import type { FoliateView } from "foliate-js/view.js";
import type { Annotation, MarksBridge, ScreenRect } from "./annotations";
import { swatch } from "./annotations";

/**
 * Highlights for books foliate-js renders (EPUB, MOBI/AZW3, FB2, CBZ), #48.
 *
 * Kept out of the reader component: this listens to the view's own events, turns a text
 * selection into a CFI, and draws saved highlights with foliate's overlayer. The reader
 * only calls `attachFoliateMarks` once per view and `sync` when the list changes.
 */

type OverlayerModule = typeof import("foliate-js/overlayer.js");
type Draw = (fn: (rects: import("foliate-js/overlayer.js").OverlayRect[], o: { color: string }) => SVGElement, opts: { color: string }) => void;

const SVG = "http://www.w3.org/2000/svg";

/** A highlight with a note also gets a thin underline, so notes stand out on the page. */
function drawer(O: OverlayerModule["Overlayer"], note: boolean) {
  return (rects: Parameters<typeof O.highlight>[0], opts: { color: string }) => {
    const g = document.createElementNS(SVG, "g");
    g.append(O.highlight(rects, opts));
    if (note) g.append(O.underline(rects, { color: opts.color, width: 1.5, padding: 1.5 }));
    return g;
  };
}

/** Where a range sits on screen, counting the frame the book's page lives in. */
function screenRect(range: Range): ScreenRect | null {
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect();
  const dx = frame?.left ?? 0;
  const dy = frame?.top ?? 0;
  return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy };
}

const cleanText = (s: string) => s.replace(/\s+/g, " ").trim();

export function attachFoliateMarks(view: FoliateView, bridge: () => MarksBridge, dark: () => boolean) {
  let O: OverlayerModule["Overlayer"] | null = null;
  void import("foliate-js/overlayer.js").then((m) => (O = m.Overlayer));
  /** What's drawn now, so a change redraws only what moved. */
  const drawn = new Map<string, string>(); // locator -> "color|note"
  const byLocator = () => new Map(bridge().list.filter((a) => a.kind === "highlight").map((a) => [a.locator, a]));

  const draw = (a: Annotation) => {
    drawn.set(a.locator, `${a.color}|${a.note ? 1 : 0}`);
    void view.addAnnotation({ value: a.locator }).catch(() => {});
  };

  view.addEventListener("draw-annotation", (e) => {
    const { draw: paint, annotation } = (e as CustomEvent<{ draw: Draw; annotation: { value: string } }>).detail;
    const a = byLocator().get(annotation.value);
    if (!a || !O) return;
    paint(drawer(O, !!a.note), { color: swatch(a.color, dark()) });
  });

  // A chapter came on screen: its overlay is new and empty, so draw that chapter's highlights.
  view.addEventListener("create-overlay", () => {
    for (const a of byLocator().values()) draw(a);
  });

  view.addEventListener("show-annotation", (e) => {
    const { value, range } = (e as CustomEvent<{ value: string; range: Range }>).detail;
    const a = byLocator().get(value);
    const at = range && screenRect(range);
    if (a && at) bridge().pick(a, at);
  });

  view.addEventListener("load", (e) => {
    const { doc, index } = (e as CustomEvent<{ doc: Document; index: number }>).detail;
    let timer = 0;
    // Only a selection going away closes the toolbar, not every caret move (taps make those).
    let had = false;
    const none = () => had && ((had = false), bridge().select(null));
    const read = () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return none();
      const range = sel.getRangeAt(0);
      const text = cleanText(range.toString());
      const at = screenRect(range);
      if (!text || !at) return none();
      had = true;
      const loc = view.lastLocation as { fraction?: number; tocItem?: { label?: string } } | null;
      bridge().select({
        locator: view.getCFI(index, range),
        text,
        fraction: loc?.fraction ?? 0,
        label: loc?.tocItem?.label?.trim() || null,
        at,
      });
    };
    // Selection handles move in many small steps on phones; wait for them to settle.
    doc.addEventListener("selectionchange", () => {
      clearTimeout(timer);
      timer = window.setTimeout(read, 280);
    });
    // Touching the page closes any open toolbar; tapping a highlight reopens it for that one.
    doc.addEventListener("pointerdown", () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed) bridge().dismiss();
    });
  });

  return {
    /** Redraw after the list changed (new, recoloured, noted or deleted highlights). */
    sync() {
      const now = byLocator();
      for (const [locator, sig] of drawn) {
        const a = now.get(locator);
        if (!a || `${a.color}|${a.note ? 1 : 0}` !== sig) {
          drawn.delete(locator);
          void view.deleteAnnotation({ value: locator }).catch(() => {});
        }
      }
      for (const a of now.values()) if (!drawn.has(a.locator)) draw(a);
    },
    /** Colours follow the theme. */
    redrawAll() {
      for (const a of byLocator().values()) draw(a);
    },
    clearSelection() {
      view.deselect();
    },
  };
}

/** Is a bookmark's spot on the page that's showing? `page` is the visible range's CFI. */
export async function onPage(point: string, page: string) {
  const { collapse, compare } = await import("foliate-js/epubcfi.js");
  try {
    return compare(collapse(page), point) <= 0 && compare(point, collapse(page, true)) <= 0;
  } catch {
    return false;
  }
}

/** The first spot on the visible page, where a bookmark for it points. */
export async function pageStart(page: string) {
  const { collapse } = await import("foliate-js/epubcfi.js");
  try {
    return collapse(page);
  } catch {
    return page;
  }
}
