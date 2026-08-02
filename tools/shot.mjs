/**
 * Milestone screenshot tool.
 *
 * Boots the game, plays a short scripted sequence, and writes a numbered set
 * of PNGs into `screenshots/<tag>/` so the visual evolution of the build is
 * reviewable at a glance. Also refreshes `screenshots/latest/`.
 *
 * Usage:
 *   node tools/shot.mjs --tag 01-scaffold [--device desktop|phone] [--headed]
 *   node tools/shot.mjs --tag 04-art-pass --note "world layer v2"
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const TAG = String(flag('tag', 'latest'));
const DEVICE = String(flag('device', 'desktop'));
const NOTE = String(flag('note', ''));
const HEADED = !!flag('headed', false);
const PORT = Number(flag('port', 5188));
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'screenshots', TAG);

const VIEWPORTS = {
  desktop: { width: 1280, height: 720, dsf: 2, touch: false },
  phone: { width: 390, height: 844, dsf: 3, touch: true },
  tablet: { width: 1024, height: 768, dsf: 2, touch: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(300);
  }
  return false;
}

async function ensureServer() {
  if (await up(URL_BASE, 1200)) return null;
  const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
  });
  if (!(await up(URL_BASE, 45000))) {
    proc.kill();
    throw new Error(`dev server never came up at ${URL_BASE}`);
  }
  return proc;
}

async function main() {
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = await ensureServer();
  const vp = VIEWPORTS[DEVICE] ?? VIEWPORTS.desktop;

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
    hasTouch: vp.touch,
    isMobile: vp.touch,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  let n = 0;
  const manifest = [];
  const shot = async (name, note = '') => {
    const file = path.join(OUT, `${String(n++).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    manifest.push({ name, note, file: path.relative(ROOT, file) });
    process.stdout.write(`  shot ${path.basename(file)}\n`);
  };

  await page.goto(`${URL_BASE}?debug=1`, { waitUntil: 'load' });

  const booted = await page
    .waitForFunction(() => !!window.__game, null, { timeout: 25000 })
    .then(() => true)
    .catch(() => false);

  if (!booted) {
    await shot('BOOT-FAILED', 'game handle never appeared');
    await writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({ tag: TAG, note: NOTE, booted: false, errors, shots: manifest }, null, 2),
    );
    await browser.close();
    if (server) server.kill();
    console.error('BOOT FAILED');
    for (const e of errors.slice(0, 12)) console.error('  ' + e);
    process.exit(3);
  }

  await sleep(900);
  await shot('title', 'first frame / intro state');

  const w2s = (x, y) =>
    page.evaluate(
      ([a, b]) => {
        const o = { x: 0, y: 0 };
        window.__game.r.worldToScreen(a, b, o);
        return o;
      },
      [x, y],
    );
  const tap = async (x, y) => {
    const p = await w2s(x, y);
    if (vp.touch) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
  };
  const probe = () => page.evaluate(() => window.__game?.probe?.() ?? null);

  await tap(640, 400);
  await sleep(1100);
  await shot('clue', 'word prompt + clue card');

  await sleep(1200);
  await shot('gameplay', 'letter walls scrolling in');

  // Play properly: hit the right letters, take one deliberate hit.
  let hits = 0;
  let didMiss = false;
  for (let i = 0; i < 44; i++) {
    const p = await probe();
    if (!p) break;

    if (p.phase === 'celebrate') {
      await sleep(260);
      await shot('celebrate', 'word complete - dance party');
      await sleep(2000);
      continue;
    }
    if (!p.targets?.length) {
      await sleep(200);
      continue;
    }

    const want = p.word[p.nextIndex];
    let t = p.targets.find((b) => b.letter === want);

    if (hits === 2 && !didMiss) {
      const wrong = p.targets.find((b) => b.letter !== want);
      if (wrong) {
        t = wrong;
        didMiss = true;
      }
    }
    if (!t) {
      await sleep(160);
      continue;
    }

    const wasRight = t.letter === want;
    await tap(t.x, t.y);
    await sleep(70);

    if (wasRight && hits === 0) await shot('smash', 'spin dash impact');
    else if (!wasRight) await shot('bounce', 'wrong letter - knocked back');

    if (wasRight) hits++;
    await sleep(430);
    if (hits === 3) await shot('progress', 'hangman bar filling in');
  }

  await shot('final', 'end of scripted run');

  // Mobile portrait check from the same run.
  if (DEVICE === 'desktop') {
    const mob = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    });
    const mp = await mob.newPage();
    await mp.goto(`${URL_BASE}?debug=0`, { waitUntil: 'load' });
    await mp.waitForFunction(() => !!window.__game, null, { timeout: 20000 }).catch(() => {});
    await sleep(1400);
    await mp.touchscreen.tap(195, 420);
    await sleep(1800);
    const f = path.join(OUT, `${String(n++).padStart(2, '0')}-phone.png`);
    await mp.screenshot({ path: f });
    manifest.push({ name: 'phone', note: '390x844 portrait', file: path.relative(ROOT, f) });
    process.stdout.write(`  shot ${path.basename(f)}\n`);
    await mob.close();
  }

  const perf = await page.evaluate(() => window.__perf ?? null);

  await writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(
      { tag: TAG, note: NOTE, device: DEVICE, booted: true, capturedAt: new Date().toISOString(), perf, errors, shots: manifest },
      null,
      2,
    ),
  );

  // Mirror into screenshots/latest for a stable "current state" path.
  const latest = path.join(ROOT, 'screenshots', 'latest');
  if (TAG !== 'latest') {
    await rm(latest, { recursive: true, force: true });
    await cp(OUT, latest, { recursive: true });
  }

  await browser.close();
  if (server) server.kill();

  console.log(`\n${manifest.length} shots -> screenshots/${TAG}/`);
  if (perf) console.log(`fps ${perf.fps?.toFixed(0)}  draws ${perf.drawCalls}  sprites ${perf.sprites}`);
  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ' + e);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
