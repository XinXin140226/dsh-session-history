// 导入执行器。不认识 DSH 的服务实现，只接收注入进来的能力。
import { openZip } from '../zip/reader.mjs';
import { parseSession, isEmptySession } from '../deepseek/parse.mjs';
import { mapSession, assertInvariants } from '../map/events.mjs';
import { importImages } from '../deepseek/images.mjs';
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence';
import { randomUUID } from 'node:crypto';

function exchangeToDeepSeek(one) {
  if (one?.schema !== 'dsh-session-history/exchange' || !Array.isArray(one.turns)) {
    throw new Error('这个结构化数据不是本插件导出的格式');
  }
  return {
    id: one.origin?.sessionId ?? 'exchanged',
    title: one.title,
    pinned: false,
    inserted_at: Number.isFinite(one.createdAt) ? new Date(one.createdAt).toISOString() : undefined,
    updated_at: Number.isFinite(one.createdAt) ? new Date(one.createdAt).toISOString() : undefined,
    messages: one.turns.flatMap((turn) => {
      const msgs = [];
      const userText = (turn.user ?? []).filter(b => b.kind === 'text').map(b => b.text).join('\n\n');
      const userFiles = (turn.user ?? []).filter(b => b.kind === 'image')
        .map(b => ({ file_name: b.name ?? '图片', is_image: true }));
      msgs.push({
        role: 'USER',
        inserted_at: Number.isFinite(turn.at) ? new Date(turn.at).toISOString() : undefined,
        fragments: [
          ...(userText === '' ? [] : [{ type: 'REQUEST', content: userText }]),
          ...(userFiles.length === 0 ? [] : [{ type: 'FILE', files: userFiles }]),
        ],
      });
      const frags = [];
      for (const b of turn.assistant ?? []) {
        if (b.kind === 'reasoning') frags.push({ type: 'THINK', content: b.text });
        else if (b.kind === 'text') frags.push({ type: 'RESPONSE', content: b.text });
        else if (b.kind === 'image') frags.push({ type: 'FILE', files: [{ file_name: b.name ?? '图片', is_image: true }] });
      }
      msgs.push({ role: 'ASSISTANT', inserted_at: Number.isFinite(turn.at) ? new Date(turn.at).toISOString() : undefined, fragments: frags });
      return msgs;
    }),
  };
}

export async function readCatalog(zipPath) {
  const zip = await openZip(zipPath);
  try {
    const names = [...zip.entries.keys()];

    // 本插件自己导出的包：认 manifest，读 data 下的结构化数据
    const mf = names.find(n => /(^|\/)manifest\.json$/i.test(n));
    if (mf !== undefined) {
      try {
        const m = JSON.parse(await zip.read(mf));
        if (m?.schema === 'dsh-session-history/export' && Array.isArray(m.data) && m.data.length > 0) {
          const out = [];
          for (const dataPath of m.data) {
            try {
              const one = JSON.parse(await zip.read(dataPath));
              if (one?.schema !== 'dsh-session-history/exchange') continue;
              out.push({
                originId: dataPath,
                title: typeof one.title === 'string' && one.title.trim() !== '' ? one.title : `会话 ${dataPath.split('/').pop().replace(/\.json$/, '').slice(-8)}`,
                pinned: false,
                messageCount: Array.isArray(one.turns) ? one.turns.reduce((n, t) => n + (t.user?.length ?? 0) + (t.assistant?.length ?? 0), 0) : 0,
                updatedAtMs: Number(one.createdAt) || 0,
                kind: 'exchange',
              });
            } catch { /* 单个损坏的数据文件只跳过它 */ }
          }
          if (out.length > 0) return out;
        }
      } catch { /* manifest 坏了就继续按 DeepSeek 格式试 */ }
    }

    // 索引文件名在不同版本里可能带目录或大小写不同，先模糊找
    const indexName = names.find(n => /(^|\/)chat_session_index\.json$/i.test(n));
    if (indexName !== undefined) {
      const list = JSON.parse(await zip.read(indexName));
      if (!Array.isArray(list)) throw new Error('索引文件不是数组，可能不是同一种导出包');
      const valid = list.filter(e => typeof e?.id === 'string' && e.id !== '');
      if (valid.length === 0) throw new Error('索引里没有可用会话');
      return valid.map(e => ({
        originId: e.id,
        title: typeof e.title === 'string' && e.title.trim() !== '' ? e.title : `会话 ${String(e.id).slice(-8)}`,
        pinned: e.pinned === true,
        messageCount: Number(e.message_count ?? 0),
        updatedAtMs: Date.parse(e.updated_at) || 0,
        kind: 'deepseek',
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
      title: `会话 ${n.slice(-13, -5)}`,
      pinned: false,
      messageCount: 0,
      updatedAtMs: 0,
      kind: 'deepseek',
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

    for (const originId of selectedIds) {
      if (progress.cancelled) {
        summary.skipped += 1;
        progress.skip();
        break;
      }
      if (idmap.has(originId)) { progress.skip(); summary.skipped += 1; continue; }

      let titleForError = originId;
      try {
        const isExchange = originId.endsWith('.json') && originId.includes('data/');
        const raw = isExchange
          ? exchangeToDeepSeek(JSON.parse(await zip.read(originId)))
          : JSON.parse(await zip.read(`chat_sessions/${originId}.json`));
        const parsed = parseSession(raw, { toolSummary });
        titleForError = parsed.title ?? originId;
        progress.setCurrent(titleForError);

        if (isEmptySession(parsed)) { progress.skip(); summary.skipped += 1; continue; }
        if (isExchange && parsed.turns.length === 0) { progress.skip(); summary.skipped += 1; continue; }
        const meaningfulTurns = parsed.turns.filter(t => t.userText.trim() !== '' || t.userFiles.length > 0 || t.steps.some(s => s.blocks.length > 0 || s.files.length > 0));
        if (meaningfulTurns.length === 0) { progress.skip(); summary.skipped += 1; continue; }
        parsed.turns = meaningfulTurns;

        const sessionId = `session-${randomUUID()}`;
        const createdAt = timeStrategy === 'import-time' ? Date.now() : (parsed.insertedAtMs ?? Date.now());

        let imageRefs;
        if (withImages && attachments) {
          try {
            const got = await importImages({
              zip, parsed, attachments, originId, originals: services.originals,
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

        // 官方包固定极简，插件包用调用方选的预设
        const effectivePreset = services.presetIdFor?.(isExchange ? 'exchange' : 'deepseek') ?? presetId;
        const { header, events } = mapSession(parsed, {
          sessionId,
          cwd: resolveCwd(parsed, originId),
          createdAtMs: createdAt,
          presetId: effectivePreset,
          includeToolLine,
          provenance,
          imageRefs,
        });
        assertInvariants(header, events);
        materializeAppendBatch(events);

        const handle = await persistence.create(header);
        try {
          for (let i = 0; i < events.length; i += params.batchSize) {
            await handle.append(events.slice(i, i + params.batchSize));
          }
          await handle.flush();
        } finally {
          await handle.close();
        }

        idmap.record(originId, sessionId, { title: titleForError, kind: isExchange ? 'exchange' : 'deepseek' });
        summary.imported += 1;
        summary.events += events.length;
        progress.bump('done');
      } catch (e) {
        summary.failed += 1;
        progress.fail(titleForError, String(e?.message ?? e));
      }

      await new Promise(r => setImmediate(r));
    }
  } finally {
    try { await zip?.close(); } catch { /* 已关闭 */ }
    progress.finish(progress.cancelled ? 'cancelled' : 'completed');
    lock.release();
  }

  return { ...summary, outcome: progress.cancelled ? 'cancelled' : 'completed' };
}