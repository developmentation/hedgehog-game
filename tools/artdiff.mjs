/**
 * Deterministic art A/B.
 *
 * `tools/golden.mjs` photographs the game 600 ms of wall clock after boot. That
 * is fine as a guard against someone changing the art, but it cannot answer
 * "did this change the RENDERING", because the number of simulation steps that
 * fit into those 600 ms depends on how fast the frames are — and a change that
 * makes frames faster (which is the point of an optimization) advances the
 * simulation further and moves the hero, the clue card and every eased HUD
 * value. The whole frame then reads as a regression when nothing about the
 * pixels changed.
 *
 * This removes the clock. An init script captures `requestAnimationFrame` and
 * queues the callbacks instead of running them, so the game boots with the
 * render loop stopped at exactly zero simulation steps regardless of machine
 * speed. The scene is then posed, the clock is pinned, and a fixed number of
 * frames is pumped by hand. Two builds photographed this way differ only if
 * their rendering differs.
 *
 *   node tools/artdiff.mjs --out a            capture build A into screenshots/artdiff/a
 *   node tools/artdiff.mjs --out b            ... and B
 *   node tools/artdiff.mjs --compare a b      report per-shot pixel deltas
 *
 * Options: --port, --mips (append ?mips=1), --dir (project root to serve).
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  const v = args[i + 1];
  return i === -1 ? d : v && !v.startsWith('--') ? v : d;
};

const PORT = Number(val('port', 5611));
const OUT_ROOT = path.join(ROOT, 'screenshots', 'artdiff');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same scenes as the golden guard, so the two can be read against each other. */
const SHOTS = [
  { name: 'meadow', level: 'endless', raw: true },
  { name: 'winter', level: 'deep-blue', raw: true },
  { name: 'cave', level: 'gauntlet', raw: true },
  { name: 'meadow-styled', level: 'endless', raw: false },
  { name: 'cave-styled', level: 'gauntlet', raw: false },
];

/** Runs before any page script: rAF is queued, never fired, until asked. */
function gateRaf() {
  const queue = [];
  const origRaf = window.requestAnimationFrame.bind(window);
  let id = 1;
  window.requestAnimationFrame = (cb) => {
    queue.push({ id: id, cb });
    return id++;
  };
  window.cancelAnimationFrame = (h) => {
    const i = queue.findIndex((q) => q.id === h);
    if (i >= 0) queue.splice(i, 1);
  };
  // Pump `n` frames at a FIXED timestamp step, so the loop sees the same dt
  // every run on every machine.
  window.__pumpRaf = (n, step = 16.6667) =>
    new Promise((resolve) => {
      let t = 1000;
      let left = n;
      const tick = () => {
        if (left-- <= 0) {
          origRaf(() => resolve());
          return;
        }
        t += step;
        const batch = queue.splice(0, queue.length);
        for (const q of batch) {
          try {
            q.cb(t);
          } catch (e) {
            console.error(e);
          }
        }
        origRaf(tick);
      };
      origRaf(tick);
    });
}

async function serve(dir) {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: dir,
    shell: true,
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return proc;
    } catch {
      await sleep(300);
    }
  }
  proc.kill();
  throw new Error('preview server did not start');
}

async function capture(browser, shot, outDir, extraQuery) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(gateRaf);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const q = `?level=${shot.level}&rs=1${extraQuery}`;
    await page.goto(`http://127.0.0.1:${PORT}/${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.evaluate(() => {
      try {
        indexedDB.deleteDatabase('spindash-speller');
        localStorage.clear();
      } catch {
        /* private mode */
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    // Poll on a timer, not on rAF: rAF is exactly what this harness has taken
    // away, and Playwright's default `raf` polling would wait forever.
    await page.waitForFunction(() => !!window.__game, null, { timeout: 180000, polling: 150 });
    // The boot overlay fades out on a CSS transition and is removed on a
    // timer, so a faster build can still be showing it when a slower one is
    // not. Wait it out rather than photograph it.
    await page.waitForFunction(() => !document.getElementById('boot'), null, {
      timeout: 30000,
      polling: 100,
    });

    await page.evaluate((raw) => {
      const g = window.__game;
      window.__renderScale?.(1);
      if (raw === false) window.__raw?.(false);
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
        if (s.particles?.clear) s.particles.clear();
      }
      g.ctx.time = 0;
      g.ctx.timeScale = 0;
      g.loop.start();
    }, shot.raw);

    // Exactly three frames: one to bind state, two to settle any first-frame
    // lazy allocation. Nothing moves — timeScale is 0.
    await page.evaluate(() => window.__pumpRaf(3));
    const buf = await page.screenshot();
    await writeFile(path.join(outDir, `${shot.name}.png`), buf);
    return errors;
  } finally {
    await ctx.close();
  }
}

async function compare(a, b) {
  const dirA = path.join(OUT_ROOT, a);
  const dirB = path.join(OUT_ROOT, b);
  const names = (await readdir(dirA)).filter((f) => f.endsWith('.png') && !f.includes('DIFF'));
  let worst = 0;
  for (const n of names) {
    const [ra, rb] = await Promise.all([
      sharp(await readFile(path.join(dirA, n))).raw().toBuffer({ resolveWithObject: true }),
      sharp(await readFile(path.join(dirB, n))).raw().toBuffer({ resolveWithObject: true }),
    ]);
    if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
      console.log(`  ${n.padEnd(20)} SIZE MISMATCH`);
      continue;
    }
    const px = ra.info.width * ra.info.height;
    const ch = ra.info.channels;
    const mask = Buffer.alloc(px * 3);
    let changed = 0;
    let maxD = 0;
    let sum = 0;
    for (let i = 0; i < px; i++) {
      const o = i * ch;
      const d = Math.max(
        Math.abs(ra.data[o] - rb.data[o]),
        Math.abs(ra.data[o + 1] - rb.data[o + 1]),
        Math.abs(ra.data[o + 2] - rb.data[o + 2]),
      );
      sum += d;
      if (d > maxD) maxD = d;
      if (d > 6) {
        changed++;
        mask[i * 3] = 255;
      } else {
        const g = ra.data[o] >> 2;
        mask[i * 3] = g;
        mask[i * 3 + 1] = g;
        mask[i * 3 + 2] = g;
      }
    }
    const pct = (changed / px) * 100;
    worst = Math.max(worst, pct);
    await sharp(mask, { raw: { width: ra.info.width, height: ra.info.height, channels: 3 } })
      .png()
      .toFile(path.join(OUT_ROOT, `${a}-vs-${b}.${n}`));
    console.log(
      `  ${n.replace('.png', '').padEnd(16)} ${pct.toFixed(3)}% of pixels differ  maxΔ ${maxD}  meanΔ ${(sum / px).toFixed(3)}`,
    );
  }
  console.log(`\nworst shot: ${worst.toFixed(3)}%`);
}

async function main() {
  await mkdir(OUT_ROOT, { recursive: true });
  const cmp = val('compare');
  if (cmp) {
    const b = args[args.indexOf('--compare') + 2];
    console.log(`--- ${cmp} vs ${b} -----------------------------------------`);
    await compare(cmp, b);
    return;
  }

  const label = val('out', 'a');
  const dir = path.resolve(val('dir', ROOT));
  const outDir = path.join(OUT_ROOT, label);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const srv = await serve(dir);
  try {
    const browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
    const extra = has('mips') ? '&mips=1' : '';
    for (const shot of SHOTS) {
      const errs = await capture(browser, shot, outDir, extra);
      console.log(`  ${shot.name.padEnd(16)} captured${errs.length ? `  ERRORS: ${errs[0]}` : ''}`);
    }
    await browser.close();
  } finally {
    srv.kill();
  }
  console.log(`\n-> ${outDir}`);
}

main().catch((e) => {
  console.error('\nARTDIFF FAILED:', e.message);
  process.exit(1);
});
