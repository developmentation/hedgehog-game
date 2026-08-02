/**
 * The word currently being spelled.
 *
 * Owns the entry itself, which letter slots are revealed, the difficulty tier
 * and the wrapped clue, plus the two things that only make sense next to them:
 * the word-picking policy and the per-word mastery stats written back to the
 * save.
 *
 * It draws nothing and reads no input — the play scene asks it what letter is
 * needed and tells it when one has been earned or lost.
 */

import type { Ctx } from '../core/ctx';
import { VIEW_W, clamp } from '../core/ctx';
import { wrapText } from '../ui/text';
import { WORDS, wordsByTier, type WordEntry } from '../data/words';
import { TUNING } from './tuning';

/**
 * Clue wrapping has to use the size and width the HUD renders the clue at, or
 * the lines it hands over will not fit the card.
 */
const CLUE_SIZE = 30;
const CLUE_MARGIN = 220;

/** Candidates drawn per pick — more samples means a stronger recency bias. */
const PICK_SAMPLES = 6;

export class WordSession {
  entry!: WordEntry;
  revealed: boolean[] = [];
  nextIndex = 0;
  tier = 1;
  clueLines: string[] = [];

  get word(): string {
    return this.entry.word;
  }

  /** The letter that must be smashed next. */
  get needed(): string {
    return this.entry.word[this.nextIndex];
  }

  get complete(): boolean {
    return this.nextIndex >= this.entry.word.length;
  }

  /**
   * What speech synthesis should say — the respelling when the entry has one.
   *
   * Lower-cased deliberately. The word bank stores words uppercase, and every
   * major speech engine treats an all-caps token as an initialism: "OWL" is
   * read out as "oh double-you ell", which both destroys the prompt and hands
   * the player the spelling for free. Lower-casing makes it read as a word.
   * A `say` respelling is passed through as authored, since it is already
   * written for the synthesiser.
   */
  get spoken(): string {
    return this.entry.say ?? this.entry.word.toLowerCase();
  }

  /** Roll a new word for the current tier and reset progress through it. */
  begin(ctx: Ctx): void {
    this.entry = this.pick(ctx);
    this.revealed = new Array(this.entry.word.length).fill(false);
    this.nextIndex = 0;
    this.clueLines = wrapText(this.entry.clue, CLUE_SIZE, VIEW_W - CLUE_MARGIN);
  }

  /** Bank the needed letter. Returns the slot that was filled. */
  advance(): number {
    const slot = this.nextIndex;
    this.revealed[slot] = true;
    this.nextIndex++;
    return slot;
  }

  /** Give back the most recent letter. Returns the emptied slot, or -1 if none. */
  revert(): number {
    if (this.nextIndex <= 0) return -1;
    this.nextIndex--;
    this.revealed[this.nextIndex] = false;
    return this.nextIndex;
  }

  /** Step up a tier only when the word was spelled without breaking the combo. */
  promote(bestCombo: number): void {
    this.tier = clamp(
      this.tier + (bestCombo >= this.entry.word.length ? 1 : 0),
      1,
      TUNING.scoring.maxTier,
    );
  }

  /** Fold this word's outcome into the player's per-word mastery stats. */
  recordCompletion(ctx: Ctx, misses: number): void {
    const st = (ctx.save.profile.wordStats[this.entry.word] ??= {
      wins: 0,
      misses: 0,
      lastSeen: 0,
    });
    st.wins++;
    st.misses += misses;
    st.lastSeen = Date.now();
  }

  private pick(ctx: Ctx): WordEntry {
    const stats = ctx.save.profile.wordStats;
    const pool = wordsByTier(this.tier);
    const usable = pool.length ? pool : WORDS;
    // Prefer words the player has seen least recently, so a session does not
    // repeat itself, but keep it stochastic so it never feels scripted.
    let best: WordEntry | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < PICK_SAMPLES; i++) {
      const cand = ctx.rng.pick(usable);
      const st = stats[cand.word];
      const recency = st ? -(Date.now() - st.lastSeen) / 1e7 : 0;
      const mastery = st ? st.wins * 2 - st.misses : 0;
      const s = -mastery + recency + ctx.rng.range(0, 3);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    return best ?? usable[0];
  }
}
