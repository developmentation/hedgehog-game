/**
 * The heads-up display.
 *
 * Everything drawn in screen space lives here: the word dock, the status strip,
 * the clue card, the message banner, the score floaters and the full-screen
 * flash and vignette.
 *
 * It reads a snapshot of the round through `HudState` and writes nothing back,
 * so the play scene stays the only place that decides anything. The two pieces
 * of state the HUD owns are the speaker button's hit rect (because the layout
 * that decides where the button lands is here) and a few per-word caches —
 * the wrapped clue and the score/combo strings — so that drawing a frame
 * allocates nothing at all.
 *
 * Composition rules, applied everywhere rather than per call site:
 *
 *   - ONE ANCHOR PER EDGE. Nothing in the HUD is positioned by the 1280x720
 *     design rect. The stage never letterboxes, so the world rect actually on
 *     screen changes shape with the window: the top row anchors to
 *     `r.safeTop`, the left column to `r.viewLeft`, the right column to
 *     `r.viewRight` and the word dock to `r.viewBottom`. `layout()` resolves
 *     all of it once per frame into a single reused object.
 *
 *   - ONE MESSAGE CHANNEL. Exactly one banner can be on screen at a time. The
 *     scene raises notices into `HudState.notice` with a severity; the HUD
 *     draws whatever is there, last in the opaque pass, and suppresses the clue
 *     card while it is up. Two messages can never overlap because there is only
 *     ever one.
 *
 *   - TWO MATERIAL LANGUAGES, KEPT APART. The world is painted stone / ice /
 *     gold; the HUD is dusk-navy glass, gold accents and cream type. A letter
 *     in the dock is deliberately NOT the block you smashed — it is the minted
 *     copy, in HUD material, which is why it wears the same cream face and gold
 *     edge as every other HUD surface.
 *
 *   - SOLID PLATES, LOW VALUE. At tier 5 a letter column reaches y≈25, so the
 *     top-right status group *will* be crossed by a block whatever it does.
 *     The group is therefore opaque, dark and small, with a lit rim and a cast
 *     shadow: a block passing behind a solid plate reads as layering, where a
 *     block ghosting through a half-transparent one reads as a z-order bug.
 *
 *   - text over the painted world always gets either a panel or a soft dark
 *     scrim behind it, never bare glyphs;
 *   - every rounded shape goes through `ui/plate`, which owns the corner radius
 *     language, the device-pixel grid the HUD lands on, and the rule that a
 *     cast shadow is only drawn where it is not covered by the plate above it;
 *   - all additive work happens in one pass, so the HUD costs two blend
 *     switches and no extra texture binds.
 */

import type { Ctx, PlayProbe } from '../core/ctx';
import { clamp, easeOutBack, easeOutCubic, smoothstep } from '../core/ctx';
import { drawText, measureText, wrapText, lineHeight, shadowFor, TABULAR } from './text';
import { plate, plateRing, plateShadow, mergeShadow, snapX, snapY } from './plate';
import { INK, rgb } from '../art/palette';
import { Blend } from '../engine/gl';
import { TUNING } from '../game/tuning';

/** A rising score popup. Owned by the scene; the HUD only draws it. */
export interface HudFloater {
  text: string;
  /** Small caption under `text` — the combo count rides here rather than as a
   *  second floater fighting the first for the same pixels. `''` for none. */
  sub: string;
  x: number;
  y: number;
  /** Age in seconds. */
  t: number;
  life: number;
  c: [number, number, number];
  size: number;
}

/** Notice severity. Higher wins; the scene never shows two at once. */
export const NOTICE_NONE = 0;
export const NOTICE_INFO = 1;
export const NOTICE_GOOD = 2;
export const NOTICE_BAD = 3;

/**
 * The single message channel. The scene owns one of these and mutates it, so
 * raising a message allocates nothing.
 */
export interface HudNotice {
  /** Headline, drawn in caps. */
  text: string;
  /** Optional second line. `''` for none. */
  sub: string;
  /** `NOTICE_*`. `NOTICE_NONE` means the channel is silent. */
  kind: number;
  /** Seconds since it was raised. */
  t: number;
  life: number;
}

/** The read-only view of the round the HUD needs. Nothing here is mutated. */
export interface HudState {
  phase: PlayProbe['phase'];
  /** Seconds spent in the current phase. */
  phaseT: number;
  word: string;
  clueLines: string[];
  revealed: boolean[];
  nextIndex: number;
  /** Score eased towards the real total, so the counter rolls rather than jumps. */
  scoreShown: number;
  combo: number;
  comboFlash: number;
  lives: number;
  /** Per-slot pop, 1 the moment a letter lands or is taken back. */
  slotPop: number[];
  floaters: HudFloater[];
  /** The one banner. Never null — `kind === NOTICE_NONE` is the silent state. */
  notice: HudNotice;
  /**
   * Seconds left on a player-requested clue recall, counting down. 0 = not
   * asked for. Set by the speaker button, which hears the word *and* brings
   * the clue back.
   */
  hintT: number;
  flash: number;
  flashColor: [number, number, number];
  speakerPulse: number;
}

// ---------------------------------------------------------------- type scale

/**
 * One modular scale (ratio ~1.26) for the whole interface: 19 / 24 / 30 / 38 /
 * 48 / 60. Nothing in the HUD picks a size that is not on this list.
 *
 * 19 is the floor on purpose. At 390x844 the stage fits by width to ~0.305 CSS
 * px per world unit, so 19 world units is the smallest step that still lands
 * near 6 CSS px on a phone; anything below it stops being readable there.
 */
const TYPE = {
  caption: 19,
  label: 24,
  body: 30,
  score: 38,
  head: 48,
  display: 60,
};

/** Caps are always tracked; body copy never is. */
const CAPS = 0.18;

// -------------------------------------------------------------------- colour

const C_PAPER = rgb(INK.paper);
const C_PAPER_DIM = rgb(INK.paperShade);
const C_DARK = rgb(INK.dark);
const C_GOLD = rgb(INK.gold);
const C_GOLD_DEEP = rgb(INK.goldDeep);
const C_DANGER = rgb(INK.danger);
const C_GOOD = rgb(INK.good);
const C_WHITE: [number, number, number] = [1, 1, 1];
/** Panel body: a hair bluer and deeper than the ink so panels sit *in* the dusk. */
const C_PANEL: [number, number, number] = [0.055, 0.062, 0.135];
const C_PANEL_LIT: [number, number, number] = [0.13, 0.15, 0.29];
const C_WELL: [number, number, number] = [0.04, 0.045, 0.105];
const C_DEAD: [number, number, number] = [0.26, 0.27, 0.36];
const SCRATCH: [number, number, number] = [1, 1, 1];
/** Where `mergeShadow` writes a plate's premixed body colour. Reused, never grown. */
const MERGED: [number, number, number] = [0, 0, 0];
/** Second scratch triple, for a colour that has to outlive `mix`'s SCRATCH. */
const ACCENT: [number, number, number] = [1, 1, 1];

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  SCRATCH[0] = a[0] + (b[0] - a[0]) * t;
  SCRATCH[1] = a[1] + (b[1] - a[1]) * t;
  SCRATCH[2] = a[2] + (b[2] - a[2]) * t;
  return SCRATCH;
}

// -------------------------------------------------------------------- layout

/** Inset from whichever screen edge an element is pinned to. */
const EDGE_X = 28;
/** Gap between `safeTop` and the top of the tallest element in the top row. */
const EDGE_Y = 14;

/** Shared with the play scene so the shop chip lands on the strip's baseline. */
export const HUD_EDGE_X = EDGE_X;

/**
 * Status strip. At tier 5 the top block of a column spans y≈25..129, which no
 * top-anchored HUD can dodge, so the strip is a solid plate with a lit rim and
 * a cast shadow — see the header note on plates.
 */
const STRIP_H = 84;
const STRIP_RAD = 42;
const STRIP_BODY_A = 0.99;
const STRIP_RING_A = 0.3;
const STRIP_SHADOW_A = 0.42;

/** The speaker sits proud of the strip's right end: a raised, pressable disc. */
const SPK_D = 132;
/**
 * Touch target. At 390x844 the stage fits by width to ~0.305 CSS px per world
 * unit, so a 44 CSS px target needs ~144 world units — this is 156, and the
 * 132-unit disc drawn inside it keeps the visual and the hit box honest.
 */
const SPK_HIT = 156;

/**
 * Vertical centre of the top HUD row, given `r.safeTop`. Exported because the
 * shop chip lives in the play scene but must share this baseline — the critic
 * caught it sitting on its own, and one row is one row.
 */
export const hudTopRowCY = (safeTop: number): number => safeTop + EDGE_Y + SPK_D / 2;

const HEART_SIZE = 30;
const HEART_STEP = 40;
/** Five tabular digits are reserved so the strip never reflows as the score grows. */
const SCORE_W = 5 * TABULAR * TYPE.score;

/** Combo badge, docked under the strip and right-aligned to it. */
const COMBO_H = 54;
/** Enough that the badge clears the speaker disc, which sits proud of the strip. */
const COMBO_GAP = 34;

/** Word dock. Floating plaque, not a full-width plank — see `drawWordBar`. */
/**
 * Gap from the bottom edge to the slot centres. Sized so the plaque keeps a
 * strip of the painted bank visible under it and still leaves clearance above
 * for the hop control, which parks itself just above the `WORD_BAR_H` band.
 */
const DOCK_LIFT = 78;
const SLOT_MAX_W = 78;
const SLOT_ASPECT = 1.14;
const SLOT_GAP_F = 0.16;
const SLOT_SIDE_PAD = 64;
const PLAQUE_PAD_X = 17;
const PLAQUE_PAD_Y = 13;
const PLAQUE_RAD = 30;

/** Clue card and banner share one optical centre: the message region. */
const MSG_ABOVE_BOTTOM = 420;
const CLUE_TEXT_W = 860;
const CLUE_RAD = 30;
const CLUE_PAD_X = 52;
const CLUE_HEAD_H = 58;
const CLUE_FOOT_H = 70;
const HEAD_LISTEN = 'LISTEN';
const HEAD_READ = 'READ THE CLUE';
const HEAD_INTRO = 'TAP TO START';
const LETTERS_SUFFIX = ' LETTERS';

/**
 * Recalled-clue band. The card the player gets *back* mid-word is not the card
 * they got at the start: it is one slim, translucent, non-blocking strip, set
 * at the label size and wrapped wide so it is usually a single line. It has to
 * share the frame with live letter blocks, so it gives up the header band, the
 * pips and the drop shadow, and keeps only the sentence.
 */
const HINT_TEXT_W = 940;
const HINT_PAD_X = 34;
const HINT_PAD_Y = 17;
const HINT_ICON = 24;
const HINT_RAD = 26;
/** Sits below the combo badge and above the tallest sensible block row. */
const HINT_ABOVE_BOTTOM = 462;
const HINT_LABEL = 'HINT';

/** Every screen-relative number the frame needs, resolved once per draw. */
interface Layout {
  left: number;
  right: number;
  bottom: number;
  top: number;
  cx: number;
  rowCY: number;
  stripL: number;
  stripR: number;
  stripCX: number;
  stripW: number;
  spkCX: number;
  spkCY: number;
  sparkX: number;
  scoreX: number;
  dividerX: number;
  heartLeft: number;
  comboCY: number;
  msgCY: number;
  hintCY: number;
  slotCY: number;
}

export class Hud {
  /**
   * Hit box for the speaker button, in world units. Refreshed by `layout()`
   * every frame so it tracks the visual at any aspect ratio.
   */
  readonly speakerRect = { x: 1252 - SPK_D / 2, y: 80, w: SPK_HIT, h: SPK_HIT };

  /**
   * Whatever message surface is currently on screen — clue card, recall band or
   * banner — as one rect, refreshed every frame.
   *
   * None of them block play: a letter block behind one is still tapped through.
   * But the scene reads a tap on empty ground as a hop, and a tap on a sentence
   * is not a hop, so it needs to know where the sentence is.
   */
  readonly cardRect = { cx: 0, cy: 0, w: 0, h: 0, on: false };

  /** Reused every frame; never reallocated. */
  private L: Layout = {
    left: 0, right: 1280, bottom: 720, top: 0, cx: 640, rowCY: 80,
    stripL: 0, stripR: 0, stripCX: 0, stripW: 0, spkCX: 0, spkCY: 0,
    sparkX: 0, scoreX: 0, dividerX: 0, heartLeft: 0,
    comboCY: 0, msgCY: 300, hintCY: 258, slotCY: 644,
  };

  // --- per-word caches, rebuilt only when the word changes ---
  private lastWord = ' ';
  private clueLines: string[] = [];
  private clueW = 0;
  /** The same clue re-wrapped for the slim recall band. */
  private hintLines: string[] = [];
  private hintW = 0;
  private lettersLabel = '';
  /** `glyph/<letter>` per slot, so the dock never builds a key while drawing. */
  private glyphKeys: string[] = [];
  /** ctx.time at which the current word appeared, and at which its clue started. */
  private wordT0 = 0;
  private clueT0 = 0;

  // --- string caches, so the counters never allocate while drawing ---
  private scoreVal = -1;
  private scoreStr = '0';
  private comboVal = -1;
  private comboStr = '';

  hitSpeaker(x: number, y: number): boolean {
    const s = this.speakerRect;
    return (
      x >= s.x - s.w / 2 && x <= s.x + s.w / 2 && y >= s.y - s.h / 2 && y <= s.y + s.h / 2
    );
  }

  /** True when `x,y` is over the message surface currently on screen. */
  hitCard(x: number, y: number): boolean {
    const c = this.cardRect;
    return (
      c.on &&
      x >= c.cx - c.w / 2 &&
      x <= c.cx + c.w / 2 &&
      y >= c.cy - c.h / 2 &&
      y <= c.cy + c.h / 2
    );
  }

  /** Record the live message surface for `hitCard`. */
  private markCard(cx: number, cy: number, w: number, h: number): void {
    const c = this.cardRect;
    c.cx = cx;
    c.cy = cy;
    c.w = w;
    c.h = h;
    c.on = true;
  }

  /**
   * Resolve every anchor for this frame.
   *
   * `safeTop` rather than `viewTop`: on a 9:19.5 phone the visible world runs
   * from y≈-2050, and status pinned up there would sit alone in empty sky, a
   * whole screen away from the playfield. `safeTop` is clamped to 0.42 view
   * heights above the design top, which keeps the top row attached to the game.
   */
  layout(ctx: Ctx): Layout {
    const r = ctx.r;
    const L = this.L;
    L.left = r.viewLeft;
    L.right = r.viewRight;
    L.bottom = r.viewBottom;
    L.top = r.safeTop;
    L.cx = (r.viewLeft + r.viewRight) * 0.5;

    L.rowCY = L.top + EDGE_Y + SPK_D / 2;
    L.stripR = L.right - EDGE_X;
    L.spkCX = L.stripR - SPK_D / 2;
    L.spkCY = L.rowCY;
    const heartRight = L.spkCX - SPK_D / 2 - 22;
    L.heartLeft = heartRight - TUNING.scoring.maxMisses * HEART_STEP;
    L.dividerX = L.heartLeft - 24;
    L.scoreX = L.dividerX - 24 - SCORE_W;
    L.sparkX = L.scoreX - 31;
    L.stripL = L.sparkX - 43;
    L.stripCX = (L.stripL + L.stripR) * 0.5;
    L.stripW = L.stripR - L.stripL;

    L.comboCY = L.rowCY + STRIP_H / 2 + COMBO_GAP + COMBO_H / 2;

    // The message region and the dock belong to the playfield's frame, which is
    // pinned to the bottom edge at every aspect ratio.
    L.msgCY = L.bottom - MSG_ABOVE_BOTTOM;
    // Kept below the combo badge at any safeTop, so the two never meet.
    L.hintCY = Math.max(L.bottom - HINT_ABOVE_BOTTOM, L.comboCY + COMBO_H / 2 + 66);
    L.slotCY = L.bottom - DOCK_LIFT;

    this.speakerRect.x = L.spkCX;
    this.speakerRect.y = L.spkCY;
    return L;
  }

  draw(ctx: Ctx, s: HudState): void {
    const r = ctx.r;
    const L = this.layout(ctx);
    this.sync(ctx, s);
    this.cardRect.on = false;

    // --- opaque pass, back to front ---------------------------------------
    this.drawWordBar(ctx, s, L);
    this.drawStrip(ctx, s, L);
    this.drawCombo(ctx, s, L);
    this.drawSpeaker(ctx, s, L);

    // The clue and the banner share one optical centre, so the clue stands
    // down whenever the message channel has something to say.
    const clueA = this.clueAlpha(ctx, s);
    if (clueA > 0.004) {
      this.drawClue(ctx, s, L, clueA);
    } else {
      // The full card and the slim recall band are the same information, so
      // they are never both on screen.
      const hintA = this.hintAlpha(s);
      if (hintA > 0.004) this.drawHintBand(ctx, s, L, hintA);
    }
    this.drawNotice(ctx, s, L);

    // --- one additive pass for every glow in the interface ------------------
    r.setBlend(Blend.Additive);
    this.drawWordBarGlow(ctx, s, L);
    this.drawSpeakerGlow(ctx, s, L);
    this.drawComboGlow(ctx, s, L);
    if (s.flash > 0.01) {
      const px = ctx.atlas.get('ui/pixel');
      const c = s.flashColor;
      r.draw(px, L.cx, (r.viewTop + L.bottom) * 0.5, (L.right - L.left) / px.w, (L.bottom - r.viewTop) / px.h, 0, c[0], c[1], c[2], s.flash * 0.26);
    }
    r.setBlend(Blend.Normal);

    // --- foreground text ---------------------------------------------------
    this.drawFloaters(ctx, s, L);
  }

  /** Refresh the per-word and per-value caches. Allocates only when they change. */
  private sync(ctx: Ctx, s: HudState): void {
    if (s.word !== this.lastWord) {
      this.lastWord = s.word;
      this.wordT0 = ctx.time;
      this.clueT0 = ctx.time;
      // Re-wrap at the size the card actually renders, rather than trusting a
      // width measured somewhere else.
      this.clueLines = wrapText(s.clueLines.join(' '), TYPE.body, CLUE_TEXT_W);
      let w = 0;
      for (const line of this.clueLines) w = Math.max(w, measureText(line, TYPE.body));
      this.clueW = w;
      // Second wrap, at the label size and a wider measure: the recall band
      // wants one line where the opening card wants a paragraph.
      this.hintLines = wrapText(s.clueLines.join(' '), TYPE.label, HINT_TEXT_W);
      let hw = 0;
      for (const line of this.hintLines) hw = Math.max(hw, measureText(line, TYPE.label));
      this.hintW = hw;
      this.lettersLabel = s.word.length + LETTERS_SUFFIX;
      this.glyphKeys.length = 0;
      for (let i = 0; i < s.word.length; i++) this.glyphKeys.push(`glyph/${s.word[i]}`);
    }
    // The clue's own clock, so it lives for as long as `clueFadeAt` says rather
    // than vanishing the instant the phase flips to `playing`.
    if (s.phase === 'intro') this.clueT0 = ctx.time;

    const sv = Math.round(s.scoreShown);
    if (sv !== this.scoreVal) {
      this.scoreVal = sv;
      this.scoreStr = String(sv);
    }
    if (s.combo !== this.comboVal) {
      this.comboVal = s.combo;
      this.comboStr = `${s.combo}x`;
    }
  }

  // ---------------------------------------------------------------- panels

  /**
   * Soft dark halo. The one legibility treatment used for every piece of text
   * that floats over the painted world without a panel under it.
   */
  private scrim(ctx: Ctx, cx: number, cy: number, w: number, h: number, a: number): void {
    const g = ctx.atlas.get('fx/glow');
    ctx.r.draw(g, cx, cy, w / g.w, h / g.h, 0, 0.03, 0.03, 0.08, a);
  }

  // -------------------------------------------------------------- word dock

  /** Slot pitch for the current word, clamped so 12 letters still fit the stage. */
  private slotWidth(n: number, L: Layout): number {
    const avail = Math.min(L.right - L.left, 1280) - SLOT_SIDE_PAD * 2;
    return Math.min(SLOT_MAX_W, avail / (n + (n - 1) * SLOT_GAP_F));
  }

  /**
   * The word dock.
   *
   * Deliberately NOT a full-width slab. The painted dirt bank along the bottom
   * of the frame is the best surface in the build and a plank stapled across it
   * cost more than it bought, so the dock is a floating plaque exactly as wide
   * as the word it holds, lifted clear of the bottom edge, translucent enough
   * that the bank reads through it and ringed so it still separates cleanly.
   * Legibility is carried by the tiles themselves, which stay fully opaque.
   */
  private drawWordBar(ctx: Ctx, s: HudState, L: Layout): void {
    const r = ctx.r;
    const well = ctx.atlas.get('ui/tile_well');
    const face = ctx.atlas.get('ui/tile_face');
    const ringThin = ctx.atlas.get('ui/tile_ring');
    const ringFat = ctx.atlas.get('ui/tile_ring_hi');
    const underline = ctx.atlas.get('ui/bar_pill');
    const caret = ctx.atlas.get('ui/caret');

    const n = s.word.length;
    const slotW = this.slotWidth(n, L);
    const slotH = slotW * SLOT_ASPECT;
    const gap = slotW * SLOT_GAP_F;
    const total = n * slotW + (n - 1) * gap;
    const step = slotW + gap;
    const x0 = L.cx - total / 2 + slotW / 2;
    const live = s.phase !== 'celebrate' && s.phase !== 'gameover';
    const bob = Math.sin(ctx.time * 4.4);

    const plaqueW = total + PLAQUE_PAD_X * 2;
    const plaqueH = slotH + PLAQUE_PAD_Y * 2 + 14;
    const plaqueCY = L.slotCY - 4;

    // Soft dark bed instead of a hard slab edge: the plaque sits *on* the bank
    // rather than covering it.
    //
    // The plaque is translucent, so the cast shadow underneath it is not
    // invisible — it darkens the plaque's interior by 6% of the ink. That wash
    // is folded into the plaque's own colour rather than drawn as a second
    // full-size panel, which is the same composite for a third of the fill.
    this.scrim(ctx, L.cx, plaqueCY + 10, plaqueW * 1.16, plaqueH * 2.1, 0.62);
    plateShadow(ctx, L.cx, plaqueCY, plaqueW, plaqueH, PLAQUE_RAD, 7, C_DARK, 0.3);
    const plaqueA = mergeShadow(C_PANEL, 0.8, C_DARK, 0.3, MERGED);
    plate(ctx, L.cx, plaqueCY, plaqueW, plaqueH, PLAQUE_RAD, MERGED, plaqueA);
    plateRing(ctx, L.cx, plaqueCY, plaqueW, plaqueH, PLAQUE_RAD, C_PAPER, 0.2);

    // Progress, read as one continuous quantity along the plaque's bottom lip
    // rather than counted off the slots.
    let done = s.nextIndex;
    if (done > 0 && s.revealed[done - 1]) done -= (s.slotPop[done - 1] ?? 0) * 0.9;
    const trackW = plaqueW - 44;
    const trackY = plaqueCY + plaqueH / 2 - 11;
    r.draw(underline, L.cx, trackY, trackW / underline.w, 6 / underline.h, 0, C_PAPER_DIM[0], C_PAPER_DIM[1], C_PAPER_DIM[2], 0.16);
    const fw = trackW * clamp(done / n, 0, 1);
    if (fw > 2) {
      r.draw(underline, L.cx - trackW / 2 + fw / 2, trackY, fw / underline.w, 6 / underline.h, 0, C_GOLD[0], C_GOLD[1], C_GOLD[2], 0.95);
    }

    for (let i = 0; i < n; i++) {
      const pop = s.slotPop[i] ?? 0;
      const age = 1 - pop;
      const filled = s.revealed[i];
      const isNext = live && i === s.nextIndex;

      // A landing letter slams in and settles; a letter taken back shakes.
      const settle = easeOutBack(clamp(age * 2.6, 0, 1));
      const sc = pop > 0 ? 1 + (1 - settle) * 0.45 : 1;
      const shake = !filled && pop > 0 ? Math.sin(age * 46) * pop * 9 : 0;

      const x = x0 + i * step + shake;
      const y = L.slotCY + (isNext ? bob * 2.5 : 0);
      const w = slotW * sc;
      const h = slotH * sc;

      if (filled) {
        // Cast shadow first so the tile reads as sitting on the plaque.
        r.draw(face, x, y + 6, w / face.w, h / face.h, 0, 0, 0, 0, 0.34);
        r.draw(face, x, y, w / face.w, h / face.h, 0, C_PAPER[0], C_PAPER[1], C_PAPER[2], 1);
        // Gold edge, not a dark one: a banked letter is HUD material, and the
        // gold is the same accent the strip, the caret and the progress use.
        r.draw(ringThin, x, y, w / ringThin.w, h / ringThin.h, 0, C_GOLD_DEEP[0], C_GOLD_DEEP[1], C_GOLD_DEEP[2], 0.6);

        const g = ctx.atlas.get(this.glyphKeys[i]);
        const gs = (slotW * 0.6) / g.w;
        const drop = (1 - easeOutCubic(clamp(age * 3.4, 0, 1))) * 30;
        const ga = clamp(age * 5, 0, 1);
        r.draw(g, x, y - slotH * 0.03 - drop, gs * sc, gs * sc, 0, C_DARK[0], C_DARK[1], C_DARK[2], ga);
      } else {
        const wc = isNext ? C_PANEL_LIT : C_WELL;
        r.draw(well, x, y, w / well.w, h / well.h, 0, wc[0], wc[1], wc[2], 0.92);
        const uc = isNext ? C_GOLD : C_PAPER_DIM;
        const ua = isNext ? 0.95 : 0.5;
        r.draw(
          underline,
          x,
          y + slotH * 0.3,
          (slotW * 0.5) / underline.w,
          (slotW * 0.085) / underline.h,
          0,
          uc[0],
          uc[1],
          uc[2],
          ua,
        );
        if (isNext) {
          r.draw(ringFat, x, y, w / ringFat.w, h / ringFat.h, 0, C_GOLD[0], C_GOLD[1], C_GOLD[2], 0.95);
          const cw = slotW * 0.42;
          r.draw(
            caret,
            x,
            y - slotH / 2 - 14 + bob * 3,
            cw / caret.w,
            (cw * 0.68) / caret.h,
            0,
            C_GOLD[0],
            C_GOLD[1],
            C_GOLD[2],
            0.95,
          );
        } else {
          r.draw(ringThin, x, y, w / ringThin.w, h / ringThin.h, 0, 1, 1, 1, 0.26);
        }
      }
    }
  }

  /** Every additive flourish the dock needs, batched into the shared glow pass. */
  private drawWordBarGlow(ctx: Ctx, s: HudState, L: Layout): void {
    const r = ctx.r;
    const glow = ctx.atlas.get('fx/glow');
    const ringFx = ctx.atlas.get('fx/ring');
    const face = ctx.atlas.get('ui/tile_face');

    const n = s.word.length;
    const slotW = this.slotWidth(n, L);
    const slotH = slotW * SLOT_ASPECT;
    const gap = slotW * SLOT_GAP_F;
    const total = n * slotW + (n - 1) * gap;
    const step = slotW + gap;
    const x0 = L.cx - total / 2 + slotW / 2;
    const live = s.phase !== 'celebrate' && s.phase !== 'gameover';

    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      const pop = s.slotPop[i] ?? 0;
      const age = 1 - pop;
      const filled = s.revealed[i];

      if (live && i === s.nextIndex) {
        const pulse = 0.42 + Math.sin(ctx.time * 5) * 0.18;
        const gw = slotW * 2.6;
        r.draw(glow, x, L.slotCY, gw / glow.w, gw / glow.h, 0, 1, 0.78, 0.3, pulse * 0.42);
      }

      if (pop > 0.001) {
        const hot: [number, number, number] = filled ? C_GOLD : C_DANGER;
        // Stage 1: the tile flashes white-hot on contact.
        const fl = clamp(1 - age * 4, 0, 1);
        if (filled && fl > 0) {
          r.draw(face, x, L.slotCY, slotW / face.w, slotH / face.h, 0, 1, 0.96, 0.85, fl * 0.8);
        }
        // Stage 2: a ring throws outwards and fades.
        const rt = clamp(age * 2.2, 0, 1);
        if (rt < 1) {
          const rw = slotW * (1.1 + rt * 1.9);
          const ra = (1 - rt) * (1 - rt) * 0.8;
          r.draw(ringFx, x, L.slotCY, rw / ringFx.w, rw / ringFx.h, 0, hot[0], hot[1], hot[2], ra);
        }
        // Stage 3: the afterglow drains with the pop.
        const gw = slotW * 2.2;
        r.draw(glow, x, L.slotCY, gw / glow.w, gw / glow.h, 0, hot[0], hot[1], hot[2], pop * 0.42);
      }

      // Victory sweep: a band of light runs along the finished word.
      if (s.phase === 'celebrate') {
        const swp = Math.max(0, 1 - Math.abs(s.phaseT * 4.5 - i * 0.4 - 0.5) * 2.6);
        if (swp > 0) {
          const gw = slotW * 2.4;
          r.draw(glow, x, L.slotCY, gw / glow.w, gw / glow.h, 0, 1, 0.9, 0.55, swp * 0.6);
        }
      }
    }
  }

  // ----------------------------------------------------------- status strip

  private drawStrip(ctx: Ctx, s: HudState, L: Layout): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');

    // A tier-5 column crosses this band. Solid plate + cast shadow + lit rim,
    // so a block sliding behind it is unambiguously behind it. The plate is
    // 99% opaque, so its shadow is only drawn where it actually shows.
    plateShadow(ctx, L.stripCX, L.rowCY, L.stripW, STRIP_H, STRIP_RAD, 9, C_DARK, STRIP_SHADOW_A);
    const stripA = mergeShadow(C_PANEL, STRIP_BODY_A, C_DARK, STRIP_SHADOW_A, MERGED);
    plate(ctx, L.stripCX, L.rowCY, L.stripW, STRIP_H, STRIP_RAD, MERGED, stripA);
    plateRing(ctx, L.stripCX, L.rowCY, L.stripW, STRIP_H, STRIP_RAD, C_PAPER, STRIP_RING_A);

    const rowY = snapY(r, L.rowCY);
    const labelY = rowY - 17;
    const numY = rowY + 9;

    // Score: secondary. Small caps label, tabular figures, warm but not loud.
    const spark = ctx.atlas.get('ui/spark');
    r.draw(spark, snapX(r, L.sparkX), snapY(r, numY), 30 / spark.w, 30 / spark.h, 0, C_GOLD[0], C_GOLD[1], C_GOLD[2], 0.9);
    drawText(ctx, 'SCORE', L.scoreX, labelY, {
      size: TYPE.caption,
      color: C_PAPER_DIM,
      alpha: 0.6,
      tracking: 0.24,
      shadow: 2,
      shadowAlpha: 0.6,
      snap: true,
    });
    drawText(ctx, this.scoreStr, L.scoreX, numY, {
      size: TYPE.score,
      color: C_PAPER,
      mono: TABULAR,
      shadow: shadowFor(TYPE.score),
      shadowAlpha: 0.55,
      snap: true,
    });

    r.draw(px, snapX(r, L.dividerX), rowY, 2 / px.w, (STRIP_H - 34) / px.h, 0, 1, 1, 1, 0.16);

    // Lives: quiet status. Only the last one moves, and only a little.
    const heart = ctx.atlas.get('ui/heart');
    const hollow = ctx.atlas.get('ui/heart_line');
    for (let i = 0; i < TUNING.scoring.maxMisses; i++) {
      const alive = i < s.lives;
      const hx = L.heartLeft + HEART_STEP * (i + 0.5);
      const f = alive ? heart : hollow;
      const c = alive ? C_DANGER : C_DEAD;
      // Only the last life beats, so only it is left off the pixel grid — a
      // still heart snapped to whole pixels is crisp, a beating one snapped is
      // a stair.
      const beating = alive && i === s.lives - 1;
      const beat = beating ? 1 + Math.sin(ctx.time * 5) * 0.07 : 1;
      const hw = (HEART_SIZE / f.w) * beat;
      const px0 = beating ? hx : snapX(r, hx);
      r.draw(f, px0, rowY, hw, hw, 0, c[0], c[1], c[2], alive ? 1 : 0.55);
    }
  }

  // ---------------------------------------------------------------- speaker

  private drawSpeaker(ctx: Ctx, s: HudState, L: Layout): void {
    const r = ctx.r;
    const p = s.speakerPulse;
    // Press feedback: the disc dips on contact and springs back.
    const press = p > 0.55 ? (p - 0.55) / 0.45 : 0;
    const d = SPK_D * (1 - press * 0.09 + (1 - press) * p * 0.05);

    // The disc is fully opaque, so only the crescent of shadow that clears its
    // bottom edge is ever visible.
    plateShadow(ctx, L.spkCX, L.spkCY, d, d, d / 2, 6, C_DARK, 0.4);
    const body = mix(C_GOLD_DEEP, C_GOLD, 0.25 + p * 0.6);
    plate(ctx, L.spkCX, L.spkCY, d, d, d / 2, body, 1);
    // Inner top light: the disc reads as domed rather than flat.
    plate(ctx, L.spkCX, L.spkCY - d * 0.14, d * 0.74, d * 0.42, d * 0.21, C_WHITE, 0.14);
    plateRing(ctx, L.spkCX, L.spkCY, d, d, d / 2, C_DARK, 0.5);

    // One button, two jobs: hear the word again and see the clue again. The
    // icon alone only promised the first, so the disc says what it does. When
    // speech is unavailable the icon goes and the label carries it alone.
    const hasIcon = ctx.audio.speechAvailable;
    if (hasIcon) {
      const icon = ctx.atlas.get('ui/speaker_bold');
      const iw = d * 0.44;
      r.draw(
        icon,
        L.spkCX - iw * 0.03,
        L.spkCY - d * 0.1,
        iw / icon.w,
        (iw * 0.9) / icon.h,
        0,
        C_DARK[0],
        C_DARK[1],
        C_DARK[2],
        0.92,
      );
    }
    drawText(ctx, HINT_LABEL, L.spkCX, L.spkCY + (hasIcon ? d * 0.26 : 0), {
      size: TYPE.caption * (d / SPK_D),
      color: C_DARK,
      align: 'center',
      alpha: 0.85,
      tracking: CAPS,
      snap: true,
    });
  }

  private drawSpeakerGlow(ctx: Ctx, s: HudState, L: Layout): void {
    const r = ctx.r;
    const glow = ctx.atlas.get('fx/glow');
    const ringFx = ctx.atlas.get('fx/ring');

    // Idle affordance: while the word is playing the button breathes, so it is
    // never ambiguous that this is the thing you press to hear it again.
    const idle = s.phase === 'listening' || s.phase === 'intro' ? 0.5 + Math.sin(ctx.time * 3.4) * 0.5 : 0;
    const a = Math.max(s.speakerPulse, idle * 0.45);
    if (a <= 0.01) return;

    const gw = SPK_D * 2.4;
    r.draw(glow, L.spkCX, L.spkCY, gw / glow.w, gw / glow.h, 0, 1, 0.8, 0.4, a * 0.45);

    if (s.speakerPulse > 0.01) {
      const t = 1 - s.speakerPulse;
      const rw = SPK_D * (1 + t * 1.5);
      r.draw(ringFx, L.spkCX, L.spkCY, rw / ringFx.w, rw / ringFx.h, 0, 1, 0.92, 0.7, s.speakerPulse * 0.7);
    }
  }

  // ------------------------------------------------------------------ combo

  /** 0 at 2x, 1 at 10x — the single number every combo flourish scales off. */
  private comboHeat(s: HudState): number {
    return clamp((s.combo - 2) / 8, 0, 1);
  }

  /** Width of the combo badge for the current combo. Pure function of state. */
  private comboWidth(s: HudState): number {
    const label = s.combo >= 10 ? 'RED HOT' : s.combo >= 6 ? 'ON FIRE' : 'COMBO';
    return (
      measureText(this.comboStr, TYPE.score, 0, TABULAR) +
      14 +
      measureText(label, TYPE.caption, CAPS) +
      52
    );
  }

  /**
   * The combo badge is docked under the status strip and right-aligned to it.
   * It used to be a free-floating display number at screen centre, which grew
   * with the combo until it touched the score pill; hanging it off the strip
   * makes that collision structurally impossible at any combo count, and puts
   * score / combo / lives in one status group where they belong.
   */
  private drawCombo(ctx: Ctx, s: HudState, L: Layout): void {
    if (s.combo < 2) return;
    const heat = this.comboHeat(s);
    const w = this.comboWidth(s);
    const h = COMBO_H * (1 + s.comboFlash * 0.06);
    const cx = L.stripR - w / 2;
    const cy = L.comboCY;
    // Copied out of `mix`'s scratch, which the label below reuses. Into a
    // module-level triple rather than a fresh array: this runs every frame.
    const accent = mix(C_GOLD, C_WHITE, heat * 0.6);
    ACCENT[0] = accent[0];
    ACCENT[1] = accent[1];
    ACCENT[2] = accent[2];
    const acc = ACCENT;

    plateShadow(ctx, cx, cy, w, h, h / 2, 7, C_DARK, 0.4);
    const badgeA = mergeShadow(C_PANEL, 0.99, C_DARK, 0.4, MERGED);
    plate(ctx, cx, cy, w, h, h / 2, MERGED, badgeA);
    plateRing(ctx, cx, cy, w, h, h / 2, acc, 0.5 + heat * 0.45);

    const numW = measureText(this.comboStr, TYPE.score, 0, TABULAR);
    const x = cx - w / 2 + 26;
    drawText(ctx, this.comboStr, x, cy, {
      size: TYPE.score,
      color: acc,
      mono: TABULAR,
      shadow: shadowFor(TYPE.score),
      shadowAlpha: 0.55,
      snap: true,
    });
    const label = s.combo >= 10 ? 'RED HOT' : s.combo >= 6 ? 'ON FIRE' : 'COMBO';
    drawText(ctx, label, x + numW + 14, cy + 1, {
      size: TYPE.caption,
      color: mix(C_PAPER_DIM, C_GOLD, heat),
      alpha: 0.7 + heat * 0.3,
      tracking: CAPS,
      shadow: 2,
      snap: true,
    });
  }

  private drawComboGlow(ctx: Ctx, s: HudState, L: Layout): void {
    if (s.combo < 2) return;
    const r = ctx.r;
    const heat = this.comboHeat(s);
    const glow = ctx.atlas.get('fx/glow');
    // Bounded by the badge, so the bloom can never reach the strip above it.
    const w = this.comboWidth(s);
    const cx = L.stripR - w / 2;
    const gw = w * (1.1 + s.comboFlash * 0.12);
    const gh = COMBO_H * (2.1 + s.comboFlash * 0.4);
    r.draw(glow, cx, L.comboCY, gw / glow.w, gh / glow.h, 0, 1, 0.72 - heat * 0.2, 0.28, 0.16 + heat * 0.2 + s.comboFlash * 0.28);
  }

  // ------------------------------------------------------------- clue card

  /** True while the banner owns the message region — nothing else may use it. */
  private muted(s: HudState): boolean {
    if (s.phase === 'celebrate' || s.phase === 'gameover') return true;
    return s.notice.kind !== NOTICE_NONE && s.notice.t < s.notice.life;
  }

  /** The clue runs on its own clock so it survives the phase flip to `playing`. */
  private clueAlpha(ctx: Ctx, s: HudState): number {
    if (this.muted(s)) return 0;
    const F = TUNING.feel;
    const age = ctx.time - this.clueT0;
    const open = clamp(1 - (age - F.clueFadeAt) / F.clueFadeTime, 0, 1);
    // Before the walls are live there is nothing for a card to obstruct, so a
    // recall during the presentation simply keeps the presentation up.
    if (s.phase === 'intro' || s.phase === 'listening') {
      return Math.max(open, this.hintAlpha(s));
    }
    return open;
  }

  /** Fade envelope for a player-requested recall. */
  private hintAlpha(s: HudState): number {
    if (s.hintT <= 0 || this.muted(s)) return 0;
    const hold = TUNING.feel.hintHold;
    const inA = clamp((hold - s.hintT) / 0.18, 0, 1);
    const outA = clamp(s.hintT / 0.5, 0, 1);
    return inA * outA;
  }

  /**
   * The recalled clue.
   *
   * The player forgot the word; this gives back information they already had,
   * and it has to do that without taking the game away from them. So it is one
   * slim band, translucent, parked between the combo badge and the block field,
   * and — because the HUD consumes no taps except its two buttons — completely
   * transparent to input: a tap that lands on this band still smashes the block
   * underneath it. It dismisses itself; there is nothing to close.
   */
  private drawHintBand(ctx: Ctx, s: HudState, L: Layout, a: number): void {
    const r = ctx.r;
    const lh = lineHeight(TYPE.label);
    const hasIcon = ctx.audio.speechAvailable;
    const iconGap = hasIcon ? HINT_ICON + 16 : 0;
    const w = Math.min(
      Math.max(360, this.hintW + iconGap + HINT_PAD_X * 2),
      L.right - L.left - 56,
    );
    const h = this.hintLines.length * lh + HINT_PAD_Y * 2;
    const cy = L.hintCY + (1 - a) * -12;
    const textCX = L.cx + iconGap / 2;

    if (a > 0.3) this.markCard(L.cx, cy, w, h);
    this.scrim(ctx, L.cx, cy, w * 1.3, h * 2.6, a * 0.5);
    plate(ctx, L.cx, cy, w, h, HINT_RAD, C_PANEL, a * 0.72);
    plateRing(ctx, L.cx, cy, w, h, HINT_RAD, C_GOLD, a * 0.5);

    if (hasIcon) {
      const icon = ctx.atlas.get('ui/speaker_bold');
      r.draw(
        icon,
        L.cx - w / 2 + HINT_PAD_X + HINT_ICON / 2,
        cy,
        HINT_ICON / icon.w,
        (HINT_ICON * 0.9) / icon.h,
        0,
        C_GOLD[0],
        C_GOLD[1],
        C_GOLD[2],
        a * 0.85,
      );
    }

    let ty = cy - ((this.hintLines.length - 1) * lh) / 2;
    for (const line of this.hintLines) {
      drawText(ctx, line, textCX, ty, {
        size: TYPE.label,
        color: C_PAPER,
        align: 'center',
        alpha: a,
        shadow: shadowFor(TYPE.label),
        shadowAlpha: 0.7,
        snap: true,
      });
      ty += lh;
    }
  }

  private drawClue(ctx: Ctx, s: HudState, L: Layout, fade: number): void {
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const n = s.word.length;

    const lh = lineHeight(TYPE.body);
    const bodyH = this.clueLines.length * lh;
    const pipStep = 24;
    const pipsW = n * pipStep - 8;
    // When speech is unavailable the header says so, right where the clue is —
    // rather than as a caption pinned to the screen edge, where it clipped.
    const headText =
      s.phase === 'intro' ? HEAD_INTRO : ctx.audio.speechAvailable ? HEAD_LISTEN : HEAD_READ;
    const headW = measureText(headText, TYPE.label, CAPS) + 52;

    // Clamped to the visible rect as a backstop. The clue is wrapped to 860 and
    // the view is never narrower than 1280, so this never bites — but a card
    // running off the edge is exactly the failure this file exists to prevent.
    const cardW = Math.min(
      Math.max(520, pipsW + 120, headW + 120, this.clueW + CLUE_PAD_X * 2),
      L.right - L.left - 48,
    );
    const cardH = CLUE_HEAD_H + bodyH + CLUE_FOOT_H;

    // Springs in on arrival, drifts up and shrinks a touch as it leaves.
    const appear = easeOutBack(clamp((ctx.time - this.wordT0) / 0.28, 0, 1));
    const k = (0.9 + 0.1 * appear) * (0.97 + 0.03 * fade);
    const cy = L.msgCY + (1 - appear) * -26 - (1 - fade) * 34;
    const w = cardW * k;
    const h = cardH * k;
    const rad = CLUE_RAD * k;
    const top = cy - h / 2;
    const cx = L.cx;

    // The card is the largest surface in the interface, so its shadow was also
    // the largest: a full second card, 95% of it behind an opaque one. Only the
    // lip is drawn; the sliver that used to tint the card's interior is folded
    // into the card's own colour.
    plateShadow(ctx, cx, cy, w, h, rad, 14, C_DARK, 0.4 * fade);
    const cardA = mergeShadow(C_PANEL, 0.95 * fade, C_DARK, 0.4 * fade, MERGED);
    plate(ctx, cx, cy, w, h, rad, MERGED, cardA);

    // Header band: rounded at the top, squared where it meets the body.
    const headH = CLUE_HEAD_H * k;
    plate(ctx, cx, top + headH / 2, w, headH, rad, C_GOLD_DEEP, 0.95 * fade);
    r.draw(
      px,
      cx,
      top + headH - rad / 2,
      w / px.w,
      rad / px.h,
      0,
      C_GOLD_DEEP[0],
      C_GOLD_DEEP[1],
      C_GOLD_DEEP[2],
      0.95 * fade,
    );

    const hy = top + headH / 2;
    const icon = ctx.atlas.get('ui/speaker_bold');
    const hasIcon = s.phase !== 'intro' && ctx.audio.speechAvailable;
    const tw = measureText(headText, TYPE.label * k, CAPS);
    const iw = 26 * k;
    const groupW = tw + (hasIcon ? iw + 12 * k : 0);
    let hx = cx - groupW / 2;
    if (hasIcon) {
      r.draw(icon, hx + iw / 2, hy, iw / icon.w, (iw * 0.9) / icon.h, 0, C_DARK[0], C_DARK[1], C_DARK[2], 0.85 * fade);
      hx += iw + 12 * k;
    }
    drawText(ctx, headText, hx, hy, {
      size: TYPE.label * k,
      color: C_DARK,
      alpha: 0.92 * fade,
      tracking: CAPS,
      snap: true,
    });

    let ty = top + headH + lh * 0.62;
    for (const line of this.clueLines) {
      drawText(ctx, line, cx, ty, {
        size: TYPE.body * k,
        color: C_PAPER,
        align: 'center',
        alpha: fade,
        shadow: 2,
        shadowAlpha: 0.5,
        snap: true,
      });
      ty += lh * k;
    }

    // Letter count, shown as pips that echo the slots in the dock below.
    const pip = ctx.atlas.get('ui/bar_pill');
    const py = cy + h / 2 - 44 * k;
    const step = pipStep * k;
    const px0 = cx - ((n - 1) * step) / 2;
    for (let i = 0; i < n; i++) {
      const doneP = i < s.nextIndex;
      const c = doneP ? C_GOLD : C_PAPER_DIM;
      r.draw(pip, px0 + i * step, py, (16 * k) / pip.w, (7 * k) / pip.h, 0, c[0], c[1], c[2], (doneP ? 0.95 : 0.4) * fade);
    }
    drawText(ctx, this.lettersLabel, cx, cy + h / 2 - 20 * k, {
      size: TYPE.caption * k,
      color: C_PAPER_DIM,
      align: 'center',
      alpha: 0.7 * fade,
      tracking: 0.26,
      snap: true,
    });

    plateRing(ctx, cx, cy, w, h, rad, C_GOLD, 0.55 * fade);
    if (fade > 0.3) this.markCard(cx, cy, w, h);
  }

  // ------------------------------------------------------------ the banner

  /**
   * The one message channel.
   *
   * There is exactly one banner slot and the scene decides by severity which
   * message occupies it — so "SET BACK" and "KEEP ROLLING" are one object with
   * one type hierarchy and one z-order, instead of a panel and a floater
   * racing each other through the same 200 world units. It draws last in the
   * opaque pass, which is itself drawn after the world, so no letter block can
   * ever cross in front of it.
   */
  private drawNotice(ctx: Ctx, s: HudState, L: Layout): void {
    const nt = s.notice;
    if (nt.kind === NOTICE_NONE) return;
    const inA = smoothstep(clamp(nt.t / 0.16, 0, 1));
    const outA = clamp((nt.life - nt.t) / 0.3, 0, 1);
    const alpha = inA * outA;
    if (alpha <= 0.01) return;

    const accent =
      nt.kind === NOTICE_BAD ? C_DANGER : nt.kind === NOTICE_GOOD ? C_GOOD : C_GOLD;
    const hasSub = nt.sub.length > 0;
    const headW = measureText(nt.text, TYPE.head, CAPS);
    const subW = hasSub ? measureText(nt.sub, TYPE.label, CAPS) : 0;
    const w = Math.min(Math.max(headW, subW) + 110, L.right - L.left - 48);
    const h = hasSub ? 132 : 90;
    const cy = L.msgCY - (1 - inA) * 20;

    if (alpha > 0.3) this.markCard(L.cx, cy, w, h);
    this.scrim(ctx, L.cx, cy, w * 1.5, h * 2.4, 0.55 * alpha);
    plateShadow(ctx, L.cx, cy, w, h, 34, 10, C_DARK, 0.45 * alpha);
    const noticeA = mergeShadow(C_PANEL, 0.97 * alpha, C_DARK, 0.45 * alpha, MERGED);
    plate(ctx, L.cx, cy, w, h, 34, MERGED, noticeA);
    plateRing(ctx, L.cx, cy, w, h, 34, accent, 0.8 * alpha);

    const headY = hasSub ? cy - 22 : cy;
    drawText(ctx, nt.text, L.cx, headY, {
      size: TYPE.head,
      color: C_PAPER,
      align: 'center',
      alpha,
      tracking: CAPS,
      shadow: shadowFor(TYPE.head),
      snap: true,
    });
    if (hasSub) {
      drawText(ctx, nt.sub, L.cx, cy + 30, {
        size: TYPE.label,
        color: accent,
        align: 'center',
        alpha: alpha * 0.95,
        tracking: 0.26,
        shadow: 2,
        snap: true,
      });
    }
  }

  // --------------------------------------------------------------- floaters

  private drawFloaters(ctx: Ctx, s: HudState, L: Layout): void {
    // Floaters are spawned at world positions and can therefore be born off
    // the edge of a narrow view. Clamping here — rather than at the call site —
    // means no aspect ratio can ever clip one.
    const lo = L.left + 16;
    const hi = L.right - 16;
    const topLimit = L.top + 30;
    const botLimit = L.bottom - DOCK_LIFT - 90;

    for (const f of s.floaters) {
      const t = f.t / f.life;
      const inA = clamp(t * 7, 0, 1);
      const outA = 1 - clamp((t - 0.5) / 0.5, 0, 1);
      const a = inA * outA;
      if (a <= 0.01) continue;
      // Overshoot in, then hold: reads as a hit, not a fade.
      const sc = 0.45 + 0.55 * easeOutBack(inA);
      const size = f.size * sc;
      const w = measureText(f.text, size, 0.04);
      const subSize = size * 0.52;
      const subW = f.sub ? measureText(f.sub, subSize, CAPS) : 0;
      const halfW = Math.max(w, subW) * 0.5 + 12;

      const x = clamp(f.x, lo + halfW, Math.max(lo + halfW, hi - halfW));
      const y = clamp(f.y, topLimit, botLimit);

      this.scrim(ctx, x, y + (f.sub ? size * 0.2 : 0), Math.max(w, subW) * 2.2, size * 3, a * 0.5);
      drawText(ctx, f.text, x, y, {
        size,
        color: f.c,
        alpha: a,
        align: 'center',
        tracking: 0.04,
        shadow: shadowFor(size),
        shadowAlpha: 0.55,
      });
      if (f.sub) {
        drawText(ctx, f.sub, x, y + size * 0.68, {
          size: subSize,
          color: C_PAPER,
          alpha: a * 0.9,
          align: 'center',
          tracking: CAPS,
          shadow: 2,
        });
      }
    }
  }
}
