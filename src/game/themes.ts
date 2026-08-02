/**
 * THEMES — the backdrop content model.
 *
 * ============================================================================
 * HOW TO ADD A THEME
 * ============================================================================
 *
 * Add one object literal to `THEMES` at the bottom of this file and name it
 * from a level's `theme:` field. That is the whole job — `parallax.ts` reads
 * this and nothing else, so a theme is data in exactly the way a `LevelDef` is
 * data. Play it with
 *
 *     ?level=<id>            in the URL
 *     __levels.start('<id>') from the console
 *
 * An unknown or absent theme resolves to `meadow`, never to a boot failure.
 *
 * ----------------------------------------------------------------- shape ----
 * A theme fills the eleven depth bands `parallax.ts` composes. Reading down
 * the frame, and outward from the horizon:
 *
 *     sky      one opaque full-frame painting, the only thing behind everything
 *     far      tiled silhouette, the most distant solid mass
 *     mid      tiled silhouette, the frame's middle distance
 *     rows.ridge   a treeline standing ON the mid layer
 *     rows.tall    horizon-breakers: verticals that run off the TOP of frame
 *     ground   the walkable slab, drawn twice — once as a bank behind itself
 *     rows.near / rows.fringe   scatter on and through the ground line
 *     rows.fore    foreground foliage that sweeps in front of the player
 *     canopy   an over-frame band hanging DOWN from the top of the viewport
 *     vines    a second, deeper over-frame band
 *     clouds   lit geometry in the sky, riding the far layer's rate
 *
 * Only `sky`, `far`, `mid`, `ground`, `pieces` and `rows` are required. A theme
 * with no `canopy` simply does not draw one — it must NOT borrow another
 * theme's, because the sets are painted to different palettes and mixing them
 * reads as a mistake immediately. Same for `vines`, `clouds` and `washes`.
 *
 * -------------------------------------------------------------- measuring ----
 * Every fraction in here is measured off the PNG's alpha channel, not guessed.
 * Tiling, planting and cropping all depend on it:
 *
 *   `LayerDef.u`      widest column window that is fully opaque on the rows the
 *                     player can see. The repeat pitch equals this crop exactly,
 *                     so tiles abut and never overlap; alternate tiles mirror,
 *                     so every join is a reflection about a shared column.
 *   `LayerDef.bot`    flat base of the painted range, as a fraction of the matte
 *   `LayerDef.band`   the strip that is BOTH painted AND visible — its bottom is
 *                     the line below which the layer in front is solid, not the
 *                     base of the art. Everything outside it is fill nobody sees.
 *   `GroundDef.surface`  the walkable row: first row at ~95% opaque coverage.
 *                     This is registered onto `GROUND_Y`, where the hedgehog's
 *                     paws and the letter blocks live. Wrong by fifty units and
 *                     the hero walks along inside the dirt bank.
 *   `PieceSpec.u0..v1`   the *ink* box: the tightest rectangle outside which the
 *                     painting has nothing above ~18% alpha. A matte is fill the
 *                     GPU pays for in full, so this takes 10-60% off every quad.
 *   `PieceSpec.bot`   where the sprite's own footprint sits in its matte, so it
 *                     plants on the ground line instead of floating.
 *   `PieceSpec.span`  the painted vertical extent, which converts a wanted
 *                     screen height into a scale.
 *
 * ------------------------------------------------------------------ tint ----
 * Layer tints are multipliers on the painted art. Distance is a COLOUR, not an
 * opacity: a far layer draws solid, once, tinted cooler and darker toward the
 * sky. Never fake haze by stacking alpha bands — that lets the background leak
 * through solid objects and composites the same painting a dozen times over.
 *
 * A multiplier above 1.0 is only ever right for art that is *dark*. The dusk
 * set peaks around luma 206-228 and its rows genuinely need 1.4-3.4x. The winter
 * and cave sets peak at 246-253 — near white already — so their multipliers sit
 * at or below 1.0 and buy depth by *pulling value down and hue toward the
 * distance*, which cannot clip. Copying meadow's numbers onto them blows every
 * highlight in the frame.
 */

// ------------------------------------------------------------------- types

/**
 * A prop, cropped to its ink and registered on its own footprint.
 * Fractions of the matted frame.
 */
export interface PieceSpec {
  id: string;
  /** Where the footprint sits, so the piece plants rather than floats. */
  bot: number;
  /** Painted vertical extent; converts a wanted screen height into a scale. */
  span: number;
  u0?: number;
  u1?: number;
  v0?: number;
  v1?: number;
}

/** One wrapping scatter row. */
export interface RowDef {
  /** Asset ids to draw from. Repeating an id weights it. */
  use: string[];
  count: number;
  /** Horizontal gap between pieces, min..max. */
  gap: [number, number];
  /** Screen height of the painted content, min..max. */
  height: [number, number];
  /** Ground line the row plants on: shortest piece to tallest. */
  y: [number, number];
  tint: [number, number, number];
  /** Peak sway in radians. 0 for anything that should not move. */
  sway: number;
  alpha: number;
  /** How much darker the row gets as a piece grows. 0 = flat lighting. */
  grade: number;
}

/** A tiled silhouette layer: `far` or `mid`. */
export interface LayerDef {
  id: string;
  /** Opaque tiling window. The repeat pitch is exactly this wide. */
  u: [number, number];
  /** Flat base of the painted range. */
  bot: number;
  scale: number;
  /** The strip that is both painted and visible. */
  band: [number, number];
  tint: [number, number, number];
}

export interface SkyDef {
  id: string;
  /** Left edge of the crop — keeps the painting's lateral light ramp. */
  u0: number;
  /** Top of the crop. Low enough to keep the whole hue journey, not just its peak. */
  v0: number;
  /** Screen line the painting's last row lands on. */
  bottom: number;
  tint: [number, number, number];
}

/** The walkable slab, plus the bank drawn behind it at its own rate. */
export interface GroundDef {
  id: string;
  u: [number, number];
  /** Crop: high enough to keep the fronds that break the grass line... */
  v0: number;
  /** ...and low enough to stop before the matte goes empty. */
  v1: number;
  /** The walkable row, registered onto GROUND_Y. */
  surface: number;
  scale: number;
  tint: [number, number, number];
  bank: BankDef;
}

export interface BankDef {
  scale: number;
  /** Share of the slab the bank draws, from the top of its crop. */
  crop: number;
  /** How far above the collision line the bank's own surface sits. */
  lift: number;
  /** Peak-to-trough of the skyline rise. */
  rise: number;
  tint: [number, number, number];
}

/**
 * A full-width wash, sampled from a single texel of a layer already bound —
 * so it batches for free. `src` also picks where in the pass it lands: `mid`
 * washes draw over the far layers, `ground` washes over the ground.
 *
 * alpha(u) = a * smoothstep((u - in0)/(in1 - in0)) * (1 - fade * smoothstep((u - out0)/(out1 - out0)))
 *
 * Both ends must ramp from zero. A wash that starts at a non-zero alpha draws
 * a hard horizontal rule right across the frame.
 */
export interface WashDef {
  src: 'mid' | 'ground';
  u: number;
  v: number;
  tint: [number, number, number];
  y: [number, number];
  bands: number;
  /** Peak alpha. */
  a: number;
  in: [number, number];
  fade?: number;
  out?: [number, number];
}

/** A band hanging down from the true top of the viewport. */
export interface HangDef {
  id: string;
  /** Source windows. More than one cuts separate strands out of one painting. */
  windows: [number, number][];
  v: [number, number];
  /** Sample upside down: a ridge of spires becomes a ceiling of them. */
  flip?: boolean;
  count: number;
  height: [number, number];
  /** Pitch as a fraction of a piece's own width — below 1 the band overlaps. */
  pitch: [number, number];
  /** Pitch in world units instead, for a band that is meant to have gaps. */
  pitchAbs?: boolean;
  /** Wrap span past the last piece: absolute range, or a multiple of its width. */
  tail: [number, number];
  tailAbs?: boolean;
  /** Lift off the band's floor, as a fraction of the hang depth. */
  sag: [number, number];
  tint: [number, number, number];
  alpha: number;
  /** Share of the live viewport the band would like to fill. */
  depth: number;
  /** Lowest screen line it may ever reach — keeps it off the letter blocks. */
  floor: number;
  /**
   * Shortest piece in the band. MUST equal the hang depth this band gets on a
   * 16:9 screen, or the dense part of the painting sits off the top of the
   * frame and what shows is its transparent hem.
   */
  minH: number;
}

/** The lit cloud bank: the frame's largest highlight, and a thing not a wash. */
export interface CloudDef {
  pieces: PieceSpec[];
  count: number;
  gap: [number, number];
  height: [number, number];
  /** Screen band the row occupies, top to bottom. */
  y: [number, number];
  tint: [number, number, number];
  /** Value multiplier at the top of the band and at the bottom. */
  grade: [number, number];
  alpha: [number, number];
}

export interface ThemeDef {
  id: string;
  sky: SkyDef;
  far: LayerDef;
  mid: LayerDef;
  ground: GroundDef;
  /** Ink boxes for every prop this theme plants. Rows name them by id. */
  pieces: PieceSpec[];
  rows: {
    ridge: RowDef;
    tall: RowDef;
    near: RowDef;
    fringe: RowDef;
    fore: RowDef;
  };
  washes?: WashDef[];
  clouds?: CloudDef;
  canopy?: HangDef;
  vines?: HangDef;
}

// ------------------------------------------------------------------ meadow

/**
 * The dusk meadow — the scene the game shipped with, expressed as data.
 *
 * Every number below was previously a module constant in `parallax.ts`. They
 * are reproduced here exactly, including the order the rows are laid out in,
 * because the layout RNG is seeded once and consumed in sequence: change what
 * a row asks for and every row after it moves.
 */
const MEADOW: ThemeDef = {
  id: 'meadow',

  /**
   * Starting at v=0.34 puts indigo-violet at the top of the world, violet
   * behind the clue card, magenta and coral through the middle and amber along
   * the horizon — the whole 150-point luma journey inside the strip of sky the
   * viewer can actually see. Cropping to the top of the ramp instead (0.66, as
   * a highlight pass once did) gets the highlight and throws away three
   * quarters of the colour story.
   *
   * u0=0.4 keeps most of the painting's *lateral* fall, which is what makes
   * the frame read as lit from somewhere: the sun is off to the right.
   *
   * `bottom` is well above the grass on purpose. The hills' crest cuts the sky
   * off around y=380, so registering the brightest row lower buries every amber
   * row of the ramp behind opaque hills.
   */
  sky: { id: 'sky_dusk', u0: 0.4, v0: 0.34, bottom: 474, tint: [1, 1, 1] },

  /**
   * Peaks in violet dusk haze. Aerial perspective runs the other way at dusk —
   * the rows nearest the horizon are the ones the glow eats — but that does not
   * license a NEUTRAL tint: a near-grey multiplier on a blue-grey painting is
   * how both far layers came out milky, a pale colourless mat across the middle
   * of every frame.
   *
   * The band's top is where the first peak appears; below its bottom the hills
   * in front are 97.6% opaque, so nothing visible is cropped away.
   */
  far: {
    id: 'mountains_far',
    u: [30 / 1400, 1369 / 1400],
    bot: 0.704,
    scale: 1.22,
    band: [0.352, 0.6583],
    tint: [1.835, 1.58, 1.47],
  },

  /**
   * The frame's mid-distance and its only large cool mass. Blue-teal rather
   * than lifted: a ridge a full step darker and bluer than the magenta sky
   * behind it is what makes the sky read as sky.
   */
  mid: {
    id: 'hills_mid',
    u: [24 / 1400, 1375 / 1400],
    bot: 0.624,
    scale: 1.06,
    band: [0.362, 0.5926],
    tint: [2.31, 2.145, 2.035],
  },

  ground: {
    id: 'ground_slab',
    u: [105 / 1400, 1332 / 1400],
    v0: 340 / 933,
    v1: 1,
    surface: 416 / 933,
    scale: 0.82,
    tint: [3.46, 2.92, 2.1],
    bank: { scale: 0.7, crop: 0.355, lift: 34, rise: 23, tint: [1, 1, 1] },
  },

  pieces: [
    { id: 'bush_round', bot: 0.886, span: 0.766, u0: 0.042, u1: 0.958, v0: 0.108, v1: 0.897 },
    { id: 'rock_mossy', bot: 0.855, span: 0.726, u0: 0.038, u1: 0.962, v0: 0.117, v1: 0.867 },
    { id: 'rock_small_pair', bot: 0.786, span: 0.553, u0: 0.014, u1: 0.989, v0: 0.221, v1: 0.8 },
    { id: 'mushroom_cluster', bot: 0.952, span: 0.893, u0: 0.09, u1: 0.939, v0: 0.049, v1: 0.965 },
    { id: 'fern_cluster', bot: 0.965, span: 0.927, u0: 0.023, u1: 0.97, v0: 0.028, v1: 0.979 },
    { id: 'grass_tuft_a', bot: 0.954, span: 0.911, u0: 0.049, u1: 0.921, v0: 0.033, v1: 0.969 },
    { id: 'grass_tuft_b', bot: 0.767, span: 0.478, u0: 0.025, u1: 0.977, v0: 0.277, v1: 0.782 },
    { id: 'cliff_column', bot: 0.9775, span: 0.9492, u0: 0.279, u1: 0.721, v0: 0.018, v1: 0.988 },
    { id: 'tree_oak', bot: 0.9791, span: 0.9609, u0: 0.028, u1: 0.985, v0: 0.008, v1: 0.99 },
    { id: 'tree_pine', bot: 0.9782, span: 0.95, u0: 0.216, u1: 0.826, v0: 0.017, v1: 0.989 },
    { id: 'tree_birch_cluster', bot: 0.99, span: 0.97, u0: 0.174, u1: 0.856, v0: 0.01, v1: 1 },
    { id: 'tree_willow', bot: 0.9464, span: 0.9019, u0: 0.05, u1: 0.951, v0: 0.034, v1: 0.956 },
  ],

  rows: {
    /**
     * Real trees, not a smudge cut out of the hills painting. Less than half
     * the height it once was and with gaps you can see through: at 210-520
     * units this row was a wall from the grass line to y=40 and it hid BOTH far
     * layers completely. Drawn cool and nearly opaque — a treeline darker than
     * the band behind it is worth more to the frame's range than one more lit
     * surface.
     */
    ridge: {
      use: ['tree_pine', 'tree_birch_cluster', 'tree_pine', 'tree_oak'],
      count: 30,
      gap: [150, 430],
      height: [110, 205],
      y: [548, 566],
      tint: [2.06, 1.88, 1.9],
      sway: 0,
      alpha: 0.5,
      grade: 0.14,
    },
    /**
     * Roughly one every three wall gaps. At 16 pieces on a ~900-unit pitch this
     * row overlapped itself across the whole frame; a row meant to PUNCTUATE
     * the skyline ended up owning a third of it.
     */
    tall: {
      use: ['cliff_column', 'tree_oak', 'tree_birch_cluster', 'cliff_column', 'tree_pine', 'tree_willow'],
      count: 12,
      gap: [780, 1560],
      height: [640, 1240],
      y: [548, 574],
      tint: [1.4, 1.3, 1.42],
      sway: 0,
      alpha: 0.92,
      grade: 0.1,
    },
    near: {
      use: [
        'bush_round',
        'rock_mossy',
        'rock_small_pair',
        'mushroom_cluster',
        'fern_cluster',
        'grass_tuft_a',
        'grass_tuft_b',
      ],
      count: 34,
      gap: [62, 230],
      height: [46, 128],
      y: [566, 580],
      tint: [2.78, 2.32, 1.62],
      sway: 0.016,
      alpha: 1,
      grade: 0.16,
    },
    /**
     * The fringe: dense, short, and rooted BELOW the collision line so every
     * blade crosses it. The line cannot move, so what has to go is the idea
     * that the line is where the picture changes.
     */
    fringe: {
      use: ['grass_tuft_a', 'grass_tuft_b', 'fern_cluster', 'grass_tuft_a', 'grass_tuft_b'],
      count: 50,
      gap: [38, 142],
      height: [40, 112],
      y: [588, 632],
      tint: [3.42, 2.82, 1.76],
      sway: 0.03,
      alpha: 0.96,
      grade: 0.12,
    },
    /** Fewer, larger and planted lower: this row used to bury the letters. */
    fore: {
      use: ['fern_cluster', 'grass_tuft_a', 'grass_tuft_b', 'bush_round'],
      count: 13,
      gap: [300, 760],
      height: [200, 420],
      y: [790, 930],
      tint: [1, 0.93, 1.1],
      sway: 0.042,
      alpha: 0.96,
      grade: 0.1,
    },
  },

  washes: [
    // Deep forest shadow, laid the whole height of the frame at a whisper. It
    // bottoms out at y=606, below the bank's lowest surface and so permanently
    // covered — a wash that ends in open air ends in a ruled line.
    {
      src: 'mid',
      u: 700.5 / 1400,
      v: 513.5 / 933,
      tint: [1, 0.82, 0.98],
      y: [40, 606],
      bands: 44,
      a: 0.026,
      in: [0, 0.62],
      fade: 0.55,
      out: [0.8, 1],
    },
    // ...and everything below the play line falls into the ground's own shade.
    // Shadow has to be SHAPED — dark at the bottom of the frame, lit at the
    // grass line, forty units apart.
    {
      src: 'ground',
      u: 0.5943,
      v: 0.4898,
      tint: [1, 1, 1],
      y: [652, 1100],
      bands: 24,
      a: 0.38,
      in: [0, 0.7],
    },
  ],

  /**
   * The frame's largest highlight purchase, and the only one that is a thing
   * rather than a wash. Everything else here tops out around luma 200-226, which
   * is enough for a warm frame and not a lit one: nothing clips, so nothing
   * reads as light rather than as surface. `cloud_a` has texels at 229 under a
   * soft alpha falloff, so a hot tint blows its cores to white while its edges
   * stay translucent. Free — same atlas as the trees, drawn immediately before
   * them, one bind for both.
   */
  clouds: {
    pieces: [
      { id: 'cloud_a', bot: 0.5, span: 1, u0: 0.016, u1: 0.99, v0: 0.148, v1: 0.815 },
      { id: 'cloud_b', bot: 0.5, span: 1, u0: 0.008, u1: 0.992, v0: 0.38, v1: 0.585 },
    ],
    count: 17,
    gap: [390, 1080],
    height: [96, 258],
    y: [296, 474],
    tint: [2.46, 2, 1.22],
    grade: [1.22, 0.86],
    alpha: [0.84, 0.98],
  },

  /**
   * The shadow ceiling. Pitched well inside a tile width so neighbours always
   * overlap: widening it saves 0.26x of fill and the band stops reading as a
   * canopy — the overlap IS the density. Cropped short of the painting's hem,
   * but only as short as the alpha allows: 0.75 is the last row under 10%
   * coverage, and cutting higher draws the hem as a ruled horizontal line.
   */
  canopy: {
    id: 'canopy_overhang',
    windows: [[6 / 1400, 1388 / 1400]],
    v: [36 / 933, 0.75],
    count: 13,
    height: [186, 248],
    pitch: [0.4, 0.6],
    tail: [0.66, 0.66],
    sag: [-0.07, 0.05],
    tint: [1, 1, 1],
    alpha: 0.92,
    depth: 0.28,
    floor: 156,
    minH: 156,
  },

  /** Four separate strands cut out of one painting, each on its own. */
  vines: {
    id: 'vines_hanging',
    windows: [
      [24 / 667, 142 / 667],
      [148 / 667, 309 / 667],
      [322 / 667, 516 / 667],
      [518 / 667, 641 / 667],
    ],
    v: [30 / 1000, 962 / 1000],
    count: 8,
    height: [340, 470],
    pitch: [520, 1180],
    pitchAbs: true,
    tail: [700, 1400],
    tailAbs: true,
    sag: [-0.3, 0],
    tint: [1, 1, 1],
    alpha: 0.92,
    depth: 0.52,
    floor: 236,
    minH: 330,
  },
};

// ------------------------------------------------------------------ winter

/**
 * WINTER — a snowfield under a cold dawn.
 *
 * Eight assets against the meadow's nineteen, so the composition is built out
 * of *scale range* rather than variety: the same pine appears as a 90-unit
 * speck on the ridge and a 1200-unit silhouette running off the top of the
 * frame, and the same tuft of frozen grass is both the fringe at the player's
 * feet and the 380-unit clump sweeping across the foreground. Two shapes at
 * eight sizes reads as a place; two shapes at one size reads as a shelf.
 *
 * NO CANOPY. There is no winter ceiling asset and the meadow's would arrive as
 * a slab of warm summer leaf over a blue snowfield. The top of the frame is
 * instead broken by the tall row, which is why it is the tallest and the
 * densest of the three themes: bare crowns and pine spires cut the top edge
 * where a canopy would otherwise hang.
 *
 * Tints are at or under 1.0 throughout. The winter set is painted lit — its
 * props peak at luma 250 and its mountains at 246 — so depth is bought by
 * pulling value DOWN and hue toward the cold distance.
 */
const WINTER: ThemeDef = {
  id: 'winter',

  sky: { id: 'winter_sky', u0: 0.34, v0: 0.3, bottom: 474, tint: [1, 1, 1] },

  /**
   * Snow peaks, held back by desaturating them toward the sky rather than by
   * darkening: snow in the distance goes blue and low-contrast, it does not go
   * grey. Scaled so the crest clears the pine ridge in front of it — a mountain
   * whose peak sits below the treeline is a mountain nobody can see.
   */
  far: {
    id: 'winter_mountains',
    u: [16 / 1400, 1386 / 1400],
    bot: 0.707,
    scale: 1.03,
    band: [0.302, 0.653],
    tint: [0.72, 0.79, 0.98],
  },

  /**
   * The pine ridge, already painted into the hills. It carries its own treeline,
   * so the `ridge` row above it is thinner than the meadow's — a second forest
   * on top of this one would double the silhouette and flatten both.
   */
  mid: {
    id: 'winter_hills',
    u: [36 / 1400, 1362 / 1400],
    bot: 0.656,
    scale: 0.95,
    band: [0.354, 0.621],
    tint: [0.62, 0.71, 0.94],
  },

  /**
   * Snow crust over frozen soil, with a row of icicles under the lip. The crop
   * stops at 0.71 — the last painted row — instead of running to the bottom of
   * the matte, which on this asset is 30% empty.
   */
  ground: {
    id: 'winter_ground',
    u: [32 / 1400, 1372 / 1400],
    v0: 0.312,
    v1: 0.71,
    surface: 0.397,
    scale: 0.82,
    tint: [1, 1, 1],
    // A deeper crop than the meadow's: this slab is a third the height in
    // matte terms, so 0.355 of it left the bank's lower edge ABOVE the
    // walkable slab at the top of the rise, showing a strip of sky through the
    // join. 0.62 keeps it covered at every phase.
    bank: { scale: 0.7, crop: 0.62, lift: 34, rise: 23, tint: [0.9, 0.94, 1.06] },
  },

  pieces: [
    { id: 'winter_tree_pine', bot: 0.98, span: 0.958, u0: 0.145, u1: 0.883, v0: 0.025, v1: 0.983 },
    { id: 'winter_tree_bare', bot: 0.96, span: 0.92, u0: 0.037, u1: 0.959, v0: 0.042, v1: 0.962 },
    { id: 'winter_rock', bot: 0.868, span: 0.72, u0: 0.086, u1: 0.921, v0: 0.15, v1: 0.87 },
    { id: 'winter_grass', bot: 0.937, span: 0.861, u0: 0.035, u1: 0.967, v0: 0.078, v1: 0.939 },
  ],

  rows: {
    /**
     * Sparse and small. The mid layer already has a treeline painted on it; this
     * row exists only to break its edge with a few crowns standing proud of it,
     * and it draws at half alpha so it dissolves into the ridge rather than
     * standing in front of it.
     */
    ridge: {
      use: ['winter_tree_pine', 'winter_tree_bare', 'winter_tree_pine', 'winter_tree_pine'],
      count: 26,
      gap: [180, 470],
      height: [88, 168],
      y: [548, 566],
      tint: [0.66, 0.74, 0.94],
      sway: 0,
      alpha: 0.62,
      grade: 0.14,
    },
    /**
     * The tallest AND densest row of the three themes, and the theme's whole
     * answer to the missing canopy. The meadow keeps this row sparse — twelve
     * pieces on a ~1200-unit pitch — because a canopy already owns the top of
     * its frame and a dense tall row would fight it. Winter has no canopy, so
     * the first pass left the top third of the picture as bare gradient with
     * one tree in it: a poster, not a place. At eighteen pieces on a ~700-unit
     * pitch these crowns cross the top edge two or three at a time and the
     * frame reads as standing INSIDE a treeline rather than in front of one.
     *
     * No boulders in here. `winter_rock` is in the theme and would have filled
     * the row out, but a snow boulder scaled to 1200 units is a boulder the
     * size of a tree, and that reads as a mistake rather than as scale.
     *
     * Held dark and blue: a near-silhouette against a pale sky is the strongest
     * value contrast winter has, and it is the only real shadow in the frame.
     */
    tall: {
      use: [
        'winter_tree_pine',
        'winter_tree_bare',
        'winter_tree_pine',
        'winter_tree_pine',
        'winter_tree_bare',
        'winter_tree_pine',
      ],
      count: 18,
      gap: [430, 980],
      height: [620, 1240],
      y: [548, 578],
      tint: [0.5, 0.57, 0.76],
      sway: 0,
      alpha: 0.94,
      grade: 0.12,
    },
    /**
     * Weighted toward grass rather than rock. The first pass ran four rocks to
     * three tufts and the ground line came out as a row of near-identical snow
     * boulders — the one composition failure a four-asset theme is actually
     * prone to. The height window is wider than the meadow's for the same
     * reason: with two shapes to work with, scale IS the variety.
     */
    near: {
      use: [
        'winter_grass',
        'winter_rock',
        'winter_grass',
        'winter_tree_pine',
        'winter_grass',
        'winter_rock',
        'winter_grass',
      ],
      count: 32,
      gap: [70, 250],
      height: [40, 150],
      y: [566, 580],
      tint: [0.94, 0.97, 1.06],
      sway: 0.016,
      alpha: 1,
      grade: 0.16,
    },
    fringe: {
      use: ['winter_grass', 'winter_grass', 'winter_rock', 'winter_grass', 'winter_grass'],
      count: 50,
      gap: [40, 148],
      height: [38, 112],
      y: [588, 628],
      tint: [1.02, 1.04, 1.12],
      sway: 0.03,
      alpha: 0.96,
      grade: 0.12,
    },
    fore: {
      use: ['winter_grass', 'winter_grass', 'winter_rock', 'winter_grass'],
      count: 13,
      gap: [300, 760],
      height: [210, 430],
      y: [800, 940],
      tint: [0.5, 0.55, 0.72],
      sway: 0.042,
      alpha: 0.96,
      grade: 0.1,
    },
  },

  washes: [
    // A thin cold scrim off the darkest texel of the hills, doing the same job
    // the meadow's does: pulling the whole frame a hair toward one atmosphere.
    {
      src: 'mid',
      u: 0.0864,
      v: 0.448,
      tint: [0.86, 0.94, 1],
      y: [40, 600],
      bands: 40,
      a: 0.05,
      in: [0, 0.55],
      fade: 0.7,
      out: [0.78, 1],
    },
    // The ground's own shade below the play line, off the slab's darkest texel.
    {
      src: 'ground',
      u: 0.7214,
      v: 0.4534,
      tint: [0.82, 0.88, 1],
      y: [640, 1100],
      bands: 24,
      a: 0.34,
      in: [0, 0.7],
    },
  ],

  /**
   * The same two cloud paintings the meadow uses, tinted cold. They are the one
   * borrowed asset in the theme and they earn it: a cloud is a cloud, the
   * paintings are pure value with almost no hue of their own, and a winter sky
   * with nothing in it is the emptiest frame in the game. Kept dimmer and
   * cooler than the meadow's so they read as overcast rather than as a sunset.
   *
   * Set HIGHER than the meadow's, which hug the horizon. The meadow can afford
   * that because it has a canopy hanging into the top of the frame; winter
   * needs this band to reach up past the tall crowns and give the upper sky
   * something in it. They pass behind the clue card, which is opaque, so
   * nothing here costs readability.
   */
  clouds: {
    pieces: [
      { id: 'cloud_a', bot: 0.5, span: 1, u0: 0.016, u1: 0.99, v0: 0.148, v1: 0.815 },
      { id: 'cloud_b', bot: 0.5, span: 1, u0: 0.008, u1: 0.992, v0: 0.38, v1: 0.585 },
    ],
    count: 18,
    gap: [380, 1000],
    height: [120, 300],
    y: [130, 430],
    tint: [1.34, 1.24, 1.22],
    grade: [1.1, 0.78],
    alpha: [0.5, 0.76],
  },
};

// -------------------------------------------------------------------- cave

/**
 * CAVE — underground, lit by what grows there.
 *
 * The one theme with no sky. `cave_backdrop` is a finished painting of a cavern
 * wall, so it is registered much further down the frame than a sky is: there is
 * no horizon to hold a bright line at, and everything above the ground is
 * *interior*. The value ramp therefore runs the other way from the meadow's —
 * dark at the edges, bright only where something is actually glowing.
 *
 * THE CANOPY IS THE MID LAYER, UPSIDE DOWN. `cave_mid_rocks` is a ridge of
 * stalagmites with a flat solid base and glowing tips; sampled with its v range
 * reversed it becomes a ceiling of stalactites with a flat top edge that always
 * sits off-frame and a fringe of lit points hanging into view — which is
 * exactly the contract the over-frame band asks for. Reusing the theme's own
 * art at another scale is the honest way to fill a band; borrowing the meadow's
 * leaf canopy would put a summer oak over a cave.
 */
const CAVE: ThemeDef = {
  id: 'cave',

  /**
   * Not a sky: an opaque interior, registered low so it fills the frame down to
   * the ground rather than stopping at a horizon that does not exist. u0=0.06
   * keeps the painting's own lateral story — cold crystal on the left, warm lit
   * rock on the right.
   */
  sky: { id: 'cave_backdrop', u0: 0.06, v0: 0.06, bottom: 616, tint: [0.94, 0.94, 1] },

  /**
   * The far wall: a rock band with stalactites at its top edge. Its own top is
   * the frame's deepest dark, which is what every glowing thing in front of it
   * is measured against, so it is tinted DOWN — the only far layer in the game
   * that is darker than the backdrop behind it.
   */
  far: {
    id: 'cave_far_wall',
    u: [98 / 1400, 1306 / 1400],
    bot: 0.726,
    scale: 0.92,
    band: [0.205, 0.681],
    tint: [0.58, 0.62, 0.8],
  },

  /**
   * The stalagmite ridge. Glowing teal along its crest, so it is left near its
   * own exposure and merely cooled: this is the frame's mid-distance light
   * source and pulling it down would leave the picture with nothing lit in it
   * between the backdrop and the player's feet.
   */
  mid: {
    id: 'cave_mid_rocks',
    u: [16 / 1400, 1380 / 1400],
    bot: 0.857,
    scale: 0.6,
    band: [0.164, 0.802],
    tint: [0.78, 0.86, 1],
  },

  ground: {
    id: 'cave_ground',
    u: [32 / 1400, 1370 / 1400],
    v0: 0.39,
    v1: 0.812,
    surface: 0.409,
    scale: 0.82,
    tint: [1.04, 1.04, 1.04],
    bank: { scale: 0.7, crop: 0.6, lift: 34, rise: 23, tint: [0.72, 0.78, 0.94] },
  },

  pieces: [
    { id: 'cave_stalagmite', bot: 0.98, span: 0.946, u0: 0.162, u1: 0.854, v0: 0.036, v1: 0.982 },
    { id: 'cave_crystal_cluster', bot: 0.944, span: 0.895, u0: 0.091, u1: 0.904, v0: 0.051, v1: 0.946 },
    { id: 'cave_mushroom_glow', bot: 0.957, span: 0.913, u0: 0.132, u1: 0.834, v0: 0.046, v1: 0.959 },
    { id: 'cave_moss', bot: 0.878, span: 0.769, u0: 0.039, u1: 0.95, v0: 0.111, v1: 0.88 },
  ],

  rows: {
    /**
     * A field of small spires and crystals standing on the mid ridge. Held at
     * half alpha and pulled blue so it dissolves into the layer behind it: the
     * crystals here are meant to read as distant glimmer, not as objects.
     */
    ridge: {
      use: ['cave_stalagmite', 'cave_crystal_cluster', 'cave_stalagmite', 'cave_crystal_cluster'],
      count: 28,
      gap: [160, 440],
      height: [95, 190],
      y: [548, 566],
      tint: [0.5, 0.6, 0.86],
      sway: 0,
      alpha: 0.58,
      grade: 0.14,
    },
    /**
     * Columns running floor to ceiling. Nearly black, because they pass in
     * front of the only lit band in the frame and a silhouette is the cheapest
     * depth cue there is.
     */
    tall: {
      use: [
        'cave_stalagmite',
        'cave_crystal_cluster',
        'cave_stalagmite',
        'cave_stalagmite',
        'cave_crystal_cluster',
        'cave_stalagmite',
      ],
      count: 12,
      gap: [740, 1500],
      height: [620, 1180],
      y: [548, 576],
      tint: [0.34, 0.4, 0.6],
      sway: 0,
      alpha: 0.94,
      grade: 0.12,
    },
    /**
     * The near storey is where the cave's light actually lives: glowing
     * mushrooms and crystal at full exposure, on ground that is otherwise the
     * darkest in the game.
     */
    near: {
      use: [
        'cave_mushroom_glow',
        'cave_crystal_cluster',
        'cave_moss',
        'cave_mushroom_glow',
        'cave_crystal_cluster',
        'cave_moss',
        'cave_stalagmite',
      ],
      count: 32,
      gap: [66, 240],
      height: [48, 138],
      y: [566, 582],
      tint: [1.06, 1.06, 1.08],
      sway: 0.016,
      alpha: 1,
      grade: 0.16,
    },
    fringe: {
      use: ['cave_moss', 'cave_moss', 'cave_mushroom_glow', 'cave_moss', 'cave_moss'],
      count: 44,
      gap: [42, 150],
      height: [36, 100],
      y: [588, 630],
      tint: [1.1, 1.1, 1.1],
      sway: 0.03,
      alpha: 0.96,
      grade: 0.12,
    },
    fore: {
      use: ['cave_moss', 'cave_mushroom_glow', 'cave_crystal_cluster', 'cave_moss'],
      count: 13,
      gap: [300, 760],
      height: [200, 420],
      y: [800, 940],
      tint: [0.32, 0.38, 0.52],
      sway: 0.042,
      alpha: 0.96,
      grade: 0.1,
    },
  },

  washes: [
    // The cave's one atmospheric purchase, and it runs the opposite way to the
    // meadow's: a cold glow sampled off the brightest crystal on the mid ridge,
    // laid across the middle of the frame so the deep distance has something to
    // dissolve into instead of going flat black.
    {
      src: 'mid',
      u: 0.7186,
      v: 0.2433,
      tint: [0.5, 0.78, 0.92],
      y: [120, 596],
      bands: 36,
      a: 0.1,
      in: [0, 0.7],
      fade: 0.9,
      out: [0.86, 1],
    },
    // ...and the floor falls into its own shadow below the play line, hard,
    // because underground there is nothing down there to light it.
    {
      src: 'ground',
      u: 0.04,
      v: 0.4062,
      tint: [1, 1, 1],
      y: [636, 1100],
      bands: 24,
      a: 0.52,
      in: [0, 0.62],
    },
  ],

  /**
   * The ceiling: the mid layer's own ridge, sampled upside down. Pitched to
   * overlap like the meadow's canopy so the band reads as continuous rock, and
   * held to a hard floor well above the letter blocks.
   */
  canopy: {
    id: 'cave_mid_rocks',
    windows: [[16 / 1400, 1380 / 1400]],
    v: [0.4, 0.855],
    flip: true,
    count: 11,
    height: [176, 236],
    pitch: [0.46, 0.66],
    tail: [0.66, 0.66],
    sag: [-0.06, 0.04],
    tint: [0.34, 0.4, 0.58],
    alpha: 0.95,
    depth: 0.26,
    floor: 150,
    minH: 150,
  },

  /**
   * A second, deeper rank of stalactites at twice the ceiling's scroll rate.
   * Cut as four narrow windows out of the same painting so no two hang the
   * same, and sparse enough to read as individual spires rather than a fringe.
   */
  vines: {
    id: 'cave_mid_rocks',
    windows: [
      [0.06, 0.2],
      [0.28, 0.44],
      [0.5, 0.66],
      [0.74, 0.9],
    ],
    v: [0.34, 0.855],
    flip: true,
    count: 7,
    height: [300, 430],
    pitch: [560, 1240],
    pitchAbs: true,
    tail: [700, 1400],
    tailAbs: true,
    sag: [-0.26, 0],
    tint: [0.28, 0.34, 0.5],
    alpha: 0.94,
    depth: 0.5,
    floor: 230,
    minH: 320,
  },
};

// ------------------------------------------------------------------ lookup

/** Every theme the game ships. `THEMES[0]` is the fallback. */
export const THEMES: readonly ThemeDef[] = [MEADOW, WINTER, CAVE];

export const DEFAULT_THEME: ThemeDef = MEADOW;

/**
 * Resolve a level's `theme` string. Unknown, absent or misspelled all land on
 * the meadow — a theme is a decoration, never a reason not to boot.
 */
export function themeFor(id: string | undefined): ThemeDef {
  if (id) for (const t of THEMES) if (t.id === id) return t;
  return DEFAULT_THEME;
}
