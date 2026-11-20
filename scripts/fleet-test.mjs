/**
 * fleet-test.mjs — автотест флота (Этап 7b): верфь, снаряжение, гейты рынка.
 * Docking-операции пачкуются синхронно внутри одного page.evaluate — между
 * аудитом и сделкой не проскакивает ни один rAF-кадр, поэтому пулы двигает
 * только сама сделка. Проверяет:
 *  1. старт: истребитель с китом — hp/щит/реген/скорость/трюм/DPS из HULLS+EQUIP;
 *  2. консервация денег: покупка корпуса с зачётом, покупка/продажа модуля, сдача
 *     корпуса — delta не шевелится, деньги перетекают игрок ↔ stations 1:1;
 *  2b. терминал 10d: «Макс» набивает трюм до упора (деньги/вместимость — clamp в buy),
 *     «Продать весь трюм» (sellAll) обнуляет его, delta снова не шевелится, кнопки в DOM;
 *  3. гейты: шахта торгует только C/B и корпусами «any»; на хабе SS только с
 *     Альянсом ≥ +35; SSS и «флагманские» линии — только клановый рынок с кланами
 *     ≥ +35 (оккупированный Никс);
 *  4. совместимость: орудие чужого класса корпусу не встаёт, на своём — встаёт
 *     и поднимает DPS; снятый двигатель заменяется дежурным корпуса;
 *  5. сейв v8: корпус/установленное/склад/кредиты/delta через reload один в один.
 *
 * Использование: npm run build && npm run fleet
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
  console.error(`FLEET FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("FLEET FAIL: no usable browser"); server.close(); process.exit(1); }
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

// ── 0/1. старт: новый игрок = истребитель со стартовым китом ──
// st0 снимается ДО god(): god завышает hp/shield до 1e9/1e6, а нам нужны честные
// 120/51 из HULLS+EQUIP. Дальше по тесту бог нужен, чтобы праздный игрок не сдох.
await page.evaluate(() => { window.__gameApi.current.newGame(); });
const st0 = await page.evaluate(() => window.__sim.ship());
await page.evaluate(() => window.__sim.god());
const okStart = st0.ship === "fighter" && st0.hp === 120 && st0.shield === 51 && st0.regen === 5
  && st0.speed === 470 && st0.cargo === 24 && Math.abs(st0.dps - 30.6) < 0.01
  && st0.installed.weapon[0] === "needle-C" && st0.installed.shield[0] === "turtle-C" && st0.installed.engine[0] === "spark-C";

// ── 2. сделки на хабе: delta 0, перетоки 1:1, статы от корпусов/модулей ──
const trades = await page.evaluate(() => {
  const api = window.__gameApi.current;
  const docked = window.__sim.dockAt("station-0"); // хаб «Ковчег»
  window.__sim.cash(500000);
  const a0 = window.__econAudit();
  api.buyHull("corvette"); // net = 42000 − 0.6×5000 = 39000
  const a1 = window.__econAudit();
  const s1 = window.__sim.ship();
  api.buyModule("wasp-B"); // 1800×3.2 = 5760
  const a2 = window.__econAudit();
  const f2 = window.__uiBridge.getSnapshot().station.fleet;
  const waspIdx = f2.stash.findIndex((s) => s.itemId === "wasp-B");
  api.equipModule(waspIdx, "weapon", 1); // корвет держит два орудия
  const s2 = window.__sim.ship();
  const f2b = window.__uiBridge.getSnapshot().station.fleet;
  const absentAfterEquip = !f2b.stash.some((s) => s.itemId === "wasp-B");
  api.unequipModule("weapon", 1);
  const f2c = window.__uiBridge.getSnapshot().station.fleet;
  const backIdx = f2c.stash.findIndex((s) => s.itemId === "wasp-B");
  api.sellModule(backIdx); // +55% = 3168
  const a3 = window.__econAudit();
  api.sellHull(); // корвет → истребитель, зачёт 60% = 25200
  const a4 = window.__econAudit();
  const s4 = window.__sim.ship();
  return { docked, a0, a1, a2, a3, a4, s1, s2, s4, waspInShop: f2.shop.some((g) => g.itemId === "wasp-B"), absentAfterEquip };
});
const poolD = (a, b, k) => a.pools[k] - b.pools[k];
const okDock = trades.docked === true;
const okHullBuy = trades.a1.delta === trades.a0.delta && trades.a1.player === trades.a0.player - 39000
  && poolD(trades.a1, trades.a0, "stations") === 39000
  && trades.s1.ship === "corvette" && trades.s1.hp === 300 && trades.s1.cargo === 48
  && trades.s1.shield === 91 && trades.s1.speed === 430; // 40 плит + черепаха-C 51
const okModuleBuy = trades.a2.delta === trades.a1.delta && trades.a2.player === trades.a1.player - 5760
  && poolD(trades.a2, trades.a1, "stations") === 5760 && trades.waspInShop;
const okEquipDps = trades.s2.installed.weapon[1] === "wasp-B" && trades.absentAfterEquip
  && Math.abs(trades.s2.dps - (9 + 15) * 3.6) < 0.01; // залп из двух стволов под темп лучшего
const okModuleSell = trades.a3.delta === trades.a2.delta && trades.a3.player === trades.a2.player + 3168
  && poolD(trades.a3, trades.a2, "stations") === -3168;
const okHullSell = trades.a4.delta === trades.a3.delta && trades.a4.player === trades.a3.player + 25200
  && poolD(trades.a4, trades.a3, "stations") === -25200
  && trades.s4.ship === "fighter" && trades.s4.hp === 120 && trades.s4.installed.engine[0] === "spark-C";

// ── 2b. товарный терминал (10d): «Макс» набивает трюм, «Продать весь трюм» пустит его;
// delta не шевелится, деньги ходят игрок ↔ stations туда-обратно ──
const goods = await page.evaluate(() => {
  const api = window.__gameApi.current;
  const st = () => window.__uiBridge.getSnapshot().station;
  const used = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  const a0 = window.__econAudit();
  const s0 = st();
  api.buy("food", 9999); // кнопка «Макс»
  const s1 = st();
  const a1 = window.__econAudit();
  api.sellAll(); // кнопка «Продать весь трюм»
  const s2 = st();
  const a2 = window.__econAudit();
  // DOM: кнопки живые — «Макс» в каждой строке и подвал с общим сбросом трюма
  const rowBtns = [...document.querySelectorAll(".trade-actions .mini-btn")].map((b) => b.textContent.trim());
  const foot = document.querySelector(".trade-foot .btn");
  return {
    cargoMax: s1.cargoMax, used0: used(s0.cargo), used1: used(s1.cargo), used2: used(s2.cargo),
    credits: [s0.credits, s1.credits, s2.credits],
    a0, a1, a2,
    ui: { max: rowBtns.includes("Макс"), foot: !!foot && foot.textContent.includes("Продать весь трюм") },
  };
});
const okBuyMax = goods.a1.delta === goods.a0.delta && goods.used0 === 0
  && goods.used1 === goods.cargoMax && goods.credits[1] < goods.credits[0];
const okSellAll = goods.a2.delta === goods.a1.delta
  && goods.used2 === 0 && goods.credits[2] > goods.credits[1];
const okGoodsUi = goods.ui.max && goods.ui.foot;

// ── 3a. шахта: только C/B и корпуса «any» ──
const mine = await page.evaluate(() => {
  window.__gameApi.current.undock();
  const docked = window.__sim.dockAt("station-2"); // «Алтайр», шахта
  const f = window.__uiBridge.getSnapshot().station.fleet;
  const frig = f.hulls.find((h) => h.id === "frigate");
  const batt = f.hulls.find((h) => h.id === "battleship");
  return {
    docked,
    lowRanksOnly: f.shop.every((g) => g.rank === "C" || g.rank === "B"),
    coreInShop: f.shop.some((g) => g.itemId.startsWith("wasp") || g.itemId.startsWith("hammer")),
    corvetteStock: f.hulls.find((h) => h.id === "corvette").stock,
    frigateLocked: !frig.stock && !!frig.why,
    battleLocked: !batt.stock && !!batt.why,
  };
});
const okMine = mine.docked && mine.lowRanksOnly && !mine.coreInShop && mine.corvetteStock && mine.frigateLocked && mine.battleLocked;

// ── 3b. хаб: SS и флагманские линии только с Альянсом ≥ +35 ──
const hubGate = await page.evaluate(() => {
  const out = {};
  window.__sim.rep("trader", 10);
  window.__sim.dockAt("station-0");
  let f = window.__uiBridge.getSnapshot().station.fleet;
  out.coldSS = f.shop.some((g) => g.rank === "SS");
  out.coldBattle = f.hulls.find((h) => h.id === "battleship").stock;
  out.coldLance = f.shop.some((g) => g.itemId.startsWith("lance"));
  window.__sim.rep("trader", 40);
  window.__sim.dockAt("station-0");
  f = window.__uiBridge.getSnapshot().station.fleet;
  out.warmSS = f.shop.some((g) => g.rank === "SS");
  out.warmSSS = f.shop.some((g) => g.rank === "SSS");
  out.warmBattle = f.hulls.find((h) => h.id === "battleship").stock;
  out.warmFrigate = f.hulls.find((h) => h.id === "frigate").stock;
  return out;
});
const okHubGate = !hubGate.coldSS && !hubGate.coldBattle && !hubGate.coldLance
  && hubGate.warmSS && !hubGate.warmSSS && hubGate.warmBattle && hubGate.warmFrigate;

// ── 3c. клановый рынок (оккупированный Никс): SSS и флагманы — только со «своими» ──
const clanGate = await page.evaluate(() => {
  window.__gameApi.current.undock();
  window.__sim.jump("nix");
  const out = {};
  window.__sim.rep("clan", -5);
  out.dockedCold = window.__sim.dockAt("station-0");
  let f = window.__uiBridge.getSnapshot().station.fleet;
  out.coldSSS = f.shop.some((g) => g.rank === "SSS");
  out.coldLance = f.shop.some((g) => g.itemId.startsWith("lance"));
  out.coldCitadel = f.shop.some((g) => g.itemId.startsWith("citadel"));
  out.coldBattle = f.hulls.find((h) => h.id === "battleship").stock;
  window.__sim.rep("clan", 40);
  window.__sim.dockAt("station-0");
  f = window.__uiBridge.getSnapshot().station.fleet;
  out.kinSSS = f.shop.some((g) => g.rank === "SSS");
  out.kinLanceSss = f.shop.some((g) => g.itemId === "lance-SSS");
  out.kinCitadel = f.shop.some((g) => g.itemId.startsWith("citadel"));
  out.kinBattle = f.hulls.find((h) => h.id === "battleship").stock;
  window.__gameApi.current.undock();
  return out;
});
const okClanGate = clanGate.dockedCold && !clanGate.coldSSS && !clanGate.coldLance && !clanGate.coldCitadel && !clanGate.coldBattle
  && clanGate.kinSSS && clanGate.kinLanceSss && clanGate.kinCitadel && clanGate.kinBattle;

// ── 4. совместимость: чужое орудие в слот не встаёт, своё — встаёт;
//       снятый двигатель заменяется дежурным корпусов ──
const fit = await page.evaluate(() => {
  window.__sim.jump("eidolon");
  window.__sim.give("hammer-C"); // масс-драйвер: фрегат/линкор, на истребителе — мимо
  window.__sim.give("reactor-C"); // термоядро: фрегат/линкор
  window.__sim.dockAt("station-0");
  const out = {};
  const f1 = window.__uiBridge.getSnapshot().station.fleet;
  const idx = f1.stash.findIndex((s) => s.itemId === "hammer-C");
  out.fighterFits = f1.stash[idx].fits;
  window.__gameApi.current.equipModule(idx, "weapon", 0);
  const s1 = window.__sim.ship();
  out.rejected = s1.installed.weapon[0] === "needle-C";
  out.stillStashed = window.__uiBridge.getSnapshot().station.fleet.stash.some((s) => s.itemId === "hammer-C");
  window.__sim.hull("frigate"); // бесплатная смена корпуса для зонда
  window.__sim.dockAt("station-0");
  const f2 = window.__uiBridge.getSnapshot().station.fleet;
  window.__gameApi.current.equipModule(f2.stash.findIndex((s) => s.itemId === "hammer-C"), "weapon", 0);
  const s2 = window.__sim.ship();
  out.hammerEquipped = s2.installed.weapon[0] === "hammer-C";
  out.needleToStash = window.__uiBridge.getSnapshot().station.fleet.stash.some((s) => s.itemId === "needle-C");
  const f3 = window.__uiBridge.getSnapshot().station.fleet;
  window.__gameApi.current.equipModule(f3.stash.findIndex((s) => s.itemId === "reactor-C"), "engine", 0);
  window.__gameApi.current.unequipModule("engine", 0);
  const s3 = window.__sim.ship();
  out.engineDefaulted = s3.installed.engine[0] === "turbine-C"; // дежурный двигатель фрегата
  return out;
});
const okFit = fit.fighterFits === false && fit.rejected && fit.stillStashed
  && fit.hammerEquipped && fit.needleToStash && fit.engineDefaulted;

// ── 5. сейв v9: фит, кредиты и delta через перезагрузку ──
const saved = await page.evaluate(() => {
  window.__gameApi.current.saveNow();
  const raw = localStorage.getItem("game.savegame");
  const sv = raw ? JSON.parse(raw) : null;
  return { sv, a: window.__econAudit(), s: window.__sim.ship() };
});
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });
const restored = await page.evaluate(() => {
  window.__gameApi.current.continueGame();
  return { a: window.__econAudit(), s: window.__sim.ship() };
});
const sameFleet = (x, y) => x.ship === y.ship
  && JSON.stringify(x.installed) === JSON.stringify(y.installed)
  && JSON.stringify(x.stash) === JSON.stringify(y.stash);
const okSave = !!saved.sv && saved.sv.v === 9 && sameFleet(saved.sv.player, saved.s)
  && sameFleet(restored.s, saved.s) && restored.a.delta === saved.a.delta && restored.a.player === saved.a.player;

await done({
  okStart, okDock, okHullBuy, okModuleBuy, okEquipDps, okModuleSell, okHullSell,
  okBuyMax, okSellAll, okGoodsUi,
  okMine, okHubGate, okClanGate, okFit, okSave,
  noPageErrors: pageErrors.length === 0,
}, {
  st0,
  trades: { money: [trades.a0, trades.a1, trades.a2, trades.a3, trades.a4].map((x) => ({ p: x.player, d: x.delta })), s1: trades.s1, s2: trades.s2, s4: trades.s4 },
  goods: { used: [goods.used0, goods.used1, goods.used2], credits: goods.credits, cargoMax: goods.cargoMax, ui: goods.ui },
  mine, hubGate, clanGate, fit,
  save: { v: saved.sv?.v, credits: [saved.a.player, restored.a.player], delta: [saved.a.delta, restored.a.delta] },
  pageErrors: pageErrors.slice(0, 3),
});
