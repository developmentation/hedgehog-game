/**
 * GPU micro-benchmark for the renderer.
 *
 * Wall-clock frame rate cannot measure anything on this machine: the panel
 * presents at 143 Hz, rAF is vsync-pinned, and several other headed browsers
 * are usually running. So every number here comes from
 * `EXT_disjoint_timer_query_webgl2` — the GPU's own clock, wrapped around
 * exactly the commands one frame submits (from `Renderer.resetStats`, which
 * opens the frame, to `Renderer.tickScaler`, which the loop calls last).
 *
 * Two rules make the comparisons trustworthy:
 *
 *  1. **Interleaved.** Every variant is measured round-robin inside ONE browser
 *     session, N rounds of a fixed slice each, so ambient load lands on every
 *     arm equally instead of on whichever arm happened to run while a build
 *     was going.
 *  2. **Frozen pose.** The game is posed exactly as the golden harness poses
 *     it (loop stopped, `timeScale` 0, `distance` pinned) and then re-rendered,
 *     so every frame submits identical geometry and the only thing that differs
 *     between arms is the thing under test.
 *
 * Shader variants are built by string surgery on the REAL shader source read
 * out of `src/engine/gl.ts`, so `base` is textually the shipping shader and
 * there is no second copy to drift.
 *
 *   node tools/glbench.mjs                    # shader variants
 *   node tools/glbench.mjs --suite upload     # instance-upload cost
 *   node tools/glbench.mjs --suite state      # clear / blend / render scale
 *   node tools/glbench.mjs --rounds 10 --slice 1500 --level endless
 *   node tools/glbench.mjs --live             # do not freeze the simulation
 */

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSnapshot, serveStatic } from './benchserve.mjs';

const ROOT = path.resolve('.');

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const PORT = Number(val('port', 5497));

const ROUNDS = Number(val('rounds', 8));
const SLICE = Number(val('slice', 1300));
const LEVEL = String(val('level', 'endless'));
const SUITE = String(val('suite', 'shader'));
const LIVE = has('live');
/**
 * Draw every batch this many times.
 *
 * Per-fragment effects on this GPU are 0.1-0.3 ms against a run-to-run noise
 * floor of ~0.5 ms, so they cannot be resolved at 1x. Repeating the draw
 * multiplies the fill — and so the per-fragment term — without touching the
 * fixed costs, which lifts the signal clear of the noise. Divide the measured
 * difference by REPEAT to get the per-frame figure.
 */
const REPEAT = Number(val('repeat', 1));
const KEEP = has('keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shader variants, cut from the shipping source.
// ---------------------------------------------------------------------------

function literal(src, name) {
  const key = `const ${name} = \``;
  const i = src.indexOf(key);
  if (i < 0) throw new Error(`could not find ${name} in gl.ts`);
  const j = src.indexOf('`', i + key.length);
  return src.slice(i + key.length, j);
}

/** Cut `from`..`to` (exclusive of `to`) out of `src` and replace it. */
function splice(src, from, to, replacement, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`variant ${label}: anchor not found: ${from.slice(0, 40)}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`variant ${label}: end anchor not found: ${to.slice(0, 40)}`);
  return src.slice(0, a) + replacement + src.slice(b);
}

const DISCARD = '  if (c.a < 0.0025) discard;\n';
const SELECT_FROM = '  int slot = v_mode & 7;';
const SELECT_TO = '  vec4 c = texel * v_color;';
const GRADE_FROM = '  vec3 g = c.rgb * u_grade.x;';
const GRADE_TO = '  // Anti-banding dither';
const DITHER_FROM = '  float dither = fract(';
const DITHER_TO = '  // Additive without a second blend mode.';

const drop = {
  discard: (s) => {
    if (!s.includes(DISCARD)) throw new Error('discard anchor missing');
    return s.replace(DISCARD, '');
  },
  grade: (s) => splice(s, GRADE_FROM, GRADE_TO, '  vec3 g = c.rgb;\n\n', 'grade'),
  dither: (s) => splice(s, DITHER_FROM, DITHER_TO, '', 'dither'),
  select: (s) =>
    splice(s, SELECT_FROM, SELECT_TO, '  vec4 texel = texture(u_tex[0], v_uv);\n', 'select'),
  fetch: (s) => splice(s, SELECT_FROM, SELECT_TO, '  vec4 texel = vec4(0.55, 0.5, 0.45, 0.6);\n', 'fetch'),
};

/** A grade that costs nothing when it is a no-op: one uniform branch. */
const gradeBranch = (s) =>
  splice(
    s,
    GRADE_FROM,
    GRADE_TO,
    `  vec3 g = c.rgb;
  if (u_grade.x != 1.0 || u_grade.y != 1.0) {
    g *= u_grade.x;
    float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(luma), g, u_grade.y);
  }

`,
    'gradeBranch',
  );

/** Dither only for instances that ask for it (mode bit 4). Nothing sets it here. */
const ditherBranch = (s) =>
  splice(
    s,
    DITHER_FROM,
    DITHER_TO,
    `  if ((v_mode & 16) != 0) {
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    g = clamp(g + (dither - 0.5) * (1.0 / 255.0), 0.0, 1.0);
  }

`,
    'ditherBranch',
  );

function buildVariants(frag) {
  const v = { base: frag };
  v['no-discard'] = drop.discard(frag);
  v['discard-0.02'] = frag.replace(DISCARD, '  if (c.a < 0.02) discard;\n');
  v['discard-0.06'] = frag.replace(DISCARD, '  if (c.a < 0.06) discard;\n');
  v['no-grade'] = drop.grade(frag);
  v['grade-branch'] = gradeBranch(frag);
  v['no-dither'] = drop.dither(frag);
  v['dither-branch'] = ditherBranch(frag);
  v['one-sampler'] = drop.select(frag);
  v['no-alu'] = drop.dither(drop.grade(drop.discard(frag)));
  v['no-fetch'] = drop.fetch(frag);
  v['floor'] = drop.fetch(drop.dither(drop.grade(drop.discard(frag))));
  return v;
}

// ---------------------------------------------------------------------------
// In-page harness. Everything below runs in the browser.
// ---------------------------------------------------------------------------

function installBench(payload) {
  const { vert, variants } = payload;
  const g = window.__game;
  const r = g.r;
  const gl = r.gl;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { ok: false, reason: 'EXT_disjoint_timer_query_webgl2 unavailable' };

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('compile: ' + gl.getShaderInfoLog(sh) + '\n' + src);
    }
    return sh;
  };

  const progs = {};
  for (const name of Object.keys(variants)) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, variants[name]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link ' + name + ': ' + gl.getProgramInfoLog(p));
    }
    gl.useProgram(p);
    const units = new Int32Array(8);
    for (let i = 0; i < 8; i++) units[i] = i;
    const uTex = gl.getUniformLocation(p, 'u_tex');
    if (uTex) gl.uniform1iv(uTex, units);
    progs[name] = {
      prog: p,
      uProj: gl.getUniformLocation(p, 'u_proj'),
      uGrade: gl.getUniformLocation(p, 'u_grade'),
    };
  }

  const opts = {
    uploadRepeat: 1,
    orphan: false,
    noClear: false,
    noBlend: false,
    bindSame: false,
    drawRepeat: 1,
    clearScissor: false,
    glDither: true,
  };
  let active = null;

  const origBegin = r.begin.bind(r);
  r.begin = function (cx, cy, cz) {
    origBegin(cx, cy, cz);
    if (active) {
      gl.useProgram(active.prog);
      if (active.uProj) gl.uniformMatrix4fv(active.uProj, false, r.proj);
      if (active.uGrade) gl.uniform2f(active.uGrade, r.grade[0], r.grade[1]);
    }
  };

  const origClear = r.clear.bind(r);
  r.clear = function (a, b, c) {
    if (opts.noClear) return;
    if (opts.clearScissor) {
      // Clear a sixteenth of the target instead of all of it: if the cost is
      // bandwidth, it must fall in proportion to the area.
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, r.canvas.width, Math.max(1, Math.round(r.canvas.height * 0.0625)));
      const p = r.clearPolicy;
      r.clearPolicy = 'full';
      origClear(a, b, c);
      r.clearPolicy = p;
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    origClear(a, b, c);
  };

  const FPI = 17;
  const origFlush = r.flush.bind(r);
  r.flush = function () {
    const n = r.count;
    // Force every sampler slot onto the SAME texture. The fragments then read
    // identical texels whether or not the selector runs, so a pair of arms that
    // differ only in the selector is a clean isolation of what it costs.
    if (opts.bindSame && r.slotCount > 1) {
      const t = r.slots[0];
      for (let i = 1; i < r.slotCount; i++) r.slots[i] = t;
    }
    if (n > 0 && (opts.uploadRepeat > 1 || opts.orphan)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.instanceVBO);
      if (opts.orphan) gl.bufferData(gl.ARRAY_BUFFER, r.capacity * FPI * 4, gl.DYNAMIC_DRAW);
      for (let i = 1; i < opts.uploadRepeat; i++) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, r.data, 0, n * FPI);
      }
    }
    const extra = opts.drawRepeat - 1;
    origFlush();
    for (let i = 0; i < extra && n > 0; i++) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    }
  };

  // --- timing ---------------------------------------------------------------
  const pool = [];
  const pending = [];
  let cur = null;
  let samples = [];

  const poll = () => {
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      while (pending.length) pool.push(pending.pop());
      return;
    }
    while (pending.length) {
      const q = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      pool.push(q);
    }
  };

  const origReset = r.resetStats.bind(r);
  r.resetStats = function () {
    origReset();
    if (cur) return;
    cur = pool.pop() || gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, cur);
  };

  const origTick = r.tickScaler.bind(r);
  r.tickScaler = function (dt) {
    origTick(dt);
    if (cur) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(cur);
      cur = null;
    }
    if (opts.noBlend) gl.enable(gl.BLEND);
    if (opts.glDither) gl.enable(gl.DITHER);
    poll();
  };

  // noBlend has to be applied after every pass, because nothing else touches it
  const origEnd = r.end.bind(r);
  r.end = function () {
    if (opts.noBlend) gl.disable(gl.BLEND);
    if (!opts.glDither) gl.disable(gl.DITHER);
    origEnd();
  };

  window.__bench = {
    variants: Object.keys(progs),
    use(name) {
      active = name ? progs[name] : null;
      if (name && !active) throw new Error('no variant ' + name);
      samples = [];
    },
    set(o) {
      Object.assign(opts, o);
      samples = [];
    },
    reset() {
      samples = [];
    },
    take() {
      poll();
      const s = samples;
      samples = [];
      return s;
    },
    stats() {
      return {
        drawCalls: r.drawCalls,
        sprites: r.spritesDrawn,
        culled: r.spritesCulled,
        renderScale: r.renderScale,
        canvas: r.canvas.width + 'x' + r.canvas.height,
        bytesPerFrame: r.spritesDrawn * FPI * 4,
      };
    },
  };
  return { ok: true, variants: Object.keys(progs) };
}

function poseFrozen(level) {
  const g = window.__game;
  window.__renderScale?.(1);
  g.loop.stop();
  const s = g.stack.top;
  if (s) {
    s.phase = 'playing';
    s.phaseT = 0;
    s.scrollSpeed = 0;
    s.targetSpeed = 0;
    s.distance = 4000;
    s.hintT = 0;
    s.flash = 0;
    s.comboFlash = 0;
    s.speakerPulse = 0;
    if (s.notice) s.notice.kind = 0;
    if (s.noticeQueue) s.noticeQueue.length = 0;
    if (s.floaters) s.floaters.length = 0;
  }
  g.ctx.timeScale = 0;
  g.loop.start();
  return level;
}

// ---------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------

function pct(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  const glSrc = (await readFile(path.join(ROOT, 'src', 'engine', 'gl.ts'), 'utf8')).replace(/\r\n/g, '\n');
  const vert = literal(glSrc, 'VERT');
  const frag = literal(glSrc, 'FRAG');
  const variants = buildVariants(frag);

  const server = await serveStatic(await buildSnapshot('glbench', ROOT), PORT);
  const browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  pageerror:', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?level=${LEVEL}&rs=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    await sleep(1500);
    if (!LIVE) await page.evaluate(poseFrozen, LEVEL);
    await sleep(600);

    const install = await page.evaluate(installBench, { vert, variants });
    if (!install.ok) throw new Error(install.reason);
    if (REPEAT > 1) await page.evaluate((k) => window.__bench.set({ drawRepeat: k }), REPEAT);

    const renderer = await page.evaluate(() => {
      const gl = window.__game.r.gl;
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    });
    console.log(`\nGPU: ${renderer.renderer} (${renderer.vendor})`);
    const st = await page.evaluate(() => window.__bench.stats());
    console.log(
      `frame: ${st.canvas} px, ${st.sprites} sprites, ${st.drawCalls} draws, ` +
        `${st.culled} culled, ${st.bytesPerFrame} instance bytes/frame, ` +
        `${LIVE ? 'live' : 'frozen'}\n`,
    );

    if (SUITE === 'cpu') {
      // How expensive is submission itself? Not a GPU question, so not a GPU
      // timer: this is a straight CPU microbenchmark of `draw` and of the one
      // `bufferSubData` a flush issues, run with the GPU taken out of the loop
      // (the instance counter is reset by hand instead of flushed).
      const cpu = await page.evaluate(() => {
        const r = window.__game.r;
        const atlas = window.__game.atlas;
        let f = null;
        for (const v of atlas.frames.values()) {
          f = v;
          break;
        }
        const midX = (r.viewLeft + r.viewRight) * 0.5;
        const midY = (r.viewTop + r.viewBottom) * 0.5;
        const off = r.viewRight + 10000;
        const run = (fn) => {
          let best = Infinity;
          for (let rep = 0; rep < 7; rep++) {
            r.begin(0, 0, 1);
            const t = performance.now();
            fn();
            const ms = performance.now() - t;
            r.count = 0;
            if (ms < best) best = ms;
          }
          return best;
        };
        const N = 200000;
        const straight = run(() => {
          for (let i = 0; i < N; i++) {
            r.draw(f, midX, midY, 1, 1, 0, 1, 1, 1, 1);
            if ((i & 8191) === 8191) r.count = 0;
          }
        });
        const rotated = run(() => {
          for (let i = 0; i < N; i++) {
            r.draw(f, midX, midY, 1, 1, 0.7, 1, 1, 1, 1);
            if ((i & 8191) === 8191) r.count = 0;
          }
        });
        const culled = run(() => {
          for (let i = 0; i < N; i++) r.draw(f, off, midY, 1, 1, 0, 1, 1, 1, 1);
        });
        // Upload only: 360 instances, the size a real flush writes.
        const gl = r.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, r.instanceVBO);
        const M = 20000;
        let bestUp = Infinity;
        for (let rep = 0; rep < 7; rep++) {
          const t = performance.now();
          for (let i = 0; i < M; i++) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, r.data, 0, 360 * 17);
          }
          const ms = performance.now() - t;
          if (ms < bestUp) bestUp = ms;
        }
        r.count = 0;
        return {
          drawNs: (straight / N) * 1e6,
          drawRotNs: (rotated / N) * 1e6,
          cullNs: (culled / N) * 1e6,
          uploadUs: (bestUp / M) * 1000,
        };
      });
      console.log('  CPU submit cost (best of 7):');
      console.log(`    draw(), on screen, no rotation   ${cpu.drawNs.toFixed(1)} ns/sprite`);
      console.log(`    draw(), on screen, rotated       ${cpu.drawRotNs.toFixed(1)} ns/sprite`);
      console.log(`    draw(), culled                   ${cpu.cullNs.toFixed(1)} ns/sprite`);
      console.log(`    bufferSubData of 360 instances   ${cpu.uploadUs.toFixed(1)} us/call`);
      console.log(
        `    => 360 sprites cost ${((cpu.drawNs * 360) / 1000).toFixed(1)} us to submit + ` +
          `${cpu.uploadUs.toFixed(1)} us to upload\n`,
      );
      return;
    }

    /** arms: [{label, apply: async () => void}] */
    const arms = [];
    if (SUITE === 'shader') {
      arms.push({ label: 'shipping (no override)', apply: () => page.evaluate(() => window.__bench.use(null)) });
      for (const name of Object.keys(variants)) {
        arms.push({ label: name, apply: () => page.evaluate((n) => window.__bench.use(n), name) });
      }
    } else if (SUITE === 'upload') {
      for (const k of [1, 2, 4, 8, 16, 32]) {
        arms.push({
          label: `upload x${k}`,
          apply: () => page.evaluate((n) => window.__bench.set({ uploadRepeat: n, orphan: false }), k),
        });
      }
      arms.push({
        label: 'orphan + upload x1',
        apply: () => page.evaluate(() => window.__bench.set({ uploadRepeat: 1, orphan: true })),
      });
    } else if (SUITE === 'select') {
      // A and B below read the SAME texels (every slot bound to slot 0's
      // texture), so they discard the same fragments and hit the same cache.
      // The only difference is whether the shader runs the 3-deep selector.
      const arm = (label, variant, bindSame) => ({
        label,
        apply: async () => {
          await page.evaluate((n) => window.__bench.use(n), variant);
          await page.evaluate((b) => window.__bench.set({ bindSame: b }), bindSame);
        },
      });
      arms.push(arm('A selector, 1 texture', 'base', true));
      arms.push(arm('B no selector, 1 texture', 'one-sampler', true));
      arms.push(arm('C selector, 8 textures (ship)', 'base', false));
      arms.push(arm('D no selector, 1 texture bnd', 'one-sampler', false));
    } else if (SUITE === 'scale') {
      // 0.998 is the interesting one: the offscreen buffer is native-sized, so
      // the world pass rasterises exactly as many pixels as at 1.0 and the
      // whole difference is the framebuffer round trip and the blit.
      for (const s of [1, 0.998, 0.85, 0.72, 0.6, 0.5]) {
        arms.push({
          label: s === 0.998 ? 'offscreen at native (blit)' : `render scale ${s}`,
          apply: () => page.evaluate((v) => window.__renderScale(v), s),
        });
      }
    } else if (SUITE === 'state') {
      arms.push({ label: 'baseline', apply: () => page.evaluate(() => window.__bench.set({ noClear: false, noBlend: false })) });
      arms.push({ label: 'no clear', apply: () => page.evaluate(() => window.__bench.set({ noClear: true, noBlend: false })) });
      arms.push({ label: 'no blend', apply: () => page.evaluate(() => window.__bench.set({ noClear: false, noBlend: true })) });
      arms.push({ label: 'no clear + no blend', apply: () => page.evaluate(() => window.__bench.set({ noClear: true, noBlend: true })) });
      arms.push({ label: 'clear 1/16 of the area', apply: () => page.evaluate(() => window.__bench.set({ noClear: false, noBlend: false, clearScissor: true })) });
      arms.push({
        label: "clearPolicy 'bars'",
        apply: () =>
          page.evaluate(() => {
            window.__bench.set({ noClear: false, noBlend: false, clearScissor: false, glDither: true });
            window.__game.r.clearPolicy = 'bars';
          }),
      });
      arms.push({
        label: "clearPolicy 'full'",
        apply: () =>
          page.evaluate(() => {
            window.__bench.set({ noClear: false, noBlend: false, clearScissor: false, glDither: true });
            window.__game.r.clearPolicy = 'full';
          }),
      });
      arms.push({ label: 'GL_DITHER off', apply: () => page.evaluate(() => window.__bench.set({ noClear: false, noBlend: false, clearScissor: false, glDither: false })) });
    } else {
      throw new Error('unknown suite ' + SUITE);
    }

    const acc = arms.map(() => []);
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < arms.length; i++) {
        await arms[i].apply();
        await sleep(180); // settle: shader swap, first frames after a state change
        await page.evaluate(() => window.__bench.reset());
        await sleep(SLICE);
        const s = await page.evaluate(() => window.__bench.take());
        acc[i].push(...s);
      }
      process.stdout.write(`  round ${round + 1}/${ROUNDS}\r`);
    }

    // Put the page back to shipping state.
    if (SUITE === 'shader') await page.evaluate(() => window.__bench.use(null));

    const base = pct(acc[0], 0.5);
    console.log('\n');
    console.log('  ' + 'arm'.padEnd(26) + 'p50 ms   p05     p95     n     vs base');
    for (let i = 0; i < arms.length; i++) {
      const p50 = pct(acc[i], 0.5);
      const d = ((p50 - base) / base) * 100;
      console.log(
        '  ' +
          arms[i].label.padEnd(26) +
          p50.toFixed(3).padStart(6) +
          '  ' +
          pct(acc[i], 0.05).toFixed(3).padStart(6) +
          '  ' +
          pct(acc[i], 0.95).toFixed(3).padStart(6) +
          '  ' +
          String(acc[i].length).padStart(5) +
          '   ' +
          (i === 0
            ? '—'
            : (d >= 0 ? '+' : '') +
              d.toFixed(1) +
              '%  (' +
              (p50 - base >= 0 ? '+' : '') +
              (p50 - base).toFixed(3) +
              ' ms' +
              (REPEAT > 1 ? `, ${((p50 - base) / REPEAT >= 0 ? '+' : '') + ((p50 - base) / REPEAT).toFixed(3)} ms at 1x` : '') +
              ')'),
      );
    }
    console.log('');
    if (KEEP) await sleep(600000);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
