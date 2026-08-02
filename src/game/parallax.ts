/**
 * Parallax backdrop.
 *
 * Eleven depth bands, nine distinct scroll rates:
 *
 *   sky (static, with drifting cirrus)  ->  far mountains 0.04
 *   ->  mid hills 0.15  ->  ridge forest 0.27  ->  tall mass 0.60
 *   ->  grass bank 0.84  ->  ground + near scatter 1.0
 *   ->  foreground foliage 1.42  ->  hanging vines 2.00
 *   ->  over-frame canopy 2.90
 *
 * **A rate is only real if it is the loudest thing in some band of the frame.**
 * The previous pass had eight distinct constants and *three* measurable planes:
 * a ridge forest built at 210-520 units tall blanketed the whole middle of the
 * screen, so the 0.05 mountains and the 0.12 hills existed but never showed;
 * and the canopy was so thin at 16:9 that the band it nominally owned actually
 * measured the tall trees behind it. Everything here is now sized so that each
 * rate *dominates a horizontal strip of the output*: canopy at the top edge,
 * then tall crowns, mountains, hills, the ridge treeline, the grass bank, the
 * ground, and the foreground row along the bottom. Scroll rates are re-spaced
 * to roughly 1.4x per plane, which is about the smallest ratio a viewer reads
 * as a separate distance.
 *
 * Three rules shape every decision in here.
 *
 * **The frame has a top as well as a bottom.** A backdrop whose every element
 * is planted on the horizon is a poster, not a place. Two bands exist purely to
 * break that: a canopy that hangs *down* from the real top of the viewport, and
 * a row of trees and rock spires tall enough to cut through the horizon and run
 * off the top edge. Both are anchored to `r.viewTop`, never to a design-space
 * constant, because the stage no longer letterboxes — on a tall phone the top
 * of the world sits ~2000 units above the playfield and a canopy pinned to y=0
 * would float in the middle of an empty sky.
 *
 * **Range, not a raised floor.** A frame is lit when it holds deep shadow and
 * a real highlight at the same time; it is bleached when every band of it sits
 * in one narrow high midtone. So the picture is built top to bottom as a value
 * ramp with the whole of the sky painting's hue journey in it — indigo at the
 * zenith, violet behind the clue card, magenta and coral through the middle,
 * amber at the horizon — and the highlights are *bought locally*: a tight
 * horizon glow about a tenth of the frame tall, a near-opaque sun-rake along
 * the top of the soil, lit grass and fern in the fringe, and a bank of cloud
 * whose cores are the only thing in the picture allowed to clip. Everything that ought
 * to be dark is allowed to be: the canopy is a shadow ceiling, the treeline a
 * cool silhouette against the glow, the near foliage close to black, and the
 * ground falls away into its own shade below the play line. Distance is sold
 * by *alpha* — each far layer is sliced into bands whose opacity drops toward
 * the horizon so a ridge dissolves into the glow — and by *hue*, mauve for the
 * peaks and blue-teal for the hills, never by a neutral multiplier, which is
 * how those layers came out milky the last time.
 *
 * **Nothing may bury the play.** The letter blocks live between y≈200 and 500
 * and the hedgehog holds station at x=300. The canopy band is clamped so it can
 * never descend into the block band, and the near foliage fades to a wisp as it
 * sweeps across the hero's column. Depth is worth having only while the game
 * stays readable through it.
 *
 * **One batch per texture.** The generated art lives on five textures (sky,
 * mountains, hills, ground, shared sprite atlas) and the layer order is chosen
 * so each is touched once — twice for the atlas, which is both the mid-ground
 * tree mass and the near scatter. The grass bank and the fringe row cost
 * nothing at all because each is drawn adjacent to a pass that has already
 * bound its texture; the haze, the scrim, the rake, the dusk shade and the
 * cirrus are sub-rectangles of textures already bound, so they are free too,
 * and so is the sunlit cloud bank, which shares the atlas bind with the ridge
 * row drawn immediately after it. Measured at 17 draw calls for the entire
 * frame, world and HUD together — one fewer than before the palette work, and
 * every highlight in here was bought without spending one. Nothing allocates
 * after `init()`.
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

// --------------------------------------------------------------- art metrics
//
// The generated layers are matted onto a fixed canvas, so the painted content
// occupies a known sub-rectangle. Every fraction below was *measured* off the
// PNG's alpha channel rather than guessed, because tiling depends on it: see
// the note on seams under `buildLayer`.

const MTN_BOT = 0.704; // mountains_far: flat base of the range
const HIL_BOT = 0.624; // hills_mid: flat base of the ridge

/**
 * Horizontal crops: the widest window that is *fully opaque on every row the
 * player can see*, in texels of the 1400-wide mattes.
 *
 * This is the seam fix. The mattes fade out over the last few dozen columns, so
 * tiling on the nominal sprite width left a transparent crack; the previous
 * workaround shrank the repeat pitch by a few percent, which made neighbouring
 * tiles *overlap* instead — and since these layers draw at partial alpha, the
 * overlap composited twice and showed up as exactly what the review called "a
 * rectangular patch of mismatched value".
 *
 * Cropping to the true opaque extent lets the pitch equal the sprite width
 * exactly: tiles abut, never overlap, so no pixel is ever shaded twice. And
 * because alternate tiles mirror, every join is a reflection about a shared
 * column — the same texel on both sides — which is continuous by construction.
 */
const MTN_U0 = 30 / 1400;
const MTN_U1 = 1369 / 1400;
const HIL_U0 = 24 / 1400;
const HIL_U1 = 1375 / 1400;
const GRD_U0 = 105 / 1400;
const GRD_U1 = 1332 / 1400;
/** Top of the crop: high enough to keep the sparse fronds that break the
 *  grass line, low enough that the solid mat below is full width on every row
 *  and so folds without a notch. */
const GRD_V0 = 340 / 933;
/**
 * The walkable surface, measured off the slab: the first row where opaque
 * coverage reaches 95% and greenness peaks. Everything above it is loose
 * fronds that should poke *over* the line, everything below it is mat and then
 * soil. This row is registered to `GROUND_Y`, which is where the hedgehog's
 * paws, the letter blocks and their contact shadows all live — get it wrong by
 * fifty units and the hero walks along inside the dirt bank.
 */
const GRD_SURFACE = 416 / 933;

/**
 * Where the visible sky starts in the painting, and the single biggest lever on
 * the frame's *colour*.
 *
 * Measured off `sky_dusk.png`, right half, by row:
 *
 *   v=0.26  rgb( 43, 41,113)  indigo      lum  47
 *   v=0.45  rgb(113, 63,129)  violet      lum  78
 *   v=0.65  rgb(195, 82,114)  magenta     lum 108
 *   v=0.80  rgb(242,116, 76)  coral       lum 140
 *   v=1.00  rgb(252,195, 48)  amber       lum 197
 *
 * That is the whole picture: one ramp carrying a 150-point luma range *and* a
 * four-station hue journey. A previous pass, chasing a p95 target, cropped to
 * v>=0.66 — the top of the ramp only. It got the highlight and threw away
 * three quarters of the colour story: the visible sky became coral-to-amber,
 * the hot tint on top of it clipped both into yellow, and the frame came out
 * bleached because every band of it sat inside one narrow high-midtone.
 *
 * Range is not a floor. Starting at 0.34 puts indigo-violet at the top of the
 * world, violet behind the clue card, magenta and coral through the middle and
 * amber along the horizon — the whole journey inside the strip of sky the
 * viewer can actually see. The highlight is bought back separately and locally:
 * the horizon glow, the sun-rake on the soil, and a bank of lit cloud. None of
 * those is a lift applied to the whole frame, which is the only kind of
 * brightening that costs contrast.
 */
const SKY_V0 = 0.34;
/**
 * ...and from here rightward. The painting has a *horizontal* ramp as well as
 * a vertical one — its left edge is about a stop darker than its right at every
 * row. Keeping a good part of that fall is what makes the frame read as lit
 * *from somewhere*: the sun is off to the right, which is where the ridge
 * crowns are lit from and where the glow is hottest. Cropping it away (0.42, as
 * the highlight pass did) buys a couple of luma points everywhere and costs the
 * only lateral structure the sky has.
 */
const SKY_U0 = 0.4;
/**
 * Screen line the sky's brightest row lands on.
 *
 * Well *above* the grass, and that is deliberate. The hills' crest cuts the sky
 * off around y=380, so with v=1 registered at the old 604 the entire top third
 * of the painting's ramp — every row of it that is amber — was being drawn
 * behind opaque hills. Landing it at 474 puts coral at the crest and amber in
 * the open sky just above it, where it can be seen. Everything below is covered
 * by the hills, the bank and the ground, so nothing is lost by ending early.
 */
const SKY_BOTTOM = 474;

/**
 * Sky tint. Weighted toward red and blue and held *down* on green, which is
 * the whole difference between a dusk and a lime wash: the ramp's own greens
 * are already low, and a multiplier that lifts them evenly clips magenta into
 * yellow and amber into chartreuse. The old [1.76,1.82,1.46] did exactly that
 * over most of the range. This one keeps violet violet at the top and lets only
 * the last few rows above the horizon clip, where clipping reads as the sun.
 */
const SKY_C: [number, number, number] = [0.501, 0.481, 0.491];
const SKY_C2: [number, number, number] = [0.498, 0.48, 0.491];

/** Screen line the far layers bottom out on — under the ground, so no seam. */
const FAR_BASE = 596;

/**
 * Far-layer scales. Both ranges are lifted well above the old values so their
 * crests clear the treeline in front of them: a mountain whose peak sits below
 * the forest edge is a mountain nobody can see, however correct its parallax.
 */
const MTN_SCALE = 1.22;
const HIL_SCALE = 1.06;
const GRD_SCALE = 0.82;

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

/** Bands per far layer. More bands = smoother haze falloff, 1 sprite each. */
const BANDS = 8;

/**
 * Prop content boxes, as fractions of the matted frame. `bot` places the
 * sprite's pivot on its own footprint so props plant on the ground line
 * instead of floating; `span` converts a wanted screen height into a scale.
 */
interface Spec {
  id: string;
  bot: number;
  span: number;
}

const PROPS: Spec[] = [
  { id: 'bush_round', bot: 0.886, span: 0.766 },
  { id: 'rock_mossy', bot: 0.855, span: 0.726 },
  { id: 'rock_small_pair', bot: 0.786, span: 0.553 },
  { id: 'mushroom_cluster', bot: 0.952, span: 0.893 },
  { id: 'fern_cluster', bot: 0.965, span: 0.927 },
  { id: 'grass_tuft_a', bot: 0.954, span: 0.911 },
  { id: 'grass_tuft_b', bot: 0.767, span: 0.478 },
];

const NEAR_IDX = [0, 1, 2, 3, 4, 5, 6];
const FORE_IDX = [4, 5, 6, 0];
/**
 * The fringe row: ferns and grass tufts only, planted *below* `GROUND_Y` so
 * every one of them crosses the walkable line instead of standing on it.
 *
 * This is the answer to the ruler. The collision line cannot move, so what has
 * to go is the idea that the line is where the picture changes: with a dense
 * row of blades straddling it and a bank behind it whose own skyline undulates,
 * y=560 stops being an edge and becomes the middle of a band of grass.
 */
const FRINGE_IDX = [5, 6, 4, 5, 6];

/** The vertical mass. Same measured content box, on much taller art. */
const TREES: Spec[] = [
  { id: 'cliff_column', bot: 0.9775, span: 0.9492 },
  { id: 'tree_oak', bot: 0.9791, span: 0.9609 },
  { id: 'tree_pine', bot: 0.9782, span: 0.95 },
  { id: 'tree_birch_cluster', bot: 0.99, span: 0.97 },
  { id: 'tree_willow', bot: 0.9464, span: 0.9019 },
];

/** Horizon-breakers: a spire, a broad oak, a birch stand. */
const TALL_IDX = [0, 1, 3, 0, 2, 4];
/** The forest edge sitting on the ridge. */
const RIDGE_IDX = [2, 3, 2, 1];

/** canopy_overhang: flat top edge, soft fringe at the bottom. */
const CAN_U0 = 6 / 1400;
const CAN_U1 = 1388 / 1400;
const CAN_V0 = 36 / 933;
/**
 * Cropped short of the painting's full hem, but only as short as the alpha
 * allows. The last sixth of `canopy_overhang` is a scatter of isolated leaf
 * tips, so carrying it spends piece height on something that reads as nothing
 * and pushes the part that reads off the top of the frame. Cut too high,
 * though, and the crop lands on rows that are still a third opaque — which
 * draws the band's hem as a ruled horizontal line, which is the exact defect
 * this module is fixing at the other end of the frame. 0.75 is the last row
 * under 10% coverage.
 */
const CAN_V1 = 0.75;

/** vines_hanging holds four separate strands; each is cut out on its own. */
const VINE_V0 = 30 / 1000;
const VINE_V1 = 962 / 1000;
const VINE_U: [number, number][] = [
  [24 / 667, 142 / 667],
  [148 / 667, 309 / 667],
  [322 / 667, 516 / 667],
  [518 / 667, 641 / 667],
];

/**
 * How far the over-frame canopy hangs, as a share of the *live* viewport, and
 * the lowest screen line it may ever reach. On a 16:9 monitor the floor wins
 * and the band covers the top ~22%; on a tall phone the share wins and it is
 * 28% of a much taller frame — still far above the letters either way.
 */
const CANOPY_DEPTH = 0.28;
const CANOPY_FLOOR = 156;
/**
 * MUST equal the hang depth this band gets on a 16:9 screen.
 *
 * `drawHang` scales a piece by `max(1, hang / minH)`, so a `minH` larger than
 * the hang pins the multiplier at 1 and the piece keeps whatever absolute
 * height it was authored with. That is what broke the canopy: 486-628 units of
 * leaf hung into a 180-unit band put the dense two thirds of the painting
 * entirely above the top of the screen, and what showed on a monitor was the
 * transparent fringe at its hem. The band measured as the trees behind it
 * because that is genuinely what you were looking at.
 *
 * With `minH` equal to the 16:9 hang the multiplier becomes exactly
 * proportional, so a piece is a fixed *fraction* of the band on every screen:
 * dense leaf across the top ~45%, fringe below it, flat top edge always off
 * frame.
 */
const CANOPY_MIN_H = 156;
const VINE_DEPTH = 0.52;
const VINE_FLOOR = 236;
const VINE_MIN_H = 330;

/**
 * The canopy's tint and coverage.
 *
 * The leaf painting is dark — mean luma 49-60 raw across the bands that carry
 * coverage — and that is the point of it. This band is the frame's shadow
 * anchor, the thing every highlight below is measured against, so it is lit
 * only far enough to keep the leaves reading as leaves rather than as a bar.
 * The highlight pass ran it at 2.9, which put the whole ceiling into the same
 * high midtone as the sky and the ground: nothing in the frame was dark, so
 * nothing in it was bright either.
 *
 * Warm on red, cool on blue: the underside of a canopy at dusk picks up the
 * horizon on its lit edges and the sky in its depths, and the texture already
 * has both if the multiplier does not flatten them.
 */
const CANOPY_C: [number, number, number] = [0.616, 0.588, 0.598];
const CANOPY_A = 0.92;
const VINE_C: [number, number, number] = [0.508, 0.496, 0.502];
const VINE_A = 0.92;

/** Radius around the hedgehog inside which foreground foliage thins to a wisp. */
const HERO_CLEAR = 300;
const HERO_CLEAR_A = 0.26;

/**
 * Texels borrowed for the two full-width washes (both live on the hills tex).
 *
 * The haze samples the single brightest fully-opaque texel in the whole hills
 * painting — rgb(255,226,65), luma 220, a lit ridge crown. This is where the
 * frame's highlights are *bought*: a tight ramp that only really arrives in the
 * last hundred units above the horizon, so about a tenth of the picture goes
 * genuinely hot instead of all of it going slightly warm. Tinted a shade toward
 * amber, because raw it is a yellow-green and it used to be laid at 0.44 over
 * half the screen — which is exactly the sickly wash the review saw.
 */
const HAZE_U = 740 / 1400;
const HAZE_V = 356 / 933; // brightest lit crown: hot gold, luma 220
const HAZE_C: [number, number, number] = [0.488, 0.462, 0.432];
const SCRIM_U = 700.5 / 1400;
const SCRIM_V = 513.5 / 933; // deep forest shadow: dark teal

/**
 * Two more washes, both sampled off the *ground* texture and drawn straight
 * after the ground tiles, so both cost nothing.
 *
 * The rake is the second highlight purchase: it samples the brightest opaque
 * texel on the slab — rgb(254,230,108), luma 226 — and lays it in a narrow,
 * near-opaque strip along the top of the soil, which is where a low sun
 * actually catches a bank. That strip is a few percent of the frame and it is
 * the hottest thing in it after the horizon itself.
 *
 * The dusk wash is the opposite purchase and comes off the same texture: the
 * slab's darkest texel, ramped in below the play line so the bottom edge of the
 * picture falls away into real shadow instead of holding one flat orange all
 * the way down. Shadow has to be *shaped* — dark at the bottom of the frame,
 * lit at the grass line, forty units apart.
 */
const RAKE_U = 0.8771;
const RAKE_V = 0.4748;
const RAKE_C: [number, number, number] = [0.459, 0.404, 0.229];
const DUSK_U = 0.5943;
const DUSK_V = 0.4898;
const DUSK_C: [number, number, number] = [0.459, 0.459, 0.487];

/**
 * The grass bank: the same slab, drawn a second time behind the walkable one.
 *
 * Two jobs. It is the ninth scroll rate, sitting between the treeline and the
 * ground; and its top edge — not the ground's — is what the sky is cut against,
 * so giving it a per-tile rise makes the skyline undulate without moving
 * `GROUND_Y` by a single unit. The rise is invisible as a seam because the tile
 * edge is a ragged fringe of blades, and because everything below the bank's
 * surface is covered by the ground slab in front of it.
 */
const BANK_SCALE = 0.7;
/** How far above the collision line the bank's own surface row sits. */
const BANK_LIFT = 34;
/** Peak-to-trough of the skyline rise, and how many tiles it takes to cycle. */
const BANK_RISE = 23;
const BANK_STEPS = 7;
/**
 * The same rise, a third as deep and three tiles out of phase, applied to the
 * walkable slab itself.
 *
 * The slab carries a second horizontal edge inside it — the line where lit
 * grass gives way to soil, about 40 units under the surface — and that one was
 * as straight as the first. Seven units of drift is far too little to matter to
 * anything that collides (the hedgehog's contact shadow moves by at most seven
 * units over a thousand of travel, under one percent of frame height) and quite
 * enough to stop the soil edge reading as a ruled line, especially with the
 * fringe rooted through it.
 */
const GROUND_RISE = 7;
const GROUND_PHASE = 3;
const BANK_C: [number, number, number] = [0.62, 0.588, 0.525];

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
 * A 1x1 frame that samples a single texel of `f`. Because u0 === u1 every
 * fragment reads the same point, so this is a flat colour quad that batches
 * with whatever texture is already bound — a full-screen wash for free.
 */
function solid(f: Frame, u: number, v: number): Frame {
  const uu = f.u0 + (f.u1 - f.u0) * u;
  const vv = f.v0 + (f.v1 - f.v0) * v;
  return { tex: f.tex, u0: uu, v0: vv, u1: uu, v1: vv, w: 1, h: 1, px: 0.5, py: 0.5 };
}

/** Same frame, pivot moved to the sprite's footprint so it plants and sways. */
function planted(f: Frame, bot: number): Frame {
  return { ...f, py: bot };
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

/** One slice of a drifting cirrus sheet. Kept in sky-`v` space so the sheet
 *  can be re-projected every frame against a viewport-sized sky. */
interface DriftBand {
  f: Frame;
  v0: number;
  v1: number;
  a: number;
}

interface Drift {
  bands: DriftBand[];
  wide: number;
  amp: number;
  rate: number;
  phase: number;
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

const SCATTER_COUNT = 26;

export class Parallax {
  // --- painted path -------------------------------------------------------
  private painted = false;

  private sky: Frame | null = null;
  private skirt: Frame | null = null;
  private skirtY = 0;
  private skirtSy = 1;
  private drifts: Drift[] = [];

  private mtn: FarLayer | null = null;
  private hill: FarLayer | null = null;

  private hazeF: Frame | null = null;
  private haze: Wash[] = [];
  private hazeC: [number, number, number] = [1, 1, 1];
  private scrimF: Frame | null = null;
  private scrim: Wash[] = [];
  private scrimC: [number, number, number] = [1, 0.82, 0.98];

  private sunCloud: Prop[] = [];
  private sunCloudSpan = 1;
  private sunCloudMargin = 0;

  private ridge: Prop[] = [];
  private ridgeSpan = 1;
  private ridgeMargin = 0;
  private tall: Prop[] = [];
  private tallSpan = 1;
  private tallMargin = 0;

  private groundF: Frame | null = null;
  private groundY = 0;
  private groundScale = 1;
  private groundTileW = 1;
  private bankY = 0;
  private bankTileW = 1;
  /** Per-tile skyline rise, indexed by tile number mod its length. */
  private bankRise: number[] = [];
  private rakeF: Frame | null = null;
  private rake: Wash[] = [];
  private duskF: Frame | null = null;
  private dusk: Wash[] = [];

  private near: Prop[] = [];
  private nearSpan = 1;
  private nearMargin = 0;
  private fringe: Prop[] = [];
  private fringeSpan = 1;
  private fringeMargin = 0;
  private fore: Prop[] = [];
  private foreSpan = 1;
  private foreMargin = 0;

  private canopy: Hang[] = [];
  private canopySpan = 1;
  private canopyMargin = 0;
  private vines: Hang[] = [];
  private vineSpan = 1;
  private vineMargin = 0;

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
  private clouds: { i: number; x: number; y: number; scale: number; speed: number; alpha: number }[] =
    [];

  private ready = false;

  // ---------------------------------------------------------------- init

  private init(ctx: Ctx): void {
    if (this.ready) return;
    this.ready = true;

    const a = ctx.assets;
    this.painted =
      a.has('sky_dusk') && a.has('mountains_far') && a.has('hills_mid') && a.has('ground_slab');

    if (this.painted) this.initPainted(ctx);
    this.initProcedural(ctx);
  }

  private initPainted(ctx: Ctx): void {
    const a = ctx.assets;
    // Own RNG: the scatter must be identical every boot without perturbing the
    // sequence any other system is drawing from.
    const rng = new Rng(0x5c47739a);

    // --- sky --------------------------------------------------------------
    const sky = a.get('sky_dusk')!;
    this.sky = sub(sky, SKY_U0, 1, SKY_V0, 1);
    // A stretched sliver of the last rows fills everything below the horizon;
    // it is almost entirely hidden by the ground and the word bar.
    this.skirt = sub(sky, SKY_U0, 1, 0.985, 1);
    this.skirtSy = 96 / this.skirt.h;
    this.skirtY = SKY_BOTTOM - 6 + 48;

    // Drifting cirrus: the same sky redrawn over its own natural v range, so
    // the gradient matches exactly and only the wisps move. Each sheet is
    // sliced and faded to nothing at both ends — a hard-edged sheet drawn at
    // even 0.2 alpha rules a visible line right across an otherwise smooth sky.
    // Both sheets live inside the visible range: a sheet whose v band starts
    // above SKY_V0 is projected to a negative screen y and simply never shows.
    this.drifts.length = 0;
    this.pushDrift(sky, 0.7, 0.86, 1.22, 88, 0.045, 0.22, 0);
    this.pushDrift(sky, 0.81, 0.97, 1.17, 58, 0.031, 0.16, 2.1);

    // --- far mountains ----------------------------------------------------
    const mtn = sub(a.get('mountains_far')!, MTN_U0, MTN_U1, 0, 1);
    const mtnH = mtn.h * MTN_SCALE;
    const mtnCy = FAR_BASE + 6 - (MTN_BOT - 0.5) * mtnH;
    // Peaks in violet dusk haze; base dissolved into the glow.
    //
    // Aerial perspective runs the *other* way at dusk: the rows nearest the
    // horizon are the ones the glow eats, so they end up the lightest and the
    // warmest. What that does NOT license is tinting them *neutral* — a
    // near-grey multiplier on a blue-grey painting is how both far layers came
    // out milky, a pale colourless mat across the middle of every frame. The
    // tint is a hue now as well as a level: mauve-violet at the crest so the
    // peaks belong to the sky they stand in, warm and low-alpha at the base so
    // they dissolve into the amber rather than into white.
    this.mtn = this.buildLayer(
      mtn, F_MTN, MTN_SCALE, mtnCy,
      0.34, 0.715,
      0.8, 0.22,
      1.72, 1.46, 1.7,
      1.95, 1.7, 1.24,
    );

    // --- mid hills --------------------------------------------------------
    const hil = a.get('hills_mid')!;
    const hilF = sub(hil, HIL_U0, HIL_U1, 0, 1);
    const hilH = hilF.h * HIL_SCALE;
    const hilCy = FAR_BASE - (HIL_BOT - 0.5) * hilH;
    // The hills are the frame's mid-distance and the only large cool mass in
    // it. Tinted blue-teal rather than lifted: a ridge that is a full step
    // *darker and bluer* than the magenta sky behind it is what makes the sky
    // read as sky. The old near-neutral 1.78/2.32 ramp put it at luma 140 in
    // the same hue family as everything else — depth by fog, with no colour to
    // the fog.
    this.hill = this.buildLayer(
      hilF, F_HIL, HIL_SCALE, hilCy,
      0.355, 0.632,
      0.92, 0.3,
      1.92, 1.84, 2.12,
      2.7, 2.45, 1.95,
    );

    // --- washes (ride along on the hills texture) -------------------------
    // The haze is the horizon glow, and it is where the frame's highlights come
    // from. It runs from a whisper at y=300 to near-opaque gold by y=545 — over
    // the sky and both far layers, but *under* the treeline, the bank and the
    // ground, so what it lights is exactly the strip of distance between the
    // hills' crest and the grass. That is about a fifth of a 16:9 frame taken
    // to luma 160-210, against four fifths that keep their own value. A lift
    // applied to the whole picture buys the same p95 and costs it every bit of
    // contrast it has; this buys it in one place, where a setting sun is.
    //
    // It bottoms out at y=576, which is below the bank's lowest surface and so
    // permanently covered — a wash that ends in open air ends in a ruled line.
    this.hazeF = solid(hil, HAZE_U, HAZE_V);
    this.hazeC = HAZE_C;
    this.buildWash(this.haze, 296, 576, 32, (u) =>
      0.96 * smoothstep(clamp((u - 0.1) / 0.55, 0, 1)),
    );
    this.scrimF = solid(hil, SCRIM_U, SCRIM_V);
    this.buildWash(
      this.scrim,
      40,
      606,
      44,
      (u) =>
        0.026 *
        smoothstep(clamp(u / 0.62, 0, 1)) *
        (1 - 0.55 * smoothstep(clamp((u - 0.8) / 0.2, 0, 1))),
    );

    // --- the sunlit cloud bank -------------------------------------------
    //
    // The third and largest highlight purchase, and the only one that is a
    // *thing* rather than a wash.
    //
    // Everything else in this frame is either the sky's own ramp, which tops
    // out around luma 200 where it is amber, or a layer tinted up off a
    // painting whose brightest texel is 226. That is enough for a warm frame
    // and not enough for a lit one: nothing in it clips, so nothing in it reads
    // as light rather than as surface. `cloud_a` has texels at luma 229 under a
    // soft alpha falloff, so a hot tint blows its cores to white while its
    // edges stay translucent — a couple of percent of the picture genuinely at
    // the top of the range, with no hard edge anywhere. It also gives the sky
    // something to *be* besides a gradient.
    //
    // Free. The clouds live on the same packed atlas as the trees and the
    // scatter, and this row is drawn immediately before the ridge, so the two
    // rows share one bind. They ride the mountains' 0.04 — no new scroll rate,
    // and at that distance they are effectively pinned to the sky anyway.
    this.sunCloudSpan = this.buildClouds(ctx, rng);
    this.sunCloudMargin = rowMargin(this.sunCloud);

    // --- ridge forest -----------------------------------------------------
    // Real trees, not a smudge cut out of the hills painting: they are on the
    // shared atlas now, so a whole forest edge costs the same one batch as the
    // tall row drawn immediately after it.
    //
    // Less than half the height it used to be, and with gaps you can see
    // through. At 210-520 units this row was a wall from the grass line to
    // y=40 and it hid *both* far layers completely: the 0.05 mountains and the
    // 0.12 hills were being drawn every frame and never appeared in a single
    // measured band. At 110-205 its crowns top out around y=360-440, which
    // leaves the hill crest above it and the mountain crest above that.
    // Tinted a cool blue-teal and drawn nearly opaque: this row sits directly
    // in front of the horizon glow, and a treeline that is *darker* than the
    // band behind it is worth more to the frame's range than one more lit
    // surface. The silhouettes are small and there are thirty of them, so the
    // shadow they add is broken up rather than a slab.
    this.ridgeSpan = this.buildRow(
      ctx, rng, this.ridge, TREES, RIDGE_IDX,
      30, 150, 430, 110, 205, 548, 566,
      2.06, 1.88, 1.9, 0, 0.5, 0.14,
    );
    this.ridgeMargin = rowMargin(this.ridge);

    // --- the horizon-breakers --------------------------------------------
    // Roughly one every three wall gaps. Thinned from 16 pieces on a ~900-unit
    // mean pitch to 12 on ~1250: at the old density the tall mass overlapped
    // itself across the whole frame, which is how a row meant to *punctuate*
    // the skyline ended up owning a third of it.
    this.tallSpan = this.buildRow(
      ctx, rng, this.tall, TREES, TALL_IDX,
      12, 780, 1560, 640, 1240, 548, 574,
      1.4, 1.3, 1.42, 0, 0.92, 0.1,
    );
    this.tallMargin = rowMargin(this.tall);

    // --- ground -----------------------------------------------------------
    const grd = a.get('ground_slab')!;
    this.groundF = sub(grd, GRD_U0, GRD_U1, GRD_V0, 1);
    this.groundScale = GRD_SCALE;
    this.groundTileW = this.groundF.w * GRD_SCALE;
    // Register the measured surface row onto GROUND_Y. The slab's own bottom
    // then lands near y=980, which is below `viewBottom` on every aspect the
    // renderer can produce (it never exceeds 720), so the soil bank always runs
    // off the bottom of the screen rather than ending in a horizontal cut.
    const gh = this.groundF.h * GRD_SCALE;
    const surf = (GRD_SURFACE - GRD_V0) / (1 - GRD_V0);
    this.groundY = GROUND_Y + (0.5 - surf) * gh;
    // The bank: the same registration arithmetic against a surface line lifted
    // BANK_LIFT above the collision one, at its own smaller scale — which also
    // gives it a different tile pitch, so the two grass edges never beat.
    const bh = this.groundF.h * BANK_SCALE;
    this.bankY = GROUND_Y - BANK_LIFT + (0.5 - surf) * bh;
    this.bankTileW = this.groundF.w * BANK_SCALE;
    this.bankRise.length = 0;
    for (let k = 0; k < BANK_STEPS; k++) {
      // Two harmonics so the skyline reads as terrain rather than as a wave,
      // and scaled so no two neighbouring tiles ever step by more than about
      // two thirds of the peak-to-trough — inside the depth of the fringe of
      // blades along the edge, which is what hides the join.
      const t = (2 * Math.PI * k) / BANK_STEPS;
      this.bankRise.push((Math.sin(t) * 0.68 + Math.sin(t * 2 + 1.1) * 0.32) * BANK_RISE);
    }
    this.rakeF = solid(grd, RAKE_U, RAKE_V);
    // Rises to nearly opaque within thirty units of the grass line and is gone
    // again a hundred below it. Ramps from exactly zero at both ends: a wash
    // that starts at a non-zero alpha draws a hard horizontal rule right across
    // the frame.
    this.buildWash(this.rake, 552, 1010, 34, (u) => {
      const rise = smoothstep(clamp(u / 0.075, 0, 1));
      const fall = 1 - smoothstep(clamp((u - 0.09) / 0.32, 0, 1));
      return 0.74 * rise * fall;
    });
    this.duskF = solid(grd, DUSK_U, DUSK_V);
    // ...and everything below that goes into the ground's own shadow. Reaches
    // its full depth around y=900, which is off the bottom of a 16:9 frame and
    // most of the way down a phone's, so the darkening always reads as a fall
    // rather than as a band.
    this.buildWash(this.dusk, 652, 1100, 24, (u) => 0.38 * smoothstep(clamp(u / 0.7, 0, 1)));

    // --- scatter rows -----------------------------------------------------
    this.nearSpan = this.buildRow(
      ctx, rng, this.near, PROPS, NEAR_IDX,
      34, 62, 230, 46, 128, GROUND_Y + 6, GROUND_Y + 20,
      2.78, 2.32, 1.62, 0.016, 1, 0.16,
    );
    this.nearMargin = rowMargin(this.near);
    // The fringe. Dense, short, and rooted below the line so it grows *through*
    // it — the one thing the review asked for by name. Same atlas as the row
    // above, drawn immediately after it, so the whole ground storey is still
    // one batch however many blades are in it.
    this.fringeSpan = this.buildRow(
      ctx, rng, this.fringe, PROPS, FRINGE_IDX,
      50, 38, 142, 40, 112, GROUND_Y + 28, GROUND_Y + 72,
      3.42, 2.82, 1.76, 0.03, 0.96, 0.12,
    );
    this.fringeMargin = rowMargin(this.fringe);
    // Fewer, larger, and planted lower than they used to be: the review found
    // letters 40% buried and the hedgehog invisible behind this row. It now
    // tops out below the block band, and `drawFore` thins it further wherever
    // it crosses the hero's column.
    this.foreSpan = this.buildRow(
      ctx, rng, this.fore, PROPS, FORE_IDX,
      13, 300, 760, 200, 420, 790, 930,
      1, 0.93, 1.1, 0.042, 0.96, 0.1,
    );
    this.foreMargin = rowMargin(this.fore);

    // --- the over-frame band ---------------------------------------------
    if (a.has('canopy_overhang')) {
      const cf = sub(a.get('canopy_overhang')!, CAN_U0, CAN_U1, CAN_V0, CAN_V1, 0);
      const aspect = cf.w / cf.h;
      let x = 0;
      let w = 0;
      // Pitched well inside a tile width so neighbours always overlap: the
      // band has to read as a continuous ceiling of leaf, and a gap in it is a
      // hole straight back to the empty sky this layer exists to cover.
      for (let i = 0; i < 13; i++) {
        const h = rng.range(186, 248);
        w = h * aspect;
        x += w * rng.range(0.4, 0.6);
        this.canopy.push({
          f: cf,
          x,
          w,
          h,
          flip: rng.next() > 0.5 ? 1 : -1,
          // Sag is shallower than it was: the band is thinner now, and a piece
          // lifted nearly half a hang above the floor left the strip it is
          // supposed to own measuring the tall trees behind it instead.
          sag: rng.range(-0.07, 0.05),
          r: CANOPY_C[0],
          g: CANOPY_C[1],
          b: CANOPY_C[2],
          a: CANOPY_A,
        });
      }
      this.canopySpan = x + w * 0.66;
      this.canopyMargin = hangMargin(this.canopy);
    }
    if (a.has('vines_hanging')) {
      const raw = a.get('vines_hanging')!;
      let x = 0;
      let w = 0;
      for (let i = 0; i < 8; i++) {
        const u = VINE_U[rng.int(0, VINE_U.length)];
        const vf = sub(raw, u[0], u[1], VINE_V0, VINE_V1, 0);
        const h = rng.range(340, 470);
        w = h * (vf.w / vf.h);
        x += rng.range(520, 1180);
        this.vines.push({
          f: vf,
          x,
          w,
          h,
          flip: rng.next() > 0.5 ? 1 : -1,
          sag: rng.range(-0.3, 0),
          r: VINE_C[0],
          g: VINE_C[1],
          b: VINE_C[2],
          a: VINE_A,
        });
      }
      this.vineSpan = x + rng.range(700, 1400);
      this.vineMargin = hangMargin(this.vines);
    }
  }

  private pushDrift(
    sky: Frame,
    v0: number,
    v1: number,
    wide: number,
    amp: number,
    rate: number,
    peak: number,
    phase: number,
  ): void {
    const n = 7;
    const bands: DriftBand[] = [];
    for (let k = 0; k < n; k++) {
      const va = v0 + ((v1 - v0) * k) / n;
      const vb = v0 + ((v1 - v0) * (k + 1)) / n;
      bands.push({
        f: sub(sky, SKY_U0, 1, va, vb),
        v0: va,
        v1: vb,
        // Sine taper: zero at both ends, so the sheet has no edge to see.
        a: peak * Math.sin((Math.PI * (k + 0.5)) / n),
      });
    }
    this.drifts.push({ bands, wide, amp, rate, phase });
  }

  /**
   * Slice a full-width layer into haze-graded horizontal bands.
   *
   * `f` must already be cropped to its opaque extent — the repeat pitch is
   * taken straight from `f.w`, so tiles abut exactly and alternate tiles mirror
   * about the shared edge column. That is the whole seam story: no shrink, no
   * overlap, no double-composited strip.
   */
  private buildLayer(
    f: Frame,
    factor: number,
    scale: number,
    cy: number,
    v0: number,
    v1: number,
    aTop: number,
    aBot: number,
    rTop: number,
    gTop: number,
    bTop: number,
    rBot: number,
    gBot: number,
    bBot: number,
  ): FarLayer {
    const h = f.h * scale;
    const tileW = f.w * scale;
    const bands: Band[] = [];
    for (let k = 0; k < BANDS; k++) {
      const va = v0 + ((v1 - v0) * k) / BANDS;
      const vb = v0 + ((v1 - v0) * (k + 1)) / BANDS;
      const t = k / (BANDS - 1);
      bands.push({
        f: sub(f, 0, 1, va, vb),
        y: cy + ((va + vb) * 0.5 - 0.5) * h,
        r: lerp(rTop, rBot, t),
        g: lerp(gTop, gBot, t),
        b: lerp(bTop, bBot, t),
        a: lerp(aTop, aBot, t),
      });
    }
    return { factor, scale, tileW, bands };
  }

  private buildWash(
    out: Wash[],
    y0: number,
    y1: number,
    n: number,
    curve: (u: number) => number,
  ): void {
    // Bands abut exactly. Overlapping them by even a pixel would double the
    // alpha along the join and draw a visible rule across the whole screen;
    // sharing an edge cannot gap, because the two quads are built from the
    // same arithmetic and no pixel centre falls inside the ULP between them.
    out.length = 0;
    const step = (y1 - y0) / n;
    for (let k = 0; k < n; k++) {
      out.push({ y: y0 + step * (k + 0.5), h: step, a: curve((k + 0.5) / n) });
    }
  }

  /**
   * Lay out the sunlit cloud bank. Returns the wrap span, or leaves the row
   * empty (and the frame one highlight poorer, but correct) if neither cloud
   * asset was generated.
   *
   * Kept low and to the warm end of the band: high cloud would be lit from
   * underneath at this hour and would also sit squarely behind the letter
   * blocks. These hug the horizon, where they belong and where the treeline
   * and the hills give them something to be in front of.
   */
  private buildClouds(ctx: Ctx, rng: Rng): number {
    const ids = ['cloud_a', 'cloud_b'].filter((id) => ctx.assets.has(id));
    if (!ids.length) return 1;
    let x = 0;
    for (let i = 0; i < 17; i++) {
      x += rng.range(390, 1080);
      const f = ctx.assets.get(ids[rng.int(0, ids.length)])!;
      const h = rng.range(96, 258);
      const s = h / f.h;
      // Hotter the lower it sits: these are lit from below the horizon.
      const t = clamp((rng.range(296, 474) - 296) / 178, 0, 1);
      const k = lerp(1.22, 0.86, t);
      this.sunCloud.push({
        f,
        x,
        y: lerp(296, 474, t),
        sx: rng.next() > 0.5 ? s : -s,
        sy: s,
        r: 2.46 * k,
        g: 2 * k,
        b: 1.22 * k,
        a: rng.range(0.84, 0.98),
        amp: 0,
        rate: 0,
        phase: 0,
      });
    }
    return x + rng.range(390, 1080);
  }

  /** Lay out one scatter row. Returns the wrap span. */
  private buildRow(
    ctx: Ctx,
    rng: Rng,
    out: Prop[],
    specs: Spec[],
    pool: number[],
    count: number,
    gapMin: number,
    gapMax: number,
    hMin: number,
    hMax: number,
    yMin: number,
    yMax: number,
    tr: number,
    tg: number,
    tb: number,
    sway: number,
    alpha: number,
    /** How much darker the row gets as a piece grows. 0 = flat lighting. */
    grade: number,
  ): number {
    let x = 0;
    for (let i = 0; i < count; i++) {
      x += rng.next() < 0.22 ? rng.range(gapMin * 0.32, gapMin * 0.8) : rng.range(gapMin, gapMax);
      const spec = specs[pool[rng.int(0, pool.length)]];
      const raw = ctx.assets.get(spec.id);
      if (!raw) continue;
      const h = rng.range(hMin, hMax);
      const s = h / (raw.h * spec.span);
      const hn = clamp((h - hMin) / (hMax - hMin), 0, 1);
      // Bigger reads as nearer: plant it lower down the slope, and shift its
      // value along `grade` as it grows.
      const k = lerp(1 + grade, 1 - grade, hn);
      const warm = rng.range(0.9, 1.12);
      out.push({
        f: planted(raw, spec.bot),
        x,
        y: lerp(yMin, yMax, hn) + rng.range(-5, 5),
        sx: rng.next() > 0.5 ? s : -s,
        sy: s,
        // Ceiling, not a level: the prop paintings run luma 56-107, so a row
        // meant to be sun-struck needs a multiplier around 3 and the old cap of
        // 1.4 silently threw every one of those away — the grass line asked to
        // be lit and got 1.4x a dark green whatever it asked for. 3.6 is high
        // enough that no row currently hits it and low enough that a typo
        // cannot blow a whole layer to white.
        r: clamp(tr * k * warm, 0, 3.6),
        g: clamp(tg * k, 0, 3.6),
        b: clamp(tb * k * (2 - warm), 0, 3.6),
        a: alpha,
        amp: sway * rng.range(0.55, 1.5),
        rate: rng.range(0.5, 1.25),
        phase: rng.range(0, 6.283),
      });
    }
    return x + rng.range(gapMin, gapMax);
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
      this.clouds.push({
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
    for (const c of this.clouds) {
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
    this.init(ctx);
    if (!this.painted) {
      this.drawProcedural(ctx, distance);
      return;
    }

    const r = ctx.r;
    const t = ctx.time;
    const still = ctx.reducedMotion;

    // 1 -------------------------------------------------------------- sky
    // Sized from the live viewport, not the design rect: the stage no longer
    // letterboxes, so on a wide monitor or a tall phone the sky must stretch to
    // the real edges or its border shows as a band across the screen.
    const vl = r.viewLeft;
    const vr = r.viewRight;
    const cx = (vl + vr) * 0.5;
    const spanW = vr - vl + 8;
    const skyTop = Math.min(r.viewTop, 0);
    const skySpanH = SKY_BOTTOM - skyTop;
    const sk = this.sky!;
    const skySx = spanW / sk.w;
    const skySy = skySpanH / sk.h;
    const skyCy = skyTop + skySpanH * 0.5;
    const s1 = SKY_C;
    const s2 = SKY_C2;
    r.draw(sk, cx, skyCy, skySx, skySy, 0, s1[0], s1[1], s1[2], 1);
    // Two half-strength copies, offset by about half a gradient step. The
    // source is an 8-bit ramp and stretching it over a phone's worth of sky
    // made every step visible as a stripe; averaging three taps dithers the
    // staircase away for two sprites and no extra draw call.
    const tap = skySpanH * 0.011;
    r.draw(sk, cx, skyCy - tap, skySx, skySy, 0, s1[0], s1[1], s1[2], 0.3);
    r.draw(sk, cx, skyCy + tap, skySx, skySy, 0, s2[0], s2[1], s2[2], 0.3);
    r.draw(this.skirt!, cx, this.skirtY, spanW / this.skirt!.w, this.skirtSy, 0, s1[0], s1[1], s1[2], 1);

    const skyScale = skySpanH / (1 - SKY_V0);
    for (let i = 0; i < this.drifts.length; i++) {
      const d = this.drifts[i];
      const x = cx + (still ? 0 : Math.sin(t * d.rate + d.phase) * d.amp);
      for (let k = 0; k < d.bands.length; k++) {
        const b = d.bands[k];
        const y0 = skyTop + (b.v0 - SKY_V0) * skyScale;
        const y1 = skyTop + (b.v1 - SKY_V0) * skyScale;
        // Tinted like the sky it lies on. Drawn untinted, as it used to be,
        // each sheet pulled the whole sky back toward the raw painting: two
        // sheets at 0.22 and 0.16 alpha cost about 7% of every sky pixel, and
        // 7% off a highlight is the difference between a highlight and a
        // mid-tone.
        r.draw(b.f, x, (y0 + y1) * 0.5, (spanW * d.wide) / b.f.w, (y1 - y0) / b.f.h, 0, s2[0], s2[1] * 0.99, s2[2], b.a);
      }
    }

    // 2 -------------------------------------------------- far mountains
    this.drawLayer(r, this.mtn!, distance);

    // 3 ----------------------------- mid hills + the two washes
    this.drawLayer(r, this.hill!, distance);
    const hz = this.hazeC;
    for (let i = 0; i < this.haze.length; i++) {
      const w = this.haze[i];
      r.draw(this.hazeF!, cx, w.y, spanW, w.h, 0, hz[0], hz[1], hz[2], w.a);
    }
    const sc = this.scrimC;
    for (let i = 0; i < this.scrim.length; i++) {
      const w = this.scrim[i];
      r.draw(this.scrimF!, cx, w.y, spanW, w.h, 0, sc[0], sc[1], sc[2], w.a);
    }

    // 4 ---------------------------------- ridge forest + horizon-breakers
    // Both on the shared atlas, drawn back to back so they cost one bind. They
    // sit *behind* the ground slab, which is what hides their footings.
    this.drawRow(ctx, this.sunCloud, this.sunCloudSpan, this.sunCloudMargin, F_MTN, distance, false, 1);
    this.drawRow(ctx, this.ridge, this.ridgeSpan, this.ridgeMargin, F_RIDGE, distance, !still, 1);
    this.drawRow(ctx, this.tall, this.tallSpan, this.tallMargin, F_TALL, distance, !still, this.tallLift(r));

    // 5 ------------------------------------------- grass bank + ground
    // Both are the same texture, drawn back to back, so the bank is free.
    const g = this.groundF!;
    const bw = this.bankTileW;
    const boff = distance * F_BANK;
    const nRise = this.bankRise.length;
    const b0 = Math.floor((boff + vl) / bw) - 1;
    const b1 = Math.ceil((boff + vr) / bw) + 1;
    for (let idx = b0; idx <= b1; idx++) {
      const x = idx * bw - boff + bw * 0.5;
      const k = (((idx % nRise) + nRise) % nRise) | 0;
      const flip = (((idx % 2) + 2) % 2) === 0 ? BANK_SCALE : -BANK_SCALE;
      r.draw(g, x, this.bankY + this.bankRise[k], flip, BANK_SCALE, 0, BANK_C[0], BANK_C[1], BANK_C[2], 1);
    }
    const gw = this.groundTileW;
    const g0 = Math.floor((distance + vl) / gw) - 1;
    const g1 = Math.ceil((distance + vr) / gw) + 1;
    const gRise = GROUND_RISE / BANK_RISE;
    for (let idx = g0; idx <= g1; idx++) {
      const x = idx * gw - distance + gw * 0.5;
      const j = idx + GROUND_PHASE;
      const k = (((j % nRise) + nRise) % nRise) | 0;
      const flip = (((idx % 2) + 2) % 2) === 0 ? 1 : -1;
      const y = this.groundY + this.bankRise[k] * gRise;
      r.draw(g, x, y, this.groundScale * flip, this.groundScale, 0, 3.46, 2.92, 2.1, 1);
    }
    const rk = RAKE_C;
    for (let i = 0; i < this.rake.length; i++) {
      const w = this.rake[i];
      r.draw(this.rakeF!, cx, w.y, spanW, w.h, 0, rk[0], rk[1], rk[2], w.a);
    }
    const dk = DUSK_C;
    for (let i = 0; i < this.dusk.length; i++) {
      const w = this.dusk[i];
      r.draw(this.duskF!, cx, w.y, spanW, w.h, 0, dk[0], dk[1], dk[2], w.a);
    }

    // 6 --------------------- near scatter + grass fringe (shared atlas)
    this.drawRow(ctx, this.near, this.nearSpan, this.nearMargin, F_NEAR, distance, !still, 1);
    this.drawRow(ctx, this.fringe, this.fringeSpan, this.fringeMargin, F_NEAR, distance, !still, 1);
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
    this.drawHang(ctx, this.vines, this.vineSpan, this.vineMargin, F_VINE, distance, VINE_FLOOR, VINE_DEPTH, VINE_MIN_H);
    this.drawHang(ctx, this.canopy, this.canopySpan, this.canopyMargin, F_CANOPY, distance, CANOPY_FLOOR, CANOPY_DEPTH, CANOPY_MIN_H);
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

  private drawLayer(r: Ctx['r'], l: FarLayer, distance: number): void {
    const off = distance * l.factor;
    const vl = r.viewLeft;
    const vr = r.viewRight;
    // Indexed off the *live* left edge, not off zero. On anything wider than
    // 16:9 `viewLeft` is negative, and a loop that started at the tile covering
    // x=0 simply left the strip to its left unpainted.
    const i0 = Math.floor((off + vl) / l.tileW) - 1;
    const i1 = Math.ceil((off + vr) / l.tileW) + 1;
    for (let idx = i0; idx <= i1; idx++) {
      const x = idx * l.tileW - off + l.tileW * 0.5;
      // Alternate tiles mirror, which both doubles the repeat period and makes
      // every join a reflection about a shared column of texels.
      const flip = (((idx % 2) + 2) % 2) === 0 ? l.scale : -l.scale;
      for (let j = 0; j < l.bands.length; j++) {
        const b = l.bands[j];
        r.draw(b.f, x, b.y, flip, l.scale, 0, b.r, b.g, b.b, b.a);
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
    list: Prop[],
    span: number,
    margin: number,
    factor: number,
    distance: number,
    sway: boolean,
    lift: number,
  ): void {
    const r = ctx.r;
    const t = ctx.time;
    const left = r.viewLeft - margin * lift - 8;
    const right = r.viewRight + margin * lift + 8;
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
    const r = ctx.r;
    const t = ctx.time;
    const still = ctx.reducedMotion;
    const left = r.viewLeft - this.foreMargin - 8;
    const right = r.viewRight + this.foreMargin + 8;
    const off = distance * F_FORE + left;
    for (let i = 0; i < this.fore.length; i++) {
      const p = this.fore[i];
      let x = (p.x - off) % this.foreSpan;
      if (x < 0) x += this.foreSpan;
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
   * `floorY` is the hard limit: whatever the screen shape, the fringe stops
   * above the letter blocks. `depth` is the share of the live viewport it would
   * *like* to fill, and `minH` the shortest piece in the band — a piece is
   * scaled up until it is at least as tall as the hang, so its flat top edge is
   * always off-screen and the band never reads as a floating strip.
   */
  private drawHang(
    ctx: Ctx,
    list: Hang[],
    span: number,
    margin: number,
    factor: number,
    distance: number,
    floorY: number,
    depth: number,
    minH: number,
  ): void {
    if (!list.length) return;
    const r = ctx.r;
    const vt = r.viewTop;
    const bottom = Math.min(vt + (r.viewBottom - vt) * depth, floorY);
    const mul = Math.max(1, (bottom - vt) / minH);
    const left = r.viewLeft - margin * mul - 8;
    const right = r.viewRight + margin * mul + 8;
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
    for (const c of this.clouds) {
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
