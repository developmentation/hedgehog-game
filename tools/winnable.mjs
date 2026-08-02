/**
 * Winnability soak test.
 *
 * The game is only playable if the letter the player needs next reliably
 * appears on an approaching wall. That is not guaranteed by construction —
 * walls are assigned target letters at spawn from a *prediction* about how
 * the player will consume them — so it has to be tested by actually playing.
 *
 * This plays real words through real taps and fails loudly if the needed
 * letter ever goes missing for longer than a wall cycle, which is exactly the
 * deadlock a player hits when a word becomes unwinnable.
 *
 *   node tools/winnable.mjs --words 12 --port 5271
 *   node tools/winnable.mjs --words 12 --miss   # also miss walls on purpose
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const WORDS = Number(val('words', 10));
const PORT = Number(val('port', 5271));
const MISS = has('miss');
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  let server = null;
  if (!(await up(1200))) {
    server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      shell: true,
      stdio: 'ignore',
    });
    if (!(await up(45000))) throw new Error('preview server did not start');
  }

  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 25000 });
  await sleep(700);
  await page.mouse.click(640, 400);
  await sleep(900);

  const probe = () => page.evaluate(() => window.__game?.probe?.() ?? null);
  const tap = async (wx, wy) => {
    const p = await page.evaluate(
      ([x, y]) => {
        const o = { x: 0, y: 0 };
        window.__game.r.worldToScreen(x, y, o);
        return o;
      },
      [wx, wy],
    );
    await page.mouse.click(p.x, p.y);
  };

  const completed = [];
  const failures = [];
  let lastWord = null;
  let starvedTicks = 0;
  let missesTaken = 0;
  let ticks = 0;

  const MAX_TICKS = WORDS * 260;
  const STARVE_LIMIT = 90; // ~18s without the needed letter being reachable

  while (completed.length < WORDS && ticks < MAX_TICKS) {
    ticks++;
    const p = await probe();
    if (!p) break;

    if (p.word !== lastWord) {
      if (lastWord !== null && p.phase !== 'setback') completed.push(lastWord);
      lastWord = p.word;
      starvedTicks = 0;
    }

    if (p.phase === 'celebrate' || p.phase === 'setback') {
      await sleep(200);
      continue;
    }

    const need = p.word[p.nextIndex];
    const hit = p.targets.find((t) => t.letter === need);

    if (!hit) {
      starvedTicks++;
      if (starvedTicks > STARVE_LIMIT) {
        failures.push({
          word: p.word,
          revealed: p.revealed.map((r) => (r ? '1' : '0')).join(''),
          need,
          onScreen: [...new Set(p.targets.map((t) => t.letter))].sort().join(''),
          note: 'needed letter never appeared — word is unwinnable',
        });
        // Force a new word so the soak keeps going and can find more cases.
        lastWord = null;
        starvedTicks = 0;
        await sleep(1500);
      }
      await sleep(200);
      continue;
    }

    starvedTicks = 0;

    // Optionally let some walls roll past unused — this is the player
    // behaviour that broke the original targeting prediction.
    if (MISS && missesTaken < WORDS && Math.random() < 0.18) {
      missesTaken++;
      await sleep(900);
      continue;
    }

    await tap(hit.x, hit.y);
    await sleep(260);
  }

  await browser.close();
  if (server) server.kill();

  const ok = failures.length === 0 && errors.length === 0;
  console.log(`words completed : ${completed.length}/${WORDS}`);
  console.log(`deliberate skips: ${missesTaken}`);
  console.log(`console errors  : ${errors.length}`);
  console.log(`deadlocks       : ${failures.length}`);
  for (const f of failures.slice(0, 6)) {
    console.log(`  DEADLOCK "${f.word}" revealed=${f.revealed} needed=${f.need} onScreen=[${f.onScreen}]`);
  }
  for (const e of errors.slice(0, 5)) console.log(`  ERROR ${e}`);
  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
