/**
 * input.ts — keyboard/mouse + touch input. **Control-mapping conventions are fixed** (the most
 * frequent playtest defect is a reversed direction mapping):
 *
 *   W / ArrowUp    = thrust up-screen (moveZ = +1)
 *   S / ArrowDown  = thrust down-screen (moveZ = -1)
 *   A / ArrowLeft  = thrust left (moveX = -1)
 *   D / ArrowRight = thrust right (moveX = +1)
 *
 *   Mouse position = aim point (world-space conversion happens in game.ts)
 *   LMB / Space    = fire (held); E = dock; Esc = pause
 *   Touch left half  = thrust stick (same directions as WASD)
 *   Touch fire button = DOM button driving `touchFiring`
 *
 * When changing these conventions you must also update the direction assertions in scripts/verify-game.mjs.
 */

import { INPUT_CONFIG } from "./config";

const KEYMAP: Record<string, [axis: "moveX" | "moveZ", dir: 1 | -1]> = {
  KeyW: ["moveZ", 1], ArrowUp: ["moveZ", 1],
  KeyS: ["moveZ", -1], ArrowDown: ["moveZ", -1],
  KeyA: ["moveX", -1], ArrowLeft: ["moveX", -1],
  KeyD: ["moveX", 1], ArrowRight: ["moveX", 1],
};

/** Keys whose browser default (scroll etc.) must never fire while playing. */
const SWALLOWED = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"]);

export class Input {
  /** Normalized movement axes: moveX ∈ [-1,1] (left negative, right positive), moveZ ∈ [-1,1] (down negative, up positive). */
  moveX = 0;
  moveZ = 0;
  /** Camera delta for this frame (radians). Multiply by sensitivity and INVERT config when applying. */
  yawDelta = 0;
  pitchDelta = 0;
  /** Instantaneous actions (true on the frame the key is pressed; auto-cleared once consumed). */
  readonly actions = new Set<string>();
  /** Cursor position in CSS pixels (always tracked, even with no buttons pressed). */
  mouseX = 0;
  mouseY = 0;
  /** Fire sources — `firing` is their OR. */
  mouseDown = false;
  spaceHeld = false;
  touchFiring = false;
  private held = new Set<string>();
  private touchMoveId: number | null = null;
  private touchMoveOrigin = { x: 0, y: 0 };
  /** One shot banked from a click whose mousedown was swallowed (focus activation). */
  private pendingTap = false;

  /** Listener teardown — collected at construction so dispose() can unwind every subscription. */
  private unsubscribe: Array<() => void> = [];

  constructor(private target: HTMLElement = document.body) {
    const on = <T extends Event>(
      el: Window | Document | HTMLElement,
      type: string,
      fn: (e: T) => void,
      opts?: AddEventListenerOptions,
    ) => {
      const handler = fn as EventListener;
      el.addEventListener(type, handler, opts);
      this.unsubscribe.push(() => el.removeEventListener(type, handler, opts));
    };

    on<KeyboardEvent>(window, "keydown", (e) => {
      if (SWALLOWED.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      const m = KEYMAP[e.code];
      if (m) this.held.add(e.code);
      if (e.code === "Space") this.spaceHeld = true;
      this.actions.add(e.code); // e.g. "KeyE" / "Escape" / "Space" are consumed directly by code
      this.recomputeAxes();
    });
    on<KeyboardEvent>(window, "keyup", (e) => {
      this.held.delete(e.code);
      if (e.code === "Space") this.spaceHeld = false;
      this.recomputeAxes();
    });
    // Focus loss must release everything: a keyup that happens while unfocused never arrives,
    // otherwise the ship keeps thrusting by itself after Alt-Tab.
    on(window, "blur", () => this.resetAll());
    on(document, "visibilitychange", () => { if (document.hidden) this.resetAll(); });
    on<MouseEvent>(window, "mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (document.pointerLockElement || e.buttons > 0) {
        const sx = INPUT_CONFIG.MOUSE_SENS_X * (INPUT_CONFIG.INVERT_X ? -1 : 1);
        const sy = INPUT_CONFIG.MOUSE_SENS_Y * (INPUT_CONFIG.INVERT_Y ? -1 : 1);
        this.yawDelta -= e.movementX * sx;
        this.pitchDelta += -e.movementY * sy;
      }
    });
    // Fire only when the press starts on the canvas itself — UI buttons above the canvas
    // must not trigger weapons. Pointer capture binds the release to the canvas even when
    // the cursor escapes the window: without it mouseup is lost and the guns stick ON.
    on<PointerEvent>(target, "pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      this.mouseDown = true;
      try { target.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    });
    // The cursor came back over the canvas with the button still held — the press began
    // "outside" (another pane, another monitor) or the embed swallowed the activation
    // mousedown; resume firing instead of waiting for a press that already happened.
    on<PointerEvent>(target, "pointerenter", (e) => {
      if (e.pointerType === "mouse" && (e.buttons & 1) !== 0) this.mouseDown = true;
    });
    on<MouseEvent>(window, "mouseup", (e) => {
      if (e.button !== 0) return;
      // Orphan release on the canvas (its mousedown never arrived — e.g. Electron spends
      // the first click after focus loss on window activation): bank it as one shot,
      // otherwise the click that refocuses the game is silently eaten.
      if (!this.mouseDown && !this.spaceHeld && !this.touchFiring && e.target === target) this.pendingTap = true;
      this.mouseDown = false;
    });
    on<MouseEvent>(target, "contextmenu", (e) => e.preventDefault());
    on<TouchEvent>(target, "touchstart", (e) => this.onTouch(e, true), { passive: true });
    on<TouchEvent>(target, "touchmove", (e) => this.onTouch(e, false), { passive: true });
    on<TouchEvent>(target, "touchend", (e) => this.onTouchEnd(e), { passive: true });
    on<TouchEvent>(target, "touchcancel", (e) => this.onTouchEnd(e), { passive: true });
  }

  get firing(): boolean {
    return this.mouseDown || this.spaceHeld || this.touchFiring;
  }

  /** DOM fire button (touch UI) drives this. */
  setTouchFiring(v: boolean): void {
    this.touchFiring = v;
  }

  /** Detach every listener and zero the axes — call it when the game is unmounted (see src/game/boot.ts). */
  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.actions.clear();
    this.resetAll();
  }

  private onTouch(e: TouchEvent, start: boolean): void {
    const w = window.innerWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (start) {
        // left half of the screen = thrust stick; right half stays free for DOM buttons
        if (t.clientX < w / 2 && this.touchMoveId === null) {
          this.touchMoveId = t.identifier;
          this.touchMoveOrigin = { x: t.clientX, y: t.clientY };
        }
      } else if (t.identifier === this.touchMoveId) {
        // left stick: push up = up-screen (+moveZ), push right = right (+moveX), exactly matching WASD
        this.moveX = clamp((t.clientX - this.touchMoveOrigin.x) / 60, -1, 1);
        this.moveZ = clamp(-(t.clientY - this.touchMoveOrigin.y) / 60, -1, 1);
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    // Each lifted finger releases only its own stick.
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.touchMoveId) {
        this.touchMoveId = null;
        this.recomputeAxes(); // fall back to whatever the keyboard still holds (usually nothing)
      }
    }
  }

  private resetAll(): void {
    this.held.clear();
    this.touchMoveId = null;
    this.yawDelta = 0;
    this.pitchDelta = 0;
    this.mouseDown = false;
    this.spaceHeld = false;
    this.pendingTap = false;
    this.recomputeAxes();
  }

  private recomputeAxes(): void {
    let x = 0, z = 0;
    for (const code of this.held) {
      const m = KEYMAP[code];
      if (m) {
        if (m[0] === "moveX") x += m[1]; else z += m[1];
      }
    }
    this.moveX = clamp(x, -1, 1);
    this.moveZ = clamp(z, -1, 1);
  }

  /** Consume the camera delta before each frame render (take and zero it). */
  consumeLook(): { yaw: number; pitch: number } {
    const r = { yaw: this.yawDelta, pitch: this.pitchDelta };
    this.yawDelta = 0;
    this.pitchDelta = 0;
    return r;
  }

  /** Take the banked single shot from a swallowed-activation click (true at most once per click). */
  consumeTap(): boolean {
    const t = this.pendingTap;
    this.pendingTap = false;
    return t;
  }

  /** Consume an instantaneous action: was this key pressed during the current frame. */
  consumeAction(code: string): boolean {
    const has = this.actions.has(code);
    if (has) this.actions.delete(code);
    return has;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
