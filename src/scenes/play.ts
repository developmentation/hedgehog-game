/**
 * The main play loop.
 *
 * Structure of a round:
 *   listening -> the word is spoken, the clue shows, walls start rolling in
 *   playing   -> tap/press the letter that comes next; correct letters are
 *                smashed and fill the hangman bar, wrong ones bounce you off
 *   celebrate -> the word is complete, the hedgehog throws a party on top
 *   setback   -> too many misses; you lose ground and a revealed letter, but
 *                never the run itself
 *
 * The design rule throughout is Flappy Bird's: one input, instant restart,
 * no modal failure. Misses cost momentum and position, not the session.
 *
 * This file is orchestration only. The word, the walls, the hedgehog and the
 * HUD each own themselves; the scene owns the phase machine, the score and the
 * routing of input.
 *
 * What is *played* is a `LevelDef` (see `game/levels.ts`) — which words, how
 * fast, how tall the columns, how forgiving, and what ends it. The scene holds
 * one `LevelRun` and hands it to the session and the field; nothing here knows
 * whether that level is the endless stream or a six-word themed sprint. Feel
 * constants that are true of the whole game — dash timing, springs, camera,
 * shake — still come from `TUNING`.
 */

import type { Ctx, Scene, PlayProbe } from '../core/ctx';
import { VIEW_W, GROUND_Y, PLAYER_X, damp } from '../core/ctx';
import { Particles } from '../game/particles';
import { Parallax } from '../game/parallax';
import { TUNING } from '../game/tuning';
import { WordSession } from '../game/wordSession';
import { WallField, type Wall, type Block } from '../game/wallField';
import { LevelRun, LEVELS, bootLevel, getLevel, type LevelDef } from '../game/levels';
import { Player } from '../game/player';
import {
  Hud,
  hudTopRowCY,
  HUD_EDGE_X,
  NOTICE_NONE,
  NOTICE_INFO,
  NOTICE_GOOD,
  NOTICE_BAD,
  type HudState,
  type HudFloater,
  type HudNotice,
} from '../ui/hud';
import { JumpButton } from '../ui/jumpButton';
import { Blend } from '../engine/gl';
import { BLOCK_W, BLOCK_H } from '../art/letters';
import { INK, rgb } from '../art/palette';
import { checkUnlocks, labelOf } from '../game/progression';
import { openShop, roundedPanel, roundedRing } from './shop';
import { drawText, measureText, type TextStyle } from '../ui/text';

type Phase = PlayProbe['phase'];

/**
 * The workshop chip: the spark balance, which doubles as the way in. It sits on
 * the same baseline as the status strip and is pinned to `r.viewLeft`, so the
 * top of the screen reads as one row at every aspect ratio instead of two
 * things floating at unrelated heights.
 *
 * Only the furniture is fixed — icon inset, gap before the label, right inset.
 * The balance's own width is measured, so a four-figure spark count can never
 * run into 'SHOP'.
 */
const CHIP_PAD_L = 54;
const CHIP_GAP = 18;
const CHIP_PAD_R = 20;
const CHIP_H = 72;
const CHIP_RAD = 36;
/**
 * Touch slop. At 390x844 a world unit is ~0.305 CSS px, so a 44 CSS px target
 * needs ~144 units; the chip is drawn 176x72 and taps within 176x156 of its
 * centre count. The extra reach is empty sky above and below the pill.
 */
const CHIP_HIT_H = 156;
const CHIP_HIT_W = 176;
const CHIP_FILL: [number, number, number] = [0.055, 0.062, 0.135];
const CHIP_GOLD = rgb(INK.gold);
const CHIP_PAPER = rgb(INK.paper);
const CHIP_SHADE = rgb(INK.paperShade);
/** Reused so the chip's two labels cost no allocation per frame. */
const CHIP_STYLE: TextStyle = { size: 23 };

/** How many deferred messages the banner channel will hold. */
const NOTICE_QUEUE_MAX = 3;

/** Seconds after a level ends before a press will restart it. */
const RESTART_ARM = 0.8;

/**
 * What the harness can read about the level on top of the play state. Kept out
 * of `PlayProbe` so the core contract stays as it was; `probe()` widens its
 * return type instead.
 */
export interface LevelProbe {
  level: string;
  levelTitle: string;
  theme: string;
  goal: string;
  /** 0..1 towards the goal. Always 0 in an endless level. */
  goalProgress: number;
  levelComplete: boolean;
  wordsDone: number;
  tier: number;
  columnHeight: number;
  targetSpeed: number;
}

export class PlayScene implements Scene {
  readonly name = 'play';

  private phase: Phase = 'intro';
  private phaseT = 0;

  // --- the level being played ---
  private run = new LevelRun(bootLevel());
  /** A level change asked for from outside, applied at the top of `update`. */
  private pendingLevel: LevelDef | null = null;

  // --- systems ---
  private session = new WordSession();
  private particles = new Particles();
  private field = new WallField(this.particles);
  private player = new Player(this.particles);
  private parallax = new Parallax();
  private hud = new Hud();

  // --- world ---
  private distance = 0;
  private scrollSpeed = TUNING.scroll.startSpeed;
  private targetSpeed = TUNING.scroll.startSpeed;

  // --- scoring ---
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private misses = 0;
  private lives = TUNING.scoring.maxMisses;
  private sparksEarned = 0;

  // --- hud state ---
  private scoreShown = 0;
  private comboFlash = 0;
  private slotPop: number[] = [];
  private floaters: HudFloater[] = [];
  private flash = 0;
  private flashColor: [number, number, number] = [1, 1, 1];
  private speakerPulse = 0;
  /** Seconds left on a player-requested clue recall. Counts down; 0 = idle. */
  private hintT = 0;

  /**
   * The one message channel. Mutated in place, so raising a banner allocates
   * nothing, and only ever one is on screen — see `raiseNotice`.
   */
  private notice: HudNotice = { text: '', sub: '', kind: NOTICE_NONE, t: 0, life: 0 };
  private noticeQueue: HudNotice[] = [];

  /** Screen-anchored shop chip, recomputed each frame; never reallocated. */
  private chip = { cx: 0, cy: 0, w: 176, h: CHIP_H };

  // --- progression ---
  private unlockBuf: string[] = [];
  private sparkStr = '0';
  private sparkCache = -1;
  /** Measured once: the 'SHOP' label never changes, but its width sizes the chip. */
  private readonly shopLabelW = measureText('SHOP', 19, 0.2);

  // --- the attempt currently in flight ---
  private pendingWall: Wall | null = null;
  private pendingBlock: Block | null = null;
  private pendingCorrect = false;

  // --- the hop ---
  /** The on-screen control. Owns its own layout and press animation. */
  private jumpBtn = new JumpButton();
  /** Raised once per session, the first time a wall arrives that cannot be spelled. */
  private jumpHinted = false;
  /**
   * A letter tap made in mid-air, held for `TUNING.jump.airBuffer` and replayed
   * the instant he lands.
   *
   * He cannot spin-dash while airborne — that is the whole price of the hop —
   * but "cannot" must not mean "the game ignored you". A tap made a beat before
   * touchdown is a tap the player meant for touchdown, so it is kept and fired
   * there; anything older than the window was meant for a moment that has gone,
   * and is dropped rather than replayed as a surprise.
   */
  private bufWall: Wall | null = null;
  private bufBlock: Block | null = null;
  private bufAge = 0;

  enter(ctx: Ctx): void {
    (window as any).__probeFn = () => this.probe();
    // The only entry point a level needs: list what exists, ask for one. The
    // request is queued rather than applied here, so it can be made from a
    // console or a harness at any moment without landing mid-update.
    (window as any).__levels = {
      list: () => LEVELS.map((l) => ({ id: l.id, title: l.title, goal: l.goal.kind })),
      current: () => this.run.config.id,
      start: (id: string) => {
        const def = getLevel(id);
        if (def) this.pendingLevel = def;
        return !!def;
      },
    };
    this.startLevel(ctx, this.run.config.def);
  }

  exit(): void {
    (window as any).__probeFn = null;
    (window as any).__levels = null;
  }

  // ------------------------------------------------------------------ level

  /**
   * Begin a run of one level. This is the only place a `LevelDef` becomes
   * live: a fresh `LevelRun` is built and handed to the two systems that are
   * shaped by it, and the scene's own totals are cleared.
   */
  private startLevel(ctx: Ctx, def: LevelDef): void {
    this.run = new LevelRun(def);
    const cfg = this.run.config;
    this.session.configure(this.run);
    this.field.configure(this.run);

    this.score = 0;
    this.scoreShown = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.sparksEarned = 0;
    this.floaters.length = 0;
    this.noticeQueue.length = 0;
    this.notice.kind = NOTICE_NONE;
    this.scrollSpeed = TUNING.scroll.startSpeed;
    // A level with no hop has nothing to teach about hopping.
    this.jumpHinted = !cfg.allowJump;

    this.startWord(ctx, true);
    this.phase = 'intro';
    this.phaseT = 0;

    // The endless run boots exactly as it always has: silent, straight into
    // the clue. Only a level with something to achieve announces itself.
    if (cfg.goalKind !== 'endless') {
      this.raiseNotice(cfg.title, this.run.progressLabel(), NOTICE_INFO, 1.8);
    }
  }

  /** The goal is met: stop the run and leave the result on screen. */
  private finishLevel(ctx: Ctx): void {
    this.phase = 'gameover';
    this.phaseT = 0;
    this.raiseNotice('LEVEL COMPLETE', this.run.config.title, NOTICE_GOOD, 4);
    ctx.audio.play('unlock', 1);
    ctx.shake(TUNING.feel.shake.word, TUNING.feel.shake.wordTime);
  }

  // ---------------------------------------------------------------- session

  private startWord(ctx: Ctx, first = false): void {
    this.session.begin(ctx);
    this.slotPop = new Array(this.session.word.length).fill(0);
    this.misses = 0;
    this.lives = this.run.config.lives;
    // A new word owns the message region. Anything still congratulating the
    // last one is cut short rather than left to fight the incoming clue — and
    // cut short by fading, not by vanishing mid-sentence.
    this.noticeQueue.length = 0;
    this.hintT = 0;
    const n = this.notice;
    if (n.kind !== NOTICE_NONE) n.life = Math.min(n.life, n.t + 0.3);

    // The level's difficulty shape decides the pace; TUNING decides how the
    // world eases into it.
    this.targetSpeed = this.run.speed;
    if (!first) this.scrollSpeed = this.targetSpeed * TUNING.scroll.resumeFactor;

    this.phase = 'listening';
    this.phaseT = 0;

    // Bring the hedgehog home. The celebration parks him mid-screen in the
    // dance pose, and without this he stayed there — still dancing, hundreds
    // of units off station — for the whole opening of every word after the
    // first, because only a dash ever reset him.
    this.player.returnHome();

    this.field.reset(ctx, this.session);
    this.speakWord(ctx);
  }

  private speakWord(ctx: Ctx): void {
    this.speakerPulse = 1;
    void ctx.audio.speak(this.session.spoken, {
      rate: ctx.save.profile.settings.speechRate,
    });
  }

  /**
   * The hint button: hear the word again *and* see the clue again.
   *
   * One control, because two buttons that both look like "play the audio"
   * would be worse than none. The clue is safe to re-show — the word bank
   * guarantees a clue never contains the word or its stem — so this restores
   * information the player already had rather than giving anything away.
   */
  private recallHint(ctx: Ctx): void {
    this.speakWord(ctx);
    this.hintT = TUNING.feel.hintHold;
    // An answer to something the player actually asked for outranks an
    // unsolicited nudge, so an INFO banner stands down and the clue appears now
    // rather than after it. Outcomes — a setback, a completed word — still win.
    if (this.notice.kind === NOTICE_INFO) {
      this.notice.kind = NOTICE_NONE;
      this.noticeQueue.length = 0;
    }
    ctx.audio.play('uiTap');
  }

  // ----------------------------------------------------------------- update

  update(ctx: Ctx, dt: number): void {
    if (this.pendingLevel) {
      const def = this.pendingLevel;
      this.pendingLevel = null;
      this.startLevel(ctx, def);
    }
    this.phaseT += dt;
    this.parallax.update(ctx, dt);
    this.particles.update(dt);
    this.updateFloaters(dt);
    this.updateNotice(dt);
    this.updateHudFx(dt);

    this.handleInput(ctx);

    const S = TUNING.scroll;
    switch (this.phase) {
      case 'intro':
        this.scrollSpeed = damp(this.scrollSpeed, S.introSpeed, S.ease.intro, dt);
        break;
      case 'listening':
        this.scrollSpeed = damp(this.scrollSpeed, this.targetSpeed * S.listenFactor, S.ease.listening, dt);
        if (this.phaseT > TUNING.feel.listenHold) this.phase = 'playing';
        break;
      case 'playing':
        this.scrollSpeed = damp(this.scrollSpeed, this.targetSpeed, S.ease.playing, dt);
        break;
      case 'celebrate':
        this.scrollSpeed = damp(this.scrollSpeed, 0, S.ease.celebrate, dt);
        this.updateCelebrate(ctx, dt);
        break;
      case 'setback':
        this.scrollSpeed = damp(this.scrollSpeed, S.setbackSpeed, S.ease.setback, dt);
        if (this.phaseT > TUNING.feel.setbackHold) {
          this.phase = 'playing';
          this.phaseT = 0;
          this.lives = this.run.config.lives;
          this.misses = 0;
        }
        break;
      case 'gameover':
        this.scrollSpeed = damp(this.scrollSpeed, 0, S.ease.gameover, dt);
        break;
    }

    this.distance += this.scrollSpeed * dt;
    this.field.update(ctx, dt, {
      session: this.session,
      scrollSpeed: this.scrollSpeed,
      // The hedgehog's *running line*, not wherever the dash has flung him.
      //
      // A spin-dash at a far column carries him hundreds of units downfield for
      // a fifth of a second, and the field was measuring "has this wall gone
      // past the player?" against that. So smashing a letter two columns out
      // charged a life for every column he flew over — walls that were still
      // several hundred units *in front of* him when he landed, still on
      // screen, still tappable, and now silently dead: no telegraph, ignored by
      // `ensureWinnable`, uncounted by the spawner. Clamping to the home line
      // means only the world scrolling past can retire a wall, which is the
      // only thing the player ever reads as one going past.
      playerX: Math.min(this.player.x, PLAYER_X),
      onPassed: (w) => {
        if (this.phase !== 'playing') return;
        // Airborne and over the column: it rolls past underneath him and costs
        // nothing. This is the one place the hop pays out, and it is decided by
        // where the hedgehog actually is rather than by a flag set on input —
        // so what the player saw happen is what the rules did.
        if (this.player.clearsColumnAt(w.x)) {
          this.registerDodge(ctx, w);
          return;
        }
        this.registerMiss(ctx, w.x, GROUND_Y - 140, true);
      },
      shouldSpawn: () => this.phase !== 'celebrate' && this.phase !== 'gameover',
    });
    this.player.update(ctx, dt, this.scrollSpeed, () => this.completeDash(ctx));
    this.jumpBtn.update(dt, this.player.canJump() && this.canJumpNow());
    this.flushAirBuffer(ctx, dt);
    this.maybeHintJump();
    this.updateCamera(ctx, dt);
  }

  /**
   * Hold a mid-air letter tap, then replay it the moment his feet are down.
   *
   * Everything is re-validated at replay time — the block may have been taken
   * by the same input twice, the wall may have rolled past — because the world
   * has moved on since the tap and a stale reference is exactly how a buffered
   * input turns into a dash at nothing.
   */
  private flushAirBuffer(ctx: Ctx, dt: number): void {
    if (!this.bufBlock || !this.bufWall) return;
    this.bufAge += dt;
    const stale =
      this.bufAge > TUNING.jump.airBuffer ||
      !this.bufBlock.alive ||
      this.bufWall.passed ||
      this.bufWall.x < this.player.x - TUNING.walls.passedInset;
    if (stale) {
      this.bufWall = null;
      this.bufBlock = null;
      return;
    }
    if (this.player.isBusy() || this.phase !== 'playing') return;
    const wall = this.bufWall;
    const block = this.bufBlock;
    this.bufWall = null;
    this.bufBlock = null;
    this.attempt(ctx, wall, block);
  }

  /**
   * The one-time prompt.
   *
   * Fired the first time the nearest live column cannot supply the letter the
   * player needs — which is precisely the first moment the hop is the right
   * answer, and therefore the only moment the sentence "you can jump" is worth
   * reading. It is raised at INFO severity, so anything the round has to say
   * about the round itself outranks it.
   */
  private maybeHintJump(): void {
    if (this.jumpHinted || this.phase !== 'playing') return;
    const J = TUNING.jump;
    const need = this.session.needed;
    for (const w of this.field.walls) {
      if (w.spent || w.passed) continue;
      const d = w.x - this.player.x;
      if (d < 0) continue;
      if (d > J.hintDistance) return;
      for (const b of w.blocks) if (b.alive && b.letter === need) return;
      this.raiseJumpHint();
      return;
    }
  }

  private raiseJumpHint(): void {
    if (this.jumpHinted) return;
    this.jumpHinted = true;
    this.raiseNotice('HOP IT', 'SPACE OR THE JUMP BUTTON', NOTICE_INFO, TUNING.jump.hintHold);
  }

  /** Phases in which leaving the ground makes sense at all. */
  private canJumpNow(): boolean {
    if (!this.run.config.allowJump) return false;
    return this.phase === 'playing' || this.phase === 'listening' || this.phase === 'setback';
  }

  private updateHudFx(dt: number): void {
    const F = TUNING.feel;
    this.flash = Math.max(0, this.flash - dt * F.flash.decay);
    this.comboFlash = Math.max(0, this.comboFlash - dt * F.comboFlashDecay);
    this.speakerPulse = Math.max(0, this.speakerPulse - dt * F.speakerPulseDecay);
    this.hintT = Math.max(0, this.hintT - dt);
    this.scoreShown = damp(this.scoreShown, this.score, F.scoreEase, dt);
    for (let i = 0; i < this.slotPop.length; i++) {
      this.slotPop[i] = Math.max(0, this.slotPop[i] - dt * F.slotPopDecay);
    }
  }

  private updateCamera(ctx: Ctx, dt: number): void {
    // Lead the camera slightly in the direction of travel and lift on dash,
    // so a smash feels like it moves the whole frame.
    const C = TUNING.camera;
    const targetZoom =
      this.player.state === 'dash'
        ? C.zoomDash
        : this.phase === 'celebrate'
          ? C.zoomCelebrate
          : C.zoomBase;
    ctx.cam.zoom = damp(ctx.cam.zoom, targetZoom, C.zoomEase, dt);
    const targetY = this.player.state === 'dash' ? C.liftDash : C.liftBase;
    ctx.cam.y = damp(ctx.cam.y, targetY, C.liftEase, dt);
  }

  private updateCelebrate(ctx: Ctx, dt: number): void {
    if (this.phaseT < TUNING.feel.celebrateHold) {
      this.player.confetti(ctx, dt);
    } else if (this.run.complete) {
      // The goal was met by the word we have just finished celebrating. An
      // endless level never reaches here, which is the whole of its specialness.
      this.finishLevel(ctx);
    } else {
      this.session.promote(this.bestCombo);
      this.startWord(ctx);
    }
  }

  // ------------------------------------------------------------------ input

  private handleInput(ctx: Ctx): void {
    // The workshop is reachable from anywhere, including mid-word — nothing is
    // lost by opening it, so there is no reason to gate it behind a phase.
    if (ctx.input.pausePressed) {
      openShop();
      return;
    }
    this.layoutChip(ctx);
    for (let i = 0; i < ctx.input.taps.length; i++) {
      const t = ctx.input.taps[i];
      if (this.hitChip(t.x, t.y)) {
        ctx.audio.play('uiTap');
        openShop();
        return;
      }
    }

    if (this.phase === 'intro') {
      if (ctx.input.anyPressed) {
        this.phase = 'listening';
        this.phaseT = 0;
        this.speakWord(ctx);
      }
      return;
    }

    // The level is over. The only input left is "again", and it is armed a
    // beat late so the tap that finished the level cannot restart it.
    if (this.phase === 'gameover') {
      if (this.phaseT > RESTART_ARM && ctx.input.anyPressed) {
        this.startLevel(ctx, this.run.config.def);
      }
      return;
    }

    const busy = this.player.isBusy() || this.phase === 'celebrate';
    // Space and the Up arrow arrive here; the intro branch above has already
    // returned, so the confirm-key overload can never eat the hop.
    let wantJump = ctx.input.jumpPressed;
    const hopping = this.run.config.allowJump;

    if (hopping) this.jumpBtn.layout(ctx);

    for (const tap of ctx.input.taps) {
      // The hint button always wins — the player must be able to re-hear the
      // word and re-read the clue at any moment, including mid-dash. Forgetting
      // the word is the failure mode this game is built around, so recovery
      // from it is never gated on a phase.
      if (this.hud.hitSpeaker(tap.x, tap.y)) {
        this.recallHint(ctx);
        continue;
      }
      // The control is tested before the field, so a column drifting behind it
      // can never steal a press meant for the button.
      if (hopping && this.jumpBtn.hit(tap.x, tap.y)) {
        this.jumpBtn.bump();
        wantJump = true;
        continue;
      }
      // The field is tested BEFORE the clue card, so a message surface never
      // costs the player a letter: a block behind the card is still smashed by
      // tapping it.
      const hit = this.field.blockAt(tap.x, tap.y);
      if (hit) {
        if (busy) this.bufferAttempt(hit.wall, hit.block);
        else this.attempt(ctx, hit.wall, hit.block);
        continue;
      }
      // A tap on the sentence itself is not a hop. It is the player finishing
      // with it, so the recalled clue takes the tap and leaves.
      if (this.hud.hitCard(tap.x, tap.y)) {
        if (this.hintT > 0.3) this.hintT = 0.3;
        continue;
      }
      // Nothing under the finger: empty sky, empty ground. That is a hop.
      wantJump = true;
    }

    for (const key of ctx.input.keysPressed) {
      const hit = this.field.nearestBlockWithLetter(key, this.player.x);
      if (!hit) continue;
      if (busy) this.bufferAttempt(hit.wall, hit.block);
      else this.attempt(ctx, hit.wall, hit.block);
    }

    if (wantJump) this.tryJump(ctx);
  }

  /** Hold a letter input made while he is committed to another move. */
  private bufferAttempt(wall: Wall, block: Block): void {
    // Only the hop buffers. A dash or a knockback is already resolving into a
    // hit or a miss, and queueing a second attempt behind it would fire an
    // input the player made about a wall that is about to change.
    if (!this.player.isAirborne()) return;
    this.bufWall = wall;
    this.bufBlock = block;
    this.bufAge = 0;
  }

  private tryJump(ctx: Ctx): void {
    if (!this.run.config.allowJump) return;
    this.jumpBtn.bump();
    if (!this.canJumpNow()) return;
    if (!this.player.jump(ctx)) return;
    // The player has found the move; the tutorial prompt has nothing left to
    // teach and is never raised.
    this.jumpHinted = true;
    ctx.audio.play('charge', 0.34);
  }

  // --------------------------------------------------------------- attempts

  private attempt(ctx: Ctx, wall: Wall, block: Block): void {
    if (this.phase === 'listening') this.phase = 'playing';
    if (this.phase !== 'playing') return;

    this.pendingWall = wall;
    this.pendingBlock = block;
    this.pendingCorrect = block.letter === this.session.needed;

    this.player.dashTo(wall.x + block.ox - BLOCK_W * TUNING.dash.landingInset, block.y);
    ctx.audio.play('charge', 0.7);
  }

  private completeDash(ctx: Ctx): void {
    const wall = this.pendingWall;
    const block = this.pendingBlock;
    if (!wall || !block) {
      this.player.returnHome();
      return;
    }
    if (this.pendingCorrect) this.smash(ctx, wall, block);
    else this.bounceOff(ctx, wall, block);
    this.pendingWall = null;
    this.pendingBlock = null;
  }

  private smash(ctx: Ctx, wall: Wall, block: Block): void {
    block.alive = false;
    wall.spent = true;

    const bx = wall.x + block.ox;
    const by = block.y;

    this.slotPop[this.session.advance()] = 1;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboFlash = 1;

    const C = TUNING.scoring;
    const F = TUNING.feel;
    const comboMul = 1 + Math.min(this.combo - 1, C.comboCap) * C.comboStep;
    const gained = Math.round(C.perLetter * comboMul * this.session.tier);
    this.score += gained;
    this.sparksEarned += Math.round(gained * C.sparkShareLetter);

    ctx.save.profile.lettersSmashed++;

    // One floater per smash. The combo used to be a second popup 70 units to
    // the right, which meant two labels landing on the same pixels; it is now
    // a caption on the same object, so there is nothing left to collide with.
    this.addFloater(
      `+${gained}`,
      bx,
      by - 40,
      rgb(INK.gold),
      34,
      this.combo > 1 ? `${this.combo}x` : '',
    );

    const comboStep = Math.min(this.combo, F.shake.smashComboCap);
    ctx.audio.play('smash', F.smashPitchBase + comboStep * F.smashPitchStep);
    ctx.audio.play('comboUp', 0.8);
    ctx.shake(F.shake.smash + comboStep, F.shake.smashTime);
    ctx.hitStop(F.hitStopSmash);
    this.flash = F.flash.smash;
    this.flashColor = [1, 0.95, 0.8];

    this.field.shatter(ctx, bx, by);

    // Jolt the surviving blocks in the same wall.
    for (const b of wall.blocks) if (b.alive) b.jolt = 1;

    if (this.session.complete) this.completeWord(ctx);
  }

  private bounceOff(ctx: Ctx, wall: Wall, block: Block): void {
    block.jolt = 1;
    this.player.bounce();
    this.registerMiss(ctx, wall.x + block.ox, block.y, false);
  }

  /**
   * A wall cleared by hopping it.
   *
   * Costs nothing: no life, no score, and — deliberately — no combo break. The
   * player did not fail to spell that column, they declined it, and a streak
   * that survives a considered dodge is what makes the move feel like part of
   * the game rather than a penalty box. The only thing they gave up is the
   * letter that column was carrying, which is cost enough.
   */
  private registerDodge(ctx: Ctx, wall: Wall): void {
    this.addFloater('DODGED', wall.x, GROUND_Y - 200, rgb(INK.good), 28);
    ctx.audio.play('uiTap', 0.5);
    this.field.dust(ctx, wall.x, GROUND_Y - 30);
  }

  private registerMiss(ctx: Ctx, x: number, y: number, passedBy: boolean): void {
    const C = TUNING.scoring;
    const F = TUNING.feel;

    // Losing a life to a wall that simply rolled past is the other moment the
    // hop is worth knowing about, and the more legible of the two — so if the
    // prompt has not fired yet, it fires here.
    if (passedBy) this.raiseJumpHint();

    this.combo = 0;
    ctx.audio.resetCombo();
    this.misses++;
    this.lives = Math.max(0, this.lives - 1);

    const penalty = Math.min(this.score, C.missPenaltyPerTier * this.session.tier);
    this.score -= penalty;
    if (penalty > 0) this.addFloater(`-${penalty}`, x, y - 30, rgb(INK.danger), 30);

    ctx.audio.play('bounce', 1);
    ctx.shake(passedBy ? F.shake.missPassed : F.shake.missHit, F.shake.missTime);
    this.flash = F.flash.miss;
    this.flashColor = [1, 0.4, 0.45];

    this.field.dust(ctx, x, y);

    if (this.lives <= 0) this.triggerSetback(ctx);
  }

  /**
   * The setback: you lose ground and the most recent letter, but never the
   * run. This is the "no punishment" promise — the cost is momentum and
   * position, and you can always keep going.
   */
  private triggerSetback(ctx: Ctx): void {
    const C = TUNING.scoring;
    const F = TUNING.feel;

    this.phase = 'setback';
    this.phaseT = 0;

    const slot = this.session.revert();
    if (slot >= 0) this.slotPop[slot] = 1;
    const lost = Math.round(this.score * this.run.config.setbackCost);
    this.score = Math.max(0, this.score - lost);
    this.bestCombo = 0;

    // Push the walls back so the player literally loses ground.
    this.field.pushBack(C.setbackPushBack, PLAYER_X);

    ctx.audio.play('setback', 1);
    ctx.shake(F.shake.setback, F.shake.setbackTime);
    this.flash = F.flash.setback;
    this.flashColor = [1, 0.3, 0.36];
    // What happened and what to do about it, in one object. These used to be a
    // "SET BACK" floater and a separate "KEEP ROLLING" panel drawn at two
    // sizes in the same 200 world units.
    this.raiseNotice('SET BACK', 'KEEP ROLLING', NOTICE_BAD, F.setbackHold);
  }

  private completeWord(ctx: Ctx): void {
    const C = TUNING.scoring;
    const F = TUNING.feel;

    this.phase = 'celebrate';
    this.phaseT = 0;
    this.player.dance(this.player.x);

    const bonus = C.wordBonusPerTier * this.session.tier + this.bestCombo * C.wordBonusPerCombo;
    this.score += bonus;
    this.sparksEarned += Math.round(bonus * C.sparkShareWord);
    this.raiseNotice('WORD COMPLETE', `+${bonus} BONUS`, NOTICE_GOOD, 1.1);

    // Bank the word against the level's goal, then say where that leaves us.
    // The line queues behind the completion banner rather than fighting it,
    // and an endless level has nothing to report so it says nothing.
    const done = this.run.noteWord(this.score, this.bestCombo);
    if (this.run.config.goalKind !== 'endless' && !done) {
      this.raiseNotice('GOAL', this.run.progressLabel(), NOTICE_INFO, 1.2);
    }

    const p = ctx.save.profile;
    p.wordsCompleted++;
    p.longestStreak = Math.max(p.longestStreak, this.bestCombo);
    p.bestScore = Math.max(p.bestScore, this.score);
    p.totalScore += bonus;
    p.sparks += this.sparksEarned;
    this.sparksEarned = 0;
    this.session.recordCompletion(ctx, this.misses);

    // Milestones are evaluated once the word's takings are banked, so a reward
    // earned by this very word lands in the same celebration.
    // Unlocks are raised at a lower severity than the completion itself, so
    // they queue behind it and play one after another rather than stacking.
    const newly = checkUnlocks(p, this.unlockBuf);
    for (let i = 0; i < newly.length; i++) {
      this.raiseNotice('UNLOCKED', labelOf(newly[i]).toUpperCase(), NOTICE_INFO, 0.9);
    }
    if (newly.length) ctx.audio.play('unlock', 1);

    ctx.save.save();

    ctx.audio.play('wordComplete', 1);
    ctx.audio.resetCombo();
    void ctx.audio.speak(this.session.spoken, { rate: 0.9 });
    ctx.shake(F.shake.word, F.shake.wordTime);
    this.flash = F.flash.word;
    this.flashColor = [1, 0.95, 0.7];
    this.player.cheer(ctx);
  }

  // --------------------------------------------------------------- floaters

  private addFloater(
    text: string,
    x: number,
    y: number,
    c: [number, number, number],
    size: number,
    sub = '',
  ): void {
    const F = TUNING.feel.floater;
    this.floaters.push({ text, sub, x, y: this.clearY(text, x, y, size), t: 0, life: F.life, c, size });
    if (this.floaters.length > F.max) this.floaters.shift();
  }

  /**
   * Stack a new floater clear of the live ones instead of printing it on top.
   * Two smashes in quick succession land within a block of each other, and the
   * old behaviour put both labels on the same pixels; this walks the newcomer
   * upwards until its box is free. Bounded passes, no allocation.
   */
  private clearY(text: string, x: number, y: number, size: number): number {
    const w = text.length * size * 0.55;
    const h = size * 1.9;
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      for (let i = 0; i < this.floaters.length; i++) {
        const f = this.floaters[i];
        const fw = f.text.length * f.size * 0.55;
        const fh = f.size * 1.9;
        if (Math.abs(f.x - x) < (w + fw) * 0.5 && Math.abs(f.y - y) < (h + fh) * 0.5) {
          y = f.y - (h + fh) * 0.5 - 8;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return y;
  }

  private updateFloaters(dt: number): void {
    const rise = TUNING.feel.floater.rise;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      f.y -= dt * rise;
      if (f.t >= f.life) this.floaters.splice(i, 1);
    }
  }

  // ---------------------------------------------------------- message channel

  /**
   * Put a message in the single banner slot.
   *
   * The rule is severity, and it is total: a message of equal or higher
   * severity takes the slot immediately, a strictly higher one also wipes
   * anything queued behind it (a setback should not be followed by leftover
   * congratulations), and a lower one waits its turn. Because there is exactly
   * one slot, two banners can never share the screen — which is the whole
   * point, since "SET BACK" and "KEEP ROLLING" used to.
   */
  private raiseNotice(text: string, sub: string, kind: number, life: number): void {
    const cur = this.notice;
    const live = cur.kind !== NOTICE_NONE && cur.t < cur.life;
    if (live && kind < cur.kind) {
      if (this.noticeQueue.length < NOTICE_QUEUE_MAX) {
        this.noticeQueue.push({ text, sub, kind, t: 0, life });
      }
      return;
    }
    if (kind > cur.kind) this.noticeQueue.length = 0;
    cur.text = text;
    cur.sub = sub;
    cur.kind = kind;
    cur.t = 0;
    cur.life = life;
  }

  private updateNotice(dt: number): void {
    const n = this.notice;
    if (n.kind === NOTICE_NONE) return;
    n.t += dt;
    if (n.t < n.life) return;
    const next = this.noticeQueue.shift();
    if (!next) {
      n.kind = NOTICE_NONE;
      return;
    }
    n.text = next.text;
    n.sub = next.sub;
    n.kind = next.kind;
    n.life = next.life;
    n.t = 0;
  }

  // ------------------------------------------------------------------- draw

  draw(ctx: Ctx): void {
    this.parallax.draw(ctx, this.distance);
    // Hero shade goes down BEFORE the blocks, so the pool of shade he sits in
    // lands on the ground rather than washing over any column beside him.
    this.player.drawShade(ctx);
    this.field.draw(ctx);
    this.particles.draw(ctx);
    this.player.draw(ctx);
    // Foreground foliage last, so it sweeps in FRONT of the hedgehog and the
    // blocks. That occlusion is most of what sells the depth of the scene.
    this.parallax.drawForeground(ctx, this.distance);
  }

  drawUi(ctx: Ctx): void {
    this.hud.draw(ctx, this.hudState());
    this.drawShopChip(ctx);
    this.drawJumpButton(ctx);
  }

  /**
   * The hop control, drawn after the HUD so nothing can cover it, and given a
   * gentle pull-focus for as long as the player has never used it.
   */
  private drawJumpButton(ctx: Ctx): void {
    // A level that has taken the hop away does not show its control either.
    if (!this.run.config.allowJump) return;
    const live = this.canJumpNow() || this.phase === 'intro';
    const ready = this.player.canJump() && this.canJumpNow();
    this.jumpBtn.draw(ctx, ready, live ? this.player.jumpCharge() : 0);
    ctx.r.setBlend(Blend.Additive);
    // Until it has been pressed once it breathes, exactly as the speaker does
    // while a word is playing — the same idiom for the same job.
    const attention = this.jumpHinted ? 0 : 0.5 + Math.sin(ctx.time * 3.4) * 0.5;
    this.jumpBtn.drawGlow(ctx, ready, attention);
    ctx.r.setBlend(Blend.Normal);
  }

  /**
   * Pin the chip to the left edge of whatever is actually on screen, on the
   * status strip's baseline. Mutates a field; allocates nothing.
   */
  private layoutChip(ctx: Ctx): void {
    const r = ctx.r;
    const sparks = ctx.save.profile.sparks;
    if (this.sparkCache !== sparks) {
      this.sparkCache = sparks;
      this.sparkStr = String(sparks);
      this.chip.w = Math.max(
        176,
        CHIP_PAD_L + measureText(this.sparkStr, 30) + CHIP_GAP + this.shopLabelW + CHIP_PAD_R,
      );
    }
    this.chip.cx = r.viewLeft + HUD_EDGE_X + this.chip.w / 2;
    this.chip.cy = hudTopRowCY(r.safeTop);
  }

  private hitChip(x: number, y: number): boolean {
    const c = this.chip;
    const hw = Math.max(c.w, CHIP_HIT_W) / 2;
    return (
      x >= c.cx - hw &&
      x <= c.cx + hw &&
      y >= c.cy - CHIP_HIT_H / 2 &&
      y <= c.cy + CHIP_HIT_H / 2
    );
  }

  /** Spark balance + the way into the workshop. Deliberately quiet. */
  private drawShopChip(ctx: Ctx): void {
    const r = ctx.r;
    this.layoutChip(ctx);
    const c = this.chip;
    const x = c.cx - c.w / 2;
    const y = c.cy - c.h / 2;
    const hovered = ctx.input.hasHover && this.hitChip(ctx.input.hoverX, ctx.input.hoverY);

    // Same plate as the status strip opposite it: one row, one material.
    roundedPanel(ctx, x, y, c.w, c.h, CHIP_RAD, CHIP_FILL, hovered ? 1 : 0.97);
    roundedRing(ctx, x, y, c.w, c.h, CHIP_RAD, CHIP_GOLD, hovered ? 0.85 : 0.38);

    const spark = ctx.atlas.get('ui/spark');
    const ss = 26 / spark.w;
    r.draw(spark, x + 32, c.cy, ss, ss, ctx.time * 0.5, CHIP_GOLD[0], CHIP_GOLD[1], CHIP_GOLD[2], 1);

    CHIP_STYLE.size = 30;
    CHIP_STYLE.color = CHIP_PAPER;
    CHIP_STYLE.align = 'left';
    CHIP_STYLE.alpha = 1;
    CHIP_STYLE.tracking = 0;
    CHIP_STYLE.shadow = 3;
    drawText(ctx, this.sparkStr, x + CHIP_PAD_L, c.cy, CHIP_STYLE);

    CHIP_STYLE.size = 19;
    CHIP_STYLE.color = CHIP_SHADE;
    CHIP_STYLE.align = 'right';
    CHIP_STYLE.alpha = hovered ? 0.95 : 0.62;
    CHIP_STYLE.tracking = 0.2;
    CHIP_STYLE.shadow = 2;
    drawText(ctx, 'SHOP', x + c.w - CHIP_PAD_R, c.cy, CHIP_STYLE);
  }

  private hudState(): HudState {
    return {
      phase: this.phase,
      phaseT: this.phaseT,
      word: this.session.word,
      clueLines: this.session.clueLines,
      revealed: this.session.revealed,
      nextIndex: this.session.nextIndex,
      scoreShown: this.scoreShown,
      combo: this.combo,
      comboFlash: this.comboFlash,
      lives: this.lives,
      slotPop: this.slotPop,
      floaters: this.floaters,
      notice: this.notice,
      hintT: this.hintT,
      flash: this.flash,
      flashColor: this.flashColor,
      speakerPulse: this.speakerPulse,
    };
  }

  // ------------------------------------------------------------------ probe

  probe(): PlayProbe & LevelProbe {
    const cfg = this.run.config;
    const targets: PlayProbe['targets'] = [];
    for (const w of this.field.walls) {
      if (w.x < -100 || w.x > VIEW_W + 100) continue;
      for (const b of w.blocks) {
        if (!b.alive) continue;
        targets.push({ letter: b.letter, x: w.x + b.ox, y: b.y, w: BLOCK_W, h: BLOCK_H });
      }
    }
    return {
      phase: this.phase,
      word: this.session.word,
      revealed: this.session.revealed.slice(),
      nextIndex: this.session.nextIndex,
      score: this.score,
      combo: this.combo,
      misses: this.misses,
      lives: this.lives,
      targets,
      playerState: this.player.state,
      airHeight: GROUND_Y - this.player.y,
      jumpBtn: { x: this.jumpBtn.cx, y: this.jumpBtn.cy, d: this.jumpBtn.d },
      level: cfg.id,
      levelTitle: cfg.title,
      theme: cfg.theme,
      goal: cfg.goalKind,
      goalProgress: this.run.progress,
      levelComplete: this.run.complete,
      wordsDone: this.run.wordsDone,
      tier: this.session.tier,
      columnHeight: this.run.columnHeight,
      targetSpeed: this.targetSpeed,
    };
  }
}
