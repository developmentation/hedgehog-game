/**
 * Audio bus: procedural sound effects, an adaptive music bed and spoken word
 * prompts.
 *
 * Sound effects are synthesised on demand from oscillators and shaped noise —
 * no audio files ship with the game, so there is nothing to download and every
 * sound is original. Word prompts use the platform speech synthesiser, which
 * is what makes "hear the word, spell the word" possible across hundreds of
 * words without a hundred megabytes of recordings.
 *
 * Design rules that the code below exists to enforce:
 *   - The spoken word is the most important sound in the game. SFX and music
 *     duck under it, always.
 *   - Nothing punishes. `bounce` and `setback` are soft and rounded; they say
 *     "not that one" and "you lost ground", never "you died".
 *   - `smash` fires up to ten times in a row, so it is varied per call from a
 *     deterministic counter — same character, never the same sample twice.
 *   - Every node that gets created is stopped and disconnected. Nothing is
 *     allocated per frame; the music bed schedules ahead on a timer.
 *   - If AudioContext or speechSynthesis is missing (embedded webviews), every
 *     entry point degrades to a silent no-op instead of throwing.
 */

export type SfxName =
  | 'smash'
  | 'bounce'
  | 'charge'
  | 'letterLock'
  | 'wordComplete'
  | 'unlock'
  | 'uiTap'
  | 'countdown'
  | 'setback'
  | 'comboUp';

interface VoicePick {
  voice: SpeechSynthesisVoice | null;
  rate: number;
  pitch: number;
}

interface FilterSpec {
  type: BiquadFilterType;
  /** Cutoff/centre at note start. */
  f0: number;
  /** Optional cutoff at note end — the sweep is what gives sounds movement. */
  f1?: number;
  q?: number;
}

interface TremSpec {
  hz0: number;
  hz1?: number;
  /** 0..0.5 — amplitude wobble depth. */
  depth: number;
}

interface ToneSpec {
  t: number;
  f0: number;
  f1?: number;
  type?: OscillatorType;
  attack?: number;
  decay: number;
  peak: number;
  filter?: FilterSpec;
  trem?: TremSpec;
  pan?: number;
  detune?: number;
  dest?: AudioNode;
}

interface NoiseSpec {
  t: number;
  dur: number;
  peak: number;
  attack?: number;
  filter?: FilterSpec;
  pan?: number;
  dest?: AudioNode;
}

const MASTER_GAIN = 0.9;
/**
 * Per-effect trim, measured by rendering each sound through the full chain in
 * an OfflineAudioContext. The layer peaks in `play()` are *pre-filter*, and a
 * steep bandpass on noise throws away most of that amplitude, so the raw
 * numbers say nothing about how loud a sound actually lands. These bring every
 * effect to its intended level in the final mix: smash is the loudest thing in
 * the game, wordComplete the payoff, UI ticks well underneath.
 */
const TRIM: Record<SfxName, number> = {
  smash: 2.7,
  bounce: 1.65,
  charge: 1.25,
  letterLock: 1.9,
  wordComplete: 1.75,
  unlock: 1.65,
  uiTap: 3.0,
  countdown: 3.2,
  setback: 1.4,
  comboUp: 2.9,
};
/** How far SFX and music drop while a word is being spoken. */
const DUCK_SFX = 0.32;
const DUCK_MUSIC = 0.1;
/** Polyphony cap — a runaway effect can never grow the graph without bound. */
const MAX_ACTIVE_SOURCES = 72;

// --- Music bed -------------------------------------------------------------
const BPM = 92;
/** Eighth-note grid. */
const STEP = 30 / BPM;
const STEPS_PER_CHORD = 16;
/** How far ahead the scheduler writes events, and how often it wakes up. */
const LOOKAHEAD = 0.9;
const TICK_MS = 180;

interface Chord {
  pad: [number, number, number];
  bass: number;
  arp: number[];
}

/**
 * A-minor loop with close voice-leading, so chord changes glide rather than
 * lurch. Deliberately consonant and static — it sits under the word, not over.
 */
const CHORDS: Chord[] = [
  { pad: [220.0, 261.63, 329.63], bass: 110.0, arp: [220.0, 261.63, 329.63, 392.0, 523.25] },
  { pad: [174.61, 261.63, 329.63], bass: 87.31, arp: [174.61, 261.63, 329.63, 440.0, 523.25] },
  { pad: [196.0, 261.63, 329.63], bass: 130.81, arp: [196.0, 261.63, 329.63, 392.0, 493.88] },
  { pad: [196.0, 246.94, 329.63], bass: 98.0, arp: [196.0, 246.94, 329.63, 392.0, 587.33] },
];
/** Up-and-back arpeggio figure over the chord's five available notes. */
const ARP_PATTERN = [0, 1, 2, 3, 4, 3, 2, 1];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Deterministic pseudo-noise in -1..1 — used to vary repeated impacts. */
function jitter(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export class AudioBus {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfxBus: GainNode | null = null;
  musicBus: GainNode | null = null;

  muted = false;
  /** Speech is unavailable on some embedded browsers; UI adapts when false. */
  speechAvailable = false;

  private limiter: DynamicsCompressorNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private sfxDuck: GainNode | null = null;
  private musicDuck: GainNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private voice: VoicePick = { voice: null, rate: 0.86, pitch: 1.0 };
  private unlocked = false;
  private comboStep = 0;
  private smashCount = 0;

  /** Every scheduled one-shot source, so it can be torn down deterministically. */
  private active = new Set<AudioScheduledSourceNode>();

  // Speech state.
  private speechInit = false;
  private speechGen = 0;
  private speechSettle: (() => void) | null = null;
  private speechWatchdog: number | null = null;
  private speechStartTimer: number | null = null;
  private voicePoll: number | null = null;
  private onVoicesChanged: (() => void) | null = null;
  private duckCount = 0;

  // Music state.
  private musicStarted = false;
  private musicWanted = true;
  private musicTimer: number | null = null;
  private musicGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private padGain: GainNode | null = null;
  private padOsc: OscillatorNode[] = [];
  private padLfo: OscillatorNode | null = null;
  private padLfoGain: GainNode | null = null;
  private nextStepTime = 0;
  private stepIndex = 0;
  private intensity = 0;
  private intensityApplied = -1;

  private onVisibility: (() => void) | null = null;

  /**
   * Must be called from a user gesture. Browsers refuse to start an
   * AudioContext otherwise, and iOS additionally requires the first speech
   * utterance to originate from a gesture.
   */
  unlock(): void {
    if (!this.unlocked) {
      try {
        const Ctor = window.AudioContext || (window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        if (!Ctor) throw new Error('no AudioContext');
        const ctx: AudioContext = new Ctor({ latencyHint: 'interactive' });
        this.ctx = ctx;

        // A gentle limiter on the way out: ten smashes in a row must not clip.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -9;
        limiter.knee.value = 8;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.22;
        this.limiter = limiter;

        // ...and a soft-clip ceiling behind it, because the compressor's attack
        // still lets the first sample of a stacked transient through. Linear
        // below 0.7, so it is inaudible during normal play, and mathematically
        // incapable of emitting a sample past ~0.93.
        const shaper = ctx.createWaveShaper();
        const n = 1024;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          const a = Math.abs(x);
          const y = a <= 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
          curve[i] = x < 0 ? -y : y;
        }
        shaper.curve = curve;
        shaper.oversample = '2x';
        limiter.connect(shaper);
        shaper.connect(ctx.destination);
        this.shaper = shaper;

        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
        this.master.connect(limiter);

        // Duck stages sit between each bus and the master so `sfxBus` /
        // `musicBus` stay free for callers to set a static mix level.
        this.sfxDuck = ctx.createGain();
        this.sfxDuck.gain.value = 1;
        this.sfxDuck.connect(this.master);

        this.musicDuck = ctx.createGain();
        this.musicDuck.gain.value = 1;
        this.musicDuck.connect(this.master);

        this.sfxBus = ctx.createGain();
        this.sfxBus.gain.value = 0.85;
        this.sfxBus.connect(this.sfxDuck);

        this.musicBus = ctx.createGain();
        this.musicBus.gain.value = 0.5;
        this.musicBus.connect(this.musicDuck);

        // 2s of white noise, reused for every impact/percussion sound.
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buf;

        // Tab switches, phone calls and OS audio focus changes all suspend the
        // context behind our back; nothing here is fatal, so just re-resume.
        ctx.onstatechange = () => {
          if (ctx.state !== 'running' && !this.isHidden()) void this.resumeContext();
        };
        this.onVisibility = () => {
          if (this.isHidden()) {
            this.stopMusicClock();
          } else {
            void this.resumeContext();
            this.resyncMusic();
          }
        };
        document.addEventListener?.('visibilitychange', this.onVisibility);

        void this.resumeContext();
        this.unlocked = true;
      } catch (err) {
        console.warn('audio: unavailable', err);
        this.ctx = null;
      }
    }

    this.initSpeech();
    if (this.unlocked && this.musicWanted) this.startMusic();
  }

  private isHidden(): boolean {
    try {
      return typeof document !== 'undefined' && document.hidden === true;
    } catch {
      return false;
    }
  }

  /** Nudge a context the browser suspended out from under us. */
  private resumeContext(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve();
    try {
      const p = ctx.resume?.();
      return p && typeof p.then === 'function' ? p.catch(() => undefined) : Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // Synth primitives
  // -------------------------------------------------------------------------

  /**
   * Take ownership of a scheduled source: start it, stop it, and disconnect
   * the whole chain the moment it ends. Without this the graph grows by a
   * handful of nodes per smash and never shrinks.
   */
  private own(
    src: AudioScheduledSourceNode,
    chain: AudioNode[],
    start: number,
    stop: number,
  ): void {
    const clean = (): void => {
      if (!this.active.delete(src)) return;
      src.onended = null;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      for (const n of chain) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
    src.onended = clean;
    this.active.add(src);
    try {
      src.start(start);
      src.stop(stop);
    } catch {
      clean();
    }
  }

  /** Percussive amplitude envelope that always lands on true zero. */
  private ampEnv(t: number, attack: number, decay: number, peak: number): GainNode {
    const g = this.ctx!.createGain();
    const p = Math.max(peak, 0.0001);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(p, t + attack);
    g.gain.exponentialRampToValueAtTime(p * 0.0006, t + attack + decay);
    g.gain.linearRampToValueAtTime(0, t + attack + decay + 0.012);
    return g;
  }

  private makeFilter(spec: FilterSpec, t: number, end: number): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = spec.type;
    f.Q.value = spec.q ?? 0.7;
    const a = Math.max(20, spec.f0);
    f.frequency.setValueAtTime(a, t);
    if (spec.f1 !== undefined && spec.f1 !== spec.f0) {
      f.frequency.exponentialRampToValueAtTime(Math.max(20, spec.f1), end);
    }
    return f;
  }

  private panner(pan: number | undefined): StereoPannerNode | null {
    const ctx = this.ctx!;
    if (!pan || typeof ctx.createStereoPanner !== 'function') return null;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }

  private tone(spec: ToneSpec): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.active.size > MAX_ACTIVE_SOURCES) return;
    const attack = spec.attack ?? 0.004;
    const t = spec.t;
    const end = t + attack + spec.decay;
    const chain: AudioNode[] = [];

    const osc = ctx.createOscillator();
    osc.type = spec.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, spec.f0), t);
    if (spec.f1 !== undefined && spec.f1 !== spec.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.f1), end);
    }
    if (spec.detune) osc.detune.value = spec.detune;

    let node: AudioNode = osc;
    if (spec.filter) {
      const f = this.makeFilter(spec.filter, t, end);
      node.connect(f);
      chain.push(f);
      node = f;
    }

    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (spec.trem && spec.trem.depth > 0) {
      const depth = clamp(spec.trem.depth, 0, 0.5);
      const trem = ctx.createGain();
      trem.gain.value = 1 - depth;
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(spec.trem.hz0, t);
      if (spec.trem.hz1) lfo.frequency.exponentialRampToValueAtTime(Math.max(0.1, spec.trem.hz1), end);
      lfoGain = ctx.createGain();
      lfoGain.gain.value = depth;
      lfo.connect(lfoGain);
      lfoGain.connect(trem.gain);
      node.connect(trem);
      chain.push(trem);
      node = trem;
    }

    const env = this.ampEnv(t, attack, spec.decay, spec.peak);
    node.connect(env);
    chain.push(env);
    node = env;

    const pan = this.panner(spec.pan);
    if (pan) {
      node.connect(pan);
      chain.push(pan);
      node = pan;
    }
    node.connect(spec.dest ?? this.sfxBus!);

    const stop = end + 0.05;
    this.own(osc, chain, t, stop);
    if (lfo && lfoGain) this.own(lfo, [lfoGain], t, stop);
  }

  private noise(spec: NoiseSpec): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer) return;
    if (this.active.size > MAX_ACTIVE_SOURCES) return;
    const attack = spec.attack ?? 0.002;
    const t = spec.t;
    const end = t + attack + spec.dur;
    const chain: AudioNode[] = [];

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Start from a different point each time so repeated hits never phase-lock.
    const offset = (this.smashCount * 0.137 + this.active.size * 0.041) % 1.9;

    let node: AudioNode = src;
    if (spec.filter) {
      const f = this.makeFilter(spec.filter, t, end);
      node.connect(f);
      chain.push(f);
      node = f;
    }
    const env = this.ampEnv(t, attack, spec.dur, spec.peak);
    node.connect(env);
    chain.push(env);
    node = env;

    const pan = this.panner(spec.pan);
    if (pan) {
      node.connect(pan);
      chain.push(pan);
      node = pan;
    }
    node.connect(spec.dest ?? this.sfxBus!);

    const stop = end + 0.05;
    const clean = (): void => {
      if (!this.active.delete(src)) return;
      src.onended = null;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      for (const n of chain) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
    src.onended = clean;
    this.active.add(src);
    try {
      src.start(t, offset);
      src.stop(stop);
    } catch {
      clean();
    }
  }

  // -------------------------------------------------------------------------
  // Sound effects
  // -------------------------------------------------------------------------

  play(name: SfxName, intensity = 1): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    if (ctx.state !== 'running') {
      // Scheduling against a frozen clock would dump every queued sound at
      // once when the context wakes. Drop the effect and get the clock back.
      void this.resumeContext();
      return;
    }
    const t = ctx.currentTime + 0.004;
    const v = clamp(intensity, 0, 1.6) * TRIM[name];

    switch (name) {
      case 'smash':
        this.smash(t, v);
        break;

      case 'bounce':
        // Soft, rounded, low — "not that one", never "you died".
        this.tone({
          t,
          f0: 300,
          f1: 186,
          type: 'sine',
          attack: 0.012,
          decay: 0.24,
          peak: 0.24 * v,
          filter: { type: 'lowpass', f0: 1400, f1: 700 },
        });
        this.tone({
          t: t + 0.006,
          f0: 452,
          f1: 302,
          type: 'sine',
          attack: 0.016,
          decay: 0.15,
          peak: 0.09 * v,
          filter: { type: 'lowpass', f0: 1800, f1: 820 },
        });
        this.noise({
          t,
          dur: 0.05,
          attack: 0.004,
          peak: 0.07 * v,
          filter: { type: 'lowpass', f0: 900, f1: 380, q: 0.7 },
        });
        break;

      case 'charge':
        // Spin-dash rev: rising saw behind an opening filter, with a rotational
        // chatter from the tremolo and a friction hiss on top.
        this.tone({
          t,
          f0: 96,
          f1: 520,
          type: 'sawtooth',
          attack: 0.05,
          decay: 0.4,
          peak: 0.15 * v,
          filter: { type: 'lowpass', f0: 560, f1: 3000, q: 4 },
          trem: { hz0: 14, hz1: 46, depth: 0.4 },
        });
        this.noise({
          t,
          dur: 0.4,
          attack: 0.07,
          peak: 0.09 * v,
          filter: { type: 'bandpass', f0: 800, f1: 3400, q: 1.4 },
        });
        break;

      case 'letterLock':
        this.tone({ t, f0: 880, decay: 0.11, peak: 0.16 * v, attack: 0.002, type: 'sine' });
        this.tone({ t, f0: 1760, decay: 0.05, peak: 0.055 * v, attack: 0.001, type: 'sine' });
        this.tone({
          t: t + 0.045,
          f0: 1318.5,
          decay: 0.13,
          peak: 0.11 * v,
          attack: 0.002,
          type: 'triangle',
          filter: { type: 'lowpass', f0: 4200 },
        });
        this.noise({
          t,
          dur: 0.02,
          attack: 0.001,
          peak: 0.06 * v,
          filter: { type: 'highpass', f0: 3800 },
        });
        break;

      case 'comboUp': {
        // Rising pentatonic ladder — each consecutive hit climbs one step, and
        // gets a touch brighter, so a long chain audibly builds.
        const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
        const semis = steps[Math.min(this.comboStep, steps.length - 1)];
        this.comboStep++;
        const bright = Math.min(1, 0.55 + this.comboStep * 0.06);
        const f = 523.25 * Math.pow(2, semis / 12);
        this.tone({
          t,
          f0: f,
          type: 'triangle',
          attack: 0.003,
          decay: 0.2,
          peak: 0.16 * v,
          filter: { type: 'lowpass', f0: 2400 + semis * 260, q: 1 },
        });
        this.tone({ t, f0: f * 2.01, type: 'sine', attack: 0.002, decay: 0.11, peak: 0.06 * v * bright });
        this.tone({
          t: t + 0.004,
          f0: f * 3,
          type: 'sine',
          attack: 0.001,
          decay: 0.06,
          peak: 0.03 * v * bright,
        });
        break;
      }

      case 'wordComplete': {
        // Arpeggiated major-ninth with an octave sparkle on each note, a warm
        // bed underneath and a shimmer that opens upward as it fades.
        const notes = [523.25, 659.25, 783.99, 987.77, 1174.66];
        for (let i = 0; i < notes.length; i++) {
          const tt = t + i * 0.07;
          this.tone({
            t: tt,
            f0: notes[i],
            type: 'triangle',
            attack: 0.004,
            decay: 0.5 + i * 0.08,
            peak: 0.14 * v,
            filter: { type: 'lowpass', f0: 5200, f1: 1800, q: 0.8 },
            pan: (i - 2) * 0.12,
          });
          this.tone({
            t: tt,
            f0: notes[i] * 2,
            type: 'sine',
            attack: 0.003,
            decay: 0.22,
            peak: 0.045 * v,
          });
        }
        this.tone({ t, f0: 261.63, type: 'sine', attack: 0.06, decay: 0.9, peak: 0.09 * v });
        this.tone({ t, f0: 392.0, type: 'sine', attack: 0.07, decay: 0.85, peak: 0.07 * v });
        this.noise({
          t: t + 0.05,
          dur: 1.05,
          attack: 0.28,
          peak: 0.06 * v,
          filter: { type: 'bandpass', f0: 2600, f1: 9000, q: 1.1 },
        });
        this.tone({ t: t + 0.34, f0: 2093, type: 'sine', attack: 0.02, decay: 0.85, peak: 0.04 * v });
        break;
      }

      case 'unlock': {
        const chord = [659.25, 987.77, 1318.5];
        for (let i = 0; i < chord.length; i++) {
          this.tone({
            t: t + i * 0.075,
            f0: chord[i],
            f1: chord[i] * 1.5,
            type: 'sine',
            attack: 0.012,
            decay: 0.42,
            peak: 0.13 * v,
          });
        }
        this.noise({
          t,
          dur: 0.5,
          attack: 0.2,
          peak: 0.05 * v,
          filter: { type: 'bandpass', f0: 1200, f1: 6000, q: 1 },
        });
        break;
      }

      case 'uiTap':
        this.noise({
          t,
          dur: 0.022,
          attack: 0.001,
          peak: 0.12 * v,
          filter: { type: 'bandpass', f0: 2200, q: 0.8 },
        });
        this.tone({ t, f0: 920, f1: 700, type: 'sine', attack: 0.001, decay: 0.05, peak: 0.09 * v });
        break;

      case 'countdown':
        this.tone({
          t,
          f0: 660,
          f1: 640,
          type: 'sine',
          attack: 0.002,
          decay: 0.11,
          peak: 0.15 * v,
          filter: { type: 'lowpass', f0: 3200 },
        });
        this.tone({ t, f0: 1320, type: 'sine', attack: 0.001, decay: 0.05, peak: 0.05 * v });
        this.noise({
          t,
          dur: 0.02,
          attack: 0.001,
          peak: 0.05 * v,
          filter: { type: 'highpass', f0: 3000 },
        });
        break;

      case 'setback':
        // Deflation, not death: everything slides down and closes, then a soft
        // landing. No dissonance, no harsh top end.
        this.tone({
          t,
          f0: 300,
          f1: 96,
          type: 'triangle',
          attack: 0.02,
          decay: 0.6,
          peak: 0.2 * v,
          filter: { type: 'lowpass', f0: 2200, f1: 420, q: 1.2 },
          trem: { hz0: 9, hz1: 3, depth: 0.22 },
        });
        this.tone({ t, f0: 150, f1: 52, type: 'sine', attack: 0.03, decay: 0.58, peak: 0.15 * v });
        this.noise({
          t,
          dur: 0.55,
          attack: 0.05,
          peak: 0.11 * v,
          filter: { type: 'bandpass', f0: 1800, f1: 280, q: 0.9 },
        });
        this.tone({ t: t + 0.5, f0: 86, f1: 52, type: 'sine', attack: 0.008, decay: 0.26, peak: 0.19 * v });
        this.noise({
          t: t + 0.5,
          dur: 0.14,
          attack: 0.004,
          peak: 0.06 * v,
          filter: { type: 'lowpass', f0: 700, f1: 200 },
        });
        break;
    }
  }

  /**
   * Heavy, satisfying break in four layers: transient click, a broadband crack
   * whose filter sweeps down as the material gives, a pitched body with sub
   * weight, and scattering shards over a dust tail. Every call is detuned,
   * re-panned and re-levelled from a counter so ten in a row never fatigue.
   */
  private smash(t: number, v: number): void {
    const n = this.smashCount++;
    const j = jitter(n);
    const j2 = jitter(n * 7 + 3);
    const pan = j * 0.3;
    const p = 0.94 + j2 * 0.07;
    const lvl = v * (0.94 + j * 0.06);

    // 1. Transient — the instant of contact.
    this.noise({
      t,
      dur: 0.012,
      attack: 0.0005,
      peak: 0.5 * lvl,
      filter: { type: 'highpass', f0: 2600 },
      pan,
    });
    // 2. Crack — broadband, sweeping down as the block gives way.
    this.noise({
      t: t + 0.002,
      dur: 0.13,
      attack: 0.002,
      peak: 0.4 * lvl,
      filter: { type: 'bandpass', f0: 5200 * p, f1: 900 * p, q: 0.7 },
      pan,
    });
    // 3. Body — the block's own pitched resonance.
    this.tone({
      t,
      f0: 232 * p,
      f1: 62 * p,
      type: 'triangle',
      attack: 0.002,
      decay: 0.19,
      peak: 0.32 * lvl,
      filter: { type: 'lowpass', f0: 2400, f1: 600, q: 0.8 },
      pan: pan * 0.5,
    });
    // 4. Sub weight.
    this.tone({ t, f0: 120 * p, f1: 44, type: 'sine', attack: 0.004, decay: 0.16, peak: 0.28 * lvl });
    // 5. Shards flying off, panned opposite the impact.
    for (let i = 0; i < 2; i++) {
      const jf = jitter(n * 13 + i * 29);
      const oct = i === 0 ? 1 : 1.6;
      this.tone({
        t: t + 0.012 + i * 0.026 + Math.abs(jf) * 0.02,
        f0: (1900 + jf * 520) * oct,
        f1: (1500 + jf * 400) * oct,
        type: 'sine',
        attack: 0.001,
        decay: 0.07 + 0.03 * Math.abs(jf),
        peak: 0.09 * lvl,
        pan: -pan,
      });
    }
    // 6. Dust tail.
    this.noise({
      t: t + 0.02,
      dur: 0.3,
      attack: 0.01,
      peak: 0.11 * lvl,
      filter: { type: 'lowpass', f0: 1400, f1: 320, q: 0.6 },
      pan: pan * 0.4,
    });
  }

  /** Reset the combo ladder so the next `comboUp` starts from the bottom. */
  resetCombo(): void {
    this.comboStep = 0;
  }

  // -------------------------------------------------------------------------
  // Music bed
  // -------------------------------------------------------------------------

  /**
   * Slow procedural pad + arpeggio. Persistent oscillators carry the pad (no
   * allocation for chord changes); only short arp/bass notes are created, at
   * most a handful per second, and each disconnects itself when it ends.
   */
  startMusic(): void {
    const ctx = this.ctx;
    this.musicWanted = true;
    if (!ctx || this.musicStarted || !this.musicBus) return;
    this.musicStarted = true;

    const now = ctx.currentTime;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(this.cutoffFor(this.intensity), now);
    this.musicFilter = filter;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(this.levelFor(this.intensity), now + 3);
    gain.connect(this.musicBus);
    filter.connect(gain);
    this.musicGain = gain;

    const pad = ctx.createGain();
    pad.gain.value = 0.5;
    pad.connect(filter);
    this.padGain = pad;

    // Slow breathing on the cutoff keeps a static chord from sounding dead.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start(now);
    this.padLfo = lfo;
    this.padLfoGain = lfoGain;

    const chord = CHORDS[0];
    for (let i = 0; i < 3; i++) {
      for (let d = 0; d < 2; d++) {
        const o = ctx.createOscillator();
        o.type = d === 0 ? 'sine' : 'triangle';
        o.frequency.setValueAtTime(chord.pad[i], now);
        o.detune.value = d === 0 ? -6 : 6;
        const vg = ctx.createGain();
        vg.gain.value = d === 0 ? 0.22 : 0.11;
        o.connect(vg);
        vg.connect(pad);
        o.start(now);
        this.padOsc.push(o);
      }
    }

    this.stepIndex = 0;
    this.nextStepTime = now + 0.15;
    // The fade-in above already targets the current intensity; scheduling a
    // second automation on top of it here would fight the ramp.
    this.intensityApplied = this.intensity;
    this.startMusicClock();
  }

  stopMusic(): void {
    this.musicWanted = false;
    this.stopMusicClock();
    const ctx = this.ctx;
    if (!ctx || !this.musicStarted) return;
    this.musicStarted = false;
    const now = ctx.currentTime;
    const g = this.musicGain;
    if (g) {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), now);
        g.gain.linearRampToValueAtTime(0, now + 0.5);
      } catch {
        /* ignore */
      }
    }
    const dead: AudioNode[] = [];
    if (this.musicFilter) dead.push(this.musicFilter);
    if (this.padGain) dead.push(this.padGain);
    if (this.padLfoGain) dead.push(this.padLfoGain);
    if (g) dead.push(g);
    const oscs = this.padOsc.slice();
    if (this.padLfo) oscs.push(this.padLfo);
    for (const o of oscs) {
      try {
        o.stop(now + 0.6);
      } catch {
        /* ignore */
      }
      o.onended = () => {
        try {
          o.disconnect();
        } catch {
          /* ignore */
        }
      };
    }
    // Tear the shared chain down once, after the fade has finished.
    window.setTimeout(() => {
      for (const n of dead) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
    }, 900);
    this.padOsc = [];
    this.padLfo = null;
    this.padLfoGain = null;
    this.padGain = null;
    this.musicFilter = null;
    this.musicGain = null;
  }

  private startMusicClock(): void {
    if (this.musicTimer !== null || !this.musicStarted) return;
    this.musicTimer = window.setInterval(() => this.tickMusic(), TICK_MS);
  }

  private stopMusicClock(): void {
    if (this.musicTimer === null) return;
    window.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  /** After a tab switch the audio clock has moved on without us. */
  private resyncMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicStarted) return;
    this.nextStepTime = ctx.currentTime + 0.1;
    this.startMusicClock();
  }

  private tickMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicStarted || this.muted) return;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.nextStepTime < now - 0.4 || this.nextStepTime > now + 5) {
      this.nextStepTime = now + 0.08;
    }
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this.nextStepTime < horizon && guard++ < 32) {
      this.scheduleStep(this.stepIndex, this.nextStepTime);
      this.stepIndex = (this.stepIndex + 1) % (STEPS_PER_CHORD * CHORDS.length);
      this.nextStepTime += STEP;
    }
  }

  private scheduleStep(step: number, t: number): void {
    const chordIndex = Math.floor(step / STEPS_PER_CHORD) % CHORDS.length;
    const chord = CHORDS[chordIndex];
    const local = step % STEPS_PER_CHORD;
    const i = this.intensity;

    // Chord change: glide the persistent pad oscillators to the new voicing.
    if (local === 0) {
      for (let vIdx = 0; vIdx < 3; vIdx++) {
        for (let d = 0; d < 2; d++) {
          const osc = this.padOsc[vIdx * 2 + d];
          if (!osc) continue;
          try {
            osc.frequency.cancelScheduledValues(t);
            osc.frequency.setValueAtTime(osc.frequency.value, t);
            osc.frequency.exponentialRampToValueAtTime(chord.pad[vIdx], t + 0.5);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const dest = this.musicFilter;
    if (!dest) return;

    // Bass pulse twice a bar.
    if (local === 0 || local === 8) {
      this.tone({
        t,
        f0: chord.bass,
        type: 'sine',
        attack: 0.02,
        decay: 1.1,
        peak: 0.16 + 0.12 * i,
        dest,
      });
    }

    // Arpeggio: silent when calm, half-time in the middle, full eighths when
    // the player is on a run.
    if (i < 0.06) return;
    const dense = i > 0.45;
    if (!dense && local % 2 !== 0) return;
    const note = chord.arp[ARP_PATTERN[local % ARP_PATTERN.length]];
    const level = (0.05 + 0.13 * i) * (dense ? 1 : 0.85);
    this.tone({
      t,
      f0: note,
      type: 'triangle',
      attack: 0.008,
      decay: 0.34 + 0.2 * i,
      peak: level,
      filter: { type: 'lowpass', f0: 1800 + 2600 * i, q: 0.8 },
      pan: (local % 4) * 0.12 - 0.18,
      dest,
    });
    if (i > 0.72 && local % 4 === 0) {
      this.tone({
        t,
        f0: note * 2,
        type: 'sine',
        attack: 0.005,
        decay: 0.25,
        peak: 0.04 * i,
        dest,
      });
    }
  }

  private levelFor(i: number): number {
    return 0.12 + 0.2 * i;
  }

  private cutoffFor(i: number): number {
    return 420 + 2900 * Math.pow(i, 1.4);
  }

  /**
   * Drive from combo/pace: 0 is a bare pad, 1 is a full arpeggio. Cheap enough
   * to call every frame — it ignores changes below the audible threshold.
   */
  setIntensity(v: number): void {
    const t = clamp(v, 0, 1);
    if (Math.abs(t - this.intensity) < 0.02) return;
    this.intensity = t;
    this.applyIntensity();
  }

  private applyIntensity(): void {
    if (!this.ctx || !this.musicStarted) return;
    if (Math.abs(this.intensity - this.intensityApplied) < 0.02) return;
    this.intensityApplied = this.intensity;
    if (this.musicGain) this.glide(this.musicGain.gain, this.levelFor(this.intensity), 0.9);
    if (this.musicFilter) this.glide(this.musicFilter.frequency, this.cutoffFor(this.intensity), 0.7);
  }

  /**
   * Retarget a param without fighting whatever automation is already queued on
   * it — the music fade-in and an intensity change can otherwise overlap.
   */
  private glide(p: AudioParam, target: number, tc: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(now);
      else {
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
      }
      p.setTargetAtTime(target, now, tc);
    } catch {
      try {
        p.value = target;
      } catch {
        /* ignore */
      }
    }
  }

  /** Current adaptive-music intensity, 0..1. */
  getIntensity(): number {
    return this.intensity;
  }

  // -------------------------------------------------------------------------
  // Ducking
  // -------------------------------------------------------------------------

  /**
   * Pull SFX and music down so the spoken word stays intelligible. Reference
   * counted, so overlapping calls can't leave the mix stuck quiet.
   */
  duckForSpeech(): void {
    this.duckCount++;
    if (this.duckCount === 1) this.rampDuck(DUCK_SFX, DUCK_MUSIC, 0.08);
  }

  unduck(): void {
    if (this.duckCount === 0) return;
    this.duckCount--;
    if (this.duckCount === 0) this.rampDuck(1, 1, 0.35);
  }

  private rampDuck(sfx: number, music: number, time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const set = (g: GainNode | null, target: number): void => {
      if (!g) return;
      try {
        if (typeof g.gain.cancelAndHoldAtTime === 'function') g.gain.cancelAndHoldAtTime(now);
        else {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(g.gain.value, now);
        }
        g.gain.linearRampToValueAtTime(target, now + time);
      } catch {
        g.gain.value = target;
      }
    };
    set(this.sfxDuck, sfx);
    set(this.musicDuck, music);
  }

  // -------------------------------------------------------------------------
  // Speech
  // -------------------------------------------------------------------------

  private initSpeech(): void {
    if (this.speechInit) return;
    let synth: SpeechSynthesis | null = null;
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      synth = window.speechSynthesis;
      if (!synth || typeof synth.speak !== 'function') return;
      if (typeof SpeechSynthesisUtterance !== 'function') return;
    } catch {
      return;
    }
    this.speechInit = true;
    this.speechAvailable = true;

    const choose = (): boolean => {
      let voices: SpeechSynthesisVoice[] = [];
      try {
        voices = synth!.getVoices() ?? [];
      } catch {
        return false;
      }
      if (!voices.length) return false;
      // Prefer a natural-sounding en-GB/en-US voice; fall back to any English.
      const score = (v: SpeechSynthesisVoice): number => {
        let s = 0;
        const n = (v.name || '').toLowerCase();
        if (/^en[-_]/i.test(v.lang)) s += 10;
        if (v.localService) s += 2;
        if (/natural|neural|premium|enhanced|siri/.test(n)) s += 6;
        if (/google/.test(n)) s += 4;
        if (/zira|david|mark/.test(n)) s += 1;
        if (/compact|espeak/.test(n)) s -= 4;
        return s;
      };
      const english = voices.filter((v) => /^en/i.test(v.lang || ''));
      const best = (english.length ? english : voices).slice().sort((a, b) => score(b) - score(a))[0];
      if (!best) return false;
      this.voice = { voice: best, rate: 0.86, pitch: 1.0 };
      return true;
    };

    // Voices arrive asynchronously nearly everywhere, and the `voiceschanged`
    // event is unreliable on Safari and old Chrome — so listen *and* poll,
    // and stop doing both the moment a voice is picked.
    const stopWatching = (): void => {
      if (this.voicePoll !== null) {
        window.clearInterval(this.voicePoll);
        this.voicePoll = null;
      }
      if (this.onVoicesChanged) {
        try {
          synth!.removeEventListener?.('voiceschanged', this.onVoicesChanged);
        } catch {
          /* ignore */
        }
        this.onVoicesChanged = null;
      }
    };

    if (!choose()) {
      this.onVoicesChanged = () => {
        if (choose()) stopWatching();
      };
      try {
        synth.addEventListener?.('voiceschanged', this.onVoicesChanged);
      } catch {
        /* ignore */
      }
      let tries = 0;
      this.voicePoll = window.setInterval(() => {
        if (choose() || ++tries > 24) stopWatching();
      }, 200);
    }

    // iOS only permits speech that descends from a user gesture; a silent
    // priming utterance here buys the right to speak later.
    try {
      const prime = new SpeechSynthesisUtterance(' ');
      prime.volume = 0;
      synth.speak(prime);
      synth.cancel();
    } catch {
      /* ignore */
    }
  }

  /** Speak a word aloud. Resolves when the utterance ends, errors or is cancelled. */
  speak(text: string, opts: { rate?: number; pitch?: number } = {}): Promise<void> {
    const words = (text ?? '').toString().trim();
    if (!this.speechAvailable || this.muted || !words) return Promise.resolve();

    // Supersede whatever was speaking: its promise settles now, and its
    // watchdog is torn down before the new one is armed.
    const prev = this.speechSettle;
    this.speechSettle = null;
    this.clearSpeechTimers();
    const gen = ++this.speechGen;
    if (prev) prev();

    return new Promise<void>((resolve) => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        if (this.speechGen === gen) {
          this.clearSpeechTimers();
          this.speechSettle = null;
        }
        this.unduck();
        resolve();
      };
      this.speechSettle = settle;
      this.duckForSpeech();

      const rate = clamp(opts.rate ?? this.voice.rate, 0.4, 3);
      // Generous: the watchdog below detects the real end. This only exists so
      // a synthesiser that dies mid-word can never wedge the game.
      const hardCapMs = Math.max(5000, (1500 + words.length * 320) / rate);

      const begin = (): void => {
        this.speechStartTimer = null;
        if (this.speechGen !== gen) {
          settle();
          return;
        }
        try {
          const u = new SpeechSynthesisUtterance(words);
          if (this.voice.voice) u.voice = this.voice.voice;
          u.rate = rate;
          u.pitch = clamp(opts.pitch ?? this.voice.pitch, 0, 2);
          u.volume = 1;
          u.onend = settle;
          u.onerror = settle;
          speechSynthesis.speak(u);
        } catch {
          settle();
          return;
        }

        const t0 = Date.now();
        let sawSpeaking = false;
        let quiet = 0;
        let lastPump = t0;
        this.speechWatchdog = window.setInterval(() => {
          if (this.speechGen !== gen) {
            settle();
            return;
          }
          let speaking = false;
          try {
            speaking = speechSynthesis.speaking || speechSynthesis.pending;
          } catch {
            /* treat as not speaking */
          }
          if (speaking) {
            sawSpeaking = true;
            quiet = 0;
            // Chrome silently stalls the synthesiser after ~15s of speech;
            // a periodic resume() re-arms the queue. Harmless when idle.
            if (Date.now() - lastPump > 5000) {
              lastPump = Date.now();
              try {
                speechSynthesis.resume();
              } catch {
                /* ignore */
              }
            }
          } else {
            quiet++;
            // Ended without ever firing `onend` (several mobile engines).
            if (sawSpeaking && quiet >= 2) {
              settle();
              return;
            }
            // Never started at all — the engine swallowed the utterance.
            if (!sawSpeaking && Date.now() - t0 > 2500) {
              settle();
              return;
            }
          }
          if (Date.now() - t0 > hardCapMs) settle();
        }, 250);
      };

      // Chrome drops an utterance queued in the same task as cancel(); the
      // short gap is what makes back-to-back speak() calls reliable.
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      this.speechStartTimer = window.setTimeout(begin, 70);
    });
  }

  cancelSpeech(): void {
    const prev = this.speechSettle;
    this.speechSettle = null;
    this.speechGen++;
    this.clearSpeechTimers();
    if (this.speechAvailable) {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    if (prev) prev();
  }

  private clearSpeechTimers(): void {
    if (this.speechWatchdog !== null) {
      window.clearInterval(this.speechWatchdog);
      this.speechWatchdog = null;
    }
    if (this.speechStartTimer !== null) {
      window.clearTimeout(this.speechStartTimer);
      this.speechStartTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Mix / lifecycle
  // -------------------------------------------------------------------------

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) {
      const ctx = this.ctx!;
      const now = ctx.currentTime;
      try {
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(m ? 0 : MASTER_GAIN, now + 0.08);
      } catch {
        this.master.gain.value = m ? 0 : MASTER_GAIN;
      }
    }
    if (m) {
      this.cancelSpeech();
      this.stopMusicClock();
      this.stopAllSources();
    } else if (this.musicStarted) {
      this.resyncMusic();
    }
  }

  /** Hard-stop every scheduled one-shot; each source cleans up its own chain. */
  private stopAllSources(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const src of Array.from(this.active)) {
      try {
        src.stop(ctx.currentTime);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Release everything. Safe to call more than once. */
  dispose(): void {
    this.cancelSpeech();
    this.stopMusic();
    this.stopAllSources();
    this.active.clear();
    if (this.onVisibility) {
      try {
        document.removeEventListener?.('visibilitychange', this.onVisibility);
      } catch {
        /* ignore */
      }
      this.onVisibility = null;
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.limiter = null;
    this.shaper = null;
    this.sfxDuck = null;
    this.musicDuck = null;
    this.noiseBuffer = null;
    this.unlocked = false;
    this.musicStarted = false;
  }
}
