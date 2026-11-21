/**
 * storage.ts — localStorage persistence (high score/progress/settings).
 * Browser-local storage: doesn't sync across devices, and clearing browser data loses it — state this to the user on delivery.
 *
 * Этап 15a: опциональная облачная синхронизация сейва. Ключ "savegame" пишется
 * локально (sync API неизменен) и дебаунсом уходит на сервер через attachRemote();
 * preloadRemote() перед стартом игры поднимает облачную копию в localStorage.
 */

const PREFIX = "game.";

/** Ключ, синхронизируемый с облаком (= SAVE_KEY из config.ts; дублируется, чтобы не тянуть config в storage). */
const REMOTE_SYNC_KEY = "savegame";
const PUSH_DEBOUNCE_MS = 3000;

/** Реализация облачного канала; подключается из src/auth/client.ts. */
export interface RemoteSync {
  /** Сырой JSON сейва с сервера либо null, если облачного сейва нет. */
  preload(): Promise<string | null>;
  /** Отправка сырого JSON на сервер (fire-and-forget, ошибки глушатся каналом). */
  push(raw: string): void;
}

let remote: RemoteSync | null = null;
let pendingRaw: string | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function attachRemote(sync: RemoteSync | null): void {
  remote = sync;
  pendingRaw = null;
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}

/**
 * Поднимает облачный сейв в localStorage до старта игры. Облако — источник истины
 * для залогиненного игрока; если облачного сейва нет, локальный остаётся (первая
 * игра с аккаунта унаследует прогресс этого браузера и запишется в облако).
 */
export async function preloadRemote(): Promise<void> {
  if (!remote) return;
  try {
    const raw = await remote.preload();
    if (raw !== null) {
      localStorage.setItem(PREFIX + REMOTE_SYNC_KEY, raw);
    }
  } catch {
    // Сервер недоступен — играем на локальной копии, запись догонит позже.
  }
}

/** Немедленная отправка накопленной записи (beforeunload, logout). */
export function flushRemote(): void {
  if (!remote || pendingRaw === null) return;
  const raw = pendingRaw;
  pendingRaw = null;
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  remote.push(raw);
}

function schedulePush(raw: string): void {
  if (!remote) return;
  pendingRaw = raw;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(flushRemote, PUSH_DEBOUNCE_MS);
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    try {
      const raw = JSON.stringify(value);
      localStorage.setItem(PREFIX + key, raw);
      if (key === REMOTE_SYNC_KEY) schedulePush(raw);
    } catch {
      // fails silently when storage is full/in private mode, without affecting the game
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // same as set(): storage unavailable is not a game error
    }
  },
};

export const highScore = {
  get: () => storage.get<number>("highScore", 0),
  set: (v: number) => storage.set("highScore", v),
};
