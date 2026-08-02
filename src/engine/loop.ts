/**
 * Fixed-timestep game loop with render interpolation.
 *
 * Simulation runs at a fixed rate so physics and feel are identical on 60Hz,
 * 90Hz and 144Hz displays; rendering interpolates between the last two
 * simulation states so motion stays smooth on high-refresh panels.
 */

export interface LoopStats {
  /** Smoothed frames per second. */
  fps: number;
  /** Smoothed milliseconds spent inside update(). */
  updateMs: number;
  /** Smoothed milliseconds spent inside render(). */
  renderMs: number;
  /** Simulation steps executed in the last frame. */
  steps: number;
  /** Frames whose total CPU time exceeded the display budget. */
  longFrames: number;
}

export interface LoopOptions {
  /** Simulation steps per second. */
  hz?: number;
  /** Maximum simulation steps per frame before time is discarded. */
  maxSteps?: number;
  update: (dt: number) => void;
  render: (alpha: number, dt: number) => void;
}

export class Loop {
  readonly stats: LoopStats = { fps: 60, updateMs: 0, renderMs: 0, steps: 0, longFrames: 0 };

  private hz: number;
  private step: number;
  private maxSteps: number;
  private update: (dt: number) => void;
  private render: (alpha: number, dt: number) => void;

  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private frameCount = 0;
  private fpsWindowStart = 0;

  constructor(opts: LoopOptions) {
    this.hz = opts.hz ?? 120;
    this.step = 1 / this.hz;
    this.maxSteps = opts.maxSteps ?? 5;
    this.update = opts.update;
    this.render = opts.render;

    // Dropping accumulated time on tab-restore prevents a burst of catch-up
    // steps that would teleport the player.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastTime = performance.now();
        this.accumulator = 0;
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.fpsWindowStart = this.lastTime;
    this.frameCount = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp so a stall never produces a physics explosion.
    if (frameTime > 0.25) frameTime = 0.25;
    this.accumulator += frameTime;

    const uStart = performance.now();
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      this.update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    if (steps === this.maxSteps) this.accumulator = 0; // shed debt, stay responsive
    const uEnd = performance.now();

    const alpha = this.accumulator / this.step;
    this.render(alpha, frameTime);
    const rEnd = performance.now();

    const s = this.stats;
    s.steps = steps;
    s.updateMs += ((uEnd - uStart) - s.updateMs) * 0.1;
    s.renderMs += ((rEnd - uEnd) - s.renderMs) * 0.1;
    if (rEnd - uStart > 14) s.longFrames++;

    this.frameCount++;
    if (now - this.fpsWindowStart >= 500) {
      s.fps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
      this.frameCount = 0;
      this.fpsWindowStart = now;
    }
  };
}
