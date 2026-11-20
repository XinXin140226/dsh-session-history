// 图片导入（实验性）。从导出包里取图，交给 DSH 自己的附件存储，不在本地另存一份。
// 尺寸与体积的收敛交给存储层：它会把超过归一化阈值的图重编码，我们不做二次处理。
const EXT_MEDIA = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

export function mediaTypeOf(fileName) {
  const idx = String(fileName ?? '').lastIndexOf('.');
  if (idx < 0) return undefined;
  return EXT_MEDIA.get(fileName.slice(idx + 1).toLowerCase());
}

// 收集一个会话里所有图片的导出路径
export function imagePathsOf(parsed) {
  const out = new Set();
  for (const turn of parsed.turns) {
    for (const f of turn.userFiles) {
      if (f.isImage && f.exportPath) out.add(f.exportPath);
    }
    for (const step of turn.steps) {
      for (const f of step.files) {
        if (f.isImage && f.exportPath) out.add(f.exportPath);
      }
    }
  }
  return [...out];
}

/**
 * 把一个会话的图片写入附件存储，返回 exportPath 到引用的映射。
 * 单张失败只记一笔，不影响其他图片与会话本身。
 */
export async function importImages({ zip, parsed, attachments, originId, onWarn }) {
  const refs = new Map();
  const failures = [];
  const paths = imagePathsOf(parsed);
  if (paths.length === 0) return { refs, failures, total: 0 };

  for (const exportPath of paths) {
    const name = exportPath.slice(exportPath.lastIndexOf('/') + 1);
    // 导出文件名形如 <id>_<原文件名>，取最后一段下划线之后的部分做展示名
    const display = name.includes('_') ? name.slice(name.indexOf('_') + 1) : name;
    const mediaType = mediaTypeOf(display) ?? mediaTypeOf(name);
    if (mediaType === undefined) {
      failures.push({ name: display, reason: '不是支持的图片格式' });
      continue;
    }
    try {
      const bytes = await zip.read(exportPath);
      const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: display });
      refs.set(exportPath, ref);
    } catch (e) {
      const reason = String(e?.message ?? e);
      failures.push({ name: display, reason });
      onWarn?.(`${originId} 的图片 ${display} 没导入：${reason}`);
    }
  }
  return { refs, failures, total: paths.length };
}
