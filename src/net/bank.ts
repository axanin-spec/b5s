/**
 * bank.ts — мост между локальными кредитами игры и серверным счётом (15c).
 *
 * Модель: у игрока ДВА кармана — локальные кредиты в сейве (сингл-экономика)
 * и серверный счёт в ledger (мультиплеер: торговля, PvP-выплаты). Переложить
 * деньги можно через «банк на станции»:
 *   deposit(n)  — локальные → сервер (tx player:me → pool:stations)
 *   withdraw(n) — сервер → локальные (grant pool:stations → player:me,
 *                 лимит 500k/час — анти-абьюз до серверной валидации событий)
 * Игровая сторона (трек Б) двигает player.credits зеркально вызовам.
 */

import type { Session } from "@/auth/client";

const API = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8787";

export interface Balance {
  player: number;
  pools: { patrol: number; alliance: number; clan: number; stations: number };
}

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null;
  if (!data || !data.ok) throw new Error(data?.error || `http_${res.status}`);
  return data;
}

export function getBalance(session: Session): Promise<Balance> {
  return call<Balance>("GET", "/api/balance", session.token);
}

export function deposit(session: Session, amount: number): Promise<{ balance: number }> {
  return call("POST", "/api/tx", session.token, {
    id: crypto.randomUUID(),
    from: `player:${session.username}`,
    to: "pool:stations",
    amount,
    reason: "deposit",
  });
}

export function withdraw(session: Session, amount: number): Promise<{ balance: number }> {
  return call("POST", "/api/grant", session.token, {
    id: crypto.randomUUID(),
    from: "pool:stations",
    to: `player:${session.username}`,
    amount,
    reason: "withdraw",
  });
}
