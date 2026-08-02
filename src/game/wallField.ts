/**
 * The letter walls.
 *
 * Columns of lettered blocks roll in from the right. Every wall is guaranteed
 * to contain the letter the player needs next, so a run can never soft-lock,
 * and the rest of the column is decoys.
 *
 * Owns spawning, scrolling, per-block physics, hit-testing and drawing the
 * blocks. It has no opinion about score, lives or the player — the scene asks
 * it what was hit and decides what that means.
 *
 * Two things dominate the design of this file:
 *
 *   1. Legibility. The glyph is the single most important pixel budget in the
 *      game, so every letter is drawn as a three-part sandwich — a soft dark
 *      recess pooled on the block face, a hard offset outline, then the fill.
 *      That stack survives a near-white crystal block and a near-black stone
 *      one without changing the letter's colour, so the player only ever has
 *      to learn one visual language.
 *
 *   2. Batching. Block faces live on the generated-art texture while glyphs,
 *      shadows and FX live on the procedural atlas, so the whole field is
 *      drawn in three non-interleaved passes: one additive run of halos under
 *      the cubes, then every face, then every piece of atlas work. Three draw
 *      calls, whatever the column height. Contact shadows sit below the lowest
 *      block's footprint, so drawing them in the atlas pass (after the faces)
 *      costs nothing visually and saves a texture bind, and the atlas pass goes
 *      last so the particle system's normal-blend run joins the same batch.
 *
 * Nothing in `update()` or `draw()` allocates: presentation transforms are
 * cached onto the block, and every particle burst is fired through a single
 * reused emit-options record.
 */

import type { Ctx } from '../core/ctx';
import { VIEW_W, GROUND_Y, clamp, damp, lerp, easeOutBack } from '../core/ctx';
import { BLOCK_W, BLOCK_H } from '../art/letters';
import { Blend, type Frame } from '../engine/gl';
import type { EmitOptions, Particles } from './particles';
import { TUNING } from './tuning';
import type { WordSession } from './wordSession';

export interface Block {
  letter: string;
  /** Offset from the wall's x. */
  ox: number;
  y: number;
  alive: boolean;
  /** Material index: 0 stone, 1 crystal, 2 amber. */
  mat: number;
  /** Wobble applied when a neighbour is smashed. */
  jolt: number;
  /** Scale-in animation on spawn. */
  born: number;
  hoverT: number;
  /** Telegraph strength — this is the letter the player needs next. */
  targetT: number;
  /** Vertical spring offset: the block sagging under an impact and recovering. */
  sag: number;
  sagV: number;
  /** Per-block phase so a column never oscillates in lockstep. */
  phase: number;
  /** Hand-stacked tilt, radians. */
  lean: number;
  /** Drawn size of this block's cube face, world units. */
  size: number;
  // Presentation transform, recomputed each update and consumed by draw.
  dx: number;
  dy: number;
  dsx: number;
  dsy: number;
  drot: number;
}

export interface Wall {
  x: number;
  blocks: Block[];
  /** Set once the correct letter in this wall has been taken. */
  spent: boolean;
  passed: boolean;
}

/** Per-frame wiring from the scene. */
export interface WallFrame {
  /** Live session — read at spawn time, since a setback can rewind mid-update. */
  session: WordSession;
  scrollSpeed: number;
  playerX: number;
  /** Called when an uncleared wall rolls past the player. */
  onPassed: (wall: Wall) => void;
  /** Checked after the sweep, so a phase change made by `onPassed` is honoured. */
  shouldSpawn: () => boolean;
}

// ---------------------------------------------------------------- geometry

/** Cube faces are drawn a touch wider than the hit box so columns read solid. */
const DRAW_W = BLOCK_W * 1.06;
/** Highest a block's top edge may sit, so a 5-stack never leaves the frame. */
const TOP_MARGIN = 20;
/** Cull margin either side of the view — one block's half-width plus slack. */
const CULL = 120;

/** Glyph box as a fraction of the drawn cube. Big: legibility beats elegance. */
const GLYPH_FRACTION = 0.8;
/** Outline offset as a fraction of the glyph box. */
const OUTLINE_R = 0.052;
/** Soft dark pool behind the glyph, as a fraction of the cube. */
const POOL_FRACTION = 1.06;

/** Spring constants for the block sag. Underdamped on purpose: it bounces. */
const SPRING_K = 300;
const SPRING_D = 16;

/** Distances from the player at which the target hint starts and peaks. */
const TELEGRAPH_FAR = 620;
const TELEGRAPH_NEAR = 260;

// ------------------------------------------------------------- materials

/** Generated sprite per material, with the procedural atlas name as fallback. */
const ASSET_ID = ['block_stone', 'block_crystal', 'block_amber'];
const ATLAS_ID = ['block/stone', 'block/crystal', 'block/amber'];

/**
 * The painted sprites carry transparent padding, and the cube inside is not
 * quite square or quite centred. These fractions were measured off the source
 * PNGs so all three materials read as exactly the same physical cube.
 */
const ASSET_FILL_W = [316 / 420, 306 / 420, 308 / 420];
const ASSET_FILL_H = [319 / 420, 311 / 420, 321 / 420];
const ASSET_CX = [0.5, 0.5095, 0.5];
const ASSET_CY = [0.4988, 0.4988, 0.494];

/**
 * How hard the dark pool behind the glyph is pushed, per material. The pale
 * crystal needs the most: a white letter on cyan is the worst case in the game.
 */
const POOL_ALPHA = [0.32, 0.54, 0.46];

/**
 * Debris tints, straight off the material ramps. Saturated rather than pale:
 * a grey chip against a bright dusk sky reads as a paper scrap, a slate-blue
 * or amber one reads as a piece of the block that was just there.
 */
const CHIP_HI: [number, number, number][] = [
  [0.4, 0.44, 0.6],
  [0.2, 0.6, 0.74],
  [0.79, 0.5, 0.17],
];
const CHIP_LO: [number, number, number][] = [
  [0.16, 0.17, 0.28],
  [0.09, 0.28, 0.38],
  [0.34, 0.18, 0.04],
];
const DUST_C: [number, number, number][] = [
  [0.72, 0.74, 0.86],
  [0.72, 0.9, 0.98],
  [0.93, 0.78, 0.55],
];

// --------------------------------------------------------------- scratch

/**
 * One reused emit record for every burst this file fires. `Particles.emit`
 * copies each value out immediately, so a single scratch is safe and the
 * smash costs zero allocations.
 */
const CEND: [number, number, number] = [1, 1, 1];
const EMIT: EmitOptions = {
  frame: null as unknown as Frame,
  x: 0,
  y: 0,
  count: 0,
  speed: [0, 0],
  angle: 0,
  spread: 0,
  life: [0, 0],
  size: [0, 0],
  sizeEnd: 0,
  color: [1, 1, 1],
  colorEnd: CEND,
  gravity: 0,
  drag: 0,
  spin: 0,
  additive: false,
  alpha: 1,
};

export class WallField {
  readonly walls: Wall[] = [];

  private spawnX = VIEW_W + TUNING.walls.initialAhead;

  private particles: Particles;

  /** Letter pool reused by `spawn` so building a column never allocates. */
  private pool: string[] = [];

  // Resolved once per draw: painted sprite if present, procedural if not.
  private faceFrame: (Frame | null)[] = [null, null, null];
  private faceKx = [0, 0, 0];
  private faceKy = [0, 0, 0];
  private faceOx = [0, 0, 0];
  private faceOy = [0, 0, 0];

  constructor(particles: Particles) {
    this.particles = particles;
  }

  /** Clear the field and lay down a fresh runway for a new word. */
  reset(ctx: Ctx, session: WordSession): void {
    this.walls.length = 0;
    // Seed a couple of walls off-screen so the first one arrives on beat.
    this.spawnX = VIEW_W + TUNING.walls.seedAhead;
    for (let i = 0; i < TUNING.walls.seedCount; i++) this.spawn(ctx, session);
  }

  spawn(ctx: Ctx, session: WordSession): void {
    const T = TUNING.walls;
    const word = session.word;

    // Every wall must contain the letter the player needs next, plus decoys.
    // Decoys are drawn from the word's own letters first so the choice is a
    // real spelling decision rather than a visual search.
    //
    // Only walls the player can STILL REACH may advance the target index. A
    // wall that has already scrolled past is unusable, so counting it here
    // pushed every future wall further along the word than the player could
    // ever get — the needed letter then never appeared again and the word
    // became unwinnable. Spent walls are excluded for the same reason.
    let reachable = 0;
    for (let i = 0; i < this.walls.length; i++) {
      const w = this.walls[i];
      if (!w.spent && !w.passed) reachable++;
    }
    const needIndex = Math.min(session.nextIndex + reachable, word.length - 1);
    const need = word[needIndex];

    const height = clamp(
      T.heightBase + Math.floor(session.tier / T.heightPerTier),
      T.heightMin,
      T.heightMax,
    );

    const pool = this.pool;
    pool.length = 0;
    pool.push(need);
    for (let i = 0; i < word.length && pool.length < height; i++) {
      const c = word[i];
      if (pool.indexOf(c) < 0) pool.push(c);
    }
    while (pool.length < height) {
      const c = String.fromCharCode(65 + ctx.rng.int(0, 26));
      if (pool.indexOf(c) < 0) pool.push(c);
    }
    ctx.rng.shuffle(pool);

    // Fit the column between the ground and the top of the frame: a 5-stack
    // tightens its spacing and shrinks a little rather than running off-screen.
    const bottomY = GROUND_Y - T.baseLift;
    const topMost = TOP_MARGIN + DRAW_W * 0.5;
    const gap =
      height > 1 ? Math.min(T.blockGap, (bottomY - topMost) / (height - 1)) : T.blockGap;
    const size = Math.min(DRAW_W, gap * 0.99);

    // Never repeat a material vertically: adjacent cubes always differ, which
    // is what lets a 5-tall column be counted at a glance while it scrolls.
    let mat = ctx.rng.int(0, 3);

    const blocks: Block[] = [];
    for (let i = 0; i < pool.length; i++) {
      blocks.push({
        letter: pool[i],
        ox: (ctx.rng.next() - 0.5) * 5,
        y: bottomY - i * gap,
        alive: true,
        mat,
        jolt: 0,
        born: 0,
        hoverT: 0,
        targetT: 0,
        sag: -26 - i * 6,
        sagV: 0,
        phase: ctx.rng.range(0, Math.PI * 2),
        lean: ctx.rng.signed() * 0.014,
        size,
        dx: 0,
        dy: 0,
        dsx: 1,
        dsy: 1,
        drot: 0,
      });
      mat = (mat + 1 + ctx.rng.int(0, 2)) % 3;
    }

    const last = this.walls[this.walls.length - 1];
    const x = last ? last.x + T.wallGap : this.spawnX;
    this.walls.push({ x, blocks, spent: false, passed: false });
  }

  /**
   * Shove every wall downfield — the ground a setback costs the player.
   *
   * A wall that lands back in front of the player is *in play again*, so its
   * `passed` flag has to be lifted with it. Leaving it set made the two columns
   * nearest the player after every setback into ghosts: still drawn, still
   * tappable, but skipped by the telegraph, by `ensureWinnable` and by the
   * spawner's reachable count — so the player was pushed back into a stretch of
   * track where the game had stopped pointing at the letter they needed, at the
   * exact moment they most needed pointing.
   */
  pushBack(distance: number, playerX: number): void {
    const line = playerX - TUNING.walls.passedInset;
    for (const w of this.walls) {
      w.x += distance;
      if (w.passed && w.x >= line) w.passed = false;
      // The shove is a physical event: every column feels it.
      for (const b of w.blocks) {
        b.jolt = Math.min(1, b.jolt + 0.8);
        b.sagV += 150;
      }
    }
  }

  // ------------------------------------------------------------------- fx

  /** Prime the shared emit record with neutral defaults. */
  private beginEmit(frame: Frame): EmitOptions {
    EMIT.frame = frame;
    EMIT.count = 1;
    EMIT.speed[0] = 0;
    EMIT.speed[1] = 0;
    EMIT.angle = 0;
    EMIT.spread = Math.PI;
    EMIT.life[0] = 0.4;
    EMIT.life[1] = 0.6;
    EMIT.size[0] = 20;
    EMIT.size[1] = 30;
    EMIT.sizeEnd = 0;
    EMIT.color[0] = 1;
    EMIT.color[1] = 1;
    EMIT.color[2] = 1;
    CEND[0] = 1;
    CEND[1] = 1;
    CEND[2] = 1;
    EMIT.gravity = 0;
    EMIT.drag = 0;
    EMIT.spin = 0;
    EMIT.additive = false;
    EMIT.alpha = 1;
    return EMIT;
  }

  /** Which material was standing at this spot — used to tint the debris. */
  private materialAt(x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    for (const w of this.walls) {
      const dx = Math.abs(w.x - x);
      if (dx > 140) continue;
      for (const b of w.blocks) {
        const d = dx + Math.abs(b.y - y);
        if (d < bestD) {
          bestD = d;
          best = b.mat;
        }
      }
    }
    return best;
  }

  /**
   * Blow a block apart.
   *
   * The player always arrives from the left, so the debris cone is biased up
   * and to the right: chunky chips that tumble under gravity, a white-hot core
   * flash, two shockwave rings at different speeds, and a dust plume that
   * lingers after the sparks have gone. Everything above the hole in the column
   * gets a downward kick and drops onto its spring.
   */
  shatter(ctx: Ctx, x: number, y: number): void {
    const mat = this.materialAt(x, y);
    const hi = CHIP_HI[mat];
    const lo = CHIP_LO[mat];
    const du = DUST_C[mat];

    // Core flash — one bright bloom, gone in a blink.
    let e = this.beginEmit(ctx.atlas.get('fx/glow'));
    e.x = x;
    e.y = y;
    e.count = 1;
    e.life[0] = 0.22;
    e.life[1] = 0.22;
    e.size[0] = 280;
    e.size[1] = 280;
    e.sizeEnd = 0.3;
    e.color[0] = 1;
    e.color[1] = 0.96;
    e.color[2] = 0.86;
    e.additive = true;
    e.alpha = 1;
    this.particles.emit(ctx, e);

    // Two rings: a fast hard one and a slower material-coloured one.
    e = this.beginEmit(ctx.atlas.get('fx/shockwave'));
    e.x = x;
    e.y = y;
    e.count = 1;
    e.life[0] = 0.26;
    e.life[1] = 0.26;
    e.size[0] = 110;
    e.size[1] = 110;
    e.sizeEnd = 4.2;
    e.additive = true;
    e.alpha = 1;
    this.particles.emit(ctx, e);

    e = this.beginEmit(ctx.atlas.get('fx/ring'));
    e.x = x;
    e.y = y;
    e.count = 1;
    e.life[0] = 0.32;
    e.life[1] = 0.32;
    e.size[0] = 60;
    e.size[1] = 60;
    e.sizeEnd = 5.5;
    e.color[0] = hi[0];
    e.color[1] = hi[1];
    e.color[2] = hi[2];
    e.additive = true;
    e.alpha = 0.85;
    this.particles.emit(ctx, e);

    // Chunky shards. Four shapes, biased along the impact vector.
    for (let i = 0; i < 4; i++) {
      e = this.beginEmit(ctx.atlas.get(`shard/${i}`));
      e.x = x;
      e.y = y;
      e.count = 4;
      e.speed[0] = 260;
      e.speed[1] = 780;
      e.angle = -0.45;
      e.spread = 1.5;
      e.life[0] = 0.55;
      e.life[1] = 1.05;
      e.size[0] = 26;
      e.size[1] = 58;
      e.sizeEnd = 0.55;
      e.color[0] = hi[0];
      e.color[1] = hi[1];
      e.color[2] = hi[2];
      CEND[0] = lo[0];
      CEND[1] = lo[1];
      CEND[2] = lo[2];
      e.gravity = 1900;
      e.drag = 0.6;
      e.spin = 14;
      this.particles.emit(ctx, e);
    }

    // Three slow, heavy chunks. These are what the eye actually tracks, so
    // they get the whole face's worth of mass and tumble the longest.
    e = this.beginEmit(ctx.atlas.get('shard/0'));
    e.x = x;
    e.y = y;
    e.count = 3;
    e.speed[0] = 200;
    e.speed[1] = 430;
    e.angle = -0.9;
    e.spread = 1.1;
    e.life[0] = 0.8;
    e.life[1] = 1.15;
    e.size[0] = 58;
    e.size[1] = 86;
    e.sizeEnd = 0.7;
    e.color[0] = hi[0];
    e.color[1] = hi[1];
    e.color[2] = hi[2];
    CEND[0] = lo[0];
    CEND[1] = lo[1];
    CEND[2] = lo[2];
    e.gravity = 2000;
    e.drag = 0.4;
    e.spin = 8;
    this.particles.emit(ctx, e);

    // Impact stars: the cartoon punctuation on top of the physical debris.
    e = this.beginEmit(ctx.atlas.get('fx/star'));
    e.x = x;
    e.y = y;
    e.count = 4;
    e.speed[0] = 140;
    e.speed[1] = 480;
    e.angle = -0.5;
    e.spread = 1.9;
    e.life[0] = 0.3;
    e.life[1] = 0.6;
    e.size[0] = 40;
    e.size[1] = 84;
    e.sizeEnd = 0.1;
    e.color[0] = 1;
    e.color[1] = 0.95;
    e.color[2] = 0.72;
    e.gravity = 180;
    e.drag = 2.6;
    e.spin = 5;
    e.additive = true;
    this.particles.emit(ctx, e);

    // A back-spray so the hole does not look one-sided.
    e = this.beginEmit(ctx.atlas.get('shard/1'));
    e.x = x;
    e.y = y;
    e.count = 5;
    e.speed[0] = 150;
    e.speed[1] = 420;
    e.angle = Math.PI * 0.85;
    e.spread = 0.9;
    e.life[0] = 0.5;
    e.life[1] = 0.9;
    e.size[0] = 16;
    e.size[1] = 34;
    e.sizeEnd = 0.5;
    e.color[0] = lo[0];
    e.color[1] = lo[1];
    e.color[2] = lo[2];
    e.gravity = 1900;
    e.drag = 0.8;
    e.spin = 16;
    this.particles.emit(ctx, e);

    // Sparks.
    e = this.beginEmit(ctx.atlas.get('fx/spark'));
    e.x = x;
    e.y = y;
    e.count = 18;
    e.speed[0] = 300;
    e.speed[1] = 940;
    e.angle = -0.35;
    e.spread = Math.PI;
    e.life[0] = 0.18;
    e.life[1] = 0.46;
    e.size[0] = 18;
    e.size[1] = 46;
    e.sizeEnd = 0;
    e.color[0] = 1;
    e.color[1] = 0.94;
    e.color[2] = 0.68;
    CEND[0] = 1;
    CEND[1] = 0.38;
    CEND[2] = 0.16;
    e.gravity = 320;
    e.drag = 2.4;
    e.additive = true;
    this.particles.emit(ctx, e);

    // Dust plume — the slow part that sells the weight.
    e = this.beginEmit(ctx.atlas.get('fx/dust'));
    e.x = x;
    e.y = y;
    e.count = 12;
    e.speed[0] = 60;
    e.speed[1] = 300;
    e.angle = -Math.PI * 0.5;
    e.spread = Math.PI;
    e.life[0] = 0.45;
    e.life[1] = 0.95;
    e.size[0] = 40;
    e.size[1] = 96;
    e.sizeEnd = 1.9;
    e.color[0] = du[0];
    e.color[1] = du[1];
    e.color[2] = du[2];
    e.gravity = -60;
    e.drag = 2.6;
    e.alpha = 0.6;
    this.particles.emit(ctx, e);

    this.jolt(x, y);
  }

  /** Kick the survivors in the column a smash just punched a hole in. */
  private jolt(x: number, y: number): void {
    for (const w of this.walls) {
      if (Math.abs(w.x - x) > 140) continue;
      for (const b of w.blocks) {
        if (!b.alive) continue;
        const above = b.y < y;
        b.jolt = 1;
        b.sagV += above ? 300 : 110;
      }
    }
  }

  /** Dry puff thrown backwards where a wall refused to break. */
  dust(ctx: Ctx, x: number, y: number): void {
    const du = DUST_C[this.materialAt(x, y)];
    let e = this.beginEmit(ctx.atlas.get('fx/dust'));
    e.x = x;
    e.y = y;
    e.count = 14;
    e.speed[0] = 120;
    e.speed[1] = 440;
    e.angle = Math.PI;
    e.spread = 1.2;
    e.life[0] = 0.3;
    e.life[1] = 0.72;
    e.size[0] = 26;
    e.size[1] = 64;
    e.sizeEnd = 1.7;
    e.color[0] = du[0];
    e.color[1] = du[1];
    e.color[2] = du[2];
    e.gravity = 260;
    e.drag = 2;
    e.alpha = 0.75;
    this.particles.emit(ctx, e);

    // A few chips fly off without the block breaking — it held.
    e = this.beginEmit(ctx.atlas.get('shard/2'));
    e.x = x;
    e.y = y;
    e.count = 4;
    e.speed[0] = 180;
    e.speed[1] = 430;
    e.angle = Math.PI * 0.86;
    e.spread = 0.7;
    e.life[0] = 0.35;
    e.life[1] = 0.7;
    e.size[0] = 12;
    e.size[1] = 24;
    e.sizeEnd = 0.4;
    e.color[0] = 0.75;
    e.color[1] = 0.72;
    e.color[2] = 0.7;
    e.gravity = 1700;
    e.drag = 0.9;
    e.spin = 12;
    this.particles.emit(ctx, e);
  }

  // --------------------------------------------------------------- update

  update(ctx: Ctx, dt: number, f: WallFrame): void {
    const T = TUNING.walls;
    const move = f.scrollSpeed * dt;
    const time = ctx.time;
    const calm = ctx.reducedMotion ? 0 : 1;

    // The telegraph only ever points at the nearest wall still holding the
    // player's next letter, and only once that wall is close enough that
    // finding it is a reaction rather than a puzzle.
    const need = f.session.needed;
    let target: Wall | null = null;
    let bestX = Infinity;
    for (const w of this.walls) {
      if (w.spent || w.passed) continue;
      if (w.x < f.playerX || w.x >= bestX) continue;
      bestX = w.x;
      target = w;
    }
    const prox = target
      ? clamp((TELEGRAPH_FAR - (bestX - f.playerX)) / (TELEGRAPH_FAR - TELEGRAPH_NEAR), 0, 1)
      : 0;

    for (const w of this.walls) {
      w.x -= move;
      const isTargetWall = w === target;

      for (const b of w.blocks) {
        if (b.born < 1) b.born = Math.min(1, b.born + dt * T.bornRate);
        b.jolt = damp(b.jolt, 0, T.joltDecay, dt);

        // Vertical spring: the block sags under an impact and rides back up.
        b.sagV += (-b.sag * SPRING_K - b.sagV * SPRING_D) * dt;
        b.sag = clamp(b.sag + b.sagV * dt, -34, 34);

        const hovered =
          ctx.input.hasHover &&
          b.alive &&
          Math.abs(ctx.input.hoverX - (w.x + b.ox)) < BLOCK_W * T.hoverPad &&
          Math.abs(ctx.input.hoverY - b.y) < BLOCK_H * T.hoverPad;
        b.hoverT = damp(b.hoverT, hovered ? 1 : 0, T.hoverEase, dt);

        const wanted = b.alive && isTargetWall && b.letter === need;
        b.targetT = damp(b.targetT, wanted ? prox : 0, 6, dt);

        // --- presentation transform ---------------------------------------
        const born = easeOutBack(clamp(b.born, 0, 1));
        const j = b.jolt;
        const wob = Math.sin(time * 34 + b.phase) * j;
        const breathe = b.targetT * 0.015 * (0.5 + 0.5 * Math.sin(time * 4.2 + b.phase));
        const drift = calm * Math.sin(time * 1.05 + b.phase) * 1.5;

        b.dx = w.x + b.ox + wob * 7 + drift;
        b.dy = b.y + b.sag;
        b.dsx = born * (1 + j * 0.1 + b.hoverT * 0.05 + breathe);
        b.dsy = born * (1 - j * 0.08 + b.hoverT * 0.05 + breathe);
        b.drot =
          b.lean +
          wob * 0.1 +
          calm * Math.sin(time * 0.8 + b.phase * 1.7) * 0.006;
      }

      // A wall that reaches the player without being cleared costs a miss but
      // never stops the run — it simply rolls past.
      if (!w.passed && w.x < f.playerX - T.passedInset) {
        w.passed = true;
        if (!w.spent) f.onPassed(w);
      }
    }
    while (this.walls.length && this.walls[0].x < T.despawnX) this.walls.shift();

    this.ensureWinnable(ctx, f.session, f.playerX);

    const last = this.walls[this.walls.length - 1];
    if (!last || last.x < VIEW_W + T.wallGap) {
      if (f.shouldSpawn()) this.spawn(ctx, f.session);
    }
  }

  /**
   * Guarantee the word stays winnable.
   *
   * Assigning each wall a target letter at spawn time is a *prediction* that
   * the player will consume walls in order. They do not have to: the correct
   * letter can be taken out of a later wall, a wall can roll past unused, and
   * a setback rewinds `nextIndex` under walls that are already on screen. Any
   * of those leaves every wall in play holding a stale target, and the letter
   * the player actually needs simply never appears again.
   *
   * So the prediction is backed by a check. If no reachable wall carries the
   * needed letter, one block in the furthest wall is relabelled — furthest
   * because it is the least likely to be under the player's eye, and because
   * it gives them the most time to see it coming.
   */
  private ensureWinnable(ctx: Ctx, session: WordSession, playerX: number): void {
    const word = session.word;
    const need = word[session.nextIndex];
    if (!need) return;

    let furthest: Wall | null = null;
    for (let i = 0; i < this.walls.length; i++) {
      const w = this.walls[i];
      if (w.spent || w.passed) continue;
      for (let j = 0; j < w.blocks.length; j++) {
        // A reachable wall already offers it — nothing to do.
        if (w.blocks[j].alive && w.blocks[j].letter === need) return;
      }
      if (!furthest || w.x > furthest.x) furthest = w;
    }
    // Nothing reachable yet; the next spawn will carry the letter.
    if (!furthest || furthest.x < playerX + TUNING.walls.wallGap * 0.5) return;

    // Prefer overwriting a letter the player will not need soon, and never
    // clobber the only copy of the letter needed immediately after this one.
    const soon = word[session.nextIndex + 1];
    const blocks = furthest.blocks;
    let victim = -1;
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[j];
      if (!b.alive || b.letter === need) continue;
      if (b.letter === soon && victim !== -1) continue;
      if (victim === -1 || b.letter !== soon) victim = j;
    }
    if (victim === -1) {
      for (let j = 0; j < blocks.length; j++) if (blocks[j].alive) victim = j;
    }
    if (victim === -1) return;

    blocks[victim].letter = need;
    // Re-seat it so the swap reads as the block settling, not a letter
    // flickering in place.
    blocks[victim].born = Math.min(blocks[victim].born, 0.35);
    blocks[victim].jolt = 1;
    void ctx;
  }

  /**
   * Which block is under this point.
   *
   * The boxes are deliberately larger than the cubes — at 390px a cube is only
   * 33 CSS px across, well under a thumb — which means vertically adjacent
   * boxes in a column overlap. So the winner is the *nearest centre*, not the
   * first box the scan happens to enter: blocks are stored bottom-up, and
   * first-match handed every tap in the overlap band to the lower block, so
   * aiming at the underside of the letter you wanted quietly smashed the one
   * below it and cost a life. Nearest-centre makes the boundary land exactly
   * where the player sees it, halfway between the two cubes, and lets the pads
   * stay generous rather than being shrunk to keep them disjoint.
   */
  blockAt(x: number, y: number): { wall: Wall; block: Block } | null {
    const T = TUNING.walls;
    const padX = BLOCK_W * T.hitPadX;
    const padY = BLOCK_H * T.hitPadY;
    let best: { wall: Wall; block: Block } | null = null;
    let bestD = Infinity;
    for (const w of this.walls) {
      const dx = w.x - x;
      if (dx > padX + T.hitScanSlack || dx < -(padX + T.hitScanSlack)) continue;
      for (const b of w.blocks) {
        if (!b.alive) continue;
        const bx = w.x + b.ox - x;
        const by = b.y - y;
        if (bx > padX || bx < -padX || by > padY || by < -padY) continue;
        // Normalised, so a tall pad and a wide pad are compared on equal terms.
        const nx = bx / padX;
        const ny = by / padY;
        const d = nx * nx + ny * ny;
        if (d < bestD) {
          bestD = d;
          if (best) {
            best.wall = w;
            best.block = b;
          } else {
            best = { wall: w, block: b };
          }
        }
      }
    }
    return best;
  }

  nearestBlockWithLetter(letter: string, playerX: number): { wall: Wall; block: Block } | null {
    const T = TUNING.walls;
    let best: { wall: Wall; block: Block } | null = null;
    let bestX = Infinity;
    for (const w of this.walls) {
      if (w.x < playerX - T.keyReachBack || w.x > VIEW_W + T.keyReachAhead) continue;
      for (const b of w.blocks) {
        if (b.alive && b.letter === letter && w.x < bestX) {
          bestX = w.x;
          best = { wall: w, block: b };
        }
      }
    }
    return best;
  }

  // ----------------------------------------------------------------- draw

  /**
   * Bind the painted cube sprites if they have been generated, otherwise the
   * procedural atlas faces. Per-material constants convert a desired cube size
   * straight into a draw scale and a centring offset.
   */
  private resolveFaces(ctx: Ctx): void {
    for (let m = 0; m < 3; m++) {
      const painted = ctx.assets.has(ASSET_ID[m]) ? ctx.assets.get(ASSET_ID[m]) : null;
      const f = painted ?? ctx.atlas.get(ATLAS_ID[m]);
      const fw = painted ? ASSET_FILL_W[m] : 1;
      const fh = painted ? ASSET_FILL_H[m] : 1;
      const cx = painted ? ASSET_CX[m] : 0.5;
      const cy = painted ? ASSET_CY[m] : 0.5;
      this.faceFrame[m] = f;
      this.faceKx[m] = 1 / (f.w * fw);
      this.faceKy[m] = 1 / (f.h * fh);
      this.faceOx[m] = (0.5 - cx) / fw;
      this.faceOy[m] = (0.5 - cy) / fh;
    }
  }

  draw(ctx: Ctx): void {
    const r = ctx.r;
    const time = ctx.time;
    this.resolveFaces(ctx);
    const glow = ctx.atlas.get('fx/glow');

    // --- pass 1: one additive run, drawn *behind* the cubes -----------------
    // Under-lighting the block spills a halo around its silhouette instead of
    // washing out the face, so the hint stays a hint and the paint survives.
    r.setBlend(Blend.Additive);
    for (const w of this.walls) {
      if (w.x < -CULL || w.x > VIEW_W + CULL) continue;
      for (const b of w.blocks) {
        if (!b.alive) continue;
        const pulse = 0.5 + 0.5 * Math.sin(time * 4.2 + b.phase);
        const a = b.hoverT * 0.4 + b.targetT * (0.1 + 0.13 * pulse);
        if (a <= 0.01) continue;
        r.draw(
          glow,
          b.dx,
          b.dy,
          (b.size * 2.1) / glow.w,
          (b.size * 2.1) / glow.h,
          0,
          1,
          0.86,
          0.5,
          a,
        );
      }
    }
    r.setBlend(Blend.Normal);

    // --- pass 2: cube faces, all on the generated-art texture --------------
    for (const w of this.walls) {
      if (w.x < -CULL || w.x > VIEW_W + CULL) continue;
      for (const b of w.blocks) {
        if (!b.alive || b.dsx <= 0) continue;
        const m = b.mat;
        const face = this.faceFrame[m]!;
        const sx = b.size * this.faceKx[m] * b.dsx;
        const sy = b.size * this.faceKy[m] * b.dsy;
        // Hover lifts the face; the telegraph warms it very slightly.
        const t = b.targetT;
        const lift = 1 + b.hoverT * 0.16;
        r.draw(
          face,
          b.dx + b.size * this.faceOx[m] * b.dsx,
          b.dy + b.size * this.faceOy[m] * b.dsy,
          sx,
          sy,
          b.drot,
          lift + t * 0.1,
          lift + t * 0.05,
          lift,
          1,
        );
      }
    }

    // --- pass 3: everything on the procedural atlas ------------------------
    // Kept last so the particle system, which draws next on the same texture
    // and the same blend mode, joins this batch instead of starting a new one.
    const soft = ctx.atlas.get('fx/dust');

    for (const w of this.walls) {
      if (w.x < -CULL || w.x > VIEW_W + CULL) continue;

      // Contact shadow. Sits entirely below the lowest cube's footprint, so
      // drawing it after the faces costs nothing and saves a texture bind.
      let alive = 0;
      let footX = w.x;
      for (const b of w.blocks) {
        if (!b.alive) continue;
        if (alive === 0) footX = b.dx;
        alive++;
      }
      if (alive > 0) {
        // The sun is high and to the right, so the pool leans left. A wide
        // soft spread plus a tight dark core is what plants a column on the
        // ground rather than leaving it hovering over it.
        const weight = 1 + (alive - 1) * 0.14;
        r.draw(
          soft,
          footX - 14,
          GROUND_Y + 6,
          (DRAW_W * 2.1 * weight) / soft.w,
          34 / soft.h,
          0,
          0,
          0,
          0.03,
          0.34,
        );
        r.draw(
          soft,
          footX - 6,
          GROUND_Y + 2,
          (DRAW_W * 0.95) / soft.w,
          16 / soft.h,
          0,
          0,
          0,
          0.02,
          0.5,
        );
      }

      for (const b of w.blocks) {
        if (!b.alive || b.dsx <= 0) continue;

        // A soft dark pool sunk into the face. This is what makes a white
        // glyph survive the pale crystal cube without recolouring the letter.
        r.draw(
          glow,
          b.dx,
          b.dy + b.size * 0.02,
          (b.size * POOL_FRACTION * b.dsx) / glow.w,
          (b.size * POOL_FRACTION * b.dsy) / glow.h,
          0,
          0.05,
          0.04,
          0.1,
          POOL_ALPHA[b.mat],
        );

        const gl = ctx.atlas.get(`glyph/${b.letter}`);
        const box = b.size * GLYPH_FRACTION;
        const gx = (box / gl.w) * b.dsx;
        const gy = (box / gl.h) * b.dsy;
        // Optical centre: the painted cubes carry a heavier bottom bevel, so
        // the letter sits a hair above the geometric middle.
        const cy = b.dy - b.size * 0.012;
        const o = box * OUTLINE_R;

        // Hard outline: four diagonal offsets, the lower-right one pushed out
        // further so it doubles as a cast shadow.
        r.draw(gl, b.dx - o, cy - o, gx, gy, b.drot, 0.04, 0.03, 0.08, 0.92);
        r.draw(gl, b.dx + o, cy - o, gx, gy, b.drot, 0.04, 0.03, 0.08, 0.92);
        r.draw(gl, b.dx - o, cy + o, gx, gy, b.drot, 0.04, 0.03, 0.08, 0.92);
        r.draw(gl, b.dx + o * 1.7, cy + o * 2.1, gx, gy, b.drot, 0.03, 0.02, 0.06, 0.85);

        // Fill. Constant near-white so the letter never changes identity;
        // the telegraph only warms it, it does not recolour it.
        const t = b.targetT;
        r.draw(
          gl,
          b.dx,
          cy,
          gx,
          gy,
          b.drot,
          1,
          lerp(0.985, 0.93, t),
          lerp(0.955, 0.72, t),
          1,
        );
      }
    }
  }
}
