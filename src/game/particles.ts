/**
 * Pooled particle system.
 *
 * Fixed-capacity struct-of-arrays: no allocation after construction, no GC
 * pressure mid-run, and the whole system draws inside the existing sprite
 * batch. Dead particles are swapped with the last live one so the live range
 * stays contiguous and iteration is cache-friendly.
 */

import type { Ctx } from '../core/ctx';
import { Blend, type Frame } from '../engine/gl';

const CAP = 2048;

export interface EmitOptions {
  frame: Frame;
  x: number;
  y: number;
  count: number;
  /** Speed range. */
  speed: [number, number];
  /** Emission arc centre and half-width, radians. */
  angle: number;
  spread: number;
  life: [number, number];
  size: [number, number];
  /** Size multiplier at end of life. */
  sizeEnd?: number;
  color: [number, number, number];
  /** Optional second colour; each particle lerps between the two. */
  colorEnd?: [number, number, number];
  gravity?: number;
  drag?: number;
  spin?: number;
  additive?: boolean;
  alpha?: number;
}

export class Particles {
  private x = new Float32Array(CAP);
  private y = new Float32Array(CAP);
  private vx = new Float32Array(CAP);
  private vy = new Float32Array(CAP);
  private life = new Float32Array(CAP);
  private maxLife = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private sizeEnd = new Float32Array(CAP);
  private rot = new Float32Array(CAP);
  private spin = new Float32Array(CAP);
  private r = new Float32Array(CAP);
  private g = new Float32Array(CAP);
  private b = new Float32Array(CAP);
  private r2 = new Float32Array(CAP);
  private g2 = new Float32Array(CAP);
  private b2 = new Float32Array(CAP);
  private alpha = new Float32Array(CAP);
  private gravity = new Float32Array(CAP);
  private drag = new Float32Array(CAP);
  private additive = new Uint8Array(CAP);
  private frames: (Frame | null)[] = new Array(CAP).fill(null);

  private count = 0;

  get live(): number {
    return this.count;
  }

  emit(ctx: Ctx, o: EmitOptions): void {
    const rng = ctx.rng;
    for (let n = 0; n < o.count; n++) {
      if (this.count >= CAP) return;
      const i = this.count++;
      const a = o.angle + rng.signed() * o.spread;
      const sp = rng.range(o.speed[0], o.speed[1]);
      this.x[i] = o.x;
      this.y[i] = o.y;
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp;
      const l = rng.range(o.life[0], o.life[1]);
      this.life[i] = l;
      this.maxLife[i] = l;
      const s = rng.range(o.size[0], o.size[1]);
      this.size[i] = s;
      this.sizeEnd[i] = s * (o.sizeEnd ?? 0);
      this.rot[i] = rng.range(0, Math.PI * 2);
      this.spin[i] = (o.spin ?? 0) * rng.signed();
      this.r[i] = o.color[0];
      this.g[i] = o.color[1];
      this.b[i] = o.color[2];
      const ce = o.colorEnd ?? o.color;
      this.r2[i] = ce[0];
      this.g2[i] = ce[1];
      this.b2[i] = ce[2];
      this.alpha[i] = o.alpha ?? 1;
      this.gravity[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.additive[i] = o.additive ? 1 : 0;
      this.frames[i] = o.frame;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove keeps the live range contiguous.
        const last = --this.count;
        if (i !== last) {
          this.x[i] = this.x[last];
          this.y[i] = this.y[last];
          this.vx[i] = this.vx[last];
          this.vy[i] = this.vy[last];
          this.life[i] = this.life[last];
          this.maxLife[i] = this.maxLife[last];
          this.size[i] = this.size[last];
          this.sizeEnd[i] = this.sizeEnd[last];
          this.rot[i] = this.rot[last];
          this.spin[i] = this.spin[last];
          this.r[i] = this.r[last];
          this.g[i] = this.g[last];
          this.b[i] = this.b[last];
          this.r2[i] = this.r2[last];
          this.g2[i] = this.g2[last];
          this.b2[i] = this.b2[last];
          this.alpha[i] = this.alpha[last];
          this.gravity[i] = this.gravity[last];
          this.drag[i] = this.drag[last];
          this.additive[i] = this.additive[last];
          this.frames[i] = this.frames[last];
        }
        i--;
        continue;
      }
      const d = 1 - this.drag[i] * dt;
      this.vx[i] *= d;
      this.vy[i] = this.vy[i] * d + this.gravity[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  draw(ctx: Ctx): void {
    const r = ctx.r;
    // Two passes keep the blend-mode switch to a single flush instead of one
    // per particle.
    for (let pass = 0; pass < 2; pass++) {
      const wantAdditive = pass === 1;
      r.setBlend(wantAdditive ? Blend.Additive : Blend.Normal);
      for (let i = 0; i < this.count; i++) {
        if (!!this.additive[i] !== wantAdditive) continue;
        const f = this.frames[i];
        if (!f) continue;
        const t = 1 - this.life[i] / this.maxLife[i];
        const s = this.size[i] + (this.sizeEnd[i] - this.size[i]) * t;
        const scale = s / f.w;
        // Fade in fast, out slow — reads as energy rather than a pop.
        const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
        r.draw(
          f,
          this.x[i],
          this.y[i],
          scale,
          scale,
          this.rot[i],
          this.r[i] + (this.r2[i] - this.r[i]) * t,
          this.g[i] + (this.g2[i] - this.g[i]) * t,
          this.b[i] + (this.b2[i] - this.b[i]) * t,
          fade * this.alpha[i],
        );
      }
    }
    r.setBlend(Blend.Normal);
  }

  clear(): void {
    this.count = 0;
  }
}
