/**
 * The jump control.
 *
 * A hop is the only move in the game with no object attached to it. Every other
 * input points at something the player can already see — a letter block, the
 * speaker, the shop chip — so it teaches itself. "Leave the ground" points at
 * nothing, which is why a swipe gesture alone is not an interface: on a phone
 * there is no surface that says the move exists. This is that surface.
 *
 * Three rules shape it:
 *
 *   ANCHORED TO THE LIVE VIEWPORT, NEVER THE DESIGN RECT. The stage does not
 *   letterbox, so `viewLeft` goes negative on a wide monitor and the visible
 *   world grows upward on a tall phone. The button hangs off `r.viewLeft` and
 *   `r.viewBottom`, and is lifted clear of the full `WORD_BAR_H` band rather
 *   than of the plaque's current width — a twelve-letter word makes that plaque
 *   reach past the screen's left third, and a control that is only sometimes
 *   clear of it is a control that is sometimes unusable.
 *
 *   SIZED IN CSS PIXELS, DRAWN IN WORLD UNITS. `r.scale` is device pixels per
 *   world unit and `r.dpr` device pixels per CSS pixel, so `44 * dpr / scale` is
 *   a 44 CSS px target in world units whatever the screen. The disc is never
 *   smaller than that and never smaller than the speaker opposite it.
 *
 *   IT NEVER TOUCHES THE HEDGEHOG. The control is drawn after everything else,
 *   so anything of it that reaches the hedgehog's column is drawn on top of
 *   him — and a chip sitting over the character is worse than no chip at all.
 *   The disc is sized and placed so its whole footprint stays left of his
 *   running line by a clear margin at every viewport (`HERO_CLEAR`), and the
 *   attention glow, which used to reach two body-widths past the disc and lay a
 *   wash across his left side, is held inside that same footprint.
 *
 *   THE COOLDOWN IS VISIBLE. The hop's entire cost is that he cannot spell
 *   while he is off the ground, so the player has to be able to see when it is
 *   spent and when it is back. The disc dims and a lamp under the chevron
 *   drains and refills; there is never a moment where pressing does nothing for
 *   a reason the screen did not show.
 *
 * Draws in one pass on the shared procedural atlas — no texture bind of its
 * own — and allocates nothing per frame.
 */

import type { Ctx } from '../core/ctx';
import { WORD_BAR_H, PLAYER_X, clamp } from '../core/ctx';
import { INK, rgb } from '../art/palette';
import { drawText, type TextStyle } from './text';
import { plate, plateRing, plateShadow, mergeShadow, snapX, snapY } from './plate';

/** Disc diameter in world units, and the CSS-pixel floor it is held above. */
const BASE_D = 132;
const MIN_CSS = 44;

/** Inset from the left edge, and the gap above the word-bar band. */
const EDGE_X = 26;
const GAP_ABOVE_DOCK = 22;

/** Extra reach around the disc that still counts as a press. */
const HIT_PAD = 14;

/**
 * World units of clear air kept between the control and the hedgehog's running
 * line. His silhouette reaches about 67 units from centre at its most stretched, so this
 * leaves roughly a third of a body of daylight even at the widest the disc is
 * ever drawn, in every state that keeps him on his line.
 */
const HERO_CLEAR = 128;

/**
 * Ceiling on the disc, so the clearance above is a guarantee rather than a
 * coincidence of the aspect ratios that happen to have been tested. Reached
 * only on a very small, very dense screen, and even there the disc is still
 * over 40 CSS px across.
 */
const MAX_D = 168;

/** Attention glow diameter, as a multiple of the disc. */
const GLOW_SPAN = 1.3;

/** How fast the press dip springs back, per second. */
const PRESS_DECAY = 4.2;

const C_PANEL: [number, number, number] = [0.055, 0.062, 0.135];
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_PAPER = rgb(INK.paper);
const C_DIM = rgb(INK.paperShade);

/** Reused so the label costs no allocation per frame. */
const LABEL: TextStyle = { size: 19 };

/** Where the disc's body colour is premixed with its own cast shadow. */
const MERGED: [number, number, number] = [0, 0, 0];

export class JumpButton {
  /** Centre and radius in world units, refreshed by `layout` every frame. */
  cx = 0;
  cy = 0;
  d = BASE_D;

  /** 1 the frame it is pressed, draining to 0. */
  private press = 0;
  /** Eased 0..1 availability, so the disc fades rather than snapping. */
  private lit = 1;

  /**
   * Resolve the anchor for this frame. Mutates fields; allocates nothing.
   */
  layout(ctx: Ctx): void {
    const r = ctx.r;
    // A 44 CSS px target, expressed in the units this frame is drawn in.
    const minWorld = (MIN_CSS * r.dpr) / Math.max(r.scale, 0.0001);
    this.d = Math.min(Math.max(BASE_D, minWorld), MAX_D);
    this.cx = r.viewLeft + EDGE_X + this.d / 2;
    // The right edge of the glow, not of the disc: the flourish is part of the
    // control's footprint and it is what was reaching him. `viewLeft` is never
    // positive, so this only ever pulls the control further from him.
    const limit = PLAYER_X - HERO_CLEAR - (this.d * GLOW_SPAN) / 2;
    if (this.cx > limit) this.cx = limit;
    this.cy = r.viewBottom - WORD_BAR_H - GAP_ABOVE_DOCK - this.d / 2;
  }

  /**
   * Is this world point on the button?
   *
   * Square rather than circular on purpose: a round hit box on a round control
   * loses the corners, and the corners of a thumb-sized target are exactly the
   * part a thumb lands on when it is aiming at the bottom-left of a phone.
   */
  hit(x: number, y: number): boolean {
    const h = this.d / 2 + HIT_PAD;
    return x >= this.cx - h && x <= this.cx + h && y >= this.cy - h && y <= this.cy + h;
  }

  /** Fire the press animation. Called whether or not the hop was allowed. */
  bump(): void {
    this.press = 1;
  }

  update(dt: number, ready: boolean): void {
    this.press = Math.max(0, this.press - dt * PRESS_DECAY);
    // Availability eases so a 0.3s cooldown reads as the light coming back on
    // rather than as the control flickering.
    const target = ready ? 1 : 0;
    this.lit += (target - this.lit) * clamp(dt * 12, 0, 1);
  }

  /**
   * @param ready   whether a hop can start this instant
   * @param charge  0..1 refill of the cooldown lamp — 1 means fully available
   */
  draw(ctx: Ctx, ready: boolean, charge: number): void {
    const r = ctx.r;
    this.layout(ctx);

    const hovered =
      ctx.input.hasHover && this.hit(ctx.input.hoverX, ctx.input.hoverY);
    const p = this.press;
    const d = this.d * (1 - p * 0.08);
    const bx = this.cx;
    const by = this.cy + p * 4;
    const rad = d / 2;
    const on = this.lit;

    // Body: the same dusk glass as every other floating control, so the button
    // reads as part of the interface and not as a sticker on top of it.
    //
    // The shadow under it is drawn only where the disc does not cover it; the
    // part that did show through the translucent body is premixed into the
    // body's colour, which composites identically for one plate instead of two.
    const shadowA = 0.4 * (0.5 + on * 0.5);
    const bodyA = 0.72 + on * 0.2;
    plateShadow(ctx, bx, by, d, d, rad, 7, C_DARK, shadowA);
    const mergedA = mergeShadow(C_PANEL, bodyA, C_DARK, shadowA, MERGED);
    plate(ctx, bx, by, d, d, rad, MERGED, mergedA);
    plateRing(
      ctx,
      bx,
      by,
      d,
      d,
      rad,
      on > 0.5 ? C_GOLD : C_DIM,
      (0.3 + on * 0.35) * (hovered ? 1.35 : 1) + p * 0.4,
    );

    // The chevron. `ui/caret` is painted pointing down, so it is mounted
    // upside down here — one shape, two meanings, no second sprite.
    const caret = ctx.atlas.get('ui/caret');
    const cw = d * 0.42;
    const cc = on > 0.5 ? C_PAPER : C_DIM;
    r.draw(
      caret,
      snapX(r, this.cx),
      snapY(r, by - d * 0.1),
      cw / caret.w,
      -((cw * 0.68) / caret.h),
      0,
      cc[0],
      cc[1],
      cc[2],
      0.45 + on * 0.5,
    );

    LABEL.size = d * 0.145;
    LABEL.color = cc;
    LABEL.align = 'center';
    LABEL.alpha = 0.4 + on * 0.45;
    LABEL.tracking = 0.2;
    LABEL.shadow = 2;
    LABEL.snap = true;
    drawText(ctx, 'JUMP', this.cx, by + d * 0.24, LABEL);

    // Cooldown lamp: a pill under the label that drains on take-off and refills
    // as the hop comes back. This is the only place the cost of the move is
    // stated, so it is never hidden — it is drawn at full strength even when
    // the rest of the disc is dim.
    const pill = ctx.atlas.get('ui/bar_pill');
    const trackW = d * 0.46;
    const ty = by + d * 0.36;
    r.draw(pill, this.cx, ty, trackW / pill.w, 5 / pill.h, 0, C_DIM[0], C_DIM[1], C_DIM[2], 0.22);
    const fw = trackW * clamp(charge, 0, 1);
    if (fw > 1) {
      const fc = ready ? C_GOLD : C_DIM;
      r.draw(
        pill,
        this.cx - trackW / 2 + fw / 2,
        ty,
        fw / pill.w,
        5 / pill.h,
        0,
        fc[0],
        fc[1],
        fc[2],
        ready ? 0.9 : 0.6,
      );
    }
  }

  /** Additive flourish, drawn inside whatever glow pass the caller owns. */
  drawGlow(ctx: Ctx, ready: boolean, attention: number): void {
    const a = Math.max(this.press, ready ? attention * 0.5 : 0);
    if (a <= 0.02) return;
    const glow = ctx.atlas.get('fx/glow');
    const gw = this.d * GLOW_SPAN;
    ctx.r.draw(glow, this.cx, this.cy, gw / glow.w, gw / glow.h, 0, 1, 0.82, 0.42, a * 0.42);
  }
}
