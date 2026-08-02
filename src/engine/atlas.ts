/**
 * Procedural texture atlas.
 *
 * All art in this game is authored as code: each sprite is a `Painter` that
 * draws into an offscreen 2D canvas at boot. The atlas shelf-packs every
 * painter into one power-of-two texture so the whole game renders from a
 * single GPU texture binding.
 *
 * Authoring in code (rather than shipping PNGs) keeps the download at zero
 * bytes of art, lets sprites be re-baked at the device's pixel density, and
 * means every asset is original by construction.
 */

import type { Frame } from './gl';
import { SkylinePacker } from './pack';

export interface Painter {
  /** Unique frame name, e.g. `hedgehog/roll_03`. */
  name: string;
  /** Art-unit width (world units at 1x). */
  w: number;
  /** Art-unit height. */
  h: number;
  /** Normalised pivot within the frame. Defaults to centre. */
  px?: number;
  py?: number;
  /**
   * Draw the sprite. The context is pre-scaled so that (0,0)..(w,h) in art
   * units maps onto the allocated region — draw in art units and ignore the
   * bake resolution entirely.
   */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

const PAD = 4;

export class Atlas {
  readonly frames = new Map<string, Frame>();
  texture: WebGLTexture | null = null;
  size = 0;
  /** Packed page dimensions. The page is rectangular, not a square pow2. */
  width = 0;
  height = 0;
  /** Bake resolution multiplier actually used. */
  bakeScale = 1;
  /** Diagnostic: fraction of atlas area occupied. */
  occupancy = 0;

  /**
   * The bake canvas is NOT kept.
   *
   * It used to be held in a `canvas` field "for debug capture", and nothing in
   * the game or the tools ever read it. A 2D canvas' backing store is four
   * bytes per pixel of system RAM for as long as the reference lives, and this
   * one is the full atlas: 16 MB at dpr 1, and 64 MB at dpr 2, which is every
   * phone. It stayed resident for the life of the process to serve a debug
   * path that did not exist.
   *
   * Anything that wants the baked sheet can read it back off the GPU, which
   * costs a stall once rather than tens of megabytes forever.
   */

  private painters: Painter[] = [];

  add(p: Painter): void {
    this.painters.push(p);
  }

  addAll(ps: Painter[]): void {
    for (const p of ps) this.painters.push(p);
  }

  has(name: string): boolean {
    return this.frames.has(name);
  }

  get(name: string): Frame {
    const f = this.frames.get(name);
    if (!f) throw new Error(`atlas: missing frame "${name}"`);
    return f;
  }

  /** Frames whose name starts with `prefix`, in insertion order. */
  sequence(prefix: string): Frame[] {
    const out: Frame[] = [];
    for (const [name, f] of this.frames) if (name.startsWith(prefix)) out.push(f);
    if (out.length === 0) throw new Error(`atlas: no frames matching "${prefix}"`);
    return out;
  }

  /**
   * Bake every registered painter into one texture.
   * `bakeScale` trades atlas memory for crispness; it is clamped so the atlas
   * never exceeds the GPU's max texture size.
   */
  bake(gl: WebGL2RenderingContext, bakeScale: number): void {
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    let scale = bakeScale;
    let pw = 0;
    let ph = 0;
    let placements: { p: Painter; x: number; y: number; w: number; h: number }[] = [];

    // Grow the atlas (or shrink the bake scale) until everything fits.
    for (;;) {
      const packed = this.tryPack(scale, maxTex);
      if (packed) {
        pw = packed.w;
        ph = packed.h;
        placements = packed.placements;
        break;
      }
      scale *= 0.75;
      if (scale < 0.2) throw new Error('atlas: cannot fit art even at minimum scale');
    }

    this.bakeScale = scale;
    this.width = pw;
    this.height = ph;
    this.size = Math.max(pw, ph);

    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!;
    ctx.clearRect(0, 0, pw, ph);

    let used = 0;
    for (const pl of placements) {
      ctx.save();
      // Clip so a painter that overdraws cannot corrupt its neighbours.
      ctx.beginPath();
      ctx.rect(pl.x, pl.y, pl.w, pl.h);
      ctx.clip();
      ctx.translate(pl.x, pl.y);
      ctx.scale(scale, scale);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      try {
        pl.p.draw(ctx, pl.p.w, pl.p.h);
      } catch (err) {
        console.error(`atlas: painter "${pl.p.name}" threw`, err);
      }
      ctx.restore();
      used += pl.w * pl.h;

      // Half-texel inset avoids sampling the padding gutter.
      const inset = 0.5;
      this.frames.set(pl.p.name, {
        tex: null as unknown as WebGLTexture, // patched below
        u0: (pl.x + inset) / pw,
        v0: (pl.y + inset) / ph,
        u1: (pl.x + pl.w - inset) / pw,
        v1: (pl.y + pl.h - inset) / ph,
        w: pl.p.w,
        h: pl.p.h,
        px: pl.p.px ?? 0.5,
        py: pl.p.py ?? 0.5,
      });
    }
    this.occupancy = used / (pw * ph);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    this.texture = tex;
    for (const f of this.frames.values()) f.tex = tex;
  }

  /**
   * Skyline-pack every painter into the smallest rectangle that holds them.
   *
   * This was tallest-first shelf packing into a square power of two, and both
   * halves of that were costing memory. Shelves are as tall as their tallest
   * member, and this set mixes 96-px glyphs with far taller UI pieces, so it
   * measured 53% occupancy. Rounding the result up to a square power of two
   * then paid for the waste twice: at dpr 2 the page was 4096x4096 = 64 MB of
   * RGBA8 to hold roughly 9 Mpx of art.
   *
   * Now it uses the same `SkylinePacker` as the painted atlas and trims the
   * page to the height actually reached, so the texture costs close to what the
   * art in it costs. Width is still capped at a power of two (and at the GPU's
   * limit) because it is the axis the packer searches along; height is whatever
   * the skyline ends up at, rounded to 4 so rows stay aligned.
   */
  private tryPack(
    scale: number,
    maxTex: number,
  ): { w: number; h: number; placements: { p: Painter; x: number; y: number; w: number; h: number }[] } | null {
    const items = this.painters
      .map((p) => ({
        p,
        w: Math.ceil(p.w * scale) + PAD,
        h: Math.ceil(p.h * scale) + PAD,
      }))
      // Tallest first: the skyline builds from the bottom, so placing the big
      // pieces while the contour is still flat is what keeps it flat.
      .sort((a, b) => b.h - a.h || b.w - a.w);

    let area = 0;
    let maxW = 0;
    for (const it of items) {
      area += it.w * it.h;
      if (it.w > maxW) maxW = it.w;
    }

    // Start from the width a perfect packing would need and step up. A wider
    // page is not automatically worse — it gives the packer more room to fill
    // low spots — so the first width that fits is taken rather than the
    // narrowest conceivable one.
    let w = 256;
    while (w < maxW || w * w < area) w *= 2;

    for (; w <= maxTex; w *= 2) {
      const packer = new SkylinePacker(w, maxTex);
      const placements: { p: Painter; x: number; y: number; w: number; h: number }[] = [];
      let ok = true;
      for (const it of items) {
        const at = packer.add(it.w, it.h);
        if (!at) {
          ok = false;
          break;
        }
        placements.push({ p: it.p, x: at.x, y: at.y, w: it.w - PAD, h: it.h - PAD });
      }
      if (ok) {
        const h = Math.min(maxTex, Math.ceil(packer.top / 4) * 4);
        return { w, h, placements };
      }
    }
    return null;
  }

}
