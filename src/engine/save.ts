/**
 * Persistent profile storage backed by IndexedDB.
 *
 * IndexedDB is the primary store (survives more aggressive eviction than
 * localStorage and has room for per-word mastery stats). localStorage acts as
 * a mirror so a failed IDB open — private browsing on some platforms — still
 * keeps the player's progress for the session.
 */

const DB_NAME = 'spindash-speller';
const DB_VERSION = 1;
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
  settings: { muted: boolean; reducedMotion: boolean; highContrast: boolean; speechRate: number };
  /** Per-word mastery, keyed by the word itself. */
  wordStats: Record<string, WordStat>;
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
    settings: { muted: false, reducedMotion: false, highContrast: false, speechRate: 0.86 },
    wordStats: {},
    lastPlayed: 0,
  };
}

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
      unlocked: Array.from(new Set([...base.unlocked, ...(p.unlocked ?? [])])),
      version: DB_VERSION,
    };
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
