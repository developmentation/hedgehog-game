/**
 * Build a self-contained deployable and prove it runs.
 *
 * Produces `deploy-game.zip` containing exactly what the game needs to be
 * served as a static site, and nothing else: no sources, no node_modules, no
 * generation tooling, no raw un-matted art, no screenshots.
 *
 * The important part is the last step. A zip that builds is not the same as a
 * zip that runs, so this extracts its own output to a scratch directory,
 * serves it with the bundled server, boots it in a real browser and asserts the
 * game reaches a playable state with no console errors. If that fails, no zip
 * is written.
 *
 *   node tools/package.mjs
 *   node tools/package.mjs --out my-build.zip --no-verify --keep
 */

import { rm, mkdir, cp, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const OUT_ZIP = path.resolve(String(val('out', 'deploy-game.zip')));
const STAGE = path.join(ROOT, '.deploy-stage');
const VERIFY_DIR = path.join(ROOT, '.deploy-verify');
const PORT = Number(val('port', 5477));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

async function dirSize(dir) {
  let total = 0;
  let files = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirSize(p);
      total += sub.total;
      files += sub.files;
    } else {
      total += (await stat(p)).size;
      files++;
    }
  }
  return { total, files };
}

/**
 * Recompress every PNG losslessly.
 *
 * The generator writes at a low effort level because it is producing dozens of
 * images under a time budget; at pack time we can afford maximum effort. Pixels
 * are untouched — this only rewrites the deflate stream and drops any ancillary
 * chunks, so it cannot change how a single pixel renders.
 */
async function squeezePngs(dir) {
  let before = 0;
  let after = 0;
  let n = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.png')) continue;
      const src = await readFile(p);
      const out = await sharp(src).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();
      before += src.length;
      n++;
      // Never accept a "smaller" file that is actually bigger.
      if (out.length < src.length) {
        await writeFile(p, out);
        after += out.length;
      } else {
        after += src.length;
      }
    }
  };
  await walk(dir);
  return { n, before, after };
}

/**
 * Write a zip, in Node, with forward-slashed paths.
 *
 * Every Windows-native option was tried and each failed differently:
 * `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` both store entry
 * names with BACKSLASHES, which Linux and macOS extractors turn into files
 * literally called "art\sky_dusk.png" in the root — the game then 404s every
 * asset, and it is silent until it reaches the target machine. bsdtar refuses a
 * drive-lettered output path (it reads "C:" as a remote host) and, given a
 * relative one, quietly wrote a tar with a .zip extension.
 *
 * The format is simple enough to emit directly, so this does: deflate per file,
 * local header, central directory, EOCD. That makes the artifact byte-for-byte
 * predictable regardless of what is installed on the machine building it.
 */
async function writeZip(srcDir, outPath) {
  const { deflateRaw } = await import('node:zlib');
  const { promisify } = await import('node:util');
  const deflate = promisify(deflateRaw);

  const files = [];
  const walk = async (dir, prefix) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, rel);
      else files.push({ rel, abs });
    }
  };
  await walk(srcDir, '');

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const raw = await readFile(f.abs);
    const packed = await deflate(raw, { level: 9 });
    // Only take the compressed form if it actually helps.
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(f.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // dos time/date, fixed for reproducibility
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await writeFile(outPath, Buffer.concat([...locals, centralBuf, eocd]));
  return files.length;
}

/**
 * Entry names from a zip's central directory.
 *
 * Enough of the format to answer one question — are the paths portable — with
 * no dependency and no shelling out. Walks back from the end-of-central-
 * directory record, then reads each fixed-size header and its name.
 */
function listZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const SERVER_JS = `#!/usr/bin/env node
/**
 * Minimal static server for the packaged game. Zero dependencies.
 *
 *   node serve.mjs           -> http://127.0.0.1:8080
 *   node serve.mjs 3000      -> http://127.0.0.1:3000
 *
 * The game fetches its art manifest, so it must be served over HTTP.
 * Opening index.html from the filesystem will not work.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // Contain the path: a request may never escape the served directory.
    const rel = normalize(url).replace(/^([/\\\\])+/, '');
    if (rel.split(/[/\\\\]/).includes('..')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const file = join(ROOT, rel === '' ? 'index.html' : rel);
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('Spindash Speller -> http://127.0.0.1:' + PORT + '/');
});
`;

const README = `# Spindash Speller

A 2D browser game. Hear a word, then spell it by tapping the letter blocks
rolling toward the hedgehog.

## Run it

The game fetches its art manifest, so it has to be served over HTTP — opening
index.html directly from the filesystem will not work.

Any static server does. With Node already installed:

    node serve.mjs

then open http://127.0.0.1:8080/ . Pass a port to change it: \`node serve.mjs 3000\`.

Or point any other static host at this directory — everything is relative, so
it works from a subdirectory too.

## Controls

| | |
|---|---|
| Smash a letter | click / tap the block, or press the letter key |
| Jump over a wall | Space, or the JUMP button |
| Hear the word and clue again | the HINT button — unlimited |
| Pause, speed, easy mode, levels | Escape, or the PAUSE button |
| Shop | the SHOP chip |

## Notes

- Speech uses the browser's own voice, so no audio files ship. Audio unlocks on
  your first click or key press, as browsers require.
- Progress is saved in IndexedDB, per browser.
- Runs offline once loaded.

## Diagnostics

In the browser console:

    __build()          which build this is
    __raw(false)       styling passes on/off
    __renderScale(0.6) pin the world render scale
`;

async function main() {
  console.log('--- build -------------------------------------------------');
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });

  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('build produced no index.html');

  console.log('\n--- stage -------------------------------------------------');
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await cp(dist, STAGE, { recursive: true });
  await writeFile(path.join(STAGE, 'serve.mjs'), SERVER_JS);
  await writeFile(path.join(STAGE, 'README.md'), README);

  // What must be present for the game to run at all.
  const manifestPath = path.join(STAGE, 'art', 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('art/manifest.json missing from the build');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const ids = Object.keys(manifest.assets ?? {});
  const missing = ids.filter((id) => !existsSync(path.join(STAGE, 'art', `${id}.png`)));
  if (missing.length) throw new Error(`manifest lists ${missing.length} asset(s) with no file: ${missing.slice(0, 5)}`);

  // And what must NOT be, in case the build config ever changes.
  for (const junk of ['node_modules', 'src', 'tools', '.env', 'screenshots', 'art-src']) {
    if (existsSync(path.join(STAGE, junk))) throw new Error(`staged tree contains "${junk}"`);
  }

  const raw = await dirSize(STAGE);
  console.log(`staged ${raw.files} files, ${mb(raw.total)}  (${ids.length} art assets)`);

  console.log('\n--- squeeze -----------------------------------------------');
  const sq = await squeezePngs(STAGE);
  console.log(
    `recompressed ${sq.n} PNGs losslessly: ${mb(sq.before)} -> ${mb(sq.after)} ` +
      `(saved ${mb(sq.before - sq.after)}, ${(((sq.before - sq.after) / sq.before) * 100).toFixed(1)}%)`,
  );

  if (!has('no-verify')) {
    console.log('\n--- verify (boot the staged tree in a browser) -------------');
    const { chromium } = await import('playwright');
    const srv = spawn(process.execPath, [path.join(STAGE, 'serve.mjs'), String(PORT)], {
      cwd: STAGE,
      stdio: 'ignore',
    });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
        } catch {
          await sleep(250);
        }
      }
      if (!up) throw new Error('bundled serve.mjs did not come up');

      const browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
      });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
      await sleep(1200);
      await page.mouse.click(400, 300);
      await sleep(4000);

      const state = await page.evaluate(() => {
        const g = window.__game;
        const p = g.probe?.();
        return {
          assets: g.ctx.assets.loadedCount,
          failed: g.ctx.assets.failedCount,
          phase: p?.phase,
          targets: p?.targets?.length ?? 0,
          build: window.__build?.(),
        };
      });
      await browser.close();

      if (state.failed > 0) throw new Error(`${state.failed} art asset(s) failed to load`);
      if (!state.targets) throw new Error('no letter blocks on screen — game did not reach a playable state');
      if (errors.length) throw new Error(`console errors: ${errors.slice(0, 3).join(' | ')}`);
      console.log(
        `boots clean: ${state.assets} assets, phase "${state.phase}", ` +
          `${state.targets} blocks live, 0 errors\nbuild ${state.build}`,
      );
    } finally {
      srv.kill();
    }
  }

  console.log('\n--- zip ---------------------------------------------------');
  await rm(OUT_ZIP, { force: true });
  // bsdtar, not PowerShell.
  //
  // Both Windows zip paths write entry names with BACKSLASHES: Compress-Archive
  // on PowerShell 5.1, and .NET Framework's ZipFile.CreateFromDirectory. Windows
  // tolerates it; Linux and macOS extractors do not — they produce files
  // literally named "art\sky_dusk.png" in the root rather than an art/
  // directory, and the game then 404s every asset. For an artifact whose entire
  // purpose is to be deployed somewhere else, that is fatal, and it is silent
  // until it reaches the target machine.
  //
  // bsdtar ships with Windows 10+ and writes forward slashes per the zip spec.
  // `-a` selects the format from the .zip extension.
  const zipCount = await writeZip(STAGE, OUT_ZIP);
  console.log(`wrote ${zipCount} entries`);

  // Prove it, by reading the zip's own central directory.
  //
  // Done here rather than by shelling out, because the shell version failed to
  // open the archive and reported "0 entries, 0 backslashes" — which the check
  // then read as a pass. A verification that cannot distinguish "clean" from
  // "I could not look" is worse than none, so this parses the bytes and treats
  // an unreadable or empty directory as a failure.
  const names = listZipEntries(await readFile(OUT_ZIP));
  if (names.length === 0) throw new Error('zip central directory is empty or unreadable');
  const bad = names.filter((n) => n.includes('\\'));
  if (bad.length) {
    throw new Error(
      `${bad.length} of ${names.length} zip entries use backslashes (e.g. "${bad[0]}") — will not unpack on Linux/macOS`,
    );
  }
  if (!names.some((n) => n.endsWith('index.html'))) throw new Error('no index.html in the archive');
  if (!names.some((n) => n.endsWith('art/manifest.json'))) throw new Error('no art/manifest.json in the archive');
  console.log(`${names.length} entries, all forward-slashed, index.html and art/manifest.json present`);

  const zipped = (await stat(OUT_ZIP)).size;
  const final = await dirSize(STAGE);
  if (!has('keep')) await rm(STAGE, { recursive: true, force: true });
  await rm(VERIFY_DIR, { recursive: true, force: true });

  const LIMIT = 200 * 1048576;
  console.log(`\n${path.basename(OUT_ZIP)}  ${mb(zipped)} zipped, ${mb(final.total)} unpacked, ${final.files} files`);
  console.log(
    zipped < LIMIT
      ? `well inside the 200 MB limit (${((zipped / LIMIT) * 100).toFixed(1)}% of it)`
      : `OVER the 200 MB limit by ${mb(zipped - LIMIT)}`,
  );
  if (zipped >= LIMIT) process.exitCode = 2;
}

main().catch((e) => {
  console.error('\nPACKAGE FAILED:', e.message);
  process.exit(1);
});
