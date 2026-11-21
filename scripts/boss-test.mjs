/**
 * boss-test.mjs — автест эскалации флагманов (Этап 13b).
 * Сервер не нужен: флагмана зовём напрямую через __sim.bossSpawn(),
 * поколение задаём через __sim.bossGen(bossKills). Проверяет:
 *  1. Mk I (первый): базовые статы FACTION_CFG.boss, экран 4, без асов;
 *  2. Mk IV (после трёх потоплений): hp/щит/урон/темп по BOSS_ESC,
 *     экран 5, один ас с позывным и усиленным корпусом;
 *  3. кап поколения: bossGen(9) → Mk IX, статы по g=8, экран 8, аса 2;
 *  4. подкрепление на половине hp Mk IX приводит ещё двух асов;
 *  5. выкуп над обломками: Mk I — 25k, Mk IX — кап 50k;
 *  6. после потопления флагмана в мире нет; ₡-инвариант цел, мир жив.
 *
 * Использование: npm run build:test && npm run boss   (сервит dist/, как net-test)
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
  console.error(`BOSS FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("BOSS FAIL: no usable browser"); server.close(); process.exit(1); }
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

// базовые константы — те же числа, что в FACTION_CFG.boss / BOSS_ESC (config.ts)
const BASE = { hp: 1600, shield: 700, dmg: 16, rate: 0.9 };
const E = { HP: 0.35, SH: 0.45, DMG: 0.2, RATE: 0.08, CAP: 8, ESC_CAP: 8, EXTRA: 2, EFROM: 2, ECAP: 2 };
const r2 = (v) => Math.round(v * 100) / 100;
const expect = (g) => {
  const gg = Math.min(g, E.CAP);
  return {
    hp: gg ? Math.round(BASE.hp * (1 + E.HP * gg)) : BASE.hp,
    shield: gg ? Math.round(BASE.shield * (1 + E.SH * gg)) : BASE.shield,
    dmg: gg ? Math.round(BASE.dmg * (1 + E.DMG * gg)) : BASE.dmg,
    rate: gg ? r2(BASE.rate * (1 + E.RATE * gg)) : BASE.rate,
    escorts: Math.min(E.ESC_CAP, 4 + Math.floor(gg / E.EXTRA)),
    elites: gg >= E.EFROM ? Math.min(E.ECAP, Math.floor(gg / 2)) : 0,
  };
};

await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600);
});

// Mk I — базовый флагман: статы из таблицы, экран 4, асов нет
const mk1 = await page.evaluate(() => {
  window.__sim.bossGen(0);
  window.__sim.bossSpawn();
  window.__sim.step(1);
  return window.__sim.bossInfo();
});
// поддоны ищем счётчиком по сумме: пул слотов не сохраняет порядок вставки
const kill1 = await page.evaluate((amount) => {
  const cnt = () => window.__sim.pickups().filter((p) => p.kind === "credits" && p.amount === amount).length;
  const before = cnt();
  const killed = window.__sim.bossKillNow();
  window.__gameApi.current.continuePlaying?.();
  return { killed, gone: window.__sim.bossInfo() === null, pod: cnt() === before + 1 };
}, 25000);

// Mk IV — после трёх потоплений: рост статов, экран 5, один ас
const mk4 = await page.evaluate(() => {
  window.__sim.bossGen(3);
  window.__sim.bossSpawn();
  window.__sim.step(1);
  return window.__sim.bossInfo();
});
const kill4 = await page.evaluate(() => {
  window.__sim.bossKillNow();
  window.__gameApi.current.continuePlaying?.();
  return window.__sim.bossInfo() === null;
});

// Mk IX — кап поколения: bossGen(9) обязан дать g=8; подкрепление приводит ещё асов
const mk9 = await page.evaluate(() => {
  window.__sim.bossGen(9);
  window.__sim.bossSpawn();
  window.__sim.step(1);
  const info = window.__sim.bossInfo();
  window.__sim.bossHurt(info.shield + info.hp / 2 + 100); // ниже половины hp
  window.__sim.step(1);
  return { before: info, after: window.__sim.bossInfo() };
});
const kill9 = await page.evaluate((amount) => {
  const cnt = () => window.__sim.pickups().filter((p) => p.kind === "credits" && p.amount === amount).length;
  const before = cnt();
  window.__sim.bossKillNow();
  window.__gameApi.current.continuePlaying?.();
  return { pod: cnt() === before + 1, gone: window.__sim.bossInfo() === null };
}, 50000);

// хвост: мир живой, ₡-инвариант цел
const tail = await page.evaluate(() => {
  window.__sim.step(600);
  const a = window.__sim.step(1);
  return { delta: a.delta, alive: window.__sim.count("patrol") + window.__sim.count("trader") };
});

const near = (a, b, eps = 0.005) => typeof a === "number" && Math.abs(a - b) < eps;
const okStats = (i, g) => {
  const e = expect(g);
  return !!i && i.gen === Math.min(g, E.CAP) && i.hp === e.hp && i.shield === e.shield
    && i.dmg === e.dmg && near(i.fireRate, e.rate) && i.escorts === e.escorts;
};
const eliteOk = (s) => s && s.hp === Math.round(55 * 2.6) && s.shield === Math.round(20 * 2.5)
  && s.dmg === Math.round(7 * 1.8) && s.radius === 36 && s.name.length > 0;

const ok = {
  okMk1: okStats(mk1, 0) && mk1.elites.length === 0 && mk1.name === "Флагман Mk I",
  okKill1: kill1.killed && kill1.gone && kill1.pod,
  okMk4: okStats(mk4, 3) && mk4.elites.length === 1 && eliteOk(mk4.elites[0]) && mk4.name === "Флагман Mk IV",
  okKill4: kill4,
  okMk9Cap: okStats(mk9.before, 9) && mk9.before.elites.length === 2
    && mk9.before.elites.every(eliteOk) && mk9.before.name === "Флагман Mk IX",
  okReinforce: mk9.after.elites.length === 4 && mk9.after.escorts === mk9.before.escorts + 2,
  okKill9: kill9.gone && kill9.pod,
  okMoney: Math.abs(tail.delta) < 1,
  okWorld: tail.alive >= 6,
  noPageErrors: pageErrors.length === 0,
};
done(ok, { mk1, kill1, mk4, mk9, kill9, tail, pageErrors: pageErrors.length ? pageErrors : undefined });
