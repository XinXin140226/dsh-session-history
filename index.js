// dsh-session-history Host 半边。
// 能力：清单读取、后台导入、单个与批量导出、任务状态、取消，以及界面路由。
import Schema from '@deepseek-ai/schemastery';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectTier, tierParams } from './lib/caps/tiers.mjs';
import { IdMap } from './lib/store/idmap.mjs';
import { TaskLock } from './lib/store/lock.mjs';
import { TaskProgress } from './lib/store/progress.mjs';
import { readCatalog, runImport } from './lib/plan/importer.mjs';
import { runExport } from './lib/plan/exporter.mjs';
import { registerRoutes } from './lib/host/routes.mjs';
import { dirUsage, clearDir, autoCleanIfDue, markClean } from './lib/store/cache.mjs';

export const Config = Schema.object({
  // 导入会话记录哪个预设；关闭则记录官方 minimal，恢复后不带联网搜索
  searchPreset: Schema.boolean().default(true),
  // 时间策略：保留原始时间，或统一改写为导入时间
  timeStrategy: Schema.union(['original', 'import-time']).default('original'),
  // 导入时在会话开头写入来源说明
  provenance: Schema.boolean().default(true),
  // 检索摘要档位：一行摘要、检索词列表、不显示
  toolSummary: Schema.union(['line', 'queries', 'off']).default('line'),
  // 图片导入（实验性），默认关
  images: Schema.boolean().default(false),
  // 性能档位
  tier: Schema.union(['auto', 'low', 'mid', 'high']).default('auto'),
  // 插件数据目录，缺省落在 DSH 主目录下
  dataDir: Schema.string(),
});

const PRESET_WITH_SEARCH = 'dsh-session-history';
const PRESET_PLAIN = 'minimal';

let sessionPersistenceRef;


async function readEventsFor(sessionId) {
  const persistence = sessionPersistenceRef;
  if (!persistence?.open) throw new Error('当前环境没有会话持久化服务');
  const reader = await persistence.open(sessionId, 'read');
  try {
    const { events } = await reader.read();
    return events;
  } finally {
    await reader.close();
  }
}

export async function apply(ctx, config) {
  sessionPersistenceRef = ctx.get?.('sessionPersistence');
  const persistence = ctx.get?.('sessionPersistence');
  const sessionQuery = ctx.get?.('sessionQuery');
  const attachments = ctx.get?.('attachments');

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dataDir = config.dataDir ?? join(dshHome, 'plugin-data', 'dsh-session-history');
  const importCwd = join(dataDir, 'workspace');
  const exportsDir = join(dataDir, 'exports');
  const cacheDir = join(dshHome, 'cache', 'attachments');
  const cacheStamp = join(dataDir, 'cache-clean.stamp');
  mkdirSync(importCwd, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });

  const device = await detectTier();
  const tier = config.tier === 'auto' ? device.tier : config.tier;
  const params = device.tier === tier ? device.params : tierParams(tier);

  const idmap = new IdMap(join(dataDir, 'idmap.ndjson'));
  const lock = new TaskLock(join(dataDir, 'task.lock'));

  let lastProgress;
  const progress = new TaskProgress((state) => { lastProgress = state; }, params.throttleMs);

  const caps = {
    import: Boolean(persistence),
    export: Boolean(sessionQuery) || Boolean(persistence),
    images: Boolean(attachments) && config.images,
    device: { platform: device.platform, isAndroid: device.isAndroid, cores: device.cores },
    tier,
  };

  // 幂等表反查：DSH 会话 id 是否来自导入
  const importedIds = new Set();
  for (const sid of idmap.map.values()) importedIds.add(sid);

  const services = {
    persistence,
    sessionQuery,
    idmap,
    lock,
    progress,
    params,
    presetId: config.searchPreset ? PRESET_WITH_SEARCH : PRESET_PLAIN,
    timeStrategy: config.timeStrategy,
    includeToolLine: config.toolSummary !== 'off',
    toolSummary: config.toolSummary,
    provenance: config.provenance,
    attachments,
    withImages: config.images && Boolean(attachments),
    resolveCwd: () => importCwd,
  };

  // 每次启动检查一次，满七天就清附件缓存
  const cleanResult = await autoCleanIfDue({ cacheDir, stampFile: cacheStamp, logger: ctx.logger });

  ctx.logger?.info?.(
    'session history ready: import=%s export=%s tier=%s data=%s',
    caps.import, caps.export, tier, dataDir,
  );

  const service = {
    caps,
    async catalog(zipPath) {
      if (!caps.import) throw new Error('当前环境不能导入');
      return readCatalog(zipPath);
    },
    startImport(zipPath, selectedIds, options = {}) {
      if (!caps.import) throw new Error('当前环境不能导入');
      if (progress.get().running) throw new Error('已有任务在跑');
      const runServices = options.withImages === true
        ? { ...services, withImages: true }
        : services;
      const promise = runImport({ zipPath, selectedIds, services: runServices })
        .then((r) => {
          for (const rec of idmap.map.values()) importedIds.add(rec);
          return r;
        })
        .catch(e => ({ error: String(e?.message ?? e) }));
      return { promise, status: () => progress.get() };
    },
    importAndWait(zipPath, selectedIds) { return runImport({ zipPath, selectedIds, services }); },
    startExport(sessionIds, outPath) {
      if (!caps.export) throw new Error('当前环境不能导出');
      if (progress.get().running) throw new Error('已有任务在跑');
      const promise = runExport({ sessionIds, outPath, services }).catch(e => ({ error: String(e?.message ?? e) }));
      return { promise, status: () => progress.get() };
    },
    exportAndWait(sessionIds, outPath) { return runExport({ sessionIds, outPath, services }); },
    // 单个会话的 Markdown，供界面直接预览或下载
    async markdownOf(sessionId) {
      const rows = await service.sessionRows();
      const row = rows.find(r => r.id === sessionId);
      const events = await readEventsFor(sessionId);
      const { titleFromEvents, renderMarkdown } = await import('./lib/report/markdown.mjs');
      return renderMarkdown({
        id: sessionId,
        title: row?.title ?? titleFromEvents(events, sessionId),
        createdAt: events[0]?.time,
        events,
        imported: importedIds.has(sessionId),
      });
    },
    // 会话列表，供导出与预览共用
    async sessionRows() {
      const sq = ctx.get?.('sessionQuery');
      if (!sq?.listSessions) return [];
      const records = await sq.listSessions();
      const rows = records.map(r => {
        const id = r.sessionId ?? r.header?.id;
        return {
          id,
          title: '',
          updatedAt: r.updatedAt ?? r.header?.createdAt ?? 0,
          imported: importedIds.has(id),
        };
      }).filter(r => r.id);

      // 标题从日志里的 session/title 事件折出来。列表记录里没有这个字段。
      // 会话太多时只补前两百条，剩下的显示短 id，避免一次打开上千个日志。
      const LIMIT = 200;
      const targets = rows.slice(0, LIMIT);
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const row = targets[cursor++];
          try {
            const events = await readEventsFor(row.id);
            let title = '';
            for (const e of events) {
              if (e.type === 'session/title' && typeof e.data?.title === 'string') title = e.data.title;
            }
            row.title = title;
          } catch { /* 读不到就留空，界面回退到短 id */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return rows;
    },

    // 缓存占用与清理，供设置页展示与手动触发
    async cacheInfo() {
      const usage = await dirUsage(cacheDir);
      return { ...usage, dir: cacheDir };
    },
    async clearCache() {
      const removed = await clearDir(cacheDir);
      await markClean(cacheStamp);
      return removed;
    },
    status() { return lastProgress ?? progress.get(); },
    cancel() { progress.cancel(); },
    importedCount() { return idmap.size(); },
    isImported(sessionId) { return importedIds.has(sessionId); },
    // 保存配置：走官方编辑器，写回 profile 补丁并重启本插件
    async saveConfig(patch) {
      const entry = ctx.fiber?.entry;
      const editor = ctx.get?.('configEditor');
      if (entry === undefined || editor === undefined) {
        throw new Error('当前 profile 不能保存配置，请在插件设置里手动修改');
      }
      const merged = {
        searchPreset: config.searchPreset,
        timeStrategy: config.timeStrategy,
        provenance: config.provenance,
    attachments,
    withImages: config.images && Boolean(attachments),
        toolSummary: config.toolSummary,
        images: config.images,
        tier: config.tier,
        ...patch,
      };
      await editor.edit(entry, () => merged);
    },
    config: {
      searchPreset: config.searchPreset,
      timeStrategy: config.timeStrategy,
      toolSummary: config.toolSummary,
      images: config.images,
      tier,
    },
  };

  // Cordis 要求服务先 provide；直接赋值会被拒绝
  ctx.provide('sessionHistory', service);
  ctx.effect(() => {
    registerRoutes(ctx, { config, service, exportsDir });
    return () => {};
  }, 'session-history routes');
}