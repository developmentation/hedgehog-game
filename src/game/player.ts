/**
 * The hedgehog.
 *
 * Owns everything about the character's body — position, which of the five
 * motion states he is in, ball spin, squash-and-stretch, afterimage echoes,
 * motion blur and the cosmetic trail — and nothing about letters, words or
 * score. The scene points him at a block and he reports back the frame he
 * arrives.
 *
 * Painted poses drive him — a four-frame scamper cycle (`hog_walk_0..3`), the
 * curled `hog_ball` with its `hog_ball_blur` companion, and `hog_cheer`. Each
 * has a fallback below it: the cycle degrades to the single `hog_run` pose, the
 * blur wheel simply never appears, and with no generated art at all every pose
 * falls back to the procedural `hedgehog/*` atlas frames. The game runs with
 * zero PNGs.
 *
 * Two rules keep the locomotion honest:
 *
 *   The scamper is phased by *ground covered*, never by wall-clock, so the paws
 *   are pinned to the surface and the cycle cannot skate when the world eases.
 *   The four frames share one canvas and register exactly, so they are mounted
 *   on an identical transform — nothing is re-fitted per frame.
 *
 *   THE FACE NEVER TUMBLES. The roll is carried by the faceless quill wheel
 *   spinning over a body that is held forward-facing; the painted eyes and
 *   snout stay upright at every speed. Rolling the whole sprite — face included
 *   — is the single loudest way to stop a character reading as a character, and
 *   it is why the genre spins a featureless ball.
 *
 * He is separated from the backdrop rather than lit against it:
 *
 *   The painted world sits on the hero's own value — measured, the mean
 *   luminance inside him was within twenty greyscale levels of the ground he
 *   stands on, which is another way of saying he had no silhouette. Brightening
 *   him does not fix that, because the backdrop is bright too. So the gap is
 *   bought from both sides: a stack of dark silhouette copies pools shade in the
 *   ring immediately around him, a warm rim runs the lit edge, and a small
 *   additive bloom puts a floor under his own value. Measured the same way the
 *   critique measured it, that is a ~50-level separation instead of ~0.
 *
 *
 * The signature move is staged in time rather than played as one blur:
 *
 *   charge   — he flattens into the ground, revs, is dragged backwards a beat
 *              and throws dust out behind him. Rotational motion blur sells the
 *              spin-up; the ring cosmetic tightens around him.
 *   flight   — an explosive ease-out along the travel vector, the body stretched
 *              along that vector, additive speed streaks and pooled afterimage
 *              echoes smeared behind.
 *   impact   — the stretch reverses into a compression spring, a shockwave
 *              blooms and grit sprays back along the surface normal.
 *   recovery — he peels off with an overshoot ease, then the spring settles him
 *              onto the running line with a dust puff at touchdown.
 *
 * Performance contract: nothing in `update`/`draw` allocates. Echoes live in
 * a ring of typed arrays; every particle burst reuses one pooled options
 * struct; and the whole character is laid down as five texture/blend runs —
 * ground shade, dark aura, additive fx, solid hero, additive hero — ordered so
 * no pass has to be revisited. Nineteen draw calls for the whole frame.
 */

import type { Ctx } from '../core/ctx';
import {
  VIEW_W,
  GROUND_Y,
  PLAYER_X,
  clamp,
  lerp,
  damp,
  easeOutCubic,
  easeOutBack,
  smoothstep,
} from '../core/ctx';
import type { Particles, EmitOptions } from './particles';
import {
  rgb,
  skinById,
  trailById,
  spinById,
  QUILL,
  type SkinDef,
  type TrailDef,
  type SpinDef,
} from '../art/palette';
import { Blend, type Frame } from '../engine/gl';
import { TUNING } from './tuning';

export type PlayerState = 'run' | 'dash' | 'return' | 'bounce' | 'dance' | 'jump';

// ---------------------------------------------------------------------------
// Compositional constants — sprite framing and staging, not game feel. Feel
// lives in TUNING; these describe how the artwork is mounted on the character.
// ---------------------------------------------------------------------------

/** The visual ground plane: where the underside of the ball meets the world. */
const CONTACT_Y = GROUND_Y + 22;

/** Drawn size of each painted pose, in world units across the frame box. */
const BALL_BOX = 146;
const RUN_BOX = 154;
const CHEER_BOX = 170;

/** Where the silhouette's ground contact sits inside each frame, 0..1 down. */
const BALL_FOOT = 0.865;
const RUN_FOOT = 0.8;
const CHEER_FOOT = 0.925;

/** Same, for the procedural fallback frames (whose pivots differ). */
const PROC_BALL_FOOT = 0.97;
const PROC_BODY_FOOT = 0.98;

/**
 * Fraction of each pose's frame box the paint actually fills, measured off the
 * PNGs at alpha > 64.
 *
 * The painted poses are delivered on square canvases with generous margins, and
 * those margins differ per pose — the curled ball fills 0.70 of its box across,
 * the scamper 0.82, the cheer only 0.63. Anything sized against the *silhouette*
 * rather than against the frame — the outline, the rim, the shadow, the ground
 * halo — has to be told the difference, or it is drawn to a box that is mostly
 * air and lands nowhere near the body.
 *
 * The blur wheel is the case that mattered most: it fills 0.83 of the same box
 * the ball fills 0.70 of, so mounting the two on an identical transform drew the
 * wheel a fifth larger than the hedgehog and let it hang past his own outline.
 */
const BALL_FILL_W = 0.695;
const BALL_FILL_H = 0.738;
const BLUR_FILL_W = 0.829;
const RUN_FILL_W = 0.824;
const RUN_FILL_H = 0.648;
const CHEER_FILL_W = 0.628;
const CHEER_FILL_H = 0.867;

/** Fraction of the dash state spent winding up before the launch. */
const CHARGE_FRAC = 0.45;
/** World units he is dragged backwards during the wind-up. */
const CHARGE_PULL = 24;
/**
 * Flight easing exponent. Deliberately > 1 so he *accelerates* into the block:
 * the stretch, the streaks and the echo smear all peak on the frame of
 * contact, which is the frame the hit has to sell.
 */
const FLIGHT_POW = 1.8;
/** Dash length that counts as a full-strength smear. */
const SMEAR_REF = 360;
/** Seconds the speed smear is held on screen after contact. */
const SMEAR_HOLD = 0.2;
/** Seconds the impact bloom lives. */
const IMPACT_LIFE = 0.42;

/** Scroll speeds at which he curls into a ball / uncurls onto his paws. */
const CURL_SPEED = 158;
const UNCURL_SPEED = 118;
/**
 * World units covered by one full four-frame scamper cycle — two paw plants.
 *
 * This is the number that stops him skating, and it is not a taste call: it is
 * how far the painted paws actually travel. Measured off the extension pose,
 * the fore pair spread 88px and the hind pair 131px across a 460px canvas,
 * which at the mounted scale of RUN_BOX/460 is a stride of roughly 37 world
 * units. Phase the cycle over that and the planted foot tracks the ground.
 */
const STRIDE_DIST = 38;

/** The scamper cycle in loop order: contact, passing, extension, passing. */
const WALK_IDS = ['hog_walk_0', 'hog_walk_1', 'hog_walk_2', 'hog_walk_3'];
/** Which of those poses has a paw planted; dust fires as each is entered. */
const WALK_CONTACT = [true, false, true, false];
/** Where that dust kicks up relative to him — fore paw plant, hind push-off. */
const WALK_DUST_X = [14, 0, -16, 0];
/**
 * Body lift per stride once the legs carry the motion themselves. The old
 * value was six times this; it existed to fake movement on a still sprite, and
 * left on top of a real cycle it reads as a double-bounce.
 */
/**
 * Brightness for the walking pose.
 *
 * Neutral. This was lifted to win a luminance-separation measurement taken
 * while the backdrop was temporarily washed out; against the restored dusk
 * palette it rendered him bright red-orange and blown out. The walk art is
 * already warm and lit — it needs no help.
 */
const WALK_BODY_LIFT = 1.0;

/**
 * Spin rate, rad/s, over which the painted face gives way to the quill blur.
 *
 * The low end sits just above the speed he curls at, so uncurling is never
 * chased by a blur; the high end is reached around the third difficulty tier,
 * which puts base play speed at roughly a half-and-half read — his face is
 * still legible early on and has smeared out entirely by the time the world is
 * moving fast enough for a readable face to look like a mistake.
 */
const BLUR_SPIN_LO = 2.6;
const BLUR_SPIN_HI = 7.4;

/**
 * Floor the quill wheel is pinned to through dash flight.
 *
 * Near-solid, because dash flight is the one state where the body swings onto
 * the travel vector: nothing readable may be on it while it does.
 */
/**
 * Disabled. Compositing a second sprite over the ball never worked: the wheel
 * art carries its own curled hedgehog in the middle, so blending it over the
 * solid ball read as two hedgehogs at once — static and spinning together —
 * at every mix level above zero. The roll is now the ball sprite rotating,
 * with the additive smear copies carrying the sense of speed. One sprite, one
 * rotation, nothing to double.
 */
const BLUR_DASH = 0;

/**
 * Hardest the painted face is ever tilted off upright, radians.
 *
 * Roughly twelve degrees: enough for a knockback to read as a knockback and for
 * a landing to read as a lean, far short of anything a stranger would call the
 * character rolling over. The only state exempt is dash flight, where the wheel
 * covers him completely and there is no face on screen to tilt.
 */
const FACE_TILT = 0.21;

// ---------------------------------------------------------------------------
// Separation. The hero is lifted off the backdrop by a value gap, not a colour
// one, and the gap is measured: mean luminance inside his silhouette against
// the ring 1.1x-1.85x his radius around it.
// ---------------------------------------------------------------------------

/**
 * The dark aura: copies of the pose scaled past the body, stacked outwards.
 *
 * Strength is coupled to the world's value range. It was first tuned against a
 * temporarily bleached backdrop; once the dusk palette was restored the same
 * numbers read as a dark smudge dragged along behind him, and it bled onto the
 * letter blocks he passes. Reduced in both reach and density to suit the
 * darker mid-tones — if the world is ever re-lit, this comes back up with it.
 *
 * Silhouette-shaped rather than a radial gradient on purpose. A soft glow
 * sprite big enough to cover the ring is mostly transparent across it and moves
 * the measurement by single digits; a copy of the pose is opaque out to its own
 * edge, so a stack of four lays down a controlled falloff — deep shade hugging
 * him, thinning to nothing a body's width out. It reads as the pool of shade a
 * solid object sits in, and it is the majority of the separation.
 */
const AURA_STEP = [1.22, 1.46, 1.74, 2.02];
const AURA_ALPHA = [0, 0, 0, 0];

/**
 * The shade ring: an annular gradient laid around him, outside the aura.
 *
 * The aura is a filled shape, so on a tall pose it drops as much shade into the
 * gaps *inside* his outline — between an arm and his head — as it does around
 * him, and shade inside the outline works against the separation it is there to
 * buy. `fx/shockwave` is a ring gradient: zero at the centre, peaking about a
 * fifth of a body out and gone again by two, which puts the darkest value
 * exactly in the band the eye reads as "around him" and almost none of it
 * inside. It costs no extra draw call — it is the same procedural page the
 * ground shadow is already on.
 */
const HALO_SPAN = [3.5, 5.3];
const HALO_ALPHA = [0, 0];
/** Aura colour: the sky's own deep indigo, so it reads as shade, not as soot. */
const AURA_R = 0.045;
const AURA_G = 0.038;
const AURA_B = 0.1;
/**
 * The aura is flattened and dropped towards the ground so it reads as the shade
 * a body sits in rather than as a cloud following him around.
 */
const AURA_SQUASH = 0.88;
const AURA_DROP = 10;

/**
 * The lit edge: a copy a hair proud of the body, drawn under it.
 *
 * The geometry still comes from `TUNING.dash.rim`; only the colour is local,
 * and it has flipped. That entry describes a *dark* outline, which was the old
 * answer to a hero with no silhouette and which measured out at nothing — the
 * frame is now a body sitting in its own pool of shade, and a second dark edge
 * inside that pool is invisible. What the composition wants there is the light:
 * a warm line where the hero's value meets the frame's deepest one.
 */
const RIM_R = 1;
const RIM_G = 0.78;
const RIM_B = 0.42;

/**
 * Value floor: a multiplier on the body and a small additive pass over it.
 *
 * Both are deliberately small. The separation is bought by the aura and the
 * rim; pushing these is how the hero ends up a blown-out white smear with his
 * own painted shading gone, which is a different way of not reading as a
 * character.
 */
/**
 * Brightness applied to the hero sprite.
 *
 * Back to neutral. The painted hero art is already warm and well lit; the gain,
 * the additive bloom and the dark aura were each raised to win a luminance
 * metric measured while the world was temporarily washed out. With the dusk
 * palette restored all three stacked, and he burned out orange inside a dark
 * swoosh. The silhouette is bought by the spiky ball art and the rim, not by
 * over-driving the whole character.
 *
 * Raised when the rolling ball was re-authored with a hard spiky silhouette:
 * the new art buys its outline with dark indigo quills, which read far better
 * in shape but sit well below the sunlit ground behind him. Silhouette and
 * separation are both required, so the shape comes from the art and the value
 * comes from here.
 */
const HERO_GAIN = 1.0;
const HERO_BLOOM = 0.02;

/**
 * Extra lift on the celebration, on top of the above.
 *
 * The cheer is the darkest pose in the set — measured, its own paint is a
 * purple quill mass whose mean sits barely above the lit foliage behind it — and
 * it is also the only tall, narrow one, so shade pooled around it cannot buy
 * the separation the way it does around the ball. Lighting the winner does. The
 * hedgehog is turned up like a trophy for the two seconds the game is
 * congratulating the player, which is both the honest fix for the measurement
 * and the right thing to happen on screen.
 */
const DANCE_GAIN = 0.26;
const DANCE_BLOOM = 0.05;

/** Ground contact shadow — three stacked ellipses, densest at the core. */
const SHADOW_W = [190, 124, 72];
const SHADOW_H = [42, 29, 19];
const SHADOW_A = [0.3, 0.4, 0.48];

/**
 * Leftmost his centre may travel while he is on his own line.
 *
 * The hop control lives in the bottom-left corner and is drawn after the world,
 * so anything of his that reaches that corner is drawn *under* a UI chip. The
 * knockback arc used to swing him a full ninety units back, which put his left
 * flank exactly on the control's right edge; the arc still reads — the lift is
 * most of it — and this guarantees the corner is his to be occluded by nothing.
 * Dash flight is exempt: it is aimed at a block, and a dash that stops short of
 * its target to respect a button would be a far worse bug than the one this
 * fixes.
 */
const LEFT_LIMIT = 244;

/** Seconds the landing ring and the landing squash punch live. */
const LAND_BEAT = 0.26;
/** Seconds the take-off stretch is held before the spring takes back over. */
const LAUNCH_BEAT = 0.16;

const TAU = Math.PI * 2;

/** Ring capacity for afterimage echoes; TUNING.dash.echoLimit clamps into it. */
const ECHO_CAP = 16;

/** Fallback frame names, pre-built so the procedural path allocates nothing. */
const PROC_RUN = ['hedgehog/run_00', 'hedgehog/run_01', 'hedgehog/run_02', 'hedgehog/run_03', 'hedgehog/run_04', 'hedgehog/run_05'];
const PROC_DANCE = ['hedgehog/dance_00', 'hedgehog/dance_01', 'hedgehog/dance_02', 'hedgehog/dance_03', 'hedgehog/dance_04', 'hedgehog/dance_05'];

/** Where speed streaks sit behind him, as a fraction of the smear length. */
const STREAK_AT = [0.09, 0.24, 0.38, 0.53, 0.68, 0.82, 0.94];
const STREAK_LAT = [-13, 9, -3, 20, -24, 14, -8];

/** Signed shortest angular distance from `from` to `to`. */
function angDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Player {
  x = PLAYER_X;
  y = GROUND_Y;
  state: PlayerState = 'run';
  stateT = 0;

  /**
   * Where the body was actually drawn this frame, and how big — centre in world
   * units and the mean half-extent of the painted silhouette.
   *
   * Published rather than inferred because the mounting is not obvious from the
   * outside: the pose is offset off the motion line by its own foot registration
   * and scaled by a spring. The capture harness measures the hedgehog's value
   * separation against the background inside exactly this disc, and a metric
   * aimed at a guessed centre measures the ground next to him.
   */
  drawCX = PLAYER_X;
  drawCY = GROUND_Y;
  drawR = 52;

  // --- motion ---
  private spinAngle = 0;
  private spinRate = 0;
  private dashFromX = 0;
  private dashFromY = 0;
  private dashToX = 0;
  private dashToY = 0;
  private travelAngle = 0;
  private dashHit = false;
  private scroll = 0;

  // --- the hop: one vertical velocity, one cooldown, one launch latch ---
  private vy = 0;
  private jumpCool = 0;
  /** False during the anticipation crouch, true from the instant he leaves. */
  private launched = false;

  // --- body deformation: one underdamped spring, +stretched / -compressed ---
  private stretch = 0;
  private stretchVel = 0;

  /**
   * The two impact beats, in seconds since they fired.
   *
   * The spring alone gave the hop a rigid arc: it relaxes smoothly out of every
   * event at the same rate, so take-off and touchdown read as the same shape at
   * different sizes. These are staged on top of it — a hard vertical stretch
   * held through the first sixth of a second off the deck, and a flat, held
   * pancake on the frame he arrives that snaps back rather than easing back.
   */
  private launchT = 99;
  private landT = 99;
  /** Strength of the landing beat, 0..1, so a stomp and a hop differ. */
  private landPunch = 0;

  // --- locomotion personality ---
  private curled = true;
  /** Scamper phase, 0..2π, advanced by distance travelled and nothing else. */
  private stridePhase = 0;
  private walkIndex = 0;
  private danceBobPrev = 0;

  // --- painted cycle, resolved once the asset library has settled ---
  /** -1 not yet resolved, 0 absent, 1 all four frames are loaded. */
  private walkArt = -1;
  private walkFrames: (Frame | null)[] = [null, null, null, null];

  // --- fx timers ---
  private trailTimer = 0;
  private dustTimer = 0;
  private impactT = 99;
  private impactAngle = 0;

  // --- afterimage ring (no allocation after construction) ---
  private ecX = new Float32Array(ECHO_CAP);
  private ecY = new Float32Array(ECHO_CAP);
  private ecRot = new Float32Array(ECHO_CAP);
  private ecSx = new Float32Array(ECHO_CAP);
  private ecSy = new Float32Array(ECHO_CAP);
  private ecT = new Float32Array(ECHO_CAP);
  private ecHead = 0;
  private ecCount = 0;

  // --- resolved pose for this frame ---
  private poseFrame: Frame | null = null;
  private poseScale = 1;
  private poseFoot = 0;
  private poseFlip = 1;
  /** Quill-blur companion for the current pose, or null if it has none. */
  private blurFrame: Frame | null = null;
  /** Size ratio pose:blur, so the two stay mounted identically. */
  private blurAdj = 1;
  /** Painted fill of the current pose within its frame box, across and down. */
  private poseFillW = 1;
  private poseFillH = 1;
  /**
   * True when the pose carries no face and may therefore be rolled bodily —
   * only the procedural fallback ball. Every painted pose has eyes in it.
   */
  private poseSpins = false;

  // --- cosmetics, resolved once per equip change rather than every frame ---
  private skin: SkinDef = skinById('');
  private trail: TrailDef = trailById('');
  private spin: SpinDef = spinById('');
  private skinId = ' ';
  private trailId = ' ';
  private spinId = ' ';

  // --- skin tint, normalised against the default so painted art stays lit ---
  private tintR = 1;
  private tintG = 1;
  private tintB = 1;

  private particles: Particles;

  /** One pooled emit descriptor; every burst fills it in full before emitting. */
  private colA: [number, number, number] = [1, 1, 1];
  private colB: [number, number, number] = [1, 1, 1];
  private opt: EmitOptions = {
    frame: null as unknown as Frame,
    x: 0,
    y: 0,
    count: 1,
    speed: [0, 0],
    angle: 0,
    spread: 0,
    life: [0, 0],
    size: [0, 0],
    sizeEnd: 0,
    color: [1, 1, 1],
    colorEnd: [1, 1, 1],
    gravity: 0,
    drag: 0,
    spin: 0,
    additive: false,
    alpha: 1,
  };

  constructor(particles: Particles) {
    this.particles = particles;
    this.opt.color = this.colA;
    this.opt.colorEnd = this.colB;
  }

  // -------------------------------------------------------------- public API

  /**
   * True while he is committed to a move and a new spin-dash cannot start.
   *
   * The hop counts. That is the entire cost of the move: leaving the ground
   * means giving up the ability to smash a letter until he is back on it, so a
   * dodge is a trade of tempo rather than a free pass. The scene softens the
   * edge by holding a mid-air tap for `TUNING.jump.airBuffer` and replaying it
   * on touchdown, so the input is never simply dropped.
   */
  isBusy(): boolean {
    return this.state === 'dash' || this.state === 'bounce' || this.state === 'jump';
  }

  /** True once he has actually left the ground — the crouch does not count. */
  isAirborne(): boolean {
    return this.state === 'jump' && this.launched;
  }

  /** Whether a hop can start right now: feet down, cooldown spent. */
  canJump(): boolean {
    return (this.state === 'run' || this.state === 'return') && this.jumpCool <= 0;
  }

  /**
   * How much of the hop is back, 0..1. The button draws this as a lamp, so the
   * player is never refused a move without having been shown why.
   */
  jumpCharge(): number {
    if (this.state === 'jump') return 0;
    const c = TUNING.jump.cooldown;
    return c <= 0 ? 1 : clamp(1 - this.jumpCool / c, 0, 1);
  }

  /**
   * Is he over the column at `wallX` and high enough for it to pass under him?
   *
   * Both halves matter. Height alone would let the tail of a hop, a hand's
   * width off the deck, wave a wall through; proximity alone would dodge a
   * column on the far side of the screen. Together they mean the wall the
   * player watched themselves clear is exactly the wall that costs nothing.
   */
  clearsColumnAt(wallX: number): boolean {
    if (!this.isAirborne()) return false;
    const J = TUNING.jump;
    return GROUND_Y - this.y >= J.clearHeight && Math.abs(this.x - wallX) <= J.clearReach;
  }

  /** Leave the ground. Returns false if he could not — cooldown or mid-move. */
  jump(ctx: Ctx): boolean {
    if (!this.canJump()) return false;
    const J = TUNING.jump;
    this.vy = 0;
    this.launched = false;
    this.curled = true;
    // Anticipation: load the spring downwards so the launch has a release.
    this.stretch = -J.crouchSquash;
    this.stretchVel = -J.crouchSquash * 5;
    this.dashFromY = this.y;
    this.launchT = 99;
    this.landT = 99;
    this.setState('jump');
    // Grit shed sideways as he plants and compresses. This fires on the crouch,
    // a frame before anything moves, so the wind-up is visible and not merely
    // implied by a sprite getting shorter.
    this.burst(
      ctx,
      'fx/dust',
      this.x,
      CONTACT_Y - 4,
      4,
      40,
      130,
      Math.PI,
      2.9,
      0.22,
      0.46,
      18,
      40,
      0.2,
      0.92,
      0.86,
      0.74,
      0.62,
      0.58,
      0.64,
      -30,
      3,
      2,
      false,
    );
    return true;
  }

  /** Launch at a target. `onDashEnd` fires once the dash lands. */
  dashTo(x: number, y: number): void {
    this.dashFromX = this.x;
    this.dashFromY = this.y;
    this.dashToX = x;
    this.dashToY = y;
    this.dashHit = false;
    this.curled = true;
    this.travelAngle = Math.atan2(y - this.y, x - this.x);
    // Wind-up: load the spring the other way so the launch has something to
    // release. Negative stretch reads as compression along the travel axis.
    this.stretch = -0.34;
    this.stretchVel = 0;
    this.setState('dash');
  }

  bounce(): void {
    this.dashFromX = this.x;
    this.dashFromY = this.y;
    this.stretch = -0.42;
    this.stretchVel = -1.2;
    this.setState('bounce');
  }

  /** Peel off the block and settle back onto the running line. */
  returnHome(): void {
    this.dashFromX = this.x;
    this.dashFromY = this.y;
    this.setState('return');
  }

  /**
   * Park and celebrate, held clear of the screen edges — and, on the left, of
   * the hop control. He lands the word wherever the last block happened to be,
   * which on a short word can be well to the left of his running line, and the
   * one place a celebrating hero must not be parked is behind a UI chip.
   */
  dance(x: number): void {
    this.setState('dance');
    this.danceBobPrev = 0;
    const m = TUNING.dash.danceMargin;
    this.dashToX = clamp(x, Math.max(m, PLAYER_X), VIEW_W - m);
  }

  // ----------------------------------------------------------------- update

  update(ctx: Ctx, dt: number, scrollSpeed: number, onDashEnd: () => void): void {
    const T = TUNING.dash;
    this.stateT += dt;
    this.scroll = scrollSpeed;
    this.impactT += dt;
    this.launchT += dt;
    this.landT += dt;
    if (this.jumpCool > 0) this.jumpCool -= dt;

    this.stepSpring(T.squashDecay, dt);

    // Spin rate tracks how fast the world is moving under him, so the ball
    // never looks like it is skidding across the ground.
    const boost = this.state === 'dash' ? T.dashSpinBoost : 1;
    const targetSpin = (scrollSpeed / T.spinPerSpeed) * boost;
    this.spinRate = damp(this.spinRate, targetSpin, T.spinEase, dt);
    this.spinAngle += this.spinRate * dt;
    if (this.spinAngle > Math.PI * 2) this.spinAngle -= Math.PI * 2;

    switch (this.state) {
      case 'run':
        this.updateRun(ctx, dt, scrollSpeed);
        break;
      case 'dash':
        this.updateDash(ctx, dt, scrollSpeed, onDashEnd);
        break;
      case 'return':
        this.updateReturn(ctx, dt);
        break;
      case 'bounce':
        this.updateBounce(ctx, dt);
        break;
      case 'dance':
        this.updateDance(ctx, dt);
        break;
      case 'jump':
        this.updateJump(ctx, dt);
        break;
    }

    // See `LEFT_LIMIT`. Applied after the states have had their say, so it is
    // one invariant in one place rather than a clamp inside every mover.
    if (this.state !== 'dash' && this.x < LEFT_LIMIT) this.x = LEFT_LIMIT;

    this.stepEchoes(dt, T.echoFade);
  }

  /** Underdamped spring: overshoot on release, then settle. */
  private stepSpring(decay: number, dt: number): void {
    const k = decay * decay * 2.2;
    const d = decay * 1.05;
    this.stretchVel += (-this.stretch * k - this.stretchVel * d) * dt;
    this.stretch += this.stretchVel * dt;
    if (this.stretch > 0.9) this.stretch = 0.9;
    else if (this.stretch < -0.55) this.stretch = -0.55;
  }

  private updateRun(ctx: Ctx, dt: number, scrollSpeed: number): void {
    const T = TUNING.dash;
    this.x = damp(this.x, PLAYER_X, T.runFollow, dt);

    // He curls into a ball once the world is moving fast enough to warrant it,
    // and scampers on his paws when it slows down. Hysteresis stops it flapping.
    if (this.curled) {
      if (scrollSpeed < UNCURL_SPEED) this.setCurled(ctx, false);
    } else if (scrollSpeed > CURL_SPEED) {
      this.setCurled(ctx, true);
    }

    if (this.curled) {
      this.y = GROUND_Y + Math.sin(ctx.time * T.runBobRate) * T.runBobAmp;
      this.groundDust(ctx, dt, scrollSpeed);
    } else {
      const walk = this.walkReady(ctx);

      // Distance, not time. `scrollSpeed * dt` is the ground that passed under
      // him this frame, so the cycle advances with the world and a slowing
      // scroll slows his legs instead of letting them skate.
      this.stridePhase += (scrollSpeed / STRIDE_DIST) * dt * TAU;
      if (this.stridePhase >= TAU) this.stridePhase -= TAU;

      const idx = clamp((this.stridePhase / TAU) * 4, 0, 3.999) | 0;
      if (idx !== this.walkIndex) {
        this.walkIndex = idx;
        // Dust belongs to the two planted poses, not to a timer — that is what
        // ties the puff to the paw rather than to the frame rate.
        if (WALK_CONTACT[idx]) this.footfall(ctx, WALK_DUST_X[idx]);
      }

      const s = Math.sin(this.stridePhase);
      const sp = clamp(scrollSpeed / 120, 0, 1);
      // A hint of lift over the passing poses, and a breathing bob that fades
      // out as he picks up speed — with a real cycle running, anything more
      // stacks a second bounce on top of the one the legs already give.
      this.y =
        GROUND_Y -
        Math.abs(s) * (walk ? WALK_BODY_LIFT : 6) * sp +
        Math.sin(ctx.time * T.runBobRate * 0.5) * T.runBobAmp * (walk ? 1 - sp * 0.8 : 1);
    }
  }

  /**
   * Whether the painted four-frame cycle is available, latched the first time
   * the asset library reports itself loaded. Steady state is one field read,
   * and nothing is allocated to answer it.
   */
  private walkReady(ctx: Ctx): boolean {
    if (this.walkArt < 0) {
      if (!ctx.assets.ready) return false;
      let ok = 1;
      for (let i = 0; i < 4; i++) {
        const f = ctx.assets.get(WALK_IDS[i]);
        this.walkFrames[i] = f;
        if (!f) ok = 0;
      }
      this.walkArt = ok;
    }
    return this.walkArt === 1;
  }

  private updateDash(ctx: Ctx, dt: number, scrollSpeed: number, onDashEnd: () => void): void {
    const T = TUNING.dash;
    const chargeT = T.dashTime * CHARGE_FRAC;
    const flightT = T.dashTime;

    // The block keeps scrolling while he winds up and flies, so the landing
    // point has to travel with it or the impact lands behind the target.
    this.dashToX -= scrollSpeed * dt;
    this.travelAngle = Math.atan2(this.dashToY - this.dashFromY, this.dashToX - this.dashFromX);

    if (this.stateT < chargeT) {
      // --- charge: dragged back, flattened, revving ---
      const k = smoothstep(clamp(this.stateT / chargeT, 0, 1));
      this.x = this.dashFromX - CHARGE_PULL * k;
      this.y = this.dashFromY + 5 * k;
      this.chargeDust(ctx, dt, k);
      return;
    }

    // --- flight ---
    const t = clamp((this.stateT - chargeT) / flightT, 0, 1);
    const e = Math.pow(t, FLIGHT_POW);
    const fromX = this.dashFromX - CHARGE_PULL;
    this.x = lerp(fromX, this.dashToX, e);
    this.y = lerp(this.dashFromY + 5, this.dashToY, e);

    this.emitTrail(ctx, dt, T.trailRate.dash);
    this.pushEcho();
    this.dashSmoke(ctx, dt, t);
    if (this.y > GROUND_Y - 80) this.groundDust(ctx, dt, 900);

    if (t >= 1) {
      if (!this.dashHit) this.onImpact(ctx);
      onDashEnd();
    }
  }

  /** The frame he arrives: reverse the stretch into a compression and spray. */
  private onImpact(ctx: Ctx): void {
    this.dashHit = true;
    this.impactT = 0;
    this.impactAngle = this.travelAngle;
    this.stretch = -0.5;
    this.stretchVel = -3.5;

    const back = this.travelAngle + Math.PI;
    // Grit sprayed back along the surface he just broke...
    this.burst(
      ctx,
      'fx/spark',
      this.x,
      this.y,
      20,
      340,
      1150,
      back,
      1.25,
      0.2,
      0.6,
      14,
      40,
      0.15,
      1,
      0.9,
      0.55,
      1,
      0.42,
      0.14,
      620,
      1.5,
      11,
      true,
    );
    // ...a slow smoke bloom that hangs in the frame...
    this.burst(
      ctx,
      'fx/dust',
      this.x,
      this.y,
      12,
      140,
      520,
      back,
      1.6,
      0.35,
      0.85,
      44,
      104,
      0.3,
      1,
      0.92,
      0.8,
      0.62,
      0.56,
      0.64,
      90,
      2.2,
      3,
      false,
    );
    // ...and a low sheet of dust dragged along the ground under the hit.
    this.burst(
      ctx,
      'fx/dust',
      this.x - 20,
      CONTACT_Y - 10,
      7,
      260,
      620,
      Math.PI * 0.98,
      0.35,
      0.3,
      0.6,
      36,
      86,
      0.25,
      0.98,
      0.9,
      0.78,
      0.66,
      0.6,
      0.62,
      -180,
      2.4,
      3,
      false,
    );
  }

  private updateReturn(ctx: Ctx, dt: number): void {
    const T = TUNING.dash;
    const t = clamp(this.stateT / T.returnTime, 0, 1);
    const e = easeOutBack(t, T.returnOvershoot);
    this.x = lerp(this.dashFromX, PLAYER_X, e);
    this.y = lerp(this.dashFromY, GROUND_Y, easeOutCubic(t));
    this.travelAngle = Math.atan2(GROUND_Y - this.dashFromY, PLAYER_X - this.dashFromX);
    this.emitTrail(ctx, dt, T.trailRate.return);
    this.pushEcho();
    if (t >= 1) {
      this.touchdown(ctx, 0.34, 0.55);
      this.setState('run');
    }
  }

  private updateBounce(ctx: Ctx, dt: number): void {
    const T = TUNING.dash;
    const t = clamp(this.stateT / T.bounceTime, 0, 1);
    // Arc backwards then settle — reads as "knocked off" without dying.
    const arc = Math.sin(t * Math.PI);
    this.x = lerp(this.dashFromX, PLAYER_X, easeOutCubic(t)) - arc * T.bounceBack;
    this.y = lerp(this.dashFromY, GROUND_Y, easeOutCubic(t)) - arc * T.bounceLift;
    if (t > 0.55) this.emitTrail(ctx, dt, T.trailRate.return * 0.5);
    if (t >= 1) {
      this.touchdown(ctx, 0.5, 0.7);
      this.setState('run');
    }
  }

  /**
   * The hop.
   *
   * Staged the same way the dash is, because the same rule applies: a move the
   * player has to *time* has to be legible before it happens.
   *
   *   crouch — he sinks into the ground and compresses, feet still planted, for
   *            `crouchTime`. Nothing has left the deck yet, so a hop pressed a
   *            frame too early still reads as deliberate.
   *   flight — one launch impulse and constant gravity, integrated straight.
   *            No easing curve: an arc the player is asked to judge against a
   *            moving column has to be the arc their eye already predicts.
   *   land   — the spring is popped and dust kicks out sideways, exactly as it
   *            does coming off a dash, so a touchdown is one visual idea in
   *            this game rather than two.
   */
  private updateJump(ctx: Ctx, dt: number): void {
    const J = TUNING.jump;
    this.x = damp(this.x, PLAYER_X, TUNING.dash.runFollow, dt);

    if (!this.launched) {
      if (this.stateT < J.crouchTime) {
        const k = smoothstep(clamp(this.stateT / J.crouchTime, 0, 1));
        this.y = GROUND_Y + J.crouchDip * k;
        return;
      }
      this.launched = true;
      this.vy = -J.launchSpeed;
      this.stretch = J.takeoffStretch;
      this.stretchVel = J.takeoffStretch * 6;
      this.launchT = 0;
      this.takeoffDust(ctx);
      // A small kick on the frame he leaves. The hop had the same weight as
      // walking off a kerb because nothing outside the sprite moved.
      ctx.shake(4, 0.1);
    }

    this.vy += J.gravity * dt;
    this.y += this.vy * dt;
    this.emitTrail(ctx, dt, TUNING.dash.trailRate.return * 0.7);

    if (this.y >= GROUND_Y && this.vy > 0) {
      // How hard he arrived, against the speed he left at. A hop taken from a
      // standstill and one dropped off the apex should not land the same.
      const impact = clamp(this.vy / J.launchSpeed, 0, 1.2);
      this.y = GROUND_Y;
      this.vy = 0;
      this.launched = false;
      this.jumpCool = J.cooldown;
      this.touchdown(ctx, J.landSquash, impact);
      ctx.shake(7 * impact, 0.18);
      ctx.hitStop(0.04 * impact);
      this.setState('run');
    }
  }

  /** The kick-off: a hard fan of grit shoved straight down and out. */
  private takeoffDust(ctx: Ctx): void {
    this.burst(
      ctx,
      'fx/dust',
      this.x,
      CONTACT_Y - 4,
      9,
      160,
      460,
      Math.PI,
      2.6,
      0.3,
      0.7,
      30,
      74,
      0.28,
      0.94,
      0.88,
      0.76,
      0.64,
      0.6,
      0.66,
      -90,
      2.4,
      3,
      false,
    );
    this.burst(
      ctx,
      'fx/spark',
      this.x,
      CONTACT_Y - 8,
      4,
      220,
      520,
      Math.PI * 0.5,
      1.5,
      0.14,
      0.32,
      12,
      26,
      0.1,
      1,
      0.88,
      0.5,
      1,
      0.55,
      0.24,
      520,
      1.6,
      9,
      true,
    );
  }

  private updateDance(ctx: Ctx, dt: number): void {
    const T = TUNING.dash;
    const bob = Math.abs(Math.sin(this.stateT * T.danceBobRate));
    this.y = GROUND_Y - bob * T.danceBobLift;
    // Hurry him back inside the frame for the first beat — he lands the word
    // wherever the last block was, which can be right on the screen edge.
    const follow = T.danceFollow * (this.stateT < 0.5 ? 3.5 : 1);
    this.x = damp(this.x, this.dashToX, follow, dt);
    // Stomp on every touchdown so the celebration has weight under it.
    if (this.danceBobPrev > 0.1 && bob <= 0.1) this.touchdown(ctx, 0.26, 0.34);
    this.danceBobPrev = bob;
    this.emitTrail(ctx, dt, T.trailRate.dance);
  }

  /**
   * Landing: pop the spring, start the impact beat and kick a low puff out to
   * both sides.
   *
   * `beat` is what separates a touchdown from a scuff. At 0 this is the old
   * behaviour — the spring absorbs it and nothing else happens, which is right
   * for curling up or for a dance stomp. Above 0 he is flattened hard on the
   * frame of contact and *held* there for a couple of frames before the spring
   * is allowed to take him back, and a ring runs out along the ground. That
   * hold is the landing: a squash that eases out from its first frame reads as
   * elasticity, not as weight.
   */
  private touchdown(ctx: Ctx, strength: number, beat = 0): void {
    this.stretch = -strength;
    this.stretchVel = -strength * 6;
    if (beat > 0) {
      this.landT = 0;
      this.landPunch = clamp(beat, 0, 1.2);
      // A flat sheet of grit shoved out sideways, low and fast.
      this.burst(
        ctx,
        'fx/dust',
        this.x,
        CONTACT_Y - 4,
        10,
        220,
        560,
        Math.PI,
        3.05,
        0.26,
        0.62,
        30,
        78,
        0.3,
        0.96,
        0.9,
        0.78,
        0.66,
        0.6,
        0.64,
        -50,
        3.2,
        3,
        false,
      );
    }
    this.burst(
      ctx,
      'fx/dust',
      this.x,
      CONTACT_Y - 6,
      6,
      70,
      230,
      Math.PI,
      2.4,
      0.26,
      0.6,
      26,
      62,
      0.25,
      0.9,
      0.85,
      0.74,
      0.62,
      0.6,
      0.66,
      -60,
      2.6,
      2.5,
      false,
    );
  }

  private setCurled(ctx: Ctx, curled: boolean): void {
    this.curled = curled;
    this.stretch = curled ? -0.24 : 0.2;
    this.stretchVel = curled ? -1.6 : 1.2;
    this.touchdown(ctx, curled ? 0.22 : 0.16);
  }

  /** A puff under the paw that just planted. `dx` is which paw it was. */
  private footfall(ctx: Ctx, dx: number): void {
    if (this.scroll < 30) return;
    this.burst(
      ctx,
      'fx/dust',
      this.x + dx,
      CONTACT_Y - 4,
      2,
      50,
      150,
      Math.PI * 0.92,
      0.7,
      0.22,
      0.44,
      14,
      30,
      0.2,
      0.88,
      0.83,
      0.7,
      0.6,
      0.58,
      0.62,
      -40,
      2.8,
      2,
      false,
    );
  }

  /**
   * The plume he tears open in the air behind him. Independent of the cosmetic
   * trail — the default loadout has no trail at all, and the dash still has to
   * carry weight.
   */
  private dashSmoke(ctx: Ctx, dt: number, t: number): void {
    const back = this.travelAngle + Math.PI;
    this.burst(
      ctx,
      'fx/dust',
      this.x,
      this.y,
      2,
      60,
      260,
      back,
      0.6,
      0.24,
      0.5,
      44 + t * 34,
      86 + t * 40,
      0.3,
      1,
      0.9,
      0.72,
      0.72,
      0.6,
      0.7,
      -40,
      3.4,
      3,
      false,
    );
    this.burst(
      ctx,
      'fx/spark',
      this.x,
      this.y,
      1,
      180,
      560,
      back,
      0.45,
      0.14,
      0.32,
      12,
      28,
      0.1,
      1,
      0.85,
      0.45,
      1,
      0.5,
      0.2,
      0,
      1.8,
      10,
      true,
    );
  }

  /** Grit peeled off the ground while he is rolling along it at speed. */
  private groundDust(ctx: Ctx, dt: number, scrollSpeed: number): void {
    if (scrollSpeed < 140) return;
    this.dustTimer += dt * (scrollSpeed / 260) * 26;
    if (this.dustTimer < 1) return;
    this.dustTimer = 0;
    this.burst(
      ctx,
      'fx/dust',
      this.x - 30,
      CONTACT_Y - 8,
      2,
      110,
      300,
      Math.PI * 0.86,
      0.5,
      0.28,
      0.55,
      28,
      62,
      0.18,
      0.94,
      0.88,
      0.74,
      0.66,
      0.6,
      0.62,
      -50,
      2.2,
      4,
      false,
    );
  }

  /** The wind-up: a fan of grit dragged backwards out from under the ball. */
  private chargeDust(ctx: Ctx, dt: number, k: number): void {
    this.dustTimer += dt * 90 * (0.3 + k);
    if (this.dustTimer < 1) return;
    this.dustTimer = 0;
    this.burst(
      ctx,
      'fx/dust',
      this.x - 18,
      CONTACT_Y - 8,
      2,
      200,
      520,
      Math.PI * 0.94,
      0.42,
      0.24,
      0.52,
      22,
      52,
      0.2,
      0.95,
      0.88,
      0.74,
      0.68,
      0.6,
      0.6,
      -140,
      2,
      5,
      false,
    );
    this.burst(
      ctx,
      'fx/spark',
      this.x - 14,
      CONTACT_Y - 10,
      1,
      320,
      680,
      Math.PI * 0.96,
      0.3,
      0.16,
      0.34,
      10,
      22,
      0.1,
      1,
      0.86,
      0.44,
      1,
      0.5,
      0.2,
      -60,
      1.4,
      8,
      true,
    );
  }

  // ------------------------------------------------------------------ bursts

  /**
   * Fill the pooled emit descriptor and fire it. Every field is written on
   * every call, so the struct can safely be shared between all effects.
   */
  private burst(
    ctx: Ctx,
    frame: string,
    x: number,
    y: number,
    count: number,
    speed0: number,
    speed1: number,
    angle: number,
    spread: number,
    life0: number,
    life1: number,
    size0: number,
    size1: number,
    sizeEnd: number,
    r0: number,
    g0: number,
    b0: number,
    r1: number,
    g1: number,
    b1: number,
    gravity: number,
    drag: number,
    spin: number,
    additive: boolean,
  ): void {
    const o = this.opt;
    o.frame = ctx.atlas.get(frame);
    o.x = x;
    o.y = y;
    o.count = count;
    o.speed[0] = speed0;
    o.speed[1] = speed1;
    o.angle = angle;
    o.spread = spread;
    o.life[0] = life0;
    o.life[1] = life1;
    o.size[0] = size0;
    o.size[1] = size1;
    o.sizeEnd = sizeEnd;
    this.colA[0] = r0;
    this.colA[1] = g0;
    this.colA[2] = b0;
    this.colB[0] = r1;
    this.colB[1] = g1;
    this.colB[2] = b1;
    o.color = this.colA;
    o.colorEnd = this.colB;
    o.gravity = gravity;
    o.drag = drag;
    o.spin = spin;
    o.additive = additive;
    o.alpha = 1;
    this.particles.emit(ctx, o);
  }

  /** One big burst the moment a word falls. */
  cheer(ctx: Ctx): void {
    for (let i = 0; i < 3; i++) {
      this.burst(
        ctx,
        'fx/star',
        this.x,
        GROUND_Y - 60,
        22,
        300,
        900,
        -Math.PI / 2,
        Math.PI * 0.9,
        0.8,
        1.6,
        20,
        48,
        0.3,
        1,
        0.9,
        0.5,
        0.9,
        0.4,
        1,
        900,
        0.5,
        9,
        true,
      );
    }
  }

  /**
   * Sporadic stars and notes thrown up while he dances.
   *
   * Thrown *clear* of him rather than around him. They used to spawn inside a
   * 120-unit box centred on the hedgehog, which is precisely the ring that has
   * to stay clean for him to read against it — additive stars sitting in it
   * measured out most of the value separation the celebration frame had, so the
   * one moment the game is congratulating the player was the one moment the
   * player could least see who was being congratulated.
   */
  confetti(ctx: Ctx, dt: number): void {
    if (ctx.rng.next() >= dt * 26) return;
    const side = ctx.rng.next() > 0.5 ? 1 : -1;
    this.burst(
      ctx,
      ctx.rng.next() > 0.5 ? 'fx/star' : 'fx/note',
      this.x + side * ctx.rng.range(150, 320),
      GROUND_Y - ctx.rng.range(10, 150),
      2,
      180,
      420,
      -Math.PI / 2,
      1.1,
      0.7,
      1.5,
      18,
      40,
      0.4,
      1,
      0.86,
      0.42,
      1,
      0.4,
      0.7,
      520,
      0.4,
      7,
      true,
    );
  }

  private emitTrail(ctx: Ctx, dt: number, rate: number): void {
    this.resolveCosmetics(ctx);
    const trail = this.trail;
    if (!trail.sprite) return;
    this.trailTimer += dt * rate * 60;
    while (this.trailTimer >= 1) {
      this.trailTimer -= 1;
      this.burst(
        ctx,
        trail.sprite,
        this.x - 18,
        this.y + 12,
        1,
        30,
        90,
        Math.PI * 0.95,
        0.7,
        0.25,
        0.55,
        10,
        26,
        0.2,
        trail.color[0],
        trail.color[1],
        trail.color[2],
        trail.color[0],
        trail.color[1],
        trail.color[2],
        60,
        1.4,
        6,
        trail.id !== 'trail/dust',
      );
    }
  }

  // ------------------------------------------------------------------ echoes

  private pushEcho(): void {
    const i = this.ecHead;
    this.ecX[i] = this.x;
    this.ecY[i] = this.y;
    this.ecRot[i] = this.bodyRot();
    this.ecSx[i] = this.bodyScaleX();
    this.ecSy[i] = this.bodyScaleY();
    this.ecT[i] = 1;
    this.ecHead = (i + 1) % ECHO_CAP;
    if (this.ecCount < ECHO_CAP) this.ecCount++;
  }

  private stepEchoes(dt: number, fade: number): void {
    // Entries are pushed in order, so the first dead one ends the live run.
    let live = 0;
    for (let n = 0; n < this.ecCount; n++) {
      const i = (this.ecHead - 1 - n + ECHO_CAP * 2) % ECHO_CAP;
      this.ecT[i] -= dt * fade;
      if (this.ecT[i] <= 0) break;
      live++;
    }
    this.ecCount = live;
  }

  // -------------------------------------------------------------- appearance

  /**
   * Rotation of the *body* this frame — the axis its squash and stretch run
   * along, and the angle the painted face is mounted at.
   *
   * This is where the roll used to live, and it is the reason a stranger did
   * not read him as a character: the ball was the whole sprite turned about its
   * centre, so his eyes and snout went round with the quills, a hundred degrees
   * a frame. The spin has moved to `wheelRot`, which turns a faceless quill
   * wheel over him. What is left here is a face that stays forward: a lean into
   * speed, a tilt on the way up and down out of a hop, a wobble out of a
   * knockback — all of it inside `FACE_TILT`.
   *
   * Dash flight is the one exemption, and it is not a loophole: the wheel is
   * pinned over him at `BLUR_DASH` there, so the body swinging onto the travel
   * vector — which is what makes the stretch run along the dash — puts nothing
   * on screen that has a face on it.
   */
  private bodyRot(): number {
    const T = TUNING.dash;
    if (this.poseSpins) return this.wheelRot();
    switch (this.state) {
      case 'dash': {
        const chargeT = T.dashTime * CHARGE_FRAC;
        if (this.stateT < chargeT) return 0;
        return this.travelAngle;
      }
      case 'return': {
        const sn = 1 - clamp(this.stateT / T.returnTime, 0, 1);
        return clamp(angDelta(0, this.travelAngle), -FACE_TILT, FACE_TILT) * sn;
      }
      case 'bounce': {
        const t = clamp(this.stateT / T.bounceTime, 0, 1);
        // Rocked backwards out of the hit and righted on the way down. It used
        // to be a two-and-a-half radian backflip.
        return -Math.sin(t * Math.PI) * FACE_TILT * 1.5 - t * 0.06;
      }
      case 'dance':
        return Math.sin(this.stateT * T.danceBobRate * 2) * 0.13;
      case 'jump':
        // Nose up off the launch, nose down into the landing.
        return clamp(-this.vy / 5200, -FACE_TILT, FACE_TILT);
      default:
        // Curled: the ball ROLLS. This was clamped to 0.11 rad (6 degrees) to stop
      // the painted face tumbling, back when a separate faceless wheel sprite was
      // composited on top to carry the spin. That wheel is gone, so the clamp left
      // a static hedgehog with translucent copies rotating around it. A rolling
      // ball rotates; the face going round with it is what rolling looks like.
      if (this.curled) return this.spinAngle;
        // Scampering: lean into the speed. The stride-synced shoulder roll that
        // used to sit on top of this was another way of faking motion on a
        // still sprite; the painted cycle carries it, so it only survives on
        // the fallback pose.
        return (
          0.05 +
          clamp(this.scroll / 300, 0, 1) * 0.1 +
          (this.walkArt === 1 ? 0 : Math.sin(this.stridePhase * 2) * 0.035)
        );
    }
  }

  /**
   * Rotation of the quill shell — the wheel and the rotational smear behind it.
   *
   * This is the roll, and it is the only thing that carries it. Through dash
   * flight it hands over to the body's own angle so the wheel and the stretched
   * silhouette it sits inside stay on one axis; everywhere else it is the raw
   * spin, which is damped against the world's speed and so can never skid.
   */
  /**
   * Formerly the independent shell angle. Now simply the body's own roll, so a
   * smear copy can never sit 300 degrees away from the sprite it is smearing.
   */
  private wheelRot(): number {
    const T = TUNING.dash;
    if (this.state === 'dash' && this.stateT >= T.dashTime * CHARGE_FRAC) {
      const sn = this.flightSpeedNorm();
      return this.spinAngle + angDelta(this.spinAngle, this.travelAngle) * sn;
    }
    return this.spinAngle;
  }

  /**
   * Instantaneous flight speed, normalised 0..1, driving stretch and streaks.
   * With `FLIGHT_POW` easing this rises monotonically and tops out exactly on
   * contact; long dashes smear harder than short ones.
   */
  private flightSpeedNorm(): number {
    const T = TUNING.dash;
    const chargeT = T.dashTime * CHARGE_FRAC;
    const t = clamp((this.stateT - chargeT) / T.dashTime, 0, 1);
    const dx = this.dashToX - (this.dashFromX - CHARGE_PULL);
    const dy = this.dashToY - (this.dashFromY + 5);
    const dist = Math.sqrt(dx * dx + dy * dy);
    return Math.pow(t, FLIGHT_POW - 1) * clamp(dist / SMEAR_REF, 0.55, 1.25);
  }

  /**
   * The three staged deformations of the hop, each 0..1.
   *
   *   crouch — ramps in over the anticipation, so he is at his flattest on the
   *            frame before he leaves.
   *   launch — full on the frame he leaves and *held* through the first part of
   *            the window before releasing, so the stretch is a pose rather
   *            than the top of a curve.
   *   land   — full on the frame he arrives and held flat for about ninety
   *            milliseconds before it snaps back. That hold is the beat: a
   *            squash that starts easing on its first frame reads as a bounce,
   *            not as weight arriving.
   */
  private crouchBeat(): number {
    if (this.state !== 'jump' || this.launched) return 0;
    return smoothstep(clamp(this.stateT / TUNING.jump.crouchTime, 0, 1));
  }

  private launchBeat(): number {
    if (this.launchT >= LAUNCH_BEAT) return 0;
    return 1 - smoothstep(this.launchT / LAUNCH_BEAT);
  }

  private landBeat(): number {
    if (this.landT >= LAND_BEAT) return 0;
    const t = this.landT / LAND_BEAT;
    const k = t < 0.35 ? 1 : 1 - smoothstep((t - 0.35) / 0.65);
    return k * this.landPunch;
  }

  private bodyScaleX(): number {
    const T = TUNING.dash;
    if (this.state === 'dash') {
      const chargeT = T.dashTime * CHARGE_FRAC;
      if (this.stateT < chargeT) {
        // Flattened into the ground: wider, shorter.
        return 1 + 0.2 * smoothstep(clamp(this.stateT / chargeT, 0, 1));
      }
      return 1 + 0.62 * this.flightSpeedNorm() + this.stretch * 0.4;
    }
    if (this.state === 'return') {
      const sn = 1 - clamp(this.stateT / T.returnTime, 0, 1);
      return 1 + 0.3 * sn + this.stretch * 0.4;
    }
    if (this.state === 'run' && !this.curled) {
      // Stride-synced squash is dropped on the painted cycle: at four frames it
      // reads as the body changing size rather than as weight shifting.
      const w = this.walkArt === 1 ? 0 : 1;
      return 1 - this.stretch * 0.35 + Math.abs(Math.sin(this.stridePhase)) * 0.02 * w;
    }
    return (
      (1 - this.stretch * 0.55) *
      (1 + this.crouchBeat() * 0.2) *
      (1 - this.launchBeat() * 0.11) *
      (1 + this.landBeat() * 0.2)
    );
  }

  private bodyScaleY(): number {
    const T = TUNING.dash;
    if (this.state === 'dash') {
      const chargeT = T.dashTime * CHARGE_FRAC;
      if (this.stateT < chargeT) {
        return 1 - 0.24 * smoothstep(clamp(this.stateT / chargeT, 0, 1));
      }
      return 1 / (1 + 0.62 * this.flightSpeedNorm()) + this.stretch * 0.2;
    }
    if (this.state === 'return') {
      const sn = 1 - clamp(this.stateT / T.returnTime, 0, 1);
      return 1 / (1 + 0.3 * sn) + this.stretch * 0.2;
    }
    if (this.state === 'run' && !this.curled) {
      const w = this.walkArt === 1 ? 0 : 1;
      return 1 + this.stretch * 0.35 - Math.abs(Math.sin(this.stridePhase)) * 0.03 * w;
    }
    return (
      (1 + this.stretch * 0.55) *
      (1 - this.crouchBeat() * 0.17) *
      (1 + this.launchBeat() * 0.16) *
      (1 - this.landBeat() * 0.17)
    );
  }

  /**
   * Pick the painted pose, falling back to the procedural atlas. Results land
   * in `poseFrame` / `poseScale` / `poseFoot` / `poseFlip` so nothing is
   * allocated to describe them.
   */
  private resolvePose(ctx: Ctx, kind: number): void {
    const a = ctx.assets;
    this.blurFrame = null;
    this.poseFillW = 1;
    this.poseFillH = 1;
    this.poseSpins = false;
    if (kind === 2) {
      const f = a.get('hog_cheer');
      if (f) {
        this.poseFrame = f;
        this.poseScale = CHEER_BOX / f.w;
        this.poseFoot = (CHEER_FOOT - f.py) * f.h * this.poseScale;
        this.poseFlip = 1;
        this.poseFillW = CHEER_FILL_W;
        this.poseFillH = CHEER_FILL_H;
        return;
      }
      const i = Math.floor(this.stateT * 14) % 6;
      const g = ctx.atlas.get(PROC_DANCE[i]);
      this.poseFrame = g;
      this.poseScale = 1;
      this.poseFoot = (PROC_BODY_FOOT - g.py) * g.h;
      this.poseFlip = 1;
      return;
    }
    if (kind === 1) {
      this.poseFillW = RUN_FILL_W;
      this.poseFillH = RUN_FILL_H;
      if (this.walkReady(ctx)) {
        // The four frames share one canvas and register against each other, so
        // they mount on an identical transform. Fitting each one to its own
        // bounds is exactly what made him jitter and change size.
        const w = this.walkFrames[this.walkIndex]!;
        this.poseFrame = w;
        this.poseScale = RUN_BOX / w.w;
        this.poseFoot = (RUN_FOOT - w.py) * w.h * this.poseScale;
        this.poseFlip = -1;
        return;
      }
      const f = a.get('hog_run');
      if (f) {
        this.poseFrame = f;
        this.poseScale = RUN_BOX / f.w;
        this.poseFoot = (RUN_FOOT - f.py) * f.h * this.poseScale;
        // Painted facing left; mirror him into the direction of travel.
        this.poseFlip = -1;
        return;
      }
      const i = Math.floor((this.stridePhase / (Math.PI * 2)) * 6) % 6;
      const g = ctx.atlas.get(PROC_RUN[(i + 6) % 6]);
      this.poseFrame = g;
      this.poseScale = 1;
      this.poseFoot = (PROC_BODY_FOOT - g.py) * g.h;
      this.poseFlip = 1;
      this.poseFillW = 1;
      this.poseFillH = 1;
      return;
    }
    const f = a.get('hog_ball');
    if (f) {
      this.poseFrame = f;
      this.poseScale = BALL_BOX / f.w;
      this.poseFoot = (BALL_FOOT - f.py) * f.h * this.poseScale;
      this.poseFlip = 1;
      this.poseFillW = BALL_FILL_W;
      this.poseFillH = BALL_FILL_H;
      const b = a.get('hog_ball_blur');
      if (b) {
        this.blurFrame = b;
        // Matched on the PAINT, not on the frame box: the two canvases are the
        // same size but the wheel's quills reach a fifth further out, and
        // mounting them 1:1 hung the blur past the hedgehog's own outline.
        this.blurAdj = (f.w * BALL_FILL_W) / (b.w * BLUR_FILL_W);
      }
      return;
    }
    const g = ctx.atlas.get('hedgehog/ball_00');
    this.poseFrame = g;
    this.poseScale = 1;
    this.poseFoot = (PROC_BALL_FOOT - g.py) * g.h;
    this.poseFlip = 1;
    // The fallback ball is a bare quill ring with nothing to tumble, so it is
    // the one pose allowed to roll bodily.
    this.poseSpins = true;
  }

  /**
   * How much of the quill wheel is laid over the body, 0..1.
   *
   * Driven by the spin rate, which is itself damped towards the world's speed,
   * so the wheel eases in as the roll winds up and there is no threshold
   * anywhere for a hard swap to pop across.
   *
   * It is no longer a trade against the character. The wheel is what turns and
   * the body underneath it does not, so a partly-veiled hedgehog at cruise
   * still has upright eyes looking down the track — `blurMixCap` now buys
   * legibility rather than buying back a face that was tumbling. Dash flight
   * overrides it to near-solid, because that is the one state where the body
   * swings onto the travel vector and there must be nothing readable on it.
   */
  private blurMix(): number {
    if (!this.blurFrame) return 0;
    const t = clamp(
      (Math.abs(this.spinRate) - BLUR_SPIN_LO) / (BLUR_SPIN_HI - BLUR_SPIN_LO),
      0,
      1,
    );
    const m = smoothstep(t) * TUNING.dash.blurMixCap;
    if (this.state === 'dash' && this.stateT >= TUNING.dash.dashTime * CHARGE_FRAC) {
      return Math.max(m, BLUR_DASH);
    }
    return m;
  }

  /**
   * Re-resolve the equipped cosmetics only when the loadout actually changed.
   * The palette lookups build closures and colour tuples, so doing this every
   * frame would allocate for nothing.
   *
   * The tint is normalised against the default quill colour: the painted art
   * keeps its own lighting on the classic skin and only shifts hue on the
   * unlockable ones.
   */
  private resolveCosmetics(ctx: Ctx): void {
    const eq = ctx.save.profile.equipped;
    if (eq.spin !== this.spinId) {
      this.spinId = eq.spin;
      this.spin = spinById(eq.spin);
    }
    if (eq.trail !== this.trailId) {
      this.trailId = eq.trail;
      this.trail = trailById(eq.trail);
    }
    if (eq.skin === this.skinId) return;
    this.skinId = eq.skin;
    this.skin = skinById(eq.skin);
    const c = rgb(this.skin.quill.base);
    const d = rgb(QUILL.base);
    this.tintR = clamp(1 + (c[0] / d[0] - 1) * 0.7, 0.4, 1.85);
    this.tintG = clamp(1 + (c[1] / d[1] - 1) * 0.7, 0.4, 1.85);
    this.tintB = clamp(1 + (c[2] / d[2] - 1) * 0.7, 0.4, 1.85);
  }

  // -------------------------------------------------------------------- draw

  /**
   * Ground shade and separation aura, as a SEPARATE pass.
   *
   * These must be drawn before the letter blocks. Drawn with the body they
   * washed dark over any column the hedgehog happened to be standing beside —
   * the two blocks nearest him read a full stop darker than an identical pair
   * across the screen. Shade belongs on the ground he stands on, not on the
   * objects he stands next to. The scene calls this ahead of the wall field;
   * the geometry setup is repeated rather than cached because it is a handful
   * of arithmetic and keeping the two passes independent is worth more than
   * saving it.
   */
  drawShade(ctx: Ctx): void {
    const r = ctx.r;
    const T = TUNING.dash;
    this.resolveCosmetics(ctx);
    const spin = this.spin;
    const soft = ctx.reducedMotion ? 0.35 : 1;

    const rolling = this.state !== 'dance';
    const kind = this.state === 'dance' ? 2 : rolling && !this.curled && this.state === 'run' ? 1 : 0;
    const curledPose = kind === 0;
    this.resolvePose(ctx, kind);
    const f = this.poseFrame;
    if (!f) return;

    const rot = this.bodyRot();
    const wrot = this.wheelRot();
    const sx = this.bodyScaleX() * this.poseScale;
    const sy = this.bodyScaleY() * this.poseScale;
    const mix = this.blurMix();
    // As the wheel takes over it carries the spin itself, so the additive
    // rotational smear underneath it stands down rather than doubling up.
    const smear = 1 - mix * 0.35;
    /**
     * Uniform scale for everything that is not the body itself — the aura, the
     * wheel, the smear. Deliberately the geometric mean of the body's two axes
     * rather than the axes themselves: the squash and stretch preserve volume,
     * so this is constant through a landing or a dash and the pool of shade
     * around him neither balloons across the screen on the flight frames nor
     * collapses on the frame he lands.
     */
    const uni = Math.sqrt(Math.abs(sx * sy));

    // Grounded blend: 1 on the deck, 0 once he is up at a block. Grounded he
    // sits on the contact plane; airborne he centres on the target.
    const grounded = 1 - clamp((GROUND_Y - this.y) / 120, 0, 1);
    const cy = this.y + (CONTACT_Y - GROUND_Y - this.poseFoot) * grounded;
    const lift = 1 - grounded;
    const landK = this.landBeat();

    // Publish where the body landed, for the silhouette metric. See `drawCX`.
    this.drawCX = this.x;
    this.drawCY = cy;
    this.drawR =
      0.25 *
      (Math.abs(sx) * f.w * this.poseFillW + Math.abs(sy) * f.h * this.poseFillH);

    // -------------------------------------------- 1. ground contact shadow
    //
    // Three stacked ellipses on the contact plane, densest at the core. It was
    // previously two at a third of this density, drawn through a soft radial
    // sprite whose own alpha falls off to nothing — the product was about a
    // tenth of a stop of darkening on a ground slab that has since been
    // brightened, which is to say it was not there. A character with no shadow
    // is a character standing in front of the world instead of on it.
    const dust = ctx.atlas.get('fx/dust');
    const spread = 1 + lift * 0.75;
    const dens = 1 - lift * 0.6;
    const splat = 1 + landK * 0.3;
    for (let i = 0; i < 3; i++) {
      r.draw(
        dust,
        this.x - 4,
        CONTACT_Y + 3,
        (SHADOW_W[i] * spread * splat) / dust.w,
        (SHADOW_H[i] * (1 + lift * 0.15)) / dust.h,
        0,
        0.03,
        0.026,
        0.07,
        SHADOW_A[i] * dens,
      );
    }

    // The shade rings, on the same page as the shadow so they are free. Two
    // spans, so the band the measurement reads is covered evenly rather than
    // peaking on its inner edge and thinning out across the rest of it.
    const halo = ctx.atlas.get('fx/shockwave');
    for (let i = 0; i < HALO_SPAN.length; i++) {
      const hs = (HALO_SPAN[i] * this.drawR) / halo.w;
      r.draw(
        halo,
        this.x,
        cy + AURA_DROP,
        hs,
        hs * AURA_SQUASH,
        0,
        AURA_R,
        AURA_G,
        AURA_B,
        HALO_ALPHA[i],
      );
    }

    // ------------------------------------------------- 2. separation aura
    //
    // The pool of shade he sits in — see the constants. Four copies of the pose
    // stepped outwards, so the falloff is the shape of the character rather
    // than the shape of a gradient sprite.
    //
    // Normalised onto the measured silhouette rather than onto the frame box.
    // The poses have wildly different aspects inside identically-sized canvases
    // — the cheer is half as wide as it is tall — and stepping the frame
    // outwards on a tall pose lays shade down the sides of the body instead of
    // around it, which darkens the hero rather than the ring he sits in.
    const aw = (2 * this.drawR) / (f.w * this.poseFillW);
    const ah = (2 * this.drawR * AURA_SQUASH) / (f.h * this.poseFillH);
    for (let i = 0; i < AURA_STEP.length; i++) {
      const k = AURA_STEP[i];
      r.draw(
        f,
        this.x,
        cy + AURA_DROP,
        k * aw * this.poseFlip,
        k * ah,
        rot,
        AURA_R,
        AURA_G,
        AURA_B,
        AURA_ALPHA[i],
      );
    }

    void T;
  }

  draw(ctx: Ctx): void {
    const r = ctx.r;
    const T = TUNING.dash;
    this.resolveCosmetics(ctx);
    const spin = this.spin;
    const soft = ctx.reducedMotion ? 0.35 : 1;

    const rolling = this.state !== 'dance';
    const kind = this.state === 'dance' ? 2 : rolling && !this.curled && this.state === 'run' ? 1 : 0;
    const curledPose = kind === 0;
    this.resolvePose(ctx, kind);
    const f = this.poseFrame;
    if (!f) return;

    const rot = this.bodyRot();
    const wrot = this.wheelRot();
    const sx = this.bodyScaleX() * this.poseScale;
    const sy = this.bodyScaleY() * this.poseScale;
    const mix = this.blurMix();
    // As the wheel takes over it carries the spin itself, so the additive
    // rotational smear underneath it stands down rather than doubling up.
    const smear = 1 - mix * 0.35;
    /**
     * Uniform scale for everything that is not the body itself — the aura, the
     * wheel, the smear. Deliberately the geometric mean of the body's two axes
     * rather than the axes themselves: the squash and stretch preserve volume,
     * so this is constant through a landing or a dash and the pool of shade
     * around him neither balloons across the screen on the flight frames nor
     * collapses on the frame he lands.
     */
    const uni = Math.sqrt(Math.abs(sx * sy));

    // Grounded blend: 1 on the deck, 0 once he is up at a block. Grounded he
    // sits on the contact plane; airborne he centres on the target.
    const grounded = 1 - clamp((GROUND_Y - this.y) / 120, 0, 1);
    const cy = this.y + (CONTACT_Y - GROUND_Y - this.poseFoot) * grounded;
    const lift = 1 - grounded;
    const landK = this.landBeat();

    // Publish where the body landed, for the silhouette metric. See `drawCX`.
    this.drawCX = this.x;
    this.drawCY = cy;
    this.drawR =
      0.25 *
      (Math.abs(sx) * f.w * this.poseFillW + Math.abs(sy) * f.h * this.poseFillH);

    // Ground shade and aura are drawn earlier, by drawShade(). See there.

    // ------------------------------------ 3. additive fx from the fx atlas
    r.setBlend(Blend.Additive);

    // The winner's key light.
    //
    // The cheer is the one pose that is tall and narrow, and it is the one the
    // separation stack cannot carry on its own: shade pooled around a standing
    // figure fills the gaps between his arms as readily as the ring outside
    // him, so the value gap collapses exactly where the game is celebrating.
    // A warm backlight held inside his own silhouette's reach solves it the way
    // a stage does — the winner is lit, and the light does not spill into the
    // frame around him.
    if (this.state === 'dance') {
      const glow = ctx.atlas.get('fx/glow');
      const gs = (this.drawR * 2.1) / glow.w;
      const pulse = 0.44 + Math.abs(Math.sin(this.stateT * T.danceBobRate)) * 0.14;
      r.draw(glow, this.x, cy, gs, gs, 0, 1, 0.82, 0.45, pulse * soft);
    }

    // The hop, staged. A ring winds inwards through the crouch and a flat one
    // runs out along the ground on the frame he arrives, so both ends of the
    // move are events in the world and not only poses on the sprite.
    if (this.state === 'jump' && !this.launched) {
      const k = this.crouchBeat();
      const ring = ctx.atlas.get('fx/ring');
      const rs = (210 - k * 120) / ring.w;
      r.draw(ring, this.x, cy + 10, rs, rs * 0.42, 0, 1, 0.86, 0.5, k * 0.55 * soft);
    }
    if (landK > 0.01) {
      const k = 1 - landK / Math.max(this.landPunch, 0.001);
      const ring = ctx.atlas.get('fx/ring');
      const rs = (90 + k * 260) / ring.w;
      r.draw(ring, this.x, CONTACT_Y - 4, rs, rs * 0.26, 0, 1, 0.88, 0.6, landK * 0.75 * soft);
      const glow = ctx.atlas.get('fx/glow');
      const gs = (200 * (1 - k * 0.4)) / glow.w;
      r.draw(glow, this.x, CONTACT_Y - 6, gs, gs * 0.34, 0, 1, 0.84, 0.55, landK * 0.4 * soft);
    }

    const charging =
      this.state === 'dash' && this.stateT < T.dashTime * CHARGE_FRAC;
    const chargeK = charging ? smoothstep(clamp(this.stateT / (T.dashTime * CHARGE_FRAC), 0, 1)) : 0;

    // Rotational smear is a property of ROLLING. Applied to the walk pose it
    // drew four rotated copies of the walking hedgehog orbiting the walking
    // hedgehog, so the character was visibly walking and rolling at the same
    // time. It is also anchored to the body angle now, so a smear copy can
    // never sit hundreds of degrees away from the sprite it is smearing.
    if (charging && curledPose) {
      // Heat builds in the core, and a ring winds inwards as anticipation.
      const glow = ctx.atlas.get('fx/glow');
      const gs = (120 + chargeK * 90) / glow.w;
      r.draw(glow, this.x, cy, gs, gs, 0, 1, 0.72, 0.32, 0.3 + chargeK * 0.4);
      this.drawSpinRing(ctx, spin.ring, this.x, cy, 1.5 - chargeK * 0.45, 0.35 + chargeK * 0.5);
    }

    if (this.state === 'dash' && !charging) {
      const sn = this.flightSpeedNorm();
      if (sn > 0.03) this.drawStreaks(ctx, this.x, cy, sn * soft, this.travelAngle);
      this.drawSpinRing(ctx, spin.ring, this.x, cy, 1.1 + sn * 0.5, 0.45 * (1 - sn * 0.4));
    } else if (this.impactT < SMEAR_HOLD) {
      // Hold the smear a beat past contact so the hit still reads as speed on
      // the frame after it lands.
      const k = 1 - this.impactT / SMEAR_HOLD;
      this.drawStreaks(ctx, this.x, cy, k * soft, this.impactAngle);
    }

    if (this.impactT < IMPACT_LIFE) {
      // Shockwave off the point of contact, a tight ring inside it, and a hot
      // flash core that blows out for the first couple of frames.
      const k = this.impactT / IMPACT_LIFE;
      const inv = 1 - k;
      const wave = ctx.atlas.get('fx/shockwave');
      const ws = (110 + k * 460) / wave.w;
      r.draw(wave, this.x, cy, ws, ws * 0.7, this.impactAngle, 1, 0.9, 0.62, inv * inv * 0.95);
      const ring = ctx.atlas.get('fx/ring');
      const rs = (70 + k * 300) / ring.w;
      r.draw(ring, this.x, cy, rs, rs * 0.62, this.impactAngle, 1, 0.95, 0.72, inv * inv * 0.45);
      const glow = ctx.atlas.get('fx/glow');
      const gs = (230 * (1 - k * 0.55)) / glow.w;
      r.draw(glow, this.x, cy, gs, gs, 0, 1, 0.95, 0.76, inv * inv * inv * 0.95);
    }

    r.setBlend(Blend.Normal);

    // ---------------------------------- 4. lit rim, body, and the quill wheel
    //
    // The rim is a warm copy of the pose scaled a hair proud of the body, and
    // it is not styling. Immediately outside it the aura has pooled the frame's
    // deepest value; immediately inside it is the hero's own. A hard light edge
    // between the two is what makes the pair read as a lit object rather than
    // as a sprite with a drop shadow.
    const lit = this.state === 'dance' ? 1 : 0;
    const hero = T.heroLift * HERO_GAIN * (1 + lit * DANCE_GAIN);
    const RIM = T.rim;
    if (RIM.alpha > 0.004) {
      const k = 1 + RIM.width;
      r.draw(f, this.x, cy, sx * k * this.poseFlip, sy * k, rot, RIM_R, RIM_G, RIM_B, RIM.alpha);
    }
    // Cross-faded against the wheel, not drawn under it at full strength.
    // Laying an opaque wheel over an opaque body shows BOTH — a static curled
    // hedgehog with a second spinning one on top of it. The wheel carries its
    // own hard spiky silhouette now, so the body can drop away beneath it
    // without the outline thinning.
    const bodyA = 1 - mix * 0.95;
    if (bodyA > 0.01) {
      r.draw(
        f,
        this.x,
        cy,
        sx * this.poseFlip,
        sy,
        rot,
        this.tintR * hero,
        this.tintG * hero,
        this.tintB * hero,
        bodyA,
      );
    }

    // This is the roll. It turns; the body under it does not. Outside dash
    // flight it is mounted on the uniform scale so that a body mid-squash does
    // not shear a wheel that is supposed to be round.
    if (curledPose && mix > 0.004) {
      const bf = this.blurFrame!;
      const bs = this.blurAdj;
      const flight = this.state === 'dash' && this.stateT >= T.dashTime * CHARGE_FRAC;
      const wx = (flight ? sx : uni) * bs;
      const wy = (flight ? sy : uni) * bs;
      r.draw(
        bf,
        this.x,
        cy,
        wx * this.poseFlip,
        wy,
        flight ? rot : wrot,
        this.tintR * hero,
        this.tintG * hero,
        this.tintB * hero,
        mix,
      );
    }

    // ---------------------- 5. additive hero: echoes, spin smear, value floor
    r.setBlend(Blend.Additive);

    // The smeared copies are taken from the WHEEL wherever there is one. They
    // used to be taken from the ball, which meant the rotational blur was four
    // extra faces fanned out around the first one.
    // The smear MUST be made from the same sprite as the body.
    //
    // It used to source `blurFrame` — a different piece of art, with its own
    // curled hedgehog painted into it — while the body drew `hog_ball`. So two
    // different hedgehog images were composited every frame: a ghost rolling
    // behind the one you were actually controlling. Measured across 150 frames,
    // both sprites appeared together in 134 of them. A motion smear is copies
    // of the SAME image offset in rotation; anything else is a second character.
    const sf = f;
    const sfAdj = 1;

    if (rolling) {
      const maxEchoes = Math.max(1, Math.round(spin.echoes * soft));
      const n = Math.min(this.ecCount, maxEchoes, T.echoLimit);
      for (let e = n - 1; e >= 0; e--) {
        const i = (this.ecHead - 1 - e + ECHO_CAP * 2) % ECHO_CAP;
        const a = this.ecT[i] * this.ecT[i] * 0.52 * ((n - e) / n);
        const eg = 1 - grounded;
        const ey = this.ecY[i] + (CONTACT_Y - GROUND_Y - this.poseFoot) * (1 - eg);
        r.draw(
          sf,
          this.ecX[i],
          ey,
          this.ecSx[i] * this.poseScale * sfAdj * this.poseFlip,
          this.ecSy[i] * this.poseScale * sfAdj,
          this.ecRot[i],
          this.tintR,
          this.tintG * 0.78,
          this.tintB * 0.6,
          a,
        );
      }

      // Rotational motion blur: copies smeared around the spin axis. During
      // flight the body is stretched along travel, so the smear is linear
      // instead and the echoes above already carry it.
      if (charging) {
        const step = (0.22 + chargeK * 0.5) * soft;
        this.drawBlur(r, sf, this.x, cy, uni * sfAdj, rot, step, (0.13 + chargeK * 0.1) * smear);
      } else if (this.state === 'dash') {
        // In flight the body is already stretched along travel, so the smear
        // is linear rather than rotational: copies dropped straight back down
        // the dash line.
        const sn = this.flightSpeedNorm();
        const back = this.travelAngle + Math.PI;
        const gap = (14 + sn * 40) * soft;
        const bx = Math.cos(back) * gap;
        const by = Math.sin(back) * gap;
        for (let i = 1; i <= 3; i++) {
          r.draw(
            sf,
            this.x + bx * i,
            cy + by * i,
            sx * sfAdj * this.poseFlip,
            sy * sfAdj,
            rot,
            this.tintR,
            this.tintG * 0.82,
            this.tintB * 0.66,
            (0.34 / i) * sn * soft,
          );
        }
      } else {
        const step = clamp(Math.abs(this.spinRate) * 0.032, 0, 0.4) * soft;
        if (curledPose && step > 0.02) {
          this.drawBlur(r, sf, this.x, cy, uni * sfAdj, rot, step, 0.2 * smear);
        }
      }
    }

    // The value floor. A warm pass confined to his own silhouette — additive,
    // so it cannot spill a halo the way a glow sprite would — which lifts him
    // clear of the backdrop's own mid-tones without the multiplicative gain
    // having to be pushed far enough to blow the painted highlights out.
    // The additive value-floor pass is gone: it was a seventh full-size copy of
    // the same sprite drawn every frame for a contribution of about 2%.

    r.setBlend(Blend.Normal);
  }

  /** Four additive copies rotated off the shell, reading as a spin smear. */
  private drawBlur(
    r: Ctx['r'],
    f: Frame,
    x: number,
    y: number,
    s: number,
    rot: number,
    step: number,
    alpha: number,
  ): void {
    const flip = this.poseFlip;
    for (let i = 1; i <= 2; i++) {
      const a = alpha / i;
      r.draw(f, x, y, s * flip, s, rot + step * i, this.tintR, this.tintG, this.tintB, a);
      r.draw(f, x, y, s * flip, s, rot - step * i, this.tintR, this.tintG, this.tintB, a);
    }
  }

  /** Additive speed lines laid along the travel vector behind him. */
  private drawStreaks(ctx: Ctx, x: number, y: number, k: number, angle: number): void {
    const r = ctx.r;
    const streak = ctx.atlas.get('fx/streak');
    const back = angle + Math.PI;
    const cos = Math.cos(back);
    const sin = Math.sin(back);
    const reach = 80 + k * 210;
    for (let i = 0; i < STREAK_AT.length; i++) {
      const d = STREAK_AT[i] * reach;
      const lat = STREAK_LAT[i] * (0.4 + k * 0.7);
      const px = x + cos * d - sin * lat;
      const py = y + sin * d + cos * lat;
      const len = (90 + (1 - STREAK_AT[i]) * 150) * (0.45 + k * 0.55);
      const fade = k * (1 - STREAK_AT[i] * 0.6) * 0.85;
      r.draw(streak, px, py, len / streak.w, (11 + i * 2) / streak.h, angle, 1, 0.79, 0.5, fade);
    }
  }

  /** Cosmetic spin ring: honours the equipped `spin/*` pattern. */
  private drawSpinRing(
    ctx: Ctx,
    pattern: string,
    x: number,
    y: number,
    radiusScale: number,
    alpha: number,
  ): void {
    if (pattern === 'none' || alpha <= 0.01) return;
    const r = ctx.r;
    const rad = 62 * radiusScale;
    if (pattern === 'halo') {
      const glow = ctx.atlas.get('fx/glow');
      const gs = (rad * 3.1) / glow.w;
      r.draw(glow, x, y, gs, gs, 0, 1, 0.82, 0.45, alpha * 0.5);
      const ring = ctx.atlas.get('fx/ring');
      const rs = (rad * 2.3) / ring.w;
      r.draw(ring, x, y, rs, rs, this.spinAngle * 2, 1, 0.9, 0.5, alpha);
      return;
    }
    const seg = ctx.atlas.get(pattern === 'chevrons' ? 'fx/spark' : 'fx/streak');
    const count = 6;
    for (let i = 0; i < count; i++) {
      const a = this.spinAngle * 2.2 + (i / count) * Math.PI * 2;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (pattern === 'chevrons') {
        const s = 26 / seg.w;
        r.draw(seg, px, py, s, s, a, 1, 0.85, 0.45, alpha);
      } else {
        r.draw(seg, px, py, 40 / seg.w, 8 / seg.h, a + Math.PI / 2, 1, 0.88, 0.5, alpha);
      }
    }
  }

  private setState(s: PlayerState): void {
    this.state = s;
    this.stateT = 0;
  }
}
