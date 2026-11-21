/**
 * test-pvp.mjs — автотест PvP-верификации шарда (Этап 15c).
 * Попадания, дистанция, темп, смерть, респаун, персист счётчика убийств.
 * Запуск: node server/test-pvp.mjs  (exit 0 = зелёный)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18796;
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
        id: null,
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

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-pvp-"));
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

  const a = await api("POST", "/api/register", { username: "Атакующий", password: "secret123" });
  const v = await api("POST", "/api/register", { username: "Жертва", password: "secret123" });

  const A = await connectWs(a.token);
  const V = await connectWs(v.token);
  const wa = await A.wait((m) => m.t === "welcome");
  const wv = await V.wait((m) => m.t === "welcome");
  A.id = wa.id; V.id = wv.id;

  // оба репортят позиции рядом в одной системе
  const sendState = async (c, x, hp) => {
    c.send({ t: "state", x, y: 0, a: 0, sys: "Эйдолон", hp });
    await sleep(70); // выходим из окна троттлинга 20 Гц
  };
  await sendState(A, 0, 100);
  await sendState(V, 500, 100);

  // обычное попадание верифицируется и рассылается обоим
  const hitV = V.wait((m) => m.t === "hit" && m.id === V.id && m.dmg === 30);
  A.send({ t: "hit", target: V.id, dmg: 30 });
  const hit = await hitV;
  check("попадание верифицировано, hp-оценка 70", hit.hp === 70 && hit.from === A.id);

  // попадание из другой системы отклоняется
  await sendState(A, 0, 100);
  A.send({ t: "state", x: 0, y: 0, a: 0, sys: "Другая", hp: 100 });
  await sleep(70);
  const before = V.count((m) => m.t === "hit");
  A.send({ t: "hit", target: V.id, dmg: 10 });
  await sleep(200);
  check("hit из другой системы отклонён", V.count((m) => m.t === "hit") === before);

  // возвращаемся в систему; слишком далеко — отклоняется
  await sendState(A, 99999, 100);
  A.send({ t: "hit", target: V.id, dmg: 10 });
  await sleep(200);
  check("hit сверх дистанции отклонён", V.count((m) => m.t === "hit") === before);

  // слишком большой урон отклоняется
  await sendState(A, 500, 100);
  A.send({ t: "hit", target: V.id, dmg: 5000 });
  await sleep(200);
  check("hit сверх капа урона отклонён", V.count((m) => m.t === "hit") === before);

  // добивание: 70 урона → kill обоим, счётчик убийств = 1
  const killV = V.wait((m) => m.t === "kill" && m.id === V.id && m.by === A.id);
  const killA = A.wait((m) => m.t === "kill" && m.id === V.id);
  A.send({ t: "hit", target: V.id, dmg: 70 });
  await killV; await killA;
  check("kill рассылается обоим", true);

  // по мёртвому не бьют
  const before2 = V.count((m) => m.t === "hit");
  A.send({ t: "hit", target: V.id, dmg: 10 });
  await sleep(200);
  check("hit по мёртвой цели игнорируется", V.count((m) => m.t === "hit") === before2);

  // респаун: жертва снова шлёт state → respawn всем
  const respA = A.wait((m) => m.t === "respawn" && m.id === V.id);
  await sendState(V, 500, 100);
  await respA;
  check("respawn рассылается", true);

  // счётчик убийств персистентен в world.json
  await sleep(300);
  const wj = JSON.parse(await readFile(path.join(dataDir, "world.json"), "utf8"));
  check("world.json: kills=1, killsLog с записями",
    wj.kills === 1 && wj.killsLog.length === 1 && wj.killsLog[0].victim === "Жертва");

  A.close(); V.close();
} catch (e) {
  failed = true;
  console.error("PVP TEST ERROR:", e.message);
} finally {
  child.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nPVP ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
