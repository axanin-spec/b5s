/**
 * economy.ts — Этап 9a: денежный контур, рыночные модификаторы и радио-торговля,
 * вынесенные из монолита Game. Всё работает на структурном контексте EconCtx —
 * Game просто передаёт себя. Здесь нет UI: всплывашки и звук приходят колбэками
 * через контекст, чтобы модуль оставался тестируемым без canvas.
 */

import { BLACK_STREET, CLAN_ONLY_GOODS, ECONOMY, GOODS, MONEY_TOTAL, OCCUPATION, PIRATE_BRANCH, REP, TRADER_AI } from "./config";
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

/** Товар из клановой тройки (14g): на союзной бирже не значится, но с 14с
 *  уходит из-под прилавка в любом порту — по уличным ценам и через клановую кассу. */
export function isClanOnlyGood(goodId: string): boolean {
  return CLAN_ONLY_GOODS.includes(goodId);
}

/**
 * Касса сделок: на клановой земле — клановый фонд; в союзном доку обычным
 * товарам — станционная касса, а клановой тройке (14с) — тоже клановая:
 * уличный сходняк крутит свою наличность, Альянс делает вид, что не видит.
 */
export function tradePool(c: EconCtx, goodId?: string): PoolId {
  if (clanTurf(c, c.dockTarget)) return "clan";
  return goodId && isClanOnlyGood(goodId) ? "clan" : "stations";
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
 * 14с: в союзном доку уличный перекос получает только клановая тройка —
 * остальная биржа живёт по reputation-расценкам Альянса.
 */
export function priceMods(c: EconCtx, goodId?: string): { buy: number; sell: number } {
  const tm = tradeMod(c);
  if (clanTurf(c, c.dockTarget)) {
    const b = blackMods(c);
    return { buy: tm.buy * b.buy, sell: tm.sell * b.sell };
  }
  if (goodId && isClanOnlyGood(goodId)) {
    return { buy: tm.buy * BLACK_STREET.buy, sell: tm.sell * BLACK_STREET.sell };
  }
  return tm;
}

/**
 * Раскладка чёрного рынка по клановой репутации (Этап 6): «своим» кланы
 * продают дешевле и платят жирнее, с чужака не гонят, но и не любят.
 * Единая таблица для докового перекоса и радио бортников (13d).
 */
export function blackMods(c: EconCtx): { buy: number; sell: number } {
  return c.player.rep.clan >= REP.FRIENDLY ? PIRATE_BRANCH.BLACK_FRIEND
    : c.player.rep.clan <= REP.UNFRIENDLY ? PIRATE_BRANCH.BLACK_COLD
    : OCCUPATION.BLACK;
}

/* ------------------------------------------------------------------ */
/* Радио-торговля: караваны (Этап 5b) и чёрный рынок в эфире (13d)     */
/* ------------------------------------------------------------------ */

/**
 * Ближайшее торговое судно на связи. С 13d бортники кланов тоже в эфире —
 * у них свой канал (клановые расценки), поэтому просто участвуют в выборе;
 * что за борт отвечает радио — решает флаг smuggler в radioData/сделках.
 */
export function radioIdx(c: EconCtx): number {
  const p = c.ships[0];
  let best = -1, bestD: number = TRADER_AI.RADIO_RANGE;
  for (let i = 1; i < c.ships.length; i++) {
    const s = c.ships[i];
    if (!s.active || s.faction !== "trader") continue;
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

/**
 * Radio offer: the caravan quotes against the market it last left (Этап 5b).
 * 13d: бортник кланов — тот же эфир, но чёрный: тройка в прилавке, расценки
 * клановой раскладки (для «своих» — жирнее), отсчёт от кланового дока.
 */
export function radioData(c: RadioCtx): RadioSnapshot | null {
  const i = radioIdx(c);
  if (i < 0) return null;
  const s = c.ships[i];
  const clan = !!s.smuggler;
  const m = blackMods(c);
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const sells: RadioSnapshot["sells"] = [];
  const buys: RadioSnapshot["buys"] = [];
  const room = TRADER_AI.HOLD - traderLoad(s);
  for (const g of GOODS) {
    // 14g/14с: зарегистрированный караван «неучтёнку» на борт не берёт —
    // уличный сходняк живёт вне караванного эфира; бортник (13d) — и есть сходняк
    if (isClanOnlyGood(g.id) && !clan) continue;
    const base = priceOf(home, g.id);
    const q = Math.round(s.cargo[g.id] ?? 0);
    if (q > 0) {
      const unit = Math.max(1, Math.round(base * (clan ? m.buy : TRADER_AI.RADIO_SELL)));
      sells.push({ goodId: g.id, name: g.name, qty: q, unit });
    }
    const have = c.player.cargo[g.id] ?? 0;
    if (have > 0 && room > 0) {
      const unit = Math.max(1, Math.round(base * (clan ? m.sell : TRADER_AI.RADIO_BUY)));
      const maxQty = Math.min(have, room, Math.floor(Math.max(0, s.wallet) / unit));
      if (maxQty > 0) buys.push({ goodId: g.id, name: g.name, unit, maxQty });
    }
  }
  // 14а: класс из реестра виден в шапке радио — ветеранов узнают по позывному и букве
  return { shipIdx: i, name: s.name || (clan ? "Бортник" : "Караван"), tier: s.tier, clan: clan || undefined, sells, buys, wallet: Math.round(s.wallet), holdFree: Math.max(0, room) };
}

/**
 * Radio purchase: credits go straight into the caravan's pocket — pools untouched (5b).
 * Сделка с бортником (13d) — тоже мимо казн: его кошелёк и так клановый float
 * (smugglerFloat), инвариант ₡ держится; вне биржи — тарифа нет.
 */
export function radioBuy(c: RadioCtx, shipIdx: number, goodId: string, qty: number): boolean {
  const s = c.ships[shipIdx];
  if (!s || !s.active || s.faction !== "trader") return false;
  const clan = !!s.smuggler;
  if (isClanOnlyGood(goodId) && !clan) return false; // 14g: борт каравана контрабанды не видит
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const unit = Math.max(1, Math.round(priceOf(home, goodId) * (clan ? blackMods(c).buy : TRADER_AI.RADIO_SELL)));
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

/** Radio sale: the caravan pays from its wallet and stows the goods in its hold (5b);
 *  у бортника (13d) кошелёк клановый, расценка чёрная — платит жирнее биржи. */
export function radioSell(c: RadioCtx, shipIdx: number, goodId: string, qty: number): boolean {
  const s = c.ships[shipIdx];
  if (!s || !s.active || s.faction !== "trader") return false;
  const clan = !!s.smuggler;
  if (isClanOnlyGood(goodId) && !clan) return false; // 14g: борт каравана контрабанды не видит
  const home = c.dockables[Math.min(Math.max(s.routeFrom, 0), c.dockables.length - 1)];
  const unit = Math.max(1, Math.round(priceOf(home, goodId) * (clan ? blackMods(c).sell : TRADER_AI.RADIO_BUY)));
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
