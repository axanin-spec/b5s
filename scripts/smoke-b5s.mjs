/**
 * smoke-b5s.mjs — браузерная проверка прода https://b5s.ru (Caddy/TLS, не коммитится).
 * Сессию подкладываем ДО загрузки: localStorage "game.auth" = {token,username}
 * (в проде нет SKIP_AUTH, __GAME_READY__ ставится только после первого кадра Game).
 * Дальше: canvas есть, ошибок страницы нет, /api/health с той же страницы 200,
 * а серверный /api/world показывает наш борт с состоянием — значит браузер
 * проткнул wss:// через Caddy и игры живут в общем шаре.
 * Использование: node scripts/smoke-b5s.mjs <token> <username>
 */
import { chromium } from "playwright";

const [token, username] = process.argv.slice(2);
if (!token || !username) { console.error("usage: node scripts/smoke-b5s.mjs <token> <username>"); process.exit(1); }
const URL_ = "https://b5s.ru/";

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
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.addInitScript(([t, u]) => {
  localStorage.setItem("game.auth", JSON.stringify({ token: t, username: u }));
}, [token, username]);
const world0 = await (await fetch("https://b5s.ru/api/world")).json();
await page.goto(URL_, { waitUntil: "load" });
await page.waitForSelector("canvas", { timeout: 30000 });
// игра крутится: ждём 6 реальных секунд (wss-хартбит 10 Гц сам постелит state)
await page.waitForTimeout(6000);
const health = await page.evaluate(async () => {
  const r = await fetch("https://b5s.ru/api/health");
  return { status: r.status, body: await r.json() };
});
const world = await (await fetch("https://b5s.ru/api/world")).json();
const shot = "verification-shots/b5s-https.png";
await page.screenshot({ path: new URL("../" + shot, import.meta.url).pathname.replace(/^\//, "") });
const ok = {
  canvas: true,
  noPageErrors: pageErrors.length === 0,
  health200: health.status === 200 && health.body.ok === true,
  // наш браузер добавил +1 в online — wss через Caddy проткнули
  inWorld: world.world.online >= world0.world.online + 1,
};
console.log(JSON.stringify({ ok, health, online: { before: world0.world.online, after: world.world.online }, pageErrors: pageErrors.length ? pageErrors : undefined, shot }, null, 1));
await browser.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
