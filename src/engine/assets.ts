/**
 * Generated-asset loader.
 *
 * Art produced by tools/genart.mjs is described by public/art/manifest.json.
 * Small sprites (props, blocks, the hero) are packed into shared atlas pages so
 * they cost no extra draw calls; large full-width layers (sky, mountain range,
 * ground slab) are kept as standalone textures because atlasing them would
 * force a huge texture for no benefit — each is drawn a handful of times per
 * frame anyway.
 *
 * The whole path is optional: if the manifest is missing or a fetch fails, the
 * game falls back to its procedural art and still runs. That keeps the build
 * playable while art is still being generated.
 *
 * Three things here are load-bearing for memory and boot time, and each was
 * measured (see docs/ASSET-AUDIT.md):
 *
 *   Decode off the main thread. `fetch` -> `Blob` -> `createImageBitmap` puts
 *   PNG decode on a worker thread and hands GL a ready surface. The old path
 *   set `img.src` and uploaded the `HTMLImageElement`, which made the *driver*
 *   decode inside `texImage2D` — one 1536x1024 sky measured 490 ms of blocked
 *   main thread in a single call.
 *
 *   Pack tight, and never into a canvas. Placements go straight to GPU with
 *   `texStorage2D` + one `texSubImage2D` per sprite, so no 2D canvas backing
 *   store is ever allocated. The old path packed via `Atlas`, whose square
 *   power-of-two growth put 15.5 Mpx of sprite into an 8192x8192 texture — 256
 *   MB of VRAM at 23% occupancy, plus an equal-sized canvas in system RAM.
 *
 *   Mipmaps, safely. Painted sprites are minified in the real frame (p50 1.4,
 *   p90 4.0 texels per device pixel), so `LINEAR` alone is point-sampling one
 *   texel in sixteen: aliasing plus a thrashed texture cache. Every placement
 *   is aligned to a `MIP_ALIGN`-texel grid and separated by at least that much
 *   gutter, which makes each texel of mip level `MIP_LEVELS-1` belong to
 *   exactly one sprite. That is what makes atlas mipmapping bleed-free rather
 *   than merely usually-fine.
 */

import type { Frame } from './gl';

export interface GeneratedAsset {
  id: string;
  group: string;
  w: number;
  h: number;
  opaque?: boolean;
  coverage?: number;
}

interface Manifest {
  generatedAt: string;
  assets: Record<string, GeneratedAsset>;
}

/** Per-phase cost of a load, in ms, for the perf HUD and tools/assetprobe.mjs. */
export interface AssetLoadStats {
  /** Wall time from first request to last byte of the wave. */
  fetchMs: number;
  /** Summed `createImageBitmap` time (off-thread; overlaps fetch). */
  decodeMs: number;
  /** Packing the atlas pages — pure arithmetic, no pixels touched. */
  packMs: number;
  /** `texStorage2D` + `texSubImage2D` + `generateMipmap`. */
  uploadMs: number;
  totalMs: number;
  /** Bytes of PNG pulled over the wire. */
  bytes: number;
  /** GPU bytes committed, mip levels included. */
  vramBytes: number;
  pages: { w: number; h: number; sprites: number; occupancy: number }[];
  standalone: number;
}

/**
 * Sprites at or below this size get packed into a shared atlas page.
 *
 * Set high enough to swallow the tall tree assets (~733x1100). They are the
 * only vertical mass in the backdrop, and leaving them out of the atlas made
 * each one cost a whole draw call, which is why the world composition stayed
 * flat and horizontal.
 */
const ATLAS_MAX_DIM = 1200;

/**
 * Widest atlas page.
 *
 * Not the GPU's maximum. 4096 is the floor every WebGL2 device guarantees, and
 * a page wider than the art needs only buys fragmentation. Height floats: the
 * packer grows a page downward and then trims it to the last occupied row, so
 * a page costs its contents rather than the next power of two.
 */
const PAGE_W = 4096;
/** Tallest page before the packer starts a second one. */
const PAGE_H_MAX = 4096;

/**
 * Mip levels kept for atlas pages, and the alignment that makes them safe.
 *
 * `MIP_ALIGN` must be `2 ** (MIP_LEVELS - 1)`: at the deepest level one texel
 * covers exactly one aligned block, so it can never straddle two sprites.
 * Level 4 is 1/16 minification, comfortably past the measured p99 of 5x.
 */
const MIP_LEVELS = 5;
const MIP_ALIGN = 1 << (MIP_LEVELS - 1);

/**
 * Mipmapping is built, measured and OFF by default. `?mips=1` turns it on.
 *
 * It is the correct thing for the atlas — 75% of painted draws are minified,
 * p90 at 4.6 texels per device pixel — and switching it on visibly settles the
 * crawling foliage. But it also costs a third more VRAM and moves 18% of the
 * pixels in every golden frame, which is a look change, not a bug fix, and not
 * one to make silently. It becomes free to turn on the day block compression
 * lands: BC7 pays for the whole mip chain four times over.
 *
 * The layout is kept mip-ready either way — the alignment and gutters below
 * cost about 3% of a page — so enabling it is a one-line change, not a repack.
 */
const MIPS_ON =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('mips') === '1';

/**
 * The wide standalone layers (sky, mountains, ground) are drawn at or above
 * 1:1 — they are magnified, not minified — so a mip chain on them is 21 MB of
 * VRAM that is never sampled. Measured p50 minification for those textures is
 * 0.6; for the atlas it is 1.4.
 */
const MIP_STANDALONE = false;

/** Levels to allocate for a texture, honouring the flags above. */
function mipLevelsFor(w: number, h: number, atlas: boolean): number {
  if (!MIPS_ON) return 1;
  if (!atlas && !MIP_STANDALONE) return 1;
  return atlas ? MIP_LEVELS : Math.floor(Math.log2(Math.max(w, h))) + 1;
}

/** GPU bytes for an RGBA8 texture including `levels` mip levels. */
function vramFor(w: number, h: number, levels: number): number {
  let bytes = 0;
  for (let i = 0; i < levels; i++) {
    bytes += Math.max(1, w >> i) * Math.max(1, h >> i) * 4;
  }
  return bytes;
}

type Decoded = { spec: GeneratedAsset; src: ImageBitmap | HTMLImageElement; w: number; h: number };

/**
 * Decode a PNG off the main thread.
 *
 * `createImageBitmap` from a Blob runs the decode on a worker thread and
 * returns a surface GL can upload without touching it again. Falls back to an
 * `<img>` on anything that lacks it, which keeps the loader working in odd
 * embedders at the old cost rather than failing.
 */
async function decode(url: string): Promise<{ src: ImageBitmap | HTMLImageElement; bytes: number; decodeMs: number } | null> {
  try {
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (typeof createImageBitmap === 'function') {
      const t = performance.now();
      // `colorSpaceConversion: 'default'`, NOT `'none'`. Several of these PNGs
      // carry a colour profile from the generator, and the old loader went
      // through an `<img>` and a 2D canvas, both of which colour-manage into
      // sRGB. Skipping that decodes the raw profile values instead and shifts
      // the whole frame — measured at a mean of 23/255 across the meadow shot,
      // which is a bleached sky, not a rounding difference.
      const bmp = await createImageBitmap(blob, {
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'default',
      });
      return { src: bmp, bytes: blob.size, decodeMs: performance.now() - t };
    }
    const objUrl = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = objUrl;
    });
    URL.revokeObjectURL(objUrl);
    return img ? { src: img, bytes: blob.size, decodeMs: 0 } : null;
  } catch {
    return null;
  }
}

interface Placement {
  d: Decoded;
  x: number;
  y: number;
}

interface Page {
  w: number;
  h: number;
  placements: Placement[];
  used: number;
}

/**
 * Skyline bottom-left packer.
 *
 * Keeps the upper contour of the packed region as a run-length skyline and
 * puts each rectangle at the lowest position it fits, breaking ties leftward.
 * That beats shelf packing by a wide margin on mixed sizes — a shelf is as tall
 * as its tallest member, and this art set is 420-px blocks next to 1100-px
 * trees, which is exactly the case shelves handle worst (measured: 23% -> 88%
 * occupancy on the same 36 sprites).
 *
 * Every placement is snapped to `MIP_ALIGN`, which both keeps mip levels
 * bleed-free and costs less than it sounds: the alignment slack is a few
 * percent of a page.
 */
class SkylinePacker {
  private nodes: { x: number; y: number; w: number }[];

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.nodes = [{ x: 0, y: 0, w }];
  }

  /** Lowest y at which `w` wide fits starting at node `i`, or -1. */
  private fitAt(i: number, w: number, h: number): number {
    const x = this.nodes[i].x;
    if (x + w > this.w) return -1;
    let y = this.nodes[i].y;
    let left = w;
    for (let j = i; left > 0; j++) {
      if (j >= this.nodes.length) return -1;
      if (this.nodes[j].y > y) y = this.nodes[j].y;
      if (y + h > this.h) return -1;
      left -= this.nodes[j].w;
    }
    return y;
  }

  /** Place a `w` x `h` rectangle, or return null if it does not fit. */
  add(w: number, h: number): { x: number; y: number } | null {
    let best = -1;
    let bestY = Infinity;
    let bestX = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const y = this.fitAt(i, w, h);
      if (y < 0) continue;
      if (y < bestY || (y === bestY && this.nodes[i].x < bestX)) {
        best = i;
        bestY = y;
        bestX = this.nodes[i].x;
      }
    }
    if (best < 0) return null;

    const node = { x: bestX, y: bestY + h, w };
    this.nodes.splice(best, 0, node);
    // Trim or drop the nodes this rectangle now covers.
    for (let i = best + 1; i < this.nodes.length; ) {
      const n = this.nodes[i];
      const prev = this.nodes[i - 1];
      if (n.x >= prev.x + prev.w) break;
      const shrink = prev.x + prev.w - n.x;
      if (n.w <= shrink) {
        this.nodes.splice(i, 1);
        continue;
      }
      n.x += shrink;
      n.w -= shrink;
      break;
    }
    // Merge neighbours at the same height.
    for (let i = 0; i < this.nodes.length - 1; ) {
      if (this.nodes[i].y === this.nodes[i + 1].y) {
        this.nodes[i].w += this.nodes[i + 1].w;
        this.nodes.splice(i + 1, 1);
        continue;
      }
      i++;
    }
    return { x: bestX, y: bestY };
  }

  /** Height actually reached, for trimming the page. */
  get top(): number {
    let t = 0;
    for (const n of this.nodes) if (n.y > t) t = n.y;
    return t;
  }
}

/** Reserved slot for a sprite: its pixels plus a mip-safe, mip-aligned gutter. */
function slotSize(d: Decoded): { w: number; h: number } {
  return {
    w: Math.ceil((d.w + MIP_ALIGN) / MIP_ALIGN) * MIP_ALIGN,
    h: Math.ceil((d.h + MIP_ALIGN) / MIP_ALIGN) * MIP_ALIGN,
  };
}

function packInto(items: Decoded[], w: number, h: number): { placements: Placement[]; used: number; top: number } | null {
  const packer = new SkylinePacker(w, h);
  const placements: Placement[] = [];
  let used = 0;
  for (const d of items) {
    const s = slotSize(d);
    const at = packer.add(s.w, s.h);
    if (!at) return null;
    placements.push({ d, x: at.x, y: at.y });
    used += d.w * d.h;
  }
  return { placements, used, top: packer.top };
}

/**
 * Pack every atlasable sprite into as few pages as will hold them, each page
 * no taller than it has to be.
 *
 * The page height is searched rather than doubled. A power-of-two page is a
 * WebGL1 habit; WebGL2 samples and mips a rectangular texture perfectly well,
 * and doubling is what turned 15.5 Mpx of art into a 67 Mpx texture. The search
 * starts from the area the sprites actually need and grows in MIP_ALIGN steps
 * until the skyline fits, so the page costs its contents plus the packer's
 * inefficiency and nothing else.
 */
function packPages(items: Decoded[]): Page[] {
  // Tallest first: the skyline is built from the bottom, and putting the big
  // pieces down while the contour is still flat is what keeps it flat.
  let pending = items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const pages: Page[] = [];

  while (pending.length) {
    const slotArea = pending.reduce((t, d) => {
      const s = slotSize(d);
      return t + s.w * s.h;
    }, 0);
    const tallest = pending.reduce((t, d) => Math.max(t, slotSize(d).h), 0);

    let fit: ReturnType<typeof packInto> = null;
    let h = 0;
    // Perfect packing is the lower bound; step up until the skyline agrees.
    const start = Math.max(tallest, Math.ceil(slotArea / PAGE_W));
    for (h = Math.ceil(start / MIP_ALIGN) * MIP_ALIGN; h <= PAGE_H_MAX; h += MIP_ALIGN * 8) {
      fit = packInto(pending, PAGE_W, h);
      if (fit) break;
    }

    if (fit) {
      const top = Math.max(MIP_ALIGN, Math.ceil(fit.top / MIP_ALIGN) * MIP_ALIGN);
      pages.push({ w: PAGE_W, h: top, placements: fit.placements, used: fit.used });
      break;
    }

    // Does not fit one page: fill a full-height page greedily and recurse.
    const packer = new SkylinePacker(PAGE_W, PAGE_H_MAX);
    const placements: Placement[] = [];
    const overflow: Decoded[] = [];
    let used = 0;
    for (const d of pending) {
      const s = slotSize(d);
      const at = packer.add(s.w, s.h);
      if (!at) {
        overflow.push(d);
        continue;
      }
      placements.push({ d, x: at.x, y: at.y });
      used += d.w * d.h;
    }
    if (!placements.length) break; // a single sprite wider than a page
    pages.push({
      w: PAGE_W,
      h: Math.max(MIP_ALIGN, Math.ceil(packer.top / MIP_ALIGN) * MIP_ALIGN),
      placements,
      used,
    });
    pending = overflow;
  }
  return pages;
}

export class AssetLibrary {
  /** Frames keyed by asset id (e.g. `tree_oak`). */
  readonly frames = new Map<string, Frame>();
  readonly byGroup = new Map<string, string[]>();
  /** True once at least one generated asset is available. */
  ready = false;
  /** Diagnostics surfaced to the perf HUD. */
  loadedCount = 0;
  failedCount = 0;
  /** Width of the first atlas page — kept for the existing HUD readout. */
  atlasSize = 0;
  standaloneTextures = 0;
  loadMs = 0;
  stats: AssetLoadStats | null = null;
  /** Every GPU texture this library owns, for teardown and VRAM accounting. */
  readonly textures: WebGLTexture[] = [];

  private manifest: Manifest | null = null;
  private base = 'art/';
  private gl: WebGL2RenderingContext | null = null;
  private pending: Promise<void> | null = null;
  private clearFbo: WebGLFramebuffer | null = null;

  /** Zero a whole texture level through an FBO clear. */
  private clearTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, w: number, h: number): void {
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    this.clearFbo ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.clearFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      // A wave loaded mid-game runs between frames, so every piece of global
      // state this touches is put back.
      const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
      const cc = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
      const scissor = gl.getParameter(gl.SCISSOR_TEST) as boolean;
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /**
   * Load the manifest and a wave of assets.
   *
   * `include` selects a subset by id — that is the hook per-theme streaming
   * hangs off. Omit it and everything loads, which is what boot does today.
   * `load` is additive and idempotent: ids already resident are skipped, so a
   * second call is exactly the incremental wave.
   */
  async load(
    gl: WebGL2RenderingContext,
    base = 'art/',
    _bakeScale = 1,
    include?: (spec: GeneratedAsset) => boolean,
  ): Promise<void> {
    const t0 = performance.now();
    this.gl = gl;
    this.base = base;

    if (!this.manifest) {
      try {
        const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
        if (res.ok) this.manifest = (await res.json()) as Manifest;
      } catch {
        /* no generated art yet — procedural fallback stays in play */
      }
    }
    const manifest = this.manifest;
    if (!manifest?.assets || !Object.keys(manifest.assets).length) {
      this.loadMs = performance.now() - t0;
      return;
    }

    const specs = Object.values(manifest.assets).filter(
      (s) => !this.frames.has(s.id) && (!include || include(s)),
    );
    if (!specs.length) {
      this.loadMs = performance.now() - t0;
      return;
    }

    // --- fetch + decode, all in flight at once -------------------------------
    const tFetch = performance.now();
    const results = await Promise.all(specs.map((s) => decode(`${base}${s.id}.png`)));
    const fetchMs = performance.now() - tFetch;

    let bytes = 0;
    let decodeMs = 0;
    const small: Decoded[] = [];
    const big: Decoded[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const r = results[i];
      if (!r) {
        this.failedCount++;
        continue;
      }
      this.loadedCount++;
      bytes += r.bytes;
      decodeMs += r.decodeMs;
      const list = this.byGroup.get(spec.group) ?? [];
      list.push(spec.id);
      this.byGroup.set(spec.group, list);

      const w = r.src.width;
      const h = r.src.height;
      (Math.max(w, h) <= ATLAS_MAX_DIM ? small : big).push({ spec, src: r.src, w, h });
    }

    // --- pack ---------------------------------------------------------------
    const tPack = performance.now();
    const pages = packPages(small);
    const packMs = performance.now() - tPack;

    // --- upload -------------------------------------------------------------
    const tUp = performance.now();
    let vramBytes = 0;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // An `ImageBitmap` built with `premultiplyAlpha: 'premultiply'` already
    // carries premultiplied colour; asking GL to do it again would darken every
    // soft edge. The `<img>` fallback carries straight alpha and does need it.
    const setUnpack = (src: ImageBitmap | HTMLImageElement) =>
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !('close' in src));

    const pageLevels = mipLevelsFor(PAGE_W, PAGE_H_MAX, true);

    for (const page of pages) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, pageLevels, gl.RGBA8, page.w, page.h);
      // `texStorage2D` leaves the store UNDEFINED, not zeroed. Level 0 is only
      // ever sampled inside a sprite, but `generateMipmap` averages the gutters
      // in — so whatever the driver left there would show up as fringing on
      // every minified sprite. Clearing through an FBO costs one clear per page
      // instead of a 64 MB zero buffer per page in system RAM.
      this.clearTexture(gl, tex, page.w, page.h);
      for (const pl of page.placements) {
        setUnpack(pl.d.src);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          pl.x,
          pl.y,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pl.d.src as TexImageSource,
        );
      }
      if (pageLevels > 1) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        pageLevels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(tex);
      vramBytes += vramFor(page.w, page.h, pageLevels);
      if (!this.atlasSize) this.atlasSize = page.w;

      for (const pl of page.placements) {
        // Half-texel inset puts the edge samples on texel centres.
        const inset = 0.5;
        this.frames.set(pl.d.spec.id, {
          tex,
          u0: (pl.x + inset) / page.w,
          v0: (pl.y + inset) / page.h,
          u1: (pl.x + pl.d.w - inset) / page.w,
          v1: (pl.y + pl.d.h - inset) / page.h,
          w: pl.d.w,
          h: pl.d.h,
          px: 0.5,
          py: 0.5,
        });
      }
    }

    for (const d of big) {
      const levels = mipLevelsFor(d.w, d.h, false);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, d.w, d.h);
      setUnpack(d.src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.src as TexImageSource);
      if (levels > 1) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(tex);
      this.standaloneTextures++;
      vramBytes += vramFor(d.w, d.h, levels);
      this.frames.set(d.spec.id, {
        tex,
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        w: d.w,
        h: d.h,
        px: 0.5,
        py: 0.5,
      });
    }

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    // The decoded surfaces are on the GPU now; let the decoder's memory go
    // rather than waiting for GC to notice several hundred MB of bitmaps.
    for (const d of small) if ('close' in d.src) d.src.close();
    for (const d of big) if ('close' in d.src) d.src.close();

    const uploadMs = performance.now() - tUp;

    this.ready = this.frames.size > 0;
    this.loadMs = performance.now() - t0;
    const prev = this.stats;
    this.stats = {
      fetchMs: Math.round(fetchMs),
      decodeMs: Math.round(decodeMs),
      packMs: Math.round(packMs),
      uploadMs: Math.round(uploadMs),
      totalMs: Math.round(this.loadMs),
      bytes: bytes + (prev?.bytes ?? 0),
      vramBytes: vramBytes + (prev?.vramBytes ?? 0),
      pages: [
        ...(prev?.pages ?? []),
        ...pages.map((p) => ({
          w: p.w,
          h: p.h,
          sprites: p.placements.length,
          occupancy: +(p.used / (p.w * p.h)).toFixed(3),
        })),
      ],
      standalone: this.standaloneTextures,
    };
  }

  /**
   * Load everything not already resident, once, in the background.
   *
   * Boot calls this after the first frame so the remaining themes arrive while
   * the player is reading the first word instead of before they see anything.
   * Repeated calls join the in-flight promise.
   */
  loadRest(): Promise<void> {
    if (!this.gl || !this.manifest) return Promise.resolve();
    if (this.pending) return this.pending;
    const p = this.load(this.gl, this.base).finally(() => {
      this.pending = null;
    });
    this.pending = p;
    return p;
  }

  /** Resolves when every manifest asset is resident. */
  whenComplete(): Promise<void> {
    return this.loadRest();
  }

  has(id: string): boolean {
    return this.frames.has(id);
  }

  /** Frame for `id`, or null when that asset has not been generated yet. */
  get(id: string): Frame | null {
    return this.frames.get(id) ?? null;
  }

  /** All ids in a group, e.g. every scatter prop. */
  group(name: string): string[] {
    return this.byGroup.get(name) ?? [];
  }
}
