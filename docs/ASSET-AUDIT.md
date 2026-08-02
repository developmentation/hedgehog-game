# Asset pipeline and GPU memory audit

Everything here is measured, on this machine, with tools committed alongside it:

| tool | what it answers |
|---|---|
| `node tools/assetprobe.mjs` | real VRAM by texture, cold-boot breakdown, atlas occupancy, minification census |
| `node tools/artdiff.mjs` | whether a change altered the RENDERING, with the simulation clock removed |
| `node tools/texcompress.mjs` | block-compression quality and size, per asset, with visual evidence |

Hardware: Intel UHD Graphics (0x9A60), ANGLE/D3D11, `MAX_TEXTURE_SIZE` 16384.
Page at 1280x720 CSS, `deviceScaleFactor` 2, so a 2560x1440 drawing buffer.
Numbers are medians of three cold boots (fresh context, empty HTTP cache).

> Caveat on every wall-clock figure below: these were taken while two other
> agents were building and driving browsers on the same machine. Ratios between
> A and B measured back-to-back in the same session are sound; absolute
> milliseconds are pessimistic and noisy.

---

## 1. VRAM: 383 MB, and 197 MB of it was empty texture

`assetprobe` wraps `texImage2D` / `texStorage2D` / `renderbufferStorage` before
any page code runs, so this is what was uploaded, not what the code believes it
uploaded.

### Before

| texture | dimensions | format | mips | VRAM |
|---|---|---|---|---|
| **painted atlas** | **8192 x 8192** | RGBA8 | no | **256.00 MB** |
| procedural atlas | 4096 x 4096 | RGBA8 | no | 64.00 MB |
| `sky_dusk` | 1536 x 1024 | RGBA8 | no | 6.00 MB |
| `winter_sky` | 1536 x 1024 | RGBA8 | no | 6.00 MB |
| `cave_backdrop` | 1536 x 1024 | RGBA8 | no | 6.00 MB |
| 9 x wide layer | 1400 x 933 | RGBA8 | no | 4.98 MB each, 44.84 MB |
| | | | | **382.84 MB** |

**No, 64 MB is not what to expect — it was 256 MB.** The brief's "4096² atlas
plus 4 standalone textures" describes a build that no longer exists. Two things
had drifted:

1. `ATLAS_MAX_DIM` is 1200, and twelve assets are wider than that, so there are
   **12 standalone textures, not 4** — 62.84 MB.
2. The 36 remaining sprites total 15.55 Mpx of ink. `Atlas.tryPack` grows a
   **square power-of-two** texture until they fit. 4096² (16.8 Mpx) is not
   enough once shelf waste is included, so it doubled to **8192² = 67.1 Mpx**
   and uploaded 256 MB to hold 59 MB of sprite. **Occupancy 23.2%.** 196.7 MB
   of that texture is untouched memory.

The same call also allocated an 8192x8192 2D canvas to bake into — another
256 MB, in system RAM, on the main thread.

### After

| texture | dimensions | format | mips | VRAM |
|---|---|---|---|---|
| atlas page 1 (27 sprites) | 4096 x 4080 | RGBA8 | no | 63.75 MB |
| atlas page 2 (9 sprites) | 4096 x 896 | RGBA8 | no | 14.00 MB |
| procedural atlas | 4096 x 4096 | RGBA8 | no | 64.00 MB |
| 12 x standalone layer | as before | RGBA8 | no | 62.84 MB |
| | | | | **204.59 MB** |

**Painted art: 318.84 MB -> 140.59 MB, a 56% cut (-178 MB).**
**Whole context: 382.84 MB -> 204.59 MB (-47%).**

The 256 MB system-RAM canvas is gone entirely: placements go to the GPU through
`texStorage2D` + one `texSubImage2D` per sprite. Measured JS heap after boot
fell 18.9 MB -> 7.4 MB.

The remaining 64 MB procedural atlas is `src/art/*` + `src/engine/atlas.ts`,
which this pass does not own. For the record it is 4096² at 53.3% occupancy
with `bakeScale` 2, i.e. ~30 MB of it is also empty; the same rectangular
packing would recover most of that.

---

## 2. Atlas efficiency

| | before | after |
|---|---|---|
| pages | 1 | 2 |
| page size | 8192 x 8192 (67.1 Mpx) | 4096 x 4080 + 4096 x 896 (20.4 Mpx) |
| sprite ink | 15.55 Mpx | 15.55 Mpx |
| **occupancy** | **23.2%** | **76.2%** (page 1 82.3%, page 2 49.0%) |
| wasted area | 51.6 Mpx = 196.7 MB | 4.9 Mpx = 18.5 MB |

Of the 4.9 Mpx still wasted, about 2.9 Mpx is the deliberate mip-alignment
gutter (see §4) and only ~2 Mpx is packer inefficiency.

### Why the shelf packer stopped being good enough — and it is not about count

`Atlas.tryPack`'s comment says "good enough occupancy for a few hundred
sprites". For the procedural atlas, where every painter is a similar small
glyph or UI plate, that is true — it is at 53.3% with ~200 painters. For
painted art it was never true, and the reason is **height variance, not
count**. A shelf is as tall as its tallest member; this set is 420-px letter
blocks sitting on shelves opened by 1100-px trees. Five shelves held 36
sprites and threw away three quarters of the texture.

The fallback is not a bigger shelf packer, it is a different one. `assets.ts`
now uses a **skyline bottom-left packer** with a run-length contour, which
places each rectangle at the lowest point it fits. Same input, same sort:
23.2% -> 82.3% on page 1. Packing all 36 sprites costs **1 ms**.

The second lever is dropping the square power-of-two habit. WebGL2 samples and
mips rectangular NPOT textures without complaint; the page is 4096 wide and its
height is *searched* from the area the sprites actually need, in 128-px steps,
rather than doubled. That is what turns "next power of two" from a 4x penalty
into a few percent.

Page 2 at 49% is the one loose end: 9 small sprites spill past the 4096-row cap
and get a page sized by their tallest member. Balancing the split across two
pages would recover roughly 6 MB. Left alone deliberately — it is 4% of the
remaining bill and the packing code is already the most intricate part of the
loader.

### Where this design breaks

| bound | limit | reached at |
|---|---|---|
| skyline packer quality | degrades slowly; still >75% at 4x this input | not the binding constraint |
| atlas pages vs sampler slots | `Renderer` binds 8 textures per batch | ~8 pages + standalones, i.e. **~120 assets** |
| **VRAM on integrated graphics** | art alone; 0.64 Mpx average per asset | **~90 assets = 230 MB, ~150 assets = 382 MB** |
| download | 0.29 MB average per asset | 150 assets = **44 MB**, unacceptable for web |

**The binding constraint is VRAM, and it bites at roughly 90-100 assets** on
hardware like this. Compression (§3) moves that to ~350 assets; streaming (§6)
moves it further by making the *resident* set smaller than the *shipped* set.
Both are needed for 150 assets across four themes; neither alone is enough.

---

## 3. Compressed textures — verdict: yes, and gradients are not the problem

`tools/texcompress.mjs` encodes with a principal-axis fit plus two
least-squares refinement passes (the stb_dxt / squish algorithm, not a naive
bounding box — a weak encoder would bias this verdict pessimistic) and decodes
with the hardware's own integer palette rules, so the measured output is what
the GPU would sample.

This device reports `WEBGL_compressed_texture_s3tc` (BC1-BC3),
`EXT_texture_compression_bptc` (BC7) and `EXT_texture_compression_rgtc`.
Chrome's software fallback additionally reports ASTC and ETC. So at least one
suitable format is present, as expected.

Assets are premultiplied before encoding, because `compressedTexImage2D` has no
unpack-time premultiply — a compressed pipeline has to ship premultiplied data.

### Size, whole set (48 assets, 30.5 Mpx)

| format | bytes | ratio |
|---|---|---|
| RGBA8 | 122.2 MB | 1.0x |
| BC3 / DXT5 (8 bpp) | 30.6 MB | **4.0x** |
| BC1 / DXT1 (4 bpp, no alpha) | 15.3 MB | 8.0x |

Applied to the actual GPU allocation — atlas pages and standalone layers, all
of which compress including their gutters — **140.59 MB of painted art becomes
35.2 MB**, and a full mip chain on top of that still only reaches 47 MB, which
is a third of what the art costs *today with no mips at all*.

### Quality, on painterly art with soft alpha

PSNR is versus premultiplied RGBA8. "composite" is the same measured after
compositing over mid-grey, which is what the player actually sees; "worst blk"
is the RMSE of the single worst 4x4 block, so a good mean cannot hide a visible
failure.

| asset | character | BC3 RGB | composite | alpha | worst blk |
|---|---|---|---|---|---|
| `sky_dusk` | full-frame smooth gradient | **39.5 dB** | 39.5 | — (opaque) | **6.9** |
| `cave_backdrop` | painted cavern, opaque | 35.6 dB | 35.6 | — | 20.0 |
| `cloud_a` | soft alpha, low frequency | 40.4 dB | 40.8 | 50.3 | 21.6 |
| `hog_ball` | the hero, hard alpha | 35.1 dB | 35.3 | 48.9 | 32.7 |
| `grass_tuft_a` | fine foliage | 33.8 dB | 34.7 | 40.5 | 27.6 |
| `tree_oak` | tall tree, fine branches | 33.3 dB | 33.4 | 44.8 | 25.4 |
| `winter_grass` | **worst of 48** | 30.5 dB | 31.4 | 39.8 | 27.6 |
| `tree_willow` | second worst | 31.8 dB | 32.1 | 42.0 | 30.8 |

**The feared failure mode does not occur.** Block compression bands on
gradients when a 4x4 block cannot be described by a line in colour space — but
a smooth gradient *is* a line, so it is the easy case: `sky_dusk` is the best
asset in the set at 39.5 dB with a worst block of 6.9/255. Visual evidence in
`docs/compress/sky_dusk.bc3.png` (original | BC3 | 8x-amplified difference):
the amplified difference is smooth noise with no step structure anywhere.

The damage is on **high-frequency detail**, not gradients: fine foliage and
branch silhouettes, 30.5-33.8 dB. `docs/compress/tree_willow.bc3.png` is the
worst case in the set and `docs/compress/hog_ball.bc3.png` is the hero. At 1:1
both are indistinguishable; the amplified difference shows fine noise along
leaf and quill edges, never blocking.

Alpha survives well — 39.8-53.2 dB — because BC3 gives alpha its own block with
8 interpolated levels, which is more precision than the colour channels get.
Soft alpha is not the risk here; it is the part that compresses best.

**Verdict: BC3 is acceptable, and BC7 is the format to actually ship.** BC7 is
the same 8 bpp with 8 partition modes and up to 7-bit endpoints against BC3's
single implicit partition and 5:6:5, so every number above is a lower bound on
what a UASTC/KTX2 pipeline delivers at identical size. The two assets that
measure worst are exactly the ones BC7's partitioning is designed for.

### Why it is not landed in this pass

Compression is a **visible change** — 30-40 dB is not "identical", it is
"acceptable" — and the standing rule for this pass is no visual regression.
Landing it is a deliberate art decision plus a pipeline, not a free win. Costed:

| step | work |
|---|---|
| encoder | adopt `basis_universal` / `toktx` for UASTC->KTX2; do **not** ship the JS encoder in `texcompress.mjs`, it is a measuring instrument |
| build | `tools/genart.mjs` emits `.ktx2` beside each `.png`; manifest gains a `formats` list |
| runtime | ~120 lines in `assets.ts`: probe extensions, pick BC7 > ASTC > BC3 > PNG, transcode via the Basis WASM transcoder (~500 KB, loaded once), `compressedTexSubImage2D` into the same skyline pages (block-aligned placement already holds — `MIP_ALIGN` 16 is a multiple of 4) |
| fallback | keep the PNG path exactly as it is; any device without a compressed format is unaffected |
| verification | re-run `tools/artdiff.mjs`, accept the delta explicitly, refresh goldens |
| **estimate** | **2-3 days**, of which the runtime is half a day |

Download does **not** improve for free: KTX2/UASTC files are larger than PNG
for this art (PNG is already an entropy-coded lossless format at 14.1 MB, and
UASTC is a fixed 8 bpp before Zstd). Expect the deploy payload to *grow* unless
ETC1S is used for the non-hero assets. The win is VRAM, upload time and texture
cache behaviour — not bytes on the wire.

---

## 4. Mipmaps: needed, built, measured, and off by default

`assetprobe` wraps `Renderer.draw` and computes texels-per-device-pixel for
every sprite in a real frame.

| texture | p50 | p90 | verdict |
|---|---|---|---|
| **atlas page 1** (props, trees, foliage, blocks) | **2.15** | **4.21** | badly minified |
| atlas page 2 (hero set) | 1.44 | 1.49 | minified |
| `ground_slab` | 0.71 | 0.71 | magnified |
| `hills_mid` | 0.47 | 0.47 | magnified |
| `mountains_far` | 0.41 | 0.41 | magnified |
| `sky_dusk` | 0.36 | 0.36 | magnified |
| all painted draws | 1.46 | 4.08 | 74% minified, 40% beyond 2x |

So the brief's suspicion is right and then some: three quarters of painted
draws are minified, 40% of them past 2x, and the atlas p90 is over 4 texels per
pixel — `LINEAR` alone is point-sampling one texel in sixteen. That is the
crawling foliage, and it is also a texture-cache miss on nearly every fetch.

But the split matters: **the wide standalone layers are magnified, always.**
`sky_dusk` at 0.36 never fetches a mip. Giving those twelve textures a chain
would cost 20.9 MB of VRAM that is never sampled. They are excluded
unconditionally (`MIP_STANDALONE = false`).

### Bleed-free atlas mipmapping

Padding alone does not make an atlas mip-safe, because mip texel grids are
aligned to the *texture* origin, not to sprite boundaries. `assets.ts` instead
**aligns every placement to a 16-texel grid and rounds each reserved slot up to
that grid with at least one full 16-texel gutter**. A texel at mip level 4 —
the deepest level allocated — then covers exactly one aligned block and can
never straddle two sprites. `generateMipmap`'s 2x2 box filter is precisely this
aligned reduction, so it is correct by construction rather than by luck.
`texStorage2D` leaves its store *undefined*, so each page is cleared through an
FBO first; otherwise driver garbage in the gutters would be averaged into every
minified sprite edge.

Cost of the alignment: ~2.9 Mpx on a 20.4 Mpx atlas, about 3%.

### What turning it on costs and buys

Measured with `tools/artdiff.mjs`, which removes the simulation clock so the
only variable is rendering:

| comparison | pixels differing >6/255 | max delta | mean delta |
|---|---|---|---|
| HEAD vs new loader | **0.000%** on all 5 shots | 2-4 | 0.001-0.008 |
| HEAD vs new loader **+ mips** | 3.3% - 6.8% | 167-206 | 0.8-1.7 |

VRAM cost: +33% on the atlas pages, 77.75 MB -> 103.4 MB.

`?mips=1` enables it. It is **off by default** because it changes the look —
5% of pixels with a mean delta of 1.3/255, which is settled foliage rather than
crawling foliage, but it is still a look change and `golden.mjs`'s threshold is
1.2%. It becomes obviously correct the moment compression lands: BC7 pays for
the entire chain four times over, and 103 MB of mipmapped RGBA8 becomes 26 MB
of mipmapped BC7. **Recommendation: enable mips in the same change that lands
compression, never before.**

---

## 5. Cold boot

Both columns measured back-to-back in the same session, same mirror of the
repo, median of three cold boots.

| phase | before | after |
|---|---|---|
| **to `__game` (playable)** | **1782 ms** | **612 ms** |
| `assets.load()` | 363 ms | 403 ms |
| art over the wire | 14.14 MB in 48 requests | same |
| fetch wall time | 57 ms (17.3x parallel) | 73 ms (14.9x parallel) |
| **PNG decode on the main thread** | **3333 ms summed** | **0 ms** |
| PNG decode off-thread (`createImageBitmap`) | 0 | 980 ms summed |
| **GL upload (blocking)** | **281 ms** | **36 ms** |
| JS heap after boot | 18.9 MB | 7.4 MB |

**2.9x faster to playable.** What did it:

- **Fetching was never the problem.** 48 requests complete in a 57-73 ms window
  at 15-17x parallelism. HTTP/1.1 connection limits are not being hit and there
  is nothing to gain from bundling assets into one file.
- **Decode was, and it was on the main thread.** The old loader set `img.src`
  and handed the `HTMLImageElement` to `texImage2D`, which makes the *driver*
  decode synchronously inside the GL call. One 1536x1024 sky measured **490 ms
  in a single `texImage2D`** on a cold run. `fetch` -> `Blob` ->
  `createImageBitmap` moves that to a worker thread; the 980 ms of decode still
  happens but overlaps itself and never blocks a frame, and the GL call that
  follows is a pure upload at 36 ms total for 48 textures.
- **Nothing serialised that should be parallel** — `Promise.all` over all
  assets was already there and is kept.
- Baking through a 2D canvas is gone, and with it an 8192² canvas allocation
  and 48 live `HTMLImageElement`s; decoded bitmaps are explicitly `.close()`d
  once uploaded rather than left for GC.

### Projected to 150 assets

Scaling by the measured per-asset averages (0.29 MB on disk, 0.64 Mpx, 20 ms of
off-thread decode):

| | 48 today | 150 projected |
|---|---|---|
| download | 14.1 MB | 44 MB |
| fetch wall time | 73 ms | ~230 ms (parallelism holds) |
| off-thread decode | 980 ms summed | ~3.1 s summed, ~800 ms wall on 4 cores |
| GL upload | 36 ms | ~110 ms |
| art VRAM (RGBA8) | 141 MB | **382 MB** |
| art VRAM (BC7 + mips) | — | **~64 MB** |
| **to playable** | 612 ms | **~1.6 s, all at boot** |

A 44 MB first load and 382 MB of VRAM are both past what a browser game should
ask for. Compression fixes the VRAM; only streaming fixes the download and the
1.6 s.

---

## 6. Streaming: measured waste, and what it costs to fix

Every theme's art loads at boot. Assets were attributed to themes by which ones
each `ThemeDef` block in `src/game/themes.ts` actually names; 12 are core (hero
set, letter blocks, ruins) and belong to no theme.

| theme | assets it needs | needed at boot | **loaded and unused** |
|---|---|---|---|
| MEADOW | 20 + 12 core = 32 | 6.08 MB / 65.2 MB RGBA | **16 assets, 8.05 MB (57%), 57.0 MB RGBA (47%)** |
| WINTER | 10 + 12 core = 22 | 4.29 MB / 44.4 MB RGBA | **26 assets, 9.84 MB (70%), 77.8 MB RGBA (64%)** |
| CAVE | 8 + 12 core = 20 | 5.54 MB / 39.0 MB RGBA | **28 assets, 8.59 MB (61%), 83.2 MB RGBA (68%)** |
| all three | 48 | 14.13 MB / 122.2 MB RGBA | — |

**Between 47% and 68% of the art on the GPU is for a theme that is not on
screen.** A fourth theme takes the worst case past 70% and adds ~3 MB and
~29 MB of VRAM that is idle in every session that does not visit it.

### The mechanism is landed; the wiring is not

`AssetLibrary.load` already takes an `include` predicate and is additive and
idempotent, and `loadRest()` / `whenComplete()` exist. What is deliberately not
wired:

| step | work | why not now |
|---|---|---|
| theme -> asset-id map | add `theme` to `tools/artspec.mjs` entries so `genart.mjs` writes it into the manifest; ~30 min, one `--rematte` run (free) | speculative field until a consumer exists |
| boot the active theme only | `main.ts`: pass the predicate, call `loadRest()` after `loop.start()` | `main.ts` is outside this pass's ownership |
| late arrivals | re-register `r.rawTextures` when wave 2 lands, or have the library own that set | small, but same file |
| correctness at theme switch | `await assets.whenComplete()` before a level change can draw a missing frame | must not race the golden harness, which switches level immediately |
| actual eviction | one page-set per theme so `deleteTexture` can free whole pages | the only genuinely hard part: pages are shared today |

**Cost: half a day for load-on-demand without eviction** (saves the boot
download and the boot latency — 30-43% of bytes, and time-to-playable drops
towards the core+theme figure). **A further day for per-theme page groups with
eviction**, which is what actually caps resident VRAM at one theme's worth.

**Recommendation for 150 assets and four themes:** do both, and do compression
first. Compression alone takes 382 MB to 64 MB, which is already survivable;
streaming on top makes the resident set roughly one theme — around 25 MB — and
cuts the first download from 44 MB to ~15 MB. Neither is worth doing at 48
assets on its own; both are unavoidable at 150.

---

## 7. What landed

Only `src/engine/assets.ts` changed. Proven pixel-identical to HEAD by
`tools/artdiff.mjs` (0.000% of pixels differing on all five shots, max delta
2-4/255, which is GPU filtering noise).

- Skyline bottom-left packer with searched, rectangular, non-power-of-two page
  heights and multi-page spill. Occupancy 23.2% -> 76.2%.
- Off-thread decode via `fetch` + `createImageBitmap`; `texStorage2D` +
  `texSubImage2D` straight from the bitmap. No 2D canvas, no
  `HTMLImageElement`, main-thread decode 3333 ms -> 0.
- `colorSpaceConversion: 'default'` on decode. This one is a trap: `'none'`
  looks like the right choice for exact pixels, but the old path went through
  an `<img>` and a 2D canvas, both of which colour-manage into sRGB. Several of
  these PNGs carry a profile from the generator, and skipping the conversion
  shifted the whole frame by a mean of 23/255 — a visibly bleached sky. Caught
  by `artdiff`, not by eye.
- Mip-ready layout (16-texel alignment, full gutters, FBO-cleared pages) with
  mipmapping behind `?mips=1`, off by default, excluded from the magnified
  standalone layers.
- Per-phase `stats` (fetch / decode / pack / upload / VRAM / per-page
  occupancy) so the next person measures instead of guessing.
- Streaming hooks: `load(..., include)`, `loadRest()`, `whenComplete()`.

### A note on `npm run golden`

The golden guard photographs the game 600 ms of wall clock after boot and does
not reset the simulation clock, so what it captures depends on how many
simulation steps fit into those 600 ms — which depends on machine speed and
load. Measured on an unmodified HEAD build, `ctx.time` at the freeze point
varied from **0.008 s to 0.600 s across seven consecutive runs of the same
build**, and a clean HEAD run reported 5 of 7 shots "changed" by 16-19%. Any
change that makes boot faster — which is the point of this pass — shifts that
phase and lights up the hero, the clue card and every eased HUD value while the
art underneath is bit-identical.

That is why `tools/artdiff.mjs` exists: it gates `requestAnimationFrame`, boots
the game at exactly zero simulation steps, poses, pins the clock and pumps a
fixed number of frames by hand, so two builds differ only if their rendering
differs. It is the instrument that showed this change is a no-op visually and
that mipmapping costs 5%, where `golden.mjs` reported 18% for both.

**`npm run golden` does not pass with this change, and refreshing the goldens
does not fix it.** With only this change applied, in an isolated mirror of the
repo, all seven shots report 3.8-16.5% changed. Regenerating them with
`--update` and immediately re-running the guard twice against its own fresh
output gave:

| run | result |
|---|---|
| refresh, then verify | 3 of 7 changed (0.24% - 2.33%) |
| verify again | 5 of 7 changed (0.52% - **29.16%**) |

A guard that disagrees with a snapshot of itself by 29% two minutes later is
not measuring the build. The committed goldens have deliberately **not** been
updated: replacing a known reference with a coin-flip snapshot would be worse
than leaving it failing and saying so.

`golden.mjs` is not owned by this pass. The fix it needs is the one `artdiff`
demonstrates — reset `ctx.time`, gate `requestAnimationFrame`, and step a fixed
number of ticks from the boot state instead of sleeping 600 ms. Until then,
`tools/artdiff.mjs` is the guard to trust for anything that changes timing.

`tools/package.mjs` is unaffected: it stages, recompresses 48 PNGs, boots the
staged tree clean with all 48 assets loaded and zero console errors, and writes
a **14.20 MB** zip — 7.1% of the 200 MB limit.
