/**
 * world.ts — клиент общего шарда (Этап 15b).
 * WebSocket-подключение к /api/ws, ростер игроков, общие пулы, реконнект.
 * Протокол: server/CONTRACT.md (раздел «Общий шард»).
 *
 * ВАЖНО: модуль НЕ подключён к игровому циклу — интеграция в game.ts
 * (отправка своего state 10 Гц, рендер чужих кораблей и позывных) идёт
 * отдельным шагом по треку Б. Здесь — готовый транспорт с чистым API.
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8787";
const SEND_INTERVAL_MS = 100; // 10 Гц — достаточно для позиций, сервер режет до 20 Гц
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface PlayerState {
  x: number;
  y: number;
  a: number;
  sys?: string;
  hull?: string;
}

export interface RemotePlayer {
  id: string;
  username: string;
  state: PlayerState | null;
}

export interface WorldInfo {
  pools: { patrol: number; alliance: number; clan: number; stations: number };
  online: number;
  registered: number;
  updatedAt: number;
}

export type WorldStatus = "offline" | "connecting" | "online";

type Listener = () => void;

class WorldNet {
  status: WorldStatus = "offline";
  selfId: string | null = null;
  players = new Map<string, RemotePlayer>();
  world: WorldInfo | null = null;

  private ws: WebSocket | null = null;
  private token: string | null = null;
  private listeners = new Set<Listener>();
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private pendingState: PlayerState | null = null;
  private deliberatelyClosed = false;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  connect(token: string): void {
    this.token = token;
    this.deliberatelyClosed = false;
    this.#open();
  }

  disconnect(): void {
    this.deliberatelyClosed = true;
    this.token = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.#stopSending();
    this.ws?.close();
    this.ws = null;
    this.players.clear();
    this.selfId = null;
    this.status = "offline";
    this.emit();
  }

  /** Игра шлёт свою позицию; реальная отправка — таймером 10 Гц. */
  setState(s: PlayerState): void {
    this.pendingState = s;
  }

  #wsUrl(): string {
    const base = API.replace(/^http/, "ws");
    return `${base}/api/ws?token=${encodeURIComponent(this.token || "")}`;
  }

  #open(): void {
    if (!this.token) return;
    this.status = "connecting";
    this.emit();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#wsUrl());
    } catch {
      return this.#scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.#startSending();
    };
    ws.onmessage = (e) => this.#onMessage(String(e.data));
    ws.onclose = () => {
      this.#stopSending();
      if (this.ws === ws) this.ws = null;
      this.players.clear();
      this.selfId = null;
      this.status = "offline";
      this.emit();
      if (!this.deliberatelyClosed) this.#scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  #scheduleReconnect(): void {
    if (this.deliberatelyClosed || !this.token) return;
    this.status = "connecting";
    this.emit();
    this.reconnectTimer = setTimeout(() => this.#open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  #startSending(): void {
    this.#stopSending();
    this.sendTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.pendingState) {
        this.ws.send(JSON.stringify({ t: "state", ...this.pendingState }));
      }
    }, SEND_INTERVAL_MS);
  }

  #stopSending(): void {
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.sendTimer = null;
  }

  #onMessage(text: string): void {
    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome": {
        this.selfId = msg.id as string;
        this.players.clear();
        for (const p of msg.players as RemotePlayer[]) this.players.set(p.id, p);
        this.world = msg.world as WorldInfo;
        this.status = "online";
        break;
      }
      case "join": {
        const p = msg.player as RemotePlayer;
        this.players.set(p.id, p);
        break;
      }
      case "leave": {
        this.players.delete(msg.id as string);
        break;
      }
      case "state": {
        const p = this.players.get(msg.id as string);
        if (p) p.state = { x: msg.x as number, y: msg.y as number, a: msg.a as number, sys: msg.sys as string | undefined, hull: msg.hull as string | undefined };
        break;
      }
      case "world": {
        this.world = msg.world as WorldInfo;
        break;
      }
      default:
        return;
    }
    this.emit();
  }
}

export const worldNet = new WorldNet();

// Отладочный доступ из консоли/E2E (только чтение состояния; не API игры).
if (typeof window !== "undefined") {
  (window as unknown as { __worldNet: WorldNet }).__worldNet = worldNet;
}
