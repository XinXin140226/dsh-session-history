// M3 自测：导出全链路。导入 5 个会话，再全部导出成 zip，校验产物。
import { Context } from '@deepseek-ai/cordis';
import { apply as jsonlPlugin } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { readCatalog, runImport } from '../lib/plan/importer.mjs';
import { runExport } from '../lib/plan/exporter.mjs';
import { IdMap } from '../lib/store/idmap.mjs';
import { TaskLock } from '../lib/store/lock.mjs';
import { TaskProgress } from '../lib/store/progress.mjs';
import { mkdirSync, rmSync, statSync } from 'node:fs';

const ZIP = '/storage/emulated/0/Download/Browser/deepseek_data-2026-11-19.zip';
const ROOT = '/tmp/test-export-root';
const DATA = '/tmp/test-export-data';
const OUT = '/tmp/test-export-out/sessions.zip';

rmSync(ROOT, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
rmSync('/tmp/test-export-out', { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const ctx = new Context();
await ctx.plugin(jsonlPlugin, { root: ROOT, compression: 'zstd' });
const persistence = ctx.sessionPersistence;

const catalog = await readCatalog(ZIP);
const picked = catalog.slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 5);
const idmap = new IdMap(`${DATA}/idmap.ndjson`);
const lock = new TaskLock(`${DATA}/task.lock`);
const progress = new TaskProgress(() => {});

const services = {
  persistence, idmap, lock, progress, sessionQuery: undefined,
  params: { batchSize: 120 },
  resolveCwd: () => '/tmp/test-export-root',
  presetId: 'dsh-session-history',
};

const imp = await runImport({ zipPath: ZIP, selectedIds: picked.map(p => p.originId), services });
console.log('导入:', JSON.stringify(imp));

const ids = [...idmap.map.values()];
const t0 = Date.now();
const exp = await runExport({ sessionIds: ids, outPath: OUT, services });
console.log(`导出 ${Date.now() - t0}ms`, JSON.stringify({ exported: exp.exported, failed: exp.failed, bytes: exp.bytes }));
console.log('产物大小:', statSync(OUT).size);
console.log('文件:', exp.files.join(', '));

await ctx.fiber.dispose();
const ok = exp.exported === ids.length && exp.failed === 0 && exp.bytes > 1000;
console.log(ok ? 'EXPORT_TEST_OK' : 'EXPORT_TEST_FAIL');
process.exit(ok ? 0 : 1);