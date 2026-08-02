/**
 * Generated-asset loader.
 *
 * Art produced by tools/genart.mjs is described by public/art/manifest.json.
 * Small sprites (props, blocks, the hero) are packed into a shared atlas so
 * they cost no extra draw calls; large full-width layers (sky, mountain range,
 * ground slab) are kept as standalone textures because atlasing them would
 * force a huge texture for no benefit — each is drawn a handful of times per
 * frame anyway.
 *
 * The whole path is optional: if the manifest is missing or a fetch fails, the
 * game falls back to its procedural art and still runs. That keeps the build
 * playable while art is still being generated.
 */

import type { Frame } from './gl';
import { Atlas } from './atlas';

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

/**
 * Sprites at or below this size get packed into the shared atlas.
 *
 * Set high enough to swallow the tall tree assets (~733x1100). They are the
 * only vertical mass in the backdrop, and leaving them out of the atlas made
 * each one cost a whole draw call, which is why the world composition stayed
 * flat and horizontal. One 4096 atlas holds the trees, the props, the blocks
 * and the whole hero set together.
 */
const ATLAS_MAX_DIM = 1200;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function textureFromImage(gl: WebGL2RenderingContext, img: HTMLImageElement): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  return tex;
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
  atlasSize = 0;
  standaloneTextures = 0;
  loadMs = 0;

  private atlas: Atlas | null = null;

  async load(gl: WebGL2RenderingContext, base = 'art/', bakeScale = 1): Promise<void> {
    const t0 = performance.now();
    let manifest: Manifest | null = null;
    try {
      const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      if (res.ok) manifest = (await res.json()) as Manifest;
    } catch {
      /* no generated art yet — procedural fallback stays in play */
    }
    if (!manifest?.assets || !Object.keys(manifest.assets).length) {
      this.loadMs = performance.now() - t0;
      return;
    }

    const specs = Object.values(manifest.assets);
    const images = await Promise.all(specs.map((s) => loadImage(`${base}${s.id}.png`)));

    const small: { spec: GeneratedAsset; img: HTMLImageElement }[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const img = images[i];
      if (!img) {
        this.failedCount++;
        continue;
      }
      this.loadedCount++;
      const list = this.byGroup.get(spec.group) ?? [];
      list.push(spec.id);
      this.byGroup.set(spec.group, list);

      if (Math.max(img.width, img.height) <= ATLAS_MAX_DIM) {
        small.push({ spec, img });
      } else {
        const tex = textureFromImage(gl, img);
        this.standaloneTextures++;
        this.frames.set(spec.id, {
          tex,
          u0: 0,
          v0: 0,
          u1: 1,
          v1: 1,
          w: img.width,
          h: img.height,
          px: 0.5,
          py: 0.5,
        });
      }
    }

    if (small.length) {
      const atlas = new Atlas();
      for (const { spec, img } of small) {
        atlas.add({
          name: spec.id,
          w: img.width,
          h: img.height,
          draw(ctx, w, h) {
            ctx.drawImage(img, 0, 0, w, h);
          },
        });
      }
      atlas.bake(gl, bakeScale);
      for (const { spec } of small) {
        if (atlas.has(spec.id)) this.frames.set(spec.id, atlas.get(spec.id));
      }
      this.atlas = atlas;
      this.atlasSize = atlas.size;
    }

    this.ready = this.frames.size > 0;
    this.loadMs = performance.now() - t0;
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
