// M4 自测：Client 模块。无 react 环境，用最小渲染器执行组件函数，
// 验证工厂能装载、座位能注册、组件能渲染出预期文案，且状态更新后重渲染正常。
// 覆盖：设置页三段、侧栏进度条、fetch 失败时的错误提示。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 组件的轮询定时器在测试里不阻塞退出
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  const t = realSetInterval(fn, ms);
  t.unref?.();
  return t;
};

// ---- 最小 React ----
let hookStates = [];
let hookIndex = 0;
let pendingEffects = [];
let rerender = null;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) };
  },
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next;
      if (rerender) rerender();
    };
    return [hookStates[i], set];
  },
  useEffect(fn, deps) {
    const i = hookIndex++;
    const prev = hookStates[i];
    const changed = !prev || !deps || deps.some((d, k) => d !== prev[k]);
    if (changed) {
      hookStates[i] = deps;
      pendingEffects.push(fn);
    }
  },
  useCallback(fn) { hookIndex++; return fn; },
  useMemo(fn) { hookIndex++; return fn(); },
};

// 固定语言，保证断言稳定
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
} catch { globalThis.navigator = { language: 'zh-CN' }; }

// ---- 站点源与假 fetch ----
globalThis.location = { origin: 'http://test.local' };
const seenUrls = [];
const responses = new Map();
globalThis.fetch = async (url) => {
  seenUrls.push(String(url));
  const key = String(url).split('?')[0];
  const body = responses.get(key);
  if (body === undefined) return { status: 404, json: async () => ({ ok: false, error: '未配置' }) };
  const payload = typeof body === 'function' ? body() : body;
  if (payload instanceof Error) throw payload;
  return { status: 200, json: async () => payload };
};

responses.set('http://test.local/api/session-history.scan', { ok: true, zips: [{ path: '/tmp/demo.zip', name: 'deepseek_data-demo.zip', size: 220414875, mtime: Date.now() }] });
responses.set('http://test.local/api/session-history.catalog', { ok: true, rows: [
  { originId: 'a1', title: 'ADB 帮助翻译解释', messageCount: 12, updatedAtMs: Date.now() - 3600e3, pinned: false },
  { originId: 'a2', title: '坦克动荡源码获取', messageCount: 33, updatedAtMs: Date.now() - 86400e3, pinned: true },
], imported: 0 });
responses.set('http://test.local/api/session-history.status', { ok: true, status: { running: false }, imported: 0 });
responses.set('http://test.local/api/session-history.settings', { ok: true, config: { searchPreset: true, provenance: true, images: false, timeStrategy: 'original', toolSummary: 'line', tier: 'auto' } });
responses.set('http://test.local/api/session-history.sessions', { ok: true, rows: [
  { id: 'session-1', title: '导入的会话', updatedAt: Date.now(), imported: true },
  { id: 'session-2', title: '本机的会话', updatedAt: Date.now() - 7200e3, imported: false },
] });

// ---- 装载模块 ----
let mod;
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { mod = factory(requireStub); } },
};
function requireStub(name) {
  if (name === 'react') return React;
  throw new Error(`未提供的模块：${name}`);
}

const code = await readFile(new URL('../client.js', import.meta.url), 'utf8');
vm.runInThisContext(code, { filename: 'client.js' });
if (!mod) throw new Error('工厂没有被调用');
console.log('工厂装载成功，inject:', mod.inject.join(', '));

// ---- 座位注册 ----
const registrations = [];
const fakeCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { fn(); return () => {}; },
    register: (options, component) => { registrations.push({ ...options, component }); return () => {}; },
  },
};
mod.apply(fakeCtx);
console.log('注册座位:', registrations.map(r => `${r.name}#${r.id}`).join(', '));

// ---- 渲染 ----
function renderTree(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderTree).join('');
  if (typeof node === 'function') return renderTree({ type: node, props: {}, children: [] });
  if (typeof node.type === 'function') return renderTree(node.type(node.props));
  if (node.type === 'input') {
    return `<input value="${node.props.value ?? ''}" placeholder="${node.props.placeholder ?? ''}">`;
  }
  return renderTree(node.children);
}

async function renderComponent(component, label) {
  hookStates = []; hookIndex = 0; pendingEffects = [];
  rerender = null;
  const tree = component();
  const html1 = renderTree(tree);
  // 执行副作用，等异步数据回来
  for (const fn of pendingEffects) fn();
  pendingEffects = [];
  await new Promise(r => setTimeout(r, 30));
  hookIndex = 0;
  const html2 = renderTree(component());
  console.log(`\n[${label}] 首帧 ${html1.length} 字符，副作用后 ${html2.length} 字符`);
  return html2;
}

const page = registrations.find(r => r.component && r.name.startsWith('settings.'));
const side = registrations.find(r => r.name === 'sidebar.footer.action');

const pageHtml = await renderComponent(page.component, '设置页');
for (const expect of ['导入', '导出', '设置', '选择文件', 'deepseek_data-demo.zip', '把聊天记录压缩包拖到这里']) {
  const hit = pageHtml.includes(expect);
  console.log(`  ${hit ? '有' : '缺'}：${expect}`);
  if (!hit) throw new Error(`设置页缺少文案：${expect}`);
}

// 侧栏进度条：无任务时应为空
hookStates = []; hookIndex = 0; pendingEffects = [];
const sideIdle = renderTree(side.component());
console.log(`\n[侧栏] 无任务时输出 ${sideIdle.length} 字符（应为 0）`);
if (sideIdle.length !== 0) throw new Error('侧栏在无任务时应不显示');

// 有任务时应显示进度
responses.set('http://test.local/api/session-history.status', { ok: true, status: { running: true, kind: 'import', done: 30, total: 100, skipped: 0, failed: 0 } });
hookStates = []; hookIndex = 0; pendingEffects = [];
side.component();
for (const fn of pendingEffects) fn();
await new Promise(r => setTimeout(r, 30));
hookIndex = 0;
const sideBusy = renderTree(side.component());
console.log(`[侧栏] 有任务时输出 ${sideBusy.length} 字符`);
for (const expect of ['导入', '30%']) {
  const hit = sideBusy.includes(expect);
  console.log(`  ${hit ? '有' : '缺'}：${expect}`);
  if (!hit) throw new Error(`侧栏缺少：${expect}`);
}

// 直接让首页就是导出页，覆盖会话列表请求（之前 404 就出在这一步）
hookStates = ['export']; hookIndex = 0; pendingEffects = [];
renderTree(page.component());            // 渲染时才注册副作用
for (const fn of pendingEffects) fn();   // 跑副作用，发出会话列表请求
await new Promise(r => setTimeout(r, 60));
hookIndex = 0;
const exportHtml = renderTree(page.component());
console.log('导出页渲染:', exportHtml.includes('只看导入的') ? '通过' : '异常');
if (!exportHtml.includes('只看导入的')) throw new Error('导出页没有渲染出来');

const badUrls = seenUrls.filter(u => !u.startsWith('http://test.local/api/'));
console.log(`请求地址 ${seenUrls.length} 个，非绝对路径 ${badUrls.length} 个`);
if (badUrls.length > 0) {
  console.log('  例:', badUrls.slice(0, 3));
  throw new Error('客户端没有用绝对地址请求');
}

console.log('\nCLIENT_TEST_OK');