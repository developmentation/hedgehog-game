# Themes

A theme is the set of paintings a level is played in. It is **data** — one
object literal in `src/game/themes.ts` — and `parallax.ts` owns only the
composition rules: scroll rates, tiling and wrap arithmetic, registration
against the ground line, culling and draw order.

Selection: a `LevelDef.theme` names a theme id. `LevelRun` publishes
`activeThemeId()`, `Parallax.init` compares it each frame (one identity check)
and rebuilds when it changes. An unknown or missing theme falls back to
`meadow`.

## The three shipped themes

| id | assets | notes |
|---|---|---|
| `meadow` | the original dusk set, 12 pieces | canopy + vines + cloud bank |
| `winter` | 8 | **no canopy** — there is no winter ceiling art, and the meadow's would be summer leaf over snow |
| `cave` | 8 | **no sky** — an opaque backdrop registered down to y=616 |

Two composition tricks worth knowing, because they are the answer to "this
theme has fewer assets than the meadow":

- **Winter buys variety from scale, not from more art.** Four shapes, but the
  `tall` row is the densest of the three (18 pieces, ~700-unit pitch, 620–1240
  units) so the same pine is a 90-unit speck on the ridge and a 1240-unit
  silhouette in front. It borrows only `cloud_a/b` from the meadow — pure
  value, no hue — tinted cold.
- **The cave's ceiling is its own mid layer, upside down.** `cave_mid_rocks`
  sampled with its v range reversed turns a stalagmite ridge with a flat base
  into a stalactite ceiling with a flat off-frame top and lit tips hanging in.
  That is exactly the over-frame canopy contract, satisfied with the theme's
  own art rather than by borrowing another set's.

Never mix sets. A theme with no canopy draws no canopy; half-swapped sets read
as a mistake.

## `ThemeDef` shape

Every fraction is measured off the PNG alpha channel, not estimated.

- `sky` — opaque full-frame painting: `{id, u0, v0, bottom, tint}`
- `far` / `mid` — tiled silhouettes:
  `{id, u:[opaque tiling window], bot:[flat base], scale, band:[painted AND visible strip], tint}`
- `ground` — `{id, u, v0, v1, surface, scale, tint, bank:{scale, crop, lift, rise, tint}}`.
  `surface` is the row that registers onto `GROUND_Y`.
- `pieces[]` — `PieceSpec{id, bot, span, u0..v1}`, the ink box of every prop
- `rows{ridge, tall, near, fringe, fore}` —
  `RowDef{use:string[], count, gap, height, y, tint, sway, alpha, grade}`.
  Repeats in `use` weight the pick.
- `washes[]?` — `{src:'mid'|'ground', u, v, tint, y, bands, a, in, fade, out}`.
  `src` also decides where in the pass the wash lands.
- `clouds?`, `canopy?`, `vines?` — `HangDef{windows[], flip, pitch|pitchAbs, tail|tailAbs, depth, floor, minH}`

## Cost

Backdrop only, frozen world, identical scroll position, 1280x720@2x:

| theme | overdraw | sprites | draw calls |
|---|---|---|---|
| meadow | 2.86x | 48 | 2 |
| winter | 2.72x | 48 | 2 |
| cave | 3.54x | 50 | 2 |

Cave is +24% — a taller sky quad and narrower mid tiles. Full frame mid-gameplay
is 4.3–5.4x, 358–436 sprites, 2 draw calls throughout. Heap is flat: nothing
allocates after a theme is built.

## Adding a fourth theme

Eight assets in the existing roles: an opaque sky, `far` and `mid` tiled
silhouettes with flat bases, a ground slab, two tall verticals, two props. Plus
either a canopy source, or a `mid` layer whose base is flat enough to flip.

Then one measuring pass — opaque tiling window per tiled layer, flat base row,
surface row on the ground, ink box and footprint per prop — and one literal.

Two gotchas:

1. Pick `bank.crop` deep enough that the bank's lower edge stays under the slab
   at the top of its rise.
2. Set row tints from the art's **actual peak luma**. The dusk set wants
   1.4–3.4x; the newer sets want <= 1.0. A tint above 1.0 on already-bright art
   clips — see the comment in `parallax.ts`.
