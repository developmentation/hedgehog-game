/**
 * The word currently being spelled.
 *
 * Owns the entry itself, which letter slots are revealed and the wrapped clue,
 * plus the two things that only make sense next to them: the word-picking
 * policy and the per-word mastery stats written back to the save.
 *
 * It has no opinion about difficulty. Which words exist, and which rung of the
 * tier ladder is live, both come from the active `LevelRun` — so a themed run,
 * a single-tier warm-up and the endless stream are the same code with a
 * different descriptor.
 *
 * It draws nothing and reads no input — the play scene asks it what letter is
 * needed and tells it when one has been earned or lost.
 */

import type { Ctx } from '../core/ctx';
import { VIEW_W } from '../core/ctx';
import { wrapText } from '../ui/text';
import { type WordEntry } from '../data/words';
import { LevelRun, DEFAULT_LEVEL } from './levels';

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
  clueLines: string[] = [];

  /** The run this session belongs to. Replaced wholesale by `configure`. */
  private run: LevelRun = new LevelRun(DEFAULT_LEVEL);
  /** The current rung's slice of the level pool, rebuilt only when it moves. */
  private tierPool: WordEntry[] = [];
  private tierPoolFor = -1;

  /** Point the session at a level. Called once when a run starts. */
  configure(run: LevelRun): void {
    this.run = run;
    this.tierPoolFor = -1;
  }

  /** The difficulty rung currently in play — still the scoring multiplier. */
  get tier(): number {
    return this.run.tier;
  }

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

  /**
   * The clue, as speech.
   *
   * The clue is the question, and it was text-only — which excluded exactly
   * the player this game is aimed at, a child who cannot read it yet. It is
   * safe to speak for the same reason it is safe to show: the word bank
   * guarantees a clue never contains the word or its first four letters.
   */
  get spokenClue(): string {
    return this.entry.clue;
  }

  /** Roll a new word for the current rung and reset progress through it. */
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

  /**
   * Step up the level's tier ladder, and only when the word was spelled
   * without breaking the combo. A single-tier level has nowhere to climb, so
   * this is a no-op there rather than a special case anywhere else.
   */
  promote(bestCombo: number): void {
    this.run.promote(bestCombo >= this.entry.word.length);
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

  /**
   * The level's pool narrowed to the current rung.
   *
   * Cached, because it only changes when the ladder moves — once every few
   * words at most — and rebuilding it per pick would allocate for nothing. A
   * rung with no words in this level's pool falls back to the whole pool, so a
   * narrow filter can never starve the picker.
   */
  private usablePool(): readonly WordEntry[] {
    const tier = this.run.tier;
    if (this.tierPoolFor === tier) return this.tierPool.length ? this.tierPool : this.run.config.pool;
    this.tierPoolFor = tier;
    this.tierPool.length = 0;
    for (const w of this.run.config.pool) if (w.tier === tier) this.tierPool.push(w);
    return this.tierPool.length ? this.tierPool : this.run.config.pool;
  }

  private pick(ctx: Ctx): WordEntry {
    const stats = ctx.save.profile.wordStats;
    const usable = this.usablePool();
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
