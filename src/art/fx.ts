/**
 * Particle and effect art.
 *
 * STATUS: baseline pass. All shapes are white so the particle system can tint
 * them per-emitter; this keeps every effect on the same atlas page and the
 * whole frame inside one draw call.
 *
 * Frame contract:
 *   fx/dust, fx/spark, fx/petal, fx/star, fx/glow, fx/ring, fx/streak,
 *   fx/shockwave, fx/note
 */

import type { Painter } from '../engine/atlas';

function radial(ctx: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function fxPainters(): Painter[] {
  return [
    {
      name: 'fx/dust',
      w: 48,
      h: 48,
      draw: (ctx, w, h) =>
        radial(ctx, w, h, [
          [0, 'rgba(255,255,255,0.9)'],
          [0.45, 'rgba(255,255,255,0.35)'],
          [1, 'rgba(255,255,255,0)'],
        ]),
    },
    {
      name: 'fx/glow',
      w: 128,
      h: 128,
      draw: (ctx, w, h) =>
        radial(ctx, w, h, [
          [0, 'rgba(255,255,255,1)'],
          [0.28, 'rgba(255,255,255,0.5)'],
          [0.62, 'rgba(255,255,255,0.14)'],
          [1, 'rgba(255,255,255,0)'],
        ]),
    },
    {
      name: 'fx/spark',
      w: 40,
      h: 40,
      draw(ctx, w, h) {
        // Four-point star: reads as a bright spark at any scale.
        ctx.beginPath();
        const cx = w / 2;
        const cy = h / 2;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const r = i % 2 === 0 ? w * 0.5 : w * 0.12;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      },
    },
    {
      name: 'fx/star',
      w: 44,
      h: 44,
      draw(ctx, w, h) {
        ctx.beginPath();
        const cx = w / 2;
        const cy = h / 2;
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
          const r = i % 2 === 0 ? w * 0.48 : w * 0.2;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      },
    },
    {
      name: 'fx/petal',
      w: 36,
      h: 36,
      draw(ctx, w, h) {
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w * 0.22, h * 0.46, 0.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      },
    },
    {
      name: 'fx/ring',
      w: 128,
      h: 128,
      draw(ctx, w, h) {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w * 0.42, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = w * 0.055;
        ctx.stroke();
      },
    },
    {
      name: 'fx/shockwave',
      w: 160,
      h: 160,
      draw(ctx, w, h) {
        const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.28, w / 2, h / 2, w * 0.5);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      },
    },
    {
      name: 'fx/streak',
      w: 96,
      h: 24,
      draw(ctx, w, h) {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
      },
    },
    {
      name: 'fx/note',
      w: 40,
      h: 48,
      draw(ctx, w, h) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(w * 0.36, h * 0.74, w * 0.24, h * 0.16, -0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(w * 0.55, h * 0.16, w * 0.09, h * 0.6);
        ctx.beginPath();
        ctx.moveTo(w * 0.64, h * 0.16);
        ctx.quadraticCurveTo(w * 0.92, h * 0.22, w * 0.8, h * 0.44);
        ctx.lineTo(w * 0.64, h * 0.36);
        ctx.closePath();
        ctx.fill();
      },
    },
  ];
}
