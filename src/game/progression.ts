/**
 * Progression: ranks, milestones, unlocks and the cosmetic economy.
 *
 * Pure logic. It never renders, never touches the DOM and never talks to
 * IndexedDB — every function here reads or mutates a plain `Profile` object and
 * the caller decides when to persist it. That keeps the rules testable and lets
 * both the play scene and the shop share one source of truth about what the
 * player owns and what they are working towards.
 *
 * The economy has two paths to every cosmetic, deliberately:
 *
 *   - PAY: spend sparks, which drip out of every letter and word. The grind is
 *     short and always visible, so a player who just wants the pink hedgehog
 *     can go and get it.
 *   - EARN: hit the item's milestone ("reach a 12x streak", "spell a tier-5
 *     word") and it unlocks free. Skill outruns the wallet.
 *
 * Whichever lands first wins; the other path simply stops mattering. Nothing is
 * ever gated behind a wall the player cannot see the far side of, which is the
 * same no-punishment promise the play loop makes.
 */

import type { Profile } from '../engine/save';
import { SKINS, TRAILS, SPINS } from '../art/palette';
import { WORDS } from '../data/words';
import { clamp } from '../core/ctx';

// ---------------------------------------------------------------- milestones

export type MilestoneId =
  | 'words/5'
  | 'combo/8'
  | 'letters/150'
  | 'words/20'
  | 'combo/12'
  | 'tier5/1'
  | 'score/15000'
  | 'rank/8'
  | 'words/60'
  | 'mastery/15';

export interface Milestone {
  id: MilestoneId;
  /** Short imperative shown on a locked item, e.g. "Reach a 12x streak". */
  detail: string;
  /** Cosmetic granted for free the moment this lands. */
  grants: string;
  /** How far along the player is, 0..1. Reaching 1 fires the grant. */
  progress(p: Profile): number;
  /** Human-readable "3 / 10" style counter for the shop. */
  counter(p: Profile): string;
}

/** Word -> tier, built once so tier milestones stay an O(1) lookup. */
const WORD_TIER = new Map<string, number>();
for (const w of WORDS) WORD_TIER.set(w.word, w.tier);

const ratio = (have: number, need: number): number => clamp(have / need, 0, 1);

/** Distinct tier-5 words the player has ever completed. */
function tier5Wins(p: Profile): number {
  let n = 0;
  for (const word in p.wordStats) {
    if (p.wordStats[word].wins > 0 && WORD_TIER.get(word) === 5) n++;
  }
  return n;
}

/** Words the player has beaten at least twice — real mastery, not one lucky run. */
function masteredWords(p: Profile): number {
  let n = 0;
  for (const word in p.wordStats) if (p.wordStats[word].wins >= 2) n++;
  return n;
}

export const MILESTONES: readonly Milestone[] = [
  {
    id: 'words/5',
    detail: 'Complete 5 words',
    grants: 'trail/dust',
    progress: (p) => ratio(p.wordsCompleted, 5),
    counter: (p) => `${Math.min(p.wordsCompleted, 5)} / 5`,
  },
  {
    id: 'combo/8',
    detail: 'Reach an 8x streak',
    grants: 'spin/comet',
    progress: (p) => ratio(p.longestStreak, 8),
    counter: (p) => `${Math.min(p.longestStreak, 8)} / 8`,
  },
  {
    id: 'letters/150',
    detail: 'Smash 150 letters',
    grants: 'skin/ember',
    progress: (p) => ratio(p.lettersSmashed, 150),
    counter: (p) => `${Math.min(p.lettersSmashed, 150)} / 150`,
  },
  {
    id: 'words/20',
    detail: 'Complete 20 words',
    grants: 'trail/spark',
    progress: (p) => ratio(p.wordsCompleted, 20),
    counter: (p) => `${Math.min(p.wordsCompleted, 20)} / 20`,
  },
  {
    id: 'combo/12',
    detail: 'Reach a 12x streak',
    grants: 'spin/turbine',
    progress: (p) => ratio(p.longestStreak, 12),
    counter: (p) => `${Math.min(p.longestStreak, 12)} / 12`,
  },
  {
    id: 'tier5/1',
    detail: 'Spell a tier-5 word',
    grants: 'skin/mint',
    progress: (p) => ratio(tier5Wins(p), 1),
    counter: (p) => `${Math.min(tier5Wins(p), 1)} / 1`,
  },
  {
    id: 'score/15000',
    detail: 'Bank 15000 lifetime points',
    grants: 'trail/frost',
    progress: (p) => ratio(p.totalScore, 15000),
    counter: (p) => `${Math.min(Math.round(p.totalScore), 15000)} / 15000`,
  },
  {
    id: 'rank/8',
    detail: 'Reach rank 8',
    grants: 'spin/nova',
    progress: (p) => ratio(rankLevel(p.totalScore), 8),
    counter: (p) => `${Math.min(rankLevel(p.totalScore), 8)} / 8`,
  },
  {
    id: 'words/60',
    detail: 'Complete 60 words',
    grants: 'skin/orchid',
    progress: (p) => ratio(p.wordsCompleted, 60),
    counter: (p) => `${Math.min(p.wordsCompleted, 60)} / 60`,
  },
  {
    id: 'mastery/15',
    detail: 'Master 15 different words',
    grants: 'skin/gold',
    progress: (p) => ratio(masteredWords(p), 15),
    counter: (p) => `${Math.min(masteredWords(p), 15)} / 15`,
  },
];

const MILESTONE_BY_GRANT = new Map<string, Milestone>();
for (const m of MILESTONES) MILESTONE_BY_GRANT.set(m.grants, m);

/** The milestone that unlocks `id` for free, if it has one. */
export const milestoneFor = (id: string): Milestone | null =>
  MILESTONE_BY_GRANT.get(id) ?? null;

export const milestoneMet = (p: Profile, m: Milestone): boolean => m.progress(p) >= 1;

// ------------------------------------------------------------------ ranks

/**
 * Rank titles, in order. Rank 1 is where everybody starts; the last entry is
 * the ceiling, so the curve never runs out of names.
 */
export const RANK_TITLES: readonly string[] = [
  'Acorn',
  'Sprout',
  'Bramble',
  'Rambler',
  'Spinner',
  'Dashling',
  'Quillwright',
  'Streaker',
  'Comet',
  'Thunderball',
  'Lexicon',
  'Spindash Legend',
];

export const MAX_RANK = RANK_TITLES.length;

/**
 * Score needed to reach each rank.
 *
 * A gentle power curve: rank 2 lands after a word or two so the very first
 * session shows visible movement, then each rank costs progressively more so
 * the top of the ladder stays a long-tail goal rather than an afternoon.
 */
const RANK_FLOOR: number[] = (() => {
  const out: number[] = [0];
  for (let n = 2; n <= MAX_RANK; n++) {
    out.push(Math.round((600 * Math.pow(n - 1, 1.8)) / 50) * 50);
  }
  return out;
})();

/** Lifetime score at which `level` (1-based) is reached. */
export const rankFloor = (level: number): number =>
  RANK_FLOOR[clamp(level, 1, MAX_RANK) - 1];

export function rankLevel(totalScore: number): number {
  let lvl = 1;
  for (let i = MAX_RANK - 1; i >= 0; i--) {
    if (totalScore >= RANK_FLOOR[i]) {
      lvl = i + 1;
      break;
    }
  }
  return lvl;
}

export interface RankInfo {
  level: number;
  title: string;
  /** Score at which this rank began. */
  floor: number;
  /** Score needed for the next rank, or -1 at the ceiling. */
  next: number;
  /** Progress through the current rank, 0..1. Always 1 at the ceiling. */
  progress: number;
}

/**
 * Rank for a lifetime score. Pass `out` from a long-lived field to keep this
 * allocation-free inside a draw loop.
 */
export function rankFor(totalScore: number, out?: RankInfo): RankInfo {
  const r: RankInfo = out ?? { level: 1, title: '', floor: 0, next: 0, progress: 0 };
  const lvl = rankLevel(totalScore);
  r.level = lvl;
  r.title = RANK_TITLES[lvl - 1];
  r.floor = RANK_FLOOR[lvl - 1];
  if (lvl >= MAX_RANK) {
    r.next = -1;
    r.progress = 1;
  } else {
    r.next = RANK_FLOOR[lvl];
    const span = r.next - r.floor;
    r.progress = span > 0 ? clamp((totalScore - r.floor) / span, 0, 1) : 1;
  }
  return r;
}

// -------------------------------------------------------------- the catalogue

export type CosmeticKind = 'skin' | 'trail' | 'spin';

export interface CosmeticEntry {
  id: string;
  kind: CosmeticKind;
  label: string;
  /** Sparks required to buy outright. 0 = owned from the start. */
  cost: number;
  /** Free alternative route, if this item has one. */
  milestone: Milestone | null;
}

function build(kind: CosmeticKind, defs: { id: string; label: string; cost: number }[]): CosmeticEntry[] {
  return defs.map((d) => ({
    id: d.id,
    kind,
    label: d.label,
    cost: d.cost,
    milestone: MILESTONE_BY_GRANT.get(d.id) ?? null,
  }));
}

export const SKIN_ITEMS: readonly CosmeticEntry[] = build('skin', SKINS);
export const TRAIL_ITEMS: readonly CosmeticEntry[] = build('trail', TRAILS);
export const SPIN_ITEMS: readonly CosmeticEntry[] = build('spin', SPINS);

export const CATEGORIES: readonly { kind: CosmeticKind; title: string; items: readonly CosmeticEntry[] }[] = [
  { kind: 'skin', title: 'SKINS', items: SKIN_ITEMS },
  { kind: 'trail', title: 'TRAILS', items: TRAIL_ITEMS },
  { kind: 'spin', title: 'SPIN', items: SPIN_ITEMS },
];

const BY_ID = new Map<string, CosmeticEntry>();
for (const c of CATEGORIES) for (const it of c.items) BY_ID.set(it.id, it);

export const cosmeticById = (id: string): CosmeticEntry | null => BY_ID.get(id) ?? null;

export const labelOf = (id: string): string => BY_ID.get(id)?.label ?? id;

/** Total items in the catalogue — the denominator of the collection counter. */
export const CATALOGUE_SIZE = BY_ID.size;

// ------------------------------------------------------------ award helpers

export const isUnlocked = (p: Profile, id: string): boolean => p.unlocked.indexOf(id) >= 0;

export const isEquipped = (p: Profile, id: string): boolean => {
  const item = BY_ID.get(id);
  return !!item && p.equipped[item.kind] === id;
};

/** Add an item to the ledger. Returns false when it was already there. */
export function grant(p: Profile, id: string): boolean {
  if (!BY_ID.has(id) || isUnlocked(p, id)) return false;
  p.unlocked.push(id);
  return true;
}

/** Credit sparks. Negative or non-finite amounts are ignored, never applied. */
export function awardSparks(p: Profile, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return p.sparks;
  p.sparks = Math.max(0, Math.round(p.sparks + amount));
  return p.sparks;
}

/** Debit sparks. Returns false and changes nothing when the balance is short. */
export function spendSparks(p: Profile, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;
  const cost = Math.round(amount);
  if (p.sparks < cost) return false;
  p.sparks = Math.max(0, p.sparks - cost);
  return true;
}

export function howManyOwned(p: Profile): number {
  let n = 0;
  for (const id of p.unlocked) if (BY_ID.has(id)) n++;
  return n;
}

// --------------------------------------------------------------- unlock check

/**
 * Grant every milestone reward the player has now earned.
 *
 * Idempotent by construction: a grant is recorded in `profile.unlocked`, and
 * anything already in that list is skipped, so calling this twice in a row
 * reports the second call as empty. The caller is responsible for persisting
 * the profile afterwards.
 *
 * Pass `out` to reuse an array and keep this allocation-free on the hot path.
 * Returns the same array, filled with the ids unlocked by this call.
 */
export function checkUnlocks(p: Profile, out?: string[]): string[] {
  const list = out ?? [];
  list.length = 0;
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    if (isUnlocked(p, m.grants)) continue;
    if (m.progress(p) < 1) continue;
    if (grant(p, m.grants)) list.push(m.grants);
  }
  return list;
}

// ------------------------------------------------------------- shop actions

export type ItemState =
  /** Owned and currently worn. */
  | 'equipped'
  /** Owned, one tap from being worn. */
  | 'owned'
  /** Not owned, but the balance covers it. */
  | 'affordable'
  /** Not owned and not affordable — the milestone is the other way in. */
  | 'locked';

export function itemState(p: Profile, id: string): ItemState {
  const item = BY_ID.get(id);
  if (!item) return 'locked';
  if (isUnlocked(p, id)) return p.equipped[item.kind] === id ? 'equipped' : 'owned';
  return p.sparks >= item.cost ? 'affordable' : 'locked';
}

export type ActionResult = 'bought' | 'equipped' | 'already' | 'poor' | 'unknown';

/** Wear an owned item. No-op (false) if it is not owned or not a cosmetic. */
export function equip(p: Profile, id: string): boolean {
  const item = BY_ID.get(id);
  if (!item || !isUnlocked(p, id)) return false;
  if (p.equipped[item.kind] === id) return false;
  p.equipped[item.kind] = id;
  return true;
}

/** Spend sparks on an item. Never double-charges for something already owned. */
export function purchase(p: Profile, id: string): ActionResult {
  const item = BY_ID.get(id);
  if (!item) return 'unknown';
  if (isUnlocked(p, id)) return 'already';
  if (!spendSparks(p, item.cost)) return 'poor';
  grant(p, id);
  return 'bought';
}

/**
 * The single commit action behind the shop's one button: buy it if it is not
 * owned, wear it if it is, and say so if neither is possible.
 */
export function activate(p: Profile, id: string): ActionResult {
  const item = BY_ID.get(id);
  if (!item) return 'unknown';
  if (!isUnlocked(p, id)) {
    const res = purchase(p, id);
    if (res !== 'bought') return res;
    equip(p, id);
    return 'bought';
  }
  return equip(p, id) ? 'equipped' : 'already';
}
