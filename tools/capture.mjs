/**
 * Automated playtest + capture harness.
 *
 * Boots the real game in Chromium, plays it through actual pointer taps on
 * real on-screen letters (never by poking internal state), and writes out
 * screenshots plus a perf report. This is what the critics review.
 *
 * Usage:
 *   node tools/capture.mjs --out captures/run-01 [--headed] [--device phone]
 *                          [--shots intro,play,smash,complete,party,gameover]
 *
 * `--headed` uses the real GPU and produces trustworthy frame timings;
 * headless falls back to SwiftShader, which is fine for pixels but reports
 * pessimistic FPS. Perf claims should always come from a headed run.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const OUT = path.resolve(flag('out', 'captures/latest'));
const HEADED = !!flag('headed', false);
const DEVICE = flag('device', 'desktop');
const PORT = Number(flag('port', 5188));
const URL_BASE = `http://127.0.0.1:${PORT}/`;

const VIEWPORTS = {
  desktop: { width: 1280, height: 720, dsf: 1, touch: false },
  phone: { width: 390, height: 844, dsf: 3, touch: true },
  tablet: { width: 1024, height: 768, dsf: 2, touch: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function ensureServer() {
  if (await waitForServer(URL_BASE, 1200)) return null;
  const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: path.resolve('.'),
    shell: true,
    stdio: 'ignore',
    detached: false,
  });
  const ok = await waitForServer(URL_BASE, 40000);
  if (!ok) {
    proc.kill();
    throw new Error(`dev server did not come up on ${URL_BASE}`);
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
      '--enable-gpu-rasterization',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
    hasTouch: vp.touch,
    isMobile: vp.touch,
    reducedMotion: 'no-preference',
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${URL_BASE}?debug=0&seed=1234`, { waitUntil: 'load' });

  // Wait for the game handle to appear — this is the real readiness signal.
  await page.waitForFunction(() => !!window.__game, null, { timeout: 25000 });
  await sleep(600);

  const shots = [];
  const shot = async (name, note = '') => {
    const file = path.join(OUT, `${String(shots.length).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    shots.push({ name, file: path.relative(process.cwd(), file), note });
  };

  const probe = () => page.evaluate(() => window.__game?.probe?.() ?? null);

  // Convert a world-space target to page coords and tap it for real.
  const tapWorld = async (wx, wy) => {
    const pt = await page.evaluate(
      ([x, y]) => {
        const o = { x: 0, y: 0 };
        window.__game.r.worldToScreen(x, y, o);
        return o;
      },
      [wx, wy],
    );
    if (vp.touch) await page.touchscreen.tap(pt.x, pt.y);
    else await page.mouse.click(pt.x, pt.y);
  };

  await shot('boot', 'first frame after load');

  // Dismiss any intro/attract state with a tap in the centre.
  await tapWorld(640, 360);
  await sleep(900);
  await shot('intro', 'after first input');

  // --- Scripted play: hit correct letters, then deliberately miss one. ---
  const timeline = [];
  let correctHits = 0;
  let deliberateMiss = false;

  for (let step = 0; step < 60; step++) {
    const p = await probe();
    if (!p) break;
    timeline.push({ step, phase: p.phase, score: p.score, combo: p.combo, misses: p.misses });

    if (p.phase === 'celebrate') {
      await shot('party', 'word completed - celebration');
      await sleep(1600);
      continue;
    }
    if (p.phase === 'gameover') {
      await shot('gameover', 'run ended');
      break;
    }
    if (!p.targets || p.targets.length === 0) {
      await sleep(200);
      continue;
    }

    const want = p.word[p.nextIndex];
    let target = p.targets.find((t) => t.letter === want);

    // One deliberate wrong answer, to capture the bounce-off feedback.
    if (correctHits === 3 && !deliberateMiss) {
      const wrong = p.targets.find((t) => t.letter !== want);
      if (wrong) {
        target = wrong;
        deliberateMiss = true;
      }
    }
    if (!target) {
      await sleep(180);
      continue;
    }

    await tapWorld(target.x, target.y);
    if (target.letter === want) correctHits++;

    // Catch the impact frame while the smash is still on screen.
    await sleep(90);
    if (correctHits === 1) await shot('smash', 'letter smash impact');
    if (deliberateMiss && correctHits === 3) {
      await shot('bounce', 'wrong letter - bounce off');
      deliberateMiss = 'shot';
    }
    await sleep(420);
    if (shots.length < 4) await shot('play', 'mid-run gameplay');
  }

  await shot('final', 'end of scripted run');

  // --- Perf sample over a sustained window. ---
  await page.evaluate(() => {
    window.__perfSamples = [];
    const s = () => {
      if (window.__perf) window.__perfSamples.push({ ...window.__perf });
      if (window.__perfSamples.length < 60) setTimeout(s, 100);
    };
    s();
  });
  await sleep(7000);
  const samples = await page.evaluate(() => window.__perfSamples ?? []);

  const stat = (key) => {
    const v = samples.map((s) => s[key]).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!v.length) return null;
    return {
      min: +v[0].toFixed(2),
      p50: +v[Math.floor(v.length * 0.5)].toFixed(2),
      p95: +v[Math.floor(v.length * 0.95)].toFixed(2),
      max: +v[v.length - 1].toFixed(2),
    };
  };

  const report = {
    device: DEVICE,
    viewport: vp,
    headed: HEADED,
    gpuTrustworthy: HEADED,
    capturedAt: new Date().toISOString(),
    consoleErrors,
    perf: {
      fps: stat('fps'),
      updateMs: stat('updateMs'),
      renderMs: stat('renderMs'),
      drawCalls: stat('drawCalls'),
      sprites: stat('sprites'),
      heapMb: stat('heapMb'),
      atlasSize: samples[0]?.atlasSize ?? null,
      atlasOccupancy: samples[0]?.atlasOccupancy ?? null,
      bakeMs: samples[0]?.bakeMs ?? null,
      longFrames: samples[samples.length - 1]?.longFrames ?? null,
    },
    timeline,
    shots,
  };

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  if (server) {
    try {
      server.kill();
    } catch {
      /* ignore */
    }
  }

  console.log(JSON.stringify({ out: path.relative(process.cwd(), OUT), ...report.perf }, null, 2));
  if (consoleErrors.length) {
    console.error(`\n${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors.slice(0, 10)) console.error(`  ${e}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
