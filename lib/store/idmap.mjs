// 幂等映射表：追加写 NDJSON，启动时读进内存。记录原始会话 id 到 DSH 会话 id。
// 末行残缺时丢弃，不会把表读坏。
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class IdMap {
  constructor(file) {
    this.file = file;
    this.map = new Map(); // originId -> sessionId
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.originId === 'string' && typeof rec.sessionId === 'string') {
            this.map.set(rec.originId, rec.sessionId);
          }
        } catch { /* 末行残缺，跳过 */ }
      }
    }
  }

  get(originId) { return this.map.get(originId); }
  has(originId) { return this.map.has(originId); }
  size() { return this.map.size; }

  record(originId, sessionId, meta = {}) {
    this.map.set(originId, sessionId);
    appendFileSync(this.file, JSON.stringify({ originId, sessionId, at: Date.now(), ...meta }) + '\n');
  }
}