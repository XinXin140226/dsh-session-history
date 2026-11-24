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
import { OriginalStore } from './lib/store/originals.mjs';
import { checkLatest, downloadAsset, installPackage, inspectInstall, compareVersion } from './lib/host/update.mjs';
import { readFileSync } from 'node:fs';

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

// 路由挂在 connection 服务上。声明依赖，Cordis 会等它就绪再激活插件，
// 避免开机时抢先激活、路由注册不上又不再重试。
export const inject = ['connection'];

const PRESET_WITH_SEARCH = 'dsh-session-history';
const PRESET_PLAIN = 'minimal';
const PRESET_STANDARD = 'standard';
// 导入时可选的预设，界面与路由共用同一份
const PRESETS = new Set([PRESET_WITH_SEARCH, PRESET_PLAIN, PRESET_STANDARD]);

// 当前版本与安装形态，更新功能要用
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

let sessionPersistenceRef;
const titleCache = new Map();


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
  const uploadDir = join(dataDir, 'uploads');
  const originals = new OriginalStore(join(dataDir, 'originals'));
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
    device: {
      platform: device.platform,
      isAndroid: device.isAndroid,
      // 容器亲和性会把它限制成 1，真机核数看 cpuCores
      affinityCores: device.cores,
      cpuCores: device.cpuCores ?? device.cores,
      freeGb: Number(((device.effectiveFree ?? 0) / 1024 ** 3).toFixed(1)),
      basis: device.basis ?? '',
    },
    tier,
  };

  // 幂等表反查：DSH 会话 id 是否来自导入
  const importedIds = new Set();
  for (const sid of idmap.map.values()) importedIds.add(sid);

  // 会话 id 到导入时标题的映射，作为标题兜底来源
  const importedTitles = new Map();
  try {
    for (const rec of idmap.records()) {
      if (typeof rec.sessionId === 'string' && typeof rec.title === 'string' && rec.title !== '') {
        importedTitles.set(rec.sessionId, rec.title);
      }
    }
  } catch { /* 表坏了就不兜底 */ }

  const services = {
    persistence,
    sessionQuery,
    idmap,
    lock,
    progress,
    params,
    presetId: config.searchPreset ? PRESET_WITH_SEARCH : PRESET_PLAIN,
    // 官方包固定极简；插件包默认按设置走，导入时可临时改
    presetIdFor: (kind) => (kind === 'exchange'
      ? (config.searchPreset ? PRESET_WITH_SEARCH : PRESET_PLAIN)
      : PRESET_PLAIN),
    timeStrategy: config.timeStrategy,
    includeToolLine: config.toolSummary !== 'off',
    toolSummary: config.toolSummary,
    provenance: config.provenance,
    attachments,
    withImages: config.images && Boolean(attachments),
    originals,
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
      const runServices = { ...services };
      if (options.withImages === true) runServices.withImages = true;
      // 两种包都允许临时改预设，区别只在默认值
      if (typeof options.presetId === 'string' && PRESETS.has(options.presetId)) {
        const chosen = options.presetId;
        runServices.presetIdFor = () => chosen;
      }
      const promise = runImport({ zipPath, selectedIds, services: runServices })
        .then((r) => {
          for (const rec of idmap.map.values()) importedIds.add(rec);
          return r;
        })
        .catch(e => ({ error: String(e?.message ?? e) }));
      return { promise, status: () => progress.get() };
    },
    importAndWait(zipPath, selectedIds) { return runImport({ zipPath, selectedIds, services }); },
    startExport(sessionIds, outPath, options = {}) {
      if (!caps.export) throw new Error('当前环境不能导出');
      if (progress.get().running) throw new Error('已有任务在跑');
      const importedSet = new Set(options.importedIds ?? [...importedIds]);
      const promise = runExport({ sessionIds, outPath, services: { ...services, isImported: id => importedSet.has(id) } })
        .catch(e => ({ error: String(e?.message ?? e) }));
      return { promise, status: () => progress.get() };
    },
    exportAndWait(sessionIds, outPath) { return runExport({ sessionIds, outPath, services: { ...services, isImported: id => importedIds.has(id) } }); },
    // 单个会话的 Markdown，供界面直接预览或下载
    async markdownOf(sessionId) {
      // 只读这一个会话的事件，标题也从中取，不去翻全量列表
      const events = await readEventsFor(sessionId);
      const { titleFromEvents, renderMarkdown } = await import('./lib/report/markdown.mjs');
      return renderMarkdown({
        id: sessionId,
        title: titleFromEvents(events, sessionId),
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
          blank: false,
          updatedAt: r.updatedAt ?? r.header?.createdAt ?? 0,
          imported: importedIds.has(id),
        };
      }).filter(r => r.id);

      // 标题来源按可靠性排：官方标题快照 > 翻日志 > 导入时记下的标题
      const missing = [];
      const sq2 = ctx.get?.('sessionQuery');
      if (sq2?.readTitleSnapshots) {
        for (let i = 0; i < rows.length; i += 50) {
          const chunk = rows.slice(i, i + 50);
          try {
            const snaps = await sq2.readTitleSnapshots(chunk.map(r => r.id));
            snaps.forEach((entry, k) => {
              const t = entry?.value?.title ?? entry?.title;
              if (typeof t === 'string' && t.trim() !== '') {
                chunk[k].title = t.trim();
                titleCache.set(chunk[k].id, t.trim());
              }
            });
          } catch { /* 这一批读不到，走兜底 */ }
        }
      }
      for (const row of rows) {
        if (row.title === '') missing.push(row);
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const row = missing[cursor++];
          const cached = titleCache.get(row.id);
          if (cached !== undefined) { row.title = cached; continue; }
          try {
            const events = await readEventsFor(row.id);
            let title = '';
            let hasUser = false;
            for (const e of events) {
              if (e.type === 'session/title' && typeof e.data?.title === 'string') title = e.data.title;
              if (e.type === 'user/message') hasUser = true;
            }
            // 一条用户消息都没有的会话就是刚开的新对话，DSH 还没来得及起标题
            row.blank = !hasUser;
            row.title = title;
            if (title !== '') titleCache.set(row.id, title);
          } catch { /* 读不到就留空 */ }
          if (row.title === '') row.title = importedTitles.get(row.id) ?? '';
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return rows;
    },

    // 缓存占用与清理，供设置页展示与手动触发
    async originalInfo() {
      const usage = await originals.usage();
      const cache = await dirUsage(cacheDir);
      return { originals: usage, cache };
    },
    async originalOf(id) {
      return originals.get(String(id).replace(/^sha256:/, ''));
    },
    async clearOriginals() {
      return originals.clear();
    },
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
    importedIds() { return [...importedIds]; },
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
        toolSummary: config.toolSummary,
        images: config.images,
        tier: config.tier,
        ...patch,
      };
      await editor.edit(entry, () => merged);
    },
    presets: [...PRESETS],
    version: VERSION,
    // 检查更新：唯一联网入口
    async updateCheck() {
      const info = await checkLatest();
      const install = await inspectInstall(process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'web'));
      if (!info.ok) return { ok: false, current: VERSION, error: info.error, errors: info.errors, linked: install.linked };
      return {
        ok: true,
        current: VERSION,
        latest: info.version,
        tag: info.tag,
        via: info.via,
        newer: compareVersion(info.version, VERSION) > 0,
        linked: install.linked,
      };
    },
    // 下载并安装；链接安装需要 force 才覆盖
    async updateApply(options = {}) {
      const install = await inspectInstall(process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'web'));
      if (install.linked && options.force !== true) {
        return {
          ok: false,
          linked: true,
          error: '当前是本地开发链接，更新会覆盖成打包版本',
          reason: '当前是本地开发链接，更新会覆盖成打包版本。确认覆盖请带上 force。',
        };
      }
      const info = await checkLatest();
      if (!info.ok) return { ok: false, error: info.error, errors: info.errors };
      if (compareVersion(info.version, VERSION) <= 0) return { ok: false, error: '已经是最新版本', current: VERSION };
      const got = await downloadAsset({ version: info.version, dataDir });
      if (!got.ok) return { ok: false, error: got.error, errors: got.errors };
      const installed = await installPackage({ tgzPath: got.path, profile: process.env.DSH_PROFILE ?? 'web' });
      if (!installed.ok) return { ok: false, error: '安装命令执行失败', command: installed.command, output: installed.output };
      return { ok: true, from: VERSION, to: info.version, bytes: got.bytes, sha256: got.sha256, command: installed.command, restartRequired: true };
    },
    config: {
      searchPreset: config.searchPreset,
      timeStrategy: config.timeStrategy,
      toolSummary: config.toolSummary,
      images: config.images,
      // 这里必须是配置原值（auto/低/中/高），不能是解析后的档位，否则界面会存回具体档位
      tier: config.tier,
      resolvedTier: tier,
      tierBasis: device.basis ?? '',
    },
  };

  // Cordis 要求服务先 provide；直接赋值会被拒绝
  ctx.provide('sessionHistory', service);
  ctx.effect(() => {
    // 少数环境里服务比插件晚一步，短时间内重试几次再放弃
    let attempts = 0;
    const tryRegister = () => {
      const conn = ctx.get?.('connection');
      if (conn?.fetch?.register) {
        registerRoutes(ctx, { config, service, exportsDir, uploadDir, connection: conn });
        return;
      }
      attempts += 1;
      if (attempts > 20) {
        ctx.logger?.warn?.('session history: 迟迟拿不到 connection 服务，界面路由未注册');
        return;
      }
      const timer = setTimeout(tryRegister, 500);
      timer.unref?.();
    };
    tryRegister();
    return () => {};
  }, 'session-history routes');
}