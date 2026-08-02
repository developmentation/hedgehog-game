/**
 * Does the frame's own art cover the screen, or is the clear load-bearing?
 *
 * `glClear` on a 2560x1440 backbuffer measures 0.99 ms on the test GPU — 12% of
 * the frame — because it is a real 14.8 MB write, not a metadata fast path. It
 * is redundant for every pixel that opaque art paints over afterwards. The
 * renderer cannot prove that from geometry alone (this game's backdrop covers
 * the viewport as a UNION of bands, several of which are not flagged opaque),
 * so the question has to be answered empirically.
 *
 * Method: render the same frozen pose twice, identical in every way except the
 * clear colour, and diff. A pixel that differs is a pixel the clear is visible
 * through. Zero differing pixels inside the rendered band means the clear
 * contributes nothing there and can be scissored down to the letterbox bars.
 *
 *   node tools/clearprobe.mjs            frozen golden poses + a live soak
 *   node tools/clearprobe.mjs --live-ms 8000
 */

import { chromium } from 'playwright';
import path from 'node:path';
import sharp from 'sharp';
import { buildSnapshot, serveStatic } from './benchserve.mjs';

const ROOT = path.resolve('.');
const args = process.argv.slice(2);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const LIVE_MS = Number(val('live-ms', 6000));
const PORT = Number(val('port', 5496));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same poses the golden guard photographs, plus the two overlay scenes. */
const POSES = [
  { name: 'meadow', level: 'endless', raw: true },
  { name: 'meadow-styled', level: 'endless', raw: false },
  { name: 'winter', level: 'deep-blue', raw: true },
  { name: 'cave', level: 'gauntlet', raw: true },
  { name: 'cave-styled', level: 'gauntlet', raw: false },
];

const QUICK = args.includes('--quick');
const VIEWPORTS = [
  { name: '16:9  1280x720 dsf2', width: 1280, height: 720, deviceScaleFactor: 2 },
  { name: 'portrait 390x844 dsf3', width: 390, height: 844, deviceScaleFactor: 3 },
  { name: 'ultrawide 1720x720 dsf1', width: 1720, height: 720, deviceScaleFactor: 1 },
];

function pinClear(rgb) {
  const r = window.__game.r;
  if (!window.__origClear) window.__origClear = r.clear.bind(r);
  r.clear = function () {
    window.__origClear(rgb[0], rgb[1], rgb[2]);
  };
}

function freeze(raw) {
  const g = window.__game;
  window.__renderScale?.(1);
  if (!raw) window.__raw?.(false);
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
}

async function diffCount(a, b) {
  const A = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  const n = A.info.width * A.info.height;
  const ch = A.info.channels;
  let differing = 0;
  let firstY = -1;
  let lastY = -1;
  let minX = Infinity;
  let maxX = -1;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (A.data[o] !== B.data[o] || A.data[o + 1] !== B.data[o + 1] || A.data[o + 2] !== B.data[o + 2]) {
      differing++;
      const y = (i / A.info.width) | 0;
      const x = i % A.info.width;
      if (firstY < 0) firstY = y;
      lastY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return { differing, total: n, firstY, lastY, minX, maxX, h: A.info.height, w: A.info.width };
}

async function main() {
  const server = await serveStatic(await buildSnapshot('clearprobe', ROOT), PORT);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
  });
  let bad = 0;
  try {
    for (const vp of (QUICK ? VIEWPORTS.slice(0, 1) : VIEWPORTS)) {
      console.log(`\n${vp.name}`);
      for (const pose of POSES) {
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.deviceScaleFactor,
        });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${PORT}/?level=${pose.level}&rs=1`, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
        await sleep(700);
        await page.evaluate(freeze, pose.raw);
        await sleep(400);

        await page.evaluate(pinClear, [1, 0, 1]);
        await sleep(250);
        const magenta = await page.screenshot();
        await page.evaluate(pinClear, [0, 1, 0]);
        await sleep(250);
        const green = await page.screenshot();
        const d = await diffCount(magenta, green);
        const pctv = (d.differing / d.total) * 100;
        if (d.differing) bad++;
        console.log(
          `  ${pose.name.padEnd(14)} ${d.differing === 0 ? 'covered' : 'CLEAR VISIBLE'}  ` +
            `${d.differing} px (${pctv.toFixed(3)}%)` +
            (d.differing ? `  rows ${d.firstY}..${d.lastY} of ${d.h}, cols ${d.minX}..${d.maxX} of ${d.w}` : ''),
        );
        await ctx.close();
      }
    }

    if (QUICK) return;
    // Live soak: play for real and look for the clear colour showing through.
    console.log('\nlive soak (16:9, unfrozen, magenta clear)');
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?level=endless&rs=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    await sleep(600);
    await page.evaluate(pinClear, [1, 0, 1]);
    let worst = 0;
    const t0 = Date.now();
    let shots = 0;
    while (Date.now() - t0 < LIVE_MS) {
      await page.keyboard.press('Space');
      const buf = await page.screenshot();
      const im = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const n = im.info.width * im.info.height;
      const ch = im.info.channels;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const o = i * ch;
        if (im.data[o] > 200 && im.data[o + 1] < 60 && im.data[o + 2] > 200) hits++;
      }
      if (hits > worst) worst = hits;
      shots++;
    }
    console.log(`  ${shots} frames sampled, worst magenta pixel count: ${worst}`);
    if (worst) bad++;
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(
    bad
      ? `\n${bad} case(s) where the clear is visible — it is load-bearing there.`
      : '\nthe clear is invisible in every case: the art covers the band everywhere.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
