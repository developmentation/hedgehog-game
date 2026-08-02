/**
 * The Workshop — where sparks become a new hedgehog.
 *
 * Three columns (skins, trails, spin patterns) sit beside a live preview, so
 * whatever the player is pointing at is already rolling in front of them before
 * they spend anything. There is exactly one commit button; browsing never costs
 * you a spark, and the button always spells out what it is about to do.
 *
 * Every rule about what is owned, what is affordable and what a milestone
 * requires comes from `game/progression`. This file is presentation and input
 * only — it decides nothing about the economy.
 *
 * Input parity is a hard requirement: the same screen has to work with a
 * finger, a mouse and a keyboard. Rows are 62 world units tall inside a 236
 * unit column (comfortably past a 44px touch target at any sane scale), the
 * mouse selects on click (never on hover), and arrow keys walk the same grid.
 * Arrow keys are not part of the shared `Input` letter/tap model, so the scene
 * owns a small key listener for its lifetime and drops it on the way out.
 */

import type { Ctx, Scene } from '../core/ctx';
import { VIEW_W, VIEW_H, clamp } from '../core/ctx';
import type { Frame } from '../engine/gl';
import { Blend } from '../engine/gl';
import { drawText, type TextStyle } from '../ui/text';
import { INK, rgb, skinById, trailById, spinById } from '../art/palette';
import { Particles, type EmitOptions } from '../game/particles';
import {
  CATEGORIES,
  CATALOGUE_SIZE,
  activate,
  checkUnlocks,
  howManyOwned,
  isUnlocked,
  itemState,
  rankFor,
  type CosmeticEntry,
  type RankInfo,
} from '../game/progression';

// ------------------------------------------------------------------- layout

const HEADER_H = 176;

const CARD_X = 40;
const CARD_Y = 196;
const CARD_W = 420;
const CARD_H = 494;
const CARD_CX = CARD_X + CARD_W / 2;

const HOG_X = CARD_CX;
const HOG_Y = 360;

const GRID_CARD_X = 478;
const GRID_CARD_W = 774;
const GRID_X = 490;
const COL_W = 236;
const COL_GAP = 21;
const COL_TITLE_Y = 226;
const ROW_Y0 = 246;
const ROW_H = 62;
const ROW_GAP = 9;

const BTN_X = CARD_X + 40;
const BTN_Y = 622;
const BTN_W = CARD_W - 80;
const BTN_H = 60;

const BACK_X = GRID_X + 2 * (COL_W + COL_GAP);
const BACK_Y = 614;
const BACK_W = COL_W;
const BACK_H = 56;

const colLeft = (c: number): number => GRID_X + c * (COL_W + COL_GAP);
const rowTop = (i: number): number => ROW_Y0 + i * (ROW_H + ROW_GAP);

// ------------------------------------------------------------------ palette

const C_PAPER = rgb(INK.paper);
const C_SHADE = rgb(INK.paperShade);
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_GOLD_DEEP = rgb(INK.goldDeep);
const C_GOOD = rgb(INK.good);
const C_DANGER = rgb(INK.danger);
const C_WHITE: [number, number, number] = [1, 1, 1];

/** Reused so text drawing never allocates a style object per frame. */
const ST: TextStyle = { size: 20, color: C_PAPER, align: 'left', alpha: 1, tracking: 0, shadow: 0 };

const BALL_FRAMES: string[] = [];
for (let i = 0; i < 8; i++) BALL_FRAMES.push(`hedgehog/ball_${String(i).padStart(2, '0')}`);

/** Reused emit options — `Particles.emit` reads and never retains this. */
const TRAIL_OPT: EmitOptions = {
  frame: null as unknown as Frame,
  x: 0,
  y: 0,
  count: 1,
  speed: [110, 260],
  angle: Math.PI * 0.98,
  spread: 0.45,
  life: [0.35, 0.7],
  size: [14, 34],
  sizeEnd: 0.15,
  color: C_WHITE,
  gravity: 40,
  drag: 1.5,
  spin: 5,
  additive: true,
};

// -------------------------------------------------------------- stack access

interface StackLike {
  push(s: Scene): void;
  pop(): void;
}

function gameStack(): StackLike | null {
  const g = (window as unknown as { __game?: { stack?: StackLike } }).__game;
  return g?.stack ?? null;
}

/** Push the workshop over whatever is playing. No-op before boot completes. */
export function openShop(): boolean {
  const st = gameStack();
  if (!st) return false;
  st.push(new ShopScene());
  return true;
}

// -------------------------------------------------------------------- scene

export class ShopScene implements Scene {
  readonly name = 'shop';

  private col = 0;
  private row = 0;
  private t = 0;
  private spinAngle = 0;
  private selectPop = 0;
  private denyShake = 0;
  private buyFlash = 0;
  private trailTimer = 0;

  private particles = new Particles();
  private rank: RankInfo = { level: 1, title: '', floor: 0, next: 0, progress: 0 };

  // Cached strings, rebuilt only when the numbers behind them move.
  private costLabels = new Map<string, string>();
  private balanceStr = '0';
  private balanceCache = -1;
  private rankStr = '';
  private rankProgStr = '';
  private collectionStr = '';
  private actionLabel = '';
  private actionEnabled = false;
  private detailStr = '';
  private requireStr = '';


  private keyQueue: string[] = [];
  private onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    if (
      k === 'ArrowUp' ||
      k === 'ArrowDown' ||
      k === 'ArrowLeft' ||
      k === 'ArrowRight' ||
      k === 'Enter' ||
      k === ' ' ||
      k === 'Backspace'
    ) {
      if (!e.repeat) this.keyQueue.push(k);
      e.preventDefault();
    }
  };

  // ------------------------------------------------------------- lifecycle

  enter(ctx: Ctx): void {
    // Anything the player earned but never saw celebrated lands now, so the
    // shop is always showing the truth about what they own.
    if (checkUnlocks(ctx.save.profile).length) ctx.save.save();

    for (const cat of CATEGORIES) {
      for (const item of cat.items) {
        if (!this.costLabels.has(item.id)) this.costLabels.set(item.id, String(item.cost));
      }
    }

    // Open on whatever is currently worn, so the preview matches the game the
    // player just left.
    const equipped = ctx.save.profile.equipped.skin;
    const idx = CATEGORIES[0].items.findIndex((i) => i.id === equipped);
    this.col = 0;
    this.row = idx >= 0 ? idx : 0;

    this.refreshRank(ctx);
    this.refreshSelection(ctx);
    window.addEventListener('keydown', this.onKey);
    ctx.audio.play('uiTap', 0.7);
  }

  exit(ctx: Ctx): void {
    window.removeEventListener('keydown', this.onKey);
    this.keyQueue.length = 0;
    this.particles.clear();
    ctx.save.save();
  }

  private close(): void {
    gameStack()?.pop();
  }

  // ---------------------------------------------------------------- helpers

  private items(col: number): readonly CosmeticEntry[] {
    return CATEGORIES[col].items;
  }

  private get selected(): CosmeticEntry {
    const list = this.items(this.col);
    return list[clamp(this.row, 0, list.length - 1)];
  }

  private refreshRank(ctx: Ctx): void {
    const p = ctx.save.profile;
    rankFor(p.totalScore, this.rank);
    this.rankStr = `RANK ${this.rank.level}  ${this.rank.title.toUpperCase()}`;
    this.rankProgStr =
      this.rank.next < 0
        ? 'MAX RANK'
        : `${Math.round(p.totalScore)} / ${this.rank.next}`;
    this.collectionStr = `${howManyOwned(p)} / ${CATALOGUE_SIZE} COLLECTED`;
  }

  /** Rebuild the strings that depend on which item is highlighted. */
  private refreshSelection(ctx: Ctx): void {
    const p = ctx.save.profile;
    const item = this.selected;
    const state = itemState(p, item.id);

    switch (state) {
      case 'equipped':
        this.actionLabel = 'EQUIPPED';
        this.actionEnabled = false;
        this.detailStr = 'Currently worn';
        break;
      case 'owned':
        this.actionLabel = 'EQUIP';
        this.actionEnabled = true;
        this.detailStr = 'Unlocked';
        break;
      case 'affordable':
        this.actionLabel = `BUY  ${item.cost}`;
        this.actionEnabled = true;
        this.detailStr = `Costs ${item.cost} sparks`;
        break;
      default:
        this.actionLabel = `NEED  ${item.cost - p.sparks}`;
        this.actionEnabled = false;
        this.detailStr = `Costs ${item.cost} sparks`;
        break;
    }

    if (item.milestone && !isUnlocked(p, item.id)) {
      this.requireStr = `OR ${item.milestone.detail.toUpperCase()}  ${item.milestone.counter(p)}`;
    } else {
      this.requireStr = '';
    }
  }

  private select(ctx: Ctx, col: number, row: number, sound: boolean): void {
    const c = clamp(col, 0, CATEGORIES.length - 1);
    const r = clamp(row, 0, this.items(c).length - 1);
    if (c === this.col && r === this.row) return;
    this.col = c;
    this.row = r;
    this.selectPop = 1;
    this.particles.clear();
    this.refreshSelection(ctx);
    if (sound) ctx.audio.play('uiTap', 0.5);
  }

  private commit(ctx: Ctx): void {
    const item = this.selected;
    const res = activate(ctx.save.profile, item.id);
    if (res === 'bought') {
      ctx.audio.play('unlock', 1);
      ctx.shake(6, 0.24);
      this.buyFlash = 1;
      this.refreshRank(ctx);
      ctx.save.save();
    } else if (res === 'equipped') {
      ctx.audio.play('letterLock', 0.9);
      this.buyFlash = 0.55;
      ctx.save.save();
    } else {
      ctx.audio.play('bounce', 0.7);
      this.denyShake = 1;
    }
    this.refreshSelection(ctx);
  }

  // ------------------------------------------------------------------ update

  update(ctx: Ctx, dt: number): void {
    this.t += dt;
    this.spinAngle += dt * 3.4;
    this.selectPop = Math.max(0, this.selectPop - dt * 3.2);
    this.denyShake = Math.max(0, this.denyShake - dt * 4.5);
    this.buyFlash = Math.max(0, this.buyFlash - dt * 1.8);
    this.particles.update(dt);
    this.emitPreviewTrail(ctx, dt);

    if (ctx.input.pausePressed) {
      this.close();
      return;
    }

    // Keyboard: the scene's own arrow listener, plus WASD from the shared map.
    for (let i = 0; i < this.keyQueue.length; i++) {
      const k = this.keyQueue[i];
      if (k === 'ArrowUp') this.select(ctx, this.col, this.row - 1, true);
      else if (k === 'ArrowDown') this.select(ctx, this.col, this.row + 1, true);
      else if (k === 'ArrowLeft') this.select(ctx, this.col - 1, this.row, true);
      else if (k === 'ArrowRight') this.select(ctx, this.col + 1, this.row, true);
      else if (k === 'Backspace') {
        this.keyQueue.length = 0;
        this.close();
        return;
      } else this.commit(ctx);
    }
    this.keyQueue.length = 0;

    for (let i = 0; i < ctx.input.keysPressed.length; i++) {
      const k = ctx.input.keysPressed[i];
      if (k === 'W') this.select(ctx, this.col, this.row - 1, true);
      else if (k === 'S') this.select(ctx, this.col, this.row + 1, true);
      else if (k === 'A') this.select(ctx, this.col - 1, this.row, true);
      else if (k === 'D') this.select(ctx, this.col + 1, this.row, true);
    }

    // Selection is committed by CLICK ONLY — never by hover.
    //
    // Hover-driven selection made the shop unusable: you would click the item
    // you wanted, then move the mouse toward the BUY button, and every row the
    // pointer crossed on the way stole the selection, so BUY always applied to
    // the wrong thing. Pointing at something is not the same as choosing it.
    // Hover still draws a highlight (see `drawRows`), it just cannot change
    // what is selected.

    for (let i = 0; i < ctx.input.taps.length; i++) {
      const tap = ctx.input.taps[i];
      if (hit(tap.x, tap.y, BACK_X, BACK_Y, BACK_W, BACK_H)) {
        ctx.audio.play('uiTap', 0.8);
        this.close();
        return;
      }
      if (hit(tap.x, tap.y, BTN_X, BTN_Y, BTN_W, BTN_H)) {
        this.commit(ctx);
        continue;
      }
      const c = this.colAt(tap.x);
      const r = this.rowAt(c, tap.y);
      if (c >= 0 && r >= 0) {
        this.select(ctx, c, r, true);
        // Tapping something you already own wears it immediately. Buying always
        // goes through the explicit button, so a stray tap never spends sparks.
        if (itemState(ctx.save.profile, this.items(c)[r].id) === 'owned') this.commit(ctx);
      }
    }
  }

  private colAt(x: number): number {
    for (let c = 0; c < CATEGORIES.length; c++) {
      const left = colLeft(c);
      if (x >= left && x <= left + COL_W) return c;
    }
    return -1;
  }

  private rowAt(col: number, y: number): number {
    if (col < 0) return -1;
    const n = this.items(col).length;
    for (let i = 0; i < n; i++) {
      const top = rowTop(i);
      if (y >= top && y <= top + ROW_H) return i;
    }
    return -1;
  }

  private emitPreviewTrail(ctx: Ctx, dt: number): void {
    const trail = trailById(this.previewId(ctx, 'trail'));
    if (!trail.sprite || !ctx.atlas.has(trail.sprite)) return;
    this.trailTimer += dt * 26;
    while (this.trailTimer >= 1) {
      this.trailTimer -= 1;
      TRAIL_OPT.frame = ctx.atlas.get(trail.sprite);
      TRAIL_OPT.x = HOG_X - 30;
      TRAIL_OPT.y = HOG_Y + 26;
      TRAIL_OPT.color = trail.color;
      TRAIL_OPT.additive = trail.id !== 'trail/dust';
      this.particles.emit(ctx, TRAIL_OPT);
    }
  }

  /** Which cosmetic of `kind` the preview shows: the highlight beats the kit. */
  private previewId(ctx: Ctx, kind: 'skin' | 'trail' | 'spin'): string {
    const item = this.selected;
    return item.kind === kind ? item.id : ctx.save.profile.equipped[kind];
  }

  // -------------------------------------------------------------------- draw

  draw(): void {
    /* The workshop is entirely screen-space; the frozen game shows through. */
  }

  drawUi(ctx: Ctx): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');

    // Scrim over the paused game. Opaque enough that the HUD underneath cannot
    // compete with the shop's own type, sheer enough to keep a sense of place.
    r.draw(px, VIEW_W / 2, VIEW_H / 2, VIEW_W / px.w, VIEW_H / px.h, 0, 0.03, 0.035, 0.075, 0.97);

    this.drawHeader(ctx, px);
    this.drawPreview(ctx, px);
    this.drawGrid(ctx, px);
    this.drawFooter(ctx, px);
  }

  // ------------------------------------------------------------------ header

  private drawHeader(ctx: Ctx, px: Frame): void {
    const r = ctx.r;
    const p = ctx.save.profile;

    fill(r, px, 0, 0, VIEW_W, HEADER_H, 0.06, 0.06, 0.13, 0.9);
    fill(r, px, 0, HEADER_H - 3, VIEW_W, 3, C_GOLD[0], C_GOLD[1], C_GOLD[2], 0.42);

    text(ctx, 'WORKSHOP', 48, 74, 44, C_GOLD, 'left', 1, 0.14, 4);
    text(ctx, 'SPEND SPARKS ON A NEW LOOK', 50, 110, 17, C_SHADE, 'left', 0.72, 0.2, 0);
    text(ctx, this.collectionStr, 50, 140, 16, C_GOOD, 'left', 0.75, 0.16, 0);

    // Rank ladder.
    const barW = 300;
    const barX = VIEW_W / 2 - barW / 2;
    text(ctx, this.rankStr, VIEW_W / 2, 68, 26, C_PAPER, 'center', 0.95, 0.14, 3);
    roundedPanel(ctx, barX, 98, barW, 12, 6, EDGE, 0.12);
    const w = Math.max(12, barW * this.rank.progress);
    roundedPanel(ctx, barX, 98, w, 12, 6, C_GOLD, 0.95);
    text(ctx, this.rankProgStr, VIEW_W / 2, 126, 16, C_SHADE, 'center', 0.7, 0.1, 0);

    // Spark balance.
    if (this.balanceCache !== p.sparks) {
      this.balanceCache = p.sparks;
      this.balanceStr = String(p.sparks);
    }
    const spark = ctx.atlas.get('ui/spark');
    const pulse = 1 + this.buyFlash * 0.2;
    const ss = (32 / spark.w) * pulse;
    r.setBlend(Blend.Additive);
    const glow = ctx.atlas.get('fx/glow');
    r.draw(glow, 1206, 72, 96 / glow.w, 96 / glow.h, 0, 1, 0.82, 0.35, 0.16 + this.buyFlash * 0.3);
    r.setBlend(Blend.Normal);
    r.draw(spark, 1206, 72, ss, ss, this.t * 0.6, C_GOLD[0], C_GOLD[1], C_GOLD[2], 1);
    text(ctx, this.balanceStr, 1176, 74, 38, C_PAPER, 'right', 1, 0, 3);
    text(ctx, 'SPARKS', 1232, 110, 15, C_SHADE, 'right', 0.65, 0.2, 0);
  }

  // ----------------------------------------------------------------- preview

  private drawPreview(ctx: Ctx, px: Frame): void {
    const r = ctx.r;
    const item = this.selected;
    const skin = skinById(this.previewId(ctx, 'skin'));
    const spin = spinById(this.previewId(ctx, 'spin'));
    const c = rgbInto(skin.quill.base, TINT_A);
    const hi = rgbInto(skin.quill.hi, TINT_B);

    card(ctx, CARD_X, CARD_Y, CARD_W, CARD_H);

    // Medallion plate — ui/panel is square, so its rounding stays honest here.
    const panel = ctx.atlas.get('ui/panel');
    const ps = 280 / panel.w;
    r.draw(panel, HOG_X, HOG_Y, ps, ps, 0, 0.12, 0.13, 0.24, 0.95);

    r.setBlend(Blend.Additive);
    const glow = ctx.atlas.get('fx/glow');
    const gp = 250 + Math.sin(this.t * 2) * 12 + this.buyFlash * 90;
    r.draw(glow, HOG_X, HOG_Y, gp / glow.w, gp / glow.h, 0, hi[0], hi[1], hi[2], 0.3 + this.buyFlash * 0.4);
    r.setBlend(Blend.Normal);

    // Spin pattern: echoes trailing the ball, plus its signature ring.
    const ball = this.ballFrame(ctx, this.spinAngle);
    const bs = 175 / ball.w;
    r.setBlend(Blend.Additive);
    for (let i = spin.echoes; i >= 1; i--) {
      const k = i / spin.echoes;
      r.draw(
        ball,
        HOG_X - k * 62,
        HOG_Y + k * 10,
        bs * (1 - k * 0.12),
        bs * (1 - k * 0.12),
        this.spinAngle - k * 0.5,
        c[0],
        c[1],
        c[2],
        0.26 * (1 - k),
      );
    }
    this.drawSpinRing(ctx, spin.ring);
    r.setBlend(Blend.Normal);

    this.particles.draw(ctx);

    const bob = Math.sin(this.t * 2.2) * 5;
    const pop = 1 + this.selectPop * 0.12;
    r.draw(ball, HOG_X, HOG_Y + bob, bs * pop, bs * pop, this.spinAngle, c[0], c[1], c[2], 1);

    // Name, colour swatches and the state line.
    text(ctx, item.label.toUpperCase(), CARD_CX, 512, 34, C_PAPER, 'center', 1, 0.06, 3);
    this.drawSwatches(ctx, CARD_CX, 544, item);
    text(ctx, this.detailStr, CARD_CX, 578, 18, C_SHADE, 'center', 0.85, 0.04, 0);
    if (this.requireStr) {
      text(ctx, this.requireStr, CARD_CX, 602, 15, C_GOOD, 'center', 0.8, 0.06, 0);
    }

    this.drawActionButton(ctx, px);
  }

  private drawSwatches(ctx: Ctx, cx: number, y: number, item: CosmeticEntry): void {
    if (item.kind === 'skin') {
      const s = skinById(item.id);
      const cols = SWATCH_SRC;
      cols[0] = s.quill.shade;
      cols[1] = s.quill.base;
      cols[2] = s.quill.hi;
      cols[3] = s.belly.base;
      cols[4] = s.belly.hi;
      const w = 26;
      let x = cx - (cols.length * (w + 4) - 4) / 2;
      for (let i = 0; i < cols.length; i++) {
        roundedPanel(ctx, x, y - 7, w, 14, 7, rgbInto(cols[i], TINT_C), 1);
        x += w + 4;
      }
    } else if (item.kind === 'trail') {
      const t = trailById(item.id);
      TINT_C[0] = t.color[0];
      TINT_C[1] = t.color[1];
      TINT_C[2] = t.color[2];
      roundedPanel(ctx, cx - 60, y - 7, 120, 14, 7, TINT_C, t.sprite ? 1 : 0.22);
    } else {
      const s = spinById(item.id);
      const w = 16;
      let x = cx - (s.echoes * (w + 4) - 4) / 2;
      for (let i = 0; i < s.echoes; i++) {
        roundedPanel(ctx, x, y - 7, w, 14, 7, C_GOLD, 0.35 + (i / s.echoes) * 0.65);
        x += w + 4;
      }
    }
  }

  private drawSpinRing(ctx: Ctx, ring: string): void {
    if (ring === 'none') return;
    const r = ctx.r;
    if (ring === 'halo') {
      const f = ctx.atlas.get('fx/ring');
      const s = (250 + Math.sin(this.t * 5) * 10) / f.w;
      r.draw(f, HOG_X, HOG_Y, s, s, -this.spinAngle * 0.4, 1, 0.9, 0.55, 0.55);
      return;
    }
    const f = ctx.atlas.get('fx/streak');
    const n = ring === 'dashes' ? 8 : 5;
    const rad = 118;
    const len = ring === 'dashes' ? 34 : 52;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.spinAngle * 0.7;
      const x = HOG_X + Math.cos(a) * rad;
      const y = HOG_Y + Math.sin(a) * rad;
      const rot = ring === 'dashes' ? a + Math.PI / 2 : a;
      r.draw(f, x, y, len / f.w, (ring === 'dashes' ? 10 : 14) / f.h, rot, 1, 0.86, 0.5, 0.75);
    }
  }

  private ballFrame(ctx: Ctx, angle: number): Frame {
    const gen = ctx.assets.get('hog_ball');
    if (gen) return gen;
    const n = BALL_FRAMES.length;
    const i = ((Math.floor((angle / (Math.PI * 2)) * n) % n) + n) % n;
    return ctx.atlas.get(BALL_FRAMES[i]);
  }

  private drawActionButton(ctx: Ctx, px: Frame): void {
    const r = ctx.r;
    const hovered =
      ctx.input.hasHover && hit(ctx.input.hoverX, ctx.input.hoverY, BTN_X, BTN_Y, BTN_W, BTN_H);
    const shake = this.denyShake > 0 ? Math.sin(this.denyShake * 48) * this.denyShake * 7 : 0;
    const x = BTN_X + shake;

    if (this.actionEnabled) {
      const pulse = 0.88 + Math.sin(this.t * 3) * 0.06 + (hovered ? 0.12 : 0);
      roundedPanel(ctx, x, BTN_Y, BTN_W, BTN_H, 18, C_GOLD_DEEP, pulse);
      roundedRing(ctx, x, BTN_Y, BTN_W, BTN_H, 18, C_GOLD, 1);
      text(ctx, this.actionLabel, x + BTN_W / 2, BTN_Y + BTN_H / 2, 28, C_DARK, 'center', 1, 0.12, 0);
    } else {
      roundedPanel(ctx, x, BTN_Y, BTN_W, BTN_H, 18, EDGE, 0.08);
      roundedRing(ctx, x, BTN_Y, BTN_W, BTN_H, 18, EDGE, 0.18);
      const col = this.denyShake > 0.05 ? C_DANGER : C_SHADE;
      text(ctx, this.actionLabel, x + BTN_W / 2, BTN_Y + BTN_H / 2, 26, col, 'center', 0.75, 0.12, 0);
    }
  }

  // -------------------------------------------------------------------- grid

  private drawGrid(ctx: Ctx, px: Frame): void {
    const r = ctx.r;
    const p = ctx.save.profile;
    const spark = ctx.atlas.get('ui/spark');

    card(ctx, GRID_CARD_X, CARD_Y, GRID_CARD_W, CARD_H);

    for (let c = 0; c < CATEGORIES.length; c++) {
      const cat = CATEGORIES[c];
      const left = colLeft(c);
      const selectedCol = c === this.col;

      text(ctx, cat.title, left + 4, COL_TITLE_Y, 20, selectedCol ? C_GOLD : C_SHADE, 'left', selectedCol ? 1 : 0.6, 0.22, 0);
      fill(r, px, left + 4, COL_TITLE_Y + 16, 40, 3, C_GOLD[0], C_GOLD[1], C_GOLD[2], selectedCol ? 0.9 : 0.25);

      for (let i = 0; i < cat.items.length; i++) {
        const item = cat.items[i];
        const top = rowTop(i);
        const cy = top + ROW_H / 2;
        const isSel = selectedCol && i === this.row;
        const state = itemState(p, item.id);
        const owned = state === 'equipped' || state === 'owned';

        // Row plate. Hover is a *pointing* affordance only — it lifts the
        // plate so the mouse feels responsive, but it never changes the
        // selection, which belongs to click alone.
        const hovered =
          !isSel &&
          ctx.input.hasHover &&
          hit(ctx.input.hoverX, ctx.input.hoverY, left, top, COL_W, ROW_H);

        if (isSel) {
          roundedPanel(ctx, left, top, COL_W, ROW_H, 15, C_GOLD, 0.24 + this.selectPop * 0.12);
          roundedRing(ctx, left, top, COL_W, ROW_H, 15, C_GOLD, 0.95);
        } else {
          roundedPanel(ctx, left, top, COL_W, ROW_H, 15, EDGE, hovered ? 0.16 : owned ? 0.09 : 0.05);
          roundedRing(ctx, left, top, COL_W, ROW_H, 15, EDGE, hovered ? 0.34 : 0.1);
        }

        // Colour identity bar.
        const bar = rowTint(item, TINT_C);
        roundedPanel(ctx, left + 12, top + 12, 8, ROW_H - 24, 4, bar, owned ? 1 : 0.45);

        const labelCol = owned ? C_PAPER : isSel ? C_PAPER : C_SHADE;
        text(ctx, item.label, left + 26, cy - 1, 21, labelCol, 'left', owned || isSel ? 1 : 0.72, 0.02, 0);

        if (state === 'equipped') {
          text(ctx, 'WORN', left + COL_W - 14, cy - 1, 16, C_GOOD, 'right', 1, 0.16, 0);
        } else if (state === 'owned') {
          text(ctx, 'OWNED', left + COL_W - 14, cy - 1, 15, C_SHADE, 'right', 0.7, 0.16, 0);
        } else {
          const affordable = state === 'affordable';
          const sc = 17 / spark.w;
          r.draw(
            spark,
            left + COL_W - 24,
            cy - 1,
            sc,
            sc,
            0,
            C_GOLD[0],
            C_GOLD[1],
            C_GOLD[2],
            affordable ? 1 : 0.4,
          );
          text(
            ctx,
            this.costLabels.get(item.id) ?? '',
            left + COL_W - 38,
            cy - 1,
            19,
            affordable ? C_GOLD : C_SHADE,
            'right',
            affordable ? 1 : 0.55,
            0,
            0,
          );
        }
      }
    }
  }

  private drawFooter(ctx: Ctx, px: Frame): void {
    const r = ctx.r;
    text(ctx, 'ARROWS OR WASD  MOVE', GRID_X + 4, 632, 15, C_SHADE, 'left', 0.55, 0.16, 0);
    text(ctx, 'ENTER  BUY OR EQUIP', GRID_X + 4, 656, 15, C_SHADE, 'left', 0.55, 0.16, 0);

    const hovered =
      ctx.input.hasHover && hit(ctx.input.hoverX, ctx.input.hoverY, BACK_X, BACK_Y, BACK_W, BACK_H);
    roundedPanel(ctx, BACK_X, BACK_Y, BACK_W, BACK_H, 18, EDGE, hovered ? 0.2 : 0.1);
    roundedRing(ctx, BACK_X, BACK_Y, BACK_W, BACK_H, 18, C_PAPER, 0.45);
    text(ctx, 'BACK TO PLAY', BACK_X + BACK_W / 2, BACK_Y + BACK_H / 2 - 4, 22, C_PAPER, 'center', 0.95, 0.1, 0);
    text(ctx, 'ESC', BACK_X + BACK_W / 2, BACK_Y + BACK_H / 2 + 16, 13, C_SHADE, 'center', 0.6, 0.2, 0);
  }
}

// ------------------------------------------------------------------- drawing

const TINT_A: [number, number, number] = [1, 1, 1];
const TINT_B: [number, number, number] = [1, 1, 1];
const TINT_C: [number, number, number] = [1, 1, 1];
const SWATCH_SRC: string[] = ['', '', '', '', ''];

/** `rgb()` without the allocation — writes straight into a reused tuple. */
function rgbInto(hex: string, out: [number, number, number]): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  out[0] = ((n >> 16) & 255) / 255;
  out[1] = ((n >> 8) & 255) / 255;
  out[2] = (n & 255) / 255;
  return out;
}

function rowTint(item: CosmeticEntry, out: [number, number, number]): [number, number, number] {
  if (item.kind === 'skin') return rgbInto(skinById(item.id).quill.light, out);
  if (item.kind === 'trail') {
    const t = trailById(item.id);
    out[0] = t.color[0];
    out[1] = t.color[1];
    out[2] = t.color[2];
    return out;
  }
  return rgbInto(INK.gold, out);
}

const hit = (px: number, py: number, x: number, y: number, w: number, h: number): boolean =>
  px >= x && px <= x + w && py >= y && py <= y + h;

/** Top-left anchored filled rect. */
function fill(
  r: Ctx['r'],
  px: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  cr: number,
  cg: number,
  cb: number,
  a: number,
): void {
  r.draw(px, x + w / 2, y + h / 2, w / px.w, h / px.h, 0, cr, cg, cb, a);
}

function outline(
  r: Ctx['r'],
  px: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  cr: number,
  cg: number,
  cb: number,
  a: number,
): void {
  fill(r, px, x, y, w, t, cr, cg, cb, a);
  fill(r, px, x, y + h - t, w, t, cr, cg, cb, a);
  fill(r, px, x, y + t, t, h - t * 2, cr, cg, cb, a);
  fill(r, px, x + w - t, y + t, t, h - t * 2, cr, cg, cb, a);
}

const HALF_PI = Math.PI / 2;

/**
 * A rounded panel built from four quarter-discs and up to three stretched
 * pixels — the same corner language the HUD uses, so the shop reads as part of
 * the same interface rather than a bolted-on menu. Falls back to a square rect
 * if the corner sprite is not in the atlas.
 */
export function roundedPanel(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  rad: number,
  c: [number, number, number],
  a: number,
): void {
  const r = ctx.r;
  const px = ctx.atlas.get('ui/pixel');
  if (!ctx.atlas.has('ui/corner')) {
    fill(r, px, x, y, w, h, c[0], c[1], c[2], a);
    return;
  }
  const co = ctx.atlas.get('ui/corner');
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rr = Math.min(rad, w * 0.5, h * 0.5);
  const sc = rr / co.w;
  const x0 = cx - w / 2 + rr / 2;
  const x1 = cx + w / 2 - rr / 2;
  const y0 = cy - h / 2 + rr / 2;
  const y1 = cy + h / 2 - rr / 2;
  r.draw(co, x0, y0, sc, sc, 0, c[0], c[1], c[2], a);
  r.draw(co, x1, y0, sc, sc, HALF_PI, c[0], c[1], c[2], a);
  r.draw(co, x1, y1, sc, sc, Math.PI, c[0], c[1], c[2], a);
  r.draw(co, x0, y1, sc, sc, -HALF_PI, c[0], c[1], c[2], a);
  const midW = w - rr * 2;
  if (midW > 0.5) {
    r.draw(px, cx, y0, midW / px.w, rr / px.h, 0, c[0], c[1], c[2], a);
    r.draw(px, cx, y1, midW / px.w, rr / px.h, 0, c[0], c[1], c[2], a);
  }
  const midH = h - rr * 2;
  if (midH > 0.5) r.draw(px, cx, cy, w / px.w, midH / px.h, 0, c[0], c[1], c[2], a);
}

/** The outline that registers exactly with `roundedPanel`. */
export function roundedRing(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  rad: number,
  c: [number, number, number],
  a: number,
): void {
  const r = ctx.r;
  const px = ctx.atlas.get('ui/pixel');
  if (!ctx.atlas.has('ui/corner_ring')) {
    outline(r, px, x, y, w, h, 2, c[0], c[1], c[2], a);
    return;
  }
  const co = ctx.atlas.get('ui/corner_ring');
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rr = Math.min(rad, w * 0.5, h * 0.5);
  const sc = rr / co.w;
  const lw = rr / 8;
  const x0 = cx - w / 2 + rr / 2;
  const x1 = cx + w / 2 - rr / 2;
  const y0 = cy - h / 2 + rr / 2;
  const y1 = cy + h / 2 - rr / 2;
  r.draw(co, x0, y0, sc, sc, 0, c[0], c[1], c[2], a);
  r.draw(co, x1, y0, sc, sc, HALF_PI, c[0], c[1], c[2], a);
  r.draw(co, x1, y1, sc, sc, Math.PI, c[0], c[1], c[2], a);
  r.draw(co, x0, y1, sc, sc, -HALF_PI, c[0], c[1], c[2], a);
  const midW = w - rr * 2;
  if (midW > 0.5) {
    r.draw(px, cx, y + lw / 2, midW / px.w, lw / px.h, 0, c[0], c[1], c[2], a);
    r.draw(px, cx, y + h - lw / 2, midW / px.w, lw / px.h, 0, c[0], c[1], c[2], a);
  }
  const midH = h - rr * 2;
  if (midH > 0.5) {
    r.draw(px, x + lw / 2, cy, lw / px.w, midH / px.h, 0, c[0], c[1], c[2], a);
    r.draw(px, x + w - lw / 2, cy, lw / px.w, midH / px.h, 0, c[0], c[1], c[2], a);
  }
}

const CARD_FILL: [number, number, number] = [0.068, 0.073, 0.15];
const EDGE: [number, number, number] = [1, 1, 1];

/** A rounded card with a soft lit edge — the shop's base surface. */
function card(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  roundedPanel(ctx, x, y, w, h, 26, CARD_FILL, 0.95);
  roundedRing(ctx, x, y, w, h, 26, EDGE, 0.1);
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
