/**
 * smoke-prod.mjs — разовая проверка боевого деплоя (2026-11-22): прод-клиент с
 * http://141.133.207.47 грузится, логин проходит (регистрация/вход через тот же
 * origin), WebGL-пробник жив, health-API отвечает с той же страницы (same-origin).
 * В проде нет SKIP_AUTH (он только в test-режиме), поэтому сессию подкладываем в
 * localStorage до загрузи — AUTH_KEY = "game.auth" из src/auth/client.ts.
 * Использование: node scripts/smoke-prod.mjs [URL]
 */
import { chromium } from "playwright";

const URL_ = (process.argv[2] || "http://141.133.207.47/").replace(/\/+$/, "");
const AUTH_KEY = "game.auth";
const USER = "smoke-deploy";
const PASS = "deploy12345";

// токен получаем до загрузки страницы: регистрация, а если аккаунт есть — вход
async function api(path, body) {
  const r = await fetch(`${URL_}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}
let auth = await api("/api/register", { username: USER, password: PASS });
if (!auth.token) auth = await api("/api/login", { username: USER, password: PASS });

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try { browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {}); break; } catch { /* next */ }
}
if (!browser) { console.error("SMOKE FAIL: no usable browser"); process.exit(1); }
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const failedReqs = [];
page.on("requestfailed", (r) => failedReqs.push(`${r.url()} :: ${r.failure()?.errorText}`));
// сессия в localStorage ДО исполнения бандла — тогда App монтирует игру сразу
await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ }; },
  [AUTH_KEY, JSON.stringify({ token: auth.token ?? "", username: USER })]);
await page.goto(URL_ + "/", { waitUntil: "load", timeout: 45000 });
// харнесс __GAME_READY__ ставится и в проде (finishFrame в render.ts) — до первого
// кадра игры: значит бандл исполнен, сессия принята, Game смонтирован и крутит цикл
await page.waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 60000 });
const canvasVisible = await page.locator("canvas").first().isVisible().catch(() => false);
const health = await page.evaluate(async () => {
  try { const r = await fetch("/api/health"); return await r.json(); } catch (e) { return { err: String(e) }; }
});
// 3D-слой тоже проверяем: boot по умолчанию 2D, переключаемся через пробу настроек —
// здесь достаточно WebGL2-пробника (тот же тест, что «auto»)
const gl = await page.evaluate(() => {
  try { return document.createElement("canvas").getContext("webgl2") !== null; } catch { return false; }
});
const ok = Boolean(auth.token) && canvasVisible && health.ok === true && gl && errors.length === 0 && failedReqs.length === 0;
console.log(JSON.stringify({
  ok, authed: Boolean(auth.token), canvasVisible, health, webgl2: gl,
  pageErrors: errors.slice(0, 3), failedReqs: failedReqs.slice(0, 5),
}, null, 1));
await browser.close();
process.exit(ok ? 0 : 1);
