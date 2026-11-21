/**
 * world.mjs — общий шард (Этап 15b): присутствие игроков, ретрансляция состояний,
 * общие пулы экономики. Хранение — world.json рядом с сейвами.
 *
 * Протокол (JSON, текстовые кадры):
 *   клиент → сервер: { t: "state", x, y, a, sys, hull }   (троттлинг 20 Гц)
 *   сервер → клиент: { t: "welcome", id, players, world }
 *                    { t: "join", player }  { t: "leave", id }
 *                    { t: "state", id, ... }               (чужие состояния)
 *                    { t: "world", world }                 (пулы/онлайн, по изменению)
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STATE_MIN_INTERVAL_MS = 50; // не чаще 20 Гц на игрока
const MAX_PLAYERS = 200;
/** Этап 15: +1 000 000 ₡ за зарегистрированного игрока, в пулы пропорционально. */
export const POOL_TOPUP_PER_PLAYER = { patrol: 200_000, alliance: 260_000, clan: 140_000, stations: 400_000 };

const DEFAULT_WORLD = () => ({
  registered: 0,
  pools: { patrol: 0, alliance: 0, clan: 0, stations: 0 },
  updatedAt: 0,
});

export function createWorld(dataDir) {
  const worldFile = path.join(dataDir, "world.json");
  /** @type {Map<string, {id: string, username: string, conn: object, state: object|null, lastRelay: number}>} */
  const players = new Map();
  let world = DEFAULT_WORLD();
  let writeChain = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await readFile(worldFile, "utf8"));
      world = { ...DEFAULT_WORLD(), ...raw, pools: { ...DEFAULT_WORLD().pools, ...(raw.pools || {}) } };
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
    return { pools: world.pools, online: players.size, registered: world.registered, updatedAt: world.updatedAt };
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
    return [...players.values()].map((p) => ({ id: p.id, username: p.username, state: p.state }));
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
    return s;
  }

  function handleConnection(conn, username) {
    if (players.size >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ t: "error", error: "shard_full" }));
      return conn.close();
    }
    const player = { id: conn.id, username, conn, state: null, lastRelay: 0 };
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
      if (msg?.t !== "state") return;
      const now = Date.now();
      if (now - player.lastRelay < STATE_MIN_INTERVAL_MS) return; // троттлинг 20 Гц
      const s = sanitizeState(msg);
      if (!s) return;
      player.lastRelay = now;
      player.state = s;
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
