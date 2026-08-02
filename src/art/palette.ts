/**
 * The game's colour system.
 *
 * Every painter pulls from here so the whole screen reads as one art
 * direction. The scheme is a dusk-lit meadow: warm low sun, cool shadows,
 * saturated hero colours that pop against a desaturated background — the same
 * separation-by-saturation trick the reference art uses to keep a busy
 * background from competing with the character.
 */

export interface Ramp {
  /** Deepest shadow. */
  shade: string;
  /** Core surface colour. */
  base: string;
  /** Sun-facing surface. */
  light: string;
  /** Specular / rim highlight. */
  hi: string;
}

export const ramp = (shade: string, base: string, light: string, hi: string): Ramp => ({
  shade,
  base,
  light,
  hi,
});

/** Sky gradient stops, far to near. */
export const SKY = {
  zenith: '#1b2a5e',
  high: '#3c4f8f',
  mid: '#8f6f9e',
  low: '#e08a72',
  horizon: '#f8c58a',
};

/** Parallax layers get progressively lighter and bluer with distance. */
export const FOG = {
  far: 'rgba(154, 168, 214, 0.72)',
  mid: 'rgba(120, 132, 186, 0.44)',
  near: 'rgba(84, 92, 148, 0.18)',
};

export const HILL_FAR = ramp('#4d5a94', '#5d6ba6', '#6d7cba', '#8390cf');
export const HILL_MID = ramp('#2f3d6e', '#3c4c85', '#4a5c9c', '#5b6eb4');
export const HILL_NEAR = ramp('#1c2749', '#26325e', '#313f76', '#3d4d8e');

export const GRASS = ramp('#1d4a3a', '#2a6b4f', '#3d8f64', '#5fbc84');
export const SOIL = ramp('#2a1f2e', '#3a2b3c', '#4c3a4c', '#614d61');

/** Hero hedgehog default skin. */
export const QUILL = ramp('#2b2a52', '#3d3c73', '#55539b', '#7d7ac9');
export const BELLY = ramp('#a9714a', '#c98d5e', '#e5ab7a', '#f6c99b');
export const SNOUT = ramp('#5a3b2c', '#7a5240', '#9a6b55', '#b98a72');

/** Letter block materials. */
export const STONE = ramp('#3b4364', '#59628a', '#7c86b2', '#a6b0d6');
export const CRYSTAL = ramp('#1e5f7a', '#2b86a8', '#41b0d4', '#8fe6ff');
export const AMBER = ramp('#7a4413', '#b06a20', '#e09338', '#ffcb7a');

/** UI ink. */
export const INK = {
  paper: '#f6f1e4',
  paperShade: '#d9d0bc',
  dark: '#1a1730',
  darkSoft: 'rgba(26, 23, 48, 0.55)',
  gold: '#ffcf5c',
  goldDeep: '#e09a24',
  danger: '#ff5f6d',
  good: '#66e2a0',
};

/** Cosmetic skin definitions, referenced by progression unlock ids. */
export interface SkinDef {
  id: string;
  label: string;
  quill: Ramp;
  belly: Ramp;
  /** Sparks required to unlock. 0 = available from the start. */
  cost: number;
}

export const SKINS: SkinDef[] = [
  { id: 'skin/classic', label: 'Dusk', quill: QUILL, belly: BELLY, cost: 0 },
  {
    id: 'skin/ember',
    label: 'Ember',
    quill: ramp('#5a1f14', '#8c2f1c', '#c2472a', '#ff8a5c'),
    belly: ramp('#8c5a22', '#c08132', '#e5a656', '#ffd39a'),
    cost: 600,
  },
  {
    id: 'skin/mint',
    label: 'Mint',
    quill: ramp('#14483d', '#1d6b58', '#2b9a7c', '#5fdcb4'),
    belly: ramp('#9c8a4a', '#c5b268', '#e3d28e', '#f7ecbb'),
    cost: 1500,
  },
  {
    id: 'skin/orchid',
    label: 'Orchid',
    quill: ramp('#421a52', '#652a7c', '#9042ac', '#ce87e6'),
    belly: ramp('#8f5470', '#b8748f', '#d894ad', '#f2bcd0'),
    cost: 3200,
  },
  {
    id: 'skin/gold',
    label: 'Bullion',
    quill: ramp('#6b4a08', '#9c7014', '#d4a025', '#ffe08a'),
    belly: ramp('#7a5c1c', '#ab8434', '#d9ae59', '#ffe4a8'),
    cost: 6000,
  },
];

export interface TrailDef {
  id: string;
  label: string;
  /** Tint applied to trail particles. */
  color: [number, number, number];
  /** Frame prefix in the atlas. */
  sprite: string;
  cost: number;
}

export const TRAILS: TrailDef[] = [
  { id: 'trail/none', label: 'None', color: [1, 1, 1], sprite: '', cost: 0 },
  { id: 'trail/dust', label: 'Dust', color: [0.85, 0.78, 0.6], sprite: 'fx/dust', cost: 250 },
  { id: 'trail/spark', label: 'Sparks', color: [1, 0.82, 0.35], sprite: 'fx/spark', cost: 900 },
  { id: 'trail/frost', label: 'Frost', color: [0.55, 0.86, 1], sprite: 'fx/spark', cost: 2000 },
  { id: 'trail/bloom', label: 'Petals', color: [1, 0.6, 0.78], sprite: 'fx/petal', cost: 4000 },
];

export interface SpinDef {
  id: string;
  label: string;
  /** Number of afterimage echoes drawn behind the ball. */
  echoes: number;
  /** Ring pattern drawn around the ball while charging. */
  ring: 'none' | 'dashes' | 'chevrons' | 'halo';
  cost: number;
}

export const SPINS: SpinDef[] = [
  { id: 'spin/classic', label: 'Classic', echoes: 3, ring: 'none', cost: 0 },
  { id: 'spin/comet', label: 'Comet', echoes: 6, ring: 'dashes', cost: 400 },
  { id: 'spin/turbine', label: 'Turbine', echoes: 5, ring: 'chevrons', cost: 1200 },
  { id: 'spin/nova', label: 'Nova', echoes: 8, ring: 'halo', cost: 2600 },
];

export const skinById = (id: string): SkinDef => SKINS.find((s) => s.id === id) ?? SKINS[0];
export const trailById = (id: string): TrailDef => TRAILS.find((t) => t.id === id) ?? TRAILS[0];
export const spinById = (id: string): SpinDef => SPINS.find((s) => s.id === id) ?? SPINS[0];

/** Parse `#rrggbb` into 0..1 components. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Build a vertical linear gradient from a ramp. */
export function rampGradient(
  ctx: CanvasRenderingContext2D,
  r: Ramp,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, r.hi);
  g.addColorStop(0.35, r.light);
  g.addColorStop(0.72, r.base);
  g.addColorStop(1, r.shade);
  return g;
}
