/**
 * Small, fast, seedable PRNG (mulberry32).
 *
 * Deterministic seeding matters here for two reasons: the capture harness must
 * be able to replay an identical run for A/B comparison, and procedural art
 * must bake identically every boot.
 */
export class Rng {
  private s: number;

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  /** 0..1 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** min..max */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** In-place Fisher-Yates. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Signed noise, -1..1 */
  signed(): number {
    return this.next() * 2 - 1;
  }
}

export const rng = new Rng();
