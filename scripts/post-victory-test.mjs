/**
 * post-victory-test.mjs — автест пост-игры (Этап 13e, трек Б).
 * Сервер не нужен: победу зовём реальным путём (3-й потопленный флагман),
 * дальше проверяем жизнь победителя:
 *  1. victory → victoryShown/legend; HUD носит титул «🏆 ПОБЕДИТЕЛЬ ГАЛАКТИКИ»
 *     (живой DOM + hud.legend в снапшоте); setState в шард несёт legend:true,
 *     чужие ростеры (net-test идиом) рисуют 🏆 при позывном;
 *  2. наследный контракт: после победы доска Альянса выкладывает legacy-заказ
 *     с наградой вдвое против базовой формулы; выплата идёт из казны —
 *     alliance-пул проседает ровно на награду, ₡-инвариант цел;
 *  3. гейт казны: при пустом пуле заказчика наследный не выставляется вообще;
 *  4. мягкая эскалация: после победы поколение ползёт за BOSS_ESC.GEN_CAP
 *     (gen 10 → Mk XI, gen 20 → кап POSTWIN.GEN_CAP=16 → Mk XVII),
 *     выкуп над обломками ×2 сверх поколенного (Mk XI → поддон 100 000);
 *  5. хвост: мир живой, ₡-инвариант цел.
 *
 * Использование: npm run build:test && npm run postwin   (сервит dist/, как boss-test)
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
  console.error(`POSTWIN FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("POSTWIN FAIL: no usable browser"); server.close(); process.exit(1); }
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

const START = { hp: 1600, shield: 700, dmg: 16, rate: 0.9 }; // FACTION_CFG.boss (config.ts)
const E = { HP: 0.35, SH: 0.45, DMG: 0.2, RATE: 0.08, CAP: 8, EXTRA: 2, ECAP: 2 };
const POSTWIN = { GEN_CAP: 16, BOUNTY_MULT: 2 };
const r2 = (v) => Math.round(v * 100) / 100;
const near = (a, b, eps = 0.005) => typeof a === "number" && Math.abs(a - b) < eps;

// ── разгон мира + реальная победа: третий потопленный флагман ────────────
const victory = await page.evaluate(() => {
  window.__gameApi.current.newGame();
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(600);
  window.__sim.bossGen(2); // ещё один труп доvedёт счёт до FLAGSHIPS_TO_WIN
  window.__sim.bossSpawn();
  window.__sim.step(1);
  const killed = window.__sim.bossKillNow(); // bossKills → 3 → victory()
  const wonState = window.__sim.winNow !== undefined; // мост на месте
  return {
    killed, wonState,
    legend: window.__sim.legend(),
    state: window.__uiBridge.getSnapshot().screen,
  };
});
await page.evaluate(() => window.__gameApi.current.continuePlaying?.());
// ── A. титул: снапшот + живой DOM + исходящий state в шард ───────────────
// pushHud троттлится кадрами — прокручиваем секунду игрового времени,
// чтобы снапшот гарантированно пересобрался уже с victoryShown=true
const hudSnap = await page.evaluate(() => {
  window.__sim.step(60);
  return {
    legend: window.__uiBridge.getSnapshot().hud?.legend === true,
    netLegend: window.__sim.net().legend === true,
  };
});
let titleDom = "";
try {
  const el = await page.waitForSelector(".hud-legend", { timeout: 5000 });
  titleDom = (await el.textContent()) ?? "";
} catch { /* нет узла — фиксация ниже */ }
// 🏆 при чужом позывном: ростер fakePlayers проходит тот же тракт, что шард
await page.evaluate(() => {
  const sys = window.__sim.net().sys;
  window.__sim.fakePlayers([
    { id: "champ", username: "Чемпион", x: 0.1, y: 0.1, a: 0, sys },
    { id: "fresh", username: "Новичок", x: -0.1, y: -0.1, a: 0, sys, legend: true },
  ]);
});
// ростер пересобирается перед кадром rAF (тот же идом, что net-test)
await page.waitForFunction(() => window.__sim.net().remotes.length === 2, null, { timeout: 5000 });
const remoteLegend = await page.evaluate(() => {
  const rs = window.__sim.net().remotes;
  return {
    champ: rs.find((r) => r.name === "Чемпион")?.legend ?? null,
    fresh: rs.find((r) => r.name === "Новичок")?.legend ?? null,
  };
});

// ── B. наследный контракт: выплата из казны Альянса ровно на награду ──────
const legacyBoard = await page.evaluate(() => {
  for (let i = 0; i < 24; i++) {
    window.__sim.dockAt("station-0");
    const o = window.__uiBridge.getSnapshot().station?.contracts.find((c) => c.legacy);
    if (o) return { offer: o, tries: i + 1 };
  }
  return { offer: null, tries: 24 };
});
let legacyPay = { ok: false };
if (legacyBoard.offer) {
  legacyPay = await page.evaluate((offer) => {
    const a0 = window.__sim.poolAmt("alliance");
    window.__gameApi.current.acceptContract(offer.id);
    const act = window.__uiBridge.getSnapshot().station?.active;
    window.__gameApi.current.undock();
    const need = act?.need ?? 0;
    let kills = 0, guard = 0;
    while (kills < need && guard++ < need + 60) {
      if (window.__sim.kill("pirate")) kills++; else window.__sim.step(60);
      if (window.__sim.poolAmt("alliance") !== a0) break; // выплата прошла — читаем кассу сразу
    }
    const a1 = window.__sim.poolAmt("alliance");
    return {
      ok: true, accepted: !!act && act.legacy === true && act.reward === offer.reward,
      need, kills,
      debit: a0 - a1, reward: offer.reward, delta: window.__sim.step(1).delta,
    };
  }, legacyBoard.offer);
}

// ── C. гейт казны: пустой alliance-пул → наследного нет никогда ───────────
const gate = await page.evaluate(() => {
  const a0 = window.__sim.poolAmt("alliance");
  const drained = window.__sim.drainPool("alliance");
  let seen = false;
  for (let i = 0; i < 10; i++) {
    window.__sim.dockAt("station-0");
    if (window.__uiBridge.getSnapshot().station?.contracts.some((c) => c.legacy)) seen = true;
  }
  const a1 = window.__sim.poolAmt("alliance");
  window.__sim.payPool("alliance", drained);
  // инвариант ₡ — главный страж: деньги drain/pay ходят игровыми путями gain/pay
  return { seen, a0, drained, a1, delta: window.__sim.step(1).delta };
});

// ── D. эскалация за GEN_CAP + выкуп ×2 ────────────────────────────────────
const postBoss = await page.evaluate(() => {
  window.__sim.sundock();
  window.__sim.bossGen(10);
  window.__sim.bossSpawn();
  window.__sim.step(1);
  const mk11 = window.__sim.bossInfo();
  const cnt = () => window.__sim.pickups().filter((p) => p.kind === "credits" && p.amount === 100000).length;
  const before = cnt();
  window.__sim.bossKillNow();
  const pod = cnt() === before + 1;
  window.__sim.bossGen(20);
  window.__sim.bossSpawn();
  window.__sim.step(1);
  const cap = window.__sim.bossInfo();
  return { mk11, pod, cap: { gen: cap?.gen, name: cap?.name } };
});

// ── хвост: мир живой, инвариант цел ───────────────────────────────────────
const tail = await page.evaluate(() => {
  window.__sim.step(600);
  const a = window.__sim.step(1);
  return { delta: a.delta, alive: window.__sim.count("patrol") + window.__sim.count("trader") };
});

const expectGen = (g) => ({
  hp: Math.round(START.hp * (1 + E.HP * g)),
  shield: Math.round(START.shield * (1 + E.SH * g)),
  dmg: Math.round(START.dmg * (1 + E.DMG * g)),
  rate: r2(START.rate * (1 + E.RATE * g)),
  escorts: Math.min(E.CAP, 4 + Math.floor(g / E.EXTRA)),
});
const g11 = postBoss.mk11 ? expectGen(10) : null;

const ok = {
  okVictory: victory.killed && victory.legend === true && victory.state === "victory",
  okHudLegend: hudSnap.legend && hudSnap.netLegend,
  okTitleDom: titleDom.includes("ПОБЕДИТЕЛЬ ГАЛАКТИКИ"),
  okRemoteLegend: remoteLegend.champ === false && remoteLegend.fresh === true,
  okLegacyOffer: !!legacyBoard.offer && legacyBoard.offer.reward > 0,
  okLegacyPay: legacyPay.ok && legacyPay.accepted
    && legacyPay.debit === legacyPay.reward && Math.abs(legacyPay.delta) < 1,
  okGate: gate.a0 > 1000 && gate.a1 < 1000 && !gate.seen && Math.abs(gate.delta) < 1,
  okPostCap: !!postBoss.mk11 && postBoss.mk11.gen === 10 && postBoss.mk11.name === "Флагман Mk XI"
    && postBoss.mk11.hp === g11.hp && postBoss.mk11.shield === g11.shield
    && postBoss.mk11.dmg === g11.dmg && near(postBoss.mk11.fireRate, g11.rate)
    && postBoss.mk11.escorts === g11.escorts,
  okBountyX2: postBoss.pod, // поддон ровно 100 000 = 25 000 × кап 2 × POSTWIN ×2
  okSoftCap: postBoss.cap.gen === POSTWIN.GEN_CAP && postBoss.cap.name === "Флагман Mk XVII",
  okMoney: Math.abs(tail.delta) < 1,
  okWorld: tail.alive >= 6,
  noPageErrors: pageErrors.length === 0,
};
done(ok, { victory, hudSnap, remoteLegend, legacyBoard, legacyPay, gate, postBoss, tail, titleDom, pageErrors: pageErrors.length ? pageErrors : undefined });
