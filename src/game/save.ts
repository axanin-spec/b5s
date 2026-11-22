/**
 * save.ts — localStorage save/load with versioning and defensive validation.
 * Browser-local only: does not sync across devices; clearing browser data loses it.
 */

import { EQUIP, GOODS, HULLS, MONEY_TOTAL, POOLS, SAVE_KEY, TRADER_TIERS } from "./config";
import { storage } from "./storage";
import type { EquipCat, SaveGame } from "./types";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function validCargo(c: unknown): c is Record<string, number> {
  if (typeof c !== "object" || c === null) return false;
  for (const g of GOODS) {
    const q = (c as Record<string, unknown>)[g.id];
    if (q !== undefined && (!isNum(q) || q < 0 || q > 100000)) return false;
  }
  return true;
}

/** v8: корпус + установленные модули + склад (Этап 7). Всё должно сходиться с верфью. */
function validFleet(p: SaveGame["player"]): boolean {
  const hull = HULLS.find((h) => h.id === p.ship);
  if (!hull) return false;
  const inst = p.installed;
  if (typeof inst !== "object" || inst === null) return false;
  for (const cat of ["weapon", "shield", "engine"] as EquipCat[]) {
    const arr = inst[cat];
    if (!Array.isArray(arr) || arr.length > hull.slots[cat]) return false;
    for (const id of arr) {
      if (id === null) continue;
      const it = EQUIP[id];
      if (typeof id !== "string" || !it || it.cat !== cat || !it.ships.includes(hull.id)) return false;
    }
  }
  if (!Array.isArray(p.stash) || p.stash.length > 64) return false;
  for (const id of p.stash) {
    if (typeof id !== "string" || !EQUIP[id]) return false;
  }
  return true;
}

/** Parse and validate; returns null on any shape violation (caller falls back to a new game). */
export function loadSave(): SaveGame | null {
  return validateSave(storage.get<unknown>(SAVE_KEY, null));
}

/** The shape gate shared by localStorage load and file import (Этап 9c). */
export function validateSave(raw: unknown): SaveGame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as SaveGame;
  // v9 added the market intel log (Этап 10a); v10 — база игрока (Этап 17, поле опционально);
  // v8/v9 saves stay playable — грузятся с дефолтами
  if (s.v !== 8 && s.v !== 9 && s.v !== 10) return null;
  if (!isNum(s.seed) || typeof s.system !== "string" || s.system.length === 0) return null;
  // Этап 17: база опциональна; если есть — форма строгая
  if (s.base !== undefined && s.base !== null) {
    const b = s.base;
    if (typeof b !== "object" || typeof b.sys !== "string" || b.sys.length === 0) return null;
    if (!validCargo(b.cargo)) return null;
  }
  if (typeof s.player !== "object" || s.player === null) return null;
  const p = s.player;
  if (!isNum(p.x) || !isNum(p.y) || !isNum(p.credits) || p.credits < 0) return null;
  if (!isNum(p.hull) || !isNum(p.shield) || !isBool(p.outlaw)) return null;
  if (!isNum(p.pardons) || p.pardons < 0) return null;
  if (!validCargo(p.cargo) || !validFleet(p)) return null;
  // v7: the clan standing joined the ledger (Этап 6) — older saves lack it and are rejected
  const rep = p.rep;
  if (typeof rep !== "object" || rep === null || !isNum(rep.patrol) || !isNum(rep.trader) || !isNum(rep.clan)) return null;
  // contract is optional (v3 added it): null/undefined = accepted, anything else must be shaped
  if (s.contract !== null && s.contract !== undefined) {
    const c = s.contract;
    if (typeof c !== "object") return null;
    if ((c.kind !== "hunt" && c.kind !== "transport" && c.kind !== "bounty") || !isNum(c.reward) || !isNum(c.timeLeft)) return null;
    // 6b: clan-board contracts carry their funder; absent = Alliance (pre-6b v7 saves)
    if (c.funder !== undefined && c.funder !== "alliance" && c.funder !== "clan") return null;
    if (!isNum(c.done) || !isNum(c.need) || !isNum(c.id) || !isNum(c.qty)) return null;
    if (typeof c.title !== "string" || typeof c.destId !== "string") return null;
    // 13e: legacy mark is optional; anything non-boolean is a broken save
    if (c.legacy !== undefined && c.legacy !== null && typeof c.legacy !== "boolean") return null;
  }
  if (typeof s.fluct !== "object" || s.fluct === null) return null;
  if (typeof s.stats !== "object" || s.stats === null) return null;
  if (!isNum(s.stats.kills) || !isNum(s.stats.earned) || !isNum(s.stats.traded) || !isNum(s.stats.playTime)) return null;
  // v4: the pirate occupation front replaces the old chase-boss flags
  if (typeof s.occupation !== "object" || s.occupation === null) return null;
  if (typeof s.occupation.systemId !== "string" || !isBool(s.occupation.held) || !isNum(s.occupation.t) || !isBool(s.occupation.flagshipBuilt)) return null;
  if (!isNum(s.bossKills) || s.bossKills < 0) return null;
  // v9: market intel (Этап 10a) — optional; a v8 save has none and gets an empty log below
  if (s.intel !== undefined && s.intel !== null) {
    if (typeof s.intel !== "object") return null;
    for (const k of Object.keys(s.intel)) {
      const e = s.intel[k];
      if (typeof e !== "object" || e === null) return null;
      if (typeof e.systemId !== "string" || typeof e.name !== "string" || !isNum(e.t) || e.t < 0) return null;
      if (e.clan !== undefined && !isBool(e.clan)) return null; // 14g: optional флаг кланового прилавка
      if (typeof e.prices !== "object" || e.prices === null) return null;
      for (const g of Object.keys(e.prices)) {
        const q = e.prices[g];
        if (typeof q !== "object" || q === null || !isNum(q.buy) || !isNum(q.sell) || q.buy < 0 || q.sell < 0) return null;
      }
    }
  }
  if (!s.intel) s.intel = {};
  // 14а: реестр караванов — опционален; сейвы до 14а входят с пустой книгой ниже
  if (s.traders !== undefined && s.traders !== null) {
    if (typeof s.traders !== "object") return null;
    for (const k of Object.keys(s.traders)) {
      const r = s.traders[k];
      if (typeof r !== "object" || r === null || !isNum(r.trips) || r.trips < 0) return null;
      if (!isNum(r.tier) || r.tier < 0 || r.tier >= TRADER_TIERS.TIERS.length) return null;
    }
  }
  if (!s.traders) s.traders = {};
  // v6: closed money pools — sane finite numbers; the clan fund may run into debt
  // (Этап 5c hull write-offs) but never below -MONEY_TOTAL
  if (typeof s.pools !== "object" || s.pools === null) return null;
  for (const k of Object.keys(POOLS)) {
    const v = (s.pools as Record<string, unknown>)[k];
    if (!isNum(v) || v < -MONEY_TOTAL || v > MONEY_TOTAL) return null;
  }
  // v6 (5d extension): the raid operation on the ops desk — optional, old v6 saves omit it
  if (s.raid !== null && s.raid !== undefined) {
    const r = s.raid;
    if (typeof r !== "object") return null;
    if (typeof r.targetId !== "string" || r.targetId.length === 0) return null;
    if (!isNum(r.timeLeft) || r.timeLeft < 0 || r.timeLeft > 1e4) return null;
    if (!isNum(r.cooldown) || r.cooldown < 0 || r.cooldown > 1e4) return null;
    if (!isNum(r.taken) || r.taken < 0) return null;
    if (!Array.isArray(r.grabbed) || r.grabbed.length > 8 || r.grabbed.some((g) => typeof g !== "string")) return null;
  }
  return s;
}

export function writeSave(save: SaveGame): void {
  storage.set(SAVE_KEY, save);
}

/**
 * Import a save from a JSON file (Этап 9c): same validation gate as loadSave —
 * a shaped-but-foreign file is rejected, a valid one replaces the stored save.
 */
export function importSaveJson(json: string): boolean {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return false; }
  const s = validateSave(raw);
  if (!s) return false;
  writeSave(s);
  return true;
}

export function hasSave(): boolean {
  return loadSave() !== null;
}

export function clearSave(): void {
  storage.remove(SAVE_KEY);
}
