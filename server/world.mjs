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
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STATE_MIN_INTERVAL_MS = 50; // не чаще 20 Гц на игрока
const MAX_PLAYERS = 200;
/** Этап 15: +1 000 000 ₡ за зарегистрированного игрока, в пулы пропорционально. */
export const POOL_TOPUP_PER_PLAYER = { patrol: 200_000, alliance: 260_000, clan: 140_000, stations: 400_000 };

// --- PvP-верификация (15c) ---
const HIT_MAX_DMG = 1000; // кап урона одного попадания
const HIT_MAX_RANGE = 3000; // мир. единицы между последними state атакующего и цели
const HIT_RATE_WINDOW_MS = 10_000;
const HIT_RATE_MAX = 30; // не более 30 попаданий за 10 с на атакующего
const DEFAULT_HP = 100;
const KILLS_LOG_MAX = 50;

const DEFAULT_WORLD = () => ({
  registered: 0,
  pools: { patrol: 0, alliance: 0, clan: 0, stations: 0 },
  kills: 0,
  killsLog: [],
  updatedAt: 0,
});

export function createWorld(dataDir) {
  const worldFile = path.join(dataDir, "world.json");
  /** @type {Map<string, {id, username, conn, state, lastRelay, dead, estHp, hitTimes}>} */
  const players = new Map();
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

  function handleConnection(conn, username) {
    if (players.size >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ t: "error", error: "shard_full" }));
      return conn.close();
    }
    const player = { id: conn.id, username, conn, state: null, lastRelay: 0, dead: false, estHp: null, hitTimes: [] };
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
      broadcast({ t: "state", id: conn.id, ...s }, conn.id);
    };

    conn.onClose = () => {
      if (!players.delete(conn.id)) return;
      broadcast({ t: "leave", id: conn.id });
      broadcastWorld(); // online изменился
    };
  }

  return { load, onRegistration, handleConnection, publicWorld, get size() { return players.size; } };
}
