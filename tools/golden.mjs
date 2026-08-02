/**
 * Visual regression guard.
 *
 * Every visual regression in this project so far was caught by a human looking
 * at the screen: a bleached palette, a hedgehog drawn twice, tints multiplied
 * to 3.4x, hairline seams through composed panels. Typecheck passed for all of
 * them, and so did the gameplay soak test, because none of them are bugs in
 * behaviour — the game played perfectly while looking wrong.
 *
 * This renders a fixed set of frames from a frozen, seeded game state and
 * compares them against committed goldens.
 *
 *   node tools/golden.mjs            compare against docs/golden/ and fail on drift
 *   node tools/golden.mjs --update   accept the current frames as the new truth
 *   node tools/golden.mjs --only cave,hud
 *
 * Determinism is the whole trick. Each shot pins the RNG seed, freezes the
 * clock with timeScale 0, sets the scroll distance by hand and forces a known
 * word, so two runs of the same build must produce identical pixels. If they
 * do not, the harness is at fault and says so rather than blaming the build.
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const GOLDEN_DIR = path.join(ROOT, 'docs', 'golden');
const OUT_DIR = path.join(ROOT, 'screenshots', 'golden-run');

/**
 * The port is chosen at run time, never fixed.
 *
 * This was `const PORT = 5499`, and `serve()` treated "something answers on
 * 5499" as "our preview server is up". When anything else already held that
 * port — a second checkout, another agent's preview, a leaked server from an
 * earlier run — `--strictPort` made OUR vite exit, the readiness fetch hit the
 * FOREIGN server, and the guard photographed a build it had never been asked
 * to test. That is the worst failure a regression guard has: not a false alarm
 * but a confident verdict about the wrong subject. It reported seven of seven
 * shots changed at ~99.9% of pixels, which is what a build serving procedural
 * fallback art looks like next to a painted reference.
 */
let PORT = 0;

/** An ephemeral port the OS confirms is free, so nobody else can be on it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Kill the preview server and everything it spawned.
 *
 * `spawn(..., { shell: true })` gives back the shell, not vite, so `.kill()`
 * reaped the wrapper and left vite holding `dist/`. The next `vite build` then
 * died with `ENOTEMPTY: rmdir 'dist/art'` at `emptyOutDir` — a failure that
 * looks like a broken build and is really a leaked child from the last run.
 */
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  const v = args[i + 1];
  return i === -1 ? d : v && !v.startsWith('--') ? v : d;
};
const UPDATE = has('update');
const ONLY = val('only') ? String(val('only')).split(',').map((s) => s.trim()) : null;

/**
 * A pixel may drift this far before it counts as changed.
 *
 * Not zero: the GPU is allowed tiny filtering differences between runs, and a
 * threshold of 0 would make the guard cry wolf until nobody read it. Set from
 * the measured same-build noise floor, with headroom.
 */
const CHANNEL_TOLERANCE = 6;
/**
 * Fraction of pixels allowed past that before the shot counts as a failure.
 *
 * Set from measurement, not taste. Repeated runs of an unchanged build sit at
 * 0.000% on most shots, with a residual up to 0.92% on two of them that does
 * not settle. A real regression is not close to that: re-injecting the 1.35x
 * sky tint that shipped twice moved 16.31% of the styled meadow. 1.2% sits
 * clear of the floor and an order of magnitude below the signal.
 *
 * If this ever has to be raised again, find out why the floor moved instead.
 */
const FAIL_FRACTION = 0.012;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The shots.
 *
 * Each one exists because something specific broke there. `pose` runs in the
 * page with the game frozen; keep it pure state-setting, no timing.
 */
/**
 * Shots cover BOTH colour paths.
 *
 * The game boots with raw mode on, where the backdrop declines to tint itself.
 * A guard that only photographs that state is blind to every theme tint — an
 * injected 1.35x sky multiplier, the exact regression that shipped twice, moved
 * zero pixels. So each backdrop is captured raw AND styled.
 */
const SHOTS = [
  {
    name: 'meadow',
    why: 'backdrop exposure and tinting — bleached once, went garish twice',
    level: 'endless',
    pose: () => {},
  },
  {
    name: 'winter',
    why: 'theme swap composes its own art, does not borrow the meadow canopy',
    level: 'deep-blue',
    pose: () => {},
  },
  {
    name: 'cave',
    why: 'theme with no sky; its ceiling is the mid layer sampled upside down',
    level: 'gauntlet',
    pose: () => {},
  },
  {
    name: 'hero-roll',
    why: 'the hedgehog was drawn twice, and once as two different sprites',
    level: 'endless',
    pose: (g) => {
      const s = g.stack.top;
      s.player.x = 300;
      s.scrollSpeed = 260;
    },
  },
  {
    name: 'hud',
    why: 'composed plates seamed; panel opacity has flipped twice',
    level: 'endless',
    pose: (g) => {
      const s = g.stack.top;
      s.score = 2021;
      s.scoreShown = 2021;
      s.combo = 5;
      s.lives = 2;
    },
  },
  {
    name: 'meadow-styled',
    why: 'the tinted path: theme multipliers reached 3.46x here twice',
    level: 'endless',
    raw: false,
    pose: () => {},
  },
  {
    name: 'cave-styled',
    why: 'tinted path for a theme whose art is already bright',
    level: 'gauntlet',
    raw: false,
    pose: () => {},
  },
];

async function serve() {
  PORT = await freePort();
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });

  // A leaked server outlives the process that made it, so hang the cleanup off
  // the interpreter rather than trusting one `finally` to run.
  const onExit = () => killTree(proc);
  process.once('exit', onExit);
  process.once('SIGINT', () => {
    onExit();
    process.exit(130);
  });

  for (let i = 0; i < 80; i++) {
    // If vite died — a port race, a missing `dist/`, a bad config — stop.
    // Continuing here is how the old harness ended up reading someone else's
    // server: the child was gone but something still answered.
    if (proc.exitCode !== null) {
      throw new Error(`preview server exited with code ${proc.exitCode} before serving`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  killTree(proc);
  throw new Error('preview server did not start');
}

/**
 * Freeze the game into a reproducible pose and photograph it.
 *
 * Wall-clock must not reach the simulation at any point, or two runs diverge:
 * the first attempt let the game play for a couple of real seconds before
 * freezing and drifted 3-4% against itself, which would have made this guard
 * cry wolf on every run.
 *
 * So the render loop is stopped the moment the game boots, the simulation is
 * advanced by an exact number of fixed-size steps, and only then is the clock
 * frozen and the loop restarted to draw. Every run walks the identical path.
 *
 * The saved profile is the other source of drift — it steers word selection
 * through the least-recently-seen weighting — so each shot gets a fresh browser
 * context and clears storage before booting.
 */
async function capture(browser, shot) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/?level=${shot.level}`, { waitUntil: 'load' });
    // A profile carried over from an earlier shot changes which word is drawn.
    await page.evaluate(async () => {
      try {
        indexedDB.deleteDatabase('spindash-speller');
        localStorage.clear();
      } catch {
        /* private mode — nothing to clear */
      }
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });

    // WAIT FOR THE PAINTED ART, NOT FOR THE CLOCK.
    //
    // `window.__game` exists as soon as boot finishes, but the generated art
    // loads in the BACKGROUND afterwards (`AssetLibrary.loadRest`, called after
    // the first frame so the remaining themes arrive while the player reads the
    // first word). Until it lands, every scene draws the procedural fallback,
    // and a shot taken then differs from the reference in ~99.9% of pixels —
    // the signature of a different frame, not of drift.
    //
    // This was a flat `sleep(600)`. Measured on a warm dev server the art was
    // resident well inside that window in 5 runs of 5, so the sleep was not
    // observed to lose the race — but it is a magic number racing an async
    // load rather than a wait for it, and nothing pins it to the load's actual
    // cost. `whenComplete()` resolves when every manifest asset is resident,
    // so the harness now waits on the condition it actually depends on.
    // Optional call: the guard has to be able to photograph older commits than
    // itself, and `whenComplete` postdates some of them. Bisecting a visual
    // regression means running today's harness against yesterday's build.
    await page.evaluate(() => window.__game.ctx.assets.whenComplete?.());
    await sleep(200);

    await page.evaluate(
      ([poseSrc, raw]) => {
        const g = window.__game;
        // The adaptive scaler is load-dependent: leaving it free would make the
        // render resolution, and so every pixel, a function of whatever else
        // the machine was doing.
        window.__renderScale?.(1);
        if (raw === false) window.__raw?.(false);

        // Take the clock away from the simulation entirely.
        g.loop.stop();

        // Pose from the BOOT state and never let the simulation advance.
        //
        // An earlier version stepped 480 fixed ticks to reach a "settled"
        // frame. That drifted 21% against itself, and the diff said exactly
        // why: the word was identical every run, but the scroll position and
        // the clue card's own fade timer were not, because how far the loop
        // had already run before the harness could stop it depended on machine
        // speed. The seeded boot state is the one frame that is genuinely the
        // same every time, so it is the one to photograph.
        const s = g.stack.top;
        if (s) {
          s.phase = 'playing';
          s.phaseT = 0;
          s.scrollSpeed = 0;
          s.targetSpeed = 0;
          s.distance = 4000; // fixed parallax offset, independent of elapsed time
          // Transient overlays run on their own clocks; pin them shut so the
          // shot cannot depend on when it was taken.
          s.hintT = 0;
          s.flash = 0;
          s.comboFlash = 0;
          s.speakerPulse = 0;
          if (s.notice) s.notice.kind = 0;
          if (s.noticeQueue) s.noticeQueue.length = 0;
          if (s.floaters) s.floaters.length = 0;
          if (s.particles?.clear) s.particles.clear();
        }
        // eslint-disable-next-line no-new-func
        new Function('g', `(${poseSrc})(g)`)(g);

        // Restart the loop only to draw: with timeScale 0 the scene receives
        // dt = 0, so nothing moves while the frame is being photographed.
        g.ctx.timeScale = 0;
        g.loop.start();
      },
      [shot.pose.toString(), shot.raw !== false],
    );
    await sleep(500);
    const buf = await page.screenshot();
    return { buf, errors };
  } finally {
    await ctx.close();
  }
}

/** Compare two PNGs of identical size. */
async function diff(aBuf, bBuf) {
  const a = await sharp(aBuf).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bBuf).raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return { sizeMismatch: true, changed: 1, maxDelta: 255, mean: 255, mask: null };
  }
  const n = a.info.width * a.info.height;
  const ch = a.info.channels;
  const mask = Buffer.alloc(n * 3);
  let changed = 0;
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]),
    );
    sum += d;
    if (d > maxDelta) maxDelta = d;
    if (d > CHANNEL_TOLERANCE) {
      changed++;
      mask[i * 3] = 255; // flag drift in red
    } else {
      const g = a.data[o] >> 2;
      mask[i * 3] = g;
      mask[i * 3 + 1] = g;
      mask[i * 3 + 2] = g;
    }
  }
  return {
    changed: changed / n,
    maxDelta,
    mean: sum / n,
    mask,
    width: a.info.width,
    height: a.info.height,
  };
}

async function main() {
  await mkdir(GOLDEN_DIR, { recursive: true });
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const shots = ONLY ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS;
  if (!shots.length) throw new Error('no shots matched --only');

  const server = await serve();
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
  });
  const errors = [];

  const results = [];
  try {
    for (const shot of shots) {
      const { buf, errors: shotErrors } = await capture(browser, shot);
      errors.push(...shotErrors);
      await writeFile(path.join(OUT_DIR, `${shot.name}.png`), buf);
      const goldenPath = path.join(GOLDEN_DIR, `${shot.name}.png`);

      if (UPDATE || !existsSync(goldenPath)) {
        await writeFile(goldenPath, buf);
        results.push({ shot, status: existsSync(goldenPath) ? 'updated' : 'created' });
        continue;
      }

      const d = await diff(await readFile(goldenPath), buf);
      const failed = d.sizeMismatch || d.changed > FAIL_FRACTION;
      if (failed && d.mask) {
        await sharp(d.mask, { raw: { width: d.width, height: d.height, channels: 3 } })
          .png()
          .toFile(path.join(OUT_DIR, `${shot.name}.DIFF.png`));
      }
      results.push({ shot, status: failed ? 'CHANGED' : 'ok', d });
    }
  } finally {
    await browser.close();
    killTree(server);
  }

  console.log('');
  let bad = 0;
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(
        `  ok       ${r.shot.name.padEnd(11)} ${(r.d.changed * 100).toFixed(3)}% drifted, max Δ${r.d.maxDelta}`,
      );
    } else if (r.status === 'CHANGED') {
      bad++;
      console.log(
        `  CHANGED  ${r.shot.name.padEnd(11)} ${(r.d.changed * 100).toFixed(2)}% of pixels, max Δ${r.d.maxDelta}` +
          `${r.d.sizeMismatch ? ' (SIZE MISMATCH)' : ''}`,
      );
      console.log(`           ${r.shot.why}`);
      console.log(`           diff: screenshots/golden-run/${r.shot.name}.DIFF.png`);
    } else {
      console.log(`  ${r.status.padEnd(8)} ${r.shot.name}`);
    }
  }
  if (errors.length) {
    bad++;
    console.log(`\n  ${errors.length} console error(s): ${errors.slice(0, 3).join(' | ')}`);
  }

  if (UPDATE) {
    console.log('\ngoldens updated — review the diff before committing them');
  } else if (bad) {
    console.log(`\n${bad} shot(s) changed. If the change is intended, re-run with --update.`);
    process.exitCode = 1;
  } else {
    console.log('\nno visual drift');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
