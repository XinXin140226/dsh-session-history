// 附件缓存管理：统计占用、清理、每周自动清一次。
// 只碰 ~/.dsh/cache/attachments 这一个目录，不碰附件本体。
import { readdir, stat, unlink, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try { const st = await stat(full); bytes += st.size; files += 1; } catch { /* 跳过 */ }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

export async function clearDir(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        try { await unlink(full); } catch { /* 空目录删不掉就算了 */ }
      } else {
        try {
          const st = await stat(full);
          await unlink(full);
          bytes += st.size;
          files += 1;
        } catch { /* 跳过 */ }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

export async function lastCleanAt(stampFile) {
  try {
    const raw = (await readFile(stampFile, 'utf8')).trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

export async function markClean(stampFile) {
  await mkdir(join(stampFile, '..'), { recursive: true });
  await writeFile(stampFile, String(Date.now()), 'utf8');
}

// 距离上次清理超过七天就该清了。从没清过也算该清。
export async function dueForClean(stampFile, now = Date.now()) {
  const last = await lastCleanAt(stampFile);
  if (last === 0) return true;
  return now - last >= WEEK_MS;
}

export async function autoCleanIfDue({ cacheDir, stampFile, logger }) {
  try {
    if (!(await dueForClean(stampFile))) return { skipped: true };
    const removed = await clearDir(cacheDir);
    await markClean(stampFile);
    logger?.info?.('session history: 清理附件缓存 %s 个文件，释放 %s 字节', removed.files, removed.bytes);
    return { ...removed, skipped: false };
  } catch (e) {
    logger?.warn?.('session history: 自动清理缓存失败 %s', String(e?.message ?? e));
    return { error: String(e?.message ?? e) };
  }
}