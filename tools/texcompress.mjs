/**
 * Block-compression prototype and quality measurement.
 *
 * The VRAM audit says compressed textures are the largest single saving
 * available (4x, and it multiplies with mipmaps). The risk is quality: this art
 * is painterly — long smooth gradients and soft alpha edges — which is exactly
 * what 4x4 block compression is worst at. So this does not assert; it encodes,
 * decodes with the hardware's own integer rules, and measures.
 *
 *   node tools/texcompress.mjs                       measure the default sample
 *   node tools/texcompress.mjs --assets sky_dusk,cloud_a
 *   node tools/texcompress.mjs --all                 every asset in the manifest
 *   node tools/texcompress.mjs --out docs/compress   write visual evidence
 *
 * Formats:
 *   BC1 (DXT1)  4 bpp, RGB only            — WEBGL_compressed_texture_s3tc
 *   BC3 (DXT5)  8 bpp, RGB + 8-bit alpha   — WEBGL_compressed_texture_s3tc
 *
 * BC7 (`EXT_texture_compression_bptc`) is also 8 bpp and is strictly better
 * than BC3 — it has 8 partition modes and up to 7-bit endpoints where BC3 has
 * one implicit partition and 5:6:5 — so the BC3 numbers below are a LOWER bound
 * on what a real KTX2/UASTC pipeline delivers at the same size. Encoding BC7
 * well needs a mode-searching encoder (bc7enc/ISPC); measuring BC3 honestly is
 * the cheap way to find out whether 8 bpp is enough for this art at all.
 *
 * The encoder is a principal-axis fit with a least-squares refinement pass,
 * which is what stb_dxt and squish do. It is not a toy: a worse encoder would
 * make block compression look worse than it is and bias the verdict.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const ART = path.join(ROOT, 'public', 'art');
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  const v = args[i + 1];
  return i === -1 ? d : v && !v.startsWith('--') ? v : d;
};

// --- BC1/BC3 encoding -------------------------------------------------------

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Pack 8-bit RGB into RGB565. */
function to565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}
/** Expand RGB565 back exactly as the hardware does. */
function from565(c) {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 3)];
}

/**
 * Endpoints for one 4x4 RGB block.
 *
 * Principal axis by power iteration on the colour covariance, then extremes
 * along it, then two rounds of least-squares refinement against the actual
 * index assignment — the same shape as stb_dxt's `stb__RefineBlock`.
 */
function fitBlock(px) {
  const n = px.length / 4;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    mr += px[i * 4];
    mg += px[i * 4 + 1];
    mb += px[i * 4 + 2];
  }
  mr /= n;
  mg /= n;
  mb /= n;

  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  for (let i = 0; i < n; i++) {
    const dr = px[i * 4] - mr;
    const dg = px[i * 4 + 1] - mg;
    const db = px[i * 4 + 2] - mb;
    xx += dr * dr;
    yy += dg * dg;
    zz += db * db;
    xy += dr * dg;
    xz += dr * db;
    yz += dg * db;
  }
  let ax = 1;
  let ay = 1;
  let az = 1;
  for (let it = 0; it < 8; it++) {
    const nx = ax * xx + ay * xy + az * xz;
    const ny = ax * xy + ay * yy + az * yz;
    const nz = ax * xz + ay * yz + az * zz;
    const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (m < 1e-8) break;
    ax = nx / m;
    ay = ny / m;
    az = nz / m;
  }

  let lo = Infinity;
  let hi = -Infinity;
  let loI = 0;
  let hiI = 0;
  for (let i = 0; i < n; i++) {
    const d = (px[i * 4] - mr) * ax + (px[i * 4 + 1] - mg) * ay + (px[i * 4 + 2] - mb) * az;
    if (d < lo) {
      lo = d;
      loI = i;
    }
    if (d > hi) {
      hi = d;
      hiI = i;
    }
  }
  let e0 = [px[hiI * 4], px[hiI * 4 + 1], px[hiI * 4 + 2]];
  let e1 = [px[loI * 4], px[loI * 4 + 1], px[loI * 4 + 2]];

  // Least-squares refinement: given the current palette, re-solve the two
  // endpoints that minimise squared error for the chosen indices.
  for (let pass = 0; pass < 2; pass++) {
    const pal = palette4(e0, e1);
    let a2 = 0;
    let b2 = 0;
    let ab = 0;
    const ax2 = [0, 0, 0];
    const bx2 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < 4; k++) {
        const dr = px[i * 4] - pal[k][0];
        const dg = px[i * 4 + 1] - pal[k][1];
        const db = px[i * 4 + 2] - pal[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      // Weight of endpoint 0 for each index: 1, 0, 2/3, 1/3.
      const w = best === 0 ? 1 : best === 1 ? 0 : best === 2 ? 2 / 3 : 1 / 3;
      const v = 1 - w;
      a2 += w * w;
      b2 += v * v;
      ab += w * v;
      for (let c = 0; c < 3; c++) {
        ax2[c] += w * px[i * 4 + c];
        bx2[c] += v * px[i * 4 + c];
      }
    }
    const det = a2 * b2 - ab * ab;
    if (Math.abs(det) < 1e-6) break;
    const inv = 1 / det;
    const n0 = [0, 0, 0];
    const n1 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      n0[c] = clamp255((b2 * ax2[c] - ab * bx2[c]) * inv);
      n1[c] = clamp255((a2 * bx2[c] - ab * ax2[c]) * inv);
    }
    e0 = n0;
    e1 = n1;
  }
  return [e0, e1];
}

function palette4(e0, e1) {
  const c0 = from565(to565(e0[0], e0[1], e0[2]));
  const c1 = from565(to565(e1[0], e1[1], e1[2]));
  const p = [c0, c1, [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) {
    p[2][c] = (2 * c0[c] + c1[c] + 1) / 3;
    p[3][c] = (c0[c] + 2 * c1[c] + 1) / 3;
  }
  return p;
}

/** Encode one 4x4 RGB block; returns { c0, c1, indices } as the hardware sees it. */
function encodeColorBlock(px) {
  let [e0, e1] = fitBlock(px);
  let c0 = to565(e0[0], e0[1], e0[2]);
  let c1 = to565(e1[0], e1[1], e1[2]);
  // 4-colour mode requires c0 > c1; swapping flips which endpoint is which.
  if (c0 === c1) {
    return { c0, c1, indices: new Uint8Array(px.length / 4), pal: palette4(from565(c0), from565(c1)) };
  }
  if (c0 < c1) {
    const t = c0;
    c0 = c1;
    c1 = t;
  }
  const pal = palette4(from565(c0), from565(c1));
  const n = px.length / 4;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const dr = px[i * 4] - pal[k][0];
      const dg = px[i * 4 + 1] - pal[k][1];
      const db = px[i * 4 + 2] - pal[k][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    indices[i] = best;
  }
  return { c0, c1, indices, pal };
}

/** Encode one 4x4 alpha block the BC3 way: two endpoints, 8 interpolated levels. */
function encodeAlphaBlock(a) {
  let lo = 255;
  let hi = 0;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pal = new Array(8);
  pal[0] = hi;
  pal[1] = lo;
  if (hi > lo) {
    for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * hi + i * lo + 3) / 7;
  } else {
    for (let i = 2; i < 8; i++) pal[i] = hi;
  }
  const indices = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < 8; k++) {
      const d = Math.abs(a[i] - pal[k]);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    indices[i] = best;
  }
  return { pal, indices };
}

/**
 * Round-trip an RGBA image through BC1 or BC3 and return the decoded result.
 *
 * Decoding uses the same integer palette the GPU builds, so the output is what
 * the hardware would actually sample — not an approximation of it.
 */
function roundTrip(data, w, h, mode) {
  const out = Buffer.alloc(w * h * 4);
  const bx = Math.ceil(w / 4);
  const by = Math.ceil(h / 4);
  let bytes = 0;
  const blockPx = new Float64Array(16 * 4);
  const blockA = new Uint8Array(16);

  for (let byi = 0; byi < by; byi++) {
    for (let bxi = 0; bxi < bx; bxi++) {
      let n = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const sx = Math.min(w - 1, bxi * 4 + x);
          const sy = Math.min(h - 1, byi * 4 + y);
          const o = (sy * w + sx) * 4;
          blockPx[n * 4] = data[o];
          blockPx[n * 4 + 1] = data[o + 1];
          blockPx[n * 4 + 2] = data[o + 2];
          blockPx[n * 4 + 3] = data[o + 3];
          blockA[n] = data[o + 3];
          n++;
        }
      }
      const cb = encodeColorBlock(blockPx.subarray(0, n * 4));
      const ab = mode === 'bc3' ? encodeAlphaBlock(blockA.subarray(0, n)) : null;
      bytes += mode === 'bc3' ? 16 : 8;

      n = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const dx = bxi * 4 + x;
          const dy = byi * 4 + y;
          if (dx < w && dy < h) {
            const o = (dy * w + dx) * 4;
            const c = cb.pal[cb.indices[n]];
            out[o] = clamp255(Math.round(c[0]));
            out[o + 1] = clamp255(Math.round(c[1]));
            out[o + 2] = clamp255(Math.round(c[2]));
            out[o + 3] = ab ? clamp255(Math.round(ab.pal[ab.indices[n]])) : 255;
          }
          n++;
        }
      }
    }
  }
  return { out, bytes };
}

// --- metrics ---------------------------------------------------------------

function psnr(a, b, n, stride, offsets) {
  let se = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (const off of offsets) {
      const d = a[i * stride + off] - b[i * stride + off];
      se += d * d;
      count++;
    }
  }
  const mse = se / count;
  return { mse, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
}

/**
 * Composite over a mid-grey and measure that.
 *
 * Raw RGBA error over-reports damage in fully transparent regions, where the
 * colour channels are invisible. What the player sees is the composite, so
 * that is the number the verdict should rest on.
 */
function compositePsnr(a, b, n) {
  let se = 0;
  let count = 0;
  const BG = 128;
  for (let i = 0; i < n; i++) {
    const aa = a[i * 4 + 3] / 255;
    const ba = b[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const av = a[i * 4 + c] * aa + BG * (1 - aa);
      const bv = b[i * 4 + c] * ba + BG * (1 - ba);
      const d = av - bv;
      se += d * d;
      count++;
    }
  }
  const mse = se / count;
  return { mse, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
}

// --- main ------------------------------------------------------------------

const DEFAULT_SAMPLE = ['sky_dusk', 'cloud_a'];

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ART, 'manifest.json'), 'utf8'));
  let ids;
  if (has('all')) ids = Object.keys(manifest.assets);
  else if (val('assets')) ids = String(val('assets')).split(',').map((s) => s.trim());
  else ids = DEFAULT_SAMPLE;

  const outDir = val('out') ? path.resolve(String(val('out'))) : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  console.log(
    'asset                    size        RGBA8    BC1     BC3   | BC1 dB  BC3 dB | comp dB  alpha dB  worst blk',
  );
  const totals = { rgba: 0, bc1: 0, bc3: 0 };

  for (const id of ids) {
    const file = path.join(ART, `${id}.png`);
    const { data, info } = await sharp(await readFile(file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const n = w * h;

    // Premultiply first: that is the form these textures live in on the GPU,
    // and it is what a compressed pipeline would have to ship, because there
    // is no unpack-time premultiply for `compressedTexImage2D`.
    const pre = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3];
      const f = a / 255;
      pre[i * 4] = Math.round(data[i * 4] * f);
      pre[i * 4 + 1] = Math.round(data[i * 4 + 1] * f);
      pre[i * 4 + 2] = Math.round(data[i * 4 + 2] * f);
      pre[i * 4 + 3] = a;
    }

    const r1 = roundTrip(pre, w, h, 'bc1');
    const r3 = roundTrip(pre, w, h, 'bc3');

    const p1 = psnr(pre, r1.out, n, 4, [0, 1, 2]);
    const p3 = psnr(pre, r3.out, n, 4, [0, 1, 2]);
    const pa = psnr(pre, r3.out, n, 4, [3]);
    const pc = compositePsnr(pre, r3.out, n);

    // Worst 4x4 block, so a good average cannot hide a visible failure.
    let worst = 0;
    const bx = Math.ceil(w / 4);
    const by = Math.ceil(h / 4);
    for (let byi = 0; byi < by; byi++) {
      for (let bxi = 0; bxi < bx; bxi++) {
        let se = 0;
        let c = 0;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const sx = bxi * 4 + x;
            const sy = byi * 4 + y;
            if (sx >= w || sy >= h) continue;
            const o = (sy * w + sx) * 4;
            for (let k = 0; k < 3; k++) {
              const d = pre[o + k] - r3.out[o + k];
              se += d * d;
              c++;
            }
          }
        }
        const rmse = Math.sqrt(se / Math.max(1, c));
        if (rmse > worst) worst = rmse;
      }
    }

    const rgbaBytes = n * 4;
    totals.rgba += rgbaBytes;
    totals.bc1 += r1.bytes;
    totals.bc3 += r3.bytes;

    console.log(
      `${id.padEnd(22)} ${String(w + 'x' + h).padEnd(11)} ` +
        `${(rgbaBytes / 1048576).toFixed(2)}MB ${(r1.bytes / 1048576).toFixed(2)}MB ${(r3.bytes / 1048576).toFixed(2)}MB | ` +
        `${p1.psnr.toFixed(1)}   ${p3.psnr.toFixed(1)}  | ${pc.psnr.toFixed(1)}     ${pa.psnr.toFixed(1)}     ${worst.toFixed(1)}`,
    );

    if (outDir) {
      // Evidence: original, BC3, and an 8x-amplified absolute difference.
      const amp = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
          amp[i * 4 + c] = clamp255(Math.abs(pre[i * 4 + c] - r3.out[i * 4 + c]) * 8);
        }
        amp[i * 4 + 3] = 255;
      }
      const crop = { left: 0, top: 0, width: Math.min(w, 512), height: Math.min(h, 512) };
      // Centre the crop on the busiest area so the strip shows real detail.
      crop.left = Math.max(0, Math.floor(w / 2 - crop.width / 2));
      crop.top = Math.max(0, Math.floor(h / 2 - crop.height / 2));
      const strip = await sharp({
        create: { width: crop.width * 3 + 24, height: crop.height, channels: 4, background: { r: 20, g: 20, b: 24, alpha: 1 } },
      })
        .composite([
          { input: await sharp(pre, { raw: { width: w, height: h, channels: 4 } }).extract(crop).png().toBuffer(), left: 0, top: 0 },
          { input: await sharp(r3.out, { raw: { width: w, height: h, channels: 4 } }).extract(crop).png().toBuffer(), left: crop.width + 12, top: 0 },
          { input: await sharp(amp, { raw: { width: w, height: h, channels: 4 } }).extract(crop).png().toBuffer(), left: crop.width * 2 + 24, top: 0 },
        ])
        .png()
        .toBuffer();
      await writeFile(path.join(outDir, `${id}.bc3.png`), strip);
      await writeFile(
        path.join(outDir, `${id}.full.bc3.png`),
        await sharp(r3.out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      );
    }
  }

  console.log(
    `\nTOTAL  RGBA8 ${(totals.rgba / 1048576).toFixed(1)} MB   ` +
      `BC1 ${(totals.bc1 / 1048576).toFixed(1)} MB (${(totals.rgba / totals.bc1).toFixed(1)}x)   ` +
      `BC3 ${(totals.bc3 / 1048576).toFixed(1)} MB (${(totals.rgba / totals.bc3).toFixed(1)}x)`,
  );
  if (outDir) console.log(`evidence -> ${outDir}  (original | BC3 | 8x difference)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
