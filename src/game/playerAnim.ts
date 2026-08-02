/**
 * The hedgehog's POSE: which sprite is on screen this frame, how it is mounted,
 * and what shape it is squashed into.
 *
 * This module answers "what does he look like right now" and nothing else. It
 * reads the controller's motion state (`player.ts`) and never writes to it,
 * never emits a particle and never issues a draw call. If you are adding a new
 * hero ability, this is the file that decides which artwork it wears and how
 * that artwork leans, stretches and rolls.
 *
 * Three pose families, each with a fallback beneath it, so the game runs with
 * zero PNGs:
 *
 *   BALL  — curled: painted `hog_ball`, else the procedural `hedgehog/ball_00`
 *   WALK  — scampering: the painted four-frame cycle `hog_walk_0..3`, else the
 *           single `hog_run` pose, else the procedural `hedgehog/run_*` cycle
 *   CHEER — celebrating: painted `hog_cheer`, else `hedgehog/dance_*`
 *
 * Two rules keep the locomotion honest:
 *
 *   The scamper is phased by *ground covered*, never by wall-clock, so the paws
 *   are pinned to the surface and the cycle cannot skate when the world eases.
 *   The four frames share one canvas and register exactly, so they are mounted
 *   on an identical transform — nothing is re-fitted per frame.
 *
 *   THE FACE NEVER TUMBLES — outside the roll. A painted face rotated a hundred
 *   degrees a frame is the single loudest way to stop a character reading as a
 *   character. Every non-rolling tilt is clamped to `FACE_TILT`. See `bodyRot`
 *   for why the curled ball is the one deliberate exception.
 */

import type { Ctx } from '../core/ctx';
import { GROUND_Y, clamp, smoothstep } from '../core/ctx';
import type { Frame } from '../engine/gl';
import { TUNING } from './tuning';
import type { Player } from './player';

// ---------------------------------------------------------------------------
// Compositional constants — sprite framing and staging, not game feel. Feel
// lives in TUNING; these describe how the artwork is mounted on the character.
// ---------------------------------------------------------------------------

/** The visual ground plane: where the underside of the ball meets the world. */
export const CONTACT_Y = GROUND_Y + 22;

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
 * rather than against the frame — `drawR`, and the celebration backlight scaled
 * off it — has to be told the difference, or it is measured against a box that
 * is mostly air and lands nowhere near the body.
 */
const BALL_FILL_W = 0.695;
const BALL_FILL_H = 0.738;
const RUN_FILL_W = 0.824;
const RUN_FILL_H = 0.648;
const CHEER_FILL_W = 0.628;
const CHEER_FILL_H = 0.867;

/** The scamper cycle in loop order: contact, passing, extension, passing. */
const WALK_IDS = ['hog_walk_0', 'hog_walk_1', 'hog_walk_2', 'hog_walk_3'];

/** Fallback frame names, pre-built so the procedural path allocates nothing. */
const PROC_RUN = ['hedgehog/run_00', 'hedgehog/run_01', 'hedgehog/run_02', 'hedgehog/run_03', 'hedgehog/run_04', 'hedgehog/run_05'];
const PROC_DANCE = ['hedgehog/dance_00', 'hedgehog/dance_01', 'hedgehog/dance_02', 'hedgehog/dance_03', 'hedgehog/dance_04', 'hedgehog/dance_05'];

/** Fraction of the dash state spent winding up before the launch. */
export const CHARGE_FRAC = 0.45;
/** World units he is dragged backwards during the wind-up. */
export const CHARGE_PULL = 24;
/**
 * Flight easing exponent. Deliberately > 1 so he *accelerates* into the block:
 * the stretch, the streaks and the echo smear all peak on the frame of
 * contact, which is the frame the hit has to sell.
 */
export const FLIGHT_POW = 1.8;
/** Dash length that counts as a full-strength smear. */
const SMEAR_REF = 360;

/**
 * Hardest the painted face is ever tilted off upright, radians.
 *
 * Roughly twelve degrees: enough for a knockback to read as a knockback and for
 * a landing to read as a lean, far short of anything a stranger would call the
 * character rolling over.
 */
const FACE_TILT = 0.21;

/** Seconds the landing squash punch lives, and the take-off stretch hold. */
export const LAND_BEAT = 0.26;
export const LAUNCH_BEAT = 0.16;

/** Which pose family is on screen. */
export const POSE_BALL = 0;
export const POSE_WALK = 1;
export const POSE_CHEER = 2;

/** Signed shortest angular distance from `from` to `to`. */
function angDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * The sprite mounted for this frame, resolved in place.
 *
 * Every field is overwritten on every `resolve`, so nothing is allocated to
 * describe the pose and the previous frame can never leak through.
 */
export class HeroPose {
  /** Which family — POSE_BALL / POSE_WALK / POSE_CHEER. */
  kind = POSE_BALL;
  frame: Frame | null = null;
  /** Multiplier from the frame's own art units to world units. */
  scale = 1;
  /** World units from the motion line down to the silhouette's ground contact. */
  foot = 0;
  /** -1 mirrors the pose into the direction of travel. */
  flip = 1;
  /** Painted fill of the current pose within its frame box, across and down. */
  fillW = 1;
  fillH = 1;
  /**
   * True when the pose carries no face and may therefore be rolled bodily —
   * only the procedural fallback ball. Every painted pose has eyes in it.
   */
  spins = false;

  /** -1 not yet resolved, 0 absent, 1 all four painted walk frames are loaded. */
  walkArt = -1;
  private walkFrames: (Frame | null)[] = [null, null, null, null];

  /**
   * Whether the painted four-frame cycle is available, latched the first time
   * the asset library reports itself loaded. Steady state is one field read,
   * and nothing is allocated to answer it.
   */
  walkReady(ctx: Ctx): boolean {
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

  /** Pick the painted pose for `p`'s current state, falling back to the atlas. */
  resolve(ctx: Ctx, p: Player): void {
    const a = ctx.assets;
    this.fillW = 1;
    this.fillH = 1;
    this.spins = false;
    this.kind =
      p.state === 'dance'
        ? POSE_CHEER
        : !p.curled && p.state === 'run'
          ? POSE_WALK
          : POSE_BALL;

    if (this.kind === POSE_CHEER) {
      const f = a.get('hog_cheer');
      if (f) {
        this.frame = f;
        this.scale = CHEER_BOX / f.w;
        this.foot = (CHEER_FOOT - f.py) * f.h * this.scale;
        this.flip = 1;
        this.fillW = CHEER_FILL_W;
        this.fillH = CHEER_FILL_H;
        return;
      }
      const i = Math.floor(p.stateT * 14) % 6;
      const g = ctx.atlas.get(PROC_DANCE[i]);
      this.frame = g;
      this.scale = 1;
      this.foot = (PROC_BODY_FOOT - g.py) * g.h;
      this.flip = 1;
      return;
    }

    if (this.kind === POSE_WALK) {
      this.fillW = RUN_FILL_W;
      this.fillH = RUN_FILL_H;
      if (this.walkReady(ctx)) {
        // The four frames share one canvas and register against each other, so
        // they mount on an identical transform. Fitting each one to its own
        // bounds is exactly what made him jitter and change size.
        const w = this.walkFrames[p.walkIndex]!;
        this.frame = w;
        this.scale = RUN_BOX / w.w;
        this.foot = (RUN_FOOT - w.py) * w.h * this.scale;
        this.flip = -1;
        return;
      }
      const f = a.get('hog_run');
      if (f) {
        this.frame = f;
        this.scale = RUN_BOX / f.w;
        this.foot = (RUN_FOOT - f.py) * f.h * this.scale;
        // Painted facing left; mirror him into the direction of travel.
        this.flip = -1;
        return;
      }
      const i = Math.floor((p.stridePhase / (Math.PI * 2)) * 6) % 6;
      const g = ctx.atlas.get(PROC_RUN[(i + 6) % 6]);
      this.frame = g;
      this.scale = 1;
      this.foot = (PROC_BODY_FOOT - g.py) * g.h;
      this.flip = 1;
      this.fillW = 1;
      this.fillH = 1;
      return;
    }

    const f = a.get('hog_ball');
    if (f) {
      this.frame = f;
      this.scale = BALL_BOX / f.w;
      this.foot = (BALL_FOOT - f.py) * f.h * this.scale;
      this.flip = 1;
      this.fillW = BALL_FILL_W;
      this.fillH = BALL_FILL_H;
      return;
    }
    const g = ctx.atlas.get('hedgehog/ball_00');
    this.frame = g;
    this.scale = 1;
    this.foot = (PROC_BALL_FOOT - g.py) * g.h;
    this.flip = 1;
    // The fallback ball is a bare quill ring with nothing to tumble, so it is
    // the one pose allowed to roll bodily.
    this.spins = true;
  }
}

// ------------------------------------------------------------------- echoes

/** Ring capacity for afterimage echoes; TUNING.dash.echoLimit clamps into it. */
export const ECHO_CAP = 16;

/**
 * Afterimage echoes: a ring of poses he has recently held.
 *
 * Parallel typed arrays rather than objects, sized once at construction, so a
 * dash that pushes an echo every frame allocates nothing.
 */
export class EchoRing {
  readonly x = new Float32Array(ECHO_CAP);
  readonly y = new Float32Array(ECHO_CAP);
  readonly rot = new Float32Array(ECHO_CAP);
  readonly sx = new Float32Array(ECHO_CAP);
  readonly sy = new Float32Array(ECHO_CAP);
  /** Life remaining, 1 at birth down to 0. */
  readonly t = new Float32Array(ECHO_CAP);
  head = 0;
  count = 0;

  push(p: Player): void {
    const i = this.head;
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.rot[i] = bodyRot(p);
    this.sx[i] = bodyScaleX(p);
    this.sy[i] = bodyScaleY(p);
    this.t[i] = 1;
    this.head = (i + 1) % ECHO_CAP;
    if (this.count < ECHO_CAP) this.count++;
  }

  step(dt: number, fade: number): void {
    // Entries are pushed in order, so the first dead one ends the live run.
    let live = 0;
    for (let n = 0; n < this.count; n++) {
      const i = (this.head - 1 - n + ECHO_CAP * 2) % ECHO_CAP;
      this.t[i] -= dt * fade;
      if (this.t[i] <= 0) break;
      live++;
    }
    this.count = live;
  }
}

// ---------------------------------------------------------------------- shape

/**
 * Rotation of the *body* this frame — the axis its squash and stretch run
 * along, and the angle the painted face is mounted at.
 *
 * Everything here except the roll is clamped inside `FACE_TILT`: a lean into
 * speed, a tilt on the way up and down out of a hop, a wobble out of a
 * knockback. The clamp exists because the ball used to be the whole sprite
 * turned about its centre in every state, so his eyes and snout went round with
 * the quills at a hundred degrees a frame and he stopped reading as a character.
 *
 * The curled ball is the deliberate exception, and it was arrived at the hard
 * way. The roll used to be carried by a separate faceless wheel sprite
 * composited on top, with the body clamped to 0.11 rad underneath it. That
 * wheel is gone — it carried its own curled hedgehog in the middle, so blending
 * it over the solid ball read as two hedgehogs at once — and with it gone the
 * clamp left a static hedgehog with translucent copies rotating around it. A
 * rolling ball rotates; the face going round with it is what rolling looks like.
 *
 * Dash flight is the other exception: the body swings onto the travel vector so
 * the stretch runs along the dash.
 */
export function bodyRot(p: Player): number {
  const T = TUNING.dash;
  if (p.pose.spins) return rollRot(p);
  switch (p.state) {
    case 'dash': {
      const chargeT = T.dashTime * CHARGE_FRAC;
      if (p.stateT < chargeT) return 0;
      return p.travelAngle;
    }
    case 'return': {
      const sn = 1 - clamp(p.stateT / T.returnTime, 0, 1);
      return clamp(angDelta(0, p.travelAngle), -FACE_TILT, FACE_TILT) * sn;
    }
    case 'bounce': {
      const t = clamp(p.stateT / T.bounceTime, 0, 1);
      // Rocked backwards out of the hit and righted on the way down. It used
      // to be a two-and-a-half radian backflip.
      return -Math.sin(t * Math.PI) * FACE_TILT * 1.5 - t * 0.06;
    }
    case 'dance':
      return Math.sin(p.stateT * T.danceBobRate * 2) * 0.13;
    case 'jump':
      // Nose up off the launch, nose down into the landing.
      return clamp(-p.vy / 5200, -FACE_TILT, FACE_TILT);
    default:
      // Curled: the ball ROLLS. See the note above — this is not an oversight.
      if (p.curled) return p.spinAngle;
      // Scampering: lean into the speed. The stride-synced shoulder roll that
      // used to sit on top of this was another way of faking motion on a
      // still sprite; the painted cycle carries it, so it only survives on
      // the fallback pose.
      return (
        0.05 +
        clamp(p.scroll / 300, 0, 1) * 0.1 +
        (p.pose.walkArt === 1 ? 0 : Math.sin(p.stridePhase * 2) * 0.035)
      );
  }
}

/**
 * The raw roll angle, damped against the world's speed so it can never skid.
 *
 * Reached only by the faceless fallback ball, which is allowed to spin bodily.
 * Through dash flight it eases onto the travel vector so the spin and the
 * stretched silhouette it sits inside stay on one axis.
 */
function rollRot(p: Player): number {
  const T = TUNING.dash;
  if (p.state === 'dash' && p.stateT >= T.dashTime * CHARGE_FRAC) {
    const sn = flightSpeedNorm(p);
    return p.spinAngle + angDelta(p.spinAngle, p.travelAngle) * sn;
  }
  return p.spinAngle;
}

/**
 * Instantaneous flight speed, normalised 0..1, driving stretch and streaks.
 * With `FLIGHT_POW` easing this rises monotonically and tops out exactly on
 * contact; long dashes smear harder than short ones.
 */
export function flightSpeedNorm(p: Player): number {
  const T = TUNING.dash;
  const chargeT = T.dashTime * CHARGE_FRAC;
  const t = clamp((p.stateT - chargeT) / T.dashTime, 0, 1);
  const dx = p.dashToX - (p.dashFromX - CHARGE_PULL);
  const dy = p.dashToY - (p.dashFromY + 5);
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
export function crouchBeat(p: Player): number {
  if (p.state !== 'jump' || p.launched) return 0;
  return smoothstep(clamp(p.stateT / TUNING.jump.crouchTime, 0, 1));
}

export function launchBeat(p: Player): number {
  if (p.launchT >= LAUNCH_BEAT) return 0;
  return 1 - smoothstep(p.launchT / LAUNCH_BEAT);
}

export function landBeat(p: Player): number {
  if (p.landT >= LAND_BEAT) return 0;
  const t = p.landT / LAND_BEAT;
  const k = t < 0.35 ? 1 : 1 - smoothstep((t - 0.35) / 0.65);
  return k * p.landPunch;
}

export function bodyScaleX(p: Player): number {
  const T = TUNING.dash;
  if (p.state === 'dash') {
    const chargeT = T.dashTime * CHARGE_FRAC;
    if (p.stateT < chargeT) {
      // Flattened into the ground: wider, shorter.
      return 1 + 0.2 * smoothstep(clamp(p.stateT / chargeT, 0, 1));
    }
    return 1 + 0.62 * flightSpeedNorm(p) + p.stretch * 0.4;
  }
  if (p.state === 'return') {
    const sn = 1 - clamp(p.stateT / T.returnTime, 0, 1);
    return 1 + 0.3 * sn + p.stretch * 0.4;
  }
  if (p.state === 'run' && !p.curled) {
    // Stride-synced squash is dropped on the painted cycle: at four frames it
    // reads as the body changing size rather than as weight shifting.
    const w = p.pose.walkArt === 1 ? 0 : 1;
    return 1 - p.stretch * 0.35 + Math.abs(Math.sin(p.stridePhase)) * 0.02 * w;
  }
  return (
    (1 - p.stretch * 0.55) *
    (1 + crouchBeat(p) * 0.2) *
    (1 - launchBeat(p) * 0.11) *
    (1 + landBeat(p) * 0.2)
  );
}

export function bodyScaleY(p: Player): number {
  const T = TUNING.dash;
  if (p.state === 'dash') {
    const chargeT = T.dashTime * CHARGE_FRAC;
    if (p.stateT < chargeT) {
      return 1 - 0.24 * smoothstep(clamp(p.stateT / chargeT, 0, 1));
    }
    return 1 / (1 + 0.62 * flightSpeedNorm(p)) + p.stretch * 0.2;
  }
  if (p.state === 'return') {
    const sn = 1 - clamp(p.stateT / T.returnTime, 0, 1);
    return 1 / (1 + 0.3 * sn) + p.stretch * 0.2;
  }
  if (p.state === 'run' && !p.curled) {
    const w = p.pose.walkArt === 1 ? 0 : 1;
    return 1 + p.stretch * 0.35 - Math.abs(Math.sin(p.stridePhase)) * 0.03 * w;
  }
  return (
    (1 + p.stretch * 0.55) *
    (1 - crouchBeat(p) * 0.17) *
    (1 + launchBeat(p) * 0.16) *
    (1 - landBeat(p) * 0.17)
  );
}
