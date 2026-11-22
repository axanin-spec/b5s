/**
 * base-test.mjs — автест домашней базы (Этап 17, трек Б).
 * Сервер не нужен: гибель вызываем через __sim.dieNow (тот же путь, что залп NPC).
 * Проверяет:
 *  1. дефолт новой игры — база Эйдолон, склад пуст;
 *  2. смерть в своей системе: не поражение (экрана конца нет), респаун у станции,
 *     корпус — «Рейнджер» со стартовым китом, stash и кошелёк целы, трюм — поддоны
 *     у обломков (не больше трёх, TTL 10 минут), деньги целы;
 *  3. смерть в чужой системе: транспорт несёт на базу, трюм сгорел с бортом;
 *  4. док на базе: вкладка «База» видит склад; сдать/взять — арифметика, склад
 *     безлимитен (больше трюма), отказ при забитом трюме;
 *  5. сейв v10 несёт базу и склад; перенос базы в Кронос; «завершить сессию» → меню;
 *     continue — склад цел, респаун уже на новой базе.
 *
 * Использование: npm run build:test && npm run base   (сервит dist/, как остальные зонды)
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
  console.error(`BASE FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
];
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try {
    browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {});
    break;
  } catch { /* next */ }
}
if (!browser) { console.error("BASE FAIL: no usable browser"); server.close(); process.exit(1); }
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
  window.__sim.give("wasp-A");          // модуль на склад — должен пережить гибель
  window.__sim.hull("corvette");        // недешёвый корпус — обязан сгореть
  window.__sim.god();
  window.__sim.hide();
  window.__sim.step(200);
  window.__sim.cash(20000);
});

// 1) дефолт: у нового капитана база — Эйдолон, склад пуст
const b0 = await page.evaluate(() => window.__sim.base());

// 2) смерть в своей системе: груз → поддоны у обломков, остальное — респаун
const same = await page.evaluate(() => {
  const a0 = window.__sim.step(1); // аудит после накачки денег (gain/pay нейтральны)
  window.__sim.pcargo("food", 5);
  window.__sim.pcargo("ore", 3);
  window.__sim.pcargo("meds", 2);
  window.__sim.pcargo("tech", 2); // четвёртый по GOODS после лимита трёх поддонов — сгорит
  const pos = window.__sim.probe().pos;
  const state = window.__sim.dieNow();
  const a1 = window.__sim.step(1);
  const snap = window.__uiBridge.getSnapshot();
  const pods = window.__sim.pickups().filter((p) => p.kind === "cargo");
  return {
    state, pos, credits0: a0.player, credits1: a1.player, delta: a1.delta,
    screen: snap.screen, end: snap.end,
    news: snap.feed.map((f) => f.text),
    ship: window.__sim.ship(),
    cargo: { food: window.__sim.pcargo("food"), ore: window.__sim.pcargo("ore"), tech: window.__sim.pcargo("tech") },
    pods, base: window.__sim.base(),
  };
});

// 3) смерть в чужой системе: трюм сгорает с бортом, транспорт — на базу
const cross = await page.evaluate(() => {
  window.__sim.jump("kronos");
  window.__sim.pcargo("food", 6);
  const state = window.__sim.dieNow();
  const a = window.__sim.step(1);
  return {
    state, delta: a.delta, food: window.__sim.pcargo("food"),
    podsHere: window.__sim.pickups().filter((p) => p.kind === "cargo" && p.goodId === "food" && p.amount === 6).length,
    base: window.__sim.base(),
  };
});

// 4) док на базе: склад, сдать/взять, безлимит, отказ, сейв v10
const dock = await page.evaluate(() => {
  const sts = window.__sim.stations();
  const ok = window.__sim.dockAt(sts[0].id);
  const snap0 = window.__uiBridge.getSnapshot().station;
  window.__gameApi.current.setHomeBase();
  const b1 = window.__sim.base();
  const snap1 = window.__uiBridge.getSnapshot().station;
  window.__sim.pcargo("food", 8);
  window.__gameApi.current.baseStore("food", 8);
  const afterStore = window.__sim.base().cargo;
  window.__sim.pcargo("food", 20);
  window.__gameApi.current.baseStore("food", 20); // склад без лимита трюма: 28 тонн
  const unlimited = window.__sim.base().cargo;
  window.__gameApi.current.baseTake("food", 3);
  const take3 = { hold: window.__sim.pcargo("food"), store: window.__sim.base().cargo.food };
  window.__gameApi.current.baseTake("food", 99999); // сколько влезет — до отказа
  const takeMax = { hold: window.__sim.pcargo("food"), store: window.__sim.base().cargo.food };
  window.__gameApi.current.baseTake("food", 5); // трюм забит — отказ
  const refuse = { hold: window.__sim.pcargo("food"), news: window.__uiBridge.getSnapshot().feed.map((f) => f.text) };
  const raw = JSON.parse(localStorage.getItem("game.savegame"));
  return {
    docked: ok, stsId: sts[0].id,
    here: snap0.base.here, isHome0: snap0.base.isHome, canSet: snap0.base.canSet,
    isHome1: snap1.base.isHome, b1,
    afterStore, unlimited, take3, takeMax, refuse,
    save: { v: raw.v, st: raw.base && raw.base.st, cargo: raw.base && raw.base.cargo, sys: raw.base && raw.base.sys },
  };
});

// 5) перенос базы в Кронос, «завершить сессию», continue: склад цел, респаун — новый
const moved = await page.evaluate(() => {
  window.__sim.sundock();
  window.__sim.jump("kronos");
  const sts2 = window.__sim.stations();
  window.__sim.dockAt(sts2[0].id);
  const snap = window.__uiBridge.getSnapshot().station;
  const wasHere = snap.base.here; // чужая система — склад закрыт
  window.__gameApi.current.setHomeBase();
  const b2 = window.__sim.base();
  window.__gameApi.current.endSession();
  const screen = window.__uiBridge.getSnapshot().screen;
  const raw = JSON.parse(localStorage.getItem("game.savegame"));
  window.__gameApi.current.continueGame();
  const b3 = window.__sim.base(); // после continue — система сейва (Кронос), склад на месте
  window.__sim.jump("eidolon");   // гибель вдали от новой базы → транспорт в Кронос
  window.__sim.dieNow();
  const b4 = window.__sim.base();
  return {
    wasHere, canSet: snap.base.canSet, b2, screen, stId: sts2[0].id,
    save: { v: raw.v, sys: raw.base && raw.base.sys, cargo: raw.base && raw.base.cargo, system: raw.system },
    b3, b4,
  };
});

// 6) хвост: мир живой, страница без ошибок
const tail = await page.evaluate(() => {
  window.__sim.step(300);
  return { alive: window.__sim.count("patrol") + window.__sim.count("trader") };
});

const podsSame = same.pods;
const nearWreck = podsSame.every((p) => Math.hypot(p.x - same.pos[0], p.y - same.pos[1]) < 200);
const ok = {
  okBaseDefault: b0.sys === "eidolon" && b0.st === null && Object.keys(b0.cargo).length === 0,
  okDeathNoEnd: same.state === "playing" && same.screen === "playing" && same.end === null,
  okHullReset: same.ship.ship === "fighter"
    && same.ship.installed.weapon.join() === "needle-C"
    && same.ship.installed.shield.join() === "turtle-C"
    && same.ship.installed.engine.join() === "spark-C"
    && same.ship.hp === 120,
  okStashKept: same.ship.stash.includes("wasp-A"),
  okPods: podsSame.length === 3
    && ["food", "ore", "meds"].every((g) => podsSame.some((p) => p.goodId === g && p.amount > 0))
    && !podsSame.some((p) => p.goodId === "tech"), // четвёртый в порядке GOODS — за лимитом, сгорел
  okPodTtl: podsSame.every((p) => p.life >= 595),
  okPodPos: podsSame.length > 0 && nearWreck,
  okCargoEmpty: same.cargo.food === 0 && same.cargo.ore === 0 && same.cargo.tech === 0,
  okNews: same.news.some((t) => t.includes("Катапультирование")),
  okMoney: same.credits0 === 20000 && same.credits1 === 20000 && Math.abs(same.delta) < 1e-3,
  okCrossRespawn: cross.state === "playing" && cross.base.sysNow === "eidolon" && Math.abs(cross.delta) < 1e-3,
  okCargoBurned: cross.food === 0 && cross.podsHere === 0,
  okHereSnap: dock.docked && dock.here && !dock.isHome0 && dock.canSet && dock.isHome1 && dock.b1.st === dock.stsId,
  okStore: dock.afterStore.food === 8,
  okNoCap: dock.unlimited.food === 28, // склад шире трюма истребителя (24)
  okTake: dock.take3.hold === 3 && dock.take3.store === 25,
  okTakeMax: dock.takeMax.hold === 24 && dock.takeMax.store === 4,
  okRefuse: dock.refuse.hold === 24 && dock.refuse.news.some((t) => t.includes("трюм забит")),
  okSaveV10: dock.save.v === 10 && dock.save.sys === "eidolon" && dock.save.st === dock.stsId && dock.save.cargo.food === 4,
  okMoveBase: !moved.wasHere && moved.canSet && moved.b2.sys === "kronos" && moved.b2.st === moved.stId,
  okSessionTitle: moved.screen === "title",
  okSaveStash: moved.save.v === 10 && moved.save.sys === "kronos" && moved.save.system === "kronos" && moved.save.cargo.food === 4,
  okContinue: moved.b3.sys === "kronos" && moved.b3.cargo.food === 4 && moved.b3.st === moved.b2.st,
  okRespawnNewBase: moved.b4.sysNow === "kronos",
  okWorld: tail.alive >= 6,
  noPageErrors: pageErrors.length === 0,
};
done(ok, { b0, same: { ...same, pods: podsSame.length }, cross, dock, moved, tail, pageErrors: pageErrors.length ? pageErrors : undefined });
