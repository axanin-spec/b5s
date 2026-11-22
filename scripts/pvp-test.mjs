/**
 * pvp-test.mjs — автест PvP и сделок общего шара (Этап 15c, трек Б).
 * Сервер не нужен: ростер подсовываем через __sim.fakePlayers, входящие события
 * — через __sim.fakeCombat/__sim.fakeTrade (тот же путь, что у сообщений ws).
 * Проверяет:
 *  1. исходящий state несёт hp/maxHp (серверная оценка боёв);
 *  2. трассер игрока, попавший в чужой корабль, порождает worldNet.sendHit;
 *  3. входящий hit по мне уходит в борт (щит гасит);
 *  4. kill мной — строка в фиде; kill по мне — воскрешение на базе (Этап 17);
 *  5. trade_done переносит товары и двигает кредиты на обеих ролях;
 *  6. мир жив после всех процедур, ошибок страницы нет.
 *
 * Использование: npm run build:test && npm run pvp   (сервит dist/, как net-test)
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
  console.error(`PVP FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
];
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try {
    browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {});
    break;
  } catch { /* next */ }
}
if (!browser) { console.error("PVP FAIL: no usable browser"); server.close(); process.exit(1); }
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

await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600);
});

// 1) исходящий state: hp/maxHp летят в шард (server sanitizeState их ждёт)
const st = await page.evaluate(() => {
  window.__sim.step(12); // сеттер state тикает 10 Гц — парки шагов хватает
  const ps = window.__worldNet.pendingState;
  return ps ? { hp: ps.hp, maxHp: ps.maxHp } : null;
});

// 2) исходящие попадания: чужой борт прямо над носом — мышь в «вверх» центра экрана
const out = await page.evaluate(async () => {
  const h = window.__gameApi.current.getPlayerHeading(); // нормализованные
  const net = window.__sim.net();
  window.__sim.fakePlayers([{ id: "p1", username: "Соперник", x: h.x + 0.2, y: h.y, a: 0, sys: net.sys, hull: net.hull }], "self-test");
  return net.sys;
});
await page.waitForFunction(() => window.__sim.net().remotes.some((r) => r.pid === "p1"), null, { timeout: 5000 });
await page.evaluate(() => {
  window.__hits = [];
  window.__worldNet.sendHit = (t, d) => { window.__hits.push([t, d]); };
});
// точная посадка: над центром борта на r+4 — трассер рождается внутри круга попадания
await page.evaluate(async () => {
  const r = window.__sim.net().remotes.find((x) => x.pid === "p1").radius;
  const h = window.__gameApi.current.getPlayerHeading();
  const HALF = 11500;
  const px = h.x * HALF, py = h.y * HALF;
  const net = window.__sim.net();
  window.__sim.fakePlayers([{ id: "p1", username: "Соперник", x: px / HALF, y: (py + r + 4) / HALF, a: 0, sys: net.sys, hull: net.hull }], "self-test");
});
await page.waitForFunction(() => {
  const rem = window.__sim.net().remotes.find((x) => x.pid === "p1");
  const h = window.__gameApi.current.getPlayerHeading();
  return rem && Math.abs(rem.y - h.y * 11500) > 1;
}, null, { timeout: 5000 });
const sz = page.viewportSize() || { width: 1280, height: 800 };
await page.mouse.move(sz.width / 2, sz.height / 2 - 120); // прицел «вверх» по миру
await page.evaluate(() => {
  window.__gameApi.current.setTouchFiring(true);
  window.__sim.step(240);
  window.__gameApi.current.setTouchFiring(false);
});
const hits = await page.evaluate(() => window.__hits);

// 3) входящий hit: щит гасит, корпус цел
const incoming = await page.evaluate(() => {
  const before = window.__sim.fakeCombat({ t: "hit", id: "self-test", from: "p1", dmg: 50 });
  return { shield: before.shield, hp: before.hp };
});

// 4) kill мной → фид; kill по мне → смерть не конец: респаун на базе, корпус — «Рейнджер» (Этап 17)
const feed = await page.evaluate(() => {
  window.__sim.fakeCombat({ t: "kill", id: "p1", by: "self-test" });
  return window.__uiBridge.getSnapshot().feed.map((f) => f.text);
});
const death = await page.evaluate(() => {
  window.__sim.fakeCombat({ t: "kill", id: "self-test", by: "p1", dmg: 0 });
  return {
    screen: window.__uiBridge.getSnapshot().screen,
    end: window.__uiBridge.getSnapshot().end,
    hull: window.__sim.ship().ship,
    base: window.__sim.base().sysNow,
  };
});

// 5) сделки: я — инициатор (плачу ₡, получаю товар), я — принимающий (плачу ₡, догружаюсь)
const trade = await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.step(30);
  window.__sim.cash(6000);
  const from = window.__sim.fakeTrade({
    t: "trade_done", id: "tr1", from: "self-test", to: "p1",
    giveCredits: 1000, wantCredits: 0, giveGoods: {}, wantGoods: { food: 3 },
  });
  const to = window.__sim.fakeTrade({
    t: "trade_done", id: "tr2", from: "p1", to: "self-test",
    giveCredits: 0, wantCredits: 500, giveGoods: { food: 2 }, wantGoods: {},
  });
  // чужая сделка меня не касается
  const alien = window.__sim.fakeTrade({ t: "trade_done", id: "tr3", from: "p9", to: "p8", giveCredits: 777 });
  return { from, to, alien };
});

// 6) хвост: мир живой, страница без ошибок
const tail = await page.evaluate(() => {
  window.__sim.step(600);
  return { alive: window.__sim.count("patrol") + window.__sim.count("trader") };
});

const ok = {
  okStateHp: !!st && st.hp > 0 && st.maxHp >= st.hp,
  okOutHits: Array.isArray(hits) && hits.length >= 1 && hits.every((h) => h[0] === "p1" && h[1] > 0),
  okIncoming: incoming.shield === 1e6 - 50 && incoming.hp === 1e9,
  okKillFeed: feed.some((t) => t.includes("Вы уничтожили") && t.includes("Соперник")),
  okDeathFlow: death.screen === "playing" && death.end === null && death.hull === "fighter" && death.base === "eidolon",
  okTradeFrom: trade.from.credits === 5000 && trade.from.cargo.food === 3,
  okTradeTo: trade.to.credits === 4500 && trade.to.cargo.food === 5,
  okTradeAlien: trade.alien.credits === 4500 && trade.alien.cargo.food === 5,
  okWorld: tail.alive >= 6,
  noPageErrors: pageErrors.length === 0,
};
done(ok, { st, out, hits: hits && hits.length, incoming, trade, tail, pageErrors: pageErrors.length ? pageErrors : undefined });
