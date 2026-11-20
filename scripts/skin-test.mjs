/**
 * skin-test.mjs — автотест WebGL-«шубы» (Этап 12a): three-скелет под той же симуляцией.
 * Орто-камера сверху, канвас ввода не тронут, фон — нижний 2D-холст. Проверяет:
 *  1. __gl.enable(): режим 3d включился, спрайты и draw calls ненулевые;
 *  2. слои DOM: #bg-canvas → #gl-canvas → #game-canvas (ввод остаётся верхним);
 *  3. шов screenToWorld: центр экрана → camX/camY; +100px → +100/ppu; вверх экрана
 *     → +y мир (орто-формула одинакова в обоих режимах, допуск 0.5);
 *  4. GL-канвас не чёрный (preserveDrawingBuffer → чтение пикселей);
 *  5. __gameProbe после переключения — прежний контракт {x, 0, −y};
 *  6. мышь живая: pointerdown по канвасу в 3d-режиме зажигает стрельбу (__input);
 *  7. скриншот verification-shots/skin-play.png снят.
 *
 * Использование: npm run preskin && npm run skin   (сервит dist/, как intel-test)
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = existsSync(join(ROOT, "dist/public/index.html")) ? join(ROOT, "dist/public") : join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`SKIN FAIL: no build output at ${DIST} — run \`npm run preskin\` first`);
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
if (!browser) { console.error("SKIN FAIL: no usable browser"); server.close(); process.exit(1); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL_, { waitUntil: "load" });
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 30000 });

const done = (ok, extra) => {
  console.log(JSON.stringify({ ok, ...extra }, null, 1));
  browser.close().then(() => server.close());
  process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
};

// старт: новая игра, бессмертный игрок (в 3d-режиме он тоже должен выживать)
await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
});
await page.waitForTimeout(400);
const g0 = await page.evaluate(() => window.__gameProbe());

// ── 1/2. включение 3d: мост, порядок холстов ──
const en = await page.evaluate(() => {
  const r = window.__gl.enable();
  // порядок среди трёх слоёв рендера (миникарта HUD — не холст мира, её не считаем)
  const sel = "canvas#bg-canvas, canvas#gl-canvas, canvas#game-canvas";
  return { r, layers: [...document.querySelectorAll(sel)].map((c) => c.id) };
});
await page.waitForTimeout(700); // несколько GL-кадров
const st = await page.evaluate(() => window.__gl.state());
const okGl = en.r === true && st.mode === "3d" && st.sprites > 0 && st.drawCalls > 0;
// #game-canvas обязан остаться последним (верхним) — иначе мышиный ввод уйдёт в GL-холст
const okLayers = en.layers.length === 3 && en.layers[0] === "bg-canvas"
  && en.layers[1] === "gl-canvas" && en.layers[2] === "game-canvas";

// ── 3. шов screenToWorld (тот же в обоих режимах) ──
const seam = await page.evaluate(() => {
  const v = window.__gl.view();
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  return {
    v,
    center: window.__gl.s2w(cx, cy),
    right: window.__gl.s2w(cx + 100, cy),
    up: window.__gl.s2w(cx, cy - 100),
  };
});
const near = (a, b) => Math.abs(a - b) < 0.5;
const px2world = 100 / seam.v.ppu;
const okAim = near(seam.center.x, seam.v.camX) && near(seam.center.y, seam.v.camY)
  && near(seam.right.x, seam.v.camX + px2world) && near(seam.right.y, seam.v.camY)
  && near(seam.up.x, seam.v.camX) && near(seam.up.y, seam.v.camY + px2world);

// ── 4. GL-канвас не чёрный (копируем WebGL-канвас во временный 2D и считаем пиксели) ──
const nonBlack = await page.evaluate(() => {
  const glc = document.getElementById("gl-canvas");
  if (!glc) return { ok: false };
  const tmp = document.createElement("canvas");
  tmp.width = 320; tmp.height = 200;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(glc, 0, 0, tmp.width, tmp.height);
  const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8 && (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12)) lit++;
  }
  return { ok: lit > 100, lit };
});
const okNonBlack = nonBlack.ok === true;

// ── 5. контракт __gameProbe не поехал: {x, 0, −y} ──
const g1 = await page.evaluate(() => window.__gameProbe());
const okProbe2d = g1.y === 0 && Number.isFinite(g1.z) && Math.abs(g1.x - g0.x) < 60;

// ── 6. мышь живая: зажжённая ЛКМ по канвасу в 3d-режиме даёт выстрелы ──
const shots0 = await page.evaluate(() => window.__input().shots);
await page.mouse.move(840, 360);
await page.mouse.down();
await page.waitForTimeout(700);
const held = await page.evaluate(() => window.__input());
await page.mouse.up();
const okInput = held.mouseDown === true && held.shots > shots0;

// ── 7. скриншот 3d-режима ──
mkdirSync(join(ROOT, "verification-shots"), { recursive: true });
await page.screenshot({ path: join(ROOT, "verification-shots", "skin-play.png") });
const okShots = existsSync(join(ROOT, "verification-shots", "skin-play.png"));

await done({
  okGl, okLayers, okAim, okNonBlack, okProbe2d, okInput, okShots,
  noPageErrors: pageErrors.length === 0,
}, {
  layers: en.layers,
  glState: st,
  seam: { v: seam.v, center: seam.center, right: seam.right, up: seam.up, px2world },
  probe: { before: g0, after: g1 },
  litPx: nonBlack.lit,
  shots: [shots0, held.shots],
  pageErrors: pageErrors.slice(0, 3),
});
