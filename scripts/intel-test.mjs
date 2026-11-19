/**
 * intel-test.mjs — автопроб рыночной разведки (Этап 10a).
 * Проверяет:
 *  1. стыковка записывает снимок цен станции (совпадает с терминалом, все товары);
 *  2. вторая станция добавляется в журнал, повторная стыковка обновляет время снимка;
 *  3. сейв v9 несёт разведку в localStorage (докинг автосохраняет);
 *  4. на карте вкладка «Система» → «Рынки»: посещённые со ценами, прочие «нет данных»;
 *  5. сейв v8 без intel загружается и даёт пустую разведку (обратная совместимость).
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
const GOOD_IDS = ["food", "ore", "meds", "tech", "lux", "arms"];
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
const okSave = saved?.v === 9 && !!saved.intel?.[st0] && !!saved.intel?.[st1]
  && GOOD_IDS.every((g) => saved.intel[st0].prices[g]);

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

// ── 5. сейв v8 без intel: грузится, разведка пуста ──
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

const ok = { okRecord, okSecond, okRefresh, okSave, okUi, okV8, noPageErrors: pageErrors.length === 0 };
console.log(JSON.stringify({ ok, seen: { st0, st1 }, snap: { count: snap0.count, t: e0?.t, now: snap0.now }, upd, v8, pageErrors: pageErrors.slice(0, 3) }, null, 1));
await browser.close();
server.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
