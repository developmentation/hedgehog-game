# Is this a 2.5D engine?

An assessment of `src/engine` + `src/core` as a foundation for future 2.5D
games, written read-only against the tree at `cc3b784`.

Every performance claim below is measured, on this machine, with the harness
described in [Method](#method). Nothing here is estimated from theory.

---

## Verdict first

**Option (b): keep building the game, and extract when a second game exists —
with one carve-out taken now.**

Not because the code is not good enough to extract. It is: the renderer, the
loop, the atlas, the RNG and the particle pool are better than most of what
ships in this category, and the coupling audit found exactly **one** illegal
import in the whole tree. The reason is that an extracted package would be
extracted against a guess about what the second game needs, and this codebase
has an unusually strong track record of doing the opposite — every good
decision in `gl.ts` and `parallax.ts` was made *after* a measurement said the
previous one was wrong. Extracting now spends that method's budget on a
consumer that does not exist.

The carve-out is small and I would do it this week: **cut the four things that
make `engine/` non-reusable in principle** (§1.3). It is about three days, it
is not speculative, and it makes option (a) cheap to take later instead of
expensive.

And the load-bearing finding, which is not about code at all:

> **The art pipeline bakes the lighting and the projection into the albedo.**
> `tools/artspec.mjs` locks a STYLE preamble that specifies *"clean orthographic
> side view as if photographed straight-on for a 2D game layer, no perspective
> distortion, no vanishing point"* and *"a low warm golden sun from the RIGHT
> side, producing warm amber rim-light on right-facing edges and deep cool
> blue-violet shadows on the left."* Both statements are true of every one of the
> 32 shipped PNGs.

A 2.5D game wants a three-quarter projection and *dynamic* light. You cannot
get either from art that already has one baked in — relighting a sprite whose
shadows are painted on gives you two light directions in the same frame. This
is a one-way door that has already been walked through, and it is a bigger cost
than every renderer change in this document combined (§2.4, §2.5).

Rewriting the renderer for 2.5D first (option (c)) is the wrong order for
exactly that reason: it would deliver a lighting pass that the art cannot feed.

---

## 1. What is genuinely reusable

### 1.1 Reusable as-is, today, with no changes

These have zero game knowledge and would drop into a second project unmodified.

| File | Lines | Why it is good |
|---|---|---|
| `src/engine/gl.ts` | 1078 | Zero imports. Instanced batcher where *nothing* breaks a batch — 8 texture slots with a binary-split selector, additive expressed per-fragment instead of as blend state, so a whole pass is one draw call. Exact frustum rejection in `draw()`. Adaptive render-scale controller with a real control law (p70 of a 24-frame window, pinned ceiling, doubling backoff). |
| `src/engine/loop.ts` | 115 | Zero imports. Fixed step + interpolation alpha + debt shedding + visibility handling. Nothing to change. |
| `src/engine/rng.ts` | 54 | Zero imports. Seeded mulberry32. The only wart is the module-level `export const rng = new Rng()` singleton sitting beside the per-`Ctx` instance. |
| `src/engine/atlas.ts` | 221 | Shelf packer + `Painter` interface. Genuinely generic; the only hedgehog in it is a doc comment. |
| `src/engine/assets.ts` | 169 | Manifest loader with a size threshold that decides atlas vs standalone. Generic mechanism. |
| `src/core/stack.ts` | 69 | Scene stack. Draws all, updates top. Two lines of game in it (a hardcoded clear colour). |
| `src/core/debug.ts` | 107 | Perf overlay. Reads only engine surfaces. |
| `src/game/particles.ts` | 179 | Misfiled — this is engine code. Fixed-capacity struct-of-arrays, swap-remove, zero allocation after construction, two-pass blend grouping to avoid a flush per particle. Move it to `engine/` unchanged. |

### 1.2 The idioms worth keeping, not just the files

Three patterns in here are better than the code they live in and should
survive any refactor:

- **`Frame` is a value, not a handle.** It is a flat struct of `{tex, u0..v1,
  w, h, px, py}`, so `parallax.ts` can synthesise new ones at init time —
  `sub()` crops, `subFlip()` samples bottom-to-top to turn a stalagmite ridge
  into a stalactite ceiling, `solid()` makes a 1×1 frame that reads a single
  texel so a full-screen colour wash batches with whatever texture is already
  bound, and `trimmed()` crops to the ink box while *moving the pivot so the
  caller's arithmetic is unchanged*. That last property — a crop with no
  consequences — is what made the 33% overdraw reduction possible without
  touching a single layout number. Do not turn `Frame` into a class.
- **Content is data, composition is code.** `ThemeDef` holds every id, crop,
  tint and count; `parallax.ts` holds the scroll rates, wrap arithmetic and
  draw order. Adding a theme is one object literal. This is the correct seam
  and it generalises directly to a 2.5D world.
- **Measure, then decide, then write down why.** `PERF-BASELINE.md` §3 kills a
  depth pre-pass with three measurements and states the occlusion ceiling
  (0.03%). The comments in `gl.ts` explain what was tried and reverted. That is
  the actual reusable asset here.

### 1.3 What is tangled, specifically

Four things, and only four. None is deep.

**a. `src/engine/input.ts:17` imports `TUNING` from `src/game/tuning`.** The
only engine→game edge in the tree, and it is a value import so it is a real
bundling edge. Used at `input.ts:129-133` for three swipe-gesture thresholds.
Also `input.ts:152-159` forwards only `A`–`Z` — a reused engine silently eats
digits and punctuation — and `jumpPressed` (`input.ts:66`) is a platformer verb
in an engine header. *Fix: constructor options + an action map. Half a day.*

**b. `src/engine/save.ts` is a hedgehog profile schema, not a save system.**
`DB_NAME = 'spindash-speller'`. The `Profile` interface hardcodes `sparks`,
`equipped: {skin, trail, spin}`, `wordStats: Record<string, WordStat>`,
`easyWords`. `levelRecord`/`noteLevelPlay`/`noteLevelScore`/`noteLevelClear`
(L177-245) are game progression logic living in `engine/`. There *is* a
genuinely generic kernel inside it — `openDb()` and the IDB + localStorage
mirror + coalesced-write machinery (L251-412) — welded to `Profile` only
through one field and `migrate()`. *Fix: make the store generic over `T`,
move the profile shape and the level-record helpers to `game/`. One day.*

**c. `src/engine/audio.ts` is a very good synth bus with a game cue table
bolted on.** The primitives (`ampEnv`, `makeFilter`, `panner`, `tone`, `noise`,
the duck bus, the limiter chain, the speech watchdog) are all reusable. But
`SfxName` (L24-34) is this game's ten cues, `TRIM` (L92-103) is their mix, and
`play()` is a 230-line hardcoded `switch` synthesising them. `resetCombo()`
(L839) is a scoring concept. *Fix: lift the cue table out as data the game
supplies. One to two days — the extraction line is already clean.*

**d. `src/core/ctx.ts` is a game header wearing an engine header's name.** It
exports `GROUND_Y = 560`, `PLAYER_X = 300`, `WORD_BAR_H = 132`, and the entire
`PlayProbe` interface (`phase: 'listening' | 'celebrate' | 'setback' | ...`,
`word`, `revealed`, `targets: {letter, ...}[]`). Every module that wants
`clamp` imports from the file that defines the hangman bar's height.

**Total: about three days.** After it, `engine/` genuinely has no game in it.

### 1.4 Is `Ctx` a clean seam or a god object?

**A service locator, not a god object** — and closer to clean than not.

It holds almost no state of its own (`cam`, `time`, `alpha`, `timeScale`,
`rawMode`, `reducedMotion`) and every other field is a real engine service. 21
modules take it. Usage is not uniform: `atlas` (16 files, 105 refs) and `r` (16
files, 73 refs) are the true hub; `alpha` and `timeScale` are written by
`main.ts` and read by nobody; `hitStop` has two call sites.

The one real problem is that it is *one* interface shared by engine and game,
so `save: SaveStore` drags the hedgehog `Profile` into the type graph of every
module in the project — including `ui/text.ts`, which wants a renderer and a
font. The fix is a split, not a diet:

```
interface Engine { r; atlas; assets; input; audio; rng; time; alpha; timeScale; reducedMotion }
interface Ctx extends Engine { save: SaveStore<Profile>; cam; shake; hitStop; rawMode }
```

Mechanical, roughly a day, and it is the same day as §1.3d.

### 1.5 Does `Scene` compose?

Weakly, and that is mostly fine.

`SceneStack` (69 lines) draws every scene bottom-to-top and updates only the
top, which is exactly right for a pause overlay over a frozen game. What it
does not have: `pause`/`resume` hooks, a per-scene camera, or any way for a
scene to opt into updating while covered. What it should not have but does:
`r.clear(0.055, 0.075, 0.18)` — an art decision hardcoded in the scene stack —
and a hardwired two-pass structure (world pass with camera, HUD pass without).

The two-pass split is *correct* and worth keeping; the measurement in
`PERF-BASELINE.md` §2 shows keeping the HUD native costs 0.78 ms and buys back
the only part of the image a resample visibly destroys. But it belongs in a
game-supplied pass list, not in the stack.

Scenes also know each other by name: `play.ts` imports `openLevelSelect` from
`scenes/levelSelect` and `openShop`/`roundedPanel`/`roundedRing` from
`scenes/shop`, and `ui/pauseButton.ts` imports `roundedPanel` from
`scenes/shop` — a UI widget reaching into a scene for a drawing primitive.
Minor, but it is the kind of thing that makes a second game's `scenes/` folder
inherit the first game's.

### 1.6 Could a second game reuse the renderer without the word bank?

**Yes, today, unchanged.** `gl.ts` has zero imports. `Renderer` +
`Atlas` + `Loop` + `Rng` + `Particles` is a working, fast 2D sprite stack you
could start a new game on this afternoon. You would have to write your own
`Input`, or accept the `TUNING` import; and you would not want `save.ts` or
`audio.ts`'s cue table.

What you would *also* inherit, and should know about: `resize()`
(`gl.ts:451-543`) is not a generic aspect-fit. It never letterboxes, it
anchors the world to the **bottom** on tall screens because "the ground and
word bar stay pinned to the bottom edge", and past a 2.6× vertical extension it
bands the viewport with the band biased to 68% below centre for thumb reach.
That is a very good policy *for a horizontal side-scroller with a bottom-docked
HUD*. It is the wrong policy for a top-down or isometric game, which wants to
centre. It should become a strategy, not a constant.

---

## 2. What 2.5D actually needs

Costs assume one engineer working the way this codebase has been worked —
measured, documented, with the golden-frame guard kept green.

### 2.1 A z-axis and depth sorting — **2–3 weeks, and it is the hard one**

**Exists:** nothing. Depth is the *order of the six lines* in
`PlayScene.draw()` (`play.ts:1398-1409`): parallax, hero shade, blocks,
particles, hero, foreground foliage. The GL context is created with
`depth: false` (`gl.ts:345`). Within the backdrop, depth is eleven bands drawn
in a fixed sequence at nine hardcoded scroll rates (`F_MTN = 0.04` …
`F_CANOPY = 2.9`).

**Missing:** a per-sprite z, a sort, and any notion that draw order is derived
rather than authored.

**The sort itself is free.** Measured, 20 reps, same machine:

| sprites | `Array.sort(idx, cmp)` | radix-16 (exact) | bucket-1024 (y-band) |
|---|---|---|---|
| 500 | 0.37 ms | 0.61 ms | **0.13 ms** |
| 2 000 | 1.04 ms | 0.20 ms | **0.05 ms** |
| 10 000 | 5.53 ms | 0.21 ms | **0.09 ms** |
| 50 000 | 34.62 ms | 0.51 ms | **0.31 ms** |

A counting sort on a quantised depth key costs 0.09 ms at ten thousand
sprites. `Array.prototype.sort` with a comparator costs 5.5 ms at the same
count and 34.6 ms at fifty thousand — a 60–110× difference, and the single
easiest way to accidentally make a 2.5D renderer slow.

**So why is it 2–3 weeks?** Because of what sorting does to the *batcher*, and
this is the most important architectural point in this document:

> `Renderer.draw()` writes each instance straight into the array in call order
> and assigns a texture slot with a `lastSlot` cache that "is nearly always a
> hit because runs of sprites share a texture" (`gl.ts:984-999`). The batch
> flushes when the 8 slots are exhausted. **That works today because draw order
> is grouped by layer, and layers are grouped by texture.** A depth sort
> destroys exactly that locality: after sorting by z, consecutive sprites are
> neighbours in space, not in texture, and slot exhaustion could split the
> batch every few sprites.

Concretely, `draw()` must stop being submit-and-emit and become
collect → sort → assign slots → emit, with texture-slot assignment happening
*after* the sort. That is a real rewrite of the batcher's middle, and it
interacts with `flush()`, `spritesCulled`, and the blend-mode packing.

Mitigations exist and are cheap once you know the shape: 8 slots is generous,
and a 2.5D world that keeps its geometry on 1–3 atlases never exhausts them.
But "the number of source textures visible in one depth range must stay under
8" becomes a hard content constraint the current design does not have.

**Can a depth buffer avoid the sort?** No, and this repo already proved it.
`PERF-BASELINE.md` §3a measures ink coverage per asset: only `sky_dusk` is
opaque (1.00); everything else is 17–57% ink. Alpha-blended sprites cannot be
z-tested into the right order. **2.5D on painted alpha art needs a CPU sort,
not a depth buffer** — the hardware cannot help.

**Blocked by:** the batcher's submit-order assumption. Nothing else.

### 2.2 A camera with more than x/y/zoom — **1 week**

**Exists:** `Camera {x, y, zoom, shakeX, shakeY}` (`ctx.ts:30-37`).
`Renderer.begin()` hand-builds the ortho matrix from six scalars
(`gl.ts:574-583`) and derives the cull rect analytically:
`cullL = camX + viewLeft / zoom` (`gl.ts:591-595`).

**Missing:** rotation, off-axis projection, per-layer or per-depth cameras.
Note that parallax today is *not* a camera feature — `parallax.ts` implements
it by multiplying the scroll distance by a per-layer factor. In real 2.5D,
parallax falls out of z plus a projection and stops being nine hand-tuned
constants.

**Cost:** replace the hand-built matrix with a general view-projection, and the
analytic cull rect with a transformed AABB. `screenToWorld` / `worldToScreen`
(`gl.ts:546-559`) assume axis-alignment too and follow. About a week including
re-proving the golden frames.

**Blocked by:** nothing structural. This is the cheapest of the big four.

### 2.3 Transform hierarchy / parenting — **do not build it**

**Exists:** nothing. Every sprite is drawn at absolute world coordinates the
caller computed; `playerDraw.ts` composes the hero from hand-written offsets.

**Position:** a general scene graph is cargo cult for this shape of game. The
number of composite actors in a 2D/2.5D sprite game that genuinely need
parenting is small (a character and the thing it carries), and a helper that
composes two transforms at the call site costs an afternoon versus a graph
that every system then has to traverse and every sprite pays for.

If a future game needs deep hierarchies (a skeletal animation system, say),
build that system's own local transform composition. Do not put a graph
between `draw()` and the batcher — the batcher's whole value is that
submission is a flat, allocation-free write.

### 2.4 Normal maps and a lighting pass — **3–4 weeks engine, open-ended art**

**Exists:** nothing dynamic. All lighting is *painted in* — the `parallax.ts`
header describes building the frame "top to bottom as a value ramp", with
highlights "bought locally" by a lit cloud bank and a rake along the soil, and
distance sold "by hue and value — never by alpha". `ThemeDef` tints are
multipliers up to 3.46. It is a good, coherent, entirely static lighting model.

**Missing:** a normal channel anywhere in the pipeline, a second texture bound
per sprite, a normal-map index in the instance, and a light pass.

**Measured cost.** Same GPU class as the baseline, 2560×1440 backbuffer,
geometry built to the game's own measured 4.62× overdraw, only the fragment
program varying:

| fragment program | GPU-synced ms | vs base |
|---|---|---|
| base (shipped: 8-slot select, grade, IGN dither, per-fragment additive) | 7.57 | 1.00× |
| + normal-map fetch, unused | 7.82 | 1.03× |
| + normal + 2 point lights | 8.79 | 1.16× |
| + normal + 4 point lights | 10.85 | **1.43×** |
| + normal + 8 point lights | 15.45 | **2.04×** |
| base geometry + **one** full-screen 8-light pass | 11.25 | 1.49× |

The second texture fetch is nearly free (+3%). **The lights are not, and the
reason is overdraw.** Forward lighting pays per *fragment*, and this scene
shades every pixel 4.62 times, so it pays for every light 4.62 times. Eight
lights forward costs +7.88 ms; the same eight lights evaluated once per screen
pixel cost about +2.0 ms after subtracting the base shading the full-screen
quad also does — a ~4× saving that matches the overdraw ratio exactly.

**So the design conclusion is firm: on this renderer, lighting belongs in a
screen-space pass, not in the sprite shader.** That means a G-buffer (albedo +
normal), which means the world pass writes two render targets, which the
offscreen render-scale path (`bindWorldTarget`, `gl.ts:833`) currently does not
do — it attaches a single RGBA8 *renderbuffer* precisely because it is only
ever blitted, never sampled. That becomes two sampled textures.

**Blocked by, structurally:** `Frame` has one `tex` (`gl.ts:196-208`), and
`Atlas.bake()` bakes one canvas into one texture (`atlas.ts:86-163`). A normal
map needs a second atlas with *byte-identical packing*, which neither
`atlas.ts` nor `AssetLibrary` can express today.

**Blocked by, actually:** the art. `tools/artspec.mjs` bakes a fixed sun
direction into the STYLE preamble, and every shipped PNG has amber rim-light on
its right edge and blue-violet shadow on its left. Lighting those sprites
dynamically gives you two suns. Getting normal maps at all means either
deriving them from luminance (which, on art that already has painted shadows,
derives the *painted* shadow as geometry — wrong, and convincingly wrong, which
is worse) or regenerating the whole set with a flat-lit albedo pass plus a
separate normal pass. That is 32 assets and a re-prompted, re-validated
pipeline. I will not put a number on it; it is the largest single item in this
document and it is not engine work.

### 2.5 Skewed / perspective ground planes — **1 week, as a second program**

**Exists:** nothing. The vertex shader computes
`(a_corner - pivot) * halfExtent` then applies a 2×2 rotation from
`(cos, sin)` (`gl.ts:76-81`). Every quad is an axis-aligned rectangle with a
2D spin. There is no way to express four arbitrary corners, and no perspective
divide — `gl_Position.w` is always 1.

**Two options:**

- **Affine shear in the existing format.** `a_rot` is `(cos, sin, pivotX,
  pivotY)`; a general 2×2 needs four numbers, so the pivot has to move
  elsewhere. Gets you skew, gets you no foreshortening *within* a quad — a
  ground plane would be a parallelogram, not a trapezoid. Cheap, and honestly
  enough for a lot of 2.5D looks.
- **A second, small program for ground geometry.** A real 2.5D ground plane is
  1–20 quads, not thousands. Give them their own VAO and shader with four
  corners and a real perspective matrix, draw them in their own pass, leave the
  sprite batcher alone. **This is the right answer**, and it is the one the
  architecture is already shaped for — the renderer's whole thesis is "one
  pass, one draw call", and a handful of ground quads is a second draw call.

The art-pipeline caveat applies again: the STYLE preamble says *"no perspective
distortion, no vanishing point"*, so there is currently no asset that would
look correct on a perspective plane.

### 2.6 Tilemaps — **1 week, purely additive**

**Exists:** no data structure, but the *idiom* everywhere. `drawLayer()`,
`drawRow()`, `drawHang()` and the ground/bank loops in `parallax.ts` each
hand-write index arithmetic of the form
`i0 = floor((off + viewLeft) / tileW); i1 = ceil((off + viewRight) / tileW)`,
with mirroring on alternate tiles and per-tile skyline rise. That is a tilemap
renderer written five times.

**Missing:** a grid, a tile→`Frame` map, chunked culling.

**Cost:** about a week for a chunked tilemap that submits into the existing
batcher. Nothing blocks it. Note the batcher already handles the volume — 20 000
instances submit and draw in 1.68 ms, 60 000 in 4.94 ms — but `main.ts:26`
constructs the renderer with `capacity = 24576`, which a tilemap would want
raised.

### 2.7 Occlusion culling — **do not build it**

**Exists:** exact frustum rejection in `draw()`, measured to bring
fully-offscreen sprites reaching GL from 17.9/frame to **0**.

**Position: cargo cult, and the repo has already proved it.**
`PERF-BASELINE.md` §3b rasterised every world-pass quad into a 160×90 coverage
grid in draw order and measured the area covered by a later fully-opaque quad —
exactly the fill a front-to-back test could skip:

```
world-pass fill      3.959 screens
occluded by opaque   0.001 screens   (0.03%)
```

The ceiling is 0.03% because the previous pass already cropped every band to
the strip where it is the frontmost thing painted. Static geometric cropping is
a depth pre-pass computed once at build time. A 2.5D game with large *opaque*
foreground geometry could change this arithmetic — but not one built on painted
alpha sprites at 17–57% ink coverage.

### 2.8 Shadows that are not a blob — **1 week**

**Exists:** a blob. `player.drawShade()` is called before the blocks
(`play.ts:1400-1402`) so the pool of shade lands on the ground rather than
washing over an adjacent column; contact shading lives in `playerFx.ts` /
`playerDraw.ts`.

**The realistic 2.5D options, in order of value:**

- **Sheared silhouette.** Draw the caster's own frame a second time, sheared
  along the light direction, flattened toward the ground plane, in flat dark.
  In *this* batcher that is one extra instance per caster on a texture that is
  already bound — no batch break, no extra bind, no second pass. Needs the
  shear from §2.5. Cheap and it reads as a real shadow.
- **Shadow maps.** No. They need depth, and depth does not work with
  alpha-blended sprites (§2.1).

**Blocked by:** the shear, and by §2.1 if you want the shadow to sort correctly
against other geometry.

---

## 3. The structural questions

Positions, with reasons.

### ECS — **no**

Cargo cult here, and the codebase already has the only part that matters.
`particles.ts` is a struct-of-arrays pool with swap-remove and zero allocation
after construction; `wallField.ts` manages its own homogeneous arrays. Those
are precisely the two places where archetype storage pays, and both already
have the memory layout an ECS would give them, without the indirection. The
entity counts — one hero, ~10 walls, ≤2048 particles — do not justify a
component registry. What an ECS is usually bought for is the *discipline* of no
per-frame allocation, and this codebase already keeps that discipline
explicitly ("nothing allocates after a theme is built", `parallax.ts:68`).

If a future game has 50 000 heterogeneous entities, revisit. It will not be a
spelling game or a platformer.

### Scene graph — **no as a data structure, yes as a concept**

2.5D *replaces* a scene graph with a depth sort, and the sort is strictly
simpler and demonstrably cheap (§2.1). Build the sort. Do not build a graph.

### Asset registry beyond a manifest — **yes, and it is the cheapest of the four**

This one is genuinely needed and pays for itself immediately. Today
`AssetLibrary.get(id)` returns `Frame | null` and every consumer writes its own
fallback: `parallax.ts` has `if (!raw || !spec) continue`, `if (!raw) return
null`, and a `has()` guard on a theme's "irreducible core"
(`parallax.ts:431-434`). A missing asset id is a silent runtime degradation
today; it should be a build-time error.

A registry should know three things the manifest does not:

1. **Variants per id** — `albedo` / `normal` / `emissive`. This is the
   precondition for §2.4 and it does not exist in any form.
2. **Load groups**, so a level can preload its theme instead of the boot
   loading all 32 assets.
3. **Ids as a checked type**, so `a.get('tree_oak')` fails to compile if the
   asset is not in the manifest.

About a week. Do this before anything else on the 2.5D list.

### A serialisation format for levels beyond a TS literal — **no, and this is the strongest "don't" here**

`LevelDef` and `ThemeDef` as TypeScript literals give you: compile-time type
checking, jump-to-definition, refactor-rename, dead-code elimination, zero
parser, zero schema drift — and *comments*. That last one is not a nicety in
this codebase. `themes.ts` documents that `LayerDef.band` is "the strip that is
BOTH painted AND visible", that `GroundDef.surface` is "the walkable row: first
row at ~95% opaque coverage… wrong by fifty units and the hero walks along
inside the dirt bank", and that a multiplier above 1.0 is only ever right for
art that is dark. `levels.ts` explains why the RNG consumption order must not
be shuffled. JSON would throw all of that on the floor.

What JSON buys is "an editor could write it" — which matters exactly when there
is an editor, and there isn't. **If an editor ever arrives, have it emit a TS
literal.** That is a two-hour code generator and you keep everything above.

The one thing worth adding now is a *validator* so a hand-edited level cannot
silently degrade — and `resolveLevel()` (`levels.ts:217-260`) already does
most of it: it clamps every range, falls back to the whole word bank if a
filter matches nothing, and resolves an unknown theme to `meadow` rather than
failing to boot. Extend that, do not replace it.

### An editor — **premature, but one specific tool is not**

Do not build a level editor. Do build the thing that is currently done by hand
and is *provably* mechanical: every fraction in `themes.ts` is measured off a
PNG's alpha channel. `PieceSpec.u0..v1` is "the tightest rectangle outside
which the painting has nothing above ~18% alpha". `GroundDef.surface` is "first
row at ~95% opaque coverage". `LayerDef.u` is "widest column window that is
fully opaque". A human is reading pixel coordinates out of an image and typing
them into a literal.

A tool that emits those `PieceSpec` blocks from the PNGs — extending
`tools/artspec.mjs`, which already owns the asset descriptions — removes the
single most error-prone manual step in the content pipeline, and it becomes
*mandatory* the moment there is a second texture (a normal map) whose packing
must match the albedo exactly. Two to three days, high value, do it early.

---

## 4. The instance layout

**The load-bearing question, and the answer is: the layout has enormous room —
so much that a 2.5D layout carrying *more* data can be *smaller and faster*
than today's. The cost of migrating is not bytes and it is not throughput. It
is the shape of `Renderer.draw()`.**

### 4.1 What is actually there

The brief says 16 floats / 64 bytes. The tree at `cc3b784` is **17 floats / 68
bytes** — a `a_mode` float was added carrying the texture slot in bits 0–2 and
the additive flag in bit 3 (`gl.ts:19-24`, `1025`).

```
0..3    a_xform  f32×4   x, y, halfW, halfH
4..7    a_rot    f32×4   cos, sin, pivotX, pivotY
8..11   a_uv     f32×4   u0, v0, u1, v1
12..15  a_color  f32×4   r, g, b, a
16      a_mode   f32×1   texSlot(3 bits) | additive(1 bit)
```

### 4.2 The headroom nobody is using

Every field in that layout is stored at 32-bit float precision, and **only one
of them needs it**:

| field | range | precision actually needed | honest format | bytes |
|---|---|---|---|---|
| `x, y, halfW, halfH` | world units, unbounded | full | f32×4 | 16 |
| `cos, sin` | −1…1 | ~1e-4 | **snorm16×2** | 4 |
| `pivotX, pivotY` | −1…1 | ~1e-4 | **snorm16×2** | 4 |
| `u0, v0, u1, v1` | 0…1 | atlas is ≤4096px, so a texel is 1/4096; unorm16 gives 1/65536 — **16× finer than one texel**, and the half-texel inset is 8 steps | **unorm16×4** | 8 |
| `r, g, b, a` | 0…3.6 (`TINT_CAP`) | tints are multipliers; half-float holds 3.46 with ~3 decimal digits | **half×4** | 8 |
| `mode` | 4 bits used of a 24-bit-exact mantissa | — | **ubyte×4** | 4 |

Note the colour constraint is real and easy to get wrong: `parallax.ts` uses
tint multipliers up to 3.46 with a cap of 3.6, so a naive `UNSIGNED_BYTE`
normalised colour attribute — the usual sprite-batcher trick — **would clip
every painted layer in the game.** Half-float is the correct choice, not
uint8.

That gives a 2.5D-capable layout of **48 bytes** that carries strictly *more*
than today's 68:

```
off  0  f32×4    x, y, halfW, halfH
off 16  f32×1    z                          <- NEW: depth
off 20  snorm16×4 cos, sin, pivotX, pivotY
off 28  unorm16×4 u0, v0, u1, v1
off 36  half×4   r, g, b, a
off 44  ubyte×4  texSlot|blend, normalIdx, lightMaskLo, lightMaskHi   <- NEW ×3
        = 48 bytes
```

A depth float, a normal-map index and a 16-bit light mask, for **20 bytes less
than today**.

### 4.3 Measured

Three layouts, identical vertex maths, 3 px quads so the measurement is
attribute-bound rather than fill-bound. `fill` is the CPU write into the typed
array; `upload+draw` is `bufferSubData` + `drawArraysInstanced` with a forced
GPU sync; `frame` is both together. Medians of 5 interleaved rounds.

| sprites | layout | bytes/frame | fill ms | upload+draw ms | frame ms |
|---|---|---|---|---|---|
| **300** *(the shipped frame is ~292)* | current 68 B | 20 KB | 0.003 | 0.029 | 0.283 |
| | grown 80 B | 24 KB | 0.007 | 0.053 | 0.278 |
| | packed 48 B **+z** | 14 KB | 0.005 | 0.018 | 0.304 |
| **20 000** | current 68 B | 1.36 MB | 0.213 | 1.281 | 1.682 |
| | grown 80 B | 1.60 MB | 0.243 | 1.552 | 1.753 |
| | packed 48 B **+z** | 0.96 MB | 0.233 | **1.092** | **1.259** |
| **60 000** | current 68 B | 4.08 MB | 0.560 | 2.957 | 4.937 |
| | grown 80 B | 4.80 MB | 0.697 | 4.253 | 5.270 |
| | packed 48 B **+z** | 2.88 MB | 0.700 | **2.947** | **3.817** |

Read three things off that table:

1. **At the game's actual scale, the layout is irrelevant.** At ~300 sprites
   all three arms are inside the noise floor. 292 sprites × 68 bytes is 20 KB a
   frame, 1.2 MB/s at 60 Hz. Any argument for changing the layout *for this
   game* is an argument from aesthetics, not from measurement.
2. **Growing it naively is the wrong move but not a catastrophe.** Appending
   three floats (68→80 B) costs +7% frame time at 60 000 sprites, +4% at 20 000,
   nothing at 300. If you want z and a normal index and nothing else, appending
   them is a legitimate, ugly, working choice.
3. **Packing is a real win at scale and it is free of regret.** 48 bytes
   carrying *more* data is 23% faster per frame at 60 000 and 25% at 20 000.
   Honest caveat: the CPU-side write got slightly *slower* (0.56 → 0.70 ms at
   60 000) because packing needs a float→half conversion and writes through
   several typed-array views over one `ArrayBuffer`. The GPU saving more than
   pays for it, but the trade is real and worth knowing if a future game is ever
   CPU-submit bound rather than GPU bound.

### 4.4 The migration cost, honestly

**The byte layout is the easy half.** It is contained entirely in `gl.ts`:
`FLOATS_PER_INSTANCE`, the six `vertexAttribPointer` calls in the constructor,
the write block in `draw()` (`gl.ts:1001-1027`) and the two shaders. A day,
maybe two with the half-float helper and a golden-frame re-prove.

**The API is the hard half, and it is not hard for the reason you would guess.**

There are **152 `r.draw(...)` call sites** across 14 files:

```
parallax 17 · playerDraw 19 · wallField 10 · shop 26 · hud 29 · plate 16
levelSelect 9 · jumpButton 4 · pauseMenu 4 · play 2 · pauseButton 2 · others 3
```

The signature is fully positional —
`draw(f, x, y, scaleX, scaleY, rot, r, g, b, a)` — so **appending `z`,
`normalIdx` and `lightMask` at the end is source-compatible with all 152 of
them.** No call site has to change to adopt the new layout. That is a genuinely
lucky property of the existing API and it makes the mechanical migration
close to free.

What is *not* free:

- **`z` at position 11 of a positional signature is a bad API** for a renderer
  whose central concept is depth. If depth is the point, it wants to be near
  the front, and moving it means touching all 152 sites. That is a day of
  mechanical editing plus a golden re-prove — annoying, not expensive. Do it
  once, deliberately, rather than living with `draw(f, x, y, 1, 1, 0, 1, 1, 1,
  1, z)` forever.
- **The batcher must become collect → sort → assign → emit** (§2.1). *This* is
  the real cost, it is independent of the byte layout, and it is where the
  weeks go.
- **Every one of the 152 call sites has to decide what its z is.** For the six
  lines of `PlayScene.draw()` that is trivial. For the eleven parallax bands it
  means converting nine hand-tuned scroll-rate constants into depths that
  produce the same rates — which is a *content* migration of a scene that has
  been visually tuned very carefully, guarded by golden frames that will all go
  red at once.

**Recommendation on the layout specifically:** do not touch it now. It costs
nothing at this game's scale and there is no second consumer to design against.
When 2.5D work actually starts, go straight to the 48-byte packed layout — skip
the naive grown version entirely, because it is measurably worse than the packed
one on every axis and the migration cost is identical.

---

## 5. The three options, costed

### (a) Extract an engine package now

**Cost: 3 days for the honest version, 3–4 weeks for the real one.**

The 3-day version is §1.3: cut the four game leaks and you have a directory
you *could* copy. The 3–4 week version is what an actual package needs —
`Ctx`/`Engine` split, a generic `SaveStore<T>`, a data-driven audio cue table,
an input action map, a resize strategy instead of a bottom-anchor constant,
`particles.ts` moved, a build setup, and a second consumer to prove any of it.

**Against:** you would be designing the seams against a hypothesis. This
codebase's method is measure-then-decide, and there is nothing to measure yet.
The evidence that this matters: the resize policy in `gl.ts` looks generic and
is deeply specific; you only find that out by trying to use it for a top-down
game.

### (b) Keep building, extract when a second game exists

**Cost: 3 days now (§1.3), and the extraction is cheaper later than now.**

The tree is already 95% of the way there — one illegal import, four inlined
schemas. The remaining 5% is exactly the part that needs a second consumer to
get right. Taking the 3 days now means the boundary is *stated* even though it
is not enforced by a package boundary, which is most of the value.

**Against:** boundaries that are not enforced erode. Mitigate with a lint rule
banning `src/engine/**` → `src/game/**` imports — that is an hour, and it would
have caught `input.ts:17`.

### (c) Rewrite the renderer for 2.5D first

**Cost: 8–12 weeks engine, plus an art regeneration I cannot bound.**

Sum of §2: depth + sort (2–3 weeks, the batcher rewrite), camera (1 week),
G-buffer + screen-space lighting (3–4 weeks), ground-plane program (1 week),
tilemap (1 week), shadows (1 week), asset registry (1 week). Then the content
migration: eleven parallax bands and every golden frame.

**Against, decisively:** it delivers a lighting pass the art cannot feed. Every
shipped asset has a fixed sun baked into it and was generated under a prompt
that forbids perspective. You would finish a renderer capable of dynamic light
and discover the only thing you can point it at is 32 PNGs that are already
lit. **Do the art-pipeline question first** — regenerate two or three assets as
flat-lit albedo plus a normal pass, look at them, and find out whether the
generator can even produce a usable normal map. That is a few days and it
determines whether §2.4 is a 3-week project or an impossible one.

### What I would do

**(b), plus this order:**

1. **This week — 3 days.** The four cuts in §1.3. Add the lint rule.
2. **Next — 3 days.** The `PieceSpec` measuring tool (§3). It removes the most
   error-prone manual step today and becomes mandatory the moment a second
   texture per sprite exists.
3. **Before committing to any 2.5D plan — a few days.** Regenerate two assets
   as flat albedo + normal and look at them. This is the cheapest experiment
   with the highest information content in the whole document.
4. **Then, if step 3 says yes:** asset registry (1 week) → depth + sort with the
   48-byte layout (2–3 weeks) → camera (1 week) → screen-space lighting (3–4
   weeks). In that order, because each is useless without the one before it.
5. **Extract the package** when game two exists and has told you where the
   seams actually are.

---

## 6. What not to touch

For the avoidance of doubt, the following are *right* and should survive
everything above:

- **The one-draw-call thesis in `gl.ts`.** Cross-texture batching via 8 slots
  with a binary-split selector, and additive-as-a-fragment-op instead of a
  blend state. Those two things together are what took draw calls from 17 to 2,
  and they are the reason `parallax.ts` can order layers by what depth demands
  rather than by what the GPU tolerates. Depth sorting will pressure the slot
  scheme (§2.1) — solve that without giving up the thesis.
- **The adaptive render-scale controller** (`gl.ts:701-798`) and the
  world-scaled / HUD-native split. The p70 window, the pinned ceiling, the
  doubling backoff and the two-second warm-up each exist because a simpler rule
  was tried and failed in a specific documented way. And `renderScale === 1`
  taking the offscreen path out entirely, so the default look is bit-identical,
  is exactly the right safety property.
- **Exact frustum culling in `draw()`** with `CULL_PAD = 0` and the stated
  error analysis.
- **`Frame` as a synthesisable value** and the `sub`/`subFlip`/`solid`/`trimmed`
  helpers (§1.2).
- **`ThemeDef` / `LevelDef` as commented TypeScript literals.** §3.
- **`particles.ts` exactly as written.** Move the file, change nothing in it.
- **The fixed-step loop with interpolation alpha and debt shedding.**
- **`PERF-BASELINE.md`'s habit of recording what was tried and reverted** —
  the canopy pitch, the alpha-band haze, the depth pre-pass. That document has
  already prevented at least three plausible-sounding mistakes and it will
  prevent more.

---

## Method

All measurements taken on the machine this repo lives on:
`ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0)`,
via Playwright-driven headed Chromium, scratchpad harnesses (not committed).

- **Layout bench (§4.3).** Three VAO/program pairs differing only in instance
  format; identical vertex maths in all three so the comparison isolates
  attribute fetch. 3 px quads to stay attribute-bound rather than fill-bound
  (a 24 px run was also taken and is fill-dominated and too noisy to report).
  `fill` measures the CPU write alone with no GL calls; `upload+draw` measures
  `bufferSubData` + `drawArraysInstanced` over a pre-filled buffer; both are
  K-iteration loops divided by K, terminated by a forced GPU sync. Five
  interleaved rounds per configuration, medians reported.
- **Lighting bench (§2.4).** Fixed geometry — 97 quads built to sum to 4.62×
  overdraw, mirroring the shipped mix of full-width bands plus a prop tail —
  rendered into a 2560×1440 backbuffer, the same backbuffer
  `PERF-BASELINE.md` measures. Only the fragment program varies between arms.
  The base arm reproduces the shipped shader (8-slot binary select, grade, IGN
  dither, per-fragment additive) and lands at 7.57 ms against the baseline
  document's 7.49 ms for the real frame, which is the cross-check that the
  synthetic scene is representative. Seven interleaved rounds of 20 frames.
  *Caveat on the deferred arm:* the full-screen light quad reuses the same
  shader as the forward arms, so it also pays a screen of base shading; the
  ~2.0 ms figure for eight lights over one screen is derived by subtracting
  the measured per-screen base cost (7.57 / 4.62 = 1.64 ms). It agrees with the
  forward arm's implied per-screen light cost (7.88 / 4.62 = 1.71 ms) to within
  the noise, which is why I trust it.
- **Sort bench (§2.1).** 20 reps per configuration on random keys, in the same
  page. `Array.sort` sorts an index array with a comparator closing over a
  `Float32Array`. The counting sorts refill their key array every rep, so the
  quantisation cost is included and not hidden.
- **Sync note.** An earlier run of the lighting bench reported 0.005 ms for
  every arm: `gl.finish()` alone did not force execution on this ANGLE/D3D11
  path with an unpresented canvas. Replacing it with a 1×1 `readPixels`
  produced the numbers above. Any future harness in this repo should use the
  readback, not `finish()`.

Peer documents `RENDERER-AUDIT.md`, `CPU-AUDIT.md` and `ASSET-AUDIT.md` had not
landed at the time of writing; where they overlap, prefer their numbers for
throughput and asset questions and this document for the design argument.
