/**
 * Scene stack.
 *
 * Scenes below the top keep drawing (so a pause overlay shows the frozen game
 * behind it) but stop updating unless they opt in. This keeps transitions
 * cheap: no scene ever has to render the one underneath itself.
 */

import type { Ctx, Scene } from './ctx';

export class SceneStack {
  private scenes: Scene[] = [];
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  get top(): Scene | undefined {
    return this.scenes[this.scenes.length - 1];
  }

  push(s: Scene): void {
    this.scenes.push(s);
    s.enter?.(this.ctx);
  }

  pop(): void {
    const s = this.scenes.pop();
    s?.exit?.(this.ctx);
  }

  replace(s: Scene): void {
    while (this.scenes.length) this.pop();
    this.push(s);
  }

  update(dt: number): void {
    this.top?.update(this.ctx, dt);
  }

  render(): void {
    const ctx = this.ctx;
    const r = ctx.r;
    // Counters span the whole frame, not one pass.
    r.resetStats();
    // Deep sky indigo: on a tall phone the portrait cap letterboxes, and this
    // is what fills the bars — a sky tone reads as atmosphere, not as a bar.
    r.clear(0.055, 0.075, 0.18);
    r.begin(ctx.cam.x + ctx.cam.shakeX, ctx.cam.y + ctx.cam.shakeY, ctx.cam.zoom);
    for (const s of this.scenes) s.draw(ctx);
    r.end();

    // HUD renders unshaken and unzoomed so text never wobbles or blurs.
    //
    // It is also exempt from raw mode. Raw mode exists to show the painted
    // world exactly as authored, and it does that by forcing every sprite's
    // colour multiply to white — but interface art is baked white on purpose
    // and gets all of its colour at draw time, so the same switch erased the
    // HUD entirely. The world is the thing being judged; the UI just needs to
    // stay readable while you judge it.
    const rawWorld = r.rawMode;
    r.rawMode = false;
    r.begin(0, 0, 1);
    for (const s of this.scenes) s.drawUi?.(ctx);
    r.end();
    r.rawMode = rawWorld;
  }
}
