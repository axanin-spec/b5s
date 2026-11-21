/**
 * economy.ts — Этап 9a: денежный контур, рыночные модификаторы и радио-торговля,
 * вынесенные из монолита Game. Всё работает на структурном контексте EconCtx —
 * Game просто передаёт себя. Здесь нет UI: всплывашки и звук приходят колбэками
 * через контекст, чтобы модуль оставался тестируемым без canvas.
 */

import { CLAN_ONLY_GOODS, ECONOMY, GOODS, MONEY_TOTAL, OCCUPATION, PIRATE_BRANCH, REP, TRADER_AI } from "./config";
import type { Dockable, MoneyPools, PlayerState, PoolId, Ship } from "./types";
import type { RadioSnapshot } from "./uiBridge";
import { priceOf } from "./world";

/** Структурный хозяин денежного контура: казна, игрок, корабли и точка дока. */
export interface EconCtx {
  pools: MoneyPools;
  player: PlayerState;
  ships: Ship[];
  dockTarget: Dockable | null;
  hereOccupied(): boolean;
}

/** Контекст радио-торговли: экономика + трюмы/кошельки + побочные эффекты UI. */
export interface RadioCtx extends EconCtx {
  dockables: Dockable[];
  cargoMax(): number;
  cargoUsed(): number;
  floater(x: number, y: number, text: string, c: string): void;
  audio: { sfx(name: string): void };
  pushHud(): void;
}

/** Pay the player from a treasury; a drained pool deflates the payout. Returns what was actually paid. */
export function gain(c: EconCtx, n: number, pool: PoolId): number {
  const paid = Math.max(0, Math.min(Math.round(n), Math.round(c.pools[pool])));
  c.pools[pool] -= paid;
  c.player.credits += paid;
  return paid;
}

/** Spend player credits into a treasury — the mirror of gain(). */
export function pay(c: EconCtx, n: number, pool: PoolId): void {
  const spent = Math.round(n);
  c.player.credits -= spent;
  c.pools[pool] += spent;
}

/** Клановая земля: оккупированная система или Логово — один источник правды для
 *  кассы, цен и контрабандного гейджа (14g). */
export function clanTurf(c: EconCtx, d: Dockable | null): boolean {
  return !!d && (c.hereOccupied() || d.id === PIRATE_BRANCH.LAIR.id);
}

/** Товар из клановой тройки (14g): в союзных доках не торгуется вообще. */
export function isClanOnlyGood(goodId: string): boolean {
  return CLAN_ONLY_GOODS.includes(goodId);
}

/** Гейдж 14g: контрабанда в союзном доку — сделку не проводить. */
export function clanOnlyBlocked(c: EconCtx, d: Dockable | null, goodId: string): boolean {
  return isClanOnlyGood(goodId) && !clanTurf(c, d);
}

/** Treasury a docked trade runs through: smuggler cash on clan turf, civilian capital elsewhere. */
export function tradePool(c: EconCtx): PoolId {
  return clanTurf(c, c.dockTarget) ? "clan" : "stations";
}

/** Player's share of the galaxy's fixed credit mass (0..1) — the economic victory meter. */
export function sharePct(c: EconCtx): number {
  return c.player.credits / MONEY_TOTAL;
}

/**
 * Credits sitting in traders' wallets (Этап 5b). This is Alliance money on loan:
 * drawn from pools.alliance at spawn, returned at freeShip, pocketed by the player on a kill.
 * Clan haulers (Этап 8) are excluded — their stake is clan money, see smugglerFloat().
 */
export function traderFloat(c: EconCtx): number {
  let f = 0;
  for (const s of c.ships) if (s.active && s.faction === "trader" && !s.smuggler) f += Math.round(s.wallet);
  return f;
}

/** Clan hauler wallets in flight (Этап 8): clan money on loan, returned at freeShip. */
export function smugglerFloat(c: EconCtx): number {
  let f = 0;
  for (const s of c.ships) if (s.active && s.faction === "trader" && s.smuggler) f += Math.round(s.wallet);
  return f;
}

/** Debug/QA: the closed-circulation invariant. delta must stay 0 — see the balance autotest. */
export function econAudit(c: EconCtx): { total: number; player: number; pools: MoneyPools; traderFloat: number; delta: number } {
  const sum = c.pools.patrol + c.pools.alliance + c.pools.clan + c.pools.stations;
  const float = traderFloat(c) + smugglerFloat(c);
  const player = Math.round(c.player.credits);
  return { total: MONEY_TOTAL, player, pools: { ...c.pools }, traderFloat: float, delta: sum + float + player - MONEY_TOTAL };
}

/** Trade volume nudges the local price (Этап 5b / игрок — PLAYER_FLUCT_PUSH). */
export function pushFluct(d: Dockable, goodId: string, delta: number): void {
  const cur = d.fluct[goodId] ?? 1;
  d.fluct[goodId] = Math.min(ECONOMY.FLUCT_MAX, Math.max(ECONOMY.FLUCT_MIN, cur + delta));
}

/**
 * Патрульный тариф (Этап 13a): гражданский оборот облагается в пользу казны —
 * бойкая торговля жирнит патруль (и крейсер «Варта» возвращается на дозор).
 * Вызывать после сделки с фактическим оборотом; платит станция из маржи,
 * цены игрока не тронуты. На чёрном рынке тарифа нет: клановая касса и есть
 * рынок — их доля уже вся маржа. Радио-сделки (10c) вне биржи — не облагаются.
 * Инвариант ₡ сохранён: деньги те же, адресат другой. Возвращает собранное.
 */
export function levy(c: EconCtx, gross: number, pool: PoolId): number {
  if (pool !== "stations") return 0;
  const t = Math.min(Math.round(gross * ECONOMY.TARIFF), Math.round(c.pools.stations));
  if (t <= 0) return 0;
  c.pools.stations -= t;
  c.pools.patrol += t;
  return t;
}

/** Репутационный множитель цен Альянса. */
export function tradeMod(c: EconCtx): { buy: number; sell: number } {
  if (c.player.rep.trader >= REP.FRIENDLY) return REP.PRICE_FRIENDLY;
  if (c.player.rep.trader <= REP.UNFRIENDLY) return REP.PRICE_UNFRIENDLY;
  return { buy: 1, sell: 1 };
}

/**
 * Live trade multipliers: reputation bracket + black-market skew when the clans
 * hold the system. Single source of truth — the terminal and the till must agree.
 * On clan turf the clan standing bends the skew too (Этап 6).
 */
export function priceMods(c: EconCtx): { buy: number; sell: number } {
  const tm = tradeMod(c);
  if (clanTurf(c, c.dockTarget)) {
    const b = c.player.rep.clan >= REP.FRIENDLY ? PIRATE_BRANCH.BLACK_FRIEND
      : c.player.rep.clan <= REP.UNFRIENDLY ? PIRATE_BRANCH.BLACK_COLD
      : OCCUPATION.BLACK;
    return { buy: tm.buy * b.buy, sell: tm.sell * b.sell };
  }
  return tm;
}

/* ------------------------------------------------------------------ */
/* Радио-торговля с караванами (Этап 5b)                               */
/* ------------------------------------------------------------------ */

/** Ближайший караван на связи; бортники не выходят в эфир Альянса (Этап 8). */
export function radioIdx(c: EconCtx): number {
  const p = c.ships[0];
  let best = -1, bestD: number = TRADER_AI.RADIO_RANGE;
  for (let i = 1; i < c.ships.length; i++) {
    const s = c.ships[i];
    if (!s.active || s.faction !== "trader") continue;
    if (s.smuggler) continue;
    const dd = Math.hypot(s.x - p.x, s.y - p.y) - s.radius;
    if (dd <= bestD) { bestD = dd; best = i; }
  }
  return best;
}

function traderLoad(s: Ship): number {
  let n = 0;
  for (const g of GOODS) n += Math.round(s.cargo[g.id] ?? 0);
  return n;
}

/** Radio offer: the caravan quotes against the market it last left (Этап 5b). */
export function radioData(c: RadioCtx): RadioSnapshot | null {
  const i = radioIdx(c);
  if (i < 0) return null;
  const s = c.ships[i];
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const sells: RadioSnapshot["sells"] = [];
  const buys: RadioSnapshot["buys"] = [];
  const room = TRADER_AI.HOLD - traderLoad(s);
  for (const g of GOODS) {
    // 14g: зарегистрированный караван «неучтёнку» на борт не берёт —
    // контрабанда ходит только через клановые причалы
    if (isClanOnlyGood(g.id)) continue;
    const base = priceOf(home, g.id);
    const q = Math.round(s.cargo[g.id] ?? 0);
    if (q > 0) {
      const unit = Math.max(1, Math.round(base * TRADER_AI.RADIO_SELL));
      sells.push({ goodId: g.id, name: g.name, qty: q, unit });
    }
    const have = c.player.cargo[g.id] ?? 0;
    if (have > 0 && room > 0) {
      const unit = Math.max(1, Math.round(base * TRADER_AI.RADIO_BUY));
      const maxQty = Math.min(have, room, Math.floor(Math.max(0, s.wallet) / unit));
      if (maxQty > 0) buys.push({ goodId: g.id, name: g.name, unit, maxQty });
    }
  }
  return { shipIdx: i, name: s.name || "Караван", sells, buys, wallet: Math.round(s.wallet), holdFree: Math.max(0, room) };
}

/** Radio purchase: credits go straight into the caravan's pocket — pools untouched (5b). */
export function radioBuy(c: RadioCtx, shipIdx: number, goodId: string, qty: number): boolean {
  const s = c.ships[shipIdx];
  if (!s || !s.active || s.faction !== "trader") return false;
  if (isClanOnlyGood(goodId)) return false; // 14g: борт каравана контрабанды не видит
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const unit = Math.max(1, Math.round(priceOf(home, goodId) * TRADER_AI.RADIO_SELL));
  const n = Math.max(0, Math.min(
    Math.floor(qty),
    Math.round(s.cargo[goodId] ?? 0),
    c.cargoMax() - c.cargoUsed(),
    Math.floor(c.player.credits / unit),
  ));
  if (n <= 0) return false;
  c.player.credits -= n * unit;
  s.wallet += n * unit;
  s.cargo[goodId] = Math.round((s.cargo[goodId] ?? 0) - n);
  if (s.cargo[goodId] <= 0) delete s.cargo[goodId];
  c.player.cargo[goodId] = (c.player.cargo[goodId] ?? 0) + n;
  c.player.traded += 1;
  c.floater(s.x, s.y, `−₡${n * unit}`, "#9fb6c6");
  c.audio.sfx("trade");
  c.pushHud();
  return true;
}

/** Radio sale: the caravan pays from its wallet and stows the goods in its hold (5b). */
export function radioSell(c: RadioCtx, shipIdx: number, goodId: string, qty: number): boolean {
  const s = c.ships[shipIdx];
  if (!s || !s.active || s.faction !== "trader") return false;
  if (isClanOnlyGood(goodId)) return false; // 14g: борт каравана контрабанды не видит
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const unit = Math.max(1, Math.round(priceOf(home, goodId) * TRADER_AI.RADIO_BUY));
  const n = Math.max(0, Math.min(
    Math.floor(qty),
    c.player.cargo[goodId] ?? 0,
    TRADER_AI.HOLD - traderLoad(s),
    Math.floor(Math.max(0, s.wallet) / unit),
  ));
  if (n <= 0) return false;
  s.wallet -= n * unit;
  c.player.credits += n * unit;
  c.player.earned += n * unit;
  c.player.cargo[goodId] = (c.player.cargo[goodId] ?? 0) - n;
  if (c.player.cargo[goodId] <= 0) delete c.player.cargo[goodId];
  s.cargo[goodId] = (s.cargo[goodId] ?? 0) + n;
  c.player.traded += 1;
  c.floater(s.x, s.y, `+₡${n * unit}`, "#ffd24a");
  c.audio.sfx("trade");
  c.pushHud();
  return true;
}
