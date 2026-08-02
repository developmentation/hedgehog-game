/**
 * Unified input: touch, mouse and keyboard funnel into one tap/pointer model.
 *
 * The game only ever asks two questions — "was there a tap this frame, and
 * where in world space?" and "was a letter key pressed?" — so every device
 * path converges on the same two answers. Multi-touch is supported: each
 * simultaneous finger produces its own tap, which matters when a player
 * hammers two letters at once.
 *
 * One gesture is recognised on top of that model: a flick upwards. It is purely
 * additive — the flick still produces its usual tap on the way down, so nothing
 * that reads `taps` changes behaviour — and it exists because "swipe up to jump"
 * is the gesture a phone player will try first.
 */

import type { Renderer } from './gl';
import { TUNING } from '../game/tuning';

export interface Tap {
  x: number;
  y: number;
  /** Pointer id, or -1 for keyboard-sourced taps. */
  id: number;
  /** Set when the tap came from a physical key rather than a pointer. */
  key: string | null;
}

const SCRATCH = { x: 0, y: 0 };

export class Input {
  /** Taps that began this frame, in world coordinates. */
  readonly taps: Tap[] = [];
  /** Letters pressed this frame, uppercase. */
  readonly keysPressed: string[] = [];
  /** Currently-held pointer positions in world space, by pointer id. */
  readonly pointers = new Map<number, { x: number; y: number }>();

  /** Last known pointer position in world space — drives hover highlights. */
  hoverX = -9999;
  hoverY = -9999;
  hasHover = false;

  /** True while any pointer is down. */
  anyDown = false;
  /** Set on the frame a "confirm/any" input arrives (tap, space, enter). */
  anyPressed = false;
  /**
   * Set on the frame Escape or P is pressed.
   *
   * This is the PAUSE key, and only the pause key. It used to open the workshop
   * from the play scene, which meant the one key every player already knows the
   * meaning of did something else — so the shop keeps its own on-screen chip and
   * a button on the pause panel, and Escape stops the world. A scene layered on
   * top (the workshop, the pause panel) reads the same flag as "close me",
   * which is the same gesture one level in.
   */
  pausePressed = false;
  /**
   * Set on the frame a jump is asked for: Space, Up/W, or an upward flick.
   *
   * Deliberately *separate* from `anyPressed` rather than derived from it.
   * Space feeds both — it is the confirm key and the jump key — and a consumer
   * that wants one must not be handed the other, which is exactly the confusion
   * that would make Space start the round and never hop.
   */
  jumpPressed = false;

  private renderer: Renderer;
  private el: HTMLElement;
  private detachers: (() => void)[] = [];
  /** Where and when each live pointer went down, for flick detection. */
  private starts = new Map<number, { x: number; y: number; t: number; touch: boolean }>();

  constructor(renderer: Renderer, el: HTMLElement) {
    this.renderer = renderer;
    this.el = el;
    this.attach();
  }

  private attach(): void {
    const el = this.el;

    const onPointerDown = (e: PointerEvent) => {
      el.setPointerCapture?.(e.pointerId);
      this.renderer.screenToWorld(e.clientX, e.clientY, SCRATCH);
      this.pointers.set(e.pointerId, { x: SCRATCH.x, y: SCRATCH.y });
      this.starts.set(e.pointerId, {
        x: SCRATCH.x,
        y: SCRATCH.y,
        t: performance.now(),
        touch: e.pointerType === 'touch',
      });
      this.taps.push({ x: SCRATCH.x, y: SCRATCH.y, id: e.pointerId, key: null });
      this.hoverX = SCRATCH.x;
      this.hoverY = SCRATCH.y;
      this.hasHover = true;
      this.anyDown = true;
      this.anyPressed = true;
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      this.renderer.screenToWorld(e.clientX, e.clientY, SCRATCH);
      const p = this.pointers.get(e.pointerId);
      if (p) {
        p.x = SCRATCH.x;
        p.y = SCRATCH.y;
      }
      // Touch has no hover state; only a mouse should light up letters.
      if (e.pointerType === 'mouse') {
        this.hoverX = SCRATCH.x;
        this.hoverY = SCRATCH.y;
        this.hasHover = true;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const s = this.starts.get(e.pointerId);
      this.starts.delete(e.pointerId);
      this.pointers.delete(e.pointerId);
      this.anyDown = this.pointers.size > 0;
      if (e.pointerType === 'touch') this.hasHover = false;

      // An upward flick. Touch only: a mouse drag up over the sky is not a
      // gesture anyone means, and the same movement with a held button is how
      // a mouse user selects nothing.
      if (!s || !s.touch) return;
      this.renderer.screenToWorld(e.clientX, e.clientY, SCRATCH);
      const J = TUNING.jump;
      const rise = s.y - SCRATCH.y;
      const drift = Math.abs(SCRATCH.x - s.x);
      const secs = (performance.now() - s.t) / 1000;
      if (rise >= J.swipeRise && drift <= J.swipeDrift && secs <= J.swipeTime) {
        this.jumpPressed = true;
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      this.starts.delete(e.pointerId);
      this.pointers.delete(e.pointerId);
      this.anyDown = this.pointers.size > 0;
      if (e.pointerType === 'touch') this.hasHover = false;
    };

    const onPointerLeave = () => {
      this.hasHover = false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key;
      if (k.length === 1) {
        const up = k.toUpperCase();
        if (up >= 'A' && up <= 'Z') {
          this.keysPressed.push(up);
          this.anyPressed = true;
          e.preventDefault();
          return;
        }
      }
      // Space is both "confirm" and "jump"; it raises both flags and lets the
      // scene decide which one this moment calls for.
      if (k === ' ' || k === 'Enter') {
        this.anyPressed = true;
        if (k === ' ') this.jumpPressed = true;
        e.preventDefault();
      } else if (k === 'ArrowUp') {
        this.anyPressed = true;
        this.jumpPressed = true;
        e.preventDefault();
      } else if (k === 'Escape' || k === 'p' || k === 'P') {
        this.pausePressed = true;
        e.preventDefault();
      }
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    el.addEventListener('pointerdown', onPointerDown, { passive: false });
    el.addEventListener('pointermove', onPointerMove, { passive: true });
    el.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('pointercancel', onPointerCancel, { passive: true });
    el.addEventListener('pointerleave', onPointerLeave, { passive: true });
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);

    this.detachers.push(() => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    });
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.taps.length = 0;
    this.keysPressed.length = 0;
    this.anyPressed = false;
    this.pausePressed = false;
    this.jumpPressed = false;
  }

  destroy(): void {
    for (const d of this.detachers) d();
    this.detachers.length = 0;
    this.starts.clear();
    this.pointers.clear();
  }
}
