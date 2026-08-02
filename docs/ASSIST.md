# Pause, speed and easy mode

Three assist features aimed at younger players. All three persist in
`Profile.settings` (IndexedDB, with the localStorage mirror) and survive a
reload.

## Where they live

Four corners, one control each, so nothing competes:

| corner | control |
|---|---|
| top-left | SHOP chip |
| top-right | HINT (re-hear the word, recall the clue) |
| bottom-left | JUMP |
| bottom-right | **PAUSE** |

Speed and easy mode live **on the pause panel**, not on the HUD — they are
settings, not controls, and a child should not be able to hit them by accident
mid-word. When either is off-default a small gold pill (`0.6x EASY`) sits above
the pause disc, so an adult can read the state without opening anything.

## Pause

`Escape` or `P`, or the disc. These keys no longer open the shop; the workshop
is now reachable from the pause panel, which is also arrow-key + Enter
walkable, so the keyboard reaches everything.

The world stops dead — verified with wall displacement at **0.00** across a
pause — and the hedgehog settles. He is not frozen mid-stride: his own curl
hysteresis uncurls him out of the ball onto his paws, his stride is
distance-driven so it stops with him planted on a footfall frame, the idle bob
keeps him breathing, and the scene holds his squash spring at −0.28 so he sits
back on his haunches.

Assembled entirely from the controller's existing public behaviour — no new
player state. It reads as "stopped, planted, waiting" rather than a literal
sit-down; that is as close as the six existing states get.

Resume is lossless from any state. A paused dash still lands its letter; a
paused hop still comes down.

## Speed

Scales world scroll and, because spawning is distance-paced, wall spawning with
it. It does **not** touch dash timing, hop timing, hit-stop, clue holds or input
windows — those stay snappy at every setting.

| setting | target px/s (tier 1) | measured |
|---|---|---|
| 0.6x | 154 | 150–151 |
| 0.8x | 205 | 198–208 |
| 1.0x | 256 | 235–253 |
| 1.25x | 320 | 296–314 |

At 0.6x a column takes ~4.0 s to cross instead of 2.4 s. At 1.25x tier 4 reaches
418 px/s and is still tappable. Both extremes complete words with zero errors.

## Easy mode

A wrong letter still bounces him off with the thud, the shake and the dust — the
feedback is the teaching, so it stays. It just costs nothing: no life, no
points, no combo break, and it can never trigger a setback.

Against farming, two things:

- **Records are not written at all.** `bestScore` and `longestStreak` stay put;
  a record set with the penalties off is not a record.
- **Accumulating totals bank at `TUNING.assist.easyEarnShare` (0.4)** — sparks
  and lifetime score, which drives rank.

What is *not* discounted is the learning. The word, the letters and the per-word
mastery stats count in full, so the word-count milestones stay reachable for a
five-year-old. `Profile.easyWords` records how many words were earned with the
net up.

## Known rough edges

- The pause disc sits on the word-dock band, because that is the only strip of
  the frame no letter column can reach — a control in the playfield would
  eventually eat a live letter tap, and for *pause* that reads as a dead game.
  It holds itself clear of the plaque using a copy of the dock's slot geometry;
  if the dock is ever re-proportioned that gap tightens. At 12 letters and
  exactly 1280 wide there is no clear air, and the disc gives ground toward the
  screen edge rather than covering a slot.
- The clue timer runs on `ctx.time`, which the pause does not stop, so a long
  pause can outlive the clue card. Resuming mid-word therefore re-speaks the
  word and brings the clue back for its normal hold — which is what a child
  needs anyway, but it is compensation rather than a frozen clock.
