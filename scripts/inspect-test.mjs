/**
 * inspect-test.mjs — автест патрульного досмотра (Этап 14d): таможня на воде.
 * Проверяет:
 *  1. бортник с контрабандой: катер разворачивает канал (scan), через INSPECT.TIME
 *     расстреливает судно, а кошелёк бортника падает в pools.patrol;
 *  2. побег: выведенный за LEASH·RANGE бортник срывает канал, казна не толстеет;
 *  3. игрок под каналом: аварийный сброс [X] выгружает улики поддонами, пустой
 *     трюм на момент досмотра отпускают без штрафа и без удара по репутации;
 *  4. конфискация: spice в трюме → штраф в казну патруля, конфискация, −REP;
 *     баннер HUD (hud.scan) горит, пока канал открыт;
 *  5. кулдаун: после досмотра катер сидит на CD — в упор гружёному игроку
 *     новый канал не разворачивает;
 *  6. деньги целы на всём протяжении (delta ≈ 0), ошибок страницы нет.
 * Вокруг актёров каждой итерации подчищаются пираты (tfree — деньги не двигает):
 * катер берётся за канал только будучи свободным от погони.
 *
 * Использование: npm run build:test && npm run inspect   (сервит dist/, как patrol-test)
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
  console.error(`INSPECT FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("INSPECT FAIL: no usable browser"); server.close(); process.exit(1); }
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
  window.__sim.step(600); // 10 с — укомплектованное население, бортники загружены
});

const CONTRA = ["arms", "tobacco", "spice", "drugs"];

// ── 1. бортник с контрабандой: канал → расстрел → кошелёк в казну патруля ──
const npc = await page.evaluate((CONTRA) => {
  const load = (s) => CONTRA.reduce((n, g) => n + (s.cargo[g] ?? 0), 0);
  // сносим пиратов (катер берётся за канал только будучи свободным) и чужие
  // катеры (не дадим второму досмотрчику перехватить приговор); tfree денег не двигает
  const sweep = (x, y, keep) => {
    for (const o of window.__sim.near(x, y, 3400)) {
      if (o.faction === "pirate" || (o.faction === "patrol" && o.i !== keep)) window.__sim.tfree(o.i);
    }
  };
  const sm = window.__sim.smugglers().find((s) => load(s) > 0);
  if (!sm) return { found: false };
  const pi = window.__sim.patrolSpawn(sm.x + 300, sm.y - 120); // в радиусе канала 520
  if (pi < 0) return { found: true, locked: false };
  const a0 = window.__sim.step(0);
  const name0 = sm.name;
  let locked = false, wLock = 0;
  for (let k = 0; k < 100 && !locked; k++) {
    const pc = window.__sim.pinfo(pi);
    if (pc) sweep(pc.x, pc.y, pi);
    window.__sim.step(12);
    const hit = window.__sim.scan().find((s) => s.to === sm.i);
    if (hit) {
      locked = true;
      wLock = window.__sim.smugglers().find((x) => x.i === sm.i)?.wallet ?? 0;
    }
  }
  if (!locked) return { found: true, locked: false };
  let cd0 = 0, dead = false;
  for (let k = 0; k < 100; k++) {
    const pc = window.__sim.pinfo(pi);
    if (pc) sweep(pc.x, pc.y, pi);
    window.__sim.step(12);
    const p = window.__sim.patrols().find((q) => q.i === pi);
    cd0 = p ? p.cd : 0;
    if (cd0 > 25) { // канал закрыт с приговором
      dead = !window.__sim.smugglers().some((x) => x.i === sm.i && x.name === name0);
      break;
    }
  }
  const a1 = window.__sim.step(0);
  const feed = (window.__uiBridge.snap.feed ?? []).map((f) => f.text).join("\n");
  return {
    found: true, locked: true, dead, cd0: Math.round(cd0),
    wallet: wLock, patrolGain: Math.round(a1.pools.patrol - a0.pools.patrol),
    seized: feed.includes("Досмотр") && feed.includes("контрабанды"),
    delta: a1.delta,
  };
}, CONTRA);

// ── 2. побег: игрок, выведенный за LEASH·RANGE, срывает канал — ни штрафа, ни REP ──
const run = await page.evaluate(() => {
  const hud = () => window.__uiBridge.snap.hud;
  const sweep = (x, y, keep) => {
    for (const o of window.__sim.near(x, y, 3400)) {
      if (o.faction === "pirate" || (o.faction === "patrol" && o.i !== keep)) window.__sim.tfree(o.i);
    }
  };
  let spot = null;
  for (let a = 0; a < 16 && !spot; a++) {
    const x = Math.cos((a * Math.PI) / 8) * 5400, y = Math.sin((a * Math.PI) / 8) * 5400;
    if (window.__sim.near(x, y, 2600).length === 0) spot = { x, y };
  }
  if (!spot) return { found: false };
  window.__sim.cash(15000);
  window.__sim.tp(spot.x, spot.y);
  window.__sim.pcargo("drugs", 12);
  const pi = window.__sim.patrolSpawn(spot.x + 360, spot.y + 40);
  if (pi < 0) return { found: true, locked: false };
  const r0 = hud().rep.patrol, c0 = hud().credits;
  let locked = false;
  for (let k = 0; k < 100 && !locked; k++) {
    const pc = window.__sim.pinfo(pi);
    if (pc) sweep(pc.x, pc.y, pi);
    window.__sim.step(12);
    locked = window.__sim.scan().some((s) => s.from === pi && s.to === 0);
  }
  if (!locked) return { found: true, locked: false };
  const a0 = window.__sim.step(0);
  window.__sim.tp(spot.x + 3400, spot.y + 1800); // галоп за поводок канала (≈884)
  window.__sim.step(90); // 1.5 с — цикла think (0.3–0.55 с) хватает заметить побег с запасом
  const stillOn = window.__sim.scan().some((s) => s.from === pi);
  const a1 = window.__sim.step(0);
  const p = window.__sim.patrols().find((q) => q.i === pi);
  return {
    found: true, locked: true, aborted: !stillOn,
    cargo: window.__sim.pcargo("drugs"),
    fine: Math.round(c0 - hud().credits), repHit: Math.round(r0 - hud().rep.patrol),
    patrolGain: Math.round(a1.pools.patrol - a0.pools.patrol),
    cd: p ? Math.round(p.cd * 10) / 10 : 0, delta: a1.delta,
  };
});

// ── 3–5. игрок: канал → сброс [X] → «трюм чист»; затем конфискация со штрафом ──
const you = await page.evaluate((CONTRA) => {
  const hud = () => window.__uiBridge.snap.hud;
  const feed = () => (window.__uiBridge.snap.feed ?? []).map((f) => f.text).join("\n");
  const sweep = (x, y, keep) => {
    for (const o of window.__sim.near(x, y, 3400)) {
      if (o.faction === "pirate" || (o.faction === "patrol" && o.i !== keep)) window.__sim.tfree(o.i);
    }
  };
  // чистая поляна: никто в 2600 — катер возьмёт на досмотр именно игрока
  let spot = null;
  for (let a = 0; a < 16 && !spot; a++) {
    const x = Math.cos((a * Math.PI) / 8) * 5400, y = Math.sin((a * Math.PI) / 8) * 5400;
    if (window.__sim.near(x, y, 2600).length === 0) spot = { x, y };
  }
  if (!spot) return { found: false };
  window.__sim.cash(15000);
  window.__sim.tp(spot.x, spot.y);
  window.__sim.pcargo("drugs", 12);

  // 3: канал на игроке → аварийный сброс → отпуск «трюм чист»
  const pi = window.__sim.patrolSpawn(spot.x + 380, spot.y + 60);
  if (pi < 0) return { found: true, locked: false };
  const r0 = hud().rep.patrol, c0 = hud().credits;
  let locked = false, hudScan = 0;
  for (let k = 0; k < 100 && !locked; k++) {
    sweep(spot.x, spot.y, pi);
    window.__sim.step(12);
    hudScan = Math.max(hudScan, hud().scan);
    locked = window.__sim.scan().some((s) => s.from === pi && s.to === 0);
  }
  if (!locked) return { found: true, locked: false };
  window.__sim.step(20); // канал открыт — дать pushHud (цикл 0.12 с) показать прогресс
  hudScan = Math.max(hudScan, hud().scan);
  const dumped = window.__sim.pcargo("drugs");
  window.__gameApi.current.jettison();
  const pods = window.__sim.pickups().filter((p) => p.kind === "cargo" && CONTRA.includes(p.goodId)).length;
  window.__sim.tp(spot.x + 640, spot.y + 60); // отойти от поддонов, оставаясь в поводке канала
  let cd0 = 0;
  for (let k = 0; k < 100; k++) {
    sweep(spot.x + 640, spot.y + 60, pi);
    window.__sim.step(12);
    const p = window.__sim.patrols().find((q) => q.i === pi);
    cd0 = p ? p.cd : 0;
    if (cd0 > 25) break;
  }
  window.__sim.step(20); // добить hud-цикл: отпуск уже отражён в снимке
  const clean = feed().includes("трюм чист");
  const keptRep = hud().rep.patrol, keptCr = hud().credits;

  // 4: вторая партия уже на глазах — конфискация + штраф + удар по репутации.
  // игрок отошёл на spot+640 — второй катер ставим в радиус канала именно к нему
  window.__sim.pcargo("spice", 30);
  const px = spot.x + 640, py = spot.y + 60;
  const pi2 = window.__sim.patrolSpawn(px - 380, py - 80);
  if (pi2 < 0) return { found: true, locked: true, locked2: false };
  const r1 = hud().rep.patrol, c1 = hud().credits;
  const a0 = window.__sim.step(0);
  let locked2 = false, hudScan2 = 0;
  for (let k = 0; k < 100 && !locked2; k++) {
    sweep(px, py, pi2);
    window.__sim.step(12);
    hudScan2 = Math.max(hudScan2, hud().scan);
    locked2 = window.__sim.scan().some((s) => s.from === pi2 && s.to === 0);
  }
  if (locked2) { window.__sim.step(20); hudScan2 = Math.max(hudScan2, hud().scan); }
  let cd1 = 0;
  for (let k = 0; k < 100; k++) {
    const pc = window.__sim.pinfo(pi2);
    if (pc) sweep(pc.x, pc.y, pi2);
    window.__sim.step(12);
    const p = window.__sim.patrols().find((q) => q.i === pi2);
    cd1 = p ? p.cd : 0;
    if (cd1 > 25) break;
  }
  window.__sim.step(20); // добить hud-цикл: штраф и репутация уже в снимке
  const a1 = window.__sim.step(0);
  const fined = feed().includes("конфисковано") && feed().includes("штраф");
  const confiscatedValue = c1 - hud().credits, repAfter = hud().rep.patrol;
  // 5: кулдаун — подводим катеру гружёного игрока в упор, новый канал не открывается
  window.__sim.pcargo("drugs", 8);
  const pc = window.__sim.pinfo(pi2);
  let relock = false;
  if (pc) {
    window.__sim.tp(pc.x + 260, pc.y);
    for (let k = 0; k < 24 && !relock; k++) {
      sweep(pc.x, pc.y, pi2);
      window.__sim.step(15);
      relock = window.__sim.scan().some((s) => s.from === pi2 && s.to === 0);
    }
  }
  return {
    found: true, locked: true, locked2,
    dumped, pods: pods > 0, clean, r0, c0, keptRep, keptCr,
    spiceLeft: window.__sim.pcargo("spice"),
    fine: Math.round(confiscatedValue), repHit: Math.round(r1 - repAfter),
    patrolGain: Math.round(a1.pools.patrol - a0.pools.patrol),
    hudScan, hudScan2, cd0: Math.round(cd0), cd1: Math.round(cd1), fined,
    cdBlocksRelock: !relock, delta: a1.delta,
  };
}, CONTRA);

// ── 6. финальная ревизия: мир живой, деньги целы ──
const tail = await page.evaluate(() => {
  window.__sim.step(600);
  const a = window.__sim.step(1);
  return {
    delta: a.delta,
    alive: window.__sim.count("patrol") + window.__sim.count("trader"),
    sane: window.__sim.scan().every((s) => s.t > 0 && s.t <= 4),
  };
});

const ok = {
  okSeizeNpc: npc.found && npc.locked && npc.dead && npc.seized
    && npc.patrolGain >= npc.wallet - 1 && npc.cd0 >= 25,
  okEscape: run.found && run.locked && run.aborted && run.cargo === 12
    && run.fine === 0 && run.repHit === 0 && run.cd >= 2 && run.cd <= 6.5 && run.patrolGain < 500,
  okJettison: you.found && you.locked && you.dumped === 12 && you.pods && you.clean
    && you.keptRep === you.r0 && you.keptCr >= you.c0 - 1,
  okConfiscate: you.locked2 && you.spiceLeft === 0 && you.fine >= 150 && you.repHit >= 12
    && you.patrolGain >= 149 && you.hudScan2 > 0 && you.hudScan > 0 && you.fined,
  okCooldown: you.cd0 >= 25 && you.cd1 >= 25 && you.cdBlocksRelock,
  okMoney: Math.abs(npc.delta) < 1 && Math.abs(run.delta) < 1 && Math.abs(you.delta) < 1 && Math.abs(tail.delta) < 1,
  okClean: tail.alive >= 6 && tail.sane,
  noPageErrors: pageErrors.length === 0,
};
done(ok, {
  npc, run, you, tail,
  pageErrors: pageErrors.length ? pageErrors : undefined,
});
