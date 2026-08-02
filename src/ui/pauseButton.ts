/**
 * The pause control.
 *
 * Same rules as the hop control it mirrors (`ui/jumpButton.ts`): anchored to the
 * live viewport rather than the design rect, sized in CSS pixels and drawn in
 * world units, drawn last so nothing can cover it, and allocation-free.
 *
 * The placement is the interesting decision. On a 16:9 desktop the whole frame
 * above the word dock is a letter field — a five-block column reaches y≈78, and
 * a block's tap box reaches 76 units past its centre — so *any* control parked
 * in the playfield can, at some tier, be sitting on top of a live letter. The
 * shop chip and the speaker already accept that trade, because the worst case is
 * a replayed word or an opened workshop. Pause cannot: it stops the world, so a
 * stolen tap is a game that appears to have died.
 *
 * The one band that is structurally free of letters is the word dock's, below
 * `GROUND_Y - baseLift + hitPadY` (≈574) — so this sits there, on the dock's own
 * baseline, hard against the right edge where the hedgehog never goes and where
 * a right thumb already rests. The plaque is centred and grows with the word, so
 * `layout` is told how long the word is and holds the disc clear of it; only an
 * eleven- or twelve-letter word at the narrowest sane viewport can crowd it, and
 * even then the disc gives ground rather than covering a letter slot.
 */

import type { Ctx } from '../core/ctx';
import { VIEW_W } from '../core/ctx';
import { INK, rgb } from '../art/palette';
import { drawText, measureText, type TextStyle } from './text';
import { roundedPanel, roundedRing } from '../scenes/shop';

/** Disc diameter in world units, the CSS floor it is held above, and its cap. */
const BASE_D = 124;
const MIN_CSS = 44;
const MAX_D = 152;

/** Inset from the right edge, and the dock baseline it shares with the word bar. */
const EDGE_X = 24;
const DOCK_LIFT = 78;

/** Extra reach around the disc that still counts as a press. */
const HIT_PAD = 12;

/**
 * Mirror of the word dock's plaque geometry (`ui/hud.ts`, `drawWordBar`).
 *
 * Duplicated on purpose and knowingly: the alternative is either exporting the
 * dock's layout from a file this one must not depend on for a single number, or
 * placing a control by eye and discovering on a twelve-letter word that it is
 * sitting on the last letter. If the dock is ever re-proportioned these drift,
 * and the failure mode is a slightly tighter gap — never an unreachable control.
 */
const SLOT_MAX_W = 78;
const SLOT_GAP_F = 0.16;
const SLOT_SIDE_PAD = 64;
const PLAQUE_PAD_X = 17;

const C_PANEL: [number, number, number] = [0.055, 0.062, 0.135];
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_PAPER = rgb(INK.paper);
const C_DIM = rgb(INK.paperShade);

/** Reused so the labels cost no allocation per frame. */
const LABEL: TextStyle = { size: 18 };

/** The assist caption's type, measured once per distinct string. */
const TAG_SIZE = 20;
const TAG_TRACK = 0.16;

/** How fast the press dip springs back, per second. */
const PRESS_DECAY = 4.2;

export class PauseButton {
  /** Centre and diameter in world units, refreshed by `layout` every frame. */
  cx = 0;
  cy = 0;
  d = BASE_D;

  /** 1 the frame it is pressed, draining to 0. */
  private press = 0;

  /** Last caption drawn and its measured width — remeasured only when it changes. */
  private tagStr = '';
  private tagW = 0;

  /**
   * Resolve the anchor for this frame. `wordLen` is the word currently in the
   * dock, which is what decides how much room there is on the right.
   */
  layout(ctx: Ctx, wordLen: number): void {
    const r = ctx.r;
    const minWorld = (MIN_CSS * r.dpr) / Math.max(r.scale, 0.0001);
    this.d = Math.min(Math.max(BASE_D, minWorld), MAX_D);
    this.cy = r.viewBottom - DOCK_LIFT;

    const half = this.d / 2;
    this.cx = r.viewRight - EDGE_X - half;

    // Hold clear of the plaque. If the word is long enough that there is no
    // clear air left, take back as much of the edge inset as there is rather
    // than parking the disc on a letter slot.
    const dockR = dockRightEdge(wordLen, r.viewLeft, r.viewRight);
    const wanted = dockR + 12 + half;
    if (this.cx < wanted) this.cx = Math.min(wanted, r.viewRight - 6 - half);
  }

  /**
   * Is this world point on the button?
   *
   * Square, like the hop control: the corners of a thumb-sized target are
   * exactly the part a thumb lands on at the edge of a phone.
   */
  hit(x: number, y: number): boolean {
    const h = this.d / 2 + HIT_PAD;
    return x >= this.cx - h && x <= this.cx + h && y >= this.cy - h && y <= this.cy + h;
  }

  /** Fire the press animation. */
  bump(): void {
    this.press = 1;
  }

  update(dt: number): void {
    this.press = Math.max(0, this.press - dt * PRESS_DECAY);
  }

  /**
   * @param paused  true while the world is stopped — the button becomes the way
   *                back in, and says so with a play chevron instead of bars.
   * @param tag     a short state caption ('0.6x', 'EASY', '0.6x EASY'), drawn
   *                above the disc so a parent can see at a glance what the
   *                assists are set to. Empty for the default settings.
   */
  draw(ctx: Ctx, paused: boolean, tag: string): void {
    const r = ctx.r;
    const p = this.press;
    const d = this.d * (1 - p * 0.08);
    const x = this.cx - d / 2;
    const y = this.cy - d / 2 + p * 4;
    const rad = d / 2;
    const hovered = ctx.input.hasHover && this.hit(ctx.input.hoverX, ctx.input.hoverY);

    roundedPanel(ctx, x, y + 7, d, d, rad, C_DARK, 0.4);
    roundedPanel(ctx, x, y, d, d, rad, C_PANEL, 0.92);
    roundedRing(ctx, x, y, d, d, rad, paused ? C_GOLD : C_PAPER, (paused ? 0.85 : 0.4) + (hovered ? 0.3 : 0) + p * 0.4);

    const iconY = this.cy - d * 0.08 + p * 4;
    const c = paused ? C_GOLD : C_PAPER;
    if (paused) {
      // `ui/caret` points down; turned a quarter it is the play triangle every
      // child already knows, so the same sprite carries both halves of the toggle.
      const caret = ctx.atlas.get('ui/caret');
      const cw = d * 0.38;
      r.draw(caret, this.cx + cw * 0.06, iconY, cw / caret.w, (cw * 0.72) / caret.h, -Math.PI / 2, c[0], c[1], c[2], 0.95);
    } else {
      const pill = ctx.atlas.get('ui/bar_pill');
      const bw = d * 0.1;
      const bh = d * 0.34;
      for (let i = 0; i < 2; i++) {
        r.draw(pill, this.cx + (i === 0 ? -bw : bw), iconY, bw / pill.w, bh / pill.h, 0, c[0], c[1], c[2], 0.9);
      }
    }

    LABEL.size = d * 0.145;
    LABEL.color = c;
    LABEL.align = 'center';
    LABEL.alpha = 0.85;
    LABEL.tracking = 0.2;
    LABEL.shadow = 2;
    drawText(ctx, paused ? 'PLAY' : 'PAUSE', this.cx, this.cy + d * 0.28 + p * 4, LABEL);

    if (tag) this.drawTag(ctx, tag, d);
  }

  /**
   * The assist caption, on its own plate.
   *
   * It sits over painted foliage, and dim type on a bright bank is type nobody
   * reads — so it gets the same dusk-glass plate every other floating label in
   * the interface gets, sized to the string rather than to a guess.
   */
  private drawTag(ctx: Ctx, tag: string, d: number): void {
    if (tag !== this.tagStr) {
      this.tagStr = tag;
      this.tagW = measureText(tag, TAG_SIZE, TAG_TRACK);
    }
    const w = this.tagW + 30;
    const h = 34;
    const x = this.cx + d / 2 - w;
    const y = this.cy - d / 2 - h - 10;
    roundedPanel(ctx, x, y, w, h, h / 2, C_PANEL, 0.9);
    roundedRing(ctx, x, y, w, h, h / 2, C_GOLD, 0.4);
    LABEL.size = TAG_SIZE;
    LABEL.color = C_GOLD;
    LABEL.align = 'center';
    LABEL.alpha = 0.95;
    LABEL.tracking = TAG_TRACK;
    LABEL.shadow = 0;
    drawText(ctx, tag, x + w / 2, y + h / 2, LABEL);
  }
}

/**
 * Rightmost world x the word plaque reaches for a word of `n` letters. Pure
 * arithmetic on the constants above; no state, no allocation.
 */
function dockRightEdge(n: number, viewLeft: number, viewRight: number): number {
  if (n <= 0) return viewLeft;
  const cx = (viewLeft + viewRight) * 0.5;
  const avail = Math.min(viewRight - viewLeft, VIEW_W) - SLOT_SIDE_PAD * 2;
  const slotW = Math.min(SLOT_MAX_W, avail / (n + (n - 1) * SLOT_GAP_F));
  const total = n * slotW + (n - 1) * slotW * SLOT_GAP_F;
  return cx + total / 2 + PLAQUE_PAD_X;
}
