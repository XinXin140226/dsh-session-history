// 导出执行器：从 sessionQuery 读会话，渲染 Markdown，打包 zip，后台跑，支持取消。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderMarkdown, titleFromEvents, buildZip, safeFileName } from '../report/markdown.mjs';

// 读单个会话的完整事件流。优先 sessionQuery.readSession，退回 persistence 读句柄。
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
  const { lock, progress, idmap } = services;
  lock.acquire();
  progress.start('export', sessionIds.length);
  const summary = { exported: 0, failed: 0, bytes: 0, files: [] };

  try {
    const used = new Set();
    const files = [];

    for (const sessionId of sessionIds) {
      if (progress.cancelled) break;
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
          imported: Boolean(idmap?.has?.(sessionId)),
        });
        const name = safeFileName(title, sessionId, used);
        files.push({ name, data: Buffer.from(md, 'utf8') });
        summary.exported += 1;
        progress.bump('done');
      } catch (e) {
        summary.failed += 1;
        progress.fail(title, String(e?.message ?? e));
      }
      await new Promise(r => setImmediate(r));
    }

    // 清单文件
    const manifest = {
      exportedAt: new Date().toISOString(),
      count: files.length,
      files: files.map(f => f.name),
      failed: summary.failed,
    };
    files.push({ name: '清单.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

    const zipBuf = buildZip(files);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, zipBuf);
    summary.bytes = zipBuf.length;
    summary.files = files.map(f => f.name);
  } finally {
    progress.finish();
    lock.release();
  }

  return summary;
}