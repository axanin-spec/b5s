/**
 * config.ts — global tuning for «Космический Рейнджер».
 * Input sensitivity and invert switches live here (sync verify-game.mjs when changing the mapping).
 */

export const INPUT_CONFIG = {
  /** Mouse/touch camera sensitivity (radians/pixel). */
  MOUSE_SENS_X: 0.0026,
  MOUSE_SENS_Y: 0.0022,
  /** Camera invert switches: default false = mouse right turns camera right, mouse up looks up (intuitive directions). */
  INVERT_X: false,
  INVERT_Y: false,
} as const;

export const QUALITY = {
  /** Degradation tier for insufficient performance: cut particles and effects instead of dropping frames. */
  PARTICLES_HIGH: 600,
  PARTICLES_LOW: 220,
  /** Auto-degrade when the frame rate stays below this for 2s. */
  DEGRADE_FPS: 45,
  /** Two consecutive windows below this → also drop nebulas/dust layers (tier 2), not just supersample. */
  HEAVY_FPS: 32,
  /** Windows at/above this fps let quality climb back (8 windows ≈ 16s). */
  RECOVER_FPS: 55,
} as const;

export const COLORS = {
  background: 0x04060d,
} as const;

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export const WORLD_CFG = {
  /** Half-size of the square playable area (world units). */
  HALF: 11500,
  STAR_RADIUS: 780,
  STAR_HEAT_RADIUS: 1350,
  STAR_HEAT_DPS: 34,
  /** Orbit radius, body radius, angular velocity (rad/s) per planet. */
  PLANETS: [
    { orbit: 2750, radius: 330, w: 0.010 },
    { orbit: 4200, radius: 290, w: 0.008 },
    { orbit: 5700, radius: 380, w: 0.006 },
    { orbit: 7300, radius: 310, w: 0.005 },
    { orbit: 8900, radius: 360, w: 0.004 },
  ],
  /** Stations get their own orbits between the planets. */
  STATION_ORBITS: [3500, 5000, 6550, 8150],
  STATION_RADIUS: 150,
  /** Docking: must be inside this distance to the body edge and slower than DOCK_MAX_SPEED. */
  DOCK_MARGIN: 420,
  DOCK_MAX_SPEED: 260,
} as const;

/* ------------------------------------------------------------------ */
/* Player & ships                                                      */
/* ------------------------------------------------------------------ */

export const PLAYER_CFG = {
  RADIUS: 30,
  START_CREDITS: 2600,
  BASE_ACCEL: 340,
  BASE_MAX_SPEED: 430,
  TURN_LERP: 11, // heading smoothing rate
} as const;

export const FACTION_CFG = {
  pirate: { radius: 30, hp: 55, shield: 20, accel: 300, maxSpeed: 390, dmg: 7, fireRate: 1.1, aggro: 2600, bounty: [220, 520] },
  patrol: { radius: 32, hp: 90, shield: 45, accel: 320, maxSpeed: 410, dmg: 9, fireRate: 1.4, aggro: 3200, bounty: [0, 0] },
  trader: { radius: 34, hp: 70, shield: 25, accel: 220, maxSpeed: 300, dmg: 0, fireRate: 0, aggro: 0, bounty: [300, 800] },
  boss:   { radius: 95, hp: 1600, shield: 700, accel: 190, maxSpeed: 250, dmg: 16, fireRate: 0.9, aggro: 99999, bounty: [25000, 25000] },
} as const;

/** Target populations kept alive by the spawner. */
export const POPULATION = {
  PIRATES: 9,
  PATROLS: 6,
  TRADERS: 5,
  SPAWN_PERIOD: 3.2,
} as const;

/* ------------------------------------------------------------------ */
/* Pirate occupation (Этап 2.5: динамический фронт)                    */
/* ------------------------------------------------------------------ */

export const OCCUPATION = {
  /** System the clans hold at game start. */
  START_SYSTEM: "nix",
  /** Seconds between liberation and the clans seizing another random system. */
  REOCCUPY_DELAY: 150,
  /** Seconds the new flagship spends on the slipway before it becomes operational. */
  FLAGSHIP_BUILD: 75,
  /** Extra pirate population held in the occupied system (no patrols there). */
  PIRATE_EXTRA: 7,
  /** Escort screen spawned around the resident flagship. */
  ESCORTS: 4,
  /** Black market: smugglers sell cheap and pay fat for stolen goods. */
  BLACK: { buy: 0.9, sell: 1.12 },
  /** Flat patrol bounty paid on liberation. */
  LIBERATION_REWARD: 4000,
  /** Standing gain shared by patrol + Alliance when a system is freed. */
  REP_LIBERATE: { patrol: 10, trader: 10 },
  /** Flagships destroyed to break the pirate threat (economic victory still stands). */
  FLAGSHIPS_TO_WIN: 3,
} as const;

export const BOLT_CFG = {
  SPEED: 1050,
  LIFE: 1.15,
  RADIUS: 14,
} as const;

/* ------------------------------------------------------------------ */
/* Closed money circulation (Этап 5a)                                  */
/* ------------------------------------------------------------------ */

/**
 * The galaxy holds a FIXED mass of credits split into pools; every credit the
 * player earns comes out of a pool and every credit spent flows back in:
 * Σ pools + player.credits = MONEY_TOTAL (checked by __econAudit() + balance autotest).
 *  • patrol   — treasury: pays bounties/liberation, receives fines;
 *  • alliance — fund: pays contract/convoy rewards (and the trader fleet in 5b);
 *  • clan     — pirate war-chest: loot drops pay out of it; sunk ships drain it (5c);
 *  • stations — civilian working capital: buys cargo, sells upgrades/repairs.
 */
export const POOLS = {
  patrol: 500_000,
  alliance: 650_000,
  clan: 350_000,
  stations: 1_000_000,
} as const;

/** Total credits in the galaxy — constant for the whole run (pools + player start). */
export const MONEY_TOTAL = POOLS.patrol + POOLS.alliance + POOLS.clan + POOLS.stations + PLAYER_CFG.START_CREDITS;

/** Economic victory: own this share of the galaxy's credits (market-share progress bar in the HUD). */
export const VICTORY_SHARE = 0.25;

/* ------------------------------------------------------------------ */
/* Economy                                                             */
/* ------------------------------------------------------------------ */

export interface GoodDef { id: string; name: string; base: number }

export const GOODS: readonly GoodDef[] = [
  { id: "food", name: "Провиант", base: 45 },
  { id: "ore", name: "Руда", base: 85 },
  { id: "meds", name: "Медикаменты", base: 160 },
  { id: "tech", name: "Техника", base: 270 },
  { id: "lux", name: "Роскошь", base: 430 },
  { id: "arms", name: "Оружие", base: 620 },
] as const;

export type StationKind = "agri" | "mine" | "industry" | "science" | "hub";

export const STATION_KIND_NAMES: Record<StationKind, string> = {
  agri: "Аграрный мир",
  mine: "Шахтёрский мир",
  industry: "Промышленный центр",
  science: "Научная колония",
  hub: "Торговая станция",
};

/** Price multiplier per good: <1 produces the good (cheap to buy), >1 consumes it (pays well). */
export const KIND_MODS: Record<StationKind, Record<string, number>> = {
  agri:     { food: 0.5, ore: 1.25, meds: 1.15, tech: 1.35, lux: 1.2, arms: 1.1 },
  mine:     { food: 1.25, ore: 0.5, meds: 1.2, tech: 1.3, lux: 1.1, arms: 1.0 },
  industry: { food: 1.15, ore: 1.35, meds: 1.0, tech: 0.6, lux: 1.1, arms: 0.8 },
  science:  { food: 1.1, ore: 1.1, meds: 0.55, tech: 1.2, lux: 1.3, arms: 1.25 },
  hub:      { food: 0.95, ore: 0.95, meds: 0.95, tech: 0.95, lux: 0.7, arms: 0.9 },
};

export const ECONOMY = {
  /** Player sells at price * SELL_FACTOR. */
  SELL_FACTOR: 0.82,
  /** Random-walk tick (seconds of game time). */
  TICK: 18,
  FLUCT_STEP: 0.09,
  FLUCT_MIN: 0.7,
  FLUCT_MAX: 1.45,
  /** Chance per tick that a demand event starts somewhere. */
  EVENT_CHANCE: 0.35,
  EVENT_MULT: 1.9,
  EVENT_DURATION: 55,
} as const;

/* ------------------------------------------------------------------ */
/* Reputation                                                          */
/* ------------------------------------------------------------------ */

export const REP = {
  MIN: -100, MAX: 100,
  /** At/below this the patrol faction shoots on sight (even without the outlaw flag). */
  HOSTILE_PATROL: -35,
  /** Friendly price bracket: Alliance traders give discounts. */
  FRIENDLY: 35,
  /** Unfriendly bracket: they overcharge and underpay. */
  UNFRIENDLY: -35,
  /** {buy, sell} price multipliers for the friendly/unfriendly brackets. */
  PRICE_FRIENDLY: { buy: 0.93, sell: 1.06 },
  PRICE_UNFRIENDLY: { buy: 1.12, sell: 0.9 },
  /** Standing changes for player kills. */
  KILL: {
    pirate: { patrol: 2, trader: 1 },
    trader: { patrol: -6, trader: -12 },
    patrol: { patrol: -30, trader: -2 },
  },
  /** Standing labels indexed by bracket: ≤-60, ≤-20, <20, <60, ≥60. */
  LABELS: ["ВРАЖДА", "НАПРЯЖЁННЫЕ", "НЕЙТРАЛИТЕТ", "ДРУЖЕЛЮБИЕ", "СОЮЗ"] as const,
  /** Pirate kills counted as atonement while hunted — this many ends the hunt (flag and vendetta). */
  PARDON_KILLS: 6,
  /** Patrol tribunal: fine = BASE + PER_POINT·(points below 0) + OUTLAW_FEE while wanted.
   *  Ends the hunt outright: lifts the outlaw flag and lifts patrol back above HOSTILE_PATROL. */
  FINE: { BASE: 600, PER_POINT: 40, OUTLAW_FEE: 900, GAIN: 15, TRADER_GAIN: 3 },
} as const;

export function repLabel(v: number): string {
  return v <= -60 ? REP.LABELS[0] : v <= -20 ? REP.LABELS[1] : v < 20 ? REP.LABELS[2] : v < 60 ? REP.LABELS[3] : REP.LABELS[4];
}

/* ------------------------------------------------------------------ */
/* Contracts (контракты у станций)                                     */
/* ------------------------------------------------------------------ */

export const CONTRACTS = {
  /** Seconds to complete hunt/transport; escort uses its own spawn arrival. */
  TIME_HUNT: 300,
  TIME_TRANSPORT: 300,
  TIME_ESCORT: 240,
  /** Standing gained on completion per contract kind. */
  REP: {
    hunt: { patrol: 8, trader: 3 },
    transport: { patrol: 2, trader: 8 },
    escort: { patrol: 4, trader: 6 },
  },
  /** Reward jitter: base ± this fraction. */
  JITTER: 0.15,
  CALLSIGNS: ["Гермес", "Кестрел", "Альциона", "Вега-Экспресс", "Новая Заря", "Икар"] as const,
} as const;

/* ------------------------------------------------------------------ */
/* Convoy raid news events (перехватываемые события)                   */
/* ------------------------------------------------------------------ */

export const CONVOY = {
  /** Delay before the first raid after entering a system, then re-roll window. */
  FIRST_DELAY: 75,
  PERIOD_MIN: 80, PERIOD_MAX: 150,
  /** Seconds the raid lasts if nobody intervenes. */
  WINDOW: 70,
  RAIDERS: 3,
  /** Raider kills required to save the convoy. */
  NEED: 2,
  REWARD: 850,
  REP: { patrol: 5, trader: 9 },
} as const;

/* ------------------------------------------------------------------ */
/* Upgrades (Верфь): 5 lines × 5 levels, index 0 = stock              */
/* ------------------------------------------------------------------ */

export interface UpgradeLine {
  id: string;
  name: string;
  desc: string;
  /** Per-level value (meaning depends on the line) and purchase cost to reach that level. */
  levels: readonly { v: number; cost: number }[];
}

export const UPGRADE_DEFS: readonly UpgradeLine[] = [
  {
    id: "engine", name: "Двигатель", desc: "Скорость и ускорение",
    levels: [{ v: 1, cost: 0 }, { v: 1.18, cost: 4200 }, { v: 1.38, cost: 9500 }, { v: 1.62, cost: 21000 }, { v: 1.92, cost: 45000 }],
  },
  {
    id: "hull", name: "Корпус", desc: "Прочность корпуса",
    levels: [{ v: 100, cost: 0 }, { v: 150, cost: 5000 }, { v: 210, cost: 12000 }, { v: 290, cost: 26000 }, { v: 400, cost: 56000 }],
  },
  {
    id: "shield", name: "Щиты", desc: "Ёмкость и регенерация",
    levels: [{ v: 60, cost: 0 }, { v: 100, cost: 4600 }, { v: 150, cost: 11000 }, { v: 220, cost: 24000 }, { v: 320, cost: 50000 }],
  },
  {
    id: "weapon", name: "Оружие", desc: "Урон и залп",
    levels: [{ v: 10, cost: 0 }, { v: 16, cost: 5200 }, { v: 24, cost: 12500 }, { v: 34, cost: 28000 }, { v: 48, cost: 60000 }],
  },
  {
    id: "cargo", name: "Трюм", desc: "Вместимость груза",
    levels: [{ v: 24, cost: 0 }, { v: 40, cost: 3200 }, { v: 64, cost: 7500 }, { v: 96, cost: 16000 }, { v: 140, cost: 34000 }],
  },
] as const;

/** Shield regen per second by shield level. */
export const SHIELD_REGEN = [6, 9, 13, 18, 26] as const;
/** Projectiles per volley by weapon level. */
export const WEAPON_SHOTS = [1, 1, 2, 2, 3] as const;
/** Volleys per second by weapon level. */
export const WEAPON_RATE = [3.2, 3.6, 3.8, 4.2, 4.4] as const;

export const REPAIR_COST_PER_HP = 6;

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

export const SAVE_KEY = "savegame";
// v6: closed money pools (pools + player = MONEY_TOTAL); older saves are rejected
export const SAVE_VERSION = 6;
export const AUTOSAVE_INTERVAL = 30;

/* ------------------------------------------------------------------ */
/* Star systems + hyperspace gates                                     */
/* ------------------------------------------------------------------ */

export interface SystemDef {
  id: string;
  name: string;
  seed: number;
  desc: string;
  /** Multiplies initial price fluctuations: >1 = дорогая система (продавать выгодно). */
  priceLevel: number;
  /** Extra pirates kept alive by the spawner. */
  pirateBoost: number;
  /** Human-readable economic specialization shown on the map and in the terminal. */
  profileName: string;
  /**
   * System-level price multipliers per good, applied on top of station KIND_MODS:
   * <1 the system produces it (cheap to source), >1 it consumes (pays well).
   * Kept gentle (0.6…1.3) so station specialization stays the dominant signal.
   */
  profileMods: Record<string, number>;
}

export const SYSTEMS: readonly SystemDef[] = [
  {
    id: "eidolon", name: "Эйдолон", seed: 0xE1D011, desc: "Домашняя система: сбалансированный рынок",
    priceLevel: 1.0, pirateBoost: 0,
    profileName: "Торговый перекрёсток",
    profileMods: { food: 1, ore: 1, meds: 1.02, tech: 0.98, lux: 0.94, arms: 1 },
  },
  {
    id: "kronos", name: "Кронос", seed: 0x3A7702, desc: "Промышленный пояс: платят щедро, пиратов больше",
    priceLevel: 1.14, pirateBoost: 3,
    profileName: "Промышленный пояс",
    profileMods: { food: 1.18, ore: 0.9, meds: 1.12, tech: 0.78, lux: 1.05, arms: 0.82 },
  },
  {
    id: "nix", name: "Никс", seed: 0x9C4103, desc: "Фронтир: дешёвые товары, густые пираты",
    priceLevel: 0.9, pirateBoost: 6,
    profileName: "Аграрный фронтир",
    profileMods: { food: 0.62, ore: 1.15, meds: 1.2, tech: 1.25, lux: 0.9, arms: 1.08 },
  },
] as const;

export const GATE_CFG = {
  /** Distance of a gate from the star (world units). */
  DIST: 10200,
  RADIUS: 190,
  /** Jump prompt range from the gate edge. */
  MARGIN: 420,
  MAX_SPEED: 300,
  /** Seconds of invulnerability right after a jump. */
  JUMP_GRACE: 2.5,
} as const;
