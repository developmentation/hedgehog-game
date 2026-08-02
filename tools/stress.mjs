/**
 * CPU/memory stress harness.
 *
 * The game is GPU-fill bound today, which makes its CPU numbers look free and
 * therefore untested. This drives the *real* systems — the same `WallField`,
 * `Particles` and `Player` instances the game runs, through their real update
 * and draw paths — at 1x, 10x and 100x entity counts, and reports where the
 * CPU time actually goes, how many bytes a frame allocates, and which call
 * sites those bytes came from.
 *
 * Nothing is mocked. It reaches into the live scene through `window.__game`,
 * stops the loop so nothing else perturbs the clock, scales the population
 * using the systems' own spawners and constructors, and times each region.
 *
 *   node tools/stress.mjs                    1x / 10x / 100x timings + allocation
 *   node tools/stress.mjs --scales 1,4,10,40 custom ladder
 *   node tools/stress.mjs --live 60          60 s soak of the REAL loop, heap + GC
 *   node tools/stress.mjs --profile          + Chrome sampling profiler call tree
 *   node tools/stress.mjs --loop             + fixed-step headroom table
 *   node tools/stress.mjs --headed           real GPU instead of SwiftShader
 *   node tools/stress.mjs --json out.json    machine-readable results
 *
 * METHOD NOTE — why this is not a per-frame p50.
 *
 * `performance.now()` in a page that is not cross-origin isolated is coarsened
 * to 100 microseconds. A 3 microsecond region timed once per frame reads as
 * either 0 or 100 microseconds, so a per-frame median of anything small is
 * meaningless — the first version of this harness reported "0.0000 ms" for
 * every region at 1x, which is how the coarsening was found.
 *
 * So each region is benchmarked the way a microbenchmark has to be: the call
 * is repeated inside ONE timestamp pair until the block takes at least 25 ms,
 * seven blocks are run, and the median block's per-call cost is reported. The
 * clock is then three and a half orders of magnitude finer than the thing
 * being measured. Whole-frame numbers, which are large enough not to need it,
 * are also reported straight.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  const v = args[i + 1];
  return i === -1 ? d : v && !v.startsWith('--') ? v : d;
};

const PORT = Number(val('port', 5502));
const URL = `http://127.0.0.1:${PORT}/`;
const SCALES = String(val('scales', '1,10,100'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const HEADED = has('headed');
const DO_PROFILE = has('profile');
const DO_LOOP = has('loop');
/** Print the sampled allocation stacks, not just the leaf call sites. */
const DO_TREE = has('tree');
/**
 * Turn TurboFan inlining off for the run.
 *
 * The heap sampler walks the JS stack, and an allocation inside a function
 * that has been inlined into its caller is reported against the CALLER. That
 * is how the first pass of this audit came to blame `Loop.tick` for 84 bytes
 * a frame it does not allocate: `tick` had inlined the scene's whole update
 * path. With inlining off, every frame in the table is the function that
 * really allocated. Timings under this flag are not comparable to anything.
 */
const NO_INLINE = has('noinline');
/** Skip heap allocation sampling, so the GC trace is not inflated by it. */
const NO_SAMPLE = has('nosample');
const LIVE_SECONDS = has('live') ? Number(val('live', 60)) : 0;
/**
 * Run against the dev server instead of the production build.
 *
 * The production bundle is one minified line, so every allocation site the
 * heap sampler reports reads `f @ index-XXXX.js:106` and attributes nothing.
 * The dev server serves each module separately with its original function
 * names, which is what makes the allocation table readable. Timings are a few
 * per cent slower (unminified, no tree-shake) so the ladder is normally run
 * against the build; `--dev` is for finding out WHERE.
 */
const DEV = has('dev');
const JSON_OUT = val('json');
const BLOCK_MS = Number(val('blockms', 25));
/**
 * Walls that count as "1x".
 *
 * Deliberately a constant rather than whatever the live field happened to be
 * holding when the rig was installed. The field's population breathes between
 * three and five walls depending on where in the word the run is, so a ladder
 * scaled off the live sample put 400 walls in one run's 100x arm and 300 in
 * the next — and two runs of the same build then differed by a third. Four is
 * the game's typical on-screen population.
 */
const BASE_WALLS = Number(val('basewalls', 4));
/** Particles that count as "1x". Same reasoning. */
const BASE_PARTICLES = Number(val('baseparticles', 40));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill a spawned server and everything it started. */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    child.kill();
  }
}

async function up(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(URL)).ok) return true;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The in-page rig. Installed once as `window.__stress`.
// ---------------------------------------------------------------------------

function installRig(blockMs) {
  const g = window.__game;
  const ctx = g.ctx;
  const scene = g.stack.top;

  ctx.audio?.setMuted?.(true);

  const DT = 1 / 120;
  const noop = function () {};

  const S = {
    g,
    ctx,
    scene,
    field: scene.field,
    particles: scene.particles,
    player: scene.player,
    PlayerClass: scene.player.constructor,
    heroes: [scene.player],
    blockMs,
    // One stable frame record for `WallField.update`, so what is measured is
    // the field's own cost and not the scene's per-step wiring. The scene's
    // wiring is measured separately, by the live soak.
    wf: {
      session: scene.session,
      scrollSpeed: 0,
      playerX: 300,
      onPassed: noop,
      shouldSpawn: function () {
        return false;
      },
    },
    // Speed, gravity and drag are all zero so the population can be aged to
    // mid-life in one big step without the particles flying out of the view
    // and being culled. Mid-life matters: `Particles.draw` fades in over the
    // first 12% of a particle's life and out over the rest, so a freshly
    // emitted particle has alpha 0 and is rejected by `Renderer.draw` before
    // it costs anything. The first version of this harness measured exactly
    // that — an empty loop — and reported particle draw as free.
    emit: {
      frame: null,
      x: 0,
      y: 0,
      count: 0,
      speed: [0, 0],
      angle: 0,
      spread: Math.PI,
      life: [100, 100],
      size: [18, 44],
      sizeEnd: 1,
      color: [1, 0.9, 0.7],
      colorEnd: [0.6, 0.5, 0.4],
      gravity: 0,
      drag: 0,
      spin: 3,
      additive: false,
      alpha: 0.8,
    },
  };

  S.base = {
    walls: scene.field.walls.length,
    blocks: scene.field.walls.reduce((n, w) => n + w.blocks.length, 0),
    particles: scene.particles.live,
  };

  S.stopLoop = function () {
    g.loop.stop();
  };
  S.startLoop = function () {
    g.loop.start();
  };

  /** Grow the wall field to `n` walls and spread them across the view. */
  S.setWalls = function (n) {
    const f = S.field;
    let guard = 0;
    while (f.walls.length < n && guard++ < n + 16) f.spawn(ctx, scene.session);
    f.walls.length = Math.min(f.walls.length, n);
    // Spread across the visible band: the field culls on `w.x`, so a stress
    // test whose entities are off-screen measures the cull and nothing else.
    const span = 1480;
    for (let i = 0; i < f.walls.length; i++) {
      const w = f.walls[i];
      w.x = -100 + (span / Math.max(1, f.walls.length)) * i;
      w.spent = false;
      w.passed = false;
      for (const b of w.blocks) b.born = 1;
    }
    return f.walls.reduce((k, w) => k + w.blocks.length, 0);
  };

  /**
   * Fill the particle pool to `n` live particles.
   *
   * Re-seeded immediately before every particle measurement, because the hero
   * benchmark runs `Player.update` a few million times and each of those
   * emits footfall and roll dust — left alone it pins the pool at its 2048
   * capacity and every particle arm silently measures 2048 regardless of the
   * scale it claims to be testing.
   *
   * `life` picks the arm. Draw needs a population at mid-life, because the
   * fade curve makes a newborn particle alpha-0 and `Renderer.draw` rejects
   * it before it costs anything; update needs a population that cannot expire
   * during its own several-million-iteration benchmark.
   */
  S.setParticles = function (n, life) {
    const p = S.particles;
    p.clear();
    const L = life || 1e5;
    const o = S.emit;
    o.frame = ctx.atlas.get('fx/dust');
    o.life[0] = L;
    o.life[1] = L;
    let placed = 0;
    while (p.live < n && placed < n + 128) {
      o.count = Math.min(8, n - p.live);
      if (o.count <= 0) break;
      o.x = 60 + ((placed * 137) % 1160);
      o.y = 80 + ((placed * 253) % 500);
      p.emit(ctx, o);
      placed += o.count;
    }
    // Age to half-life in one step. Velocity, gravity and drag are zero, so
    // nothing moves and nothing leaves the view.
    if (!life) p.update(L * 0.5);
    return p.live;
  };

  /** Grow the hero population. Real `Player` instances, real update and draw. */
  S.setHeroes = function (n) {
    while (S.heroes.length < n) {
      const h = new S.PlayerClass(S.particles);
      h.x = 200 + ((S.heroes.length * 91) % 900);
      h.y = 560 - ((S.heroes.length * 47) % 180);
      S.heroes.push(h);
    }
    S.heroes.length = Math.max(1, n);
    return S.heroes.length;
  };

  // ------------------------------------------------------------- benchmark
  /**
   * Per-call cost of `fn`, in ms. Calibrates an iteration count that makes one
   * timed block last `blockMs`, then reports the median of seven blocks.
   */
  S.bench = function (fn) {
    for (let i = 0; i < 200; i++) fn(); // tier the function up before timing
    let iters = 1;
    for (let guard = 0; guard < 40; guard++) {
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) fn();
      const el = performance.now() - t0;
      if (el >= S.blockMs) break;
      iters = Math.max(iters + 1, Math.ceil((iters * (S.blockMs + 2)) / Math.max(el, 0.05)));
      if (iters > 4e6) break;
    }
    const rounds = [];
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) fn();
      rounds.push((performance.now() - t0) / iters);
    }
    rounds.sort(function (a, b) {
      return a - b;
    });
    return { ms: rounds[3], iters: iters, min: rounds[0], max: rounds[6] };
  };

  // ------------------------------------------------------- timed regions
  S.regions = {
    fieldUpdate: function () {
      ctx.time += DT;
      S.field.update(ctx, DT, S.wf);
    },
    particlesUpdate: function () {
      S.particles.update(DT);
    },
    heroUpdate: function () {
      const h = S.heroes;
      for (let i = 0; i < h.length; i++) h[i].update(ctx, DT, 260, noop);
    },
    fieldDraw: function () {
      S.field.draw(ctx);
      ctx.r.flush();
    },
    particlesDraw: function () {
      S.particles.draw(ctx);
      ctx.r.flush();
    },
    heroDraw: function () {
      const h = S.heroes;
      for (let i = 0; i < h.length; i++) h[i].draw(ctx);
      ctx.r.flush();
    },
    heroShade: function () {
      const h = S.heroes;
      for (let i = 0; i < h.length; i++) h[i].drawShade(ctx);
      ctx.r.flush();
    },
  };

  /**
   * Draw regions are benchmarked with the GL flush stubbed out.
   *
   * `Renderer.flush` is a `bufferSubData` plus a `drawArraysInstanced`; on
   * SwiftShader that is a software rasteriser and it would swamp the number
   * being asked for, which is the CPU cost of BUILDING the instance buffer.
   * The stub keeps every byte of `Renderer.draw` — cull test, transform,
   * texture-slot selection, 17 float writes — and drops only the upload.
   */
  S.benchDraw = function (name) {
    const r = ctx.r;
    r.resetStats();
    r.begin(0, 0, 1);
    const real = r.flush;
    r.flush = function () {
      this.count = 0;
      this.slotCount = 0;
      this.lastSlot = 0;
    };
    let out;
    try {
      out = S.bench(S.regions[name]);
    } finally {
      r.flush = real;
      r.count = 0;
      r.slotCount = 0;
      r.lastSlot = 0;
      r.end();
    }
    return out;
  };

  /** One whole real frame: update every system, then render it for real. */
  S.realFrame = function () {
    const r = ctx.r;
    ctx.time += DT;
    S.field.update(ctx, DT, S.wf);
    S.particles.update(DT);
    for (let i = 0; i < S.heroes.length; i++) S.heroes[i].update(ctx, DT, 260, noop);
    r.resetStats();
    r.clear(0.05, 0.07, 0.18);
    r.begin(0, 0, 1);
    for (let i = 0; i < S.heroes.length; i++) S.heroes[i].drawShade(ctx);
    S.field.draw(ctx);
    S.particles.draw(ctx);
    for (let i = 0; i < S.heroes.length; i++) S.heroes[i].draw(ctx);
    r.end();
  };

  S.sprites = function () {
    return { sprites: ctx.r.spritesDrawn, drawCalls: ctx.r.drawCalls };
  };

  /**
   * How many quads each system actually submits, counted by wrapping
   * `Renderer.draw` for exactly one frame. Untimed, so the wrapper's own cost
   * does not matter — this answers "what is the CPU paying per entity".
   */
  S.census = function () {
    const r = ctx.r;
    const real = r.draw;
    const c = { shade: 0, field: 0, particles: 0, heroes: 0 };
    let cur = 'shade';
    r.draw = function (f, x, y, sx, sy, rot, cr, cg, cb, a) {
      c[cur]++;
      return real.call(this, f, x, y, sx, sy, rot, cr, cg, cb, a);
    };
    r.resetStats();
    r.begin(0, 0, 1);
    try {
      cur = 'shade';
      for (let i = 0; i < S.heroes.length; i++) S.heroes[i].drawShade(ctx);
      cur = 'field';
      S.field.draw(ctx);
      cur = 'particles';
      S.particles.draw(ctx);
      cur = 'heroes';
      for (let i = 0; i < S.heroes.length; i++) S.heroes[i].draw(ctx);
    } finally {
      r.draw = real;
    }
    c.submitted = r.count;
    r.end();
    c.reachedGl = r.spritesDrawn;
    return c;
  };

  S.heap = function () {
    const m = performance.memory;
    return m ? m.usedJSHeapSize : 0;
  };
  S.gc = function () {
    if (typeof window.gc === 'function') {
      window.gc();
      return true;
    }
    return false;
  };

  // ------------------------------------------------------- layout experiment
  /**
   * Array-of-structs versus struct-of-arrays, for the wall blocks.
   *
   * `Particles` is already SoA; `WallField` is one object per block. To ask
   * whether that costs anything, both arms below run the SAME arithmetic —
   * a transcription of `WallField.update`'s per-block body — over the same
   * population, differing only in where the numbers live. Both are harness
   * code, so neither gets a JIT advantage the other does not.
   *
   * Each layout is also run in a "physics only" form with the four sines and
   * the presentation transform removed. The full form is what the game does;
   * the reduced form is where a layout difference could actually be visible,
   * because a body that spends most of its time inside `Math.sin` is not
   * memory-bound and will report that layout does not matter.
   */
  S.buildLayouts = function () {
    const blocks = [];
    const wallX = [];
    for (let i = 0; i < S.field.walls.length; i++) {
      const w = S.field.walls[i];
      for (let j = 0; j < w.blocks.length; j++) {
        blocks.push(w.blocks[j]);
        wallX.push(w.x);
      }
    }
    const n = blocks.length;
    const soa = {
      n,
      wx: new Float32Array(n),
      ox: new Float32Array(n),
      y: new Float32Array(n),
      jolt: new Float32Array(n),
      born: new Float32Array(n),
      hoverT: new Float32Array(n),
      targetT: new Float32Array(n),
      sag: new Float32Array(n),
      sagV: new Float32Array(n),
      phase: new Float32Array(n),
      lean: new Float32Array(n),
      dx: new Float32Array(n),
      dy: new Float32Array(n),
      dsx: new Float32Array(n),
      dsy: new Float32Array(n),
      drot: new Float32Array(n),
      alive: new Uint8Array(n),
      letter: new Uint8Array(n),
      isTarget: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      soa.wx[i] = wallX[i];
      soa.ox[i] = b.ox;
      soa.y[i] = b.y;
      soa.jolt[i] = b.jolt;
      soa.born[i] = b.born;
      soa.hoverT[i] = b.hoverT;
      soa.targetT[i] = b.targetT;
      soa.sag[i] = b.sag;
      soa.sagV[i] = b.sagV;
      soa.phase[i] = b.phase;
      soa.lean[i] = b.lean;
      soa.alive[i] = b.alive ? 1 : 0;
      soa.letter[i] = b.letter.charCodeAt(0);
      soa.isTarget[i] = 0;
    }
    S.aos = { blocks, wallX, n };
    S.soa = soa;
    return n;
  };

  // Constants transcribed from wallField.ts so both arms run identical maths.
  const SPRING_K = 300;
  const SPRING_D = 16;
  const OB_S = 1.70158;
  const easeBack = function (t) {
    return 1 + (OB_S + 1) * Math.pow(t - 1, 3) + OB_S * Math.pow(t - 1, 2);
  };
  const cl = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };

  S.layoutBench = function (full) {
    const dt = DT;
    const time = ctx.time;
    const kJolt = Math.exp(-9 * dt);
    const kHover = Math.exp(-14 * dt);
    const kTarget = Math.exp(-6 * dt);
    const hasHover = true;
    const hoverX = 640;
    const hoverY = 400;
    const padX = 74;
    const padY = 74;
    const need = 65;
    const prox = 0.7;
    const calm = 1;

    const aosFn = function () {
      const A = S.aos;
      const bs = A.blocks;
      const wxs = A.wallX;
      for (let i = 0; i < A.n; i++) {
        const b = bs[i];
        const wx = wxs[i];
        if (b.born < 1) b.born = Math.min(1, b.born + dt * 3.4);
        b.jolt *= kJolt;
        b.sagV += (-b.sag * SPRING_K - b.sagV * SPRING_D) * dt;
        b.sag = cl(b.sag + b.sagV * dt, -34, 34);
        const hovered =
          hasHover &&
          b.alive &&
          Math.abs(hoverX - (wx + b.ox)) < padX &&
          Math.abs(hoverY - b.y) < padY;
        const ht = hovered ? 1 : 0;
        b.hoverT = ht + (b.hoverT - ht) * kHover;
        const tt = b.alive && b.letter.charCodeAt(0) === need ? prox : 0;
        b.targetT = tt + (b.targetT - tt) * kTarget;
        if (!full) continue;
        const born = b.born >= 1 ? 1 : easeBack(cl(b.born, 0, 1));
        const j = b.jolt;
        const wob = Math.sin(time * 34 + b.phase) * j;
        const breathe = b.targetT * 0.015 * (0.5 + 0.5 * Math.sin(time * 4.2 + b.phase));
        const drift = calm * Math.sin(time * 1.05 + b.phase) * 1.5;
        b.dx = wx + b.ox + wob * 7 + drift;
        b.dy = b.y + b.sag;
        b.dsx = born * (1 + j * 0.1 + b.hoverT * 0.05 + breathe);
        b.dsy = born * (1 - j * 0.08 + b.hoverT * 0.05 + breathe);
        b.drot = b.lean + wob * 0.1 + calm * Math.sin(time * 0.8 + b.phase * 1.7) * 0.006;
      }
    };

    const soaFn = function () {
      const S2 = S.soa;
      const n = S2.n;
      const wx = S2.wx, ox = S2.ox, yy = S2.y, jolt = S2.jolt, born = S2.born;
      const hoverT = S2.hoverT, targetT = S2.targetT, sag = S2.sag, sagV = S2.sagV;
      const phase = S2.phase, lean = S2.lean, alive = S2.alive, letter = S2.letter;
      const dx = S2.dx, dy = S2.dy, dsx = S2.dsx, dsy = S2.dsy, drot = S2.drot;
      for (let i = 0; i < n; i++) {
        if (born[i] < 1) born[i] = Math.min(1, born[i] + dt * 3.4);
        jolt[i] *= kJolt;
        sagV[i] += (-sag[i] * SPRING_K - sagV[i] * SPRING_D) * dt;
        sag[i] = cl(sag[i] + sagV[i] * dt, -34, 34);
        const hovered =
          hasHover &&
          alive[i] === 1 &&
          Math.abs(hoverX - (wx[i] + ox[i])) < padX &&
          Math.abs(hoverY - yy[i]) < padY;
        const ht = hovered ? 1 : 0;
        hoverT[i] = ht + (hoverT[i] - ht) * kHover;
        const tt = alive[i] === 1 && letter[i] === need ? prox : 0;
        targetT[i] = tt + (targetT[i] - tt) * kTarget;
        if (!full) continue;
        const bn = born[i] >= 1 ? 1 : easeBack(cl(born[i], 0, 1));
        const j = jolt[i];
        const wob = Math.sin(time * 34 + phase[i]) * j;
        const breathe = targetT[i] * 0.015 * (0.5 + 0.5 * Math.sin(time * 4.2 + phase[i]));
        const drift = calm * Math.sin(time * 1.05 + phase[i]) * 1.5;
        dx[i] = wx[i] + ox[i] + wob * 7 + drift;
        dy[i] = yy[i] + sag[i];
        dsx[i] = bn * (1 + j * 0.1 + hoverT[i] * 0.05 + breathe);
        dsy[i] = bn * (1 - j * 0.08 + hoverT[i] * 0.05 + breathe);
        drot[i] = lean[i] + wob * 0.1 + calm * Math.sin(time * 0.8 + phase[i] * 1.7) * 0.006;
      }
    };

    /**
     * The same AoS body with the four sines replaced by an angle-addition
     * expansion: sin(k*t + p) = sin(k*t)cos(p) + cos(k*t)sin(p), with the four
     * sin/cos(k*t) computed once per update and sin/cos(p) cached per block.
     * Mathematically identical, not bit-identical. This arm exists to price
     * the change before anyone writes it into the game.
     */
    const trigFn = function () {
      const A = S.aos;
      const bs = A.blocks;
      const wxs = A.wallX;
      const s34 = Math.sin(time * 34), c34 = Math.cos(time * 34);
      const s42 = Math.sin(time * 4.2), c42 = Math.cos(time * 4.2);
      const s10 = Math.sin(time * 1.05), c10 = Math.cos(time * 1.05);
      const s08 = Math.sin(time * 0.8), c08 = Math.cos(time * 0.8);
      for (let i = 0; i < A.n; i++) {
        const b = bs[i];
        const wx = wxs[i];
        if (b.born < 1) b.born = Math.min(1, b.born + dt * 3.4);
        b.jolt *= kJolt;
        b.sagV += (-b.sag * SPRING_K - b.sagV * SPRING_D) * dt;
        b.sag = cl(b.sag + b.sagV * dt, -34, 34);
        const hovered =
          hasHover &&
          b.alive &&
          Math.abs(hoverX - (wx + b.ox)) < padX &&
          Math.abs(hoverY - b.y) < padY;
        const ht = hovered ? 1 : 0;
        b.hoverT = ht + (b.hoverT - ht) * kHover;
        const tt = b.alive && b.letter.charCodeAt(0) === need ? prox : 0;
        b.targetT = tt + (b.targetT - tt) * kTarget;
        const born = b.born >= 1 ? 1 : easeBack(cl(b.born, 0, 1));
        const j = b.jolt;
        const sp = b.__sp, cp = b.__cp, sq = b.__sq, cq = b.__cq;
        const wob = (s34 * cp + c34 * sp) * j;
        const breathe = b.targetT * 0.015 * (0.5 + 0.5 * (s42 * cp + c42 * sp));
        const drift = calm * (s10 * cp + c10 * sp) * 1.5;
        b.dx = wx + b.ox + wob * 7 + drift;
        b.dy = b.y + b.sag;
        b.dsx = born * (1 + j * 0.1 + b.hoverT * 0.05 + breathe);
        b.dsy = born * (1 - j * 0.08 + b.hoverT * 0.05 + breathe);
        b.drot = b.lean + wob * 0.1 + calm * (s08 * cq + c08 * sq) * 0.006;
      }
    };
    for (let i = 0; i < S.aos.n; i++) {
      const b = S.aos.blocks[i];
      b.__sp = Math.sin(b.phase);
      b.__cp = Math.cos(b.phase);
      b.__sq = Math.sin(b.phase * 1.7);
      b.__cq = Math.cos(b.phase * 1.7);
    }

    // Interleaved A, B, A, B ... so ambient load lands on both equally, then
    // the median of each arm. Three other agents were running browsers on this
    // machine throughout; a single pair of blocks put the two arms 40% apart
    // in one direction and 2% apart in the other on consecutive scales.
    const A = [];
    const B = [];
    const C = [];
    for (let r = 0; r < 5; r++) {
      A.push(S.bench(aosFn).ms);
      B.push(S.bench(soaFn).ms);
      if (full) C.push(S.bench(trigFn).ms);
    }
    const sortNum = function (x, y) { return x - y; };
    A.sort(sortNum);
    B.sort(sortNum);
    C.sort(sortNum);
    return { n: S.aos.n, aos: A[2], soa: B[2], trig: full ? C[2] : 0 };
  };

  /** Update-only steps, for the allocation reading: no GL involved at all. */
  S.updateOnly = function (n) {
    for (let i = 0; i < n; i++) {
      ctx.time += DT;
      S.field.update(ctx, DT, S.wf);
      S.particles.update(DT);
      for (let k = 0; k < S.heroes.length; k++) S.heroes[k].update(ctx, DT, 260, noop);
    }
  };

  window.__stress = S;
  return S.base;
}

// ---------------------------------------------------------------------------

const f2 = (n) => (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
const pad = (s, n) => String(s).padStart(n);

/**
 * Fold the sampled allocation tree onto call sites.
 *
 * Frames with no URL are the harness's own: Playwright injects an unnamed
 * script to serialise `evaluate` results, and V8 reports its internal
 * subsystems (PARSER, BYTECODE_COMPILER, IDLE_EXTERNAL) the same way. They are
 * kept in the total — hiding them would make the game look cleaner than the
 * measurement is — but flagged, so the game's own bytes can be read off.
 */
function flattenHeapProfile(head) {
  const sites = new Map();
  const stacks = [];
  let total = 0;
  let appTotal = 0;
  const path = [];
  const walk = (node) => {
    const self = node.selfSize || 0;
    total += self;
    const f = node.callFrame || {};
    const url = String(f.url || '');
    const app = url.includes('://') && !url.includes('/node_modules/');
    const file = url.split('/').pop() || '(harness/v8)';
    const key = `${app ? '' : '~ '}${f.functionName || '(anonymous)'} @ ${file}:${f.lineNumber ?? -1}`;
    path.push(`${f.functionName || '(anon)'}@${file}:${f.lineNumber ?? -1}`);
    if (self > 0) {
      if (app) appTotal += self;
      const e = sites.get(key) || { bytes: 0, app };
      e.bytes += self;
      sites.set(key, e);
      stacks.push({ bytes: self, stack: path.slice().reverse() });
    }
    for (const c of node.children || []) walk(c);
    path.pop();
  };
  walk(head);
  return {
    sites: [...sites.entries()]
      .map(([site, e]) => [site, e.bytes, e.app])
      .sort((a, b) => b[1] - a[1]),
    stacks: stacks.sort((a, b) => b.bytes - a.bytes),
    total,
    appTotal,
  };
}

async function main() {
  let server = null;
  if (!(await up(1200))) {
    const argv = DEV
      ? ['vite', '--port', String(PORT), '--strictPort']
      : ['vite', 'preview', '--port', String(PORT), '--strictPort'];
    // `detached` so the whole tree can be killed on the way out. With
    // `shell: true` alone, `server.kill()` kills the shell and leaves the vite
    // process listening — eighteen of them accumulated during this audit and
    // one of them held an open handle on `dist/`, which made `vite build` fail
    // to empty its own output directory.
    server = spawn('npx', argv, { shell: true, stdio: 'ignore', detached: true });
    if (!(await up(60000))) throw new Error('server did not start');
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--mute-audio',
      `--js-flags=--expose-gc${NO_INLINE ? ' --no-turbo-inlining' : ''}`,
      '--enable-precise-memory-info',
      ...(HEADED ? [] : ['--enable-unsafe-swiftshader', '--use-gl=angle']),
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(URL, { waitUntil: 'load' });
  if (DEV) {
    // The dev server rewrites its dependency pre-bundle on first load and
    // reloads the page underneath us. Take the hit once, deliberately, rather
    // than losing the execution context halfway through a 60 s soak.
    await sleep(3000);
    await page.reload({ waitUntil: 'load' });
  }
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  await page.mouse.click(640, 400);
  await sleep(2500);

  const cdp = await page.context().newCDPSession(page);
  const results = { arms: [], alloc: null, live: null, profile: null, loop: null };

  // ------------------------------------------------------- the live soak
  //
  // Runs the REAL loop, the real scene, the real per-step wiring, for N
  // seconds. This is the only arm that sees `PlayScene.update`, and therefore
  // the only one that can see allocation the scene makes on the systems'
  // behalf.
  if (LIVE_SECONDS > 0) {
    // The heap sampler is not free: it intercepts allocations, and leaving it
    // on inflates the very GC cost the trace is measuring. `--nosample` gets
    // the collector's honest number at the price of losing the attribution.
    if (!NO_SAMPLE) {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
    }

    // What the allocation actually costs. Bytes per frame is only half the
    // story; the half that matters is how much of the frame the collector
    // takes back. V8 emits a trace event per collection with its duration, so
    // this is the collector's own number rather than an inference from a
    // sawtooth in the heap graph.
    const gcEvents = [];
    const onTrace = (e) => {
      for (const ev of e.value || []) {
        const n = ev.name || '';
        if (
          ev.dur > 0 &&
          (n === 'V8.GCScavenger' ||
            n === 'V8.GCFinalizeMC' ||
            n === 'V8.GCIncrementalMarking' ||
            n === 'MinorGC' ||
            n === 'MajorGC')
        ) {
          gcEvents.push({ name: n, dur: ev.dur });
        }
      }
    };
    cdp.on('Tracing.dataCollected', onTrace);
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['v8', 'disabled-by-default-v8.gc'] },
    });

    // Sampled from Node rather than from one long in-page `await`: a soak that
    // holds a single execution context for a minute loses everything if the
    // page so much as reloads, and the dev server reloads it.
    const sampler = () =>
      page.evaluate(() => {
        const g = window.__game;
        const m = performance.memory;
        return {
          heap: m ? m.usedJSHeapSize : 0,
          fps: g.loop.stats.fps,
          updateMs: g.loop.stats.updateMs,
          renderMs: g.loop.stats.renderMs,
          longFrames: g.loop.stats.longFrames,
          now: performance.now(),
        };
      });
    // Nothing talks to the page during the soak.
    //
    // The first version sampled the heap ten times a second, and every one of
    // those `evaluate` round trips allocates in the page to serialise its
    // result — enough to trigger scavenges of its own. It reported 48
    // collections and 2.6 ms of GC per second for a game that allocates 26
    // bytes a step. The harness was most of what it was measuring.
    await page.evaluate(() => typeof window.gc === 'function' && window.gc());
    const first = await sampler();
    await sleep(LIVE_SECONDS * 1000);
    const last = await sampler();
    const live = {
      seconds: (last.now - first.now) / 1000,
      heapStart: first.heap,
      heapEnd: last.heap,
      fps: last.fps,
      updateMs: last.updateMs,
      renderMs: last.renderMs,
      longFrames: last.longFrames,
    };
    const tracingDone = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
    await cdp.send('Tracing.end');
    await tracingDone;
    cdp.off('Tracing.dataCollected', onTrace);

    let flat = { sites: [], stacks: [], total: 0, appTotal: 0 };
    if (!NO_SAMPLE) {
      const { profile } = await cdp.send('HeapProfiler.stopSampling');
      await cdp.send('HeapProfiler.disable');
      flat = flattenHeapProfile(profile.head);
    }

    const gcByKind = new Map();
    let gcTotalUs = 0;
    let gcWorstUs = 0;
    for (const e of gcEvents) {
      const k = gcByKind.get(e.name) || { n: 0, us: 0, worst: 0 };
      k.n++;
      k.us += e.dur;
      if (e.dur > k.worst) k.worst = e.dur;
      gcByKind.set(e.name, k);
      gcTotalUs += e.dur;
      if (e.dur > gcWorstUs) gcWorstUs = e.dur;
    }
    live.gc = {
      totalMs: gcTotalUs / 1000,
      worstMs: gcWorstUs / 1000,
      msPerSecond: gcTotalUs / 1000 / live.seconds,
      byKind: [...gcByKind.entries()].map(([name, k]) => ({
        name,
        count: k.n,
        totalMs: k.us / 1000,
        worstMs: k.worst / 1000,
      })),
    };

    const simSteps = live.seconds * 120;
    live.sampledBytes = flat.total;
    live.appBytes = flat.appTotal;
    live.bytesPerSimStep = flat.total / simSteps;
    live.appBytesPerSimStep = flat.appTotal / simSteps;
    live.top = flat.sites.slice(0, 26).map(([site, bytes, app]) => ({
      site,
      bytes,
      app,
      perSimStep: bytes / simSteps,
    }));
    results.live = live;

    console.log(`\n=== live soak: ${live.seconds.toFixed(1)} s of the real loop at ${live.fps.toFixed(0)} fps`);
    console.log(`    loop stats      update ${live.updateMs.toFixed(3)} ms  render ${live.renderMs.toFixed(3)} ms  long frames ${live.longFrames}`);
    console.log(`    heap            ${(live.heapStart / 1048576).toFixed(2)} -> ${(live.heapEnd / 1048576).toFixed(2)} MB`);
    // Counts are trustworthy; the durations are not.
    //
    // V8 schedules most scavenges into the browser's idle period between
    // frames, and the trace event that carries them is the idle task, so its
    // `dur` is the length of the idle slot rather than the pause. A run here
    // reported a 2.2 second "MinorGC" while the loop's own `longFrames`
    // counter — frames whose CPU exceeded 14 ms — stayed at zero. The count is
    // the collection rate; `longFrames` is the frame-time impact, and that is
    // the number to read.
    for (const k of live.gc.byKind) {
      if (k.name === 'MinorGC' || k.name === 'MajorGC')
        console.log(`    ${k.name.padEnd(15)} ${k.count} in ${live.seconds.toFixed(0)} s = ${(k.count / live.seconds).toFixed(2)}/s`);
    }
    console.log(`    frames over budget (loop's own counter, 14 ms of CPU): ${live.longFrames}`);
    console.log(`    allocated       ${flat.total.toLocaleString()} B total = ${f2(live.bytesPerSimStep)} B per 120 Hz sim step`);
    console.log(`    of which game   ${flat.appTotal.toLocaleString()} B = ${f2(live.appBytesPerSimStep)} B per sim step   (rows marked ~ are harness/V8, not the game)`);
    console.log(`    top allocating call sites:`);
    for (const t of live.top) {
      if (t.perSimStep < 0.2) break;
      console.log(`      ${pad(f2(t.perSimStep), 9)} B/step  ${(t.bytes / 1024).toFixed(0).padStart(7)} KB  ${t.site}`);
    }
    if (DO_TREE) {
      console.log(`    allocating stacks, deepest frame first:`);
      for (const s of flat.stacks.slice(0, 14)) {
        console.log(`      ${(s.bytes / 1024).toFixed(1).padStart(8)} KB  ${s.stack.slice(0, 7).join('  <-  ')}`);
      }
    }
    console.log('');
  }

  const base = await page.evaluate(installRig, BLOCK_MS);
  await page.evaluate(() => window.__stress.stopLoop());
  console.log(`baseline population: ${base.walls} walls / ${base.blocks} blocks / ${base.particles} particles`);
  console.log(`headless=${!HEADED}  block=${BLOCK_MS} ms  scales=${SCALES.join(',')}\n`);
  results.base = base;

  // ------------------------------------------------------------------ timing
  for (const scale of SCALES) {
    const arm = await page.evaluate(
      ([scale, baseWalls, baseParticles]) => {
        const S = window.__stress;
        const blocks = S.setWalls(Math.max(1, Math.round(baseWalls * scale)));
        const particles = S.setParticles(
          Math.max(1, Math.round(baseParticles * scale)),
        );
        const heroes = S.setHeroes(scale <= 1 ? 1 : Math.round(scale));

        const want = Math.max(1, Math.round(baseParticles * scale));
        const r = { scale, walls: S.field.walls.length, blocks, particles, heroes };
        r.fieldUpdate = S.bench(S.regions.fieldUpdate);
        r.heroUpdate = S.bench(S.regions.heroUpdate);
        // Re-seed after the hero arm, which fills the pool with its own dust.
        S.setParticles(want, 1e9);
        r.particlesUpdate = S.bench(S.regions.particlesUpdate);
        r.heroShade = S.benchDraw('heroShade');
        r.fieldDraw = S.benchDraw('fieldDraw');
        r.heroDraw = S.benchDraw('heroDraw');
        S.setParticles(want, 0);
        r.particlesDraw = S.benchDraw('particlesDraw');

        // One real frame with real GL. Seeded at the pool's 2048 capacity so
        // the figure is stable: the heroes emit dust of their own every step,
        // so any smaller population drifts upwards during the benchmark and
        // the arms stop being comparable. A frame with this many heroes in it
        // would saturate the pool anyway.
        S.setParticles(2048, 0);
        r.particlesAtFrame = S.particles.live;
        r.census = S.census();
        S.realFrame();
        const sp = S.sprites();
        r.sprites = sp.sprites;
        r.drawCalls = sp.drawCalls;
        r.realFrame = S.bench(S.realFrame);
        return r;
      },
      [scale, BASE_WALLS, BASE_PARTICLES],
    );
    arm.updateTotal =
      arm.fieldUpdate.ms + arm.particlesUpdate.ms + arm.heroUpdate.ms;
    arm.submitTotal =
      arm.heroShade.ms + arm.fieldDraw.ms + arm.particlesDraw.ms + arm.heroDraw.ms;
    results.arms.push(arm);

    console.log(
      `--- ${scale}x : ${arm.walls} walls / ${arm.blocks} blocks / ${arm.particles} particles / ${arm.heroes} heroes / ${arm.sprites} sprites`,
    );
    console.log(
      `    update ${pad(f2(arm.updateTotal), 8)} ms   field ${pad(f2(arm.fieldUpdate.ms), 8)}  particles ${pad(f2(arm.particlesUpdate.ms), 8)}  heroes ${pad(f2(arm.heroUpdate.ms), 8)}`,
    );
    console.log(
      `    submit ${pad(f2(arm.submitTotal), 8)} ms   field ${pad(f2(arm.fieldDraw.ms), 8)}  particles ${pad(f2(arm.particlesDraw.ms), 8)}  heroes ${pad(f2(arm.heroDraw.ms), 8)}  shade ${pad(f2(arm.heroShade.ms), 8)}`,
    );
    const c = arm.census;
    console.log(
      `    quads  ${pad(c.submitted, 8)}      field ${pad(c.field, 8)}  particles ${pad(c.particles, 8)}  heroes ${pad(c.heroes, 8)}  shade ${pad(c.shade, 8)}   (${c.reachedGl} reached GL)`,
    );
    console.log(
      `    whole frame incl. GL upload ${f2(arm.realFrame.ms)} ms   draw calls ${arm.drawCalls}\n`,
    );
  }

  // -------------------------------------------------------------- allocation
  if (!has('noalloc')) {
    const ALLOC_FRAMES = 4000;
    await page.evaluate(
      ([baseWalls, baseParticles]) => {
        const S = window.__stress;
        S.setWalls(baseWalls);
        S.setParticles(baseParticles);
        S.setHeroes(1);
        S.updateOnly(400);
      },
      [BASE_WALLS, BASE_PARTICLES],
    );

    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
    const heap = await page.evaluate((n) => {
      const S = window.__stress;
      S.gc();
      const h0 = S.heap();
      S.updateOnly(n);
      const h1 = S.heap();
      S.gc();
      const h2 = S.heap();
      return { h0, h1, h2, gcAvailable: typeof window.gc === 'function' };
    }, ALLOC_FRAMES);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    await cdp.send('HeapProfiler.disable');
    const flat = flattenHeapProfile(profile.head);

    results.alloc = {
      frames: ALLOC_FRAMES,
      heapDeltaBytes: heap.h1 - heap.h0,
      bytesPerFrameHeap: (heap.h1 - heap.h0) / ALLOC_FRAMES,
      sampledTotalBytes: flat.total,
      bytesPerFrameSampled: flat.total / ALLOC_FRAMES,
      retainedAfterGc: heap.h2 - heap.h0,
      gcAvailable: heap.gcAvailable,
      appBytes: flat.appTotal,
      appBytesPerFrame: flat.appTotal / ALLOC_FRAMES,
      top: flat.sites
        .slice(0, 15)
        .map(([site, bytes, app]) => ({ site, bytes, app, perFrame: bytes / ALLOC_FRAMES })),
    };

    console.log(`--- allocation: ${ALLOC_FRAMES} isolated update steps at 1x, no GL`);
    console.log(`    heap delta      ${(heap.h1 - heap.h0).toLocaleString()} B  -> ${f2((heap.h1 - heap.h0) / ALLOC_FRAMES)} B/step`);
    console.log(`    sampled alloc   ${flat.total.toLocaleString()} B  -> ${f2(flat.total / ALLOC_FRAMES)} B/step   (game's own share ${f2(flat.appTotal / ALLOC_FRAMES)} B/step)`);
    console.log(`    retained by GC  ${(heap.h2 - heap.h0).toLocaleString()} B`);
    for (const t of results.alloc.top) {
      if (t.perFrame < 0.05) break;
      console.log(`      ${pad(f2(t.perFrame), 9)} B/step  ${t.site}`);
    }
    console.log('');
  }

  // ------------------------------------------------------ AoS versus SoA
  if (has('soa')) {
    results.layout = [];
    console.log('--- data layout: the same per-block maths over objects vs typed arrays');
    console.log('    blocks       AoS full    SoA full   delta    AoS no-trig  delta      AoS physics  SoA physics   delta');
    for (const scale of SCALES) {
      const row = await page.evaluate(
        ([scale, baseWalls]) => {
          const S = window.__stress;
          S.setWalls(Math.max(1, Math.round(baseWalls * scale)));
          const n = S.buildLayouts();
          const full = S.layoutBench(true);
          const phys = S.layoutBench(false);
          return { scale, n, full, phys };
        },
        [scale, BASE_WALLS],
      );
      results.layout.push(row);
      const dF = ((row.full.soa - row.full.aos) / row.full.aos) * 100;
      const dT = ((row.full.trig - row.full.aos) / row.full.aos) * 100;
      const dP = ((row.phys.soa - row.phys.aos) / row.phys.aos) * 100;
      console.log(
        `    ${pad(row.n, 6)}   ${pad(f2(row.full.aos), 9)}  ${pad(f2(row.full.soa), 9)}  ${pad(dF.toFixed(1) + '%', 7)}  ${pad(f2(row.full.trig), 10)}  ${pad(dT.toFixed(1) + '%', 7)}   ${pad(f2(row.phys.aos), 10)}  ${pad(f2(row.phys.soa), 11)}  ${pad(dP.toFixed(1) + '%', 8)}`,
      );
    }
    console.log('');
  }

  // ----------------------------------------------------------- the CPU tree
  if (DO_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 60 });
    results.profile = [];
    for (const scale of SCALES) {
      await page.evaluate(
        ([scale, baseWalls, baseParticles]) => {
          const S = window.__stress;
          S.setWalls(Math.max(1, Math.round(baseWalls * scale)));
          S.setParticles(Math.max(1, Math.round(baseParticles * scale)));
          S.setHeroes(scale <= 1 ? 1 : Math.round(scale));
          for (let i = 0; i < 120; i++) S.realFrame();
        },
        [scale, BASE_WALLS, BASE_PARTICLES],
      );
      await cdp.send('Profiler.start');
      await page.evaluate(() => {
        const S = window.__stress;
        const t0 = performance.now();
        let n = 0;
        while (performance.now() - t0 < 1500) {
          S.realFrame();
          n++;
        }
        return n;
      });
      const { profile } = await cdp.send('Profiler.stop');

      const byId = new Map();
      for (const n of profile.nodes) byId.set(n.id, n);
      const counts = new Map();
      for (const id of profile.samples || []) counts.set(id, (counts.get(id) || 0) + 1);
      const totalSamples = (profile.samples || []).length || 1;
      const spanMs = (profile.endTime - profile.startTime) / 1000;
      const self = new Map();
      for (const [id, c] of counts) {
        const n = byId.get(id);
        if (!n) continue;
        const f = n.callFrame;
        const key = `${f.functionName || '(anonymous)'} ${String(f.url || '').split('/').pop()}:${f.lineNumber}`;
        self.set(key, (self.get(key) || 0) + c);
      }
      const top = [...self.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([fn, c]) => ({ fn, pct: (c / totalSamples) * 100, ms: (c / totalSamples) * spanMs }));
      results.profile.push({ scale, spanMs, top });

      console.log(`--- sampled CPU self-time at ${scale}x  (${spanMs.toFixed(0)} ms wall, ${totalSamples} samples)`);
      for (const t of top) {
        if (t.pct < 0.8) break;
        console.log(`    ${pad(t.pct.toFixed(1), 5)}%  ${t.fn}`);
      }
      console.log('');
    }
    await cdp.send('Profiler.disable');
  }

  // ------------------------------------------------------ fixed-step loop
  if (DO_LOOP) {
    results.loop = results.arms.map((a) => {
      const step = a.updateTotal;
      const submit = a.submitTotal;
      return {
        scale: a.scale,
        stepMs: step,
        submitMs: submit,
        realtimeRatio120: 1000 / 120 / step,
        fourStepsPlusSubmit: step * 4 + submit,
      };
    });
    console.log('--- fixed-step headroom (one 120 Hz step buys 8.333 ms of simulated time)');
    for (const r of results.loop) {
      console.log(
        `    ${pad(r.scale + 'x', 5)}: step ${pad(f2(r.stepMs), 8)} ms -> ${r.realtimeRatio120.toFixed(0)}x realtime;  maxSteps=4 worst case + submit = ${f2(r.fourStepsPlusSubmit)} ms of a 16.7 ms frame`,
      );
    }
    console.log('');
  }

  await browser.close();
  if (server) killTree(server);

  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify(results, null, 2));
    console.log(`wrote ${JSON_OUT}`);
  }
  if (errors.length) {
    console.log(`console errors: ${errors.length}`);
    for (const e of errors.slice(0, 6)) console.log(`  ${e}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
