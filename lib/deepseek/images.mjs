// 图片导入。从导出包里取图，压缩后交给 DSH 附件存储。
// 压缩用 sharp，环境里没有就原样入库，只记一条警告，不阻断导入。
import { randomUUID } from 'node:crypto';

const EXT_MEDIA = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

// 超过这两个阈值才重新编码，避免小图被无谓地转劣
const MAX_EDGE = 2048;
const MAX_BYTES = 1.2 * 1024 * 1024;
const JPEG_QUALITY = 82;
const WEBP_QUALITY = 78;

export function mediaTypeOf(fileName) {
  const idx = String(fileName ?? '').lastIndexOf('.');
  if (idx < 0) return undefined;
  return EXT_MEDIA.get(fileName.slice(idx + 1).toLowerCase());
}

let sharpModule;

// sharp 装在 DSH 自己的 node_modules 里，插件目录直接 import 解析不到。
// 先走普通解析，再按 dsh 安装位置找，都失败就退回不压缩。
async function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  const attempts = [];
  try { attempts.push('sharp'); } catch { /* 忽略 */ }
  try {
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const req = createRequire(import.meta.url);
    // 借任意一个 @deepseek-ai 包定位 dsh 的 node_modules
    const anchor = req.resolve('@deepseek-ai/dsh-session/package.json');
    const dshNodeModules = join(dirname(anchor), '..', '..');
    const sharpDir = join(dshNodeModules, 'sharp');
    attempts.push(join(sharpDir, 'dist', 'index.mjs'));
    attempts.push(sharpDir);
  } catch { /* 定位失败就只试普通解析 */ }

  for (const spec of attempts) {
    try {
      const mod = await import(spec);
      const candidate = mod.default ?? mod;
      if (typeof candidate === 'function') { sharpModule = candidate; return sharpModule; }
    } catch { /* 试下一个 */ }
  }
  sharpModule = null;
  return sharpModule;
}

// 压到长边 2048、JPEG 质量 82。动图与本来就很小的图跳過。
export async function compressImage(bytes, mediaType) {
  const sharp = await loadSharp();
  if (!sharp) return { data: bytes, mediaType, compressed: false, reason: '环境里没有图像库' };
  if (mediaType === 'image/gif') return { data: bytes, mediaType, compressed: false, reason: '动图不处理' };
  if (bytes.length <= MAX_BYTES) {
    try {
      const meta = await sharp(bytes).metadata();
      const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (longEdge <= MAX_EDGE) return { data: bytes, mediaType, compressed: false, width: meta.width, height: meta.height };
    } catch {
      return { data: bytes, mediaType, compressed: false, reason: '读不出尺寸' };
    }
  }
  try {
    // 保持原编码再压一次：webp 截图转 JPEG 往往更大，转了反而亏
    const pipeline = sharp(bytes).resize({
      width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true,
    });
    if (mediaType === 'image/png') pipeline.png({ compressionLevel: 9, palette: true });
    else if (mediaType === 'image/webp') pipeline.webp({ quality: WEBP_QUALITY });
    else pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    const out = await pipeline.toBuffer({ resolveWithObject: true });

    // 压完更大就保留原图，不为了统一格式牺牲体积
    if (out.data.length >= bytes.length) {
      const meta = await sharp(bytes).metadata();
      return { data: bytes, mediaType, compressed: false, width: meta.width, height: meta.height, reason: '压缩后反而更大' };
    }
    return {
      data: new Uint8Array(out.data),
      mediaType,
      compressed: true,
      width: out.info.width,
      height: out.info.height,
      before: bytes.length,
      after: out.data.length,
    };
  } catch (e) {
    return { data: bytes, mediaType, compressed: false, reason: String(e?.message ?? e) };
  }
}

export function imagePathsOf(parsed) {
  const out = new Set();
  for (const turn of parsed.turns) {
    for (const f of turn.userFiles) if (f.isImage && f.exportPath) out.add(f.exportPath);
    for (const step of turn.steps) {
      for (const f of step.files) if (f.isImage && f.exportPath) out.add(f.exportPath);
    }
  }
  return [...out];
}

export async function importImages({ zip, parsed, attachments, originId, onWarn, onStat }) {
  const refs = new Map();
  const failures = [];
  const paths = imagePathsOf(parsed);
  if (paths.length === 0) return { refs, failures, total: 0, savedBytes: 0 };

  let savedBytes = 0;
  for (const exportPath of paths) {
    const base = exportPath.slice(exportPath.lastIndexOf('/') + 1);
    const display = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
    const mediaType = mediaTypeOf(display) ?? mediaTypeOf(base);
    if (mediaType === undefined) {
      failures.push({ name: display, reason: '不是支持的图片格式' });
      continue;
    }
    try {
      const raw = await zip.read(exportPath);
      const packed = await compressImage(raw, mediaType);
      if (packed.compressed && Number.isFinite(packed.before)) savedBytes += packed.before - packed.after;
      onStat?.(packed.compressed ? 1 : 0);
      const ref = await attachments.saveImage({
        data: packed.data instanceof Uint8Array ? packed.data : new Uint8Array(packed.data),
        mediaType: packed.mediaType,
        name: display,
      });
      refs.set(exportPath, ref);
    } catch (e) {
      const reason = String(e?.message ?? e);
      failures.push({ name: display, reason });
      onWarn?.(`${originId} 的图片 ${display} 没导入：${reason}`);
    }
  }
  return { refs, failures, total: paths.length, savedBytes };
}