// 插件更新：唯一联网的功能。
// 版本检查先直连 GitHub API，取不到再走代理读 releases.atom。
// 下载按 gh-proxy.com、ghfast.top、官方地址的顺序尝试。
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REPO = 'XinXin140226/dsh-session-history';
const PROXIES = ['https://gh-proxy.com/', 'https://ghfast.top/'];

export function assetName(version) {
  return `dsh-session-history-${version}.tgz`;
}

/** 把版本号规整成 x.y.z，便于比较。 */
export function normalizeVersion(text) {
  const m = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m === null ? undefined : `${m[1]}.${m[2]}.${m[3]}`;
}

/** 版本比较，返回 1 / 0 / -1。 */
export function compareVersion(a, b) {
  const pa = normalizeVersion(a)?.split('.').map(Number);
  const pb = normalizeVersion(b)?.split('.').map(Number);
  if (pa === undefined || pb === undefined) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'dsh-session-history' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 查最新版本：直连 API，失败再用代理读 atom。 */
export async function checkLatest({ timeoutMs = 12000 } = {}) {
  const attempts = [];
  attempts.push({ via: 'github-api', url: `https://api.github.com/repos/${REPO}/releases/latest`, parse: (t) => {
    const j = JSON.parse(t);
    return { tag: j.tag_name, version: normalizeVersion(j.tag_name) };
  } });
  for (const proxy of PROXIES) {
    attempts.push({ via: proxy, url: `${proxy}https://github.com/${REPO}/releases.atom`, parse: (t) => {
      const m = t.match(/releases\/tag\/([^"<\s]+)/);
      if (m === null) throw new Error('原子源里没有版本号');
      return { tag: decodeURIComponent(m[1]), version: normalizeVersion(m[1]) };
    } });
  }
  attempts.push({ via: 'github-atom', url: `https://github.com/${REPO}/releases.atom`, parse: (t) => {
    const m = t.match(/releases\/tag\/([^"<\s]+)/);
    if (m === null) throw new Error('原子源里没有版本号');
    return { tag: decodeURIComponent(m[1]), version: normalizeVersion(m[1]) };
  } });

  const errors = [];
  for (const a of attempts) {
    try {
      const text = await getText(a.url, timeoutMs);
      const parsed = a.parse(text);
      if (parsed.version === undefined) throw new Error('版本号解析失败');
      return { ok: true, version: parsed.version, tag: parsed.tag, via: a.via };
    } catch (e) {
      errors.push(`${a.via}: ${String(e?.message ?? e)}`);
    }
  }
  return { ok: false, error: '所有线路都没取到版本信息', errors };
}

/** 按代理顺序把 asset 下到本地，返回落盘路径。 */
export async function downloadAsset({ version, dataDir, timeoutMs = 120000 }) {
  const name = assetName(version);
  const dir = join(dataDir, 'updates');
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const path = `/releases/download/v${version}/${name}`;
  const candidates = [
    ...PROXIES.map(p => ({ via: p, url: `${p}https://github.com/${REPO}${path}` })),
    { via: 'github', url: `https://github.com/${REPO}${path}` },
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'dsh-session-history' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error('文件太小，可能不是包');
      await writeFile(target, buf);
      return { ok: true, path: target, bytes: buf.length, via: c.via, sha256: createHash('sha256').update(buf).digest('hex') };
    } catch (e) {
      errors.push(`${c.via}: ${String(e?.message ?? e)}`);
    }
  }
  return { ok: false, error: '下载失败', errors };
}

/** 用 dsh 自己的安装命令把包装进 profile。 */
export async function installPackage({ tgzPath, profile, timeoutMs = 180000 }) {
  const args = ['plugin'];
  if (typeof profile === 'string' && profile !== '') args.push('--profile', profile);
  args.push('add', tgzPath);
  try {
    const { stdout, stderr } = await run('dsh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, command: `dsh ${args.join(' ')}`, output: `${stdout}${stderr}`.trim().slice(-2000) };
  } catch (e) {
    return {
      ok: false,
      command: `dsh ${args.join(' ')}`,
      error: String(e?.message ?? e),
      output: `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim().slice(-2000),
    };
  }
}

/** 判断当前安装是不是本地开发链接，链接的更新会被覆盖安装。 */
export async function inspectInstall(profileDir) {
  const link = join(profileDir, 'node_modules', 'dsh-session-history');
  try {
    const st = await lstat(link);
    if (st.isSymbolicLink()) return { linked: true, path: link };
  } catch { /* 没装 */ }
  return { linked: false, path: link };
}