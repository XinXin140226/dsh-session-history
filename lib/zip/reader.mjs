// 零依赖 zip 读取器。随机访问，不整包入内存。
// 用法：const zip = await openZip(path); const list = await zip.entries(); const bytes = await zip.read(name);
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LFH = 0x04034b50;

const MAX_COMMENT = 65557; // 65535 + 22

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }
function u64(b, o) {
  // ZIP64 八字节小端
  return b.readUInt32LE(o) + b.readUInt32LE(o + 4) * 0x100000000;
}

function findSignature(fd, fileSize, sig, scanFrom) {
  // 从 scanFrom 向前扫到文件尾，返回签名位置；找不到返回 -1
  const start = Math.max(0, scanFrom);
  const len = fileSize - start;
  if (len <= 0) return -1;
  return (async () => {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, start);
    for (let i = bytesRead - 4; i >= 0; i--) {
      if (buf.readUInt32LE(i) === sig) return start + i;
    }
    return -1;
  })();
}

export async function openZip(path) {
  const fd = await open(path, 'r');
  const { size: fileSize } = await fd.stat();

  // 1) 定位 EOCD（扫描尾部 64KB+22 内最后一个匹配）
  const eocdScanStart = Math.max(0, fileSize - MAX_COMMENT);
  const eocdPos = await (async () => {
    const buf = Buffer.alloc(fileSize - eocdScanStart);
    const { bytesRead } = await fd.read(buf, 0, buf.length, eocdScanStart);
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD) return eocdScanStart + i;
    }
    throw new Error('找不到 ZIP 结束记录，可能不是 zip 文件');
  })();

  // 2) 读 EOCD 头部字段
  const eocd = Buffer.alloc(22);
  await fd.read(eocd, 0, 22, eocdPos);
  let entryCount = u16(eocd, 10);
  let cdSize = u32(eocd, 12);
  let cdOffset = u32(eocd, 16);

  // 3) ZIP64 探测：locator 在 EOCD 前 20 字节
  if (cdOffset === 0xffffffff || entryCount === 0xffff || cdSize === 0xffffffff) {
    const locPos = eocdPos - 20;
    if (locPos >= 0) {
      const loc = Buffer.alloc(20);
      const n = await fd.read(loc, 0, 20, locPos);
      if (n.bytesRead === 20 && u32(loc, 0) === SIG_LOC64) {
        const eocd64Offset = u64(loc, 8);
        const z64 = Buffer.alloc(56);
        await fd.read(z64, 0, 56, eocd64Offset);
        if (u32(z64, 0) !== SIG_EOCD64) throw new Error('ZIP64 结束记录损坏');
        entryCount = u64(z64, 32);
        cdSize = u64(z64, 40);
        cdOffset = u64(z64, 48);
      }
    }
  }

  // 4) 读整个中央目录（其体积与条目数线性相关，1992 会话包约几百 KB，可一次读入）
  if (cdSize > 64 * 1024 * 1024) throw new Error('中央目录异常庞大，拒绝处理');
  const cd = Buffer.alloc(cdSize);
  {
    let read = 0;
    while (read < cdSize) {
      const { bytesRead } = await fd.read(cd, read, cdSize - read, cdOffset + read);
      if (bytesRead === 0) throw new Error('中央目录读取中断');
      read += bytesRead;
    }
  }

  // 5) 解析条目
  const entries = new Map(); // name -> {offset, compressedSize, size, method}
  let p = 0;
  while (p + 46 <= cdSize && u32(cd, p) === SIG_CEN) {
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let lfhOffset = u32(cd, p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 扩展字段
    if (extraLen > 0) {
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = u16(cd, q);
        const sz = u16(cd, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff) { size = u64(cd, r); r += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(cd, r); r += 8; }
          if (lfhOffset === 0xffffffff) { lfhOffset = u64(cd, r); r += 8; }
        }
        q += 4 + sz;
      }
    }
    entries.set(name, { offset: lfhOffset, compressedSize, size, method });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`zip 里没有这个条目: ${name}`);
    // 读 local file header 固定 30 字节，算出真实数据偏移
    const lfh = Buffer.alloc(30);
    const n = await fd.read(lfh, 0, 30, e.offset);
    if (n.bytesRead !== 30 || u32(lfh, 0) !== SIG_LFH) throw new Error(`条目 ${name} 的本地头损坏`);
    const nameLen = u16(lfh, 26);
    const extraLen = u16(lfh, 28);
    const dataStart = e.offset + 30 + nameLen + extraLen;
    const compressed = Buffer.alloc(e.compressedSize);
    {
      let got = 0;
      while (got < e.compressedSize) {
        const r = await fd.read(compressed, got, e.compressedSize - got, dataStart + got);
        if (r.bytesRead === 0) throw new Error(`条目 ${name} 数据读取中断`);
        got += r.bytesRead;
      }
    }
    if (e.method === 0) return compressed;
    if (e.method === 8) return inflateRawSync(compressed);
    throw new Error(`条目 ${name} 用了不支持的压缩方法 ${e.method}`);
  }

  async function close() { await fd.close(); }

  return { entries, read, close, fileSize, entryCount: entries.size };
}
