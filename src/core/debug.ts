/**
 * Performance overlay + machine-readable perf feed.
 *
 * Rendered as DOM rather than sprites so measuring the game never perturbs the
 * thing being measured. Toggle with the backtick key or `?debug=1`.
 * `window.__perf` is what the automated capture harness reads.
 */

import type { Ctx } from './ctx';
import type { Loop } from '../engine/loop';

export interface PerfSnapshot {
  fps: number;
  updateMs: number;
  renderMs: number;
  drawCalls: number;
  sprites: number;
  longFrames: number;
  atlasSize: number;
  atlasOccupancy: number;
  bakeMs: number;
  heapMb: number;
  /** Fraction of device resolution the world pass is rasterising at. */
  renderScale: number;
  /** False once the scale has been pinned by hand or by a setting. */
  autoScale: boolean;
  /** Pixels the world pass actually shades, in millions. */
  worldMpx: number;
}

export function attachDebug(ctx: Ctx, loop: Loop, meta: { bakeMs: number }): void {
  const params = new URLSearchParams(location.search);
  let visible = params.get('debug') === '1';

  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'top:8px',
    'left:8px',
    'z-index:50',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#9ff0c8',
    'background:rgba(4,8,18,0.78)',
    'padding:7px 10px',
    'border-radius:7px',
    'border:1px solid rgba(120,220,180,0.25)',
    'pointer-events:none',
    'white-space:pre',
    'letter-spacing:0.02em',
  ].join(';');
  el.style.display = visible ? 'block' : 'none';
  document.body.appendChild(el);

  const snap: PerfSnapshot = {
    fps: 0,
    updateMs: 0,
    renderMs: 0,
    drawCalls: 0,
    sprites: 0,
    longFrames: 0,
    atlasSize: ctx.atlas.size,
    atlasOccupancy: ctx.atlas.occupancy,
    bakeMs: meta.bakeMs,
    heapMb: 0,
    renderScale: 1,
    autoScale: true,
    worldMpx: 0,
  };
  (window as any).__perf = snap;

  window.addEventListener('keydown', (e) => {
    if (e.key === '`') {
      visible = !visible;
      el.style.display = visible ? 'block' : 'none';
    }
  });

  const tick = () => {
    const s = loop.stats;
    snap.fps = s.fps;
    snap.updateMs = s.updateMs;
    snap.renderMs = s.renderMs;
    snap.drawCalls = ctx.r.drawCalls;
    snap.sprites = ctx.r.spritesDrawn;
    snap.longFrames = s.longFrames;
    const mem = (performance as any).memory;
    snap.heapMb = mem ? mem.usedJSHeapSize / 1048576 : 0;
    const r = ctx.r;
    snap.renderScale = r.renderScale;
    snap.autoScale = r.autoScale;
    // The number that actually matters on a fill-bound frame: how many pixels
    // the world pass rasterises before overdraw is counted at all.
    snap.worldMpx = (r.canvas.width * r.canvas.height * r.renderScale * r.renderScale) / 1e6;

    if (visible) {
      el.textContent =
        `${s.fps.toFixed(0).padStart(3)} fps   step ${s.steps}\n` +
        `upd ${s.updateMs.toFixed(2)}ms  ren ${s.renderMs.toFixed(2)}ms\n` +
        `draws ${snap.drawCalls}  sprites ${snap.sprites}\n` +
        `scale ${snap.renderScale.toFixed(2)}${snap.autoScale ? '' : ' pin'}  ${snap.worldMpx.toFixed(2)}Mpx -> ${(r.canvas.width / 1e3).toFixed(1)}k\n` +
        `long ${s.longFrames}  heap ${snap.heapMb.toFixed(1)}mb\n` +
        `atlas ${snap.atlasSize}px @${(snap.atlasOccupancy * 100).toFixed(0)}%  bake ${meta.bakeMs.toFixed(0)}ms`;
    }
    setTimeout(tick, 250);
  };
  tick();
}
