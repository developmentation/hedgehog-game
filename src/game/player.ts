/**
 * The hedgehog — the controller.
 *
 * Owns where the character is, which of the six motion states he is in, and
 * how he responds to the scene pointing him at things. He knows nothing about
 * letters, words or score: the scene aims him at a block and he reports back
 * the frame he arrives.
 *
 * The rest of the hero lives beside this file, and the split is by question:
 *
 *   `playerAnim.ts`  — what does he LOOK like this frame? Pose selection from
 *                      the asset library, body rotation, squash-and-stretch,
 *                      the staged hop beats, and the afterimage ring.
 *   `playerFx.ts`    — what does he THROW into the world? Every dust, spark,
 *                      smoke and confetti burst, plus the equipped cosmetics.
 *   `playerDraw.ts`  — how is he RASTERISED? The ground-shade pass, the
 *                      additive fx sprites, the body, the echoes and smear.
 *
 * Adding a new ability: the state and its transitions go here, its particles go
 * in `playerFx.ts`, its sprite work in `playerDraw.ts`, and any new pose or
 * deformation in `playerAnim.ts`.
 *
 *
 * ==========================================================================
 * THE STATE MACHINE
 * ==========================================================================
 *
 * Six states. Exactly one is active; `stateT` is seconds since it was entered
 * and is reset by every transition. Everything is entered through `setState`.
 *
 *   run     — the default. He holds the running line at PLAYER_X while the
 *             world scrolls past, curling into a ball above CURL_SPEED and
 *             scampering on his paws below UNCURL_SPEED (hysteresis, so it
 *             cannot flap). Owns: the curl decision, the stride phase and its
 *             footfall dust, the idle bob, the rolling grit.
 *             Leaves on: dashTo -> dash, bounce -> bounce, jump -> jump,
 *                        dance -> dance, returnHome -> return.
 *
 *   dash    — the signature move, staged in time rather than played as one
 *             blur. Owns the whole spin-dash and the impact.
 *               charge   (first CHARGE_FRAC of dashTime) — he flattens into the
 *                        ground, revs, is dragged CHARGE_PULL units backwards
 *                        and throws dust out behind him.
 *               flight   — an explosive ease-out along the travel vector at
 *                        FLIGHT_POW, the body stretched along it, additive
 *                        speed streaks and pooled echoes smeared behind. The
 *                        target tracks the scrolling world so the hit lands on
 *                        the block rather than behind it.
 *               impact   — the stretch reverses into a compression spring, a
 *                        shockwave blooms, grit sprays back along the normal.
 *             Leaves on: the scene's `onDashEnd` callback, which routes to
 *                        `returnHome` (a smash) or `bounce` (a wrong letter).
 *             This is the only state exempt from the LEFT_LIMIT clamp: a dash
 *             that stopped short of its target to respect a UI corner would be
 *             a far worse bug than the one that clamp fixes.
 *
 *   return  — peeling off the block. An overshoot ease back to PLAYER_X and the
 *             ground line, then the spring settles him with a dust puff.
 *             Leaves on: t >= 1 -> run.
 *
 *   bounce  — knocked off a wrong letter. A backwards arc that reads as "hit"
 *             without dying, righted on the way down.
 *             Leaves on: t >= 1 -> run.
 *
 *   jump    — the hop; the escape hatch for a wall he cannot spell. Staged the
 *             same way the dash is, because the same rule applies: a move the
 *             player has to *time* has to be legible before it happens.
 *               crouch — he sinks into the ground, feet still planted, for
 *                        `crouchTime`. `launched` is false here, so nothing has
 *                        left the deck and an early press still reads as
 *                        deliberate. `isAirborne()` is false, so a wall passing
 *                        now still costs a life.
 *               flight — one launch impulse and constant gravity, integrated
 *                        straight. No easing curve: an arc the player must judge
 *                        against a moving column has to be the arc their eye
 *                        already predicts.
 *               land   — spring popped, dust out sideways, shake and hit-stop
 *                        scaled by how hard he arrived.
 *             Owns: `vy`, `launched`, and `jumpCool` — the cooldown that, with
 *             the airtime, is the entire cost of the move.
 *             Leaves on: touchdown -> run.
 *
 *   dance   — the celebration. Parked at a clamped x, bobbing, stomping on each
 *             touchdown, throwing confetti. Held clear of the screen edges and
 *             of the hop control, because he lands the word wherever the last
 *             block happened to be.
 *             Leaves on: `returnHome` when the next word starts.
 *
 * Cross-cutting, owned by `update` rather than by any one state:
 *   - the underdamped squash/stretch spring, stepped every frame;
 *   - `spinAngle`/`spinRate`, damped towards the world's speed so the ball can
 *     never look like it is skidding;
 *   - the afterimage ring's fade;
 *   - the LEFT_LIMIT invariant, applied after the states have had their say so
 *     it is one clamp in one place rather than one inside every mover.
 *
 * `isBusy()` is dash | bounce | jump: the states in which a new spin-dash
 * cannot start. The hop counting is the whole cost of the move — leaving the
 * ground means giving up the ability to smash a letter until you are back on
 * it, so a dodge is a trade of tempo rather than a free pass.
 *
 * Performance contract: nothing in `update`/`draw` allocates.
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
import type { Particles } from './particles';
import { TUNING } from './tuning';
import { HeroPose, EchoRing, CHARGE_FRAC, CHARGE_PULL, FLIGHT_POW } from './playerAnim';
import { HeroFx } from './playerFx';
import { drawHero, drawHeroShade } from './playerDraw';

export type PlayerState = 'run' | 'dash' | 'return' | 'bounce' | 'dance' | 'jump';

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

/** Which of the four scamper poses has a paw planted; dust fires on entry. */
const WALK_CONTACT = [true, false, true, false];
/** Where that dust kicks up relative to him — fore paw plant, hind push-off. */
const WALK_DUST_X = [14, 0, -16, 0];
/**
 * Body lift per stride once the legs carry the motion themselves. The old
 * value was six times this — it existed to fake movement on a still sprite, and
 * left on top of a real cycle it read as a double-bounce. The fallback pose,
 * which has no cycle, still gets the full six.
 */
const WALK_BODY_LIFT = 1.0;

/**
 * Leftmost his centre may travel while he is on his own line.
 *
 * The hop control lives in the bottom-left corner and is drawn after the world,
 * so anything of his that reaches that corner is drawn *under* a UI chip. The
 * knockback arc used to swing him a full ninety units back, which put his left
 * flank exactly on the control's right edge; the arc still reads — the lift is
 * most of it — and this guarantees the corner is his to be occluded by nothing.
 */
const LEFT_LIMIT = 244;

const TAU = Math.PI * 2;

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

  // -------------------------------------------------------------------------
  // Everything below is written by this file and READ by `playerAnim.ts` and
  // `playerDraw.ts`. It is internal to the hero module; the scene's contract is
  // the method list further down plus x / y / state / drawCX / drawCY / drawR.
  // -------------------------------------------------------------------------

  // --- motion ---
  spinAngle = 0;
  spinRate = 0;
  dashFromX = 0;
  dashFromY = 0;
  dashToX = 0;
  dashToY = 0;
  travelAngle = 0;
  private dashHit = false;
  scroll = 0;

  // --- the hop: one vertical velocity, one cooldown, one launch latch ---
  vy = 0;
  private jumpCool = 0;
  /** False during the anticipation crouch, true from the instant he leaves. */
  launched = false;

  // --- body deformation: one underdamped spring, +stretched / -compressed ---
  stretch = 0;
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
  launchT = 99;
  landT = 99;
  /** Strength of the landing beat, 0..1, so a stomp and a hop differ. */
  landPunch = 0;

  // --- locomotion personality ---
  curled = true;
  /** Scamper phase, 0..2π, advanced by distance travelled and nothing else. */
  stridePhase = 0;
  walkIndex = 0;
  private danceBobPrev = 0;

  // --- impact beat, in seconds since the dash landed ---
  impactT = 99;
  impactAngle = 0;

  /** Which sprite he is wearing this frame, and how it is mounted. */
  readonly pose = new HeroPose();
  /** Afterimage echoes: a ring of poses he recently held. */
  readonly echoes = new EchoRing();
  /** Particle bursts and the equipped cosmetics. */
  readonly fx: HeroFx;

  constructor(particles: Particles) {
    this.fx = new HeroFx(particles);
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
    this.fx.crouchDust(ctx, this.x);
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

  /** One big burst the moment a word falls. */
  cheer(ctx: Ctx): void {
    this.fx.cheer(ctx, this.x);
  }

  /** Sporadic stars and notes thrown up while he dances. */
  confetti(ctx: Ctx, dt: number): void {
    this.fx.confetti(ctx, dt, this.x);
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

    this.echoes.step(dt, T.echoFade);
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
      this.fx.groundDust(ctx, dt, this.x, scrollSpeed);
      return;
    }

    const walk = this.pose.walkReady(ctx);

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
      if (WALK_CONTACT[idx]) this.fx.footfall(ctx, this.x, WALK_DUST_X[idx], this.scroll);
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
      this.fx.chargeDust(ctx, dt, this.x, k);
      return;
    }

    // --- flight ---
    const t = clamp((this.stateT - chargeT) / flightT, 0, 1);
    const e = Math.pow(t, FLIGHT_POW);
    const fromX = this.dashFromX - CHARGE_PULL;
    this.x = lerp(fromX, this.dashToX, e);
    this.y = lerp(this.dashFromY + 5, this.dashToY, e);

    this.fx.emitTrail(ctx, dt, T.trailRate.dash, this.x, this.y);
    this.echoes.push(this);
    this.fx.dashSmoke(ctx, this.x, this.y, this.travelAngle, t);
    if (this.y > GROUND_Y - 80) this.fx.groundDust(ctx, dt, this.x, 900);

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
    this.fx.impactBurst(ctx, this.x, this.y, this.travelAngle);
  }

  private updateReturn(ctx: Ctx, dt: number): void {
    const T = TUNING.dash;
    const t = clamp(this.stateT / T.returnTime, 0, 1);
    const e = easeOutBack(t, T.returnOvershoot);
    this.x = lerp(this.dashFromX, PLAYER_X, e);
    this.y = lerp(this.dashFromY, GROUND_Y, easeOutCubic(t));
    this.travelAngle = Math.atan2(GROUND_Y - this.dashFromY, PLAYER_X - this.dashFromX);
    this.fx.emitTrail(ctx, dt, T.trailRate.return, this.x, this.y);
    this.echoes.push(this);
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
    if (t > 0.55) this.fx.emitTrail(ctx, dt, T.trailRate.return * 0.5, this.x, this.y);
    if (t >= 1) {
      this.touchdown(ctx, 0.5, 0.7);
      this.setState('run');
    }
  }

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
      this.fx.takeoffDust(ctx, this.x);
      // A small kick on the frame he leaves. The hop had the same weight as
      // walking off a kerb because nothing outside the sprite moved.
      ctx.shake(4, 0.1);
    }

    this.vy += J.gravity * dt;
    this.y += this.vy * dt;
    this.fx.emitTrail(ctx, dt, TUNING.dash.trailRate.return * 0.7, this.x, this.y);

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
    this.fx.emitTrail(ctx, dt, T.trailRate.dance, this.x, this.y);
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
    }
    this.fx.landingDust(ctx, this.x, beat > 0);
  }

  private setCurled(ctx: Ctx, curled: boolean): void {
    this.curled = curled;
    this.stretch = curled ? -0.24 : 0.2;
    this.stretchVel = curled ? -1.6 : 1.2;
    this.touchdown(ctx, curled ? 0.22 : 0.16);
  }

  private setState(s: PlayerState): void {
    this.state = s;
    this.stateT = 0;
  }

  // -------------------------------------------------------------------- draw

  /**
   * Ground shade, as a SEPARATE pass drawn before the letter blocks. See
   * `playerDraw.ts` for why it cannot be folded into `draw`.
   */
  drawShade(ctx: Ctx): void {
    drawHeroShade(ctx, this);
  }

  draw(ctx: Ctx): void {
    drawHero(ctx, this);
  }
}
