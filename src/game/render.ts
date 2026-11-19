/**
 * render.ts — Этап 9a (спил 4/4): вся отрисовка кадра, вынесенная из монолита Game.
 * renderFrame рисует мир на канвасе по структурному контексту RenderCtx; Game
 * передаёт себя и держит одну обёртку. Логики мира здесь нет — только камера,
 * параллакс, тела, корабли, эффекты, HUD-слои в мировом пространстве.
 */

import { GATE_CFG, QUALITY, RAID, WORLD_CFG } from "./config";
import type { Bolt, Dockable, Pickup, Ship } from "./types";
import type { ParallaxLayer } from "./game";
import { perf } from "./perf";
import { makeGlowTexture } from "./textures";

/** Fixed palette so the hot loop never builds color strings. */
const PALETTE = [
  "#ffffff", "#ffe9a8", "#ffd24a", "#ff9c54", "#ff5a4a", "#ff54d2",
  "#54ffd2", "#7fd0ff", "#5a9fff", "#d26aff", "#8fd08f", "#c96a4a",
] as const;
const PALETTE_TEX: HTMLCanvasElement[] = [];

export function paletteTex(): HTMLCanvasElement[] {
  if (PALETTE_TEX.length) return PALETTE_TEX;
  for (const hex of PALETTE) {
    const rgb = `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
    PALETTE_TEX.push(makeGlowTexture(rgb));
  }
  return PALETTE_TEX;
}

/** Масштаб спрайтов кораблей к их радиусу столкновений. */
const SHIP_SCALE = 2.4;

interface RingFx { life: number; maxLife: number; x: number; y: number; r: number; vr: number; hot: boolean }
interface Floater { x: number; y: number; t: number; ttl: number; text: string; c: string; big: boolean }

/** Структурный хозяин кадра: камера, текстуры, пулы сущностей, флаги качества. */
export interface RenderCtx {
  ctx: CanvasRenderingContext2D;
  sm: { state: string };
  ships: Ship[];
  rnd(): number;
  isPirate(): boolean;
  setQuality(q: number): void;
  ppu: number;
  camX: number; camY: number;
  camSx: number; camSy: number;
  shake: number;
  titleOrbitT: number;
  layers: ParallaxLayer[];
  quality: number;
  fpsAccum: number;
  fpsWindowStart: number;
  lowParticles: boolean;
  badWindows: number;
  goodWindows: number;
  bgGradient: CanvasGradient | null;
  dockables: Dockable[];
  dockSpin: number[];
  dockSpinVel: number[];
  dockTex: HTMLCanvasElement[];
  dockTarget: Dockable | null;
  grabTarget: string | null;
  grabT: number;
  raid: { timeLeft: number } | null;
  gates: { to: string; name: string; x: number; y: number }[];
  gateSpin: number;
  gateTex: HTMLCanvasElement;
  gateHorizonTex: HTMLCanvasElement | HTMLImageElement;
  jumpGate: { to: string; name: string; x: number; y: number } | null;
  pickups: Pickup[];
  pickupTex: { cargo: HTMLCanvasElement; credits: HTMLCanvasElement };
  shipTexMap: Record<string, HTMLCanvasElement[]>;
  bolts: Bolt[];
  boltTexPlayer: HTMLCanvasElement;
  boltTexEnemy: HTMLCanvasElement;
  particles: { life: number; maxLife: number; x: number; y: number; size: number; ci: number }[];
  rings: RingFx[];
  waypoint: { x: number; y: number; label: string; targetId: string } | null;
  input: { touchFiring: boolean; mouseX: number; mouseY: number };
  floaters: Floater[];
  warpFx: number;
  starTex: HTMLCanvasElement;
  splashRemoved: boolean;
}

const sx = (c: RenderCtx, wx: number): number => (wx - c.camSx) * c.ppu + window.innerWidth / 2;
const sy = (c: RenderCtx, wy: number): number => (c.camSy - wy) * c.ppu + window.innerHeight / 2;

export function renderFrame(c: RenderCtx): void {
  // auto quality: sustained low fps → cheaper particles, then supersample, then layers.
  // hysteresis: 2 bad windows (4s) to step down, 8 good (16s) to step back up
  c.fpsAccum += 1;
  const now = performance.now();
  if (now - c.fpsWindowStart > 2000) {
    const fps = (c.fpsAccum * 1000) / Math.max(1, now - c.fpsWindowStart);
    c.lowParticles = fps < QUALITY.DEGRADE_FPS || c.quality >= 1;
    if (fps < QUALITY.DEGRADE_FPS) { c.badWindows++; c.goodWindows = 0; }
    else if (fps >= QUALITY.RECOVER_FPS) { c.goodWindows++; c.badWindows = 0; }
    else { c.badWindows = 0; c.goodWindows = 0; }
    if (c.badWindows >= 2 && c.quality < 2) {
      const want = fps < QUALITY.HEAVY_FPS ? 2 : 1;
      if (want > c.quality) c.setQuality(want);
      c.badWindows = 0;
    } else if (c.goodWindows >= 8 && c.quality > 0) {
      c.setQuality(c.quality - 1);
      c.goodWindows = 0;
    }
    c.fpsAccum = 0;
    c.fpsWindowStart = now;
  }

  const st = c.sm.state;
  const p = c.ships[0];
  const ctx = c.ctx;
  const W = window.innerWidth, H = window.innerHeight;

  // camera target
  if (st === "title") {
    c.titleOrbitT += 0.0027;
    const r = 4600;
    c.camX += (Math.cos(c.titleOrbitT) * r - c.camX) * 0.01;
    c.camY += (Math.sin(c.titleOrbitT) * r - c.camY) * 0.01;
  } else if (p.active) {
    const lookX = p.x + p.vx * 0.32;
    const lookY = p.y + p.vy * 0.32;
    c.camX += (lookX - c.camX) * 0.09;
    c.camY += (lookY - c.camY) * 0.09;
  }

  // shake
  let shX = 0, shY = 0;
  if (c.shake > 0.2) {
    shX = (c.rnd() - 0.5) * c.shake;
    shY = (c.rnd() - 0.5) * c.shake;
    c.shake *= 0.88;
  }
  c.camSx = c.camX + shX;
  c.camSy = c.camY + shY;

  // clear: subtle deep-space gradient instead of a flat fill
  const bg = c.bgGradient || (c.bgGradient = (() => {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 1.6);
    g.addColorStop(0, "#070c18");
    g.addColorStop(1, "#02040a");
    return g;
  })());
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  perf.begin();

  /* parallax layers: effective world pos = s - cam * f;
     tier 2 drops the nebula (f .3) and near-dust (f .7) layers — the two biggest blits */
  for (const layer of c.layers) {
    if (c.quality >= 2 && layer.f >= 0.3) continue;
    const ox = c.camSx * layer.f, oy = c.camSy * layer.f;
    for (const star of layer.stars) {
      const x = (star.x - ox) * c.ppu + W / 2;
      const y = H / 2 - (star.y - oy) * c.ppu;
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
      ctx.fillStyle = star.c;
      const r = star.r;
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    for (const neb of layer.nebulas) {
      const size = neb.scale * c.ppu;
      const x = (neb.x - ox) * c.ppu + W / 2;
      const y = H / 2 - (neb.y - oy) * c.ppu;
      if (x + size / 2 < 0 || x - size / 2 > W || y + size / 2 < 0 || y - size / 2 > H) continue;
      if (neb.additive) {
        // painted-on-black art: 'lighter' makes its darks vanish into the starfield
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.3;
        ctx.drawImage(neb.tex, x - size / 2, y - size / 2, size, size);
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.globalAlpha = 0.95;
        ctx.drawImage(neb.tex, x - size / 2, y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    }
  }

  perf.mark("parallax");

  /* orbit rings */
  ctx.lineWidth = 1;
  for (const d of c.dockables) {
    const r = d.orbit * c.ppu;
    const cx = sx(c, 0), cy = sy(c, 0);
    if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H) continue;
    ctx.strokeStyle = d.isStation ? "rgba(46,95,143,0.16)" : "rgba(42,74,102,0.24)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // star heat ring
  {
    const r = WORLD_CFG.STAR_HEAT_RADIUS * c.ppu;
    const cx = sx(c, 0), cy = sy(c, 0);
    ctx.strokeStyle = "rgba(255,84,51,0.3)";
    ctx.setLineDash([14, 10]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* the star */
  {
    const size = WORLD_CFG.STAR_RADIUS * 5.2 * c.ppu;
    const x = sx(c, 0), y = sy(c, 0);
    ctx.drawImage(c.starTex, x - size / 2, y - size / 2, size, size);
  }

  /* planets + stations */
  for (let i = 0; i < c.dockables.length; i++) {
    const d = c.dockables[i];
    const scale = (d.isStation ? d.radius * 2.6 : d.radius * 2.1) * c.ppu;
    const x = sx(c, d.x), y = sy(c, d.y);
    if (x + scale / 2 < 0 || x - scale / 2 > W || y + scale / 2 < 0 || y - scale / 2 > H) continue;
    c.dockSpin[i] += c.dockSpinVel[i];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(c.dockSpin[i]);
    ctx.drawImage(c.dockTex[i], -scale / 2, -scale / 2, scale, scale);
    ctx.restore();
    // docking range hint for the current target
    if (c.dockTarget === d && st === "playing") {
      ctx.strokeStyle = "rgba(84,255,210,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, scale / 2 + 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    // raid heist: an orange arc closing over the storehouse being emptied (5d)
    if (c.grabTarget === d.id && c.raid && c.raid.timeLeft > 0) {
      const frac = Math.max(0, Math.min(1, c.grabT / RAID.GRAB_TIME));
      ctx.strokeStyle = "#ff9a3a";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, scale / 2 + 16, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
    }
  }

  /* hyperspace gates — additive event horizon behind slowly counter-rotating arcs */
  c.gateSpin += 0.006;
  const gPulse = 1 + 0.055 * Math.sin(c.gateSpin * 2.2);
  for (const g of c.gates) {
    const scale = GATE_CFG.RADIUS * 2.4 * c.ppu;
    const x = sx(c, g.x), y = sy(c, g.y);
    if (x + scale < 0 || x - scale > W || y + scale < 0 || y - scale > H) continue;
    ctx.save();
    ctx.translate(x, y);
    // horizon: the vortex art is painted on black, so "lighter" drops the backdrop and keeps the glow
    const hs = scale * 0.56 * gPulse;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.9 * (0.92 + 0.08 * gPulse);
    ctx.rotate(-c.gateSpin * 0.45);
    ctx.drawImage(c.gateHorizonTex, -hs / 2, -hs / 2, hs, hs);
    ctx.restore();
    ctx.rotate(c.gateSpin);
    ctx.drawImage(c.gateTex, -scale / 2, -scale / 2, scale, scale);
    ctx.restore();
    ctx.font = `${Math.max(11, Math.round(14 * c.ppu))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(215,232,238,0.85)";
    ctx.fillText(`⇄ ${g.name}`, x, y + scale / 2 + 20 * c.ppu);
    if (c.jumpGate === g && st === "playing") {
      ctx.strokeStyle = "rgba(84,255,210,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, scale / 2 + 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  perf.mark("bodies");

  /* pickups */
  const t = now * 0.001;
  for (const pk of c.pickups) {
    if (!pk.active) continue;
    const size = 46 * c.ppu;
    const x = sx(c, pk.x), y = sy(c, pk.y) + Math.sin(t * 2 + pk.amount) * 6 * c.ppu;
    if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(t * 1.4 + pk.amount) * 0.3);
    ctx.drawImage(pk.kind === "credits" ? c.pickupTex.credits : c.pickupTex.cargo, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  /* ships */
  for (let i = 0; i < c.ships.length; i++) {
    const s = c.ships[i];
    if (!s.active) continue;
    const scale = s.radius * SHIP_SCALE * c.ppu;
    const x = sx(c, s.x), y = sy(c, s.y);
    if (x + scale / 2 < 0 || x - scale / 2 > W || y + scale / 2 < 0 || y - scale / 2 > H) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 2 - s.angle); // texture points up; world angle θ → canvas rotation π/2 − θ
    const texs = s.cruiser ? c.shipTexMap.cruiser : c.shipTexMap[s.faction];
    ctx.drawImage(texs[texs.length > 1 ? i & 1 : 0], -scale / 2, -scale / 2, scale, scale);
    ctx.restore();
    // shield ring flash after recent hits
    if (s.shield > 0 && s.sinceHit < 0.35) {
      ctx.strokeStyle = `rgba(111,195,255,${0.7 - s.sinceHit * 2})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, s.radius * c.ppu + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // pirate status (5f): dashed kin rings — blue around the raiders, hostile red around patrol
    if (i !== 0 && c.isPirate() && (s.faction === "pirate" || s.faction === "patrol")) {
      ctx.strokeStyle = s.faction === "pirate" ? "rgba(90,159,255,0.45)" : "rgba(255,90,74,0.45)";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 7]);
      ctx.beginPath();
      ctx.arc(x, y, s.radius * c.ppu + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* bolts */
  for (const b of c.bolts) {
    if (!b.active) continue;
    const size = (b.friendly ? 15 : 12) * Math.max(c.ppu, 0.6);
    const x = sx(c, b.x), y = sy(c, b.y);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    ctx.drawImage(b.friendly ? c.boltTexPlayer : c.boltTexEnemy, x - size / 2, y - size / 2, size, size);
  }

  perf.mark("entities");

  /* particles */
  ctx.globalCompositeOperation = "lighter";
  const pal = paletteTex();
  for (const d of c.particles) {
    if (d.life <= 0) continue;
    const x = sx(c, d.x), y = sy(c, d.y);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const k = d.life / d.maxLife;
    ctx.globalAlpha = k;
    const size = d.size * (0.5 + k) * Math.max(c.ppu, 0.55);
    ctx.drawImage(pal[d.ci], x - size / 2, y - size / 2, size, size);
  }
  // blast shockwave rings
  for (const rg of c.rings) {
    if (rg.life <= 0) continue;
    const x = sx(c, rg.x), y = sy(c, rg.y);
    const rr = rg.r * c.ppu;
    if (x + rr < 0 || x - rr > W || y + rr < 0 || y - rr > H) continue;
    const k = Math.max(0, rg.life / rg.maxLife);
    ctx.globalAlpha = Math.min(1, k * 1.3) * 0.85;
    ctx.strokeStyle = rg.hot ? "rgb(255,190,120)" : "rgb(255,235,190)";
    ctx.lineWidth = Math.max(1, (rg.hot ? 9 : 5) * k);
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
    if (rg.hot) {
      ctx.globalAlpha *= 0.5;
      ctx.strokeStyle = "rgb(255,255,255)";
      ctx.lineWidth = Math.max(1, 4 * k);
      ctx.beginPath(); ctx.arc(x, y, rr * 0.72, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  perf.mark("fx");

  /* plotted course: diamond over the target, or a compass arrow pinned to the screen edge */
  if (c.waypoint && st === "playing") {
    const wx = sx(c, c.waypoint.x), wy = sy(c, c.waypoint.y);
    const margin = 46;
    const onScreen = wx > margin && wx < W - margin && wy > margin && wy < H - margin;
    ctx.save();
    ctx.strokeStyle = "#54ffd2";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(84,255,210,0.8)";
    ctx.shadowBlur = 8;
    if (onScreen) {
      ctx.translate(wx, wy);
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-9, -9, 18, 18);
    } else {
      const ps = c.ships[0];
      const px = sx(c, ps.x), py = sy(c, ps.y);
      const a = Math.atan2(wy - py, wx - px);
      const dx = Math.cos(a), dy = Math.sin(a);
      let tt = 4000;
      if (dx > 1e-6) tt = Math.min(tt, (W - margin - px) / dx); else if (dx < -1e-6) tt = Math.min(tt, (margin - px) / dx);
      if (dy > 1e-6) tt = Math.min(tt, (H - margin - py) / dy); else if (dy < -1e-6) tt = Math.min(tt, (margin - py) / dy);
      const ax = px + dx * tt, ay = py + dy * tt;
      ctx.translate(ax, ay);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(13, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath();
      ctx.stroke();
      const dist = Math.hypot(c.waypoint.x - ps.x, c.waypoint.y - ps.y);
      ctx.rotate(-a);
      ctx.shadowBlur = 0;
      ctx.font = "11px ui-monospace, Consolas, monospace";
      ctx.fillStyle = "#54ffd2";
      ctx.textAlign = "center";
      ctx.fillText(`${(dist / 1000).toFixed(1)}k`, 0, 26);
    }
    ctx.restore();
  }

  /* aim reticle (desktop) */
  if (st === "playing" && !c.input.touchFiring) {
    const mx = c.input.mouseX, my = c.input.mouseY;
    ctx.strokeStyle = "rgba(84,255,210,0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mx, my, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx - 17, my); ctx.lineTo(mx - 6, my);
    ctx.moveTo(mx + 6, my); ctx.lineTo(mx + 17, my);
    ctx.moveTo(mx, my - 17); ctx.lineTo(mx, my - 6);
    ctx.moveTo(mx, my + 6); ctx.lineTo(mx, my + 17);
    ctx.stroke();
  }

  /* floating credit popups (game feel): rise and fade in screen space */
  if (c.floaters.length && st === "playing") {
    ctx.save();
    ctx.textAlign = "center";
    for (const f of c.floaters) {
      const k = f.t / f.ttl;
      ctx.globalAlpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
      ctx.font = `${f.big ? 800 : 700} ${Math.round((f.big ? 17 : 13) * c.ppu)}px ui-monospace, Consolas, monospace`;
      const fx = sx(c, f.x), fy = sy(c, f.y) - k * 46 * c.ppu;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(2,6,14,0.9)";
      ctx.strokeText(f.text, fx, fy);
      ctx.fillStyle = f.c;
      ctx.fillText(f.text, fx, fy);
    }
    ctx.restore();
  }

  /* hyperspace arrival: radial cyan flash + receding speed streaks */
  if (c.warpFx > 0) {
    const k = c.warpFx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rg = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.hypot(W, H) / 2);
    rg.addColorStop(0, `rgba(180,255,240,${0.65 * k})`);
    rg.addColorStop(1, "rgba(60,200,255,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = `rgba(200,255,250,${k * 0.55})`;
    ctx.lineWidth = 2;
    const r0 = 60 + (1 - k) * Math.hypot(W, H) * 0.5;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.3;
      const r1 = r0 + 140 + 260 * (1 - k);
      ctx.beginPath();
      ctx.moveTo(W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0);
      ctx.lineTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }

  perf.end();
  window.__GAME_READY__ = true;
  if (!c.splashRemoved) {
    c.splashRemoved = true;
    document.getElementById("boot-splash")?.remove();
  }
}
