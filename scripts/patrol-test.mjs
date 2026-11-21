/**
 * patrol-test.mjs — автотест гильдейской повинности караванов (Этап 14b):
 * отчисления с прибыли рейса в казну патруля, разведка (караван наводит патруль
 * на замеченных рейдеров) и сигнал бедствия (ближайший катер спешит на помощь).
 * Проверяет:
 *  1. отчисления: серия прибыльных сделок подкидывает ₡ в pools.patrol ровно на
 *     столько, сколько показал гильдейский гурт (guildLedger), аудит денег цел;
 *  2. сводка: пират в радиусе глазомера каравана получает метку, гурт отчётов растёт;
 *  3. охота по метке: катер, которому рейдер НЕ виден (дальше порока аггро 3200),
 *     всё равно берёт его в наводку — работает разведка каравана, а не свои глаза;
 *  4. вызов: попадание пирата поднимает ближайший казённый катер (callT/callIdx),
 *     катер идёт к каравану;
 *  5. кулдаун: второй сигнал того же каравана в CALL_CD никого не поднимает;
 *  6. гибель участников сводки/вызова не роняет мир; деньги целы.
 *
 * Использование: npm run build:test && npm run patrol   (сервит dist/, как trader-test)
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
  console.error(`PATROL FAIL: no build output at ${DIST} — run \`npm run build:test\` first`);
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
if (!browser) { console.error("PATROL FAIL: no usable browser"); server.close(); process.exit(1); }
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

// ── 1. гильдейские отчисления: серия прибыльных ходок → казна патруля ──
const dues = await page.evaluate(() => {
  const t = window.__sim.traders()[0];
  if (!t) return { found: false };
  const g0 = window.__sim.guild();
  const a0 = window.__sim.step(0); // аудит-снимок без шага мира
  let cycles = 0;
  for (let k = 0; k < 8 && window.__sim.guild().duezed === g0.duezed; k++) {
    window.__sim.twallet(t.i, 15000); // фонд выхода, чтобы сделке было чем крутиться
    window.__sim.tdock(t.i);           // продажа/закупка + сбор у дока
    cycles++;
  }
  const g1 = window.__sim.guild();
  const a1 = window.__sim.step(0);
  return {
    found: true, cycles,
    dues: g1.duezed - g0.duezed,
    patrolGain: a1.pools.patrol - a0.pools.patrol, // содержит и тариф 13a — сверяем нижнюю границу
    delta: a1.delta,
  };
});

// ── 2. сводка: замеченный рейдер получает метку ──
const report = await page.evaluate(() => {
  const t = window.__sim.traders()[0];
  if (!t) return { found: false };
  const r0 = window.__sim.guild().reports;
  const pi = window.__sim.pirateSpawn(t.x + 240, t.y + 30); // в радиусе глазомера
  let marked = false;
  for (let k = 0; k < 24 && !marked; k++) {
    window.__sim.step(15); // цикл think каравана ~0.42 с
    marked = window.__sim.marks().some((m) => m.j === pi);
  }
  return { found: true, pi, marked, reports: window.__sim.guild().reports - r0 };
});

// ── 3. охота по метке: катер берёт рейдера, который ему НЕ виден ──
const hunt = await page.evaluate(() => {
  const ts = window.__sim.traders();
  const t = ts[1] ?? ts[0];
  if (!t) return { found: false };
  const ps = window.__sim.patrols();
  if (!ps.length) return { found: false };
  // ставим караван туда, где ближайший катер дальше порога аггро 3200 —
  // глазам патруля рейдер недоступен, в наводку он берётся только по сводке
  let best = null, bestMin = -1;
  for (let a = 0; a < 8; a++) {
    for (const r of [3400, 5200]) {
      const cx = Math.cos((a * Math.PI) / 4) * r, cy = Math.sin((a * Math.PI) / 4) * r;
      const mind = Math.min(...ps.map((p) => Math.hypot(p.x - cx, p.y - cy)));
      if (mind > bestMin) { bestMin = mind; best = { cx, cy, mind }; }
    }
  }
  if (!best || bestMin <= 3200) return { found: true, skip: "нет дальней точки", ok: false };
  window.__sim.tmove(t.i, best.cx, best.cy);
  // одинокий рейдер может не дожить до сводки: конвой 14a отстреливается.
  // Подсаживаем новых на то же место, пока хоть один не доживёт до наводки катера.
  let pi = window.__sim.pirateSpawn(best.cx + 200, best.cy + 40);
  let locked = false;
  for (let k = 0; k < 80 && !locked; k++) {
    let pir = window.__sim.pinfo(pi);
    if (!pir) {
      pi = window.__sim.pirateSpawn(best.cx + 200, best.cy + 40);
      pir = window.__sim.pinfo(pi);
      if (!pir) break;
    }
    window.__sim.step(15);
    const cur = window.__sim.pinfo(pi);
    if (!cur) continue;
    locked = window.__sim.patrols().some((p) => p.target === pi
      && Math.hypot(p.x - cur.x, p.y - cur.y) > 3200);
  }
  return { found: true, locked, minDist: best.mind };
});

// ── 4. сигнал бедствия: ближайший катер идёт на помощь ──
const call = await page.evaluate(() => {
  // секции 2–3 оставили дежурных рейдеров: сшибаем меченых, ждём караван без кулдауна
  for (const m of window.__sim.marks()) window.__sim.tfree(m.j);
  let t = null;
  for (let g = 0; g < 60 && !t; g++) {
    window.__sim.step(15);
    t = window.__sim.traders().find((x) => x.callCd <= 0 && x.anger < 0) ?? null;
  }
  const ps = window.__sim.patrols();
  if (!t || !ps.length) return { found: false };
  let near = ps[0], nd = Infinity;
  for (const p of ps) { const d = Math.hypot(p.x - t.x, p.y - t.y); if (d < nd) { nd = d; near = p; } }
  // караван в 2.4 к от выбранного катера — в радиусе вызова 3000
  window.__sim.tmove(t.i, near.x + 2200, near.y + 900);
  const tr0 = window.__sim.traders().find((x) => x.i === t.i);
  const d0 = Math.hypot(near.x - tr0.x, near.y - tr0.y);
  const c0 = window.__sim.guild().calls;
  const pi = window.__sim.pirateSpawn(tr0.x + 150, tr0.y);
  window.__sim.thit(t.i, 8, pi); // попадание рейдера = сигнал бедствия
  const picked = window.__sim.patrols().find((p) => p.callIdx === t.i && p.callT > 0);
  let d1 = Infinity, engaged = false;
  for (let k = 0; k < 34 && !(d1 < d0 - 250); k++) {
    window.__sim.step(15); // 0.25 с
    const now = window.__sim.traders().find((x) => x.i === t.i);
    const b = window.__sim.patrols().find((p) => picked && p.i === picked.i);
    if (now && b) {
      d1 = Math.min(d1, Math.hypot(b.x - now.x, b.y - now.y));
      engaged = engaged || b.target === pi || b.callT > 0;
    }
  }
  return { found: true, picked: !!picked, calls: window.__sim.guild().calls - c0, d0: Math.round(d0), d1: Math.round(d1), engaged };
});

// ── 5. кулдаун: повторный вызов того же каравана никого не поднимает ──
const cd = await page.evaluate(() => {
  const t = window.__sim.traders().find((x) => x.callCd > 0);
  if (!t) return { found: false };
  const c0 = window.__sim.guild().calls;
  const pi = window.__sim.pirateSpawn(t.x + 160, t.y - 20);
  window.__sim.thit(t.i, 5, pi);
  return { found: true, extra: window.__sim.guild().calls - c0 };
});

// ── 6. гибель участников сводки/вызова не роняет мир; деньги целы ──
const tail = await page.evaluate(() => {
  for (const m of window.__sim.marks()) window.__sim.tfree(m.j); // сшибить всех меченых
  for (const p of window.__sim.patrols()) if (p.callT > 0) window.__sim.tfree(p.i); // и отозванных катером
  window.__sim.step(900); // 15 с: мир перезаполняется, сводки протухают
  const audit = window.__sim.step(1);
  return {
    delta: audit.delta,
    alive: window.__sim.count("patrol") + window.__sim.count("trader"),
    sane: window.__sim.patrols().every((p) => p.callIdx < 0 || p.callT <= 0 || window.__sim.pinfo(p.callIdx)),
  };
});

const ok = {
  okDues: dues.found && dues.dues > 0 && dues.patrolGain >= dues.dues - 1e-6 && Math.abs(dues.delta) < 1,
  okReport: report.found && report.marked && report.reports >= 1,
  okMarkHunt: hunt.found && hunt.locked,
  okCall: call.found && call.picked && call.calls >= 1 && call.d1 < call.d0 - 250 && call.engaged,
  okCallCd: cd.found && cd.extra === 0,
  okClean: tail.alive >= 6 && tail.sane,
  okMoney: Math.abs(tail.delta) < 1,
  noPageErrors: pageErrors.length === 0,
};
done(ok, {
  dues, report, hunt, call, cd, tail,
  pageErrors: pageErrors.length ? pageErrors : undefined,
});
