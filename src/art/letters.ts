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

/**
 * Outline offsets, as a fraction of the glyph box, and the pad that holds them.
 *
 * These mirror `OUTLINE_R` and the shadow offset in `wallField.ts`; they live
 * here too because the sprite has to be large enough to contain them. `PAD` is
 * the extra box on each side, so the sprite spans 1 + 2*PAD glyph boxes.
 */
const OUTLINE_R = 0.052;
const OUTLINE_PAD = 0.14;
const OUTLINE_OFFSETS: [number, number, number][] = [
  // dx, dy (in units of OUTLINE_R), alpha
  [-1, -1, 0.92],
  [1, -1, 0.92],
  [-1, 1, 0.92],
  [1.7, 2.1, 0.85],
];

/**
 * The glyph's dark outline and cast shadow, baked into one sprite.
 *
 * The field used to draw this as four offset copies of the glyph plus the
 * fill: five full glyph-box quads per block, which was 62% of everything the
 * field submitted and — since this frame is fill-bound, not draw-call-bound —
 * 62% of the fill it cost. Baking collapses the four into one.
 *
 * This is EXACT, not an approximation. Source-over is associative, so
 * compositing the four copies into a sprite and that sprite over the block
 * face gives the same pixels as compositing them over the face one at a time;
 * they are all the same flat dark colour, so there is no order-dependent
 * hue mixing to lose either. The only real difference is one resample of the
 * baked sprite instead of four of the glyph.
 */
function glyphOutlinePainter(ch: string): Painter {
  const span = 1 + OUTLINE_PAD * 2;
  return {
    name: `glyphOutline/${ch}`,
    w: GLYPH * span,
    h: GLYPH * span,
    draw(ctx, w, h) {
      const box = w / span;
      const o = box * OUTLINE_R;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(box * 0.78)}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
      // The glyph's own centre inside the padded sprite.
      const cx = w / 2;
      const cy = h / 2 - box * 0.5 + box * 0.54;
      for (const [dx, dy, a] of OUTLINE_OFFSETS) {
        // The lower-right offset is pushed further and lighter: it doubles as
        // the cast shadow, which is why it is in this list rather than drawn
        // separately.
        ctx.globalAlpha = a;
        ctx.fillStyle = a > 0.9 ? 'rgb(10,8,20)' : 'rgb(8,5,15)';
        ctx.fillText(ch, cx + dx * o, cy + dy * o);
      }
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

  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    out.push(glyphPainter(ch));
    out.push(glyphOutlinePainter(ch));
  }

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
