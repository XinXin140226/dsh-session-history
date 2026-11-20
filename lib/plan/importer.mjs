// 导入执行器。不认识 DSH 的服务实现，只接收注入进来的能力。
// services: { persistence, idmap, lock, progress, params, resolveCwd, imageRefs? }
import { openZip } from '../zip/reader.mjs';
import { parseSession, isEmptySession } from '../deepseek/parse.mjs';
import { mapSession, assertInvariants } from '../map/events.mjs';
import { importImages } from '../deepseek/images.mjs';
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence';
import { randomUUID } from 'node:crypto';

// 读清单：只读索引文件，不碰会话正文
export async function readCatalog(zipPath) {
  const zip = await openZip(zipPath);
  try {
    const names = [...zip.entries.keys()];

    // 索引文件名在不同版本里可能带目录或大小写不同，先模糊找
    const indexName = names.find(n => /(^|\/)chat_session_index\.json$/i.test(n));
    if (indexName !== undefined) {
      const list = JSON.parse(await zip.read(indexName));
      if (!Array.isArray(list)) throw new Error('索引文件不是数组，可能不是同一种导出包');
      return list.map(e => ({
        originId: e.id,
        title: typeof e.title === 'string' ? e.title : '',
        pinned: e.pinned === true,
        messageCount: Number(e.message_count ?? 0),
        updatedAtMs: Date.parse(e.updated_at) || 0,
      }));
    }

    // 没有索引就按会话文件兜底：列出 chat_sessions 下的 json，标题留空
    const sessionFiles = names.filter(n => /chat_sessions\/[^/]+\.json$/i.test(n) && !n.includes('_files/'));
    if (sessionFiles.length === 0) {
      const sample = names.slice(0, 20).join('\n  ');
      throw new Error(`这个包里没有 chat_session_index.json，也没有 chat_sessions 目录。\n包里前 20 个条目：\n  ${sample}`);
    }
    return sessionFiles.map(n => ({
      originId: n.slice(n.lastIndexOf('/') + 1, -5),
      title: '',
      pinned: false,
      messageCount: 0,
      updatedAtMs: 0,
    }));
  } finally {
    await zip.close();
  }
}

export async function runImport({ zipPath, selectedIds, services }) {
  const { persistence, idmap, lock, progress, params, resolveCwd, presetId, timeStrategy = 'original', includeToolLine = true, toolSummary = 'line', provenance = true, attachments, withImages = false } = services;

  lock.acquire();
  progress.start('import', selectedIds.length);
  const summary = { imported: 0, skipped: 0, failed: 0, events: 0, images: 0, imageFailures: 0, savedBytes: 0 };

  let zip;
  try {
    zip = await openZip(zipPath);
    const batch = [];

    for (const originId of selectedIds) {
      if (progress.cancelled) break;
      if (idmap.has(originId)) { progress.skip(); summary.skipped += 1; continue; }

      let titleForError = originId;
      try {
        const raw = JSON.parse(await zip.read(`chat_sessions/${originId}.json`));
        const parsed = parseSession(raw, { toolSummary });
        titleForError = parsed.title ?? originId;
        progress.setCurrent(titleForError);

        if (isEmptySession(parsed)) { progress.skip(); summary.skipped += 1; continue; }

        const sessionId = `session-${randomUUID()}`;
        const createdAt = timeStrategy === 'import-time' ? Date.now() : (parsed.insertedAtMs ?? Date.now());

        // 图片是实验性通道：只有显式开启且附件服务可用时才取图，失败不外溢到文本
        let imageRefs;
        if (withImages && attachments) {
          try {
            const got = await importImages({
              zip, parsed, attachments, originId,
              onWarn: (msg) => progress.warn?.(msg),
            });
            imageRefs = got.refs;
            summary.images += got.refs.size;
            summary.imageFailures += got.failures.length;
            summary.savedBytes += got.savedBytes ?? 0;
            progress.addImages?.(got.refs.size, got.failures.length, got.savedBytes ?? 0);
          } catch (e) {
            progress.warn?.(`${originId} 的图片通道整体失败：${String(e?.message ?? e)}`);
            summary.imageFailures += 1;
          }
        }

        const { header, events } = mapSession(parsed, {
          sessionId,
          cwd: resolveCwd(parsed, originId),
          createdAtMs: createdAt,
          presetId,
          includeToolLine,
          provenance,
          imageRefs,
        });
        assertInvariants(header, events);
        materializeAppendBatch(events); // 官方干跑校验，不合法不建会话

        const handle = await persistence.create(header);
        try {
          for (let i = 0; i < events.length; i += params.batchSize) {
            await handle.append(events.slice(i, i + params.batchSize));
          }
          await handle.flush();
        } finally {
          await handle.close();
        }

        idmap.record(originId, sessionId, { title: titleForError });
        summary.imported += 1;
        summary.events += events.length;
        progress.bump('done');
      } catch (e) {
        summary.failed += 1;
        progress.fail(titleForError, String(e?.message ?? e));
      }

      // 让出事件循环，界面不卡
      await new Promise(r => setImmediate(r));
    }
  } finally {
    try { await zip?.close(); } catch { /* 已关闭 */ }
    progress.finish();
    lock.release();
  }

  return summary;
}