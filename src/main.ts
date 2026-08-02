/**
 * Boot: build the renderer, bake procedural art, wire input/audio/save, and
 * hand control to the scene stack.
 */

import { Renderer } from './engine/gl';
import { Atlas } from './engine/atlas';
import { Input } from './engine/input';
import { AudioBus } from './engine/audio';
import { SaveStore } from './engine/save';
import { Rng } from './engine/rng';
import { Loop } from './engine/loop';
import { AssetLibrary } from './engine/assets';
import type { Ctx, Scene } from './core/ctx';
import { VIEW_W, VIEW_H, clamp } from './core/ctx';
import { allPainters } from './art/index';
import { SceneStack } from './core/stack';
import { PlayScene } from './scenes/play';
import { attachDebug } from './core/debug';

async function boot(): Promise<void> {
  const canvas = document.getElementById('glcanvas') as HTMLCanvasElement;
  const stage = document.getElementById('stage') as HTMLElement;
  const bootEl = document.getElementById('boot');

  const r = new Renderer(canvas, 24576);
  r.viewW = VIEW_W;
  r.viewH = VIEW_H;

  const save = new SaveStore();
  await save.whenReady();

  const atlas = new Atlas();
  atlas.addAll(allPainters());

  // Bake at the device's pixel density so sprites stay crisp on phones,
  // capped to keep atlas upload cost sane on low-end GPUs.
  const bakeScale = clamp(Math.min(window.devicePixelRatio || 1, 2), 1, 2);
  const t0 = performance.now();
  atlas.bake(r.gl, bakeScale);
  const bakeMs = performance.now() - t0;

  // Generated painted art. Loaded in parallel with nothing blocking on it —
  // the game is fully playable on procedural art alone, so a missing or
  // half-generated asset set degrades gracefully instead of failing to boot.
  const assets = new AssetLibrary();
  await assets.load(r.gl, 'art/', Math.min(bakeScale, 1));

  const audio = new AudioBus();
  const input = new Input(r, stage);
  const rng = new Rng(0x5eed1234);

  let shakeMag = 0;
  let shakeTime = 0;
  let shakeDur = 0;
  let hitStopLeft = 0;

  const ctx: Ctx = {
    r,
    atlas,
    assets,
    input,
    audio,
    save,
    rng,
    cam: { x: 0, y: 0, zoom: 1, shakeX: 0, shakeY: 0 },
    time: 0,
    alpha: 0,
    timeScale: 1,
    // Booting in RAW: art drawn exactly as painted, no styling passes.
    rawMode: true,
    reducedMotion:
      save.profile.settings.reducedMotion ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
      false,
    shake(magnitude, seconds) {
      if (ctx.reducedMotion) return;
      // Never let a small shake cut off a bigger one mid-flight.
      if (magnitude >= shakeMag * (1 - shakeTime / Math.max(shakeDur, 0.0001))) {
        shakeMag = magnitude;
        shakeDur = seconds;
        shakeTime = 0;
      }
    },
    hitStop(seconds) {
      hitStopLeft = Math.max(hitStopLeft, seconds);
    },
  };

  audio.setMuted(save.profile.settings.muted);

  const stack = new SceneStack(ctx);
  stack.push(new PlayScene());

  // The first gesture anywhere unlocks audio; browsers require this.
  const unlockAudio = () => {
    audio.unlock();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio, { once: false });
  window.addEventListener('keydown', unlockAudio, { once: false });

  // Render scale.
  //
  // The world pass can rasterise below device resolution and be upscaled on
  // resolve (see gl.ts); the HUD always stays native. By default the adaptive
  // controller owns it, so a machine that can hold the target frame rate at
  // native never leaves native and the look at rest is unchanged.
  //
  // Two ways to take it off automatic:
  //   ?rs=0.72        pin the scale for a capture or a comparison
  //   ?rs=auto&fps=50 keep it adaptive but move the target
  // A persisted preference would belong in `save.profile.settings`; the field
  // does not exist yet, so it is read defensively and simply has no effect
  // until `save.ts` adds it.
  const params = new URLSearchParams(location.search);
  const savedScale = (save.profile.settings as { renderScale?: number }).renderScale;
  const rsParam = params.get('rs');
  const fpsParam = Number(params.get('fps'));
  if (Number.isFinite(fpsParam) && fpsParam > 0) r.targetFps = fpsParam;
  if (rsParam && rsParam !== 'auto') {
    const v = Number(rsParam);
    if (Number.isFinite(v)) r.setRenderScale(v);
  } else if (!rsParam && typeof savedScale === 'number') {
    r.setRenderScale(savedScale);
  }

  const resize = () => r.resize(stage.clientWidth, stage.clientHeight, 2);
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  window.addEventListener('pagehide', () => save.saveNow());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      save.saveNow();
      audio.cancelSpeech();
    }
  });

  const loop = new Loop({
    hz: 120,
    maxSteps: 4,
    update: (dt) => {
      if (hitStopLeft > 0) {
        hitStopLeft -= dt;
        // Freeze the simulation, but still run the scene with dt = 0 so it can
        // CONSUME this frame's input before it is cleared. The old code called
        // `endFrame()` here without updating, which silently discarded any tap
        // that landed inside the 35ms hit-stop after a smash — precisely when
        // an eager player is queueing their next letter.
        stack.update(0);
        input.endFrame();
        return;
      }
      const scaled = dt * ctx.timeScale;
      ctx.time += scaled;

      if (shakeTime < shakeDur) {
        shakeTime += dt;
        const k = 1 - shakeTime / shakeDur;
        const decay = k * k;
        const f = ctx.time * 62;
        ctx.cam.shakeX = Math.sin(f * 1.7) * shakeMag * decay;
        ctx.cam.shakeY = Math.cos(f * 2.3) * shakeMag * decay * 0.7;
      } else {
        ctx.cam.shakeX = 0;
        ctx.cam.shakeY = 0;
        shakeMag = 0;
      }

      stack.update(scaled);
      input.endFrame();
    },
    render: (alpha, dt) => {
      ctx.alpha = alpha;
      stack.render();
      // Fed the frame's wall time, not the render cost: the thing being held
      // is the frame rate the player sees, and on a fill-bound game almost all
      // of that time is spent on the GPU after `render()` has already
      // returned. Measuring our own submit time would report 0.4 ms and never
      // scale anything.
      r.tickScaler(dt);
    },
  });

  // Raw mode applies to the painted assets only — never to the procedural
  // atlas, which holds glyphs, UI and particles that are white by design.
  for (const frame of assets.frames.values()) r.rawTextures.add(frame.tex);
  r.rawMode = ctx.rawMode;

  attachDebug(ctx, loop, { bakeMs });

  bootEl?.classList.add('hidden');
  setTimeout(() => bootEl?.remove(), 500);
  loop.start();

  // Live grade control, so exposure and saturation can be dialled against the
  // real frame instead of guessed at: window.__grade(exposure, saturation).
  (window as any).__grade = (e = 1, sat = 1) => {
    r.grade[0] = e;
    r.grade[1] = sat;
    return `grade exposure=${e} saturation=${sat}`;
  };

  // Live render-scale control.
  //
  //   window.__renderScale()       -> report, and hand control back to auto
  //   window.__renderScale(0.6)    -> pin the world pass at 60% of device res
  //   window.__renderScale('auto') -> same as no argument
  //   window.__renderScale(1, 45)  -> auto off at native, target 45 fps
  //
  // The second argument sets the adaptive target, which is also the honest way
  // to force the controller to work on a machine that is not struggling: ask
  // for a frame rate the display cannot reach and watch it walk the ladder
  // down, then ask for a reachable one and watch it walk back up.
  (window as any).__renderScale = (s?: number | string, targetFps?: number) => {
    if (typeof targetFps === 'number' && targetFps > 0) r.targetFps = targetFps;
    if (s === undefined || s === 'auto') {
      r.setRenderScale(null);
      r.resetScaler();
    } else if (typeof s === 'number') {
      r.setRenderScale(s);
    }
    return {
      renderScale: r.renderScale,
      auto: r.autoScale,
      targetFps: r.targetFps,
      devicePixels: `${Math.round(r.canvas.width * r.renderScale)}x${Math.round(r.canvas.height * r.renderScale)} of ${r.canvas.width}x${r.canvas.height}`,
    };
  };

  // Diagnostic: window.__raw(true) draws the art with no tints, washes,
  // vignette, flash or hero separation passes at all.
  (window as any).__raw = (on = true) => {
    ctx.rawMode = !!on;
    r.rawMode = !!on;
    return on ? "RAW: art only" : "styled";
  };

  // Build stamp. Vite hashes the bundle filename, so a normal refresh can
  // quietly serve a stale one — which has repeatedly made a fixed bug look
  // unfixed.  in the console says exactly which build is running.
  (window as any).__build = () => {
    const stamp = __BUILD_STAMP__;
    console.log('%c' + stamp, 'font:600 13px ui-monospace;color:#9ff0c8');
    return stamp;
  };

  // Expose a handle for the automated capture harness.
  (window as any).__game = {
    ctx,
    loop,
    stack,
    atlas,
    r,
    probe: () => (window as any).__probeFn?.() ?? null,
  };
}

boot().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.textContent = 'Failed to start';
    bootEl.style.color = '#ff5f6d';
  }
});
