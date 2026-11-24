// 档位判定：容器亲和性只有 1 核时不能判成低档
import { detectTier, createRuntimeGovernor } from '../lib/caps/tiers.mjs';

const d = await detectTier();
const okCores = d.cpuCores >= d.cores;
const okTier = ['low', 'mid', 'high'].includes(d.tier);
// 8 核 / 1.8 GB 可用：按现行规则应为中档，不能是低
const okNotLowWhenCores = !(d.cpuCores >= 8 && d.effectiveFree > 1.5 * 1024 ** 3) || d.tier !== 'low';
console.log('判定:', d.tier, d.basis, '亲和性', d.cores, '真机核', d.cpuCores);
console.log('参数:', JSON.stringify(d.params));

const g = createRuntimeGovernor(d.tier, d.params);
for (let i = 0; i < 20; i++) g.record(400);
g.memoryGuard(100 * 1024 * 1024);
const okGuard = g.tier === 'low';

const ok = okCores && okTier && okNotLowWhenCores && okGuard;
console.log(ok ? 'TIER_TEST_OK' : 'TIER_TEST_FAIL');
process.exit(ok ? 0 : 1);
