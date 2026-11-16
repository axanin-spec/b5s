/**
 * boot.ts — bootstrap for «Космический Рейнджер».
 * Contract with the React shell (src/pages/Home.tsx):
 *   startGame(canvas)  mounts renderer + loop onto an existing <canvas>
 *   stopGame()         tears everything down (loop, renderer, listeners, probe)
 * Calling startGame twice is safe: the previous session is stopped first.
 */

import { Game } from "./game";

declare global {
  interface Window {
    /** Player-coordinate probe — scripts/verify-game.mjs asserts direction mapping through it. */
    __gameProbe?: () => { x: number; y: number; z: number };
    /** Readiness signal — the self-check waits for it before screenshotting/asserting. */
    __GAME_READY__?: boolean;
  }
}

let session: Game | null = null;

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();
  session = new Game(canvas);
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
