/**
 * Sprite text rendering.
 *
 * Draws strings from the ASCII glyphs baked into the atlas, so text costs
 * nothing beyond the sprites it adds to the existing batch. Supports
 * alignment, letter-spacing, tabular (fixed-advance) figures, a cheap drop
 * shadow and word wrapping.
 *
 * The atlas keys are precomputed once rather than built per glyph per frame,
 * so a HUD full of text allocates nothing while it draws.
 */

import type { Ctx } from '../core/ctx';
import { TEXT_EM, TEXT_CELL_H, ADVANCE } from '../art/ui';
import { snapX, snapY } from './plate';

export interface TextStyle {
  /** Type size in world units (em box; cap height is roughly 0.7 of it). */
  size: number;
  color?: [number, number, number];
  alpha?: number;
  align?: 'left' | 'center' | 'right';
  /** Extra tracking as a fraction of size. */
  tracking?: number;
  /**
   * Fixed advance per character as a fraction of size. Use `TABULAR` for
   * counters so the layout does not twitch as digits change.
   */
  mono?: number;
  /** Drop shadow offset in world units; 0 disables. */
  shadow?: number;
  shadowAlpha?: number;
  shadowColor?: [number, number, number];
  /**
   * Land every glyph on a whole device pixel.
   *
   * For screen-space type that holds still — a score, a button label, a line of
   * clue copy — a glyph cell whose left edge falls at x.5 device pixels is
   * resampled across two columns and reads as soft, and the softness changes
   * with the window size because the anchor it hangs off is fractional. Snapping
   * moves each cell by at most half a pixel, which is well inside the letter
   * spacing, and the run keeps its measured width because only the draw position
   * is snapped, never the advance.
   *
   * Off by default, and deliberately off for anything that MOVES: quantising a
   * rising score floater to the pixel grid trades softness for a visible stair.
   */
  snap?: boolean;
}

const WHITE: [number, number, number] = [1, 1, 1];
const BLACK: [number, number, number] = [0, 0, 0];

/** Fixed advance for counters — wide enough for every digit in the baked face. */
export const TABULAR = 0.6;

/** `text/<code>` for every printable code, built once at module load. */
const KEY: string[] = [];
for (let code = 0; code < 128; code++) KEY[code] = `text/${code}`;

/**
 * Shadow offset that stays proportional to the type size, so the whole HUD
 * shares one legibility treatment instead of hand-picked numbers per call.
 */
export const shadowFor = (size: number): number => Math.max(2, Math.round(size * 0.07));

/** Width of `str` in world units at the given size. */
export function measureText(str: string, size: number, tracking = 0, mono = 0): number {
  const s = size / TEXT_EM;
  const fixed = mono > 0 ? mono * size : 0;
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const adv = fixed || (ADVANCE.get(str.charCodeAt(i)) ?? TEXT_EM * 0.5) * s;
    w += adv + tracking * size;
  }
  return w - (str.length ? tracking * size : 0);
}

export function drawText(ctx: Ctx, str: string, x: number, y: number, style: TextStyle): number {
  const {
    size,
    color = WHITE,
    alpha = 1,
    align = 'left',
    tracking = 0,
    mono = 0,
    shadow = 0,
    shadowAlpha = 0.5,
    shadowColor = BLACK,
    snap = false,
  } = style;

  const scale = size / TEXT_EM;
  const fixed = mono > 0 ? mono * size : 0;
  const total = measureText(str, size, tracking, mono);
  const cursor = align === 'left' ? x : align === 'center' ? x - total / 2 : x - total;

  const passes = shadow > 0 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const isShadow = shadow > 0 && pass === 0;
    const col = isShadow ? shadowColor : color;
    const a = isShadow ? alpha * shadowAlpha : alpha;
    const dx = isShadow ? shadow : 0;
    const dy = isShadow ? shadow : 0;
    let cx = cursor;
    const baseline = snap ? snapY(ctx.r, y + dy) : y + dy;

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const adv = fixed || (ADVANCE.get(code) ?? TEXT_EM * 0.5) * scale;
      if (code !== 32 && code < 128 && ctx.atlas.has(KEY[code])) {
        const f = ctx.atlas.get(KEY[code]);
        const gx = cx + adv / 2 + dx;
        // Glyph cells are centred on their advance box, so `y` is the optical
        // centre of a capital — vertical centring needs no extra offset.
        ctx.r.draw(
          f,
          snap ? snapX(ctx.r, gx) : gx,
          baseline,
          scale,
          scale,
          0,
          col[0],
          col[1],
          col[2],
          a,
        );
      }
      cx += adv + tracking * size;
    }
  }
  return total;
}

/** Split `str` into lines that each fit within `maxWidth`. */
export function wrapText(str: string, size: number, maxWidth: number, tracking = 0): string[] {
  const words = str.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measureText(candidate, size, tracking) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Line height that matches the baked glyph cell. */
export const lineHeight = (size: number): number => (size / TEXT_EM) * TEXT_CELL_H * 0.9;
