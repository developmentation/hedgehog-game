/**
 * Asset-pipeline probe: what the art actually costs at runtime.
 *
 * Boots a production build in a real browser and reports, from the inside:
 *
 *   - every GPU texture allocation the page makes, with dimensions, internal
 *     format, mip level and bytes — i.e. the real VRAM bill, not an estimate
 *   - the cold-boot timeline broken into fetch / decode / bake / upload
 *   - atlas geometry: size, occupancy, wasted area, bake scale actually used
 *   - which compressed-texture formats the device offers
 *
 * Method: an init script installed before any page code wraps `fetch` and the
 * WebGL texture-upload entry points. Wrapping the GL calls is what makes the
 * VRAM number trustworthy — it counts what was uploaded, including allocations
 * the engine does not know it is making, and it cannot drift from the code.
 *
 *   node tools/assetprobe.mjs                 headed, real GPU (default)
 *   node tools/assetprobe.mjs --swift         software rasteriser, headless
 *   node tools/assetprobe.mjs --json out.json
 *   node tools/assetprobe.mjs --runs 3        median of N cold boots
 *   node tools/assetprobe.mjs --throttle 4    simulate a 4x slower CPU
 *
 * Each run is a cold boot: a fresh browser context with an empty HTTP cache,
 * so the fetch column is a first visit rather than a reload.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  const v = args[i + 1];
  return i === -1 ? d : v && !v.startsWith('--') ? v : d;
};

const OUT_DIR = path.join(ROOT, '.probe-dist');
const PORT = Number(val('port', 5487));
const RUNS = Number(val('runs', 3));
const THROTTLE = Number(val('throttle', 1));
const SWIFT = has('swift');
const JSON_OUT = val('json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1048576).toFixed(2);

/**
 * Installed before any page script.
 *
 * Everything here has to survive being stringified, so it is one self-contained
 * function with no closure over the harness.
 */
function instrument() {
  const T = {
    textures: [],
    fetches: [],
    uploadMs: 0,
    decodeMs: 0,
    imgDecodeMs: 0,
    bitmapMs: 0,
  };
  window.__probeData = T;

  const t0 = performance.now();

  // --- fetch / XHR ---------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...a) {
    const url = String(typeof a[0] === 'string' ? a[0] : a[0]?.url ?? '');
    const s = performance.now();
    const res = await origFetch.apply(this, a);
    T.fetches.push({ url, ms: performance.now() - s, start: s - t0 });
    return res;
  };

  // --- image decode --------------------------------------------------------
  // Both paths are wrapped so a before/after comparison is apples to apples.
  const origCIB = window.createImageBitmap;
  if (origCIB) {
    window.createImageBitmap = async function (...a) {
      const s = performance.now();
      const r = await origCIB.apply(this, a);
      T.bitmapMs += performance.now() - s;
      return r;
    };
  }
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...srcDesc,
    set(v) {
      const s = performance.now();
      this.addEventListener(
        'load',
        () => {
          T.imgDecodeMs += performance.now() - s;
        },
        { once: true },
      );
      srcDesc.set.call(this, v);
    },
  });

  // --- GPU texture allocation ---------------------------------------------
  const G = WebGL2RenderingContext.prototype;
  // Bytes per pixel by internal format, for the formats this engine can reach.
  const BPP = {
    6408: 4, // RGBA
    32856: 4, // RGBA8
    6407: 3, // RGB
    32849: 3, // RGB8
  };
  // Compressed formats: bytes per 4x4 block.
  const BLOCK = {
    33776: 8, // COMPRESSED_RGB_S3TC_DXT1
    33777: 8, // COMPRESSED_RGBA_S3TC_DXT1
    33778: 16, // DXT3
    33779: 16, // DXT5
    36492: 16, // BPTC / BC7
    37808: 16, // ASTC 4x4
    37492: 8, // ETC2 RGB8
    37496: 16, // ETC2 RGBA8
  };

  let bound = null;
  const origBind = G.bindTexture;
  G.bindTexture = function (target, tex) {
    if (target === this.TEXTURE_2D) bound = tex;
    return origBind.call(this, target, tex);
  };

  function note(rec) {
    T.textures.push(rec);
  }

  const origTexImage2D = G.texImage2D;
  G.texImage2D = function (target, level, internalformat, ...rest) {
    const s = performance.now();
    const r = origTexImage2D.call(this, target, level, internalformat, ...rest);
    const ms = performance.now() - s;
    T.uploadMs += ms;
    // Two overloads: (…, w, h, border, fmt, type, pixels) or (…, fmt, type, src)
    let w = 0;
    let h = 0;
    if (rest.length >= 6) {
      w = rest[0];
      h = rest[1];
    } else {
      const src = rest[2];
      w = src?.width ?? src?.videoWidth ?? 0;
      h = src?.height ?? src?.videoHeight ?? 0;
    }
    note({ kind: 'tex', level, internalformat, w, h, bytes: (BPP[internalformat] ?? 4) * w * h, ms, at: s - t0 });
    return r;
  };

  // Immutable storage: one call commits every mip level up front, so this is
  // the allocation that matters and `texSubImage2D` after it is free.
  const origTexStorage = G.texStorage2D;
  if (origTexStorage) {
    G.texStorage2D = function (target, levels, internalformat, w, h) {
      const s = performance.now();
      const r = origTexStorage.call(this, target, levels, internalformat, w, h);
      const ms = performance.now() - s;
      T.uploadMs += ms;
      let bytes = 0;
      for (let i = 0; i < levels; i++) bytes += Math.max(1, w >> i) * Math.max(1, h >> i) * (BPP[internalformat] ?? 4);
      note({ kind: 'tex', level: 0, levels, internalformat, w, h, bytes, ms, at: s - t0 });
      return r;
    };
  }

  const origCompressed = G.compressedTexImage2D;
  if (origCompressed) {
    G.compressedTexImage2D = function (target, level, internalformat, w, h, ...rest) {
      const s = performance.now();
      const r = origCompressed.call(this, target, level, internalformat, w, h, ...rest);
      const ms = performance.now() - s;
      T.uploadMs += ms;
      const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
      note({
        kind: 'compressed',
        level,
        internalformat,
        w,
        h,
        bytes: blocks * (BLOCK[internalformat] ?? 16),
        ms,
        at: s - t0,
      });
      return r;
    };
  }

  const origGenMip = G.generateMipmap;
  G.generateMipmap = function (target) {
    const s = performance.now();
    const r = origGenMip.call(this, target);
    T.uploadMs += performance.now() - s;
    T.textures.push({ kind: 'mipgen', ms: performance.now() - s, at: s - t0, storage: !!origTexStorage && T.textures.some((t) => t.levels > 1) });
    return r;
  };

  // Renderbuffers are VRAM too — the world pass allocates one when the
  // adaptive render scale drops below 1.
  const origRb = G.renderbufferStorage;
  G.renderbufferStorage = function (target, fmt, w, h) {
    note({ kind: 'renderbuffer', level: 0, internalformat: fmt, w, h, bytes: 4 * w * h, ms: 0, at: performance.now() - t0 });
    return origRb.call(this, target, fmt, w, h);
  };

  window.__probeGl = () => {
    const c = document.getElementById('glcanvas');
    const gl = c && (c.__ctx || null);
    return null;
  };
}

async function runOnce(browser, url, index) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    bypassCSP: true,
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  if (THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  }

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  const toGameMs = Date.now() - t0;
  // Let the first frames land so mip generation / lazy allocation is counted.
  await sleep(1500);

  // --- minification census -------------------------------------------------
  //
  // The question mipmaps answer is "how many texels does a screen pixel cover".
  // Wrapping `draw` and comparing each sprite's texel extent to the device
  // pixels it lands on answers it from the real frame instead of from theory.
  await page.evaluate(() => {
    const g = window.__game;
    const r = g.r;
    const M = { samples: [], byTex: new Map() };
    window.__minify = M;
    const orig = r.draw.bind(r);
    // Painted assets are baked 1:1, so a frame's art width IS its texel width.
    // Frames handed to `draw` are often cropped sub-rects built by the
    // parallax code, so identity on the Frame object only catches the hero.
    // Group by TEXTURE instead and name each texture after an asset that lives
    // on it — which is exactly the granularity the mip decision needs, because
    // filtering is a per-texture setting.
    const idOf = new Map();
    const texName = new Map();
    const texCount = new Map();
    for (const [id, f] of g.ctx.assets.frames) {
      idOf.set(f, id);
      texCount.set(f.tex, (texCount.get(f.tex) ?? 0) + 1);
      if (!texName.has(f.tex)) texName.set(f.tex, id);
    }
    for (const [tex, n] of texCount) {
      if (n > 1) texName.set(tex, `atlas page (${n} sprites, e.g. ${texName.get(tex)})`);
    }
    r.draw = function (f, x, y, sx = 1, sy = sx, ...rest) {
      const dev = r.scale * (g.ctx.cam.zoom || 1) * r.renderScale;
      const px = Math.abs(f.w * sx) * dev;
      if (px > 0.5) {
        const painted = r.rawTextures.has(f.tex);
        M.samples.push({ ratio: f.w / px, painted });
        if (painted) {
          const key = texName.get(f.tex) ?? 'unnamed';
          const b = M.byTex.get(key) ?? [];
          b.push(f.w / px);
          M.byTex.set(key, b);
        }
      }
      return orig(f, x, y, sx, sy, ...rest);
    };
  });
  await sleep(2500);
  const minify = await page.evaluate(() => {
    const all = window.__minify.samples;
    const stat = (list) => {
      const s = list.map((x) => x.ratio).sort((a, b) => a - b);
      if (!s.length) return null;
      const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return {
        n: s.length,
        p05: +q(0.05).toFixed(2),
        p50: +q(0.5).toFixed(2),
        p90: +q(0.9).toFixed(2),
        p99: +q(0.99).toFixed(2),
        minifiedPct: +((s.filter((v) => v > 1.05).length / s.length) * 100).toFixed(1),
        over2xPct: +((s.filter((v) => v > 2).length / s.length) * 100).toFixed(1),
      };
    };
    const per = [];
    for (const [id, list] of window.__minify.byTex) {
      const s = list.slice().sort((a, b) => a - b);
      per.push({ id, n: s.length, p50: +s[s.length >> 1].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2) });
    }
    per.sort((a, b) => b.p50 - a.p50);
    return {
      painted: stat(all.filter((x) => x.painted)),
      procedural: stat(all.filter((x) => !x.painted)),
      per,
    };
  });

  const data = await page.evaluate(() => {
    const g = window.__game;
    const a = g.ctx.assets;
    const c = document.getElementById('glcanvas');
    const gl = g.r.gl;
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource').map((r) => ({
      name: r.name.split('/').pop(),
      kind: r.initiatorType,
      ms: r.duration,
      start: r.startTime,
      bytes: r.encodedBodySize,
      transfer: r.transferSize,
    }));
    return {
      probe: window.__probeData,
      resources: res,
      domContentLoaded: nav.domContentLoadedEventEnd,
      assets: {
        loadedCount: a.loadedCount,
        failedCount: a.failedCount,
        atlasSize: a.atlasSize,
        standaloneTextures: a.standaloneTextures,
        loadMs: a.loadMs,
        frames: a.frames.size,
        stats: a.stats ?? null,
      },
      proceduralAtlas: { size: g.atlas.size, occupancy: g.atlas.occupancy, bakeScale: g.atlas.bakeScale },
      gl: {
        renderer: (() => {
          const d = gl.getExtension('WEBGL_debug_renderer_info');
          return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : String(gl.getParameter(gl.RENDERER));
        })(),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        compressed: gl.getSupportedExtensions().filter((e) => /compress|bptc|s3tc|etc|astc/i.test(e)),
      },
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
      canvas: { w: c.width, h: c.height },
    };
  });

  await context.close();
  return { ...data, minify, toGameMs, errors, index };
}

function summarise(runs) {
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const r = runs[0];
  const texs = r.probe.textures.filter((t) => t.kind === 'tex' || t.kind === 'compressed');
  const rbs = r.probe.textures.filter((t) => t.kind === 'renderbuffer');

  const lines = [];
  const say = (s = '') => lines.push(s);

  say(`renderer      ${r.gl.renderer}`);
  say(`max texture   ${r.gl.maxTex}`);
  say(`compressed    ${r.gl.compressed.join(', ') || 'none'}`);
  say(`canvas        ${r.canvas.w}x${r.canvas.h}`);
  say('');

  say('--- GPU texture allocations (level 0 unless noted) ---');
  let total = 0;
  for (const t of texs) {
    total += t.bytes;
    say(
      `  ${String(t.w).padStart(5)}x${String(t.h).padEnd(5)} ${t.levels ? t.levels + ' lvls' : '1 lvl '}  fmt 0x${t.internalformat.toString(16)}  ` +
        `${mb(t.bytes).padStart(7)} MB  alloc ${t.ms.toFixed(1)} ms  @${t.at.toFixed(0)} ms`,
    );
  }
  // Textures allocated with texStorage2D already report their whole chain; a
  // mutable texture followed by generateMipmap gains 1/3 on top.
  const mutableMipped = r.probe.textures.filter((t) => t.kind === 'mipgen').length
    ? texs.filter((t) => !t.levels).reduce((a, b) => a + b.bytes, 0) / 3
    : 0;
  if (mutableMipped) {
    say(`  + mip chains on mutable textures: ${mb(mutableMipped)} MB`);
    total += mutableMipped;
  }
  for (const t of rbs) {
    say(`  renderbuffer ${t.w}x${t.h}  ${mb(t.bytes)} MB`);
    total += t.bytes;
  }
  say(`  TOTAL VRAM  ${mb(total)} MB across ${texs.length} textures`);
  say('');

  say('--- atlases ---');
  say(
    `  painted atlas    ${r.assets.atlasSize}x${r.assets.atlasSize}  ` +
      `${r.assets.standaloneTextures} standalone  ${r.assets.frames} frames`,
  );
  say(
    `  procedural atlas ${r.proceduralAtlas.size}x${r.proceduralAtlas.size}  ` +
      `occupancy ${(r.proceduralAtlas.occupancy * 100).toFixed(1)}%  bakeScale ${r.proceduralAtlas.bakeScale}`,
  );
  if (r.assets.stats) say(`  painted stats    ${JSON.stringify(r.assets.stats)}`);
  say('');

  say('--- cold boot (median of ' + runs.length + ') ---');
  const artRes = (run) => run.resources.filter((x) => x.name.endsWith('.png'));
  say(`  to __game            ${median(runs.map((x) => x.toGameMs))} ms`);
  say(`  assets.load()        ${median(runs.map((x) => x.assets.loadMs)).toFixed(0)} ms`);
  say(
    `  art bytes over wire  ${mb(artRes(r).reduce((a, b) => a + (b.transfer || b.bytes), 0))} MB in ${artRes(r).length} requests`,
  );
  const artStart = Math.min(...artRes(r).map((x) => x.start));
  const artEnd = Math.max(...artRes(r).map((x) => x.start + x.ms));
  say(`  art fetch window     ${artStart.toFixed(0)} -> ${artEnd.toFixed(0)} ms (${(artEnd - artStart).toFixed(0)} ms wall)`);
  say(`  sum of fetch times   ${artRes(r).reduce((a, b) => a + b.ms, 0).toFixed(0)} ms (parallelism ${(artRes(r).reduce((a, b) => a + b.ms, 0) / (artEnd - artStart)).toFixed(1)}x)`);
  say(`  <img> decode (main)  ${median(runs.map((x) => x.probe.imgDecodeMs)).toFixed(0)} ms summed`);
  say(`  createImageBitmap    ${median(runs.map((x) => x.probe.bitmapMs)).toFixed(0)} ms summed`);
  say(`  GL upload            ${median(runs.map((x) => x.probe.uploadMs)).toFixed(0)} ms`);
  say(`  JS heap              ${r.heapMB ? r.heapMB.toFixed(1) + ' MB' : 'n/a'}`);
  say('');
  say('--- minification (texels per device pixel; >1 = minified) ---');
  for (const k of ['painted', 'procedural']) {
    const s = r.minify?.[k];
    if (!s) continue;
    say(
      `  ${k.padEnd(11)} n=${String(s.n).padStart(5)}  p05 ${s.p05}  p50 ${s.p50}  p90 ${s.p90}  p99 ${s.p99}  ` +
        `minified ${s.minifiedPct}%  >2x ${s.over2xPct}%`,
    );
  }
  if (r.minify?.per?.length) {
    say('  per asset (p50 / p90):');
    for (const p of r.minify.per) say(`    ${p.id.padEnd(22)} ${String(p.p50).padStart(6)} / ${String(p.p90).padStart(6)}  n=${p.n}`);
  }
  if (r.errors.length) say(`  ERRORS: ${r.errors.slice(0, 3).join(' | ')}`);

  return { text: lines.join('\n'), totalVram: total };
}

async function main() {
  console.log('--- build -------------------------------------------------');
  await rm(OUT_DIR, { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build', '--outDir', '.probe-dist', '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (!existsSync(path.join(OUT_DIR, 'index.html'))) throw new Error('build produced no index.html');

  const server = spawn(
    process.execPath,
    ['-e', SERVE_SRC.replace('__DIR__', OUT_DIR.replace(/\\/g, '/')).replace('__PORT__', String(PORT))],
    { stdio: 'ignore' },
  );
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
      } catch {
        await sleep(200);
      }
    }
    const browser = await chromium.launch(
      SWIFT
        ? { headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--mute-audio'] }
        : { headless: false, args: ['--mute-audio'] },
    );
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runOnce(browser, `http://127.0.0.1:${PORT}/`, i));
    await browser.close();

    const { text } = summarise(runs);
    console.log('\n' + text);
    if (JSON_OUT) {
      await writeFile(JSON_OUT, JSON.stringify(runs, null, 1));
      console.log(`\nraw -> ${JSON_OUT}`);
    }
  } finally {
    server.kill();
    if (!has('keep')) await rm(OUT_DIR, { recursive: true, force: true });
  }
}

const SERVE_SRC = `
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const ROOT = '__DIR__';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png', '.ktx2':'image/ktx2', '.bin':'application/octet-stream' };
createServer(async (req,res)=>{
  try {
    const url = decodeURIComponent((req.url||'/').split('?')[0]);
    const rel = normalize(url).replace(/^[\\/\\\\]+/,'');
    const file = join(ROOT, rel === '' ? 'index.html' : rel);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
}).listen(__PORT__, '127.0.0.1');
`;

main().catch((e) => {
  console.error('\nPROBE FAILED:', e.message);
  process.exit(1);
});
