/**
 * Rectangle packing, shared by both atlases.
 *
 * There are two texture systems in this engine — `atlas.ts` bakes procedural
 * art (glyphs, UI, particles) and `assets.ts` packs the painted PNGs — and they
 * had grown two different packers. The painted one had already been rewritten
 * to a skyline packer after shelf packing was measured wasting 77% of an
 * 8192x8192 page; the procedural one was still shelf-packing into a square
 * power of two. Same algorithm, same failure mode, one copy.
 *
 * Nothing in here knows about textures, mips or canvases: it places rectangles
 * in a box. Callers decide what a rectangle means and how big the box is.
 */

/**
 * Skyline bottom-left packer.
 *
 * Keeps the upper contour of the packed region as a run-length skyline and
 * puts each rectangle at the lowest position it fits, breaking ties leftward.
 * That beats shelf packing by a wide margin on mixed sizes — a shelf is as tall
 * as its tallest member, which is exactly the case shelves handle worst
 * (measured: 23% -> 88% occupancy on the painted set's 36 sprites, 420-px
 * blocks next to 1100-px trees).
 */
export class SkylinePacker {
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
