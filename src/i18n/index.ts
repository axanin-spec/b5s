/**
 * i18n — лёгкая многоязычность без зависимостей.
 * Словари: src/i18n/locales/<lang>.ts (ключи — плоские, "area.key").
 * Выбор языка хранится в localStorage ("b5s.lang"); дефолт — по navigator.language
 * (ru* → ru, иначе en). Fallback: ru → сам ключ.
 * Добавление языка: скопировать ru.ts, перевести значения, вписать в LOCALES.
 */

import { useSyncExternalStore } from "react";
import { ru } from "./locales/ru";
import { en } from "./locales/en";

export type Dict = Record<string, string>;

export const LOCALES = {
  ru: { dict: ru as Dict, label: "Русский" },
  en: { dict: en as Dict, label: "English" },
} as const;

export type Locale = keyof typeof LOCALES;

const STORAGE_KEY = "b5s.lang";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LOCALES) return saved as Locale;
  } catch {}
  const nav = typeof navigator !== "undefined" ? navigator.language?.toLowerCase() || "" : "";
  return nav.startsWith("ru") ? "ru" : "en";
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale) {
  if (l === current || !(l in LOCALES)) return;
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {}
  document.documentElement.lang = l;
  for (const fn of listeners) fn();
}

/** Перевод по ключу; {var} в строке подставляется из vars. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = LOCALES[current].dict[key] ?? LOCALES.ru.dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** React-хук: возвращает [locale, t], перерендеривает при смене языка. */
export function useI18n(): [Locale, typeof t] {
  const l = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return [l, t];
}
