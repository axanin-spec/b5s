/**
 * net-test.mjs — автест игровой части общего шара (Этап 15b, трек Б).
 * Сервер не нужен: worldNet офлайн, ростер подсовывается через __sim.fakePlayers.
 * Проверяет:
 *  1. update() шлёт свой state 10 Гц: координаты нормализованы (/HALF), sys и hull на месте;
 *  2. смена корпуса отражается в исходящем state (bark вместо fighter);
 *  3. ростер фильтруется у источника отрисовки: не себя, живых, своей системы, со state;
 *     чужой корпус = силуэт HULLS с радиусом из конфига, позиция из нормализованных метров;
 *  4. воскрешение: dead=false — корабль возвращается в ростер кадра;
 *  5. DOM-оверлей трека А погашен (drawsNetRemotes), его канвас пуст — дублей нет;
 *  6. офлайн: чужие исчезают, исходящий state продолжается (позиция догоняет телепорт);
 *  7. мир жив, ₡-инвариант цел, ошибок страницы нет.
 *
 * Использование: npm run build:test && npm run net   (сервит dist/, как ttl-test)
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = existsSync(join(ROOT, "dist/public/index.html")) ? join(ROOT, "dist/public") : join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`NET FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
  process.exit(1);
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  try {
    const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    let path; try { path = decodeURIComponent(raw); } catch { path = raw; }
    const file = resolve(DIST, "." + path);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/`;

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try {
    browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {});
    break;
  } catch { /* next */ }
}
if (!browser) { console.error("NET FAIL: no usable browser"); server.close(); process.exit(1); }
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL_, { waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });

const done = (ok, extra) => {
  console.log(JSON.stringify({ ok, ...extra }, null, 1));
  browser.close().then(() => server.close());
  process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
};

// новый запуск: бессмертный невидимка, флот укомплектован; 7 тиков ≥ 0.1 с → ≥1 отправка
const send = await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600); // население
  window.__sim.step(7);   // 0.117 с симуляции — update() обязан выслать state
  const w = window.__worldNet;
  const p = w.pendingState; // TS-private → рантайм-поле
  const net = window.__sim.net();
  const pr = window.__sim.probe();
  return {
    has: !!p,
    sys: p ? p.sys : null, sysNow: net.sys,
    hull: p ? p.hull : null,
    dx: p ? Math.abs(p.x * 11500 - pr.pos[0]) : 1e9, // нормала × HALF → метры
    dy: p ? Math.abs(p.y * 11500 - pr.pos[1]) : 1e9,
  };
});

// смена корпуса должна уехать в шард
const swap = await page.evaluate(() => {
  window.__sim.hull("bark");
  window.__sim.step(12); // > 0.1 с — следующий отправленный state уже с новым корпусом
  const p = window.__worldNet.pendingState;
  return { hull: p ? p.hull : null };
});

// ростер: 5 фантомов — «себя», наш, чужая система, мертвец, без координат
const roster = await page.evaluate(async () => {
  const sys = window.__sim.net().sys;
  window.__sim.fakePlayers([
    { id: "me", username: "ЭтоЯ", x: 0.5, y: 0.5, a: 0, sys, hull: "fighter" },
    { id: "r1", username: "Кувшин", x: 0.2, y: -0.1, a: 1.2, sys, hull: "bark" },
    { id: "r2", username: "Соня", x: 0.1, y: 0.1, a: 0.5, sys: "Система-Призрак", hull: "fighter" },
    { id: "r3", username: "Мертвец", x: 0.3, y: 0.3, a: 0, sys, hull: "corvette", dead: true },
    { id: "r4", username: "БезКоординат", x: 0, y: 0, a: 0, sys, hull: "fighter" },
  ], "me");
  window.__worldNet.players.get("r4").state = null; // «не присылал state»
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return window.__sim.net();
});

// воскрес — вернулся в кадр
await page.evaluate(() => { window.__worldNet.players.get("r3").dead = false; });
await page.waitForFunction(() => window.__sim.net().remotes.length === 2, null, { timeout: 5000 });
const revived = await page.evaluate(() => window.__sim.net().remotes.map((r) => r.name).sort().join(","));

// оверлей трека А погашен и пуст: шевронов/подписей-дублей нет
const overlay = await page.evaluate(async () => {
  const cv = document.getElementById("net-overlay");
  if (!cv) return { exists: false, ink: -1, gate: false };
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const d = cv.getContext("2d").getImageData(0, 0, Math.max(1, cv.width), Math.max(1, cv.height)).data;
  let ink = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
  return { exists: true, ink, gate: window.__gameApi.current.drawsNetRemotes() };
});

// офлайн: чужие пропали, исходящий поток жив — позиция догоняет телепорт
await page.evaluate(async () => {
  window.__worldNet.status = "offline";
  window.__sim.step(12);
});
await page.waitForFunction(() => window.__sim.net().remotes.length === 0, null, { timeout: 5000 });
const offline = await page.evaluate(() => {
  const p0 = window.__worldNet.pendingState;
  const x0 = p0 ? p0.x : null;
  const pr = window.__sim.probe();
  window.__sim.tp(pr.pos[0] + 4000, pr.pos[1]);
  window.__sim.step(12);
  const p1 = window.__worldNet.pendingState;
  return {
    moved: p1 ? Math.abs(p1.x * 11500 - (pr.pos[0] + 4000)) < 50 : false,
    changed: p1 && x0 !== null ? Math.abs(p1.x - x0) > 0.1 : false,
    remotes: window.__sim.net().remotes.length,
  };
});

// хвост: мир живой, ₡-инвариант цел
const tail = await page.evaluate(() => {
  window.__sim.fakePlayers(null);
  window.__sim.step(600);
  const a = window.__sim.step(1);
  return { delta: a.delta, alive: window.__sim.count("patrol") + window.__sim.count("trader") };
});

// эталонный хэш позывного — тот же алгоритм, что remoteHue/hueFor
const hueOf = (name) => { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return h % 360; };
const r1 = roster.remotes.find((r) => r.name === "Кувшин");

const ok = {
  okSend: send.has && send.sys === send.sysNow && send.hull === "fighter" && send.dx < 25 && send.dy < 25,
  okHullSwap: swap.hull === "bark",
  okRoster: roster.remotes.length === 1 && !!r1 && r1.radius === 46 && r1.x === 2300 && r1.y === -1150
    && Math.abs(r1.a - 1.2) < 0.02 && r1.hue === hueOf("Кувшин"),
  okRevive: revived === "Кувшин,Мертвец",
  okOverlayMuted: overlay.exists && overlay.gate === true && overlay.ink === 0,
  okOffline: offline.remotes === 0 && offline.moved && offline.changed,
  okMoney: Math.abs(tail.delta) < 1,
  okWorld: tail.alive >= 6,
  noPageErrors: pageErrors.length === 0,
};
done(ok, {
  send, swap, roster, revived, overlay, offline, tail,
  hueRef: { Кувшин: hueOf("Кувшин") },
  pageErrors: pageErrors.length ? pageErrors : undefined,
});
