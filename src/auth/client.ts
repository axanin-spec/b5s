/**
 * client.ts — API-клиент сервера «Космический Рейнджер» (Этап 15a).
 * Аккаунты + облачный сейв. Контракт: server/CONTRACT.md.
 * Адрес сервера: import.meta.env.VITE_API_URL, по умолчанию http://localhost:8787.
 */

import { attachRemote, flushRemote } from "@/game/storage";

const API = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8787";
const AUTH_KEY = "game.auth";

export interface Session {
  token: string;
  username: string;
}

export class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network");
  }
  const data = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
  if (!data || !data.ok) throw new ApiError(data?.error || `http_${res.status}`);
  return data as T;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s.token === "string" && typeof s.username === "string" ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(s));
}

export function logout(): void {
  const s = getSession();
  if (s) {
    // отзыв токена на сервере; keepalive — запрос доживает при закрытии вкладки
    fetch(`${API}/api/logout`, {
      method: "POST",
      keepalive: true,
      headers: { Authorization: `Bearer ${s.token}` },
    }).catch(() => {});
  }
  flushRemote();
  attachRemote(null);
  localStorage.removeItem(AUTH_KEY);
}

export async function register(
  username: string,
  password: string,
  email?: string,
): Promise<{ session: Session | null; needVerification: boolean; username: string }> {
  const r = await call<
    { token?: string; username: string; needVerification?: boolean }
  >("POST", "/api/register", { username, password, ...(email ? { email } : {}) });
  if (r.needVerification) return { session: null, needVerification: true, username: r.username };
  const s = { token: r.token!, username: r.username };
  saveSession(s);
  return { session: s, needVerification: false, username: r.username };
}

/** Подтверждение почты кодом → сессия (Этап 16c). */
export async function verifyEmail(username: string, code: string): Promise<Session> {
  const s = await call<Session>("POST", "/api/verify", { username, code });
  saveSession(s);
  return s;
}

/** Повторная отправка кода подтверждения. */
export async function resendCode(username: string): Promise<void> {
  await call("POST", "/api/verify-resend", { username });
}

/** Запрос кода сброса пароля на email (ответ сервера всегда ok). */
export async function resetRequest(email: string): Promise<void> {
  await call("POST", "/api/reset-request", { email });
}

/** Смена пароля по коду с почты → новая сессия (старые токены отозваны). */
export async function resetConfirm(email: string, code: string, password: string): Promise<Session> {
  const s = await call<Session>("POST", "/api/reset-confirm", { email, code, password });
  saveSession(s);
  return s;
}

export async function login(username: string, password: string): Promise<Session> {
  const s = await call<Session>("POST", "/api/login", { username, password });
  saveSession(s);
  return s;
}

/**
 * Подключает облачную синхронизацию сейва к storage (write-through с дебаунсом).
 * Вызывать один раз после входа, до preloadRemote().
 */
export function wireRemoteSync(session: Session): void {
  attachRemote({
    preload: async () => {
      const data = await call<{ save: unknown }>("GET", "/api/save", undefined, session.token);
      // Отдаём сырой JSON: полную валидацию выполнит validateSave при загрузке игры.
      return data.save === null || data.save === undefined ? null : JSON.stringify(data.save);
    },
    push: (raw) => {
      // keepalive: запись доживает при закрытии вкладки (flushRemote → beforeunload).
      fetch(`${API}/api/save`, {
        method: "PUT",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ save: JSON.parse(raw) }),
      }).catch(() => {
        // Сеть моргнула — локальная копия в localStorage остаётся источником до следующей записи.
      });
    },
  });
}
