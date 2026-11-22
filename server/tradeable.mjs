/**
 * tradeable.mjs — whitelist id, допустимых в торговле игрок↔игрок (аудит 15c).
 * Источник истины — src/game/config.ts (GOODS, EQUIP_LINES, RANKS); здесь
 * дублируются только id. Дрейф ловит test-trade.mjs (парсит config.ts и
 * проверяет, что каждый игровой id принимается isTradeableId).
 */

const GOODS_IDS = ["food", "ore", "meds", "tech", "lux", "arms", "tobacco", "spice", "drugs"];
const MODULE_LINES = ["needle", "wasp", "hammer", "lance", "turtle", "bastion", "citadel", "spark", "turbine", "reactor"];
const RANKS = ["C", "B", "A", "S", "SS", "SSS"];

const GOODS_SET = new Set(GOODS_IDS);
const MODULE_SET = new Set(MODULE_LINES.flatMap((l) => RANKS.map((r) => `${l}-${r}`)));

/** id товара (food) или модуля (needle-C … reactor-SSS). */
export function isTradeableId(id) {
  return GOODS_SET.has(id) || MODULE_SET.has(id);
}
