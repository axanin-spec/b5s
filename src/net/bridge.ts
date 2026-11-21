/**
 * bridge.ts — мост игрового состояния в общий шард (Этап 15b).
 *
 * 15b (трек Б): отправка переехала в игровой цикл — game.ts шлёт полный state
 * (x, y, a, sys, hull) 10 раз/с из update(). Мост больше НЕ шлёт: вторая
 * строка без hull затирали бы игровую между тиками. Экспорт сохранён —
 * Home.tsx вызывает start/stop при входе и выходе из игры.
 */

export function startNetBridge(): void {}

export function stopNetBridge(): void {}
