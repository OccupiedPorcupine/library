import type { Book } from "./api";
import { hash } from "./color";

/**
 * Spine geometry and typography, worked out per book so that thick books look thick
 * and every title fits its spine (like the spines on hft.md/quant-books).
 */

/** Rough bytes per page by format, for books whose page count isn't known yet. */
const BYTES_PER_PAGE: Record<string, number> = {
  txt: 1800,
  md: 1800,
  fb2: 2600,
  epub: 2400,
  mobi: 2600,
  azw: 2600,
  azw3: 2600,
  pdf: 55_000,
  cbz: 350_000,
};

/** Page count if known, else an estimate from file size, else a stable per-book guess. */
export function pagesOf(book: Book): number {
  if (book.pageCount && book.pageCount > 0) return book.pageCount;
  const bpp = BYTES_PER_PAGE[book.format];
  // Tiny files (and anything unusual) say nothing useful about length.
  if (bpp && book.size > 40_000) return Math.min(1500, Math.max(40, Math.round(book.size / bpp)));
  return 160 + (hash(book.id) % 9) * 55;
}

/** Spine thickness in px at a 360px-tall shelf: grows with the square root of the page count. */
export function spineWidth(pages: number, scale: number): number {
  return Math.round(Math.min(84, Math.max(26, 20 + Math.sqrt(pages) * 1.9)) * scale);
}

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Width of `text` at 1px in the given font, cached. */
function measure(text: string, family: string, weight: number, upper = false, tracking = 0): number {
  const key = `${weight}|${family}|${upper}|${tracking}|${text}`;
  let w = widths.get(key);
  if (w !== undefined) return w;
  if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const t = upper ? text.toUpperCase() : text;
  if (ctx) {
    ctx.font = `${weight} 100px ${family}`;
    w = ctx.measureText(t).width / 100;
  } else w = t.length * 0.55;
  w += t.length * tracking;
  widths.set(key, w);
  return w;
}

let sans: string | undefined;
/** The app's sans stack, read lazily so the stylesheet has loaded. */
const SANS = () => (sans ??= getComputedFont("--font-sans", 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'));

function getComputedFont(v: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback;
}

export interface SpineType {
  /** Title size in px. */
  ts: number;
  /** Author size in px. */
  as: number;
}

/**
 * Largest title and author sizes that fit a spine. Vertical text runs along the spine's
 * height; when one column isn't enough the title wraps into more columns across the width.
 */
export function fitSpine(title: string, author: string | null, ws: number, height: number): SpineType {
  const band = Math.min(26, Math.max(18, height * 0.07));
  // Author: one column, capped at a third of the spine.
  let as = 0;
  let authorLen = 0;
  if (author) {
    const per = measure(author, SANS(), 600, true, 0.12);
    as = Math.min(9.5, Math.max(6.5, ws * 0.22));
    while (as > 6.5 && per * as > height * 0.32) as -= 0.25;
    authorLen = Math.min(per * as, height * 0.32) + 10;
  }
  const room = height - band - 10 - 6 - authorLen - 8;
  const across = ws - 10;
  const per = measure(title, SANS(), 700);
  let ts = Math.min(22, Math.max(11, ws * 0.36));
  for (; ts > 8.5; ts -= 0.25) {
    const cols = Math.max(1, Math.floor(across / (ts * 1.12)));
    // Words break between columns, so leave a little slack per column.
    if (per * ts <= cols * room * 0.9) break;
  }
  return { ts: Math.round(ts * 4) / 4, as: Math.round(as * 4) / 4 };
}

/** Surname for the spine, with "et al." for several authors. */
export function shortAuthor(a: string): string {
  const etAl = /\s+et al\.?\s*$/i;
  const first = a.replace(etAl, "").split(/,| & | and /)[0]!.trim();
  const parts = first.split(/\s+/);
  const last = parts[parts.length - 1] ?? first;
  return etAl.test(a) || first !== a.trim() ? `${last} et al.` : last;
}
