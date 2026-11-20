// 单任务锁：同一时间只允许一个导入或导出任务。持有进程死掉视为陈旧锁。
import { openSync, writeSync, closeSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class TaskLock {
  constructor(file) { this.file = file; }

  acquire() {
    mkdirSync(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      let stale = false;
      try {
        const info = JSON.parse(readFileSync(this.file, 'utf8'));
        if (typeof info.pid === 'number') {
          try { process.kill(info.pid, 0); } catch { stale = true; }
        } else stale = true;
      } catch { stale = true; }
      if (!stale) throw new Error('已有导入或导出任务在跑，等它结束或取消后再试');
      try { unlinkSync(this.file); } catch { /* 已被清掉 */ }
    }
    const fd = openSync(this.file, 'w');
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    this.held = true;
  }

  release() {
    if (!this.held) return;
    try { unlinkSync(this.file); } catch { /* 已不存在 */ }
    this.held = false;
  }
}