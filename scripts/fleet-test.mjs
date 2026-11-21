/**
 * fleet-test.mjs — автотест флота (Этап 7b): верфь, снаряжение, гейты рынка.
 * Docking-операции пачкуются синхронно внутри одного page.evaluate — между
 * аудитом и сделкой не проскакивает ни один rAF-кадр, поэтому пулы двигает
 * только сама сделка. Проверяет:
 *  1. старт: истребитель с китом — hp/щит/реген/скорость/трюм/DPS из HULLS+EQUIP;
 *  2. консервация денег: покупка корпуса с зачётом, покупка/продажа модуля, сдача
 *     корпуса — delta не шевелится, деньги перетекают игрок ↔ stations 1:1,
 *     а патрульный тариф (13a, 2% с оборота) идёт stations → patrol точно по LEVY;
 *  2b. терминал 10d: «Макс» набивает трюм до упора (деньги/вместимость — clamp в buy),
 *     «Продать весь трюм» (sellAll) обнуляет его, delta снова не шевелится, кнопки в DOM;
 *  3. гейты: шахта торгует только C/B и корпусами «any»; на хабе SS только с
 *     Альянсом ≥ +35; SSS и «флагманские» линии — только клановый рынок с кланами
 *     ≥ +35 (оккупированный Никс);
 *  4. совместимость: орудие чужого класса корпусу не встаёт, на своём — встаёт
 *     и поднимает DPS; снятый двигатель заменяется дежурным корпуса;
 *  4b. торговые корпуса 14f: лихтер на стенде где угодно, барк — только на сборочных
 *     стапелях; покупка меняет трюм/слоты, чужой фит уезжает на склад, дежурный
 *     двигатель корпусной; средняя линейка барку встаёт, лёгкая — мимо; ₡ 1:1;
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
// Этап 13a: патрульный тариф 2% с оборота — станция платит из маржи (stations → patrol)
const LEVY = (g) => Math.round(g * 0.02);
const okDock = trades.docked === true;
const okHullBuy = trades.a1.delta === trades.a0.delta && trades.a1.player === trades.a0.player - 39000
  && poolD(trades.a1, trades.a0, "stations") === 39000 - LEVY(39000)
  && trades.s1.ship === "corvette" && trades.s1.hp === 300 && trades.s1.cargo === 48
  && trades.s1.shield === 91 && trades.s1.speed === 430; // 40 плит + черепаха-C 51
const okModuleBuy = trades.a2.delta === trades.a1.delta && trades.a2.player === trades.a1.player - 5760
  && poolD(trades.a2, trades.a1, "stations") === 5760 - LEVY(5760) && trades.waspInShop;
const okEquipDps = trades.s2.installed.weapon[1] === "wasp-B" && trades.absentAfterEquip
  && Math.abs(trades.s2.dps - (9 + 15) * 3.6) < 0.01; // залп из двух стволов под темп лучшего
const okModuleSell = trades.a3.delta === trades.a2.delta && trades.a3.player === trades.a2.player + 3168
  && poolD(trades.a3, trades.a2, "stations") === -3168 - LEVY(3168);
const okHullSell = trades.a4.delta === trades.a3.delta && trades.a4.player === trades.a3.player + 25200
  && poolD(trades.a4, trades.a3, "stations") === -25200 - LEVY(25200)
  && trades.s4.ship === "fighter" && trades.s4.hp === 120 && trades.s4.installed.engine[0] === "spark-C";
// okTariff (13a): казна патруля выросла ровно на сумму тарифов четырёх сделок —
// доходный контур казны больше не зависит от одних штрафов трибунала
const tariffGot = poolD(trades.a4, trades.a0, "patrol");
const tariffWant = LEVY(39000) + LEVY(5760) + LEVY(3168) + LEVY(25200);
const okTariff = tariffGot === tariffWant;

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

// ── 4b. торговые корпуса (14f): лихтер/барк — покупка на хабе, гейт верфи на
//       шахте, переезд фита, конформность средней линейки барку; деньги 1:1 с пулом ──
const trade = await page.evaluate(() => {
  const api = window.__gameApi.current;
  const out = { trace: [] };
  const tr = (k) => out.trace.push([k, window.__sim.probe()]);
  // стоим на хабе «Ковчег» (eidolon), корпус фрегат. Лихтер: net = 26000 − 0.6×150000 = −64000 (сдача)
  tr("entry");
  window.__sim.cash(500000);
  const a0 = window.__econAudit();
  api.buyHull("lighter");
  const a1 = window.__econAudit();
  const s1 = window.__sim.ship();
  const f1 = window.__uiBridge.getSnapshot().station.fleet;
  out.lighter = {
    ship: s1.ship, hp: s1.hp, cargo: s1.cargo,
    wSlots: s1.installed.weapon.length, eDefault: s1.installed.engine[0] === "spark-C",
    hammerToStash: f1.stash.some((s) => s.itemId === "hammer-C"),
    gain: a1.player - a0.player, deltaKept: a1.delta === a0.delta,
    pool: a1.pools.stations - a0.pools.stations,
  };
  // шахта: лихтер в стенде (yard «any»), барк заперт (yard «core»); покупка барка — отказ
  tr("afterLighter");
  api.undock();
  tr("afterUndock");
  out.mineDocked = window.__sim.dockAt("station-2");
  tr("afterMineDock");
  const sfm = window.__uiBridge.getSnapshot().station;
  const fm = sfm ? sfm.fleet : null;
  const lighterM = fm ? fm.hulls.find((h) => h.id === "lighter") : null;
  const barkM = fm ? fm.hulls.find((h) => h.id === "bark") : null;
  // лихтер уже на нас — в стенде он как «ваш корпус», проверяем отсутствие гейта;
  // барк на шахте обязан быть заперт с объяснением
  out.lighterGateFree = !!lighterM && !lighterM.why && (lighterM.stock || lighterM.current);
  out.barkLockedMine = !!barkM && !barkM.stock && !!barkM.why;
  const aR0 = window.__econAudit();
  api.buyHull("bark");
  const aR1 = window.__econAudit();
  out.refused = window.__sim.ship().ship === "lighter" && aR1.player === aR0.player && aR1.delta === aR0.delta;
  // хаб: барк (net = 120000 − 0.6×26000 = 104400), искра уезжает на склад, дежурит турбина
  window.__sim.dockAt("station-0");
  window.__sim.cash(500000);
  const a2 = window.__econAudit();
  api.buyHull("bark");
  const a3 = window.__econAudit();
  const s2 = window.__sim.ship();
  out.bark = {
    ship: s2.ship, hp: s2.hp, cargo: s2.cargo,
    wSlots: s2.installed.weapon.length, sSlots: s2.installed.shield.length,
    sparkToStash: window.__uiBridge.getSnapshot().station.fleet.stash.some((s) => s.itemId === "spark-C"),
    eDefault: s2.installed.engine[0] === "turbine-C",
    pay: a2.player - a3.player, deltaKept: a3.delta === a2.delta,
    pool: a3.pools.stations - a2.pools.stations,
  };
  // совместимость 14f: средняя линейка («Шершень») барку встаёт, лёгкая («Игла») — мимо
  window.__sim.give("wasp-C");
  window.__sim.give("needle-B");
  window.__sim.dockAt("station-0");
  const f3 = window.__uiBridge.getSnapshot().station.fleet;
  const iw = f3.stash.findIndex((s) => s.itemId === "wasp-C");
  const inn = f3.stash.findIndex((s) => s.itemId === "needle-B");
  out.fits = { wasp: f3.stash[iw].fits, needle: f3.stash[inn].fits };
  api.equipModule(iw, "weapon", 0);
  out.waspOn = window.__sim.ship().installed.weapon[0] === "wasp-C";
  api.equipModule(window.__uiBridge.getSnapshot().station.fleet.stash.findIndex((s) => s.itemId === "needle-B"), "weapon", 0);
  out.needleRejected = window.__sim.ship().installed.weapon[0] === "wasp-C"
    && window.__uiBridge.getSnapshot().station.fleet.stash.some((s) => s.itemId === "needle-B");
  return out;
});
const okTradeLighter = trade.lighter.ship === "lighter" && trade.lighter.hp === 220 && trade.lighter.cargo === 90
  && trade.lighter.wSlots === 1 && trade.lighter.eDefault && trade.lighter.hammerToStash
  && trade.lighter.gain === 64000 && trade.lighter.deltaKept
  && Math.abs(trade.lighter.pool + (64000 + LEVY(64000))) < 1;
const okTradeMine = trade.mineDocked && trade.lighterGateFree && trade.barkLockedMine && trade.refused;
const okTradeBark = trade.bark.ship === "bark" && trade.bark.hp === 560 && trade.bark.cargo === 240
  && trade.bark.wSlots === 1 && trade.bark.sSlots === 2 && trade.bark.sparkToStash && trade.bark.eDefault
  && trade.bark.pay === 104400 && trade.bark.deltaKept && Math.abs(trade.bark.pool - (104400 - LEVY(104400))) < 1;
const okTradeFit = trade.fits.wasp === true && trade.fits.needle === false
  && trade.waspOn === true && trade.needleRejected === true;

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
  okTariff,
  okBuyMax, okSellAll, okGoodsUi,
  okMine, okHubGate, okClanGate, okFit,
  okTradeLighter, okTradeMine, okTradeBark, okTradeFit,
  okSave,
  noPageErrors: pageErrors.length === 0,
}, {
  st0,
  trades: { money: [trades.a0, trades.a1, trades.a2, trades.a3, trades.a4].map((x) => ({ p: x.player, d: x.delta })), tariff: { got: tariffGot, want: tariffWant }, s1: trades.s1, s2: trades.s2, s4: trades.s4 },
  goods: { used: [goods.used0, goods.used1, goods.used2], credits: goods.credits, cargoMax: goods.cargoMax, ui: goods.ui },
  mine, hubGate, clanGate, fit, trade,
  save: { v: saved.sv?.v, credits: [saved.a.player, restored.a.player], delta: [saved.a.delta, restored.a.delta] },
  pageErrors: pageErrors.slice(0, 3),
});
