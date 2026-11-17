/**
 * world.ts — star system generation (seeded), orbital motion and the living market.
 */

import { ECONOMY, GOODS, KIND_MODS, PIRATE_BRANCH, STATION_KIND_NAMES, WORLD_CFG } from "./config";
import { mulberry32 } from "./textures";
import type { Dockable, StationKind } from "./types";

const PLANET_DEFS: { name: string; kind: StationKind }[] = [
  { name: "Вега", kind: "agri" },
  { name: "Гефест", kind: "mine" },
  { name: "Форж", kind: "industry" },
  { name: "Прометей", kind: "science" },
  { name: "Эдем", kind: "hub" },
];

const STATION_DEFS: { name: string; kind: StationKind }[] = [
  { name: "Станция «Ковчег»", kind: "hub" },
  { name: "Станция «Пульсар»", kind: "industry" },
  { name: "Станция «Алтайр»", kind: "mine" },
  { name: "Станция «Наука»", kind: "science" },
];

export function generateWorld(seed: number, priceLevel = 1, sysMods: Record<string, number> = {}, withLair = false): Dockable[] {
  const rnd = mulberry32(seed);
  const dockables: Dockable[] = [];

  const initFluct = () => {
    const f: Record<string, number> = {};
    for (const g of GOODS) {
      f[g.id] = Math.min(ECONOMY.FLUCT_MAX, Math.max(ECONOMY.FLUCT_MIN, (0.9 + rnd() * 0.25) * priceLevel));
    }
    return f;
  };

  WORLD_CFG.PLANETS.forEach((p, i) => {
    const def = PLANET_DEFS[i];
    dockables.push({
      id: `planet-${i}`,
      name: def.name,
      kind: def.kind,
      isStation: false,
      orbit: p.orbit,
      angle: rnd() * Math.PI * 2,
      angVel: p.w,
      x: 0, y: 0,
      radius: p.radius,
      sysMods,
      market: {},
      fluct: initFluct(),
      eventGood: null,
      eventT: 0,
    });
  });

  WORLD_CFG.STATION_ORBITS.forEach((orbit, i) => {
    const def = STATION_DEFS[i];
    dockables.push({
      id: `station-${i}`,
      name: def.name,
      kind: def.kind,
      isStation: true,
      orbit,
      angle: rnd() * Math.PI * 2,
      angVel: 0.007 + rnd() * 0.004,
      x: 0, y: 0,
      radius: WORLD_CFG.STATION_RADIUS,
      sysMods,
      market: {},
      fluct: initFluct(),
      eventGood: null,
      eventT: 0,
    });
  });

  // the smuggler lair (Этап 6c): an unlicensed station parked on a far orbit of Терминус
  if (withLair) {
    dockables.push({
      id: PIRATE_BRANCH.LAIR.id,
      name: PIRATE_BRANCH.LAIR.name,
      kind: "hub",
      isStation: true,
      orbit: WORLD_CFG.PLANETS[WORLD_CFG.PLANETS.length - 1].orbit + 170,
      angle: Math.PI * 1.17,
      angVel: 0.0016,
      x: 0, y: 0,
      radius: WORLD_CFG.STATION_RADIUS,
      sysMods,
      market: {},
      fluct: initFluct(),
      eventGood: null,
      eventT: 0,
    });
  }

  updateOrbits(dockables, 0);
  refreshAllPrices(dockables);
  return dockables;
}

export function updateOrbits(dockables: Dockable[], dt: number): void {
  for (const d of dockables) {
    d.angle += d.angVel * dt;
    d.x = Math.cos(d.angle) * d.orbit;
    d.y = Math.sin(d.angle) * d.orbit;
  }
}

export function basePriceOf(d: Dockable, goodId: string): number {
  const good = GOODS.find((g) => g.id === goodId);
  if (!good) return 1;
  // station specialization × system specialization — the system profile trends the whole market
  return good.base * (KIND_MODS[d.kind][goodId] ?? 1) * (d.sysMods[goodId] ?? 1);
}

/** Current buy price (what the player pays). Selling price applies SELL_FACTOR on top. */
export function priceOf(d: Dockable, goodId: string): number {
  const event = d.eventGood === goodId ? ECONOMY.EVENT_MULT : 1;
  return Math.max(1, Math.round(basePriceOf(d, goodId) * d.fluct[goodId] * event));
}

export function refreshPrices(d: Dockable): void {
  for (const g of GOODS) d.market[g.id] = priceOf(d, g.id);
}

export function refreshAllPrices(dockables: Dockable[]): void {
  for (const d of dockables) refreshPrices(d);
}

/**
 * Advance the market: random walk + occasional demand events.
 * Returns a news headline when something noteworthy happens (for the HUD ticker).
 */
export function economyTick(dockables: Dockable[], rnd: () => number): string | null {
  let news: string | null = null;
  for (const d of dockables) {
    for (const g of GOODS) {
      const step = (rnd() - 0.5) * 2 * ECONOMY.FLUCT_STEP;
      d.fluct[g.id] = Math.min(ECONOMY.FLUCT_MAX, Math.max(ECONOMY.FLUCT_MIN, d.fluct[g.id] + step));
    }
    if (d.eventGood) {
      d.eventT -= ECONOMY.TICK;
      if (d.eventT <= 0) {
        news = `Спрос на товар «${goodName(d.eventGood)}» на объекте ${d.name} нормализовался`;
        d.eventGood = null;
        d.eventT = 0;
      }
    } else if (rnd() < ECONOMY.EVENT_CHANCE / dockables.length) {
      const g = GOODS[Math.floor(rnd() * GOODS.length)];
      d.eventGood = g.id;
      d.eventT = ECONOMY.EVENT_DURATION;
      news = `Внимание торговцам: на объекте ${d.name} резко вырос спрос на «${g.name}»!`;
    }
  }
  refreshAllPrices(dockables);
  return news;
}

export function goodName(id: string): string {
  return GOODS.find((g) => g.id === id)?.name ?? id;
}

export function kindName(kind: StationKind): string {
  return STATION_KIND_NAMES[kind];
}

/** Nearest dockable within docking range of (x, y); null when none. */
export function findDockTarget(dockables: Dockable[], x: number, y: number): Dockable | null {
  let best: Dockable | null = null;
  let bestDist = Infinity;
  for (const d of dockables) {
    const dist = Math.hypot(d.x - x, d.y - y) - d.radius;
    if (dist < WORLD_CFG.DOCK_MARGIN && dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}
