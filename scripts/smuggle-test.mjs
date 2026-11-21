/**
 * smuggle-test.mjs — автотест клановых бортников (Этап 8, 14с): серый трафик
 * по всей галактике — в клановых водах гуще, на союзной земле — уличный сходняк.
 * Проверяет:
 *  1. спавн (14с): бортники есть в ЛЮБОЙ системе (в союзном Эйдолоне — уличный
 *     наём), в Терминусе и оккупированной — вдвое гуще; на выходе трюм с тройкой;
 *  2. маршруты: цель — лэир (Терминус), станция чёрного рынка (оккупация) или
 *     любой союзный док (14с); после сделки бортник уходит к краю и покидает систему;
 *  3. деньги: сделки идут через клановый пул (своим и чужим портам — тоже),
 *     инвариант Σпулов+float+игрок держится (delta 0) на каждом чекпоинте;
 *     кошелёк возвращается в клан при уходе;
 *  4. уличный прилавок (14с): игрок в союзном доку покупает/сдаёт контрабанду —
 *     деньги ходят ИСКЛЮЧИТЕЛЬНО игрок ↔ клановая касса, станция и патруль
 *     не при чём (тариф 13a чёрный рынок не берёт);
 *  5. лор-иммунитет: пираты/флагман никогда не берут бортника в прицел;
 *  6. сейв: клан записывается брутто (кошельки бортников влиты), Альянс — без них.
 *
 * Использование: npm run build && npm run smuggle   (сервит dist/, как balance-test)
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
  console.error(`SMUGGLE FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("SMUGGLE FAIL: no usable browser"); server.close(); process.exit(1); }
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

const AI_FLEE = 2; // AiState.Flee — «ушёл к вратам»

// newGame в Эйдолоне, безучастный игрок в углу
await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
});

// ── 0. 14с: в Эйдолоне (союзная, не Терминус) бортники ЕСТЬ — уличный наём ──
const street = await page.evaluate(() => {
  window.__sim.hide();
  window.__sim.step(600); // 10 с — спавн-цикл точно отработал
  const trio = (s) => (s.cargo.tobacco ?? 0) + (s.cargo.spice ?? 0) + (s.cargo.drugs ?? 0);
  const sm = window.__sim.smugglers();
  return {
    n: sm.length,
    armed: sm.length > 0 && sm.every((s) => s.dmg > 0), // конвой им нанимать не у кого, но пушка есть
    loaded: sm.some((s) => trio(s) > 0), // выходят гружёными клановой тройкой
    stationRoute: sm.every((s) => s.ai === 2 || String(s.routeId ?? "").startsWith("station-")),
  };
});
const okSpawnStreet = street.n >= 1 && street.armed && street.loaded && street.stationRoute;

// ── 0b. 14с: уличный прилавок — контрабанда в союзном доку ходит игрок ↔ клан ──
const counter = await page.evaluate(() => {
  const api = window.__gameApi.current;
  window.__sim.cash(20000); // до 30 тыс., чтобы не пробить VICTORY_SHARE
  const dock = window.__sim.sdock(); // первая станция Эйдолона — союзный док
  if (!dock || !dock.docked) return { found: false };
  const a0 = window.__econAudit();
  api.buy("tobacco", 3); // закуп из-под прилавка: игрок → клановая касса
  const a1 = window.__econAudit();
  api.sell("tobacco", 3); // и сдача — тоже из-под прилавка: клановая касса → игрок
  const a2 = window.__econAudit();
  window.__sim.sundock();
  return {
    found: true,
    clanSpend: a1.pools.clan - a0.pools.clan, // закуп: клановая касса пополнела
    clanPayout: a1.pools.clan - a2.pools.clan, // выплата: клановая касса опустела
    stationsDrift: (a1.pools.stations - a0.pools.stations) + (a2.pools.stations - a1.pools.stations),
    patrolDrift: (a1.pools.patrol - a0.pools.patrol) + (a2.pools.patrol - a1.pools.patrol), // тарифа нет
    creditsNet: a2.player - a0.player, // круг с руками: продали дешевле, чем купили
    delta: a2.delta,
  };
});
const okStreetTrade = counter.found
  && counter.clanSpend > 0 && counter.clanPayout > 0
  && counter.stationsDrift === 0 && counter.patrolDrift === 0
  && counter.creditsNet < 0 && Math.abs(counter.delta) < 1;

// ── 1. Терминус: спавн, маршрут на лэир, сделки через клан, уход ──
const term = await page.evaluate(() => {
  window.__sim.jump("terminus");
  window.__sim.hide();
  const out = { samples: [], clanStart: null, clanEnd: null, deltas: [], sawTrade: false, sawLeave: false, seenIdx: new Set(), despawned: false };
  out.clanStart = window.__econAudit().pools.clan;
  let firstIdx = null;
  for (let k = 0; k < 24; k++) { // 4 минуты чанками по 10 с
    const audit = window.__sim.step(600);
    out.deltas.push(audit.delta);
    const sm = window.__sim.smugglers();
    out.samples.push(sm);
    if (sm.length && firstIdx === null) firstIdx = sm[0].i;
    if (sm.some((s) => s.wallet > 0 && window.__econAudit().pools.clan !== out.clanStart)) out.sawTrade = true;
    if (sm.some((s) => s.ai === 2)) out.sawLeave = true;
    if (firstIdx !== null && !sm.some((s) => s.i === firstIdx)) out.despawned = true;
    if (out.sawLeave && out.despawned && out.samples.length > 6) break;
  }
  out.clanEnd = window.__econAudit().pools.clan;
  return JSON.parse(JSON.stringify(out, (k, v) => (v instanceof Set ? [...v] : v)));
});

const termSmugs = term.samples.flat();
const okSpawnTerminus = term.samples.some((s) => s.length >= 1);
// маршрут строго на лэир, либо корабль уже уходит (Flee после сделки)
const okRouteLair = termSmugs.length > 0 && termSmugs.every((s) => s.routeId === "lair" || s.ai === AI_FLEE);
// никто из пиратов ни разу не взял бортника в прицел, корпуса целы
const okNoPirateTarget = termSmugs.length > 0
  && termSmugs.every((s) => !s.targetedByPirate && s.hp === s.maxHp);
// сделки шевелят клановую кассу, уход за край случился, кошелёк вернулся (delta 0 везде)
const okClanTrade = term.sawTrade && term.clanStart !== term.clanEnd;
const okLeave = term.sawLeave && term.despawned;
const okDelta = term.deltas.every((d) => Math.abs(d) < 0.01);

// ── 2. сейв: клан БРУТТО (кошельки бортников влиты), Альянс — только свои ──
const saveCheck = await page.evaluate(() => {
  window.__gameApi.current.saveNow();
  const a = window.__econAudit();
  const smug = window.__sim.smugglers().reduce((n, s) => n + s.wallet, 0);
  const raw = localStorage.getItem("game.savegame");
  const sv = raw ? JSON.parse(raw) : null;
  return { a, smug, sv: sv ? { pools: sv.pools } : null };
});
const near = (x, y) => Math.abs(x - y) < 1.5;
const okSaveGross = !!saveCheck.sv
  && near(saveCheck.sv.pools.clan, saveCheck.a.pools.clan + saveCheck.smug)
  && near(saveCheck.sv.pools.alliance, saveCheck.a.pools.alliance + (saveCheck.a.traderFloat - saveCheck.smug));

// ── 3. оккупированная система (Никс): маршрут на станцию чёрного рынка ──
const occ = await page.evaluate(() => {
  window.__sim.jump("nix"); // стартовая оккупация (OCCUPATION.START_SYSTEM)
  window.__sim.hide();
  const out = { samples: [], deltas: [] };
  for (let k = 0; k < 12; k++) { // 2 минуты
    const audit = window.__sim.step(600);
    out.deltas.push(audit.delta);
    const sm = window.__sim.smugglers();
    out.samples.push(sm);
    if (sm.length >= 1) break;
  }
  return out;
});
const occSmugs = occ.samples.flat();
const okSpawnOccupied = occSmugs.length >= 1;
const okRouteBlackMarket = occSmugs.length > 0
  && occSmugs.every((s) => (s.routeId && s.routeId.startsWith("station-")) || s.ai === AI_FLEE);
const okDeltaOcc = occ.deltas.every((d) => Math.abs(d) < 0.01);

await done({
  okSpawnStreet, okStreetTrade,
  okSpawnTerminus, okRouteLair, okNoPirateTarget,
  okClanTrade, okLeave, okDelta, okSaveGross,
  okSpawnOccupied, okRouteBlackMarket, okDeltaOcc,
  noPageErrors: pageErrors.length === 0,
}, {
  street, counter,
  terminus: { clanStart: term.clanStart, clanEnd: term.clanEnd, samples: term.samples.filter((s) => s.length).slice(0, 3) },
  save: { smugglerFloat: saveCheck.smug, auditClan: saveCheck.a.pools.clan, saveClan: saveCheck.sv?.pools.clan },
  occupied: occ.samples.filter((s) => s.length).slice(0, 2),
  pageErrors: pageErrors.slice(0, 3),
});
