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
