/**
 * bridge.ts — мост игрового состояния в общий шард (Этап 15b).
 * Не трогает game.ts: позиция/система читаются через публичный uiBridge
 * (gameApi.getPlayerHeading + hud.systemName) и уходят в worldNet 10 раз/с.
 */

import { gameApi, uiBridge } from "@/game/uiBridge";
import { worldNet } from "./world";

const POLL_MS = 100;

let timer: ReturnType<typeof setInterval> | null = null;

export function startNetBridge(): void {
  stopNetBridge();
  timer = setInterval(() => {
    if (worldNet.status !== "online") return;
    const snap = uiBridge.getSnapshot();
    if (snap.screen !== "playing" && snap.screen !== "paused" && snap.screen !== "docked") return;
    const pos = gameApi.current?.getPlayerHeading();
    if (!pos) return;
    const sys = snap.hud?.systemName;
    worldNet.setState({ x: pos.x, y: pos.y, a: pos.a, ...(sys ? { sys } : {}) });
  }, POLL_MS);
}

export function stopNetBridge(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
