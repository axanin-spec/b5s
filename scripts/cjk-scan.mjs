// cjk-scan.mjs — поиск слипшихся иероглифов/арабицы/каны в русских файлах.
// Regex ТОЛЬКО escape-нотацией (литеральные кандзи набираются искажённо, а
// класс с суррогатами даёт ложняки на эмодзи). Выход 0 — чисто.
import { readFileSync } from "node:fs";

const ROOT = "E:/Рейнджеры/app/";
const SCRATCH = "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-AppData-Roaming-CherryStudio-Data-Agents-system-2026-11-16-403eb74c-4298-40c6-95c8-25c5fe7f412a/3db6dfc6-1b2b-45d1-a6e6-224dfcf84ef4/scratchpad/";
const FILES = [
  "scripts/post-victory-test.mjs",
  "scripts/boss-test.mjs",
  "scripts/base-test.mjs",
  "scripts/pvp-test.mjs",
  "scripts/balance-test.mjs",
  "scripts/fleet-test.mjs",
  "scripts/intel-test.mjs",
  "src/game/config.ts",
  "src/game/types.ts",
  "src/game/save.ts",
  "src/game/missions.ts",
  "src/game/game.ts",
  "src/game/render.ts",
  "src/game/uiBridge.ts",
  "src/net/world.ts",
  "src/ui/Hud.tsx",
  "src/ui/StationScreen.tsx",
  "src/ui/TradeWindow.tsx",
  "src/index.css",
  "PLAN.md",
];
const TEXTS = [["msg.txt", SCRATCH + "msg.txt"]];
const RE = /[\u4E00-\u9FFF\uF900-\uFAFF\u0600-\u06FF\u3040-\u30FF]/g;
let bad = 0;
for (const f of FILES) {
  const src = readFileSync(ROOT + f, "utf8");
  const hits = src.match(RE);
  if (hits) { bad += hits.length; console.log(`${f}: ${hits.length} × ${[...new Set(hits)].join(" ")}`); }
}
for (const [label, p] of TEXTS) {
  try {
    const src = readFileSync(p, "utf8");
    const hits = src.match(RE);
    if (hits) { bad += hits.length; console.log(`${label}: ${hits.length} × ${[...new Set(hits)].join(" ")}`); }
  } catch { /* нет файла — не проверяем */ }
}
console.log(bad === 0 ? "CJK SCAN: CLEAN" : `CJK SCAN: ${bad} ХИТОВ`);
process.exit(bad === 0 ? 0 : 1);
