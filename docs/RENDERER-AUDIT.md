# Renderer audit

An audit of the GPU layer — `src/engine/gl.ts` and `src/engine/atlas.ts` — with
two questions in view: where is the next order of magnitude, and what is already
optimal and should be left alone.

The short answer is that **there is no order of magnitude left in the renderer.**
The frame is bandwidth-bound at the ROP, not shader-bound, not draw-call-bound,
and not upload-bound. Nine of the eleven things that looked like wins measured at
zero or worse, and the two that are real (the clear, and blending the opaque
backdrop) are both blocked on the same single bit of metadata that the renderer
cannot derive for itself.

Everything below is measured. Nothing below is an estimate unless it says so.

---

## Method

Wall-clock frame rate cannot measure anything on this machine — the panel
presents at 143 Hz, rAF is vsync-pinned, and three other agents were running
headed browsers throughout. Every number here comes from
`EXT_disjoint_timer_query_webgl2`, wrapped around exactly the commands one frame
submits: the query opens in `Renderer.resetStats`, which the scene stack calls
first, and closes in `Renderer.tickScaler`, which the loop calls last.

Two rules make the comparisons trustworthy:

- **Interleaved.** Every variant is measured round-robin inside one browser
  session, N rounds of a fixed slice each, so ambient load lands on every arm
  equally instead of on whichever arm ran while a build was going.
- **Frozen pose.** The game is posed as the golden guard poses it (loop stopped,
  `timeScale` 0, `distance` pinned) and re-rendered, so every frame submits
  identical geometry and the only difference between arms is the thing under
  test.

New tools, all of which rebuild their variants from the real shipping source so
there is no second copy to drift:

| tool | what it answers |
|---|---|
| `tools/glbench.mjs` | GPU cost of shader variants, texture state, upload volume, render scale, CPU submit |
| `tools/clearprobe.mjs` | which pixels the clear is actually visible through |
| `tools/abshot.mjs` | isolate one file's pixel effect in a tree several agents are editing |
| `tools/benchserve.mjs` | private build + static server, so a run cannot race another agent's `dist/` |

Rig: ANGLE / Intel UHD Graphics (0x9A60) / D3D11, 1280x720 CSS at dsf 2 =
**2560x1440**, ~330 sprites, 2 draw calls, 8 culled, 22 KB of instance data per
frame. Absolute frame times drift between sessions (6.6 ms when the machine was
quiet, 13.5 ms when it was not) so **only within-table comparisons are
meaningful**. The run-to-run noise floor on a single arm is **±0.5 ms, about
±7%**; anything smaller than that is reported as "below the floor", not as a
result.

---

## Where the frame actually goes

The decisive experiment. Interleaved, one session, native resolution:

| arm | GPU ms p50 | vs baseline |
|---|---|---|
| baseline | 8.194 | — |
| no clear | 7.192 | **−1.002 ms (−12.2%)** |
| no blending | 6.876 | **−1.318 ms (−16.1%)** |
| no clear + no blending | 5.653 | −2.541 ms (−31.0%) |
| clear 1/16 of the area | 6.973 | −1.220 ms |
| `clearPolicy = 'bars'` | 6.792 | −1.402 ms |
| `clearPolicy = 'full'` (shipping) | 8.120 | −0.074 ms (noise) |
| `GL_DITHER` disabled | 7.804 | −0.390 ms (noise; +0.030 in a second session) |

A second session, taken an hour earlier: baseline 8.789, no clear −1.262, no
blend −1.433, both −3.122, clear 1/16 −1.187. A third: baseline 8.174, no clear
−0.987, no blend −1.688, both −2.554. Same shape every time.

So roughly **a third of the frame is the colour buffer being written and read**,
and the single largest line item is one `glClear`.

That reframes everything else. The fragment shader's arithmetic, the sampler
selector, the instance upload and the draw-call count are all rounding errors
against 14.8 MB of clear plus a read-modify-write on every surviving fragment.

---

## 1. Instance data throughput — already optimal, by three orders of magnitude

**Question:** would a packed layout (half floats, u8 colour, quantised rotation)
help at 360 sprites? Would persistent-mapped or double-buffered VBOs beat
orphaning?

**Measured.** `tools/glbench.mjs --suite upload` repeats the `bufferSubData` per
flush N times, so the frame uploads N x the bytes and nothing else changes:

| arm | bytes/frame | GPU ms p50 |
|---|---|---|
| x1 (shipping) | 22 KB | 13.504 |
| x2 | 44 KB | 13.718 |
| x4 | 89 KB | 13.786 |
| x8 | 178 KB | 13.579 |
| x16 | 355 KB | 13.180 |
| x32 | 710 KB | 13.443 |
| orphan + x1 | 22 KB | 14.303 (**+0.799**) |

**Thirty-two times the upload volume moves the frame by less than the noise
floor, and the slope is indistinguishable from zero.** Halving the instance size
would therefore save something less than half of nothing.

CPU side (`--suite cpu`, best of 7, GPU taken out of the loop):

| | |
|---|---|
| `draw()`, on screen, no rotation | **23.0 ns/sprite** |
| `draw()`, on screen, rotated | 68.0 ns/sprite |
| `draw()`, culled | 11.5 ns/sprite |
| `bufferSubData` of 360 instances | **1.4 us** |
| **360 sprites, total** | **8.3 us submit + 1.4 us upload** |

The perf HUD's ~1.09 ms "render submit" is therefore **99% caller-side scene
work** — parallax layout, wall field, particles — and under 1% renderer. Anyone
optimising submission should look upstream of `Renderer.draw`.

**Rejected:** packed layout (saves <10 us of CPU and 0 ms of GPU), persistent
mapping (does not exist in WebGL), double-buffered VBOs (solves a stall that
does not happen), and **orphaning, which measured +0.8 ms** — the driver is
already renaming the buffer, and asking it to reallocate every flush costs real
time. `bufferSubData` at offset 0 with no orphan is the right call and should
stay.

The useful corollary is for 2.5D: **the instance layout has effectively
unlimited headroom.** Adding depth, a texture-array layer, a normal-map index
and a light index costs nothing measurable. The real ceiling is the 16 attribute
locations GLSL ES 3.00 allows, of which this renderer uses 6.

## 2. Shader cost — `discard` is the most valuable instruction in the frame

**Question:** `discard` disables early-Z and forces the slow path on tile-based
GPUs. Is removing it faster? What does the grade cost when it is a no-op?

**Measured**, interleaved, native, one session (a second session and a 6x-fill
amplified session agree on the signs that matter):

| fragment variant | GPU ms p50 | vs shipping |
|---|---|---|
| shipping | 6.599 | — |
| identical shader, recompiled (control) | 6.581 | −0.018 |
| **`discard` removed** | **7.250** | **+0.651 (+9.9%)** |
| `discard` threshold raised to 0.02 | 6.702 | +0.103 |
| `discard` threshold raised to 0.06 | 6.816 | +0.217 |
| grade removed entirely | 7.091 | +0.492 |
| grade behind a uniform branch | 7.128 | +0.529 |
| dither removed | 7.234 | +0.636 |
| dither behind a per-instance bit | 6.989 | +0.391 |
| selector removed, one sampler | 6.801 | +0.202 |
| discard + grade + dither all removed | 7.115 | +0.516 |
| texture fetch replaced by a constant | 8.430 | +1.831 |
| everything removed (fetch, discard, grade, dither) | 8.351 | +1.752 |

Read that table twice. **Every arm that removes work is slower or unchanged**,
except by amounts under the noise floor — and the two arms that remove the most
work are the *slowest in the frame by a mile*, because both of them defeat the
`discard`.

- **Keep `discard`.** Removing it and relying on `a == 0` blending to a no-op
  measured **+9.9%** here, **+9.5%** in a second session and **+21.6%** in a
  6x-fill session. This pass has no depth buffer, so there is no early-Z for
  `discard` to disable; what it buys is skipping the ROP read-modify-write on
  every fragment inside a quad and outside its ink — and the art is 17–57% ink,
  so that is most of them.
- **Do not raise the threshold.** 0.02 and 0.06 both measured *slower* than
  0.0025, consistently, across three sessions. Killing whole tiles of fully
  transparent texels is what pays; trimming the ink boundary only adds
  partially-covered quads and divergence.
- **The grade is free.** Cutting exposure + saturation-toward-luma entirely
  moved the frame by 0.00 ms once the recompiled-shader control is accounted
  for, and guarding it with a uniform branch was slower than leaving it. The
  branchless `mix` costs nothing real. Leave it alone.
- **The dither is free too**, or near enough: at best 0.16 ms (2%), and gating
  it behind a per-instance bit recovered only 0.06 ms of that — the branch eats
  the saving. Rejected: not worth a mode bit, a size heuristic, or the risk.
- **The texture fetch is ~0.7 ms (8–10%)** and irreducible for a textured
  renderer. (The "no fetch" arms are slower only because a constant texel
  defeats the `discard`; the fetch's own cost is read off the p05 of the
  amplified session.)

The tiler caveat stands and is not measurable here: on a tile-based mobile GPU
`discard` can force a full-rate path and this trade may invert. `glbench` builds
the no-discard variant from `gl.ts` itself, so re-running it on a phone is one
command, not a port.

## 3. Overdraw from the renderer side — the clear is the whole story

The content pass already cropped every band to its ink box and the culling is
exact, so there is no geometry left for the renderer to remove. A per-layer
scissor cannot help: a scissor reduces the fill of a quad that is *partly*
off-screen, and after exact frustum culling and ink-box cropping there are none.
A cheap opaque pre-pass was already rejected on a measured occlusion ceiling of
0.03% (see `PERF-BASELINE.md`), and the ink-coverage numbers here confirm why —
only the sky is opaque, and it is the backmost thing drawn.

What is left is the one full-screen write the renderer issues itself, and it is
not free. `glClear` on this hardware is **not** a metadata fast path — it is
14.8 MB of bandwidth, and the cost falls in proportion to area: clearing a
sixteenth of the target recovered **1.220 ms of the 1.262 ms** that skipping it
entirely recovers.

So: how much of that clear is load-bearing? `tools/clearprobe.mjs` renders the
same frozen pose twice, identical except for the clear colour, and diffs. Any
pixel that differs is a pixel the clear shows through.

| viewport | pose | pixels the clear is visible through |
|---|---|---|
| 16:9 2560x1440 | cave, cave-styled | **0** of 3,686,400 |
| 16:9 2560x1440 | meadow, meadow-styled | **383** (rows 1359–1439, cols 670–918) |
| 16:9 2560x1440 | winter | 391 (rows 1263–1439, cols 1841–2548) |
| portrait 390x844 dsf3 | all | 32.5% — the letterbox bars, genuinely needed |
| ultrawide 1720x720 dsf1 | meadow / winter | 102 / 244, bottom rows |
| 16:9, live play, 6 sampled frames | endless | 0 |

**The frame spends 12–17% of its GPU time painting 3.7 million pixels so that
about 390 of them are the right colour.** Those 390 are a small gap in the
bottom band that scrolls with the ground; the cave theme has no gap at all.

### What shipped

`Renderer.clearPolicy: 'full' | 'bars' | 'none'`, defaulting to `'full'` —
byte-for-byte the previous behaviour. `'bars'` scissors the clear to the
letterbox bars only, which on 16:9 means it does nothing at all, and it works on
both the native and the reduced-scale offscreen target.

Measured on the real code path, interleaved: `'bars'` **−1.402 ms (−17.1%)**;
`'full'` −0.074 ms against baseline, i.e. unchanged, as it must be.

The default stays `'full'` because **the renderer cannot prove coverage**. This
backdrop covers the viewport as a union of bands, most of which are 17–41% ink,
and nothing tells the renderer which texels are opaque. Switching to `'bars'` is
a contract with the content, not an optimisation the renderer may take on its
own. See "What remains" for the exact recipe and its price.

## 4. Texture state — the texture array is worth about 2%, and this was the
surprise

**Question:** what does the 8-sampler binary-split selector cost, versus a
`TEXTURE_2D_ARRAY` with a layer index per instance?

Isolating the selector needs care: a variant that reads `u_tex[0]` for every
sprite also changes which texels come back, which changes the discard rate and
the cache behaviour. So the clean pair binds **the same texture to all eight
units**, leaving the selector as the only difference between the arms —
identical texels, identical discards, identical cache:

| arm | GPU ms p50 |
|---|---|
| A: selector, one texture bound everywhere | 10.179 |
| B: no selector, one texture | 10.058 (**−0.121**) |
| C: selector, 8 textures (shipping) | 10.325 |
| D: no selector, 8 textures bound | 10.331 (−0.006) |

**A−B = 0.121 ms; C−D = −0.006 ms.** The selector costs somewhere between zero
and 0.15 ms of an 8–10 ms frame: **at or below the noise floor, about 1.5%.**

It is cheap because the branch is driven by a `flat` varying — it is uniform
across a whole quad, so it is coherent, and three predicated comparisons cost
nothing next to a texture fetch and a blend.

**Rejected**, and this was the idea most likely to be the big structural win.
A texture array would collapse eight binds into one and delete the selector, and
the entire prize is ~2%. The cost is not small: every layer of a 2D array must
share one size, and this game's textures are a 4096 atlas, one 1536x1024 sky and
four 1400x933 bands per theme — so it forces a full repack of the art pipeline
into fixed-size pages.

Revisit it when **materials need a second map per sprite** (see 2.5D below).
At that point the argument is slot pressure — 8 slots become 4 albedo + 4 normal
— not the branch. That is the honest case for `TEXTURE_2D_ARRAY`, and it is a
capability argument, not a performance one.

## 5. Render scale — re-measured, still the only order-of-magnitude lever

| render scale | GPU ms p50 | vs native |
|---|---|---|
| 1.00 | 8.015 | — |
| offscreen at native size (isolates the blit) | 8.403 | **+0.388 ms** |
| 0.85 | 6.893 | −14.0% |
| 0.72 | 5.863 | −26.9% |
| 0.60 | 5.015 | −37.4% |
| 0.50 | 4.216 | −47.4% |

Consistent with the shipped curve. The blit costs 0.39 ms, which is why scales
above ~0.85 do not pay for themselves.

This remains the biggest lever in the renderer, and it is already built,
adaptive and shipping. Nothing found in this audit comes close to it.

---

## A fidelity bug found on the way (not fixed, deliberately)

Textures are uploaded with `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true` in both
`atlas.ts` and `assets.ts`, so a texel is stored as `(rgb*a, a)`. The fragment
shader then computes `c = texel * v_color` and outputs `g * c.a` — which
multiplies by the texel's alpha **a second time**:

```
        output.rgb = rgb * a * v_color.rgb * (a * v_color.a)
   should have been = rgb * a * v_color.rgb *      v_color.a
```

The consequence is that partially covered texels composite at `a²` instead of
`a`: an antialiased edge at 50% coverage draws at 25%, and the canopy pieces
authored at 0.92 alpha land at 0.85. The one-token fix is `g * v_color.a`
instead of `g * c.a`.

It is **not** fixed here, on purpose. The art was authored against this
pipeline, every golden encodes it, and correcting it would lighten every soft
edge in the game — a look change, not an optimisation, and not this pass's to
make. It costs nothing either way (the multiply is the same). For the 2.5D
engine, fix it on day one, before any art is authored against it.

---

## 2.5D readiness

The instance layout is not the problem. The bandwidth measurements above show
there is room for anything; the constraints are elsewhere, and they are
specific.

**Not blocked — and this is the design's biggest asset.** Because one batch
spans eight textures and both blend modes, *submission order is free*. A 2.5D
renderer can sort its sprites by depth on the CPU every frame and still emit one
draw call. At 360 sprites that sort is ~20 us. Most 2D batchers cannot do this;
this one can, and correct painter's-algorithm depth sorting therefore needs no
renderer change at all.

| capability | what blocks it | cost to unblock |
|---|---|---|
| **Per-sprite depth** | No `z` in the instance; `gl_Position.z` is hard-zero; the context asks for `depth: false`. | One float (free) and one line in the vertex shader. A real depth *buffer* is a different question: it adds a per-fragment read+write, and the closest measured proxy — blending, which is exactly that — costs 1.3–1.7 ms/frame. Add `z` for **sorting**; enable the depth buffer only when there is opaque geometry for it to cull, which today there is not (occlusion ceiling 0.03%). |
| **Alpha-to-coverage** | Needs MSAA; the context asks for `antialias: false`. | **Reject.** MSAA multiplies ROP traffic by the sample count, and this frame is ROP-bound: even 2x would cost more than the entire clear + blend budget (2.5 ms). Use sorted alpha blending, or alpha-tested cutouts via the existing `discard`, which measures *cheap* here. |
| **Per-sprite normal maps / a lighting pass** | A second texture fetch per fragment, and a second sampler slot per material. | The fetch measures ~0.7 ms/frame, so a second map is ~+0.7 ms (+9%) at today's 4.6x overdraw. The slot pressure is the harder half: 8 slots become 4 materials. **This is the real case for `TEXTURE_2D_ARRAY`** — one albedo array, one normal array, one layer index per instance, two samplers total and unlimited materials. Cost: a fixed-size-page repack in the asset pipeline. |
| **Skewed / rotated ground planes** | The instance layout. `a_xform(x, y, hw, hh)` + `a_rot(cos, sin, pivotX, pivotY)` expresses translate, scale, mirror and rotate — and nothing else. No shear, no perspective. | Replace those 8 floats with a **2x3 affine** `(m00, m01, m10, m11, tx, ty)`: 6 floats instead of 8, strictly more general, fewer vertex-shader ops, and the CPU folds the pivot in during `draw()` (~+5 ns/sprite). True perspective — a ground plane receding to a horizon — needs a per-vertex `w`, so either a 3x3 homography (9 floats, still free) or per-corner positions, which means giving up the shared unit quad. Risk is not cost: every pivot, mirror and cull path has to be re-verified against the goldens. |
| **More sprites** | Nothing. | 23 ns/sprite submit, 68 ns rotated (`Math.cos`/`Math.sin` are 45 ns of that — take a precomputed cos/sin pair in the API if a 2.5D scene ever submits 10⁴ rotated sprites). Capacity is 24576 instances; the frame uses 330. |
| **Mipmaps** | `Atlas` bakes no mip chain, and `PAD = 4` is too small to survive one — level 2 and beyond would bleed neighbouring sprites into each other. | 2.5D scales sprites with depth, which means **minification**, which without mips means aliasing and texture-cache thrash. Fix by padding each entry to 2^k of the deepest level used, or by moving to array pages with per-page mips. Do this at the same time as the array, not before: today every sprite draws at ~1:1 and mips would only cost memory. |

## WebGPU

**Not worth it. Not until one of four specific things is true.**

The reasoning is arithmetic, not taste. This frame is 87% world-pass fill, and
within that fill it is dominated by memory traffic that WebGPU does not touch:
the clear (12–17%), blending (16–21%), the texture fetch (8–10%). Same GPU, same
rasteriser, same ROP, same blend unit. A WebGPU backend re-expresses the API
above all of that.

What WebGPU genuinely improves is CPU-side submission and driver validation.
This renderer issues **2 draw calls** and spends **~10 us of CPU per frame**
inside `Renderer`. Drive both to exactly zero and the frame improves by 0.1%.
The honest upper bound on a WebGPU port, assuming it removes every scrap of
per-frame CPU and driver overhead and changes nothing else, is under 1% — and
the realistic figure is negative, because it is a second renderer to keep
bug-compatible with the first across every device the game runs on.

X — the conditions under which the answer changes:

1. **Compute.** Particle simulation, culling or lighting moving onto the GPU
   with >10⁴ elements. WebGL2 has no compute shaders; transform feedback is a
   poor substitute. This is the strongest of the four.
2. **Draw-call count above ~10³/frame.** Render bundles genuinely win there.
   This renderer's whole architecture exists to keep that number at 2.
3. **A material system that outgrows 16 vertex attributes.** Storage buffers and
   bindless-style indexing remove the instance-layout ceiling that 2.5D
   materials will eventually hit — though note the measurement above: that
   ceiling is nowhere near being reached today.
4. **A deferred lighting pass.** Multiple render targets, explicit depth and
   MSAA control, and predictable pipeline state are worth real money once there
   is a G-buffer. But note item 3 in the 2.5D table: on ROP-bound hardware like
   the test rig, a G-buffer is a bandwidth decision before it is an API one.

Until then, effort spent on a WebGPU backend buys less than moving the render
scale ladder by one rung.

---

## What remains, prioritised

| # | item | payoff | cost | blocked on |
|---|---|---|---|---|
| 1 | **Clear elision.** Set `r.clearPolicy = 'bars'`. | **1.0–1.4 ms, 12–17%** | one line, plus an art fix | The ~390-pixel gap at the bottom of the meadow and winter bands. Close it (extend the ground band by ~40 CSS px, or however `parallax.ts` prefers), re-run `tools/clearprobe.mjs` until every 16:9 pose reads 0, then flip the policy. The cave theme already reads 0. |
| 2 | **Draw the opaque backdrop with blending off.** | ~0.3–0.4 ms, 4–5% | ~20 lines in `flush()` + 1 line in `assets.ts` | `Frame` needs an `opaque` flag. The art manifest **already has it** (`opaque: true` on the three sky/backdrop assets); `assets.ts` simply does not copy it onto the `Frame`. Then `flush()` splits a leading run of opaque, `Blend.Normal`, `a == 1` instances into its own draw with `BLEND` disabled — 3 draw calls instead of 2. Bounded by the sky+skirt's 0.79 of 3.96 screens against a 1.3–1.7 ms blend budget. |
| 3 | **Fix the double premultiply.** | 0 ms; correctness | 1 token + new goldens | A deliberate look change. Right thing to do in the next engine, wrong thing to do mid-project. |
| 4 | **`TEXTURE_2D_ARRAY`.** | ~0.15 ms today | asset-pipeline repack | Do it for materials, not for speed. See 2.5D. |
| 5 | **2x3 affine instance layout.** | 0 ms; unblocks skewed ground planes | ~half a day + golden re-verification | Nothing. Cheap and strictly more general; the reason not to do it today is that nothing draws a skewed quad yet. |
| 6 | **WebGPU backend.** | <1%, probably negative | weeks | See above. |

Explicitly **not** worth doing, with the numbers that say so: packed instance
data (32x the upload is free), buffer orphaning (+0.8 ms), double-buffered VBOs
(no stall to solve), removing `discard` (+10 to +22%), raising the discard
threshold (+1.5 to +8%), branching the grade (+0.5 ms), gating the dither
(+0.4 ms net), disabling `GL_DITHER` (noise), a depth pre-pass (0.03% occlusion
ceiling), MSAA of any kind (ROP-bound), per-layer scissors (nothing left to
clip).

---

## Verification

- `npx tsc --noEmit` clean.
- The change to `gl.ts` is `clearPolicy` plus comments. With the default
  `'full'`, `clear()` executes exactly `clearColor` + `clear(COLOR_BUFFER_BIT)`,
  as before; the shader edits are inside GLSL comments. Measured: `'full'`
  −0.074 ms against the pre-change baseline, i.e. unchanged.
- Draw calls still 2, cross-texture batching, per-sprite culling, `__raw`,
  `__grade`, `__renderScale`, `rawMode` and `untint` all untouched. No
  per-frame allocation added.

### `npm run golden` — failing at HEAD, not from this change

It has to be said plainly: the golden guard **does not currently pass on this
machine at HEAD**, before this change is applied, and this was verified in a
clean `git worktree` checkout of HEAD with nothing else modified:

```
HEAD, --only winter, four consecutive runs:   15.82%  16.27%  16.57%  16.49%
HEAD + this change, four consecutive runs:    16.27%  16.38%  16.30%  16.56%
```

Statistically identical. Across full runs at HEAD the failure set *flaps* — one
run had `winter` and `hero-roll` at exactly 0.000% / max Δ0 while `meadow`
failed at 5.90%; the next had the reverse. With this change applied, five of the
seven shots have been observed at **0.000% drift, max Δ0** against the committed
goldens, which is the strongest possible statement that the renderer output is
bit-identical when the pose lands.

The flap is in the harness, and two concrete defects were found in it while
tracking this down. Both belong to whoever owns `tools/golden.mjs`:

1. **It will photograph a foreign server.** `serve()` spawns `vite preview` on a
   hard-coded port 5499 and then probes that port with `fetch`. If anything else
   is already listening — and with several agents in this tree, something usually
   is — the spawn fails silently and the harness photographs *the other process's
   build*. That is exactly what happened here: a run in an isolated worktree
   produced screenshots of a different agent's `dist/`, showing procedural
   fallback art against painted-art goldens, and reported 99.96% drift on every
   shot. Fix: bind an ephemeral port, or fail hard when the spawn does.
2. **It leaks the server.** `spawn(..., { shell: true })` returns the shell's
   pid, so `server.kill()` leaves `vite` alive holding both the port and a handle
   on `dist/` — which then makes the *next* `vite build` fail at `emptyOutDir`
   and the run after that photograph a stale bundle. Fix: `taskkill /t` on
   Windows, or spawn without a shell.

Beyond those, the residual flap looks like pose timing: the diff masks show the
clue card at a different vertical offset between runs, i.e. something in the
scene is still advancing on wall-clock before `loop.stop()` catches it. That is
a scene-state issue, not a renderer one, and `docs/PERF-BASELINE.md`'s
determinism claim should be re-checked against a loaded machine.

`tools/abshot.mjs` exists because of all this: it builds into its own scratch
directory, serves from its own process, and photographs the same poses, so one
file's pixel effect can be isolated without trusting a shared port or a shared
`dist/`.
