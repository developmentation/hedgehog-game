/**
 * HUD and interface art.
 *
 * STATUS: baseline pass.
 *
 * Frame contract:
 *   ui/pixel        - flat white, stretched for bars and scrims
 *   ui/panel        - rounded panel with a soft inner light
 *   ui/slot         - empty hangman slot
 *   ui/slot_fill    - filled hangman slot backing
 *   ui/heart        - life pip
 *   ui/spark        - currency icon
 *   ui/speaker      - "hear the word again" button
 *   ui/vignette     - screen-edge darkening, stretched to fill
 *   digit/0..9      - white digits, tinted at draw time
 *
 * The HUD kit added in `hudPainters` (rounded-panel corners, letter slots,
 * bar backdrop, icons) is documented next to it, lower down.
 */

import type { Painter } from '../engine/atlas';
import { INK } from './palette';

export function uiPainters(): Painter[] {
  const out: Painter[] = [];

  out.push({
    name: 'ui/pixel',
    w: 8,
    h: 8,
    draw(ctx, w, h) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    },
  });

  out.push({
    name: 'ui/panel',
    w: 128,
    h: 128,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.roundRect(4, 4, w - 8, h - 8, 22);
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();
    },
  });

  out.push({
    name: 'ui/slot',
    w: 88,
    h: 104,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.roundRect(5, 5, w - 10, h - 10, 14);
      ctx.strokeStyle = 'rgba(255,255,255,0.34)';
      ctx.lineWidth = 4;
      ctx.stroke();
      // Underscore hints "a letter goes here" even before anything is filled.
      ctx.beginPath();
      ctx.roundRect(w * 0.22, h * 0.76, w * 0.56, 6, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/slot_fill',
    w: 88,
    h: 104,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.roundRect(5, 5, w - 10, h - 10, 14);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0.72)');
      ctx.fillStyle = g;
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/heart',
    w: 56,
    h: 52,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(w / 2, h * 0.92);
      ctx.bezierCurveTo(-w * 0.12, h * 0.5, w * 0.16, -h * 0.1, w / 2, h * 0.26);
      ctx.bezierCurveTo(w * 0.84, -h * 0.1, w * 1.12, h * 0.5, w / 2, h * 0.92);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/spark',
    w: 48,
    h: 48,
    draw(ctx, w, h) {
      ctx.beginPath();
      const cx = w / 2;
      const cy = h / 2;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? w * 0.48 : w * 0.17;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/speaker',
    w: 64,
    h: 64,
    draw(ctx, w, h) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(w * 0.16, h * 0.38);
      ctx.lineTo(w * 0.32, h * 0.38);
      ctx.lineTo(w * 0.5, h * 0.2);
      ctx.lineTo(w * 0.5, h * 0.8);
      ctx.lineTo(w * 0.32, h * 0.62);
      ctx.lineTo(w * 0.16, h * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = w * 0.06;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.arc(w * 0.52, h * 0.5, w * (0.16 + i * 0.14), -0.9, 0.9);
        ctx.stroke();
      }
    },
  });

  out.push({
    name: 'ui/vignette',
    w: 256,
    h: 144,
    draw(ctx, w, h) {
      const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.34, w / 2, h / 2, h * 0.95);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.85)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  });

  for (let d = 0; d < 10; d++) {
    out.push({
      name: `digit/${d}`,
      w: 56,
      h: 72,
      draw(ctx, w, h) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `900 ${Math.round(h * 0.86)}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(d), w / 2, h * 0.54);
        ctx.restore();
      },
    });
  }

  out.push(...hudPainters());
  out.push(...asciiPainters());
  return out;
}

/**
 * Second-pass HUD kit.
 *
 * Everything here is baked white (or white-with-an-alpha-ramp) so the HUD can
 * tint one sprite into every role it needs, and every shape is either
 * scale-invariant or composed at draw time. `ui/corner` and `ui/corner_ring`
 * are the important pair: four rotated copies plus a few stretched pixels make
 * an arbitrarily sized rounded panel or pill, so the HUD gets a real panel
 * system without a 9-slice shader and without a painter per panel size.
 *
 * Frame contract (additions):
 *   ui/corner       - quarter disc, round corner at TOP-LEFT; rotate for the rest
 *   ui/corner_ring  - stroked quarter arc matching ui/corner, stroke on the outside
 *   ui/bar_pill     - fully-rounded bar, for underscores and letter-count pips
 *   ui/bar_bg       - word-bar backdrop, stretched horizontally (vertical ramp)
 *   ui/tile_well    - empty letter slot: recessed well with a top-down ramp
 *   ui/tile_face    - filled letter slot: lit face with a shaded lip
 *   ui/tile_ring    - slot outline, thin
 *   ui/tile_ring_hi - slot outline, thick (the "next letter" state)
 *   ui/caret        - rounded down-triangle, points at the active slot
 *   ui/speaker_bold - chunky speaker icon for the re-hear button
 *   ui/heart_line   - hollow heart for a spent life
 */

/** Corner sprites are baked at this size; ring thickness is 1/8 of the radius. */
const CORNER = 64;
const CORNER_LW = 8;

/** Letter-slot sprites share this cell so the three layers register exactly. */
const TILE_W = 96;
const TILE_H = 110;
const TILE_R = 19;

function hudPainters(): Painter[] {
  const out: Painter[] = [];

  out.push({
    name: 'ui/corner',
    w: CORNER,
    h: CORNER,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(w, h);
      ctx.arc(w, h, w, Math.PI, Math.PI * 1.5);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/corner_ring',
    w: CORNER,
    h: CORNER,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.arc(w, h, w - CORNER_LW / 2, Math.PI, Math.PI * 1.5);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = CORNER_LW;
      ctx.stroke();
    },
  });

  out.push({
    name: 'ui/bar_pill',
    w: 64,
    h: 16,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, h / 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/bar_bg',
    w: 32,
    h: 132,
    draw(ctx, w, h) {
      // A lit top edge over a deep body: the bar reads as a solid shelf the
      // word sits on rather than a translucent rectangle laid over the world.
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(44, 48, 88, 0.99)');
      g.addColorStop(0.16, 'rgba(22, 24, 50, 0.99)');
      g.addColorStop(1, 'rgba(5, 6, 16, 1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // A bright lip along the top: the shelf has to separate from whatever the
      // world painters put immediately above it, which is usually also dark.
      ctx.fillStyle = 'rgba(246, 241, 228, 0.42)';
      ctx.fillRect(0, 0, w, 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(0, 5, w, 3);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, h - 4, w, 4);
    },
  });

  out.push({
    name: 'ui/tile_well',
    w: TILE_W,
    h: TILE_H,
    draw(ctx, w, h) {
      // Alpha ramp, not colour: the HUD tints this one sprite, and a denser top
      // reads as a recess once that tint is dark.
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.78)');
      g.addColorStop(1, 'rgba(255,255,255,0.5)');
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, TILE_R);
      ctx.fillStyle = g;
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/tile_face',
    w: TILE_W,
    h: TILE_H,
    draw(ctx, w, h) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.52, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.88, 'rgba(255,255,255,0.82)');
      g.addColorStop(1, 'rgba(255,255,255,0.66)');
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, TILE_R);
      ctx.fillStyle = g;
      ctx.fill();
    },
  });

  const tileRing = (name: string, lw: number): Painter => ({
    name,
    w: TILE_W,
    h: TILE_H,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.roundRect(lw / 2, lw / 2, w - lw, h - lw, TILE_R - lw / 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      ctx.stroke();
    },
  });
  out.push(tileRing('ui/tile_ring', 5));
  out.push(tileRing('ui/tile_ring_hi', 9));

  out.push({
    name: 'ui/caret',
    w: 44,
    h: 30,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(w * 0.08, h * 0.16);
      ctx.lineTo(w * 0.92, h * 0.16);
      ctx.lineTo(w * 0.5, h * 0.9);
      ctx.closePath();
      // Stroke as well as fill so the points come out rounded, not needle-sharp.
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.fill();
    },
  });

  out.push({
    name: 'ui/speaker_bold',
    w: 80,
    h: 72,
    draw(ctx, w, h) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h * 0.36);
      ctx.lineTo(w * 0.25, h * 0.36);
      ctx.lineTo(w * 0.44, h * 0.13);
      ctx.lineTo(w * 0.44, h * 0.87);
      ctx.lineTo(w * 0.25, h * 0.64);
      ctx.lineTo(w * 0.1, h * 0.64);
      ctx.closePath();
      ctx.lineWidth = w * 0.09;
      ctx.stroke();
      ctx.fill();

      ctx.lineWidth = w * 0.075;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(w * 0.44, h * 0.5, w * (0.17 + i * 0.14), -0.82, 0.82);
        ctx.stroke();
      }
    },
  });

  out.push({
    name: 'ui/heart_line',
    w: 56,
    h: 52,
    draw(ctx, w, h) {
      ctx.beginPath();
      ctx.moveTo(w / 2, h * 0.88);
      ctx.bezierCurveTo(-w * 0.08, h * 0.5, w * 0.18, -h * 0.06, w / 2, h * 0.28);
      ctx.bezierCurveTo(w * 0.82, -h * 0.06, w * 1.08, h * 0.5, w / 2, h * 0.88);
      ctx.closePath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 7;
      ctx.stroke();
    },
  });

  return out;
}

/**
 * Printable-ASCII glyph set.
 *
 * Baking a real font into the atlas means clue text, labels and menus all draw
 * from the same texture as the rest of the game — so the entire frame, HUD
 * included, still costs one draw call. Each glyph records its own advance
 * width so text is proportionally spaced rather than monospaced.
 */
export const TEXT_EM = 64;
export const TEXT_CELL_H = 84;

/** Advance width per character code, in art units at `TEXT_EM`. */
export const ADVANCE = new Map<number, number>();

const TEXT_FONT = `600 ${TEXT_EM}px "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;

function asciiPainters(): Painter[] {
  const out: Painter[] = [];

  // Measure once on a scratch context so the atlas knows each cell's width.
  const meas = document.createElement('canvas').getContext('2d')!;
  meas.font = TEXT_FONT;

  for (let code = 32; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const adv = meas.measureText(ch).width;
    ADVANCE.set(code, adv);
    if (code === 32) continue; // space draws nothing

    // Pad the cell so glyphs with overshoot (parentheses, commas) are not clipped.
    const cellW = Math.max(8, Math.ceil(adv) + 12);
    out.push({
      name: `text/${code}`,
      w: cellW,
      h: TEXT_CELL_H,
      draw(ctx, w, h) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = TEXT_FONT;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(ch, w / 2, h * 0.76);
        ctx.restore();
      },
    });
  }
  return out;
}

/** Colour constants re-exported so HUD code has one import for its palette. */
export { INK };
