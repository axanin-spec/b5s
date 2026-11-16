/**
 * types.ts — entity shapes, world model and the save-game schema.
 * Entities live in fixed-size pools with `active` flags: zero allocation in the hot loop.
 */

export type Faction = "player" | "pirate" | "patrol" | "trader" | "boss";

export type StationKind = import("./config").StationKind;

/* ------------------------------------------------------------------ */
/* Ships                                                               */
/* ------------------------------------------------------------------ */

export enum AiState {
  Wander = 0,
  Chase = 1,
  Flee = 2,
  Route = 3,
}

export interface Ship {
  active: boolean;
  faction: Faction;
  x: number; y: number;
  vx: number; vy: number;
  /** Heading angle, world space (rad, 0 = +x, CCW). */
  angle: number;
  hp: number; maxHp: number;
  shield: number; maxShield: number;
  accel: number; maxSpeed: number;
  radius: number;
  dmg: number; fireRate: number; fireCooldown: number;
  /** Seconds since the last hit — shields regen only after a quiet period. */
  sinceHit: number;
  ai: AiState;
  /** Chase target — index into the ship pool, -1 = none. */
  targetIdx: number;
  /** Waypoint for wander/route. */
  tx: number; ty: number;
  wanderT: number;
  /** Trader route: dockable indices. */
  routeFrom: number; routeTo: number;
  /** Escort contract this ship is protecting (contract id, -1 = none). */
  escortId: number;
  /** Convoy-raid event this ship belongs to (event id, -1 = none). */
  raidId: number;
  /** Escort/flee bookkeeping. */
  thinkT: number;
  trailT: number;
  /** Renderer handle (owned by entities.ts). */
  sprite: unknown;
}

/* ------------------------------------------------------------------ */
/* Projectiles / pickups / particles                                   */
/* ------------------------------------------------------------------ */

export interface Bolt {
  active: boolean;
  /** Rendering pool: player bolts are cyan, all NPC bolts are orange. */
  friendly: boolean;
  /** Faction of the shooter — drives hit resolution. */
  from: Faction;
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  dmg: number;
}

export interface Pickup {
  active: boolean;
  kind: "credits" | "cargo";
  goodId: string;
  amount: number;
  x: number; y: number;
  vx: number; vy: number;
  life: number;
}

/* ------------------------------------------------------------------ */
/* Dockable bodies (planets + stations)                                */
/* ------------------------------------------------------------------ */

export interface Dockable {
  id: string;
  name: string;
  kind: StationKind;
  isStation: boolean;
  orbit: number;
  angle: number;
  angVel: number;
  x: number; y: number;
  radius: number;
  /** System-level specialization multipliers per good id (shared across the system). */
  sysMods: Record<string, number>;
  /** Current price per good id. */
  market: Record<string, number>;
  /** Random-walk multiplier per good id. */
  fluct: Record<string, number>;
  /** Active demand event: good id + remaining seconds, null = none. */
  eventGood: string | null;
  eventT: number;
}

/* ------------------------------------------------------------------ */
/* Player progression                                                  */
/* ------------------------------------------------------------------ */

export type UpgradeId = "engine" | "hull" | "shield" | "weapon" | "cargo";

export type UpgradeLevels = Record<UpgradeId, number>; // 0..4

/** Faction standings, −100..100. Pirates keep no score — they shoot anyway. */
export type RepState = { patrol: number; trader: number };

/* ------------------------------------------------------------------ */
/* Contracts (station quests)                                          */
/* ------------------------------------------------------------------ */

export type ContractKind = "hunt" | "transport" | "escort";

/** What the station broker offers; one contract may be active at a time. */
export interface ContractOffer {
  id: number;
  kind: ContractKind;
  title: string;
  desc: string;
  reward: number;
  timeLimit: number;
  /** hunt: kills needed; transport/escort: 1. */
  need: number;
  /** transport: contract cargo (virtual — does not use cargo space). */
  goodId: string;
  qty: number;
  /** transport/escort: destination dockable id + display name. */
  destId: string;
  destName: string;
}

/** Accepted contract; escort additionally binds a spawned trader pool index. */
export interface ActiveContract extends ContractOffer {
  timeLeft: number;
  done: number;
  /** Ship-pool index of the escorted trader, -1 when lost / not applicable. */
  escortIdx: number;
}

export interface PlayerState {
  credits: number;
  cargo: Record<string, number>;
  upgrades: UpgradeLevels;
  /** Wanted flag: set by attacking patrols/civilians; cleared by atonement kills or a fine. */
  outlaw: boolean;
  /** Pirate kills counted toward the pardon quota while wanted (REP.PARDON_KILLS). */
  pardons: number;
  /** Faction standings — gate patrol aggression and Alliance prices. */
  rep: RepState;
  kills: number;
  earned: number;
  traded: number;
  playTime: number;
  /** Pirate flagships destroyed — FLAGSHIPS_TO_WIN breaks the occupation threat. */
  bossKills: number;
  victoryShown: boolean;
}

/* ------------------------------------------------------------------ */
/* Pirate occupation                                                   */
/* ------------------------------------------------------------------ */

/**
 * The dynamic pirate front: the clans hold exactly one system at a time (extra
 * pirates, no patrols, black market, resident flagship). Killing the flagship
 * frees the system; after a pause the clans seize another random one.
 */
export interface OccupationState {
  /** System currently held (or, while `held` is false, the last one lost). */
  systemId: string;
  /** true = system under the clans; false = liberated, reoccupation timer running. */
  held: boolean;
  /** Active countdown: flagship build (held) or reoccupation delay (liberated). */
  t: number;
  /** Resident flagship off the slipway — spawns on arrival (or now, if the player is there). */
  flagshipBuilt: boolean;
}

/* ------------------------------------------------------------------ */
/* Save game                                                           */
/* ------------------------------------------------------------------ */

export interface SaveGame {
  v: number;
  seed: number;
  system: string;
  player: {
    x: number; y: number;
    credits: number;
    hull: number; shield: number;
    cargo: Record<string, number>;
    upgrades: UpgradeLevels;
    outlaw: boolean;
    pardons: number;
    rep: RepState;
  };
  /**
   * Accepted hunt/transport contract to restore after reload (their progress is
   * world-position based). Escort contracts die with the session: the escorted
   * ship is not persisted, so a save stores null for them.
   */
  contract: {
    id: number; kind: ContractKind; title: string; desc: string;
    reward: number; timeLeft: number; need: number; done: number;
    goodId: string; qty: number; destId: string; destName: string;
  } | null;
  /** Price fluctuation multipliers per dockable id. */
  fluct: Record<string, Record<string, number>>;
  stats: { kills: number; earned: number; traded: number; playTime: number };
  /** The dynamic pirate front — see OccupationState. */
  occupation: { systemId: string; held: boolean; t: number; flagshipBuilt: boolean };
  bossKills: number;
  victoryShown: boolean;
  savedAt: number;
}
