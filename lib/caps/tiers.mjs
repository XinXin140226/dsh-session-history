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

export async function detectTier() {
  const info = await detectPlatform();
  const cgMax = await cgroupMemoryMax();
  const effectiveTotal = Math.min(info.totalMem, cgMax ?? Number.MAX_SAFE_INTEGER);
  // 容器里 os.freemem 读的是宿主值，按有效总量比例估一个保守值
  const effectiveFree = Math.min(info.freeMem, Math.max(effectiveTotal * 0.25, 256 * 1024 * 1024));

  let tier = 'mid';
  if (info.cores <= 4 || effectiveFree < 1.5 * 1024 * 1024 * 1024) tier = 'low';
  else if (!info.isAndroid && info.cores >= 8 && effectiveFree > 4 * 1024 * 1024 * 1024) tier = 'high';

  return { ...info, cgMax, effectiveTotal, effectiveFree, tier, params: TIERS[tier] };
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
