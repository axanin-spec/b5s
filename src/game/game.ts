/**
 * game.ts — «Космический Рейнджер»: top-down 2D space sim on a Canvas 2D renderer.
 * World: one star system, 5 planets + 4 stations on live orbits, parallax starfields/nebulas.
 * Systems: trading (living market), combat (pirates/patrols/traders/boss), upgrades, saves.
 * All textures are procedural canvases (textures.ts); all entities live in fixed pools.
 */

import {
  BOLT_CFG, CONTRACTS, CONVOY, ECONOMY, FACTION_CFG, GATE_CFG, GOODS, OCCUPATION, PLAYER_CFG, POPULATION, QUALITY,
  MONEY_TOTAL, POOLS, REPAIR_COST_PER_HP, REP, SAVE_VERSION, AUTOSAVE_INTERVAL, SHIELD_REGEN, SYSTEMS, UPGRADE_DEFS,
  VICTORY_SHARE, WEAPON_RATE, WEAPON_SHOTS, WORLD_CFG,
} from "./config";
import { AudioSystem } from "./audio";
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
import { gameApi, uiBridge, type EndStats, type GameApi, type HudData, type MapSnapshot, type StationSnapshot } from "./uiBridge";
import type { ActiveContract, Bolt, ContractOffer, Dockable, Faction, MoneyPools, OccupationState, Pickup, PlayerState, PoolId, SaveGame, Ship, UpgradeId } from "./types";
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
    routeFrom: 0, routeTo: 0, escortId: -1, raidId: -1, thinkT: 0, trailT: 0, sprite: null,
  };
}

/**
 * Can a bolt fired by `from` damage `target`? Traders never shoot; player may hit anyone.
 * `outlaw` is the patrol-hostility flag: the player shot civilians or their patrol
 * standing dropped to vendetta (REP.HOSTILE_PATROL).
 */
export function canHit(from: Faction, target: Faction, outlaw: boolean): boolean {
  switch (from) {
    case "player": return target !== "player";
    case "pirate":
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

export class Game {
  private ctx: CanvasRenderingContext2D;
  private loop: GameLoop;
  private input: Input;
  private audio = new AudioSystem();
  private sm = new GameStateMachine();
  private disposed = false;

  /* view */
  private ppu = 1;
  private camX = 0; private camY = 0;
  private shake = 0;
  private titleOrbitT = 0;
  private layers: ParallaxLayer[] = [];

  /* world */
  private seed = 1;
  private rnd = mulberry32(1);
  private dockables: Dockable[] = [];
  private dockTex: HTMLCanvasElement[] = [];
  private starTex: HTMLCanvasElement;
  private dockSpin: number[] = [];
  /** Per-dockable spin rate; AI planets bake their terminator, so their art swap freezes it to 0. */
  private dockSpinVel: number[] = [];
  /** Guards async art swaps against a world rebuild (system jump) mid-flight. */
  private worldGen = 0;

  /* entities */
  private ships: Ship[] = [];
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
  private player: PlayerState = Game.freshPlayerState();

  /* timers */
  private econT = ECONOMY.TICK;
  private saveT = AUTOSAVE_INTERVAL;
  private spawnT = 2;
  private hudT = 0;
  private newsT = 0;
  private alarmT = 0;
  private damageFlash = 0;

  private dockTarget: Dockable | null = null;
  private bossIdx = -1;
  private bossEscortsSpawned = false;
  private bgGradient: CanvasGradient | null = null;
  private splashRemoved = false;

  /* star systems + gates */
  private systemDef: SystemDef = SYSTEMS[0];
  private gates: { to: string; name: string; x: number; y: number }[] = [];
  private jumpGate: { to: string; name: string; x: number; y: number } | null = null;
  private gateTex: HTMLCanvasElement;
  /** Event horizon behind the arcs: AI vortex art once it loads, procedural glow until then. */
  private gateHorizonTex: HTMLCanvasElement | HTMLImageElement;
  private gateSpin = 0;
  private jumpGrace = 0;

  /* contracts + faction reputation + raid events */
  private contract: ActiveContract | null = null;
  /** Broker offers generated on docking; empty while a contract is active. */
  private offers: ContractOffer[] = [];
  private contractSeq = 0;
  private raidSeq = 0;
  /** Convoy-raid event currently on the news wire, null = quiet. */
  private convoy: { id: number; t: number; done: number; traderIdx: number } | null = null;
  private convoyT: number = CONVOY.FIRST_DELAY;

  /* pirate occupation front + star chart */
  private occ: OccupationState = {
    systemId: OCCUPATION.START_SYSTEM, held: true, t: OCCUPATION.FLAGSHIP_BUILD, flagshipBuilt: false,
  };
  /** Star chart overlay state — the simulation keeps ticking behind it. */
  private mapOpen = false;
  /** Plotted course in the current system; cleared by a jump. */
  private waypoint: { x: number; y: number; label: string; targetId: string } | null = null;
  /** Static per-system schematics for the chart (seeded, computed once). */
  private layoutCache = new Map<string, Dockable[]>();
  /** Closed money circulation (Этап 5a): Σ pools + player.credits === MONEY_TOTAL at all times. */
  private pools: MoneyPools = { ...POOLS };

  private static freshPlayerState(): PlayerState {
    return {
      credits: PLAYER_CFG.START_CREDITS,
      cargo: {}, upgrades: { engine: 0, hull: 0, shield: 0, weapon: 0, cargo: 0 },
      outlaw: false, pardons: 0, rep: { patrol: 0, trader: 0 },
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
  private newWorld(seed: number, priceLevel = 1, sysMods: Record<string, number> = {}): void {
    this.seed = seed >>> 0;
    this.rnd = mulberry32(this.seed ^ 0x51f7);
    this.dockables = generateWorld(this.seed, priceLevel, sysMods);
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
  private hereOccupied(): boolean {
    return this.occ.held && this.occ.systemId === this.systemDef.id;
  }

  private systemName(id: string): string {
    return SYSTEMS.find((s) => s.id === id)?.name ?? id;
  }

  private enterSystem(systemId: string, arrivalFromId?: string): void {
    this.systemDef = SYSTEMS.find((s) => s.id === systemId) ?? SYSTEMS[0];
    this.audio.setSystem(this.systemDef.id); // crossfade to this system's theme
    this.newWorld(this.systemDef.seed, this.systemDef.priceLevel, this.systemDef.profileMods);
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

  private spawnShip(faction: Faction, x: number, y: number): number {
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
      if (faction === "trader") this.pickTraderRoute(i);
      return i;
    }
    return -1;
  }

  private freeShip(i: number): void {
    this.ships[i].active = false;
    if (this.bossIdx === i) this.bossIdx = -1;
    // drop dangling target references
    for (const s of this.ships) if (s.active && s.targetIdx === i) s.targetIdx = -1;
  }

  private pickTraderRoute(idx: number): void {
    const s = this.ships[idx];
    const n = this.dockables.length;
    let to = Math.floor(this.rnd() * n);
    if (to === s.routeFrom) to = (to + 1) % n;
    s.routeTo = to;
    const d = this.dockables[to];
    s.tx = d.x; s.ty = d.y;
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
      this.spawnShip("pirate", x + Math.cos(ea) * 420, y + Math.sin(ea) * 420);
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

  /** Player volley: WEAPON_SHOTS bolts with a small spread. */
  private playerFire(angle: number): void {
    const lvl = this.player.upgrades.weapon;
    const shots = WEAPON_SHOTS[lvl];
    const dmg = UPGRADE_DEFS[3].levels[lvl].v;
    for (let i = 0; i < shots; i++) {
      const off = shots === 1 ? 0 : (i - (shots - 1) / 2) * 0.09;
      this.fireBolt(0, angle + off, dmg, BOLT_CFG.SPEED);
    }
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
    if (cfg && cfg.bounty[1] > 0) {
      const amount = Math.round(cfg.bounty[0] + this.rnd() * (cfg.bounty[1] - cfg.bounty[0]));
      const src: PoolId = s.faction === "trader" ? "alliance" : s.faction === "patrol" ? "patrol" : "clan";
      this.spawnPickup("credits", "", amount, s.x, s.y, src);
    }
    if (s.faction === "trader" || (s.faction === "pirate" && this.rnd() < 0.4)) {
      const pods = s.faction === "trader" ? 2 : 1;
      for (let i = 0; i < pods; i++) {
        const g = GOODS[Math.floor(this.rnd() * GOODS.length)];
        this.spawnPickup("cargo", g.id, 2 + Math.floor(this.rnd() * 6), s.x + (this.rnd() - 0.5) * 160, s.y + (this.rnd() - 0.5) * 160);
      }
    }

    if (byPlayer) {
      this.player.kills += s.faction === "pirate" ? 1 : 0;
      // faction standings: order kept by killing pirates, chaos punished by killing civilians
      if (s.faction === "pirate") {
        this.addRep(REP.KILL.pirate);
        // wanted rangers buy back trust with pirate heads — the hunt ends when the quota fills
        if (this.patrolHostile()) {
          this.player.pardons += 1;
          if (this.player.pardons >= REP.PARDON_KILLS) {
            this.player.outlaw = false;
            this.player.pardons = 0;
            // the atonement program wipes the slate: vendetta is forgiven along with the flag
            if (this.player.rep.patrol <= REP.HOSTILE_PATROL) this.player.rep.patrol = REP.HOSTILE_PATROL + 1;
            this.setNews(`Патруль снял розыск: ${REP.PARDON_KILLS} голов пиратов зачтены как искупление`);
            this.audio.sfx("pickup");
          }
        }
      } else if (s.faction === "trader") this.addRep(REP.KILL.trader);
      else if (s.faction === "patrol") this.addRep(REP.KILL.patrol);
    }
    // scripted-event bookkeeping runs regardless of who pulled the trigger
    if (this.convoy) {
      if (idx === this.convoy.traderIdx) {
        this.endConvoy(false, "Конвой разбит — рейдеры уходят с добычей.");
      } else if (byPlayer && s.faction === "pirate" && s.raidId === this.convoy.id) {
        this.convoy.done++;
        if (this.convoy.done >= CONVOY.NEED) this.endConvoy(true, "Рейдеры обратились в бегство, конвой спасён!");
      }
    }
    if (this.contract) {
      if (this.contract.kind === "hunt" && byPlayer && s.faction === "pirate") {
        this.contract.done++;
        if (this.contract.done >= this.contract.need) this.completeContract("все цели ликвидированы");
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

  private spawnPickup(kind: "credits" | "cargo", goodId: string, amount: number, x: number, y: number, src: PoolId = "clan"): void {
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

  private upgradeVal(id: UpgradeId): number {
    const line = UPGRADE_DEFS.find((l) => l.id === id)!;
    return line.levels[this.player.upgrades[id]].v;
  }

  private cargoMax(): number { return this.upgradeVal("cargo"); }
  private maxHull(): number { return this.upgradeVal("hull"); }
  private maxShield(): number { return this.upgradeVal("shield"); }
  private cargoUsed(): number {
    let n = 0;
    for (const g of GOODS) n += this.player.cargo[g.id] ?? 0;
    return n;
  }

  private applyPlayerStats(): void {
    const p = this.ships[0];
    const eng = this.upgradeVal("engine");
    p.accel = PLAYER_CFG.BASE_ACCEL * eng;
    p.maxSpeed = PLAYER_CFG.BASE_MAX_SPEED * eng;
    p.maxHp = this.maxHull();
    p.maxShield = this.maxShield();
    this.rebuildPlayerTex();
  }

  /** The Ranger's silhouette grows pods/plates/emitters/nozzles as its upgrade lines level up. */
  private rebuildPlayerTex(): void {
    const u = this.player.upgrades;
    this.shipTexMap.player = [makeShipTexture("player", 0, {
      weapon: u.weapon ?? 0, hull: u.hull ?? 0, shield: u.shield ?? 0, engine: u.engine ?? 0,
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
  }

  private spawnInitialPopulation(): void {
    const pirates = POPULATION.PIRATES + this.systemDef.pirateBoost + (this.hereOccupied() ? OCCUPATION.PIRATE_EXTRA : 0);
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
  }

  newGame(): void {
    this.clearEntities();
    this.player = Game.freshPlayerState();
    this.occ = { systemId: OCCUPATION.START_SYSTEM, held: true, t: OCCUPATION.FLAGSHIP_BUILD, flagshipBuilt: false };
    this.pools = { ...POOLS };
    this.waypoint = null;
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
    this.player.upgrades = { ...save.player.upgrades };
    this.player.outlaw = save.player.outlaw;
    this.player.pardons = save.player.pardons;
    this.player.rep = { ...save.player.rep };
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
    this.enterSystem(save.system);
    // restore an in-progress hunt/transport contract (escorts do not survive a reload)
    if (save.contract) {
      const sc = save.contract;
      this.contract = { ...sc, timeLimit: sc.timeLeft, escortIdx: -1 };
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
        upgrades: { ...this.player.upgrades },
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
      pools: { ...this.pools },
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
  private gain(n: number, pool: PoolId): number {
    const paid = Math.max(0, Math.min(Math.round(n), Math.round(this.pools[pool])));
    this.pools[pool] -= paid;
    this.player.credits += paid;
    return paid;
  }

  /** Spend player credits into a treasury — the mirror of gain(). */
  private pay(n: number, pool: PoolId): void {
    const spent = Math.round(n);
    this.player.credits -= spent;
    this.pools[pool] += spent;
  }

  /** Treasury a docked trade runs through: smuggler cash in an occupied system, civilian capital elsewhere. */
  private tradePool(): PoolId {
    return this.dockTarget && this.hereOccupied() ? "clan" : "stations";
  }

  /** Player's share of the galaxy's fixed credit mass (0..1) — the economic victory meter. */
  sharePct(): number {
    return this.player.credits / MONEY_TOTAL;
  }

  /** Debug/QA: the closed-circulation invariant. delta must stay 0 — see the balance autotest. */
  econAudit(): { total: number; player: number; pools: MoneyPools; delta: number } {
    const sum = this.pools.patrol + this.pools.alliance + this.pools.clan + this.pools.stations;
    const player = Math.round(this.player.credits);
    return { total: MONEY_TOTAL, player, pools: { ...this.pools }, delta: sum + player - MONEY_TOTAL };
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

  private setNews(text: string): void {
    uiBridge.set({ news: text });
    this.newsT = 14;
  }

  /* ================================================================== */
  /* Docking / trade / upgrades                                          */
  /* ================================================================== */

  dock(): void {
    if (this.sm.state !== "playing" || !this.dockTarget) return;
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
   */
  private priceMods(): { buy: number; sell: number } {
    const tm = this.tradeMod();
    return this.dockTarget && this.hereOccupied()
      ? { buy: tm.buy * OCCUPATION.BLACK.buy, sell: tm.sell * OCCUPATION.BLACK.sell }
      : tm;
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
    this.audio.sfx("credits");
    this.pushStation();
    this.pushHud();
  }

  upgrade(id: string): void {
    if (this.sm.state !== "docked") return;
    const line = UPGRADE_DEFS.find((l) => l.id === id);
    if (!line) return;
    const lvl = this.player.upgrades[id as UpgradeId];
    if (lvl >= line.levels.length - 1) return;
    const cost = line.levels[lvl + 1].cost;
    if (this.player.credits < cost) return;
    this.pay(cost, "stations"); // the shipyards run on station capital
    this.player.upgrades[id as UpgradeId] = lvl + 1;
    this.applyPlayerStats();
    if (id === "shield") this.ships[0].shield = this.ships[0].maxShield;
    if (id === "hull") this.ships[0].hp = Math.min(this.ships[0].hp + 50, this.ships[0].maxHp);
    this.audio.sfx("upgrade");
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  repair(): void {
    if (this.sm.state !== "docked") return;
    const p = this.ships[0];
    const missing = Math.ceil(p.maxHp - p.hp);
    if (missing <= 0) return;
    const cost = missing * REPAIR_COST_PER_HP;
    if (this.player.credits < cost) return;
    this.pay(cost, "stations");
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

  private addRep(d: { patrol?: number; trader?: number }): void {
    const r = this.player.rep;
    if (d.patrol) r.patrol = Math.max(REP.MIN, Math.min(REP.MAX, r.patrol + d.patrol));
    if (d.trader) r.trader = Math.max(REP.MIN, Math.min(REP.MAX, r.trader + d.trader));
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
    this.player.outlaw = false;
    this.player.pardons = 0;
    this.audio.sfx("trade");
    this.setNews(`Штраф ₡${cost.toLocaleString("ru-RU")} уплачен — розыск снят, патруль больше не считает вас врагом.`);
    this.saveNow();
    this.pushStation();
    this.pushHud();
  }

  /** Alliance standing bends prices: allies discount, enemies gouge. */
  private tradeMod(): { buy: number; sell: number } {
    if (this.player.rep.trader >= REP.FRIENDLY) return REP.PRICE_FRIENDLY;
    if (this.player.rep.trader <= REP.UNFRIENDLY) return REP.PRICE_UNFRIENDLY;
    return { buy: 1, sell: 1 };
  }

  /** One offer of each kind per docking; the broker restocks every undock. */
  private genOffers(here: Dockable): void {
    this.offers = [];
    // no licensed brokers in pirate space — the board is dead until liberation
    if (this.hereOccupied()) return;
    const others = this.dockables.filter((d) => d.id !== here.id);
    if (others.length === 0) return;
    const jit = (base: number) => Math.round((base * (1 + (this.rnd() * 2 - 1) * CONTRACTS.JITTER)) / 50) * 50;
    const boost = 1 + this.systemDef.pirateBoost * 0.2;

    const n = 4 + Math.floor(this.rnd() * 3);
    this.offers.push({
      id: ++this.contractSeq, kind: "hunt",
      title: "Охота на пиратов",
      desc: `Уничтожить ${n} пиратов в системе ${this.systemDef.name}.`,
      reward: jit((650 + 140 * n) * boost), timeLimit: CONTRACTS.TIME_HUNT,
      need: n, goodId: "", qty: 0, destId: "", destName: "",
    });

    const dest = others[Math.floor(this.rnd() * others.length)];
    const g = GOODS[Math.floor(this.rnd() * GOODS.length)];
    const qty = 6 + Math.floor(this.rnd() * 7);
    this.offers.push({
      id: ++this.contractSeq, kind: "transport",
      title: "Курьерский рейс",
      desc: `Передать запечатанный контейнер (${qty} ед. «${goodName(g.id)}»). Пункт назначения: ${dest.name}. Трюм не занимает.`,
      reward: jit(900 + qty * 95), timeLimit: CONTRACTS.TIME_TRANSPORT,
      need: 1, goodId: g.id, qty, destId: dest.id, destName: dest.name,
    });

    const dest2 = others[Math.floor(this.rnd() * others.length)];
    const callsign = `${CONTRACTS.CALLSIGNS[Math.floor(this.rnd() * CONTRACTS.CALLSIGNS.length)]}-${2 + Math.floor(this.rnd() * 8)}`;
    this.offers.push({
      id: ++this.contractSeq, kind: "escort",
      title: "Эскорт транспорта",
      desc: `Сопроводить транспорт «${callsign}». Пункт назначения: ${dest2.name}. Собьют его — контракт провален.`,
      reward: jit(1150), timeLimit: CONTRACTS.TIME_ESCORT,
      need: 1, goodId: "", qty: 0, destId: dest2.id, destName: dest2.name,
    });
  }

  acceptContract(id: number): void {
    if (this.sm.state !== "docked" || this.contract) return;
    const off = this.offers.find((o) => o.id === id);
    if (!off) return;
    this.offers = this.offers.filter((o) => o.id !== id);
    const c: ActiveContract = { ...off, timeLeft: off.timeLimit, done: 0, escortIdx: -1 };
    if (off.kind === "escort") {
      const here = this.dockTarget;
      const destIdx = this.dockables.findIndex((d) => d.id === off.destId);
      if (here && destIdx >= 0) {
        const idx = this.spawnShip("trader", here.x + 240, here.y + 140);
        if (idx >= 0) {
          const s = this.ships[idx];
          s.routeFrom = this.dockables.indexOf(here);
          s.routeTo = destIdx;
          s.tx = this.dockables[destIdx].x; s.ty = this.dockables[destIdx].y;
          s.escortId = off.id;
          c.escortIdx = idx;
        }
      }
    }
    this.contract = c;
    this.audio.sfx("trade");
    this.setNews(`Контракт принят: ${off.title}. Награда ₡${off.reward.toLocaleString("ru-RU")}.`);
    this.pushStation();
    this.pushHud();
  }

  cancelContract(): void {
    if (!this.contract) return;
    const ei = this.contract.escortIdx;
    if (ei >= 0 && this.ships[ei].active && this.ships[ei].escortId === this.contract.id) {
      this.ships[ei].escortId = -1; // the escorted trader goes back to its own routes
    }
    this.contract = null;
    this.setNews("Контракт отменён.");
    if (this.sm.state === "docked" && this.dockTarget) this.genOffers(this.dockTarget);
    this.pushStation();
    this.pushHud();
  }

  private completeContract(reason: string): void {
    const c = this.contract;
    if (!c) return;
    this.contract = null;
    const paid = this.gain(c.reward, "alliance"); // contract money comes out of the Alliance fund
    this.player.earned += paid;
    this.addRep(CONTRACTS.REP[c.kind]);
    this.audio.sfx("credits");
    this.setNews(`Контракт выполнен: ${c.title} — ${reason}. +₡${paid.toLocaleString("ru-RU")}`);
    if (this.sm.state === "docked" && this.dockTarget) this.genOffers(this.dockTarget);
    this.pushStation();
    this.pushHud();
    this.saveNow();
  }

  private failContract(reason: string): void {
    if (!this.contract) return;
    const ei = this.contract.escortIdx;
    if (ei >= 0 && this.ships[ei].active) this.ships[ei].escortId = -1;
    this.contract = null;
    this.setNews(`Контракт провален: ${reason}.`);
    this.pushStation();
    this.pushHud();
  }

  private spawnConvoyEvent(): void {
    const di = Math.floor(this.rnd() * this.dockables.length);
    const d = this.dockables[di];
    const id = ++this.raidSeq;
    const trader = this.spawnShip("trader", d.x + 160, d.y + 120);
    if (trader < 0) { this.convoyT = 25; return; } // pool full — retry soon
    this.ships[trader].raidId = id;
    this.ships[trader].routeFrom = di;
    this.pickTraderRoute(trader);
    for (let k = 0; k < CONVOY.RAIDERS; k++) {
      const a = this.rnd() * Math.PI * 2;
      const p = this.spawnShip("pirate", d.x + Math.cos(a) * 620, d.y + Math.sin(a) * 620);
      if (p >= 0) this.ships[p].raidId = id;
    }
    this.convoy = { id, t: CONVOY.WINDOW, done: 0, traderIdx: trader };
    this.setNews(`ПЕРЕХВАТ: пираты атакуют конвой у ${d.name}! Сбейте ${CONVOY.NEED} рейдеров за ${Math.round(CONVOY.WINDOW)} с.`);
    this.audio.sfx("alarm");
  }

  private endConvoy(win: boolean, reason: string): void {
    if (!this.convoy) return;
    const id = this.convoy.id;
    this.convoy = null;
    for (const s of this.ships) if (s.active && s.raidId === id) s.raidId = -1; // survivors go back to ordinary piracy
    if (win) {
      const paid = this.gain(CONVOY.REWARD, "alliance");
      this.player.earned += paid;
      this.addRep(CONVOY.REP);
      this.audio.sfx("credits");
      this.setNews(`${reason} Торговый альянс платит ₡${paid}.`);
    } else {
      this.setNews(reason);
    }
    this.pushHud();
  }

  private updateContracts(dt: number): void {
    if (this.contract) {
      this.contract.timeLeft -= dt;
      if (this.contract.timeLeft <= 0) this.failContract("время вышло");
    }
    if (this.convoy) {
      this.convoy.t -= dt;
      if (this.convoy.t <= 0) this.endConvoy(false, "Рейдеры растворились в поясе астероидов — конвой спасён, но награды не будет.");
    } else {
      this.convoyT -= dt;
      if (this.convoyT <= 0) {
        this.convoyT = CONVOY.PERIOD_MIN + this.rnd() * (CONVOY.PERIOD_MAX - CONVOY.PERIOD_MIN);
        this.spawnConvoyEvent();
      }
    }
  }

  /** HUD one-liner for the active contract / raid, with distance to the objective. */
  private missionLine(): string | null {
    const fmtT = (sec: number) => {
      const s = Math.max(0, Math.ceil(sec));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    let base: string | null = null;
    if (this.contract) {
      const c = this.contract;
      base = c.kind === "hunt"
        ? `КОНТРАКТ · Охота ${c.done}/${c.need} · ${fmtT(c.timeLeft)}`
        : `КОНТРАКТ · ${c.kind === "transport" ? "Доставка" : "Эскорт"} → ${c.destName} · ${fmtT(c.timeLeft)}`;
    } else if (this.convoy) {
      base = `ТРЕВОГА · Конвой: рейдеры ${this.convoy.done}/${CONVOY.NEED} · ${fmtT(this.convoy.t)}`;
    }
    if (!base) return null;
    const obj = this.objectivePos();
    if (obj) {
      const p = this.ships[0];
      const dist = Math.hypot(obj.x - p.x, obj.y - p.y);
      base += ` · ${(dist / 1000).toFixed(1)}k`;
    }
    return base;
  }

  /** Where the mini-radar should point: contract target or the nearest live raider. */
  private objectivePos(): { x: number; y: number; c: string } | null {
    const p = this.ships[0];
    if (this.contract) {
      const c = this.contract;
      if (c.kind === "hunt") {
        let best: Ship | null = null, bd = Infinity;
        for (let i = 1; i < MAX_SHIPS; i++) {
          const s = this.ships[i];
          if (!s.active || s.faction !== "pirate") continue;
          const dd = Math.hypot(s.x - p.x, s.y - p.y);
          if (dd < bd) { bd = dd; best = s; }
        }
        return best ? { x: best.x, y: best.y, c: "#ff5a4a" } : null;
      }
      if (c.kind === "escort") {
        const s = c.escortIdx >= 0 ? this.ships[c.escortIdx] : null;
        if (s && s.active) return { x: s.x, y: s.y, c: "#ffb347" };
      }
      const d = this.dockables.find((dd) => dd.id === c.destId);
      return d ? { x: d.x, y: d.y, c: "#ffb347" } : null;
    }
    if (this.convoy) {
      let best: Ship | null = null, bd = Infinity;
      for (let i = 1; i < MAX_SHIPS; i++) {
        const s = this.ships[i];
        if (!s.active || s.faction !== "pirate" || s.raidId !== this.convoy.id) continue;
        const tough = s.hp + s.shield;
        if (tough < bd) { bd = tough; best = s; }
      }
      return best ? { x: best.x, y: best.y, c: "#ff5a4a" } : null;
    }
    return null;
  }

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
      p.shield = Math.min(p.maxShield, p.shield + SHIELD_REGEN[this.player.upgrades.shield] * dt);
    }

    /* ---- player fire ---- */
    p.fireCooldown -= dt;
    if (this.input.firing && p.fireCooldown <= 0) {
      const aim = this.aimAngle() ?? p.angle;
      this.playerFire(aim);
      p.fireCooldown = 1 / WEAPON_RATE[this.player.upgrades.weapon];
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
    if (!this.occ.held) {
      this.occ.t -= dt;
      if (this.occ.t > 0) return;
      const cands = SYSTEMS.filter((s) => s.id !== this.occ.systemId);
      const pick = cands[Math.floor(this.rnd() * cands.length)];
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

  private maintainPopulation(): void {
    let pirates = 0, patrols = 0, traders = 0;
    for (let i = 1; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      if (s.faction === "pirate") pirates++;
      else if (s.faction === "patrol") patrols++;
      else if (s.faction === "trader") traders++;
    }
    const pirateCap = POPULATION.PIRATES + this.systemDef.pirateBoost + (this.hereOccupied() ? OCCUPATION.PIRATE_EXTRA : 0);
    if (pirates < pirateCap) this.spawnAtEdge("pirate");
    if (!this.hereOccupied() && patrols < POPULATION.PATROLS) this.spawnAtEdge("patrol");
    if (traders < POPULATION.TRADERS) this.spawnAtEdge("trader");
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

      /* think (staggered) */
      s.thinkT -= dt;
      if (s.thinkT <= 0) {
        s.thinkT = 0.3 + this.rnd() * 0.25;
        this.think(i);
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

      // keep NPCs inside the world; fleeing pirates may leave (despawn)
      if (Math.abs(s.x) > HALF * 1.25 || Math.abs(s.y) > HALF * 1.25) {
        if (s.faction === "pirate" && s.ai === AiState.Flee) { this.freeShip(i); continue; }
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
          if (td < range && canHit(s.faction, t.faction, this.patrolHostile())) {
            const aim = Math.atan2(t.y - s.y, t.x - s.x) + (this.rnd() - 0.5) * 0.12;
            this.fireBolt(i, aim, s.dmg, BOLT_CFG.SPEED * 0.82);
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
          this.spawnShip("pirate", s.x + 260, s.y);
          this.spawnShip("pirate", s.x - 260, s.y);
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

  private think(i: number): void {
    const s = this.ships[i];
    const p = this.ships[0];
    const HALF = WORLD_CFG.HALF;

    if (s.faction === "trader") {
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
        this.pickTraderRoute(i);
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
        s.wanderT -= 0.4;
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
    // low hull → run for the edge of the system
    if (s.hp < s.maxHp * 0.28 && s.ai !== AiState.Flee) {
      s.ai = AiState.Flee;
      const a = Math.atan2(s.y, s.x) + (this.rnd() - 0.5);
      s.tx = Math.cos(a) * HALF * 1.4;
      s.ty = Math.sin(a) * HALF * 1.4;
      s.targetIdx = -1;
    }
    if (s.ai === AiState.Flee) return;

    // pick target: player in range, else nearest trader, else wander
    let best = -1, bestD: number = FACTION_CFG.pirate.aggro;
    if (p.active) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      const playerHeat = this.player.kills >= 3 ? 1.5 : 1; // notorious rangers attract pirates
      if (d < bestD * playerHeat) { best = 0; bestD = d; }
    }
    for (let j = 1; j < MAX_SHIPS; j++) {
      const o = this.ships[j];
      if (!o.active || (o.faction !== "trader" && o.faction !== "patrol")) continue;
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
      s.wanderT -= 0.4;
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
        if (!canHit(b.from, s.faction, outlaw)) continue;
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
          pk.active = false;
        } else if (this.cargoUsed() < this.cargoMax()) {
          this.player.cargo[pk.goodId] = (this.player.cargo[pk.goodId] ?? 0) + pk.amount;
          this.audio.sfx("pickup");
          pk.active = false;
        } // else: hold full — leave the pod floating
      }
    }
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
      const texs = this.shipTexMap[s.faction];
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

  private pushHud(): void {
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
      dockName: this.dockTarget && this.sm.state === "playing" ? this.dockTarget.name : null,
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
    uiBridge.set({ hud });
  }

  private pushStation(): void {
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
      kindName: (d.isStation ? "Орбитальная станция · " : "Планета · ") + kindName(d.kind),
      systemProfile: `Система ${this.systemDef.name} · ${this.systemDef.profileName}`,
      occupied,
      eventGood: d.eventGood,
      prices,
      cargo: { ...this.player.cargo },
      cargoUsed: this.cargoUsed(),
      cargoMax: this.cargoMax(),
      credits: Math.round(this.player.credits),
      hull: Math.max(0, Math.round(p.hp)), maxHull: Math.round(p.maxHp),
      repairCost: Math.ceil(p.maxHp - p.hp) * REPAIR_COST_PER_HP,
      reputation: { ...this.player.rep },
      fineCost: this.fineCost(),
      wanted: this.patrolHostile(),
      outlaw: this.player.outlaw,
      pardons: this.player.pardons,
      priceNote: occupied ? "Чёрный рынок: краденое берут с руками, вопросов не задают"
        : mod.buy < 1 ? "Союзная скидка — Альянс помнит ваши услуги"
        : mod.buy > 1 ? "Враждебные цены — репутация в Альянсе на дне" : null,
      contracts: this.offers.map((o) => ({ id: o.id, kind: o.kind, title: o.title, desc: o.desc, reward: o.reward, timeLimit: o.timeLimit })),
      active: this.contract ? {
        kind: this.contract.kind, title: this.contract.title, desc: this.contract.desc,
        reward: this.contract.reward, done: this.contract.done, need: this.contract.need,
        timeLeft: Math.max(0, Math.ceil(this.contract.timeLeft)),
      } : null,
      upgrades: UPGRADE_DEFS.map((line) => {
        const lvl = this.player.upgrades[line.id as UpgradeId];
        const maxLevel = line.levels.length - 1;
        const next = lvl < maxLevel ? line.levels[lvl + 1] : null;
        return {
          id: line.id, name: line.name, desc: line.desc,
          level: lvl, maxLevel,
          nextCost: next ? next.cost : null,
          canAfford: next ? this.player.credits >= next.cost : false,
          nextValue: next ? next.v : null,
        };
      }),
    };
    uiBridge.set({ station });
  }

  /* ================================================================== */
  /* Star chart + waypoints                                              */
  /* ================================================================== */

  /** Seeded static layout of a system (bodies at t=0) for the chart — computed once. */
  private systemLayout(def: SystemDef): Dockable[] {
    let w = this.layoutCache.get(def.id);
    if (!w) {
      w = generateWorld(def.seed, def.priceLevel, def.profileMods);
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
  private pushMap(): void {
    const HALF = WORLD_CFG.HALF;
    const obj = this.objectivePos();
    const map: MapSnapshot = {
      systems: SYSTEMS.map((s) => ({
        id: s.id, name: s.name, profile: s.profileName, desc: s.desc, priceLevel: s.priceLevel,
        occupied: this.occ.held && this.occ.systemId === s.id,
        flagship: this.occ.held && this.occ.systemId === s.id && this.occ.flagshipBuilt,
        current: s.id === this.systemDef.id,
      })),
      currentId: this.systemDef.id,
      layouts: SYSTEMS.map((s) => ({
        id: s.id,
        bodies: this.systemLayout(s).map((d) => ({
          id: d.id, x: d.x / HALF, y: d.y / HALF, r: Math.max(0.012, d.radius / HALF),
          c: d.isStation ? "#7fd0ff" : "#8fd08f", label: d.name, station: d.isStation,
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
      const c = s.faction === "pirate" ? "#ff5a4a" : s.faction === "boss" ? "#d26aff" : s.faction === "patrol" ? "#5a9fff" : "#ffd24a";
      map.ships.push({ x: s.x / HALF, y: s.y / HALF, c });
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
      upgrade: (id) => this.upgrade(id),
      repair: () => this.repair(),
      continuePlaying: () => {
        if (this.sm.state === "victory") { this.sm.transition("playing"); uiBridge.set({ end: null }); this.pushStatic(); }
      },
      acceptContract: (id) => this.acceptContract(id),
      cancelContract: () => this.cancelContract(),
      payFine: () => this.payFine(),
      getMinimap: () => this.minimapData(),
      getPlayerHeading: () => {
        const p = this.ships[0];
        return { x: p.x / WORLD_CFG.HALF, y: p.y / WORLD_CFG.HALF, a: p.angle };
      },
      toggleMap: () => this.toggleMap(),
      closeMap: () => this.closeMap(),
      setWaypoint: (kind, id) => this.setWaypoint(kind, id),
      clearWaypoint: () => this.clearWaypoint(),
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
    window.__gameProbe = () => {
      const p = this.ships[0];
      // contract with scripts/verify-game.mjs: W (up-screen, +y world) must decrease probe z
      return { x: p.x, y: 0, z: -p.y };
    };
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
        c: d.isStation ? "#7fd0ff" : "#8fd08f",
        s: d.isStation ? 3 : 4,
      });
    }
    for (let i = 0; i < MAX_SHIPS; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      if (i === 0) { out.push({ x: s.x / HALF, y: s.y / HALF, c: "#ffffff", s: 4 }); continue; }
      const c = s.faction === "pirate" ? "#ff5a4a" : s.faction === "boss" ? "#d26aff" : s.faction === "patrol" ? "#5a9fff" : "#ffd24a";
      out.push({ x: s.x / HALF, y: s.y / HALF, c, s: s.faction === "boss" ? 4 : 2 });
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
