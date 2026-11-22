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
  /** 15c: здоровье для серверной оценки боёв (цель без hp считается со 100 hp). */
  hp?: number;
  maxHp?: number;
  /** 13e: титул «Победитель галактики» — additive, сервер пропустит как unknown,
   *  пока трек А не добавит поле в sanitizeState. */
  legend?: boolean;
}

export interface RemotePlayer {
  id: string;
  username: string;
  state: PlayerState | null;
  dead?: boolean;
}

/** Боевое событие шарда (15c): hit — попадание по id, kill — смерть, respawn — возврат. */
export interface CombatEvent {
  t: "hit" | "kill" | "respawn";
  id: string;
  from?: string;
  by?: string;
  dmg?: number;
  hp?: number;
}

/** Входящее торговое предложение (15c). */
export interface TradeOffer {
  id: string;
  from: string;
  fromName: string;
  giveCredits: number;
  wantCredits: number;
  giveGoods: Record<string, number>;
  wantGoods: Record<string, number>;
}

/** Исход сделки (15c): done — расчёт прошёл (товары переходят на клиентах). */
export interface TradeEvent {
  t: "trade_done" | "trade_fail" | "trade_declined" | "trade_cancelled";
  id: string;
  reason?: string;
  /** 15c (трек Б): условия расчёта — сервер кладёт их в trade_done, чтобы
   *  клиенты перенесли товары между трюмами. У прочих исходов их нет. */
  from?: string;
  to?: string;
  giveCredits?: number;
  wantCredits?: number;
  giveGoods?: Record<string, number>;
  wantGoods?: Record<string, number>;
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
  /** Последние боевые события шарда (15c), новые в конце, ≤ 100. */
  combatLog: CombatEvent[] = [];
  /** Входящие торговые офферы (15c), по id. */
  tradeOffers = new Map<string, TradeOffer>();
  /** Исходы сделок, новые в конце, ≤ 50. */
  tradeEvents: TradeEvent[] = [];

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
    this.combatLog = [];
    this.tradeOffers.clear();
    this.tradeEvents = [];
    this.selfId = null;
    this.status = "offline";
    this.emit();
  }

  /** Игра шлёт свою позицию; реальная отправка — таймером 10 Гц. */
  setState(s: PlayerState): void {
    this.pendingState = s;
  }

  /** PvP (15c): заявка о попадании по игроку. Сервер верифицирует и рассылает. */
  sendHit(targetId: string, dmg: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "hit", target: targetId, dmg }));
    }
  }

  /** Торговля (15c): создать оффер игроку toId. id генерируется клиентом (идемпотентность). */
  sendTradeOffer(toId: string, terms: { giveCredits?: number; wantCredits?: number; giveGoods?: Record<string, number>; wantGoods?: Record<string, number> }): string {
    const id = crypto.randomUUID();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "trade_offer", id, to: toId, ...terms }));
    }
    return id;
  }

  acceptTrade(id: string): void {
    this.#sendTradeVerb("trade_accept", id);
  }

  declineTrade(id: string): void {
    this.tradeOffers.delete(id);
    this.#sendTradeVerb("trade_decline", id);
    this.emit();
  }

  cancelTrade(id: string): void {
    this.#sendTradeVerb("trade_cancel", id);
  }

  #sendTradeVerb(verb: string, id: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: verb, id }));
    }
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
      case "hit": {
        const ev: CombatEvent = { t: "hit", id: msg.id as string, from: msg.from as string, dmg: msg.dmg as number, hp: msg.hp as number };
        this.combatLog.push(ev);
        if (this.combatLog.length > 100) this.combatLog.shift();
        break;
      }
      case "kill": {
        const ev: CombatEvent = { t: "kill", id: msg.id as string, by: msg.by as string };
        this.combatLog.push(ev);
        if (this.combatLog.length > 100) this.combatLog.shift();
        const p = this.players.get(ev.id);
        if (p) p.dead = true;
        break;
      }
      case "respawn": {
        const ev: CombatEvent = { t: "respawn", id: msg.id as string };
        this.combatLog.push(ev);
        if (this.combatLog.length > 100) this.combatLog.shift();
        const p = this.players.get(ev.id);
        if (p) p.dead = false;
        break;
      }
      case "trade_offer": {
        const offer: TradeOffer = {
          id: msg.id as string,
          from: msg.from as string,
          fromName: msg.fromName as string,
          giveCredits: (msg.giveCredits as number) || 0,
          wantCredits: (msg.wantCredits as number) || 0,
          giveGoods: (msg.giveGoods as Record<string, number>) || {},
          wantGoods: (msg.wantGoods as Record<string, number>) || {},
        };
        this.tradeOffers.set(offer.id, offer);
        break;
      }
      case "trade_done":
      case "trade_fail":
      case "trade_declined":
      case "trade_cancelled": {
        this.tradeOffers.delete(msg.id as string);
        const ev: TradeEvent = { t: msg.t, id: msg.id as string, reason: msg.reason as string | undefined };
        if (msg.t === "trade_done") {
          // 15c (трек Б): условия нужны обеим сторонам для переноса товаров и зеркальных кредитов
          ev.from = msg.from as string;
          ev.to = msg.to as string;
          ev.giveCredits = (msg.giveCredits as number) || 0;
          ev.wantCredits = (msg.wantCredits as number) || 0;
          ev.giveGoods = (msg.giveGoods as Record<string, number>) || {};
          ev.wantGoods = (msg.wantGoods as Record<string, number>) || {};
        }
        this.tradeEvents.push(ev);
        if (this.tradeEvents.length > 50) this.tradeEvents.shift();
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
