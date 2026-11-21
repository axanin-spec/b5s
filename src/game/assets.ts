/**
 * assets.ts — async AI-art loader (public/assets/).
 * Procedural textures stay as the boot fallback; every art slot swaps in when its
 * PNG arrives, so the game never blocks on art and degrades silently when offline.
 */

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(url);
  if (!p) {
    p = new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null); // missing art → caller keeps the procedural fallback
      im.src = url;
    });
    imgCache.set(url, p);
  }
  return p;
}

/** Детерминированный выбор арт-варианта системы (Этап 10e): половина систем рисует батч "_b". */
export function planetVariant(systemId: string): "" | "_b" {
  let h = 0;
  for (let i = 0; i < systemId.length; i++) h = (h * 31 + systemId.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? "_b" : "";
}

/** PNG → canvas, обрезанный кругом: доки рендерятся circular-спрайтами, чёрные углы арта закрыли бы звёзды. */
async function loadMaskedSprite(url: string): Promise<HTMLCanvasElement | null> {
  const img = await loadImage(url);
  if (!img) return null;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
  ctx.clip();
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
  ctx.restore();
  return c;
}

/**
 * Планета → masked-спрайт. `variant` (Этап 10e) берёт второй батч арта ("_b"), чтобы системы
 * с одинаковыми наборами планет не выглядели клонированными; нет варианта → null, вызывающий
 * возвращает базовый батч или процедурный фолбэк.
 */
export function loadPlanetTexture(kind: string, variant = ""): Promise<HTMLCanvasElement | null> {
  return loadMaskedSprite(`assets/planets/${kind}${variant}.png`);
}

/** Станция → masked-спрайт (Этап 13): hub/industry/mine/science (+батч "_b") и пиратская "lair". */
export function loadStationTexture(kind: string, variant = ""): Promise<HTMLCanvasElement | null> {
  return loadMaskedSprite(`assets/stations/${kind}${variant}.png`);
}
