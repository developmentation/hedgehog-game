/**
 * HUD surfaces: the rounded plate, its outline, and its cast shadow.
 *
 * Every opaque thing in the interface is one of three shapes — a plate, a ring
 * around a plate, or the shadow a plate throws — so they live here rather than
 * being re-derived per panel. Two rules are enforced for the whole HUD in this
 * one file:
 *
 *   EDGES LAND ON WHOLE DEVICE PIXELS. A plate anchored to `r.viewRight - 28`
 *   sits at a fractional device pixel at almost every window size, which turns
 *   a hard edge into a two-pixel ramp whose weighting changes the moment the
 *   window is resized. `plate`, `plateRing` and `plateShadow` snap their four
 *   edges to the device grid before they draw, so the same panel is crisp at
 *   1280x720@2x, 1910x955@1x and 390x844@3x. Only the outer rectangle is
 *   snapped — the corner radius, and anything animating inside the plate, keep
 *   their sub-pixel positions so motion stays smooth.
 *
 *   A SHADOW IS ONLY DRAWN WHERE IT SHOWS. The HUD's plates cast their shadow
 *   by drawing a second, identical plate a few units lower. Under a plate that
 *   is 95-100% opaque the whole interior of that second plate is invisible, and
 *   it was the single largest piece of fill in the interface — the clue card's
 *   shadow alone covered a quarter of the screen to show a 14-unit lip. So
 *   `plateShadow` draws the lip and nothing else, and `mergeShadow` folds the
 *   part that *did* show through — the interior wash under a translucent
 *   plate — into the plate's own colour, which is exact rather than an
 *   approximation: compositing C over (D over B) is the same as compositing a
 *   single premixed colour over B.
 */

import type { Ctx } from '../core/ctx';
import type { Renderer } from '../engine/gl';

const HALF_PI = Math.PI / 2;

/** World x snapped to the nearest whole device pixel. */
export function snapX(r: Renderer, x: number): number {
  const s = r.scale;
  if (!(s > 0)) return x;
  return (Math.round(x * s + r.offsetX) - r.offsetX) / s;
}

/** World y snapped to the nearest whole device pixel. */
export function snapY(r: Renderer, y: number): number {
  const s = r.scale;
  if (!(s > 0)) return y;
  return (Math.round(y * s + r.offsetY) - r.offsetY) / s;
}

/**
 * Fold a shadow that sits directly under a plate into the plate's own colour.
 *
 * `out` receives the premixed colour and the return value is the premixed
 * alpha, so the caller draws ONE plate that composites identically to the two
 * it used to draw. Exact wherever the shadow covers the plate, which is
 * everywhere except a `dy`-tall sliver along the top edge.
 */
export function mergeShadow(
  body: readonly [number, number, number],
  bodyA: number,
  shadow: readonly [number, number, number],
  shadowA: number,
  out: [number, number, number],
): number {
  const a = 1 - (1 - bodyA) * (1 - shadowA);
  if (a <= 0.0001) {
    out[0] = body[0];
    out[1] = body[1];
    out[2] = body[2];
    return 0;
  }
  const k = 1 / a;
  const u = (1 - bodyA) * shadowA;
  out[0] = (bodyA * body[0] + u * shadow[0]) * k;
  out[1] = (bodyA * body[1] + u * shadow[1]) * k;
  out[2] = (bodyA * body[2] + u * shadow[2]) * k;
  return a;
}

/**
 * A rounded plate: four rotated quarter-discs plus up to three stretched
 * pixels, which between them tile the rectangle exactly once — no piece
 * overlaps another, so a plate costs its own area in fill and no more.
 */
export function plate(
  ctx: Ctx,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rad: number,
  c: readonly [number, number, number],
  a: number,
): void {
  if (a <= 0.0025) return;
  const r = ctx.r;
  const x0e = snapX(r, cx - w * 0.5);
  const x1e = snapX(r, cx + w * 0.5);
  const y0e = snapY(r, cy - h * 0.5);
  const y1e = snapY(r, cy + h * 0.5);
  const W = x1e - x0e;
  const H = y1e - y0e;
  if (W < 0.5 || H < 0.5) return;
  const mx = (x0e + x1e) * 0.5;
  const my = (y0e + y1e) * 0.5;

  const px = ctx.atlas.get('ui/pixel');
  const co = ctx.atlas.get('ui/corner');
  const rr = Math.min(rad, W * 0.5, H * 0.5);

  // Snap the INTERNAL joins to the pixel grid, and only overlap when opaque.
  //
  // A plate is four quarter-discs plus stretched bars. The outer edges were
  // already snapped, but the joins between the pieces were not, so every seam
  // landed on a fraction of a pixel and the corner sprites' own anti-aliased
  // edges let a hairline of background through — a line across the score strip,
  // and on a circle, where the bars vanish and the four quadrants meet at the
  // centre, the HINT button broke visibly into quarters.
  //
  // Overlapping the pieces fixes an OPAQUE plate, since drawing the same solid
  // colour twice is indistinguishable from drawing it once. It makes a
  // TRANSLUCENT one worse: two passes of alpha 0.14 leave a brighter cross
  // exactly where they overlap, which is the seam again in the other direction.
  // So the joins are snapped for everything, and the overlap is added only when
  // the colour is solid enough that double-covering cannot show.
  const xa = snapX(r, x0e + rr);
  const xb = snapX(r, x1e - rr);
  const ya = snapY(r, y0e + rr);
  const yb = snapY(r, y1e - rr);
  const eps = a >= 0.995 ? 1 / Math.max(r.scale, 0.0001) : 0;

  // Each corner is sized from its own snapped join, so a rounding difference on
  // one side cannot shift the piece on the other.
  const corner = (px0: number, px1: number, py0: number, py1: number, rot: number): void => {
    const cw = px1 - px0;
    const chh = py1 - py0;
    if (cw <= 0 || chh <= 0) return;
    r.draw(
      co,
      (px0 + px1) * 0.5,
      (py0 + py1) * 0.5,
      (cw + eps) / co.w,
      (chh + eps) / co.h,
      rot,
      c[0],
      c[1],
      c[2],
      a,
    );
  };
  corner(x0e, xa, y0e, ya, 0);
  corner(xb, x1e, y0e, ya, HALF_PI);
  corner(xb, x1e, yb, y1e, Math.PI);
  corner(x0e, xa, yb, y1e, -HALF_PI);

  // The cross that fills everything the corners do not.
  const midW = xb - xa;
  if (midW > 0.5) {
    const bw = (midW + eps * 2) / px.w;
    const topH = ya - y0e;
    const botH = y1e - yb;
    if (topH > 0.5) r.draw(px, mx, (y0e + ya) * 0.5, bw, (topH + eps) / px.h, 0, c[0], c[1], c[2], a);
    if (botH > 0.5) r.draw(px, mx, (yb + y1e) * 0.5, bw, (botH + eps) / px.h, 0, c[0], c[1], c[2], a);
  }
  const midH = yb - ya;
  if (midH > 0.5) {
    r.draw(px, mx, (ya + yb) * 0.5, W / px.w, (midH + eps * 2) / px.h, 0, c[0], c[1], c[2], a);
  }
}

/** The outline that registers exactly with `plate`. Stroke is 1/8 of the radius. */
export function plateRing(
  ctx: Ctx,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rad: number,
  c: readonly [number, number, number],
  a: number,
): void {
  if (a <= 0.0025) return;
  const r = ctx.r;
  const x0e = snapX(r, cx - w * 0.5);
  const x1e = snapX(r, cx + w * 0.5);
  const y0e = snapY(r, cy - h * 0.5);
  const y1e = snapY(r, cy + h * 0.5);
  const W = x1e - x0e;
  const H = y1e - y0e;
  if (W < 0.5 || H < 0.5) return;
  const mx = (x0e + x1e) * 0.5;
  const my = (y0e + y1e) * 0.5;

  const px = ctx.atlas.get('ui/pixel');
  const co = ctx.atlas.get('ui/corner_ring');
  const rr = Math.min(rad, W * 0.5, H * 0.5);
  const sc = rr / co.w;
  const lw = rr / 8;
  const x0 = x0e + rr / 2;
  const x1 = x1e - rr / 2;
  const y0 = y0e + rr / 2;
  const y1 = y1e - rr / 2;
  r.draw(co, x0, y0, sc, sc, 0, c[0], c[1], c[2], a);
  r.draw(co, x1, y0, sc, sc, HALF_PI, c[0], c[1], c[2], a);
  r.draw(co, x1, y1, sc, sc, Math.PI, c[0], c[1], c[2], a);
  r.draw(co, x0, y1, sc, sc, -HALF_PI, c[0], c[1], c[2], a);

  const midW = W - rr * 2;
  if (midW > 0.5) {
    r.draw(px, mx, y0e + lw / 2, midW / px.w, lw / px.h, 0, c[0], c[1], c[2], a);
    r.draw(px, mx, y1e - lw / 2, midW / px.w, lw / px.h, 0, c[0], c[1], c[2], a);
  }
  const midH = H - rr * 2;
  if (midH > 0.5) {
    r.draw(px, x0e + lw / 2, my, lw / px.w, midH / px.h, 0, c[0], c[1], c[2], a);
    r.draw(px, x1e - lw / 2, my, lw / px.w, midH / px.h, 0, c[0], c[1], c[2], a);
  }
}

/**
 * The visible part of the shadow a plate of the same size throws `dy` below
 * itself: the bottom corner row, and the lip that the plate's own corner curve
 * leaves uncovered above it. Everything higher than that is behind the plate,
 * and belongs in the plate's colour via `mergeShadow` instead.
 *
 * Three or four quads and `w * (rad + dy)` of fill, in place of seven quads and
 * `w * h`.
 */
export function plateShadow(
  ctx: Ctx,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rad: number,
  dy: number,
  c: readonly [number, number, number],
  a: number,
): void {
  if (a <= 0.0025 || dy <= 0) return;
  const r = ctx.r;
  const x0e = snapX(r, cx - w * 0.5);
  const x1e = snapX(r, cx + w * 0.5);
  const y0e = snapY(r, cy - h * 0.5);
  const y1e = snapY(r, cy + h * 0.5);
  const W = x1e - x0e;
  const H = y1e - y0e;
  if (W < 0.5 || H < 0.5) return;
  const mx = (x0e + x1e) * 0.5;

  const px = ctx.atlas.get('ui/pixel');
  const co = ctx.atlas.get('ui/corner');
  const rr = Math.min(rad, W * 0.5, H * 0.5);
  const sc = rr / co.w;
  const bot = snapY(r, y1e + dy);
  const row = bot - rr / 2;
  r.draw(co, x1e - rr / 2, row, sc, sc, Math.PI, c[0], c[1], c[2], a);
  r.draw(co, x0e + rr / 2, row, sc, sc, -HALF_PI, c[0], c[1], c[2], a);

  const midW = W - rr * 2;
  if (midW > 0.5) r.draw(px, mx, row, midW / px.w, rr / px.h, 0, c[0], c[1], c[2], a);

  // The lip: between the plate's corner curve starting to pull in and the top
  // of the corner row below. Never taller than the shadow's own straight side.
  const lipH = Math.min(bot - y1e, H - rr * 2);
  if (lipH > 0.5) {
    r.draw(px, mx, y1e - rr + lipH * 0.5, W / px.w, lipH / px.h, 0, c[0], c[1], c[2], a);
  }
}
