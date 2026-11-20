// Host 路由：清单扫描、导入、进度、取消、会话列表、导出与下载。
// 客户端同源 fetch 调用，路径与官方导出路由一个风格。
import { readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';

export const ROUTES = {
  scan: '/api/session-history.scan',
  catalog: '/api/session-history.catalog',
  import: '/api/session-history.import',
  status: '/api/session-history.status',
  cancel: '/api/session-history.cancel',
  sessions: '/api/session-history.sessions',
  export: '/api/session-history.export',
  download: '/api/session-history.download',
  markdown: '/api/session-history.markdown',
  cache: '/api/session-history.cache',
  cacheClear: '/api/session-history.cache.clear',
  settings: '/api/session-history.settings',
  settingsSave: '/api/session-history.settings.save',
};

// 常见位置扫 deepseek_data 导出包
const SCAN_DIRS = [
  '/storage/emulated/0/Download',
  '/storage/emulated/0/Download/Browser',
  '/storage/emulated/0/Download/DSHA',
  join(process.env.HOME ?? '/root', 'Downloads'),
  join(process.env.HOME ?? '/root', '下载'),
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text === '') return {};
  return JSON.parse(text);
}

function assertZipPath(p) {
  if (typeof p !== 'string' || p === '') throw new Error('缺少 zip 路径');
  const abs = resolve(p);
  if (!abs.startsWith('/')) throw new Error('路径必须是绝对路径');
  if (!abs.toLowerCase().endsWith('.zip')) throw new Error('只接受 zip 文件');
  return abs;
}

export function registerRoutes(ctx, { config, service, exportsDir, connection }) {
  // 用动态查找，未声明注入也不会抛；没有 Web 层时静默跳过路由
  const conn = connection ?? ctx.get?.('connection');
  if (!conn?.fetch?.register) {
    ctx.logger?.warn?.('session history: 没有 connection.fetch，界面路由不注册');
    return;
  }

  const reg = (path, methods, handler) => conn.fetch.register({
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handler(request);
      } catch (e) {
        return fail(String(e?.message ?? e));
      }
    },
  });

  // 扫常用位置
  reg(ROUTES.scan, ['GET'], async () => {
    const found = [];
    const seen = new Set();
    for (const dir of SCAN_DIRS) {
      let names = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!/\.zip$/i.test(name)) continue;
        if (!/deepseek|chat|export|data/i.test(name)) continue;
        const p = join(dir, name);
        if (seen.has(p)) continue;
        seen.add(p);
        try {
          const st = await stat(p);
          if (!st.isFile()) continue;
          found.push({ path: p, name, size: st.size, mtime: st.mtimeMs });
        } catch { /* 跳过读不到的 */ }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return json({ ok: true, zips: found.slice(0, 20) });
  });

  // 读清单
  reg(ROUTES.catalog, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    const zipPath = assertZipPath(body.zipPath);
    await stat(zipPath); // 不存在会抛
    const rows = await service.catalog(zipPath);
    return json({ ok: true, zipPath, rows, imported: service.importedCount() });
  });

  // 开始导入
  reg(ROUTES.import, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    const zipPath = assertZipPath(body.zipPath);
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : [];
    if (ids.length === 0) return fail('没有选中任何会话');
    const task = service.startImport(zipPath, ids, { withImages: body.withImages === true });
    // 后台跑，结果挂在任务状态里
    task.promise.catch(() => {});
    return json({ ok: true, total: ids.length });
  });

  // 进度
  reg(ROUTES.status, ['GET'], async () => json({ ok: true, status: service.status(), imported: service.importedCount() }));

  // 取消
  reg(ROUTES.cancel, ['POST'], async () => {
    service.cancel();
    return json({ ok: true });
  });

  // 设置：读当前生效配置
  reg(ROUTES.settings, ['GET'], async () => json({ ok: true, config: service.config }));

  // 设置：保存（只接受白名单键与合法值）
  reg(ROUTES.settingsSave, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    const patch = body.patch;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return fail('patch 必须是对象');
    const ALLOWED = {
      searchPreset: (v) => typeof v === 'boolean',
      provenance: (v) => typeof v === 'boolean',
      images: (v) => typeof v === 'boolean',
      timeStrategy: (v) => v === 'original' || v === 'import-time',
      toolSummary: (v) => ['line', 'queries', 'off'].includes(v),
      tier: (v) => ['auto', 'low', 'mid', 'high'].includes(v),
    };
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      const check = ALLOWED[k];
      if (!check) return fail(`不认识的配置项：${k}`);
      if (!check(v)) return fail(`配置项 ${k} 的取值不合法`);
      clean[k] = v;
    }
    if (Object.keys(clean).length === 0) return fail('没有要保存的改动');
    await service.saveConfig(clean);
    return json({ ok: true, saved: clean });
  });

  // 会话列表（导出选择用）
  reg(ROUTES.sessions, ['GET'], async (request) => {
    const url = new URL(request.url);
    const onlyImported = url.searchParams.get('onlyImported') === '1';
    const rows = await service.sessionRows();
    const out = (onlyImported ? rows.filter(r => r.imported) : rows).sort((a, b) => b.updatedAt - a.updatedAt);
    return json({ ok: true, rows: out });
  });

  // 导出
  reg(ROUTES.export, ['POST'], async (request) => {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : [];
    if (ids.length === 0) return fail('没有选中任何会话');
    await mkdir(exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = join(exportsDir, `dsh-sessions-${stamp}.zip`);
    const task = service.startExport(ids, outPath);
    const result = await task.promise;
    if (result?.error) return fail(result.error, 500);
    return json({ ok: true, name: basename(outPath), bytes: result.bytes, exported: result.exported, failed: result.failed });
  });

  // 缓存占用
  reg(ROUTES.cache, ['GET'], async () => json({ ok: true, ...(await service.cacheInfo()) }));

  // 手动清理缓存
  reg(ROUTES.cacheClear, ['POST'], async () => {
    const removed = await service.clearCache();
    return json({ ok: true, ...removed });
  });

  // 单个会话直接拿 Markdown
  reg(ROUTES.markdown, ['GET'], async (request) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (sessionId === '') return fail('缺少 sessionId');
    const text = await service.markdownOf(sessionId);
    const name = `${sessionId.slice(-12)}.md`;
    return new Response(text, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // 下载
  reg(ROUTES.download, ['GET'], async (request) => {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') ?? '';
    if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return fail('文件名不合法');
    const file = join(exportsDir, name);
    const buf = await readFile(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      },
    });
  });
}