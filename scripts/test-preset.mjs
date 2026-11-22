// 验证：官方包固定极简，插件包用所选预设
import { Context } from '@deepseek-ai/cordis';
import { apply as pJsonl } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { readCatalog, runImport } from '../lib/plan/importer.mjs';
import { IdMap } from '../lib/store/idmap.mjs';
import { TaskLock } from '../lib/store/lock.mjs';
import { TaskProgress } from '../lib/store/progress.mjs';
import { rmSync } from 'node:fs';

const ZIP = '/storage/emulated/0/Download/Browser/deepseek_data-2026-11-19.zip';
const EX = '/tmp/test-export-out/sessions.zip';
// 依赖 test-export 先跑一次，生成插件包样本

const ctx = new Context();
await ctx.plugin(pJsonl, { root: '/tmp/preset-root', compression: 'zstd' });
const persistence = ctx.sessionPersistence;

async function once(zip, presetFor, tag) {
  rmSync(`/tmp/preset-data-${tag}`, { recursive: true, force: true });
  const progress = new TaskProgress(() => {});
  const services = {
    persistence, idmap: new IdMap(`/tmp/preset-data-${tag}/m.ndjson`),
    lock: new TaskLock(`/tmp/preset-data-${tag}/l.lock`), progress,
    params: { batchSize: 120 }, resolveCwd: () => '/tmp', presetId: 'minimal',
    presetIdFor: presetFor, timeStrategy: 'original', includeToolLine: true,
    provenance: false, toolSummary: 'line',
  };
  const cat = await readCatalog(zip);
  const one = cat[0];
  const r = await runImport({ zipPath: zip, selectedIds: [one.originId], services });
  const newId = services.idmap.get(one.originId);
  const reader = await persistence.open(newId, 'read');
  const { header } = reader;
  await reader.close();
  return { kind: one.kind, imported: r.imported, preset: header?.agentPreset };
}

rmSync('/tmp/preset-root', { recursive: true, force: true });

const off = await once(ZIP, (kind) => (kind === 'exchange' ? 'standard' : 'minimal'), 'off');
console.log('官方包:', JSON.stringify(off));

const pl = await once(EX, (kind) => (kind === 'exchange' ? 'standard' : 'minimal'), 'pl');
console.log('插件包:', JSON.stringify(pl));

// 默认值：官方包极简，插件包带搜索
const offDefault = await once(ZIP, (kind) => (kind === 'exchange' ? 'dsh-session-history' : 'minimal'), 'd1');
const plDefault = await once(EX, (kind) => (kind === 'exchange' ? 'dsh-session-history' : 'minimal'), 'd2');
console.log('官方默认:', JSON.stringify(offDefault));
console.log('插件默认:', JSON.stringify(plDefault));

// 覆盖：官方包也能手动改成标准，说明不是强制
const offForced = await once(ZIP, () => 'standard', 'o3');
console.log('官方改标准:', JSON.stringify(offForced));

const ok = off.kind === 'deepseek' && off.preset === 'minimal'
  && pl.kind === 'exchange' && pl.preset === 'standard'
  && offDefault.preset === 'minimal' && plDefault.preset === 'dsh-session-history'
  && offForced.preset === 'standard';
console.log(ok ? 'PRESET_TEST_OK' : 'PRESET_TEST_FAIL');
await ctx.fiber.dispose();
process.exit(ok ? 0 : 1);
