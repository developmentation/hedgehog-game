/**
 * Parallax backdrop.
 *
 * Eleven depth bands, nine distinct scroll rates:
 *
 *   sky (static, with a lit cloud bank)  ->  far layer 0.04
 *   ->  mid layer 0.15  ->  ridge row 0.27  ->  tall mass 0.60
 *   ->  bank 0.84  ->  ground + near scatter 1.0
 *   ->  foreground foliage 1.42  ->  hanging band 2.00
 *   ->  over-frame canopy 2.90
 *
 * **WHAT is drawn is data; WHERE and HOW OFTEN is code.** Every asset id, crop,
 * tint, count and screen band lives in a `ThemeDef` (see `themes.ts`); this file
 * owns the composition rules those numbers are poured into — the scroll rates,
 * the tiling and wrap arithmetic, the registration onto `GROUND_Y`, the culling
 * and the draw order. Adding a theme is one object literal in `themes.ts` and
 * no change here. The active theme comes from the level being played
 * (`activeThemeId()`), and switching it rebuilds this module from scratch.
 *
 * **A rate is only real if it is the loudest thing in some band of the frame.**
 * An earlier pass had eight distinct constants and *three* measurable planes:
 * a ridge forest built at 210-520 units tall blanketed the whole middle of the
 * screen, so the 0.05 mountains and the 0.12 hills existed but never showed;
 * and the canopy was so thin at 16:9 that the band it nominally owned actually
 * measured the tall trees behind it. Everything is now sized so that each rate
 * *dominates a horizontal strip of the output*: canopy at the top edge, then
 * tall crowns, the far layer, the mid layer, the ridge row, the bank, the
 * ground, and the foreground row along the bottom. Scroll rates are spaced at
 * roughly 1.4x per plane, which is about the smallest ratio a viewer reads as
 * a separate distance.
 *
 * Three rules shape every decision in here.
 *
 * **The frame has a top as well as a bottom.** A backdrop whose every element
 * is planted on the horizon is a poster, not a place. Two bands exist purely to
 * break that: a canopy that hangs *down* from the real top of the viewport, and
 * a row of verticals tall enough to cut through the horizon and run off the top
 * edge. Both are anchored to `r.viewTop`, never to a design-space constant,
 * because the stage no longer letterboxes — on a tall phone the top of the
 * world sits ~2000 units above the playfield and a canopy pinned to y=0 would
 * float in the middle of an empty sky. A theme with no canopy asset does not
 * get one (see `winter`), and leans on the tall row instead; it must never
 * borrow another theme's, because the sets are painted to different palettes.
 *
 * **Range, not a raised floor.** A frame is lit when it holds deep shadow and
 * a real highlight at the same time; it is bleached when every band of it sits
 * in one narrow high midtone. So the picture is built top to bottom as a value
 * ramp with the whole of the sky painting's hue journey in it, and the
 * highlights are *bought locally*: a lit cloud bank, a near-opaque rake along
 * the top of the soil, lit fringe. Everything that ought to be dark is allowed
 * to be. Distance is sold by *hue and value* — never by alpha, which lets the
 * background leak through solid objects.
 *
 * **Nothing may bury the play.** The letter blocks live between y≈200 and 500
 * and the hedgehog holds station at x=300. The canopy band is clamped so it can
 * never descend into the block band, and the near foliage fades to a wisp as it
 * sweeps across the hero's column. Depth is worth having only while the game
 * stays readable through it.
 *
 * **Fill is the budget, not draw calls.** The batcher samples eight textures
 * and both blend modes inside one draw call, so the layer order is free to be
 * whatever depth demands — the whole world pass is a single call. What costs is
 * fragments: this scene is GPU fill-bound, and every quad is paid for at its
 * full rectangle whether or not the painting inside it covers anything. So the
 * rules are: draw each layer once (never a stack of alpha bands faking haze),
 * size each quad to the strip of screen where that layer is the frontmost thing
 * painted, and crop every sprite to the box its ink actually occupies. Nothing
 * allocates after a theme is built.
 *
 * Every generated asset is optional. With none present the module falls back
 * to the procedural shapes the game shipped with and still runs.
 */

import type { Ctx } from '../core/ctx';
import { VIEW_W, GROUND_Y, PLAYER_X, clamp, lerp, smoothstep } from '../core/ctx';
import { rgb, FOG } from '../art/palette';
import type { Frame } from '../engine/gl';
import { Blend } from '../engine/gl';
import { Rng } from '../engine/rng';
import { activeThemeId } from './levels';
import {
  themeFor,
  DEFAULT_THEME,
  type CloudDef,
  type HangDef,
  type LayerDef,
  type PieceSpec,
  type RowDef,
  type ThemeDef,
  type WashDef,
} from './themes';

// -------------------------------------------------------- frame geometry
//
// These are facts about the *output*, not about any painting, so they are the
// same for every theme. Anything that is a fact about a painting — a crop, a
// base row, a tint — lives in the theme.

/** Screen line the far layers bottom out on: under the ground, so no seam. */
const FAR_BASE = 596;

/** Scroll rates, as a fraction of world distance. Roughly 1.4x per plane. */
const F_MTN = 0.04;
const F_HIL = 0.15;
const F_RIDGE = 0.27;
const F_TALL = 0.6;
const F_BANK = 0.84;
const F_NEAR = 1.0;
const F_FORE = 1.42;
const F_VINE = 2.0;
const F_CANOPY = 2.9;

/** How many tiles the bank's skyline rise takes to cycle. */
const BANK_STEPS = 7;
/**
 * The same rise, a third as deep and three tiles out of phase, applied to the
 * walkable slab itself.
 *
 * The slab carries a second horizontal edge inside it — the line where lit
 * surface gives way to soil — and that one was as straight as the first. Seven
 * units of drift is far too little to matter to anything that collides (the
 * hedgehog's contact shadow moves by at most seven units over a thousand of
 * travel, under one percent of frame height) and quite enough to stop the soil
 * edge reading as a ruled line, especially with the fringe rooted through it.
 */
const GROUND_RISE = 7;
const GROUND_PHASE = 3;

/** Radius around the hedgehog inside which foreground foliage thins to a wisp. */
const HERO_CLEAR = 300;
const HERO_CLEAR_A = 0.26;

/**
 * Layer tints are multipliers on the painted art, and are capped at 3.6 for a
 * scatter row.
 *
 * A multiplier above 1.0 is only ever right for art that is dark. The dusk set
 * contains no near-white pixels — measured 0.00% above luma 235 in every one,
 * with a p99 of at most 206 — so its rows genuinely need 1.4-3.4x and the old
 * cap of 1.4 silently threw that away. The winter and cave sets peak at luma
 * 246-253 and sit at or below 1.0 for exactly the same reason: a multiplier
 * above 1.0 there manufactures exposure the artwork does not have.
 *
 * 3.6 is high enough that no row currently hits it and low enough that a typo
 * cannot blow a whole layer to white.
 */
const TINT_CAP = 3.6;

/**
 * Sky skirt: a stretched sliver of the painting's last rows filling everything
 * below the horizon. Almost entirely hidden by the ground and the word bar.
 */
const SKIRT_V0 = 0.985;
const SKIRT_H = 96;
const SKIRT_DROP = 42;

// ------------------------------------------------------------------- helpers

/** A sub-rectangle of `f`, in normalised frame space. Init-time only. */
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

/**
 * The same window, sampled bottom-to-top.
 *
 * The shader lerps v from `v0` at the quad's top edge to `v1` at its bottom, so
 * swapping the pair is a vertical flip and costs nothing. It is how the cave
 * gets a ceiling: a ridge of stalagmites with a flat base and lit tips, read
 * upside down, is a ceiling of stalactites with a flat top edge that stays off
 * frame and a fringe of lit points hanging into view.
 */
function subFlip(f: Frame, u0: number, u1: number, v0: number, v1: number, py = 0.5): Frame {
  const g = sub(f, u0, u1, v0, v1, py);
  const t = g.v0;
  g.v0 = g.v1;
  g.v1 = t;
  return g;
}

/**
 * A 1x1 frame that samples a single texel of `f`. Because u0 === u1 every
 * fragment reads the same point, so this is a flat colour quad that batches
 * with whatever texture is already bound — a full-screen wash for free.
 */
function solid(f: Frame, u: number, v: number): Frame {
  const uu = f.u0 + (f.u1 - f.u0) * u;
  const vv = f.v0 + (f.v1 - f.v0) * v;
  return { tex: f.tex, u0: uu, v0: vv, u1: uu, v1: vv, w: 1, h: 1, px: 0.5, py: 0.5 };
}

/**
 * The frame a prop is actually drawn from: cropped to its ink box, with the
 * pivot moved to the sprite's footprint so it plants and sways.
 *
 * The pivot is expressed in the *cropped* frame's space but placed where it
 * would have been in the full one — horizontally on the matte's centre line,
 * vertically on `bot`. That is what makes the crop free of consequences: the
 * anchor the layout code positions, the axis a mirrored sprite reflects about
 * and the point a swaying sprite rotates around are all unchanged, so the
 * caller's `x`, `y` and scale arithmetic (which is written against the full
 * frame, `raw.h * span`) keeps working untouched.
 */
function trimmed(f: Frame, spec: PieceSpec): Frame {
  const u0 = spec.u0 ?? 0;
  const u1 = spec.u1 ?? 1;
  const v0 = spec.v0 ?? 0;
  const v1 = spec.v1 ?? 1;
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
    px: (0.5 - u0) / (u1 - u0),
    py: (spec.bot - v0) / (v1 - v0),
  };
}

/**
 * Widest half-extent in a row, which is how far past the visible edge a wrap
 * boundary has to sit. Anything less and a sprite blinks out of existence with
 * part of itself still on screen — the taller the art, the more obvious it is.
 */
function hangMargin(list: Hang[]): number {
  let m = 0;
  for (let i = 0; i < list.length; i++) if (list[i].w * 0.5 > m) m = list[i].w * 0.5;
  return m;
}

function rowMargin(list: Prop[]): number {
  let m = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const w = Math.abs(p.sx) * p.f.w * 0.5;
    if (w > m) m = w;
  }
  return m;
}

// --------------------------------------------------------------------- types

interface Band {
  f: Frame;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FarLayer {
  factor: number;
  scale: number;
  tileW: number;
  bands: Band[];
}

interface Wash {
  y: number;
  h: number;
  a: number;
}

/** One full-width wash: a texel, a tint and the bands it is laid in. */
interface WashSet {
  f: Frame;
  r: number;
  g: number;
  b: number;
  bands: Wash[];
}

interface Prop {
  f: Frame;
  x: number;
  y: number;
  sx: number;
  sy: number;
  r: number;
  g: number;
  b: number;
  a: number;
  amp: number;
  rate: number;
  phase: number;
}

/** A laid-out scatter row: its pieces, its wrap span and its widest overhang. */
interface Row {
  list: Prop[];
  span: number;
  margin: number;
}

/** A piece of the over-frame band: anchored by its flat TOP edge (py = 0). */
interface Hang {
  f: Frame;
  x: number;
  w: number;
  h: number;
  flip: number;
  /** Lift off the band's floor, as a fraction of the hang depth. */
  sag: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A laid-out over-frame band, plus the screen rules that place it. */
interface HangBand {
  list: Hang[];
  span: number;
  margin: number;
  depth: number;
  floor: number;
  minH: number;
}

const SCATTER_COUNT = 26;

const emptyRow = (): Row => ({ list: [], span: 1, margin: 0 });

export class Parallax {
  // --- painted path -------------------------------------------------------
  private painted = false;
  /** The theme currently built. A change here rebuilds everything below it. */
  private theme: ThemeDef | null = null;

  private sky: Frame | null = null;
  private skirt: Frame | null = null;
  private skirtY = 0;
  private skirtSy = 1;

  private far: FarLayer | null = null;
  private mid: FarLayer | null = null;

  /** Washes that ride the mid texture, drawn over the far layers... */
  private midWash: WashSet[] = [];
  /** ...and those that ride the ground texture, drawn over the ground. */
  private groundWash: WashSet[] = [];

  private clouds: Row = emptyRow();
  private ridge: Row = emptyRow();
  private tall: Row = emptyRow();
  private near: Row = emptyRow();
  private fringe: Row = emptyRow();
  private fore: Row = emptyRow();

  private groundF: Frame | null = null;
  private bankF: Frame | null = null;
  private groundY = 0;
  private groundScale = 1;
  private groundTileW = 1;
  private groundTint: [number, number, number] = [1, 1, 1];
  private bankY = 0;
  private bankScale = 1;
  private bankTileW = 1;
  private bankTint: [number, number, number] = [1, 1, 1];
  /** Per-tile skyline rise, indexed by tile number mod its length. */
  private bankRise: number[] = [];
  /** The walkable slab's share of that rise. */
  private groundRise = 0;

  private canopy: HangBand | null = null;
  private vines: HangBand | null = null;

  /** Set once a host draws the foreground itself; stops the inline pass. */
  private foreHosted = false;

  // --- procedural fallback ------------------------------------------------
  private layers: {
    frame: string;
    factor: number;
    y: number;
    scale: number;
    tint: [number, number, number];
    alpha: number;
  }[] = [];
  private scatter: { frame: string; x: number; scale: number; factor: number; flip: boolean }[] = [];
  private puffs: { i: number; x: number; y: number; scale: number; speed: number; alpha: number }[] =
    [];

  /** Mirror of ctx.rawMode, captured once per frame for the draw helpers. */
  private raw = false;
  private proceduralReady = false;

  // ---------------------------------------------------------------- init

  /**
   * Build for whatever theme the live level asks for.
   *
   * Cheap enough to call from both `update` and `draw` every frame: the common
   * case is one identity compare. A theme change is an init, not a frame cost —
   * it is the only thing in this module that allocates.
   */
  private init(ctx: Ctx): void {
    let want = themeFor(activeThemeId());
    if (this.theme === want) return;
    if (!this.has(ctx, want)) want = DEFAULT_THEME;
    if (this.theme === want) return;

    this.theme = want;
    this.painted = this.has(ctx, want);
    this.reset();
    if (this.painted) this.buildTheme(ctx, want);
    if (!this.proceduralReady) {
      this.proceduralReady = true;
      this.initProcedural(ctx);
    }
  }

  /** Does this theme's irreducible core exist? Props are all optional. */
  private has(ctx: Ctx, t: ThemeDef): boolean {
    const a = ctx.assets;
    return a.has(t.sky.id) && a.has(t.far.id) && a.has(t.mid.id) && a.has(t.ground.id);
  }

  /**
   * Drop every scrap of the outgoing theme.
   *
   * Nothing survives a theme change except the procedural fallback (which is
   * built from the atlas, not from the assets) and `foreHosted`, which is a
   * fact about the host rather than about the scene. Rows are replaced rather
   * than emptied in place so a shorter row cannot leave the tail of a longer
   * one behind it.
   */
  private reset(): void {
    this.sky = null;
    this.skirt = null;
    this.far = null;
    this.mid = null;
    this.midWash = [];
    this.groundWash = [];
    this.clouds = emptyRow();
    this.ridge = emptyRow();
    this.tall = emptyRow();
    this.near = emptyRow();
    this.fringe = emptyRow();
    this.fore = emptyRow();
    this.groundF = null;
    this.bankF = null;
    this.bankRise = [];
    this.canopy = null;
    this.vines = null;
  }

  private buildTheme(ctx: Ctx, t: ThemeDef): void {
    const a = ctx.assets;
    // Own RNG: the scatter must be identical every boot without perturbing the
    // sequence any other system is drawing from. Every theme re-seeds it with
    // the same value, so a theme's layout is a pure function of its numbers —
    // and switching away and back gives the identical frame.
    const rng = new Rng(0x5c47739a);

    // --- sky --------------------------------------------------------------
    const skyRaw = a.get(t.sky.id)!;
    this.sky = sub(skyRaw, t.sky.u0, 1, t.sky.v0, 1);
    this.skirt = sub(skyRaw, t.sky.u0, 1, SKIRT_V0, 1);
    this.skirtSy = SKIRT_H / this.skirt.h;
    this.skirtY = t.sky.bottom + SKIRT_DROP;

    // --- the two tiled layers --------------------------------------------
    this.far = this.buildLayer(a.get(t.far.id)!, t.far, F_MTN, FAR_BASE + 6);
    const midRaw = a.get(t.mid.id)!;
    this.mid = this.buildLayer(midRaw, t.mid, F_HIL, FAR_BASE);

    // --- ground -----------------------------------------------------------
    // Register the measured surface row onto GROUND_Y — where the hedgehog's
    // paws, the letter blocks and their contact shadows all live.
    const g = t.ground;
    const grdRaw = a.get(g.id)!;
    this.groundF = sub(grdRaw, g.u[0], g.u[1], g.v0, g.v1);
    this.groundScale = g.scale;
    this.groundTileW = this.groundF.w * g.scale;
    this.groundTint = g.tint;
    const gh = this.groundF.h * g.scale;
    const surf = (g.surface - g.v0) / (g.v1 - g.v0);
    this.groundY = GROUND_Y + (0.5 - surf) * gh;
    // The bank: the same slab, drawn a second time behind the walkable one.
    //
    // Two jobs. It is the ninth scroll rate, sitting between the ridge row and
    // the ground; and its top edge — not the ground's — is what the sky is cut
    // against, so a per-tile rise makes the skyline undulate without moving
    // `GROUND_Y` by a single unit. The rise is invisible as a seam because the
    // tile edge is a ragged fringe and because everything below the bank's
    // surface is covered by the slab in front of it.
    //
    // Only its top matters, so it is cropped rather than drawn full height:
    // a second full copy of the ground reaching off the bottom of the frame is
    // a quarter of a screen of fill per frame for nothing. `crop` has to be
    // deep enough that the bank's lower edge stays under the walkable slab's
    // opaque line at the TOP of the rise, which is why it differs per theme.
    const b = g.bank;
    const bh = this.groundF.h * b.scale;
    this.bankF = sub(this.groundF, 0, 1, 0, b.crop);
    this.bankY = GROUND_Y - b.lift - surf * bh + bh * b.crop * 0.5;
    this.bankScale = b.scale;
    this.bankTileW = this.groundF.w * b.scale;
    this.bankTint = b.tint;
    for (let k = 0; k < BANK_STEPS; k++) {
      // Two harmonics so the skyline reads as terrain rather than as a wave,
      // and scaled so no two neighbouring tiles ever step by more than about
      // two thirds of the peak-to-trough — inside the depth of the fringe
      // along the edge, which is what hides the join.
      const p = (2 * Math.PI * k) / BANK_STEPS;
      this.bankRise.push((Math.sin(p) * 0.68 + Math.sin(p * 2 + 1.1) * 0.32) * b.rise);
    }
    this.groundRise = GROUND_RISE / b.rise;

    // --- washes -----------------------------------------------------------
    // Both ride a texture that is already bound, so they cost one quad each and
    // no bind at all. `src` also decides where in the pass they land.
    if (t.washes) {
      for (const w of t.washes) {
        const set = this.buildWash(w.src === 'mid' ? midRaw : grdRaw, w);
        (w.src === 'mid' ? this.midWash : this.groundWash).push(set);
      }
    }

    // --- rows, in the order the RNG is consumed --------------------------
    // The order matters and must not be shuffled: one seeded stream feeds every
    // row, so moving a row moves every row after it.
    if (t.clouds) this.buildClouds(ctx, rng, this.clouds, t.clouds);
    const pieces = new Map<string, PieceSpec>();
    for (const p of t.pieces) pieces.set(p.id, p);
    this.buildRow(ctx, rng, this.ridge, t.rows.ridge, pieces);
    this.buildRow(ctx, rng, this.tall, t.rows.tall, pieces);
    this.buildRow(ctx, rng, this.near, t.rows.near, pieces);
    this.buildRow(ctx, rng, this.fringe, t.rows.fringe, pieces);
    this.buildRow(ctx, rng, this.fore, t.rows.fore, pieces);

    // --- the over-frame bands --------------------------------------------
    if (t.canopy) this.canopy = this.buildHang(ctx, rng, t.canopy);
    if (t.vines) this.vines = this.buildHang(ctx, rng, t.vines);
  }

  /**
   * One tiled layer, sized and registered against a screen base line.
   *
   * The frame is cropped to its opaque extent first — the repeat pitch is taken
   * straight from that width, so tiles abut exactly and alternate tiles mirror
   * about the shared edge column. That is the whole seam story: no shrink, no
   * overlap, no double-composited strip. Shrinking the pitch by a few percent
   * instead (an earlier workaround for the mattes' soft edges) made neighbours
   * *overlap*, and since those layers drew at partial alpha the overlap
   * composited twice and showed as a rectangular patch of mismatched value.
   */
  private buildLayer(raw: Frame, def: LayerDef, factor: number, base: number): FarLayer {
    const f = sub(raw, def.u[0], def.u[1], 0, 1);
    const h = f.h * def.scale;
    const cy = base - (def.bot - 0.5) * h;
    const [v0, v1] = def.band;

    // ONE opaque band per layer.
    //
    // This used to slice every layer into eight horizontal strips at partial
    // alpha, to fake aerial haze by fading a ridge out toward the horizon.
    // Two things were wrong with that. Partial alpha does not read as haze, it
    // reads as TRANSPARENCY — clouds and trees were visibly showing through the
    // mountains standing in front of them. And because each strip composites
    // separately, and each layer is redrawn once per tile, a single frame
    // stacked roughly twenty layers of the mid art and fifty of the tree art
    // over one another, which drove the whole frame hotter and more saturated
    // than the source paintings.
    //
    // Distance is a COLOUR, not an opacity. A far layer is drawn solid and
    // tinted toward the sky: cooler, darker, lower contrast. That is what
    // aerial perspective actually is, it cannot let the background leak through
    // a solid object, and it composites exactly once.
    const bands: Band[] = [
      {
        f: sub(f, 0, 1, v0, v1),
        y: cy + ((v0 + v1) * 0.5 - 0.5) * h,
        r: def.tint[0],
        g: def.tint[1],
        b: def.tint[2],
        a: 1,
      },
    ];
    return { factor, scale: def.scale, tileW: f.w * def.scale, bands };
  }

  private buildWash(src: Frame, def: WashDef): WashSet {
    const bands: Wash[] = [];
    // Bands abut exactly. Overlapping them by even a pixel would double the
    // alpha along the join and draw a visible rule across the whole screen;
    // sharing an edge cannot gap, because the two quads are built from the
    // same arithmetic and no pixel centre falls inside the ULP between them.
    const [y0, y1] = def.y;
    const n = def.bands;
    const step = (y1 - y0) / n;
    const [i0, i1] = def.in;
    const fade = def.fade ?? 0;
    const [o0, o1] = def.out ?? [0, 1];
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const rise = smoothstep(clamp((u - i0) / (i1 - i0), 0, 1));
      const fall = fade ? 1 - fade * smoothstep(clamp((u - o0) / (o1 - o0), 0, 1)) : 1;
      bands.push({ y: y0 + step * (k + 0.5), h: step, a: def.a * rise * fall });
    }
    return { f: solid(src, def.u, def.v), r: def.tint[0], g: def.tint[1], b: def.tint[2], bands };
  }

  /**
   * Lay out a lit cloud bank, or leave the row empty (and the frame one
   * highlight poorer, but correct) if none of its paintings were generated.
   *
   * Kept low and to the warm end of the band: high cloud would be lit from
   * underneath at this hour and would also sit squarely behind the letter
   * blocks. These hug the horizon, where they belong and where the ridge row
   * and the mid layer give them something to be in front of.
   *
   * `bot` is 0.5 for a cloud — it hangs from its own centre, not off a
   * footprint — so the pivot stays put and the scale stays keyed to the
   * untrimmed height.
   */
  private buildClouds(ctx: Ctx, rng: Rng, out: Row, def: CloudDef): void {
    const specs = def.pieces.filter((c) => ctx.assets.has(c.id));
    if (!specs.length) return;
    const [yMin, yMax] = def.y;
    const yRange = yMax - yMin;
    let x = 0;
    for (let i = 0; i < def.count; i++) {
      x += rng.range(def.gap[0], def.gap[1]);
      const spec = specs[rng.int(0, specs.length)];
      const raw = ctx.assets.get(spec.id)!;
      const f = trimmed(raw, spec);
      const h = rng.range(def.height[0], def.height[1]);
      const s = h / raw.h;
      // Hotter the lower it sits: these are lit from below the horizon.
      const t = clamp((rng.range(yMin, yMax) - yMin) / yRange, 0, 1);
      const k = lerp(def.grade[0], def.grade[1], t);
      out.list.push({
        f,
        x,
        y: lerp(yMin, yMax, t),
        sx: rng.next() > 0.5 ? s : -s,
        sy: s,
        r: def.tint[0] * k,
        g: def.tint[1] * k,
        b: def.tint[2] * k,
        a: rng.range(def.alpha[0], def.alpha[1]),
        amp: 0,
        rate: 0,
        phase: 0,
      });
    }
    out.span = x + rng.range(def.gap[0], def.gap[1]);
    out.margin = rowMargin(out.list);
  }

  /** Lay out one scatter row. */
  private buildRow(
    ctx: Ctx,
    rng: Rng,
    out: Row,
    def: RowDef,
    pieces: Map<string, PieceSpec>,
  ): void {
    // Resolved once and kept the same length as `use`, so a theme naming an id
    // it never described costs a piece rather than shifting the whole stream.
    const pool = def.use.map((id) => pieces.get(id));
    const [gapMin, gapMax] = def.gap;
    const [hMin, hMax] = def.height;
    const [yMin, yMax] = def.y;
    let x = 0;
    for (let i = 0; i < def.count; i++) {
      x += rng.next() < 0.22 ? rng.range(gapMin * 0.32, gapMin * 0.8) : rng.range(gapMin, gapMax);
      const spec = pool[rng.int(0, pool.length)];
      const raw = spec && ctx.assets.get(spec.id);
      if (!raw || !spec) continue;
      const h = rng.range(hMin, hMax);
      const s = h / (raw.h * spec.span);
      const hn = clamp((h - hMin) / (hMax - hMin), 0, 1);
      // Bigger reads as nearer: plant it lower down the slope, and shift its
      // value along `grade` as it grows.
      const k = lerp(1 + def.grade, 1 - def.grade, hn);
      const warm = rng.range(0.9, 1.12);
      out.list.push({
        f: trimmed(raw, spec),
        x,
        y: lerp(yMin, yMax, hn) + rng.range(-5, 5),
        sx: rng.next() > 0.5 ? s : -s,
        sy: s,
        r: clamp(def.tint[0] * k * warm, 0, TINT_CAP),
        g: clamp(def.tint[1] * k, 0, TINT_CAP),
        b: clamp(def.tint[2] * k * (2 - warm), 0, TINT_CAP),
        a: def.alpha,
        amp: def.sway * rng.range(0.55, 1.5),
        rate: rng.range(0.5, 1.25),
        phase: rng.range(0, 6.283),
      });
    }
    out.span = x + rng.range(gapMin, gapMax);
    out.margin = rowMargin(out.list);
  }

  /**
   * Lay out an over-frame band, or return null if its painting is absent.
   *
   * A canopy is pitched *inside* a piece width so neighbours always overlap:
   * the band has to read as a continuous ceiling, and a gap in it is a hole
   * straight back to the empty sky this layer exists to cover. Widening the
   * pitch was tried as a fill saving — the pieces draw near-opaque, so a second
   * one over the first only moves coverage from 92% to 99% and looked on paper
   * like a quarter of a screen bought for nothing. It is not nothing: at a
   * 0.55-0.72 pitch the ceiling measurably thinned and the hem climbed. The
   * overlap is the density. A band that is *meant* to have gaps between its
   * pieces sets `pitchAbs` and spaces them in world units instead.
   */
  private buildHang(ctx: Ctx, rng: Rng, def: HangDef): HangBand | null {
    const raw = ctx.assets.get(def.id);
    if (!raw) return null;
    const cut = def.flip ? subFlip : sub;
    const frames = def.windows.map((w) => cut(raw, w[0], w[1], def.v[0], def.v[1], 0));
    const list: Hang[] = [];
    let x = 0;
    let w = 0;
    for (let i = 0; i < def.count; i++) {
      const f = frames.length > 1 ? frames[rng.int(0, frames.length)] : frames[0];
      const h = rng.range(def.height[0], def.height[1]);
      w = h * (f.w / f.h);
      x += def.pitchAbs ? rng.range(def.pitch[0], def.pitch[1]) : w * rng.range(def.pitch[0], def.pitch[1]);
      list.push({
        f,
        x,
        w,
        h,
        flip: rng.next() > 0.5 ? 1 : -1,
        // Sag is shallow on purpose: a piece lifted nearly half a hang above
        // the floor leaves the strip it is supposed to own measuring whatever
        // is behind it instead.
        sag: rng.range(def.sag[0], def.sag[1]),
        r: def.tint[0],
        g: def.tint[1],
        b: def.tint[2],
        a: def.alpha,
      });
    }
    const span = def.tailAbs ? x + rng.range(def.tail[0], def.tail[1]) : x + w * def.tail[0];
    return { list, span, margin: hangMargin(list), depth: def.depth, floor: def.floor, minH: def.minH };
  }

  private initProcedural(ctx: Ctx): void {
    this.layers = [
      { frame: 'world/hill_far', factor: 0.06, y: GROUND_Y - 40, scale: 1.5, tint: rgb('#7b88c4'), alpha: 1 },
      { frame: 'world/hill_mid', factor: 0.14, y: GROUND_Y - 10, scale: 1.3, tint: rgb('#5a68a8'), alpha: 1 },
      { frame: 'world/hill_near', factor: 0.3, y: GROUND_Y + 24, scale: 1.1, tint: rgb('#3a4780'), alpha: 1 },
    ];

    const rng = ctx.rng;
    const props = ['world/tree_0', 'world/tree_1', 'world/tree_2', 'world/rock_0', 'world/rock_1'];
    for (let i = 0; i < SCATTER_COUNT; i++) {
      this.scatter.push({
        frame: rng.pick(props),
        x: i * 520 + rng.range(-160, 160),
        scale: rng.range(0.7, 1.15),
        factor: 0.45,
        flip: rng.next() > 0.5,
      });
    }

    for (let i = 0; i < 7; i++) {
      this.puffs.push({
        i: i % 3,
        x: rng.range(-200, VIEW_W + 600),
        y: rng.range(60, 300),
        scale: rng.range(0.55, 1.3),
        speed: rng.range(4, 14),
        alpha: rng.range(0.24, 0.6),
      });
    }
  }

  // -------------------------------------------------------------- update

  update(ctx: Ctx, dt: number): void {
    this.init(ctx);
    if (this.painted) return; // painted motion is a pure function of ctx.time
    // Recycled against the live edges: `viewLeft` is negative on anything wider
    // than the design aspect, so a fixed -500 would recycle a cloud on screen.
    const off = ctx.r.viewLeft - 560;
    for (const c of this.puffs) {
      c.x -= c.speed * dt;
      if (c.x < off) {
        c.x = ctx.r.viewRight + ctx.rng.range(120, 700);
        c.y = ctx.rng.range(50, 300);
      }
    }
  }

  // ---------------------------------------------------------------- draw

  /** `distance` is total world scroll in world units. */
  draw(ctx: Ctx, distance: number): void {
    this.raw = ctx.rawMode;
    this.init(ctx);
    if (!this.painted) {
      this.drawProcedural(ctx, distance);
      return;
    }

    const r = ctx.r;
    const still = ctx.reducedMotion;

    // 1 -------------------------------------------------------------- sky
    // Sized from the live viewport, not the design rect: the stage no longer
    // letterboxes, so on a wide monitor or a tall phone the sky must stretch to
    // the real edges or its border shows as a band across the screen.
    //
    // ONE quad for it, plus the sliver that fills in below the horizon. This
    // used to be eighteen: the gradient drawn three times to dither its 8-bit
    // staircase, and a drifting cirrus sheet as two more copies sliced into
    // seven alpha-tapered bands each. Measured, that was 2.42 screens of fill,
    // more than a third of the frame's cost, for a wisp nobody could point at
    // and a dither that belongs in the shader (see `gl.ts`).
    const vl = r.viewLeft;
    const vr = r.viewRight;
    const cx = (vl + vr) * 0.5;
    const spanW = vr - vl + 8;
    const skyTop = Math.min(r.viewTop, 0);
    const skySpanH = this.theme!.sky.bottom - skyTop;
    const sk = this.sky!;
    const s1 = this.theme!.sky.tint;
    r.draw(sk, cx, skyTop + skySpanH * 0.5, spanW / sk.w, skySpanH / sk.h, 0, s1[0], s1[1], s1[2], 1);
    r.draw(this.skirt!, cx, this.skirtY, spanW / this.skirt!.w, this.skirtSy, 0, s1[0], s1[1], s1[2], 1);

    // 2 ------------------------------------------------------- far layer
    this.drawLayer(r, this.far!, distance);

    // 3 ------------------------------------ mid layer + its washes
    this.drawLayer(r, this.mid!, distance);
    this.drawWashes(ctx, this.midWash, cx, spanW);

    // 4 --------------------------------- ridge row + horizon-breakers
    // Clouds, ridge and tall are all on the shared atlas and drawn back to back
    // so they cost one bind. They sit *behind* the ground slab, which is what
    // hides their footings.
    this.drawRow(ctx, this.clouds, F_MTN, distance, false, 1);
    this.drawRow(ctx, this.ridge, F_RIDGE, distance, !still, 1);
    this.drawRow(ctx, this.tall, F_TALL, distance, !still, this.tallLift(r));

    // 5 ------------------------------------------------- bank + ground
    // Both are the same texture, drawn back to back, so the bank is free.
    const bw = this.bankTileW;
    const boff = distance * F_BANK;
    const nRise = this.bankRise.length;
    const bt = this.bankTint;
    // Tile index i covers exactly [i*w - off, (i+1)*w - off), so floor/ceil of
    // the visible edges is the complete cover; an extra tile on each side is
    // always entirely off screen.
    const b0 = Math.floor((boff + vl) / bw);
    const b1 = Math.ceil((boff + vr) / bw);
    for (let idx = b0; idx <= b1; idx++) {
      const x = idx * bw - boff + bw * 0.5;
      const k = (((idx % nRise) + nRise) % nRise) | 0;
      const flip = (((idx % 2) + 2) % 2) === 0 ? this.bankScale : -this.bankScale;
      r.draw(this.bankF!, x, this.bankY + this.bankRise[k], flip, this.bankScale, 0, bt[0], bt[1], bt[2], 1);
    }
    const g = this.groundF!;
    const gt = this.groundTint;
    const gw = this.groundTileW;
    const g0 = Math.floor((distance + vl) / gw);
    const g1 = Math.ceil((distance + vr) / gw);
    for (let idx = g0; idx <= g1; idx++) {
      const x = idx * gw - distance + gw * 0.5;
      const k = ((((idx + GROUND_PHASE) % nRise) + nRise) % nRise) | 0;
      const flip = (((idx % 2) + 2) % 2) === 0 ? 1 : -1;
      const y = this.groundY + this.bankRise[k] * this.groundRise;
      r.draw(g, x, y, this.groundScale * flip, this.groundScale, 0, gt[0], gt[1], gt[2], 1);
    }
    this.drawWashes(ctx, this.groundWash, cx, spanW);

    // 6 --------------------- near scatter + fringe (shared atlas)
    this.drawRow(ctx, this.near, F_NEAR, distance, !still, 1);
    this.drawRow(ctx, this.fringe, F_NEAR, distance, !still, 1);
    if (!this.foreHosted) this.drawForegroundPass(ctx, distance);
  }

  /**
   * Foreground foliage, split out so a host can draw it *after* the player and
   * have it sweep in front of him. Calling this once latches the inline pass
   * off; if nobody calls it the foliage still draws inside `draw`.
   */
  drawForeground(ctx: Ctx, distance: number): void {
    this.init(ctx);
    if (!this.painted) return;
    this.foreHosted = true;
    this.drawForegroundPass(ctx, distance);
  }

  private drawForegroundPass(ctx: Ctx, distance: number): void {
    this.drawFore(ctx, distance);
    if (this.vines) this.drawHang(ctx, this.vines, F_VINE, distance);
    if (this.canopy) this.drawHang(ctx, this.canopy, F_CANOPY, distance);
  }

  /**
   * How much taller the horizon-breakers grow on a screen that reveals extra
   * sky. On 16:9 this is 1; on a phone the world is nearly four times as tall
   * as it is deep, and a tree sized for a 720-unit frame would look like a
   * shrub stranded at the bottom of it.
   */
  private tallLift(r: Ctx['r']): number {
    return 1 + clamp(-r.viewTop / 2000, 0, 1) * 0.55;
  }

  /** Overlay washes — skipped entirely in raw mode. */
  private drawWashes(ctx: Ctx, sets: WashSet[], cx: number, spanW: number): void {
    if (ctx.rawMode) return;
    const r = ctx.r;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      for (let j = 0; j < s.bands.length; j++) {
        const w = s.bands[j];
        r.draw(s.f, cx, w.y, spanW, w.h, 0, s.r, s.g, s.b, w.a);
      }
    }
  }

  private drawLayer(r: Ctx['r'], l: FarLayer, distance: number): void {
    const off = distance * l.factor;
    const vl = r.viewLeft;
    const vr = r.viewRight;
    // Indexed off the *live* left edge, not off zero. On anything wider than
    // 16:9 `viewLeft` is negative, and a loop that started at the tile covering
    // x=0 simply left the strip to its left unpainted.
    const i0 = Math.floor((off + vl) / l.tileW);
    const i1 = Math.ceil((off + vr) / l.tileW);
    for (let idx = i0; idx <= i1; idx++) {
      const x = idx * l.tileW - off + l.tileW * 0.5;
      // Alternate tiles mirror, which both doubles the repeat period and makes
      // every join a reflection about a shared column of texels.
      const flip = (((idx % 2) + 2) % 2) === 0 ? l.scale : -l.scale;
      for (let j = 0; j < l.bands.length; j++) {
        const b = l.bands[j];
        // Raw mode: the painting draws at its own exposure, untinted. The
        // backdrop opts out of its OWN tinting here rather than the renderer
        // forcing every sprite white — that version also erased the
        // hedgehog's equipped skin, which lives on the same painted texture.
        const raw = this.raw;
        r.draw(
          b.f,
          x,
          b.y,
          flip,
          l.scale,
          0,
          raw ? 1 : b.r,
          raw ? 1 : b.g,
          raw ? 1 : b.b,
          b.a,
        );
      }
    }
  }

  /**
   * One wrapping row of props.
   *
   * The wrap window is anchored to `viewLeft` minus the row's own widest
   * half-extent, so a sprite is only ever recycled once it is genuinely past
   * the real left edge of the screen. Anchoring it to a constant — which is
   * what this used to do — put the recycle line inside the visible frame on any
   * display wider than 16:9, and tall art popped out of existence mid-shot.
   */
  private drawRow(
    ctx: Ctx,
    row: Row,
    factor: number,
    distance: number,
    sway: boolean,
    lift: number,
  ): void {
    const list = row.list;
    if (!list.length) return;
    const r = ctx.r;
    const t = ctx.time;
    const span = row.span;
    const left = r.viewLeft - row.margin * lift - 8;
    const right = r.viewRight + row.margin * lift + 8;
    const off = distance * factor + left;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let x = (p.x - off) % span;
      if (x < 0) x += span;
      x += left;
      if (x > right) continue;
      const rot = sway && p.amp !== 0 ? Math.sin(t * p.rate + p.phase) * p.amp : 0;
      r.draw(p.f, x, p.y, p.sx * lift, p.sy * lift, rot, p.r, p.g, p.b, p.a);
    }
  }

  /**
   * The near foliage row.
   *
   * Same layout as any other row, plus one rule: alpha falls away as a sprite
   * approaches the hedgehog's column, so foliage *passes over* him as a
   * translucent wisp instead of swallowing him. The row is already planted low
   * enough that it tops out under the letter blocks.
   */
  private drawFore(ctx: Ctx, distance: number): void {
    const list = this.fore.list;
    if (!list.length) return;
    const r = ctx.r;
    const t = ctx.time;
    const still = ctx.reducedMotion;
    const span = this.fore.span;
    const left = r.viewLeft - this.fore.margin - 8;
    const right = r.viewRight + this.fore.margin + 8;
    const off = distance * F_FORE + left;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let x = (p.x - off) % span;
      if (x < 0) x += span;
      x += left;
      if (x > right) continue;
      const clear = smoothstep(clamp(Math.abs(x - PLAYER_X) / HERO_CLEAR, 0, 1));
      const a = p.a * lerp(HERO_CLEAR_A, 1, clear);
      const rot = !still && p.amp !== 0 ? Math.sin(t * p.rate + p.phase) * p.amp : 0;
      r.draw(p.f, x, p.y, p.sx, p.sy, rot, p.r, p.g, p.b, a);
    }
  }

  /**
   * A band that hangs down from the true top of the viewport.
   *
   * `floor` is the hard limit: whatever the screen shape, the fringe stops
   * above the letter blocks. `depth` is the share of the live viewport it would
   * *like* to fill, and `minH` the shortest piece in the band — a piece is
   * scaled up until it is at least as tall as the hang, so its flat top edge is
   * always off-screen and the band never reads as a floating strip.
   */
  private drawHang(ctx: Ctx, band: HangBand, factor: number, distance: number): void {
    const list = band.list;
    if (!list.length) return;
    const r = ctx.r;
    const vt = r.viewTop;
    const bottom = Math.min(vt + (r.viewBottom - vt) * band.depth, band.floor);
    const mul = Math.max(1, (bottom - vt) / band.minH);
    const span = band.span;
    const left = r.viewLeft - band.margin * mul - 8;
    const right = r.viewRight + band.margin * mul + 8;
    const off = distance * factor + left;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let x = (p.x - off) % span;
      if (x < 0) x += span;
      x += left;
      if (x > right) continue;
      const h = p.h * mul;
      r.draw(
        p.f,
        x,
        bottom - h + p.sag * (bottom - vt),
        ((p.w * mul) / p.f.w) * p.flip,
        h / p.f.h,
        0,
        p.r,
        p.g,
        p.b,
        p.a,
      );
    }
  }

  // ------------------------------------------------------ fallback path

  private drawProcedural(ctx: Ctx, distance: number): void {
    const r = ctx.r;
    const atlas = ctx.atlas;

    const sky = atlas.get('world/sky');
    r.draw(sky, (r.viewLeft + r.viewRight) * 0.5, (r.viewTop + r.viewBottom) * 0.5, (r.viewRight - r.viewLeft) / sky.w, (r.viewBottom - r.viewTop) / sky.h, 0, 1, 1, 1, 1);

    const sun = atlas.get('world/sun');
    r.setBlend(Blend.Additive);
    const sunPulse = 1 + Math.sin(ctx.time * 0.5) * 0.03;
    r.draw(sun, VIEW_W * 0.78, GROUND_Y - 200, 2.4 * sunPulse, 2.4 * sunPulse, 0, 1, 0.92, 0.78, 0.5);
    r.setBlend(Blend.Normal);

    const cloudTint = rgb('#ffd9c0');
    const cl = r.viewLeft - 560;
    const cSpan = r.viewRight - cl + 900;
    for (const c of this.puffs) {
      const f = atlas.get(`world/cloud_${c.i}`);
      let x = (c.x - distance * 0.03 - cl) % cSpan;
      if (x < 0) x += cSpan;
      r.draw(f, x + cl, c.y, c.scale, c.scale, 0, cloudTint[0], cloudTint[1], cloudTint[2], c.alpha);
    }

    for (const l of this.layers) {
      const f = atlas.get(l.frame);
      const tileW = f.w * l.scale;
      const d = distance * l.factor;
      const i0 = Math.floor((d + r.viewLeft) / tileW) - 1;
      const i1 = Math.ceil((d + r.viewRight) / tileW) + 1;
      for (let i = i0; i <= i1; i++) {
        const x = i * tileW - d + tileW / 2;
        r.draw(f, x, l.y, l.scale, l.scale, 0, l.tint[0], l.tint[1], l.tint[2], l.alpha);
      }
    }

    const propTint = rgb('#2c3566');
    const scatterSpan = SCATTER_COUNT * 520;
    const sl = r.viewLeft - 320;
    for (const s of this.scatter) {
      let x = (s.x - distance * s.factor - sl) % scatterSpan;
      if (x < 0) x += scatterSpan;
      x += sl;
      if (x > r.viewRight + 320) continue;
      const f = ctx.atlas.get(s.frame);
      r.draw(f, x, GROUND_Y + 18, (s.flip ? -1 : 1) * s.scale, s.scale, 0, propTint[0], propTint[1], propTint[2], 1);
    }

    const ground = ctx.atlas.get('world/ground');
    const gw = ground.w;
    const g0 = Math.floor((distance + r.viewLeft) / gw) - 1;
    const g1 = Math.ceil((distance + r.viewRight) / gw) + 1;
    for (let i = g0; i <= g1; i++) {
      r.draw(ground, i * gw - distance + gw / 2, GROUND_Y + ground.h / 2 - 40, 1, 1, 0, 1, 1, 1, 1);
    }

    const grassSpan = 14 * 140;
    const grl = r.viewLeft - 140;
    for (let i = 0; i < 14; i++) {
      const f = ctx.atlas.get(`world/grass_${i % 3}`);
      let x = (i * 140 - distance * 1.25 - grl) % grassSpan;
      if (x < 0) x += grassSpan;
      x += grl;
      if (x > r.viewRight + 140) continue;
      r.draw(f, x, GROUND_Y + 34, 1.1, 1.1, 0, 0.62, 0.85, 0.68, 0.9);
    }
  }

  /** Fog wash drawn over the far layers to push them back. */
  drawFog(ctx: Ctx): void {
    if (this.painted) return;
    const r = ctx.r;
    const px = ctx.atlas.get('ui/pixel');
    const c = rgb('#8b96cf');
    r.draw(px, (r.viewLeft + r.viewRight) * 0.5, GROUND_Y - 150, (r.viewRight - r.viewLeft) / px.w, 300 / px.h, 0, c[0], c[1], c[2], 0.08);
  }
}

export { FOG };
