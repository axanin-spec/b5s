/**
 * save.ts — localStorage save/load with versioning and defensive validation.
 * Browser-local only: does not sync across devices; clearing browser data loses it.
 */

import { GOODS, MONEY_TOTAL, POOLS, SAVE_KEY, SAVE_VERSION, UPGRADE_DEFS } from "./config";
import { storage } from "./storage";
import type { SaveGame, UpgradeLevels } from "./types";

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

function validUpgrades(u: unknown): u is UpgradeLevels {
  if (typeof u !== "object" || u === null) return false;
  for (const line of UPGRADE_DEFS) {
    const lv = (u as Record<string, unknown>)[line.id];
    if (!isNum(lv) || lv < 0 || lv > line.levels.length - 1 || !Number.isInteger(lv)) return false;
  }
  return true;
}

/** Parse and validate; returns null on any shape violation (caller falls back to a new game). */
export function loadSave(): SaveGame | null {
  const raw = storage.get<unknown>(SAVE_KEY, null);
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as SaveGame;
  if (s.v !== SAVE_VERSION) return null;
  if (!isNum(s.seed) || typeof s.system !== "string" || s.system.length === 0) return null;
  if (typeof s.player !== "object" || s.player === null) return null;
  const p = s.player;
  if (!isNum(p.x) || !isNum(p.y) || !isNum(p.credits) || p.credits < 0) return null;
  if (!isNum(p.hull) || !isNum(p.shield) || !isBool(p.outlaw)) return null;
  if (!isNum(p.pardons) || p.pardons < 0) return null;
  if (!validCargo(p.cargo) || !validUpgrades(p.upgrades)) return null;
  const rep = p.rep;
  if (typeof rep !== "object" || rep === null || !isNum(rep.patrol) || !isNum(rep.trader)) return null;
  // contract is optional (v3 added it): null/undefined = accepted, anything else must be shaped
  if (s.contract !== null && s.contract !== undefined) {
    const c = s.contract;
    if (typeof c !== "object") return null;
    if ((c.kind !== "hunt" && c.kind !== "transport") || !isNum(c.reward) || !isNum(c.timeLeft)) return null;
    if (!isNum(c.done) || !isNum(c.need) || !isNum(c.id) || !isNum(c.qty)) return null;
    if (typeof c.title !== "string" || typeof c.destId !== "string") return null;
  }
  if (typeof s.fluct !== "object" || s.fluct === null) return null;
  if (typeof s.stats !== "object" || s.stats === null) return null;
  if (!isNum(s.stats.kills) || !isNum(s.stats.earned) || !isNum(s.stats.traded) || !isNum(s.stats.playTime)) return null;
  // v4: the pirate occupation front replaces the old chase-boss flags
  if (typeof s.occupation !== "object" || s.occupation === null) return null;
  if (typeof s.occupation.systemId !== "string" || !isBool(s.occupation.held) || !isNum(s.occupation.t) || !isBool(s.occupation.flagshipBuilt)) return null;
  if (!isNum(s.bossKills) || s.bossKills < 0) return null;
  // v6: closed money pools — sane finite numbers; the clan fund may run into debt
  // (Этап 5c hull write-offs) but never below -MONEY_TOTAL
  if (typeof s.pools !== "object" || s.pools === null) return null;
  for (const k of Object.keys(POOLS)) {
    const v = (s.pools as Record<string, unknown>)[k];
    if (!isNum(v) || v < -MONEY_TOTAL || v > MONEY_TOTAL) return null;
  }
  return s;
}

export function writeSave(save: SaveGame): void {
  storage.set(SAVE_KEY, save);
}

export function hasSave(): boolean {
  return loadSave() !== null;
}

export function clearSave(): void {
  storage.remove(SAVE_KEY);
}
