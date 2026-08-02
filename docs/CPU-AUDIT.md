# CPU and memory audit

Scope: `src/game/particles.ts`, `src/game/wallField.ts`, `src/game/player.ts`,
`src/game/playerAnim.ts`, `src/game/playerFx.ts`, `src/game/playerDraw.ts`,
`src/engine/loop.ts`, `src/core/stack.ts`.

The question is not whether the game is fast today — it is GPU-fill bound, and
`docs/PERF-BASELINE.md` has already established that its CPU cost is 0.24 ms of
update and 1.09 ms of render submit against a ~7.5 ms GPU frame. The question is
what happens to those numbers at ten times the entity count, and what breaks
first when they get there.

Everything below is measured. The instrument is `tools/stress.mjs`, which drives
the real `WallField`, `Particles` and `Player` instances at a chosen multiple of
the game's population and reports where the time goes.

```
node tools/stress.mjs --live 60 --scales 1,10,100 --loop     # the standard run
node tools/stress.mjs --dev --live 60 --tree                 # named allocation sites
node tools/stress.mjs --soa --scales 1,10,100,400            # the data-layout experiment
node tools/stress.mjs --profile                              # sampled CPU call tree
```

---

## Method, and three ways the first measurements were wrong

Each of these produced a confident, plausible, wrong number before it was
caught. They are recorded because the same traps are waiting for the next
person to measure this.

**1. `performance.now()` is coarsened to 100 microseconds.** A page that is not
cross-origin isolated cannot see finer than that. A 3-microsecond region timed
once per frame reads as either 0 or 100 microseconds, so the first version of
the harness reported `0.0000 ms` for every region at 1x — which is how the
coarsening was found. Every region here is therefore benchmarked by repeating
the call inside *one* timestamp pair until the block lasts at least 25 ms,
running seven blocks and taking the median block's per-call cost. The clock is
then three and a half orders of magnitude finer than the thing measured.

**2. The heap sampler blames the caller for an inlined callee.** The first
allocation table said `Loop.tick` allocated 84 bytes a frame. It does not:
TurboFan had inlined the scene's entire update path into it. `--noinline` was
added to the harness to get honest frames.

**3. The harness was most of what it was measuring.** The live soak originally
sampled the heap ten times a second, and every one of those round trips
allocates in the page to serialise its result. It reported 48 collections and
2.6 ms of GC per second for a game that allocates 26 bytes a step. The soak now
says nothing to the page while it runs.

A fourth, in the harness's own scaling code: `Player.update` emits footfall and
roll dust, so running it a few million times inside a benchmark pins the
particle pool at its 2048 capacity — and every "particle" arm then silently
measured 2048 regardless of the scale it claimed to be testing. The pool is
re-seeded immediately before each particle measurement now.

All numbers were taken headless on SwiftShader against the dev server, on a
machine that had three other agents running headed browsers throughout. Every
comparison is interleaved: arms are run A, B, A, B within minutes of each other
and medians reported, so ambient load lands on both.

---

## 1. Allocation and GC

### The claim, tested

`player.ts`, `playerFx.ts`, `playerDraw.ts` and `wallField.ts` each carry a
"nothing in update/draw allocates" contract. Driving `WallField.update`,
`Particles.update` and `Player.update` for 4000 isolated steps with no GL
attached, with Chrome's heap sampler running at a 512-byte interval:

```
sampled allocation attributable to game code:  0 bytes over 4000 steps
```

**The contract holds.** The residue the sampler does report (1.7 B/step) is all
Playwright's `evaluate` serialisation and V8's own parser and compiler.

### What the real loop allocates

The isolated test does not see the scene's per-step wiring, so the same
measurement was taken against 60 seconds of the real loop, real scene, real
input, at 60 fps.

| | |
|---|---|
| total allocated | 291 KB over 60 s |
| attributable to the game | 267 KB = **37 bytes per 120 Hz sim step** (~74 B/frame) |
| heap | 10.56 → 10.87 MB, no growth trend |
| minor collections | 58 in 60 s = 0.97/s |
| major collections | 1 in 60 s |
| **frames over budget** (loop's own counter, 14 ms of CPU) | **0** |

Top allocating call sites, with inlining disabled so the frames are honest:

| B/sim step | site | what |
|---|---|---|
| **21–30** | `tick` @ `loop.ts` | see below |
| 3.1 | `tick` @ `debug.ts` | the 4 Hz perf overlay snapshot |
| 1.9–2.5 | `audio.ts` | oscillator/gain nodes per sound |
| 1.3–2.9 | `registerMiss` @ `play.ts` | only fires on a miss |
| 0.5 | `spawn` @ `wallField.ts` | one wall + its blocks, per wall |
| 0.3 | `dust` @ `wallField.ts` | only fires on a bounce |

### The largest allocation site in the game is `performance.now()`

`Loop.tick` has no object literals, no closures and no array work, yet it was
the top allocator by a factor of seven. Progressively stripped variants were
swapped into the live loop and each measured for its own allocation:

| variant | B/frame @60 |
|---|---|
| the real `tick` | **89.5** |
| a hand-written copy of it (control) | 90.0 |
| the same, with the three `performance.now()` calls and the stats writes removed | **23.9** |
| `requestAnimationFrame` re-registration only | 0.8 |
| + the accumulator arithmetic and all the double instance-field stores | 0.0 |

So the instrumentation costs **66 bytes a frame, about 22 bytes per
`performance.now()` call**. The double a Web IDL call returns is boxed into a
heap number whenever the calling function is too large for V8 to take the
fast-API path — in a trivial callback V8 takes it and the cost is zero, which is
why the stripped variants read 0.0 and the real one does not.

Two folk beliefs were tested against this and **both are false in current V8**:
storing a double into a long-lived object field does *not* allocate a heap
number (20 million stores into an escaping object, zero GC events, and identical
timing to a `Float64Array`), and neither does re-registering a rAF callback.

**Not changed, deliberately.** Those 66 bytes die inside the frame that made
them, they do not scale with entity count, and the loop's own `longFrames`
counter recorded zero frames over budget across a 60-second soak. The only way
to remove them is to sample the instrumentation on a duty cycle, which is the
one property a hitch counter must not have. Recorded in `loop.ts` beside the
code so the next person does not rediscover it.

### What GC actually costs

Not answerable from the trace. V8 schedules most scavenges into the browser's
idle period between frames, and the trace event that carries them is the idle
task, so its duration is the length of the idle slot rather than the pause — one
run reported a 2.2-second "MinorGC" while the game held 60 fps throughout. The
number that means something is the loop's own: **zero frames over 14 ms of CPU
in 60 seconds**, at one collection per second. At this allocation rate GC is not
in the frame.

At 10x entities the allocation rate is essentially unchanged, because none of
the remaining sites scale with entity count — `spawn` is the only one that does,
at 0.5 B/step.

---

## 2. Where the CPU time goes

Population is scaled from a fixed reference of 4 walls / 8 blocks / 40 particles
/ 1 hero. Walls are spread across the visible band so the draw pass sees all of
them; a stress test whose entities are off-screen measures the cull and nothing
else. Draw regions are timed with the GL upload stubbed out, so the number is
the CPU cost of *building* the instance buffer, which is the part that is ours.

| | 1x (8 blocks) | 10x (80) | 100x (800) |
|---|---|---|---|
| **update total** | 0.0067 ms | 0.032 ms | **0.174 ms** |
| — `WallField.update` | 0.0056 | 0.023 | 0.122 |
| — `Particles.update` | 0.0009 | 0.0078 | 0.041 |
| — `Player.update` x N | 0.0003 | 0.0010 | 0.011 |
| **submit total** | 0.014 ms | 0.134 ms | **1.14 ms** |
| — `WallField.draw` | 0.0056 | 0.053 | 0.565 |
| — `Particles.draw` | 0.0072 | 0.072 | 0.478 |
| — hero draw + shade | 0.0011 | 0.0095 | 0.096 |
| quads submitted | 2107 | 2731 | 8895 |
| draw calls | 1 | 1 | 1 |

**At a hundred times the present entity count the whole CPU frame is 1.3 ms of a
16.7 ms budget.** The CPU is not the ceiling and does not become the ceiling.

The sampled call tree says the same thing more bluntly. Self time over a full
frame including the GL upload, at 100x:

```
78.9%  bufferSubData          (uploading the instance buffer)
12.6%  Renderer.draw          gl.ts
 1.9%  WallField.draw         wallField.ts
 1.9%  WallField.update       wallField.ts
 1.7%  Particles.draw         particles.ts
```

The renderer's per-quad submit costs six times what all the gameplay code
calling it costs. **The lever at scale is quads per entity, not faster gameplay
code** — see §6.

---

## 3. Changes landed

Interleaved A/B, six rounds of each arm, only `wallField.ts` swapped between
them, medians reported.

| | 10x (80 blocks) | 100x (800 blocks) |
|---|---|---|
| `WallField.update` before | 0.0279 ms | 0.1779 ms |
| `WallField.update` after | **0.0231 ms** | **0.1323 ms** |
| | **−17.2%** | **−25.7%** |
| `WallField.draw` before | 0.0634 ms | 0.6660 ms |
| `WallField.draw` after | **0.0431 ms** | **0.5213 ms** |
| | **−32.0%** | **−21.7%** |
| update total (all systems) | −12.9% | −20.0% |

Six runs each, before / after, at 100x update: `[0.1728 0.1680 0.2019 0.1810
0.1749 0.1940]` against `[0.1399 0.1380 0.1443 0.1099 0.1265 0.1244]` — the
distributions do not overlap.

Four changes, all of them the same shape: work that was being repeated per block
that is constant across the frame, or work being paid for before the test that
discards it.

**a. Three `Math.exp` per block became three per frame.** `damp(a, b, lambda,
dt)` is `b + (a - b) * Math.exp(-lambda * dt)`, and within one update `lambda`
and `dt` are constant at each call site. The field was calling `Math.exp` three
times per block — jolt, hover, telegraph — to get three numbers identical for
every block in the frame. The factors are hoisted and the expression expanded in
place, which is the same sequence of floating-point operations and therefore
bit-identical output.

**b. `easeOutBack` is skipped once a block is fully born.** `easeOutBack(1)` is
exactly 1, and a block is fully born for all but the first few frames of its
life, so its two `Math.pow` calls now run only during the spawn animation.
Exact.

**c. The glyph sprite is cached on the block.** `draw` built its atlas key with
a template literal — `glyph/${b.letter}` — one string allocation and one hash
lookup per block per frame. The `Frame` is resolved once and cached on the
block, nulled by the only thing that rewrites a letter (`ensureWinnable`).

**d. The telegraph halo's sine moved behind its own rejection test.** The pass
computed `0.5 + 0.5 * Math.sin(...)` for every block and then discarded the
result for almost all of them. The pulse only ever scales `targetT`'s share and
its factor is bounded by 0.23, so testing `hoverT * 0.4 + targetT * 0.23` first
rejects exactly the same blocks without paying for the sine. Exact.

### Verification

`npx tsc --noEmit` clean. Gameplay soak (`tools/winnable.mjs --words 6 --miss`)
**PASS**: 6/6 words, 6 deliberate skips, 0 deadlocks, 0 console errors.

The golden guard could not be used as a pass/fail gate: **it is already red at
`HEAD`**, before any change of mine, reporting all 7 shots changed by 16–19%.
That is the art regeneration in commit `4be02ec`, whose goldens were not
updated. So it was used differentially instead, in a clean `git worktree` at
`HEAD` where only `wallField.ts` differs:

| shot | HEAD vs mine | HEAD vs HEAD (control) |
|---|---|---|
| cave-styled | 0.0000% | 0.2288% |
| cave | 0.2389% | 0.0000% |
| hero-roll | 0.8235% | 0.8235% |
| hud | 0.0000% | 0.0000% |
| meadow-styled | 0.3181% | 0.0000% |
| meadow | 0.2380% | 0.7021% |
| winter | 0.2356% | 0.6296% |

The same build photographed twice drifts by the same amounts on a different,
random subset of shots — `hero-roll` is bit-for-bit the same *difference* in
both columns. **My change is inert to the limit of what this harness can
resolve.** The residual is the harness's own nondeterminism, which
`golden.mjs` already documents at "up to 0.92% on two of them".

Repeated at the later `dc98080`, in the shared tree, the guard had degraded
much further and the control run settles the matter on its own:

| shot | HEAD vs mine | mine vs mine (control) |
|---|---|---|
| cave-styled | 1.92% | **37.44%** |
| cave | 36.70% | 0.00% |
| hero-roll | 0.00% | 1.65% |
| hud | 29.64% | 28.65% |
| meadow-styled | 1.83% | 0.00% |
| meadow | 0.93% | 0.00% |
| winter | 1.56% | 1.56% |

**The same build compared against itself differs by up to 37%.** The guard's
noise floor is currently an order of magnitude above its own 1.2% failure
threshold, so it can neither pass nor fail anything, mine included. Whatever
introduced that — it is not in the files audited here, none of which had
changed between the two captures — needs finding before the guard means
anything again.

That leaves three independent things standing behind "no behaviour change":
each of the four changes is exact or bit-identical by construction and argued
as such above; the differential at `4be02ec`, taken when the guard could still
resolve sub-1%, put the change inside the control; and the gameplay soak
passes.

---

## 4. Data layout: array-of-structs versus struct-of-arrays

`Particles` is already SoA. `WallField` is one object per block. To price that,
the same arithmetic — a transcription of `WallField.update`'s per-block body —
was run over both layouts, same population, both as harness code so neither
gets a JIT advantage. Five interleaved rounds each, medians.

| blocks | AoS full | SoA full | delta | AoS physics only | SoA physics only | delta |
|---|---|---|---|---|---|---|
| 8 | 0.0035 ms | 0.0017 | **−52%** | 0.0021 ms | 0.0002 | **−89%** |
| 80 | 0.036 | 0.018 | −49% | 0.020 | 0.0020 | −90% |
| 400 | 0.178 | 0.090 | −50% | 0.101 | 0.010 | −90% |
| 800 | 0.265 | 0.180 | −32% | 0.201 | 0.019 | −90% |
| 1600 | 0.523 | 0.366 | −30% | 0.403 | 0.040 | −90% |
| 3200 | 1.04 | 0.756 | −27% | 0.413 | 0.044 | −89% |

**There is no crossover point.** The AoS penalty is a constant factor, present
from the first block, and it gets proportionally *smaller* with scale rather
than larger — which is the giveaway that it is not a cache effect. It is the
cost of the access itself: a double-valued property lives in a separately
allocated heap number, so reading `b.sag` is a pointer chase where `sag[i]` is
one load from a stream.

That shows up undiluted in the right-hand columns. Strip the four sines and the
presentation transform, leaving only the six reads and six writes of the block
physics, and **SoA is ten times faster at every population size tested, from 8
blocks to 3200.**

The full body only shows 27–52% because it is not memory-bound — it is
transcendental-bound. Same experiment with the four sines replaced by an
angle-addition expansion (`sin(kt + p) = sin(kt)cos(p) + cos(kt)sin(p)`, with
`sin/cos(kt)` per frame and `sin/cos(p)` cached per block):

| blocks | AoS as shipped | AoS, trig hoisted | delta |
|---|---|---|---|
| 80 | 0.036 ms | 0.021 | −42% |
| 800 | 0.265 | 0.209 | −21% |
| 3200 | 1.04 | 0.486 | **−53%** |

**Neither was taken.** At 10x entities — 80 blocks — the SoA rewrite saves
0.018 ms per frame and the trig rewrite 0.015 ms, against a 16.7 ms budget. Both
are about one tenth of one per cent of a frame, for a rewrite of the field's
data model or a change that is mathematically but not bit-identical and would
have to be re-photographed. The SoA conversion becomes worth 0.28 ms/frame at
3200 blocks; **the point where it is worth 0.5 ms of a frame is around 6000
blocks**, which is 750x the present game.

The finding that generalises to the next engine is the right-hand column, not
the left: if an entity's per-frame body is *not* dominated by transcendentals —
and most 2.5D entity updates are not — object-per-entity costs an order of
magnitude, at every population size, with no crossover to wait for.

---

## 5. The fixed-step loop

120 Hz, `maxSteps: 4`.

**Cost of a step, and how much headroom that leaves:**

| | step cost | vs realtime | 4 steps + submit, worst case |
|---|---|---|---|
| 1x | 0.0067 ms | 1246x | 0.041 ms of 16.7 |
| 10x | 0.032 ms | 259x | 0.263 ms of 16.7 |
| 100x | 0.174 ms | 48x | 1.83 ms of 16.7 |

**It does not spiral.** `if (steps === maxSteps) accumulator = 0` sheds the debt
rather than carrying it, which is exactly what prevents the classic death
spiral, and at 48x realtime at 100x entities there is no plausible way to reach
the ceiling through entity count alone.

**But the ceiling has a silent failure mode.** `hz` steps of simulated time per
second, at most `maxSteps` per frame, means the loop can only follow real time
down to `hz / maxSteps` = **30 fps**. Below that the simulation dilates rather
than catching up: at 20 fps the game runs at 60% speed, with no signal except
`stats.steps` pinned at 4. That is the correct trade for a game that is
GPU-bound at 7.5 ms, but a 2.5D successor that expects to run at 30 fps on a
weak device should either raise `maxSteps` or lower `hz`.

**`ctx.alpha` is written by `main.ts` and read by nothing.** There is no render
interpolation anywhere in the game, despite the loop's header claiming it — now
corrected. This matters before anyone lowers `hz` to save time: the 120 Hz rate
is what makes the missing interpolation invisible, because the drawn state is
never more than 8.3 ms stale. Halving it doubles the staleness into visible
judder on a high-refresh panel. And the saving would be 0.18 ms of a 16.7 ms
frame at 100x entities — 1% — in exchange for building interpolation into every
entity. Not worth doing until a step costs multiple milliseconds.

---

## 6. Where the ceiling actually is

Not the CPU. At 100x entities — 800 blocks, 100 heroes, 2048 particles — update
and submit together are 1.3 ms of a 16.7 ms frame.

**The binding constraint is quads.** At 100x the frame submits 8895 of them, and
the profile puts 79% of frame CPU in `bufferSubData` and another 13% in
`Renderer.draw`. Three hard numbers:

1. **`WallField` draws 8.04 quads per block.** One cube face, one dark pool, one
   telegraph halo, two contact shadows per wall — and **five for the letter**:
   four hard-outline offsets plus the fill. The glyph sandwich alone is **62% of
   everything the field submits.** Pre-compositing the outline into the glyph
   sprite, or moving it into the fragment shader, would take the field from 8.04
   quads per block to about 4 — halving both the CPU submit (≈0.28 ms at 100x)
   and the fill. This is the single largest scaling lever in the files audited,
   and it is a change to how the glyph is *baked*, not to the field.
2. **The renderer's instance buffer holds 24576 quads.** Beyond that a frame
   splits into extra flushes. At the present 8.04 quads per block and 8895 quads
   at 100x, that ceiling arrives at roughly **275x** the current entity count.
3. **The GPU gets there long before either.** `docs/PERF-BASELINE.md` measures
   the current frame at 7.49 ms GPU for 4.60x overdraw at ~300 sprites. Quads
   scale fill roughly linearly at constant size; 10x the entities is 10x the
   letter-block fill, and the backdrop's 2.94 ms is fixed. The render-scale
   controller already exists to absorb exactly that.

**So: a 2.5D game with ten times these entities has no CPU problem.** It has a
fill problem, and the CPU work that matters is the work that produces quads. In
priority order, what would have to change:

1. **Quads per entity.** Halve the glyph sandwich. Nothing else in the audited
   files is close.
2. **Cull the presentation transform, not just the draw.** `WallField.update`
   computes `dx/dy/dsx/dsy/drot` for every wall in the list including those far
   off-screen, while `draw` culls at ±120 units of the view. The physics must
   keep running off-screen or blocks would pop, but the transform — four sines
   and five writes, which §4 shows is two thirds of the per-block cost — is only
   ever consumed by the culled draw. Worth doing when the field carries a long
   off-screen queue; worth nothing today, when it carries four walls.
3. **Struct-of-arrays**, at around 6000 blocks, and immediately for any entity
   type whose update body is not trig-bound (§4).
4. **`maxSteps`/`hz`**, only if the target device is expected below 30 fps.

## 7. Measured, not worth it

- **`Math.hypot`**: not used anywhere in the codebase. Nothing to fix.
- **`Math.pow` with small integer exponents** in `ctx.ts`'s easing functions:
  reached once or twice per entity per frame, invisible in the profile. The only
  one that was hot — `easeOutBack` per block — was removed by an exact early-out
  rather than by rewriting the maths.
- **`Math.sqrt`** in `flightSpeedNorm` and `playerDraw`: once per hero per
  frame. 0.011 ms for a hundred heroes, all of it, including the state machine.
- **Double-typed object fields**: believed to allocate a heap number per store.
  Measured over 20 million stores into an escaping object — zero GC events, and
  the same time as a `Float64Array`. False.
- **`Particles.draw`'s two passes** over the whole array to group blend modes:
  the second pass rejects on one `Uint8Array` load, which is a few microseconds
  at 2048 particles. The real cost is the `Math.cos`/`Math.sin` inside
  `Renderer.draw` for each rotating particle, which is the renderer's and is
  inherent. Collapsing the two passes would also change compositing order.
- **`Loop.tick`'s three `performance.now()` calls**, 66 B/frame: §1.
- **SoA for the wall blocks** and **trig hoisting**: §4, both about 0.1% of a
  frame at 10x.

## 8. The harness

`tools/stress.mjs` is the durable artefact. It turns "is this fast enough at 10x"
into one command against the real systems, and it carries the four measurement
traps above as guard rails rather than as advice. `--soa` prices a layout change
before anyone writes it; `--tree` and `--noinline` name allocation sites;
`--loop` prints the fixed-step headroom table; `--profile` gives the call tree;
`--live N` soaks the real loop and reports heap, collections and per-step bytes.
