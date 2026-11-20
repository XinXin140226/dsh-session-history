// M3 自测：导入执行器全链路。
// 覆盖：清单读取、批量导入、幂等跳过、进度回调、锁互斥。
// 只写 /tmp/test-import-root 与 /tmp/test-import-data，不碰真实存储。
import { Context } from '@deepseek-ai/cordis';
import { apply as jsonlPlugin } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { readCatalog, runImport } from '../lib/plan/importer.mjs';
import { IdMap } from '../lib/store/idmap.mjs';
import { TaskLock } from '../lib/store/lock.mjs';
import { TaskProgress } from '../lib/store/progress.mjs';
import { mkdirSync, rmSync } from 'node:fs';

const ZIP = '/storage/emulated/0/Download/Browser/deepseek_data-2026-11-19.zip';
const ROOT = '/tmp/test-import-root';
const DATA = '/tmp/test-import-data';
const COUNT = 10;

rmSync(ROOT, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const ctx = new Context();
await ctx.plugin(jsonlPlugin, { root: ROOT, compression: 'zstd' });
const persistence = ctx.sessionPersistence;

// 清单
const t0 = Date.now();
const catalog = await readCatalog(ZIP);
console.log(`清单 ${catalog.length} 条，耗时 ${Date.now() - t0}ms`);
const picked = catalog.slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, COUNT);

const idmap = new IdMap(`${DATA}/idmap.ndjson`);
const lock = new TaskLock(`${DATA}/task.lock`);

let pushes = 0;
const progress = new TaskProgress(() => { pushes += 1; }, 50);

const services = {
  persistence, idmap, lock, progress,
  params: { batchSize: 120 },
  resolveCwd: () => '/tmp/test-import-root',
  presetId: 'dsh-session-history',
  timeStrategy: 'original',
  includeToolLine: true,
};

// 锁互斥
lock.acquire();
try {
  new TaskLock(`${DATA}/task.lock`).acquire();
  console.log('LOCK_FAIL: 第二把锁居然拿到了');
} catch (e) {
  console.log('LOCK_OK: 同进程互斥生效');
}
lock.release();

// 第一轮导入
const t1 = Date.now();
const s1 = await runImport({ zipPath: ZIP, selectedIds: picked.map(p => p.originId), services });
console.log(`第一轮 ${Date.now() - t1}ms`, JSON.stringify(s1));
console.log(`进度推送 ${pushes} 次，最终状态 done=${progress.get().done} total=${progress.get().total}`);

// 第二轮：应当全部跳过
const t2 = Date.now();
const pushesBefore = pushes;
const s2 = await runImport({ zipPath: ZIP, selectedIds: picked.map(p => p.originId), services });
console.log(`第二轮 ${Date.now() - t2}ms`, JSON.stringify(s2), `新增推送 ${pushes - pushesBefore} 次`);

// 来源说明：读一个已导入会话，确认 developer/message 落在打开的 step 内
{
  const first = (await persistence.list())[0];
  const reader = await persistence.open(first.header.id, 'read');
  const { events } = await reader.read();
  await reader.close();
  const prov = events.find(e => e.type === 'developer/message');
  const provIdx = events.findIndex(e => e.type === 'developer/message');
  const stepIdx = events.findIndex((e, i) => i < provIdx && e.type === 'step/start');
  const provOk = Boolean(prov) && prov.data.message.role === 'developer' && stepIdx >= 0;
  console.log(`来源说明：${prov ? '存在' : '缺失'}，role=${prov?.data?.message?.role}，落在已打开 step 内=${stepIdx >= 0}`, provOk ? 'PROVENANCE_OK' : 'PROVENANCE_FAIL');
  if (!provOk) throw new Error('来源说明校验失败');
}

// 后端可见性
const all = await persistence.list();
console.log(`后端会话数 ${all.length}（期望 ${s1.imported}）`);
console.log(`幂等表 ${idmap.size()} 条`);

// 第三轮：取消。取 100 个未导入的，跑起来后立即取消
const cancelledIds = catalog
  .filter(c => !idmap.has(c.originId))
  .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  .slice(0, 100)
  .map(c => c.originId);
const before = idmap.size();
const task = runImport({ zipPath: ZIP, selectedIds: cancelledIds, services });
setTimeout(() => progress.cancel(), 120);
const s3 = await task;
const after = idmap.size();
const cancelOk = s3.imported < cancelledIds.length && (after - before) === s3.imported;
console.log(`取消测试：选中 ${cancelledIds.length}，完成 ${s3.imported}，跳过 ${s3.skipped}，表增 ${after - before}`, cancelOk ? 'CANCEL_OK' : 'CANCEL_FAIL');

// 第四轮：失败隔离。混一个不存在的会话 id，坏的不影响好的
const oneGood = catalog.find(c => !idmap.has(c.originId))?.originId;
const s4 = await runImport({ zipPath: ZIP, selectedIds: [oneGood, 'ffffffff-not-a-real-session'], services });
const isolateOk = s4.failed === 1 && s4.imported === 1;
console.log(`失败隔离：成功 ${s4.imported}，失败 ${s4.failed}，错误样本「${progress.get().errors.at(-1)?.reason?.slice(0, 40)}」`, isolateOk ? 'ISOLATE_OK' : 'ISOLATE_FAIL');

await ctx.fiber.dispose();
const ok = s1.imported === COUNT && s2.imported === 0 && s2.skipped === COUNT && all.length === COUNT && cancelOk && isolateOk;
console.log(ok ? 'IMPORT_TEST_OK' : 'IMPORT_TEST_FAIL');
process.exit(ok ? 0 : 1);