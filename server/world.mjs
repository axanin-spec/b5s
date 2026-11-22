/**
 * world.mjs — общий шард (Этап 15b): присутствие игроков, ретрансляция состояний,
 * общие пулы экономики. Хранение — world.json рядом с сейвами.
 *
 * Этап 15c (сервер): PvP-события с мягкой серверной верификацией. Сервер не
 * симулирует баллистику — он проверяет СОГЛАСОВАННОСТЬ (дистанция по последним
 * ретранслированным state, лимит темпа, кап урона) и ведёт оценку hp, чтобы
 * единолично объявлять смерть/респаун. Читерская точность здесь не важна:
 * деньги двигает только ledger.mjs, а не боевые события.
 *
 * Протокол (JSON, текстовые кадры):
 *   клиент → сервер: { t: "state", x, y, a, sys, hull, hp?, maxHp? }  (20 Гц)
 *                    { t: "hit", target, dmg }                        (верифицируется)
 *   сервер → клиент: { t: "welcome", id, players, world }
 *                    { t: "join", player }  { t: "leave", id }
 *                    { t: "state", id, ... }               (чужие состояния)
 *                    { t: "world", world }                 (пулы/онлайн, по изменению)
 *                    { t: "hit", id, from, dmg, hp }       (id — цель, hp — оценка)
 *                    { t: "kill", id, by }                 (смерть игрока id от by)
 *                    { t: "respawn", id }                  (игрок вернулся в строй)
 *
 * Торговля игрок↔игрок (15c, эскроу через ledger):
 *   клиент → сервер: { t: "trade_offer", id, to, giveCredits, wantCredits,
 *                      giveGoods?, wantGoods? }  — TTL 60 с, дистанция ≤ 1500
 *                    { t: "trade_accept", id } | { t: "trade_decline", id } |
 *                    { t: "trade_cancel", id } (инициатор)
 *   сервер → клиент: { t: "trade_offer", id, from, fromName, ... }  (адресату)
 *                    { t: "trade_done", id, ... }   (обоим; товары переходят
 *                                                   на клиентах, кредиты — ledger)
 *                    { t: "trade_fail", id, reason } | { t: "trade_declined", id } |
 *                    { t: "trade_cancelled", id }
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isTradeableId } from "./tradeable.mjs";

const STATE_MIN_INTERVAL_MS = 50; // не чаще 20 Гц на игрока
const MAX_PLAYERS = 200;
/** Этап 15: +1 000 000 ₡ за зарегистрированного игрока, в пулы пропорционально. */
export const POOL_TOPUP_PER_PLAYER = { patrol: 200_000, alliance: 260_000, clan: 140_000, stations: 400_000 };

// --- PvP-верификация (15c) ---
const HIT_MAX_DMG = 1000; // кап урона одного попадания
const HIT_MAX_RANGE = 3000; // мир. единицы между последними state атакующего и цели
const HIT_RATE_WINDOW_MS = 10_000;
const HIT_RATE_MAX = 30; // не более 30 попаданий за 10 с на атакующего
const OFFER_RATE_MAX = 10; // не более 10 торговых офферов в минуту на игрока
const OFFER_RATE_WINDOW_MS = 60_000;
const DEFAULT_HP = 100;
const KILLS_LOG_MAX = 50;

// --- торговля игрок↔игрок (15c) ---
const TRADE_TTL_MS = 60_000;
const TRADE_MAX_RANGE = 1500; // мир. единицы — «стыковочная» дистанция
const TRADE_MAX_PENDING_PER_PLAYER = 10;

const DEFAULT_WORLD = () => ({
  registered: 0,
  pools: { patrol: 0, alliance: 0, clan: 0, stations: 0 },
  kills: 0,
  killsLog: [],
  updatedAt: 0,
});

export function createWorld(dataDir, ledger) {
  const worldFile = path.join(dataDir, "world.json");
  /** @type {Map<string, {id, username, conn, state, lastRelay, dead, estHp, hitTimes}>} */
  const players = new Map();
  /** Активные торговые офферы (в памяти; рестарт = отмена незавершённых). */
  const trades = new Map();
  let world = DEFAULT_WORLD();
  let writeChain = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await readFile(worldFile, "utf8"));
      world = { ...DEFAULT_WORLD(), ...raw, pools: { ...DEFAULT_WORLD().pools, ...(raw.pools || {}) } };
      if (!Array.isArray(world.killsLog)) world.killsLog = [];
    } catch {
      // первый запуск — мир по умолчанию
    }
  }

  function persist() {
    writeChain = writeChain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = worldFile + ".tmp";
      await writeFile(tmp, JSON.stringify(world), "utf8");
      await rename(tmp, worldFile);
    });
    return writeChain;
  }

  function publicWorld() {
    return {
      pools: world.pools,
      online: players.size,
      registered: world.registered,
      kills: world.kills,
      updatedAt: world.updatedAt,
    };
  }

  function broadcast(msg, exceptId = null) {
    const text = JSON.stringify(msg);
    for (const p of players.values()) {
      if (p.id !== exceptId && p.conn.alive) p.conn.send(text);
    }
  }

  /**
   * Ретрансляция state только игрокам той же системы (убирает O(N²) шум при росте онлайна).
   * Игроки без state/sys (старые клиенты, тесты) получают всё — обратная совместимость.
   */
  function broadcastState(msg, exceptId, sys) {
    const text = JSON.stringify(msg);
    for (const p of players.values()) {
      if (p.id === exceptId || !p.conn.alive) continue;
      const pSys = p.state?.sys;
      if (sys && pSys && pSys !== sys) continue;
      p.conn.send(text);
    }
  }

  function broadcastWorld() {
    broadcast({ t: "world", world: publicWorld() });
  }

  /** Регистрация игрока: счётчик + пропорциональная подпитка пулов (+1M ₡ суммарно). */
  async function onRegistration() {
    world.registered += 1;
    for (const [k, v] of Object.entries(POOL_TOPUP_PER_PLAYER)) {
      world.pools[k] = (world.pools[k] || 0) + v;
    }
    world.updatedAt = Date.now();
    await persist();
    broadcastWorld();
  }

  function roster() {
    return [...players.values()].map((p) => ({
      id: p.id,
      username: p.username,
      state: p.state,
      ...(p.dead ? { dead: true } : {}),
    }));
  }

  function sanitizeState(msg) {
    const s = {};
    for (const k of ["x", "y", "a"]) {
      const v = Number(msg[k]);
      if (!Number.isFinite(v)) return null;
      s[k] = Math.round(v * 100) / 100;
    }
    for (const k of ["sys", "hull"]) {
      if (msg[k] === undefined) continue;
      const v = String(msg[k]);
      if (v.length > 64) return null;
      s[k] = v;
    }
    // 15c: здоровье для серверной оценки боёв (необязательно)
    for (const k of ["hp", "maxHp"]) {
      if (msg[k] === undefined) continue;
      const v = Number(msg[k]);
      if (!Number.isFinite(v) || v < 0 || v > 1e6) return null;
      s[k] = Math.round(v);
    }
    // 13e: титул победителя галактики — булево, виден всем в оверлее
    if (msg.legend !== undefined) s.legend = !!msg.legend;
    return s;
  }

  /** PvP: верификация и применение попадания. Молча игнорирует невалидное. */
  function handleHit(attacker, msg) {
    const targetId = String(msg.target || "");
    const dmg = Math.round(Number(msg.dmg));
    if (!targetId || targetId === attacker.id) return;
    if (!Number.isInteger(dmg) || dmg <= 0 || dmg > HIT_MAX_DMG) return;
    const target = players.get(targetId);
    if (!target || target.dead) return;
    const a = attacker.state;
    const b = target.state;
    if (!a || !b) return;
    // одна система (если оба репортят) и дистанция по последним state
    if (a.sys && b.sys && a.sys !== b.sys) return;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    if (dx * dx + dy * dy > HIT_MAX_RANGE * HIT_MAX_RANGE) return;
    // темп огня
    const now = Date.now();
    attacker.hitTimes = attacker.hitTimes.filter((t) => now - t < HIT_RATE_WINDOW_MS);
    if (attacker.hitTimes.length >= HIT_RATE_MAX) return;
    attacker.hitTimes.push(now);

    // оценка hp цели: от последнего репортованного, иначе DEFAULT_HP
    if (target.estHp === null) target.estHp = typeof b.hp === "number" ? b.hp : DEFAULT_HP;
    target.estHp -= dmg;
    broadcast({ t: "hit", id: target.id, from: attacker.id, dmg, hp: Math.max(0, target.estHp) });

    if (target.estHp <= 0) {
      target.dead = true;
      target.estHp = null;
      world.kills += 1;
      world.killsLog.push({ t: now, by: attacker.username, victim: target.username, sys: b.sys || "" });
      if (world.killsLog.length > KILLS_LOG_MAX) world.killsLog.shift();
      world.updatedAt = now;
      persist();
      broadcast({ t: "kill", id: target.id, by: attacker.id });
      broadcastWorld();
    }
  }

  // ---------- торговля игрок↔игрок (15c) ----------

  function sweepTrades() {
    const now = Date.now();
    for (const [id, tr] of trades) {
      if (tr.expires < now) {
        trades.delete(id);
        notifyTrade(tr, { t: "trade_fail", id, reason: "expired" });
      }
    }
  }

  function notifyTrade(tr, msg) {
    const text = JSON.stringify(msg);
    players.get(tr.fromId)?.conn.send(text);
    players.get(tr.toId)?.conn.send(text);
  }

  function sanitizeGoods(g) {
    if (g === undefined || g === null) return {};
    if (typeof g !== "object" || Array.isArray(g)) return null;
    const keys = Object.keys(g);
    if (keys.length > 20) return null;
    const out = {};
    for (const k of keys) {
      if (!isTradeableId(k)) return null; // whitelist: только реальные товары/модули игры
      const q = Number(g[k]);
      if (!Number.isInteger(q) || q <= 0 || q > 100000) return null;
      out[k] = q;
    }
    return out;
  }

  function handleTradeOffer(player, msg) {
    sweepTrades();
    // анти-спам: не более OFFER_RATE_MAX офферов в минуту
    const now0 = Date.now();
    player.offerTimes = player.offerTimes.filter((t) => now0 - t < OFFER_RATE_WINDOW_MS);
    if (player.offerTimes.length >= OFFER_RATE_MAX) return;
    player.offerTimes.push(now0);
    const id = String(msg.id || "");
    if (id.length < 8 || id.length > 80 || trades.has(id)) return;
    const target = players.get(String(msg.to || ""));
    if (!target || target.id === player.id || target.dead) return;
    const giveCredits = Math.round(Number(msg.giveCredits) || 0);
    const wantCredits = Math.round(Number(msg.wantCredits) || 0);
    if (giveCredits < 0 || giveCredits > 1e9 || wantCredits < 0 || wantCredits > 1e9) return;
    const giveGoods = sanitizeGoods(msg.giveGoods);
    const wantGoods = sanitizeGoods(msg.wantGoods);
    if (!giveGoods || !wantGoods) return;
    if (!giveCredits && !wantCredits && !Object.keys(giveGoods).length && !Object.keys(wantGoods).length) return;
    // рядом и в одной системе
    const a = player.state;
    const b = target.state;
    if (!a || !b) return;
    if (a.sys && b.sys && a.sys !== b.sys) return;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    if (dx * dx + dy * dy > TRADE_MAX_RANGE * TRADE_MAX_RANGE) return;
    // лимит незавершённых офферов на игрока
    let pending = 0;
    for (const tr of trades.values()) if (tr.fromId === player.id || tr.toId === player.id) pending++;
    if (pending >= TRADE_MAX_PENDING_PER_PLAYER) return;

    const tr = {
      id, fromId: player.id, toId: target.id,
      giveCredits, wantCredits, giveGoods, wantGoods,
      expires: Date.now() + TRADE_TTL_MS,
    };
    trades.set(id, tr);
    target.conn.send(JSON.stringify({
      t: "trade_offer", id, from: player.id, fromName: player.username,
      giveCredits, wantCredits, giveGoods, wantGoods,
    }));
  }

  async function handleTradeAccept(player, msg) {
    sweepTrades();
    const tr = trades.get(String(msg.id || ""));
    if (!tr || tr.toId !== player.id) return;
    trades.delete(tr.id);
    const from = players.get(tr.fromId);
    if (!from) return notifyTrade(tr, { t: "trade_fail", id: tr.id, reason: "offline" });
    try {
      // эскроу: встречные переводы атомарно; товары переходят на клиентах по trade_done
      await ledger.executeTrade({
        idA: `${tr.id}-a`, idB: `${tr.id}-b`,
        fromA: `player:${from.username}`, toB: `player:${player.username}`,
        amountA: tr.giveCredits, amountB: tr.wantCredits,
        reason: `trade:${from.username}↔${player.username}`,
      });
      notifyTrade(tr, {
        t: "trade_done", id: tr.id, from: tr.fromId, to: tr.toId,
        giveCredits: tr.giveCredits, wantCredits: tr.wantCredits,
        giveGoods: tr.giveGoods, wantGoods: tr.wantGoods,
      });
    } catch (e) {
      notifyTrade(tr, { t: "trade_fail", id: tr.id, reason: e?.code || "error" });
    }
  }

  function handleTradeDecline(player, msg) {
    sweepTrades();
    const tr = trades.get(String(msg.id || ""));
    if (!tr || tr.toId !== player.id) return;
    trades.delete(tr.id);
    notifyTrade(tr, { t: "trade_declined", id: tr.id });
  }

  function handleTradeCancel(player, msg) {
    sweepTrades();
    const tr = trades.get(String(msg.id || ""));
    if (!tr || tr.fromId !== player.id) return;
    trades.delete(tr.id);
    notifyTrade(tr, { t: "trade_cancelled", id: tr.id });
  }

  function handleConnection(conn, username) {
    if (players.size >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ t: "error", error: "shard_full" }));
      return conn.close();
    }
    const player = { id: conn.id, username, conn, state: null, lastRelay: 0, dead: false, estHp: null, hitTimes: [], offerTimes: [] };
    players.set(conn.id, player);

    conn.send(JSON.stringify({ t: "welcome", id: conn.id, players: roster(), world: publicWorld() }));
    broadcast({ t: "join", player: { id: conn.id, username, state: null } }, conn.id);

    conn.onMessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.t === "hit") return handleHit(player, msg);
      if (msg?.t === "trade_offer") return void handleTradeOffer(player, msg);
      if (msg?.t === "trade_accept") return void handleTradeAccept(player, msg);
      if (msg?.t === "trade_decline") return void handleTradeDecline(player, msg);
      if (msg?.t === "trade_cancel") return void handleTradeCancel(player, msg);
      if (msg?.t !== "state") return;
      const now = Date.now();
      if (now - player.lastRelay < STATE_MIN_INTERVAL_MS) return; // троттлинг 20 Гц
      const s = sanitizeState(msg);
      if (!s) return;
      player.lastRelay = now;
      player.state = s;
      // респаун: мёртвый игрок снова шлёт state — возвращаем в строй
      if (player.dead) {
        player.dead = false;
        player.estHp = typeof s.hp === "number" ? s.hp : DEFAULT_HP;
        broadcast({ t: "respawn", id: conn.id });
      } else if (typeof s.hp === "number") {
        player.estHp = s.hp; // свежая правда о собственном здоровье
      }
      broadcastState({ t: "state", id: conn.id, ...s }, conn.id, s.sys || null);
    };

    conn.onClose = () => {
      if (!players.delete(conn.id)) return;
      // незавершённые сделки с участником отменяются
      for (const [id, tr] of trades) {
        if (tr.fromId === conn.id || tr.toId === conn.id) {
          trades.delete(id);
          notifyTrade(tr, { t: "trade_fail", id, reason: "offline" });
        }
      }
      broadcast({ t: "leave", id: conn.id });
      broadcastWorld(); // online изменился
    };
  }

  return { load, onRegistration, handleConnection, publicWorld, get size() { return players.size; } };
}
