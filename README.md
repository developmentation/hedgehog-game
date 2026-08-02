# Spindash Speller

A 2D browser spelling game. You **hear** a word — it is never shown — and spell
it by tapping the letter blocks rolling toward a hedgehog, who spins up and
smashes through the one you pick. Right letters fill hangman-style blanks; wrong
ones bounce him off. Finish the word and he throws a party on top of it.

Aimed at kids as well as adults, so the clue is spoken too, repeats are
unlimited, and there is no failure state — misses cost momentum and position,
never the run.

## Run it

```
npm install
npm run dev            # http://127.0.0.1:5188  (hot-reload)
npm run build && npm run preview   # http://127.0.0.1:5189  (stable)
```

Use `preview` when you are judging how it looks: `dev` hot-reloads on every
file save, which reads as flicker.

## Controls

| | |
|---|---|
| Smash a letter | click / tap the block, or press the letter key |
| Jump a wall | Space, or the JUMP button |
| Hear the word and clue again | HINT — unlimited, no cooldown |
| Pause, speed, easy mode, levels | Escape / P, or PAUSE |
| Shop | the SHOP chip |

## Checks

```
npm run check      typecheck + visual guard + gameplay soak
npm run golden     visual regression only
npm run package    deploy-game.zip, and proves it boots before writing it
```

`npm run golden` is the one that matters. Every visual regression this project
has had — a bleached palette, a hedgehog drawn twice, theme tints multiplied to
3.46x, seams through composed panels — passed typecheck and passed the gameplay
soak, because none of them was a bug in behaviour. It photographs seven frozen,
seeded frames and fails on drift. If a change is intended, `npm run
golden:update` and review the diff before committing.

`tools/winnable.mjs` is the gameplay gate: it plays real words through real taps
and fails if the letter you need ever stops appearing.

## Layout

```
src/engine/     WebGL2 instanced batcher, atlas, loop, input, audio, save
src/game/       tuning, levels, themes, word session, walls, player, particles
src/scenes/     play, level select, shop
src/ui/         HUD, plates, sprite text
src/data/       325-word bank with vetted clues
tools/          art generation, chroma matting, packaging, the two guards
docs/           perf baseline, theme format, assist features, golden frames
```

Art is generated (`tools/genart.mjs`, needs `OPENAI_API_KEY` in `.env`) and
keyed out of a flat chroma background by `tools/matte.mjs`. Raws are cached in
`art-src/raw/`, so re-matting never costs another API call — only prompt changes
do. `public/art/` holds the matted result and is committed.

## Notes

- Speech uses the browser's own synthesiser, so no audio ships. It unlocks on
  the first gesture, as browsers require.
- Progress persists in IndexedDB with a localStorage mirror.
- `window.__build()` prints the build stamp — useful when a cached bundle makes
  a fixed bug look unfixed.
