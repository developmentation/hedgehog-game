/**
 * The hedgehog, rasterised.
 *
 * Two passes, and the split between them is not cosmetic:
 *
 *   `drawHeroShade` — the ground contact shadow, laid down BEFORE the letter
 *   blocks. Drawn with the body it washed dark over any column he happened to
 *   be standing beside; the two blocks nearest him read a full stop darker than
 *   an identical pair across the screen. Shade belongs on the ground he stands
 *   on, not on the objects he stands next to.
 *
 *   `drawHero` — everything else, after the blocks and the particles: additive
 *   fx sprites, the body itself, then the additive afterimage echoes and spin
 *   smear. Ordered so no blend run has to be revisited: additive, normal,
 *   additive, back to normal, four state changes for the whole character.
 *
 * Performance contract: nothing here allocates.
 *
 * If you are adding a new hero ability, its sprite work belongs in this file
 * and its particles belong in `playerFx.ts`.
 */

import type { Ctx } from '../core/ctx';
import { GROUND_Y, clamp, smoothstep } from '../core/ctx';
import { Blend, type Frame } from '../engine/gl';
import { TUNING } from './tuning';
import type { Player } from './player';
import {
  CONTACT_Y,
  CHARGE_FRAC,
  ECHO_CAP,
  POSE_BALL,
  bodyRot,
  bodyScaleX,
  bodyScaleY,
  crouchBeat,
  flightSpeedNorm,
  landBeat,
} from './playerAnim';

/**
 * Ground contact shadow — three stacked ellipses, densest at the core.
 *
 * It was previously two at a third of this density, drawn through a soft radial
 * sprite whose own alpha falls off to nothing — the product was about a tenth
 * of a stop of darkening on a ground slab that has since been brightened, which
 * is to say it was not there. A character with no shadow is a character standing
 * in front of the world instead of on it.
 */
const SHADOW_W = [190, 124, 72];
const SHADOW_H = [42, 29, 19];
const SHADOW_A = [0.3, 0.4, 0.48];
/** The shadow's colour: the sky's own deep indigo, so it reads as shade, not soot. */
const SHADOW_R = 0.03;
const SHADOW_G = 0.026;
const SHADOW_B = 0.07;

/** Seconds the speed smear is held on screen after contact. */
const SMEAR_HOLD = 0.2;
/** Seconds the impact bloom lives. */
const IMPACT_LIFE = 0.42;

/**
 * Extra lift on the celebration.
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

/** Where speed streaks sit behind him, as a fraction of the smear length. */
const STREAK_AT = [0.09, 0.24, 0.38, 0.53, 0.68, 0.82, 0.94];
const STREAK_LAT = [-13, 9, -3, 20, -24, 14, -8];

/**
 * The pool of shade he sits in, drawn under the letter blocks.
 *
 * Deliberately independent of `drawHero`: the geometry it needs is a handful of
 * arithmetic, and keeping the two passes from sharing cached state is worth more
 * than saving it.
 */
export function drawHeroShade(ctx: Ctx, p: Player): void {
  const r = ctx.r;

  // Grounded blend: 1 on the deck, 0 once he is up at a block. The shadow
  // spreads and thins as he leaves the ground rather than travelling with him.
  const grounded = 1 - clamp((GROUND_Y - p.y) / 120, 0, 1);
  const lift = 1 - grounded;
  const spread = 1 + lift * 0.75;
  const dens = 1 - lift * 0.6;
  const splat = 1 + landBeat(p) * 0.3;

  const dust = ctx.atlas.get('fx/dust');
  for (let i = 0; i < 3; i++) {
    r.draw(
      dust,
      p.x - 4,
      CONTACT_Y + 3,
      (SHADOW_W[i] * spread * splat) / dust.w,
      (SHADOW_H[i] * (1 + lift * 0.15)) / dust.h,
      0,
      SHADOW_R,
      SHADOW_G,
      SHADOW_B,
      SHADOW_A[i] * dens,
    );
  }
}

export function drawHero(ctx: Ctx, p: Player): void {
  const r = ctx.r;
  const T = TUNING.dash;
  const fx = p.fx;
  fx.resolveCosmetics(ctx);
  const spin = fx.spin;
  const soft = ctx.reducedMotion ? 0.35 : 1;

  const pose = p.pose;
  pose.resolve(ctx, p);
  const f = pose.frame;
  if (!f) return;
  const curledPose = pose.kind === POSE_BALL;
  const rolling = p.state !== 'dance';

  const rot = bodyRot(p);
  const sx = bodyScaleX(p) * pose.scale;
  const sy = bodyScaleY(p) * pose.scale;
  /**
   * Uniform scale for everything that is not the body itself — the rotational
   * smear. Deliberately the geometric mean of the body's two axes rather than
   * the axes themselves: the squash and stretch preserve volume, so this is
   * constant through a landing or a dash and the smear around him neither
   * balloons across the screen on the flight frames nor collapses on the frame
   * he lands.
   */
  const uni = Math.sqrt(Math.abs(sx * sy));

  // Grounded he sits on the contact plane; airborne he centres on the target.
  const grounded = 1 - clamp((GROUND_Y - p.y) / 120, 0, 1);
  const cy = p.y + (CONTACT_Y - GROUND_Y - pose.foot) * grounded;
  const landK = landBeat(p);

  // Publish where the body landed, for the silhouette metric. See `drawCX`.
  p.drawCX = p.x;
  p.drawCY = cy;
  p.drawR = 0.25 * (Math.abs(sx) * f.w * pose.fillW + Math.abs(sy) * f.h * pose.fillH);

  // ------------------------------------------ additive fx from the fx atlas
  r.setBlend(Blend.Additive);

  // The winner's key light.
  //
  // The cheer is the one pose that is tall and narrow, and shade pooled around
  // a standing figure fills the gaps between his arms as readily as the ring
  // outside him, so the value gap collapses exactly where the game is
  // celebrating. A warm backlight held inside his own silhouette's reach solves
  // it the way a stage does — the winner is lit, and the light does not spill
  // into the frame around him.
  if (p.state === 'dance') {
    const glow = ctx.atlas.get('fx/glow');
    const gs = (p.drawR * 2.1) / glow.w;
    const pulse = 0.44 + Math.abs(Math.sin(p.stateT * T.danceBobRate)) * 0.14;
    r.draw(glow, p.x, cy, gs, gs, 0, 1, 0.82, 0.45, pulse * soft);
  }

  // The hop, staged. A ring winds inwards through the crouch and a flat one
  // runs out along the ground on the frame he arrives, so both ends of the
  // move are events in the world and not only poses on the sprite.
  if (p.state === 'jump' && !p.launched) {
    const k = crouchBeat(p);
    const ring = ctx.atlas.get('fx/ring');
    const rs = (210 - k * 120) / ring.w;
    r.draw(ring, p.x, cy + 10, rs, rs * 0.42, 0, 1, 0.86, 0.5, k * 0.55 * soft);
  }
  if (landK > 0.01) {
    const k = 1 - landK / Math.max(p.landPunch, 0.001);
    const ring = ctx.atlas.get('fx/ring');
    const rs = (90 + k * 260) / ring.w;
    r.draw(ring, p.x, CONTACT_Y - 4, rs, rs * 0.26, 0, 1, 0.88, 0.6, landK * 0.75 * soft);
    const glow = ctx.atlas.get('fx/glow');
    const gs = (200 * (1 - k * 0.4)) / glow.w;
    r.draw(glow, p.x, CONTACT_Y - 6, gs, gs * 0.34, 0, 1, 0.84, 0.55, landK * 0.4 * soft);
  }

  const charging = p.state === 'dash' && p.stateT < T.dashTime * CHARGE_FRAC;
  const chargeK = charging ? smoothstep(clamp(p.stateT / (T.dashTime * CHARGE_FRAC), 0, 1)) : 0;

  if (charging && curledPose) {
    // Heat builds in the core, and a ring winds inwards as anticipation.
    const glow = ctx.atlas.get('fx/glow');
    const gs = (120 + chargeK * 90) / glow.w;
    r.draw(glow, p.x, cy, gs, gs, 0, 1, 0.72, 0.32, 0.3 + chargeK * 0.4);
    drawSpinRing(ctx, p, spin.ring, p.x, cy, 1.5 - chargeK * 0.45, 0.35 + chargeK * 0.5);
  }

  if (p.state === 'dash' && !charging) {
    const sn = flightSpeedNorm(p);
    if (sn > 0.03) drawStreaks(ctx, p.x, cy, sn * soft, p.travelAngle);
    drawSpinRing(ctx, p, spin.ring, p.x, cy, 1.1 + sn * 0.5, 0.45 * (1 - sn * 0.4));
  } else if (p.impactT < SMEAR_HOLD) {
    // Hold the smear a beat past contact so the hit still reads as speed on
    // the frame after it lands.
    const k = 1 - p.impactT / SMEAR_HOLD;
    drawStreaks(ctx, p.x, cy, k * soft, p.impactAngle);
  }

  if (p.impactT < IMPACT_LIFE) {
    // Shockwave off the point of contact, a tight ring inside it, and a hot
    // flash core that blows out for the first couple of frames.
    const k = p.impactT / IMPACT_LIFE;
    const inv = 1 - k;
    const wave = ctx.atlas.get('fx/shockwave');
    const ws = (110 + k * 460) / wave.w;
    r.draw(wave, p.x, cy, ws, ws * 0.7, p.impactAngle, 1, 0.9, 0.62, inv * inv * 0.95);
    const ring = ctx.atlas.get('fx/ring');
    const rs = (70 + k * 300) / ring.w;
    r.draw(ring, p.x, cy, rs, rs * 0.62, p.impactAngle, 1, 0.95, 0.72, inv * inv * 0.45);
    const glow = ctx.atlas.get('fx/glow');
    const gs = (230 * (1 - k * 0.55)) / glow.w;
    r.draw(glow, p.x, cy, gs, gs, 0, 1, 0.95, 0.76, inv * inv * inv * 0.95);
  }

  r.setBlend(Blend.Normal);

  // ------------------------------------------------------------- the body
  const hero = p.state === 'dance' ? 1 + DANCE_GAIN : 1;
  r.draw(f, p.x, cy, sx * pose.flip, sy, rot, fx.tintR * hero, fx.tintG * hero, fx.tintB * hero, 1);

  // ------------------------- additive hero: afterimage echoes, spin smear
  r.setBlend(Blend.Additive);

  // The smear MUST be made from the same sprite as the body.
  //
  // It used to source a separate `hog_ball_blur` wheel — a different piece of
  // art, with its own curled hedgehog painted into it — while the body drew
  // `hog_ball`. So two different hedgehog images were composited every frame: a
  // ghost rolling behind the one you were actually controlling. Measured across
  // 150 frames, both sprites appeared together in 134 of them. A motion smear is
  // copies of the SAME image offset in rotation; anything else is a second
  // character.
  if (rolling) {
    const ec = p.echoes;
    const maxEchoes = Math.max(1, Math.round(spin.echoes * soft));
    const n = Math.min(ec.count, maxEchoes, T.echoLimit);
    for (let e = n - 1; e >= 0; e--) {
      const i = (ec.head - 1 - e + ECHO_CAP * 2) % ECHO_CAP;
      const a = ec.t[i] * ec.t[i] * 0.52 * ((n - e) / n);
      const eg = 1 - grounded;
      const ey = ec.y[i] + (CONTACT_Y - GROUND_Y - pose.foot) * (1 - eg);
      r.draw(
        f,
        ec.x[i],
        ey,
        ec.sx[i] * pose.scale * pose.flip,
        ec.sy[i] * pose.scale,
        ec.rot[i],
        fx.tintR,
        fx.tintG * 0.78,
        fx.tintB * 0.6,
        a,
      );
    }

    // Rotational motion blur: copies smeared around the spin axis.
    //
    // Rotational smear is a property of ROLLING. Applied to the walk pose it
    // drew four rotated copies of the walking hedgehog orbiting the walking
    // hedgehog, so the character was visibly walking and rolling at the same
    // time. It is also anchored to the body angle, so a smear copy can never
    // sit hundreds of degrees away from the sprite it is smearing.
    if (charging) {
      const step = (0.22 + chargeK * 0.5) * soft;
      drawBlur(ctx, p, f, p.x, cy, uni, rot, step, 0.13 + chargeK * 0.1);
    } else if (p.state === 'dash') {
      // In flight the body is already stretched along travel, so the smear
      // is linear rather than rotational: copies dropped straight back down
      // the dash line.
      const sn = flightSpeedNorm(p);
      const back = p.travelAngle + Math.PI;
      const gap = (14 + sn * 40) * soft;
      const bx = Math.cos(back) * gap;
      const by = Math.sin(back) * gap;
      for (let i = 1; i <= 3; i++) {
        r.draw(
          f,
          p.x + bx * i,
          cy + by * i,
          sx * pose.flip,
          sy,
          rot,
          fx.tintR,
          fx.tintG * 0.82,
          fx.tintB * 0.66,
          (0.34 / i) * sn * soft,
        );
      }
    } else {
      const step = clamp(Math.abs(p.spinRate) * 0.032, 0, 0.4) * soft;
      if (curledPose && step > 0.02) drawBlur(ctx, p, f, p.x, cy, uni, rot, step, 0.2);
    }
  }

  r.setBlend(Blend.Normal);
}

/** Four additive copies rotated off the body, reading as a spin smear. */
function drawBlur(
  ctx: Ctx,
  p: Player,
  f: Frame,
  x: number,
  y: number,
  s: number,
  rot: number,
  step: number,
  alpha: number,
): void {
  const r = ctx.r;
  const fx = p.fx;
  const flip = p.pose.flip;
  for (let i = 1; i <= 2; i++) {
    const a = alpha / i;
    r.draw(f, x, y, s * flip, s, rot + step * i, fx.tintR, fx.tintG, fx.tintB, a);
    r.draw(f, x, y, s * flip, s, rot - step * i, fx.tintR, fx.tintG, fx.tintB, a);
  }
}

/** Additive speed lines laid along the travel vector behind him. */
function drawStreaks(ctx: Ctx, x: number, y: number, k: number, angle: number): void {
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
function drawSpinRing(
  ctx: Ctx,
  p: Player,
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
    r.draw(ring, x, y, rs, rs, p.spinAngle * 2, 1, 0.9, 0.5, alpha);
    return;
  }
  const seg = ctx.atlas.get(pattern === 'chevrons' ? 'fx/spark' : 'fx/streak');
  const count = 6;
  for (let i = 0; i < count; i++) {
    const a = p.spinAngle * 2.2 + (i / count) * Math.PI * 2;
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
