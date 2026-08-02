/**
 * Photograph the golden poses from a private build, so one file's change can be
 * isolated in a tree several agents are editing at once.
 *
 * `tools/golden.mjs` compares against committed goldens, which is the right
 * guard but the wrong instrument when someone else's in-flight work is already
 * moving those pixels: every shot fails and says nothing about YOUR change. It
 * also builds into the shared `dist/`, which two concurrent builds fight over.
 *
 * This builds into a scratch directory of its own, serves it from this process,
 * and writes the frames to a directory you name. Take one set with the file
 * under test reverted, one with it applied, and diff the two sets: whatever
 * moved is yours, and nothing else is.
 *
 *   node tools/abshot.mjs --out /tmp/shots-before
 *   node tools/abshot.mjs --out /tmp/shots-after
 *   node tools/abshot.mjs --compare /tmp/shots-before /tmp/shots-after
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { buildSnapshot, serveStatic } from './benchserve.mjs';

const ROOT = path.resolve('.');
const args = process.argv.slice(2);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const PORT = Number(val('port', 5465));
const OUT = val('out', null);
const CMP = args.indexOf('--compare');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The same shots the golden guard takes, same poses, same freeze. */
const SHOTS = [
  { name: 'meadow', level: 'endless', raw: true, pose: () => {} },
  { name: 'winter', level: 'deep-blue', raw: true, pose: () => {} },
  { name: 'cave', level: 'gauntlet', raw: true, pose: () => {} },
  {
    name: 'hero-roll',
    level: 'endless',
    raw: true,
    pose: (g) => {
      const s = g.stack.top;
      s.player.x = 300;
      s.scrollSpeed = 260;
    },
  },
  {
    name: 'hud',
    level: 'endless',
    raw: true,
    pose: (g) => {
      const s = g.stack.top;
      s.score = 2021;
      s.scoreShown = 2021;
      s.combo = 5;
      s.lives = 2;
    },
  },
  { name: 'meadow-styled', level: 'endless', raw: false, pose: () => {} },
  { name: 'cave-styled', level: 'gauntlet', raw: false, pose: () => {} },
];

async function capture(browser, shot) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?level=${shot.level}`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      try {
        indexedDB.deleteDatabase('spindash-speller');
        localStorage.clear();
      } catch {
        /* private mode */
      }
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    await sleep(600);
    await page.evaluate(
      ([poseSrc, raw]) => {
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
        // eslint-disable-next-line no-new-func
        new Function('g', `(${poseSrc})(g)`)(g);
        g.ctx.timeScale = 0;
        g.loop.start();
      },
      [shot.pose.toString(), shot.raw],
    );
    await sleep(450);
    return await page.screenshot();
  } finally {
    await ctx.close();
  }
}

async function compare(a, b) {
  let worst = 0;
  for (const shot of SHOTS) {
    const A = await sharp(await readFile(path.join(a, `${shot.name}.png`)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const B = await sharp(await readFile(path.join(b, `${shot.name}.png`)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = A.info.width * A.info.height;
    const ch = A.info.channels;
    let changed = 0;
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      const o = i * ch;
      const d = Math.max(
        Math.abs(A.data[o] - B.data[o]),
        Math.abs(A.data[o + 1] - B.data[o + 1]),
        Math.abs(A.data[o + 2] - B.data[o + 2]),
      );
      if (d > maxD) maxD = d;
      if (d > 6) changed++;
    }
    const pctv = (changed / n) * 100;
    if (pctv > worst) worst = pctv;
    console.log(`  ${shot.name.padEnd(14)} ${pctv.toFixed(3)}% of pixels past tolerance, max Δ${maxD}`);
  }
  console.log(`\nworst shot: ${worst.toFixed(3)}%`);
}

async function main() {
  if (CMP >= 0) {
    await compare(args[CMP + 1], args[CMP + 2]);
    return;
  }
  if (!OUT) throw new Error('pass --out <dir> or --compare <a> <b>');
  await mkdir(OUT, { recursive: true });
  // --reuse skips the build and re-serves the previous snapshot. Two captures
  // from ONE snapshot separate harness noise from source changes, which matters
  // when other agents are editing the tree between runs.
  const dir = args.includes('--reuse')
    ? path.join(os.tmpdir(), 'hedgehog-abshot-dist')
    : await buildSnapshot('abshot', ROOT);
  const server = await serveStatic(dir, PORT);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
  });
  try {
    for (const shot of SHOTS) {
      await writeFile(path.join(OUT, `${shot.name}.png`), await capture(browser, shot));
      console.log(`  captured ${shot.name}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
