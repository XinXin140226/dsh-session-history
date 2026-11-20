// 导入导出共用任务状态：进度、统计、取消信号。节流推送。
export class TaskProgress {
  constructor(emit, throttleMs = 100) {
    this.emit = emit;
    this.throttleMs = throttleMs;
    this.state = {
      kind: undefined, // 'import' | 'export'
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      currentTitle: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      cancelled: false,
      errors: [],
      warnings: [],
      images: 0,
      imageFailures: 0,
    };
    this.cancelled = false;
    this.lastEmit = 0;
    this.pending = false;
  }

  start(kind, total) {
    this.state = { ...this.state, kind, running: true, total, done: 0, failed: 0, skipped: 0,
      currentTitle: undefined, startedAt: Date.now(), finishedAt: undefined, cancelled: false, errors: [], warnings: [], images: 0, imageFailures: 0 };
    this.cancelled = false;
    this.push(true);
  }

  setCurrent(title) {
    this.state.currentTitle = title;
    this.push();
  }

  bump(field = 'done') {
    this.state[field] += 1;
    this.push();
  }

  skip() { this.state.skipped += 1; this.push(); }

  warn(message) {
    if (this.state.warnings.length < 100) this.state.warnings.push(String(message));
    this.push();
  }

  fail(title, reason) {
    this.state.failed += 1;
    if (this.state.errors.length < 100) this.state.errors.push({ title, reason });
    this.push();
  }

  addImages(ok, failed) {
    this.state.images += ok;
    this.state.imageFailures += failed;
    this.push();
  }

  cancel() {
    this.cancelled = true;
    this.state.cancelled = true;
    this.push(true);
  }

  finish() {
    this.state.running = false;
    this.state.finishedAt = Date.now();
    this.state.currentTitle = undefined;
    this.push(true);
  }

  get() { return { ...this.state }; }

  // 节流：立即推一次，其余按间隔合并
  push(force = false) {
    const now = Date.now();
    if (force || now - this.lastEmit >= this.throttleMs) {
      this.lastEmit = now;
      this.pending = false;
      try { this.emit(this.get()); } catch { /* 推送失败不影响任务 */ }
      return;
    }
    if (this.pending) return;
    this.pending = true;
    const timer = setTimeout(() => {
      this.pending = false;
      this.lastEmit = Date.now();
      try { this.emit(this.get()); } catch { /* 同上 */ }
    }, this.throttleMs);
    timer.unref?.();
  }
}