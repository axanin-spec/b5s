/**
 * intel-test.mjs — автопроб рыночной разведки (Этап 10a).
 * Проверяет:
 *  1. стыковка записывает снимок цен станции (совпадает с терминалом, все товары);
 *  2. вторая станция добавляется в журнал, повторная стыковка обновляет время снимка;
 *  3. сейв v9 несёт разведку в localStorage (докинг автосохраняет);
 *  4. на карте вкладка «Система» → «Рынки»: посещённые со ценами, прочие «нет данных»;
 *  5. 14с: контрабанда (табак/специя/наркотики) торгуется везде — в союзном доку
 *     покупка проходит из-под прилавка (бейдж «сходняк», деньги в клановую кассу,
 *     станция и патруль не при чём), в Логово — открыто; сейв несёт clan-флаги;
 *  5b. 13c: вкладка «Галактика» — чип товара, панель «где купить/где продать»
 *     по всем разведанным станциям, курс к закупке через врата, повторный клик — свернуть;
 *  6. сейв v8 без intel загружается и даёт пустую разведку (обратная совместимость).
 *
 * Использование: npm run intel   (pre-хук сам соберёт build:test)
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
  console.error(`INTEL FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
  process.exit(1);
}
// 14g: к шести гражданским добавились три клановых — снимаются все девять
const GOOD_IDS = ["food", "ore", "meds", "tech", "lux", "arms", "tobacco", "spice", "drugs"];
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
if (!browser) { console.error("INTEL FAIL: no usable browser"); server.close(); process.exit(1); }
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL_, { waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });
await page.evaluate(() => { window.__gameApi.current.newGame(); window.__sim.god(); });
await page.waitForTimeout(300);

const stations = await page.evaluate(() => window.__sim.stations());
const st0 = stations[0].id, st1 = stations[1].id;

// ── 1. стыковка пишет снимок; цены равны терминалу, товары все ──
const seen = await page.evaluate((id) => {
  const ok = window.__sim.dockAt(id);
  const s = window.__uiBridge.getSnapshot().station;
  return { docked: ok, id: s?.id ?? null, prices: s?.prices ?? null };
}, st0);
await page.evaluate(() => window.__gameApi.current.undock());
const snap0 = await page.evaluate((id) => {
  window.__gameApi.current.toggleMap();
  const m = window.__uiBridge.getSnapshot().map;
  return { entry: m.intel.find((x) => x.dockableId === id) ?? null, count: m.intel.length, now: m.now };
}, st0);
const e0 = snap0.entry;
const okRecord = seen.docked && seen.id === st0 && !!e0 && e0.dockableId === st0 && e0.systemId === "eidolon"
  && GOOD_IDS.every((g) => e0.prices[g] && e0.prices[g].buy > 0 && e0.prices[g].sell > 0)
  && JSON.stringify(e0.prices) === JSON.stringify(seen.prices);

// ── 2. вторая станция + обновление времени при повторном доке ──
await page.waitForTimeout(1300); // playTime должен уйти вперёд (секунды реального времени)
const t1 = e0.t;
// карта пушится HUD-тиком только в полёте: после дока отстыковываемся и ждём тик (~8 Гц)
const dockAndFly = async (id) => {
  await page.evaluate((s) => { window.__sim.dockAt(s); window.__gameApi.current.undock(); }, id);
  await page.waitForTimeout(300);
  return page.evaluate((sid) => {
    const m = window.__uiBridge.getSnapshot().map;
    return { ids: m.intel.map((x) => x.dockableId), t: m.intel.find((x) => x.dockableId === sid)?.t ?? -1, now: m.now };
  }, id);
};
const two = await dockAndFly(st1);
const upd = await dockAndFly(st0); // перестыковка: снимок перезаписывается целиком
const okSecond = two.ids.includes(st1) && two.ids.includes(st0);
const okRefresh = upd.ids.length === 2 && upd.t > t1;

// ── 3. сейв v9 в localStorage (докинг автосохраняет) ──
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("game.savegame")));
// 13c: ключ разведки — «система:док» (id станций повторяются в каждой системе)
const okSave = saved?.v === 9 && !!saved.intel?.[`eidolon:${st0}`] && !!saved.intel?.[`eidolon:${st1}`]
  && GOOD_IDS.every((g) => saved.intel[`eidolon:${st0}`].prices[g]);

// ── 4. UI: вкладка «Система» → сворачиваемый блок «Рынки» ──
await page.locator(".starmap-tabs .tab").nth(1).click();
await page.waitForTimeout(250);
const head0 = await page.locator(".sm-mk-head").innerText().catch(() => "");
const collapsed = !(await page.locator(".sm-mk-table").count());
await page.locator(".sm-mk-head").click();
await page.waitForTimeout(300);
const table = await page.locator(".sm-mk-table").innerText().catch(() => "");
await page.screenshot({ path: join(ROOT, "verification-shots", "intel-markets.png") });
const names = await page.evaluate(() => window.__sim.stations().map((s) => s.name));
const okUi = collapsed
  && /\d+\/\d+ разведано/.test(head0)
  && table.includes(names[0]) && table.includes("нет данных")
  && !table.includes("устарело"); // снимки свежие — глушения быть не должно

// ── 5. 14с: чёрный рынок везде — в союзном доку контрабанда идёт из-под прилавка ──
// Союзная станция (Эйдолон): специя/табак/наркотики покупаются — молчаливого отказа
// 14g больше нет; в терминале бейдж «сходняк»; кредиты уходят в клановую кассу —
// станция получает только обычную торговлю, патруль не берёт тариф с уличной сделки.
const allianceStreet = await page.evaluate((id) => {
  window.__gameApi.current.closeMap();
  window.__sim.cash(20000); // на десяток специи с уличной наценкой
  window.__sim.dockAt(id);
  const s = window.__uiBridge.getSnapshot().station;
  const before = { ...s.cargo };
  const a0 = window.__econAudit();
  // покупка на свои: сходняк проворачивается, провиант — как всегда, по счёту станции
  window.__gameApi.current.buy("spice", 10);
  const a1 = window.__econAudit();
  window.__gameApi.current.buy("food", 5);
  const a2 = window.__econAudit();
  const after = window.__uiBridge.getSnapshot().station.cargo;
  return {
    clanMarket: s.clanMarket,
    spice: (after.spice ?? 0) - (before.spice ?? 0),
    food: (after.food ?? 0) - (before.food ?? 0),
    clanSpend: a1.pools.clan - a0.pools.clan, // специя: кредиты ушли кланам
    clanFood: a2.pools.clan - a1.pools.clan, // провиант — кланам ни кредита
    stationsSpend: a2.pools.stations - a0.pools.stations, // а еда — счёт станции
    delta: a2.delta,
  };
}, st0);
const streetTable = await page.locator(".trade-table").innerText().catch(() => "");
const okAllianceStreet = allianceStreet.clanMarket === false
  && allianceStreet.spice === 10 && allianceStreet.food === 5
  && allianceStreet.clanSpend > 0 && allianceStreet.clanFood === 0
  && allianceStreet.stationsSpend > 0 && Math.abs(allianceStreet.delta) < 1
  && streetTable.includes("СХОДНЯК") && !streetTable.includes("ЗАПРЕТ");
await page.evaluate(() => window.__gameApi.current.undock());

// Логово в Терминусе (клановый прилавок): контрабанда покупается свободно
const lairTrade = await page.evaluate(() => {
  window.__sim.jump("terminus");
  // умеренная накачка: 10 млн ₡ пробивали VICTORY_SHARE и game переходила в "victory",
  // из-за чего dock() выходил по state без вестей — 30 тыс. хватает на четыре ящика
  window.__sim.cash(30000);
  const rep = window.__sim.rep("clan", 40); // Логово не принимает чужих — делаем «своего» (6c)
  const okDock = window.__sim.dockAt("lair");
  const s = window.__uiBridge.getSnapshot().station;
  if (!s) return { id: null, okDock, rep, diag: window.__sim.probe(), news: window.__uiBridge.getSnapshot().news };
  const before2 = { ...s.cargo };
  window.__gameApi.current.buy("drugs", 4);
  window.__gameApi.current.buy("spice", 4);
  const after = window.__uiBridge.getSnapshot().station.cargo;
  return { id: s.id, okDock, rep, clanMarket: s.clanMarket, drugs: (after.drugs ?? 0) - (before2.drugs ?? 0), spice: (after.spice ?? 0) - (before2.spice ?? 0) };
});
await page.waitForTimeout(200);
const lairFlags = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("game.savegame"));
  return { lair: s.intel?.["terminus:lair"]?.clan, eidolon: s.intel?.[Object.keys(s.intel).find((k) => s.intel[k].systemId === "eidolon") ?? "" ]?.clan };
});
const okLairFree = lairTrade.id === "lair" && lairTrade.clanMarket === true
  && lairTrade.drugs === 4 && lairTrade.spice === 4
  && lairFlags.lair === true && lairFlags.eidolon === false;
await page.evaluate(() => window.__gameApi.current.undock());

// ── 5b. 13c: галактическая сводка цен на вкладке «Галактика» ──
// Собираем разведку ещё в двух системах (Кронос дорогой, Никс дешёвый) —
// панель и канвас должны указать самую дешёвую закупку и самую дорогую продажу.
const kronosDock = await page.evaluate(() => { window.__sim.jump("kronos"); return window.__sim.stations()[0].id })
const okKronosDock = await page.evaluate((id) => { const r = window.__sim.dockAt(id); window.__gameApi.current.undock(); return r }, kronosDock)
const nixDock = await page.evaluate(() => { window.__sim.jump("nix"); return window.__sim.stations()[0].id })
const okNixDock = await page.evaluate((id) => { const r = window.__sim.dockAt(id); window.__gameApi.current.undock(); return r }, nixDock)
// внимание: closeMap не обнуляет поле map в снимке — открытость смотрим по mapOpen
await page.evaluate(() => { if (!window.__uiBridge.getSnapshot().mapOpen) window.__gameApi.current.toggleMap() })
await page.waitForTimeout(300)
// ожидание зонда считаем прямо из снимка — без знания системных множителей
const xfExp = await page.evaluate(() => {
  const m = window.__uiBridge.getSnapshot().map
  const rows = m.intel.map((i) => ({ name: i.name, systemId: i.systemId, buy: i.prices.food.buy, sell: i.prices.food.sell }))
  let buy = rows[0], sell = rows[0]
  for (const r of rows) { if (r.buy < buy.buy) buy = r; if (r.sell > sell.sell) sell = r }
  return { buy, sell, cur: m.currentId, n: rows.length }
})
await page.locator('.sm-goods-btn[data-good="food"]').click()
await page.waitForTimeout(350)
const xfTxt = await page.locator(".sm-xf").innerText().catch(() => "")
// 5 станций разведаны (Эйдолон×2, Логово, Кронос, Никс) — без межсистемных коллизий ключей
const okXfPanel = okKronosDock && okNixDock && xfExp.n >= 5
  && xfTxt.includes(xfExp.buy.name) && xfTxt.includes(String(xfExp.buy.buy))
  && xfTxt.includes(xfExp.sell.name) && xfTxt.includes(String(xfExp.sell.sell))
  && /разница ₡\d+\/шт/.test(xfTxt)
await page.screenshot({ path: join(ROOT, "verification-shots", "galaxy-prices.png") })
// курс к закупке: если выгодный док не в нашей системе — путевая точка на врата
let okXfRoute = true
if (xfExp.buy.systemId !== xfExp.cur) {
  await page.locator(".sm-xf .btn").click()
  await page.waitForTimeout(250)
  okXfRoute = await page.evaluate(() => !!window.__uiBridge.getSnapshot().map.waypoint)
}
// повторный клик по чипу — сводка складывается
await page.locator('.sm-goods-btn[data-good="food"]').click()
await page.waitForTimeout(250)
const okXfToggle = (await page.locator(".sm-xf").count()) === 0

// ── 5c. 13c: миграция старой разведки — голый ключ «station-0» → «система:док» ──
const mig = await page.evaluate(() => {
  window.__gameApi.current.closeMap();
  const s = JSON.parse(localStorage.getItem("game.savegame"));
  const e = JSON.parse(JSON.stringify(s.intel["eidolon:station-0"]));
  s.intel = { "station-0": e }; // до-13c формат: ключ без системы, система только в записи
  localStorage.setItem("game.savegame", JSON.stringify(s));
  window.__gameApi.current.continueGame();
  window.__gameApi.current.toggleMap();
  const m = window.__uiBridge.getSnapshot().map;
  window.__gameApi.current.closeMap();
  return { n: m.intel.length, one: m.intel[0] ?? null };
});
const okMigrate = mig.n === 1 && mig.one?.systemId === "eidolon" && mig.one?.dockableId === "station-0";

// ── 6. сейв v8 без intel: грузится, разведка пуста ──
const v8 = await page.evaluate(() => {
  window.__gameApi.current.closeMap();
  const s = JSON.parse(localStorage.getItem("game.savegame"));
  s.v = 8; delete s.intel;
  localStorage.setItem("game.savegame", JSON.stringify(s));
  window.__gameApi.current.continueGame();
  window.__gameApi.current.toggleMap();
  const m = window.__uiBridge.getSnapshot().map;
  return { playing: window.__sim.playing === true, intel: m.intel.length };
});
const okV8 = v8.playing === true && v8.intel === 0;

const ok = { okRecord, okSecond, okRefresh, okSave, okUi, okAllianceStreet, okLairFree, okXfPanel, okXfRoute, okXfToggle, okMigrate, okV8, noPageErrors: pageErrors.length === 0 };
console.log(JSON.stringify({ ok, seen: { st0, st1 }, snap: { count: snap0.count, t: e0?.t, now: snap0.now }, upd, allianceStreet, lairTrade, lairFlags, xfExp, xfTxt: xfTxt.slice(0, 260), mig, v8, pageErrors: pageErrors.slice(0, 3) }, null, 1));
await browser.close();
server.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
