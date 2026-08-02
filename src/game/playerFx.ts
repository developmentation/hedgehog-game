/**
 * Everything the hedgehog throws into the world: grit, smoke, sparks, stars and
 * the cosmetic trail.
 *
 * Emission only — this module never draws a sprite itself, it hands descriptors
 * to the particle system. It also owns the equipped cosmetics, because the skin
 * tint and the trail sprite are resolved once per loadout change and then read
 * by both the emitters here and the draw passes in `playerDraw.ts`.
 *
 * Performance contract: nothing here allocates. Every burst fills one pooled
 * `EmitOptions` struct in full and fires it, so the struct can safely be shared
 * between every effect in the file.
 *
 * If you are adding a new hero ability, its dust, sparks and smoke belong here
 * and its sprite work belongs in `playerDraw.ts`.
 */

import type { Ctx } from '../core/ctx';
import { GROUND_Y, clamp } from '../core/ctx';
import type { Particles, EmitOptions } from './particles';
import { rgb, skinById, trailById, spinById, QUILL, type SkinDef, type TrailDef, type SpinDef } from '../art/palette';
import type { Frame } from '../engine/gl';
import { CONTACT_Y } from './playerAnim';

export class HeroFx {
  private particles: Particles;

  // --- fx timers ---
  private trailTimer = 0;
  private dustTimer = 0;

  // --- cosmetics, resolved once per equip change rather than every frame ---
  private skin: SkinDef = skinById('');
  private trail: TrailDef = trailById('');
  /** The equipped spin pattern; read by the draw pass for its ring and echoes. */
  spin: SpinDef = spinById('');
  // Sentinel ids that can never equal a real one, so the first resolve always runs.
  private skinId = '\0';
  private trailId = '\0';
  private spinId = '\0';

  // --- skin tint, normalised against the default so painted art stays lit ---
  tintR = 1;
  tintG = 1;
  tintB = 1;

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

  /**
   * Re-resolve the equipped cosmetics only when the loadout actually changed.
   * The palette lookups build closures and colour tuples, so doing this every
   * frame would allocate for nothing.
   *
   * The tint is normalised against the default quill colour: the painted art
   * keeps its own lighting on the classic skin and only shifts hue on the
   * unlockable ones.
   */
  resolveCosmetics(ctx: Ctx): void {
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

  // --------------------------------------------------------------- the hop

  /**
   * Grit shed sideways as he plants and compresses. Fired on the crouch, a
   * frame before anything moves, so the wind-up is visible and not merely
   * implied by a sprite getting shorter.
   */
  crouchDust(ctx: Ctx, x: number): void {
    this.burst(ctx, 'fx/dust', x, CONTACT_Y - 4, 4, 40, 130, Math.PI, 2.9, 0.22, 0.46, 18, 40, 0.2,
      0.92, 0.86, 0.74, 0.62, 0.58, 0.64, -30, 3, 2, false);
  }

  /** The kick-off: a hard fan of grit shoved straight down and out. */
  takeoffDust(ctx: Ctx, x: number): void {
    this.burst(ctx, 'fx/dust', x, CONTACT_Y - 4, 9, 160, 460, Math.PI, 2.6, 0.3, 0.7, 30, 74, 0.28,
      0.94, 0.88, 0.76, 0.64, 0.6, 0.66, -90, 2.4, 3, false);
    this.burst(ctx, 'fx/spark', x, CONTACT_Y - 8, 4, 220, 520, Math.PI * 0.5, 1.5, 0.14, 0.32, 12, 26, 0.1,
      1, 0.88, 0.5, 1, 0.55, 0.24, 520, 1.6, 9, true);
  }

  /**
   * Touchdown. `hard` fires the extra flat sheet of grit that separates a
   * landing from a scuff — see `Player.touchdown`, which stages the squash.
   */
  landingDust(ctx: Ctx, x: number, hard: boolean): void {
    if (hard) {
      // A flat sheet of grit shoved out sideways, low and fast.
      this.burst(ctx, 'fx/dust', x, CONTACT_Y - 4, 10, 220, 560, Math.PI, 3.05, 0.26, 0.62, 30, 78, 0.3,
        0.96, 0.9, 0.78, 0.66, 0.6, 0.64, -50, 3.2, 3, false);
    }
    this.burst(ctx, 'fx/dust', x, CONTACT_Y - 6, 6, 70, 230, Math.PI, 2.4, 0.26, 0.6, 26, 62, 0.25,
      0.9, 0.85, 0.74, 0.62, 0.6, 0.66, -60, 2.6, 2.5, false);
  }

  // ------------------------------------------------------------ locomotion

  /** A puff under the paw that just planted. `dx` is which paw it was. */
  footfall(ctx: Ctx, x: number, dx: number, scrollSpeed: number): void {
    if (scrollSpeed < 30) return;
    this.burst(ctx, 'fx/dust', x + dx, CONTACT_Y - 4, 2, 50, 150, Math.PI * 0.92, 0.7, 0.22, 0.44, 14, 30, 0.2,
      0.88, 0.83, 0.7, 0.6, 0.58, 0.62, -40, 2.8, 2, false);
  }

  /** Grit peeled off the ground while he is rolling along it at speed. */
  groundDust(ctx: Ctx, dt: number, x: number, scrollSpeed: number): void {
    if (scrollSpeed < 140) return;
    this.dustTimer += dt * (scrollSpeed / 260) * 26;
    if (this.dustTimer < 1) return;
    this.dustTimer = 0;
    this.burst(ctx, 'fx/dust', x - 30, CONTACT_Y - 8, 2, 110, 300, Math.PI * 0.86, 0.5, 0.28, 0.55, 28, 62, 0.18,
      0.94, 0.88, 0.74, 0.66, 0.6, 0.62, -50, 2.2, 4, false);
  }

  // ------------------------------------------------------------- the dash

  /** The wind-up: a fan of grit dragged backwards out from under the ball. */
  chargeDust(ctx: Ctx, dt: number, x: number, k: number): void {
    this.dustTimer += dt * 90 * (0.3 + k);
    if (this.dustTimer < 1) return;
    this.dustTimer = 0;
    this.burst(ctx, 'fx/dust', x - 18, CONTACT_Y - 8, 2, 200, 520, Math.PI * 0.94, 0.42, 0.24, 0.52, 22, 52, 0.2,
      0.95, 0.88, 0.74, 0.68, 0.6, 0.6, -140, 2, 5, false);
    this.burst(ctx, 'fx/spark', x - 14, CONTACT_Y - 10, 1, 320, 680, Math.PI * 0.96, 0.3, 0.16, 0.34, 10, 22, 0.1,
      1, 0.86, 0.44, 1, 0.5, 0.2, -60, 1.4, 8, true);
  }

  /**
   * The plume he tears open in the air behind him. Independent of the cosmetic
   * trail — the default loadout has no trail at all, and the dash still has to
   * carry weight.
   */
  dashSmoke(ctx: Ctx, x: number, y: number, travelAngle: number, t: number): void {
    const back = travelAngle + Math.PI;
    this.burst(ctx, 'fx/dust', x, y, 2, 60, 260, back, 0.6, 0.24, 0.5, 44 + t * 34, 86 + t * 40, 0.3,
      1, 0.9, 0.72, 0.72, 0.6, 0.7, -40, 3.4, 3, false);
    this.burst(ctx, 'fx/spark', x, y, 1, 180, 560, back, 0.45, 0.14, 0.32, 12, 28, 0.1,
      1, 0.85, 0.45, 1, 0.5, 0.2, 0, 1.8, 10, true);
  }

  /** The frame he arrives: grit, smoke and a low sheet dragged along the ground. */
  impactBurst(ctx: Ctx, x: number, y: number, travelAngle: number): void {
    const back = travelAngle + Math.PI;
    // Grit sprayed back along the surface he just broke...
    this.burst(ctx, 'fx/spark', x, y, 20, 340, 1150, back, 1.25, 0.2, 0.6, 14, 40, 0.15,
      1, 0.9, 0.55, 1, 0.42, 0.14, 620, 1.5, 11, true);
    // ...a slow smoke bloom that hangs in the frame...
    this.burst(ctx, 'fx/dust', x, y, 12, 140, 520, back, 1.6, 0.35, 0.85, 44, 104, 0.3,
      1, 0.92, 0.8, 0.62, 0.56, 0.64, 90, 2.2, 3, false);
    // ...and a low sheet of dust dragged along the surface under the hit.
    this.burst(ctx, 'fx/dust', x - 20, CONTACT_Y - 10, 7, 260, 620, Math.PI * 0.98, 0.35, 0.3, 0.6, 36, 86, 0.25,
      0.98, 0.9, 0.78, 0.66, 0.6, 0.62, -180, 2.4, 3, false);
  }

  // ------------------------------------------------------------ the party

  /** One big burst the moment a word falls. */
  cheer(ctx: Ctx, x: number): void {
    for (let i = 0; i < 3; i++) {
      this.burst(ctx, 'fx/star', x, GROUND_Y - 60, 22, 300, 900, -Math.PI / 2, Math.PI * 0.9, 0.8, 1.6, 20, 48, 0.3,
        1, 0.9, 0.5, 0.9, 0.4, 1, 900, 0.5, 9, true);
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
  confetti(ctx: Ctx, dt: number, x: number): void {
    if (ctx.rng.next() >= dt * 26) return;
    const side = ctx.rng.next() > 0.5 ? 1 : -1;
    this.burst(
      ctx,
      ctx.rng.next() > 0.5 ? 'fx/star' : 'fx/note',
      x + side * ctx.rng.range(150, 320),
      GROUND_Y - ctx.rng.range(10, 150),
      2, 180, 420, -Math.PI / 2, 1.1, 0.7, 1.5, 18, 40, 0.4,
      1, 0.86, 0.42, 1, 0.4, 0.7, 520, 0.4, 7, true,
    );
  }

  /** The equipped cosmetic trail, metered per frame-at-60. */
  emitTrail(ctx: Ctx, dt: number, rate: number, x: number, y: number): void {
    this.resolveCosmetics(ctx);
    const trail = this.trail;
    if (!trail.sprite) return;
    this.trailTimer += dt * rate * 60;
    while (this.trailTimer >= 1) {
      this.trailTimer -= 1;
      this.burst(ctx, trail.sprite, x - 18, y + 12, 1, 30, 90, Math.PI * 0.95, 0.7, 0.25, 0.55, 10, 26, 0.2,
        trail.color[0], trail.color[1], trail.color[2],
        trail.color[0], trail.color[1], trail.color[2],
        60, 1.4, 6, trail.id !== 'trail/dust');
    }
  }
}
