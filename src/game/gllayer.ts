/**
 * gllayer.ts — менеджер WebGL-слоя («шуба» three.js под той же симуляцией), Этап 13f
 * (спилено из game.ts по конвенции 9e/9a): разрешение режима, ленивая загрузка чанка
 * three, вставка холстов, автооткат при потере GL-контекста. В game.ts остались
 * тонкие обёртки (enable3d/disable3d/applyRender/screenToWorld) и геттер renderMode.
 * ВАЖНО: менеджер нельзя переложить в gl.ts — тот модуль и есть ленивый чанк (three);
 * game.ts знает его только через `import type`. Здесь тоже только типовые импорты
 * и динамический `import("./gl")` — в 2D-режиме three не качается.
 */
import type { Renderer3D } from "./gl";
import type { RenderPref } from "./settings";

export type RenderMode = "2d" | "3d";

/** Минимальная поверхность Game, нужная слою: куда вставлять холсты, ресайз, новости, флаг смерти. */
export interface GlHost {
  /** Канвас ввода: под него вставляются bg (фон) и gl (мир); весь мышиный ввод остаётся верхним. */
  readonly canvas: HTMLCanvasElement;
  /** Игра уничтожена, пока чанк three грузился, — слой больше не нужен. */
  readonly disposed: boolean;
  /** Задать размеры обоих новых холстов под текущие dpr/ppu. */
  onResize(): void;
  setNews(text: string): void;
}

export class GlLayer {
  mode: RenderMode = "2d";
  gl3d: Renderer3D | null = null;
  bgCanvas: HTMLCanvasElement | null = null; // 2D-фон кадра — в bgCtx, пока gl3d режет мир
  bgCtx: CanvasRenderingContext2D | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  // 12d: three тянется лениво (dynamic import) — в 2D-режиме асинхронный чанк не грузится;
  // failed — контекст WebGL терялся в этой сессии, больше не пробуем (до перезагрузки).
  private glMod: typeof import("./gl") | null = null;
  private glLoading: Promise<boolean> | null = null;
  private failed = false;

  constructor(private readonly host: GlHost) {}

  /** Cheap WebGL2 capability probe without loading three (тот же тест, что «auto» в настройках). */
  static hasWebGL2(): boolean {
    try {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null;
    } catch {
      return false;
    }
  }

  /** Настройка → конкретный режим; «auto» = 3d при WebGL2 (12d: дефолт — 3d на GPU-браузерах). */
  resolve(pref: RenderPref): RenderMode {
    if (pref === "2d") return "2d";
    if (pref === "3d") return "3d";
    return GlLayer.hasWebGL2() && !this.failed ? "3d" : "2d";
  }

  /** Загрузить модуль gl (three) одним обещанием; false при сетевой ошибке чанка. */
  load(): Promise<boolean> {
    if (this.glMod) return Promise.resolve(true);
    if (!this.glLoading) {
      this.glLoading = import("./gl").then(
        (m) => { this.glMod = m; return true; },
        () => false,
      );
    }
    return this.glLoading;
  }

  /** Реакция на настройку render (boot + onSettingsChange): применить режим немедленно. */
  apply(pref: RenderPref): void {
    if (this.resolve(pref) === "3d") void this.enable();
    else this.disable();
  }

  /**
   * Включить WebGL-слой. Под канвас ввода вставляются ещё два холста: нижний — 2D-фон,
   * средний — GL-мир; весь мышиный ввод остаётся на #game-canvas (он остался верхним).
   * 12d: ждёт dynamic-импорт three; false — если WebGL недоступен/чанк не загрузился
   * (игра продолжает в 2D). Потеря GL-контекста → автооткат в 2D (webglcontextlost).
   */
  async enable(): Promise<boolean> {
    if (this.mode === "3d") return true;
    if (this.failed || !(await this.load())) return false;
    if (this.host.disposed) return false; // игра умерла, пока грузился чанк
    // после await параллельный enable() мог всё сделать — перечитываем поле мимо сужения TS
    if ((this.mode as RenderMode) === "3d") return true; // пока грузили, включил другой вызов
    const mod = this.glMod;
    if (!mod) return false;
    if (!this.gl3d) {
      try {
        const css = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
        const bg = document.createElement("canvas");
        bg.id = "bg-canvas";
        bg.style.cssText = css;
        const bgCtx = bg.getContext("2d");
        if (!bgCtx) return false;
        const glc = document.createElement("canvas");
        glc.id = "gl-canvas";
        glc.style.cssText = css;
        this.bgCanvas = bg;
        this.bgCtx = bgCtx;
        this.gl3d = new mod.Renderer3D(glc);
        glc.addEventListener("webglcontextlost", this.onContextLost);
        this.glCanvas = glc;
        const parent = this.host.canvas.parentElement ?? document.body;
        parent.insertBefore(bg, this.host.canvas);
        parent.insertBefore(glc, this.host.canvas);
        this.host.onResize(); // задает размеры обоих новых холстов под текущий dpr/ppu
      } catch {
        this.disable();
        return false;
      }
    }
    this.mode = "3d";
    return true;
  }

  /** Драйвер/вкладка потеряли GL-контекст: preventDefault даёт шанс на restore, но мы
   * просто откатываемся в 2D и до перезагрузки 3d больше не пробуем (глочить цикл падений). */
  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.failed = true;
    this.disable();
    this.host.setNews("Контекст WebGL потерян — включён режим 2D. Перезагрузите страницу для повтора 3D.");
  };

  /** Отключить слой: уволить рендерер, снять холсты-«шубы» и слушателя контекста. */
  disable(): void {
    this.mode = "2d";
    if (this.glCanvas) this.glCanvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.gl3d?.dispose();
    this.gl3d = null;
    this.glCanvas?.remove();
    this.glCanvas = null;
    this.bgCanvas?.remove();
    this.bgCanvas = null;
    this.bgCtx = null;
  }
}
