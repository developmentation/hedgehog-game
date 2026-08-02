/**
 * The shared context handed to every subsystem.
 *
 * This is the contract boundary between modules: art, gameplay, HUD and FX all
 * receive the same `Ctx` and never reach for globals. Anything a module needs
 * from another module goes through here.
 */

import type { Renderer } from '../engine/gl';
import type { Atlas } from '../engine/atlas';
import type { Input } from '../engine/input';
import type { AudioBus } from '../engine/audio';
import type { SaveStore } from '../engine/save';
import type { Rng } from '../engine/rng';
import type { AssetLibrary } from '../engine/assets';

/** Virtual design resolution. All gameplay maths is in these units. */
export const VIEW_W = 1280;
export const VIEW_H = 720;

/** Ground line — the surface the hedgehog rolls along. */
export const GROUND_Y = 560;

/** Horizontal position the hedgehog holds while the world scrolls past. */
export const PLAYER_X = 300;

/** Height of the hangman word bar docked at the bottom. */
export const WORD_BAR_H = 132;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** Additive screen shake offset, recomputed each frame. */
  shakeX: number;
  shakeY: number;
}

export interface Ctx {
  r: Renderer;
  /** Procedurally-baked art: glyphs, UI, particles, fallback shapes. */
  atlas: Atlas;
  /** Generated painted art. Empty until assets are generated — always guard. */
  assets: AssetLibrary;
  input: Input;
  audio: AudioBus;
  save: SaveStore;
  rng: Rng;
  cam: Camera;
  /** Seconds since boot, advanced by the fixed-step simulation. */
  time: number;
  /** Interpolation alpha for the current render pass, 0..1. */
  alpha: number;
  /** Global slow-motion / hit-stop multiplier applied to dt. */
  timeScale: number;
  /** Diagnostic: skip every overlay/wash pass and draw the art as authored. */
  rawMode: boolean;
  /** True when the player has asked for reduced motion. */
  reducedMotion: boolean;
  /** Request a screen shake. Magnitude is in world units. */
  shake: (magnitude: number, seconds: number) => void;
  /** Request hit-stop: freeze the sim briefly for impact weight. */
  hitStop: (seconds: number) => void;
}

/**
 * Machine-readable view of the play scene, used by the automated capture
 * harness to drive real inputs (it taps actual on-screen letters rather than
 * poking internal state, so what it captures is what a player would see).
 */
export interface PlayProbe {
  phase: 'intro' | 'listening' | 'playing' | 'celebrate' | 'setback' | 'gameover';
  word: string;
  /** Which letter slots are filled in the hangman bar. */
  revealed: boolean[];
  /** Index of the letter the player must hit next. */
  nextIndex: number;
  score: number;
  combo: number;
  misses: number;
  lives: number;
  /** Letter blocks currently tappable, in world coordinates. */
  targets: { letter: string; x: number; y: number; w: number; h: number }[];
  /** Hedgehog motion state, and how far off the ground line he is. */
  playerState?: string;
  airHeight?: number;
  /** World-space centre and diameter of the on-screen jump control. */
  jumpBtn?: { x: number; y: number; d: number };
}

/** A self-contained slice of the game that can be pushed/popped. */
export interface Scene {
  readonly name: string;
  enter?(ctx: Ctx): void;
  exit?(ctx: Ctx): void;
  update(ctx: Ctx, dt: number): void;
  /** Draw world-space content (affected by camera). */
  draw(ctx: Ctx): void;
  /** Draw screen-space content (HUD). Optional. */
  drawUi?(ctx: Ctx): void;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  b + (a - b) * Math.exp(-lambda * dt);

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutBack = (t: number, s = 1.70158): number =>
  1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const easeOutElastic = (t: number): number => {
  if (t === 0 || t === 1) return t;
  const p = 0.35;
  return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
};
export const smoothstep = (t: number): number => t * t * (3 - 2 * t);
