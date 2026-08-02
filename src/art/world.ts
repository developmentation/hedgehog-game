/**
 * Background and terrain art.
 *
 * STATUS: baseline pass. This module carries most of the visual-quality
 * burden and is the primary target of the art iteration loop.
 *
 * Everything here is authored to tile horizontally so the parallax system can
 * scroll infinitely by drawing a handful of repeats. Layer widths are chosen
 * so seams land on low-contrast parts of the silhouette.
 *
 * Frame contract:
 *   world/sky                     - 1px-wide vertical gradient, stretched
 *   world/hill_far/mid/near       - tileable parallax silhouettes
 *   world/ground                  - tileable ground slab
 *   world/grass_0..2              - foreground grass tufts
 *   world/tree_0..2               - midground trees
 *   world/cloud_0..2              - drifting clouds
 *   world/rock_0..1               - scatter props
 *   world/sun                     - low sun disc
 */

import type { Painter } from '../engine/atlas';
import { SKY, HILL_FAR, HILL_MID, HILL_NEAR, GRASS, SOIL, rampGradient, type Ramp } from './palette';

const TILE_W = 512;

/** Deterministic value noise so the silhouette bakes identically every boot. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function ridge(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  baseY: number,
  amp: number,
  octaves: number,
): void {
  ctx.beginPath();
  ctx.moveTo(0, h);
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let y = baseY;
    // Sum sine octaves whose periods divide the tile width exactly, so the
    // left and right edges always match and the tile repeats seamlessly.
    for (let o = 0; o < octaves; o++) {
      const freq = Math.pow(2, o + 1);
      const a = amp / Math.pow(1.9, o);
      y += Math.sin(t * Math.PI * 2 * freq + hash(seed + o) * 6.28) * a;
    }
    ctx.lineTo(t * w, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
}

function hillLayer(name: string, r: Ramp, seed: number, baseY: number, amp: number): Painter {
  return {
    name,
    w: TILE_W,
    h: 320,
    draw(ctx, w, h) {
      ridge(ctx, w, h, seed, baseY, amp, 3);
      ctx.fillStyle = rampGradient(ctx, r, 0, baseY - amp * 2, 0, h);
      ctx.fill();

      // Rim of light along the crest sells the low sun.
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = r.hi;
      ctx.lineWidth = 5;
      ridge(ctx, w, h, seed, baseY - 2, amp, 3);
      ctx.stroke();
      ctx.restore();
    },
  };
}

export function worldPainters(): Painter[] {
  const out: Painter[] = [];

  out.push({
    name: 'world/sky',
    w: 8,
    h: 512,
    draw(ctx, w, h) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, SKY.zenith);
      g.addColorStop(0.32, SKY.high);
      g.addColorStop(0.58, SKY.mid);
      g.addColorStop(0.82, SKY.low);
      g.addColorStop(1, SKY.horizon);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  });

  out.push({
    name: 'world/sun',
    w: 256,
    h: 256,
    draw(ctx, w, h) {
      const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.1, w / 2, h / 2, w * 0.5);
      g.addColorStop(0, 'rgba(255,241,206,0.95)');
      g.addColorStop(0.3, 'rgba(255,206,140,0.55)');
      g.addColorStop(1, 'rgba(255,180,110,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  });

  out.push(hillLayer('world/hill_far', HILL_FAR, 1, 150, 34));
  out.push(hillLayer('world/hill_mid', HILL_MID, 2, 190, 48));
  out.push(hillLayer('world/hill_near', HILL_NEAR, 3, 236, 30));

  out.push({
    name: 'world/ground',
    w: TILE_W,
    h: 224,
    draw(ctx, w, h) {
      // Soil slab.
      ctx.fillStyle = rampGradient(ctx, SOIL, 0, 0, 0, h);
      ctx.fillRect(0, 24, w, h - 24);

      // Grass cap with a slightly irregular top edge.
      ctx.beginPath();
      ctx.moveTo(0, 40);
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const y = 34 + Math.sin(t * Math.PI * 4) * 5 + Math.sin(t * Math.PI * 14) * 2.5;
        ctx.lineTo(t * w, y);
      }
      ctx.lineTo(w, 64);
      ctx.lineTo(0, 64);
      ctx.closePath();
      ctx.fillStyle = rampGradient(ctx, GRASS, 0, 24, 0, 74);
      ctx.fill();

      // Sparse soil speckle for texture.
      for (let i = 0; i < 90; i++) {
        const x = hash(i * 3.1) * w;
        const y = 80 + hash(i * 7.7) * (h - 96);
        ctx.globalAlpha = 0.18 + hash(i * 2.3) * 0.2;
        ctx.fillStyle = hash(i) > 0.5 ? SOIL.hi : SOIL.shade;
        ctx.beginPath();
        ctx.ellipse(x, y, 3 + hash(i * 5) * 6, 2 + hash(i * 9) * 3, hash(i * 4) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  });

  for (let i = 0; i < 3; i++) {
    out.push({
      name: `world/grass_${i}`,
      w: 96,
      h: 72,
      py: 1,
      draw(ctx, w, h) {
        ctx.strokeStyle = GRASS.light;
        ctx.lineCap = 'round';
        const blades = 6 + i * 2;
        for (let b = 0; b < blades; b++) {
          const x = (b / blades) * w + hash(b + i * 10) * 10;
          const lean = (hash(b * 3 + i) - 0.5) * 26;
          ctx.lineWidth = 2.5 + hash(b * 5) * 2;
          ctx.strokeStyle = b % 3 === 0 ? GRASS.hi : GRASS.light;
          ctx.beginPath();
          ctx.moveTo(x, h);
          ctx.quadraticCurveTo(x + lean * 0.4, h * 0.5, x + lean, h * 0.12);
          ctx.stroke();
        }
      },
    });
  }

  for (let i = 0; i < 3; i++) {
    out.push({
      name: `world/tree_${i}`,
      w: 220,
      h: 300,
      py: 1,
      draw(ctx, w, h) {
        const trunkW = w * 0.1;
        ctx.fillStyle = SOIL.shade;
        ctx.beginPath();
        ctx.moveTo(w / 2 - trunkW, h);
        ctx.quadraticCurveTo(w / 2 - trunkW * 0.5, h * 0.5, w / 2 - trunkW * 0.4, h * 0.34);
        ctx.lineTo(w / 2 + trunkW * 0.4, h * 0.34);
        ctx.quadraticCurveTo(w / 2 + trunkW * 0.5, h * 0.5, w / 2 + trunkW, h);
        ctx.closePath();
        ctx.fill();

        // Canopy as overlapping blobs — cheap, and reads well in silhouette.
        const blobs = 5 + i;
        for (let b = 0; b < blobs; b++) {
          const a = (b / blobs) * Math.PI * 2;
          const cx = w / 2 + Math.cos(a) * w * 0.24;
          const cy = h * 0.26 + Math.sin(a) * h * 0.13;
          const rr = w * (0.18 + hash(b + i * 5) * 0.09);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.fillStyle = b % 2 === 0 ? HILL_NEAR.base : HILL_NEAR.shade;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(w * 0.42, h * 0.2, w * 0.16, 0, Math.PI * 2);
        ctx.fillStyle = HILL_NEAR.light;
        ctx.globalAlpha = 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
      },
    });
  }

  for (let i = 0; i < 3; i++) {
    out.push({
      name: `world/cloud_${i}`,
      w: 340,
      h: 140,
      draw(ctx, w, h) {
        const puffs = 5 + i;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let p = 0; p < puffs; p++) {
          const t = p / (puffs - 1);
          const cx = w * (0.12 + t * 0.76);
          const cy = h * (0.6 - Math.sin(t * Math.PI) * 0.28);
          const rr = h * (0.2 + Math.sin(t * Math.PI) * 0.24);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });
  }

  for (let i = 0; i < 2; i++) {
    out.push({
      name: `world/rock_${i}`,
      w: 120,
      h: 84,
      py: 1,
      draw(ctx, w, h) {
        ctx.beginPath();
        const pts = 7;
        for (let p = 0; p < pts; p++) {
          const a = Math.PI + (p / (pts - 1)) * Math.PI;
          const rr = (0.42 + hash(p + i * 4) * 0.16) * w;
          const x = w / 2 + Math.cos(a) * rr;
          const y = h + Math.sin(a) * rr * 0.8;
          if (p === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = rampGradient(ctx, HILL_NEAR, 0, 0, 0, h);
        ctx.fill();
      },
    });
  }

  return out;
}
