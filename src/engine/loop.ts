/**
 * Fixed-timestep game loop.
 *
 * Simulation runs at a fixed rate so physics and feel are identical on 60Hz,
 * 90Hz and 144Hz displays.
 *
 * ==========================================================================
 * WHAT THE INTERPOLATION ALPHA ACTUALLY DOES: NOTHING
 * ==========================================================================
 *
 * `render(alpha, dt)` is handed the fraction of a step left in the
 * accumulator, and `main.ts` publishes it as `ctx.alpha`. Nothing reads it.
 * There is no interpolation anywhere in the game: every draw uses the latest
 * simulation state as-is.
 *
 * This is worth knowing before anyone lowers `hz`. The 120 Hz rate is what
 * makes the missing interpolation invisible — the drawn state is never more
 * than 8.3 ms stale, which is under one frame even on a 120 Hz panel. Halve
 * the rate and the staleness doubles into visible judder on a high-refresh
 * display, because there is no interpolation to cover it.
 *
 * Measured against that trade (`tools/stress.mjs`): at a hundred times the
 * present entity count a simulation step costs 0.18 ms, so dropping to 60 Hz
 * would save about 0.18 ms of a 16.7 ms frame. That is 1%, in exchange for
 * building interpolation into every entity. It is not worth doing until a
 * step costs multiple milliseconds.
 *
 * ==========================================================================
 * THE maxSteps CEILING
 * ==========================================================================
 *
 * `hz` steps of simulated time per second, at most `maxSteps` of them per
 * frame, means the loop can only follow real time down to `hz / maxSteps` frames
 * per second. The game runs 120 Hz with `maxSteps: 4`, so below **30 fps the
 * simulation silently runs slow** — at 20 fps it advances at 60% of real time.
 * It does not spiral (shedding the debt is what prevents that) and it does not
 * explode; it dilates, with no signal that it is happening. `stats.steps`
 * pinned at `maxSteps` is the tell.
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
  /**
   * `alpha` is the fraction of a simulation step left in the accumulator.
   * Nothing in the game reads it — see the note at the top of this file.
   */
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

    // The three `performance.now()` calls in this function are the single
    // largest allocation site in the game: measured with Chrome's heap
    // sampler, they cost ~66 bytes a frame, because the double a Web IDL call
    // returns is boxed into a heap number whenever the callback is too big for
    // V8 to take the fast-API path. Stripping them and leaving everything else
    // took this callback from 90 to 24 bytes a frame.
    //
    // They stay. Those bytes die inside the frame that made them, the loop's
    // own `longFrames` counter recorded zero frames over budget across a
    // 60-second soak, and the alternative is a diagnostic that only samples
    // some frames — which is the one property a hitch counter must not have.
    // See docs/CPU-AUDIT.md.
    const uStart = performance.now();
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      this.update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    // Shed the debt rather than carrying it: a loop that tries to catch up
    // after a stall runs more steps next frame, which makes the next frame
    // slower still. Dropping the remainder is what stops that spiral — at the
    // cost of the time dilation described at the top of this file.
    if (steps === this.maxSteps) this.accumulator = 0;
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
