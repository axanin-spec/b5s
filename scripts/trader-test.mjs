/**
 * trader-test.mjs — автотест боевых торговцев (Этап 14а): оборонительный огонь,
 * личные классы по счёту рейсов, наёмный конвой класса «A», реестр в сейве.
 * Проверяет:
 *  1. вооружение: каждый гражданский караван стоит с плазмой (dmg/fireRate > 0);
 *     с 14с и клановые бортники вооружены (класс «C») и выходят с контрабандой в трюме;
 *  2. гнев: попадание пирата выставляет anger на стрелка; караван отвечает болтами,
 *     попадание игрока гнева не заводит (оборона — только по рейдерам);
 *  3. классы: зачтённые рейсы растят книгу C→B→A, корпус/пушки растут на ходу;
 *  4. конвой: класс «A» нанимает патруль — 2500 ₡ из кошелька в казну патруля,
 *     аудит денег не косится (delta 0), конвоир бьёт пирата у хозяина;
 *  5. сейв: реестр караванов переживает save → newGame → importSave.
 *
 * Использование: npm run build:test && npm run traders   (сервит dist/, как smuggle-test)
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
  console.error(`TRADER FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("TRADER FAIL: no usable browser"); server.close(); process.exit(1); }
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

// новый запуск: невидимый бессмертный зритель, флот живёт сам
await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600); // 10 с — укомплектованное население
});

// ── 1. вооружение: гражданские караваны с пушками ──
const armed = await page.evaluate(() => {
  const ts = window.__sim.traders();
  return { n: ts.length, all: ts.every((t) => t.dmg >= 5 && t.fireRate > 0), sample: ts[0] ?? null };
});

// ── 2. гнев и ответный огонь ──
const anger = await page.evaluate(() => {
  const t = window.__sim.traders()[0];
  if (!t) return { found: false };
  const pi = window.__sim.pirateSpawn(t.x + 120, t.y);
  window.__sim.thit(t.i, 6, pi); // имитация попадания пирата: караван обязан запомнить
  const hit = window.__sim.traders().find((x) => x.i === t.i);
  // ждём цикла think (разнесён до ~0.6 с) и считаем болты каравана
  let bolts = 0;
  for (let k = 0; k < 12; k++) { window.__sim.step(15); bolts = Math.max(bolts, window.__sim.tbolts()); }
  const pirateHp = window.__sim.thp(pi);
  return { found: true, name: t.name, i: t.i, angerOk: hit && hit.anger === pi, bolts, pirateHp };
});

// ── 2b. игрок под оборонительной плазмой не значится ──
const civil = await page.evaluate(async () => {
  window.__sim.step(700); // 11.7 с — тревога ANGER_T гарантированно истекла
  const t = window.__sim.traders().find((x) => x.anger < 0) ?? window.__sim.traders()[0];
  if (!t) return { found: false };
  window.__sim.thit(t.i, 3, 0); // попадание игрока
  window.__sim.step(45); // цикл think: гнев не должен появиться
  const hit = window.__sim.traders().find((x) => x.i === t.i);
  return { found: true, anger: hit ? hit.anger : -2 };
});

// ── 3. классы: счёт рейсов → книга → рост корпуса на ходу ──
const promo = await page.evaluate(() => {
  const t = window.__sim.traders()[0];
  if (!t) return { found: false };
  window.__sim.tdock(t.i); // первая сделка заводит запись в книге
  window.__sim.setTrips(t.name, 3);
  let tierB = false, tierA = false, hpA = 0, dmgA = 0;
  for (let k = 0; k < 20; k++) {
    window.__sim.twallet(t.i, 8000); // фонд выхода: сделке на что закупаться
    window.__sim.tdock(t.i);
    const now = window.__sim.traders().find((x) => x.i === t.i);
    if (!now) break;
    if (now.tier >= 1) tierB = true;
    if (now.tier >= 2) { tierA = true; hpA = now.maxHp; dmgA = now.dmg; break; }
  }
  const reg = window.__sim.reg()[t.name];
  return { found: true, name: t.name, tierB, tierA, hpA, dmgA, trips: reg ? reg.trips : -1 };
});

// ── 4. наёмный конвой класса «A» ──
const escort = await page.evaluate(() => {
  const t = window.__sim.traders().find((x) => x.tier >= 2);
  if (!t) return { found: false };
  // конвой уже мог наймиться на повышении — распустим, чтобы поймать сам платёж
  const pre = window.__sim.tescorts().find((e) => e.of === t.i);
  if (pre) window.__sim.tfree(pre.i);
  window.__sim.twallet(t.i, 9000);
  const before = window.__sim.traders().find((x) => x.i === t.i).wallet;
  const a = window.__sim.step(0); // аудит до
  window.__sim.trecalc(t.i); // пересчёт маршрута = окно найма
  const b = window.__sim.step(0); // аудит после
  const esc = window.__sim.tescorts().find((e) => e.of === t.i);
  return {
    found: true, hired: !!esc, before,
    walletDrop: before - window.__sim.traders().find((x) => x.i === t.i).wallet,
    patrolGain: b.pools.patrol - a.pools.patrol, delta: b.delta, esc: esc ? esc.i : -1,
  };
});

// ── 4b. конвоир бьёт пирата у хозяина ──
const fight = await page.evaluate(() => {
  const t = window.__sim.traders().find((x) => x.tier >= 2);
  const esc = t && window.__sim.tescorts().find((e) => e.of === t.i);
  if (!t || !esc) return { found: false };
  const pi = window.__sim.pirateSpawn(t.x + 320, t.y + 60);
  let locked = false;
  for (let k = 0; k < 12; k++) {
    window.__sim.step(15);
    const e = window.__sim.tescorts().find((x) => x.i === esc.i);
    if (e && e.target === pi) locked = true;
  }
  return { found: true, locked, pirateHp: window.__sim.thp(pi) };
});

// ── 5. реестр через сейв-раунд-трип ──
const round = await page.evaluate(() => {
  const t = window.__sim.traders().find((x) => x.tier >= 2);
  if (!t) return { found: false };
  const json = window.__gameApi.current.exportSave();
  window.__gameApi.current.newGame();
  window.__sim.god();
  const empty = Object.keys(window.__sim.reg()).length; // новый пилот — пустая книга
  const ok = window.__gameApi.current.importSave(json);
  const back = window.__sim.reg()[t.name];
  return { found: true, ok, empty, tier: back ? back.tier : -1, trips: back ? back.trips : -1 };
});

// ── 6. клановые бортники вооружены (14с), с контрабандой на борту; деньги целы ──
const tail = await page.evaluate(() => {
  window.__sim.jump("terminus");
  window.__sim.step(900); // бортники успели сойтись
  const sm = window.__sim.smugglers();
  const trio = (s) => (s.cargo.tobacco ?? 0) + (s.cargo.spice ?? 0) + (s.cargo.drugs ?? 0);
  const audit = window.__sim.step(1);
  return {
    n: sm.length,
    armed: sm.every((s) => s.dmg > 0 && s.fireRate > 0), // 14с: пушка класса «C» у каждого
    loaded: sm.some((s) => trio(s) > 0), // хотя бы один вышел с тоннами тройки
    delta: audit.delta,
  };
});

const ok = {
  okArmed: armed.all && armed.n >= 3,
  // ответный огонь: гнев выставлен, болты полетели; пират либо цел (промах — допустимо),
  // либо ранен/убит — но не «воскрес из отрицательного hp»
  okAnger: anger.found && anger.angerOk && anger.bolts > 0 && anger.pirateHp <= 55,
  okCivilian: civil.found && civil.anger === -1,
  okPromote: promo.found && promo.tierB && promo.tierA && promo.hpA === 170 && promo.dmgA === 9 && promo.trips >= 10,
  okEscort: escort.found && escort.hired && escort.walletDrop === 2500 && escort.patrolGain === 2500 && Math.abs(escort.delta) < 1,
  okFight: fight.found && (fight.locked || (fight.pirateHp >= 0 && fight.pirateHp < 55)),
  okReg: round.found && round.ok && round.empty === 0 && round.tier === 2 && round.trips >= 10,
  okSmugglersArmed: tail.n > 0 && tail.armed && tail.loaded, // 14с
  // аудит денег: balance-test тоже терпит плавающий ноль (копейки на флуктуациях)
  okMoney: Math.abs(tail.delta) < 1,
};
done(ok, {
  armed, anger, civil, promo, escort, fight, round, tail,
  pageErrors: pageErrors.length ? pageErrors : undefined,
});
