/**
 * Hedgehog sprite art.
 *
 * STATUS: baseline pass. Shapes and frame names are final; shading, quill
 * detail and animation richness are the target of the art iteration loop.
 *
 * Frame contract (other modules depend on these names existing):
 *   hedgehog/ball_00 .. ball_07   - spinning ball, 8 rotation phases
 *   hedgehog/run_00 .. run_05     - grounded run cycle
 *   hedgehog/idle_00 .. idle_03   - breathing idle
 *   hedgehog/dance_00 .. dance_05 - victory dance
 *   hedgehog/hurt                 - knocked-back pose
 */

import type { Painter } from '../engine/atlas';
import { QUILL, BELLY, SNOUT, rampGradient } from './palette';

const BALL = 96;
const BODY_W = 116;
const BODY_H = 96;

function quillRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, phase: number): void {
  const spikes = 18;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    const a0 = (i / spikes) * Math.PI * 2 + phase;
    const a1 = ((i + 0.5) / spikes) * Math.PI * 2 + phase;
    const a2 = ((i + 1) / spikes) * Math.PI * 2 + phase;
    const outer = r * 1.0;
    const inner = r * 0.74;
    if (i === 0) ctx.moveTo(cx + Math.cos(a0) * inner, cy + Math.sin(a0) * inner);
    ctx.lineTo(cx + Math.cos(a1) * outer, cy + Math.sin(a1) * outer);
    ctx.lineTo(cx + Math.cos(a2) * inner, cy + Math.sin(a2) * inner);
  }
  ctx.closePath();
}

function ballFrame(i: number, total: number): Painter {
  return {
    name: `hedgehog/ball_${String(i).padStart(2, '0')}`,
    w: BALL,
    h: BALL,
    draw(ctx, w, h) {
      const cx = w / 2;
      const cy = h / 2;
      const r = w * 0.46;
      const phase = (i / total) * ((Math.PI * 2) / 18);

      quillRing(ctx, cx, cy, r, phase);
      ctx.fillStyle = rampGradient(ctx, QUILL, 0, cy - r, 0, cy + r);
      ctx.fill();

      // Inner core reads as the tucked body.
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = QUILL.base;
      ctx.fill();

      // Motion streak so the ball reads as spinning even in a still frame.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = QUILL.hi;
      ctx.lineWidth = r * 0.1;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.44, phase * 18, phase * 18 + 1.8);
      ctx.stroke();
      ctx.restore();

      // Sun-side rim light.
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = QUILL.hi;
      ctx.lineWidth = r * 0.07;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.93, -2.5, -0.6);
      ctx.stroke();
      ctx.restore();
    },
  };
}

function bodyBase(ctx: CanvasRenderingContext2D, w: number, h: number, squash: number): void {
  const cx = w * 0.5;
  const cy = h * 0.56;
  const rx = w * 0.4 * (1 + squash * 0.12);
  const ry = h * 0.38 * (1 - squash * 0.14);

  // Quill mantle.
  ctx.beginPath();
  ctx.ellipse(cx + rx * 0.1, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = rampGradient(ctx, QUILL, 0, cy - ry, 0, cy + ry);
  ctx.fill();

  // Spikes along the back.
  ctx.beginPath();
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const a = Math.PI * (1.06 + t * 0.82);
    const bx = cx + Math.cos(a) * rx * 0.98;
    const by = cy + Math.sin(a) * ry * 0.98;
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a) * rx * 0.2, by + Math.sin(a) * ry * 0.34);
  }
  ctx.strokeStyle = QUILL.shade;
  ctx.lineWidth = w * 0.035;
  ctx.stroke();

  // Belly.
  ctx.beginPath();
  ctx.ellipse(cx - rx * 0.28, cy + ry * 0.24, rx * 0.46, ry * 0.5, -0.2, 0, Math.PI * 2);
  ctx.fillStyle = rampGradient(ctx, BELLY, 0, cy, 0, cy + ry);
  ctx.fill();

  // Snout.
  ctx.beginPath();
  ctx.ellipse(cx - rx * 0.82, cy + ry * 0.02, rx * 0.3, ry * 0.3, -0.15, 0, Math.PI * 2);
  ctx.fillStyle = SNOUT.light;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx - rx * 1.05, cy + ry * 0.06, w * 0.028, 0, Math.PI * 2);
  ctx.fillStyle = '#16121f';
  ctx.fill();

  // Eye.
  ctx.beginPath();
  ctx.ellipse(cx - rx * 0.5, cy - ry * 0.3, w * 0.05, h * 0.062, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#f8f4ec';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx - rx * 0.54, cy - ry * 0.28, w * 0.026, 0, Math.PI * 2);
  ctx.fillStyle = '#141126';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx - rx * 0.57, cy - ry * 0.34, w * 0.009, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function legs(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const cx = w * 0.5;
  const cy = h * 0.56;
  ctx.strokeStyle = SNOUT.base;
  ctx.lineWidth = w * 0.05;
  for (let i = 0; i < 2; i++) {
    const ph = t + i * Math.PI;
    const fx = cx + (i === 0 ? -w * 0.16 : w * 0.12);
    const fy = cy + h * 0.3;
    ctx.beginPath();
    ctx.moveTo(fx, fy - h * 0.05);
    ctx.lineTo(fx + Math.cos(ph) * w * 0.07, fy + Math.abs(Math.sin(ph)) * h * 0.07);
    ctx.stroke();
  }
}

export function hedgehogPainters(): Painter[] {
  const out: Painter[] = [];

  for (let i = 0; i < 8; i++) out.push(ballFrame(i, 8));

  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2;
    out.push({
      name: `hedgehog/run_${String(i).padStart(2, '0')}`,
      w: BODY_W,
      h: BODY_H,
      py: 0.82,
      draw(ctx, w, h) {
        legs(ctx, w, h, t);
        bodyBase(ctx, w, h, Math.sin(t) * 0.4);
      },
    });
  }

  for (let i = 0; i < 4; i++) {
    const t = (i / 4) * Math.PI * 2;
    out.push({
      name: `hedgehog/idle_${String(i).padStart(2, '0')}`,
      w: BODY_W,
      h: BODY_H,
      py: 0.82,
      draw(ctx, w, h) {
        legs(ctx, w, h, 0);
        bodyBase(ctx, w, h, Math.sin(t) * 0.12);
      },
    });
  }

  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2;
    out.push({
      name: `hedgehog/dance_${String(i).padStart(2, '0')}`,
      w: BODY_W,
      h: BODY_H,
      py: 0.82,
      draw(ctx, w, h) {
        ctx.save();
        ctx.translate(w / 2, h * 0.56);
        ctx.rotate(Math.sin(t) * 0.22);
        ctx.translate(-w / 2, -h * 0.56);
        legs(ctx, w, h, t * 2);
        bodyBase(ctx, w, h, Math.sin(t * 2) * 0.5);
        ctx.restore();
      },
    });
  }

  out.push({
    name: 'hedgehog/hurt',
    w: BODY_W,
    h: BODY_H,
    py: 0.82,
    draw(ctx, w, h) {
      bodyBase(ctx, w, h, -0.5);
    },
  });

  return out;
}
