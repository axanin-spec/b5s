/**
 * gl.ts — Этап 12 «2.5D-шуба»: WebGL-слой мира на three.js под той же симуляцией.
 * Отображение мира совпадает с контрактом __gameProbe: точка (wx, wy) → (wx, 0, −wy).
 *
 * 12a давал орто-вид сверху с паритетом 2D; 12b поднимает камеру на наклон ~45°
 * (перспектива): планеты — lambert-сферы с процедурной альбедо-развёрткой, свет идёт
 * от звезды (point light в центре системы — терминатор смотрит на звезду), станции —
 * кольца-торусы со стержнем, врата — плоские тор+горизонт на грунте, орбиты и тепловое
 * кольцо — GL-линии (в наклоне это эллипсы, canvas-круги больше не совпадают).
 * Корабли/болты/пикапы/частицы остаются билборд-спрайтами на тех же CanvasTexture:
 * three батчит спрайты в один draw call, читаемость вида сверху сохраняется.
 * Экранные повороты спрайтов пересчитаны с учётом наклона (world y на экране сжат в
 * sin(pitch) раз). project()/screenToGround() — швы координат для оверлеев и прицела.
 */
import * as THREE from "three";
import { GATE_CFG, WORLD_CFG } from "./config";
import { paletteTex, gatePulse, SHIP_SCALE, type RenderCtx } from "./render";
import { makePlanetAlbedo } from "./textures";
import { perf } from "./perf";

/** Наклон камеры и угол обзора — параметры «режиссёрского» вида 12b. */
const PITCH = Math.PI / 4; // 45°
const FOV = 42;
const CAM_K = 1.35; // запас кадра: наклоне сжимает дальний край, берём окно с запасом

/** Порядок отрисовки спрайтовых слоёв = порядок 2D-проходов. */
const ORDER = { star: 1, pickup: 5, ship: 6, bolt: 7, particle: 8 } as const;
type Cat = keyof typeof ORDER;

const KIND_TINT: Record<string, number> = {
  agri: 0x7fc96a, mine: 0xc98f5a, industry: 0x9aa8c9, science: 0x7fd0d0, hub: 0x7fd0ff,
};

export class Renderer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 10, 40000);
  private raycaster = new THREE.Raycaster();
  private pools = new Map<Cat, THREE.Sprite[]>();
  private texCache = new WeakMap<HTMLCanvasElement | HTMLImageElement, THREE.Texture>();
  private planetTex = new Map<string, THREE.Texture>();
  private ringLines: THREE.Object3D[] = [];
  private bodies = new Map<string, THREE.Object3D>(); // dockable id → 3D-модель
  private gates3d: { group: THREE.Group; frame: THREE.Mesh; horizon: THREE.Mesh }[] = [];
  private ppu = 1;
  private sprites = 0;
  private frameMs = 0;
  private gpu = "unknown";

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer — чтобы пиксельные проверки (scripts/skin-test.mjs) видели кадр
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0); // фон рисует нижний 2D-холст
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) this.gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    // «солнце» системы: точка света в позиции звезды, без затухания — терминатор смотрит на звезду
    const sun = new THREE.PointLight(0xffe9b8, 2.6);
    sun.decay = 0;
    sun.position.set(0, 260, 0);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x35425e, 1.4));
  }

  /** Размер под окно; pxr = dpr×supersample как у 2D-канваса, ppu задаёт мировую шкалу кадров 2D. */
  resize(w: number, h: number, ppu: number, pxr: number): void {
    this.ppu = ppu;
    this.renderer.setPixelRatio(pxr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tex(src: HTMLCanvasElement | HTMLImageElement): THREE.Texture {
    let t = this.texCache.get(src);
    if (!t) {
      t = src instanceof HTMLImageElement ? new THREE.Texture(src) : new THREE.CanvasTexture(src);
      t.colorSpace = THREE.SRGBColorSpace; // round-trip: canvas-цвета как есть
      t.needsUpdate = true;
      this.texCache.set(src, t);
    }
    return t;
  }

  private albedo(kind: string, seed: number): THREE.Texture {
    let t = this.planetTex.get(kind);
    if (!t) {
      t = new THREE.CanvasTexture(makePlanetAlbedo(kind, seed));
      t.colorSpace = THREE.SRGBColorSpace;
      this.planetTex.set(kind, t);
    }
    return t;
  }

  /* ----------------------------- построение мира ----------------------------- */

  /** Орбиты + тепловое кольцо: линии на грунте (в наклоне — эллипсы, canvas-круги совпадают только сверху). */
  private buildRings(c: RenderCtx): void {
    for (const r of this.ringLines) this.scene.remove(r);
    this.ringLines.length = 0;
    const circle = (rad: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * rad, 0, -Math.sin(a) * rad));
      }
      return new THREE.BufferGeometry().setFromPoints(pts);
    };
    for (const d of c.dockables) {
      const m = new THREE.LineBasicMaterial({
        color: d.isStation ? 0x2e5f8f : 0x2a4a66, transparent: true, opacity: d.isStation ? 0.3 : 0.4,
      });
      const l = new THREE.Line(circle(d.orbit), m);
      l.renderOrder = 0;
      this.scene.add(l);
      this.ringLines.push(l);
    }
    const heat = new THREE.Line(circle(WORLD_CFG.STAR_HEAT_RADIUS), new THREE.LineDashedMaterial({
      color: 0xff5433, transparent: true, opacity: 0.45, dashSize: 520, gapSize: 380,
    }));
    heat.computeLineDistances();
    this.scene.add(heat);
    this.ringLines.push(heat);
  }

  private buildBodies(c: RenderCtx): void {
    for (const o of this.bodies.values()) this.scene.remove(o);
    this.bodies.clear();
    const sphere = new THREE.SphereGeometry(1, 24, 16);
    for (const d of c.dockables) {
      if (!d.isStation) {
        const mesh = new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ map: this.albedo(d.kind, d.orbit) }));
        const R = d.radius * 1.05;
        mesh.scale.setScalar(R);
        mesh.position.set(d.x, R, -d.y); // центр шара приподнят: «стоит» на грунте
        this.scene.add(mesh);
        this.bodies.set(d.id, mesh);
        continue;
      }
      const g = new THREE.Group();
      const R = d.radius * 1.3;
      const steel = new THREE.MeshLambertMaterial({ color: 0x4a5878, emissive: 0x0b1420 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.16, 8, 44), steel);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = R * 0.7;
      const core = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.4, R * 0.4, R * 1.25, 16), steel);
      core.position.y = R * 0.62;
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(R * 0.17, 12, 8),
        new THREE.MeshBasicMaterial({ color: KIND_TINT[d.kind] ?? 0x7fd0ff }));
      beacon.position.y = R * 1.35;
      g.add(ring, core, beacon);
      g.position.set(d.x, 0, -d.y);
      this.scene.add(g);
      this.bodies.set(d.id, g);
    }
  }

  private buildGates(c: RenderCtx): void {
    for (const o of this.gates3d) this.scene.remove(o.group);
    this.gates3d = [];
    const R = GATE_CFG.RADIUS;
    for (const g of c.gates) {
      const group = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(R * 2, R * 2),
        new THREE.MeshBasicMaterial({ map: this.tex(c.gateTex), transparent: true, depthWrite: false }));
      frame.rotation.x = -Math.PI / 2;
      frame.position.y = 4;
      const horizon = new THREE.Mesh(new THREE.PlaneGeometry(R * 1.15, R * 1.15),
        new THREE.MeshBasicMaterial({
          map: this.tex(c.gateHorizonTex), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
      horizon.rotation.x = -Math.PI / 2;
      horizon.position.y = 2;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.1, 8, 48),
        new THREE.MeshLambertMaterial({ color: 0x2e6f66, emissive: 0x0d332d }));
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 3;
      group.add(horizon, frame, rim);
      group.position.set(g.x, 0, -g.y);
      this.scene.add(group);
      this.gates3d.push({ group, frame, horizon });
    }
  }

  /* ------------------------------- спрайты -------------------------------- */

  private put(cat: Cat, i: number, wx: number, wy: number, px: number,
    map: THREE.Texture, rot: number, alpha: number, additive: boolean): void {
    let pool = this.pools.get(cat);
    if (!pool) { pool = []; this.pools.set(cat, pool); }
    while (pool.length <= i) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = ORDER[cat];
      this.scene.add(sp);
      pool.push(sp);
    }
    const sp = pool[i];
    sp.visible = true;
    sp.position.set(wx, 1, -wy);
    const k = px / this.ppu; // css-пиксели → мировые единицы (шкала кадра 2D)
    sp.scale.set(k, k, 1);
    const m = sp.material as THREE.SpriteMaterial;
    m.map = map;
    m.rotation = rot;
    m.opacity = alpha;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.sprites++;
  }

  /* -------------------------------- кадр ---------------------------------- */

  frame(c: RenderCtx): void {
    perf.mark("gl");
    const t0 = performance.now();

    // камера: фокус под канвас-центром, наклон PITCH, дистанция под окно H/ppu с запасом
    const span = window.innerHeight / this.ppu;
    const dist = (span * CAM_K) / (2 * Math.tan((FOV * Math.PI / 180) / 2));
    this.camera.position.set(
      c.camSx,
      Math.sin(PITCH) * dist,
      -c.camSy + Math.cos(PITCH) * dist,
    );
    this.camera.lookAt(c.camSx, 0, -c.camSy);
    this.camera.updateMatrixWorld();

    // перестройка геометрии при смене системы (dockables/gates пересоздаются при прыжке)
    if (this.bodies.size !== c.dockables.length) this.buildBodies(c);
    if (this.ringLines.length !== c.dockables.length + 1) this.buildRings(c);
    if (this.gates3d.length !== c.gates.length) this.buildGates(c);

    for (const pool of this.pools.values()) for (const sp of pool) sp.visible = false;
    this.sprites = 0;

    // тела: позиции по орбите обновляет симуляция — модели просто ездят; вращение — из dockSpin
    for (let i = 0; i < c.dockables.length; i++) {
      const d = c.dockables[i];
      c.dockSpin[i] += c.dockSpinVel[i];
      const o = this.bodies.get(d.id);
      if (!o) continue;
      o.position.x = d.x;
      o.position.z = -d.y;
      o.rotation.y = -c.dockSpin[i];
    }
    // врата: рамка и горизонт крутятся на грунте (заводится в плоскости, см. Euler-порядок)
    const gp = gatePulse(c.gateSpin);
    for (let i = 0; i < c.gates.length && i < this.gates3d.length; i++) {
      const { frame: f, horizon: h } = this.gates3d[i];
      f.rotation.z = -c.gateSpin;
      h.rotation.z = c.gateSpin * 0.45;
      (h.material as THREE.MeshBasicMaterial).opacity = 0.9 * (0.92 + 0.08 * gp);
    }

    // звезда — additive-билборд в центре (нижняя половина уходит за горизонт)
    this.put("star", 0, 0, 0, WORLD_CFG.STAR_RADIUS * 5.2 * c.ppu, this.tex(c.starTex), 0, 1, false);

    // пикапы: покачивание — экранный сдвиг вниз → мировое −y
    const t = performance.now() * 0.001;
    let n = 0;
    for (const pk of c.pickups) {
      if (!pk.active) continue;
      this.put("pickup", n++, pk.x, pk.y - Math.sin(t * 2 + pk.amount) * 6, 46 * c.ppu,
        this.tex(pk.kind === "credits" ? c.pickupTex.credits : c.pickupTex.cargo),
        -Math.sin(t * 1.4 + pk.amount) * 0.3, 1, false);
    }

    // корабли: world angle θ на наклонном экране даёт ρ = atan2(sinθ·sinP, cosθ);
    // спрайт крутится против часовой, нос текстуры сверху → rot = ρ − π/2
    const sinP = Math.sin(PITCH);
    for (let i = 0; i < c.ships.length; i++) {
      const s = c.ships[i];
      if (!s.active) continue;
      const texs = s.cruiser ? c.shipTexMap.cruiser : c.shipTexMap[s.faction];
      const rho = Math.atan2(Math.sin(s.angle) * sinP, Math.cos(s.angle));
      this.put("ship", i, s.x, s.y, s.radius * SHIP_SCALE * c.ppu,
        this.tex(texs[texs.length > 1 ? i & 1 : 0]), rho - Math.PI / 2, 1, false);
    }

    let b = 0;
    for (const bo of c.bolts) {
      if (!bo.active) continue;
      this.put("bolt", b++, bo.x, bo.y, (bo.friendly ? 15 : 12) * Math.max(c.ppu, 0.6),
        this.tex(bo.friendly ? c.boltTexPlayer : c.boltTexEnemy), 0, 1, false);
    }

    const pal = paletteTex();
    let pi = 0;
    for (const d of c.particles) {
      if (d.life <= 0) continue;
      const k = d.life / d.maxLife;
      this.put("particle", pi++, d.x, d.y, d.size * (0.5 + k) * Math.max(c.ppu, 0.55),
        this.tex(pal[d.ci]), 0, k, true);
    }

    this.renderer.render(this.scene, this.camera);
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.1; // EMA времени рендера
    perf.mark("fx");
  }

  /* ------------------------------ координаты ------------------------------ */

  /** Мир → экранные css-пиксели (для аннотаций/всплывашек на канвасе ввода). */
  project(wx: number, wy: number): { x: number; y: number } {
    const v = new THREE.Vector3(wx, 1, -wy).project(this.camera);
    return {
      x: (v.x + 1) / 2 * window.innerWidth,
      y: (1 - v.y) / 2 * window.innerHeight,
    };
  }

  /** Экран → точка грунтовой плоскости y=0 (raycast) — прицел 3D-режима. */
  screenToGround(px: number, py: number): { x: number; y: number } {
    const ndc = new THREE.Vector2((px / window.innerWidth) * 2 - 1, -((py / window.innerHeight) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const t = -o.y / (Math.abs(d.y) < 1e-6 ? 1e-6 : d.y);
    return { x: o.x + d.x * t, y: -(o.z + d.z * t) };
  }

  /** Диагностика для probe-скриптов: судьба 3D-моделей тел в сцене. */
  bodiesDbg(): { id: string; type: string; vis: boolean; pos: [number, number, number]; scale: number }[] {
    const out: { id: string; type: string; vis: boolean; pos: [number, number, number]; scale: number }[] = [];
    for (const [id, o] of this.bodies) {
      out.push({ id, type: o.type, vis: o.visible, pos: [o.position.x, o.position.y, o.position.z], scale: o.scale.x });
    }
    return out;
  }

  info(): { sprites: number; drawCalls: number; tris: number; ms: number; gpu: string; cam: [number, number, number] } {
    const c = this.camera.position;
    return {
      sprites: this.sprites,
      drawCalls: this.renderer.info.render.calls,
      tris: this.renderer.info.render.triangles,
      ms: this.frameMs,
      gpu: this.gpu,
      cam: [Math.round(c.x), Math.round(c.y), Math.round(c.z)],
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
