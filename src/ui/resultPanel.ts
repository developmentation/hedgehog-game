/**
 * The level result: what just happened, and the three things to do about it.
 *
 * Meeting a goal used to set `phase = 'gameover'` and leave the player looking
 * at a stopped world with one undocumented affordance — press anything to
 * replay the same level. That is a dead end dressed as an ending. This panel
 * closes the loop: it says what the run scored, whether any of it was a record,
 * and offers the only three moves that make sense — do it again, pick a
 * different one, or carry on to the next.
 *
 * Deliberately not a pushed scene. The celebration is still running underneath
 * — the hedgehog is dancing on the column he just smashed — and that is the
 * reward; covering it with a full-screen menu would throw away the moment the
 * panel exists to mark. So it is a UI object the play scene owns and draws over
 * its own frame, exactly as the pause panel is.
 *
 * Same three rules as the pause panel: anchored to the live viewport, every
 * plate past 44 CSS px at 390px width, and finger / mouse / keyboard all reach
 * all of it. Allocation-free after `open` — the rectangles are built once and
 * mutated, and every string is composed when the panel opens.
 */

import type { Ctx } from '../core/ctx';
import { PLAYER_X, clamp, smoothstep } from '../core/ctx';
import { INK, rgb } from '../art/palette';
import { drawText, type TextStyle } from './text';
import { plate, plateRing } from './plate';

/** What `update` is telling the scene to do. */
export const RESULT_NONE = 0;
export const RESULT_RETRY = 1;
export const RESULT_LEVELS = 2;
export const RESULT_NEXT = 3;

// ------------------------------------------------------------------- layout

const PANEL_W = 820;
const PANEL_RAD = 34;
const PAD_X = 32;

const Y_TITLE = 24;
const Y_LEVEL = 74;
const Y_STATS = 112;
const H_STAT = 46;
const N_STATS = 3;
const Y_BTNS = Y_STATS + H_STAT * N_STATS + 22;
const H_BTNS = 132;
const PANEL_H = Y_BTNS + H_BTNS + 24;

const BTN_GAP = 16;
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

const ST: TextStyle = { size: 20 };

const I_RETRY = 0;
const I_LEVELS = 1;
const I_NEXT = 2;
const N_ITEMS = 3;

const TITLE = 'LEVEL COMPLETE';
const BEST = 'NEW BEST';
const HINT = 'ARROWS  ENTER';

const STAT_KEYS = ['SCORE', 'TIME', 'MISSES'];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ResultPanel {
  /** True while the panel owns the screen. */
  open = false;

  private t = 0;
  private focus = I_RETRY;
  private keyboard = false;
  private readonly rects: Rect[] = [];
  private panel: Rect = { x: 0, y: 0, w: PANEL_W, h: PANEL_H };

  /** Composed on open; never rebuilt while the panel is up. */
  private levelTitle = '';
  private nextLabel = 'NEXT LEVEL';
  private readonly values = ['', '', ''];
  private readonly isBest = [false, false, false];

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

  /**
   * Raise the panel on a completed run.
   *
   * `ranked` mirrors the profile's own rule: in easy mode the level is still
   * cleared, but nothing is a record, so the BEST tags stay off rather than
   * congratulating a number earned with the penalties down.
   */
  show(
    ctx: Ctx,
    levelTitle: string,
    nextTitle: string,
    score: number,
    seconds: number,
    misses: number,
    bestScore: boolean,
    bestTime: boolean,
    bestMisses: boolean,
  ): void {
    this.levelTitle = levelTitle.toUpperCase();
    this.nextLabel = nextTitle ? `NEXT  ${nextTitle.toUpperCase()}` : 'KEEP ROLLING';
    this.values[0] = String(Math.round(score));
    this.values[1] = seconds < 60 ? `${seconds.toFixed(1)}S` : fmtClock(seconds);
    this.values[2] = String(misses);
    this.isBest[0] = bestScore;
    this.isBest[1] = bestTime;
    this.isBest[2] = bestMisses;

    this.open = true;
    this.t = 0;
    this.keyboard = false;
    this.focus = I_RETRY;
    this.keyQueue.length = 0;
    window.addEventListener('keydown', this.onKey);
    this.layout(ctx);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    window.removeEventListener('keydown', this.onKey);
    this.keyQueue.length = 0;
  }

  // ------------------------------------------------------------------ layout

  private layout(ctx: Ctx): void {
    const r = ctx.r;
    const p = this.panel;
    p.w = Math.min(PANEL_W, r.viewRight - r.viewLeft - 72);
    p.h = PANEL_H;

    let cx = (r.viewLeft + r.viewRight) * 0.5;
    const heroRight = PLAYER_X + HERO_CLEAR;
    if (cx - p.w / 2 < heroRight) cx = heroRight + p.w / 2;
    cx = Math.min(cx, r.viewRight - 18 - p.w / 2);
    p.x = cx - p.w / 2;

    const top = r.safeTop;
    const bottom = r.viewBottom - DOCK_TOP;
    const cy = clamp((top + bottom) * 0.5, top + p.h / 2 + 6, bottom - p.h / 2 - 6);
    p.y = cy - p.h / 2;

    const innerX = p.x + PAD_X;
    const innerW = p.w - PAD_X * 2;
    const btnW = (innerW - BTN_GAP * (N_ITEMS - 1)) / N_ITEMS;
    for (let i = 0; i < N_ITEMS; i++) {
      const rect = this.rects[i];
      rect.x = innerX + i * (btnW + BTN_GAP);
      rect.y = p.y + Y_BTNS;
      rect.w = btnW;
      rect.h = H_BTNS;
    }
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
   * Consume this frame's input. Returns one of the `RESULT_*` constants.
   *
   * The panel arms after a beat, so the tap that smashed the final letter — the
   * one still in flight when the goal fired — cannot pick a button on the way
   * past. Escape means "back to the list", which is the one thing behind this
   * screen.
   */
  update(ctx: Ctx, dt: number): number {
    this.t = Math.min(1, this.t + dt * 4);
    this.layout(ctx);
    if (this.t < 0.45) {
      this.keyQueue.length = 0;
      return RESULT_NONE;
    }

    let action = RESULT_NONE;

    if (ctx.input.pausePressed) return RESULT_LEVELS;

    for (let i = 0; i < this.keyQueue.length; i++) {
      const k = this.keyQueue[i];
      this.keyboard = true;
      if (k === 'ArrowLeft' || k === 'ArrowUp') this.step(ctx, -1);
      else if (k === 'ArrowRight' || k === 'ArrowDown') this.step(ctx, 1);
      else action = this.focus + 1;
    }
    this.keyQueue.length = 0;

    const taps = ctx.input.taps;
    for (let i = 0; i < taps.length; i++) {
      const tap = taps[i];
      for (let j = 0; j < N_ITEMS; j++) {
        if (!this.hit(j, tap.x, tap.y)) continue;
        this.keyboard = false;
        this.focus = j;
        action = j + 1;
        break;
      }
    }

    return action;
  }

  private step(ctx: Ctx, d: number): void {
    const next = clamp(this.focus + d, 0, N_ITEMS - 1);
    if (next === this.focus) return;
    this.focus = next;
    ctx.audio.play('uiTap', 0.5);
  }

  /** World-space buttons, for the capture harness. */
  probe(): { id: string; x: number; y: number; w: number; h: number }[] {
    const out = [];
    const ids = ['retry', 'levels', 'next'];
    for (let i = 0; i < N_ITEMS; i++) {
      const r = this.rects[i];
      out.push({ id: ids[i], x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h });
    }
    return out;
  }

  // -------------------------------------------------------------------- draw

  draw(ctx: Ctx): void {
    if (!this.open) return;
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const a = smoothstep(this.t);
    const p = this.panel;

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
      0.5 * a,
    );

    const lift = (1 - a) * 26;
    const y = p.y + lift;
    const cx = p.x + p.w / 2;

    plate(ctx, cx, y + p.h / 2 + 12, p.w, p.h, PANEL_RAD, C_DARK, 0.45 * a);
    plate(ctx, cx, y + p.h / 2, p.w, p.h, PANEL_RAD, C_PANEL, 0.97 * a);
    plateRing(ctx, cx, y + p.h / 2, p.w, p.h, PANEL_RAD, C_GOLD, 0.6 * a);

    text(ctx, TITLE, p.x + PAD_X, y + Y_TITLE + 18, 38, C_GOLD, 'left', a, 0.16, 4);
    text(ctx, HINT, p.x + p.w - PAD_X, y + Y_TITLE + 20, 16, C_DIM, 'right', a * 0.5, 0.2, 0);
    text(ctx, this.levelTitle, p.x + PAD_X, y + Y_LEVEL, 22, C_PAPER, 'left', a * 0.85, 0.12, 0);

    for (let i = 0; i < N_STATS; i++) {
      const sy = y + Y_STATS + i * H_STAT + H_STAT / 2;
      text(ctx, STAT_KEYS[i], p.x + PAD_X, sy, 19, C_DIM, 'left', a * 0.7, 0.2, 0);
      const vx = p.x + PAD_X + 190;
      text(ctx, this.values[i], vx, sy, 28, C_PAPER, 'left', a, 0.02, 2);
      if (this.isBest[i]) {
        text(ctx, BEST, p.x + p.w - PAD_X, sy, 17, C_GOOD, 'right', a * 0.95, 0.18, 0);
      }
    }

    this.drawButton(ctx, I_RETRY, 'PLAY AGAIN', '', lift, a, true);
    this.drawButton(ctx, I_LEVELS, 'LEVELS', 'ESC', lift, a, false);
    this.drawButton(ctx, I_NEXT, this.nextLabel, '', lift, a, false);
  }

  private drawButton(
    ctx: Ctx,
    i: number,
    label: string,
    sub: string,
    lift: number,
    a: number,
    loud: boolean,
  ): void {
    const rect = this.rects[i];
    const top = rect.y + lift;
    const rad = Math.min(26, rect.h / 2);
    const cx = rect.x + rect.w / 2;
    const cy = top + rect.h / 2;
    const hovered = ctx.input.hasHover && this.hit(i, ctx.input.hoverX, ctx.input.hoverY);
    const focused = this.keyboard && this.focus === i;

    if (loud) {
      const pulse = 0.9 + Math.sin(ctx.time * 3) * 0.06 + (hovered ? 0.1 : 0);
      plate(ctx, cx, cy, rect.w, rect.h, rad, C_GOLD_DEEP, a * pulse);
      plateRing(ctx, cx, cy, rect.w, rect.h, rad, C_GOLD, a);
    } else {
      plate(ctx, cx, cy, rect.w, rect.h, rad, C_PLATE, a * (hovered ? 0.98 : 0.75));
      plateRing(ctx, cx, cy, rect.w, rect.h, rad, C_PAPER, a * (hovered ? 0.42 : 0.18));
    }
    if (focused) plateRing(ctx, cx, cy, rect.w + 14, rect.h + 14, rad + 7, C_PAPER, a * 0.8);

    // The label is fitted rather than trusted: "NEXT LONG WORD GAUNTLET" is
    // wider than a third of the panel at any size worth reading.
    const size = fitSize(label, rect.w - 26, 24);
    text(ctx, label, cx, cy - (sub ? 8 : 0), size, loud ? C_DARK : C_PAPER, 'center', a, 0.08, 0);
    if (sub) text(ctx, sub, cx, cy + 20, 14, C_DIM, 'center', a * 0.6, 0.2, 0);
  }
}

// ------------------------------------------------------------------- helpers

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Largest size at or below `base` that fits `str` into `room`. */
function fitSize(str: string, room: number, base: number): number {
  const w = str.length * base * 0.58;
  return w <= room ? base : Math.max(12, (base * room) / w);
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
