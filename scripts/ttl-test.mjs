/**
 * ttl-test.mjs — автест времени жизни трофеев (Этап 14e): космос не копит мусор.
 * Проверяет:
 *  1. единый TTL: кредиты, товар и модуль-поддон рождаются с жизнью PICKUP.LIFE = 600 с;
 *  2. на 590-й секунде все три живы (остаток ≈10 с) — раньше срока не испаряются;
 *  3. после 600+ с все три исчезли; денег испарение не тронуло (инвариант ₡ цел);
 *  4. аварийный сброс [X] (14d) порождает поддоны с тем же TTL;
 *  5. переполнение пула (256): свежий трофей вытесняет старейший, а не теряется;
 *  6. мир жив, ошибки страницы отсутствуют.
 *
 * Использование: npm run build:test && npm run ttl   (сервит dist/, как inspect-test)
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
  console.error(`TTL FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("TTL FAIL: no usable browser"); server.close(); process.exit(1); }
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

// новый запуск: невидимый бессмертный зритель, флот живёт сам
await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600); // 10 с — укомплектованное население
});

const MAIN = await page.evaluate(() => {
  const MAXP = 256; // ёмкость пула поддонов в game.ts (14e)
  const LIFE = 600; // PICKUP.LIFE из config.ts
  // дальняя чистая поляна: никто в 2600 — маркеры не подберёт случайный экипаж
  let spot = null;
  for (let a = 0; a < 16 && !spot; a++) {
    const x = Math.cos((a * Math.PI) / 8) * 5400, y = Math.sin((a * Math.PI) / 8) * 5400;
    if (window.__sim.near(x, y, 2600).length === 0) spot = { x, y };
  }
  if (!spot) return { found: false };
  window.__sim.tp(spot.x, spot.y);

  // три маркированных поддона — метка по (вид, товар, сумма, место): не спутать с фоном
  const sC = window.__sim.spawnpod("credits", "", 4444, spot.x + 420, spot.y + 420);
  const sG = window.__sim.spawnpod("cargo", "drugs", 13, spot.x + 440, spot.y + 420);
  const sM = window.__sim.spawnpod("module", "plasma-C", 1, spot.x + 460, spot.y + 420);
  const pC = window.__sim.pstat(sC), pG = window.__sim.pstat(sG), pM = window.__sim.pstat(sM);
  const born = [pC, pG, pM].map((p) => (p && p.active ? p.life : -1));
  const bornKinds = [pC?.kind, pG?.kind, pM?.kind];

  const a0 = window.__sim.step(0);
  // маркер ищем в списке живых поддонов: слот после испарения занимает фон, индекс не верь
  const findMark = (kind, goodId, amount, dx, dy) => {
    const R = 90; // поддон дрейфует ≤ ~55 за счёт стартового импульса
    return window.__sim.pickups().find((p) => p.kind === kind && p.goodId === goodId && p.amount === amount
      && Math.abs(p.x - (spot.x + dx)) < R && Math.abs(p.y - (spot.y + dy)) < R) ?? null;
  };

  // 59-я шестисекундная пачка ≈ 590 с: маркеры обязаны жить с остатком ~10 с
  for (let k = 0; k < 59; k++) window.__sim.step(600);
  const mC = findMark("credits", "", 4444, 420, 420);
  const mG = findMark("cargo", "drugs", 13, 440, 420);
  const mM = findMark("module", "plasma-C", 1, 460, 420);
  const alive = [mC, mG, mM].map((p) => (p ? p.life : -1));

  // ещё 20 с → за TTL: все три испарились, деньги не двинулись
  window.__sim.step(1200);
  const goneC = findMark("credits", "", 4444, 420, 420) === null;
  const goneG = findMark("cargo", "drugs", 13, 440, 420) === null;
  const goneM = findMark("module", "plasma-C", 1, 460, 420) === null;

  // 4: сброс [X] порождает улики с тем же TTL
  window.__sim.pcargo("drugs", 12);
  window.__gameApi.current.jettison();
  const jd = window.__sim.pickups().find((p) => p.kind === "cargo" && p.goodId === "drugs" && p.amount === 12
    && Math.abs(p.x - spot.x) < 120 && p.life > LIFE - 5) ?? null;

  // 5: переполнение — 300 «пробок» в пул; последний обязан выжить, вытеснив старейших
  let lastSlot = -1;
  for (let k = 0; k < 300; k++) lastSlot = window.__sim.spawnpod("cargo", "food", 1, spot.x + 900, spot.y + 900);
  const afterFill = window.__sim.pickups().length;
  const last = window.__sim.pstat(lastSlot);

  const a1 = window.__sim.step(0);
  return {
    found: true, born, bornKinds, alive, goneC, goneG, goneM,
    jettisonLife: jd ? jd.life : -1,
    poolFull: afterFill, lastFresh: !!(last && last.active && last.life > LIFE - 5 && last.kind === "cargo"),
    maxp: MAXP, LIFE,
    delta0: a0.delta, delta: a1.delta,
    cr0: a0.player, cr1: a1.player,
  };
});

// 6: хвост — мир живой, скан-каналы корректны
const tail = await page.evaluate(() => {
  window.__sim.step(600);
  const a = window.__sim.step(1);
  return {
    delta: a.delta,
    alive: window.__sim.count("patrol") + window.__sim.count("trader"),
    sane: window.__sim.scan().every((s) => s.t > 0 && s.t <= 4),
  };
});

const ok = {
  okUnifiedSpawn: MAIN.found && MAIN.born.length === 3 && MAIN.born.every((l) => l === MAIN.LIFE)
    && MAIN.bornKinds.join(",") === "credits,cargo,module",
  okAlive590: MAIN.alive.length === 3 && MAIN.alive.every((l) => l >= 5 && l <= 15),
  okExpired: MAIN.goneC && MAIN.goneG && MAIN.goneM,
  okJettisonTtl: MAIN.jettisonLife > MAIN.LIFE - 5,
  okEvict: MAIN.poolFull === MAIN.maxp && MAIN.lastFresh,
  okMoney: Math.abs(MAIN.delta0) < 1 && Math.abs(MAIN.delta) < 1 && Math.abs(tail.delta) < 1,
  okClean: tail.alive >= 6 && tail.sane,
  noPageErrors: pageErrors.length === 0,
};
done(ok, {
  MAIN, tail,
  pageErrors: pageErrors.length ? pageErrors : undefined,
});
