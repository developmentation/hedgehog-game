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

interface Shelf {
  y: number;
  h: number;
  x: number;
}

const PAD = 4;

export class Atlas {
  readonly frames = new Map<string, Frame>();
  texture: WebGLTexture | null = null;
  size = 0;
  /** Bake resolution multiplier actually used. */
  bakeScale = 1;
  /** Diagnostic: fraction of atlas area occupied. */
  occupancy = 0;
  /** Kept for debug capture — the raw baked canvas. */
  canvas: HTMLCanvasElement | null = null;

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
    let size = 0;
    let placements: { p: Painter; x: number; y: number; w: number; h: number }[] = [];

    // Grow the atlas (or shrink the bake scale) until everything fits.
    for (;;) {
      const packed = this.tryPack(scale, maxTex);
      if (packed) {
        size = packed.size;
        placements = packed.placements;
        break;
      }
      scale *= 0.75;
      if (scale < 0.2) throw new Error('atlas: cannot fit art even at minimum scale');
    }

    this.bakeScale = scale;
    this.size = size;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!;
    ctx.clearRect(0, 0, size, size);

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
        u0: (pl.x + inset) / size,
        v0: (pl.y + inset) / size,
        u1: (pl.x + pl.w - inset) / size,
        v1: (pl.y + pl.h - inset) / size,
        w: pl.p.w,
        h: pl.p.h,
        px: pl.p.px ?? 0.5,
        py: pl.p.py ?? 0.5,
      });
    }
    this.occupancy = used / (size * size);
    this.canvas = canvas;

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

  private tryPack(
    scale: number,
    maxTex: number,
  ): { size: number; placements: { p: Painter; x: number; y: number; w: number; h: number }[] } | null {
    // Tallest-first shelf packing: good enough occupancy for a few hundred
    // sprites and far cheaper than a full bin-packer.
    const items = this.painters
      .map((p) => ({
        p,
        w: Math.ceil(p.w * scale) + PAD,
        h: Math.ceil(p.h * scale) + PAD,
      }))
      .sort((a, b) => b.h - a.h || b.w - a.w);

    let area = 0;
    let maxW = 0;
    for (const it of items) {
      area += it.w * it.h;
      if (it.w > maxW) maxW = it.w;
    }

    let size = 256;
    while (size < maxW || size * size < area * 1.35) size *= 2;

    for (; size <= maxTex; size *= 2) {
      const shelves: Shelf[] = [];
      const placements: { p: Painter; x: number; y: number; w: number; h: number }[] = [];
      let cursorY = 0;
      let ok = true;

      for (const it of items) {
        if (it.w > size) return null;
        let placed = false;
        for (const sh of shelves) {
          if (it.h <= sh.h && sh.x + it.w <= size) {
            placements.push({ p: it.p, x: sh.x, y: sh.y, w: it.w - PAD, h: it.h - PAD });
            sh.x += it.w;
            placed = true;
            break;
          }
        }
        if (!placed) {
          if (cursorY + it.h > size) {
            ok = false;
            break;
          }
          const sh: Shelf = { y: cursorY, h: it.h, x: it.w };
          shelves.push(sh);
          placements.push({ p: it.p, x: 0, y: cursorY, w: it.w - PAD, h: it.h - PAD });
          cursorY += it.h;
        }
      }
      if (ok) return { size, placements };
    }
    return null;
  }
}
