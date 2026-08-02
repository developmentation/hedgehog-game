/**
 * LEVELS — choosing where to roll, from inside the game.
 *
 * Levels used to be reachable only by `?level=` or a console call, which meant
 * changing one cost a page reload. This is the screen that replaces both: a
 * card per level, generated from `LEVELS`, showing the four things a player
 * actually decides on — what it is called, what ends it, what it looks like,
 * and how they have done on it before.
 *
 * THE THEME IS THE POINT OF THE CARD. A child picking "the snowy one" is not
 * reading `winter`, so each card carries a small diorama built from that
 * theme's own paintings — its sky, its far ridge, its mid ridge, one signature
 * silhouette — cropped with the theme's own measured windows (`themes.ts`), so
 * the preview is the level rather than a picture of it. If the generated art
 * has not loaded, the diorama degrades to three flat bands in the theme's own
 * tints, which still reads as meadow / snow / cave.
 *
 * Three rules, the same three the rest of the interface keeps:
 *
 *   ANCHORED TO THE LIVE VIEWPORT. Nothing is positioned by the 1280x720 design
 *   rect. The grid is laid out between `viewLeft/viewRight` and
 *   `safeTop/viewBottom` every frame, and the column count falls out of the
 *   shape of what is actually on screen: five across on a landscape monitor,
 *   two across on a phone, where the same viewport is 1872 world units tall.
 *
 *   TOUCH FIRST. A card is never smaller than 44 CSS px on its short side at
 *   390px width (144 world units), and neither is the BACK plate.
 *
 *   PARITY ACROSS INPUTS. A tap or click on a card plays it — on a menu of
 *   levels there is nothing else a press on a level could mean. Arrows walk the
 *   grid, Enter plays the highlighted card, Escape leaves. Hover lights a card
 *   but never selects it, which is the rule the workshop had to learn.
 *
 * Allocation-free once entered: rectangles are built in the constructor and
 * mutated in place, every string is precomputed in `enter`, and each theme's
 * cropped frames are built once and cached for the life of the page.
 */

import type { Ctx, Scene } from '../core/ctx';
import { clamp, smoothstep } from '../core/ctx';
import type { Frame } from '../engine/gl';
import { INK, rgb } from '../art/palette';
import { drawText, measureText, type TextStyle } from '../ui/text';
import { plate, plateRing, plateShadow } from '../ui/plate';
import { themeFor, type ThemeDef } from '../game/themes';
import {
  LEVELS,
  goalLabel,
  isLocked,
  lockHint,
  requestLevel,
  themeLabel,
  type LevelDef,
} from '../game/levels';
import { levelRecord } from '../engine/save';

// ------------------------------------------------------------------ palette

const C_PAPER = rgb(INK.paper);
const C_DIM = rgb(INK.paperShade);
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_GOLD_DEEP = rgb(INK.goldDeep);
const C_GOOD = rgb(INK.good);
const C_CARD: [number, number, number] = [0.068, 0.073, 0.15];
const C_PLATE: [number, number, number] = [0.1, 0.11, 0.21];
const C_WHITE: [number, number, number] = [1, 1, 1];

/** Reused for every string this file draws. */
const ST: TextStyle = { size: 20 };

// ------------------------------------------------------------------- layout

/** Outer margin, and the gap between cards. */
const MARGIN = 34;
const GAP = 18;

/** Header band: title, strapline, keyboard crib. */
const HEADER_H = 118;

/**
 * The BACK plate, and the band reserved for it.
 *
 * 132 units tall is the pause panel's row height, which is what puts it past
 * 44 CSS px at 390px width — the same number, for the same reason.
 */
const BACK_H = 132;
const BACK_W = 300;
const HIT_PAD = 8;

/**
 * Column count is decided by the SHAPE of the viewport, not its width in
 * pixels. A landscape monitor gets one row of five; a phone, whose live
 * viewport is 1280x1872 world units, gets two columns and three rows, because
 * five cards across a portrait screen would be five slivers.
 */
function columnsFor(w: number, h: number, n: number): number {
  if (w >= h * 1.05) return n;
  return w >= h * 0.45 ? 2 : 1;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -------------------------------------------------------------- card content

/**
 * Everything one card prints, resolved once on entry.
 *
 * Rebuilt every time the screen opens rather than watched, because the only
 * thing that changes these is finishing a run — which necessarily happens with
 * the screen closed.
 */
interface Card {
  def: LevelDef;
  title: string;
  goal: string;
  theme: string;
  locked: boolean;
  /** What opens it, e.g. `COMPLETE FIRST STEPS`. Empty when open. */
  lock: string;
  /** `CLEARED`, `IN PROGRESS` or `NEW`. */
  status: string;
  statusGood: boolean;
  /** Up to three record lines; empty strings are not drawn. */
  recA: string;
  recB: string;
  recC: string;
}

/** `0:42`, or `1:07`. Seconds only below a minute, so a short level reads fast. */
function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(1)}S`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

function buildCard(ctx: Ctx, def: LevelDef, out: Card): void {
  const p = ctx.save.profile;
  const rec = levelRecord(p, def.id);
  out.def = def;
  out.title = def.title;
  out.goal = goalLabel(def);
  out.theme = themeLabel(def.theme);
  out.locked = isLocked(p, def);
  out.lock = out.locked ? lockHint(def) : '';
  out.status = rec.cleared ? 'CLEARED' : rec.plays > 0 ? 'TRIED' : 'NEW';
  out.statusGood = rec.cleared;

  out.recA = rec.bestScore > 0 ? `BEST  ${rec.bestScore}` : 'BEST  --';
  if (def.goal.kind === 'endless') {
    out.recB = rec.plays > 0 ? `PLAYED  ${rec.plays}` : 'NEVER PLAYED';
    out.recC = '';
  } else {
    out.recB = rec.bestTime > 0 ? `FASTEST  ${fmtTime(rec.bestTime)}` : 'NOT CLEARED YET';
    out.recC = rec.fewestMisses >= 0 ? `FEWEST MISSES  ${rec.fewestMisses}` : '';
  }
}

// ----------------------------------------------------------------- dioramas

/**
 * The cropped frames one theme's preview is built from.
 *
 * A theme is measured once — the crops are exactly the windows `themes.ts`
 * publishes for the backdrop, so the preview samples the same pixels the level
 * itself will — and cached for the life of the page. `null` anywhere means the
 * generated art is not loaded, and the preview falls back to flat bands.
 */
interface Diorama {
  sky: Frame | null;
  far: Frame | null;
  mid: Frame | null;
  /** One signature silhouette, pivoted on its own base. */
  prop: Frame | null;
  skyTint: [number, number, number];
  farTint: [number, number, number];
  midTint: [number, number, number];
}

/** Signature silhouette per theme: the shape that names the place. */
const SIGNATURE: Record<string, string> = {
  meadow: 'tree_oak',
  winter: 'winter_tree_pine',
  cave: 'cave_stalagmite',
};

/** Flat-band fallback tints — sky, ridge, ground — when there is no art. */
const FLAT: Record<string, [number, number, number][]> = {
  meadow: [
    [0.36, 0.24, 0.42],
    [0.24, 0.19, 0.36],
    [0.2, 0.28, 0.2],
  ],
  winter: [
    [0.55, 0.63, 0.75],
    [0.4, 0.48, 0.62],
    [0.72, 0.76, 0.84],
  ],
  cave: [
    [0.12, 0.12, 0.2],
    [0.18, 0.16, 0.26],
    [0.24, 0.2, 0.26],
  ],
};

const DIORAMAS = new Map<string, Diorama>();

/** A sub-rectangle of a frame's uv window. Built once per theme, never per frame. */
function sub(f: Frame, u0: number, u1: number, v0: number, v1: number, py = 0.5): Frame {
  const du = f.u1 - f.u0;
  const dv = f.v1 - f.v0;
  return {
    tex: f.tex,
    u0: f.u0 + du * u0,
    v0: f.v0 + dv * v0,
    u1: f.u0 + du * u1,
    v1: f.v0 + dv * v1,
    w: f.w * (u1 - u0),
    h: f.h * (v1 - v0),
    px: 0.5,
    py,
  };
}

function dioramaFor(ctx: Ctx, id: string): Diorama {
  const hit = DIORAMAS.get(id);
  if (hit) return hit;
  const t: ThemeDef = themeFor(id);
  const skyRaw = ctx.assets.get(t.sky.id);
  const farRaw = ctx.assets.get(t.far.id);
  const midRaw = ctx.assets.get(t.mid.id);
  const propId = SIGNATURE[t.id] ?? '';
  const propRaw = propId ? ctx.assets.get(propId) : null;
  const spec = t.pieces.find((p) => p.id === propId);

  const d: Diorama = {
    sky: skyRaw ? sub(skyRaw, t.sky.u0, 1, t.sky.v0, 1) : null,
    far: farRaw ? sub(farRaw, t.far.u[0], t.far.u[1], t.far.band[0], t.far.band[1]) : null,
    mid: midRaw ? sub(midRaw, t.mid.u[0], t.mid.u[1], t.mid.band[0], t.mid.band[1]) : null,
    prop:
      propRaw && spec
        ? sub(propRaw, spec.u0 ?? 0, spec.u1 ?? 1, spec.v0 ?? 0, spec.bot, 1)
        : null,
    skyTint: t.sky.tint,
    farTint: t.far.tint,
    midTint: t.mid.tint,
  };
  DIORAMAS.set(id, d);
  return d;
}

// -------------------------------------------------------------- stack access

interface StackLike {
  push(s: Scene): void;
  pop(): void;
}

function gameStack(): StackLike | null {
  const g = (window as unknown as { __game?: { stack?: StackLike } }).__game;
  return g?.stack ?? null;
}

/** Push the level select over whatever is playing. No-op before boot completes. */
export function openLevelSelect(): boolean {
  const st = gameStack();
  if (!st) return false;
  st.push(new LevelSelectScene());
  return true;
}

// -------------------------------------------------------------------- scene

export class LevelSelectScene implements Scene {
  readonly name = 'levels';

  private cards: Card[] = [];
  private rects: Rect[] = [];
  private sel = 0;
  private cols = 1;
  private t = 0;
  private selectPop = 0;
  private denyShake = 0;
  /** The focus ring only appears once a key has actually been pressed. */
  private keyboard = false;
  /**
   * The card's type scale, and the three metrics derived from it.
   *
   * Shared across the row — five cards must not print at five sizes — and
   * resolved by FIT rather than by taste: the lower half of a card has a fixed
   * budget (`lowerH`), the blocks in it cost a known number of `u`, so `u` is
   * whatever divides one into the other. That is what lets the same code make
   * the type visibly larger on a phone, where two columns give each card 2.5x
   * the width, without any chance of a record line running off the bottom.
   */
  private u = 26;
  private pad = 14;
  private previewH = 100;
  /** Shared title size: `u`, then shrunk if the longest title needs it. */
  private titleSize = 26;
  /**
   * Furniture scale: how much bigger the fixed chrome has to be drawn for it
   * to read at the same physical size.
   *
   * The world is always 1280 units wide, whatever the screen — so one world
   * unit is 1 CSS px on a 1280 monitor and 0.30 CSS px on a 390px phone, and a
   * 16-unit caption that is legible on the first is 5 px on the second. The
   * CARDS take care of themselves (two columns instead of five makes them 2.5x
   * wider and their type is sized off their own width); the header and the
   * BACK plate have no such width to follow, so they follow this instead.
   */
  private k = 1;
  private back: Rect = { x: 0, y: 0, w: BACK_W, h: BACK_H };

  private keyQueue: string[] = [];
  private readonly onKey = (e: KeyboardEvent): void => {
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

  constructor() {
    for (let i = 0; i < LEVELS.length; i++) {
      this.rects.push({ x: 0, y: 0, w: 0, h: 0 });
      this.cards.push({
        def: LEVELS[i],
        title: '',
        goal: '',
        theme: '',
        locked: false,
        lock: '',
        status: '',
        statusGood: false,
        recA: '',
        recB: '',
        recC: '',
      });
    }
  }

  // ------------------------------------------------------------- lifecycle

  enter(ctx: Ctx): void {
    for (let i = 0; i < LEVELS.length; i++) buildCard(ctx, LEVELS[i], this.cards[i]);

    // Open on the level being played, so the screen answers "where am I?"
    // before it asks "where next?".
    const cur = (window as any).__levels?.current?.() as string | undefined;
    const at = cur ? LEVELS.findIndex((l) => l.id === cur) : -1;
    this.sel = at >= 0 ? at : 0;
    this.t = 0;
    this.keyboard = false;
    this.keyQueue.length = 0;
    window.addEventListener('keydown', this.onKey);
    ctx.audio.play('uiTap', 0.7);

    // The capture harness drives this screen with real taps, so it needs the
    // cards in world coordinates. Same contract as `__probeFn`.
    (window as any).__select = () => ({
      focus: this.sel,
      cols: this.cols,
      back: this.back,
      cards: this.cards.map((c, i) => ({
        id: c.def.id,
        title: c.title,
        goal: c.goal,
        theme: c.theme,
        locked: c.locked,
        status: c.status,
        x: this.rects[i].x + this.rects[i].w / 2,
        y: this.rects[i].y + this.rects[i].h / 2,
        w: this.rects[i].w,
        h: this.rects[i].h,
      })),
    });
  }

  exit(): void {
    window.removeEventListener('keydown', this.onKey);
    this.keyQueue.length = 0;
    (window as any).__select = null;
  }

  private close(): void {
    gameStack()?.pop();
  }

  // ------------------------------------------------------------------ layout

  /** Resolve the grid against the live viewport. Mutates; allocates nothing. */
  private layout(ctx: Ctx): void {
    const r = ctx.r;
    // CSS pixels per world unit — `scale` is device pixels per world unit.
    const css = r.scale / Math.max(r.dpr, 0.001);
    this.k = clamp(1 / css, 1, 1.6);

    const left = r.viewLeft + MARGIN;
    const right = r.viewRight - MARGIN;
    const top = r.safeTop + MARGIN;
    const bottom = r.viewBottom - MARGIN;

    const gridTop = top + HEADER_H * this.k;
    const gridBottom = bottom - (BACK_H * this.k + 22);
    const gridW = Math.max(120, right - left);
    const gridH = Math.max(120, gridBottom - gridTop);

    const n = LEVELS.length;
    const cols = columnsFor(gridW, gridH, n);
    this.cols = cols;
    const rows = Math.ceil(n / cols);

    const cw = (gridW - GAP * (cols - 1)) / cols;
    // A card is a poster, not a column: capped at 1.5x its own width so the
    // content fills it. Left to take the whole band it grew a hand's width of
    // dead space between the goal chip and the records.
    const ch = Math.min((gridH - GAP * (rows - 1)) / rows, cw * 1.45);
    // Centre the block vertically in whatever is left, so a two-column phone
    // layout does not hang off the top of the band.
    const y0 = gridTop + Math.max(0, (gridH - (ch * rows + GAP * (rows - 1))) * 0.5);

    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const rw = i - c;
      const row = rw / cols;
      // A short final row is centred rather than left-aligned: two cards
      // stranded under a row of three reads as a layout bug.
      const inRow = Math.min(cols, n - row * cols);
      const rowW = inRow * cw + (inRow - 1) * GAP;
      const rowX = left + (gridW - rowW) * 0.5;
      const rect = this.rects[i];
      rect.x = rowX + c * (cw + GAP);
      rect.y = y0 + row * (ch + GAP);
      rect.w = cw;
      rect.h = ch;
    }

    // Type scale, resolved by fit. `NEED` is the height of everything below
    // the diorama expressed in units of `u` — the gaps, the title's cap
    // height, the goal chip, and one record line plus the steps between the
    // rest. Whatever `u` makes that equal the space available is the one the
    // card can afford.
    this.pad = Math.max(14, cw * 0.06);
    const inner = cw - this.pad * 2;
    this.previewH = Math.min(inner * 0.86, ch * 0.4);
    const lowerH = ch - this.pad * 2 - this.previewH;
    let maxLines = 2;
    for (let i = 0; i < n; i++) if (!this.cards[i].locked && this.cards[i].recC) maxLines = 3;
    const need = maxLines === 3 ? 5.47 : 4.62;
    this.u = clamp(Math.min(cw * 0.135, lowerH / need), 11, 40);

    // One title size for the whole grid: the longest title decides it.
    let size = this.u;
    for (let i = 0; i < n; i++) {
      const w = measureText(this.cards[i].title, size, 0.02);
      if (w > inner) size = Math.max(11, (size * inner) / w);
    }
    this.titleSize = size;

    this.back.w = Math.min(BACK_W * this.k, gridW);
    this.back.h = BACK_H * this.k;
    this.back.x = right - this.back.w;
    this.back.y = bottom - this.back.h;
  }

  private hitRect(rc: Rect, x: number, y: number): boolean {
    return (
      x >= rc.x - HIT_PAD &&
      x <= rc.x + rc.w + HIT_PAD &&
      y >= rc.y - HIT_PAD &&
      y <= rc.y + rc.h + HIT_PAD
    );
  }

  // ------------------------------------------------------------------ update

  update(ctx: Ctx, dt: number): void {
    this.t = Math.min(1, this.t + dt * 5);
    this.selectPop = Math.max(0, this.selectPop - dt * 3.2);
    this.denyShake = Math.max(0, this.denyShake - dt * 4.5);
    this.layout(ctx);

    if (ctx.input.pausePressed) {
      this.close();
      return;
    }

    for (let i = 0; i < this.keyQueue.length; i++) {
      const k = this.keyQueue[i];
      this.keyboard = true;
      if (k === 'ArrowLeft') this.move(ctx, -1);
      else if (k === 'ArrowRight') this.move(ctx, 1);
      else if (k === 'ArrowUp') this.move(ctx, -this.cols);
      else if (k === 'ArrowDown') this.move(ctx, this.cols);
      else if (k === 'Backspace') {
        this.keyQueue.length = 0;
        this.close();
        return;
      } else {
        this.keyQueue.length = 0;
        this.play(ctx, this.sel);
        return;
      }
    }
    this.keyQueue.length = 0;

    // WASD from the shared map, exactly as the workshop takes it.
    for (let i = 0; i < ctx.input.keysPressed.length; i++) {
      const k = ctx.input.keysPressed[i];
      if (k === 'A') this.move(ctx, -1);
      else if (k === 'D') this.move(ctx, 1);
      else if (k === 'W') this.move(ctx, -this.cols);
      else if (k === 'S') this.move(ctx, this.cols);
    }

    for (let i = 0; i < ctx.input.taps.length; i++) {
      const tap = ctx.input.taps[i];
      if (this.hitRect(this.back, tap.x, tap.y)) {
        ctx.audio.play('uiTap', 0.8);
        this.close();
        return;
      }
      for (let j = 0; j < this.rects.length; j++) {
        if (!this.hitRect(this.rects[j], tap.x, tap.y)) continue;
        this.keyboard = false;
        this.sel = j;
        this.selectPop = 1;
        // A press on a level card means "play this level". There is nothing
        // else it could mean on a menu of levels, so there is no second step.
        this.play(ctx, j);
        return;
      }
    }
  }

  private move(ctx: Ctx, d: number): void {
    const n = this.rects.length;
    const next = clamp(this.sel + d, 0, n - 1);
    if (next === this.sel) return;
    this.sel = next;
    this.selectPop = 1;
    ctx.audio.play('uiTap', 0.5);
  }

  /** Ask for a level. Locked cards refuse loudly rather than silently. */
  private play(ctx: Ctx, i: number): void {
    const card = this.cards[i];
    if (card.locked) {
      ctx.audio.play('bounce', 0.7);
      this.denyShake = 1;
      this.sel = i;
      return;
    }
    ctx.audio.play('letterLock', 0.95);
    requestLevel(card.def);
    this.close();
  }

  // -------------------------------------------------------------------- draw

  draw(): void {
    /* Screen-space only; the frozen game shows through the scrim. */
  }

  drawUi(ctx: Ctx): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const a = smoothstep(this.t);

    const vw = r.viewRight - r.viewLeft;
    const vh = r.viewBottom - r.viewTop;
    r.draw(
      px,
      (r.viewLeft + r.viewRight) * 0.5,
      (r.viewTop + r.viewBottom) * 0.5,
      vw / px.w,
      vh / px.h,
      0,
      0.03,
      0.035,
      0.075,
      0.97 * a,
    );

    this.drawHeader(ctx, a);
    for (let i = 0; i < this.rects.length; i++) this.drawCard(ctx, i, a);
    this.drawFooter(ctx, a);
  }

  private drawHeader(ctx: Ctx, a: number): void {
    const r = ctx.r;
    const k = this.k;
    const left = r.viewLeft + MARGIN;
    const right = r.viewRight - MARGIN;
    const top = r.safeTop + MARGIN;

    text(ctx, 'LEVELS', left, top + 30 * k, 44 * k, C_GOLD, 'left', a, 0.14, 4);
    text(ctx, 'CHOOSE WHERE TO ROLL', left + 4, top + 68 * k, 18 * k, C_DIM, 'left', a * 0.72, 0.2, 0);
    text(ctx, 'ARROWS  MOVE', right, top + 22 * k, 16 * k, C_DIM, 'right', a * 0.5, 0.2, 0);
    text(ctx, 'ENTER  PLAY', right, top + 46 * k, 16 * k, C_DIM, 'right', a * 0.5, 0.2, 0);
    text(ctx, 'ESC  BACK', right, top + 70 * k, 16 * k, C_DIM, 'right', a * 0.5, 0.2, 0);

    const px = ctx.atlas.get('ui/pixel');
    ctx.r.draw(
      px,
      (left + right) * 0.5,
      top + (HEADER_H - 26) * k,
      (right - left) / px.w,
      3 / px.h,
      0,
      C_GOLD[0],
      C_GOLD[1],
      C_GOLD[2],
      0.34 * a,
    );
  }

  // -------------------------------------------------------------------- card

  private drawCard(ctx: Ctx, i: number, a: number): void {
    const rect = this.rects[i];
    const card = this.cards[i];
    const sel = i === this.sel;
    const hovered =
      !sel && ctx.input.hasHover && this.hitRect(rect, ctx.input.hoverX, ctx.input.hoverY);

    const shake = sel && this.denyShake > 0 ? Math.sin(this.denyShake * 48) * this.denyShake * 7 : 0;
    const lift = sel ? -3 - this.selectPop * 4 : 0;
    const x = rect.x + shake;
    const y = rect.y + lift + (1 - a) * 22;
    const w = rect.w;
    const h = rect.h;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = Math.min(26, w * 0.1);

    plateShadow(ctx, cx, cy, w, h, rad, 12, C_DARK, 0.45 * a);
    plate(ctx, cx, cy, w, h, rad, C_CARD, 0.97 * a);
    if (sel) {
      plate(ctx, cx, cy, w, h, rad, C_GOLD, 0.07 * a);
      plateRing(ctx, cx, cy, w, h, rad, C_GOLD, 0.95 * a);
      if (this.keyboard) {
        plateRing(ctx, cx, cy, w + 14, h + 14, rad + 7, C_PAPER, 0.7 * a);
      }
    } else {
      plateRing(ctx, cx, cy, w, h, rad, C_PAPER, (hovered ? 0.34 : 0.12) * a);
    }

    const u = this.u;
    const pad = this.pad;
    const inner = w - pad * 2;
    const previewH = this.previewH;
    const previewY = y + pad;
    // Locked cards keep their art but lose their light: the player must still
    // be able to see which place they are working towards.
    const art = card.locked ? a * 0.34 : a;
    this.drawPreview(ctx, card, x + pad, previewY, inner, previewH, art);

    // Theme tag, sitting on the diorama so the name and the picture are one
    // object rather than two facts about the same card. It owns the whole
    // bottom band: the status used to share it and the two collided on a
    // 200-unit card.
    const tagH = Math.max(22, previewH * 0.2);
    const tagY = previewY + previewH - tagH;
    fill(ctx.r, ctx.atlas.get('ui/pixel'), x + pad, tagY, inner, tagH, C_DARK, 0.66 * a);
    const themeSize = Math.min(u * 0.62, tagH * 0.6);
    text(
      ctx,
      card.theme,
      x + pad + inner / 2,
      tagY + tagH / 2,
      fitSize(card.theme, inner - 16, themeSize, 0.18),
      C_PAPER,
      'center',
      a * 0.92,
      0.18,
      0,
    );

    // Status badge, pinned to the corner of the art — the one thing on the card
    // that is about the player rather than about the level.
    const badgeSize = u * 0.55;
    const badgeW = measureText(card.status, badgeSize, 0.16) + 18;
    const badgeH = badgeSize * 1.9;
    plate(
      ctx,
      x + pad + inner - badgeW / 2 - 6,
      previewY + 6 + badgeH / 2,
      badgeW,
      badgeH,
      badgeH / 2,
      card.statusGood ? C_GOOD : C_DARK,
      a * (card.statusGood ? 0.92 : 0.78),
    );
    text(
      ctx,
      card.status,
      x + pad + inner - badgeW / 2 - 6,
      previewY + 6 + badgeH / 2,
      badgeSize,
      card.statusGood ? C_DARK : C_PAPER,
      'center',
      a * 0.95,
      0.16,
      0,
    );

    let ty = previewY + previewH + u * 0.667;
    text(ctx, card.title, x + pad, ty, this.titleSize, C_PAPER, 'left', a, 0.02, 3);

    // Goal chip — the one thing that says how this level ends.
    ty += this.titleSize * 0.7 + u * 0.667;
    const chipH = u * 0.867;
    const chipW = Math.min(inner, measureText(card.goal, chipH * 0.56, 0.14) + chipH);
    plate(ctx, x + pad + chipW / 2, ty, chipW, chipH, chipH / 2, C_GOLD_DEEP, a * 0.85);
    text(ctx, card.goal, x + pad + chipW / 2, ty, chipH * 0.56, C_DARK, 'center', a, 0.14, 0);

    // Records, or what opens the level.
    //
    // Laid out DOWNWARDS from under the goal chip rather than upwards from the
    // card's floor: pinned to the floor, a third record line climbed straight
    // through the chip on a card whose height was capped. Starting at a fixed
    // offset also aligns the block across every card in the row.
    const recSize = u * 0.6;
    const lines = card.locked || !card.recC ? 2 : 3;
    const top = ty + chipH / 2 + u * 0.467 + recSize * 0.7;
    const room = y + h - pad - top;
    const step = clamp(room / (lines - 1), recSize * 1.3, recSize * 1.75);

    if (card.locked) {
      this.drawLock(ctx, x + pad, top + recSize * 0.5, recSize, card.lock, inner, a);
    } else {
      text(ctx, card.recA, x + pad, top, recSize + 2, C_PAPER, 'left', a * 0.95, 0.08, 0);
      text(ctx, card.recB, x + pad, top + step, recSize, C_DIM, 'left', a * 0.75, 0.1, 0);
      if (card.recC) {
        text(ctx, card.recC, x + pad, top + step * 2, recSize, C_DIM, 'left', a * 0.65, 0.1, 0);
      }
    }
  }

  /**
   * The padlock: `fx/ring` for the shackle, with a plate over its lower half
   * for the body. Two sprites, no new art, and unmistakably a lock.
   */
  private drawLock(
    ctx: Ctx,
    x: number,
    y: number,
    size: number,
    hint: string,
    room: number,
    a: number,
  ): void {
    const r = ctx.r;
    const d = size * 1.5;
    const ring = ctx.atlas.get('fx/ring');
    r.draw(ring, x + d / 2, y - d * 0.18, (d * 0.62) / ring.w, (d * 0.62) / ring.h, 0, C_GOLD[0], C_GOLD[1], C_GOLD[2], a * 0.85);
    plate(ctx, x + d / 2, y + d * 0.16, d * 0.8, d * 0.62, d * 0.16, C_GOLD, a * 0.9);
    plate(ctx, x + d / 2, y + d * 0.18, d * 0.12, d * 0.24, d * 0.06, C_DARK, a * 0.9);

    const tx = x + d + 8;
    const s = fitSize(hint, room - (d + 8), size, 0.08);
    text(ctx, 'LOCKED', tx, y - s * 0.75, s, C_GOLD, 'left', a * 0.9, 0.18, 0);
    text(ctx, hint, tx, y + s * 0.75, s, C_DIM, 'left', a * 0.8, 0.08, 0);
  }

  // ----------------------------------------------------------------- preview

  /**
   * One theme's diorama, drawn into `w x h` at `(x, y)`.
   *
   * Everything is sized to land inside the box — the renderer has no scissor,
   * so nothing may be allowed to overhang. Order is the backdrop's own: sky,
   * far ridge, mid ridge, silhouette.
   */
  private drawPreview(
    ctx: Ctx,
    card: Card,
    x: number,
    y: number,
    w: number,
    h: number,
    a: number,
  ): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const d = dioramaFor(ctx, card.def.theme ?? 'meadow');
    const flat = FLAT[themeFor(card.def.theme).id] ?? FLAT.meadow;
    const cx = x + w / 2;

    if (d.sky) {
      r.draw(d.sky, cx, y + h / 2, w / d.sky.w, h / d.sky.h, 0, d.skyTint[0], d.skyTint[1], d.skyTint[2], a);
    } else {
      fill(r, px, x, y, w, h, flat[0], a);
      fill(r, px, x, y + h * 0.55, w, h * 0.2, flat[1], a);
      fill(r, px, x, y + h * 0.75, w, h * 0.25, flat[2], a);
    }

    if (d.far) {
      const fh = h * 0.34;
      r.draw(d.far, cx, y + h * 0.66 - fh / 2, w / d.far.w, fh / d.far.h, 0, d.farTint[0], d.farTint[1], d.farTint[2], a);
    }
    if (d.mid) {
      const mh = h * 0.3;
      r.draw(d.mid, cx, y + h - mh / 2, w / d.mid.w, mh / d.mid.h, 0, d.midTint[0], d.midTint[1], d.midTint[2], a);
    }
    if (d.prop) {
      const ph = h * 0.72;
      const pw = (d.prop.w / d.prop.h) * ph;
      r.draw(d.prop, x + w * 0.74, y + h * 0.99, pw / d.prop.w, ph / d.prop.h, 0, 1, 1, 1, a);
    }

    // A hairline frame, so the art reads as a window rather than a bleed.
    outline(r, px, x, y, w, h, 2, C_WHITE, a * 0.16);
  }

  // ------------------------------------------------------------------ footer

  private drawFooter(ctx: Ctx, a: number): void {
    const r = ctx.r;
    const k = this.k;
    const b = this.back;
    const hovered = ctx.input.hasHover && this.hitRect(b, ctx.input.hoverX, ctx.input.hoverY);
    const rad = Math.min(30 * k, b.h / 2);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;

    plate(ctx, cx, cy, b.w, b.h, rad, C_PLATE, a * (hovered ? 0.98 : 0.8));
    plateRing(ctx, cx, cy, b.w, b.h, rad, C_PAPER, a * (hovered ? 0.55 : 0.3));

    const caret = ctx.atlas.get('ui/caret');
    const cw = 34 * k;
    r.draw(caret, b.x + 44 * k, cy, cw / caret.w, (cw * 0.72) / caret.h, Math.PI / 2, C_PAPER[0], C_PAPER[1], C_PAPER[2], a * 0.85);
    text(ctx, 'BACK TO PLAY', b.x + 74 * k, cy - 8 * k, 24 * k, C_PAPER, 'left', a * 0.95, 0.1, 0);
    text(ctx, 'ESC', b.x + 74 * k, cy + 20 * k, 14 * k, C_DIM, 'left', a * 0.6, 0.2, 0);

    text(
      ctx,
      'TAP A LEVEL TO PLAY IT',
      r.viewLeft + MARGIN,
      cy,
      17 * k,
      C_DIM,
      'left',
      a * 0.55,
      0.16,
      0,
    );
  }
}

// ------------------------------------------------------------------- drawing

/** Largest size at or below `base` that fits `str` into `room`. No allocation. */
function fitSize(str: string, room: number, base: number, tracking = 0): number {
  const w = measureText(str, base, tracking);
  return w <= room ? base : Math.max(9, (base * room) / w);
}

function fill(
  r: Ctx['r'],
  px: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  c: [number, number, number],
  a: number,
): void {
  r.draw(px, x + w / 2, y + h / 2, w / px.w, h / px.h, 0, c[0], c[1], c[2], a);
}

function outline(
  r: Ctx['r'],
  px: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  c: [number, number, number],
  a: number,
): void {
  fill(r, px, x, y, w, t, c, a);
  fill(r, px, x, y + h - t, w, t, c, a);
  fill(r, px, x, y + t, t, h - t * 2, c, a);
  fill(r, px, x + w - t, y + t, t, h - t * 2, c, a);
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
