/**
 * The two settings the player owns: how fast the world comes at them, and
 * whether a mistake is allowed to cost anything.
 *
 * Both live in `Profile.settings`, so both survive a reload; this file is the
 * only place that reads or writes them, which means the pause menu, the play
 * scene and any future options screen can never disagree about what "0.8x" or
 * "easy" means. The numbers are in `TUNING.assist` — a designer retunes there,
 * the labels below are what a six-year-old actually sees.
 *
 * Deliberately not a class and not stateful: a setting is a fact about the
 * profile, and caching it anywhere else is how a menu ends up showing one thing
 * while the game does another.
 */

import type { Profile } from '../engine/save';
import { TUNING } from './tuning';

export interface SpeedOption {
  /** Multiplier applied to the world scroll. */
  mul: number;
  /** What the chip says. */
  label: string;
  /**
   * How many bars the chip draws, 1..4. This is the part that works before you
   * can read: four chips whose bar-stacks grow left to right say "these are
   * speeds, and this one is the slowest" without a word of text.
   */
  bars: number;
}

/** The speed ladder, slowest first. Order is the order the menu shows. */
export const SPEEDS: readonly SpeedOption[] = TUNING.assist.speeds.map((mul, i) => ({
  mul,
  label: ['SLOWEST', 'SLOWER', 'NORMAL', 'FASTER'][i] ?? `${mul}x`,
  bars: i + 1,
}));

/** Short "0.6x" style caption for a speed, built once rather than per frame. */
export const SPEED_TAGS: readonly string[] = SPEEDS.map((s) =>
  `${s.mul === Math.round(s.mul) ? s.mul.toFixed(1) : s.mul}x`,
);

const DEFAULT_INDEX = Math.min(
  Math.max(TUNING.assist.defaultSpeed, 0),
  SPEEDS.length - 1,
);

/**
 * Which rung of the ladder the profile is on.
 *
 * Resolved by nearest multiplier rather than by a stored index, so a profile
 * written before a rung was added or moved still lands on the closest speed
 * that exists now instead of on rung 0.
 */
export function speedIndex(p: Profile): number {
  const want = p.settings.speed;
  if (!Number.isFinite(want)) return DEFAULT_INDEX;
  let best = DEFAULT_INDEX;
  let bestD = Infinity;
  for (let i = 0; i < SPEEDS.length; i++) {
    const d = Math.abs(SPEEDS[i].mul - want);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The multiplier the world should actually scroll at. Never 0, never NaN. */
export function speedMul(p: Profile): number {
  return SPEEDS[speedIndex(p)].mul;
}

/** Move to a rung. Returns true when something changed. */
export function setSpeedIndex(p: Profile, i: number): boolean {
  const idx = Math.min(Math.max(i | 0, 0), SPEEDS.length - 1);
  const mul = SPEEDS[idx].mul;
  if (p.settings.speed === mul) return false;
  p.settings.speed = mul;
  return true;
}

export const isEasy = (p: Profile): boolean => !!p.settings.easyMode;

/** Flip no-penalty mode. Returns true when something changed. */
export function setEasy(p: Profile, on: boolean): boolean {
  if (!!p.settings.easyMode === on) return false;
  p.settings.easyMode = on;
  return true;
}

/**
 * What a word's takings are worth, given how it was played.
 *
 * One function, used for both sparks and lifetime score, so there is exactly
 * one place the discount lives and no way for the two to drift apart.
 */
export const earnShare = (p: Profile): number =>
  isEasy(p) ? TUNING.assist.easyEarnShare : 1;
