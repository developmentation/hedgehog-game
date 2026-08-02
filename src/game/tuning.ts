/**
 * Feel tuning — the single place a designer edits to re-balance the game.
 *
 * Every number that decides how the game *plays* lives here: scroll speeds,
 * dash timings, wall geometry, scoring, camera and impact feedback. The systems
 * that consume them (`wallField`, `player`, `wordSession`, the play scene and
 * the HUD) hold no feel constants of their own, so a balance pass is a one-file
 * edit and never a code hunt.
 *
 * Each field says what it does and which way to move it to make the game
 * kinder, because "bigger number" and "easier game" are not the same direction
 * twice in a row.
 *
 * Purely compositional constants — sprite offsets, cull bounds, HUD layout —
 * stay next to the code that draws them. This file is about feel, not framing.
 *
 * What is NOT here: anything that varies from one level to the next. Which
 * words a run draws from, how fast it scrolls, how tall its columns are, how
 * its decoys are chosen, how forgiving it is and when it ends are all
 * properties of a `LevelDef` — see `game/levels.ts`. The numbers below that
 * still smell like difficulty (`scroll.baseSpeed`, `scroll.tierRamp`,
 * `walls.heightMin/Max`, `scoring.maxMisses`, `scoring.maxTier`) are the
 * FALLBACKS and CEILINGS a level is resolved against: a descriptor that says
 * nothing about pace gets its shape from them, and no descriptor can exceed
 * them.
 */

export const TUNING = {
  /** How fast the level arrives at the player. */
  scroll: {
    /** Speed the world holds before the first word sets a target. Lower = calmer boot. */
    startSpeed: 250,
    /**
     * Default pacing floor and step for a level that does not state its own
     * `pacing.startSpeed` / `endSpeed`: such a level ramps from
     * `baseSpeed + tierRamp` to `baseSpeed + maxTier * tierRamp`. A level that
     * does state them ignores both. Lower = easier everywhere.
     */
    baseSpeed: 230,
    tierRamp: 26,
    /** Fraction of target speed held while the word is being spoken. Lower = more listening room. */
    listenFactor: 0.75,
    /** Fraction of target speed the world resumes at on a new word. Lower = gentler restart. */
    resumeFactor: 0.7,
    /** Crawl speed behind the title card. */
    introSpeed: 90,
    /** Crawl speed while the setback banner plays. Lower = longer breather. */
    setbackSpeed: 60,
    /** How hard the scroll speed is pulled to its target, per phase. Lower = softer, laggier. */
    ease: {
      intro: 3,
      listening: 3,
      playing: 2.2,
      celebrate: 4.5,
      setback: 5,
      gameover: 4,
    },
  },

  /** The hedgehog's motion: dash, recover, knockback, dance. */
  dash: {
    /** Seconds from launch to impact. Lower = punchier, but harder to read. */
    dashTime: 0.13,
    /** Seconds to settle back onto the running line after a smash. */
    returnTime: 0.2,
    /** Seconds spent knocked backwards after a wrong letter. Lower = less punishing. */
    bounceTime: 0.36,
    /** Overshoot on the return ease. Higher = bouncier landing. */
    returnOvershoot: 1.1,
    /** Peak of the knockback arc, world units back and up. Lower = less ground lost visually. */
    bounceBack: 90,
    bounceLift: 120,
    /** How far short of the block's centre the dash stops, as a fraction of block width. */
    landingInset: 0.34,
    /** Screen margin the victory dance is kept inside. */
    danceMargin: 220,
    danceBobRate: 7,
    danceBobLift: 46,
    /** How hard the player is pulled back to the running line. Higher = stickier. */
    runFollow: 7,
    danceFollow: 5,
    /** Idle bob while running — pure life, no gameplay effect. */
    runBobRate: 9,
    runBobAmp: 2,
    /** How fast an impact squash relaxes. Higher = snappier. */
    squashDecay: 11,
    /** World units of scroll per radian-ish of ball spin. Lower = faster spin. */
    spinPerSpeed: 44,
    /** Spin multiplier while dashing. Higher = more violent-looking dash. */
    dashSpinBoost: 3.2,
    spinEase: 8,
    /**
     * Ceiling on the quill-blur cross-fade, 0..1.
     *
     * Never 1. Past the third tier the spin rate pins the mix, and at a full
     * mix the painted ball is gone entirely — the hero becomes a wheel that
     * happens to be hedgehog-coloured. Holding a slice of the solid pose under
     * the blur keeps the silhouette and the face reading as *him* at every
     * speed the game can reach. Lower = more character, less speed.
     */
    blurMixCap: 0,
    /**
     * Value separation against the painted backdrop.
     *
     * The world is a lit dusk whose mid-tones sit almost exactly on the
     * hedgehog's own — measured, the hero's mean luminance came within six
     * greyscale levels of the sky and foliage behind him, which is another way
     * of saying he had no silhouette. A dark copy of the pose drawn a hair
     * proud of the body gives him an outline that works against a bright
     * backdrop and a dark one alike, and a small warm gain on the body itself
     * puts his amber back above the scene.
     */
    rim: { width: 0.075, alpha: 0, r: 0.03, g: 0.022, b: 0.07 },
    /**
     * Multiplier on the hero's own colour. Higher = hotter, but blows the
     * highlights — and past a point it stops helping, because brightening him
     * towards a bright backdrop *reduces* the value gap. The separation is
     * bought by the rim; this only puts his amber back where the paint had it.
     */
    heroLift: 1.0,
    /** How fast afterimages fade, and how many are kept. */
    echoFade: 4,
    echoLimit: 12,
    /** Trail particles emitted per frame-at-60, per state. Higher = denser trail. */
    trailRate: { dash: 2.4, return: 1, dance: 0.5 },
  },

  /**
   * The hop.
   *
   * The escape hatch for a wall the player cannot spell: leave the ground and
   * the column rolls past underneath without costing a life. It is deliberately
   * a *trade* rather than a free out — he cannot spin-dash while he is in the
   * air, so every hop is roughly a second of not spelling. That is what stops it
   * becoming the dominant strategy without ever making it feel punishing: you
   * lose tempo, never lives and never score.
   */
  jump: {
    /** Seconds of anticipation crouch before he leaves the ground. Higher = more telegraph, less snappy. */
    crouchTime: 0.075,
    /** World units he sinks into the ground during the crouch. Higher = heavier wind-up. */
    crouchDip: 9,
    /**
     * Launch velocity upward, world units/sec. Higher = higher hop.
     *
     * Set so the apex clears the *top* of a two-block column rather than merely
     * getting him off the deck: a dodge the player cannot see themselves win is
     * a dodge they will not trust. Taller columns cannot be cleared literally —
     * a five-stack reaches the top of the frame — so above two blocks the read
     * falls back to "he is up and it went under him", which the DODGED callout
     * and the empty ground beneath him carry.
     */
    launchSpeed: 960,
    /** Downward acceleration, world units/sec². Higher = snappier and shorter. */
    gravity: 1900,
    /**
     * Seconds after touchdown before he can hop again. This plus the ~0.93s of
     * airtime is the whole cost of the move. Higher = less spammable.
     */
    cooldown: 0.3,
    /** Height above the ground line at which a passing wall stops counting. Lower = more forgiving. */
    clearHeight: 110,
    /** How near the column has to be for the dodge to apply, world units. Higher = more forgiving. */
    clearReach: 320,
    /** Body deformation on the crouch, the launch and the landing. Pure feel. */
    crouchSquash: 0.3,
    takeoffStretch: 0.34,
    landSquash: 0.44,
    /**
     * Seconds a letter tap made in mid-air is held and replayed on touchdown.
     * Short on purpose: it forgives the tap you made a beat early, and discards
     * the one you made at the top of the arc, which you did not mean for now.
     */
    airBuffer: 0.24,
    /** Touch swipe-up gesture, in world units and seconds. Lower rise = easier to trigger. */
    swipeRise: 110,
    swipeDrift: 200,
    swipeTime: 0.45,
    /** How close an unspellable wall gets before the one-time "you can hop this" prompt. */
    hintDistance: 620,
    /** Seconds that prompt holds. */
    hintHold: 1.7,
  },

  /** Letter-wall geometry, spawning and hit boxes. */
  walls: {
    /** Vertical spacing between blocks in a column. */
    blockGap: 116,
    /** Horizontal spacing between walls. Higher = more time per letter, easier. */
    wallGap: 620,
    /** Where the very first wall of the session is parked, beyond the right edge. */
    initialAhead: 260,
    /** Where a fresh word's runway starts, beyond the right edge. */
    seedAhead: 300,
    /** Walls seeded off-screen so the first one arrives on beat. */
    seedCount: 3,
    /** Height of the bottom block above the ground line. */
    baseLift: 62,
    /**
     * Hard bounds on a column, whatever a level's `pacing.columnHeight` asks
     * for — and the default range when it asks for nothing. Fewer blocks =
     * fewer decoys = easier. heightMax is a framing limit as much as a
     * difficulty one: taller than this and a column leaves the screen.
     */
    heightMin: 2,
    heightMax: 5,
    /** Scale-in speed on spawn, and how fast a neighbour's jolt settles. */
    bornRate: 3.4,
    joltDecay: 9,
    /** Mouse-hover highlight: reach as a fraction of block size, and how fast it lights. */
    hoverPad: 0.55,
    hoverEase: 14,
    /** x at which a wall left behind is recycled. */
    despawnX: -240,
    /** How far past the player a wall must travel to count as missed. Higher = more forgiving. */
    passedInset: 40,
    /**
     * Tap hit box as a fraction of block size. Higher = easier to hit on a phone.
     *
     * Sized off the phone, not the desktop. At 390x844 the stage fits by width
     * to ~0.305 CSS px per world unit, so the 108-unit cube is drawn only 33 CSS
     * px across — well under the 44 px a thumb needs. 0.72 and 0.70 put the
     * target at 47x45 CSS px there. The vertical pad is larger than half the
     * 116-unit column pitch, so neighbouring boxes overlap on purpose;
     * `blockAt` resolves that by nearest centre rather than by scan order, which
     * puts the boundary exactly where the eye puts it.
     */
    hitPadX: 0.72,
    hitPadY: 0.7,
    /** Extra slack on the coarse per-wall rejection test before per-block checks. */
    hitScanSlack: 40,
    /** Window a keyboard press searches for its letter, behind and ahead of the player. */
    keyReachBack: 30,
    keyReachAhead: 120,
  },

  /** Points, combo, lives and what a mistake costs. */
  scoring: {
    /**
     * Misses allowed before a setback, unless a level overrides it with
     * `rules.lives`. Higher = easier. Also sizes the HUD's heart row, which is
     * why a level asking for more than this gets them but cannot show them.
     */
    maxMisses: 3,
    /** Hardest difficulty tier any level's tier ladder may reach. */
    maxTier: 5,
    /** Base points for a smashed letter, before combo and tier multipliers. */
    perLetter: 50,
    /** Combo multiplier is 1 + min(combo-1, cap) * step. Higher = bigger streak rewards. */
    comboStep: 0.25,
    comboCap: 9,
    /** Points lost per tier on a miss, capped at the current score. Lower = kinder. */
    missPenaltyPerTier: 40,
    /** Fraction of the score surrendered to a setback, unless a level overrides
     * it with `rules.setbackCost`. Lower = kinder. */
    setbackScoreLoss: 0.15,
    /** World units the walls are shoved back on a setback — the ground you lose. */
    setbackPushBack: 320,
    /** Word-completion bonus: perTier * tier + perCombo * best combo. */
    wordBonusPerTier: 200,
    wordBonusPerCombo: 40,
    /** Share of points that also becomes cosmetic currency. */
    sparkShareLetter: 0.25,
    sparkShareWord: 0.3,
  },

  /**
   * Accessibility: the two settings the player owns rather than the designer.
   *
   * Both are deliberately *outside* the level model. A `LevelDef` says how hard
   * the game intends to be; these say how much of that intent the person at the
   * controls wants to take today, and they persist across sessions in
   * `Profile.settings` (see `game/settings.ts` for the labels the menu shows).
   */
  assist: {
    /**
     * World-speed multipliers, slowest first. Applied to the scroll — and
     * therefore to wall spawning, which is paced by distance — and to nothing
     * else. Dash timing, the hop, hit-stop, the clue hold and every input
     * window stay exactly as tuned, so the slow settings buy reading time
     * without making the character feel like he is wading.
     *
     * The floor is 0.6: at the first tier that is 154 units/sec, which gives a
     * five-year-old roughly four seconds per column instead of two and a half.
     * The ceiling is 1.25 — beyond it the top tier passes 450 units/sec, which
     * is past the point where a column can be read at all.
     */
    speeds: [0.6, 0.8, 1, 1.25],
    /** Index into `speeds` a fresh profile starts on. */
    defaultSpeed: 2,
    /**
     * Share of sparks and lifetime score an easy-mode word banks.
     *
     * Easy mode removes every cost of a mistake, so a word spelled in it is not
     * the same achievement as one spelled without the net — and with the combo
     * unbreakable the multiplier climbs to its cap and stays there. Earnings are
     * therefore discounted rather than the mode being walled off from the
     * economy: a child playing on easy still watches the sparks come in and can
     * still buy the pink hedgehog, it just takes the time it should.
     */
    easyEarnShare: 0.4,
  },

  /** Camera lead and lift. Small numbers here; the effect is felt, not seen. */
  camera: {
    zoomBase: 1,
    /** Punch-in on a dash and during the victory dance. Higher = more theatrical. */
    zoomDash: 1.035,
    zoomCelebrate: 1.06,
    zoomEase: 6,
    /** Vertical lift while dashing, world units. */
    liftDash: -12,
    liftBase: 0,
    liftEase: 5,
  },

  /** Impact feedback and the pacing of the non-playing phases. */
  feel: {
    /** Seconds the clue holds before the walls become live. Higher = easier. */
    listenHold: 0.9,
    /** Seconds the setback banner holds before control returns. */
    setbackHold: 1.3,
    /** Seconds of confetti before the next word is picked. */
    celebrateHold: 2.4,
    /** Seconds into the listening phase the clue card starts leaving, and how long it takes. */
    clueFadeAt: 2.2,
    clueFadeTime: 0.8,
    /**
     * Seconds the clue stays up when the player asks for it back mid-word.
     * Long enough to read a wrapped clue twice, short enough that it clears
     * itself before the next letter arrives. Higher = more forgiving.
     */
    hintHold: 3.4,

    /** Screen-shake magnitudes in world units, and their durations. Lower = calmer. */
    shake: {
      smash: 9,
      /** Combo count at which the smash shake stops growing. */
      smashComboCap: 8,
      smashTime: 0.22,
      /** A wall rolling past kicks softer than bouncing off one. */
      missPassed: 6,
      missHit: 14,
      missTime: 0.26,
      setback: 26,
      setbackTime: 0.5,
      word: 16,
      wordTime: 0.5,
    },
    /** Seconds the whole sim freezes on a smash. Higher = heavier, but muddier at speed. */
    hitStopSmash: 0.035,
    /** Full-screen flash strengths, and how fast any flash drains. Higher decay = shorter. */
    flash: { smash: 0.5, miss: 0.4, setback: 0.85, word: 0.7, decay: 3.4 },
    /** Smash sample pitch: base plus a step per combo, up to `shake.smashComboCap`. */
    smashPitchBase: 0.8,
    smashPitchStep: 0.04,

    /** Decay rates for the small HUD animations. Higher = snappier. */
    comboFlashDecay: 2.2,
    speakerPulseDecay: 1.6,
    slotPopDecay: 2.6,
    /** How hard the displayed score chases the real total. Higher = less roll-up. */
    scoreEase: 16,
    /** Score popups: upward drift per second, lifetime, and how many are kept on screen. */
    floater: { rise: 76, life: 1.1, max: 24 },
  },
};
