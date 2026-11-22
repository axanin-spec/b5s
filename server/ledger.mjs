/**
 * ledger.mjs — авторитет сервера по деньгам (Этап 15c, серверная часть).
 *
 * Счета: "player:<username>" и "pool:patrol|alliance|clan|stations".
 * Журнал append-only (journal.jsonl), снапшот балансов (balances.json).
 * Идемпотентность: клиент даёт tx id (UUID); повтор с тем же id возвращает
 * исходный результат без повторного проведения.
 *
 * Правила MVP (до полной валидации игровых событий):
 * - POST /api/tx: списание ТОЛЬКО со своего player-счёта (торговля игрок↔игрок,
 *   отчисления в пулы). Игрок не может уйти в минус.
 * - POST /api/grant: пул → игрок (награды). ВРЕМЕННО доверенный вызов с
 *   почасовым лимитом на игрока — до валидации событий на сервере.
 * - Пулы могут уходить в долг до -1e12 (клановая казна по правилам игры).
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export const POOL_NAMES = ["patrol", "alliance", "clan", "stations"];
const MAX_AMOUNT = 1e9;
const POOL_DEBT_FLOOR = -1e12;
const GRANT_HOURLY_CAP = 500_000; // анти-абьюз до серверной валидации событий
const ACCOUNT_RE = /^(player:[\p{L}\p{N}_-]{3,24}|pool:(patrol|alliance|clan|stations))$/u;

export function createLedger(dataDir) {
  const balancesFile = path.join(dataDir, "balances.json");
  const journalFile = path.join(dataDir, "journal.jsonl");

  const balances = new Map(); // account -> number
  const byId = new Map(); // tx id -> journal entry
  let lastSeq = 0;
  let chain = Promise.resolve();
  const grantWindow = { hour: -1, perPlayer: new Map() }; // анти-абьюз счётчики

  const balanceOf = (acc) => balances.get(acc) ?? 0;

  /** Сериализация операций; shared chain никогда не уходит в rejected. */
  function mutex(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  function apply(e) {
    balances.set(e.from, balanceOf(e.from) - e.amount);
    balances.set(e.to, balanceOf(e.to) + e.amount);
    lastSeq = Math.max(lastSeq, e.seq);
  }

  async function load(seedPools) {
    await mkdir(dataDir, { recursive: true });
    let snapshot = null;
    try {
      snapshot = JSON.parse(await readFile(balancesFile, "utf8"));
    } catch {}
    if (snapshot?.accounts) {
      lastSeq = snapshot.seq || 0;
      for (const [k, v] of Object.entries(snapshot.accounts)) balances.set(k, v);
      // догон журналом за снапшотом
      try {
        for (const line of (await readFile(journalFile, "utf8")).split("\n").filter(Boolean)) {
          try { // одна битая строка не должна ронять replay остатка журнала
            const e = JSON.parse(line);
            if (e.seq > lastSeq) apply(e);
            byId.set(e.id, e);
          } catch {}
        }
      } catch {}
      return;
    }
    // снапшота нет — перечитываем журнал целиком
    let replayed = false;
    try {
      for (const line of (await readFile(journalFile, "utf8")).split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          apply(e);
          byId.set(e.id, e);
          replayed = true;
        } catch {}
      }
    } catch {}
    if (replayed) return;
    // холодный старт: пулы = накопленные «+1M за регистрации» из world.json
    for (const name of POOL_NAMES) {
      balances.set(`pool:${name}`, Math.round(seedPools?.[name] ?? 0));
    }
    await persist();
  }

  function persist() {
    return mutex(async () => {
      const tmp = balancesFile + ".tmp";
      await writeFile(tmp, JSON.stringify({ seq: lastSeq, accounts: Object.fromEntries(balances) }), "utf8");
      await rename(tmp, balancesFile);
    });
  }

  /**
   * Провести транзакцию. Возвращает { entry, dedup } либо бросает { code }.
   * actor — username из токена; kind: "tx" (свои деньги) | "grant" (пул→игрок).
   */
  function transact(actor, kind, { id, from, to, amount, reason }) {
    if (typeof id !== "string" || id.length < 8 || id.length > 64) throw { code: "bad_id" };
    if (!ACCOUNT_RE.test(from) || !ACCOUNT_RE.test(to) || from === to) throw { code: "bad_accounts" };
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) throw { code: "bad_amount" };
    if (kind === "tx" && from !== `player:${actor}`) throw { code: "forbidden" };
    if (kind === "grant" && (!from.startsWith("pool:") || !to.startsWith("player:"))) throw { code: "bad_accounts" };

    return mutex(async () => {
      const dup = byId.get(id);
      if (dup) return { entry: dup, dedup: true }; // идемпотентный повтор
      // анти-абьюз лимит грантов (проверка и расход — атомарно внутри mutex)
      if (kind === "grant") {
        const hour = Math.floor(Date.now() / 3_600_000);
        if (grantWindow.hour !== hour) {
          grantWindow.hour = hour;
          grantWindow.perPlayer.clear();
        }
        const used = grantWindow.perPlayer.get(actor) ?? 0;
        if (used + amount > GRANT_HOURLY_CAP) throw { code: "grant_cap" };
        grantWindow.perPlayer.set(actor, used + amount);
      }
      // средства: игрок в минус не уходит; пул — не глубже долгового пола
      const after = balanceOf(from) - amount;
      const floor = from.startsWith("pool:") ? POOL_DEBT_FLOOR : 0;
      if (after < floor) throw { code: "insufficient_funds" };
      const entry = {
        id,
        seq: lastSeq + 1,
        t: Date.now(),
        kind,
        from,
        to,
        amount,
        reason: typeof reason === "string" ? reason.slice(0, 140) : "",
      };
      apply(entry);
      byId.set(id, entry);
      await appendFile(journalFile, JSON.stringify(entry) + "\n", "utf8");
      const tmp = balancesFile + ".tmp";
      await writeFile(tmp, JSON.stringify({ seq: lastSeq, accounts: Object.fromEntries(balances) }), "utf8");
      await rename(tmp, balancesFile);
      return { entry, dedup: false };
    });
  }

  /**
   * Эмиссия за регистрацию (Этап 15): мир зовёт при каждом новом игроке.
   * Источник — служебный счёт "system" (уходит в минус: эмиссия, не перевод).
   */
  function systemTopup(deltaPools, reason = "") {
    return mutex(async () => {
      for (const [name, amount] of Object.entries(deltaPools)) {
        if (!POOL_NAMES.includes(name) || !Number.isInteger(amount) || amount <= 0) continue;
        const entry = {
          id: `sys-${Date.now()}-${name}-${lastSeq + 1}`,
          seq: lastSeq + 1,
          t: Date.now(),
          kind: "system",
          from: "system",
          to: `pool:${name}`,
          amount,
          reason,
        };
        apply(entry);
        byId.set(entry.id, entry);
        await appendFile(journalFile, JSON.stringify(entry) + "\n", "utf8");
      }
      const tmp = balancesFile + ".tmp";
      await writeFile(tmp, JSON.stringify({ seq: lastSeq, accounts: Object.fromEntries(balances) }), "utf8");
      await rename(tmp, balancesFile);
    });
  }

  /**
   * Эскроу-сделка игрок↔игрок (15c): две встречные транзакции АТОМАРНО —
   * обе в одном блоке mutex, при недостатке средств у любой стороны ни одна
   * не проводится. Согласие: инициатор выразил оффером, адресат — акцептом.
   * amountA: fromA → toB, amountB: toB → fromA (0 = сторона без денег).
   */
  function executeTrade({ idA, idB, fromA, toB, amountA, amountB, reason }) {
    const re = /^player:[\p{L}\p{N}_-]{3,24}$/u;
    if (!re.test(fromA) || !re.test(toB) || fromA === toB) throw { code: "bad_accounts" };
    for (const [id, amount] of [[idA, amountA], [idB, amountB]]) {
      if (typeof id !== "string" || id.length < 8 || id.length > 80) throw { code: "bad_id" };
      if (!Number.isInteger(amount) || amount < 0 || amount > MAX_AMOUNT) throw { code: "bad_amount" };
    }
    return mutex(async () => {
      const dup = byId.get(idA) || byId.get(idB);
      if (dup) return { dedup: true, entries: [byId.get(idA), byId.get(idB)].filter(Boolean) };
      if (balanceOf(fromA) - amountA < 0 || balanceOf(toB) - amountB < 0) throw { code: "insufficient_funds" };
      const entries = [];
      const mk = (id, from, to, amount) => ({
        id, seq: lastSeq + 1, t: Date.now(), kind: "trade", from, to, amount,
        reason: typeof reason === "string" ? reason.slice(0, 140) : "",
      });
      if (amountA > 0) entries.push(mk(idA, fromA, toB, amountA));
      if (amountB > 0) entries.push(mk(idB, toB, fromA, amountB));
      for (const e of entries) {
        apply(e);
        byId.set(e.id, e);
        await appendFile(journalFile, JSON.stringify(e) + "\n", "utf8");
      }
      const tmp = balancesFile + ".tmp";
      await writeFile(tmp, JSON.stringify({ seq: lastSeq, accounts: Object.fromEntries(balances) }), "utf8");
      await rename(tmp, balancesFile);
      return { dedup: false, entries };
    });
  }

  function publicBalances(username) {
    const pools = {};
    for (const n of POOL_NAMES) pools[n] = balanceOf(`pool:${n}`);
    return { player: balanceOf(`player:${username}`), pools };
  }

  function historyFor(username, limit = 50) {
    const acc = `player:${username}`;
    const cap = Math.min(limit, 200);
    // Map хранит insertion order (≈ порядок seq) — идём с конца и выходим, набрав limit
    const all = [...byId.values()];
    const out = [];
    for (let i = all.length - 1; i >= 0 && out.length < cap; i--) {
      const e = all[i];
      if (e.from === acc || e.to === acc) out.push(e);
    }
    return out;
  }

  return { load, transact, systemTopup, executeTrade, publicBalances, historyFor, balanceOf };
}
