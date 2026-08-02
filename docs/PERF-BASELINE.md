# Performance baseline

Measured at 1280x720 @ deviceScaleFactor 2, mid-gameplay with two letter
columns on screen.

The **before** and **after** columns are two runs of the same harness against
the same working tree, differing only in the renderer pass (`src/engine/gl.ts`
and `src/game/parallax.ts`). Both were taken headed, on the real GPU, after the
level-data work had landed, so the gameplay code is identical on each side and
the two columns are directly comparable. The original pre-pass figures, taken
at commit `6578056`, are in the last column for continuity.

| metric | before | after | orig (`6578056`) |
|---|---|---|---|
| fps (real GPU, Intel UHD) | 48 p50 / 44.8 p05 | **54.5 p50 / 50.0 p05** | 56 / 54 |
| update | 0.08 ms | 0.08 ms | 0.12 ms |
| render (CPU submit) | 0.45 ms | **0.37 ms** | 0.55 ms |
| GL draw calls | 16 | **2** | 17 |
| sprites reaching GL | 335 p50 | 292 p50 | 302 |
| fully-offscreen sprites reaching GL | 17.9 / frame | **0** | 16 |
| **overdraw** | **6.78x** | **4.60x** | 6.83x |
| JS heap | 7.6 MB | 7.9 MB | 7 MB |
| bundle (js, gzip) | 68.3 KB | 69.6 KB | 67 KB |
| painted art on disk | 6.3 MB | 6.3 MB | 6.3 MB |

Overdraw is measured by wrapping `Renderer.draw`, clipping each sprite's
rotated, pivoted bounding box to the viewport, summing the visible area over
120 frames and dividing by the screen area.

## Overdraw by texture (multiples of the screen)

| texture | before | after | what changed |
|---|---|---|---|
| sky_dusk | 2.42x | **0.79x** | 18 draws -> 2: dither moved into the fragment shader, cirrus sheets dropped |
| shared painted atlas | 1.87x | **1.50x** | props, trees and clouds cropped to their ink boxes |
| procedural atlas | 0.88x | 0.99x | glyphs, UI, particles — not owned by this pass |
| ground_slab | 0.64x | **0.52x** | grass bank cropped to the part not behind the walkable slab |
| mountains_far | 0.59x | **0.48x** | band cropped to painted-and-visible |
| hills_mid | 0.38x | **0.32x** | band cropped to painted-and-visible |

The texture rows are named for the first asset packed onto each GPU texture, so
"shared painted atlas" is the row the original baseline called `tree_oak`. It
holds every packed painted asset, not one tree — and broken down by asset, that
1.87x was never one big quad but a long tail:

| asset | before | after |
|---|---|---|
| canopy_overhang | 0.336x | 0.363x |
| tree_oak | 0.301x | 0.311x |
| tree_birch_cluster | 0.241x | **0.112x** |
| grass_tuft_b | 0.225x | **0.114x** |
| grass_tuft_a | 0.192x | **0.129x** |
| hog_ball (the hero) | 0.188x | 0.190x |
| cloud_b | 0.060x | **0.013x** |

## Targets for the optimization pass

- overdraw **<= 2.5x** — **missed, 4.60x** (-32%; see below)
- GL draw calls **<= 8** — **met, 2**
- zero fully-offscreen sprites submitted — **met**
- update + render CPU unchanged or better — **met**, render 0.45 -> 0.37 ms
- **no visual regression** — **met**. At two frozen poses (loop stopped, `time`
  and scroll distance pinned) every backdrop tile of a 12x8 grid differs by a
  mean of at most 1.2/255, which is the new shader dither. The only larger
  deltas sit on the letter blocks and the hero, and a control diff of two runs
  of the *same* build lights exactly those tiles harder — they are game-state
  jitter, not rendering.

## Why 2.5x is not reachable without cutting content

What is left is mostly not waste. The frame is eleven parallax planes and the
backdrop alone accounts for 2.10x of it: sky 0.66 + horizon skirt 0.13 +
mountains 0.48 + hills 0.32 + grass bank 0.20 + ground 0.31, each now cropped
to the strip where it is the frontmost thing painted. An opaque backdrop cannot
cost less than 1.0x; the extra 1.1x is what nine distinct scroll rates cost
when the layers in front of each other have ragged silhouettes you can see
between.

The largest single item left is the over-frame canopy at 0.36x, and it was
tried: widening its pitch from half a tile to two thirds saves 0.10x and
visibly thins the ceiling, because the pieces draw at 0.92 alpha and the
overlap *is* the density. Reverted. Below that the list is the procedural atlas
(0.99x of glyphs, HUD and particles, not owned by this pass), the hero
(0.19x), and the tall trees (0.31x for three quads that are 90% ink after
cropping).

Getting under 2.5x from here means drawing fewer planes or a shallower canopy.
That is an art decision, not an optimization.

## Notes on method

- The two console 404s a headed run reports are the browser's automatic
  `/favicon.ico` probe; the page declares no icon. Headless never asks.
- SwiftShader (`--enable-unsafe-swiftshader`) is a usable stand-in for
  fill-rate work — it is a pure software rasteriser — but it saturates near the
  60 Hz cap once overdraw drops, so fps claims here come from headed runs.

---

# After the optimization pass

Combined tree at commit `5da7861` + asset cleanup. Same method, same machine.

| metric | baseline | after | change |
|---|---|---|---|
| **overdraw** | 6.83x | **4.60x** | −33% |
| **GL draw calls** | 17 | **2** | −88% |
| offscreen quads reaching GL | 17.9/frame | **0** | eliminated |
| update (CPU) | 0.12 ms | **0.09 ms** | |
| render submit (CPU) | 0.55 ms | **0.37 ms** | −33% |
| sprites submitted | 302 | 267 | |
| painted textures loaded | 33 | 32 | dropped orphaned `hog_ball_blur` |
| JS heap | 7 MB | 7 MB | |

## Overdraw by texture

| texture | before | after |
|---|---|---|
| sky_dusk | 2.42x | **0.79x** |
| shared painted atlas | 1.87x | 1.50x |
| procedural atlas | 0.88x | 0.99x |
| ground_slab | 0.64x | 0.52x |
| mountains_far | 0.59x | 0.48x |
| hills_mid | 0.38x | 0.32x |

## What did it

- Sky collapsed 18 draws -> 2. Anti-banding is now interleaved-gradient noise in
  the fragment shader (4 ALU ops) instead of two full-screen alpha copies, and
  the 14 cirrus band-slices are gone.
- Exact frustum culling in `Renderer.draw`, against the world rect the
  projection actually maps onto the viewport.
- Batching now spans textures (8 sampler slots, binary-split selector) and
  additive is done per fragment, so `setBlend` is no longer a state change.
  Those two things were what split every batch.
- Every prop/tree/cloud trimmed to its measured ink box, pivots re-registered so
  position, scale and mirroring are unchanged.

## Target not met, and why

Overdraw target was <= 2.5x; the result is 4.60x. The backdrop alone is 2.10x
after cropping (sky 0.66 + skirt 0.13 + mountains 0.48 + hills 0.32 + bank 0.20
+ ground 0.31). An opaque backdrop cannot cost less than 1.0x, and the excess is
what nine distinct scroll rates cost when the layers in front have silhouettes
you see between. Reaching 2.5x means fewer parallax planes, which is a look
decision rather than an optimization.

Largest remaining fill:
1. over-frame canopy, 0.36x — pieces draw at 0.92 alpha, so the overlap IS the
   density; widening the pitch saved 0.10x and visibly thinned the leaf ceiling.
2. procedural atlas, 0.99x — glyphs, HUD and particles, not touched by this pass.

The game remains GPU-fill bound, not CPU bound: 0.09 ms update + 0.37 ms render
against a ~20 ms frame.

---

# Render-scale pass

The previous pass took overdraw from 6.83x to 4.60x and stopped, correctly, at
the point where going further meant drawing fewer parallax planes. This pass
does not touch content at all. It attacks the other half of the fill equation.

Fill cost is `overdraw x device pixels`. Overdraw was already down to what the
art actually needs. Device pixels were untouched: a 1280x720 CSS stage on a 2x
display rasterises 2560x1440 = **3.69 million pixels**, and at 4.6x that is
~17 million fragment shades per frame. Nothing had ever questioned the second
number.

## Method note: why the numbers here are GPU times, not frame rates

Wall-clock fps could not measure this. The test machine presents at 143 Hz, so
every render scale from 1.0 down to 0.5 reported an identical 7.0 ms frame —
the frame rate was pinned by the display, not by the work. Disabling vsync
(`--disable-gpu-vsync`) did not help; rAF cadence simply moved to ~57 Hz and
pinned there instead. Three other agents were also running headed browsers on
this machine throughout, and run-to-run fps on the same build varied 78 to 143.

So the measurements below use `EXT_disjoint_timer_query_webgl2` — the GPU's own
clock, wrapped around exactly the commands one frame submits. It is immune to
vsync, to rAF, and to whatever else is running. Every comparison is also
**interleaved within one browser session**: the harness cycles round-robin
through the configurations for 8-10 rounds of 1.5 s each, so ambient load hits
every arm equally instead of landing on whichever arm ran while a build was
going.

## 1. Render scale — the measured curve

Headed, real GPU, 1280x720 @ dsf 2, mid-run with letter columns on screen.
10 interleaved rounds. World pass at reduced scale, HUD always native.

| render scale | world pass rasterises | GPU ms p50 | vs native |
|---|---|---|---|
| **1.00** (default) | 2560x1440 | **7.49** | — |
| 0.85 | 2176x1224 | 5.87 | **-22%** |
| 0.72 | 1843x1037 | 5.00 | **-33%** |
| 0.60 | 1536x864 | 4.31 | **-42%** |
| 0.50 | 1280x720 | 4.04 | **-46%** |

A second run on the same build, taken an hour apart: 7.48 / 6.71 / 5.66 / 4.56
/ 3.61 ms. Same shape, same endpoints.

Fitting `t = a + b*s^2` gives b ~ 6.5 ms and a ~ 0.9 ms: **87% of the GPU frame
is world-pass fill** and scales with the square of the render scale, which is
what "fill-bound" means quantitatively. The residue is the native HUD pass.

Frame rates, from an earlier set of runs taken while the machine was loaded
enough to sit below the 143 Hz cap: 103 fps at native, 120 at 0.72, 136 at 0.6,
142 at 0.5.

Overdraw is unchanged — 4.60x, of which 3.92x is the world pass and 0.68x the
HUD. That is the point. Overdraw is a geometry ratio; it is invariant under
resolution. The fill that was removed does not show up in it at all, which is
why the previous pass's 4.60x figure was never going to move again without
cutting planes.

## 2. What keeping the HUD sharp costs

The world renders into an offscreen buffer and is blitted up; the HUD then
draws at native straight into the default framebuffer. The alternative is to
shrink the canvas backing store and let the compositor upscale the whole frame
— no blit, but the glyphs and HUD rings soften too. Measured side by side at
the same pixel budget, same session:

| | GPU ms p50 |
|---|---|
| native | 7.96 |
| render scale 0.72, HUD native (**shipped**) | 5.58 |
| whole canvas at 1.44x dpr, HUD scaled too | 4.79 |
| render scale 0.50, HUD native | 4.20 |
| whole canvas at 1.0x dpr, HUD scaled too | 3.09 |

Keeping the HUD native costs **0.78 ms**, about 10% of a native frame, and it
buys back the one part of the image that a resample visibly destroys. Verified
by eye: at 0.6 the foliage, bark and canopy soften, while SCORE, the hearts,
HINT, JUMP, PAUSE and the letter tiles are pixel-for-pixel what they are at
native. The trade is worth it; the blit is also why scales above ~0.85 are not
worth taking, since the fixed blit eats the saving.

## 3. Depth-based early-out — measured, and no

The context still asks for `depth: false`. Three measurements say a depth
pre-pass would cost more than it could ever recover.

**a. Only one asset in the game is opaque.** From the art manifest, ink
coverage within each quad:

| asset | opaque | coverage |
|---|---|---|
| sky_dusk | **yes** | 1.00 |
| tree_oak | no | 0.57 |
| canopy_overhang | no | 0.39 |
| ground_slab | no | 0.36 |
| hills_mid | no | 0.18 |
| mountains_far | no | 0.17 |

The sky is the only quad that can write depth without an alpha test — and it is
the backmost thing drawn, so it occludes nothing. Everything in front of it is
17-57% ink. An alpha-tested depth pre-pass over those would need the texture
fetch and a `discard`, which disables early-Z on the pre-pass itself: it would
be a second full shading pass wearing a hat.

**b. The occlusion ceiling is 0.03%.** Rasterising every world-pass quad into a
160x90 coverage grid in draw order, and measuring the area covered by a *later
fully-opaque* quad — exactly the fill a front-to-back depth test could skip:

```
world-pass fill      3.959 screens
occluded by opaque   0.001 screens   (0.03%)
```

**c. The cost side is 1.3 screens.** A pre-pass would rasterise sky (0.79) plus
ground (0.52) of depth-only fill to recover 0.001 screens of shading.

The reason the ceiling is that low is that the previous pass already did the
job by hand: every band was cropped to the strip where it is the frontmost
thing painted. Static geometric cropping is a depth pre-pass computed once at
build time instead of every frame. There is nothing left for the hardware to
find.

## 4. GPU cost of each backdrop layer

Measured by suppressing a layer's submissions and diffing GPU time, interleaved
within one session (native, 7.90 ms baseline):

| suppressed | GPU ms | saving | overdraw removed |
|---|---|---|---|
| sky_dusk | 6.86 | **1.05 ms** | 0.79x |
| mountains_far + hills_mid | 6.92 | 0.99 ms | 0.80x |
| ground_slab | 7.06 | 0.84 ms | 0.52x |
| all four | 4.97 | **2.94 ms** | 2.38x |

The backdrop is **37% of the GPU frame**. That is the number any future
"fewer planes" art decision should be weighed against — and 0.6 render scale
already recovers more than removing the entire sky would.

## 5. The adaptive controller

`Renderer.tickScaler(dt)` is fed each frame's wall time from the loop; the
control laws and the reasoning behind each threshold are documented in `gl.ts`.
In short: a 24-frame window judged at p70, step down at 1.1x budget, probe up
when the budget is met on two consecutive windows, and a failed probe pins a
ceiling that only lifts after a doubling backoff. Warm-up is 2 s after boot or
resize, because the frames right after either are the worst of the session and
judging on them opened the game soft on hardware that could run it native.

Measured, real GPU, target 32 fps, load applied as 24 extra full-screen opaque
repaints inside the world pass (a real ~25 ms of fill, not a fake number):

```
t= 0.0-13.1   climbs to and holds scale 1.00      at rest, native
--- LOAD ON ---
t=15.35       1.00 -> 0.85   frame 34.7ms
t=16.49       0.85 -> 0.72   frame 30.6ms
t=17.38       0.72 -> 0.60   frame 24.3ms         2.0 s to shed the load
t=18.61       probes 0.72                         frame 19.5ms
t=20.37       0.72 -> 0.60   probe did not hold -> ceiling pinned at 0.60
t=20.4-35.0   holds 0.60, no further movement     15 s, zero churn
--- LOAD OFF ---
t=40.93       ceiling retry fires, 0.60 -> 0.72
t=41-61       holds 0.72
```

The single up-down pair at t=18.6/20.4 is the designed maximum: a failed probe
raises the ceiling, so the same rung is never retried until the backoff timer
expires. On SwiftShader the ladder walks down 1.00 -> 0.50 within a second of
the loop starting, which is the case it exists for.

**Hooks.** `window.__renderScale()` reports and returns control to automatic;
`__renderScale(0.6)` pins; `__renderScale(1, 45)` pins and moves the target.
`?rs=0.72` and `?rs=auto&fps=50` do the same from the URL. `__perf` gained
`renderScale`, `autoScale` and `worldMpx`, and the debug overlay shows them.

**Not done: persistence.** `main.ts` reads `save.profile.settings.renderScale`
defensively and honours it if it appears, but `save.ts` belongs to another
agent and the field does not exist. Adding `renderScale?: number` to the
`settings` object in `emptyProfile()` is the whole remaining change; the
renderer side is already wired.

## 6. No visual regression at native

Proven within one build and one session, on one frozen pose (loop stopped,
`time` pinned, shake zeroed), rendering the same frame three times:

| | mean delta | max |
|---|---|---|
| native vs native-again, after the offscreen path had been used | **0.0000/255** | **0** |
| native vs render scale 0.60 | 3.53/255 | 236 |

Bit-identical. At `renderScale === 1` the offscreen buffer is never created and
the renderer binds the default framebuffer with the viewport `resize()` already
set, so the draw sequence is the unscaled renderer unchanged — the zero is a
consequence of that, not a coincidence. The second row is the resample, and
inspecting it confirms the split works: world softens, HUD does not.

The portrait letterbox path was checked separately at 390x844 @ dsf 3 with
`rs=0.6`: the rendered band lands on exactly the same pixels as at native and
the bars are untouched, because the blit copies the whole buffer rather than
the band.

## Verification

`npx tsc --noEmit` clean. `npx vite build` clean. Headed run reaches
`celebrate`; zero console errors other than the browser's automatic
`/favicon.ico` probe. `__raw` and `__grade` both still behave. Draw calls
still 2, frustum culling and cross-texture batching untouched, no per-frame
allocation added (the controller's two 24-element `Float32Array`s are
allocated once).

## Summary

| metric | before | after |
|---|---|---|
| GPU ms, native | 7.49 | 7.49 (unchanged by design) |
| GPU ms, adaptive under load | 7.49, or dropped frames | **4.3 at 0.60** |
| fill reduction available | none | **22% / 33% / 42% / 46%** at 0.85 / 0.72 / 0.60 / 0.50 |
| overdraw | 4.60x | 4.60x (invariant under resolution) |
| draw calls | 2 | 2 |
| default look at rest | — | **bit-identical** |

Biggest remaining fill cost: the backdrop, 2.94 ms of a 7.49 ms frame, of which
the sky alone is 1.05 ms. Removing it needs fewer parallax planes — still an
art decision, and now one with a price tag attached.
