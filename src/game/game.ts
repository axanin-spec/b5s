/**
 * game.ts — «Космический Рейнджер»: top-down 2D space sim on a Canvas 2D renderer.
 * World: one star system, 5 planets + 4 stations on live orbits, parallax starfields/nebulas.
 * Systems: trading (living market), combat (pirates/patrols/traders/boss), fleet (hulls + gear), saves.
 * All textures are procedural canvases (textures.ts); all entities live in fixed pools.
 */

import {
  BOLT_CFG, CONTRACTS, CONVOY, ECONOMY, EMERGENCY_PULSE, EQUIP, EQUIP_LINES, EQUIP_SELL, FACTION_CFG, GATE_CFG, GOODS, HULLS, HULL_SELL, MODULE_LOOT, OCCUPATION, PATROL_ECON, PIRATE_BRANCH, PIRATE_ECON, PLAYER_CFG, POPULATION, QUALITY, RANKS, RAID,
  MONEY_TOTAL, POOLS, REPAIR_COST_PER_HP, REP, SAVE_VERSION, AUTOSAVE_INTERVAL, SMUGGLER, STARTER_KIT, SYSTEMS, TRADER_AI,
  VICTORY_SHARE, WORLD_CFG,
} from "./config";
import type { EquipCat, EquipItem, HullDef, HullId, YardTier } from "./config";
import { AudioSystem } from "./audio";
import * as econ from "./economy";
import * as fleet from "./fleet";
import * as missions from "./missions";
import { GameLoop } from "./engine";
import { Input } from "./input";
import { perf } from "./perf";
import { GameStateMachine } from "./state";
import {
  makeCargoTexture, makeCreditTexture, makeGateFrameTexture, makeGateHorizonTexture, makeGlowTexture, makeNebulaTexture,
  makePlanetTexture, makeShipTexture, makeStarTexture, makeStationTexture,
  mulberry32,
} from "./textures";
import type { SystemDef } from "./config";
import { loadImage, loadPlanetTexture } from "./assets";
import { economyTick, findDockTarget, generateWorld, goodName, kindName, priceOf, refreshAllPrices, updateOrbits } from "./world";
import { loadSave, writeSave } from "./save";
import { gameApi, uiBridge, type EndStats, type GameApi, type HudData, type MapSnapshot, type RadioSnapshot, type StationSnapshot } from "./uiBridge";
import type { ActiveContract, Bolt, ContractOffer, Dockable, Faction, InstalledGear, MoneyPools, OccupationState, Pickup, PlayerState, PoolId, RaidOp, SaveGame, Ship } from "./types";
import { AiState } from "./types";

const MAX_SHIPS = 40;
const MAX_BOLTS = 200;
const MAX_PICKUPS = 28;

/** Ship textures are drawn pointing up; hull visual radius ≈ texture half-height. */
const SHIP_SCALE = 2.4;

function blankShip(): Ship {
  return {
    active: false, faction: "trader",
    x: 0, y: 0, vx: 0, vy: 0, angle: 0,
    hp: 1, maxHp: 1, shield: 0, maxShield: 0,
    accel: 0, maxSpeed: 0, radius: 20,
    dmg: 0, fireRate: 0, fireCooldown: 0, sinceHit: 99,
    ai: AiState.Wander, targetIdx: -1, tx: 0, ty: 0, wanderT: 0,
    routeFrom: 0, routeTo: 0, name: "", wallet: 0, smuggler: false, cargo: {},
    escortId: -1, raidId: -1, raidGuard: false, screen: false, cruiser: false, thinkT: 0, thinkDt: 0.42, trailT: 0, regroupT: 0, regroupUsed: false, sprite: null,
  };
}

/**
 * Can a bolt fired by `from` damage `target`? Traders never shoot; player may hit anyone.
 * `outlaw` is the patrol-hostility flag: the player shot civilians or their patrol
 * standing dropped to vendetta (REP.HOSTILE_PATROL).
 * `piratePact` (5f): to a wanted captain the raiders are kin — a pirate bolt never
 * touches the player, stray or aimed. The occupation flagship keeps its guns warm.
 */
export function canHit(from: Faction, target: Faction, outlaw: boolean, piratePact = false): boolean {
  switch (from) {
    case "player": return target !== "player";
    case "pirate":
      return target === "patrol" || target === "trader" || (target === "player" && !piratePact);
    case "boss": return target === "player" || target === "patrol" || target === "trader";
    case "patrol": return target === "pirate" || target === "boss" || (target === "player" && outlaw);
    default: return false;
  }
}

/* ---------------- particles ---------------- */

/** Fixed palette so the hot loop never builds color strings. */
const PALETTE = [
  "#ffffff", "#ffe9a8", "#ffd24a", "#ff9c54", "#ff5a4a", "#ff54d2",
  "#54ffd2", "#7fd0ff", "#5a9fff", "#d26aff", "#8fd08f", "#c96a4a",
] as const;
const PALETTE_TEX: HTMLCanvasElement[] = [];

function paletteTex(): HTMLCanvasElement[] {
  if (PALETTE_TEX.length) return PALETTE_TEX;
  for (const hex of PALETTE) {
    const rgb = `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
    PALETTE_TEX.push(makeGlowTexture(rgb));
  }
  return PALETTE_TEX;
}

interface Particle {
  life: number; maxLife: number;
  x: number; y: number;
  vx: number; vy: number;
  ci: number; // palette index
  size: number;
}

interface StarDot { x: number; y: number; r: number; c: string }

interface ParallaxLayer {
  f: number;
  stars: StarDot[];
  nebulas: { tex: CanvasImageSource; x: number; y: number; scale: number; additive?: boolean }[];
}

/** How long a kill-feed line stays on the HUD, in play-seconds (game feel). */
const FEED_TTL = 12;

export class Game {
  private ctx: CanvasRenderingContext2D;
  private loop: GameLoop;
  private input: Input;
  audio = new AudioSystem(); // public: экономика (economy.ts) играет звуки сделок
  sm = new GameStateMachine(); // public: missions.ts проверяет фазу
  private disposed = false;

  /* view */
  private ppu = 1;
  private camX = 0; private camY = 0;
  private shake = 0;
  private titleOrbitT = 0;
  private layers: ParallaxLayer[] = [];

  /* world */
  private seed = 1;
  rnd = mulberry32(1); // public: missions.ts тасует доску контрактов
  dockables: Dockable[] = []; // public: economy.ts торгует с рынков доков
  private dockTex: HTMLCanvasElement[] = [];
  private starTex: HTMLCanvasElement;
  private dockSpin: number[] = [];
  /** Per-dockable spin rate; AI planets bake their terminator, so their art swap freezes it to 0. */
  private dockSpinVel: number[] = [];
  /** Guards async art swaps against a world rebuild (system jump) mid-flight. */
  private worldGen = 0;

  /* entities */
  ships: Ship[] = []; // public: economy.ts считает float кошельков
  private shipTexMap: Record<string, HTMLCanvasElement[]>;
  private bolts: Bolt[] = [];
  private boltTexPlayer: HTMLCanvasElement;
  private boltTexEnemy: HTMLCanvasElement;
  private pickups: Pickup[] = [];
  private pickupTex: { cargo: HTMLCanvasElement; credits: HTMLCanvasElement };
  private particles: Particle[] = [];
  private pCursor = 0;
  /** Expanding shockwave rings spawned by explosions (stroked additively in screen space). */
  private rings: { life: number; maxLife: number; x: number; y: number; r: number; vr: number; hot: boolean }[] = [];
  private ringCursor = 0;
  /** Rising credit popups over the world (game feel): spawned on income/spend, drawn in screen space. */
  private floaters: { x: number; y: number; t: number; ttl: number; text: string; c: string; big: boolean }[] = [];
  /** Kill/event feed lines for the HUD column (game feel); they age out with the player clock. */
  private feed: { id: number; text: string; cls: "info" | "gold" | "bad"; t: number }[] = [];
  private feedId = 1;
  /** Last announced pirate status (5f) — flips re-flag the newscast exactly once. */
  private pirateStatus = false;
  /** Hyperspace jump overlay, 0..1, decays inside updateParticles. */
  private warpFx = 0;
  /** Damaged-hull smoke timer. */
  private smokeT = 0;
  private lowParticles = false;
  private fpsAccum = 0;
  private fpsWindowStart = 0;
  /**
   * Adaptive pixel quality (Этап 4): 0 = full (2× supersample, all layers),
   * 1 = supersample off (¼ pixels), 2 = also drop nebulas + near dust. Driven by the
   * fps monitor with hysteresis; JS render is ~0.2ms, so fill-rate is the real lever.
   */
  private quality = 0;
  private badWindows = 0;
  private goodWindows = 0;

  /* player */
  player: PlayerState = Game.freshPlayerState(); // public: economy.ts платит в кредиты

  /* timers */
  private econT = ECONOMY.TICK;
  private saveT = AUTOSAVE_INTERVAL;
  private spawnT = 2;
  private hudT = 0;
  private newsT = 0;
  private alarmT = 0;
  private damageFlash = 0;

  dockTarget: Dockable | null = null; // public: economy.ts выбирает кассу сделки
  private bossIdx = -1;
  private bossEscortsSpawned = false;
  private bgGradient: CanvasGradient | null = null;
  private splashRemoved = false;

  /* star systems + gates */
  systemDef: SystemDef = SYSTEMS[0]; // public: missions.ts смотрит систему
  gates: { to: string; name: string; x: number; y: number }[] = []; // public: missions.ts
  private jumpGate: { to: string; name: string; x: number; y: number } | null = null;
  private gateTex: HTMLCanvasElement;
  /** Event horizon behind the arcs: AI vortex art once it loads, procedural glow until then. */
  private gateHorizonTex: HTMLCanvasElement | HTMLImageElement;
  private gateSpin = 0;
  private jumpGrace = 0;

  /* contracts + faction reputation + raid events */
  contract: ActiveContract | null = null; // public: missions.ts
  /** Broker offers generated on docking; empty while a contract is active. */
  offers: ContractOffer[] = []; // public: missions.ts
  contractSeq = 0; // public: missions.ts
  raidSeq = 0; // public: missions.ts
  /** Convoy-raid event currently on the news wire, null = quiet. */
  convoy: { id: number; t: number; done: number; traderIdx: number } | null = null; // public: missions.ts
  convoyT: number = CONVOY.FIRST_DELAY; // public: missions.ts

  /* raid operation (Этап 5d: налёт — операция с карты) */
  /** Active/cooled-down raid on the ops desk, null = the desk is clear. */
  raid: RaidOp | null = null; // public: missions.ts
  /** Storehouse being emptied right now (dockable id) + elapsed hover seconds. */
  grabTarget: string | null = null; // public: missions.ts
  grabT = 0; // public: missions.ts

  /* pirate occupation front + star chart */
  occ: OccupationState = { // public: missions.ts
    systemId: OCCUPATION.START_SYSTEM, held: true, t: OCCUPATION.FLAGSHIP_BUILD, flagshipBuilt: false,
  };
  /** Star chart overlay state — the simulation keeps ticking behind it. */
  mapOpen = false; // public: missions.ts дёргает pushMap
  /** Plotted course in the current system; cleared by a jump. */
  private waypoint: { x: number; y: number; label: string; targetId: string } | null = null;
  /** Static per-system schematics for the chart (seeded, computed once). */
  private layoutCache = new Map<string, Dockable[]>();
  /** Closed money circulation (Этап 5a): Σ pools + player.credits === MONEY_TOTAL at all times. */
  pools: MoneyPools = { ...POOLS }; // public: казны — ядро economy.ts

  private static freshPlayerState(): PlayerState {
    return {
      credits: PLAYER_CFG.START_CREDITS,
      cargo: {},
      // Этап 7: истребитель со стартовым комплектом — трюм и слоты теперь от корпуса
      ship: "fighter",
      installed: { weapon: [...STARTER_KIT.weapon], shield: [...STARTER_KIT.shield], engine: [...STARTER_KIT.engine] },
      stash: [],
      outlaw: false, pardons: 0, rep: { patrol: 0, trader: 0, clan: 0 },
      kills: 0, earned: 0, traded: 0, playTime: 0,
      bossKills: 0, victoryShown: false,
    };
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.onResize();

    this.input = new Input(canvas);

    this.starTex = makeStarTexture();
    this.gateTex = makeGateFrameTexture();
    this.gateHorizonTex = makeGateHorizonTexture();
    void loadImage("assets/gate/vortex.png").then((img) => {
      if (img && !this.disposed) this.gateHorizonTex = img;
    });
    this.boltTexPlayer = makeGlowTexture("102,255,224");
    this.boltTexEnemy = makeGlowTexture("255,136,84");
    this.pickupTex = { cargo: makeCargoTexture(), credits: makeCreditTexture() };
    paletteTex();

    // two visual variants per AI faction so repeated hulls don't read as clones;
    // the player slot is rebuilt from upgrade levels (rebuildPlayerTex)
    this.shipTexMap = {
      player: [makeShipTexture("player")],
      pirate: [makeShipTexture("pirate", 0), makeShipTexture("pirate", 1)],
      patrol: [makeShipTexture("patrol", 0), makeShipTexture("patrol", 1)],
      trader: [makeShipTexture("trader", 0), makeShipTexture("trader", 1)],
      boss: [makeShipTexture("boss")],
      cruiser: [makeShipTexture("cruiser")],
    };

    this.buildBackground();

    for (let i = 0; i < MAX_SHIPS; i++) this.ships.push(blankShip());
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({ active: false, friendly: true, from: "player", x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0 });
    }
    for (let i = 0; i < MAX_PICKUPS; i++) {
      this.pickups.push({ active: false, kind: "credits", src: "clan", goodId: "food", amount: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0 });
    }
    for (let i = 0; i < QUALITY.PARTICLES_HIGH; i++) {
      this.particles.push({ life: 0, maxLife: 1, x: 0, y: 0, vx: 0, vy: 0, ci: 0, size: 5 });
    }
    for (let i = 0; i < 16; i++) {
      this.rings.push({ life: 0, maxLife: 1, x: 0, y: 0, r: 0, vr: 0, hot: false });
    }

    this.enterSystem(SYSTEMS[0].id);

    this.loop = new GameLoop({
      update: (dt) => { perf.beginUpdate(); this.update(dt); perf.endUpdate(); },
      render: () => this.render(),
    });
    this.loop.start();

    // every state transition syncs the React screen automatically
    this.sm.onChange(() => this.pushStatic());

    window.addEventListener("resize", this.onResizeBound);
    this.exposeApi();
    this.pushStatic();
  }

  private onResizeBound = () => this.onResize();

  /** switch adaptive pixel quality tier (see this.quality); rebuilds the canvas backing store */
  private setQuality(q: number): void {
    this.quality = q;
    this.onResize();
  }

  /* ================================================================== */
  /* Background                                                          */
  /* ================================================================== */

  private buildBackground(): void {
    const HALF = WORLD_CFG.HALF;
    const mkLayer = (f: number, count: number, seed: number, maxR: number): ParallaxLayer => {
      const rnd = mulberry32(seed);
      const side = 2 * HALF * f + 4200;
      const stars: StarDot[] = [];
      for (let i = 0; i < count; i++) {
        const b = 0.5 + rnd() * 0.5;
        const tint = rnd();
        stars.push({
          x: (rnd() - 0.5) * side,
          y: (rnd() - 0.5) * side,
          r: 0.9 + rnd() * maxR,
          c: tint > 0.82 ? `rgba(255,244,214,${b})` : tint > 0.6 ? `rgba(190,220,255,${b})` : `rgba(225,238,255,${b})`,
        });
      }
      return { f, stars, nebulas: [] };
    };
    this.layers.push(mkLayer(0.12, 750, 101, 1.6));
    this.layers.push(mkLayer(0.4, 420, 202, 2.1));
    this.layers.push(mkLayer(0.7, 150, 707, 2.6)); // near dust for depth

    // nebula layer
    const neb: ParallaxLayer = { f: 0.3, stars: [], nebulas: [] };
    const nebRnd = mulberry32(303);
    const hues: [string, string][] = [
      ["rgba(96,60,190,1)", "rgba(40,80,200,1)"],
      ["rgba(30,140,150,1)", "rgba(60,60,180,1)"],
      ["rgba(160,50,130,1)", "rgba(50,80,190,1)"],
    ];
    const side = 2 * HALF * 0.3;
    for (let i = 0; i < 8; i++) {
      neb.nebulas.push({
        tex: makeNebulaTexture(400 + i * 17, hues[i % hues.length][0], hues[i % hues.length][1]),
        x: (nebRnd() - 0.5) * side * 1.7,
        y: (nebRnd() - 0.5) * side * 1.7,
        scale: 6000 + nebRnd() * 5000,
      });
    }
    this.layers.push(neb);

    // AI nebula clouds (painted on black) replace the first procedural blobs and render additively
    const nebArt = ["assets/nebula/neb1.png", "assets/nebula/neb2.png", "assets/nebula/neb3.png", "assets/nebula/neb4.png"];
    nebArt.forEach((url, i) => {
      const n = neb.nebulas[i];
      if (!n) return;
      void loadImage(url).then((img) => {
        if (!img || this.disposed) return;
        n.tex = img;
        n.additive = true;
      });
    });
  }

  /** Rebuild dockables + their textures for a fresh (or restored) world. */
  private newWorld(seed: number, priceLevel = 1, sysMods: Record<string, number> = {}, withLair = false): void {
    this.seed = seed >>> 0;
    this.rnd = mulberry32(this.seed ^ 0x51f7);
    this.dockables = generateWorld(this.seed, priceLevel, sysMods, withLair);
    this.dockTex = this.dockables.map((d) =>
      d.isStation ? makeStationTexture(d.kind, this.seed + d.orbit) : makePlanetTexture(d.kind, this.seed + d.orbit));
    this.dockSpin = this.dockables.map(() => this.rnd() * Math.PI * 2);
    this.dockSpinVel = this.dockables.map((d) => (d.isStation ? 0.0012 : 0.0004));
    this.loadDockArt();
  }

  /** Swap procedural planet canvases for AI art as it loads (fire-and-forget, keeps fallback on miss). */
  private loadDockArt(): void {
    const gen = ++this.worldGen;
    this.dockables.forEach((d, i) => {
      if (d.isStation) return;
      void loadPlanetTexture(d.kind).then((tex) => {
        if (!tex || gen !== this.worldGen || i >= this.dockTex.length) return;
        this.dockTex[i] = tex;
        this.dockSpinVel[i] = 0; // day/night is baked in the art — spinning it would slide the terminator
      });
    });
  }

  /**
   * Enter a star system: rebuild its world and place hyperspace gates to every other system.
   * With `arrivalFromId`, the player ship is placed beside the gate leading back, entities
   * are respawned, and a pursuing boss follows the player through.
   */
  /** True while the clans hold the system the player is standing in. */
  hereOccupied(): boolean {
    return this.occ.held && this.occ.systemId === this.systemDef.id;
  }

  systemName(id: string): string {
    return SYSTEMS.find((s) => s.id === id)?.name ?? id;
  }

  private enterSystem(systemId: string, arrivalFromId?: string): void {
    this.systemDef = SYSTEMS.find((s) => s.id === systemId) ?? SYSTEMS[0];
    this.audio.setSystem(this.systemDef.id); // crossfade to this system's theme
    // Терминус always hosts the smuggler lair (Этап 6c) — kin turf, occupation or not
    this.newWorld(
      this.systemDef.seed, this.systemDef.priceLevel, this.systemDef.profileMods,
      this.systemDef.id === PIRATE_BRANCH.LAIR_SYSTEM,
    );
    // one gate per destination, spread symmetrically, angle offset by the seed
    const others = SYSTEMS.filter((s) => s.id !== systemId);
    const base = ((this.systemDef.seed % 360) * Math.PI) / 180;
    this.gates = others.map((s, i) => {
      const a = base + (i / others.length) * Math.PI * 2;
      return { to: s.id, name: s.name, x: Math.cos(a) * GATE_CFG.DIST, y: Math.sin(a) * GATE_CFG.DIST };
    });
    this.jumpGate = null;
    if (arrivalFromId) {
      const p = this.ships[0];
      const back = this.gates.find((g) => g.to === arrivalFromId) ?? this.gates[0];
      const a = Math.atan2(-back.y, -back.x); // toward the star, into open space
      p.x = back.x + Math.cos(a) * (GATE_CFG.RADIUS + 360);
      p.y = back.y + Math.sin(a) * (GATE_CFG.RADIUS + 360);
      p.vx = 0; p.vy = 0;
      this.camX = p.x; this.camY = p.y;
      this.jumpGrace = GATE_CFG.JUMP_GRACE;
      this.clearEntities();
      this.spawnInitialPopulation();
      // the resident flagship of an occupied system takes station over the arrival
      if (this.hereOccupied() && this.occ.flagshipBuilt && this.bossIdx < 0) this.spawnBossResident();
    }
  }

  private jumpTo(systemId: string): void {
    this.audio.sfx("undock");
    // a jump abandons whatever the system had going on
    if (this.contract) this.failContract("вы покинули систему до завершения контракта");
    if (this.convoy) this.endConvoy(false, "Конвой ушёл через врата, рейдеры растворились в прыжке.");
    this.waypoint = null; // courses are plotted per system
    const from = this.systemDef.id;
    this.enterSystem(systemId, from);
    // arrival flash beside the destination gate (a departure burst would be wiped by enterSystem)
    const p = this.ships[0];
    this.explosion(p.x, p.y, 30, 500, 6);
    this.warpFx = 1; // fullscreen warp streaks fading out over the arrival
    const flag = this.hereOccupied()
      ? " ⚑ Система под пиратами: чёрный рынок, патруль не поможет."
      : "";
    this.setNews(`Гиперпрыжок завершён: система ${this.systemDef.name}. ${this.systemDef.desc}.${flag}`);
    this.audio.sfx("dock");
    this.saveNow();
    this.pushHud();
  }

  /* ================================================================== */
  /* Resize / camera                                                     */
  /* ================================================================== */

  private onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 2× supersampling up to ~2.6M css px: draw twice the resolution, let the compositor
    // downscale — texture edges and small text stay crisp (on 4K we skip to keep fill-rate sane);
    // quality tier 1+ drops it entirely when the fps monitor sees a struggling machine
    const ss = this.quality === 0 && w * h <= 2_600_000 ? 2 : 1;
    this.canvas.width = Math.round(w * dpr * ss);
    this.canvas.height = Math.round(h * dpr * ss);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr * ss, 0, 0, dpr * ss, 0, 0);
    this.ctx.imageSmoothingQuality = "high";
    // adaptive world scale: phones see a slightly wider area so the ship stays readable
    this.ppu = Math.max(0.42, Math.min(1.05, Math.min(w / 1500, h / 950) + 0.32));
  }

  /* ================================================================== */
  /* Spawning                                                            */
  /* ================================================================== */

  spawnShip(faction: Faction, x: number, y: number): number {
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (s.active) continue;
      const cfg = FACTION_CFG[faction as keyof typeof FACTION_CFG];
      Object.assign(s, blankShip());
      s.active = true;
      s.faction = faction;
      s.x = x; s.y = y;
      s.angle = this.rnd() * Math.PI * 2;
      s.hp = s.maxHp = cfg.hp;
      s.shield = s.maxShield = cfg.shield;
      s.accel = cfg.accel; s.maxSpeed = cfg.maxSpeed;
      s.radius = cfg.radius;
      s.dmg = cfg.dmg; s.fireRate = cfg.fireRate;
      s.targetIdx = -1;
      s.ai = faction === "trader" ? AiState.Route : AiState.Wander;
      s.tx = x; s.ty = y;
      if (faction === "trader") {
        // working capital is Alliance money until spent (5b): a poor Alliance sends poor ships
        s.name = CONTRACTS.CALLSIGNS[Math.floor(this.rnd() * CONTRACTS.CALLSIGNS.length)];
        s.wallet = Math.min(
          Math.round(TRADER_AI.CASH[0] + this.rnd() * (TRADER_AI.CASH[1] - TRADER_AI.CASH[0])),
          Math.max(0, Math.round(this.pools.alliance)),
        );
        this.pools.alliance -= s.wallet;
        // a starter hold so freshly launched ships have something to hawk
        for (let k = 0; k < 2; k++) {
          const g = GOODS[Math.floor(this.rnd() * GOODS.length)];
          s.cargo[g.id] = (s.cargo[g.id] ?? 0) + 3 + Math.floor(this.rnd() * 4);
        }
        this.pickTraderRoute(i);
      }
      return i;
    }
    return -1;
  }

  freeShip(i: number): void {
    const s = this.ships[i];
    if (s.active && s.faction === "trader" && s.wallet > 0) {
      // each fleet's working capital returns to ITS fund: Alliance for caravans, clans for haulers (Этап 8)
      this.pools[s.smuggler ? "clan" : "alliance"] += s.wallet;
      s.wallet = 0;
    }
    s.active = false;
    if (this.bossIdx === i) this.bossIdx = -1;
    // drop dangling target references
    for (const sh of this.ships) if (sh.active && sh.targetIdx === i) sh.targetIdx = -1;
  }

  /** Units of cargo in a trader hold. */
  private traderLoad(s: Ship): number {
    let n = 0;
    for (const g of GOODS) n += Math.round(s.cargo[g.id] ?? 0);
    return n;
  }

  /** Trader trade volume nudges the local price toward equilibrium (Этап 5b). */
  private pushFluct(d: Dockable, goodId: string, delta: number): void {
    econ.pushFluct(d, goodId, delta);
  }

  /**
   * Where to sail next (Этап 5b): with cargo — the dock where the hold sells for most;
   * empty — the dock where the biggest buy→sell spread awaits. Small jitter keeps the
   * five caravans from all chasing the same trade.
   */
  pickTraderRoute(idx: number): void {
    const s = this.ships[idx];
    const n = this.dockables.length;
    if (n === 0) return;
    const loaded = this.traderLoad(s) > 0;
    let best = -1, bestV = -Infinity;
    for (let j = 0; j < n; j++) {
      if (n > 1 && j === s.routeFrom) continue; // we are standing at routeFrom
      const d = this.dockables[j];
      // civilian caravans don't know the way to the smuggler lair — and its
      // deflated black-market prices would otherwise vacuum the whole fleet in
      if (d.id === PIRATE_BRANCH.LAIR.id) continue;
      let v: number;
      if (loaded) {
        v = 0;
        for (const g of GOODS) v += priceOf(d, g.id) * ECONOMY.SELL_FACTOR * Math.round(s.cargo[g.id] ?? 0);
      } else {
        // best spread: buy cheap here, sell dear at the far side
        v = -Infinity;
        for (const g of GOODS) {
          let far = 0;
          for (let k = 0; k < n; k++) {
            if (k === j) continue;
            const p = priceOf(this.dockables[k], g.id) * ECONOMY.SELL_FACTOR;
            if (p > far) far = p;
          }
          const spread = far - priceOf(d, g.id);
          if (spread > v) v = spread;
        }
      }
      v *= 1 + (this.rnd() - 0.5) * 0.25;
      if (v > bestV) { bestV = v; best = j; }
    }
    s.routeTo = best < 0 ? (s.routeFrom + 1) % n : best;
    const d = this.dockables[s.routeTo];
    s.tx = d.x; s.ty = d.y;
  }

  /**
   * Market call (Этап 5b): on arrival the caravan sells its hold, then buys the good
   * that promises the fattest margin elsewhere. Wallet ↔ local till; each ton traded
   * pushes the price back toward equilibrium, so the fleet self-corrects the market.
   */
  private traderTrade(idx: number): void {
    const s = this.ships[idx];
    const here = this.dockables[s.routeTo];
    if (!here) return;
    // lair dockings (legacy routes) also settle with the clan till, like player trades do
    const pool: PoolId = this.hereOccupied() || here.id === PIRATE_BRANCH.LAIR.id ? "clan" : "stations";

    // 1) sell everything the market can still pay for
    for (const g of GOODS) {
      const q = Math.round(s.cargo[g.id] ?? 0);
      if (q <= 0) continue;
      const unit = Math.max(1, Math.round(priceOf(here, g.id) * ECONOMY.SELL_FACTOR));
      const affordable = Math.floor(Math.max(0, Math.round(this.pools[pool])) / unit);
      const sold = Math.min(q, affordable);
      if (sold <= 0) continue; // empty till — carry the cargo around the block
      s.cargo[g.id] = q - sold;
      if (s.cargo[g.id] <= 0) delete s.cargo[g.id];
      const income = sold * unit;
      this.pools[pool] -= income;
      s.wallet += income;
      this.pushFluct(here, g.id, -TRADER_AI.FLUCT_PUSH * sold);
    }

    // 2) buy the best margin we can afford (leave 5% ballast)
    const room = TRADER_AI.HOLD - this.traderLoad(s);
    let budget = Math.floor(s.wallet * 0.95);
    if (room > 0 && budget > 0) {
      let bestG: string | null = null, bestMargin = 8; // ₡8/unit before a caravan lifts anchor
      for (const g of GOODS) {
        let far = 0;
        for (let k = 0; k < this.dockables.length; k++) {
          if (k === s.routeTo) continue;
          const p = priceOf(this.dockables[k], g.id) * ECONOMY.SELL_FACTOR;
          if (p > far) far = p;
        }
        const margin = far - priceOf(here, g.id);
        if (margin > bestMargin) { bestMargin = margin; bestG = g.id; }
      }
      if (bestG) {
        const unit = Math.max(1, Math.round(priceOf(here, bestG)));
        const till = Math.floor(Math.max(0, Math.round(this.pools[pool])) / unit);
        const q = Math.max(0, Math.min(room, Math.floor(budget / unit), till));
        if (q > 0) {
          s.cargo[bestG] = (s.cargo[bestG] ?? 0) + q;
          s.wallet -= q * unit;
          this.pools[pool] += q * unit;
          this.pushFluct(here, bestG, TRADER_AI.FLUCT_PUSH * q);
        }
      }
    }
    // a hauler's route is fixed (lair ⇄ occupied); thinkSmuggler sends it to the gate (Этап 8)
    if (!s.smuggler) this.pickTraderRoute(idx);
  }

  /** Closest caravan on the radio band, -1 = none in range (Этап 5b). */
  /** Ближайший караван на связи; -1 — эфир пуст (тело в economy.ts, Этап 9a). */
  private radioIdx(): number {
    if (this.sm.state !== "playing") return -1;
    return econ.radioIdx(this);
  }

  /** Radio offer: the caravan quotes against the market it last left (Этап 5b). */
  radioData(): RadioSnapshot | null {
    return econ.radioData(this);
  }

  /** Radio purchase: credits go straight into the caravan's pocket — pools untouched (5b). */
  radioBuy(shipIdx: number, goodId: string, qty: number): boolean {
    return econ.radioBuy(this, shipIdx, goodId, qty);
  }

  /** Radio sale: the caravan pays from its wallet and stows the goods in its hold (5b). */
  radioSell(shipIdx: number, goodId: string, qty: number): boolean {
    return econ.radioSell(this, shipIdx, goodId, qty);
  }

  private spawnAtEdge(faction: Faction): void {
    const p = this.ships[0];
    const HALF = WORLD_CFG.HALF;
    for (let tries = 0; tries < 8; tries++) {
      const a = this.rnd() * Math.PI * 2;
      const r = HALF * (0.75 + this.rnd() * 0.35);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (Math.hypot(x - p.x, y - p.y) > 3800) {
        this.spawnShip(faction, x, y);
        return;
      }
    }
  }

  /* ================================================================== */
  /* Clan haulers (Этап 8): grey traffic lair ⇄ occupied system          */
  /* ================================================================== */

  /** True while the smuggling route has an endpoint in the player's system:
   *  the lair in Terminus, or any black-market dock of the occupied system. */
  private smuggleHere(): boolean {
    return this.systemDef.id === PIRATE_BRANCH.LAIR_SYSTEM || this.hereOccupied();
  }

  /**
   * Clan hauler spawn (Этап 8). A trader hull with the capital rerouted: the spawn
   * drew Alliance money by default — refund it and draw the stake from the clan fund.
   */
  private spawnSmuggler(): void {
    const p = this.ships[0];
    const HALF = WORLD_CFG.HALF;
    const a = this.rnd() * Math.PI * 2;
    const r = HALF * (0.75 + this.rnd() * 0.35);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (Math.hypot(x - p.x, y - p.y) <= 3800) return; // don't surface a hauler on the player's nose
    const idx = this.spawnShip("trader", x, y);
    if (idx < 0) return;
    const s = this.ships[idx];
    this.pools.alliance += s.wallet;
    s.wallet = Math.min(
      Math.round(SMUGGLER.CASH[0] + this.rnd() * (SMUGGLER.CASH[1] - SMUGGLER.CASH[0])),
      Math.max(0, Math.round(this.pools.clan)),
    );
    this.pools.clan -= s.wallet;
    s.smuggler = true;
    s.name = SMUGGLER.CALLSIGNS[Math.floor(this.rnd() * SMUGGLER.CALLSIGNS.length)];
    this.pickSmugglerRoute(idx);
  }

  /**
   * Heavy cruiser «Варта» (Этап 11b): commissioned when the watch treasury is fat.
   * A patrol hull with the stats overriden from PATROL_ECON.CRUISER; despawns only
   * by dying — a drained treasury stops the replacement, not the ship itself.
   */
  private spawnCruiser(): void {
    if (!this.dockables.length) return;
    const d = this.dockables[Math.floor(this.rnd() * this.dockables.length)];
    const a = this.rnd() * Math.PI * 2;
    const idx = this.spawnShip("patrol", d.x + Math.cos(a) * 600, d.y + Math.sin(a) * 600);
    if (idx < 0) return;
    const s = this.ships[idx];
    const c = PATROL_ECON.CRUISER;
    s.hp = s.maxHp = c.hp;
    s.shield = s.maxShield = c.shield;
    s.accel = c.accel; s.maxSpeed = c.maxSpeed;
    s.dmg = c.dmg; s.fireRate = c.fireRate;
    s.radius = c.radius;
    s.cruiser = true;
    s.name = "Варта";
  }

  /** One leg of the grey route: the lair in Terminus, a black-market dock in occupied space. */
  private pickSmugglerRoute(idx: number): void {
    const s = this.ships[idx];
    let best = -1;
    if (this.systemDef.id === PIRATE_BRANCH.LAIR_SYSTEM) {
      best = this.dockables.findIndex((d) => d.id === PIRATE_BRANCH.LAIR.id);
    } else {
      const docks: number[] = [];
      for (let j = 0; j < this.dockables.length; j++) if (this.dockables[j].isStation) docks.push(j);
      best = docks.length ? docks[Math.floor(this.rnd() * docks.length)] : -1;
    }
    if (best < 0) { this.freeShip(idx); return; } // no endpoint here — fold the run
    s.routeTo = best;
    s.ai = AiState.Route;
    const d = this.dockables[best];
    s.tx = d.x; s.ty = d.y;
  }

  /**
   * The occupation flagship is a resident: it orbits its captured star with an
   * escort screen and comes out to meet whoever enters the system.
   */
  private spawnBossResident(): void {
    const a = this.rnd() * Math.PI * 2;
    const x = Math.cos(a) * 2400, y = Math.sin(a) * 2400;
    const idx = this.spawnShip("boss", x, y);
    if (idx < 0) return;
    this.bossIdx = idx;
    this.bossEscortsSpawned = false;
    for (let k = 0; k < OCCUPATION.ESCORTS; k++) {
      const ea = (k / OCCUPATION.ESCORTS) * Math.PI * 2;
      const ei = this.spawnShip("pirate", x + Math.cos(ea) * 420, y + Math.sin(ea) * 420);
      if (ei >= 0) this.ships[ei].screen = true; // the flagship's screen carries real gear (Этап 11a)
    }
    this.setNews(`⚑ Флагман кланов вышел навстречу над ${this.systemDef.name}!`);
    this.audio.sfx("alarm");
  }

  /* ================================================================== */
  /* Combat helpers                                                      */
  /* ================================================================== */

  private fireBolt(fromIdx: number, angle: number, dmg: number, speed: number): void {
    const s = this.ships[fromIdx];
    for (const b of this.bolts) {
      if (b.active) continue;
      b.active = true;
      b.friendly = s.faction === "player";
      b.from = s.faction;
      b.x = s.x + Math.cos(angle) * (s.radius + 16);
      b.y = s.y + Math.sin(angle) * (s.radius + 16);
      b.vx = Math.cos(angle) * speed + s.vx * 0.35;
      b.vy = Math.sin(angle) * speed + s.vy * 0.35;
      b.life = BOLT_CFG.LIFE;
      b.dmg = dmg;
      // muzzle flash puff at the barrel tip
      this.emit(b.x, b.y, Math.cos(angle) * 240, Math.sin(angle) * 240, 0.09, s.faction === "player" ? 6 : 3, 7);
      return;
    }
  }

  /** Player volley (Этап 7): every mounted gun fires its own spread; no guns → emergency pulse. */
  /** Выстрелы игрока — только для автопроб (окно __input), на геймплей не влияет. */
  private shotsFired = 0;

  private playerFire(angle: number): void {
    this.shotsFired++;
    const guns = this.guns();
    if (guns.length === 0) {
      this.fireBolt(0, angle, EMERGENCY_PULSE.dmg, BOLT_CFG.SPEED);
      this.audio.sfx("laser");
      return;
    }
    guns.forEach((gun, gi) => {
      const side = guns.length === 1 ? 0 : (gi - (guns.length - 1) / 2) * 0.05;
      for (let i = 0; i < gun.shots; i++) {
        const off = gun.shots === 1 ? 0 : (i - (gun.shots - 1) / 2) * 0.09;
        this.fireBolt(0, angle + side + off, gun.dmg, BOLT_CFG.SPEED);
      }
    });
    this.audio.sfx("laser");
  }

  private damageShip(idx: number, dmg: number, byPlayer: boolean): void {
    const s = this.ships[idx];
    if (!s.active) return;
    if (idx === 0 && this.jumpGrace > 0) return; // post-jump invulnerability
    s.sinceHit = 0;
    if (s.shield > 0) {
      const absorbed = Math.min(s.shield, dmg);
      s.shield -= absorbed;
      dmg -= absorbed;
      if (idx === 0) this.audio.sfx("hitShield");
      if (dmg <= 0) return;
    }
    s.hp -= dmg;
    if (idx === 0) {
      this.audio.sfx("hitHull");
      this.damageFlash++;
      this.shake = Math.min(28, this.shake + 9);
      uiBridge.set({ damageFlash: this.damageFlash });
    }
    if (byPlayer && (s.faction === "patrol" || s.faction === "trader") && !this.player.outlaw) {
      this.player.outlaw = true;
      this.setNews("Вы объявлены ВНЕ ЗАКОНА: патруль открывает огонь без предупреждения!");
      this.audio.sfx("alarm");
      this.syncPirateStatus(); // 5f: the clans gain a kin captain out of this
    }
    if (byPlayer && (s.faction === "pirate" || s.faction === "boss")) {
      // retaliate
      s.targetIdx = 0;
      s.ai = AiState.Chase;
    }
    if (s.hp <= 0) this.killShip(idx, byPlayer);
  }

  private killShip(idx: number, byPlayer: boolean): void {
    const s = this.ships[idx];
    if (!s.active) return;
    const big = s.faction === "boss";
    this.explosion(s.x, s.y, big ? 64 : 26, big ? 700 : 380,
      s.faction === "pirate" || s.faction === "boss" ? 4 : s.faction === "patrol" ? 8 : 7);
    this.audio.sfx(big ? "bigExplosion" : "explosion");
    if (Math.hypot(s.x - this.ships[0].x, s.y - this.ships[0].y) < 2600) {
      this.shake = Math.min(40, this.shake + (big ? 34 : 12));
    }

    if (idx === 0) {
      this.gameOver();
      return;
    }

    // loot — credits are somebody's money: clans pay for their crews, the Alliance
    // for its freight, the patrol for its hulls (closed circulation, Этап 5a)
    const cfg = FACTION_CFG[s.faction as keyof typeof FACTION_CFG];
    if (cfg && cfg.bounty[1] > 0 && s.faction !== "trader") {
      // the cruiser carries its own price on the hull (Этап 11b)
      const bountyRange = s.cruiser ? PATROL_ECON.CRUISER.bounty : cfg.bounty;
      const amount = Math.round(bountyRange[0] + this.rnd() * (bountyRange[1] - bountyRange[0]));
      // Pirate bounties come out of the patrol treasury (5c): an empty treasury makes
      // them "deflate" — gain() pays what little it has left. The flagship's ransom
      // is still clan money: the coffers of the occupation, captured with the wreck.
      // A downed patrol's bounty (5f) drains that same treasury — pursuers pay for
      // their own wreckage once a wanted captain scrapes it off the hull.
      const src: PoolId = s.faction === "boss" ? "clan" : "patrol";
      this.spawnPickup("credits", "", amount, s.x, s.y, src);
    }
    if (s.faction === "trader") {
      // the real hold spills as pods, working capital as credits (Этап 5b). freeShip has
      // already handed the wallet to the Alliance fund, so the pickup pays out of it.
      let pods = 0;
      for (const g of GOODS) {
        const q = Math.round(s.cargo[g.id] ?? 0);
        if (q <= 0 || pods >= 3) continue;
        pods++;
        this.spawnPickup("cargo", g.id, q, s.x + (this.rnd() - 0.5) * 160, s.y + (this.rnd() - 0.5) * 160);
      }
      s.cargo = {};
      // the spilled stake pays out of the fund that bankrolled it (clan for haulers, Этап 8)
      if (s.wallet > 0) this.spawnPickup("credits", "", Math.round(s.wallet), s.x, s.y, s.smuggler ? "clan" : "alliance");
    } else if (s.faction === "pirate" && this.rnd() < 0.4) {
      this.spawnPickup("cargo", GOODS[Math.floor(this.rnd() * GOODS.length)].id,
        2 + Math.floor(this.rnd() * 6), s.x + (this.rnd() - 0.5) * 160, s.y + (this.rnd() - 0.5) * 160);
    }
    // trophy module (Этап 11a): capped ranks guard the yard economy — SSS never drops
    const dropKey = s.faction === "boss" ? "boss"
      : s.faction === "pirate" ? (s.screen ? "screen" : s.raidId >= 0 ? "raider" : "pirate") : null;
    if (dropKey && this.rnd() < MODULE_LOOT.CHANCE[dropKey]) {
      const item = this.rollModuleDrop(MODULE_LOOT.RANK_CAP[dropKey], dropKey === "screen" || dropKey === "boss");
      if (item) this.spawnPickup("module", item.id, 1, s.x + (this.rnd() - 0.5) * 120, s.y + (this.rnd() - 0.5) * 120);
    }
    // Every sunken hull writes off the clan fund: the clans pay the civilian yards for
    // a replacement (5c). The fund thins — the spawner posts fewer pirates back in line.
    if (s.faction === "pirate" || s.faction === "boss") {
      const cost = s.faction === "boss" ? PIRATE_ECON.HULL_COST.boss : PIRATE_ECON.HULL_COST.pirate;
      const paid = Math.min(cost, this.pools.clan + PIRATE_ECON.DEBT_LIMIT); // debt caps at the clans' own treasury
      this.pools.clan -= paid;
      this.pools.stations += paid;
    }

    if (byPlayer) {
      this.player.kills += s.faction === "pirate" ? 1 : 0;
      // faction standings: order kept by killing pirates, chaos punished by killing civilians
      if (s.faction === "pirate") {
        // a clan-board hunt (6b) is hired work, not kin-slaying: the clan ledger stays shut
        const hiredOut = this.contract !== null && this.contract.funder === "clan" && this.contract.kind === "hunt";
        this.addRep(hiredOut ? { patrol: REP.KILL.pirate.patrol, trader: REP.KILL.pirate.trader } : REP.KILL.pirate);
        // wanted rangers buy back trust with pirate heads — the hunt ends when the quota fills
        if (this.patrolHostile()) {
          this.player.pardons += 1;
          if (this.player.pardons >= REP.PARDON_KILLS) {
            this.player.outlaw = false;
            this.player.pardons = 0;
            // the atonement program wipes the slate: vendetta is forgiven along with the flag
            if (this.player.rep.patrol <= REP.HOSTILE_PATROL) this.player.rep.patrol = REP.HOSTILE_PATROL + 1;
            this.syncPirateStatus(); // 5f: kin status lifts with the warrant
            this.setNews(`Патруль снял розыск: ${REP.PARDON_KILLS} голов пиратов зачтены как искупление`);
            this.audio.sfx("pickup");
          }
        }
      } else if (s.faction === "trader") {
        // a clan hauler is kin: the clans remember, the law quietly approves (Этап 8)
        this.addRep(s.smuggler ? { patrol: 2, clan: -6 } : REP.KILL.trader);
      }
      else if (s.faction === "patrol") this.addRep(REP.KILL.patrol);
    }
    // scripted-event bookkeeping runs regardless of who pulled the trigger
    if (this.convoy) {
      if (idx === this.convoy.traderIdx) {
        this.endConvoy(false, "Конвой разбит — рейдеры уходят с добычей.", true);
      } else if (byPlayer && s.faction === "pirate" && s.raidId === this.convoy.id) {
        this.convoy.done++;
        if (this.convoy.done >= CONVOY.NEED) this.endConvoy(true, "Рейдеры обратились в бегство, конвой спасён!");
      }
    }
    if (this.contract) {
      if (this.contract.kind === "hunt" && byPlayer && s.faction === "pirate") {
        this.contract.done++;
        if (this.contract.done >= this.contract.need) this.completeContract("все цели ликвидированы");
      } else if (this.contract.kind === "bounty" && byPlayer && s.faction === "patrol") {
        // clan bounty (6b): every patrol hull burned is a delivered head
        this.contract.done++;
        if (this.contract.done >= this.contract.need) this.completeContract("головы сданы, трибунал молчит");
      } else if (this.contract.kind === "escort" && s.escortId === this.contract.id) {
        this.failContract("сопровождаемый транспорт сбит");
      }
    }
    if (s.faction === "boss") {
      this.liberateSystem();
      this.freeShip(idx);
      return;
    }
    this.freeShip(idx);
  }

  /**
   * Flagship destroyed: the clans lose their foothold — pirates vanish from the
   * system, patrols return (via the spawner), and the reoccupation timer starts.
   * FLAGSHIPS_TO_WIN kills break the threat for good (victory).
   */
  private liberateSystem(): void {
    const freed = this.systemName(this.occ.systemId);
    this.occ.held = false;
    this.occ.t = OCCUPATION.REOCCUPY_DELAY;
    this.occ.flagshipBuilt = false;
    this.player.bossKills++;
    // the occupation fleet runs for the edge — poof
    for (let i = 1; i < MAX_SHIPS; i++) {
      const sh = this.ships[i];
      if (sh.active && sh.faction === "pirate") this.explosion(sh.x, sh.y, 12, 260, 4);
      if (sh.active && (sh.faction === "pirate" || sh.faction === "boss")) this.freeShip(i);
    }
    this.bossIdx = -1;
    // the liberation bonus is patrol money — a lean treasury pays what it can (5a)
    const bountyPaid = this.gain(OCCUPATION.LIBERATION_REWARD, "patrol");
    this.player.earned += bountyPaid;
    this.addRep(OCCUPATION.REP_LIBERATE);
    this.audio.sfx("credits");
    this.setNews(`⚑ СИСТЕМА ${freed.toUpperCase()} ОСВОБОЖДЕНА! Пираты уходят. Патруль платит ₡${bountyPaid.toLocaleString("ru-RU")}. Флагманов потоплено: ${this.player.bossKills}/${OCCUPATION.FLAGSHIPS_TO_WIN}.`);
    if (this.sm.state === "docked" && this.dockTarget) this.genOffers(this.dockTarget); // broker returns with the patrols
    this.pushHud();
    this.saveNow();
    if (this.player.bossKills >= OCCUPATION.FLAGSHIPS_TO_WIN && !this.player.victoryShown) {
      this.victory("Три флагмана кланов горят в разных системах — пиратская угроза сломлена!");
    }
  }

  /**
   * Roll a trophy module (Этап 11a): uniform rank 0..cap (SSS excluded by the cap),
   * flag-class lines (Сингулярность/Цитадель) only from the flagship's screen —
   * rank-and-file pirates fly yard-sale junk.
   */
  private rollModuleDrop(rankCap: number, allowFlag: boolean): EquipItem | null {
    const lines = EQUIP_LINES.filter((l) => allowFlag || l.yard !== "flag");
    if (!lines.length) return null;
    const line = lines[Math.floor(this.rnd() * lines.length)];
    const rankIdx = Math.floor(this.rnd() * (Math.min(rankCap, RANKS.length - 2) + 1)); // SSS stays out
    return EQUIP[`${line.id}-${RANKS[rankIdx]}`] ?? null;
  }

  private spawnPickup(kind: "credits" | "cargo" | "module", goodId: string, amount: number, x: number, y: number, src: PoolId = "clan"): void {
    for (let i = 0; i < MAX_PICKUPS; i++) {
      const p = this.pickups[i];
      if (p.active) continue;
      p.active = true;
      p.kind = kind; p.goodId = goodId; p.amount = amount; p.src = src;
      p.x = x; p.y = y;
      const a = this.rnd() * Math.PI * 2;
      p.vx = Math.cos(a) * 60; p.vy = Math.sin(a) * 60;
      p.life = 30;
      return;
    }
  }

  /* ================================================================== */
  /* Particles                                                           */
  /* ================================================================== */

  private emit(x: number, y: number, vx: number, vy: number, life: number, ci: number, size = 5): void {
    const cap = this.lowParticles ? QUALITY.PARTICLES_LOW : QUALITY.PARTICLES_HIGH;
    this.pCursor = (this.pCursor + 1) % cap;
    const d = this.particles[this.pCursor];
    d.life = life; d.maxLife = life;
    d.x = x; d.y = y;
    d.vx = vx; d.vy = vy;
    d.ci = ci; d.size = size;
  }

  private explosion(x: number, y: number, count: number, speed: number, ci: number): void {
    this.shockwave(x, y, count >= 40);
    const n = this.lowParticles ? Math.ceil(count / 2) : count;
    // white-hot core flash
    for (let i = 0; i < 7; i++) {
      const a = this.rnd() * Math.PI * 2;
      this.emit(x, y, Math.cos(a) * speed * 0.15, Math.sin(a) * speed * 0.15, 0.3 + this.rnd() * 0.2, 0, 18 + this.rnd() * 12);
    }
    for (let i = 0; i < n; i++) {
      const a = this.rnd() * Math.PI * 2;
      const v = speed * (0.25 + this.rnd() * 0.75);
      const life = 0.5 + this.rnd() * 0.9;
      const white = this.rnd() < 0.3;
      this.emit(x, y, Math.cos(a) * v, Math.sin(a) * v, life, white ? 1 : ci, 7 + this.rnd() * 10);
    }
  }

  /** Blast front ring; big=true for flagship-scale detonations (hot core + counter-ring). */
  private shockwave(x: number, y: number, big: boolean): void {
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    const r = this.rings[this.ringCursor];
    r.life = r.maxLife = big ? 0.75 : 0.4;
    r.x = x; r.y = y;
    r.r = big ? 70 : 20;
    r.vr = big ? 2400 : 1300;
    r.hot = big;
  }

  private updateParticles(dt: number): void {
    for (const d of this.particles) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      r.r += r.vr * dt;
      r.vr *= 1 - 1.6 * dt;
    }
    if (this.warpFx > 0) this.warpFx = Math.max(0, this.warpFx - dt * 1.4);
  }

  /* ================================================================== */
  /* Player progression helpers                                          */
  /* ================================================================== */

  /* ---- fleet (Этап 7): статы = корпус + установленные модули ---- */

  /* ---- Фит-статы (Этап 9a): тела живут в fleet.ts, тут — обёртки ---- */

  private hullDef(): HullDef { return fleet.hullDef(this.player); }

  private equipped(cat: EquipCat): (EquipItem | null)[] { return fleet.equipped(this.player, cat); }

  private guns(): EquipItem[] { return fleet.guns(this.player); }

  /** Лучший ранг в категории — кормит и статы, и арт корпуса. */
  private bestRank(cat: EquipCat): number { return fleet.bestRank(this.player, cat); }

  cargoMax(): number { return fleet.cargoMax(this.player); }
  private maxHull(): number { return fleet.maxHull(this.player); }
  private maxShield(): number { return fleet.maxShield(this.player); }
  /** Реген щита дают только модули: голая плита не восстанавливается. */
  private shieldRegen(): number { return fleet.shieldRegen(this.player); }
  /** Тяга: множитель установленного двигателя; без него — аварийные форсунки (×1). */
  private engMult(): number { return fleet.engMult(this.player); }
  private gunRate(): number { return fleet.gunRate(this.player); }

  cargoUsed(): number { return fleet.cargoUsed(this.player); }

  private applyPlayerStats(): void {
    const p = this.ships[0];
    const hull = this.hullDef();
    const m = this.engMult();
    p.radius = hull.radius;
    p.accel = hull.accel * m;
    p.maxSpeed = hull.maxSpeed * m;
    p.maxHp = this.maxHull();
    p.maxShield = this.maxShield();
    this.rebuildPlayerTex();
  }

  /** The silhouette is the hull class; pods/plates/emitters/nozzles follow the installed modules. */
  private rebuildPlayerTex(): void {
    const hullIdx = HULLS.findIndex((h) => h.id === this.player.ship);
    this.shipTexMap.player = [makeShipTexture("player", Math.max(0, hullIdx), {
      hull: Math.max(0, hullIdx),
      weapon: this.guns().length,
      weaponRank: this.bestRank("weapon"),
      shield: this.bestRank("shield"),
      engine: this.bestRank("engine"),
    })];
  }

  /* ================================================================== */
  /* Game flow: new / continue / save / load / game over / victory       */
  /* ================================================================== */

  private resetPlayerShip(x: number, y: number): void {
    const p = this.ships[0];
    Object.assign(p, blankShip());
    p.active = true;
    p.faction = "player";
    p.x = x; p.y = y;
    p.radius = PLAYER_CFG.RADIUS;
    this.applyPlayerStats();
    p.hp = p.maxHp;
    p.shield = p.maxShield;
  }

  private clearEntities(): void {
    for (let i = 1; i < MAX_SHIPS; i++) this.freeShip(i);
    for (const b of this.bolts) b.active = false;
    for (const p of this.pickups) p.active = false;
    this.bossIdx = -1;
    this.bossEscortsSpawned = false;
    // contracts and raids are system-scoped — a new world drops them
    this.contract = null;
    this.offers = [];
    this.convoy = null;
    this.convoyT = CONVOY.FIRST_DELAY;
    // transient feedback layers don't ride across a world rebuild either
    this.floaters = [];
    this.feed = [];
  }

  private spawnInitialPopulation(): void {
    const pirates = this.pirateStrength();
    for (let i = 0; i < pirates; i++) this.spawnAtEdge("pirate");
    // the clans have pushed the patrol out of occupied space; independent traders still run the black market
    if (!this.hereOccupied()) {
      for (let i = 0; i < POPULATION.PATROLS; i++) {
        const d = this.dockables[Math.floor(this.rnd() * this.dockables.length)];
        this.spawnShip("patrol", d.x + (this.rnd() - 0.5) * 1800, d.y + (this.rnd() - 0.5) * 1800);
      }
    }
    for (let i = 0; i < POPULATION.TRADERS; i++) {
      const di = Math.floor(this.rnd() * this.dockables.length);
      const d = this.dockables[di];
      const idx = this.spawnShip("trader", d.x + (this.rnd() - 0.5) * 900, d.y + (this.rnd() - 0.5) * 900);
      if (idx >= 0) {
        this.ships[idx].routeFrom = di;
        this.pickTraderRoute(idx);
      }
    }
    // the patrol response to the player's raid re-forms on every arrival in the target (5d)
    if (this.raid && this.raid.timeLeft > 0 && this.raid.targetId === this.systemDef.id) this.spawnRaidGuards();
  }

  newGame(): void {
    this.clearEntities();
    this.player = Game.freshPlayerState();
    this.pirateStatus = false; // 5f: a fresh name is clean paper
    this.occ = { systemId: OCCUPATION.START_SYSTEM, held: true, t: OCCUPATION.FLAGSHIP_BUILD, flagshipBuilt: false };
    this.pools = { ...POOLS };
    this.waypoint = null;
    this.raid = null;
    this.grabTarget = null; this.grabT = 0;
    this.enterSystem(SYSTEMS[0].id);
    // spawn just outside the first station, pointed into open space
    const st = this.dockables.find((d) => d.isStation)!;
    const a = st.angle;
    this.resetPlayerShip(st.x + Math.cos(a) * (st.radius + 700), st.y + Math.sin(a) * (st.radius + 700));
    this.spawnInitialPopulation();
    this.camX = this.ships[0].x; this.camY = this.ships[0].y;
    this.econT = ECONOMY.TICK;
    this.saveT = AUTOSAVE_INTERVAL;
    this.setNews("Добро пожаловать в систему Эйдолон. Торгуйте, сражайтесь, выживайте.");
    if (this.sm.state !== "playing") this.sm.transition("playing");
    this.audio.startMusic();
    this.pushStatic();
    this.pushHud();
  }

  continueGame(): void {
    const save = loadSave();
    if (!save) { this.newGame(); return; }
    this.clearEntities();
    this.player = Game.freshPlayerState();
    this.player.credits = save.player.credits;
    this.player.cargo = { ...save.player.cargo };
    this.player.ship = save.player.ship;
    this.player.installed = {
      weapon: [...save.player.installed.weapon],
      shield: [...save.player.installed.shield],
      engine: [...save.player.installed.engine],
    };
    this.player.stash = [...save.player.stash];
    this.player.outlaw = save.player.outlaw;
    this.player.pardons = save.player.pardons;
    this.player.rep = { ...save.player.rep };
    this.pirateStatus = this.patrolHostile(); // 5f: resync silently — no re-flag on load
    this.player.kills = save.stats.kills;
    this.player.earned = save.stats.earned;
    this.player.traded = save.stats.traded;
    this.player.playTime = save.stats.playTime;
    this.player.bossKills = save.bossKills;
    this.player.victoryShown = save.victoryShown;
    this.occ = {
      systemId: save.occupation.systemId, held: save.occupation.held,
      t: save.occupation.t, flagshipBuilt: save.occupation.flagshipBuilt,
    };
    this.pools = save.pools ? { ...save.pools } : { ...POOLS };
    this.waypoint = null;
    // the ops desk keeps the raid across a reload (guards re-form on arrival, see spawnInitialPopulation)
    this.raid = save.raid
      ? { targetId: save.raid.targetId, timeLeft: save.raid.timeLeft, cooldown: save.raid.cooldown, grabbed: [...save.raid.grabbed], taken: save.raid.taken }
      : null;
    this.grabTarget = null; this.grabT = 0;
    this.enterSystem(save.system);
    // restore an in-progress hunt/transport contract (escorts do not survive a reload)
    if (save.contract) {
      const sc = save.contract;
      // funder is optional in v7 saves written before 6b — the Alliance board paid those
      this.contract = { ...sc, funder: sc.funder ?? "alliance", timeLimit: sc.timeLeft, escortIdx: -1 };
    }
    // restore market fluctuations
    for (const d of this.dockables) {
      const f = save.fluct[d.id];
      if (f) for (const g of GOODS) if (typeof f[g.id] === "number") d.fluct[g.id] = f[g.id];
    }
    refreshAllPrices(this.dockables);
    this.resetPlayerShip(save.player.x, save.player.y);
    this.ships[0].hp = Math.min(save.player.hull, this.ships[0].maxHp);
    this.ships[0].shield = Math.min(save.player.shield, this.ships[0].maxShield);
    this.spawnInitialPopulation();
    // the resident of an occupied system returns to its post
    if (this.hereOccupied() && this.occ.flagshipBuilt && this.bossIdx < 0) this.spawnBossResident();
    this.camX = save.player.x; this.camY = save.player.y;
    this.setNews("Сохранение загружено. Удачи, рейнджер!");
    if (this.sm.state !== "playing") this.sm.transition("playing");
    this.audio.startMusic();
    this.pushStatic();
    this.pushHud();
  }

  saveNow(): void {
    const p = this.ships[0];
    if (!p.active) return; // never persist a destroyed ship
    const fluct: Record<string, Record<string, number>> = {};
    for (const d of this.dockables) fluct[d.id] = { ...d.fluct };
    const save: SaveGame = {
      v: SAVE_VERSION,
      seed: this.seed,
      system: this.systemDef.id,
      player: {
        x: Math.round(p.x), y: Math.round(p.y),
        credits: Math.round(this.player.credits),
        hull: Math.round(p.hp), shield: Math.round(p.shield),
        cargo: { ...this.player.cargo },
        ship: this.player.ship,
        installed: {
          weapon: [...this.player.installed.weapon],
          shield: [...this.player.installed.shield],
          engine: [...this.player.installed.engine],
        },
        stash: [...this.player.stash],
        outlaw: this.player.outlaw,
        pardons: this.player.pardons,
        rep: { ...this.player.rep },
      },
      // hunt/transport progress survives a reload; the escorted ship does not, so escorts drop out
      contract: this.contract && this.contract.kind !== "escort" ? {
        id: this.contract.id, kind: this.contract.kind, title: this.contract.title, desc: this.contract.desc,
        reward: this.contract.reward, timeLeft: Math.round(this.contract.timeLeft),
        need: this.contract.need, done: this.contract.done,
        goodId: this.contract.goodId, qty: this.contract.qty,
        destId: this.contract.destId, destName: this.contract.destName,
        funder: this.contract.funder,
      } : null,
      fluct,
      stats: {
        kills: this.player.kills, earned: Math.round(this.player.earned),
        traded: Math.round(this.player.traded), playTime: Math.round(this.player.playTime),
      },
      occupation: {
        systemId: this.occ.systemId, held: this.occ.held,
        t: Math.round(this.occ.t), flagshipBuilt: this.occ.flagshipBuilt,
      },
      // traders respawn on continue and re-draw their capital, so the saved pools must
      // already include their wallets (gross pools — Этап 5b; clan haulers gross into clan, Этап 8)
      pools: {
        ...this.pools,
        alliance: this.pools.alliance + this.traderFloat(),
        clan: this.pools.clan + this.smugglerFloat(),
      },
      raid: this.raid ? {
        targetId: this.raid.targetId, timeLeft: Math.round(this.raid.timeLeft),
        cooldown: Math.round(this.raid.cooldown), grabbed: [...this.raid.grabbed],
        taken: Math.round(this.raid.taken),
      } : null,
      bossKills: this.player.bossKills,
      victoryShown: this.player.victoryShown,
      savedAt: Date.now(),
    };
    writeSave(save);
    uiBridge.set({ hasSave: true });
  }

  /**
   * Pay the player out of a treasury (clamped to what it holds — the galaxy's money
   * is fixed, nobody prints credits). Returns the amount actually paid.
   */
  /* ---- Денежный контур (Этап 9a): тела живут в economy.ts, тут — обёртки ---- */

  private gain(n: number, pool: PoolId): number { return econ.gain(this, n, pool); }

  /** Spend player credits into a treasury — the mirror of gain(). */
  private pay(n: number, pool: PoolId): void { econ.pay(this, n, pool); }

  /** Treasury a docked trade runs through: smuggler cash on clan turf, civilian capital elsewhere. */
  private tradePool(): PoolId { return econ.tradePool(this); }

  /** Player's share of the galaxy's fixed credit mass (0..1) — the economic victory meter. */
  sharePct(): number { return econ.sharePct(this); }

  /** Alliance money on loan in caravan wallets (Этап 5b); clan haulers excluded (Этап 8). */
  private traderFloat(): number { return econ.traderFloat(this); }

  /** Clan hauler wallets in flight (Этап 8): clan money on loan, returned at freeShip. */
  private smugglerFloat(): number { return econ.smugglerFloat(this); }

  /** Debug/QA: the closed-circulation invariant. delta must stay 0 — see the balance autotest. */
  econAudit(): { total: number; player: number; pools: MoneyPools; traderFloat: number; delta: number } {
    return econ.econAudit(this);
  }

  private endStats(victory: boolean, reason: string): EndStats {
    return {
      victory, reason,
      credits: Math.round(this.player.credits),
      kills: this.player.kills,
      earned: Math.round(this.player.earned),
      traded: Math.round(this.player.traded),
      playTime: Math.round(this.player.playTime),
    };
  }

  private gameOver(): void {
    const p = this.ships[0];
    this.explosion(p.x, p.y, 60, 520, 6);
    p.active = false;
    this.audio.sfx("lose");
    this.audio.setThreat(0);
    uiBridge.set({ end: this.endStats(false, "Ваш корабль уничтожен."), station: null });
    this.sm.transition("gameover");
  }

  private victory(reason: string): void {
    if (this.sm.state !== "playing") return;
    this.player.victoryShown = true;
    this.saveNow();
    this.audio.sfx("win");
    this.audio.setThreat(0);
    uiBridge.set({ end: this.endStats(true, reason) });
    this.sm.transition("victory");
  }

  setNews(text: string): void {
    this.pushFeed(text);
    uiBridge.set({ news: text, feed: this.feedView() });
    this.newsT = 14;
  }

  /** Feed color (game feel): loot and kills gold, losses and warnings red, everything else info. */
  private feedCls(text: string): "info" | "gold" | "bad" {
    if (/☠|⚔|⚑|ПЕРЕХВАТ|опустошен|трофе/i.test(text)) return "gold";
    if (/потерян|ЗАХВАТИЛИ|провал|объявлен|эмбарго|не хватает|нечего|уничтожен/i.test(text)) return "bad";
    return "info";
  }

  private pushFeed(text: string): void {
    this.feed.push({ id: this.feedId++, text, cls: this.feedCls(text), t: this.player.playTime });
    while (this.feed.length > 6) this.feed.shift();
  }

  /** The live slice of the feed — stale lines drop off as the player clock passes FEED_TTL. */
  private feedView(): { id: number; text: string; cls: "info" | "gold" | "bad" }[] {
    const t = this.player.playTime;
    return this.feed.filter((f) => t - f.t < FEED_TTL).map(({ id, text, cls }) => ({ id, text, cls }));
  }

  /* ================================================================== */
  /* Docking / trade / upgrades                                          */
  /* ================================================================== */

  dock(): void {
    if (this.sm.state !== "playing" || !this.dockTarget) return;
    // embargo (5d): the raided system keeps its terminals shut while your window is open
    if (this.raidHot()) {
      this.audio.sfx("alarm");
      this.setNews("Эмбарго: система под вашим налётом — доки закрыты, терминалы молчат. Работайте трюмом у складов.");
      return;
    }
    // the lair (6c): unlicensed ink only docks kin and trusted friends — everyone
    // else gets a polite riddle and a closed boom
    if (this.dockTarget.id === PIRATE_BRANCH.LAIR.id) {
      if (!this.isPirate() && this.player.rep.clan < REP.FRIENDLY) {
        this.audio.sfx("alarm");
        this.setNews("«Расколотый кокон» не принимает незнакомцев: «Прилетай, когда кланы назовут тебя своим».");
        return;
      }
    } else if (this.isPirate() && !this.hereOccupied()) {
      // pirate status (5f): law-abiding worlds don't board a wanted captain; the clans'
      // black market in the occupied system is the only terminal that takes you
      this.audio.sfx("alarm");
      this.setNews("Вас не принимают: вы в розыске. Живой товар — на чёрном рынке оккупированной системы.");
      return;
    }
    this.sm.transition("docked");
    this.audio.sfx("dock");
    this.audio.setThreat(0);
    this.saveNow(); // docking autosaves
    // a courier contract pays out the moment its sealed container is handed over
    if (this.contract && this.contract.kind === "transport" && this.contract.destId === this.dockTarget.id) {
      this.completeContract("контейнер принят диспетчерской");
    }
    // fresh broker offers on every undock cycle while the board is free
    if (!this.contract) this.genOffers(this.dockTarget);
    uiBridge.set({ radio: null }); // nobody hails you through the hull
    this.pushStation();
  }

  undock(): void {
    if (this.sm.state !== "docked") return;
    this.sm.transition("playing");
    this.audio.sfx("undock");
    uiBridge.set({ station: null });
    this.pushHud();
  }

  /**
   * Live trade multipliers: reputation bracket + black-market skew when the clans
   * hold the system. Single source of truth — the terminal and the till must agree.
   * On clan turf the clan standing bends the skew too (Этап 6): «свои» buy at 0.82
   * and sell at 1.2; cold standing flattens the black-market bonus to a rounding.
   */
  private priceMods(): { buy: number; sell: number } {
    return econ.priceMods(this);
  }

  buy(goodId: string, qty: number): void {
    const d = this.dockTarget;
    if (!d || this.sm.state !== "docked") return;
    const price = Math.max(1, Math.round(priceOf(d, goodId) * this.priceMods().buy));
    const space = this.cargoMax() - this.cargoUsed();
    const n = Math.min(qty, space, Math.floor(this.player.credits / price));
    if (n <= 0) return;
    this.pay(n * price, this.tradePool());
    this.player.cargo[goodId] = (this.player.cargo[goodId] ?? 0) + n;
    this.player.traded += n * price;
    // player volume moves the local market too (half caravan strength): buying lifts the price
    this.pushFluct(d, goodId, ECONOMY.PLAYER_FLUCT_PUSH * n);
    this.audio.sfx("trade");
    this.pushStation();
    this.pushHud();
  }

  sell(goodId: string, qty: number): void {
    const d = this.dockTarget;
    if (!d || this.sm.state !== "docked") return;
    const have = this.player.cargo[goodId] ?? 0;
    let n = Math.min(qty, have);
    if (n <= 0) return;
    const unit = Math.max(1, Math.round(priceOf(d, goodId) * ECONOMY.SELL_FACTOR * this.priceMods().sell));
    // the counter pays with real money only: smuggler cash below occupied stations,
    // civilian capital elsewhere — an empty till buys nothing (5a, closed circulation)
    const pool = this.tradePool();
    n = Math.min(n, Math.floor(this.pools[pool] / unit));
    if (n <= 0) {
      this.audio.sfx("alarm");
      this.setNews(pool === "clan" ? "Клановая касса пуста — контрабандистам платить нечем." : "Касса станции пуста — Альянс зажал кредиты.");
      return;
    }
    const payout = unit * n;
    this.player.cargo[goodId] = have - n;
    const paid = this.gain(payout, pool);
    this.player.earned += paid;
    this.player.traded += paid;
    // dumping a hold sags the local price — the next hold of the same good pays less
    this.pushFluct(d, goodId, -ECONOMY.PLAYER_FLUCT_PUSH * n);
    this.audio.sfx("credits");
    this.pushStation();
    this.pushHud();
  }

  /* ---- Верфь и лавка снаряжения (Этап 7) ---- */

  /** Прилавок этого терминала: клановая касса (оккупация и база) или гражданская станция. */
  private clanMarket(d: Dockable): boolean { return fleet.clanMarket(this, d); }

  /** Потолок рангов на витрине: статус дока × standing. Клановый рынок — только своим. */
  private rankCap(d: Dockable): number { return fleet.rankCap(this, d); }

  /** Причина, по которой лавка не продаёт линию/ранг; null — продаёт. */
  private lineGate(d: Dockable, line: { yard: YardTier }, rankIdx: number): string | null {
    return fleet.lineGate(this, d, line, rankIdx);
  }

  /** Причина, по которой верфь не продаёт корпус; null — стапель свободен. */
  private hullGate(d: Dockable, h: HullDef): string | null { return fleet.hullGate(this, d, h); }

  private refuse(msg: string): void {
    this.audio.sfx("alarm");
    this.setNews(`Верфь: ${msg}.`);
  }

  /** Пересадка на корпус: фит пересобирает fleet.ts, статы и лечение — здесь. */
  private setShip(id: HullId): void {
    fleet.setShipFit(this.player, id);
    this.applyPlayerStats();
    const p = this.ships[0];
    p.hp = p.maxHp;
    p.shield = p.maxShield;
  }

  /** Обмен корпуса с зачётом старого по HULL_SELL; деньги — через пул прилавка (инвариант цел). */
  buyHull(id: string): void {
    if (this.sm.state !== "docked") return;
    const d = this.dockTarget;
    const to = HULLS.find((h) => h.id === id);
    if (!d || !to || to.id === this.player.ship) return;
    const gate = this.hullGate(d, to);
    if (gate) { this.refuse(gate); return; }
    if (this.cargoUsed() > to.cargo) { this.refuse(`трюм «${to.name}» не вместит груз: разгрузитесь до ${to.cargo}`); return; }
    const net = to.price - Math.round(this.hullDef().price * HULL_SELL);
    if (net > 0 && this.player.credits < net) { this.refuse(`не хватает ₡${(net - Math.floor(this.player.credits)).toLocaleString("ru-RU")} с учётом сдачи корпуса`); return; }
    const pool = this.tradePool();
    if (net > 0) this.pay(net, pool);
    else if (net < 0) this.gain(-net, pool);
    this.setShip(to.id);
    this.audio.sfx("upgrade");
    this.setNews(`⚑ Стапель передаёт вам «${to.name}»: ${net >= 0 ? `доплата ₡${net.toLocaleString("ru-RU")}` : `сдача ₡${(-net).toLocaleString("ru-RU")}`}.`);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  /** Сдача текущего корпуса на слом (всегда остаётся истребитель). */
  sellHull(): void {
    if (this.sm.state !== "docked") return;
    const cur = this.hullDef();
    if (cur.id === "fighter") { this.refuse("сдавать нечего — «Рейнджер» и есть последний плот"); return; }
    const back = Math.round(cur.price * HULL_SELL);
    this.gain(back, this.tradePool());
    this.setShip("fighter");
    this.audio.sfx("upgrade");
    this.setNews(`«${cur.name}» ушёл на слом, верфь вернула ₡${back.toLocaleString("ru-RU")}. Снова истребитель — снова с нуля.`);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  buyModule(itemId: string): void {
    if (this.sm.state !== "docked") return;
    const d = this.dockTarget;
    const it = EQUIP[itemId];
    if (!d || !it) return;
    const gate = this.lineGate(d, it, it.rankIdx);
    if (gate) { this.refuse(`«${it.name}» — ${gate}`); return; }
    if (this.player.credits < it.cost) { this.refuse("не хватает кредитов"); return; }
    this.pay(it.cost, this.tradePool());
    this.player.stash.push(it.id);
    this.audio.sfx("trade");
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  sellModule(stashIdx: number): void {
    if (this.sm.state !== "docked") return;
    const id = this.player.stash[stashIdx];
    const it = id ? EQUIP[id] : undefined;
    if (!it) return;
    this.player.stash.splice(stashIdx, 1);
    this.gain(Math.round(it.cost * EQUIP_SELL), this.tradePool());
    this.audio.sfx("credits");
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  /** Модуль со склада — в слот; то, что стояло, уезжает на склад. */
  equipModule(stashIdx: number, cat: EquipCat, slot: number): void {
    if (this.sm.state !== "docked") return;
    const id = this.player.stash[stashIdx];
    const it = id ? EQUIP[id] : undefined;
    if (!it || it.cat !== cat) return;
    if (!it.ships.includes(this.player.ship)) { this.refuse(`«${it.name}» не встанет на «${this.hullDef().name}»`); return; }
    const arr = this.player.installed[cat];
    if (slot < 0 || slot >= this.hullDef().slots[cat]) return;
    const old = arr[slot];
    arr[slot] = it.id;
    this.player.stash.splice(stashIdx, 1);
    if (old) this.player.stash.push(old);
    this.audio.sfx("upgrade");
    this.applyPlayerStats();
    this.ships[0].shield = Math.min(this.ships[0].shield, this.ships[0].maxShield);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  unequipModule(cat: EquipCat, slot: number): void {
    if (this.sm.state !== "docked") return;
    const arr = this.player.installed[cat];
    const it = arr[slot] ? EQUIP[arr[slot]!] : undefined;
    if (!it) return;
    // двигатель снимаем на дежурный: голый корпус обязан ползти домой
    arr[slot] = cat === "engine" ? this.hullDef().defaultEngine : null;
    this.player.stash.push(it.id);
    this.audio.sfx("upgrade");
    this.applyPlayerStats();
    this.ships[0].shield = Math.min(this.ships[0].shield, this.ships[0].maxShield);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  /** The repair bill; the lair's docks are unlicensed — repairs cost less there (6c). */
  private repairCost(): number {
    const p = this.ships[0];
    return fleet.repairCost(Math.ceil(p.maxHp - p.hp), this.dockTarget?.id === PIRATE_BRANCH.LAIR.id);
  }

  repair(): void {
    if (this.sm.state !== "docked") return;
    const p = this.ships[0];
    const missing = Math.ceil(p.maxHp - p.hp);
    if (missing <= 0) return;
    const cost = this.repairCost();
    if (this.player.credits < cost) return;
    // smuggler hands take smuggler coin
    this.pay(cost, this.dockTarget?.id === PIRATE_BRANCH.LAIR.id ? "clan" : "stations");
    p.hp = p.maxHp;
    this.audio.sfx("upgrade");
    this.pushStation();
    this.pushHud();
  }

  /* ================================================================== */
  /* Reputation / contracts / convoy raids                               */
  /* ================================================================== */

  /** Patrols shoot on sight once the player is outlawed or at vendetta with them. */
  private patrolHostile(): boolean {
    return this.player.outlaw || this.player.rep.patrol <= REP.HOSTILE_PATROL;
  }

  /**
   * 5f «pirate status»: a wanted captain counts as one of the clans. Raiders hold
   * their fire, radars repaint (raiders blue, patrol red), ordinary stations and
   * planets refuse the terminal — only the occupied system's black market is open.
   */
  isPirate(): boolean {
    return this.patrolHostile();
  }

  /** One-shot newscast when pirate status flips — called after any rep/outlaw change. */
  syncPirateStatus(): void {
    const now = this.patrolHostile();
    if (now === this.pirateStatus) return;
    this.pirateStatus = now;
    if (now) {
      this.audio.sfx("alarm");
      this.setNews("☠ Вы теперь свой для пиратов: рейдеры вас не тронут. Но патруль стреляет при виде, и станции вас не принимают.");
    } else {
      this.audio.sfx("pickup");
      this.setNews("Розыск выдохся: станции снова берут вас, вот и рейдерам снова есть с чего вас вешать.");
    }
  }

  /** Radar/blip color; pirate status swaps the palette — raiders go blue, patrol red. */
  private blipColor(f: Faction, smuggler = false): string {
    if (smuggler) return "#b46aff"; // clan hauler — violet, like the clan rep chip (Этап 8)
    const ally = this.isPirate();
    if (f === "pirate") return ally ? "#5a9fff" : "#ff5a4a";
    if (f === "patrol") return ally ? "#ff5a4a" : "#5a9fff";
    return f === "boss" ? "#d26aff" : "#ffd24a";
  }

  addRep(d: { patrol?: number; trader?: number; clan?: number }): void {
    const r = this.player.rep;
    if (d.patrol) r.patrol = Math.max(REP.MIN, Math.min(REP.MAX, r.patrol + d.patrol));
    if (d.trader) r.trader = Math.max(REP.MIN, Math.min(REP.MAX, r.trader + d.trader));
    if (d.clan) r.clan = Math.max(REP.MIN, Math.min(REP.MAX, r.clan + d.clan));
    this.syncPirateStatus();
  }

  /** Patrol tribunal tariff: deeper debt to the law — fatter the fine. */
  fineCost(): number {
    let c = REP.FINE.BASE + REP.FINE.PER_POINT * Math.max(0, -this.player.rep.patrol);
    if (this.player.outlaw) c += REP.FINE.OUTLAW_FEE;
    return Math.round(c);
  }

  /** Pay the tribunal: clears the wanted flag and buys back patrol standing. */
  payFine(): void {
    const r = this.player.rep;
    if (!this.player.outlaw && r.patrol >= 0) {
      this.audio.sfx("alarm"); // nothing on the books — nothing to pay
      return;
    }
    const cost = this.fineCost();
    if (this.player.credits < cost) {
      this.audio.sfx("alarm");
      this.setNews(`Не хватает ₡${(cost - Math.round(this.player.credits)).toLocaleString("ru-RU")} на штраф трибунала.`);
      return;
    }
    this.pay(cost, "patrol"); // tribunal fines refill the patrol treasury
    // the tribunal receipt ends the hunt outright: standing jumps back above the vendetta line
    r.patrol = Math.min(REP.MAX, Math.max(r.patrol + REP.FINE.GAIN, REP.HOSTILE_PATROL + 1));
    r.trader = Math.min(REP.MAX, r.trader + REP.FINE.TRADER_GAIN);
    this.addRep({ clan: REP.FINE.CLAN_GAIN }); // the clans don't forgive a handshake with the law
    this.player.outlaw = false;
    this.player.pardons = 0;
    this.audio.sfx("trade");
    this.syncPirateStatus(); // 5f: receipt in hand, the clans lose their guest
    this.setNews(`Штраф ₡${cost.toLocaleString("ru-RU")} уплачен — розыск снят, патруль больше не считает вас врагом.`);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  /** Alliance standing bends prices: allies discount, enemies gouge. */
  private tradeMod(): { buy: number; sell: number } {
    return econ.tradeMod(this);
  }

  /** One offer of each kind per docking; the broker restocks every undock. */
  private genOffers(here: Dockable): void { missions.genOffers(this, here); }

  /**
   * The clans' board (Этап 6b) — posted only in occupied systems and, later, at the
   * lair. Zero trust (clan ≤ UNFRIENDLY) and nobody even hails you here. Clan money
   * pays, clan law scores: patrol and Alliance standings burn on the way.
   */
  private genClanOffers(here: Dockable): void { missions.genClanOffers(this, here); }

  acceptContract(id: number): void { missions.acceptContract(this, id); }

  cancelContract(): void { missions.cancelContract(this); }

  private completeContract(reason: string): void { missions.completeContract(this, reason); }

  private failContract(reason: string): void { missions.failContract(this, reason); }

  private spawnConvoyEvent(): void { missions.spawnConvoyEvent(this); }

  private endConvoy(win: boolean, reason: string, plundered = false): void { missions.endConvoy(this, win, reason, plundered); }

  private updateContracts(dt: number): void { missions.updateContracts(this, dt); }

  /** HUD one-liner for the active contract / raid, with distance to the objective. */
  private missionLine(): string | null { return missions.missionLine(this); }

  /** Where the mini-radar should point: contract target or the nearest live raider. */
  objectivePos(): { x: number; y: number; c: string } | null { return missions.objectivePos(this); }

  /* ================================================================== */
  /* Update loop (fixed 60Hz)                                            */
  /* ================================================================== */

  private update(dt: number): void {
    if (this.disposed) return;
    const st = this.sm.state;

    // global keys that work outside of `playing`
    if (st === "title") {
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        if (loadSave()) this.continueGame(); else this.newGame();
      }
      this.updateParticles(dt);
      return;
    }
    if (this.input.consumeAction("Escape")) {
      // the star chart is an overlay — Esc folds it before it dares to pause the game
      if (this.mapOpen) { this.mapOpen = false; this.pushStatic(); this.updateParticles(dt); return; }
      if (st === "playing") { this.sm.transition("paused"); this.pushStatic(); }
      else if (st === "paused") { this.sm.transition("playing"); this.pushStatic(); }
      else if (st === "docked") this.undock();
      this.updateParticles(dt);
      return;
    }
    if (st === "gameover" || st === "victory") {
      if (this.input.consumeAction("Space") || this.input.consumeAction("Enter")) {
        if (st === "gameover") this.newGame();
        else { this.sm.transition("playing"); uiBridge.set({ end: null }); this.pushStatic(); }
      }
      this.updateParticles(dt);
      return;
    }
    if (st !== "playing") { this.updateParticles(dt); return; }

    this.player.playTime += dt;
    const p = this.ships[0];

    /* ---- star chart toggle (overlay; the world keeps ticking) ---- */
    if (this.input.consumeAction("KeyM")) {
      this.mapOpen = !this.mapOpen;
      this.pushStatic();
      this.pushHud();
    }

    /* ---- economy ---- */
    this.econT -= dt;
    if (this.econT <= 0) {
      this.econT = ECONOMY.TICK;
      const news = economyTick(this.dockables, this.rnd);
      if (news) this.setNews(news);
    }
    if (this.newsT > 0) {
      this.newsT -= dt;
      if (this.newsT <= 0) uiBridge.set({ news: null });
    }

    /* ---- autosave ---- */
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = AUTOSAVE_INTERVAL; this.saveNow(); }

    /* ---- contracts + raid events ---- */
    this.updateContracts(dt);

    /* ---- the player's own raid operation (5d) ---- */
    this.updateRaid(dt);

    updateOrbits(this.dockables, dt);

    /* ---- player control: W = up-screen (+y), D = right (+x) ---- */
    const thrustOn = this.input.moveX !== 0 || this.input.moveZ !== 0;
    p.vx += this.input.moveX * p.accel * dt;
    p.vy += this.input.moveZ * p.accel * dt;
    const damp = Math.exp(-(thrustOn ? 0.55 : 1.5) * dt);
    p.vx *= damp; p.vy *= damp;
    const spd = Math.hypot(p.vx, p.vy);
    if (spd > p.maxSpeed) {
      p.vx = (p.vx / spd) * p.maxSpeed;
      p.vy = (p.vy / spd) * p.maxSpeed;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // heading: face velocity while moving, else face the aim point
    let faceTarget = p.angle;
    if (spd > 40) faceTarget = Math.atan2(p.vy, p.vx);
    else {
      const aim = this.aimAngle();
      if (aim !== null) faceTarget = aim;
    }
    p.angle = turnToward(p.angle, faceTarget, PLAYER_CFG.TURN_LERP * dt);

    // world bounds: soft wall
    const HALF = WORLD_CFG.HALF;
    for (const axis of ["x", "y"] as const) {
      if (Math.abs(p[axis]) > HALF) {
        p[axis] = Math.sign(p[axis]) * HALF;
        p[axis === "x" ? "vx" : "vy"] *= -0.4;
      }
    }

    // star heat
    const starDist = Math.hypot(p.x, p.y);
    if (starDist < WORLD_CFG.STAR_HEAT_RADIUS) {
      p.sinceHit = 0;
      this.rawDamagePlayer(WORLD_CFG.STAR_HEAT_DPS * dt);
      this.alarmT -= dt;
      if (this.alarmT <= 0) { this.alarmT = 1.6; this.audio.sfx("alarm"); }
    }

    // solid bodies: planets/stations push the ship out
    for (const d of this.dockables) {
      const dx = p.x - d.x, dy = p.y - d.y;
      const dist = Math.hypot(dx, dy);
      const minDist = d.radius + p.radius * 0.8;
      if (dist < minDist && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        p.x = d.x + nx * minDist;
        p.y = d.y + ny * minDist;
        const impact = Math.max(0, -(p.vx * nx + p.vy * ny));
        if (impact > 220) this.rawDamagePlayer((impact - 220) * 0.08);
        const dot = p.vx * nx + p.vy * ny;
        p.vx -= 1.6 * dot * nx;
        p.vy -= 1.6 * dot * ny;
      }
    }

    // engine trail
    if (thrustOn && spd > 60) {
      p.trailT -= dt;
      if (p.trailT <= 0) {
        p.trailT = 0.028;
        const back = p.angle + Math.PI;
        this.emit(p.x + Math.cos(back) * p.radius * 0.9, p.y + Math.sin(back) * p.radius * 0.9,
          Math.cos(back) * 90 + p.vx * 0.2, Math.sin(back) * 90 + p.vy * 0.2, 0.45, 6, 4);
      }
    }

    // damaged-hull smoke below 35% integrity
    if (p.hp < p.maxHp * 0.35) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = 0.16;
        this.emit(p.x + (this.rnd() - 0.5) * 16, p.y + (this.rnd() - 0.5) * 16,
          (this.rnd() - 0.5) * 24, (this.rnd() - 0.5) * 24 - 14, 0.8, 11, 8);
      }
    }

    // shield regen
    p.sinceHit += dt;
    if (p.sinceHit > 4 && p.shield < p.maxShield) {
      p.shield = Math.min(p.maxShield, p.shield + this.shieldRegen() * dt);
    }

    /* ---- player fire ---- */
    p.fireCooldown -= dt;
    // tap — одиночный выстрел с клика, чей mousedown съела активация окна (см. input.ts);
    // берём каждый кадр, чтобы «банкованный» тап не выстрелил позже сам по себе
    const tap = this.input.consumeTap();
    if ((tap || this.input.firing) && p.fireCooldown <= 0) {
      const aim = this.aimAngle() ?? p.angle;
      this.playerFire(aim);
      p.fireCooldown = 1 / this.gunRate();
      // firing while stationary turns the ship toward the target
      if (spd <= 40) p.angle = turnToward(p.angle, aim, 1);
    }

    /* ---- dock prompt ---- */
    this.dockTarget = spd < WORLD_CFG.DOCK_MAX_SPEED ? findDockTarget(this.dockables, p.x, p.y) : null;
    if (this.dockTarget && (this.input.consumeAction("KeyE") || this.input.consumeAction("Enter"))) {
      this.dock();
      return;
    }

    /* ---- hyperspace gate prompt (overrides docking when both in range) ---- */
    this.jumpGate = null;
    if (spd < GATE_CFG.MAX_SPEED) {
      for (const g of this.gates) {
        if (Math.hypot(g.x - p.x, g.y - p.y) - GATE_CFG.RADIUS < GATE_CFG.MARGIN) {
          this.jumpGate = g;
          this.dockTarget = null;
          break;
        }
      }
    }
    if (this.jumpGate && (this.input.consumeAction("KeyE") || this.input.consumeAction("Enter"))) {
      this.jumpTo(this.jumpGate.to);
      return;
    }
    if (this.jumpGrace > 0) this.jumpGrace -= dt;

    /* ---- AI + NPC movement ---- */
    this.updateAi(dt);

    /* ---- bolts ---- */
    this.updateBolts(dt);

    /* ---- pickups ---- */
    this.updatePickups(dt);

    /* ---- floating credit popups ---- */
    this.updateFloaters(dt);

    /* ---- spawner ---- */
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = POPULATION.SPAWN_PERIOD;
      this.maintainPopulation();
    }

    /* ---- pirate occupation front ---- */
    this.updateOccupation(dt);

    /* ---- economic victory: own a quarter of the galaxy's money ---- */
    if (!this.player.victoryShown && this.sharePct() >= VICTORY_SHARE) {
      this.victory(`Вы выкупили четверть экономики Галактики — доля рынка ${(this.sharePct() * 100).toFixed(1)}%! Кредиты всей системы стекаются к вам.`);
    }

    /* ---- threat music ---- */
    this.audio.setThreat(this.threatLevel());

    /* ---- particles + HUD ---- */
    this.updateParticles(dt);
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.12;
      this.pushHud();
      if (this.mapOpen) this.pushMap();
    }
  }

  /**
   * Occupation state machine. Held: the flagship finishes on the slipway (even off-screen),
   * then patrols the captured star. Liberated: after REOCCUPY_DELAY the clans seize another
   * random system and the cycle starts again.
   */
  private updateOccupation(dt: number): void {
    if (this.occ.held) {
      // Protection tax (Этап 5c): the occupied system's yards feed the clan war chest —
      // civilian capital (stations) trickles to the clans while the flagship holds the system.
      const tax = Math.min(PIRATE_ECON.TAX_PER_SEC * dt, Math.max(0, this.pools.stations));
      if (tax > 0) {
        this.pools.stations -= tax;
        this.pools.clan += tax;
      }
    }
    if (!this.occ.held) {
      this.occ.t -= dt;
      if (this.occ.t > 0) return;
      // the clans do not re-occupy a system the player is currently raiding (5d)
      const cands = SYSTEMS.filter((s) => s.id !== this.occ.systemId
        && !(this.raid && this.raid.timeLeft > 0 && this.raid.targetId === s.id));
      // Каркинос — родовая крепость кланов: за новым плацдармом половина бросков ведёт именно туда
      const kar = cands.find((s) => s.id === "kar");
      const pick = kar && this.rnd() < 0.5 ? kar : cands[Math.floor(this.rnd() * cands.length)];
      this.occ = { systemId: pick.id, held: true, t: OCCUPATION.FLAGSHIP_BUILD, flagshipBuilt: false };
      this.setNews(`⚑ ПИРАТЫ ЗАХВАТИЛИ СИСТЕМУ ${pick.name.toUpperCase()}! Патруль отведён, флагман сошёл на стапели.`);
      this.audio.sfx("alarm");
      if (this.systemDef.id === pick.id) {
        // the occupation lands on the player's head: patrol fleet withdraws now
        for (let i = 1; i < MAX_SHIPS; i++) {
          const sh = this.ships[i];
          if (sh.active && sh.faction === "patrol") this.freeShip(i);
        }
        if (this.sm.state === "docked") { this.offers = []; this.pushStation(); }
        this.pushHud();
      }
      this.saveNow();
      return;
    }
    if (!this.occ.flagshipBuilt) {
      this.occ.t -= dt;
      if (this.occ.t > 0) return;
      this.occ.flagshipBuilt = true;
      if (this.systemDef.id === this.occ.systemId) {
        this.spawnBossResident(); // slipway finished on-station: it rolls out now
      } else {
        this.setNews(`Разведка: флагман кланов достроен в системе ${this.systemName(this.occ.systemId)}.`);
      }
      this.saveNow();
      return;
    }
    // resident flagship alive and player inside: keep it on station after jumps/despawns
    if (this.bossIdx < 0 && this.systemDef.id === this.occ.systemId && this.sm.state === "playing") {
      this.spawnBossResident();
    }
  }

  /* ================================================================== */
  /* Raid operation (Этап 5d)                                            */
  /* ================================================================== */

  /** True while the player's raid window is open over the system they are standing in. */
  private raidHot(): boolean { return missions.raidHot(this); }

  /**
   * Launch a raid on a free system from the galaxy map (5d). Occupied systems
   * hold nothing worth taking; the desk is busy while a window or cooldown runs.
   */
  startRaid(systemId: string): void { missions.startRaid(this, systemId); }

  /** Patrol cordon thrown up around every station of the target while the window is open. */
  private spawnRaidGuards(): void { missions.spawnRaidGuards(this); }

  /** Window timer, storehouse hovering, cooldown. Contract/convoy logic is untouched by jumps — the op is galaxy-wide. */
  private updateRaid(dt: number): void { missions.updateRaid(this, dt); }

  /** Empty one storehouse: three treasuries pay at once — strongbox, customs payroll, caravan funds. */
  private grabStorehouse(d: Dockable): void { missions.grabStorehouse(this, d); }

  /** The window closed: escorts stand down, the operation desk cools off. */
  private endRaid(reason?: string): void { missions.endRaid(this, reason); }

  /** Rough per-storehouse take in a system — the map's raid forecast (5d). */
  private raidEstFor(def: SystemDef): number { return missions.raidEstFor(this, def); }

  /** Aim angle: mouse cursor on desktop; auto-target nearest hostile on touch. */
  private aimAngle(): number | null {
    const p = this.ships[0];
    if (this.input.touchFiring && !this.input.mouseDown) {
      let best = -1, bestD = 1000;
      for (let i = 1; i < MAX_SHIPS; i++) {
        const s = this.ships[i];
        if (!s.active || (s.faction !== "pirate" && s.faction !== "boss")) continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) return Math.atan2(this.ships[best].y - p.y, this.ships[best].x - p.x);
      return p.angle;
    }
    const w = window.innerWidth, h = window.innerHeight;
    const wx = this.camX + (this.input.mouseX - w / 2) / this.ppu;
    const wy = this.camY - (this.input.mouseY - h / 2) / this.ppu;
    return Math.atan2(wy - p.y, wx - p.x);
  }

  /** Player damage with no attacker (star heat, collisions). */
  private rawDamagePlayer(dmg: number): void {
    const p = this.ships[0];
    if (!p.active || this.jumpGrace > 0) return;
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, dmg);
      p.shield -= absorbed;
      dmg -= absorbed;
      if (dmg <= 0) return;
    }
    p.hp -= dmg;
    this.damageFlash++;
    uiBridge.set({ damageFlash: this.damageFlash });
    this.shake = Math.min(24, this.shake + 3);
    if (p.hp <= 0) this.killShip(0, false);
  }

  private threatLevel(): number {
    const p = this.ships[0];
    let threat = 0;
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      const hostileToMe =
        s.faction === "pirate" || s.faction === "boss" ||
        (s.faction === "patrol" && this.player.outlaw);
      if (!hostileToMe) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < 2400) threat = Math.max(threat, s.faction === "boss" ? 1 : 1 - d / 2400);
    }
    return threat;
  }

  /**
   * How strong a pirate presence the clan fund can staff (Этап 5c): rich clans post the
   * full POPULATION.PIRATES, a thin fund keeps the flotilla at PIRATES_MIN — sinking their
   * hulls literally thins the ranks. Interpolates linearly between PIRATE_ECON.FUND_THIN
   * and FUND_FULL, then adds the local system/occupation modifiers.
   */
  private pirateStrength(): number {
    const t = (this.pools.clan - PIRATE_ECON.FUND_THIN) / (PIRATE_ECON.FUND_FULL - PIRATE_ECON.FUND_THIN);
    const base = POPULATION.PIRATES_MIN
      + Math.round((POPULATION.PIRATES - POPULATION.PIRATES_MIN) * Math.max(0, Math.min(1, t)));
    return base + this.systemDef.pirateBoost + (this.hereOccupied() ? OCCUPATION.PIRATE_EXTRA : 0);
  }

  /**
   * Constabulary headcount (Этап 11b): base is per system, but a treasury below
   * TREASURY_THIN means the watch can't pay full wages — the roster shrinks to a
   * skeleton crew of THIN_PATROLS.
   */
  private patrolStrength(): number {
    const base = POPULATION.PATROLS + (this.systemDef.patrolBoost ?? 0);
    return this.pools.patrol < PATROL_ECON.TREASURY_THIN ? Math.min(base, PATROL_ECON.THIN_PATROLS) : base;
  }

  private maintainPopulation(): void {
    let pirates = 0, patrols = 0, traders = 0;
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      if (s.faction === "pirate") pirates++;
      else if (s.faction === "patrol") patrols++;
      else if (s.faction === "trader") traders++;
    }
    const pirateCap = this.pirateStrength();
    if (pirates < pirateCap) this.spawnAtEdge("pirate");
    // constabulary strength is per system, gated by the treasury (Этап 11b)
    const patrolCap = this.patrolStrength();
    if (!this.hereOccupied() && patrols < patrolCap) this.spawnAtEdge("patrol");
    // «Варта»: a fat treasury commissions one heavy cruiser for the system
    if (!this.hereOccupied() && this.pools.patrol >= PATROL_ECON.TREASURY_FULL
      && !this.ships.some((s) => s.active && s.cruiser)) this.spawnCruiser();
    if (traders < POPULATION.TRADERS) this.spawnAtEdge("trader");
    // clan haulers (Этап 8): the grey route breathes only around its endpoints
    if (this.smuggleHere()) {
      let smugglers = 0;
      for (const s of this.ships) if (s.active && s.smuggler) smugglers++;
      if (smugglers < SMUGGLER.COUNT) this.spawnSmuggler();
    }
  }

  /* ================================================================== */
  /* AI                                                                  */
  /* ================================================================== */

  private updateAi(dt: number): void {
    const p = this.ships[0];
    const HALF = WORLD_CFG.HALF;
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;

      s.sinceHit += dt;
      if (s.sinceHit > 4 && s.shield < s.maxShield) s.shield = Math.min(s.maxShield, s.shield + 8 * dt);
      s.fireCooldown -= dt;

      /* think (staggered); think() receives the real elapsed time, so behaviour
         timings survive changes to the think cadence */
      s.thinkT -= dt;
      if (s.thinkT <= 0) {
        const elapsed = s.thinkDt - s.thinkT; // previous interval + overshoot
        s.thinkDt = 0.3 + this.rnd() * 0.25;
        s.thinkT = s.thinkDt;
        this.think(i, elapsed);
      }

      /* steer toward waypoint */
      const dx = s.tx - s.x, dy = s.ty - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 4) {
        s.vx += (dx / dist) * s.accel * dt;
        s.vy += (dy / dist) * s.accel * dt;
      }
      const damp = Math.exp(-0.6 * dt);
      s.vx *= damp; s.vy *= damp;
      const spd = Math.hypot(s.vx, s.vy);
      const cap = s.ai === AiState.Flee ? s.maxSpeed * 1.12 : s.maxSpeed;
      if (spd > cap) { s.vx = (s.vx / spd) * cap; s.vy = (s.vy / spd) * cap; }
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      // keep NPCs inside the world; fleeing pirates may leave (despawn).
      // Despawn is RADIAL: the flee waypoint sits at 1.4·HALF on an arbitrary bearing,
      // so a square threshold strands corner-bound runners orbiting the rim forever.
      if (Math.abs(s.x) > HALF * 1.25 || Math.abs(s.y) > HALF * 1.25
        || Math.hypot(s.x, s.y) > HALF * 1.3) {
        // a pirate running for good leaves the system; a regrouping one stays clamped inside.
        // A clan hauler past the edge is through the gate — the run continues off-screen (Этап 8)
        if (s.smuggler) { this.freeShip(i); continue; }
        if (s.faction === "pirate" && s.ai === AiState.Flee && s.regroupT <= 0) { this.freeShip(i); continue; }
        s.x = Math.max(-HALF, Math.min(HALF, s.x));
        s.y = Math.max(-HALF, Math.min(HALF, s.y));
      }

      // face velocity
      if (spd > 30) s.angle = turnToward(s.angle, Math.atan2(s.vy, s.vx), 8 * dt);

      // faction-colored exhaust when running hot
      if (spd > s.maxSpeed * 0.5) {
        s.trailT -= dt;
        if (s.trailT <= 0) {
          s.trailT = 0.08;
          const back = s.angle + Math.PI;
          this.emit(
            s.x + Math.cos(back) * s.radius, s.y + Math.sin(back) * s.radius,
            Math.cos(back) * 90 + s.vx * 0.2 + (this.rnd() - 0.5) * 30,
            Math.sin(back) * 90 + s.vy * 0.2 + (this.rnd() - 0.5) * 30,
            0.35,
            s.faction === "pirate" ? 3 : s.faction === "patrol" ? 8 : s.faction === "trader" ? 2 : 5,
            4,
          );
        }
      }

      // NPC fire
      if (s.fireRate > 0 && s.fireCooldown <= 0 && s.targetIdx >= 0) {
        const t = this.ships[s.targetIdx];
        if (t.active) {
          const td = Math.hypot(t.x - s.x, t.y - s.y);
          const range = s.faction === "boss" ? 1100 : 760;
          if (td < range && canHit(s.faction, t.faction, this.patrolHostile(), this.isPirate())) {
            // lead the target (AI polish): two intercept passes to where it will be at bolt arrival
            const boltSpd = BOLT_CFG.SPEED * 0.82;
            let tt = td / boltSpd;
            for (let k = 0; k < 2; k++) {
              tt = Math.hypot(t.x + t.vx * tt - s.x, t.y + t.vy * tt - s.y) / boltSpd;
            }
            const aim = Math.atan2(t.y + t.vy * tt - s.y, t.x + t.vx * tt - s.x) + (this.rnd() - 0.5) * 0.12;
            this.fireBolt(i, aim, s.dmg, boltSpd);
            s.fireCooldown = 1 / s.fireRate;
            if (td < 2600 && p.active) this.audio.sfx("enemyLaser");
          }
        }
      }

      // boss extras: radial burst + escorts at half health
      if (s.faction === "boss") {
        s.wanderT -= dt;
        if (s.wanderT <= 0) {
          s.wanderT = 3.2;
          const n = 10;
          for (let k = 0; k < n; k++) this.fireBolt(i, (k / n) * Math.PI * 2 + this.rnd(), s.dmg * 0.7, 620);
          if (p.active) this.audio.sfx("enemyLaser");
        }
        if (!this.bossEscortsSpawned && s.hp < s.maxHp * 0.5) {
          this.bossEscortsSpawned = true;
          const e1 = this.spawnShip("pirate", s.x + 260, s.y);
          const e2 = this.spawnShip("pirate", s.x - 260, s.y);
          if (e1 >= 0) this.ships[e1].screen = true;
          if (e2 >= 0) this.ships[e2].screen = true;
          this.setNews("Флагман вызвал подкрепление!");
        }
      }

      // soft separation from the player
      if (p.active) {
        const ddx = s.x - p.x, ddy = s.y - p.y;
        const dd = Math.hypot(ddx, ddy);
        const minD = s.radius + p.radius;
        if (dd < minD && dd > 0.01) {
          const push = (minD - dd) * 3;
          s.x += (ddx / dd) * push;
          s.y += (ddy / dd) * push;
        }
      }
    }
  }

  private think(i: number, dt: number): void {
    const s = this.ships[i];
    const p = this.ships[0];
    const HALF = WORLD_CFG.HALF;

    if (s.faction === "trader") {
      // clan hauler (Этап 8): one endpoint, one trade, then run for the gate.
      // Flee doubles as "leaving the system" — the edge check in updateAi despawns it.
      if (s.smuggler) {
        if (s.ai === AiState.Flee) return;
        const d = this.dockables[s.routeTo];
        if (!d) {
          s.ai = AiState.Flee;
          const a = Math.atan2(s.y, s.x);
          s.tx = Math.cos(a) * HALF * 1.4;
          s.ty = Math.sin(a) * HALF * 1.4;
          return;
        }
        s.tx = d.x; s.ty = d.y;
        if (Math.hypot(d.x - s.x, d.y - s.y) < d.radius + 260) {
          this.traderTrade(i); // settles with the clan till (lair / occupied system)
          s.ai = AiState.Flee;
          const a = Math.atan2(s.y, s.x) + (this.rnd() - 0.5);
          s.tx = Math.cos(a) * HALF * 1.4;
          s.ty = Math.sin(a) * HALF * 1.4;
        }
        return;
      }
      if (s.ai === AiState.Flee) {
        let bestD = Infinity;
        for (const d of this.dockables) {
          const dd = Math.hypot(d.x - s.x, d.y - s.y);
          if (dd < bestD) { bestD = dd; s.tx = d.x; s.ty = d.y; }
        }
        if (s.sinceHit > 6) {
          s.ai = AiState.Route;
          if (s.escortId < 0) this.pickTraderRoute(i); // escorts hold their contracted heading
        }
        return;
      }
      const d = this.dockables[s.routeTo];
      s.tx = d.x; s.ty = d.y;
      if (Math.hypot(d.x - s.x, d.y - s.y) < d.radius + 260) {
        s.routeFrom = s.routeTo;
        if (s.escortId >= 0) {
          if (this.contract && this.contract.kind === "escort" && this.contract.escortIdx === i) {
            s.escortId = -1;
            this.completeContract("транспорт благополучно прибыл");
          } else {
            s.escortId = -1;
          }
        }
        this.traderTrade(i); // sell the hold, buy the best margin, sail on (Этап 5b)
      }
      return;
    }

    if (s.faction === "patrol") {
      // hunt pirates; hunt the player if outlaw or at vendetta with the patrol
      let best = -1, bestD: number = FACTION_CFG.patrol.aggro;
      if (this.patrolHostile() && p.active) {
        best = 0;
        bestD = Math.hypot(p.x - s.x, p.y - s.y);
      }
      for (let j = 1; j < MAX_SHIPS; j++) {
        const o = this.ships[j];
        if (!o.active || (o.faction !== "pirate" && o.faction !== "boss")) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) {
        s.targetIdx = best;
        s.ai = AiState.Chase;
        s.tx = this.ships[best].x; s.ty = this.ships[best].y;
      } else {
        s.targetIdx = -1;
        s.ai = AiState.Wander;
        s.wanderT -= dt;
        if (s.wanderT <= 0 || Math.hypot(s.tx - s.x, s.ty - s.y) < 300) {
          s.wanderT = 6 + this.rnd() * 5;
          const d = this.dockables[Math.floor(this.rnd() * this.dockables.length)];
          s.tx = d.x + (this.rnd() - 0.5) * 2600;
          s.ty = d.y + (this.rnd() - 0.5) * 2600;
        }
      }
      return;
    }

    if (s.faction === "boss") {
      s.targetIdx = p.active ? 0 : -1;
      if (p.active) {
        // keep close-mid range so the flagship stays on screen
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d > 470) { s.tx = p.x; s.ty = p.y; }
        else { s.tx = s.x; s.ty = s.y; }
      }
      return;
    }

    /* pirates */
    // low hull → run for the edge of the system for good; a raider whose one regroup
    // pass is spent and whose shields are broken again doesn't get a second get-out
    const spentAndBroken = s.regroupUsed && s.shield <= 0 && s.hp < s.maxHp * 0.45 && s.sinceHit < 3;
    if ((s.hp < s.maxHp * 0.28 || spentAndBroken) && s.ai !== AiState.Flee) {
      s.ai = AiState.Flee;
      s.regroupT = 0;
      const a = Math.atan2(s.y, s.x) + (this.rnd() - 0.5);
      s.tx = Math.cos(a) * HALF * 1.4;
      s.ty = Math.sin(a) * HALF * 1.4;
      s.targetIdx = -1;
    }
    // tactical disengagement (AI polish): a wounded raider with broken shields peels off,
    // loiters off-range until its shields knit back (or 7 s pass), then dives into the fight again
    if (s.regroupT > 0) {
      s.regroupT -= dt; // real elapsed think time — was a hardcoded per-tick step
      if (s.regroupT <= 0 || s.shield > s.maxShield * 0.5) {
        s.regroupT = 0; s.ai = AiState.Wander; // back in — target selection below re-chases
      }
      else {
        s.ai = AiState.Flee; s.targetIdx = -1;
        return;
      }
    } else if (s.ai === AiState.Chase && !s.regroupUsed && s.shield <= 0 && s.hp < s.maxHp * 0.55 && s.sinceHit < 3) {
      s.regroupT = 7;
      s.regroupUsed = true;
      s.ai = AiState.Flee; s.targetIdx = -1;
      const a = Math.atan2(s.y, s.x); // pull out toward open space, not off the map
      s.tx = Math.cos(a) * HALF * 0.9;
      s.ty = Math.sin(a) * HALF * 0.9;
      return;
    }
    if (s.ai === AiState.Flee) return;

    // pick target: player in range — but never a wanted kin captain (5f: the clans
    // recognise one of their own), else nearest trader, else wander
    let best = -1, bestD: number = FACTION_CFG.pirate.aggro;
    if (p.active && !this.isPirate()) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      const playerHeat = this.player.kills >= 3 ? 1.5 : 1; // notorious rangers attract pirates
      if (d < bestD * playerHeat) { best = 0; bestD = d; }
    }
    for (let j = 1; j < MAX_SHIPS; j++) {
      const o = this.ships[j];
      if (!o.active || (o.faction !== "trader" && o.faction !== "patrol")) continue;
      if (o.smuggler) continue; // kin hauling for the clans (Этап 8) — raiders leave it be
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      const w = o.faction === "trader" ? 0.8 : 0.55; // prefer fat traders, wary of patrols
      if (d * w < bestD) { best = j; bestD = d * w; }
    }
    if (best >= 0) {
      s.targetIdx = best;
      s.ai = AiState.Chase;
      const t = this.ships[best];
      // orbit-strafe at close range instead of ramming
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      if (d < 420) {
        const a = Math.atan2(s.y - t.y, s.x - t.x) + 0.9;
        s.tx = t.x + Math.cos(a) * 380;
        s.ty = t.y + Math.sin(a) * 380;
      } else {
        s.tx = t.x; s.ty = t.y;
      }
    } else {
      s.targetIdx = -1;
      s.ai = AiState.Wander;
      s.wanderT -= dt;
      if (s.wanderT <= 0 || Math.hypot(s.tx - s.x, s.ty - s.y) < 400) {
        s.wanderT = 5 + this.rnd() * 6;
        s.tx = (this.rnd() - 0.5) * 2 * HALF * 0.85;
        s.ty = (this.rnd() - 0.5) * 2 * HALF * 0.85;
      }
    }
  }

  /* ================================================================== */
  /* Bolts & pickups                                                     */
  /* ================================================================== */

  private updateBolts(dt: number): void {
    const outlaw = this.patrolHostile();
    const pact = this.isPirate();
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) { b.active = false; continue; }
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // hit scan against ships
      for (let i = 0; i < MAX_SHIPS; i++) {
        const s = this.ships[i];
        if (!s.active) continue;
        if (s.smuggler && (b.from === "pirate" || b.from === "boss")) continue; // kin hauler — clan guns hold
        if (!canHit(b.from, s.faction, outlaw, pact)) continue;
        const rr = s.radius + BOLT_CFG.RADIUS;
        if (Math.abs(s.x - b.x) > rr || Math.abs(s.y - b.y) > rr) continue;
        if (Math.hypot(s.x - b.x, s.y - b.y) > rr) continue;
        b.active = false;
        this.emit(b.x, b.y, 0, 0, 0.25, 2, 7);
        this.damageShip(i, b.dmg, b.friendly);
        break;
      }
    }
  }

  private updatePickups(dt: number): void {
    const p = this.ships[0];
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      pk.life -= dt;
      if (pk.life <= 0) { pk.active = false; continue; }
      pk.x += pk.vx * dt;
      pk.y += pk.vy * dt;
      pk.vx *= Math.exp(-1.2 * dt);
      pk.vy *= Math.exp(-1.2 * dt);
      if (!p.active) continue;
      const d = Math.hypot(p.x - pk.x, p.y - pk.y);
      if (d < 320 && d > 0.01) {
        // magnet
        pk.vx += ((p.x - pk.x) / d) * 900 * dt;
        pk.vy += ((p.y - pk.y) / d) * 900 * dt;
      }
      if (d < p.radius + 40) {
        if (pk.kind === "credits") {
          // paid out of the dead crew's treasury — an empty one pays what little it has
          const paid = this.gain(pk.amount, pk.src);
          this.player.earned += paid;
          this.audio.sfx("credits");
          if (paid > 0) this.floater(pk.x, pk.y, `+₡${Math.round(paid)}`, "#ffd24a");
          pk.active = false;
        } else if (pk.kind === "module") {
          // trophy module (Этап 11a): into the stash — or sold on the spot when it's full
          const item = EQUIP[pk.goodId];
          if (!item) { pk.active = false; continue; }
          if (this.player.stash.length < MODULE_LOOT.STASH_MAX) {
            this.player.stash.push(pk.goodId);
            this.audio.sfx("pickup");
            this.floater(pk.x, pk.y, `⚙ ${item.name}`, "#b46aff");
            this.setNews(`Трофей с обломков: ${item.name} — на склад.`);
          } else {
            const v = this.gain(Math.round(item.cost * EQUIP_SELL), "stations");
            this.audio.sfx("credits");
            if (v > 0) this.floater(pk.x, pk.y, `+₡${Math.round(v)}`, "#ffd24a");
          }
          pk.active = false;
        } else if (this.cargoUsed() < this.cargoMax()) {
          this.player.cargo[pk.goodId] = (this.player.cargo[pk.goodId] ?? 0) + pk.amount;
          this.audio.sfx("pickup");
          pk.active = false;
        } // else: hold full — leave the pod floating
      }
    }
  }

  /** Spawn a rising text popup at world coords (game feel) — capped so a haul can't flood the screen. */
  floater(x: number, y: number, text: string, c: string, big = false): void {
    if (this.floaters.length >= 40) this.floaters.shift();
    this.floaters.push({ x, y, t: 0, ttl: big ? 2.4 : 1.5, text, c, big });
  }

  private updateFloaters(dt: number): void {
    if (!this.floaters.length) return;
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter((f) => f.t < f.ttl);
  }

  /* ================================================================== */
  /* Render (Canvas 2D)                                                  */
  /* ================================================================== */

  /** world → screen x (camera + shake already applied by caller via camSx/camSy) */
  private camSx = 0;
  private camSy = 0;

  private sx(wx: number): number { return (wx - this.camSx) * this.ppu + window.innerWidth / 2; }
  private sy(wy: number): number { return (this.camSy - wy) * this.ppu + window.innerHeight / 2; }

  private render(): void {
    // auto quality: sustained low fps → cheaper particles, then supersample, then layers.
    // hysteresis: 2 bad windows (4s) to step down, 8 good (16s) to step back up
    this.fpsAccum += 1;
    const now = performance.now();
    if (now - this.fpsWindowStart > 2000) {
      const fps = (this.fpsAccum * 1000) / Math.max(1, now - this.fpsWindowStart);
      this.lowParticles = fps < QUALITY.DEGRADE_FPS || this.quality >= 1;
      if (fps < QUALITY.DEGRADE_FPS) { this.badWindows++; this.goodWindows = 0; }
      else if (fps >= QUALITY.RECOVER_FPS) { this.goodWindows++; this.badWindows = 0; }
      else { this.badWindows = 0; this.goodWindows = 0; }
      if (this.badWindows >= 2 && this.quality < 2) {
        const want = fps < QUALITY.HEAVY_FPS ? 2 : 1;
        if (want > this.quality) this.setQuality(want);
        this.badWindows = 0;
      } else if (this.goodWindows >= 8 && this.quality > 0) {
        this.setQuality(this.quality - 1);
        this.goodWindows = 0;
      }
      this.fpsAccum = 0;
      this.fpsWindowStart = now;
    }

    const st = this.sm.state;
    const p = this.ships[0];
    const ctx = this.ctx;
    const W = window.innerWidth, H = window.innerHeight;

    // camera target
    if (st === "title") {
      this.titleOrbitT += 0.0027;
      const r = 4600;
      this.camX += (Math.cos(this.titleOrbitT) * r - this.camX) * 0.01;
      this.camY += (Math.sin(this.titleOrbitT) * r - this.camY) * 0.01;
    } else if (p.active) {
      const lookX = p.x + p.vx * 0.32;
      const lookY = p.y + p.vy * 0.32;
      this.camX += (lookX - this.camX) * 0.09;
      this.camY += (lookY - this.camY) * 0.09;
    }

    // shake
    let shX = 0, shY = 0;
    if (this.shake > 0.2) {
      shX = (this.rnd() - 0.5) * this.shake;
      shY = (this.rnd() - 0.5) * this.shake;
      this.shake *= 0.88;
    }
    this.camSx = this.camX + shX;
    this.camSy = this.camY + shY;

    // clear: subtle deep-space gradient instead of a flat fill
    const bg = this.bgGradient || (this.bgGradient = (() => {
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 1.6);
      g.addColorStop(0, "#070c18");
      g.addColorStop(1, "#02040a");
      return g;
    })());
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    perf.begin();

    /* parallax layers: effective world pos = s - cam * f;
       tier 2 drops the nebula (f .3) and near-dust (f .7) layers — the two biggest blits */
    for (const layer of this.layers) {
      if (this.quality >= 2 && layer.f >= 0.3) continue;
      const ox = this.camSx * layer.f, oy = this.camSy * layer.f;
      for (const star of layer.stars) {
        const x = (star.x - ox) * this.ppu + W / 2;
        const y = H / 2 - (star.y - oy) * this.ppu;
        if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
        ctx.fillStyle = star.c;
        const r = star.r;
        ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
      for (const neb of layer.nebulas) {
        const size = neb.scale * this.ppu;
        const x = (neb.x - ox) * this.ppu + W / 2;
        const y = H / 2 - (neb.y - oy) * this.ppu;
        if (x + size / 2 < 0 || x - size / 2 > W || y + size / 2 < 0 || y - size / 2 > H) continue;
        if (neb.additive) {
          // painted-on-black art: 'lighter' makes its darks vanish into the starfield
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 0.3;
          ctx.drawImage(neb.tex, x - size / 2, y - size / 2, size, size);
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.globalAlpha = 0.95;
          ctx.drawImage(neb.tex, x - size / 2, y - size / 2, size, size);
        }
        ctx.globalAlpha = 1;
      }
    }

    perf.mark("parallax");

    /* orbit rings */
    ctx.lineWidth = 1;
    for (const d of this.dockables) {
      const r = d.orbit * this.ppu;
      const cx = this.sx(0), cy = this.sy(0);
      if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H) continue;
      ctx.strokeStyle = d.isStation ? "rgba(46,95,143,0.16)" : "rgba(42,74,102,0.24)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // star heat ring
    {
      const r = WORLD_CFG.STAR_HEAT_RADIUS * this.ppu;
      const cx = this.sx(0), cy = this.sy(0);
      ctx.strokeStyle = "rgba(255,84,51,0.3)";
      ctx.setLineDash([14, 10]);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* the star */
    {
      const size = WORLD_CFG.STAR_RADIUS * 5.2 * this.ppu;
      const x = this.sx(0), y = this.sy(0);
      ctx.drawImage(this.starTex, x - size / 2, y - size / 2, size, size);
    }

    /* planets + stations */
    for (let i = 0; i < this.dockables.length; i++) {
      const d = this.dockables[i];
      const scale = (d.isStation ? d.radius * 2.6 : d.radius * 2.1) * this.ppu;
      const x = this.sx(d.x), y = this.sy(d.y);
      if (x + scale / 2 < 0 || x - scale / 2 > W || y + scale / 2 < 0 || y - scale / 2 > H) continue;
      this.dockSpin[i] += this.dockSpinVel[i];
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.dockSpin[i]);
      ctx.drawImage(this.dockTex[i], -scale / 2, -scale / 2, scale, scale);
      ctx.restore();
      // docking range hint for the current target
      if (this.dockTarget === d && st === "playing") {
        ctx.strokeStyle = "rgba(84,255,210,0.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, scale / 2 + 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      // raid heist: an orange arc closing over the storehouse being emptied (5d)
      if (this.grabTarget === d.id && this.raid && this.raid.timeLeft > 0) {
        const frac = Math.max(0, Math.min(1, this.grabT / RAID.GRAB_TIME));
        ctx.strokeStyle = "#ff9a3a";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, scale / 2 + 16, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
      }
    }

    /* hyperspace gates — additive event horizon behind slowly counter-rotating arcs */
    this.gateSpin += 0.006;
    const gPulse = 1 + 0.055 * Math.sin(this.gateSpin * 2.2);
    for (const g of this.gates) {
      const scale = GATE_CFG.RADIUS * 2.4 * this.ppu;
      const x = this.sx(g.x), y = this.sy(g.y);
      if (x + scale < 0 || x - scale > W || y + scale < 0 || y - scale > H) continue;
      ctx.save();
      ctx.translate(x, y);
      // horizon: the vortex art is painted on black, so "lighter" drops the backdrop and keeps the glow
      const hs = scale * 0.56 * gPulse;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.9 * (0.92 + 0.08 * gPulse);
      ctx.rotate(-this.gateSpin * 0.45);
      ctx.drawImage(this.gateHorizonTex, -hs / 2, -hs / 2, hs, hs);
      ctx.restore();
      ctx.rotate(this.gateSpin);
      ctx.drawImage(this.gateTex, -scale / 2, -scale / 2, scale, scale);
      ctx.restore();
      ctx.font = `${Math.max(11, Math.round(14 * this.ppu))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(215,232,238,0.85)";
      ctx.fillText(`⇄ ${g.name}`, x, y + scale / 2 + 20 * this.ppu);
      if (this.jumpGate === g && st === "playing") {
        ctx.strokeStyle = "rgba(84,255,210,0.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, scale / 2 + 10, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    perf.mark("bodies");

    /* pickups */
    const t = now * 0.001;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      const size = 46 * this.ppu;
      const x = this.sx(pk.x), y = this.sy(pk.y) + Math.sin(t * 2 + pk.amount) * 6 * this.ppu;
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * 1.4 + pk.amount) * 0.3);
      ctx.drawImage(pk.kind === "credits" ? this.pickupTex.credits : this.pickupTex.cargo, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    /* ships */
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      const scale = s.radius * SHIP_SCALE * this.ppu;
      const x = this.sx(s.x), y = this.sy(s.y);
      if (x + scale / 2 < 0 || x - scale / 2 > W || y + scale / 2 < 0 || y - scale / 2 > H) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 2 - s.angle); // texture points up; world angle θ → canvas rotation π/2 − θ
      const texs = s.cruiser ? this.shipTexMap.cruiser : this.shipTexMap[s.faction];
      ctx.drawImage(texs[texs.length > 1 ? i & 1 : 0], -scale / 2, -scale / 2, scale, scale);
      ctx.restore();
      // shield ring flash after recent hits
      if (s.shield > 0 && s.sinceHit < 0.35) {
        ctx.strokeStyle = `rgba(111,195,255,${0.7 - s.sinceHit * 2})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, s.radius * this.ppu + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      // pirate status (5f): dashed kin rings — blue around the raiders, hostile red around patrol
      if (i !== 0 && this.isPirate() && (s.faction === "pirate" || s.faction === "patrol")) {
        ctx.strokeStyle = s.faction === "pirate" ? "rgba(90,159,255,0.45)" : "rgba(255,90,74,0.45)";
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 7]);
        ctx.beginPath();
        ctx.arc(x, y, s.radius * this.ppu + 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* bolts */
    for (const b of this.bolts) {
      if (!b.active) continue;
      const size = (b.friendly ? 15 : 12) * Math.max(this.ppu, 0.6);
      const x = this.sx(b.x), y = this.sy(b.y);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      ctx.drawImage(b.friendly ? this.boltTexPlayer : this.boltTexEnemy, x - size / 2, y - size / 2, size, size);
    }

    perf.mark("entities");

    /* particles */
    ctx.globalCompositeOperation = "lighter";
    const pal = paletteTex();
    for (const d of this.particles) {
      if (d.life <= 0) continue;
      const x = this.sx(d.x), y = this.sy(d.y);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const k = d.life / d.maxLife;
      ctx.globalAlpha = k;
      const size = d.size * (0.5 + k) * Math.max(this.ppu, 0.55);
      ctx.drawImage(pal[d.ci], x - size / 2, y - size / 2, size, size);
    }
    // blast shockwave rings
    for (const rg of this.rings) {
      if (rg.life <= 0) continue;
      const x = this.sx(rg.x), y = this.sy(rg.y);
      const rr = rg.r * this.ppu;
      if (x + rr < 0 || x - rr > W || y + rr < 0 || y - rr > H) continue;
      const k = Math.max(0, rg.life / rg.maxLife);
      ctx.globalAlpha = Math.min(1, k * 1.3) * 0.85;
      ctx.strokeStyle = rg.hot ? "rgb(255,190,120)" : "rgb(255,235,190)";
      ctx.lineWidth = Math.max(1, (rg.hot ? 9 : 5) * k);
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
      if (rg.hot) {
        ctx.globalAlpha *= 0.5;
        ctx.strokeStyle = "rgb(255,255,255)";
        ctx.lineWidth = Math.max(1, 4 * k);
        ctx.beginPath(); ctx.arc(x, y, rr * 0.72, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    perf.mark("fx");

    /* plotted course: diamond over the target, or a compass arrow pinned to the screen edge */
    if (this.waypoint && st === "playing") {
      const wx = this.sx(this.waypoint.x), wy = this.sy(this.waypoint.y);
      const margin = 46;
      const onScreen = wx > margin && wx < W - margin && wy > margin && wy < H - margin;
      ctx.save();
      ctx.strokeStyle = "#54ffd2";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(84,255,210,0.8)";
      ctx.shadowBlur = 8;
      if (onScreen) {
        ctx.translate(wx, wy);
        ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-9, -9, 18, 18);
      } else {
        const ps = this.ships[0];
        const px = this.sx(ps.x), py = this.sy(ps.y);
        const a = Math.atan2(wy - py, wx - px);
        const dx = Math.cos(a), dy = Math.sin(a);
        let t = 4000;
        if (dx > 1e-6) t = Math.min(t, (W - margin - px) / dx); else if (dx < -1e-6) t = Math.min(t, (margin - px) / dx);
        if (dy > 1e-6) t = Math.min(t, (H - margin - py) / dy); else if (dy < -1e-6) t = Math.min(t, (margin - py) / dy);
        const ax = px + dx * t, ay = py + dy * t;
        ctx.translate(ax, ay);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(13, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath();
        ctx.stroke();
        const dist = Math.hypot(this.waypoint.x - ps.x, this.waypoint.y - ps.y);
        ctx.rotate(-a);
        ctx.shadowBlur = 0;
        ctx.font = "11px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "#54ffd2";
        ctx.textAlign = "center";
        ctx.fillText(`${(dist / 1000).toFixed(1)}k`, 0, 26);
      }
      ctx.restore();
    }

    /* aim reticle (desktop) */
    if (st === "playing" && !this.input.touchFiring) {
      const mx = this.input.mouseX, my = this.input.mouseY;
      ctx.strokeStyle = "rgba(84,255,210,0.75)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx, my, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - 17, my); ctx.lineTo(mx - 6, my);
      ctx.moveTo(mx + 6, my); ctx.lineTo(mx + 17, my);
      ctx.moveTo(mx, my - 17); ctx.lineTo(mx, my - 6);
      ctx.moveTo(mx, my + 6); ctx.lineTo(mx, my + 17);
      ctx.stroke();
    }

    /* floating credit popups (game feel): rise and fade in screen space */
    if (this.floaters.length && st === "playing") {
      ctx.save();
      ctx.textAlign = "center";
      for (const f of this.floaters) {
        const k = f.t / f.ttl;
        ctx.globalAlpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
        ctx.font = `${f.big ? 800 : 700} ${Math.round((f.big ? 17 : 13) * this.ppu)}px ui-monospace, Consolas, monospace`;
        const fx = this.sx(f.x), fy = this.sy(f.y) - k * 46 * this.ppu;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(2,6,14,0.9)";
        ctx.strokeText(f.text, fx, fy);
        ctx.fillStyle = f.c;
        ctx.fillText(f.text, fx, fy);
      }
      ctx.restore();
    }

    /* hyperspace arrival: radial cyan flash + receding speed streaks */
    if (this.warpFx > 0) {
      const k = this.warpFx;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const rg = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.hypot(W, H) / 2);
      rg.addColorStop(0, `rgba(180,255,240,${0.65 * k})`);
      rg.addColorStop(1, "rgba(60,200,255,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = `rgba(200,255,250,${k * 0.55})`;
      ctx.lineWidth = 2;
      const r0 = 60 + (1 - k) * Math.hypot(W, H) * 0.5;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + 0.3;
        const r1 = r0 + 140 + 260 * (1 - k);
        ctx.beginPath();
        ctx.moveTo(W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0);
        ctx.lineTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }

    perf.end();
    window.__GAME_READY__ = true;
    if (!this.splashRemoved) {
      this.splashRemoved = true;
      document.getElementById("boot-splash")?.remove();
    }
  }

  /* ================================================================== */
  /* UI bridge pushes                                                    */
  /* ================================================================== */

  private pushStatic(): void {
    uiBridge.set({
      screen: this.sm.state,
      hasSave: loadSave() !== null,
      muted: this.audio.muted,
      mapOpen: this.mapOpen,
    });
  }

  pushHud(): void {
    const p = this.ships[0];
    const boss = this.bossIdx >= 0 ? this.ships[this.bossIdx] : null;
    // a course to an orbiting body rides its orbit — snap the marker to the target
    if (this.waypoint) {
      const wd = this.dockables.find((dd) => dd.id === this.waypoint!.targetId);
      if (wd) { this.waypoint.x = wd.x; this.waypoint.y = wd.y; }
    }
    const hud: HudData = {
      credits: Math.round(this.player.credits),
      share: this.sharePct(),
      hull: Math.max(0, Math.round(p.hp)), maxHull: Math.round(p.maxHp),
      shield: Math.max(0, Math.round(p.shield)), maxShield: Math.round(p.maxShield),
      cargoUsed: this.cargoUsed(), cargoMax: this.cargoMax(),
      speed: Math.round(Math.hypot(p.vx, p.vy)),
      kills: this.player.kills,
      outlaw: this.player.outlaw,
      rep: { ...this.player.rep },
      wanted: this.patrolHostile(),
      pardons: this.player.pardons,
      systemName: this.systemDef.name,
      // under the raid embargo the terminal prompt is replaced by the operation line (5d)
      dockName: this.dockTarget && this.sm.state === "playing" && !this.raidHot() ? this.dockTarget.name : null,
      gateName: this.jumpGate && this.sm.state === "playing" ? this.jumpGate.name : null,
      bossActive: !!(boss && boss.active),
      bossHp: boss ? Math.max(0, Math.round(boss.hp + boss.shield)) : 0,
      bossMaxHp: boss ? Math.round(boss.maxHp + boss.maxShield) : 1,
      contractLine: this.missionLine(),
      occupied: this.hereOccupied(),
      waypointName: this.waypoint ? this.waypoint.label : null,
      waypointDist: this.waypoint
        ? Math.round(Math.hypot(this.waypoint.x - p.x, this.waypoint.y - p.y))
        : 0,
    };
    // radio offer refreshed with the HUD — a caravan in range appears on the band live
    uiBridge.set({ hud, radio: this.radioData(), feed: this.feedView() });
  }

  pushStation(): void {
    const d = this.dockTarget;
    if (!d) return;
    const p = this.ships[0];
    const occupied = this.hereOccupied();
    // black market skews both directions: smugglers' goods cheap, stolen cargo paid fat
    const mod = this.priceMods();
    const prices: StationSnapshot["prices"] = {};
    for (const g of GOODS) {
      const base = priceOf(d, g.id);
      prices[g.id] = {
        buy: Math.max(1, Math.round(base * mod.buy)),
        sell: Math.max(1, Math.round(base * ECONOMY.SELL_FACTOR * mod.sell)),
      };
    }
    const station: StationSnapshot = {
      id: d.id,
      name: d.name,
      kindName: d.id === PIRATE_BRANCH.LAIR.id ? "Контрабандистская база"
        : (d.isStation ? "Орбитальная станция · " : "Планета · ") + kindName(d.kind),
      systemProfile: `Система ${this.systemDef.name} · ${this.systemDef.profileName}`,
      occupied,
      eventGood: d.eventGood,
      prices,
      cargo: { ...this.player.cargo },
      cargoUsed: this.cargoUsed(),
      cargoMax: this.cargoMax(),
      credits: Math.round(this.player.credits),
      hull: Math.max(0, Math.round(p.hp)), maxHull: Math.round(p.maxHp),
      repairCost: this.repairCost(),
      reputation: { ...this.player.rep },
      fineCost: this.fineCost(),
      wanted: this.patrolHostile(),
      outlaw: this.player.outlaw,
      pardons: this.player.pardons,
      priceNote: (occupied || d.id === PIRATE_BRANCH.LAIR.id) ? (this.player.rep.clan >= REP.FRIENDLY
        ? "Чёрный рынок: вы здесь «свой» — берут дешевле, платят жирнее"
        : this.player.rep.clan <= REP.UNFRIENDLY
          ? "Чёрный рынок: кланы вам не доверяют — цены впритык"
          : "Чёрный рынок: краденое берут с руками, вопросов не задают")
        : mod.buy < 1 ? "Союзная скидка — Альянс помнит ваши услуги"
        : mod.buy > 1 ? "Враждебные цены — репутация в Альянсе на дне" : null,
      contracts: this.offers.map((o) => ({ id: o.id, kind: o.kind, title: o.title, desc: o.desc, reward: o.reward, timeLimit: o.timeLimit })),
      active: this.contract ? {
        kind: this.contract.kind, title: this.contract.title, desc: this.contract.desc,
        reward: this.contract.reward, done: this.contract.done, need: this.contract.need,
        timeLeft: Math.max(0, Math.ceil(this.contract.timeLeft)),
      } : null,
      fleet: this.fleetSnapshot(d),
    };
    uiBridge.set({ station });
  }

  /** Верфь + лавка модулей для терминала: что продают, чем владею, что могу купить. */
  private fleetSnapshot(d: Dockable) {
    return fleet.fleetSnapshot(this, d);
  }

  /* ================================================================== */
  /* Star chart + waypoints                                              */
  /* ================================================================== */

  /** Seeded static layout of a system (bodies at t=0) for the chart — computed once. */
  private systemLayout(def: SystemDef): Dockable[] {
    let w = this.layoutCache.get(def.id);
    if (!w) {
      w = generateWorld(def.seed, def.priceLevel, def.profileMods, def.id === PIRATE_BRANCH.LAIR_SYSTEM);
      this.layoutCache.set(def.id, w);
    }
    return w;
  }

  /** Gate ring of a system — same deterministic placement enterSystem uses. */
  private gatesFor(def: SystemDef): { to: string; name: string; x: number; y: number }[] {
    const others = SYSTEMS.filter((s) => s.id !== def.id);
    const base = ((def.seed % 360) * Math.PI) / 180;
    return others.map((s, i) => {
      const a = base + (i / others.length) * Math.PI * 2;
      return { to: s.id, name: s.name, x: Math.cos(a) * GATE_CFG.DIST, y: Math.sin(a) * GATE_CFG.DIST };
    });
  }

  /** Snapshot for the chart overlay; pushed while the chart is open (~8 Hz). */
  pushMap(): void {
    const HALF = WORLD_CFG.HALF;
    const obj = this.objectivePos();
    const map: MapSnapshot = {
      systems: SYSTEMS.map((s) => ({
        id: s.id, name: s.name, profile: s.profileName, desc: s.desc, priceLevel: s.priceLevel,
        occupied: this.occ.held && this.occ.systemId === s.id,
        flagship: this.occ.held && this.occ.systemId === s.id && this.occ.flagshipBuilt,
        current: s.id === this.systemDef.id,
        raidEst: this.raidEstFor(s),
      })),
      raid: this.raid ? {
        targetId: this.raid.targetId, timeLeft: Math.max(0, Math.ceil(this.raid.timeLeft)),
        cooldown: Math.max(0, Math.ceil(this.raid.cooldown)), grabbed: this.raid.grabbed.length,
      } : null,
      currentId: this.systemDef.id,
      layouts: SYSTEMS.map((s) => ({
        id: s.id,
        bodies: this.systemLayout(s).map((d) => ({
          id: d.id, x: d.x / HALF, y: d.y / HALF, r: Math.max(0.012, d.radius / HALF),
          // the lair glows purple on the chart like every other clan thing
          c: d.id === PIRATE_BRANCH.LAIR.id ? "#d26aff" : d.isStation ? "#7fd0ff" : "#8fd08f",
          label: d.name, station: d.isStation,
        })),
        gates: this.gatesFor(s).map((g) => ({ x: g.x / HALF, y: g.y / HALF, to: g.to, name: g.name })),
      })),
      ships: [],
      player: { x: 0, y: 0, a: 0 },
      objective: obj ? { x: obj.x / HALF, y: obj.y / HALF, c: obj.c } : null,
      waypoint: this.waypoint
        ? { x: this.waypoint.x / HALF, y: this.waypoint.y / HALF, label: this.waypoint.label }
        : null,
      occ: {
        systemId: this.occ.systemId, held: this.occ.held,
        flagshipBuilt: this.occ.flagshipBuilt, timer: Math.max(0, Math.round(this.occ.t)),
      },
    };
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      map.ships.push({ x: s.x / HALF, y: s.y / HALF, c: this.blipColor(s.faction, s.smuggler) });
    }
    const p = this.ships[0];
    map.player = { x: p.x / HALF, y: p.y / HALF, a: p.angle };
    uiBridge.set({ map });
  }

  private toggleMap(): void {
    if (this.sm.state !== "playing") return;
    this.mapOpen = !this.mapOpen;
    this.pushStatic();
    if (this.mapOpen) this.pushMap();
  }

  private closeMap(): void {
    if (!this.mapOpen) return;
    this.mapOpen = false;
    this.pushStatic();
  }

  setWaypoint(kind: "dockable" | "gate", id: string): void {
    if (this.sm.state !== "playing") return;
    if (kind === "dockable") {
      const d = this.dockables.find((dd) => dd.id === id);
      if (d) this.waypoint = { x: d.x, y: d.y, label: d.name, targetId: d.id };
    } else {
      const g = this.gates.find((gg) => gg.to === id);
      if (g) this.waypoint = { x: g.x, y: g.y, label: `Врата → ${g.name}`, targetId: g.to };
    }
    this.pushHud();
    if (this.mapOpen) this.pushMap();
  }

  private clearWaypoint(): void {
    if (!this.waypoint) return;
    this.waypoint = null;
    this.pushHud();
    if (this.mapOpen) this.pushMap();
  }

  /* ================================================================== */
  /* API for React + boot contract                                       */
  /* ================================================================== */

  private exposeApi(): void {
    const api: GameApi = {
      newGame: () => this.newGame(),
      continueGame: () => this.continueGame(),
      resume: () => { if (this.sm.state === "paused") { this.sm.transition("playing"); this.pushStatic(); } },
      pause: () => { if (this.sm.state === "playing") { this.sm.transition("paused"); this.pushStatic(); } },
      toTitle: () => {
        if (this.sm.state !== "title") {
          this.saveNow();
          this.sm.transition("title");
          uiBridge.set({ station: null, end: null });
          this.pushStatic();
        }
      },
      saveNow: () => this.saveNow(),
      toggleMute: () => { this.audio.toggleMute(); this.pushStatic(); },
      dock: () => this.dock(),
      undock: () => this.undock(),
      jump: () => { if (this.jumpGate && this.sm.state === "playing") this.jumpTo(this.jumpGate.to); },
      setTouchFiring: (v) => this.input.setTouchFiring(v),
      buy: (g, q) => this.buy(g, q),
      sell: (g, q) => this.sell(g, q),
      buyHull: (id) => this.buyHull(id),
      sellHull: () => this.sellHull(),
      buyModule: (id) => this.buyModule(id),
      sellModule: (i) => this.sellModule(i),
      equipModule: (i, cat, slot) => this.equipModule(i, cat, slot),
      unequipModule: (cat, slot) => this.unequipModule(cat, slot),
      repair: () => this.repair(),
      continuePlaying: () => {
        if (this.sm.state === "victory") { this.sm.transition("playing"); uiBridge.set({ end: null }); this.pushStatic(); }
      },
      acceptContract: (id) => this.acceptContract(id),
      cancelContract: () => this.cancelContract(),
      payFine: () => this.payFine(),
      radioBuy: (i, g, q) => { this.radioBuy(i, g, q); },
      radioSell: (i, g, q) => { this.radioSell(i, g, q); },
      getMinimap: () => this.minimapData(),
      getPlayerHeading: () => {
        const p = this.ships[0];
        return { x: p.x / WORLD_CFG.HALF, y: p.y / WORLD_CFG.HALF, a: p.angle };
      },
      toggleMap: () => this.toggleMap(),
      closeMap: () => this.closeMap(),
      setWaypoint: (kind, id) => this.setWaypoint(kind, id),
      clearWaypoint: () => this.clearWaypoint(),
      startRaid: (id) => this.startRaid(id),
    };
    gameApi.current = api;
    // debug bridge for external automation (same contract family as __gameProbe): the live
    // module instances are otherwise unreachable from an injected script's module map
    (window as unknown as Record<string, unknown>).__gameApi = gameApi;
    (window as unknown as Record<string, unknown>).__uiBridge = uiBridge;
    // section profiler for perf work (Этап 4): enable → read rolling per-frame ms report
    const self = this;
    (window as unknown as Record<string, unknown>).__perf = {
      enable: () => { perf.enabled = true; },
      disable: () => { perf.enabled = false; },
      /** spawn n pirates around the player to build a heavy combat scene */
      stress: (n = 12) => {
        const p = this.ships[0];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          this.spawnShip("pirate", p.x + Math.cos(a) * 900, p.y + Math.sin(a) * 900);
        }
      },
      /** one big explosion + shockwave near the player — worst-case fx frame */
      blast: () => {
        const p = this.ships[0];
        this.explosion(p.x + 300, p.y, 80, 460, 0);
        this.shockwave(p.x + 300, p.y, true);
      },
      get report() { return perf.report; },
      get fps() { return perf.fps; },
      get quality() { return self.quality; },
      setQuality: (q: number) => self.setQuality(Math.max(0, Math.min(2, q))),
    };
    // closed-circulation audit (Этап 5a): delta must be 0 — the balance autotest asserts it
    (window as unknown as Record<string, unknown>).__econAudit = () => this.econAudit();
    // clan economy probe (Этап 5c): fund thickness and the pirate strength it can staff;
    // setFund is a non-conserving debug setter for live checks (respects the debt cap)
    (window as unknown as Record<string, unknown>).__pirateEcon = () => ({
      fund: this.pools.clan,
      strength: this.pirateStrength(),
      setFund: (v: number) => { this.pools.clan = Math.max(-PIRATE_ECON.DEBT_LIMIT, Math.min(MONEY_TOTAL, v)); },
    });
    // watch treasury probe (Этап 11b): patrol roster thickness and the cruiser flag;
    // setFund is a non-conserving debug setter for live checks
    (window as unknown as Record<string, unknown>).__patrolEcon = () => {
      const c = this.ships.find((s) => s.active && s.cruiser);
      return {
        fund: this.pools.patrol,
        strength: this.patrolStrength(),
        cruiserUp: !!c,
        cruiser: c ? { hp: c.hp, maxHp: c.maxHp, shield: c.maxShield, name: c.name } : null,
        setFund: (v: number) => { this.pools.patrol = Math.max(0, Math.min(MONEY_TOTAL, v)); },
      };
    };
    // raid operation probe (Этап 5d): read the ops desk, launch, and park the player
    // by a dock (non-simulating teleport for live checks — heist range requires proximity)
    (window as unknown as Record<string, unknown>).__raidOps = {
      get state() {
        const r = self.raid;
        return r ? { targetId: r.targetId, timeLeft: r.timeLeft, cooldown: r.cooldown, grabbed: [...r.grabbed], taken: r.taken } : null;
      },
      start: (id: string) => self.startRaid(id),
      park: (dockableId?: string) => {
        const d = dockableId
          ? self.dockables.find((dd) => dd.id === dockableId)
          : self.dockables.find((dd) => dd.isStation && !(self.raid?.grabbed.includes(dd.id))) ?? self.dockables.find((dd) => dd.isStation);
        if (!d) return null;
        const p = self.ships[0];
        p.x = d.x + d.radius + WORLD_CFG.DOCK_MARGIN * 0.5; p.y = d.y;
        p.vx = 0; p.vy = 0;
        self.camX = p.x; self.camY = p.y;
        return { x: p.x, y: p.y, dock: d.id };
      },
    };
    // time-warp for the economy balance autotest (Этап 5e): run fixed steps headlessly
    // without waiting for rAF. god() makes the idle test player unbreakable (it never
    // fires or trades, so it stays money-neutral); hide() parks it in a far corner so
    // the fleet simulates its own business. step() returns the audit at each checkpoint.
    (window as unknown as Record<string, unknown>).__sim = {
      step: (n: number) => {
        const st = GameLoop.STEP;
        const steps = Math.max(0, Math.min(5000, Math.floor(n)));
        for (let i = 0; i < steps; i++) this.update(st);
        return this.econAudit();
      },
      god: () => {
        const p = this.ships[0];
        p.hp = 1e9; p.maxHp = 1e9; p.shield = 1e6; p.maxShield = 1e6;
      },
      hide: () => {
        const p = this.ships[0];
        p.x = -WORLD_CFG.HALF * 0.92; p.y = -WORLD_CFG.HALF * 0.92;
        p.vx = 0; p.vy = 0;
        self.camX = p.x; self.camY = p.y;
      },
      count: (faction: string) => this.ships.filter((s) => s.active && s.faction === faction).length,
      // jump straight to a system (probe tour of the whole graph), reporting layout + money invariant
      jump: (sysId: string) => {
        self.jumpTo(sysId);
        const a = self.econAudit();
        return {
          sys: self.systemDef.id, gates: self.gates.length, delta: a.delta,
          bodies: self.dockables.length, pirates: self.ships.filter((s) => s.active && s.faction === "pirate").length,
        };
      },
      get playing() { return self.sm.state === "playing"; },
      get docked() { return self.sm.state === "docked"; },
      // who is locked on the player, by side (5f pact checks)
      pirateHunt: () => self.ships.filter((s) => s.active && (s.faction === "pirate" || s.faction === "boss") && s.targetIdx === 0).length,
      patrolHunt: () => self.ships.filter((s) => s.active && s.faction === "patrol" && s.targetIdx === 0).length,
      // kill the first ship of a faction by player hands and park the player on the wreck
      kill: (f: string) => {
        const i = f === "cruiser"
          ? self.ships.findIndex((s) => s.active && s.cruiser)
          : self.ships.findIndex((s, j) => j > 0 && s.active && s.faction === f);
        if (i < 0) return null;
        const at = { x: self.ships[i].x, y: self.ships[i].y };
        self.killShip(i, true);
        const p = self.ships[0];
        p.x = at.x; p.y = at.y; p.vx = 0; p.vy = 0;
        return at;
      },
      // game-feel layer probes: popup/feed counts, a popup at the player, a hull setter for the vignette
      feel: {
        state: () => ({ floaters: this.floaters.length, feed: this.feedView().length }),
        poke: () => { const p = this.ships[0]; this.floater(p.x, p.y, "+₡1234", "#ffd24a"); },
        hull: (v: number) => { const p = this.ships[0]; p.hp = v; },
      },
      // pirate status (5f): read it, or force it on/off without grinding rep by hand
      pirate: () => this.isPirate(),
      wanted: (on: boolean) => {
        if (on) this.player.rep.patrol = Math.min(this.player.rep.patrol, REP.HOSTILE_PATROL);
        else {
          this.player.outlaw = false;
          this.player.rep.patrol = Math.max(this.player.rep.patrol, REP.HOSTILE_PATROL + 1);
        }
        this.syncPirateStatus();
        return this.isPirate();
      },
      // set an exact rep axis (6a probes): clamps like addRep does, resyncs pirate status
      rep: (k: "patrol" | "trader" | "clan", v: number) => {
        this.player.rep[k] = Math.max(REP.MIN, Math.min(REP.MAX, v));
        this.syncPirateStatus();
        return { ...this.player.rep };
      },
      // флот (Этап 7): читать статы фиита, бесплатно сменить корпус, закинуть модуль на склад
      ship: () => {
        const p = this.ships[0];
        return {
          ship: this.player.ship,
          installed: {
            weapon: [...this.player.installed.weapon],
            shield: [...this.player.installed.shield],
            engine: [...this.player.installed.engine],
          },
          stash: [...this.player.stash],
          hp: p.maxHp, shield: p.maxShield, regen: this.shieldRegen(),
          speed: p.maxSpeed, accel: p.accel, cargo: this.cargoMax(),
          dps: this.guns().reduce((s, g) => s + g.dmg * g.shots, 0) * this.gunRate(),
        };
      },
      hull: (id: string) => {
        if (!HULLS.some((h) => h.id === id)) return null;
        this.setShip(id as HullId);
        return this.player.ship;
      },
      give: (itemId: string) => {
        if (!EQUIP[itemId]) return false;
        this.player.stash.push(itemId);
        return true;
      },
      // 7b probes: нейтральная по инварианту накачка денег (станции ↔ игрок),
      // список станций системы и мгновенная стыковка (гейты dock() не обходит)
      cash: (v: number) => {
        const d = Math.round(v - this.player.credits);
        if (d > 0) this.gain(d, "stations");
        else if (d < 0) this.pay(-d, "stations");
        return this.player.credits;
      },
      stations: () => this.dockables.filter((d) => d.isStation).map((d) => ({ id: d.id, kind: d.kind, name: d.name })),
      // трофейные поддоны (Этап 11a): живые пикапы в мире — вид, id, позиция
      pickups: () => this.pickups.filter((pk) => pk.active)
        .map((pk) => ({ kind: pk.kind, goodId: pk.goodId, amount: pk.amount, x: Math.round(pk.x), y: Math.round(pk.y) })),
      // клановые бортники (Этап 8): маршрут/ИИ/кошелёк + не целится ли в них пират
      smugglers: () => this.ships
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i > 0 && s.active && s.smuggler)
        .map(({ s, i }) => ({
          i, ai: s.ai, name: s.name,
          routeId: this.dockables[s.routeTo]?.id ?? null,
          wallet: Math.round(s.wallet), hp: s.hp, maxHp: s.maxHp,
          x: Math.round(s.x), y: Math.round(s.y),
          targetedByPirate: this.ships.some((o, j) => j > 0 && o.active
            && (o.faction === "pirate" || o.faction === "boss") && o.targetIdx === i),
        })),
      dockAt: (id: string) => {
        const d = this.dockables.find((x) => x.isStation && (x.id === id || x.kind === id));
        if (!d) return false;
        if (this.sm.state === "docked") this.undock();
        const p = this.ships[0];
        p.x = d.x; p.y = d.y; p.vx = 0; p.vy = 0;
        this.update(GameLoop.STEP); // проверка дистанции выставит dockTarget
        this.dock();
        return this.sm.state === "docked";
      },
    };
    window.__gameProbe = () => {
      const p = this.ships[0];
      // contract with scripts/verify-game.mjs: W (up-screen, +y world) must decrease probe z
      return { x: p.x, y: 0, z: -p.y };
    };
    // мышиный фокус-фикс (6b-хвост): состояние ввода + счётчик выстрелов для probes
    (window as unknown as Record<string, unknown>).__input = () => ({
      mouseDown: this.input.mouseDown,
      spaceHeld: this.input.spaceHeld,
      touchFiring: this.input.touchFiring,
      firing: this.input.firing,
      shots: this.shotsFired,
      hasFocus: document.hasFocus(),
    });
  }

  private minimapData(): { x: number; y: number; c: string; s: number; o?: 1; w?: 1 }[] {
    const HALF = WORLD_CFG.HALF;
    const out: { x: number; y: number; c: string; s: number; o?: 1; w?: 1 }[] = [];
    out.push({ x: 0, y: 0, c: "#ffb347", s: 6 }); // star
    for (const g of this.gates) {
      out.push({ x: g.x / HALF, y: g.y / HALF, c: "#54ffd2", s: 4 });
    }
    for (const d of this.dockables) {
      out.push({
        x: d.x / HALF, y: d.y / HALF,
        c: d.id === PIRATE_BRANCH.LAIR.id ? "#d26aff" : d.isStation ? "#7fd0ff" : "#8fd08f",
        s: d.isStation ? 3 : 4,
      });
    }
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      if (i === 0) { out.push({ x: s.x / HALF, y: s.y / HALF, c: "#ffffff", s: 4 }); continue; }
      out.push({ x: s.x / HALF, y: s.y / HALF, c: this.blipColor(s.faction, s.smuggler), s: s.faction === "boss" ? 4 : s.cruiser ? 3 : 2 });
    }
    // plotted course ring under the objective marker
    if (this.waypoint) out.push({ x: this.waypoint.x / HALF, y: this.waypoint.y / HALF, c: "#54ffd2", s: 7, w: 1 });
    // mission objective on top: diamond marker the mini-radar points at
    const obj = this.objectivePos();
    if (obj) out.push({ x: obj.x / HALF, y: obj.y / HALF, c: obj.c, s: 6, o: 1 });
    return out;
  }

  /* ================================================================== */
  /* Teardown                                                            */
  /* ================================================================== */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    window.removeEventListener("resize", this.onResizeBound);
    this.input.dispose();
    this.audio.dispose();
    delete window.__gameProbe;
    window.__GAME_READY__ = false;
    gameApi.current = null;
  }
}

/* turn current angle toward target by at most maxStep, shortest way */
function turnToward(cur: number, target: number, maxStep: number): number {
  const diff = ((target - cur + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return cur + Math.sign(diff) * maxStep;
}
