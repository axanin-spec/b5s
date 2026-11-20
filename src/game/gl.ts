/**
 * gl.ts — Этап 12a «2.5D-шуба»: WebGL-скелет мира на three.js под той же симуляцией.
 * Отображение мира совпадает с контрактом __gameProbe: точка (wx, wy) → (wx, 0, −wy).
 * Ортографическая камера строго сверху: видимое окно H/ppu × W/ppu мировых единиц,
 * т.е. 1 единица GL = ppu css-пикселей — визуальный паритет с 2D-режимом.
 * Картинки — те же процедурные CanvasTexture, что у canvas-рендера (кэш по canvas).
 * Спрайты-билборды: повороты пересчитаны из canvas-формул (canvas крутит по часовой,
 * material.rotation — против), аддитивные слои (горизонт врат, частицы) на AdditiveBlending.
 */
import * as THREE from "three";
import { WORLD_CFG } from "./config";
import { paletteTex, bodySizePx, gateSizePx, gatePulse, SHIP_SCALE, type RenderCtx } from "./render";
import { perf } from "./perf";

const CAM_DIST = 2600;

/** Порядок отрисовки слоёв = порядок 2D-проходов (звезда → горизонт → тела → врата → ...). */
const ORDER = { star: 1, horizon: 2, body: 3, gate: 4, pickup: 5, ship: 6, bolt: 7, particle: 8 } as const;
type Cat = keyof typeof ORDER;

export class Renderer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAM_DIST * 2.5);
  private pools = new Map<Cat, THREE.Sprite[]>();
  private texCache = new WeakMap<HTMLCanvasElement | HTMLImageElement, THREE.Texture>();
  private ppu = 1;
  private sprites = 0;

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer — чтобы пиксельные проверки (scripts/skin-test.mjs) видели кадр
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0); // фон рисует нижний 2D-холст
    // up = −z мировой: экранное «вправо» = +x, экранное «вверх» = +y (без зеркал)
    this.camera.up.set(0, 0, -1);
    this.camera.position.set(0, CAM_DIST, 0);
    this.camera.lookAt(0, 0, 0);
  }

  /** Размер под окно; pxr = dpr×supersample как у 2D-канваса, ppu задаёт мировую шкалу. */
  resize(w: number, h: number, ppu: number, pxr: number): void {
    this.ppu = ppu;
    this.renderer.setPixelRatio(pxr);
    this.renderer.setSize(w, h, false);
    const hw = w / ppu / 2, hh = h / ppu / 2;
    this.camera.left = -hw; this.camera.right = hw;
    this.camera.top = hh; this.camera.bottom = -hh;
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

  /** Один спрайт: мировые (wx,wy) → (wx,0,−wy), размер в css-пикселях, rot — против часовой. */
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
    sp.position.set(wx, 0, -wy);
    const k = px / this.ppu;
    sp.scale.set(k, k, 1);
    const m = sp.material as THREE.SpriteMaterial;
    m.map = map;
    m.rotation = rot;
    m.opacity = alpha;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.sprites++;
  }

  /** Кадр мира: пулы спрайтов по тем же данным, что читает canvas-рендер. */
  frame(c: RenderCtx): void {
    perf.mark("gl");
    this.camera.position.x = c.camSx;
    this.camera.position.z = -c.camSy;
    for (const pool of this.pools.values()) for (const sp of pool) sp.visible = false;
    this.sprites = 0;

    // звезда
    this.put("star", 0, 0, 0, WORLD_CFG.STAR_RADIUS * 5.2 * c.ppu, this.tex(c.starTex), 0, 1, false);

    // планеты + станции (GL ведёт их анимацию вращения, в 2D это делает drawBodies)
    for (let i = 0; i < c.dockables.length; i++) {
      const d = c.dockables[i];
      c.dockSpin[i] += c.dockSpinVel[i];
      // canvas: rotate(+φ) по часовой → спрайт: −φ
      this.put("body", i, d.x, d.y, bodySizePx(d, c.ppu), this.tex(c.dockTex[i]), -c.dockSpin[i], 1, false);
    }

    // врата: аддитивный горизонт крутится против рампы, рампа — по часовой (как в 2D)
    const gp = gatePulse(c.gateSpin);
    for (let i = 0; i < c.gates.length; i++) {
      const g = c.gates[i];
      const scale = gateSizePx(c.ppu);
      this.put("horizon", i, g.x, g.y, scale * 0.56 * gp, this.tex(c.gateHorizonTex),
        c.gateSpin * 0.45, 0.9 * (0.92 + 0.08 * gp), true);
      this.put("gate", i, g.x, g.y, scale, this.tex(c.gateTex), -c.gateSpin, 1, false);
    }

    // пикапы: покачивание — экранный сдвиг вниз → мировое −y
    const t = performance.now() * 0.001;
    let n = 0;
    for (const pk of c.pickups) {
      if (!pk.active) continue;
      this.put("pickup", n++, pk.x, pk.y - Math.sin(t * 2 + pk.amount) * 6, 46 * c.ppu,
        this.tex(pk.kind === "credits" ? c.pickupTex.credits : c.pickupTex.cargo),
        -Math.sin(t * 1.4 + pk.amount) * 0.3, 1, false);
    }

    // корабли: нос текстуры «смотрит вверх» → world angle θ = θ − π/2 против часовой
    for (let i = 0; i < c.ships.length; i++) {
      const s = c.ships[i];
      if (!s.active) continue;
      const texs = s.cruiser ? c.shipTexMap.cruiser : c.shipTexMap[s.faction];
      this.put("ship", i, s.x, s.y, s.radius * SHIP_SCALE * c.ppu,
        this.tex(texs[texs.length > 1 ? i & 1 : 0]), s.angle - Math.PI / 2, 1, false);
    }

    // болты
    let b = 0;
    for (const bo of c.bolts) {
      if (!bo.active) continue;
      this.put("bolt", b++, bo.x, bo.y, (bo.friendly ? 15 : 12) * Math.max(c.ppu, 0.6),
        this.tex(bo.friendly ? c.boltTexPlayer : c.boltTexEnemy), 0, 1, false);
    }

    // частицы (аддитивные, как 'lighter' в 2D)
    const pal = paletteTex();
    let pi = 0;
    for (const d of c.particles) {
      if (d.life <= 0) continue;
      const k = d.life / d.maxLife;
      this.put("particle", pi++, d.x, d.y, d.size * (0.5 + k) * Math.max(c.ppu, 0.55),
        this.tex(pal[d.ci]), 0, k, true);
    }

    this.renderer.render(this.scene, this.camera);
    perf.mark("fx");
  }

  info(): { sprites: number; drawCalls: number; tris: number } {
    return {
      sprites: this.sprites,
      drawCalls: this.renderer.info.render.calls,
      tris: this.renderer.info.render.triangles,
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
