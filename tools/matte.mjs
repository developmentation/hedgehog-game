/**
 * Chroma-key matting for generated art.
 *
 * gpt-image-2 has no transparent-background mode, so assets are generated on a
 * flat chroma field and keyed out here. A naive "distance to key colour"
 * threshold is not good enough — it eats magenta-ish pixels inside the artwork
 * and leaves a coloured fringe on every anti-aliased edge. This does it
 * properly:
 *
 *   1. keyness      - how close each pixel is to the key colour
 *   2. flood fill   - only key regions REACHABLE FROM THE BORDER become
 *                     background, so a violet flower in the middle of the art
 *                     survives even though it is near-magenta
 *   3. soft alpha   - inside the background region alpha ramps with distance,
 *                     preserving the generator's anti-aliasing
 *   4. colour unmix - F = (C - K(1-a)) / a removes key spill from edge pixels,
 *                     which is what kills the tell-tale magenta halo
 *   5. trim + pad   - crop to content so atlas packing is not paying for air
 */

import sharp from 'sharp';

export const KEY_MAGENTA = { r: 255, g: 0, b: 255 };

const hex = (c) =>
  [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** How far inside the silhouette the key halo can reach, in pixels. */
const DESPILL_RADIUS = 4;

/**
 * Suppress the key hue near the alpha edge.
 *
 * Hue-aware rather than a desaturation. The key colour is characterised by
 * which channels are simultaneously high:
 *
 *   green  (0,255,0)   - G high while R and B are low
 *   magenta(255,0,255) - R and B BOTH high while G is low
 *
 * For magenta the test is `min(R,B)`, which is what makes it safe: a warm
 * orange has a high R but a low B, so `min` stays low and the pixel is left
 * alone. Only a pixel that is high in *both* — actual magenta — gets pulled
 * back toward the green channel. The green case is the mirror image.
 *
 * Strength falls off with distance from the edge, so interior art is never
 * touched at all.
 */
function despill(px, W, H, key, radius) {
  const N = W * H;

  // Distance-to-edge via a cheap two-pass chamfer over "is near transparent".
  const dist = new Uint8Array(N);
  const FAR = 255;
  for (let i = 0; i < N; i++) dist[i] = px[i * 4 + 3] < 250 ? 0 : FAR;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      let m = dist[i];
      if (x > 0 && dist[i - 1] + 1 < m) m = dist[i - 1] + 1;
      if (y > 0 && dist[i - W] + 1 < m) m = dist[i - W] + 1;
      dist[i] = m;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      let m = dist[i];
      if (x < W - 1 && dist[i + 1] + 1 < m) m = dist[i + 1] + 1;
      if (y < H - 1 && dist[i + W] + 1 < m) m = dist[i + W] + 1;
      dist[i] = m;
    }
  }

  const greenKey = key.g > key.r && key.g > key.b;
  const magentaKey = key.r > key.g && key.b > key.g;
  if (!greenKey && !magentaKey) return;

  for (let i = 0; i < N; i++) {
    const q = i * 4;
    if (px[q + 3] === 0) continue;
    const d = dist[i];
    if (d >= radius) continue;
    // Full strength at the outline, tapering to nothing `radius` px inside.
    const w = 1 - d / radius;

    const r = px[q];
    const g = px[q + 1];
    const b = px[q + 2];

    if (greenKey) {
      const ceiling = (r + b) * 0.5;
      if (g > ceiling) px[q + 1] = g - (g - ceiling) * w;
    } else {
      const m = r < b ? r : b; // both must be high for this to be magenta
      if (m > g) {
        const excess = (m - g) * w;
        px[q] = r - excess;
        px[q + 2] = b - excess;
      }
    }
  }
}

/**
 * Measure the colour the generator actually painted the background.
 *
 * Samples a ring of border pixels and takes the per-channel median. The median
 * is deliberate: it ignores the minority of border pixels where the subject
 * touches the frame edge, which a mean would smear into the result.
 */
function detectKey(data, W, H, channels) {
  const rs = [];
  const gs = [];
  const bs = [];
  const push = (x, y) => {
    const o = (y * W + x) * channels;
    rs.push(data[o]);
    gs.push(data[o + 1]);
    bs.push(data[o + 2]);
  };
  const stepX = Math.max(1, Math.floor(W / 128));
  const stepY = Math.max(1, Math.floor(H / 128));
  for (let x = 0; x < W; x += stepX) {
    for (let d = 0; d < 3; d++) {
      push(x, d);
      push(x, H - 1 - d);
    }
  }
  for (let y = 0; y < H; y += stepY) {
    for (let d = 0; d < 3; d++) {
      push(d, y);
      push(W - 1 - d, y);
    }
  }
  if (!rs.length) return null;
  const med = (a) => {
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  return { r: med(rs), g: med(gs), b: med(bs) };
}

/**
 * @param {Buffer} inputBuffer PNG bytes
 * @param {object} opts
 * @param {{r:number,g:number,b:number}} [opts.key] chroma colour
 * @param {number} [opts.tolerance] distance at which a pixel is fully opaque
 * @param {number} [opts.seedKeyness] keyness required to seed the flood fill
 * @param {number} [opts.trimPad] transparent padding kept around content
 * @param {number} [opts.maxDim] longest edge after resize, 0 to keep source
 * @returns {Promise<{buffer:Buffer, width:number, height:number, trimmed:object, coverage:number}>}
 */
export async function matte(inputBuffer, opts = {}) {
  const {
    key: nominalKey = KEY_MAGENTA,
    tolerance = 120,
    seedKeyness = 0.62,
    trimPad = 2,
    maxDim = 0,
    /**
     * Keep the full source canvas instead of cropping to content.
     *
     * Animation frames MUST use this. Trimming each frame to its own content
     * box gives every frame a different size and origin, so playing them back
     * makes the character jitter and change scale. Keeping the shared canvas
     * preserves registration for free, because the generator drew each pose in
     * the same place.
     */
    trim = true,
    /**
     * When true, only key regions reachable from the image border are removed,
     * so near-key colours *inside* the artwork survive. Costs enclosed holes
     * (gaps between branches stay filled), so it is off by default: the
     * generation prompts forbid the key colour on the subject, which makes
     * global keying both safe and more correct.
     */
    preserveInterior = false,
  } = opts;

  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const N = W * H;

  // --- 0. recover the ACTUAL key colour -----------------------------------
  // The generator paints "pure chroma green" as something like #22DD22, not
  // literal #00FF00. Keying against the nominal hex leaves the background
  // half-opaque, so measure what was really painted: take the median border
  // pixel, and only trust it if it is recognisably the requested hue.
  const detected = detectKey(data, W, H, channels);
  let key = nominalKey;
  let keySource = 'nominal';
  if (detected) {
    const dr = detected.r - nominalKey.r;
    const dg = detected.g - nominalKey.g;
    const db = detected.b - nominalKey.b;
    const drift = Math.sqrt(dr * dr + dg * dg + db * db);
    // Accept a wide drift (the hue is right, the saturation/value is not) but
    // reject a border that is nothing like the requested key — that means the
    // generator ignored the instruction and we must not key blindly.
    if (drift < 220) {
      key = detected;
      keySource = drift > 12 ? `detected #${hex(detected)} drift ${Math.round(drift)}` : 'detected';
    } else {
      keySource = `nominal — border #${hex(detected)} drift ${Math.round(drift)} (suspect)`;
    }
  }

  // --- 1. keyness ---------------------------------------------------------
  // 1 = exactly the key colour, 0 = at least `tolerance` away from it.
  const keyness = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * channels;
    const dr = data[o] - key.r;
    const dg = data[o + 1] - key.g;
    const db = data[o + 2] - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    keyness[i] = Math.max(0, 1 - dist / tolerance);
  }

  // --- 2. decide which pixels the key is allowed to affect -----------------
  // Global by default: every pixel participates, so enclosed holes (the gaps
  // between branches, the space inside an archway) key out correctly.
  let influence;
  if (!preserveInterior) {
    influence = null; // null means "all pixels"
  } else {
    const isBg = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const pushIf = (idx) => {
      if (idx >= 0 && idx < N && !isBg[idx] && keyness[idx] >= seedKeyness) {
        isBg[idx] = 1;
        stack[sp++] = idx;
      }
    };
    for (let x = 0; x < W; x++) {
      pushIf(x);
      pushIf((H - 1) * W + x);
    }
    for (let y = 0; y < H; y++) {
      pushIf(y * W);
      pushIf(y * W + W - 1);
    }
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W;
      const y = (idx / W) | 0;
      if (x > 0) pushIf(idx - 1);
      if (x < W - 1) pushIf(idx + 1);
      if (y > 0) pushIf(idx - W);
      if (y < H - 1) pushIf(idx + W);
    }
    // Grow by one ring so anti-aliased edge pixels — which sit just below the
    // seed threshold — are matted rather than left opaque.
    influence = new Uint8Array(isBg);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (isBg[i]) continue;
        if (
          (x > 0 && isBg[i - 1]) ||
          (x < W - 1 && isBg[i + 1]) ||
          (y > 0 && isBg[i - W]) ||
          (y < H - 1 && isBg[i + W])
        ) {
          influence[i] = 1;
        }
      }
    }
  }

  // --- 3 & 4. alpha + colour unmixing -------------------------------------
  const out = Buffer.alloc(N * 4);
  let covered = 0;
  for (let i = 0; i < N; i++) {
    const o = i * channels;
    const q = i * 4;
    const srcA = channels === 4 ? data[o + 3] / 255 : 1;

    const keyed = !influence || influence[i];
    // Raw (unsnapped) alpha drives the colour unmix; snapping first would
    // leave spill baked into pixels that round up to fully opaque, which is
    // exactly what produces stray key-coloured specks inside the artwork.
    const aRaw = keyed ? 1 - keyness[i] : 1;

    let r = data[o];
    let g = data[o + 1];
    let b = data[o + 2];

    if (keyed && aRaw > 0.001 && keyness[i] > 0.015) {
      const inv = 1 / aRaw;
      r = (r - key.r * (1 - aRaw)) * inv;
      g = (g - key.g * (1 - aRaw)) * inv;
      b = (b - key.b * (1 - aRaw)) * inv;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
    }

    // Snap the extremes so flat background is exactly 0 and solid art is
    // exactly 1 — avoids a faint film across the whole sprite.
    let a = aRaw;
    if (a < 0.06) a = 0;
    else if (a > 0.9) a = 1;
    a *= srcA;

    out[q] = r;
    out[q + 1] = g;
    out[q + 2] = b;
    out[q + 3] = Math.round(a * 255);
    if (a > 0.02) covered++;
  }

  // --- 4b. edge despill ---------------------------------------------------
  //
  // Colour unmixing fixes pixels the key visibly bled into, but the generator
  // also paints a soft halo of key-tinted colour just INSIDE the subject's
  // outline — those pixels are fully opaque, so unmixing never touches them
  // and a green/magenta rim survives.
  //
  // Fix: find pixels near the alpha edge and suppress the key hue there,
  // weighted by how close to the edge they are. The suppression is hue-aware,
  // not a desaturation — it only pulls down the channel combination that the
  // key colour is made of, so genuine green foliage and warm amber survive
  // untouched. A blur would soften edges that are currently crisp; this keeps
  // them sharp and only corrects the colour.
  despill(out, W, H, key, DESPILL_RADIUS);

  // --- 5. trim to content -------------------------------------------------
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (out[(y * W + x) * 4 + 3] > 6) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // Nothing survived the key — return the original so the failure is visible
    // rather than silently producing an empty sprite.
    return {
      buffer: await sharp(inputBuffer).png().toBuffer(),
      width: W,
      height: H,
      trimmed: null,
      coverage: 0,
    };
  }

  if (!trim) {
    minX = 0;
    minY = 0;
    maxX = W - 1;
    maxY = H - 1;
  } else {
    minX = Math.max(0, minX - trimPad);
    minY = Math.max(0, minY - trimPad);
    maxX = Math.min(W - 1, maxX + trimPad);
    maxY = Math.min(H - 1, maxY + trimPad);
  }
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  let pipe = sharp(out, { raw: { width: W, height: H, channels: 4 } }).extract({
    left: minX,
    top: minY,
    width: cw,
    height: ch,
  });

  let outW = cw;
  let outH = ch;
  if (maxDim > 0 && Math.max(cw, ch) > maxDim) {
    const s = maxDim / Math.max(cw, ch);
    outW = Math.max(1, Math.round(cw * s));
    outH = Math.max(1, Math.round(ch * s));
    pipe = pipe.resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' });
  }

  const buffer = await pipe.png({ compressionLevel: 9, effort: 8 }).toBuffer();

  return {
    buffer,
    width: outW,
    height: outH,
    trimmed: { left: minX, top: minY, width: cw, height: ch, srcW: W, srcH: H },
    coverage: covered / N,
    key,
    keySource,
  };
}

// --- CLI ------------------------------------------------------------------
const { pathToFileURL } = await import('node:url');
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const args = process.argv.slice(2);
  const inPath = args[0];
  const outPath = args[1] ?? inPath.replace(/\.png$/, '.matted.png');
  if (!inPath) {
    console.error('usage: node tools/matte.mjs <in.png> [out.png] [--max 1024] [--tol 120]');
    process.exit(1);
  }
  const gi = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i === -1 ? d : Number(args[i + 1]);
  };
  const res = await matte(await readFile(inPath), {
    maxDim: gi('max', 0),
    tolerance: gi('tol', 120),
  });
  await writeFile(outPath, res.buffer);
  console.log(
    `${outPath}  ${res.width}x${res.height}  coverage ${(res.coverage * 100).toFixed(1)}%`,
  );
}
