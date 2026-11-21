/**
 * test-trade.mjs — автотест торговли игрок↔игрок (Этап 15c).
 * Оффер → акцепт → атомарный расчёт через ledger; отклонения и границы.
 * Запуск: node server/test-trade.mjs  (exit 0 = зелёный)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18795;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/api/ws`;
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
  return r.json();
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${encodeURIComponent(token)}`);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
      }
    };
    ws.onopen = () => resolve({
      ws, inbox, id: null,
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      count(pred) { return inbox.filter(pred).length; },
      wait(pred, ms = 3000) {
        const hit = inbox.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { pred, resolve: res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) { waiters.splice(i, 1); rej(new Error("wait timeout")); }
          }, ms);
        });
      },
    });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-trade-"));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await api("GET", "/api/health")).ok === true; } catch { await sleep(100); }
  }
  check("server up", up);

  const a = await api("POST", "/api/register", { username: "Купец", password: "secret123" });
  const b = await api("POST", "/api/register", { username: "Скупщик", password: "secret123" });
  // стартовый капитал через гранты (в рамках лимита 500k/час)
  await api("POST", "/api/grant", { id: "seed-aaaa-0001", from: "pool:stations", to: "player:Купец", amount: 100000 }, a.token);
  await api("POST", "/api/grant", { id: "seed-bbbb-0002", from: "pool:stations", to: "player:Скупщик", amount: 50000 }, b.token);

  const A = await connectWs(a.token); // Купец
  const B = await connectWs(b.token); // Скупщик
  A.id = (await A.wait((m) => m.t === "welcome")).id;
  B.id = (await B.wait((m) => m.t === "welcome")).id;
  const near = async (c, x) => { c.send({ t: "state", x, y: 0, a: 0, sys: "Эйдолон" }); await sleep(70); };
  await near(A, 0);
  await near(B, 400);

  // оффер: Купец даёт 10k + 5 руды, хочет 3k + 2 специи
  const offerSeen = B.wait((m) => m.t === "trade_offer" && m.id === "deal-0001");
  A.send({ t: "trade_offer", id: "deal-0001", to: B.id, giveCredits: 10000, wantCredits: 3000, giveGoods: { ore: 5 }, wantGoods: { spice: 2 } });
  const offer = await offerSeen;
  check("оффер доставлен адресату с условиями", offer.fromName === "Купец" && offer.giveGoods.ore === 5 && offer.wantGoods.spice === 2);

  // акцепт → trade_done обоим, балансы пересчитаны атомарно
  const doneA = A.wait((m) => m.t === "trade_done" && m.id === "deal-0001");
  const doneB = B.wait((m) => m.t === "trade_done" && m.id === "deal-0001");
  B.send({ t: "trade_accept", id: "deal-0001" });
  await doneA; await doneB;
  const balA = (await api("GET", "/api/balance", null, a.token)).data?.player ?? (await api("GET", "/api/balance", null, a.token)).player;
  const balB = (await api("GET", "/api/balance", null, b.token)).player;
  check("расчёт: Купец 93k, Скупщик 57k", balA === 93000 && balB === 57000);

  // повторный акцепт той же сделки — оффер уже закрыт, ничего не происходит
  const before = A.count((m) => m.t.startsWith("trade_"));
  B.send({ t: "trade_accept", id: "deal-0001" });
  await sleep(200);
  check("повторный акцепт закрытого оффера игнорируется", A.count((m) => m.t.startsWith("trade_")) === before);

  // недостаток средств у адресата: хочет 500k при 57k → trade_fail, балансы целы
  await near(A, 0); await near(B, 400);
  A.send({ t: "trade_offer", id: "deal-0002", to: B.id, giveCredits: 0, wantCredits: 500000, giveGoods: { ore: 1 } });
  await B.wait((m) => m.t === "trade_offer" && m.id === "deal-0002");
  const failB = B.wait((m) => m.t === "trade_fail" && m.id === "deal-0002");
  B.send({ t: "trade_accept", id: "deal-0002" });
  const failMsg = await failB;
  check("нехватка средств → trade_fail, балансы не изменились",
    failMsg.reason === "insufficient_funds" && (await api("GET", "/api/balance", null, a.token)).player === 93000);

  // отказ адресата
  A.send({ t: "trade_offer", id: "deal-0003", to: B.id, giveCredits: 100, wantCredits: 0 });
  await B.wait((m) => m.t === "trade_offer" && m.id === "deal-0003");
  const declA = A.wait((m) => m.t === "trade_declined" && m.id === "deal-0003");
  B.send({ t: "trade_decline", id: "deal-0003" });
  await declA;
  check("отказ доставлен инициатору", true);

  // оффер дальше стыковочной дистанции не проходит
  await near(B, 99999);
  A.send({ t: "trade_offer", id: "deal-0004", to: B.id, giveCredits: 100 });
  await sleep(200);
  check("оффер на дистанции > 1500 отклонён", !B.inbox.some((m) => m.id === "deal-0004"));

  // разрыв соединения отменяет висящий оффер
  await near(B, 400);
  A.send({ t: "trade_offer", id: "deal-0005", to: B.id, giveCredits: 100 });
  await B.wait((m) => m.t === "trade_offer" && m.id === "deal-0005");
  const goneB = B.wait((m) => m.t === "trade_fail" && m.id === "deal-0005" && m.reason === "offline");
  A.close();
  await goneB;
  check("отключение инициатора отменяет сделку", true);

  B.close();
} catch (e) {
  failed = true;
  console.error("TRADE TEST ERROR:", e.message);
} finally {
  child.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nTRADE ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
