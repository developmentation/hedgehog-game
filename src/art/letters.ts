/**
 * Letter block art.
 *
 * STATUS: baseline pass. Frame names are final; material rendering and glyph
 * treatment are the target of the art iteration loop.
 *
 * Frame contract:
 *   block/stone, block/crystal, block/amber - block faces, tinted at draw time
 *   block/cracked                           - overlay for a damaged block
 *   glyph/A .. glyph/Z                      - white glyphs, tinted at draw time
 *   shard/0 .. shard/3                      - debris from a smashed block
 */

import type { Painter } from '../engine/atlas';
import { STONE, CRYSTAL, AMBER, rampGradient, type Ramp } from './palette';

export const BLOCK_W = 108;
export const BLOCK_H = 108;

/** Glyph baked size. Drawn scaled-down, so bake generously for crispness. */
const GLYPH = 96;

function blockFace(name: string, r: Ramp, facet: boolean): Painter {
  return {
    name,
    w: BLOCK_W,
    h: BLOCK_H,
    draw(ctx, w, h) {
      const pad = w * 0.045;
      const rad = w * 0.16;
      const x = pad;
      const y = pad;
      const bw = w - pad * 2;
      const bh = h - pad * 2;

      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, rad);
      ctx.fillStyle = rampGradient(ctx, r, 0, y, 0, y + bh);
      ctx.fill();

      // Bevelled top edge and dark base give the block volume.
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, rad);
      ctx.clip();

      ctx.beginPath();
      ctx.roundRect(x + bw * 0.06, y + bh * 0.05, bw * 0.88, bh * 0.22, rad * 0.7);
      ctx.fillStyle = r.hi;
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.rect(x, y + bh * 0.8, bw, bh * 0.2);
      ctx.fillStyle = r.shade;
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (facet) {
        ctx.strokeStyle = r.hi;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = w * 0.014;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(x + bw * (0.18 + i * 0.28), y);
          ctx.lineTo(x + bw * (0.05 + i * 0.28), y + bh);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, rad);
      ctx.strokeStyle = r.shade;
      ctx.lineWidth = w * 0.022;
      ctx.stroke();
    },
  };
}

function glyphPainter(ch: string): Painter {
  return {
    name: `glyph/${ch}`,
    w: GLYPH,
    h: GLYPH,
    draw(ctx, w, h) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // A heavy geometric face reads clearly at small sizes on a phone.
      ctx.font = `900 ${Math.round(h * 0.78)}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ch, w / 2, h * 0.54);
      ctx.restore();
    },
  };
}

export function letterPainters(): Painter[] {
  const out: Painter[] = [
    blockFace('block/stone', STONE, false),
    blockFace('block/crystal', CRYSTAL, true),
    blockFace('block/amber', AMBER, false),
  ];

  out.push({
    name: 'block/cracked',
    w: BLOCK_W,
    h: BLOCK_H,
    draw(ctx, w, h) {
      ctx.strokeStyle = 'rgba(12,10,20,0.75)';
      ctx.lineWidth = w * 0.024;
      ctx.beginPath();
      ctx.moveTo(w * 0.5, h * 0.08);
      ctx.lineTo(w * 0.42, h * 0.4);
      ctx.lineTo(w * 0.58, h * 0.56);
      ctx.lineTo(w * 0.46, h * 0.92);
      ctx.moveTo(w * 0.42, h * 0.4);
      ctx.lineTo(w * 0.16, h * 0.5);
      ctx.moveTo(w * 0.58, h * 0.56);
      ctx.lineTo(w * 0.86, h * 0.44);
      ctx.stroke();
    },
  });

  for (let i = 0; i < 26; i++) out.push(glyphPainter(String.fromCharCode(65 + i)));

  for (let i = 0; i < 4; i++) {
    out.push({
      name: `shard/${i}`,
      w: 34,
      h: 34,
      draw(ctx, w, h) {
        const pts = 3 + (i % 3);
        ctx.beginPath();
        for (let p = 0; p < pts; p++) {
          const a = (p / pts) * Math.PI * 2 + i;
          const rr = (w / 2) * (0.55 + ((p * 7 + i * 3) % 5) * 0.09);
          const px = w / 2 + Math.cos(a) * rr;
          const py = h / 2 + Math.sin(a) * rr;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      },
    });
  }

  return out;
}
