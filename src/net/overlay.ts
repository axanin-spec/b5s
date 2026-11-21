/**
 * overlay.ts — оверлей общего шарда (Этап 15b): чужие корабли и позывные
 * поверх игрового канваса, БЕЗ правок game.ts. Камера воспроизводит формулу
 * игры (центр = игрок, ppu из onResize), поэтому метки совпадают с миром.
 *
 * Чужой корабль рисуется шевроном цвета, производного от позывного; под ним —
 * сам позывной. Видны только игроки той же системы (state.sys === hud.systemName).
 */

import { gameApi, uiBridge } from "@/game/uiBridge";
import { worldNet } from "./world";

/** Та же формула, что в Game.onResize — иначе метки поплывут относительно мира. */
function ppuFor(w: number, h: number): number {
  return Math.max(0.42, Math.min(1.05, Math.min(w / 1500, h / 950) + 0.32));
}

/** Детерминированный цвет позывного. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function startNetOverlay(root: HTMLElement): () => void {
  const canvas = document.createElement("canvas");
  canvas.id = "net-overlay";
  // стили инлайном: index.css принадлежит треку Б, не трогаем его
  canvas.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  // между игровым канвасом и DOM-интерфейсом: метки под кнопками HUD
  const ui = root.querySelector("#ui-overlay");
  root.insertBefore(canvas, ui);
  const ctx = canvas.getContext("2d")!;
  let raf = 0;

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const snap = uiBridge.getSnapshot();
    if (snap.screen !== "playing" && snap.screen !== "paused") return;
    const me = gameApi.current?.getPlayerHeading();
    if (!me || worldNet.players.size === 0) return;
    const sys = snap.hud?.systemName;
    const ppu = ppuFor(w, h);

    for (const p of worldNet.players.values()) {
      if (p.dead) continue; // 15c: погибших не рисуем до респауна
      const st = p.state;
      if (!st) continue;
      if (sys && st.sys && st.sys !== sys) continue;
      const sx = w / 2 + (st.x - me.x) * ppu;
      const sy = h / 2 + (me.y - st.y) * ppu;
      if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;

      const hue = hueFor(p.username);
      const color = `hsl(${hue} 90% 65%)`;
      const r = 14 * ppu;

      // шеврон курса: мир y-up → экран y-down, угол зеркалится
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-st.a);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.7, r * 0.6);
      ctx.lineTo(-r * 0.35, 0);
      ctx.lineTo(-r * 0.7, -r * 0.6);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(4, 8, 14, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // позывной
      ctx.font = `${Math.max(11, 13 * ppu)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(4, 8, 14, 0.75)";
      ctx.fillText(p.username, sx + 1, sy + r + 15 + 1);
      ctx.fillStyle = color;
      ctx.fillText(p.username, sx, sy + r + 15);
    }
  };
  raf = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}
