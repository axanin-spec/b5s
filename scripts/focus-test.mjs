/**
 * focus-test.mjs — автопроб фокуса мыши и шестизвёздной карты.
 * Проверяет:
 *  1. штатный огонь: зажал ЛКМ на канвасе — выстрелы пошли, отпустил — замолчали;
 *  2. «осиротевший» mouseup после blur (клик, у которого mousedown съела активация
 *     окна) — банк тапа даёт ровно один выстрел;
 *  3. возврат курсора на канвас с уже зажатой кнопкой (pointerenter+buttons) — огонь
 *     возобновляется без нового нажатия;
 *  4. карта «Галактика» показывает все шесть узлов; клик по узлу «Терминус» открывает
 *     его сводку (раньше новые системы не рисовались вовсе).
 *
 * Использование: npm run build && npm run focus
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
  console.error(`FOCUS FAIL: no build output at ${DIST} — run \`npm run build\` first`);
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
if (!browser) { console.error("FOCUS FAIL: no usable browser"); server.close(); process.exit(1); }
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL_, { waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });
await page.evaluate(() => { window.__gameApi.current.newGame(); window.__sim.god(); });
await page.waitForTimeout(300);
const shots = () => page.evaluate(() => window.__input().shots);
const inp = () => page.evaluate(() => window.__input());
const box = await page.locator("#game-canvas").boundingBox();
const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

// ── 1. штатное удержание ЛКМ ──
await page.mouse.move(mid.x, mid.y);
const s0 = await shots();
await page.mouse.down();
const held = await inp();
await page.waitForTimeout(500);
const firedHeld = (await shots()) > s0;
await page.mouse.up();
const s1 = await shots();
await page.waitForTimeout(400);
const okHeld = held.mouseDown === true && held.firing === true && firedHeld
  && (await inp()).mouseDown === false && (await shots()) - s1 <= 1; // после отпускания — не больше осечки гашения

// ── 2. blur + проглоченный mousedown: осиротевший mouseup = один выстрел ──
await page.evaluate(() => {
  window.dispatchEvent(new Event("blur"));
  const c = document.getElementById("game-canvas");
  c.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
});
const s2 = await shots();
await page.waitForTimeout(250);
const tap = await shots();
await page.waitForTimeout(350);
const okTap = tap === s2 + 1 && (await shots()) === tap; // ровно один, без повторов
const afterTap = await inp();

// ── 3. курсор вернулся на канвас с зажатой кнопкой ──
await page.evaluate(() => {
  const c = document.getElementById("game-canvas");
  c.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", buttons: 1, bubbles: true }));
});
const back = await inp();
const s3 = await shots();
await page.waitForTimeout(450);
const firedBack = (await shots()) > s3;
await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })));
const rel = await inp();
const okEnter = back.firing === true && firedBack && rel.firing === false;

// ── 4. карта: шесть узлов, клик по Терминусу ──
const mapData = await page.evaluate(() => {
  window.__gameApi.current.toggleMap();
  const m = window.__uiBridge.getSnapshot().map;
  return { ids: m.systems.map((s) => s.id), layouts: m.layouts.length };
});
const cv = await page.locator(".sm-canvas").boundingBox();
// Терминус в GAL_POS: (0.15, 0.69) от доли канваса
await page.mouse.click(cv.x + 0.15 * cv.width, cv.y + 0.69 * cv.height);
await page.waitForTimeout(150);
const panel = await page.locator(".sm-name").first().innerText().catch(() => "");
await page.screenshot({ path: join(ROOT, "verification-shots", "focus-map-6.png") });
await page.evaluate(() => window.__gameApi.current.closeMap());
const okMap = mapData.ids.length === 6 && mapData.layouts === 6
  && ["terminus", "aurora", "kar"].every((id) => mapData.ids.includes(id))
  && panel.includes("Терминус");

const ok = {
  okHeld, okTap, okEnter, okMap,
  noPageErrors: pageErrors.length === 0,
};
console.log(JSON.stringify({ ok, map: mapData, panel: panel.slice(0, 40), afterTap, pageErrors: pageErrors.slice(0, 3) }, null, 1));
await browser.close();
server.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
