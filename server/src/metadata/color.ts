/**
 * Picks a cloth colour for a book's spine from its cover, so the shelf matches the covers.
 * Uses the cover's left edge (where the spine meets the cover), toned down a little so
 * spine text stays readable. Needs @napi-rs/canvas; returns null without it.
 */
export async function spineColorFromCover(data: Buffer): Promise<string | null> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(data);
    const w = 24;
    const h = 48;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    // Weight the left third (the spine side) twice as much as the rest of the cover.
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3]! < 128) continue;
        const k = x < w / 3 ? 2 : 1;
        r += px[i]! * k;
        g += px[i + 1]! * k;
        b += px[i + 2]! * k;
        n += k;
      }
    }
    if (!n) return null;
    return tone([r / n, g / n, b / n]);
  } catch {
    return null;
  }
}

/** Keeps colours in a cloth-like range: no pure white or black, no neon. */
function tone([r, g, b]: number[]): string {
  const max = Math.max(r!, g!, b!) / 255;
  const min = Math.min(r!, g!, b!) / 255;
  let l = (max + min) / 2;
  const d = max - min;
  let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) {
    const [R, G, B] = [r! / 255, g! / 255, b! / 255];
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue *= 60;
  }
  s = Math.min(s, 0.55);
  l = Math.min(Math.max(l, 0.16), 0.86);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [a, bb, cc] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(a)}${hex(bb)}${hex(cc)}`;
}
