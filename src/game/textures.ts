/**
 * textures.ts — every texture is generated procedurally on an offscreen canvas at boot.
 * No external assets: ships/planets/stations are parametric drawings; cache once, reuse.
 * v2 painterly pass: gradient hulls, panel greebles, rim light, faction details,
 * upgrade-reactive player hull, five distinct station silhouettes per economy kind.
 */

import type { StationKind } from "./types";

/** Deterministic PRNG (mulberry32) — bare Math.random() is banned for world/texture generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

/** The 2D canvas renderer consumes raw canvases directly. */
function toTexture(c: HTMLCanvasElement): HTMLCanvasElement {
  return c;
}

/* ------------------------------------------------------------------ */
/* Color helpers (hex only)                                            */
/* ------------------------------------------------------------------ */

/** Mix a #rrggbb toward white (t>0) or black (t<0); t ∈ [-1,1]. */
function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Soft additive glow disc at (x,y) — reused for lamps, domes, exhaust. */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a = 1): void {
  const g = ctx.createRadialGradient(x, y, 0.5, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = a;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* Ships — drawn pointing UP (+y screen); rotation happens on the sprite */
/* ------------------------------------------------------------------ */

export type ShipStyle = "player" | "pirate" | "patrol" | "trader" | "boss" | "cruiser";

/**
 * Player fit (Этап 7) driving the hull art: `hull` = index in HULLS (selects the
 * silhouette via `variant`), `weapon` = mounted gun count, `weaponRank`/`shield`/
 * `engine` = best installed rank index (0..5) for emitters, plates and nozzles.
 */
export interface ShipUpgrades { hull: number; weapon: number; weaponRank: number; shield: number; engine: number }

const SHIP_COLORS: Record<ShipStyle, { hull: string; trim: string; glow: string; cockpit: string }> = {
  player: { hull: "#9fe8d0", trim: "#2e8f74", glow: "#54ffd2", cockpit: "#eafff8" },
  pirate: { hull: "#e06a5a", trim: "#7e2a20", glow: "#ff9c54", cockpit: "#ffd9c9" },
  patrol: { hull: "#7fb4ff", trim: "#2b4f8f", glow: "#7fd0ff", cockpit: "#eaf4ff" },
  trader: { hull: "#e8c96a", trim: "#8f742e", glow: "#ffe29b", cockpit: "#fff6d9" },
  boss:   { hull: "#b46ae8", trim: "#5a2e8f", glow: "#ff54d2", cockpit: "#f6d9ff" },
  cruiser: { hull: "#a8c8f0", trim: "#3a5a9f", glow: "#9fd8ff", cockpit: "#f0f8ff" },
};

const STYLE_SEED: Record<ShipStyle, number> = { player: 11, pirate: 23, patrol: 37, trader: 53, boss: 71, cruiser: 97 };

/** Class silhouettes in a 128-unit space, nose at −y; for "player" the variant is the HULLS index. */
function shipBody(style: ShipStyle, variant = 0): Path2D {
  if (style === "player") return playerBody(variant);
  if (style === "cruiser") return playerBody(3); // «Варта» — силуэт линкора в цветах патруля
  const body = new Path2D();
  if (style === "trader") {
    // bulky hauler: wide cargo body, blunt nose
    body.moveTo(0, -46); body.lineTo(16, -30); body.lineTo(30, 6); body.lineTo(26, 40);
    body.lineTo(-26, 40); body.lineTo(-30, 6); body.lineTo(-16, -30); body.closePath();
  } else if (style === "patrol") {
    // wide interceptor: broad wings
    body.moveTo(0, -50); body.lineTo(12, -22); body.lineTo(52, 18); body.lineTo(40, 30);
    body.lineTo(14, 22); body.lineTo(10, 42); body.lineTo(-10, 42); body.lineTo(-14, 22);
    body.lineTo(-40, 30); body.lineTo(-52, 18); body.lineTo(-12, -22); body.closePath();
  } else if (style === "pirate") {
    // jagged raider
    body.moveTo(0, -52); body.lineTo(10, -20); body.lineTo(38, -2); body.lineTo(30, 12);
    body.lineTo(44, 30); body.lineTo(16, 26); body.lineTo(8, 44); body.lineTo(-8, 44);
    body.lineTo(-16, 26); body.lineTo(-44, 30); body.lineTo(-30, 12); body.lineTo(-38, -2);
    body.lineTo(-10, -20); body.closePath();
  } else {
    // boss: massive flagship, layered hull plates
    body.moveTo(0, -58); body.lineTo(22, -34); body.lineTo(52, -8); body.lineTo(46, 22);
    body.lineTo(26, 30); body.lineTo(20, 50); body.lineTo(-20, 50); body.lineTo(-26, 30);
    body.lineTo(-46, 22); body.lineTo(-52, -8); body.lineTo(-22, -34); body.closePath();
  }
  return body;
}

/** Player hull line (Этап 7): 0 истребитель · 1 корвет · 2 фрегат · 3 линкор. */
function playerBody(hull: number): Path2D {
  const b = new Path2D();
  if (hull === 3) {
    // battleship: broad layered sponsons, flat command deck
    b.moveTo(0, -56); b.lineTo(18, -36); b.lineTo(34, -30); b.lineTo(54, -4); b.lineTo(50, 16);
    b.lineTo(34, 20); b.lineTo(30, 44); b.lineTo(12, 40); b.lineTo(8, 52); b.lineTo(-8, 52);
    b.lineTo(-12, 40); b.lineTo(-30, 44); b.lineTo(-34, 20); b.lineTo(-50, 16); b.lineTo(-54, -4);
    b.lineTo(-34, -30); b.lineTo(-18, -36); b.closePath();
  } else if (hull === 2) {
    // frigate: long slab with heavy shoulders
    b.moveTo(0, -54); b.lineTo(14, -30); b.lineTo(30, -26); b.lineTo(46, 2); b.lineTo(40, 34);
    b.lineTo(18, 28); b.lineTo(14, 46); b.lineTo(-14, 46); b.lineTo(-18, 28); b.lineTo(-40, 34);
    b.lineTo(-46, 2); b.lineTo(-30, -26); b.lineTo(-14, -30); b.closePath();
  } else if (hull === 1) {
    // corvette: stubby wings, twin nacelle roots
    b.moveTo(0, -50); b.lineTo(16, -24); b.lineTo(44, 8); b.lineTo(38, 20); b.lineTo(20, 16);
    b.lineTo(16, 42); b.lineTo(-16, 42); b.lineTo(-20, 16); b.lineTo(-38, 20); b.lineTo(-44, 8);
    b.lineTo(-16, -24); b.closePath();
  } else {
    // fighter ranger: sleek arrow
    b.moveTo(0, -52); b.lineTo(14, -18); b.lineTo(42, 22); b.lineTo(26, 30);
    b.lineTo(12, 24); b.lineTo(9, 44); b.lineTo(-9, 44); b.lineTo(-12, 24);
    b.lineTo(-26, 30); b.lineTo(-42, 22); b.lineTo(-14, -18); b.closePath();
  }
  return b;
}

export function makeShipTexture(style: ShipStyle, variant = 0, up?: ShipUpgrades): HTMLCanvasElement {
  const s = style === "boss" ? 256 : 128;
  const [c, ctx] = canvas(s, s);
  const col = SHIP_COLORS[style];
  const u = s / 128; // unit scale
  ctx.translate(s / 2, s / 2);
  ctx.scale(u, u);

  const body = shipBody(style, variant);
  const rnd = mulberry32(STYLE_SEED[style] + variant * 977);

  /* engine glow behind the hull (grows with the player's engine upgrade) */
  const engLv = up ? up.engine : 0;
  const glowR = style === "boss" ? 44 : 34 + engLv * 5;
  const eg = ctx.createRadialGradient(0, 40, 2, 0, 40, glowR);
  eg.addColorStop(0, col.glow);
  eg.addColorStop(0.45, hexA(col.glow, 0.4));
  eg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = eg;
  ctx.fillRect(-glowR - 8, 40 - glowR, (glowR + 8) * 2, glowR + 20);

  /* hull: key-light gradient along the top-left → bottom-right axis */
  const hg = ctx.createLinearGradient(-30, -52, 40, 46);
  hg.addColorStop(0, shade(col.hull, 0.35));
  hg.addColorStop(0.5, col.hull);
  hg.addColorStop(1, shade(col.trim, -0.1));
  ctx.fillStyle = hg;
  ctx.fill(body);

  /* panel greebles + side shading, clipped to the hull */
  ctx.save();
  ctx.clip(body);
  ctx.strokeStyle = "rgba(4,8,16,0.4)";
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 7; i++) {
    const y = -44 + rnd() * 88;
    ctx.beginPath();
    ctx.moveTo(-56, y + (rnd() - 0.5) * 18);
    ctx.lineTo(56, y + (rnd() - 0.5) * 18);
    ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const x = -40 + rnd() * 80, y = -44 + rnd() * 84, w = 6 + rnd() * 16, h = 4 + rnd() * 9;
    ctx.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(4,8,16,0.25)";
    ctx.fillRect(x, y, w, h);
  }
  const sh = ctx.createLinearGradient(-52, -30, 52, 30);
  sh.addColorStop(0, "rgba(255,255,255,0.12)");
  sh.addColorStop(0.5, "rgba(0,0,0,0)");
  sh.addColorStop(1, "rgba(0,0,20,0.4)");
  ctx.fillStyle = sh;
  ctx.fillRect(-64, -64, 128, 128);
  // spine
  ctx.strokeStyle = shade(col.trim, -0.15);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(0, -44); ctx.lineTo(0, 34); ctx.stroke();
  ctx.restore();

  /* rim light on the leading edge (clipped half-width stroke) */
  ctx.save();
  ctx.clip(body);
  const rim = ctx.createLinearGradient(0, -58, 0, 22);
  rim.addColorStop(0, "rgba(230,245,255,0.7)");
  rim.addColorStop(1, "rgba(230,245,255,0)");
  ctx.strokeStyle = rim;
  ctx.lineWidth = 4;
  ctx.stroke(body);
  ctx.restore();

  // dark outline reads the silhouette against starfield
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = shade(col.trim, -0.25);
  ctx.stroke(body);

  /* cockpit canopy: dark frame + lit glass */
  ctx.fillStyle = "rgba(6,10,18,0.9)";
  ctx.beginPath(); ctx.ellipse(0, -18, 9, 13, 0, 0, Math.PI * 2); ctx.fill();
  const cg = ctx.createRadialGradient(-3, -22, 1, 0, -16, 12);
  cg.addColorStop(0, "#ffffff");
  cg.addColorStop(0.35, col.cockpit);
  cg.addColorStop(1, "rgba(10,20,40,0.95)");
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.ellipse(0, -18, 7, 10.5, 0, 0, Math.PI * 2); ctx.fill();

  /* faction details */
  if (style === "pirate") {
    // welded patches, rivets, nose teeth
    ctx.fillStyle = "rgba(20,12,10,0.55)";
    ctx.fillRect(-18, 2, 14, 9);
    ctx.fillRect(6, -12, 10, 7);
    ctx.fillStyle = "rgba(255,190,140,0.5)";
    for (let i = 0; i < 6; i++) {
      ctx.beginPath(); ctx.arc(-38 + i * 13, 30 + (i % 2) * 4, 1.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = shade(col.trim, -0.3);
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * 4, -46); ctx.lineTo(sx * 10, -52 - (variant ? 6 : 0)); ctx.lineTo(sx * 12, -42);
      ctx.closePath(); ctx.fill();
    }
    if (variant) {
      // asymmetric salvage fin
      ctx.fillStyle = shade(col.hull, -0.25);
      ctx.beginPath(); ctx.moveTo(30, 10); ctx.lineTo(48, 22); ctx.lineTo(30, 24); ctx.closePath(); ctx.fill();
    }
  } else if (style === "patrol") {
    // lit wing leading edges + tail antenna
    ctx.strokeStyle = col.glow;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    for (const sx of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(sx * 12, -20); ctx.lineTo(sx * 50, 16); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#cfe0f5";
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(0, 46); ctx.stroke();
    ctx.fillStyle = col.glow;
    ctx.beginPath(); ctx.arc(0, 46, 2.4, 0, Math.PI * 2); ctx.fill();
    if (variant) {
      // wingtip radomes
      ctx.fillStyle = "#dfe9f7";
      for (const sx of [-1, 1]) {
        ctx.beginPath(); ctx.arc(sx * 46, 24, 5, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (style === "trader") {
    // stacked cargo containers behind the cockpit + side nacelles
    const tones = ["#b08a4a", "#8f742e", "#c9a86a", "#6b542e"];
    const rows = 2 + (variant ? 1 : 0);
    for (let row = 0; row < rows; row++) {
      for (let k = 0; k < 2; k++) {
        const x = k === 0 ? -24 : 6, y = -4 + row * 14;
        ctx.fillStyle = tones[(row * 2 + k + variant) % tones.length];
        ctx.fillRect(x, y, 18, 12);
        ctx.strokeStyle = "rgba(10,10,14,0.6)";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(x, y, 18, 12);
      }
    }
    ctx.fillStyle = shade(col.trim, -0.2);
    ctx.fillRect(24, 26, 8, 16);
    ctx.fillRect(-32, 26, 8, 16);
  } else if (style === "boss") {
    // nested armour strakes
    ctx.strokeStyle = "rgba(8,4,18,0.55)";
    for (const k of [0.82, 0.62]) {
      ctx.save();
      ctx.scale(k, k);
      ctx.lineWidth = 3 / k;
      ctx.stroke(body);
      ctx.restore();
    }
    // gun pods
    for (const sx of [-1, 1]) {
      ctx.fillStyle = col.trim;
      ctx.beginPath(); ctx.arc(sx * 34, 6, 10, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx * 34, -16, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col.glow;
      ctx.beginPath(); ctx.arc(sx * 34, 6, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    // command tower
    ctx.fillStyle = shade(col.hull, 0.2);
    ctx.fillRect(-6, -2, 12, 22);
    ctx.strokeStyle = "rgba(8,4,18,0.6)";
    ctx.lineWidth = 2;
    ctx.strokeRect(-6, -2, 12, 22);
    // hangar bay glow
    const hb = ctx.createLinearGradient(0, 32, 0, 50);
    hb.addColorStop(0, "rgba(255,90,210,0.8)");
    hb.addColorStop(1, "rgba(255,90,210,0)");
    ctx.fillStyle = hb;
    ctx.fillRect(-16, 32, 32, 18);
  }

  /* player fit mutates with the installed modules — visual progression (Этап 7) */
  if (up) {
    const gold = "#ffd24a";
    const hot = up.weaponRank >= 4; // SS/SSS guns get gold emitters
    if (up.weapon >= 1) {
      // wingtip gun pods (one pair per mounted gun, up to three)
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#20303f";
        ctx.fillRect(sx > 0 ? 34 : -42, 8, 8, 22);
        ctx.fillStyle = hot ? gold : col.glow;
        ctx.fillRect(sx > 0 ? 35.5 : -40.5, 6, 5, 5);
      }
    }
    if (up.weapon >= 2) {
      // second, larger pair on the inner wings
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#20303f";
        ctx.fillRect(sx > 0 ? 20 : -26, -18, 6, 16);
        ctx.fillStyle = hot ? gold : col.glow;
        ctx.fillRect(sx > 0 ? 21 : -25, -20, 4, 4);
      }
    }
    if (up.weapon >= 3) {
      // spine-mounted heavy emitter (battleship third gun)
      ctx.fillStyle = "#20303f";
      ctx.fillRect(-3, 16, 6, 18);
      ctx.fillStyle = hot ? gold : col.glow;
      ctx.fillRect(-2, 32, 4, 4);
    }
    if (up.hull >= 2) {
      // armour chevrons over the wings (frigate and up)
      for (const sx of [-1, 1]) {
        ctx.fillStyle = shade(col.trim, -0.15);
        ctx.beginPath();
        ctx.moveTo(sx * 14, -8); ctx.lineTo(sx * 30, 10); ctx.lineTo(sx * 22, 16); ctx.lineTo(sx * 10, 0);
        ctx.closePath(); ctx.fill();
      }
    }
    if (up.hull >= 3) {
      // command deck spine (battleship)
      ctx.fillStyle = shade(col.trim, 0.1);
      ctx.fillRect(-7, 2, 14, 26);
      ctx.strokeStyle = "rgba(230,245,255,0.5)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-7, 2, 14, 26);
    }
    if (up.shield >= 2) {
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#28414f";
        ctx.beginPath(); ctx.arc(sx * 40, 20, 4, 0, Math.PI * 2); ctx.fill();
        glow(ctx, sx * 40, 20, 9, "rgba(127,208,255,0.95)");
      }
    }
    if (up.shield >= 4) {
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#28414f";
        ctx.beginPath(); ctx.arc(sx * 14, 38, 4.5, 0, Math.PI * 2); ctx.fill();
        glow(ctx, sx * 14, 38, 11, "rgba(127,208,255,0.95)");
      }
    }
    if (up.engine >= 2) {
      // twin auxiliary nozzles
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#1c2634";
        ctx.fillRect(sx * 16 - 3, 38, 6, 10);
        glow(ctx, sx * 16, 50, 8, col.glow);
      }
    }
  }
  return toTexture(c);
}

/* ------------------------------------------------------------------ */
/* Planets                                                             */
/* ------------------------------------------------------------------ */

const PLANET_PALETTES: Record<string, [string, string, string]> = {
  agri: ["#3f8f4f", "#7fc96a", "#2a5c38"],
  mine: ["#8f6a4f", "#c98f5a", "#5c3d2a"],
  industry: ["#5c6a8f", "#9aa8c9", "#333c5c"],
  science: ["#4f8f8f", "#7fd0d0", "#2a5c5c"],
  hub: ["#8f5c86", "#c98fbe", "#5c2a54"],
};

export function makePlanetTexture(kind: string, seed: number): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(seed);
  const [base, hi, low] = PLANET_PALETTES[kind] ?? PLANET_PALETTES.hub;
  const cx = S / 2, cy = S / 2, R = S / 2 - 6;

  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
  g.addColorStop(0, hi);
  g.addColorStop(0.55, base);
  g.addColorStop(1, low);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  // surface blotches
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * R * 0.9;
    const br = 6 + rnd() * 30;
    ctx.fillStyle = rnd() > 0.5 ? hi : low;
    ctx.globalAlpha = 0.10 + rnd() * 0.16;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, br, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // night-side shading
  const sh = ctx.createRadialGradient(cx + R * 0.5, cy + R * 0.5, R * 0.2, cx, cy, R * 1.15);
  sh.addColorStop(0, "rgba(0,0,10,0.55)");
  sh.addColorStop(0.6, "rgba(0,0,10,0.12)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  // atmosphere rim
  ctx.strokeStyle = "rgba(160,220,255,0.35)";
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, Math.PI * 2); ctx.stroke();
  return toTexture(c);
}

/* ------------------------------------------------------------------ */
/* Stations — one distinct silhouette per economy kind                 */
/* ------------------------------------------------------------------ */

/** Gradient metal box with a dark border — building block for station modules. */
function metalBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: string, bot: string): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bot);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(6,10,18,0.75)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

/** Row of lit windows / lamps. */
function windowRow(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, gap: number, color: string, size = 2.2): void {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) ctx.fillRect(x + i * gap, y, size, size);
}

/**
 * Station art, v2: each economy kind gets its own architecture so the player can
 * tell an agri-hab from a refinery at a glance (hub ring, agri domes, asteroid mine,
 * factory decks, orbital lab).
 */
/**
 * 12b «шуба»: равнопромежуточная альбедо-карта планеты для three-сферы.
 * Те же палитры, что у sprite-текстуры: широтные полосы + крапы, без блика
 * (свет ляжет lambert-шейдингом от звезды).
 */
export function makePlanetAlbedo(kind: string, seed: number): HTMLCanvasElement {
  const W = 256, H = 128;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(seed);
  const [base, hi, low] = PLANET_PALETTES[kind] ?? PLANET_PALETTES.hub;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  // latitude belts: wavy bands of hi/low tones
  for (let y = 0; y < H; y += 7 + Math.floor(rnd() * 6)) {
    ctx.fillStyle = rnd() > 0.5 ? hi : low;
    ctx.globalAlpha = 0.18 + rnd() * 0.25;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.05 + y) * 4 + (rnd() - 0.5) * 3);
    ctx.lineTo(W, y + 6 + rnd() * 8);
    ctx.lineTo(0, y + 6 + rnd() * 8);
    ctx.closePath();
    ctx.fill();
  }
  // polar caps
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = hi;
  ctx.fillRect(0, 0, W, 10);
  ctx.fillRect(0, H - 10, W, 10);
  // landmass speckles
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rnd() > 0.5 ? hi : low;
    const r = 2 + rnd() * 6;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return c;
}

export function makeStationTexture(kind: StationKind = "hub", seed = 1): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(seed);
  const cx = S / 2, cy = S / 2;

  if (kind === "hub") {
    /* trade hub: rotating ring + cyan core, warm dock windows */
    ctx.strokeStyle = "#42506b";
    ctx.lineWidth = 9;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 26, cy + Math.sin(a) * 26);
      ctx.lineTo(cx + Math.cos(a) * 62, cy + Math.sin(a) * 62);
      ctx.stroke();
    }
    const ring = ctx.createLinearGradient(cx - 70, cy - 70, cx + 70, cy + 70);
    ring.addColorStop(0, "#c9b08a");
    ring.addColorStop(0.5, "#8fa8c9");
    ring.addColorStop(1, "#46536e");
    ctx.strokeStyle = ring;
    ctx.lineWidth = 16;
    ctx.beginPath(); ctx.arc(cx, cy, 66, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#31405c";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, 74, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 58, 0, Math.PI * 2); ctx.stroke();
    // warm habitat windows around the ring
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.fillStyle = i % 3 === 0 ? "#ffd9a0" : "#ffedc9";
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 66, cy + Math.sin(a) * 66, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    // core
    glow(ctx, cx, cy, 46, "rgba(127,208,255,0.5)");
    const core = ctx.createRadialGradient(cx - 7, cy - 7, 2, cx, cy, 24);
    core.addColorStop(0, "#eaf4ff");
    core.addColorStop(1, "#2b4f8f");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1a2a48";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.stroke();
    // beacons
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      glow(ctx, cx + Math.cos(a) * 74, cy + Math.sin(a) * 74, 10, "rgba(255,210,120,0.9)");
    }
  } else if (kind === "agri") {
    /* agri-hab: flat deck with glass bio-domes */
    // deck plate
    const deck = ctx.createLinearGradient(0, cy - 8, 0, cy + 44);
    deck.addColorStop(0, "#9aa8bd");
    deck.addColorStop(1, "#3c465e");
    ctx.fillStyle = deck;
    ctx.beginPath(); ctx.ellipse(cx, cy + 26, 92, 30, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(6,10,18,0.7)";
    ctx.lineWidth = 3;
    ctx.stroke();
    // field grid on the deck
    ctx.strokeStyle = "rgba(140,220,150,0.35)";
    ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + 26 + i * 9, 88 - Math.abs(i) * 26, 4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // connector tubes between domes
    ctx.strokeStyle = "#6b7f9e";
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(cx - 44, cy - 2); ctx.lineTo(cx + 52, cy + 6); ctx.stroke();
    // glass domes
    const domes: [number, number, number][] = [[cx - 46, cy - 8, 30], [cx + 6, cy - 20, 40], [cx + 56, cy + 2, 24]];
    for (const [dx, dy, dr] of domes) {
      const dg = ctx.createRadialGradient(dx - dr * 0.3, dy - dr * 0.4, dr * 0.15, dx, dy, dr);
      dg.addColorStop(0, "rgba(190,255,190,0.95)");
      dg.addColorStop(0.55, "rgba(90,200,110,0.75)");
      dg.addColorStop(1, "rgba(25,90,50,0.9)");
      ctx.fillStyle = dg;
      ctx.beginPath(); ctx.arc(dx, dy, dr, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
      // ribs
      ctx.strokeStyle = "rgba(220,255,220,0.4)";
      ctx.lineWidth = 1.4;
      for (const k of [0.3, 0.5, 0.7]) {
        ctx.beginPath();
        ctx.ellipse(dx, dy, dr * Math.sin(k * Math.PI), dr, 0, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
      // specular
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath(); ctx.ellipse(dx - dr * 0.35, dy - dr * 0.45, dr * 0.18, dr * 0.1, -0.6, 0, Math.PI * 2); ctx.fill();
      glow(ctx, dx, dy - dr * 0.2, dr * 1.3, "rgba(120,255,150,0.18)");
    }
    // mast
    ctx.strokeStyle = "#cfe0f5";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx + 6, cy - 60); ctx.lineTo(cx + 6, cy - 84); ctx.stroke();
    glow(ctx, cx + 6, cy - 86, 7, "rgba(255,120,120,0.9)");
  } else if (kind === "mine") {
    /* asteroid mine: seeded rock with an attached rig + floodlights */
    const pts = 12;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const r = 58 + Math.sin(a * 3 + seed) * 9 + (i < pts ? (rnd() - 0.5) * 12 : 0);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.92;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const rock = ctx.createLinearGradient(cx - 50, cy - 50, cx + 60, cy + 60);
    rock.addColorStop(0, "#7a6a58");
    rock.addColorStop(0.55, "#54473a");
    rock.addColorStop(1, "#241d16");
    ctx.fillStyle = rock;
    ctx.fill();
    ctx.strokeStyle = "rgba(6,6,10,0.8)";
    ctx.lineWidth = 3;
    ctx.stroke();
    // craters
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 40;
      ctx.fillStyle = "rgba(15,12,8,0.45)";
      ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 5 + rnd() * 8, 3 + rnd() * 5, rnd(), 0, Math.PI * 2); ctx.fill();
    }
    // mining rig on the summit
    metalBox(ctx, cx - 16, cy - 92, 32, 40, "#9aa8c9", "#3a4458");
    metalBox(ctx, cx - 30, cy - 62, 60, 16, "#7c8aa6", "#333c52");
    windowRow(ctx, cx - 10, cy - 84, 4, 6, "#ffe29b");
    // drill shaft glowing into the rock
    const drill = ctx.createLinearGradient(0, cy - 46, 0, cy + 6);
    drill.addColorStop(0, "rgba(255,170,80,0.9)");
    drill.addColorStop(1, "rgba(255,170,80,0)");
    ctx.fillStyle = drill;
    ctx.fillRect(cx - 4, cy - 46, 8, 52);
    // floodlight cones
    for (const sx of [-1, 1]) {
      const fg = ctx.createLinearGradient(cx, cy - 60, cx + sx * 96, cy + 18);
      fg.addColorStop(0, "rgba(255,200,120,0.28)");
      fg.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(cx + sx * 24, cy - 56);
      ctx.lineTo(cx + sx * 100, cy + 22);
      ctx.lineTo(cx + sx * 52, cy + 40);
      ctx.closePath();
      ctx.fill();
    }
    // hazard lamps
    glow(ctx, cx - 30, cy - 56, 9, "rgba(255,120,60,0.9)");
    glow(ctx, cx + 30, cy - 56, 9, "rgba(255,120,60,0.9)");
  } else if (kind === "industry") {
    /* refinery: stacked decks, smokestacks with glowing caps, furnace lines */
    metalBox(ctx, cx - 84, cy + 34, 168, 26, "#8896b2", "#2c354c");
    metalBox(ctx, cx - 66, cy + 4, 132, 30, "#76849f", "#28304a");
    metalBox(ctx, cx - 46, cy - 24, 92, 28, "#66748e", "#232b42");
    // smokestacks
    for (const [sx, hh] of [[-28, 62], [2, 84], [28, 52]] as [number, number][]) {
      metalBox(ctx, cx + sx - 6, cy - 24 - hh, 12, hh, "#4a5570", "#1b2233");
      glow(ctx, cx + sx, cy - 24 - hh, 12, "rgba(255,140,60,0.85)");
      ctx.fillStyle = "#ff9c54";
      ctx.fillRect(cx + sx - 6, cy - 26 - hh, 12, 5);
    }
    // furnace glow bands between decks
    for (const [by, bw] of [[cy + 8, 132], [cy + 38, 168]] as [number, number][]) {
      const fg = ctx.createLinearGradient(0, by, 0, by + 8);
      fg.addColorStop(0, "rgba(255,120,50,0.85)");
      fg.addColorStop(1, "rgba(255,120,50,0.1)");
      ctx.fillStyle = fg;
      ctx.fillRect(cx - bw / 2 + 8, by, bw - 16, 8);
    }
    // gantry crane
    ctx.strokeStyle = "#1a2236";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - 46, cy - 52); ctx.lineTo(cx + 74, cy - 52); ctx.lineTo(cx + 74, cy - 30);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 40, cy - 52); ctx.lineTo(cx + 40, cy - 38); ctx.stroke();
    // hazard lights
    for (const [lx, ly] of [[-84, 34], [84, 34], [-66, 4], [66, 4]] as [number, number][]) {
      glow(ctx, cx + lx, cy + ly, 8, "rgba(255,90,74,0.9)");
    }
    windowRow(ctx, cx - 40, cy - 16, 8, 10, "#ffe29b", 2.6);
  } else {
    /* science: white modular lab, cyan dome + antenna beam, solar wings */
    // solar wings
    for (const sx of [-1, 1]) {
      const pg = ctx.createLinearGradient(cx + sx * 40, cy - 20, cx + sx * 110, cy + 20);
      pg.addColorStop(0, "#31548f");
      pg.addColorStop(1, "#101d38");
      ctx.fillStyle = pg;
      ctx.fillRect(sx > 0 ? cx + 44 : cx - 110, cy - 16, 66, 34);
      ctx.strokeStyle = "rgba(140,180,255,0.5)";
      ctx.lineWidth = 1.2;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo((sx > 0 ? cx + 44 : cx - 110) + i * 16, cy - 16);
        ctx.lineTo((sx > 0 ? cx + 44 : cx - 110) + i * 16, cy + 18);
        ctx.stroke();
      }
      ctx.strokeStyle = "#6b7f9e";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx + sx * 40, cy + 1); ctx.lineTo(cx + sx * 46, cy + 1); ctx.stroke();
    }
    // stacked white decks
    metalBox(ctx, cx - 52, cy + 14, 104, 20, "#e8eef7", "#8b97ac");
    metalBox(ctx, cx - 38, cy - 8, 76, 22, "#f2f6fc", "#9aa6bb");
    metalBox(ctx, cx - 24, cy - 26, 48, 18, "#ffffff", "#a8b4c8");
    // instrument dome
    glow(ctx, cx, cy - 34, 26, "rgba(84,255,210,0.4)");
    const dome = ctx.createRadialGradient(cx - 4, cy - 40, 2, cx, cy - 32, 14);
    dome.addColorStop(0, "#dffcff");
    dome.addColorStop(1, "#2e8f74");
    ctx.fillStyle = dome;
    ctx.beginPath(); ctx.arc(cx, cy - 32, 13, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
    // antenna + scanning beam
    ctx.strokeStyle = "#cfe0f5";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy - 44); ctx.lineTo(cx, cy - 78); ctx.stroke();
    const beam = ctx.createLinearGradient(0, cy - 118, 0, cy - 78);
    beam.addColorStop(0, "rgba(84,255,210,0)");
    beam.addColorStop(1, "rgba(84,255,210,0.55)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 78); ctx.lineTo(cx - 12, cy - 118); ctx.lineTo(cx + 12, cy - 118); ctx.lineTo(cx + 3, cy - 78);
    ctx.closePath(); ctx.fill();
    // deck edge lights
    for (let i = 0; i < 6; i++) glow(ctx, cx - 46 + i * 18.4, cy + 34, 5, "rgba(127,208,255,0.9)");
  }
  return toTexture(c);
}

export function makeStarTexture(): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, "#fffdf2");
  g.addColorStop(0.25, "#ffe9a8");
  g.addColorStop(0.6, "#ff9c3c");
  g.addColorStop(1, "rgba(255,90,20,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}

export function makeGlowTexture(rgb = "255,255,255"): HTMLCanvasElement {
  const S = 64;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(0.35, `rgba(${rgb},0.55)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}

/** Трассер болта (12c): софтовый белый «капелек» 128×16 — голова справа (u=1),
 *  хвост гаснет по x, мягкая посадка по y; цвет докрашивается материалом. */
export function makeStreakTexture(): HTMLCanvasElement {
  const W = 128, H = 16;
  const [c, ctx] = canvas(W, H);
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(255,255,255,0)");
  v.addColorStop(0.5, "rgba(255,255,255,1)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  for (let x = 0; x < W; x++) {
    const u = x / (W - 1);
    ctx.globalAlpha = Math.pow(u, 1.5) * (0.25 + 0.75 * u);
    ctx.fillStyle = v;
    ctx.fillRect(x, 0, 1, H);
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

/** Ударная волна взрыва (12c): белое гауссово кольцо — пик яркости на 0.42 полуширины,
 *  масштаб под радиус кольца задаёт GL-плейн, цвет — материал. */
export function makeShockTexture(): HTMLCanvasElement {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const C = S / 2, PEAK = S * 0.21, SIG = S * 0.045;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.4;
  for (let r = 2; r < C; r += 1) {
    const k = (r - PEAK) / SIG;
    ctx.globalAlpha = Math.exp(-k * k);
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

export function makeNebulaTexture(seed: number, hueA: string, hueB: string): HTMLCanvasElement {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 26; i++) {
    const x = S * (0.2 + rnd() * 0.6);
    const y = S * (0.2 + rnd() * 0.6);
    const r = 40 + rnd() * 130;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    const col = rnd() > 0.5 ? hueA : hueB;
    g.addColorStop(0, col);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.05 + rnd() * 0.07;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

export function makeCargoTexture(): HTMLCanvasElement {
  const S = 64;
  const [c, ctx] = canvas(S, S);
  ctx.translate(S / 2, S / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "#c9a86a";
  ctx.fillRect(-14, -14, 28, 28);
  ctx.strokeStyle = "#6b542e";
  ctx.lineWidth = 4;
  ctx.strokeRect(-14, -14, 28, 28);
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.stroke();
  ctx.rotate(-Math.PI / 4);
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 30);
  g.addColorStop(0, "rgba(255,230,150,0.35)");
  g.addColorStop(1, "rgba(255,230,150,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-32, -32, 64, 64);
  return toTexture(c);
}

export function makeCreditTexture(): HTMLCanvasElement {
  const S = 64;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2 - 4);
  g.addColorStop(0, "#fffbe0");
  g.addColorStop(0.5, "#ffd24a");
  g.addColorStop(1, "rgba(255,180,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#fff3c0";
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 9, 0, Math.PI * 2); ctx.fill();
  return toTexture(c);
}

/** Gate frame: twin arcs + nav lights, transparent center (the horizon renders behind it). */
export function makeGateFrameTexture(): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const cx = S / 2, cy = S / 2;

  ctx.strokeStyle = "#9fe8d0";
  ctx.lineWidth = 13;
  ctx.lineCap = "round";
  for (const off of [0, Math.PI]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 78, off + 0.32, off + Math.PI - 0.32);
    ctx.stroke();
  }
  ctx.strokeStyle = "#2e5f52";
  ctx.lineWidth = 4;
  for (const off of [0, Math.PI]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 90, off + 0.3, off + Math.PI - 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 66, off + 0.3, off + Math.PI - 0.3);
    ctx.stroke();
  }
  // nav lights
  ctx.fillStyle = "#eafff8";
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 78, cy + Math.sin(a) * 78, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c);
}

/** Fallback event horizon — used until the AI vortex art loads (assets/gate/vortex.png). */
export function makeGateHorizonTexture(): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const cx = S / 2, cy = S / 2;
  const g = ctx.createRadialGradient(cx, cy, 6, cx, cy, 120);
  g.addColorStop(0, "rgba(220,255,250,0.95)");
  g.addColorStop(0.35, "rgba(84,255,210,0.55)");
  g.addColorStop(1, "rgba(84,255,210,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}
