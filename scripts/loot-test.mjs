/**
 * loot-test.mjs — автотест трофейных модулей (Этап 11a). Проверяет:
 *  1. дроп случается: серия убийств пиратов даёт модули на склад;
 *  2. капы рангов: рядовой пират роняет максимум B-ранг и никогда флагманские
 *     линии (lance/citadel); SSS не выпадает ниоткуда (эксклюзив чёрного рынка);
 *  3. флагман роняет модуль гарантированно (кап SS);
 *  4. полный склад (64): поддон конвертируется в кредиты, склад не растёт,
 *     денежный инвариант держится (delta 0).
 *
 * Использование: npm run build && npm run loot   (сервит dist/, как balance-test)
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
  console.error(`LOOT FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("LOOT FAIL: no usable browser"); server.close(); process.exit(1); }
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
});

// ── 1. серия убийств пиратов: дроп, капы рангов, запрет флагманских линий ──
const pirateRun = await page.evaluate(() => {
  const drops = [];
  const deltas = [];
  let kills = 0;
  for (let wave = 0; wave < 8 && kills < 70; wave++) {
    window.__perf.stress(10);
    for (let k = 0; k < 10 && kills < 70; k++) {
      const before = window.__sim.ship().stash;
      if (!window.__sim.kill("pirate")) break;
      kills++;
      window.__sim.step(150); // 2.5 с — поддоны долетают и собираются
      const after = window.__sim.ship().stash;
      for (const id of after) if (!before.includes(id)) drops.push(id);
      deltas.push(window.__econAudit().delta);
      if (drops.length >= 3) break;
    }
    if (drops.length >= 3) break;
  }
  return { kills, drops, deltas };
});
const rankOf = (id) => id.split("-").pop();
const okDrop = pirateRun.drops.length >= 1;
const okPirateRankCap = pirateRun.drops.every((id) => rankOf(id) === "C" || rankOf(id) === "B");
const okNoFlagLine = pirateRun.drops.every((id) => !id.startsWith("lance-") && !id.startsWith("citadel-"));
const okDeltaPirates = pirateRun.deltas.every((d) => Math.abs(d) < 0.01);

// ── 2. флагман (Никс, оккупация): гарантированный дроп, SSS недостижим ──
const bossRun = await page.evaluate(() => {
  window.__sim.jump("nix");
  window.__sim.hide();
  window.__sim.god();
  for (let t = 0; t < 12 && window.__sim.count("boss") === 0; t++) window.__sim.step(600); // стапель 75 с
  const bossUp = window.__sim.count("boss") > 0;
  const before = window.__sim.ship().stash;
  window.__sim.kill("boss");
  window.__sim.step(200);
  const after = window.__sim.ship().stash;
  // флагман может уронить id, уже лежащий на складе с фазы пиратов, — считаем
  // и по пополнению списка, и по росту длины (склад тут заведомо не полон)
  const drops = after.filter((id, k) => !before.includes(id) || k >= before.length);
  return { bossUp, drops, grew: after.length - before.length, delta: window.__econAudit().delta };
});
const okBossUp = bossRun.bossUp;
const okBossDrop = bossRun.drops.length >= 1 && bossRun.grew >= 1;
const okNoSSS = [...pirateRun.drops, ...bossRun.drops].every((id) => rankOf(id) !== "SSS");

// ── 3. полный склад: конвертация в кредиты, склад не растёт, инвариант цел ──
const fullRun = await page.evaluate(() => {
  for (let i = window.__sim.ship().stash.length; i < 64; i++) window.__sim.give("needle-C");
  const out = { sawModulePod: false, converted: false, deltas: [] };
  for (let wave = 0; wave < 6 && !out.converted; wave++) {
    window.__perf.stress(8);
    for (let k = 0; k < 8; k++) {
      if (!window.__sim.kill("pirate")) break;
      const pods = window.__sim.pickups().filter((p) => p.kind === "module");
      if (pods.length > 0) out.sawModulePod = true;
      window.__sim.step(180);
      const st = window.__sim.ship().stash;
      out.deltas.push(window.__econAudit().delta);
      if (out.sawModulePod && st.length === 64 && window.__sim.pickups().every((p) => p.kind !== "module")) {
        out.converted = true; // поддон исчез, склад не вырос — ушёл в кредиты
        break;
      }
    }
  }
  return out;
});
const okStashConvert = fullRun.sawModulePod && fullRun.converted;
const okDeltaFull = fullRun.deltas.every((d) => Math.abs(d) < 0.01);

await done({
  okDrop, okPirateRankCap, okNoFlagLine, okDeltaPirates,
  okBossUp, okBossDrop, okNoSSS,
  okStashConvert, okDeltaFull,
  noPageErrors: pageErrors.length === 0,
}, {
  pirates: { kills: pirateRun.kills, drops: pirateRun.drops },
  boss: bossRun,
  full: { sawModulePod: fullRun.sawModulePod, converted: fullRun.converted },
  pageErrors: pageErrors.slice(0, 3),
});
