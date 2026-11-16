/**
 * perf.ts — section timer for render(), dev/QA only (window.__perf).
 * Zero-cost while disabled: every entry point returns on a single boolean check.
 * When enabled it rolls a 1s window of average ms-per-frame per named section.
 */

export class PerfProbe {
  enabled = false;
  /** average ms per frame per section over the last window */
  report: Record<string, number> = {};
  fps = 0;
  /** raw frame total (sum of sections) per frame */
  total = 0;

  private acc: Record<string, number> = {};
  private frames = 0;
  private winStart = 0;
  private markAt = 0;
  private cur = "";

  begin(): void {
    if (!this.enabled) return;
    this.cur = "bg+stars";
    this.markAt = performance.now();
    if (this.frames === 0) this.winStart = this.markAt;
  }

  mark(name: string): void {
    if (!this.enabled) return;
    const t = performance.now();
    this.acc[this.cur] = (this.acc[this.cur] ?? 0) + (t - this.markAt);
    this.markAt = t;
    this.cur = name;
  }

  /** fixed-step logic timing (begin/end around update); counted once per rendered frame */
  updateMs = 0;
  private updAcc = 0;

  beginUpdate(): void {
    if (!this.enabled) return;
    this.markAt = performance.now();
  }

  endUpdate(): void {
    if (!this.enabled) return;
    this.updAcc += performance.now() - this.markAt;
  }

  end(): void {
    if (!this.enabled) return;
    const t = performance.now();
    this.acc[this.cur] = (this.acc[this.cur] ?? 0) + (t - this.markAt);
    this.frames++;
    const el = t - this.winStart;
    if (el >= 1000) {
      this.fps = (this.frames * 1000) / el;
      let sum = 0;
      for (const k of Object.keys(this.acc)) {
        this.report[k] = this.acc[k] / this.frames;
        sum += this.report[k];
      }
      this.updateMs = this.updAcc / this.frames;
      this.report["update"] = this.updateMs;
      sum += this.updateMs;
      this.total = sum;
      this.acc = {};
      this.updAcc = 0;
      this.frames = 0;
      this.winStart = t;
    }
  }
}

/** Shared probe instance; render() calls into it, __perf reads the live report. */
export const perf = new PerfProbe();
