// 更新接口的失败分支必须带原因，不能只剩「请求失败（200）」
import { apply, Config } from '../index.js';

const handlers = new Map();
const conn = { fetch: { register: d => handlers.set(d.path, d) } };
const fake = {
  get: k => k === 'connection' ? conn : undefined,
  provide: (n, v) => { fake[n] = v; },
  effect: f => { f(); return () => {}; },
  logger: { info() {}, warn() {} },
  connection: conn,
  fiber: { entry: {} },
};
await apply(fake, Config({ dataDir: '/tmp/update-test-data' }));

const post = async (p, b) => {
  const res = await handlers.get(p).fetch(new Request('http://x' + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
  }));
  return { status: res.status, data: await res.json() };
};
const get = async (p) => {
  const res = await handlers.get(p).fetch(new Request('http://x' + p));
  return { status: res.status, data: await res.json() };
};

const check = await get('/api/session-history.update');
console.log('检查:', check.status, JSON.stringify(check.data).slice(0, 140));

const applyNoForce = await post('/api/session-history.update.apply', {});
console.log('不带 force:', applyNoForce.status, JSON.stringify(applyNoForce.data).slice(0, 140));

// 任何 ok:false 都必须带原因，否则前端只能显示通用错误
const failing = [check.data, applyNoForce.data].filter(d => d.ok === false);
const ok = failing.every(d => typeof d.error === 'string' && d.error !== '');
console.log(ok ? 'UPDATE_TEST_OK' : 'UPDATE_TEST_FAIL');
process.exit(ok ? 0 : 1);
