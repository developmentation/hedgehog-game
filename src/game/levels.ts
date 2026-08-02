/**
 * LEVELS — the content model.
 *
 * ============================================================================
 * HOW TO ADD A LEVEL
 * ============================================================================
 *
 * Add one object literal to `LEVELS` at the bottom of this file. That is the
 * whole job: no other file changes, no new code paths. Play it with
 *
 *     ?level=<id>            in the URL
 *     __levels.start('<id>') from the console
 *
 * A level is pure data. Everything in it is optional except `id`, `title`,
 * `words` and `goal`; anything you leave out falls back to the global feel
 * constants in `tuning.ts`, so a minimal level is four lines:
 *
 *     { id: 'birds', title: 'BIRD WATCH',
 *       words: { topics: ['animals'], tiers: [1, 2] },
 *       goal: { kind: 'words', target: 5 } }
 *
 * ---------------------------------------------------------------- words ----
 * `words` is a filter over `src/data/words.ts`, not a list. Fields are ANDed:
 *
 *     tiers   [1..5]      difficulty bands; also sets the level's tier ladder
 *     topics  ['ocean']   exact `topic` tags — see `TOPICS` in words.ts
 *     ids     ['OWL']     specific words, for a hand-authored set piece
 *     minLen / maxLen     letter-count window, inclusive
 *
 * The pool is resolved once, at level start. If a filter matches nothing the
 * level silently falls back to the whole bank rather than failing to boot.
 *
 * Within a run the game draws from ONE tier at a time — the current rung of
 * the level's tier ladder (the sorted tiers present in the pool). The ladder
 * only ever climbs, and only when a word is spelled without breaking the
 * combo. A single-tier level therefore never gets harder in vocabulary; a
 * `tiers: [1,2,3,4,5]` level walks the whole bank as the player earns it.
 *
 * --------------------------------------------------------------- pacing ----
 * `pacing` is a *shape over the level*, not a global tier:
 *
 *     startSpeed / endSpeed   world units/sec at the first word and at the end
 *                             of the ramp
 *     rampWords               how many CLEAN words it takes to get there
 *     columnHeight [lo, hi]   blocks per wall at ramp 0 and ramp 1
 *     decoyBias    0..1       where the non-answer letters come from. 0 draws
 *                             them from the word's own letters (a spelling
 *                             decision); 1 draws them from the alphabet (a
 *                             visual search). In between, per block.
 *
 * The ramp is `min(cleanWords / rampWords, 1)`, where a clean word is one
 * spelled without breaking the combo — the same thing that earns a rung on the
 * tier ladder. Difficulty is earned, never merely survived: a player who keeps
 * missing keeps the pace and the column height they were on, which is the
 * whole no-punishment promise applied to pacing.
 *
 * ----------------------------------------------------------------- goal ----
 *     { kind: 'words',   target: 6 }     complete 6 words
 *     { kind: 'score',   target: 2500 }  reach 2500 points
 *     { kind: 'streak',  target: 12 }    reach a 12-letter combo
 *     { kind: 'endless' }                never ends — the shipped default
 *
 * The goal is tested at word boundaries only, so a level always ends on a
 * celebration rather than mid-column.
 *
 * ---------------------------------------------------------------- rules ----
 *     lives         misses allowed before a setback   (default TUNING)
 *     allowJump     false hides the hop entirely      (default true)
 *     setbackCost   fraction of score a setback takes (default TUNING)
 *
 * One caveat on `lives`: the HUD's heart row is sized once from
 * `TUNING.scoring.maxMisses`, so a level asking for MORE lives than that gets
 * them, but the extra ones are not drawn. Levels that want to be kinder are
 * better off spending it on `setbackCost` or a slower `pacing`.
 *
 * ---------------------------------------------------------------- theme ----
 * A name for a background/prop set. Carried through to `probe().theme` and
 * ignored by anything that does not recognise it, so an unknown or absent
 * theme is simply the default scene — never a boot failure.
 *
 * ============================================================================
 * WHAT LIVES HERE VS IN tuning.ts
 * ============================================================================
 * `tuning.ts` keeps what is true of the *game*: dash timing, spring constants,
 * camera, shake, scoring weights, hit boxes. This file keeps what is true of a
 * *run*: which words, how fast, how tall, how forgiving, when it ends.
 */

import { clamp, lerp } from '../core/ctx';
import { WORDS, queryWords, tiersIn, type WordEntry, type WordQuery } from '../data/words';
import { TUNING } from './tuning';

export type { WordQuery };

/** How difficulty is shaped across a level. Every field falls back to TUNING. */
export interface LevelPacing {
  /** Scroll speed at the first word. */
  startSpeed?: number;
  /** Scroll speed once `rampWords` words are done. */
  endSpeed?: number;
  /** Words completed for the ramp to reach its end. */
  rampWords?: number;
  /** Blocks per wall at ramp 0 and ramp 1. */
  columnHeight?: [number, number];
  /** 0 = decoys from the word's own letters, 1 = from the alphabet. */
  decoyBias?: number;
}

export interface LevelGoal {
  kind: 'words' | 'score' | 'streak' | 'endless';
  /** Required for every kind but `endless`. */
  target?: number;
}

/** How forgiving this level is. Every field falls back to TUNING. */
export interface LevelRules {
  /** Misses allowed before a setback. */
  lives?: number;
  /** False removes the hop — button, hint and all. */
  allowJump?: boolean;
  /** Fraction of the score a setback takes, 0..1. */
  setbackCost?: number;
}

export interface LevelDef {
  id: string;
  title: string;
  /** Which words this level draws from. */
  words: WordQuery;
  /** Difficulty shape over the level, not a single global tier. */
  pacing?: LevelPacing;
  /** What ends the level and what counts as success. */
  goal: LevelGoal;
  /** Optional: how forgiving this level is. */
  rules?: LevelRules;
  /** Optional theming hook — a named background/prop set. Degrades to default. */
  theme?: string;
}

/**
 * A level with every default filled in and its word pool resolved.
 *
 * Systems read this, never the raw `LevelDef`, so no consumer ever has to
 * write `?? TUNING.something` in a hot path.
 */
export interface LevelConfig {
  readonly def: LevelDef;
  readonly id: string;
  readonly title: string;
  readonly theme: string;
  /** The level's words, resolved once. Never empty. */
  readonly pool: readonly WordEntry[];
  /** Tier ladder: distinct tiers present in the pool, ascending. Never empty. */
  readonly tiers: readonly number[];
  readonly startSpeed: number;
  readonly endSpeed: number;
  readonly rampWords: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly decoyBias: number;
  readonly goalKind: LevelGoal['kind'];
  readonly goalTarget: number;
  readonly lives: number;
  readonly allowJump: boolean;
  readonly setbackCost: number;
}

/** Resolved configs are memoised per descriptor: replaying a level is free. */
const RESOLVED = new WeakMap<LevelDef, LevelConfig>();

/** Fill a descriptor's gaps from TUNING and resolve its word pool. */
export function resolveLevel(def: LevelDef): LevelConfig {
  const hit = RESOLVED.get(def);
  if (hit) return hit;

  const S = TUNING.scroll;
  const W = TUNING.walls;
  const p = def.pacing ?? {};
  const r = def.rules ?? {};

  // A filter that matches nothing degrades to the whole bank rather than
  // leaving the session with no word to pick.
  const matched = queryWords(def.words);
  const pool = matched.length ? matched : WORDS;

  // The ladder never exceeds the game's own difficulty ceiling, so lowering
  // TUNING.scoring.maxTier still caps every level.
  const present = tiersIn(pool);
  const capped = present.filter((t) => t <= TUNING.scoring.maxTier);
  const tiers = capped.length ? capped : present;

  const height = p.columnHeight ?? [W.heightMin, W.heightMax];

  const cfg: LevelConfig = {
    def,
    id: def.id,
    title: def.title,
    theme: def.theme ?? 'default',
    pool,
    tiers,
    startSpeed: p.startSpeed ?? S.baseSpeed + S.tierRamp,
    endSpeed: p.endSpeed ?? S.baseSpeed + S.tierRamp * TUNING.scoring.maxTier,
    rampWords: Math.max(1, p.rampWords ?? TUNING.scoring.maxTier),
    minHeight: clamp(height[0], W.heightMin, W.heightMax),
    maxHeight: clamp(height[1], W.heightMin, W.heightMax),
    decoyBias: clamp(p.decoyBias ?? 0, 0, 1),
    goalKind: def.goal.kind,
    goalTarget: def.goal.target ?? 0,
    lives: Math.max(1, r.lives ?? TUNING.scoring.maxMisses),
    allowJump: r.allowJump ?? true,
    setbackCost: clamp(r.setbackCost ?? TUNING.scoring.setbackScoreLoss, 0, 1),
  };
  RESOLVED.set(def, cfg);
  return cfg;
}

/**
 * One playthrough of one level.
 *
 * Holds the level's config plus the only things that change during a run: how
 * much has been earned, where on the tier ladder that puts us, and whether the
 * goal has been met. Every consumer asks this object for its numbers, so
 * nothing downstream has to know how a level is shaped.
 *
 * Allocates only on construction; every accessor is arithmetic.
 */
export class LevelRun {
  readonly config: LevelConfig;

  /** Words completed in this run, however messily. Feeds a `words` goal. */
  wordsDone = 0;
  /** Words completed without breaking the combo — the pacing ramp's only input. */
  cleanWords = 0;
  /** Best score and best letter combo seen, for score/streak goals. */
  bestScore = 0;
  bestStreak = 0;
  /** Rung of `config.tiers`. Climbs only on a word spelled clean. */
  tierIndex = 0;
  /** Latched the moment the goal is met. */
  complete = false;

  constructor(def: LevelDef) {
    this.config = resolveLevel(def);
  }

  /** The tier words are currently drawn from. */
  get tier(): number {
    return this.config.tiers[this.tierIndex];
  }

  /** Position along the level's difficulty shape, 0..1. Earned, not elapsed. */
  get ramp(): number {
    return clamp(this.cleanWords / this.config.rampWords, 0, 1);
  }

  /** Target scroll speed right now. */
  get speed(): number {
    return lerp(this.config.startSpeed, this.config.endSpeed, this.ramp);
  }

  /** Blocks in the next wall spawned. */
  get columnHeight(): number {
    return Math.round(lerp(this.config.minHeight, this.config.maxHeight, this.ramp));
  }

  /** Progress towards the goal, 0..1. Always 0 for an endless level. */
  get progress(): number {
    const t = this.config.goalTarget;
    if (t <= 0) return 0;
    switch (this.config.goalKind) {
      case 'words':
        return clamp(this.wordsDone / t, 0, 1);
      case 'score':
        return clamp(this.bestScore / t, 0, 1);
      case 'streak':
        return clamp(this.bestStreak / t, 0, 1);
      default:
        return 0;
    }
  }

  /** One line of goal state, e.g. "3 / 6 WORDS". Empty for an endless level. */
  progressLabel(): string {
    const c = this.config;
    switch (c.goalKind) {
      case 'words':
        return `${this.wordsDone} / ${c.goalTarget} WORDS`;
      case 'score':
        return `${this.bestScore} / ${c.goalTarget} POINTS`;
      case 'streak':
        return `${this.bestStreak} / ${c.goalTarget} STREAK`;
      default:
        return '';
    }
  }

  /**
   * Bank a clean word: one rung up the tier ladder and one step along the
   * pacing ramp. Both move on the same signal, which is what the tier ramp
   * this replaced did — vocabulary and pace are earned together, and a run of
   * misses costs neither of them.
   */
  promote(clean: boolean): void {
    if (!clean) return;
    this.cleanWords++;
    this.tierIndex = Math.min(this.tierIndex + 1, this.config.tiers.length - 1);
  }

  /**
   * Bank a completed word. Returns true if that completed the level.
   * The goal is only ever tested here, so a level ends on a celebration.
   */
  noteWord(score: number, streak: number): boolean {
    this.wordsDone++;
    if (score > this.bestScore) this.bestScore = score;
    if (streak > this.bestStreak) this.bestStreak = streak;
    if (this.progress >= 1 && this.config.goalKind !== 'endless') this.complete = true;
    return this.complete;
  }
}

// ---------------------------------------------------------------- the levels

/**
 * The shipped levels. Order is presentation order; `LEVELS[0]` is the default
 * a plain boot drops into.
 */
export const LEVELS: readonly LevelDef[] = [
  /**
   * The original game, expressed as data.
   *
   * The numbers reproduce the tier ramp they replaced step for step: the old
   * target speed was `baseSpeed + tier * tierRamp` with the tier climbing one
   * rung per clean word, which is 256 at the first word through 360 after four
   * clean ones — and the column grew 2 -> 5 across the same four. A boot into
   * this level is the game as it has always played. It is not special-cased
   * anywhere: it is `goal.kind: 'endless'`, and that alone is what makes it
   * endless.
   */
  {
    id: 'endless',
    title: 'ENDLESS ROLL',
    words: { tiers: [1, 2, 3, 4, 5] },
    pacing: { startSpeed: 256, endSpeed: 360, rampWords: 4, columnHeight: [2, 5], decoyBias: 0 },
    goal: { kind: 'endless' },
  },

  /**
   * Three and four letter words, two-block columns, a slow world and a spare
   * life. Nothing here should ever require a second look at a column.
   */
  {
    id: 'warmup',
    title: 'FIRST STEPS',
    words: { tiers: [1], maxLen: 4 },
    pacing: { startSpeed: 190, endSpeed: 225, rampWords: 5, columnHeight: [2, 2], decoyBias: 0 },
    goal: { kind: 'words', target: 5 },
    theme: 'meadow',
  },

  /**
   * A themed run: the ocean shelf of the bank, mid tiers only. The decoy bias
   * is up, so a third of the wrong letters come from outside the word — the
   * first level where reading the column is work.
   */
  {
    id: 'deep-blue',
    title: 'DEEP BLUE',
    words: { topics: ['ocean'], tiers: [2, 3, 4] },
    pacing: { startSpeed: 240, endSpeed: 300, rampWords: 6, columnHeight: [3, 4], decoyBias: 0.35 },
    goal: { kind: 'words', target: 6 },
    theme: 'ocean',
  },

  /**
   * Three of the longest words in the bank, on the tallest columns, with the
   * decoys mostly random. Slow on purpose — the difficulty is the spelling,
   * and a setback here costs almost nothing so a nine-letter word is never a
   * wall you bounce off.
   */
  {
    id: 'gauntlet',
    title: 'LONG WORD GAUNTLET',
    words: { tiers: [5], minLen: 8 },
    pacing: { startSpeed: 225, endSpeed: 265, rampWords: 3, columnHeight: [4, 5], decoyBias: 0.6 },
    goal: { kind: 'words', target: 3 },
    rules: { setbackCost: 0.05 },
    theme: 'cavern',
  },

  /**
   * A score chase at speeds the endless run never reaches, on short columns so
   * the reading stays instant. The hop is off — there is no time to be in the
   * air — and it starts a heart down, which is what makes the pace read as a
   * decision rather than a setting.
   */
  {
    id: 'sprint',
    title: 'SPARK SPRINT',
    words: { tiers: [2, 3], maxLen: 6 },
    pacing: { startSpeed: 330, endSpeed: 430, rampWords: 4, columnHeight: [2, 3], decoyBias: 0.2 },
    goal: { kind: 'score', target: 2500 },
    rules: { allowJump: false, lives: 2 },
    theme: 'dusk',
  },
];

export const DEFAULT_LEVEL: LevelDef = LEVELS[0];

export function getLevel(id: string): LevelDef | null {
  for (const l of LEVELS) if (l.id === id) return l;
  return null;
}

/**
 * Which level a fresh boot starts in: `?level=<id>` if it names one, otherwise
 * the endless run. An unknown id is ignored rather than fatal.
 */
export function bootLevel(): LevelDef {
  if (typeof location === 'undefined') return DEFAULT_LEVEL;
  const id = new URLSearchParams(location.search).get('level');
  return (id && getLevel(id)) || DEFAULT_LEVEL;
}
