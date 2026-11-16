/**
 * uiBridge.ts — one-way snapshot bridge from the imperative game loop to the React HUD.
 * The game pushes immutable snapshots (throttled); React reads them with useSyncExternalStore.
 * React calls back into the game exclusively through `gameApi` (set by boot).
 */

import type { GameState } from "./state";

export interface HudData {
  credits: number;
  /** Player's share of the galaxy's fixed credit mass (0..1); VICTORY_SHARE = win line. */
  share: number;
  hull: number; maxHull: number;
  shield: number; maxShield: number;
  cargoUsed: number; cargoMax: number;
  speed: number;
  kills: number;
  outlaw: boolean;
  /** Faction standings for the always-on HUD reputation chips. */
  rep: { patrol: number; trader: number };
  /** Patrol shoots on sight (outlaw flag or vendetta standing). */
  wanted: boolean;
  /** Atonement pirate-kills counted toward lifting an active wanted flag. */
  pardons: number;
  /** Current star system. */
  systemName: string;
  /** Dockable body currently in docking range (name), else null. */
  dockName: string | null;
  /** Hyperspace gate in jump range (destination name), else null. */
  gateName: string | null;
  /** Boss fight in progress. */
  bossActive: boolean;
  bossHp: number; bossMaxHp: number;
  /** Active contract / intercepted raid status line, null = nothing on the wire. */
  contractLine: string | null;
  /** Current system is under pirate occupation (black market, no patrols). */
  occupied: boolean;
  /** Active waypoint label + straight-line distance, null = no route plotted. */
  waypointName: string | null;
  waypointDist: number;
}

/** Star chart payload: the galaxy graph + the schematic of every system. */
export interface MapSnapshot {
  systems: {
    id: string; name: string; profile: string; desc: string; priceLevel: number;
    occupied: boolean; flagship: boolean; current: boolean;
  }[];
  currentId: string;
  /** Static body/gate layout per system (seeded, identical to the live world at t=0). */
  layouts: {
    id: string;
    bodies: { id: string; x: number; y: number; r: number; c: string; label: string; station: boolean }[];
    gates: { x: number; y: number; to: string; name: string }[];
  }[];
  /** Live contacts in the current system, normalized −1..1. */
  ships: { x: number; y: number; c: string }[];
  player: { x: number; y: number; a: number };
  objective: { x: number; y: number; c: string } | null;
  waypoint: { x: number; y: number; label: string } | null;
  /** Occupation phase for the info panel. */
  occ: { systemId: string; held: boolean; flagshipBuilt: boolean; timer: number } | null;
}

export interface StationSnapshot {
  id: string;
  name: string;
  kindName: string;
  /** Economic profile of the whole system, shown under the station header. */
  systemProfile: string;
  /** true = black market terminal in an occupied system. */
  occupied: boolean;
  eventGood: string | null;
  prices: Record<string, { buy: number; sell: number }>;
  cargo: Record<string, number>;
  cargoUsed: number;
  cargoMax: number;
  credits: number;
  hull: number; maxHull: number;
  repairCost: number;
  /** Faction standings −100..100 for the reputation panel. */
  reputation: { patrol: number; trader: number };
  /** Patrol tribunal tariff to clear charges (see REP.FINE). */
  fineCost: number;
  wanted: boolean;
  /** Outlaw flag specifically (wanted may also come from vendetta standing). */
  outlaw: boolean;
  pardons: number;
  /** Shown above the trade table when standing bends prices. */
  priceNote: string | null;
  /** Broker offers — empty while a contract is active or board is restocking. */
  contracts: { id: number; kind: string; title: string; desc: string; reward: number; timeLimit: number }[];
  /** Currently accepted contract (also visible here while docked). */
  active: { kind: string; title: string; desc: string; reward: number; done: number; need: number; timeLeft: number } | null;
  upgrades: {
    id: string; name: string; desc: string;
    level: number; maxLevel: number;
    nextCost: number | null;
    canAfford: boolean;
    nextValue: number | null;
  }[];
}

export interface EndStats {
  victory: boolean;
  reason: string;
  credits: number;
  kills: number;
  earned: number;
  traded: number;
  playTime: number;
}

export interface Snapshot {
  screen: GameState;
  hasSave: boolean;
  muted: boolean;
  hud: HudData | null;
  station: StationSnapshot | null;
  end: EndStats | null;
  /** Bumped on every hull hit — drives the red flash animation. */
  damageFlash: number;
  news: string | null;
  /** Star chart overlay (M) — the game keeps running behind it. */
  mapOpen: boolean;
  map: MapSnapshot | null;
}

const INITIAL: Snapshot = {
  screen: "title",
  hasSave: false,
  muted: false,
  hud: null,
  station: null,
  end: null,
  damageFlash: 0,
  news: null,
  mapOpen: false,
  map: null,
};

/** Commands from React UI into the game. Populated by boot.ts once the game exists. */
export interface GameApi {
  newGame(): void;
  continueGame(): void;
  resume(): void;
  pause(): void;
  toTitle(): void;
  saveNow(): void;
  toggleMute(): void;
  dock(): void;
  undock(): void;
  /** Jump through the gate currently in range. */
  jump(): void;
  setTouchFiring(v: boolean): void;
  buy(goodId: string, qty: number): void;
  sell(goodId: string, qty: number): void;
  upgrade(id: string): void;
  repair(): void;
  /** Victory screen → back into the sandbox. */
  continuePlaying(): void;
  /** Take a broker offer while docked (only one active contract). */
  acceptContract(id: number): void;
  /** Abandon the active contract, no standing penalty. */
  cancelContract(): void;
  /** Pay the patrol tribunal: clears the wanted flag, restores patrol standing. */
  payFine(): void;
  /** Minimap blips: x/y normalized to [-1,1], color css, size px, o=1 → objective diamond, w=1 → waypoint ring. */
  getMinimap(): { x: number; y: number; c: string; s: number; o?: 1; w?: 1 }[];
  getPlayerHeading(): { x: number; y: number; a: number };
  /** Star chart toggle (M key / HUD button). */
  toggleMap(): void;
  closeMap(): void;
  /** Plot a course to a dockable or gate of the current system. */
  setWaypoint(kind: "dockable" | "gate", id: string): void;
  /** Clear the active waypoint. */
  clearWaypoint(): void;
}

export const gameApi: { current: GameApi | null } = { current: null };

class UiBridge {
  private snap: Snapshot = INITIAL;
  private listeners = new Set<() => void>();

  getSnapshot = (): Snapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.snap = INITIAL;
    for (const fn of this.listeners) fn();
  }
}

export const uiBridge = new UiBridge();
