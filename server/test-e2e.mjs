/**
 * test-e2e.mjs — сквозной тест Этапа 15b: сервер + два реальных браузера.
 * Оба игрока регистрируются, входят в игру и должны увидеть друг друга
 * в шарде (window.__worldNet.players). Запуск: node server/test-e2e.mjs
 * Требует собранный dist/ (npm run build) и playwright (devDependencies).
 * Exit 0 = зелёный.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright";

const API_PORT = 8788;
const WEB_PORT = 8899;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SERVER = path.join(ROOT, "server", "index.mjs");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const check = (name, cond) => {
  results[name] = !!cond;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

function serveDist() {
  const srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let file = path.join(DIST, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
      if (!file.startsWith(DIST)) throw new Error("path");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      // SPA-fallback
      const data = await readFile(path.join(DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    }
  });
  return new Promise((r) => srv.listen(WEB_PORT, () => r(srv)));
}

async function newPilot(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name}] pageerror:`, e.message));
  await page.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: "networkidle" });
  // регистрация
  await page.fill(".login-input", name);
  await page.fill('input[type="password"]', "secret123");
  await page.click("button.btn-ghost"); // «Регистрация»
  await page.waitForSelector("#game-canvas", { timeout: 10000 });
  // новая игра
  await page.click("text=Новая игра");
  await page.waitForFunction(() => window.__worldNet?.status === "online", null, { timeout: 10000 });
  return { ctx, page };
}

const dataDir = await mkdtemp(path.join(tmpdir(), "rangers-e2e-"));
const apiProc = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: dataDir },
  stdio: ["ignore", "ignore", "inherit"],
});

let webSrv = null;
let browser = null;
let failed = false;

try {
  await sleep(700);
  webSrv = await serveDist();
  // как в игровых зондах: системный Chrome/Edge, если playwright-билд не установлен
  const CANDIDATES = [
    process.env.CHROMIUM_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const exe of [null, ...CANDIDATES]) {
    try {
      browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {});
      break;
    } catch { /* next */ }
  }
  if (!browser) throw new Error("no usable browser");

  const A = await newPilot(browser, "Пилот-А");
  const B = await newPilot(browser, "Пилот-Б");
  check("оба пилота вошли и подключились к шарду", true);

  // ждём взаимной видимости (polling: фоновая страница без rAF — интервал надёжнее)
  await A.page.waitForFunction(() => window.__worldNet.players.size >= 2, null, { polling: 200, timeout: 8000 });
  await B.page.waitForFunction(() => window.__worldNet.players.size >= 2, null, { polling: 200, timeout: 8000 });
  const seenByA = await A.page.evaluate(() => [...window.__worldNet.players.values()].map((p) => p.username));
  const seenByB = await B.page.evaluate(() => [...window.__worldNet.players.values()].map((p) => p.username));
  check("A видит Пилота-Б", seenByA.includes("Пилот-Б"));
  check("Б видит Пилота-А", seenByB.includes("Пилот-А"));

  // позиции реально текут (state приходит)
  await A.page.waitForFunction(
    () => [...window.__worldNet.players.values()].some((p) => p.state && Number.isFinite(p.state.x)),
    null,
    { polling: 200, timeout: 8000 },
  );
  const stB = await A.page.evaluate(() => [...window.__worldNet.players.values()].find((p) => p.state)?.state);
  check("у A есть позиция Б (state x/y/a)", stB && Number.isFinite(stB.x) && Number.isFinite(stB.y) && Number.isFinite(stB.a));

  // общий мир: онлайн=2 на сервере
  const world = await (await fetch(`http://localhost:${API_PORT}/api/world`)).json();
  check("сервер видит online=2, пулы подпитаны за 2 регистрации",
    world.world.online === 2 && world.world.registered === 2 && world.world.pools.stations === 800000);

  // оверлей живёт и в DOM
  check("оверлейный канвас в DOM у обоих",
    (await A.page.$("#net-overlay")) !== null && (await B.page.$("#net-overlay")) !== null);

  await A.ctx.close();
  await B.ctx.close();
} catch (e) {
  failed = true;
  console.error("E2E ERROR:", e.message);
} finally {
  if (browser) await browser.close();
  if (webSrv) webSrv.close();
  apiProc.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true });
}

const ok = !failed && Object.values(results).every(Boolean);
console.log(`\nE2E ${ok ? "OK" : "FAIL"}: ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} проверок`);
process.exit(ok ? 0 : 1);
