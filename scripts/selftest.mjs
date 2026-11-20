// M2 自测：真实导出包走全链路。解析、映射、不变量、写真实后端、回读。
// 用法：node scripts/selftest.mjs [会话数量上限] [导出包路径]
// 全程只写 /tmp/selftest-root，不碰真实会话存储。
import { openZip } from '../lib/zip/reader.mjs';
import { parseSession, parseIndexEntry, isEmptySession } from '../lib/deepseek/parse.mjs';
import { mapSession, assertInvariants } from '../lib/map/events.mjs';
import { Context } from '@deepseek-ai/cordis';
import { apply as jsonlPlugin } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence';
import { randomUUID } from 'node:crypto';

const limit = Number(process.argv[2] ?? 3);
const zipPath = process.argv[3] ?? '/storage/emulated/0/Download/Browser/deepseek_data-2026-11-19.zip';
const root = '/tmp/selftest-root';

const t0 = Date.now();
const zip = await openZip(zipPath);
const openMs = Date.now() - t0;

// 读索引
const idx = JSON.parse(await zip.read('chat_session_index.json'));
console.log(`索引条目 ${idx.length}，打开清单耗时 ${openMs}ms`);
const sample = idx
  .slice()
  .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  .slice(0, limit);

// 挂真实后端
const ctx = new Context();
await ctx.plugin(jsonlPlugin, { root, compression: 'zstd' });
const sp = ctx.sessionPersistence;

let ok = 0, fail = 0, empty = 0;
let totalParseMs = 0, totalMapMs = 0, totalWriteMs = 0, totalEvents = 0, totalBytes = 0;

for (const entry of sample) {
  const sessionPath = `chat_sessions/${entry.id}.json`;
  try {
    const raw = JSON.parse(await zip.read(sessionPath));
    if (isEmptySession(parseSession(raw))) { empty += 1; console.log(`跳过空会话 ${entry.id}`); continue; }

    const t1 = Date.now();
    const parsed = parseSession(raw);
    totalParseMs += Date.now() - t1;

    const t2 = Date.now();
    const { header, events, title, stats } = mapSession(parsed, {
      cwd: '/tmp/selftest-root',
      presetId: 'standard',
      sessionId: `session-${randomUUID()}`,
    });
    assertInvariants(header, events);
    totalMapMs += Date.now() - t2;

    const t3 = Date.now();
    // 写入前干跑校验：不合法就不建会话，杜绝幽灵
    materializeAppendBatch(events);
    const handle = await sp.create(header);
    try {
      await handle.append(events);
      await handle.flush();
      const back = await handle.read();
      if (back.events.length !== events.length) throw new Error(`回读条数不符 ${back.events.length} != ${events.length}`);
    } finally {
      await handle.close();
    }
    totalWriteMs += Date.now() - t3;

    totalEvents += events.length;
    ok += 1;
    console.log(`OK ${title.slice(0, 24)}  轮次 ${stats.turns} 事件 ${events.length} 写读 ${totalWriteMs}ms`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${entry.id}: ${e.message}`);
  }
}

// 后端层面统计
const all = await sp.list();
console.log(`\n结果：成功 ${ok} 空 ${empty} 失败 ${fail}`);
console.log(`后端可见 ${all.length} 个会话`);
console.log(`解析累计 ${totalParseMs}ms 映射累计 ${totalMapMs}ms 写读累计 ${totalWriteMs}ms 事件总数 ${totalEvents}`);
await ctx.fiber.dispose();
await zip.close();
console.log('SELFTEST_DONE');
