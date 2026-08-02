/**
 * Art generation pipeline.
 *
 * Generates every asset in tools/artspec.mjs with gpt-image-2, keys out the
 * chroma background, trims and downscales, and writes a manifest the game
 * loads at boot.
 *
 *   node tools/genart.mjs                 # generate anything missing
 *   node tools/genart.mjs --only tree_oak,hog_ball
 *   node tools/genart.mjs --group prop
 *   node tools/genart.mjs --force         # regenerate even if cached
 *   node tools/genart.mjs --rematte       # re-run matting on existing raws
 *   node tools/genart.mjs --concurrency 6
 *
 * Raw generations are cached in art-src/raw/ so re-matting never costs another
 * API call — matting parameters get iterated on far more often than prompts.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ASSETS, promptFor } from './artspec.mjs';
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

const FORCE = has('force');
const REMATTE = has('rematte');
const CONCURRENCY = Number(val('concurrency', 5));
const ONLY = val('only') ? String(val('only')).split(',').map((s) => s.trim()) : null;
const GROUP = val('group');

function loadEnv() {
  const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateOne(apiKey, spec, attempt = 1) {
  const body = {
    model: 'gpt-image-2',
    prompt: promptFor(spec),
    size: spec.size ?? '1024x1024',
    output_format: 'png',
    quality: 'high',
    n: 1,
  };

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt < 4) {
      const wait = 4000 * attempt * attempt;
      console.log(`  ${spec.id}: HTTP ${res.status}, retry ${attempt} in ${wait / 1000}s`);
      await sleep(wait);
      return generateOne(apiKey, spec, attempt + 1);
    }
    throw new Error(`${spec.id}: HTTP ${res.status} ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${spec.id}: no image payload`);
  return Buffer.from(b64, 'base64');
}

async function processOne(apiKey, spec, stats) {
  const rawPath = path.join(RAW_DIR, `${spec.id}.png`);
  const outPath = path.join(OUT_DIR, `${spec.id}.png`);

  let raw;
  const cached = existsSync(rawPath);

  if (cached && !FORCE) {
    raw = await readFile(rawPath);
    if (!REMATTE && existsSync(outPath)) {
      stats.skipped.push(spec.id);
      return null;
    }
  } else {
    const t0 = Date.now();
    raw = await generateOne(apiKey, spec);
    await writeFile(rawPath, raw);
    stats.generated.push(spec.id);
    console.log(`  gen  ${spec.id.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (spec.opaque) {
    // Full-frame art needs no keying — just downscale if requested.
    let p = sharp(raw);
    if (spec.maxDim) p = p.resize(spec.maxDim, spec.maxDim, { fit: 'inside' });
    const buf = await p.png({ compressionLevel: 9 }).toBuffer();
    const meta = await sharp(buf).metadata();
    await writeFile(outPath, buf);
    return { id: spec.id, group: spec.group, w: meta.width, h: meta.height, opaque: true };
  }

  const res = await matte(raw, {
    key: spec.chroma?.key,
    tolerance: spec.tolerance ?? 120,
    maxDim: spec.maxDim ?? 0,
    trimPad: 2,
  });

  if (res.coverage < 0.02) {
    stats.warnings.push(`${spec.id}: matte kept only ${(res.coverage * 100).toFixed(1)}% — key may have failed`);
  }
  if (res.coverage > 0.97) {
    stats.warnings.push(`${spec.id}: matte removed almost nothing — background may not be flat`);
  }

  await writeFile(outPath, res.buffer);
  return {
    id: spec.id,
    group: spec.group,
    w: res.width,
    h: res.height,
    opaque: false,
    coverage: +res.coverage.toFixed(3),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { error: String(err.message ?? err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const env = loadEnv();
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing from .env');

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  let list = ASSETS;
  if (ONLY) list = list.filter((a) => ONLY.includes(a.id));
  if (GROUP) list = list.filter((a) => a.group === GROUP);
  if (!list.length) throw new Error('no assets matched the filter');

  console.log(`generating ${list.length} asset(s), concurrency ${CONCURRENCY}\n`);
  const stats = { generated: [], skipped: [], warnings: [] };
  const t0 = Date.now();

  const results = await pool(list, CONCURRENCY, (spec) => processOne(apiKey, spec, stats));

  const entries = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.error) failures.push(`${list[i].id}: ${r.error}`);
    else entries.push(r);
  }

  // Merge into any existing manifest so partial runs do not drop other assets.
  let manifest = { generatedAt: null, assets: {} };
  if (existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    } catch {
      /* start fresh */
    }
  }
  manifest.generatedAt = new Date().toISOString();
  manifest.assets ??= {};
  for (const e of entries) manifest.assets[e.id] = e;

  // Keep the manifest honest: drop entries whose file no longer exists.
  const present = new Set((await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')));
  for (const id of Object.keys(manifest.assets)) {
    if (!present.has(id)) delete manifest.assets[id];
  }

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\ndone in ${mins}m`);
  console.log(`  generated ${stats.generated.length}, cached-skip ${stats.skipped.length}, in manifest ${Object.keys(manifest.assets).length}`);
  for (const w of stats.warnings) console.log(`  WARN  ${w}`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error('  ' + f);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
