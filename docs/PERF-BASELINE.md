# Performance baseline

Measured on the build at commit `6578056`, 1280x720 @ deviceScaleFactor 2,
mid-gameplay with two letter columns on screen.

| metric | value | note |
|---|---|---|
| fps (real GPU, Intel UHD) | 56 p50 / 54 p05 | GPU-bound, not CPU |
| update | 0.12 ms | CPU is essentially free |
| render (CPU submit) | 0.55 ms | |
| GL draw calls | 17 | 5 painted textures + procedural atlas |
| sprites submitted | 302 | 16 of them entirely offscreen |
| **overdraw** | **6.83x** | every pixel shaded ~7 times |
| JS heap | 7 MB | |
| bundle (js, gzip) | 67 KB | |
| painted art on disk | 6.3 MB | |

## Overdraw by texture (multiples of the screen)

| texture | overdraw | cause |
|---|---|---|
| sky_dusk | 2.42x | 18 draws: base + 2 dither taps + 14 cirrus band slices |
| tree_oak | 1.70x | large mostly-transparent quads, full fill cost |
| procedural atlas | 1.10x | glyphs, UI, particles |
| ground_slab | 0.64x | tiled |
| mountains_far | 0.59x | tiled |
| hills_mid | 0.38x | tiled |

## Targets for the optimization pass

- overdraw **<= 2.5x**
- GL draw calls **<= 8**
- zero fully-offscreen sprites submitted
- update + render CPU unchanged or better
- **no visual regression**: the world must still render at its own exposure
  (raw mode on) and letters must stay crisp
