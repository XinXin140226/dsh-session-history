// 导出执行器：从 sessionQuery 读会话，渲染 Markdown，打包 zip，后台跑，支持取消。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderMarkdown, titleFromEvents, buildZip, safeFileName, toExchangeSession } from '../report/markdown.mjs';

async function readSessionEvents(services, sessionId) {
  const { sessionQuery, persistence } = services;
  if (sessionQuery?.readSession) {
    const got = await sessionQuery.readSession(sessionId);
    const events = got?.events ?? got?.result?.events;
    if (Array.isArray(events)) return events;
  }
  if (persistence?.open) {
    const reader = await persistence.open(sessionId, 'read');
    try {
      const { events } = await reader.read();
      return events;
    } finally {
      await reader.close();
    }
  }
  throw new Error('当前环境没有可读会话的服务');
}

export async function runExport({ sessionIds, outPath, services }) {
  const { lock, progress, isImported } = services;
  lock.acquire();
  progress.start('export', sessionIds.length);
  const summary = { exported: 0, failed: 0, skipped: 0, bytes: 0, files: [] };

  try {
    const used = new Set();
    const files = [];

    for (const sessionId of sessionIds) {
      if (progress.cancelled) {
        summary.skipped += 1;
        progress.skip();
        break;
      }
      let title = sessionId;
      try {
        const events = await readSessionEvents(services, sessionId);
        title = titleFromEvents(events, sessionId);
        progress.setCurrent(title);

        const md = renderMarkdown({
          id: sessionId,
          title,
          createdAt: events[0]?.time,
          events,
          imported: Boolean(isImported?.(sessionId)),
        });
        const name = safeFileName(title, sessionId, used);
        files.push({ name: `sessions/${name}`, data: Buffer.from(md, 'utf8') });

        // 同时存一份结构化数据，导入端优先读它，读不到再退回 Markdown
        const exchange = toExchangeSession({
          id: sessionId, title, createdAt: events[0]?.time, events, imported: Boolean(isImported?.(sessionId)),
        });
        files.push({ name: `data/${name.replace(/\.md$/, '')}.json`, data: Buffer.from(JSON.stringify(exchange), 'utf8') });
        summary.exported += 1;
        progress.bump('done');
      } catch (e) {
        summary.failed += 1;
        progress.fail(title, String(e?.message ?? e));
      }
      await new Promise(r => setImmediate(r));
    }

    // 取消也落一份清单，只包含实际完成的会话
    if (files.length === 0) return { ...summary, cancelled: progress.cancelled };
    const manifest = {
      schema: 'dsh-session-history/export',
      version: 2,
      exportedAt: new Date().toISOString(),
      sessions: files.filter(f => f.name.startsWith('sessions/')).map(f => f.name),
      data: files.filter(f => f.name.startsWith('data/')).map(f => f.name),
      failed: summary.failed,
    };
    files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

    const zipBuf = buildZip(files);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, zipBuf);
    summary.bytes = zipBuf.length;
    summary.files = files.map(f => f.name);
  } finally {
    progress.finish(progress.cancelled ? 'cancelled' : 'completed');
    lock.release();
  }

  return { ...summary, outcome: progress.cancelled ? 'cancelled' : 'completed' };
}