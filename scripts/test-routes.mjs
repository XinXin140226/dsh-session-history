// M4 自测：Host 路由层。抓取注册的处理器，用真实后端与真实导出包走一遍。
// 覆盖：扫描、清单、导入、进度、会话列表、导出、下载。
import { Context } from '@deepseek-ai/cordis';
import { apply as jsonlPlugin } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { apply as applyPlugin, Config } from '../index.js';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const ZIP = '/storage/emulated/0/Download/Browser/deepseek_data-2026-11-19.zip';
const ROOT = '/tmp/test-routes-root';
const DATA = '/tmp/test-routes-data';

rmSync(ROOT, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const ctx = new Context();
await ctx.plugin(jsonlPlugin, { root: ROOT, compression: 'zstd' });
const persistence = ctx.sessionPersistence;

const handlers = new Map();
const fakeCtx = {
  get: (k) => {
    if (k === 'sessionPersistence') return persistence;
    if (k === 'connection') return fakeCtx.connection;
    if (k === 'configEditor') return {
      edit: async (entry, change) => { fakeCtx.savedConfig = change(fakeCtx.config ?? {}); },
    };
    if (k === 'sessionQuery') return {
      listSessions: async () => (await persistence.list()).map(s => ({
        sessionId: s.header.id, title: s.header.agentPreset ? s.header.id.slice(-8) : '', updatedAt: s.header.createdAt,
      })),
    };
    return undefined;
  },
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => { const d = fn(); return () => d?.(); },
  fiber: { entry: { id: 'dsh-session-history' } },
  provide: (name, value) => { fakeCtx[name] = value; },
  connection: { fetch: { register: (def) => { handlers.set(def.path, def); } } },
};

await applyPlugin(fakeCtx, Config({ dataDir: DATA }));

const call = async (path, { method = 'GET', body } = {}) => {
  const clean = path.split('?')[0];
  const def = handlers.get(clean);
  if (!def) throw new Error(`路由没注册：${clean}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const res = await def.fetch(req);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) return res.json();
  return { buffer: Buffer.from(await res.arrayBuffer()), ct };
};

// 1 扫描
const scan = await call('/api/session-history.scan');
console.log('扫描:', scan.ok, '找到', scan.zips?.length ?? 0, '个包');
console.log('  首个:', scan.zips?.[0]?.path);

// 2 清单
const cat = await call('/api/session-history.catalog', { method: 'POST', body: { zipPath: ZIP } });
console.log('清单:', cat.ok, cat.rows?.length, '条');

// 3 导入 3 个
const picked = cat.rows.slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 3).map(r => r.originId);
const imp = await call('/api/session-history.import', { method: 'POST', body: { zipPath: ZIP, ids: picked } });
console.log('导入已发起:', imp.ok, '总数', imp.total);

// 等任务结束
let status;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 120));
  const st = await call('/api/session-history.status');
  status = st.status;
  if (!status.running && status.finishedAt) break;
}
console.log('导入结果: done', status.done, 'failed', status.failed, 'skipped', status.skipped);

// 4 会话列表
const list = await call('/api/session-history.sessions');
console.log('会话列表:', list.ok, list.rows?.length, '条，其中导入标记', list.rows?.filter(r => r.imported).length);

// 5 导出
const exp = await call('/api/session-history.export', { method: 'POST', body: { ids: list.rows.map(r => r.id) } });
console.log('导出:', exp.ok, exp.exported, '个，', exp.bytes, '字节，文件', exp.name);

// 6 下载
const named = !/^dsh-sessions-/.test(exp.name) && /\.zip$/.test(exp.name);
console.log('导出文件名用标题:', exp.name, named ? 'OK' : '不对');

const md1 = await call(`/api/session-history.markdown?sessionId=${encodeURIComponent(list.rows[0].id)}`);
console.log('单会话 md:', md1.ct.includes('markdown') ? '类型正确' : md1.ct, md1.buffer?.length ?? 0, '字节');

const dl = await call(`/api/session-history.download?name=${encodeURIComponent(exp.name)}`);
console.log('下载:', dl.buffer.length, '字节', dl.ct);
writeFileSync('/tmp/test-routes-download.zip', dl.buffer);

// 7 设置读写
const cfg1 = await call('/api/session-history.settings');
console.log('设置读取:', cfg1.ok, JSON.stringify(cfg1.config));
const cfg2 = await call('/api/session-history.settings.save', { method: 'POST', body: { patch: { toolSummary: 'queries' } } });
console.log('设置保存:', cfg2.ok, cfg2.error ?? JSON.stringify(cfg2.saved));

// 8 路径穿越拦截
const bad = await call('/api/session-history.download?name=../../etc/passwd');
console.log('路径穿越拦截:', bad.ok === false, bad.error);

await ctx.fiber.dispose();
const ok = scan.ok && cat.rows.length === 1992 && status.done === 3 && status.failed === 0
  && list.rows.length === 3 && exp.ok && exp.exported === 3 && dl.buffer.length === exp.bytes
  && bad.ok === false && named && md1.buffer.length > 200;
console.log(ok ? 'ROUTES_TEST_OK' : 'ROUTES_TEST_FAIL');
process.exit(ok ? 0 : 1);