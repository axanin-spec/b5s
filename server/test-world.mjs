/**
 * test-world.mjs — автотест общего шарда (Этап 15b).
 * Поднимает сервер на тестовом порту с временным DATA_DIR и гоняет сценарии:
 * пулы за регистрацию, welcome/join/state/leave, троттлинг, отказ по токену.
 * Запуск: node server/test-world.mjs  (exit 0 = всё зелёное)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8799;
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
        if (waiters[i].pred(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    };
    ws.onopen = () =>
      resolve({
        ws,
        inbox,
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
        /** Ждёт сообщение по предикату (сначала ищет в уже пришедших). */
        wait(pred, ms = 3000) {
          const hit = inbox.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res };
            waiters.push(w);
            setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) {
                waiters.splice(i, 1);
                rej(new Error("wait timeout"));
              }
            }, ms);
          });
        },
      });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-world-"));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", () => {});

let failed = false;
try {
  // ждём поднятия
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await api("GET", "/api/health")).ok === true;
    } catch {
      await sleep(100);
    }
  }
  check("server up", up);

  // регистрация подпитывает пулы (+1M пропорционально) за каждого игрока
  const a = await api("POST", "/api/register", { username: "Alpha", password: "secret123" });
  const w1 = (await api("GET", "/api/world")).world;
  check("пулы после 1 регистрации = +1M пропорционально",
    w1.registered === 1 && w1.pools.patrol === 200000 && w1.pools.alliance === 260000
    && w1.pools.clan === 140000 && w1.pools.stations === 400000);
  const b = await api("POST", "/api/register", { username: "Bravo", password: "secret123" });
  const w2 = (await api("GET", "/api/world")).world;
  check("пулы после 2 регистраций удвоились", w2.registered === 2 && w2.pools.stations === 800000);

  // чужой токен не пускает в шард
  let rejected = false;
  try {
    await connectWs("deadbeef".repeat(8));
  } catch {
    rejected = true;
  }
  check("невалидный токен отклонён", rejected);

  // A заходит первым: welcome с собой в ростере
  const A = await connectWs(a.token);
  const welcomeA = await A.wait((m) => m.t === "welcome");
  check("welcome A: id + ростер с собой + мир",
    typeof welcomeA.id === "string" && welcomeA.players.length === 1
    && welcomeA.players[0].username === "Alpha" && welcomeA.world.registered === 2);

  // B заходит: A получает join, B видит A в ростере
  const joinSeen = A.wait((m) => m.t === "join" && m.player.username === "Bravo");
  const B = await connectWs(b.token);
  const welcomeB = await B.wait((m) => m.t === "welcome");
  await joinSeen;
  check("join виден A; ростер B содержит обоих",
    welcomeB.players.some((p) => p.username === "Alpha") && welcomeB.players.length === 2);

  // ретрансляция состояния A → B
  const stateSeen = B.wait((m) => m.t === "state" && m.id === welcomeA.id && m.x === 100.5);
  A.send({ t: "state", x: 100.5, y: -40, a: 1.57, sys: "sol", hull: "fighter" });
  await stateSeen;
  check("state A ретранслирован B (округление/поля)", true);

  // 13e: титул победителя (legend) проходит через sanitize и доезжает до соседей
  await sleep(120); // выходим из окна троттлинга
  const legendSeen = B.wait((m) => m.t === "state" && m.legend === true);
  A.send({ t: "state", x: 100, y: -40, a: 1.5, sys: "sol", legend: true });
  await legendSeen;
  check("legend-флаг ретранслирован (13e)", true);

  // троттлинг: два state подряд (10 мс) → B получает только первый
  await sleep(100); // выходим из окна троттлинга после предыдущей ретрансляции
  B.inbox.length = 0;
  const firstSeen = B.wait((m) => m.t === "state");
  A.send({ t: "state", x: 1, y: 1, a: 0 });
  await sleep(10);
  A.send({ t: "state", x: 2, y: 2, a: 0 });
  await firstSeen;
  await sleep(150);
  check("троттлинг 20 Гц: второй state отброшен", B.inbox.filter((m) => m.t === "state").length === 1);

  // мусор не роняет соединение
  A.send({ t: "state", x: "NaN-hack" });
  A.ws.send("not json at all");
  await sleep(100);
  const stillAlive = B.wait((m) => m.t === "state" && m.x === 3);
  await sleep(60);
  A.send({ t: "state", x: 3, y: 3, a: 0 });
  await stillAlive;
  check("мусорные кадры отброшены, соединение живо", true);

  // выход B: A получает leave и world с online=1
  const leaveSeen = A.wait((m) => m.t === "leave" && m.id === welcomeB.id);
  const worldSeen = A.wait((m) => m.t === "world" && m.world.online === 1);
  B.close();
  await leaveSeen;
  await worldSeen;
  check("leave + world(online=1) после выхода B", true);

  // фильтрация по системе: C в системе "other" НЕ получает state игрока A (sys "sol"),
  // а клиент без своего sys (обратная совместимость) получает всё
  const c = await api("POST", "/api/register", { username: "Charlie", password: "secret123" });
  const C = await connectWs(c.token);
  await C.wait((m) => m.t === "welcome");
  C.send({ t: "state", x: 0, y: 0, a: 0, sys: "other" }); // C объявляет свою систему
  await sleep(150); // даём примениться
  C.inbox.length = 0;
  B2: {
    const B2 = await connectWs(b.token); // без sys — должен получать всё
    await B2.wait((m) => m.t === "welcome");
    await sleep(120); // выходим из окна троттлинга A
    A.send({ t: "state", x: 55, y: 55, a: 0, sys: "sol" });
    await B2.wait((m) => m.t === "state" && m.x === 55);
    await sleep(150);
    check("state по системе: C (other) не получил, клиент без sys получил",
      !C.inbox.some((m) => m.t === "state" && m.x === 55));
    B2.close();
  }
  C.close();
  await sleep(100);

  A.close();
} catch (e) {
  failed = true;
  console.error("WORLD TEST ERROR:", e.message);
} finally {
  child.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nWORLD ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
