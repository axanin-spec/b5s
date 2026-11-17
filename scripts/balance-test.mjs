/**
 * balance-test.mjs — экономика-автотест (Этап 5e): гоняет мир fixed-step'ами через
 * __sim.step (time-warp, без ожидания rAF) и проверяет три столпа баланса:
 *  1. инвариант денег: Σ пулов + float торговцев + игрок = MONEY_TOTAL (delta 0) на
 *     всём 5-минутном прогоне боевых действий + круг через сейв (save v6 round-trip);
 *  2. корреляция «бедные кланы → меньше пиратов»: кривая fund→strength по порогам
 *     PIRATE_ECON и ЖИВОЙ респавн (тонкий фонд → флот тает до минимума, полный → восстанавливается);
 *  3. отсутствие инфляции: кредиты игрока в [0, MONEY_TOTAL], total не гуляет, после
 *     setFund (нело-консервирующий дебаг-сеттер) delta остаётся КОНСТАНТНОЙ.
 * setFund/god/hide — дебаг-хуки (__pirateEcon, __sim), игрок в тесте безучастен:
 * не стреляет, не торгует → деньги двигает только автопилот мира.
 *
 * Использование: npm run build && npm run balance   (сервит dist/, как verify-game)
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
  console.error(`BALANCE FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("BALANCE FAIL: no usable browser"); server.close(); process.exit(1); }
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

// ── прогон: newGame, безучастный игрок в углу, N игровых минут чанками по 10 с ──
async function warp(minutes, tag) {
  await page.evaluate(() => {
    window.__gameApi.current.newGame();
    window.__sim.god();
    window.__sim.hide();
  });
  const checkpoints = [];
  const chunks = Math.round((minutes * 60) / 10);
  for (let i = 0; i < chunks; i++) {
    const a = await page.evaluate(() => {
      const audit = window.__sim.step(600); // 10 игровых секунд за чанк
      return { audit, playing: window.__sim.playing };
    });
    if (!a.playing) return { checkpoints, died: true };
    checkpoints.push(a.audit);
  }
  return { checkpoints, died: false, tag };
}

const inRange = (p) => Object.values(p.pools).every((v) => Number.isFinite(v) && v >= -p.total && v <= p.total)
  && Number.isFinite(p.player) && p.player >= 0 && p.player <= p.total;

// ── 1. инвариант денег на 5 минутах войны ──
const run1 = await warp(5);
const deltas = run1.checkpoints.map((c) => c.delta);
// Парные переводы гасятся дробно, так что дельта держится на нуле; слияние кошельков
// торговцев с пулом Альянса даёт только шум суммирования float64 (1e-7). Порог — копейка.
const okInvariant = !run1.died
  && run1.checkpoints.length === 30
  && deltas.every((d) => Math.abs(d) < 0.01)
  && run1.checkpoints.every(inRange);
// мир должен жить: за 5 минут хоть что-то происходит — пулы шевелятся (налоги,грабёж, бои)
const moved = run1.checkpoints.some((c) =>
  c.pools.stations !== run1.checkpoints[0].pools.stations || c.pools.clan !== run1.checkpoints[0].pools.clan
  || c.pools.patrol !== run1.checkpoints[0].pools.patrol || c.traderFloat !== run1.checkpoints[0].traderFloat);

// ── 2a. кривая fund→strength по порогам ──
const curve = await page.evaluate(() => {
  const pts = [350000, 250000, 205000, 155000, 60000, 0, -100000].map((f) => {
    window.__pirateEcon().setFund(f);
    return { f, s: window.__pirateEcon().strength };
  });
  window.__pirateEcon().setFund(250000); // вернём сытости для живой части
  return pts;
});
const nonIncreasing = curve.every((p, i) => i === 0 || p.s <= curve[i - 1].s);
const atThresholds = curve[0].s === 9 && curve[1].s === 9 && curve[2].s === 8 && curve[3].s === 8
  && curve[4].s === 6 && curve[5].s === 6 && curve[6].s === 6;
const okCurve = nonIncreasing && atThresholds;

// ── 2b. живой респавн: тонкий фонд → флот тает; полный → восстанавливается ──
// setFund консервирует money-массу сам (сдвигает delta), поэтому за константность
// отвечаем так: delta сразу после setFund == delta после N минут симуляции.
// Популяция живая и осциллирует (спавн 3.2 с против убийств патрулём; списания
// HULL_COST роняют фонд ниже FUND_FULL → потолок 9→8), поэтому берём НЕ снимок
// в конце окна (он ловит случайную фазу качелей), а дно тонкой фазы и пик тучной:
// «тает» = дно ≤ PIRATES_MIN, «восстанавливается» = пик ≥ 8 и выше дна на 2+.
async function samplePirates(minutes) {
  const before = await page.evaluate(() => window.__econAudit().delta);
  const chunks = Math.round((minutes * 60) / 10);
  let last = null, min = Infinity, max = -Infinity;
  for (let i = 0; i < chunks; i++) {
    last = await page.evaluate(() => window.__sim.step(600) && window.__sim.count("pirate"));
    if (last !== null) { if (last < min) min = last; if (last > max) max = last; }
  }
  const after = await page.evaluate(() => window.__econAudit().delta);
  return { count: last, min, max, before, after };
}
await page.evaluate(() => window.__pirateEcon().setFund(40000)); // заведомо тонкий
const thin = await samplePirates(5);
await page.evaluate(() => window.__pirateEcon().setFund(330000));
const fat = await samplePirates(4);
const okRespawn = thin.count !== null && fat.count !== null && thin.min <= 6 && fat.max >= 8 && fat.max > thin.min + 1;
// drift за минуты симуляции — плавающий шум суммирования (≤1e-6), экономика обязана беречь ₡ целиком
const okDeltaStable = Math.abs(thin.before - thin.after) < 0.5 && Math.abs(fat.before - fat.after) < 0.5;

// ── 3. save v6 round-trip ──
// Нюанс 5b: сейв пишет Альянс БРУТТО (кошельки караванов влиты в пул, при загрузке
// караваны возрождаются и занимают заново) — поэтому с сейвом сверяем alliance+float,
// а восстановление после reload — тоже по брутто (нетто-альянс зависит от жеребьёвки кошельков).
const saved = await page.evaluate(() => {
  window.__gameApi.current.saveNow();
  const a = window.__econAudit();
  const raw = localStorage.getItem("game.savegame");
  const sv = raw ? JSON.parse(raw) : null;
  return { a, sv: sv ? { pools: sv.pools, credits: sv.player.credits, v: sv.v, raid: sv.raid } : null };
});
const near = (x, y) => Math.abs(x - y) < 1.5;
const roundTrip = !!saved.sv && saved.sv.v === 8 && saved.sv.raid === null
  && near(saved.sv.pools.alliance, saved.a.pools.alliance + saved.a.traderFloat)
  && ["patrol", "clan", "stations"].every((k) => near(saved.sv.pools[k], saved.a.pools[k]))
  && near(saved.sv.credits, saved.a.player);
// перезагрузка → continueGame: delta перенеслась один в один, брутто-Альянс цел
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });
const after = await page.evaluate(() => {
  window.__gameApi.current.continueGame();
  return window.__econAudit();
});
const okRestore = after.delta === saved.a.delta
  && near(after.pools.alliance + after.traderFloat, saved.sv.pools.alliance)
  && ["patrol", "clan", "stations"].every((k) => near(after.pools[k], saved.a.pools[k]));

const okPlayerBound = saved.a.player >= 0 && saved.a.player <= saved.a.total && after.player >= 0 && after.player <= after.total;

await done({
  okInvariant, worldAlive: moved, okCurve, okRespawn, okDeltaStable,
  roundTrip, okRestore, okPlayerBound,
  noPageErrors: pageErrors.length === 0,
}, {
  curve,
  pirates: { thin: { min: thin.min, end: thin.count, max: thin.max }, fat: { min: fat.min, end: fat.count, max: fat.max } },
  invariant: {
    start: run1.checkpoints[0]?.pools, end: run1.checkpoints.at(-1)?.pools,
    deltasDistinct: [...new Set(deltas)],
  },
  deltas: { thinRun: [thin.before, thin.after], fatRun: [fat.before, fat.after], afterLoad: after.delta },
  saved: { audit: saved.a, save: saved.sv },
  pageErrors: pageErrors.slice(0, 3),
});
