/**
 * missions.ts — Этап 9a (спил 3/4): доска контрактов (Альянс и кланы), конвои
 * и рейдовые операции, вынесенные из монолита Game. Функции работают на
 * структурном контексте MissionsCtx; Game держит тонкие обёртки.
 */

import { CONTRACTS, CONVOY, GOODS, PIRATE_BRANCH, PIRATE_ECON, POSTWIN, RAID, REP, SYSTEMS, WORLD_CFG } from "./config";
import type { SystemDef } from "./config";
import type { ActiveContract, ContractOffer, Dockable, Faction, OccupationState, RaidOp, Ship } from "./types";
import type { EconCtx } from "./economy";
import * as econ from "./economy";
import { findDockTarget, goodName } from "./world";

/** Структурный хозяин миссий: состояние контрактов/рейдов + сервисы Game. */
export interface MissionsCtx extends EconCtx {
  rnd(): number;
  sm: { state: string };
  systemDef: SystemDef;
  dockables: Dockable[];
  gates: { to: string; name: string; x: number; y: number }[];
  occ: OccupationState;
  offers: ContractOffer[];
  contract: ActiveContract | null;
  contractSeq: number;
  raidSeq: number;
  convoy: { id: number; t: number; done: number; traderIdx: number } | null;
  convoyT: number;
  raid: RaidOp | null;
  grabTarget: string | null;
  grabT: number;
  mapOpen: boolean;
  audio: { sfx(name: string): void };
  isPirate(): boolean;
  systemName(id: string): string;
  spawnShip(f: Faction, x: number, y: number): number;
  freeShip(i: number): void;
  pickTraderRoute(i: number): void;
  addRep(d: { patrol?: number; trader?: number; clan?: number }): void;
  syncPirateStatus(): void;
  setNews(text: string): void;
  floater(x: number, y: number, text: string, c: string, big?: boolean): void;
  pushStation(): void;
  pushHud(): void;
  pushMap(): void;
  saveNow(): void;
}

/* ------------------------------------------------------------------ */
/* Доска контрактов                                                    */
/* ------------------------------------------------------------------ */

/**
 * Пост-игра (13e): галактика помнит победителя — брокеры и клановая доска
 * изредка выкладывают наследный заказ: охотничий расклад, награда вдвое.
 * Платит казна заказчика, поэтому неотягощённого заказа доска не видит:
 * если в пуле меньше двойной награды, наследный контракт не выставляется.
 */
function maybePostLegacy(c: MissionsCtx, funder: "alliance" | "clan", boost: number): void {
  if (!c.player.victoryShown || c.rnd() >= POSTWIN.LEGACY_CHANCE) return;
  const jit = (base: number) => Math.round((base * (1 + (c.rnd() * 2 - 1) * CONTRACTS.JITTER)) / 50) * 50;
  const n = 4 + Math.floor(c.rnd() * 3);
  const reward = jit((650 + 140 * n) * boost * POSTWIN.LEGACY_MULT);
  if (c.pools[funder] < reward) return; // казна не тянет вдвое — наследная доска молчит
  c.offers.push({
    id: ++c.contractSeq, kind: "hunt", funder,
    title: funder === "alliance" ? "Наследный контракт Альянса" : "Наследный заказ клана",
    desc: funder === "alliance"
      ? `Галактика подписана вашим именем. Фундаторский фонд Альянса выкупает старые счета: ${n} пиратов в системе ${c.systemDef.name} — награда вдвое против обычного, из наследной казны.`
      : `Победителя в кланах помнят: сходняк распечатывает наследную кубышку — ${n} чужих головорезов в системе ${c.systemDef.name}, выплата вдвое.`,
    reward, timeLimit: CONTRACTS.TIME_HUNT,
    need: n, goodId: "", qty: 0, destId: "", destName: "",
    legacy: true,
  });
}

/** One offer of each kind per docking; the broker restocks every undock. */
export function genOffers(c: MissionsCtx, here: Dockable): void {
  c.offers = [];
  // licensed brokers don't work in pirate space — there the clans post their own board (6b),
  // and the lair keeps its own board too (6c)
  if (c.hereOccupied() || here.id === PIRATE_BRANCH.LAIR.id) { genClanOffers(c, here); return; }
  // licensed brokers never route cargo to the smuggler lair — officially it doesn't exist
  const others = c.dockables.filter((d) => d.id !== here.id && d.id !== PIRATE_BRANCH.LAIR.id);
  if (others.length === 0) return;
  const jit = (base: number) => Math.round((base * (1 + (c.rnd() * 2 - 1) * CONTRACTS.JITTER)) / 50) * 50;
  const boost = 1 + c.systemDef.pirateBoost * 0.2;

  const n = 4 + Math.floor(c.rnd() * 3);
  c.offers.push({
    id: ++c.contractSeq, kind: "hunt", funder: "alliance",
    title: "Охота на пиратов",
    desc: `Уничтожить ${n} пиратов в системе ${c.systemDef.name}.`,
    reward: jit((650 + 140 * n) * boost), timeLimit: CONTRACTS.TIME_HUNT,
    need: n, goodId: "", qty: 0, destId: "", destName: "",
  });

  const dest = others[Math.floor(c.rnd() * others.length)];
  const g = GOODS[Math.floor(c.rnd() * GOODS.length)];
  const qty = 6 + Math.floor(c.rnd() * 7);
  c.offers.push({
    id: ++c.contractSeq, kind: "transport", funder: "alliance",
    title: "Курьерский рейс",
    desc: `Передать запечатанный контейнер (${qty} ед. «${goodName(g.id)}»). Пункт назначения: ${dest.name}. Трюм не занимает.`,
    reward: jit(900 + qty * 95), timeLimit: CONTRACTS.TIME_TRANSPORT,
    need: 1, goodId: g.id, qty, destId: dest.id, destName: dest.name,
  });

  const dest2 = others[Math.floor(c.rnd() * others.length)];
  const callsign = `${CONTRACTS.CALLSIGNS[Math.floor(c.rnd() * CONTRACTS.CALLSIGNS.length)]}-${2 + Math.floor(c.rnd() * 8)}`;
  c.offers.push({
    id: ++c.contractSeq, kind: "escort", funder: "alliance",
    title: "Эскорт транспорта",
    desc: `Сопроводить транспорт «${callsign}». Пункт назначения: ${dest2.name}. Собьют его — контракт провален.`,
    reward: jit(1150), timeLimit: CONTRACTS.TIME_ESCORT,
    need: 1, goodId: "", qty: 0, destId: dest2.id, destName: dest2.name,
  });

  maybePostLegacy(c, "alliance", boost);
}

/**
 * The clans' board (Этап 6b) — posted only in occupied systems and, later, at the
 * lair. Zero trust (clan ≤ UNFRIENDLY) and nobody even hails you here. Clan money
 * pays, clan law scores: patrol and Alliance standings burn on the way.
 */
export function genClanOffers(c: MissionsCtx, here: Dockable): void {
  if (c.player.rep.clan <= REP.UNFRIENDLY) return;
  const jit = (base: number) => Math.round((base * (1 + (c.rnd() * 2 - 1) * CONTRACTS.JITTER)) / 50) * 50;

  const n = 3 + Math.floor(c.rnd() * 3);
  c.offers.push({
    id: ++c.contractSeq, kind: "hunt", funder: "clan",
    title: "Разборки кланов",
    desc: `Соседний клан нагрянул «в гости» в системе ${c.systemDef.name}. Проводите ${n} головорезов обратно — чей флаг им удобнее поднять, решайте сами.`,
    reward: jit(600 + 150 * n), timeLimit: CONTRACTS.TIME_HUNT,
    need: n, goodId: "", qty: 0, destId: "", destName: "",
  });

  const k = 2 + Math.floor(c.rnd() * 3);
  c.offers.push({
    id: ++c.contractSeq, kind: "bounty", funder: "clan",
    title: "Головы патруля",
    desc: `Катера патруля разгуливают по системе ${c.systemDef.name} как у себя в доке. Снимите ${k} — трибунал спрашивать не будет, кланы платят вперёд глазами.`,
    reward: jit(950 + 190 * k), timeLimit: CONTRACTS.TIME_HUNT,
    need: k, goodId: "", qty: 0, destId: "", destName: "",
  });

  // at the lair a wanted captain has nowhere to deliver: Alliance docks refuse him,
  // so the smuggling run only posts when the client can legally dock (6c)
  const atLair = here.id === PIRATE_BRANCH.LAIR.id;
  const others = atLair && c.isPirate() ? [] : c.dockables.filter((d) => d.id !== here.id);
  if (others.length > 0) {
    const dest = others[Math.floor(c.rnd() * others.length)];
    const g = GOODS[Math.floor(c.rnd() * GOODS.length)];
    const qty = 5 + Math.floor(c.rnd() * 6);
    c.offers.push({
      id: ++c.contractSeq, kind: "transport", funder: "clan",
      title: "Тёмный рейс",
      desc: `Доставьте ящик «неучтёнки» (${qty} ед. «${goodName(g.id)}») своим на ${dest.name}, не задерживаясь в доке. Трюм не занимает.`,
      reward: jit(780 + qty * 90), timeLimit: CONTRACTS.TIME_TRANSPORT,
      need: 1, goodId: g.id, qty, destId: dest.id, destName: dest.name,
    });
  }

  maybePostLegacy(c, "clan", 1);
}

export function acceptContract(c: MissionsCtx, id: number): void {
  if (c.sm.state !== "docked" || c.contract) return;
  const off = c.offers.find((o) => o.id === id);
  if (!off) return;
  c.offers = c.offers.filter((o) => o.id !== id);
  const next: ActiveContract = { ...off, timeLeft: off.timeLimit, done: 0, escortIdx: -1 };
  if (off.kind === "escort") {
    const here = c.dockTarget;
    const destIdx = c.dockables.findIndex((d) => d.id === off.destId);
    if (here && destIdx >= 0) {
      const idx = c.spawnShip("trader", here.x + 240, here.y + 140);
      if (idx >= 0) {
        const s = c.ships[idx];
        s.routeFrom = c.dockables.indexOf(here);
        s.routeTo = destIdx;
        s.tx = c.dockables[destIdx].x; s.ty = c.dockables[destIdx].y;
        s.escortId = off.id;
        next.escortIdx = idx;
      }
    }
  }
  c.contract = next;
  c.audio.sfx("trade");
  c.setNews(`Контракт принят: ${off.title}. Награда ₡${off.reward.toLocaleString("ru-RU")}.`);
  c.pushStation();
  c.pushHud();
}

export function cancelContract(c: MissionsCtx): void {
  if (!c.contract) return;
  const ei = c.contract.escortIdx;
  if (ei >= 0 && c.ships[ei].active && c.ships[ei].escortId === c.contract.id) {
    c.ships[ei].escortId = -1; // the escorted trader goes back to its own routes
  }
  c.contract = null;
  c.setNews("Контракт отменён.");
  if (c.sm.state === "docked" && c.dockTarget) genOffers(c, c.dockTarget);
  c.pushStation();
  c.pushHud();
}

export function completeContract(c: MissionsCtx, reason: string): void {
  const cur = c.contract;
  if (!cur) return;
  c.contract = null;
  const clanJob = cur.funder === "clan";
  // the funder's treasury pays: Alliance brokers dip into Alliance capital, clan jobs into the clans' fund
  const paid = econ.gain(c, cur.reward, clanJob ? "clan" : "alliance");
  c.player.earned += paid;
  // the two ledgers of law: Alliance board feeds patrol/trader, the clan board feeds clans
  // at the price of the other two (kinds never mix across boards, hence the casts)
  c.addRep(clanJob
    ? PIRATE_BRANCH.CONTRACT_REP[cur.kind as keyof typeof PIRATE_BRANCH.CONTRACT_REP]
    : CONTRACTS.REP[cur.kind as keyof typeof CONTRACTS.REP]);
  c.audio.sfx("credits");
  c.setNews(`Контракт выполнен: ${cur.title} — ${reason}. +₡${paid.toLocaleString("ru-RU")}`);
  if (c.sm.state === "docked" && c.dockTarget) genOffers(c, c.dockTarget);
  c.pushStation();
  c.pushHud();
  c.saveNow();
}

export function failContract(c: MissionsCtx, reason: string): void {
  const cur = c.contract;
  if (!cur) return;
  const ei = cur.escortIdx;
  if (ei >= 0 && c.ships[ei].active) c.ships[ei].escortId = -1;
  c.contract = null;
  if (cur.funder === "clan") c.addRep(PIRATE_BRANCH.CONTRACT_FAIL_REP); // clans remember dropped work
  c.setNews(`Контракт провален: ${reason}.`);
  c.pushStation();
  c.pushHud();
}

/* ------------------------------------------------------------------ */
/* Конвой (случайная тревога)                                          */
/* ------------------------------------------------------------------ */

export function spawnConvoyEvent(c: MissionsCtx): void {
  const di = Math.floor(c.rnd() * c.dockables.length);
  const d = c.dockables[di];
  const id = ++c.raidSeq;
  const trader = c.spawnShip("trader", d.x + 160, d.y + 120);
  if (trader < 0) { c.convoyT = 25; return; } // pool full — retry soon
  c.ships[trader].raidId = id;
  c.ships[trader].routeFrom = di;
  c.pickTraderRoute(trader);
  for (let k = 0; k < CONVOY.RAIDERS; k++) {
    const a = c.rnd() * Math.PI * 2;
    const p = c.spawnShip("pirate", d.x + Math.cos(a) * 620, d.y + Math.sin(a) * 620);
    if (p >= 0) c.ships[p].raidId = id;
  }
  c.convoy = { id, t: CONVOY.WINDOW, done: 0, traderIdx: trader };
  c.setNews(`ПЕРЕХВАТ: пираты атакуют конвой у ${d.name}! Сбейте ${CONVOY.NEED} рейдеров за ${Math.round(CONVOY.WINDOW)} с.`);
  c.audio.sfx("alarm");
}

export function endConvoy(c: MissionsCtx, win: boolean, reason: string, plundered = false): void {
  if (!c.convoy) return;
  const id = c.convoy.id;
  c.convoy = null;
  for (const s of c.ships) if (s.active && s.raidId === id) s.raidId = -1; // survivors go back to ordinary piracy
  if (win) {
    const paid = econ.gain(c, CONVOY.REWARD, "alliance");
    c.player.earned += paid;
    c.addRep(CONVOY.REP);
    c.audio.sfx("credits");
    c.setNews(`${reason} Торговый альянс платит ₡${paid}.`);
  } else if (plundered) {
    // a successful clan raid (5c): the captured freight tops up the clan fund, paid by the Alliance
    const loot = Math.max(0, Math.min(PIRATE_ECON.RAID_PLUNDER, Math.round(c.pools.alliance)));
    c.pools.alliance -= loot;
    c.pools.clan += loot;
    c.setNews(`${reason} Добыча кланов: ₡${loot.toLocaleString("ru-RU")} — фонд пополнен.`);
  } else {
    c.setNews(reason);
  }
  c.pushHud();
}

export function updateContracts(c: MissionsCtx, dt: number): void {
  if (c.contract) {
    c.contract.timeLeft -= dt;
    if (c.contract.timeLeft <= 0) failContract(c, "время вышло");
  }
  if (c.convoy) {
    c.convoy.t -= dt;
    if (c.convoy.t <= 0) endConvoy(c, false, "Рейдеры растворились в поясе астероидов — конвой спасён, но награды не будет.");
  } else {
    c.convoyT -= dt;
    if (c.convoyT <= 0) {
      c.convoyT = CONVOY.PERIOD_MIN + c.rnd() * (CONVOY.PERIOD_MAX - CONVOY.PERIOD_MIN);
      spawnConvoyEvent(c);
    }
  }
}

/* ------------------------------------------------------------------ */
/* HUD-строка миссии и цель на мини-радаре                             */
/* ------------------------------------------------------------------ */

/** HUD one-liner for the active contract / raid, with distance to the objective. */
export function missionLine(c: MissionsCtx): string | null {
  const fmtT = (sec: number) => {
    const s = Math.max(0, Math.ceil(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  let base: string | null = null;
  if (c.contract) {
    const cur = c.contract;
    base = cur.kind === "hunt"
      ? `КОНТРАКТ · Охота ${cur.done}/${cur.need} · ${fmtT(cur.timeLeft)}`
      : cur.kind === "bounty"
        ? `КОНТРАКТ · Головы ${cur.done}/${cur.need} · ${fmtT(cur.timeLeft)}`
        : `КОНТРАКТ · ${cur.kind === "transport" ? "Доставка" : "Эскорт"} → ${cur.destName} · ${fmtT(cur.timeLeft)}`;
  } else if (c.raid && c.raid.timeLeft > 0) {
    const r = c.raid;
    base = `НАЛЁТ · ${c.systemName(r.targetId)} · складов ${r.grabbed.length} · ${fmtT(r.timeLeft)}`;
    if (c.grabTarget) base += ` · выгрузка ${Math.min(100, Math.floor((c.grabT / RAID.GRAB_TIME) * 100))}%`;
  } else if (c.convoy) {
    base = `ТРЕВОГА · Конвой: рейдеры ${c.convoy.done}/${CONVOY.NEED} · ${fmtT(c.convoy.t)}`;
  }
  if (!base) return null;
  const obj = objectivePos(c);
  if (obj) {
    const p = c.ships[0];
    const dist = Math.hypot(obj.x - p.x, obj.y - p.y);
    base += ` · ${(dist / 1000).toFixed(1)}k`;
  }
  return base;
}

/** Where the mini-radar should point: contract target or the nearest live raider. */
export function objectivePos(c: MissionsCtx): { x: number; y: number; c: string } | null {
  const p = c.ships[0];
  if (c.contract) {
    const cur = c.contract;
    // hunt chases pirates, clan bounty chases patrols — same nearest-prey scan (6b)
    if (cur.kind === "hunt" || cur.kind === "bounty") {
      const prey: Faction = cur.kind === "hunt" ? "pirate" : "patrol";
      let best: Ship | null = null, bd = Infinity;
      for (let i = 1; i < c.ships.length; i++) {
        const s = c.ships[i];
        if (!s.active || s.faction !== prey) continue;
        const dd = Math.hypot(s.x - p.x, s.y - p.y);
        if (dd < bd) { bd = dd; best = s; }
      }
      return best ? { x: best.x, y: best.y, c: "#ff5a4a" } : null;
    }
    if (cur.kind === "escort") {
      const s = cur.escortIdx >= 0 ? c.ships[cur.escortIdx] : null;
      if (s && s.active) return { x: s.x, y: s.y, c: "#ffb347" };
    }
    const d = c.dockables.find((dd) => dd.id === cur.destId);
    return d ? { x: d.x, y: d.y, c: "#ffb347" } : null;
  }
  if (c.convoy) {
    let best: Ship | null = null, bd = Infinity;
    for (let i = 1; i < c.ships.length; i++) {
      const s = c.ships[i];
      if (!s.active || s.faction !== "pirate" || s.raidId !== c.convoy.id) continue;
      const tough = s.hp + s.shield;
      if (tough < bd) { bd = tough; best = s; }
    }
    return best ? { x: best.x, y: best.y, c: "#ff5a4a" } : null;
  }
  // raid op: point at the nearest full storehouse here, or at the gate leading to the target (5d)
  if (c.raid && c.raid.timeLeft > 0) {
    const r = c.raid;
    if (c.systemDef.id === r.targetId) {
      let best: Dockable | null = null, bd = Infinity;
      for (const d of c.dockables) {
        if (!d.isStation || r.grabbed.includes(d.id)) continue;
        const dd = Math.hypot(d.x - p.x, d.y - p.y);
        if (dd < bd) { bd = dd; best = d; }
      }
      return best ? { x: best.x, y: best.y, c: "#ff9a3a" } : null;
    }
    const g = c.gates.find((gg) => gg.to === r.targetId);
    return g ? { x: g.x, y: g.y, c: "#ff9a3a" } : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Рейдовые операции (5d)                                              */
/* ------------------------------------------------------------------ */

export function raidHot(c: MissionsCtx): boolean {
  return !!(c.raid && c.raid.timeLeft > 0 && c.raid.targetId === c.systemDef.id);
}

/**
 * Launch a raid on a free system from the galaxy map (5d). Occupied systems
 * hold nothing worth taking; the desk is busy while a window or cooldown runs.
 */
export function startRaid(c: MissionsCtx, systemId: string): void {
  if (c.sm.state !== "playing" || !c.ships[0].active) return;
  if (c.raid) {
    c.audio.sfx("alarm");
    c.setNews(c.raid.timeLeft > 0
      ? "Оперштаб занят: окно налёта ещё открыто."
      : "Оперштаб остывает — следующая операция будет нескоро.");
    return;
  }
  const def = SYSTEMS.find((s) => s.id === systemId);
  if (!def) return;
  if (c.occ.held && c.occ.systemId === systemId) {
    c.audio.sfx("alarm");
    c.setNews("Налёт на оккупированную систему — даром: там и так всё общее.");
    return;
  }
  c.raid = { targetId: systemId, timeLeft: RAID.WINDOW, cooldown: 0, grabbed: [], taken: 0 };
  c.grabTarget = null; c.grabT = 0;
  const here = systemId === c.systemDef.id;
  if (here) spawnRaidGuards(c);
  c.audio.sfx("alarm");
  c.setNews(`⚔ НАЛЁТ НА ${def.name.toUpperCase()}: ${Math.round(RAID.WINDOW / 60)} мин, чтобы опустошить склады станций (${RAID.GRAB_TIME} с у причала). ${here ? "Вы уже здесь — охрана поднимается по тревоге!" : "Прыгайте в врата — окно уже идёт."}`);
  c.pushHud();
  if (c.mapOpen) c.pushMap();
  c.saveNow();
}

/** Patrol cordon thrown up around every station of the target while the window is open. */
export function spawnRaidGuards(c: MissionsCtx): void {
  for (const d of c.dockables) {
    if (!d.isStation) continue;
    for (let k = 0; k < RAID.GUARDS_PER_STATION; k++) {
      const idx = c.spawnShip("patrol", d.x + (c.rnd() - 0.5) * 1400, d.y + (c.rnd() - 0.5) * 1400);
      if (idx >= 0) c.ships[idx].raidGuard = true;
    }
  }
}

/** Window timer, storehouse hovering, cooldown. Contract/convoy logic is untouched by jumps — the op is galaxy-wide. */
export function updateRaid(c: MissionsCtx, dt: number): void {
  const r = c.raid;
  if (!r) return;
  if (r.timeLeft <= 0) {
    r.cooldown -= dt;
    if (r.cooldown <= 0) c.raid = null; // the ops desk is clear — the map lights the button up again
    return;
  }
  r.timeLeft -= dt;
  if (c.sm.state === "playing" && c.systemDef.id === r.targetId) {
    const p = c.ships[0];
    const spd = Math.hypot(p.vx, p.vy);
    const near = spd < WORLD_CFG.DOCK_MAX_SPEED ? findDockTarget(c.dockables, p.x, p.y) : null;
    const d = near && near.isStation && !r.grabbed.includes(near.id) ? near : null;
    if (d) {
      if (c.grabTarget !== d.id) { c.grabTarget = d.id; c.grabT = 0; }
      c.grabT += dt;
      if (c.grabT >= RAID.GRAB_TIME) grabStorehouse(c, d);
    } else {
      c.grabTarget = null; c.grabT = 0;
    }
  } else {
    c.grabTarget = null; c.grabT = 0;
  }
  if (r.timeLeft <= 0) endRaid(c);
}

/** Empty one storehouse: three treasuries pay at once — strongbox, customs payroll, caravan funds. */
export function grabStorehouse(c: MissionsCtx, d: Dockable): void {
  const r = c.raid;
  if (!r) return;
  const def = SYSTEMS.find((s) => s.id === r.targetId) ?? c.systemDef;
  const pl = def.priceLevel; // trophies ∝ the target's market wealth
  let total = 0;
  total += econ.gain(c, Math.max(RAID.LOOT_MIN.stations, RAID.LOOT.stations * Math.max(0, c.pools.stations)) * pl, "stations");
  total += econ.gain(c, Math.max(RAID.LOOT_MIN.patrol, RAID.LOOT.patrol * Math.max(0, c.pools.patrol)) * pl, "patrol");
  total += econ.gain(c, Math.max(RAID.LOOT_MIN.alliance, RAID.LOOT.alliance * Math.max(0, c.pools.alliance)) * pl, "alliance");
  r.grabbed.push(d.id);
  r.taken += total;
  // 14с: со «своего» капитана кланы берут долю добычи — скупка краденого в их руках.
  // Первый налёт ещё «с чистых рук»: своим грабитель становится только после него.
  let clanCut = 0;
  if (c.isPirate()) {
    clanCut = Math.min(Math.round(total * RAID.CLAN_SHARE), Math.max(0, Math.round(c.player.credits)));
    if (clanCut > 0) { c.player.credits -= clanCut; c.pools.clan += clanCut; }
  }
  c.player.earned += total - clanCut;
  c.grabTarget = null; c.grabT = 0;
  // the clans applaud every sagging Alliance warehouse (Этап 6)
  c.addRep(PIRATE_BRANCH.REP_RAID_GRAB);
  // embargo: the raids spook trade — every market in the system sags
  for (const dd of c.dockables) for (const g of GOODS) econ.pushFluct(dd, g.id, -RAID.EMBARGO_PUSH);
  if (r.grabbed.length === 1) {
    c.addRep(RAID.REP_HIT);
    c.player.outlaw = true; // open piracy: patrol shoots on sight until pardoned or fined
    c.audio.sfx("alarm");
    c.syncPirateStatus(); // 5f: the first grab makes you formal kin of the clans
    c.setNews(`⚔ Склад ${d.name} опустошен: +₡${total.toLocaleString("ru-RU")}. Патруль объявил вас пиратом — с этого момента вас ищут!`);
  } else {
    c.audio.sfx("credits");
    c.setNews(`⚔ Склад ${d.name} опустошен: +₡${total.toLocaleString("ru-RU")}.`
      + (clanCut > 0 ? ` Кланам доля: ₡${clanCut.toLocaleString("ru-RU")} — скупка краденого не забудет.` : ""));
  }
  c.floater(d.x, d.y - d.radius - 40, `+₡${Math.round(total).toLocaleString("ru-RU")}`, "#ff9a3c", true);
  c.pushHud();
  c.saveNow();
}

/** The window closed: escorts stand down, the operation desk cools off. */
export function endRaid(c: MissionsCtx, reason?: string): void {
  const r = c.raid;
  if (!r) return;
  for (let i = 1; i < c.ships.length; i++) {
    const s = c.ships[i];
    if (s.active && s.raidGuard) c.freeShip(i);
  }
  c.grabTarget = null; c.grabT = 0;
  c.raid = { targetId: r.targetId, timeLeft: 0, cooldown: RAID.COOLDOWN, grabbed: r.grabbed, taken: r.taken };
  c.setNews(reason
    ?? (r.grabbed.length
      ? `Операция завершена: складов ${r.grabbed.length}, добыча ₡${Math.round(r.taken).toLocaleString("ru-RU")}. Оперштаб остывает ${Math.round(RAID.COOLDOWN / 60)} мин.`
      : "Окно налёта закрыто — склады целы. Оперштаб остывает."));
  c.saveNow();
  c.pushHud();
  if (c.mapOpen) c.pushMap();
}

/** Rough per-storehouse take in a system — the map's raid forecast (5d). */
export function raidEstFor(c: MissionsCtx, def: SystemDef): number {
  return Math.round(
    (Math.max(RAID.LOOT_MIN.stations, RAID.LOOT.stations * Math.max(0, c.pools.stations))
      + Math.max(RAID.LOOT_MIN.patrol, RAID.LOOT.patrol * Math.max(0, c.pools.patrol))
      + Math.max(RAID.LOOT_MIN.alliance, RAID.LOOT.alliance * Math.max(0, c.pools.alliance)))
    * def.priceLevel,
  );
}
