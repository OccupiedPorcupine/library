import type { PDFPageProxy } from "pdfjs-dist";
import type { Annotation, MarksBridge, PageRect, ScreenRect } from "./annotations";
import { swatch } from "./annotations";

/**
 * Highlights for PDFs (#48). pdf.js draws pages as pictures, so each page also gets an
 * invisible text layer to select from. Highlights are stored as boxes in fractions of the
 * page, so they line up at any zoom or screen size, and are drawn as tinted divs on top.
 */

/** The selectable text for one page, laid over its canvas at `scale` CSS pixels per PDF point. */
export async function textLayer(page: PDFPageProxy, scale: number) {
  const { TextLayer } = await import("pdfjs-dist");
  const div = document.createElement("div");
  div.className = "textLayer";
  div.style.setProperty("--total-scale-factor", String(scale));
  const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport: page.getViewport({ scale }) });
  // Keep a drag from jumping when it crosses the gaps between lines (what pdf.js's own viewer does).
  const end = document.createElement("div");
  end.className = "endOfContent";
  div.addEventListener("pointerdown", () => div.classList.add("selecting"));
  const stop = () => div.classList.remove("selecting");
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
  const done = layer.render().then(() => {
    div.append(end);
    return div;
  });
  return {
    done,
    cancel() {
      layer.cancel();
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    },
  };
}

/** Draws (or redraws) the highlights that belong on one page slot. */
export function drawPdfMarks(slot: HTMLElement, list: Annotation[], dark: boolean) {
  const n = Number(slot.dataset.page);
  let layer = slot.querySelector<HTMLElement>(":scope > .pdf-marks");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "pdf-marks";
    slot.append(layer);
  }
  layer.replaceChildren(
    ...list
      .filter((a) => a.kind === "highlight" && a.page === n)
      .flatMap((a) =>
        a.rects.map(([x, y, w, h]) => {
          const el = document.createElement("div");
          el.className = a.note ? "pdf-mark has-note" : "pdf-mark";
          el.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;--mark:${swatch(a.color, dark)}`;
          return el;
        }),
      ),
  );
}

/** Joins the many small boxes a selection is made of into one box per line. */
function mergeLines(rects: PageRect[]): PageRect[] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: PageRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const [lx, ly, lw, lh] = last;
      const sameLine = Math.abs(r[1] + r[3] / 2 - (ly + lh / 2)) < Math.min(r[3], lh) * 0.5;
      if (sameLine && r[0] <= lx + lw + 0.02) {
        const x = Math.min(lx, r[0]);
        const y = Math.min(ly, r[1]);
        const right = Math.max(lx + lw, r[0] + r[2]);
        const bottom = Math.max(ly + lh, r[1] + r[3]);
        out[out.length - 1] = [x, y, right - x, bottom - y];
        continue;
      }
    }
    out.push(r);
  }
  return out.slice(0, 200);
}

const slotOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>(".pdf-page[data-page]") ?? null;

/**
 * Watches the document's selection and reports text selected on a PDF page under `root`.
 * A selection that runs onto later pages keeps to the page it started on.
 */
export function watchPdfSelection(root: HTMLElement, bridge: () => MarksBridge, numPages: () => number) {
  let timer = 0;
  // Only a selection going away closes the toolbar, not every caret move (taps make those).
  let had = false;
  const none = () => had && ((had = false), bridge().select(null));
  const read = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return none();
    const range = sel.getRangeAt(0).cloneRange();
    const slot = slotOf(range.startContainer);
    if (!slot || !root.contains(slot)) return;
    // The selection's own text keeps the line breaks between spans; a clipped range's doesn't.
    let raw = sel.toString();
    if (!slot.contains(range.endContainer)) {
      const text = slot.querySelector(".textLayer");
      if (!text) return;
      range.setEnd(text, text.childNodes.length);
      raw = [...range.cloneContents().childNodes].map((n) => n.textContent ?? "").join(" ");
    }
    const box = slot.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const parts: PageRect[] = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      parts.push([(r.left - box.left) / box.width, (r.top - box.top) / box.height, r.width / box.width, r.height / box.height]);
    }
    const rects = mergeLines(parts).map(
      (r) => r.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5) as PageRect,
    );
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || !rects.length) return none();
    had = true;
    const page = Number(slot.dataset.page);
    const at = range.getBoundingClientRect();
    const total = numPages();
    bridge().select({
      locator: `page:${page}`,
      page,
      rects,
      text,
      fraction: total > 1 ? Math.min(1, (page - 1 + rects[0][1]) / (total - 1)) : rects[0][1],
      at: { left: at.left, top: at.top, right: at.right, bottom: at.bottom },
    });
  };
  const onChange = () => {
    clearTimeout(timer);
    timer = window.setTimeout(read, 280);
  };
  // A tap on a highlight opens it; a tap anywhere else closes the toolbar.
  const onClick = (e: MouseEvent) => {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const slot = slotOf(e.target as Node);
    if (!slot) return;
    const box = slot.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    const page = Number(slot.dataset.page);
    const hit = [...bridge().list]
      .reverse()
      .find((a) => a.kind === "highlight" && a.page === page && a.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh));
    if (!hit) return;
    const ys = hit.rects.map((r) => r[1]);
    const at: ScreenRect = {
      left: box.left + Math.min(...hit.rects.map((r) => r[0])) * box.width,
      top: box.top + Math.min(...ys) * box.height,
      right: box.left + Math.max(...hit.rects.map((r) => r[0] + r[2])) * box.width,
      bottom: box.top + Math.max(...hit.rects.map((r) => r[1] + r[3])) * box.height,
    };
    bridge().pick(hit, at);
  };
  const onDown = (e: PointerEvent) => {
    const sel = document.getSelection();
    if (root.contains(e.target as Node) && (!sel || sel.isCollapsed)) bridge().dismiss();
  };
  document.addEventListener("selectionchange", onChange);
  root.addEventListener("click", onClick);
  root.addEventListener("pointerdown", onDown);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("selectionchange", onChange);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerdown", onDown);
  };
}
