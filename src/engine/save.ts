/**
 * Persistent profile storage backed by IndexedDB.
 *
 * IndexedDB is the primary store (survives more aggressive eviction than
 * localStorage and has room for per-word mastery stats). localStorage acts as
 * a mirror so a failed IDB open — private browsing on some platforms — still
 * keeps the player's progress for the session.
 */

const DB_NAME = 'spindash-speller';
/**
 * 1 -> 2 added `levels`: the per-level record the level-select screen reads.
 * Nothing is required of a v1 profile — `migrate` back-fills the map — so the
 * bump is a statement about the shape rather than a gate.
 */
const DB_VERSION = 2;
const STORE = 'profile';
const KEY = 'main';
const MIRROR_KEY = 'spindash-speller:profile';

export interface WordStat {
  /** Times the word was completed. */
  wins: number;
  /** Total wrong letters across all attempts. */
  misses: number;
  /** Timestamp of the last time it was seen, ms since epoch. */
  lastSeen: number;
}

/**
 * What the player has done on one level.
 *
 * One record per level id, written by the play scene and read by the level
 * select screen. Which of the three records *means* anything depends on the
 * level's goal: a `words` level is about how cleanly you spelled and how fast,
 * a `score` level is about the number, and `endless` only ever has a best
 * score. The card decides what to show; this just keeps all of it.
 *
 * `bestTime` and `fewestMisses` carry a sentinel rather than 0 for "never",
 * because 0 is a legitimate value for both.
 */
export interface LevelRecord {
  /** The goal has been met at least once. This is what gates other levels. */
  cleared: boolean;
  /** Runs started. */
  plays: number;
  /** Highest score reached on this level. 0 = none. */
  bestScore: number;
  /** Fastest clear, in seconds. 0 = never cleared. */
  bestTime: number;
  /** Fewest wrong letters in a clear. -1 = never cleared. */
  fewestMisses: number;
}

export function emptyLevelRecord(): LevelRecord {
  return { cleared: false, plays: 0, bestScore: 0, bestTime: 0, fewestMisses: -1 };
}

export interface Profile {
  version: number;
  bestScore: number;
  totalScore: number;
  wordsCompleted: number;
  lettersSmashed: number;
  longestStreak: number;
  /** Currency spent on cosmetics. */
  sparks: number;
  unlocked: string[];
  equipped: { skin: string; trail: string; spin: string };
  settings: {
    muted: boolean;
    reducedMotion: boolean;
    highContrast: boolean;
    speechRate: number;
    /**
     * Player-chosen world-speed multiplier — see `game/settings.ts` for the
     * options and `TUNING.assist.speeds` for the numbers. Scales the scroll and,
     * with it, wall spawning; never animation or input timing.
     */
    speed: number;
    /**
     * No-penalty mode: a wrong letter still bounces and still sounds, but costs
     * no life, no points, no combo and can never trigger a setback.
     */
    easyMode: boolean;
    /**
     * Fraction of device resolution the world pass rasterises at, or
     * undefined to let the adaptive scaler own it. Persisted so a device that
     * has already been measured does not have to re-discover its ceiling on
     * every load.
     */
    renderScale?: number;
  };
  /** Per-word mastery, keyed by the word itself. */
  wordStats: Record<string, WordStat>;
  /**
   * Per-level records, keyed by `LevelDef.id`.
   *
   * Sparse on purpose: a level that has never been started has no entry, and
   * `levelRecord()` hands out a fresh blank rather than writing one, so reading
   * the select screen never dirties the profile.
   */
  levels: Record<string, LevelRecord>;
  /**
   * Words completed while `settings.easyMode` was on.
   *
   * Kept apart from `wordsCompleted` as the honest record of how the run was
   * played: easy words still count as practice (they advance the word
   * milestones, which are about learning) but the profile can always say how
   * many of them were earned with the penalties off.
   */
  easyWords: number;
  lastPlayed: number;
}

export function emptyProfile(): Profile {
  return {
    version: DB_VERSION,
    bestScore: 0,
    totalScore: 0,
    wordsCompleted: 0,
    lettersSmashed: 0,
    longestStreak: 0,
    sparks: 0,
    unlocked: ['skin/classic', 'trail/none', 'spin/classic'],
    equipped: { skin: 'skin/classic', trail: 'trail/none', spin: 'spin/classic' },
    settings: {
      muted: false,
      reducedMotion: false,
      highContrast: false,
      speechRate: 0.86,
      speed: 1,
      easyMode: false,
    },
    wordStats: {},
    levels: {},
    easyWords: 0,
    lastPlayed: 0,
  };
}

// ------------------------------------------------------------- level records

/** A finite, non-negative number, or `fallback`. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Clamp one stored level record into shape.
 *
 * Every field here came off disk and may have been written by an older build,
 * truncated, or hand-edited: the select screen prints these straight onto a
 * card, so a NaN best score would render as "NaN" and a negative play count
 * would read as nonsense. Unknown ids are kept — a level removed from this
 * build may come back, and dropping the record would lose the player's work.
 */
function sanitiseLevels(raw: unknown): Record<string, LevelRecord> {
  const out: Record<string, LevelRecord> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(raw as Record<string, unknown>)) {
    const v = (raw as Record<string, unknown>)[id] as Partial<LevelRecord> | null;
    if (!v || typeof v !== 'object') continue;
    const misses = num(v.fewestMisses, -1);
    out[id] = {
      cleared: !!v.cleared,
      plays: Math.round(num(v.plays, 0)),
      bestScore: Math.round(num(v.bestScore, 0)),
      bestTime: num(v.bestTime, 0),
      fewestMisses: misses < 0 ? -1 : Math.round(misses),
    };
  }
  return out;
}

/** This level's record. Never null; never written unless there is news. */
export function levelRecord(p: Profile, id: string): LevelRecord {
  return p.levels[id] ?? BLANK_RECORD;
}

/** The shared "nothing yet" record. Read-only by convention — never mutated. */
const BLANK_RECORD: LevelRecord = emptyLevelRecord();

function ownRecord(p: Profile, id: string): LevelRecord {
  const hit = p.levels[id];
  if (hit) return hit;
  const fresh = emptyLevelRecord();
  p.levels[id] = fresh;
  return fresh;
}

/** A run of this level has begun. */
export function noteLevelPlay(p: Profile, id: string): void {
  ownRecord(p, id).plays++;
}

/**
 * Bank a score against a level. Returns true if it is a new best.
 *
 * `ranked` is false in easy mode, where the penalties are off and a "best"
 * would mean nothing — the same rule `Profile.bestScore` already keeps. The
 * play count and the clear still happen; only the numbers are withheld.
 */
export function noteLevelScore(p: Profile, id: string, score: number, ranked: boolean): boolean {
  const rec = ownRecord(p, id);
  if (!ranked || score <= rec.bestScore) return false;
  rec.bestScore = Math.round(score);
  return true;
}

/** Which of a completed run's numbers turned out to be records. */
export interface LevelClearFlags {
  firstClear: boolean;
  bestScore: boolean;
  bestTime: boolean;
  fewestMisses: boolean;
}

/**
 * The goal was met.
 *
 * `cleared` is set whether or not the run was ranked: clearing a level is
 * progress through the game, and easy mode exists precisely so that a young
 * player gets to make that progress. The three *records* are ranked-only.
 */
export function noteLevelClear(
  p: Profile,
  id: string,
  score: number,
  seconds: number,
  misses: number,
  ranked: boolean,
  out: LevelClearFlags,
): LevelClearFlags {
  const rec = ownRecord(p, id);
  out.firstClear = !rec.cleared;
  rec.cleared = true;
  out.bestScore = ranked && score > rec.bestScore;
  if (out.bestScore) rec.bestScore = Math.round(score);
  out.bestTime = ranked && seconds > 0 && (rec.bestTime <= 0 || seconds < rec.bestTime);
  if (out.bestTime) rec.bestTime = seconds;
  out.fewestMisses = ranked && (rec.fewestMisses < 0 || misses < rec.fewestMisses);
  if (out.fewestMisses) rec.fewestMisses = misses;
  return out;
}

/** Widest multiplier a stored profile may ask the world to scroll at. */
const SPEED_MIN = 0.5;
const SPEED_MAX = 1.5;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let settled = false;
    const done = (v: IDBDatabase | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
      setTimeout(() => done(null), 2500);
    } catch {
      done(null);
    }
  });
}

export class SaveStore {
  private db: IDBDatabase | null = null;
  private ready: Promise<void>;
  private writeTimer = 0;
  private pending: Profile | null = null;

  profile: Profile = emptyProfile();

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    this.db = await openDb();
    const loaded = (await this.readIdb()) ?? this.readMirror();
    if (loaded) this.profile = this.migrate(loaded);
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private migrate(p: Partial<Profile>): Profile {
    const base = emptyProfile();
    const merged: Profile = {
      ...base,
      ...p,
      equipped: { ...base.equipped, ...(p.equipped ?? {}) },
      settings: { ...base.settings, ...(p.settings ?? {}) },
      wordStats: p.wordStats ?? {},
      levels: sanitiseLevels(p.levels),
      unlocked: Array.from(new Set([...base.unlocked, ...(p.unlocked ?? [])])),
      easyWords: Math.max(0, Math.round(p.easyWords ?? 0)) || 0,
      version: DB_VERSION,
    };
    // A stored setting is data from outside this build: a profile written by an
    // older version has no speed at all, and a hand-edited one can hold
    // anything. The scroll multiplier is the one setting that would make the
    // game unplayable if it arrived as NaN or 40, so it is clamped on the way in
    // rather than trusted on the way out.
    const s = merged.settings;
    s.speed = Number.isFinite(s.speed)
      ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, s.speed))
      : 1;
    s.easyMode = !!s.easyMode;
    // A stored render scale is data from outside this build. Out of range or
    // NaN means "let the scaler decide" rather than a broken frame buffer.
    if (s.renderScale !== undefined) {
      s.renderScale =
        Number.isFinite(s.renderScale) && s.renderScale >= 0.4 && s.renderScale <= 1
          ? s.renderScale
          : undefined;
    }
    return merged;
  }

  private readIdb(): Promise<Profile | null> {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      try {
        const tx = this.db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((req.result as Profile) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private readMirror(): Profile | null {
    try {
      const raw = localStorage.getItem(MIRROR_KEY);
      return raw ? (JSON.parse(raw) as Profile) : null;
    } catch {
      return null;
    }
  }

  /**
   * Queue a write. Saves are coalesced so a burst of score updates during a
   * dance party costs one transaction, not thirty.
   */
  save(): void {
    this.pending = this.profile;
    if (this.writeTimer) return;
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = 0;
      const p = this.pending;
      this.pending = null;
      if (p) void this.flush(p);
    }, 400);
  }

  /** Write immediately — used on pagehide, where a timer would never fire. */
  saveNow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = 0;
    }
    this.pending = null;
    void this.flush(this.profile);
  }

  private async flush(p: Profile): Promise<void> {
    p.lastPlayed = Date.now();
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify(p));
    } catch {
      /* quota or private mode — IDB is still the source of truth */
    }
    if (!this.db) return;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(p, KEY);
    } catch {
      /* ignore — mirror already holds the data */
    }
  }

  async clear(): Promise<void> {
    this.profile = emptyProfile();
    try {
      localStorage.removeItem(MIRROR_KEY);
    } catch {
      /* ignore */
    }
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
      } catch {
        /* ignore */
      }
    }
  }
}
