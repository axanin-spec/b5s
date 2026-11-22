/**
 * test-ledger.mjs — автотест денежного авторитета (Этап 15c).
 * Пулы за регистрации, гранты, переводы, идемпотентность, лимиты, персист.
 * Запуск: node server/test-ledger.mjs  (exit 0 = зелёный)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18797;
const BASE = `http://localhost:${PORT}`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const check = (name, cond) => {
  results[name] = !!cond;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

async function api(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

function startServer(dataDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return proc;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await api("GET", "/api/health")).data.ok) return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-ledger-"));
let srv = startServer(dataDir);
let failed = false;

try {
  check("server up", await waitUp());

  const A = (await api("POST", "/api/register", { username: "Алиса", password: "secret123" })).data;
  const B = (await api("POST", "/api/register", { username: "Борис", password: "secret123" })).data;

  // эмиссия за регистрации отражена в журнале пулов
  const bal0 = (await api("GET", "/api/balance", null, A.token)).data;
  check("пулы журнала = 2×1M пропорционально",
    bal0.pools.patrol === 400000 && bal0.pools.alliance === 520000
    && bal0.pools.clan === 280000 && bal0.pools.stations === 800000 && bal0.player === 0);

  // грант: пул → игрок
  const g1 = await api("POST", "/api/grant", { id: "grant-0001-aaaa", from: "pool:patrol", to: "player:Алиса", amount: 50000, reason: "награда" }, A.token);
  check("grant 50k Алисе", g1.data.ok && g1.data.tx.amount === 50000 && g1.data.dedup === false);

  // перевод: Алиса → Борис
  const t1 = await api("POST", "/api/tx", { id: "tx-0001-bbbb", from: "player:Алиса", to: "player:Борис", amount: 20000, reason: "сделка" }, A.token);
  check("tx 20k Алиса→Борис", t1.data.ok && (await api("GET", "/api/balance", null, B.token)).data.player === 20000);

  // идемпотентность: повтор того же id — без повторного проведения
  const t1r = await api("POST", "/api/tx", { id: "tx-0001-bbbb", from: "player:Алиса", to: "player:Борис", amount: 20000 }, A.token);
  const balA = (await api("GET", "/api/balance", null, A.token)).data.player;
  check("повтор tx id → dedup, баланс не меняется", t1r.data.dedup === true && balA === 30000);

  // чужие деньги и чужие пулы — нельзя
  const f1 = await api("POST", "/api/tx", { id: "tx-0002-cccc", from: "pool:patrol", to: "player:Алиса", amount: 100 }, A.token);
  const f2 = await api("POST", "/api/tx", { id: "tx-0003-dddd", from: "player:Борис", to: "player:Алиса", amount: 100 }, A.token);
  check("tx с чужого счёта/пула → 403", f1.status === 403 && f2.status === 403 && f1.data.error === "forbidden");

  // недостаточно средств
  const f3 = await api("POST", "/api/tx", { id: "tx-0004-eeee", from: "player:Алиса", to: "player:Борис", amount: 1000000 }, A.token);
  check("перевод сверх баланса → 402", f3.status === 402 && f3.data.error === "insufficient_funds");

  // кривая сумма
  const f4 = await api("POST", "/api/tx", { id: "tx-0005-ffff", from: "player:Алиса", to: "player:Борис", amount: -5 }, A.token);
  check("отрицательная сумма → 400", f4.status === 400 && f4.data.error === "bad_amount");

  // почасовой лимит грантов
  await api("POST", "/api/grant", { id: "grant-0002-gggg", from: "pool:alliance", to: "player:Алиса", amount: 400000 }, A.token);
  const f5 = await api("POST", "/api/grant", { id: "grant-0003-hhhh", from: "pool:alliance", to: "player:Алиса", amount: 200000 }, A.token);
  check("grant сверх лимита 500k/час → 429", f5.status === 429 && f5.data.error === "grant_cap");

  // история видит операции игрока
  const hist = (await api("GET", "/api/ledger?limit=10", null, A.token)).data.entries;
  check("история Алисы: ≥3 записей, новые первыми", hist.length >= 3 && hist[0].seq > hist.at(-1).seq);

  // персист через рестарт
  srv.kill();
  await sleep(400);
  srv = startServer(dataDir);
  check("server up после рестарта", await waitUp());
  const balB2 = (await api("GET", "/api/balance", null, B.token)).data;
  const balA2 = (await api("GET", "/api/balance", null, A.token)).data;
  check("балансы пережили рестарт", balB2.player === 20000 && balA2.player === 430000 && balA2.pools.patrol === 350000);

  // идемпотентность переживает рестарт
  const t1rr = await api("POST", "/api/tx", { id: "tx-0001-bbbb", from: "player:Алиса", to: "player:Борис", amount: 20000 }, A.token);
  check("повтор tx id после рестарта → dedup", t1rr.data.dedup === true);

  // ротация журнала: порог 800 байт, храним 5 записей, проверка каждую запись
  srv.kill();
  await sleep(400);
  srv = startServer(dataDir, {
    LEDGER_JOURNAL_ROTATE_BYTES: "800",
    LEDGER_JOURNAL_KEEP_ENTRIES: "5",
    LEDGER_JOURNAL_ROTATE_CHECK_EVERY: "1",
  });
  check("server up для ротации", await waitUp());
  for (let i = 0; i < 8; i++) {
    await api("POST", "/api/tx", { id: `rot-${i}-aaaa`, from: "player:Алиса", to: "player:Борис", amount: 10 }, A.token);
  }
  await sleep(200);
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(path.join(dataDir, "journal.jsonl"), "utf8")).split("\n").filter(Boolean);
  const balRot = (await api("GET", "/api/balance", null, A.token)).data;
  check("журнал отротирован (≤6 записей), баланс корректен",
    lines.length <= 6 && balRot.player === 429920);
  const histRot = (await api("GET", "/api/ledger?limit=50", null, A.token)).data.entries;
  check("история после ротации: только свежие записи", histRot.length >= 1 && histRot.every((e) => e.seq > 0));
} catch (e) {
  failed = true;
  console.error("LEDGER TEST ERROR:", e.message || e);
} finally {
  srv.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nLEDGER ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
