/**
 * spawn.ts — Этап 13f (спил 2/2 по конвенции 9e/9a): заселение бортами, вынесенное
 * из монолита Game — слоты флота (spawnShip/freeShip), маршруты караванов и найм
 * конвоя (pickTraderRoute), засев на краю и клановые бортники (spawnAtEdge/
 * spawnSmuggler), крейсер «Варта», потолок флотов и пополнение (maintainPopulation).
 * Функции работают на структурном контексте SpawnCtx; Game держит тонкие обёртки,
 * вызовы не двигались. blankShip/MAX_SHIPS переехали сюда же — здесь они нужнее всех.
 */

import { CLAN_ONLY_GOODS, CONTRACTS, ECONOMY, FACTION_CFG, GOODS, OCCUPATION, PATROL_ECON, PIRATE_BRANCH, PIRATE_ECON, POPULATION, SMUGGLER, TRADER_AI, TRADER_TIERS, WORLD_CFG } from "./config";
import type { SystemDef } from "./config";
import type { Dockable, Faction, Ship } from "./types";
import { AiState } from "./types";
import type { EconCtx } from "./economy";
import * as econ from "./economy";
import { basePriceOf, priceOf } from "./world";

/** Ёмкость пула бортов (слот 0 — игрок). */
export const MAX_SHIPS = 40;

/** Чистый лист борта: нейтральные поля всех систем (13b/14а/14b/14d — флаги по умолчанию). */
export function blankShip(): Ship {
  return {
    active: false, faction: "trader",
    x: 0, y: 0, vx: 0, vy: 0, angle: 0,
    hp: 1, maxHp: 1, shield: 0, maxShield: 0,
    accel: 0, maxSpeed: 0, radius: 20,
    dmg: 0, fireRate: 0, fireCooldown: 0, sinceHit: 99,
    ai: AiState.Wander, targetIdx: -1, tx: 0, ty: 0, wanderT: 0,
    routeFrom: 0, routeTo: 0, name: "", wallet: 0, smuggler: false, cargo: {},
    escortId: -1, raidId: -1, raidGuard: false, screen: false, cruiser: false, thinkT: 0, thinkDt: 0.42, trailT: 0, regroupT: 0, regroupUsed: false, sprite: null,
    // 13b: поколение флагмана и асы — нейтрально для всех остальных бортов
    bossGen: 0, elite: false,
    // 14а: боевой караван и наёмный конвой — нейтральные значения до первого приказа
    angerIdx: -1, angerT: 0, tier: 0, escort: false, escortOf: -1,
    // 14b: гильдейская повинность — отсчёт прибыли, сигнал бедствия, ответ катера
    voyStart: 0, callCd: 0, callT: 0, callIdx: -1,
    // 14d: таможный канал — катер ведёт досмотр, цель и пауза между проверками
    scanIdx: -1, scanT: 0, inspectCd: 0,
  };
}

/** Структурный хозяин спавна: флоты, рынки, казны, реестр караванов + сервисы Game. */
export interface SpawnCtx extends EconCtx {
  rnd(): number;
  systemDef: SystemDef;
  dockables: Dockable[];
  traderTiers: Record<string, { tier: number; trips: number }>;
  /** Индекс живого флагмана; спил 13f — открыт, чтобы freeShip могла его сбрасывать. */
  bossIdx: number;
  setNews(text: string): void;
}

/* ------------------------------------------------------------------ */
/* Слоты флота                                                         */
/* ------------------------------------------------------------------ */

/** armedTrader=false — клановый бортник (spawnSmuggler): без реестра и класса;
 *  с 14с пушки он получает в spawnSmuggler (класс «C», без надбавок реестра). */
export function spawnShip(c: SpawnCtx, faction: Faction, x: number, y: number, armedTrader = true): number {
  for (let i = 1; i < MAX_SHIPS; i++) {
    const s = c.ships[i];
    if (s.active) continue;
    const cfg = FACTION_CFG[faction as keyof typeof FACTION_CFG];
    Object.assign(s, blankShip());
    s.active = true;
    s.faction = faction;
    s.x = x; s.y = y;
    s.angle = c.rnd() * Math.PI * 2;
    s.hp = s.maxHp = cfg.hp;
    s.shield = s.maxShield = cfg.shield;
    s.accel = cfg.accel; s.maxSpeed = cfg.maxSpeed;
    s.radius = cfg.radius;
    s.dmg = cfg.dmg; s.fireRate = cfg.fireRate;
    s.targetIdx = -1;
    s.ai = faction === "trader" ? AiState.Route : AiState.Wander;
    s.tx = x; s.ty = y;
    if (faction === "trader") {
      // working capital is Alliance money until spent (5b): a poor Alliance sends poor ships
      // 14а: реестр караванов ведётся по позывному — постараемся выдать незанятый
      let nm = CONTRACTS.CALLSIGNS[Math.floor(c.rnd() * CONTRACTS.CALLSIGNS.length)];
      if (armedTrader) {
        for (let t = 0; t < 5; t++) {
          const cn = CONTRACTS.CALLSIGNS[Math.floor(c.rnd() * CONTRACTS.CALLSIGNS.length)];
          if (!c.ships.some((o, j) => j !== i && j > 0 && o.active && o.faction === "trader" && !o.smuggler && o.name === cn)) { nm = cn; break; }
        }
      }
      s.name = nm;
      const tierIdx = armedTrader ? (c.traderTiers[s.name]?.tier ?? 0) : 0;
      const tt = TRADER_TIERS.TIERS[tierIdx];
      s.wallet = Math.min(
        Math.round((TRADER_AI.CASH[0] + c.rnd() * (TRADER_AI.CASH[1] - TRADER_AI.CASH[0])) * tt.walletMult),
        Math.max(0, Math.round(c.pools.alliance)),
      );
      c.pools.alliance -= s.wallet;
      // a starter hold so freshly launched ships have something to hawk
      // (14g: зарегистрированный караван контрабандную тройку не возит)
      const legal = GOODS.filter((g) => !econ.isClanOnlyGood(g.id));
      for (let k = 0; k < 2; k++) {
        const g = legal[Math.floor(c.rnd() * legal.length)];
        s.cargo[g.id] = (s.cargo[g.id] ?? 0) + 3 + Math.floor(c.rnd() * 4);
      }
      // 14а: класс из реестра — корпус, броня и оборонительная плазма по книге
      // (конвой наёмный нанимается в pickTraderRoute, куда уходим ниже)
      s.tier = tierIdx;
      if (armedTrader) {
        s.maxHp = tt.hp; s.hp = tt.hp;
        s.maxShield = tt.shield; s.shield = tt.shield;
        s.dmg = tt.dmg; s.fireRate = tt.fireRate;
      }
      pickTraderRoute(c, i, false); // спавн/загрузка: без найма — до первой ходки
      s.voyStart = s.wallet; // 14b: прибыль рейса считается от кошелька на выход из дока
    }
    return i;
  }
  return -1;
}

export function freeShip(c: SpawnCtx, i: number): void {
  const s = c.ships[i];
  if (s.active && s.faction === "trader" && s.wallet > 0) {
    // each fleet's working capital returns to ITS fund: Alliance for caravans, clans for haulers (Этап 8)
    c.pools[s.smuggler ? "clan" : "alliance"] += s.wallet;
    s.wallet = 0;
  }
  s.active = false;
  if (c.bossIdx === i) c.bossIdx = -1;
  // drop dangling target references
  for (const sh of c.ships) if (sh.active && sh.targetIdx === i) sh.targetIdx = -1;
  // 14а: конвоир, оставшийся без хозяина, становится обычным патрулем (жалованье не возвращается)
  for (const sh of c.ships) if (sh.active && sh.escort && sh.escortOf === i) { sh.escort = false; sh.escortOf = -1; sh.targetIdx = -1; }
}

/** Units of cargo in a trader hold. */
export function traderLoad(s: Ship): number {
  let n = 0;
  for (const g of GOODS) n += Math.round(s.cargo[g.id] ?? 0);
  return n;
}

/* ------------------------------------------------------------------ */
/* Маршруты караванов и конвой                                         */
/* ------------------------------------------------------------------ */

/**
 * Where to sail next (Этап 5b): with cargo — the dock where the hold sells for most;
 * empty — the dock where the biggest buy→sell spread awaits. Small jitter keeps the
 * five caravans from all chasing the same trade.
 */
/** hire=false — спавновый пересчёт (в т.ч. загрузка сейва): конвой нанимается на выходе
 *  из дока, иначе continueGame повторно платил бы жалованье до сверки брутто-Альянса. */
export function pickTraderRoute(c: SpawnCtx, idx: number, hire = true): void {
  const s = c.ships[idx];
  const n = c.dockables.length;
  if (n === 0) return;
  const loaded = traderLoad(s) > 0;
  let best = -1, bestV = -Infinity;
  for (let j = 0; j < n; j++) {
    if (n > 1 && j === s.routeFrom) continue; // we are standing at routeFrom
    const d = c.dockables[j];
    // civilian caravans don't know the way to the smuggler lair — and its
    // deflated black-market prices would otherwise vacuum the whole fleet in
    if (d.id === PIRATE_BRANCH.LAIR.id) continue;
    let v: number;
    if (loaded) {
      v = 0;
      // 14g: клановая тройка маршруту не аргумент — караван её не везёт
      for (const g of GOODS) if (!econ.isClanOnlyGood(g.id)) v += priceOf(d, g.id) * ECONOMY.SELL_FACTOR * Math.round(s.cargo[g.id] ?? 0);
    } else {
      // best spread: buy cheap here, sell dear at the far side
      v = -Infinity;
      for (const g of GOODS) {
        if (econ.isClanOnlyGood(g.id)) continue;
        let far = 0;
        for (let k = 0; k < n; k++) {
          if (k === j) continue;
          const p = priceOf(c.dockables[k], g.id) * ECONOMY.SELL_FACTOR;
          if (p > far) far = p;
        }
        const spread = far - priceOf(d, g.id);
        if (spread > v) v = spread;
      }
    }
    v *= 1 + (c.rnd() - 0.5) * 0.25;
    if (v > bestV) { bestV = v; best = j; }
  }
  s.routeTo = best < 0 ? (s.routeFrom + 1) % n : best;
  const d = c.dockables[s.routeTo];
  s.tx = d.x; s.ty = d.y;
  // 14а: караван класса «A» нанимает конвой из фонда выхода — плата идёт в казну патруля
  const t = TRADER_TIERS.TIERS[s.tier];
  if (hire && t.escort && !s.smuggler && s.wallet >= t.escortCost
    && !c.ships.some((o, j) => j > 0 && o.active && o.escort && o.escortOf === idx)) {
    const ei = spawnShip(c, "patrol", s.x + 260, s.y + 140);
    if (ei >= 0) {
      s.wallet -= t.escortCost;
      c.pools.patrol += t.escortCost;
      c.ships[ei].escort = true;
      c.ships[ei].escortOf = idx;
      c.setNews(`${s.name} нанял конвой на переход — ${t.escortCost} ₡ в казну патруля`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Засев на краю, клановые бортники, «Варта»                           */
/* ------------------------------------------------------------------ */

export function spawnAtEdge(c: SpawnCtx, faction: Faction): void {
  const p = c.ships[0];
  const HALF = WORLD_CFG.HALF;
  for (let tries = 0; tries < 8; tries++) {
    const a = c.rnd() * Math.PI * 2;
    const r = HALF * (0.75 + c.rnd() * 0.35);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (Math.hypot(x - p.x, y - p.y) > 3800) {
      spawnShip(c, faction, x, y);
      return;
    }
  }
}

/** True in clan waters — the lair in Terminus or the occupied system:
 *  the heartland of the route. С 14с бортники ходят и прочь отсюда, но
 *  именно тут их караванная смена несётся вдвое гуще (SMUGGLER.COUNT). */
export function smuggleHere(c: SpawnCtx): boolean {
  return c.systemDef.id === PIRATE_BRANCH.LAIR_SYSTEM || c.hereOccupied();
}

/**
 * Clan hauler spawn (Этап 8). A trader hull with the capital rerouted: the spawn
 * drew Alliance money by default — refund it and draw the stake from the clan fund.
 */
export function spawnSmuggler(c: SpawnCtx): void {
  const p = c.ships[0];
  const HALF = WORLD_CFG.HALF;
  const a = c.rnd() * Math.PI * 2;
  const r = HALF * (0.75 + c.rnd() * 0.35);
  const x = Math.cos(a) * r, y = Math.sin(a) * r;
  if (Math.hypot(x - p.x, y - p.y) <= 3800) return; // don't surface a hauler on the player's nose
  const idx = spawnShip(c, "trader", x, y, false); // 14с: без реестра и класса — но с пушкой ниже
  if (idx < 0) return;
  const s = c.ships[idx];
  c.pools.alliance += s.wallet;
  s.wallet = Math.min(
    Math.round(SMUGGLER.CASH[0] + c.rnd() * (SMUGGLER.CASH[1] - SMUGGLER.CASH[0])),
    Math.max(0, Math.round(c.pools.clan)),
  );
  c.pools.clan -= s.wallet;
  s.smuggler = true;
  s.name = SMUGGLER.CALLSIGNS[Math.floor(c.rnd() * SMUGGLER.CALLSIGNS.length)];
  // 14с: бортник вооружён как караван класса «C» — конвоя ему нанимать не у кого
  // (реестра нет), зато он отвечает рейдеру, севшему на хвост вдали от клановых вод
  const cGun = TRADER_TIERS.TIERS[0];
  s.dmg = cGun.dmg; s.fireRate = cGun.fireRate;
  // 14с: выходит гружёным — тонны клановой тройки с базы; расплату берёт из своего
  // фонда по базовой цене дока, деньги остаются внутри кланового контура
  const ref = c.dockables.find((dd) => dd.isStation) ?? c.dockables[0];
  if (ref) {
    // 13d: погрузочный док — «домашний» для радио-отсчёта (как у караванов routeFrom)
    s.routeFrom = Math.max(0, c.dockables.indexOf(ref));
    const gid = CLAN_ONLY_GOODS[Math.floor(c.rnd() * CLAN_ONLY_GOODS.length)];
    const unit = Math.max(1, Math.round(basePriceOf(ref, gid)));
    const q = Math.min(SMUGGLER.LOAD, Math.floor(s.wallet / unit));
    if (q > 0) {
      s.wallet -= q * unit;
      c.pools.clan += q * unit;
      s.cargo[gid] = (s.cargo[gid] ?? 0) + q;
    }
  }
  pickSmugglerRoute(c, idx);
}

/**
 * Heavy cruiser «Варта» (Этап 11b): commissioned when the watch treasury is fat.
 * A patrol hull with the stats overriden from PATROL_ECON.CRUISER; despawns only
 * by dying — a drained treasury stops the replacement, not the ship itself.
 */
export function spawnCruiser(c: SpawnCtx): void {
  if (!c.dockables.length) return;
  const d = c.dockables[Math.floor(c.rnd() * c.dockables.length)];
  const a = c.rnd() * Math.PI * 2;
  const idx = spawnShip(c, "patrol", d.x + Math.cos(a) * 600, d.y + Math.sin(a) * 600);
  if (idx < 0) return;
  const s = c.ships[idx];
  const cfg = PATROL_ECON.CRUISER;
  s.hp = s.maxHp = cfg.hp;
  s.shield = s.maxShield = cfg.shield;
  s.accel = cfg.accel; s.maxSpeed = cfg.maxSpeed;
  s.dmg = cfg.dmg; s.fireRate = cfg.fireRate;
  s.radius = cfg.radius;
  s.cruiser = true;
  s.name = "Варта";
}

/** One leg of the grey route: the lair in Terminus, a black-market dock in occupied space. */
export function pickSmugglerRoute(c: SpawnCtx, idx: number): void {
  const s = c.ships[idx];
  let best = -1;
  if (c.systemDef.id === PIRATE_BRANCH.LAIR_SYSTEM) {
    best = c.dockables.findIndex((d) => d.id === PIRATE_BRANCH.LAIR.id);
  } else {
    const docks: number[] = [];
    for (let j = 0; j < c.dockables.length; j++) if (c.dockables[j].isStation) docks.push(j);
    best = docks.length ? docks[Math.floor(c.rnd() * docks.length)] : -1;
  }
  if (best < 0) { freeShip(c, idx); return; } // no endpoint here — fold the run
  s.routeTo = best;
  s.ai = AiState.Route;
  const d = c.dockables[best];
  s.tx = d.x; s.ty = d.y;
}

/* ------------------------------------------------------------------ */
/* Потолок флотов и пополнение                                         */
/* ------------------------------------------------------------------ */

/**
 * How strong a pirate presence the clan fund can staff (Этап 5c): rich clans post the
 * full POPULATION.PIRATES, a thin fund keeps the flotilla at PIRATES_MIN — sinking their
 * hulls literally thins the ranks. Interpolates linearly between PIRATE_ECON.FUND_THIN
 * and FUND_FULL, then adds the local system/occupation modifiers.
 */
export function pirateStrength(c: SpawnCtx): number {
  const t = (c.pools.clan - PIRATE_ECON.FUND_THIN) / (PIRATE_ECON.FUND_FULL - PIRATE_ECON.FUND_THIN);
  const base = POPULATION.PIRATES_MIN
    + Math.round((POPULATION.PIRATES - POPULATION.PIRATES_MIN) * Math.max(0, Math.min(1, t)));
  return base + c.systemDef.pirateBoost + (c.hereOccupied() ? OCCUPATION.PIRATE_EXTRA : 0);
}

/**
 * Constabulary headcount (Этап 11b): base is per system, but a treasury below
 * TREASURY_THIN means the watch can't pay full wages — the roster shrinks to a
 * skeleton crew of THIN_PATROLS.
 */
export function patrolStrength(c: SpawnCtx): number {
  const base = POPULATION.PATROLS + (c.systemDef.patrolBoost ?? 0);
  return c.pools.patrol < PATROL_ECON.TREASURY_THIN ? Math.min(base, PATROL_ECON.THIN_PATROLS) : base;
}

export function maintainPopulation(c: SpawnCtx): void {
  let pirates = 0, patrols = 0, traders = 0;
  for (let i = 1; i < MAX_SHIPS; i++) {
    const s = c.ships[i];
    if (!s.active) continue;
    if (s.faction === "pirate") pirates++;
    else if (s.faction === "patrol") { if (!s.escort) patrols++; } // 14а: наёмный конвой — не казённый патруль
    else if (s.faction === "trader") traders++;
  }
  const pirateCap = pirateStrength(c);
  if (pirates < pirateCap) spawnAtEdge(c, "pirate");
  // constabulary strength is per system, gated by the treasury (Этап 11b)
  const patrolCap = patrolStrength(c);
  if (!c.hereOccupied() && patrols < patrolCap) spawnAtEdge(c, "patrol");
  // «Варта»: a fat treasury commissions one heavy cruiser for the system
  if (!c.hereOccupied() && c.pools.patrol >= PATROL_ECON.TREASURY_FULL
    && !c.ships.some((s) => s.active && s.cruiser)) spawnCruiser(c);
  if (traders < POPULATION.TRADERS) spawnAtEdge(c, "trader");
  // clan haulers (Этап 8, 14с): уличный чёрный рынок открыт в каждом порту —
  // сходняк кормит кланов везде, а на клановой воде караванов вдвое гуще
  {
    const want = smuggleHere(c) ? SMUGGLER.COUNT : SMUGGLER.STREET_COUNT;
    let smugglers = 0;
    for (const s of c.ships) if (s.active && s.smuggler) smugglers++;
    if (smugglers < want) spawnSmuggler(c);
  }
}
