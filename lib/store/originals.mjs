// 原图仓库：压缩过的图片在这里留一份原始字节，查看原图时读它。
// 按附件 id 命名，一个文件一张图，目录里另有 index.json 记元数据。
import { mkdir, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class OriginalStore {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = join(dir, 'index.json');
    this.index = null;
  }

  async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  async load() {
    if (this.index !== null) return this.index;
    try {
      this.index = JSON.parse(await readFile(this.indexFile, 'utf8'));
    } catch {
      this.index = {};
    }
    return this.index;
  }

  async save() {
    await this.ensure();
    await writeFile(this.indexFile, JSON.stringify(this.index ?? {}), 'utf8');
  }

  /** 存一张原图。同一 id 已存在就跳过，避免重复写。 */
  async put(id, bytes, mediaType, name) {
    if (typeof id !== 'string' || id === '') throw new Error('缺少附件 id');
    await this.ensure();
    const index = await this.load();
    if (index[id] !== undefined) return index[id];
    const file = join(this.dir, `${id}.bin`);
    await writeFile(file, bytes);
    index[id] = { mediaType, name, size: bytes.length, at: Date.now() };
    await this.save();
    return index[id];
  }

  async get(id) {
    const index = await this.load();
    const meta = index[id];
    if (meta === undefined) return undefined;
    try {
      const bytes = await readFile(join(this.dir, `${id}.bin`));
      return { bytes, ...meta };
    } catch {
      return undefined;
    }
  }

  async has(id) {
    const index = await this.load();
    return index[id] !== undefined;
  }

  /** 统计占用与张数。 */
  async usage() {
    const index = await this.load();
    let bytes = 0;
    let files = 0;
    for (const meta of Object.values(index)) {
      bytes += Number(meta?.size ?? 0);
      files += 1;
    }
    return { bytes, files };
  }

  /** 清空原图仓库。 */
  async clear() {
    await this.ensure();
    const before = await this.usage();
    let names = [];
    try { names = await readdir(this.dir); } catch { /* 空目录 */ }
    for (const name of names) {
      try { await unlink(join(this.dir, name)); } catch { /* 跳过 */ }
    }
    this.index = {};
    await this.save();
    return before;
  }
}
