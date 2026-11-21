/**
 * gl.ts — Этап 12 «2.5D-шуба»: WebGL-слой мира на three.js под той же симуляцией.
 * Отображение мира совпадает с контрактом __gameProbe: точка (wx, wy) → (wx, 0, −wy).
 *
 * 12a давал орто-вид сверху с паритетом 2D; 12b поднимает камеру на наклон ~45°
 * (перспектива): планеты — lambert-сферы с процедурной альбедо-развёрткой, свет идёт
 * от звезды (point light в центре системы — терминатор смотрит на звезду), станции —
 * кольца-торусы со стержнем, врата — плоские тор+горизонт на грунте, орбиты и тепловое
 * кольцо — GL-линии (в наклоне это эллипсы, canvas-круги больше не совпадают).
 * Корабли/болты/пикапы остаются билборд-спрайтами на тех же CanvasTexture:
 * three батчит спрайты в один draw call, читаемость вида сверху сохраняется.
 * Экранные повороты спрайтов пересчитаны с учётом наклона (world y на экране сжат в
 * sin(pitch) раз). project()/screenToGround() — швы координат для оверлеев и прицела.
 *
 * 12c «эффекты»: болты получают трассеры (аддитивные плоскости на грунте по направлению
 * полёта), частицы/взрывы уходят со спрайтов в один THREE.Points (per-point размер/цвет/
 * альфа через шейдер — вспышки выстрелов это те же частицы), ударные волны взрывов —
 * аддитивные кольца на грунте, попадания кораблей — красный scale/color-пульс спрайта.
 * Небо 3D-режима переезжает из 2D-фона сюда: слои параллакса (звёзды) — Points-группы
 * детьми камеры на глубине SKY_Z с экранной раскладкой (s−cam·f)·ppu — та же формула
 * параллакса, что у 2D; туманности — большие additive/normal-плоскости в тех же слоях.
 */
import * as THREE from "three";
import { GATE_CFG, PICKUP, WORLD_CFG } from "./config";
import { PALETTE_RGB, gatePulse, SHIP_SCALE, type RenderCtx } from "./render";
import { makeGlowTexture, makePlanetAlbedo, makeShockTexture, makeStreakTexture } from "./textures";
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

/* ------------------------------- 12c-слой ------------------------------- */

/** Глубина «экранного неба» (12c): слои — дети камеры на z=−SKY_Z в её локальных осях.
 *  В наклоне 45° верх кадра смотрит на грунт (ось взгляда −45°, FOV 42°), поэтому
 *  мировое «небо над камерой» в кадр не попадает — параллакс живёт в экранном пространстве,
 *  точная копия 2D-формулы (s − cam·f)·ppu: группа слоя = scale(k·ppu) + сдвиг −cam·f·k·ppu.
 *  20000 — дальше всех планет, поэтому звёзды корректно прячутся за тела. */
const SKY_Z = 20000;
/** Трассер: длина/толщина в мировых единицах (длина растёт со скоростью болта). */
const TRACER_THICK = 9;

/** Квадрат, уложенный на грунт (длинная ось = мировой +x при scale.x) — трассеры и ударные волны. */
const GROUND_QUAD = new THREE.PlaneGeometry(1, 1);
GROUND_QUAD.rotateX(-Math.PI / 2);
/** Юнит-квадрат в осях камеры (лицом к экрану) — туманности экранного неба (12c). */
const SKY_QUAD = new THREE.PlaneGeometry(1, 1);

/** Шейдер точечных слоёв (12c): per-point размер/цвет/альфа. uAtt=1 — мировая величина
 *  с перспективным сжатием (частицы), uAtt=0 — постоянные пиксели (звёзды параллакса). */
const POINT_VERT = `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uAtt;
uniform float uScale;
uniform float uPx;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float ps = mix(aSize * uPx, aSize * uScale / max(1.0, -mv.z), uAtt);
  gl_PointSize = clamp(ps, 1.0, 256.0);
  gl_Position = projectionMatrix * mv;
}`;
const POINT_FRAG = `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

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
  private pxr = 1;
  private sprites = 0;
  private frameMs = 0;
  private gpu = "unknown";
  /* 12c: трассеры/ударные волны/частицы-Points/небо */
  private tracerP: THREE.Mesh[] = [];
  private tracerE: THREE.Mesh[] = [];
  private shocks: THREE.Mesh[] = [];
  private tracerMatP: THREE.MeshBasicMaterial;
  private tracerMatE: THREE.MeshBasicMaterial;
  private tracerN = 0;
  private shockN = 0;
  private dotTex: THREE.CanvasTexture;
  private points: THREE.Points | null = null;
  private pointsN = 0;
  private skyLayers: { group: THREE.Group; f: number; near: boolean; stars: THREE.Points | null }[] = [];
  private nebMats: { mesh: THREE.Mesh; neb: { tex: CanvasImageSource; additive?: boolean }; decoded: boolean }[] = [];
  private starCount = 0;
  private dbSize = new THREE.Vector2();

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
    // 12c: материалы трассеров (свой цвет на сторону) и мягкая точка для Part-слоёв
    const streak = new THREE.CanvasTexture(makeStreakTexture());
    streak.colorSpace = THREE.SRGBColorSpace;
    this.tracerMatP = new THREE.MeshBasicMaterial({
      map: streak, color: 0x54ffd2, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.tracerMatE = new THREE.MeshBasicMaterial({
      map: streak, color: 0xff9c54, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.dotTex = new THREE.CanvasTexture(makeGlowTexture());
    this.dotTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.add(this.camera); // 12c: слои неба — дети камеры (экранное пространство)
  }

  /** Размер под окно; pxr = dpr×supersample как у 2D-канваса, ppu задаёт мировую шкалу кадров 2D. */
  resize(w: number, h: number, ppu: number, pxr: number): void {
    this.ppu = ppu;
    this.pxr = pxr;
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

  /** Небо 12c: каждый ParallaxLayer — группа-ребёнок камеры на z=−SKY_Z; локальные координаты
   *  = сырые s из слоя, экранная раскладка (масштаб k·ppu и сдвиг −cam·f) — в трансформе группы
   *  (updateSky). Звёзды — Points (пиксельный размер), туманности — плоскости лицом к камере. */
  private buildSky(c: RenderCtx): void {
    const rgba = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/;
    for (const layer of c.layers) {
      if (!layer.stars.length && !layer.nebulas.length) continue;
      const group = new THREE.Group();
      let stars: THREE.Points | null = null;
      if (layer.stars.length) {
        const n = layer.stars.length;
        const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
        const sz = new Float32Array(n), al = new Float32Array(n);
        layer.stars.forEach((s, i) => {
          pos[i * 3] = s.x; pos[i * 3 + 1] = s.y; pos[i * 3 + 2] = 0; // плоскость экрана
          const m = rgba.exec(s.c);
          if (m) {
            col[i * 3] = +m[1] / 255; col[i * 3 + 1] = +m[2] / 255; col[i * 3 + 2] = +m[3] / 255;
            al[i] = +m[4];
          } else al[i] = 1;
          sz[i] = s.r * 1.4; // 2D рисовал квадрат r×r css — точка чуть крупнее того же «зрительного веса»
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
        g.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
        g.setAttribute("aAlpha", new THREE.BufferAttribute(al, 1));
        stars = new THREE.Points(g, new THREE.ShaderMaterial({
          uniforms: { uMap: { value: this.dotTex }, uAtt: { value: 0 }, uScale: { value: 1 }, uPx: { value: this.pxr } },
          vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
          transparent: true, depthWrite: false, // NormalBlending — как source-over у 2D-звёзд
        }));
        stars.frustumCulled = false;
        stars.renderOrder = -5;
        group.add(stars);
        this.starCount += n;
      }
      for (const neb of layer.nebulas) {
        const mat = new THREE.MeshBasicMaterial({
          map: this.tex(neb.tex as HTMLCanvasElement), transparent: true,
          opacity: neb.additive ? 0.35 : 0.95,
          blending: neb.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(SKY_QUAD, mat);
        mesh.scale.setScalar(neb.scale); // ×масштаб группы → ровно neb.scale·ppu css-пикселей, как в 2D
        mesh.position.set(neb.x, neb.y, 0);
        mesh.renderOrder = -6; // туманности за звёздами
        group.add(mesh);
        this.nebMats.push({ mesh, neb, decoded: false });
      }
      this.camera.add(group); // экранное пространство: небо едет вместе с камерой
      this.skyLayers.push({ group, f: layer.f, near: layer.f >= 0.3, stars });
    }
  }

  /** Обновление неба в кадре: экранная раскладка слоя (масштаб k·ppu и сдвиг −cam·f·k·ppu —
   *  в точности 2D-формула (s−cam·f)·ppu), качество (tier2 роняет слои f≥0.3, как 2D),
   *  поздняя подмена AI-текстур туманностей (img грузится асинхронно). */
  private updateSky(c: RenderCtx): void {
    if (!this.skyLayers.length) this.buildSky(c);
    this.renderer.getDrawingBufferSize(this.dbSize);
    // сколько камерных единиц на css-пиксель приходится на глубине SKY_Z
    const k = (2 * SKY_Z * Math.tan((FOV * Math.PI / 180) / 2)) / window.innerHeight;
    for (const L of this.skyLayers) {
      L.group.visible = !(c.quality >= 2 && L.near);
      L.group.scale.set(k * c.ppu, k * c.ppu, 1);
      L.group.position.set(-c.camSx * L.f * k * c.ppu, -c.camSy * L.f * k * c.ppu, -SKY_Z);
      if (L.stars) (L.stars.material as THREE.ShaderMaterial).uniforms.uPx.value = this.pxr;
    }
    for (const n of this.nebMats) {
      const mat = n.mesh.material as THREE.MeshBasicMaterial;
      const src = n.neb.tex; // game при летней загрузке AI-арта подменяет canvas на img прямо в слое
      if (mat.map?.image !== src) {
        const t = this.tex(src as HTMLCanvasElement | HTMLImageElement);
        t.needsUpdate = true;
        mat.map = t;
        mat.blending = n.neb.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        mat.opacity = n.neb.additive ? 0.35 : 0.95;
        n.decoded = !!(t.image as HTMLImageElement)?.complete;
      } else if (src instanceof HTMLImageElement && src.complete && !n.decoded) {
        mat.map!.needsUpdate = true; // кадр залился до декодирования картинки — перезалить
        n.decoded = true;
      }
    }
  }

  /** Частицы (взрывы/выстрелы) — ОДИН THREE.Points с per-point размером/цветом/альфой. */
  private ensurePoints(cap: number): void {
    if (this.points) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(cap), 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(cap), 1));
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.dotTex }, uAtt: { value: 1 }, uScale: { value: 500 }, uPx: { value: this.pxr } },
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = ORDER.particle;
    this.scene.add(this.points);
  }

  private fillPoints(c: RenderCtx): void {
    this.ensurePoints(c.particles.length);
    const p = this.points!;
    const pos = (p.geometry.getAttribute("position") as THREE.BufferAttribute);
    const col = (p.geometry.getAttribute("aColor") as THREE.BufferAttribute);
    const sz = (p.geometry.getAttribute("aSize") as THREE.BufferAttribute);
    const al = (p.geometry.getAttribute("aAlpha") as THREE.BufferAttribute);
    const u = (p.material as THREE.ShaderMaterial).uniforms;
    u.uPx.value = this.pxr;
    u.uScale.value = this.dbSize.y / 2 / Math.tan((FOV * Math.PI / 180) / 2);
    let n = 0;
    for (const d of c.particles) {
      if (d.life <= 0) continue;
      const k = d.life / d.maxLife;
      const i3 = n * 3;
      pos.array[i3] = d.x; pos.array[i3 + 1] = 1.5; pos.array[i3 + 2] = -d.y;
      const ci3 = d.ci * 3;
      col.array[i3] = PALETTE_RGB[ci3]; col.array[i3 + 1] = PALETTE_RGB[ci3 + 1]; col.array[i3 + 2] = PALETTE_RGB[ci3 + 2];
      sz.array[n] = (d.size * (0.5 + k) * Math.max(c.ppu, 0.55)) / this.ppu; // css-px → мировые (как спрайты)
      al.array[n] = k;
      n++;
    }
    p.geometry.setDrawRange(0, n);
    pos.needsUpdate = col.needsUpdate = sz.needsUpdate = al.needsUpdate = true;
    this.pointsN = n;
  }

  /** Пул плоскостей на грунте (трассеры/ударные волны): следующий свободный слот. */
  private nextGround(pool: THREE.Mesh[], i: number, mat: THREE.Material | null, order: number): THREE.Mesh {
    while (pool.length <= i) {
      const m = new THREE.Mesh(GROUND_QUAD,
        mat ?? new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(makeShockTexture()), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.visible = false;
      m.renderOrder = order;
      this.scene.add(m);
      pool.push(m);
    }
    const m = pool[i];
    m.visible = true;
    return m;
  }

  /* ------------------------------- спрайты -------------------------------- */

  /** tint>0 — красный импульс попадания (12c): G/B компоненты материала приглушены, R горит. */
  private put(cat: Cat, i: number, wx: number, wy: number, px: number,
    map: THREE.Texture, rot: number, alpha: number, additive: boolean, tint = 0): void {
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
    m.color.setRGB(1, 1 - 0.5 * tint, 1 - 0.55 * tint);
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
    for (const pool of [this.tracerP, this.tracerE, this.shocks]) for (const m of pool) m.visible = false;

    // небо 12c: параллакс-слои Points + туманности, привязаны к камере со сдвигом (1−f)
    this.updateSky(c);

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

    // пикапы: покачивание — экранный сдвиг вниз → мировое −y; мигание на исходе TTL (14e)
    const t = performance.now() * 0.001;
    let n = 0;
    for (const pk of c.pickups) {
      if (!pk.active) continue;
      const blink = pk.life < PICKUP.BLINK ? 0.3 + 0.7 * Math.abs(Math.sin(t * 6)) : 1;
      this.put("pickup", n++, pk.x, pk.y - Math.sin(t * 2 + pk.amount) * 6, 46 * c.ppu,
        this.tex(pk.kind === "credits" ? c.pickupTex.credits : c.pickupTex.cargo),
        -Math.sin(t * 1.4 + pk.amount) * 0.3, blink, false);
    }

    // корабли: world angle θ на наклонном экране даёт ρ = atan2(sinθ·sinP, cosθ);
    // спрайт крутится против часовой, нос текстуры сверху → rot = ρ − π/2
    const sinP = Math.sin(PITCH);
    for (let i = 0; i < c.ships.length; i++) {
      const s = c.ships[i];
      if (!s.active) continue;
      const texs = s.cruiser ? c.shipTexMap.cruiser : c.shipTexMap[s.faction];
      const rho = Math.atan2(Math.sin(s.angle) * sinP, Math.cos(s.angle));
      // 12c: emissive-пульс попадания — короткий подъём масштаба + красная вспышка цвета
      const hk = s.sinceHit < 0.3 ? 1 - s.sinceHit / 0.3 : 0;
      this.put("ship", i, s.x, s.y, s.radius * SHIP_SCALE * c.ppu * (1 + 0.18 * hk),
        this.tex(texs[texs.length > 1 ? i & 1 : 0]), rho - Math.PI / 2, 1, false, hk);
    }

    // болты + трассеры 12c: аддитивная полоса на грунте назад по направлению полёта
    let b = 0, tpn = 0, ten = 0;
    for (const bo of c.bolts) {
      if (!bo.active) continue;
      this.put("bolt", b++, bo.x, bo.y, (bo.friendly ? 15 : 12) * Math.max(c.ppu, 0.6),
        this.tex(bo.friendly ? c.boltTexPlayer : c.boltTexEnemy), 0, 1, false);
      const spd = Math.hypot(bo.vx, bo.vy) || 1;
      const len = Math.min(170, Math.max(48, spd * 0.17));
      const i = bo.friendly ? tpn++ : ten++;
      const m = this.nextGround(bo.friendly ? this.tracerP : this.tracerE, i,
        bo.friendly ? this.tracerMatP : this.tracerMatE, 6.5);
      m.position.set(bo.x - (bo.vx / spd) * len * 0.35, 7, -(bo.y - (bo.vy / spd) * len * 0.35));
      m.rotation.y = Math.atan2(bo.vy, bo.vx);
      m.scale.set(len, 1, TRACER_THICK);
    }
    this.tracerN = tpn + ten;

    // частицы/взрывы/вспышки выстрелов — один Points (12c); ударные волны — кольца на грунте
    this.fillPoints(c);
    let rg = 0;
    for (const r of c.rings) {
      if (r.life <= 0) continue;
      const k = Math.max(0, r.life / r.maxLife);
      const m = this.nextGround(this.shocks, rg++, null, 9);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(r.hot ? 0xffbe78 : 0xffebbe);
      mat.opacity = Math.min(1, k * 1.3) * 0.85;
      const side = r.r / 0.21; // пик яркости текстуры кольца — на 0.21 стороны
      m.position.set(r.x, 6, -r.y);
      m.scale.set(side, 1, side);
    }
    this.shockN = rg;

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

  info(): {
    sprites: number; drawCalls: number; tris: number; ms: number; gpu: string;
    cam: [number, number, number]; tracers: number; shocks: number; points: number; stars: number;
  } {
    const c = this.camera.position;
    return {
      sprites: this.sprites,
      drawCalls: this.renderer.info.render.calls,
      tris: this.renderer.info.render.triangles,
      ms: this.frameMs,
      gpu: this.gpu,
      cam: [Math.round(c.x), Math.round(c.y), Math.round(c.z)],
      tracers: this.tracerN, shocks: this.shockN, points: this.pointsN, stars: this.starCount,
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
