// Draws the app icons (porcelain wall, three cloth-bound books on a ledge, light from above)
// into web/public/icons. (`dark` draws the dark-room variant, for when platforms support it.) Run with `node scripts/make-icons.mjs` after changing the design.
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const out = path.join(import.meta.dirname, "../web/public/icons");
fs.mkdirSync(out, { recursive: true });

/** `pad` shrinks the artwork into the safe zone for maskable icons. */
function draw(size, { pad = 0, dark = false } = {}) {
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const s = size / 512;

  // Porcelain wall, lit from above.
  const wall = g.createLinearGradient(0, 0, 0, size);
  wall.addColorStop(0, dark ? "#262a31" : "#ffffff");
  wall.addColorStop(1, dark ? "#15171b" : "#ebe8e1");
  g.fillStyle = wall;
  g.fillRect(0, 0, size, size);

  g.save();
  const k = 1 - pad * 2;
  g.translate(size * pad, size * pad);
  g.scale(s * k, s * k);

  // Soft pool of light on the wall.
  const glow = g.createRadialGradient(256, 150, 10, 256, 150, 300);
  glow.addColorStop(0, dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.9)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 512, 512);

  const ledgeY = 388;
  // Shadow under the books.
  g.fillStyle = dark ? "rgba(0,0,0,0.45)" : "rgba(40,35,25,0.16)";
  g.beginPath();
  g.ellipse(256, ledgeY + 6, 150, 14, 0, 0, Math.PI * 2);
  g.fill();

  const book = (x, w, h, color, band, lean = 0) => {
    g.save();
    g.translate(x + w / 2, ledgeY);
    g.rotate((lean * Math.PI) / 180);
    const body = g.createLinearGradient(-w / 2, 0, w / 2, 0);
    body.addColorStop(0, shade(color, -0.18));
    body.addColorStop(0.35, color);
    body.addColorStop(1, shade(color, -0.28));
    g.fillStyle = body;
    roundRect(g, -w / 2, -h, w, h, 8);
    g.fill();
    // Top edge catching the light.
    g.fillStyle = "rgba(255,255,255,0.22)";
    roundRect(g, -w / 2, -h, w, 6, 3);
    g.fill();
    // Gilt bands on the spine.
    g.fillStyle = band;
    g.fillRect(-w / 2 + 8, -h + 30, w - 16, 5);
    g.fillRect(-w / 2 + 8, -h + 42, w - 16, 2.5);
    g.fillRect(-w / 2 + 8, -34, w - 16, 5);
    g.restore();
  };
  book(150, 56, 250, "#1f3354", "#c9a96a");
  book(212, 52, 280, "#7a2630", "#d9b878");
  book(286, 62, 236, "#234a37", "#c9a96a", 9);

  // The ledge.
  const ledge = g.createLinearGradient(0, ledgeY, 0, ledgeY + 26);
  ledge.addColorStop(0, dark ? "#3a3f48" : "#ffffff");
  ledge.addColorStop(1, dark ? "#23262c" : "#dedad1");
  g.fillStyle = ledge;
  roundRect(g, 96, ledgeY, 320, 22, 6);
  g.fill();
  g.restore();
  return c.toBuffer("image/png");
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v + v * amt)));
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

const files = {
  "icon-192.png": draw(192),
  "icon-512.png": draw(512),
  "icon-maskable-512.png": draw(512, { pad: 0.1 }),
  "apple-touch-icon.png": draw(180),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(out, name), data);
console.log("wrote", Object.keys(files).join(", "));
