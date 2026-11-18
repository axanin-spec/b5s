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
  /** Trader: callsign for the radio panel ("Гера"). */
  name: string;
  /** Trader: working capital — money is counted outside pools while in its pocket (Этап 5b). */
  wallet: number;
  /** Trader: arbitrage cargo, good id → units (capacity TRADER_AI.HOLD). */
  cargo: Record<string, number>;
  /** Escort contract this ship is protecting (contract id, -1 = none). */
  escortId: number;
  /** Convoy-raid event this ship belongs to (event id, -1 = none). */
  raidId: number;
  /** Patrol escort raised by the player's raid operation (Этап 5d) — stands down when it ends. */
  raidGuard: boolean;
  /** Escort/flee bookkeeping. */
  thinkT: number;
  /** Scheduled interval of the current think cycle — think() receives the real elapsed time. */
  thinkDt: number;
  trailT: number;
  /** Pirate disengagement timer (AI polish): >0 = pulled out of the fight to let shields regen. */
  regroupT: number;
  /** A raider's get-out-of-a-fight pass is one-shot; caught broken again, it leaves the system. */
  regroupUsed: boolean;
  /** Renderer handle (owned by entities.ts). */
  sprite: unknown;
}

/* ------------------------------------------------------------------ */
/* Money pools (closed circulation, Этап 5a)                           */
/* ------------------------------------------------------------------ */

/** Which treasury a credit flow runs through — see POOLS in config. */
export type PoolId = keyof typeof import("./config").POOLS;

/** Current funds per pool; Σ pools + player.credits stays equal to MONEY_TOTAL. */
export type MoneyPools = Record<PoolId, number>;

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
  /** Credit drops are paid out of this pool when collected (cargo pods: unused). */
  src: PoolId;
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
  /** Mean-reversion anchor for fluct: the system's priceLevel — keeps rich/poor
   *  systems distinct instead of letting the random walk wash the premium out. */
  anchor: number;
  /** Active demand event: good id + remaining seconds, null = none. */
  eventGood: string | null;
  eventT: number;
}

/* ------------------------------------------------------------------ */
/* Player progression                                                  */
/* ------------------------------------------------------------------ */

export type HullId = import("./config").HullId;

export type EquipCat = import("./config").EquipCat;

/**
 * Установленные модули (Этап 7): массив по числу слотов текущего корпуса,
 * null = слот пуст. Склад (`stash`) — id модулей, снятых или купленных впрок.
 */
export type InstalledGear = Record<EquipCat, (string | null)[]>;

/**
 * Faction standings, −100..100. The clan axis (Этап 6) is the pirate branch:
 * black-market brackets, clan contracts and the smuggler base read it.
 */
export type RepState = { patrol: number; trader: number; clan: number };

/* ------------------------------------------------------------------ */
/* Contracts (station quests)                                          */
/* ------------------------------------------------------------------ */

/** bounty (Этап 6b) is a clan-board hit on patrols — the clan's own kind of hunt. */
export type ContractKind = "hunt" | "transport" | "escort" | "bounty";

/** What the station broker offers; one contract may be active at a time. */
export interface ContractOffer {
  id: number;
  kind: ContractKind;
  /** Whose treasury pays and whose standings move: Alliance broker or clan board (6b). */
  funder: "alliance" | "clan";
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
  /** Тип текущего корпуса (Этап 7): трюм, слоты и габариты — от него. */
  ship: HullId;
  installed: InstalledGear;
  /** Склад модулей: id из EQUIP. */
  stash: string[];
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
/* Raid operation (Этап 5d: налёт с карты)                             */
/* ------------------------------------------------------------------ */

/**
 * The player's own raid on a free system, launched from the galaxy map: an
 * operation window during which station storehouses can be emptied at speed
 * (trade embargo in effect), patrol escorts hunt, and the operation desk
 * cools down afterwards.
 */
export interface RaidOp {
  /** System chosen as the operation target. */
  targetId: string;
  /** Window remaining (seconds); ≤0 = over, cooldown running. */
  timeLeft: number;
  /** Seconds until the map offers the operation button again. */
  cooldown: number;
  /** Storehouse dockable ids already emptied during this operation. */
  grabbed: string[];
  /** Credits taken so far this operation (news line). */
  taken: number;
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
    /** v8: корпус + модули вместо линии улучшений 0–4. */
    ship: HullId;
    installed: InstalledGear;
    stash: string[];
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
    /** optional: v7 saves written before 6b default to the Alliance board. */
    funder?: "alliance" | "clan";
  } | null;
  /** Price fluctuation multipliers per dockable id. */
  fluct: Record<string, Record<string, number>>;
  stats: { kills: number; earned: number; traded: number; playTime: number };
  /** The dynamic pirate front — see OccupationState. */
  occupation: { systemId: string; held: boolean; t: number; flagshipBuilt: boolean };
  /** v6: funds of every money pool — with player.credits they must sum to MONEY_TOTAL. */
  pools: MoneyPools;
  /** v6 (5d extension, optional): raid operation on the ops desk, null/absent = none. */
  raid?: { targetId: string; timeLeft: number; cooldown: number; grabbed: string[]; taken: number } | null;
  bossKills: number;
  victoryShown: boolean;
  savedAt: number;
}
