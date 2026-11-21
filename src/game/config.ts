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
  // patrol bounty (5f): a shot-down cruiser spills its own treasury — wanted captains loot the pursuers
  patrol: { radius: 32, hp: 90, shield: 45, accel: 320, maxSpeed: 410, dmg: 9, fireRate: 1.4, aggro: 3200, bounty: [180, 460] },
  trader: { radius: 34, hp: 70, shield: 25, accel: 220, maxSpeed: 300, dmg: 0, fireRate: 0, aggro: 0, bounty: [300, 800] },
  boss:   { radius: 95, hp: 1600, shield: 700, accel: 190, maxSpeed: 250, dmg: 16, fireRate: 0.9, aggro: 99999, bounty: [25000, 25000] },
} as const;

/** Target populations kept alive by the spawner. */
export const POPULATION = {
  /** Full pirate strength while the clan fund is rich (≥ PIRATE_ECON.FUND_FULL). */
  PIRATES: 9,
  /** Thinned flotilla once the clan fund runs thin (≤ PIRATE_ECON.FUND_THIN). */
  PIRATES_MIN: 6,
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
  /** Standing shift when a system is freed: the law cheers, the clans lose turf. */
  REP_LIBERATE: { patrol: 10, trader: 10, clan: -10 },
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
/* Pirate clan economy (Этап 5c: каждый потопленный корпус бьёт по фонду) */
/* ------------------------------------------------------------------ */

export const PIRATE_ECON = {
  /** Sunk hulls write off from the clan fund to the civilian yards (clan → stations). */
  HULL_COST: { pirate: 2600, boss: 60_000 },
  /** Debt ceiling: the clans cannot owe more than their own starting treasury. */
  DEBT_LIMIT: POOLS.clan,
  /** Fund at/above this (credits) keeps full pirate numbers (POPULATION.PIRATES). */
  FUND_FULL: 250_000,
  /** Fund at/below this thins the flotilla to POPULATION.PIRATES_MIN. */
  FUND_THIN: 60_000,
  /** Protection tax per second from the occupied system's economy (stations → clan).
   *  26→40 (Этап 13a): темп восстановления кланов приближен к темпу потерь —
   *  2400 ₡/мин против 2600 ₡ списания корпуса; активная ферма по-прежнему
   *  подавляет кланы (дизайн 5c), но без перманентного банкротства. */
  TAX_PER_SEC: 40,
  /** A convoy lost to raiders: the clans take this from the Alliance fund (alliance → clan). */
  RAID_PLUNDER: 1_200,
} as const;

/* ------------------------------------------------------------------ */
/* Patrol economy (Этап 11b): сила закона по казне                     */
/* ------------------------------------------------------------------ */

/**
 * Symmetry with the clans (PIRATE_ECON): pirate numbers scale with the clan fund,
 * now the constabulary scales with its treasury. A fat treasury fields a heavy
 * cruiser on top of the watch; a bled one (raids drain it, bounties deflate it)
 * leaves the system on a skeleton watch — piracy has a visible price.
 */
export const PATROL_ECON = {
  /** Treasury at/above this: the heavy cruiser «Варта» is on station (over the cap). */
  TREASURY_FULL: 450_000,
  /** Below this: thinned watch. */
  TREASURY_THIN: 100_000,
  THIN_PATROLS: 4,
  /** Heavy cruiser stats — between a patrol cutter and the clan flagship. */
  CRUISER: { hp: 450, shield: 220, accel: 260, maxSpeed: 300, dmg: 12, fireRate: 1.2, radius: 48, bounty: [2500, 4000] as const },
} as const;

/* ------------------------------------------------------------------ */
/* Raid operation (Этап 5d: налёт — операция с карты)                   */
/* ------------------------------------------------------------------ */

/**
 * The player turns pirate: pick a free system on the galaxy map and run an
 * operation — an open window to empty station storehouses (hover the dock,
 * slow) while patrol escorts hunt and every terminal in the system is on
 * embargo. Each take drains three treasuries at once: the station strongbox
 * (stations), the customs payroll (patrol) and caravan funds (alliance) —
 * scaled by the target's market wealth and clamped to what each actually
 * holds, so a galaxy the player has already bled pays ever less (auto-brake).
 */
export const RAID = {
  /** Operation window from launch (seconds) — about three minutes of mayhem. */
  WINDOW: 180,
  /** Operation-desk cooldown before the next raid can be launched (seconds). */
  COOLDOWN: 240,
  /** Seconds of hovering the dock to empty one storehouse. */
  GRAB_TIME: 6,
  /** Take per storehouse per pool: fraction of the pool, × priceLevel of the target. */
  LOOT: { stations: 0.013, patrol: 0.009, alliance: 0.0046 },
  /** Floors so even a bled-dry galaxy pays a little for the risk. */
  LOOT_MIN: { stations: 700, patrol: 350, alliance: 250 },
  /** Standing cost of hitting a civilian system; the first take also brands the player outlaw.
   *  10b: разбой должен стоить репутации — окно налёта с 3–4 складами уводит Патруль за черту
   *  вражды (−35), а Альянс — к порогу недолюбливания: рынки закрываются по-настоящему. */
  REP_HIT: { patrol: -26, trader: -20 },
  /** Patrol escorts thrown up around every station of the target while the window is open. */
  GUARDS_PER_STATION: 2,
  /** Each take sags every market price in the system by this fluct push (embargo bites prices). */
  EMBARGO_PUSH: 0.12,
} as const;

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
  // 14g: товарная тройка кланов — в GOODS на общих правах, но торгуется только
  // на чёрном рынке (см. CLAN_ONLY_GOODS): наркотики печатают химзаводы и фарма,
  // табак и специя — грядка агров и оранжереи научных колоний
  { id: "tobacco", name: "Табак", base: 110 },
  { id: "spice", name: "Специя", base: 170 },
  { id: "drugs", name: "Наркотики", base: 240 },
] as const;

/**
 * 14g: контрабанда кланов — товар, которым союзные доки не торгуют вообще
 * (ни покупают, ни продают): только чёрный рынок (оккупация и Логово).
 * «Оружие» остаётся законным экспорт Альянса, но с 14d патрульный досмотр
 * считает его уликой — поэтому CONTRABAND_GOODS шире, чем CLAN_ONLY_GOODS.
 */
export const CLAN_ONLY_GOODS: readonly string[] = ["tobacco", "spice", "drugs"];

/** 14d: что ищет патрульный досмотр (оружие + наркотическая тройка). */
export const CONTRABAND_GOODS: readonly string[] = ["arms", "tobacco", "spice", "drugs"];

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
  // 14g: tobacco/spice/drugs — профиль «где растёт и где потребляют»; торгуют ими
  // только клановые причалы, но профиль нужен и для цен Логова/оккупации
  agri:     { food: 0.5, ore: 1.25, meds: 1.15, tech: 1.35, lux: 1.2, arms: 1.1, tobacco: 0.55, spice: 1.1, drugs: 1.2 },
  mine:     { food: 1.25, ore: 0.5, meds: 1.2, tech: 1.3, lux: 1.1, arms: 1.0, tobacco: 1.15, spice: 1.25, drugs: 1.3 },
  industry: { food: 1.15, ore: 1.35, meds: 1.0, tech: 0.6, lux: 1.1, arms: 0.8, tobacco: 1.2, spice: 1.3, drugs: 0.7 },
  science:  { food: 1.1, ore: 1.1, meds: 0.55, tech: 1.2, lux: 1.3, arms: 1.25, tobacco: 1.1, spice: 0.6, drugs: 0.75 },
  hub:      { food: 0.95, ore: 0.95, meds: 0.95, tech: 0.95, lux: 0.7, arms: 0.9, tobacco: 0.9, spice: 0.9, drugs: 0.85 },
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
  /** Per-tick pull of each market's fluct toward its system anchor (priceLevel).
   *  Half-life ≈ 23 ticks (~7 min): caravans, raids and luck bend prices,
   *  but a system's wealth profile always reasserts itself. */
  ANCHOR_PULL: 0.03,
  /** Price push per unit from the player's own dock trades — half the caravan
   *  strength (TRADER_AI.FLUCT_PUSH): one captain moves a market less than a
   *  supply chain, but a battleship hold dumped at once is felt. */
  PLAYER_FLUCT_PUSH: 0.002,
  /** Патрульный тариф (Этап 13a): доля гражданского оборота, уходящая в казну
   *  патруля с каждой сделки на союзных доках (товары, верфь, лавка, ремонт,
   *  караваны — в обе стороны). Платит станция из своей маржи: цены для игрока
   *  не меняются. Чёрный рынок не облагается — там касса и есть клановая
   *  (их «десятина» — вся маржа). Радио-сделки внебиржевые (10c) — тоже мимо. */
  TARIFF: 0.02,
} as const;

/* ------------------------------------------------------------------ */
/* Trader AI (Этап 5b): living caravans + space radio deals            */
/* ------------------------------------------------------------------ */

export const TRADER_AI = {
  /** Cargo capacity per trader ship (units). */
  HOLD: 24,
  /** Working capital range granted from the Alliance fund at spawn (₡). */
  CASH: [6000, 14000] as const,
  /** Radio deals: the trader sells above and buys below its last market price.
   *  10c (решение 2026-11-20): сознательная фича контрабандистов — караван торгует по ценам
   *  своего домашнего рынка, поэтому арбитраж «купить дёшево здесь, продать дорого каравану
   *  с дорогим рынком» не вставая с точки даёт живую маржу; потолок — кошелёк каравана
   *  (CASH) и его трюм (HOLD). Не фиксим: радио-бары — жанровое ядро. */
  RADIO_SELL: 1.18,
  RADIO_BUY: 0.68,
  /** Radio offer appears within this distance of the player (world units). */
  RADIO_RANGE: 1500,
  /** Per-unit price push from trader volume at a dock (pulls markets to equilibrium). */
  FLUCT_PUSH: 0.004,
} as const;

/* ------------------------------------------------------------------ */
/* Clan haulers (Этап 8): серый трафик «база ⇄ оккупированная система» */
/* ------------------------------------------------------------------ */

export const SMUGGLER = {
  /** Haulers kept on route while the player is in Terminus or the occupied system. */
  COUNT: 2,
  /** Working capital drawn from the CLAN fund at spawn (returned on despawn). */
  CASH: [5000, 9000] as const,
  CALLSIGNS: ["Крыса", "Тень", "Мул", "Кобра", "Глухарь"] as const,
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
  /** Standing changes for player kills (clan axis — Этап 6: crews are kin, patrols are prey). */
  KILL: {
    pirate: { patrol: 2, trader: 1, clan: -6 },
    trader: { patrol: -6, trader: -12, clan: 1 },
    patrol: { patrol: -30, trader: -2, clan: 5 },
  },
  /** Standing labels indexed by bracket: ≤-60, ≤-20, <20, <60, ≥60. */
  LABELS: ["ВРАЖДА", "НАПРЯЖЁННЫЕ", "НЕЙТРАЛИТЕТ", "ДРУЖЕЛЮБИЕ", "СОЮЗ"] as const,
  /** Pirate kills counted as atonement while hunted — this many ends the hunt (flag and vendetta). */
  PARDON_KILLS: 6,
  /** Patrol tribunal: fine = BASE + PER_POINT·(points below 0) + OUTLAW_FEE while wanted.
   *  Ends the hunt outright: lifts the outlaw flag and lifts patrol back above HOSTILE_PATROL. */
  FINE: { BASE: 600, PER_POINT: 40, OUTLAW_FEE: 900, GAIN: 15, TRADER_GAIN: 3, CLAN_GAIN: -4 },
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
/* Пиратская ветка (Этап 6): клановая репутация, «свой» скид, база     */
/* ------------------------------------------------------------------ */

export const PIRATE_BRANCH = {
  /** Репутация за каждый опустошенный склад налёта: кланам приятно топить Альянс (10b:
   *  каждый захват одновременно жрёт закон — разграбленный склад помнят и патруль, и брокеры). */
  REP_RAID_GRAB: { clan: 4, patrol: -6, trader: -5 },
  /** «Свой» на чёрном рынке: clan ≥ FRIENDLY покупает дешевле и продаёт жирнее;
   *  ≤ UNFRIENDLY — с чужака не гонят товар, но и любви нет. */
  BLACK_FRIEND: { buy: 0.82, sell: 1.2 },
  BLACK_COLD: { buy: 0.97, sell: 1.02 },
  /** Клановая доска заданий в оккупированной системе и на базе. Ключи — kind'и
   *  контрактов: hunt (разборки), bounty (головы патруля), transport (смуггл-рейс). */
  CONTRACT_REP: {
    hunt: { clan: 8, patrol: -4, trader: -2 },
    bounty: { clan: 10, patrol: -10 },
    transport: { clan: 9, trader: -3 },
  },
  /** Провал клановой работы — кланы запоминают. */
  CONTRACT_FAIL_REP: { clan: -5 },
  /** База контрабандистов в руинах Терминуса; стоит в этой системе на дальней орбите. */
  LAIR_SYSTEM: "terminus",
  LAIR: {
    id: "lair",
    name: "База «Расколотый кокон»",
    /** Ремонт в норах дешевле: ни доков, ни реестра. */
    REPAIR_FACTOR: 0.6,
  },
} as const;

/* ------------------------------------------------------------------ */
/* Флот (Этап 7): корпуса + снаряжение рангов C–SSS                    */
/* ------------------------------------------------------------------ */

export type HullId = "fighter" | "corvette" | "frigate" | "battleship";

/** Насколько крупный док держит корпус или линию снаряжения на стенде. */
export type YardTier = "any" | "core" | "flag";

export interface HullDef {
  id: HullId;
  name: string;
  desc: string;
  /** Цена на верфи (₡); при обмене старый корпус идёт в зачёт по HULL_SELL. */
  price: number;
  radius: number;
  /** Прочность корпуса. */
  hp: number;
  /** Бронеплиты: базовая ёмкость щита до модулей. */
  shieldPlate: number;
  accel: number;
  maxSpeed: number;
  cargo: number;
  slots: { weapon: number; shield: number; engine: number };
  yard: YardTier;
  /** Дежурный двигатель в комплекте корпуса. */
  defaultEngine: string;
}

export const HULLS: readonly HullDef[] = [
  {
    id: "fighter", name: "Истребитель «Рейнджер»", desc: "Быстрый, юркий, держит один модуль на категорию",
    price: 5_000, radius: 30, hp: 120, shieldPlate: 0, accel: 360, maxSpeed: 470, cargo: 24,
    slots: { weapon: 1, shield: 1, engine: 1 }, yard: "any", defaultEngine: "spark-C",
  },
  {
    id: "corvette", name: "Корвет «Ястреб»", desc: "Рабочая лошадка: два орудия, приличный трюм",
    price: 42_000, radius: 34, hp: 300, shieldPlate: 40, accel: 330, maxSpeed: 430, cargo: 48,
    slots: { weapon: 2, shield: 1, engine: 1 }, yard: "any", defaultEngine: "spark-C",
  },
  {
    id: "frigate", name: "Фрегат «Борей»", desc: "Линкор для бедных: двойные щиты, большой трюм",
    price: 150_000, radius: 40, hp: 620, shieldPlate: 90, accel: 300, maxSpeed: 390, cargo: 90,
    slots: { weapon: 2, shield: 2, engine: 1 }, yard: "core", defaultEngine: "turbine-C",
  },
  {
    id: "battleship", name: "Линкор «Суверен»", desc: "Мобильная крепость: три орудия, трюм грузовоза",
    price: 380_000, radius: 48, hp: 1100, shieldPlate: 150, accel: 250, maxSpeed: 330, cargo: 130,
    slots: { weapon: 3, shield: 2, engine: 1 }, yard: "flag", defaultEngine: "reactor-C",
  },
];

/** Возврат верфи при сдаче корпуса; модули продаёт склад по EQUIP_SELL. */
export const HULL_SELL = 0.6;
export const EQUIP_SELL = 0.55;

/** Короткие имена корпусов для строк совместимости модулей: «Рейнджер» · «Ястреб» (Этап 13). */
export function hullFitLabel(ships: readonly HullId[]): string {
  return ships.map((id) => HULLS.find((h) => h.id === id)?.name.replace(/^[^«]*«/, "«") ?? id).join(" · ");
}

export const RANKS = ["C", "B", "A", "S", "SS", "SSS"] as const;
export type Rank = (typeof RANKS)[number];

export type EquipCat = "weapon" | "shield" | "engine";

/** Множитель цены ранга от базовой стоимости линии.
 *  Верх кривой откалиброван под закрытую массу денег (2.5 млн): полный SSS-фит
 *  линкора ≈ 980k ₡ (~39% массы) — достижимая цель эндгейма, а не 78% как при ×100. */
const RANK_COST = [1, 3.2, 7.5, 15, 30, 50] as const;

const WEAPON_RANKS = [
  { dmg: 10, shots: 1, rate: 3.4 },
  { dmg: 15, shots: 1, rate: 3.6 },
  { dmg: 22, shots: 2, rate: 3.8 },
  { dmg: 31, shots: 2, rate: 4.0 },
  { dmg: 42, shots: 3, rate: 4.3 },
  { dmg: 56, shots: 3, rate: 4.6 },
] as const;

const SHIELD_RANKS = [
  { cap: 60, regen: 6 },
  { cap: 110, regen: 9 },
  { cap: 180, regen: 13 },
  { cap: 280, regen: 18 },
  { cap: 420, regen: 24 },
  { cap: 600, regen: 32 },
] as const;

/** Множитель скорости ранга; линия гасит бонус (тяжёлым машинам нужен тяжёлый реактор). */
const ENGINE_RANKS = [1, 1.18, 1.38, 1.62, 1.9, 2.2] as const;

export interface EquipLine {
  id: string;
  name: string;
  cat: EquipCat;
  /** Типы корпусов, на которые встаёт модуль этой линии. */
  ships: readonly HullId[];
  /** Оружие/щиты: множитель статов ранга. Двигатели: доля рангового бонуса скорости. */
  mult: number;
  /** Цена ранга C; дальше × RANK_COST. */
  cost: number;
  yard: YardTier;
  desc: string;
}

export const EQUIP_LINES: readonly EquipLine[] = [
  { id: "needle", name: "Игла", cat: "weapon", ships: ["fighter", "corvette"], mult: 0.85, cost: 1_300, yard: "any", desc: "лёгкий эмиттер" },
  { id: "wasp", name: "Шершень", cat: "weapon", ships: ["corvette", "frigate"], mult: 1, cost: 1_800, yard: "core", desc: "импульсная пушка" },
  { id: "hammer", name: "Молот", cat: "weapon", ships: ["frigate", "battleship"], mult: 1.3, cost: 2_600, yard: "core", desc: "масс-драйвер" },
  { id: "lance", name: "Сингулярность", cat: "weapon", ships: ["battleship"], mult: 1.7, cost: 4_200, yard: "flag", desc: "гравитационная пика" },
  { id: "turtle", name: "Черепаха", cat: "shield", ships: ["fighter", "corvette"], mult: 0.85, cost: 1_100, yard: "any", desc: "дефлектор" },
  { id: "bastion", name: "Бастион", cat: "shield", ships: ["corvette", "frigate"], mult: 1, cost: 1_600, yard: "core", desc: "щитовик" },
  { id: "citadel", name: "Цитадель", cat: "shield", ships: ["frigate", "battleship"], mult: 1.25, cost: 2_400, yard: "flag", desc: "полевой щит" },
  { id: "spark", name: "Искра", cat: "engine", ships: ["fighter", "corvette"], mult: 1.05, cost: 900, yard: "any", desc: "химфортунка" },
  { id: "turbine", name: "Турбина", cat: "engine", ships: ["corvette", "frigate"], mult: 1, cost: 1_400, yard: "core", desc: "плазменная турбина" },
  { id: "reactor", name: "Реактор", cat: "engine", ships: ["frigate", "battleship"], mult: 0.92, cost: 2_200, yard: "core", desc: "термоядро" },
];

export interface EquipItem {
  /** "needle-C" — id линии + ранг. */
  id: string;
  line: string;
  name: string;
  cat: EquipCat;
  rank: Rank;
  rankIdx: number;
  ships: readonly HullId[];
  yard: YardTier;
  cost: number;
  // weapon
  dmg: number;
  shots: number;
  rate: number;
  // shield
  cap: number;
  regen: number;
  // engine
  mult: number;
  /** Строка статов для карточек верфи. */
  desc: string;
}

function buildEquip(): Record<string, EquipItem> {
  const out: Record<string, EquipItem> = {};
  for (const line of EQUIP_LINES) {
    RANKS.forEach((rank, i) => {
      const item: EquipItem = {
        id: `${line.id}-${rank}`, line: line.id, name: `${line.name} «${rank}»`, cat: line.cat,
        rank, rankIdx: i, ships: line.ships, yard: line.yard,
        cost: Math.round(line.cost * RANK_COST[i]),
        dmg: Math.round(WEAPON_RANKS[i].dmg * line.mult),
        shots: WEAPON_RANKS[i].shots,
        rate: WEAPON_RANKS[i].rate,
        cap: Math.round(SHIELD_RANKS[i].cap * line.mult),
        regen: Math.round(SHIELD_RANKS[i].regen * line.mult),
        mult: Number((1 + (ENGINE_RANKS[i] - 1) * line.mult).toFixed(2)),
        desc: "",
      };
      item.desc = line.cat === "weapon"
        ? `урон ${item.dmg}×${item.shots}, темп ${item.rate}/с`
        : line.cat === "shield"
          ? `ёмкость +${item.cap}, реген +${item.regen}/с`
          : `скорость ×${item.mult.toFixed(2)}`;
      out[item.id] = item;
    });
  }
  return out;
}

/** Весь рынок снаряжения: 10 линий × 6 рангов, сгенерирован из таблиц. */
export const EQUIP: Record<string, EquipItem> = buildEquip();

/** Стартовый комплект «Рейнджера» (включён в цену корпуса). */
export const STARTER_KIT: Record<EquipCat, (string | null)[]> = {
  weapon: ["needle-C"], shield: ["turtle-C"], engine: ["spark-C"],
};

/** Залп без орудий: аварийный импульс форсунок. */
export const EMERGENCY_PULSE = { dmg: 6, shots: 1, rate: 2.4 } as const;

export const REPAIR_COST_PER_HP = 6;

/* ------------------------------------------------------------------ */
/* Трофейные модули (Этап 11a): комплектующие с боевых кораблей         */
/* ------------------------------------------------------------------ */

/**
 * Разграбленный корпус иногда роняет модуль в поддоне (→ склад игрока).
 * Капы рангов — страж экономики Этапа 7: SSS остаётся эксклюзивом чёрного рынка
 * и не выпадает НИКОГДА; пираты летают на хламе (C/B), экран флагмана несёт
 * настоящее железо (до S). Ожидаемый выход ~120 ₡-экв с пирата — меньше
 * денежного баунти (220–520), верфь не обесценивается.
 */
export const MODULE_LOOT = {
  /** Drop chance per destroyed hull (the flagship's pod is guaranteed). */
  CHANCE: { pirate: 0.09, raider: 0.35, screen: 0.5, boss: 1 },
  /** Rank cap as RANKS index: B=1, A=2, S=3, SS=4. SSS (5) never drops. */
  RANK_CAP: { pirate: 1, raider: 2, screen: 3, boss: 4 },
  /** Конвертация, когда склад полон (64): поддон продаётся по EQUIP_SELL из кассы станций. */
  STASH_MAX: 64,
} as const;

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

export const SAVE_KEY = "savegame";
// v6: closed money pools (pools + player = MONEY_TOTAL); older saves are rejected
/**
 * v9 (Этап 10a): market intel — last-seen dock prices. Unlike v7→v8, v8 saves are
 * still accepted: they simply load with an empty intel log (save.ts backfills it).
 */
export const SAVE_VERSION = 9;
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
  /** Extra patrol hulls on station (Aurora's beefed-up constabulary, negative for clan turf). */
  patrolBoost?: number;
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
  {
    id: "terminus", name: "Терминус", seed: 0x7E8014, desc: "Руины верфей: дешёвый хабарь, среди обломков прячутся пираты",
    priceLevel: 0.82, pirateBoost: 4,
    profileName: "Руины-хабарь",
    profileMods: { food: 1.28, ore: 0.78, meds: 1.12, tech: 0.68, lux: 0.95, arms: 1.05 },
  },
  {
    id: "aurora", name: "Аврора", seed: 0xA00A01, desc: "Финансовое ядро: богатый рынок, сильный патруль, мало пиратов",
    priceLevel: 1.25, pirateBoost: -2, patrolBoost: 3,
    profileName: "Финансовое ядро",
    profileMods: { food: 1.22, ore: 1.24, meds: 0.85, tech: 0.88, lux: 1.25, arms: 1.15 },
  },
  {
    id: "kar", name: "Каркинос", seed: 0xCA4C15, desc: "Крепость кланов: дешёвые оружие и трофеи, любимая вотчина пиратов",
    priceLevel: 1.18, pirateBoost: 5, patrolBoost: -1,
    profileName: "Крепость кланов",
    profileMods: { food: 1.1, ore: 1.05, meds: 1.18, tech: 1.0, lux: 1.22, arms: 0.72 },
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
