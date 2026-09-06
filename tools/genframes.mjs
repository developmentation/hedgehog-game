/**
 * Animation-frame generator.
 *
 * Generating each frame of a walk cycle from scratch produces a different
 * character every time — the face drifts, the quill pattern changes, the
 * proportions wander. So frames are produced with the image EDIT endpoint
 * using ONE already-approved sprite as the base image: the model is asked to
 * change only the limb pose and keep everything else identical, which holds
 * character identity across the cycle far better than re-prompting.
 *
 * The base is the RAW (un-matted) sprite, so the flat chroma background is
 * still present and every frame goes through the same matte as everything
 * else.
 *
 *   node tools/genframes.mjs --set hog_walk
 *   node tools/genframes.mjs --set hog_walk --force
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { matte } from './matte.mjs';

const ROOT = path.resolve('.');
const RAW_DIR = path.join(ROOT, 'art-src', 'raw');
const OUT_DIR = path.join(ROOT, 'public', 'art');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : d;
};

const KEEP = [
  'Keep the character IDENTICAL to the source image in every other respect:',
  'same art style, same brushwork, same indigo-purple quills with warm amber tips, same cream belly,',
  'same head shape, same face, same single visible eye, same ear, same body proportions, same size in frame,',
  'same lighting direction and same colours.',
  'ANATOMY: exactly four legs total — two front, two hind. Never draw a fifth or sixth leg.',
  'Keep the flat uniform green background exactly as in the source image, edge to edge, with no shadow on it.',
  'Do not add text, ground, scenery or props.',
].join(' ');

/**
 * A stylised four-phase quadruped cycle. Four keys is enough for a cartoon
 * run — the renderer interpolates position and squash between them.
 */
const SETS = {
  hog_walk: {
    base: 'hog_run',
    group: 'hero',
    chroma: { r: 0, g: 255, b: 0 },
    maxDim: 460,
    frames: [
      {
        id: 'hog_walk_0',
        pose:
          'Change ONLY the leg pose: this is the CONTACT pose of a walk cycle. The front-left leg is reaching forward and its paw has just touched the ground; the opposite hind leg is extended back with its paw just leaving the ground. Body level.',
      },
      {
        id: 'hog_walk_1',
        pose:
          'Change ONLY the leg pose: this is the PASSING pose of a walk cycle. The legs are gathered underneath the body, one front leg lifted and bent forward mid-swing passing close beneath the chest. The body is lifted very slightly higher.',
      },
      {
        id: 'hog_walk_2',
        pose:
          'Change ONLY the leg pose: this is the FULL EXTENSION pose of a walk cycle, mirrored from the first. The front-right leg reaches forward and the opposite hind leg pushes far back, legs at their widest spread. The body is slightly lower and stretched marginally longer.',
      },
      {
        id: 'hog_walk_3',
        pose:
          'Change ONLY the leg pose: this is the second PASSING pose of a walk cycle, mirrored. The legs gather back underneath the body with the other front leg lifted and bent mid-swing. The body is lifted very slightly higher.',
      },
    ],
  },
};

function loadEnv() {
  // Environment first, then a git-ignored .env next to package.json.
  const env = { ...process.env };
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function editFrame(apiKey, baseBuf, baseName, prompt, attempt = 1) {
  const fd = new FormData();
  fd.append('model', 'gpt-image-2');
  fd.append('image', new Blob([baseBuf], { type: 'image/png' }), `${baseName}.png`);
  fd.append('prompt', prompt);
  fd.append('size', '1024x1024');
  fd.append('quality', 'high');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(4000 * attempt * attempt);
      return editFrame(apiKey, baseBuf, baseName, prompt, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error('no image payload');
  return Buffer.from(b64, 'base64');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i]);
        } catch (e) {
          out[i] = { error: String(e.message ?? e) };
        }
      }
    }),
  );
  return out;
}

async function main() {
  const setName = val('set', 'hog_walk');
  const set = SETS[setName];
  if (!set) throw new Error(`unknown set "${setName}" (have: ${Object.keys(SETS).join(', ')})`);
  const force = has('force');

  const apiKey = loadEnv().OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing: set it in the environment or in a git-ignored .env');

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const basePath = path.join(RAW_DIR, `${set.base}.png`);
  if (!existsSync(basePath)) throw new Error(`base sprite missing: ${basePath}`);
  const baseBuf = await readFile(basePath);

  console.log(`generating ${set.frames.length} frame(s) for "${setName}" from ${set.base}\n`);
  const t0 = Date.now();

  const results = await pool(set.frames, 4, async (f) => {
    const rawPath = path.join(RAW_DIR, `${f.id}.png`);
    let raw;
    if (existsSync(rawPath) && !force) {
      raw = await readFile(rawPath);
      console.log(`  cached ${f.id}`);
    } else {
      const t = Date.now();
      raw = await editFrame(apiKey, baseBuf, set.base, `${f.pose} ${KEEP}`);
      await writeFile(rawPath, raw);
      console.log(`  gen    ${f.id.padEnd(16)} ${((Date.now() - t) / 1000).toFixed(0)}s`);
    }
    // trim:false keeps every frame on the same canvas so the cycle registers.
    const m = await matte(raw, { key: set.chroma, maxDim: set.maxDim, tolerance: 120, trim: false });
    await writeFile(path.join(OUT_DIR, `${f.id}.png`), m.buffer);
    return { id: f.id, group: set.group, w: m.width, h: m.height, coverage: +m.coverage.toFixed(3) };
  });

  let manifest = { generatedAt: null, assets: {} };
  if (existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    } catch {
      /* start fresh */
    }
  }
  manifest.assets ??= {};
  const fails = [];
  for (const r of results) {
    if (r?.error) fails.push(r.error);
    else if (r) manifest.assets[r.id] = r;
  }
  manifest.generatedAt = new Date().toISOString();
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)}m — ${results.filter((r) => r && !r.error).length}/${set.frames.length} frames`);
  if (fails.length) {
    for (const f of fails) console.error('  FAIL ' + f);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
