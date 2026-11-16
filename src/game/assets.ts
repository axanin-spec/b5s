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

/** Planet art PNG → circle-masked canvas (dockables render as circular sprites; the art's black corners would cover the starfield). */
export async function loadPlanetTexture(kind: string): Promise<HTMLCanvasElement | null> {
  const img = await loadImage(`assets/planets/${kind}.png`);
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
