// 设备分档：按平台、核数、可用内存定初始档位。纯函数加少量探测。
// 方案 4.1 到 4.4 节：低、中、高，参数表固定；运行时只降不升由导入器负责。
import { readFile } from 'node:fs/promises';
import os from 'node:os';

const TIERS = {
  low: { concurrency: 1, batchSize: 120, throttleMs: 200, listPageSize: 60 },
  mid: { concurrency: 2, batchSize: 200, throttleMs: 100, listPageSize: 100 },
  high: { concurrency: 4, batchSize: 400, throttleMs: 50, listPageSize: 200 },
};

/** 按档位取参数，未知档位退回中档。 */
export function tierParams(tier) {
  return TIERS[tier] ?? TIERS.mid;
}

// 内存警戒线：可用内存低于此值强制降档（字节）
export const MEMORY_GUARD_BYTES = 512 * 1024 * 1024;

// 读 cgroup 内存上限（v2 再 v1），读不到返回 undefined
async function cgroupMemoryMax() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = (await readFile(p, 'utf8')).trim();
      if (raw === 'max' || raw === '') continue;
      const n = Number(raw);
      // v1 无限制时是一个巨大的数，按无效处理
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return n;
    } catch { /* 没有这个文件就试下一个 */ }
  }
  return undefined;
}

export async function detectPlatform() {
  const platform = os.platform();
  const release = os.release().toLowerCase();
  const isAndroid = platform === 'android' || release.includes('android');
  return { platform, isAndroid, cores: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem() };
}

// 容器里 os.cpus() 会被亲和性限制成 1，真机核数要从 /proc/cpuinfo 数。
async function cpuTotalFromProc() {
  try {
    const raw = await readFile('/proc/cpuinfo', 'utf8');
    const n = (raw.match(/^processor\s*:/gm) ?? []).length;
    return n > 0 ? n : undefined;
  } catch { return undefined; }
}

// 桥给的内存是安卓侧的真实值，比容器里的更可信。
async function bridgeFacts() {
  try {
    const raw = await readFile('/root/.dsh/.bridge_headers', 'utf8');
    const headers = {};
    for (const line of raw.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const res = await fetch(`${process.env.DSHA_BRIDGE_URL ?? 'http://127.0.0.1:3091'}/app/device`, {
      headers, signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    const free = text.match(/memory_free=([\d.]+)\s*GB/);
    const total = text.match(/memory_total=([\d.]+)\s*GB/);
    return {
      freeBytes: free ? Number(free[1]) * 1024 ** 3 : undefined,
      totalBytes: total ? Number(total[1]) * 1024 ** 3 : undefined,
    };
  } catch {
    return {};
  }
}

export async function detectTier() {
  const info = await detectPlatform();
  const [cgMax, cpuTotal, facts] = await Promise.all([cgroupMemoryMax(), cpuTotalFromProc(), bridgeFacts()]);

  // 真机核数优先于容器亲和性；没有就退回 os.cpus()
  const cpuCores = Math.max(cpuTotal ?? 0, info.cores, 1);
  const effectiveTotal = Math.min(facts.totalBytes ?? info.totalMem, cgMax ?? Number.MAX_SAFE_INTEGER);
  const freeBytes = facts.freeBytes ?? info.freeMem;
  const effectiveFree = Math.min(freeBytes, effectiveTotal);

  // 判定顺序：内存吃紧先降档，其余看核数。容器亲和性只有 1 核不算低档，
  // 那是 proot 的限制，不是手机性能。
  let tier = 'mid';
  if (effectiveFree < 1 * 1024 ** 3 || cpuCores <= 2) tier = 'low';
  else if (cpuCores >= 8 && effectiveFree >= 3 * 1024 ** 3) tier = 'high';

  return {
    ...info, cgMax, cpuCores, facts,
    effectiveTotal, effectiveFree, tier, params: TIERS[tier],
    basis: `cores=${cpuCores} free=${(effectiveFree / 1024 ** 3).toFixed(1)}GB`,
  };
}

// 运行时降档：导入器每完成一个会话把耗时喂进来，持续超标就降一档
export function createRuntimeGovernor(tier, params) {
  let current = tier;
  let window = [];
  return {
    get tier() { return current; },
    get params() { return TIERS[current]; },
    record(sessionMs) {
      window.push(sessionMs);
      if (window.length > 20) window.shift();
      if (window.length === 20 && current !== 'low') {
        const avg = window.reduce((a, b) => a + b, 0) / window.length;
        if (avg > 300) {
          current = current === 'high' ? 'mid' : 'low';
          window = [];
        }
      }
    },
    memoryGuard(freeBytes) {
      if (freeBytes < MEMORY_GUARD_BYTES && current !== 'low') current = 'low';
    },
  };
}
