/**
 * watch-test.mjs — зонд казны патруля (Этап 11b): дозор живёт на свои деньги.
 * Проверяет:
 *  1. кривую казна→численность: полная казна (≥ TREASURY_FULL) держит полный
 *     дозор И спавнит тяжёлый крейсер «Варта»; средняя — только дозор;
 *     тонкая (< TREASURY_THIN) — дозор урезан до THIN_PATROLS;
 *  2. статы крейсера из PATROL_ECON.CRUISER (hp/щит/позывной);
 *  3. баунти за крейсер: поддон кредитов в диапазоне CRUISER.bounty,
 *     деньги из казны патруля (инвариант не двигается);
 *  4. дельта инварианта денег стабильна между чекпоинтами.
 * Тест идёт в Эйдолоне (patrolBoost 0 → база 6).
 *
 * Использование: npm run build && npm run watch
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
  console.error(`WATCH FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("WATCH FAIL: no usable browser"); server.close(); process.exit(1); }
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
});

const FULL = 450000, THIN = 100000;

// ── 1. жирная казна: полный дозор + крейсер «Варта» ──
await page.evaluate((f) => window.__patrolEcon().setFund(f), FULL + 50000);
// крейсер спавнится в maintainPopulation — даём до ~30 игровых секунд
let fatProbe = null;
for (let i = 0; i < 6; i++) {
  fatProbe = await page.evaluate(() => window.__sim.step(300) && window.__patrolEcon());
  if (fatProbe.cruiserUp) break;
}
const okFullStrength = fatProbe.strength === 6;
const okCruiserSpawn = fatProbe.cruiserUp === true;
const c = fatProbe.cruiser ?? {};
const okCruiserStats = okCruiserSpawn && c.maxHp === 450 && c.shield === 220 && c.name === "Варта";

// ── 2. баунти за крейсер: поддон 2500–4000, инвариант не шевельнулся ──
const d0 = await page.evaluate(() => window.__econAudit().delta);
const bounty = await page.evaluate(() => {
  const before = window.__sim.pickups().length;
  const at = window.__sim.kill("cruiser");
  if (!at) return null;
  const fresh = window.__sim.pickups().slice(before);
  const credit = fresh.filter((p) => p.kind === "credits").map((p) => p.amount);
  return { at, credit };
});
const d1 = await page.evaluate(() => window.__econAudit().delta);
const okCruiserBounty = !!bounty && bounty.credit.length > 0
  && bounty.credit.every((a) => a >= 2500 && a <= 4000);
const okDeltaKill = Math.abs(d1 - d0) < 0.01;

// ── 3. средняя казна: дозор полный, крейсер не комиссуют ──
await page.evaluate((f) => window.__patrolEcon().setFund(f), 300000);
await page.evaluate(() => window.__sim.step(600));
const midProbe = await page.evaluate(() => window.__patrolEcon());
const okMidNoCruiser = midProbe.strength === 6 && midProbe.cruiserUp === false;

// ── 4. тонкая казна: редкий дозор ──
await page.evaluate((f) => window.__patrolEcon().setFund(f), THIN - 50000);
const thinProbe = await page.evaluate(() => window.__patrolEcon());
const d2 = await page.evaluate(() => window.__econAudit().delta);
await page.evaluate(() => window.__sim.step(600));
const d3 = await page.evaluate(() => window.__econAudit().delta);
const okThinStrength = thinProbe.strength === 4;
const okDeltaStable = Math.abs(d3 - d2) < 0.5;

// ── 5. казна снова полная: дозор и крейсер возвращаются ──
await page.evaluate((f) => window.__patrolEcon().setFund(f), FULL + 50000);
let backProbe = null;
for (let i = 0; i < 6; i++) {
  backProbe = await page.evaluate(() => window.__sim.step(300) && window.__patrolEcon());
  if (backProbe.cruiserUp) break;
}
const okCruiserRespawn = backProbe.strength === 6 && backProbe.cruiserUp === true;

await done({
  okFullStrength, okCruiserSpawn, okCruiserStats, okCruiserBounty, okDeltaKill,
  okMidNoCruiser, okThinStrength, okDeltaStable, okCruiserRespawn,
  noPageErrors: pageErrors.length === 0,
}, {
  fat: { strength: fatProbe.strength, cruiser: fatProbe.cruiser },
  bounty,
  mid: { strength: midProbe.strength, cruiserUp: midProbe.cruiserUp },
  thin: { strength: thinProbe.strength },
  back: { strength: backProbe.strength, cruiserUp: backProbe.cruiserUp },
  deltas: { d0, d1, d2, d3 },
  pageErrors: pageErrors.slice(0, 3),
});
