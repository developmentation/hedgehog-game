/**
 * The pause panel: the world has stopped, the hedgehog has sat down, and this
 * is what the player does about it.
 *
 * It carries three things and no more — carry on, how fast the world comes at
 * you, and whether a mistake is allowed to cost anything — because a menu a
 * six-year-old has to read past is a menu they will not use. Every control is a
 * plate you can hit with a thumb, the selected one is filled gold rather than
 * ticked, and the speed chips draw a growing stack of bars so the ladder reads
 * as a ladder before anybody reads a word of it.
 *
 * Three rules, the same three the rest of the interface keeps:
 *
 *   ANCHORED TO THE LIVE VIEWPORT. Nothing here is positioned by the 1280x720
 *   design rect. The panel is sized against `viewLeft/viewRight`, sits between
 *   `safeTop` and the top of the word dock, and — this is the point of it — is
 *   pushed clear of the hedgehog's running line, so the thing the pause is
 *   *about* is never hidden behind the thing that paused it.
 *
 *   TOUCH FIRST. Every plate is at least 44 CSS px on its short side at 390px
 *   width, which is what sizes the rows; the panel's height falls out of that
 *   rather than the other way round.
 *
 *   PARITY ACROSS INPUTS. Finger, mouse and keyboard reach all of it. Arrow keys
 *   walk the grid and Enter commits, exactly as the workshop does, so the pause
 *   menu is also the keyboard's way into the workshop now that Escape means
 *   pause. A focus ring appears only once a key has actually been pressed, so a
 *   mouse player never sees a caret they did not ask for.
 *
 * Allocation-free after construction: the rectangles are built once and mutated
 * in place, and every string it draws is a constant or precomputed.
 */

import type { Ctx } from '../core/ctx';
import { PLAYER_X, clamp, smoothstep } from '../core/ctx';
import { INK, rgb } from '../art/palette';
import { drawText, type TextStyle } from './text';
import { roundedPanel, roundedRing } from '../scenes/shop';
import { SPEEDS, SPEED_TAGS, speedIndex, setSpeedIndex, isEasy, setEasy } from '../game/settings';

/** What `update` is telling the scene to do. */
export const PAUSE_NONE = 0;
export const PAUSE_RESUME = 1;
export const PAUSE_SHOP = 2;

// ------------------------------------------------------------------- layout

const PANEL_W = 860;
const PANEL_RAD = 34;
const PAD_X = 32;

/** Row tops relative to the panel, and their heights. */
const Y_TITLE = 20;
const H_TITLE = 38;
const Y_CAP = 82;
const Y_CHIPS = 98;
const H_CHIPS = 132;
const Y_EASY = 246;
const H_EASY = 132;
const Y_BTNS = 394;
const H_BTNS = 132;
const PANEL_H = Y_BTNS + H_BTNS + 22;

const CHIP_GAP = 14;
const BTN_GAP = 16;
const BTN_RESUME_W = 470;

/**
 * Slop around every plate. The rows are 132 tall, which is 40 CSS px at 390px
 * width; eight units of reach on each side takes the target past 44 without the
 * plates ever touching each other.
 */
const HIT_PAD = 8;

/** Clear air kept between the panel and the hedgehog's running line. */
const HERO_CLEAR = 96;

/** Top of the word dock's plaque, measured from the bottom edge. */
const DOCK_TOP = 142;

// ------------------------------------------------------------------ palette

const C_PANEL: [number, number, number] = [0.055, 0.062, 0.135];
const C_PLATE: [number, number, number] = [0.1, 0.11, 0.21];
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_GOLD_DEEP = rgb(INK.goldDeep);
const C_PAPER = rgb(INK.paper);
const C_DIM = rgb(INK.paperShade);
const C_GOOD = rgb(INK.good);

/** Reused for every string this file draws. */
const ST: TextStyle = { size: 20 };

// -------------------------------------------------------------------- model

const I_SPEED0 = 0;
const I_EASY = 4;
const I_RESUME = 5;
const I_SHOP = 6;
const N_ITEMS = 7;

/** Grid position of each item, so the arrow keys have something to walk. */
const ROW = [0, 0, 0, 0, 1, 2, 2];
const COL = [0, 1, 2, 3, 0, 0, 1];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TITLE = 'PAUSED';
const CAP_SPEED = 'SPEED';
const EASY_TITLE = 'EASY MODE';
const EASY_SUB = 'NO PENALTIES FOR A WRONG LETTER';
const ON = 'ON';
const OFF = 'OFF';
const RESUME = 'KEEP ROLLING';
const SHOP = 'WORKSHOP';
const HINT_KEYS = 'ARROWS  ENTER   ESC RESUMES';

export class PauseMenu {
  /** 0..1 appear animation. */
  private t = 0;
  /** Which item the keyboard is on, and whether the ring should be visible. */
  private focus = I_RESUME;
  private keyboard = false;
  private readonly rects: Rect[] = [];
  private panel: Rect = { x: 0, y: 0, w: PANEL_W, h: PANEL_H };

  private keyQueue: string[] = [];
  private readonly onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    if (
      k === 'ArrowUp' ||
      k === 'ArrowDown' ||
      k === 'ArrowLeft' ||
      k === 'ArrowRight' ||
      k === 'Enter' ||
      k === ' '
    ) {
      if (!e.repeat) this.keyQueue.push(k);
      e.preventDefault();
    }
  };

  constructor() {
    for (let i = 0; i < N_ITEMS; i++) this.rects.push({ x: 0, y: 0, w: 0, h: 0 });
  }

  // ---------------------------------------------------------------- lifecycle

  open(ctx: Ctx): void {
    this.t = 0;
    this.keyboard = false;
    this.focus = I_RESUME;
    this.keyQueue.length = 0;
    window.addEventListener('keydown', this.onKey);
    this.layout(ctx);
  }

  close(): void {
    window.removeEventListener('keydown', this.onKey);
    this.keyQueue.length = 0;
  }

  // ------------------------------------------------------------------ layout

  /**
   * Resolve the panel and every plate inside it. Mutates the rectangles built
   * in the constructor; allocates nothing.
   */
  private layout(ctx: Ctx): void {
    const r = ctx.r;
    const p = this.panel;
    p.w = Math.min(PANEL_W, r.viewRight - r.viewLeft - 72);
    p.h = PANEL_H;

    // Horizontally: centred, unless that would sit on the hedgehog — then
    // pushed just far enough right to leave him in the clear, and never off the
    // right edge.
    let cx = (r.viewLeft + r.viewRight) * 0.5;
    const heroRight = PLAYER_X + HERO_CLEAR;
    if (cx - p.w / 2 < heroRight) cx = heroRight + p.w / 2;
    cx = Math.min(cx, r.viewRight - 18 - p.w / 2);
    p.x = cx - p.w / 2;

    // Vertically: centred in the band between the top row and the word dock, so
    // it never covers either.
    const top = r.safeTop;
    const bottom = r.viewBottom - DOCK_TOP;
    const cy = clamp((top + bottom) * 0.5, top + p.h / 2 + 6, bottom - p.h / 2 - 6);
    p.y = cy - p.h / 2;

    const innerX = p.x + PAD_X;
    const innerW = p.w - PAD_X * 2;

    const chipW = (innerW - CHIP_GAP * (SPEEDS.length - 1)) / SPEEDS.length;
    for (let i = 0; i < SPEEDS.length; i++) {
      const rect = this.rects[I_SPEED0 + i];
      rect.x = innerX + i * (chipW + CHIP_GAP);
      rect.y = p.y + Y_CHIPS;
      rect.w = chipW;
      rect.h = H_CHIPS;
    }

    const easy = this.rects[I_EASY];
    easy.x = innerX;
    easy.y = p.y + Y_EASY;
    easy.w = innerW;
    easy.h = H_EASY;

    const resumeW = Math.min(BTN_RESUME_W, innerW - 200 - BTN_GAP);
    const res = this.rects[I_RESUME];
    res.x = innerX;
    res.y = p.y + Y_BTNS;
    res.w = resumeW;
    res.h = H_BTNS;

    const shop = this.rects[I_SHOP];
    shop.x = innerX + resumeW + BTN_GAP;
    shop.y = p.y + Y_BTNS;
    shop.w = innerW - resumeW - BTN_GAP;
    shop.h = H_BTNS;
  }

  private hit(i: number, x: number, y: number): boolean {
    const r = this.rects[i];
    return (
      x >= r.x - HIT_PAD &&
      x <= r.x + r.w + HIT_PAD &&
      y >= r.y - HIT_PAD &&
      y <= r.y + r.h + HIT_PAD
    );
  }

  // ------------------------------------------------------------------ update

  /**
   * Consume this frame's input. Returns `PAUSE_NONE`, `PAUSE_RESUME` or
   * `PAUSE_SHOP`; the scene owns what those mean.
   */
  update(ctx: Ctx, dt: number): number {
    this.t = Math.min(1, this.t + dt * 5);
    this.layout(ctx);

    let action = PAUSE_NONE;

    for (let i = 0; i < this.keyQueue.length; i++) {
      const k = this.keyQueue[i];
      this.keyboard = true;
      if (k === 'ArrowLeft') this.step(ctx, -1, 0);
      else if (k === 'ArrowRight') this.step(ctx, 1, 0);
      else if (k === 'ArrowUp') this.step(ctx, 0, -1);
      else if (k === 'ArrowDown') this.step(ctx, 0, 1);
      else action = this.commit(ctx, this.focus) || action;
    }
    this.keyQueue.length = 0;

    // Everything not on a plate is inert. A thumb landing in the gap between
    // two chips must do nothing at all — a paused game that resumes itself
    // because you touched the panel is worse than no pause.
    const taps = ctx.input.taps;
    for (let i = 0; i < taps.length; i++) {
      const tap = taps[i];
      for (let j = 0; j < N_ITEMS; j++) {
        if (!this.hit(j, tap.x, tap.y)) continue;
        this.keyboard = false;
        this.focus = j;
        action = this.commit(ctx, j) || action;
        break;
      }
    }

    return action;
  }

  /** Move the keyboard focus one step through the grid. */
  private step(ctx: Ctx, dc: number, dr: number): void {
    const row = ROW[this.focus];
    const col = COL[this.focus];
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < N_ITEMS; i++) {
      if (i === this.focus) continue;
      const dRow = ROW[i] - row;
      const dCol = COL[i] - col;
      if (dr !== 0) {
        if (Math.sign(dRow) !== Math.sign(dr)) continue;
        const score = Math.abs(dRow) * 10 + Math.abs(dCol);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      } else {
        if (ROW[i] !== row || Math.sign(dCol) !== Math.sign(dc)) continue;
        const score = Math.abs(dCol);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best < 0) return;
    this.focus = best;
    ctx.audio.play('uiTap', 0.5);
  }

  /** Act on an item. Returns the action the scene has to handle, if any. */
  private commit(ctx: Ctx, i: number): number {
    const p = ctx.save.profile;
    if (i === I_RESUME) return PAUSE_RESUME;
    if (i === I_SHOP) return PAUSE_SHOP;
    if (i === I_EASY) {
      const on = !isEasy(p);
      setEasy(p, on);
      ctx.save.save();
      ctx.audio.play(on ? 'letterLock' : 'uiTap', 0.9);
      return PAUSE_NONE;
    }
    const idx = i - I_SPEED0;
    if (setSpeedIndex(p, idx)) ctx.save.save();
    ctx.audio.play('uiTap', 0.8);
    return PAUSE_NONE;
  }

  // -------------------------------------------------------------------- draw

  draw(ctx: Ctx): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const a = smoothstep(this.t);
    const p = this.panel;

    // Scrim. Deliberately not opaque: the hedgehog sitting on the left is the
    // whole point of this screen, so the world is dimmed rather than covered.
    const vw = r.viewRight - r.viewLeft;
    const vh = r.viewBottom - r.viewTop;
    r.draw(
      px,
      (r.viewLeft + r.viewRight) * 0.5,
      (r.viewTop + r.viewBottom) * 0.5,
      vw / px.w,
      vh / px.h,
      0,
      0.02,
      0.025,
      0.06,
      0.52 * a,
    );

    const lift = (1 - a) * 26;
    const y = p.y + lift;

    roundedPanel(ctx, p.x, y + 12, p.w, p.h, PANEL_RAD, C_DARK, 0.45 * a);
    roundedPanel(ctx, p.x, y, p.w, p.h, PANEL_RAD, C_PANEL, 0.97 * a);
    roundedRing(ctx, p.x, y, p.w, p.h, PANEL_RAD, C_GOLD, 0.5 * a);

    // Title left, keyboard crib right, on one baseline: centring the title put
    // it straight through the crib on the narrower panels.
    const titleCY = y + Y_TITLE + H_TITLE / 2;
    text(ctx, TITLE, p.x + PAD_X, titleCY, 38, C_GOLD, 'left', a, 0.16, 4);
    text(ctx, HINT_KEYS, p.x + p.w - PAD_X, titleCY + 3, 16, C_DIM, 'right', a * 0.5, 0.2, 0);
    text(ctx, CAP_SPEED, p.x + PAD_X, y + Y_CAP, 19, C_DIM, 'left', a * 0.75, 0.24, 0);

    this.drawSpeedChips(ctx, lift, a);
    this.drawEasy(ctx, lift, a);
    this.drawButtons(ctx, lift, a);
  }

  private plate(
    ctx: Ctx,
    i: number,
    lift: number,
    a: number,
    selected: boolean,
  ): Rect {
    const rect = this.rects[i];
    const y = rect.y + lift;
    const rad = Math.min(26, rect.h / 2);
    const hovered = ctx.input.hasHover && this.hit(i, ctx.input.hoverX, ctx.input.hoverY);
    const focused = this.keyboard && this.focus === i;

    if (selected) {
      roundedPanel(ctx, rect.x, y, rect.w, rect.h, rad, C_GOLD, a * 0.22);
      roundedRing(ctx, rect.x, y, rect.w, rect.h, rad, C_GOLD, a * 0.95);
    } else {
      roundedPanel(ctx, rect.x, y, rect.w, rect.h, rad, C_PLATE, a * (hovered ? 0.95 : 0.7));
      roundedRing(ctx, rect.x, y, rect.w, rect.h, rad, C_PAPER, a * (hovered ? 0.4 : 0.16));
    }
    if (focused) {
      roundedRing(ctx, rect.x - 7, y - 7, rect.w + 14, rect.h + 14, rad + 7, C_PAPER, a * 0.8);
    }
    return rect;
  }

  private drawSpeedChips(ctx: Ctx, lift: number, a: number): void {
    const r = ctx.r;
    const pill = ctx.atlas.get('ui/bar_pill');
    const cur = speedIndex(ctx.save.profile);

    for (let i = 0; i < SPEEDS.length; i++) {
      const opt = SPEEDS[i];
      const sel = i === cur;
      const rect = this.plate(ctx, I_SPEED0 + i, lift, a, sel);
      const cx = rect.x + rect.w / 2;
      const top = rect.y + lift;

      // The bar stack: one more bar per rung, each taller than the last. This
      // is the part that works with the sound off and the reading not yet
      // learned — four chips whose stacks grow is a speed dial.
      const n = SPEEDS.length;
      const bw = 11;
      const step = 17;
      const baseY = top + 52;
      const x0 = cx - ((n - 1) * step) / 2;
      for (let b = 0; b < n; b++) {
        const on = b < opt.bars;
        const h = 16 + b * 9;
        const c = sel ? C_GOLD : on ? C_PAPER : C_DIM;
        r.draw(
          pill,
          x0 + b * step,
          baseY - h / 2,
          bw / pill.w,
          h / pill.h,
          0,
          c[0],
          c[1],
          c[2],
          a * (on ? (sel ? 1 : 0.8) : 0.18),
        );
      }

      text(ctx, SPEED_TAGS[i], cx, top + 84, 30, sel ? C_PAPER : C_DIM, 'center', a * (sel ? 1 : 0.85), 0.02, 3);
      text(ctx, opt.label, cx, top + 112, 16, sel ? C_GOLD : C_DIM, 'center', a * (sel ? 0.95 : 0.6), 0.18, 0);
    }
  }

  private drawEasy(ctx: Ctx, lift: number, a: number): void {
    const on = isEasy(ctx.save.profile);
    const rect = this.plate(ctx, I_EASY, lift, a, on);
    const top = rect.y + lift;
    const cy = top + rect.h / 2;

    text(ctx, EASY_TITLE, rect.x + 28, cy - 14, 30, on ? C_PAPER : C_DIM, 'left', a, 0.08, 3);
    text(ctx, EASY_SUB, rect.x + 28, cy + 22, 17, on ? C_GOOD : C_DIM, 'left', a * 0.8, 0.14, 0);

    // The switch. A pill with a knob that slides: the one control idiom that
    // says "this is a thing that is either on or off" without a label.
    const sw = 116;
    const sh = 56;
    const sx = rect.x + rect.w - 28 - sw;
    const sy = cy - sh / 2;
    roundedPanel(ctx, sx, sy, sw, sh, sh / 2, on ? C_GOLD_DEEP : C_DARK, a * (on ? 0.95 : 0.6));
    roundedRing(ctx, sx, sy, sw, sh, sh / 2, on ? C_GOLD : C_DIM, a * 0.7);
    const knob = sh - 12;
    const kx = on ? sx + sw - 6 - knob : sx + 6;
    roundedPanel(ctx, kx, sy + 6, knob, knob, knob / 2, on ? C_PAPER : C_DIM, a);
    text(ctx, on ? ON : OFF, sx - 16, cy, 22, on ? C_GOLD : C_DIM, 'right', a * 0.9, 0.2, 2);
  }

  private drawButtons(ctx: Ctx, lift: number, a: number): void {
    const r = ctx.r;
    const res = this.rects[I_RESUME];
    const top = res.y + lift;
    const rad = Math.min(26, res.h / 2);
    const hovered = ctx.input.hasHover && this.hit(I_RESUME, ctx.input.hoverX, ctx.input.hoverY);
    const focused = this.keyboard && this.focus === I_RESUME;

    // The way out is the loudest thing on the panel, and it is the item the
    // keyboard opens on: pause should never be a room you have to find the door
    // of.
    const pulse = 0.9 + Math.sin(ctx.time * 3) * 0.06 + (hovered ? 0.1 : 0);
    roundedPanel(ctx, res.x, top, res.w, res.h, rad, C_GOLD_DEEP, a * pulse);
    roundedRing(ctx, res.x, top, res.w, res.h, rad, C_GOLD, a);
    if (focused) roundedRing(ctx, res.x - 7, top - 7, res.w + 14, res.h + 14, rad + 7, C_PAPER, a * 0.8);

    const caret = ctx.atlas.get('ui/caret');
    const cw = 44;
    const cy = top + res.h / 2;
    r.draw(caret, res.x + 46, cy, cw / caret.w, (cw * 0.72) / caret.h, -Math.PI / 2, C_DARK[0], C_DARK[1], C_DARK[2], a * 0.9);
    text(ctx, RESUME, res.x + 84, cy, 30, C_DARK, 'left', a, 0.1, 0);

    const shop = this.plate(ctx, I_SHOP, lift, a, false);
    const spark = ctx.atlas.get('ui/spark');
    const scy = shop.y + lift + shop.h / 2;
    r.draw(spark, shop.x + 34, scy, 26 / spark.w, 26 / spark.h, ctx.time * 0.5, C_GOLD[0], C_GOLD[1], C_GOLD[2], a * 0.9);
    text(ctx, SHOP, shop.x + 58, scy, 24, C_PAPER, 'left', a * 0.95, 0.12, 2);
  }
}

function text(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  size: number,
  color: [number, number, number],
  align: 'left' | 'center' | 'right',
  alpha: number,
  tracking: number,
  shadow: number,
): void {
  ST.size = size;
  ST.color = color;
  ST.align = align;
  ST.alpha = alpha;
  ST.tracking = tracking;
  ST.shadow = shadow;
  drawText(ctx, s, x, y, ST);
}
