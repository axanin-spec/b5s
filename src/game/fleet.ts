/**
 * fleet.ts — Этап 9a (спил 2/4): фит-статы корабля игрока, витрина верфи и лавки
 * снаряжения, вынесенные из монолита Game. Чистые функции от PlayerState + конфига;
 * UI-побочки (звук, новости, сейв) остаются в обёртках Game.
 */

import { EMERGENCY_PULSE, EQUIP, EQUIP_LINES, EQUIP_SELL, HULL_SELL, HULLS, PIRATE_BRANCH, RANKS, REPAIR_COST_PER_HP, REP, hullFitLabel } from "./config";
import type { EquipCat, EquipItem, HullDef, HullId, YardTier } from "./config";
import type { Dockable, PlayerState } from "./types";

/** Контекст верфи: игрок и признак оккупации текущей системы. */
export interface FleetCtx {
  player: PlayerState;
  hereOccupied(): boolean;
}

/* ------------------------------------------------------------------ */
/* Фит-статы: корпус + установленные модули                            */
/* ------------------------------------------------------------------ */

export function hullDef(p: PlayerState): HullDef {
  return HULLS.find((h) => h.id === p.ship) ?? HULLS[0];
}

export function equipped(p: PlayerState, cat: EquipCat): (EquipItem | null)[] {
  return p.installed[cat].map((id) => (id ? EQUIP[id] ?? null : null));
}

export function guns(p: PlayerState): EquipItem[] {
  return equipped(p, "weapon").filter((g): g is EquipItem => !!g);
}

/** Лучший ранг в категории — кормит и статы, и арт корпуса. */
export function bestRank(p: PlayerState, cat: EquipCat): number {
  let best = 0;
  for (const id of p.installed[cat]) if (id && EQUIP[id]) best = Math.max(best, EQUIP[id].rankIdx);
  return best;
}

export function cargoMax(p: PlayerState): number { return hullDef(p).cargo; }
export function maxHull(p: PlayerState): number { return hullDef(p).hp; }

export function maxShield(p: PlayerState): number {
  let s = hullDef(p).shieldPlate;
  for (const it of equipped(p, "shield")) if (it) s += it.cap;
  return s;
}

/** Реген щита дают только модули: голая плита не восстанавливается. */
export function shieldRegen(p: PlayerState): number {
  let r = 0;
  for (const it of equipped(p, "shield")) if (it) r += it.regen;
  return r;
}

/** Тяга: множитель установленного двигателя; без него — аварийные форсунки (×1). */
export function engMult(p: PlayerState): number {
  const e = equipped(p, "engine").find((x): x is EquipItem => !!x);
  return e ? e.mult : 1;
}

export function gunRate(p: PlayerState): number {
  let r: number = EMERGENCY_PULSE.rate;
  for (const g of guns(p)) r = Math.max(r, g.rate);
  return r;
}

export function cargoUsed(p: PlayerState): number {
  let n = 0;
  for (const g of Object.keys(p.cargo)) n += p.cargo[g] ?? 0;
  return n;
}

/* ------------------------------------------------------------------ */
/* Верфь и лавка: гейты витрины (Этап 7)                               */
/* ------------------------------------------------------------------ */

/** Прилавок этого терминала: клановая касса (оккупация и база) или гражданская станция. */
export function clanMarket(c: FleetCtx, d: Dockable): boolean {
  return c.hereOccupied() || d.id === PIRATE_BRANCH.LAIR.id;
}

/** Потолок рангов на витрине: статус дока × standing. Клановый рынок — только своим. */
export function rankCap(c: FleetCtx, d: Dockable): number {
  if (clanMarket(c, d)) {
    const cl = c.player.rep.clan;
    return cl >= REP.FRIENDLY ? 5 : cl >= 0 ? 4 : 2;
  }
  const t = c.player.rep.trader;
  switch (d.kind) {
    case "hub": return t >= REP.FRIENDLY ? 4 : t >= 0 ? 3 : 2;
    case "industry": return t >= 0 ? 3 : 2;
    case "science": return 2;
    default: return 1;
  }
}

/** Причина, по которой лавка не продаёт линию/ранг; null — продаёт. */
export function lineGate(c: FleetCtx, d: Dockable, line: { yard: YardTier }, rankIdx: number): string | null {
  const clan = clanMarket(c, d);
  if (clan) {
    if (line.yard === "flag" && c.player.rep.clan < REP.FRIENDLY) return `флагманская линия — только с доверием кланов ≥ +${REP.FRIENDLY}`;
  } else {
    const core = d.kind === "industry" || d.kind === "hub" || d.kind === "science";
    if (line.yard === "core" && !core) return "такое держат промышленные узлы, научные колонии и хабы";
    if (line.yard === "flag" && (d.kind !== "hub" || c.player.rep.trader < REP.FRIENDLY)) return `нужен хаб Альянса и статус ≥ +${REP.FRIENDLY}`;
  }
  if (rankIdx > rankCap(c, d)) return clan ? "ранг выше доверия кланов" : "ранг выше статуса в Альянсе";
  return null;
}

/** Причина, по которой верфь не продаёт корпус; null — стапель свободен. */
export function hullGate(c: FleetCtx, d: Dockable, h: HullDef): string | null {
  if (h.yard === "any") return null;
  if (clanMarket(c, d)) {
    return c.player.rep.clan >= REP.FRIENDLY ? null : `трофейные стапели: кланы ≥ +${REP.FRIENDLY}`;
  }
  if (h.yard === "core") {
    return d.kind === "industry" || d.kind === "hub" || d.kind === "science" ? null : "сборочные стапели — на промышленных, научных узлах и хабах";
  }
  return d.kind === "hub" && c.player.rep.trader >= REP.FRIENDLY ? null : `флагман: хаб Альянса со статусом ≥ +${REP.FRIENDLY}`;
}

/** The repair bill; the lair's docks are unlicensed — repairs cost less there (6c). */
export function repairCost(missingHp: number, isLair: boolean): number {
  return Math.ceil(Math.max(0, missingHp) * REPAIR_COST_PER_HP * (isLair ? PIRATE_BRANCH.LAIR.REPAIR_FACTOR : 1));
}

/**
 * Пересадка на корпус (чистая часть setShip): непригодные модули уходят на склад,
 * дежурный двигатель включается всегда. Статы корабля и текстуру пересобирает Game.
 */
export function setShipFit(p: PlayerState, id: HullId): void {
  p.ship = id;
  const slots = hullDef(p).slots;
  const fit = (cat: EquipCat): (string | null)[] => {
    // не влезший в новый корпус фит уезжает на склад, а не сгорает; битые id — в утиль
    const kept: (string | null)[] = [];
    for (const x of p.installed[cat]) {
      if (!x) continue;
      if (EQUIP[x]?.ships.includes(id)) kept.push(x);
      else if (EQUIP[x]) p.stash.push(x);
    }
    while (kept.length > slots[cat]) p.stash.push(kept.pop()!);
    while (kept.length < slots[cat]) kept.push(null);
    return kept;
  };
  p.installed = { weapon: fit("weapon"), shield: fit("shield"), engine: fit("engine") };
  // без двигателя из дока не выйти: корпус всегда идёт с дежурной машиной
  if (!p.installed.engine.some(Boolean)) p.installed.engine[0] = hullDef(p).defaultEngine;
}

/* ------------------------------------------------------------------ */
/* Снапшот верфи для UI                                                */
/* ------------------------------------------------------------------ */

export function fleetSnapshot(c: FleetCtx, d: Dockable) {
  const cur = hullDef(c.player);
  const hulls = HULLS.map((h) => {
    const why = hullGate(c, d, h);
    const net = h.id === cur.id ? 0 : h.price - Math.round(cur.price * HULL_SELL);
    return {
      id: h.id, name: h.name, desc: h.desc,
      hp: h.hp, speed: h.maxSpeed, cargo: h.cargo,
      slots: `${h.slots.weapon}/${h.slots.shield}/${h.slots.engine}`,
      current: h.id === cur.id,
      stock: why === null && h.id !== cur.id,
      why,
      net,
      canAfford: c.player.credits >= net,
    };
  });
  const slotRows = (["weapon", "shield", "engine"] as EquipCat[]).map((cat) => ({
    cat,
    items: c.player.installed[cat].map((id, i) => {
      const it = id ? EQUIP[id] : null;
      return it
        ? { slot: i, itemId: it.id, name: it.name, rank: it.rank, desc: it.desc }
        : { slot: i, itemId: null, name: "—", rank: "", desc: cat === "engine" ? "нет двигателя" : "пустой слот" };
    }),
  }));
  const shop: { itemId: string; name: string; cat: EquipCat; rank: string; desc: string; cost: number; canAfford: boolean }[] = [];
  for (const line of EQUIP_LINES) {
    for (const rank of RANKS) {
      const it = EQUIP[`${line.id}-${rank}`];
      if (lineGate(c, d, line, it.rankIdx) === null) {
        // Этап 13: в описании лавки — на какие корпуса встаёт модуль
        shop.push({ itemId: it.id, name: it.name, cat: line.cat, rank, desc: `${line.desc}: ${it.desc} · для: ${hullFitLabel(line.ships)}`, cost: it.cost, canAfford: c.player.credits >= it.cost });
      }
    }
  }
  const stash = c.player.stash.map((id, idx) => {
    const it = EQUIP[id];
    return {
      idx, itemId: id, name: it.name, cat: it.cat, rank: it.rank, desc: `${it.desc} · для: ${hullFitLabel(it.ships)}`,
      fits: it.ships.includes(c.player.ship),
      sell: Math.round(it.cost * EQUIP_SELL),
    };
  });
  return {
    ship: {
      id: cur.id, name: cur.name, cargoMax: cur.cargo,
      slots: `${cur.slots.weapon}/${cur.slots.shield}/${cur.slots.engine}`,
      speed: Math.round(cur.maxSpeed * engMult(c.player)),
      dps: guns(c.player).reduce((s, g) => s + g.dmg * g.shots, 0) * gunRate(c.player),
    },
    hulls, slotRows, shop, stash,
    sellHullValue: Math.round(cur.price * HULL_SELL),
    canSellHull: cur.id !== "fighter",
  };
}
