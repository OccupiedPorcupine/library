import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FoliateView } from "foliate-js/view.js";
import { api, type BookDetail, type TocEntry } from "../lib/api";

/** Formats the in-app reader can open. Anything else opens as a raw file. */
export const READABLE = new Set(["epub", "mobi", "azw3", "fb2", "cbz", "pdf"]);

/** Where a contents entry points: an href inside the book, or a page number for PDFs. */
export function tocTarget(format: string, t: TocEntry): string | null {
  if (format === "pdf") return t.page ? String(t.page) : null;
  return READABLE.has(format) && t.href ? t.href : null;
}

interface Props {
  bookId: string;
  /** Href (reflowable formats) or page number (PDF) to open at; empty resumes where you left off. */
  at: string | null;
  onClose: () => void;
  onProgress: () => void;
}

const lastKey = (id: string) => `reader:last:${id}`;
const store = {
  get: (id: string) => {
    try {
      return localStorage.getItem(lastKey(id));
    } catch {
      return null;
    }
  },
  set: (id: string, v: string) => {
    try {
      localStorage.setItem(lastKey(id), v);
    } catch {
      /* private mode */
    }
  },
};

const isDark = () =>
  document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

/**
 * A minimal reader shell (groundwork for #4): one top bar and contents list for every format.
 * EPUB, MOBI/AZW3, FB2 and CBZ render with foliate-js; PDFs with pdf.js.
 * Both engines load only when a book opens, so the shelf page stays light.
 */
export function Reader({ bookId, at, onClose, onProgress }: Props) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [where, setWhere] = useState<{ fraction: number; label?: string }>({ fraction: 0 });
  const goRef = useRef<(target: string) => void>(() => {});
  const saveTimer = useRef(0);

  useEffect(() => {
    api
      .book(bookId)
      .then(setBook)
      .catch((e: Error) => setError(e.message));
  }, [bookId]);

  // Save progress a moment after the reader settles, not on every page turn.
  const report = useCallback(
    (fraction: number, resumeAt: string, label?: string) => {
      setWhere({ fraction, label });
      store.set(bookId, resumeAt);
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api
          .setProgress(bookId, fraction)
          .then(onProgress)
          .catch(() => {});
      }, 1500);
    },
    [bookId, onProgress],
  );
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (tocOpen ? setTocOpen(false) : onClose());
    };
    document.addEventListener("keydown", key);
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.documentElement.style.overflow = overflow;
    };
  }, [onClose, tocOpen]);

  const start = at ?? store.get(bookId);
  const pct = Math.round(where.fraction * 100);

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={book ? `Reading ${book.title}` : "Reader"}>
      <header className="reader__bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to book details">
          <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
            <path d="M15 6H1m5-5L1 6l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="reader__title">
          <span className="reader__book">{book?.title ?? " "}</span>
          <span className="reader__where">{where.label ?? (book?.author || " ")}</span>
        </div>
        {book && book.toc.length > 0 && (
          <button type="button" className="btn reader__toc-btn" onClick={() => setTocOpen((o) => !o)} aria-expanded={tocOpen}>
            Contents
          </button>
        )}
      </header>

      <div className="reader__stage">
        {error && <p className="notice">Couldn’t open this book: {error}</p>}
        {book && book.format === "pdf" && <PdfView book={book} start={start} goRef={goRef} onReport={report} onError={setError} />}
        {book && book.format !== "pdf" && READABLE.has(book.format) && (
          <FoliateViewer book={book} start={start} goRef={goRef} onReport={report} onError={setError} />
        )}
        {book && !READABLE.has(book.format) && (
          <p className="notice">
            The reader doesn’t handle {book.format.toUpperCase()} yet.{" "}
            <a href={api.fileUrl(book.id)} target="_blank" rel="noreferrer">
              Open the file
            </a>
          </p>
        )}
      </div>

      <footer className="reader__foot">
        <span className="meter meter--wide" style={{ "--p": where.fraction } as CSSProperties} />
        <span>{pct}%</span>
      </footer>

      {book && tocOpen && (
        <div className="reader__toc" role="dialog" aria-label="Contents">
          <ol className="toc">
            {book.toc.map((t, i) => {
              const target = tocTarget(book.format, t);
              const minLevel = Math.min(...book.toc.map((x) => x.level));
              return (
                <li key={i} className={`toc__item${t.level === minLevel ? " is-top" : ""}`} style={{ "--lvl": Math.min(4, t.level - minLevel) } as CSSProperties}>
                  <button
                    type="button"
                    className="toc__row"
                    disabled={!target}
                    onClick={() => target && (goRef.current(target), setTocOpen(false))}
                  >
                    <span className="toc__title">{t.title}</span>
                    {t.page != null && <span className="toc__page">{t.page}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

interface EngineProps {
  book: BookDetail;
  start: string | null;
  goRef: React.MutableRefObject<(target: string) => void>;
  onReport: (fraction: number, resumeAt: string, label?: string) => void;
  onError: (msg: string) => void;
}

// ---------- foliate-js: EPUB, MOBI/AZW3, FB2, CBZ ----------

const MIME: Record<string, string> = {
  epub: "application/epub+zip",
  cbz: "application/vnd.comicbook+zip",
  fb2: "application/x-fictionbook+xml",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
};

function bookCss(dark: boolean) {
  return `
    html { color-scheme: ${dark ? "dark" : "light"}; }
    html, body { background: transparent !important; color: ${dark ? "#e6e3dc" : "#1d1f24"} !important; }
    body { font-size: 1.08em; line-height: 1.6; }
    a:link, a:visited { color: ${dark ? "#e0b46a" : "#1d2b44"} !important; }
    img, svg { ${dark ? "filter: brightness(.9);" : ""} }
  `;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function FoliateViewer({ book, start, goRef, onReport, onError }: EngineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  // Which way the last page turn went ("left"/"right" on screen) and when, so a turn that
  // crosses into another chapter can slide in from the same side.
  const turnRef = useRef<{ side: -1 | 1; at: number } | null>(null);
  const sectionRef = useRef<number | null>(null);

  const turn = useCallback((side: -1 | 1) => {
    const view = viewRef.current;
    if (!view) return;
    turnRef.current = { side, at: performance.now() };
    void (side < 0 ? view.goLeft() : view.goRight());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current!;
    const pageKeys = (e: KeyboardEvent) => keyTurn(e);
    // Two-finger sideways swipe: one page per gesture, then wait for the gesture to finish.
    let acc = 0;
    let lockedUntil = 0;
    let idle = 0;
    const swipe = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      clearTimeout(idle);
      idle = window.setTimeout(() => (acc = 0), 180);
      const now = performance.now();
      if (now < lockedUntil) return void (lockedUntil = now + 180);
      acc += e.deltaX;
      if (Math.abs(acc) < 50) return;
      turn(acc > 0 ? 1 : -1);
      acc = 0;
      lockedUntil = now + 450;
    };
    host.addEventListener("wheel", swipe, { passive: false });
    (async () => {
      await import("foliate-js/view.js");
      const res = await fetch(api.fileUrl(book.id));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // foliate-js tells formats apart by file name and type, so give it both.
      const file = new File([await res.blob()], book.fileName, { type: MIME[book.format] ?? "" });
      if (cancelled) return;
      const view = document.createElement("foliate-view") as FoliateView;
      view.className = "reader__foliate";
      host.append(view);
      viewRef.current = view;
      view.addEventListener("relocate", (e) => {
        const loc = (e as CustomEvent<{ fraction: number; cfi: string; tocItem?: { label: string }; section?: { current: number } }>).detail;
        onReport(loc.fraction ?? 0, loc.cfi, loc.tocItem?.label?.trim());
        // Pages within a chapter slide in the renderer itself; a new chapter is a fresh page,
        // so slide that in from the side the reader turned towards.
        const section = loc.section?.current ?? null;
        const t = turnRef.current;
        const changed = section !== sectionRef.current && sectionRef.current !== null;
        if (changed && t && performance.now() - t.at < 1500 && !reducedMotion()) {
          view.renderer.animate(
            [
              { transform: `translateX(${t.side * 38}%)`, opacity: 0.35 },
              { transform: "translateX(0)", opacity: 1 },
            ],
            { duration: 360, easing: "cubic-bezier(0.22, 0.8, 0.2, 1)" },
          );
        }
        // A turn can report several locations; only the chapter change uses it up.
        if (changed) turnRef.current = null;
        sectionRef.current = section;
      });
      // Keys and sideways trackpad swipes inside the page itself (it's an iframe, so these
      // don't reach the document's own listeners).
      view.addEventListener("load", (e) => {
        const doc = (e as CustomEvent<{ doc: Document }>).detail.doc;
        doc.addEventListener("keydown", pageKeys);
        doc.addEventListener("wheel", swipe, { passive: false });
      });
      await view.open(file);
      // Slide between pages, following a finger on touch screens (foliate's "animated" mode).
      if (!reducedMotion()) view.renderer.setAttribute("animated", "");
      view.renderer.setAttribute("max-inline-size", "680px");
      view.renderer.setAttribute("margin", "56px");
      view.renderer.setAttribute("gap", "6%");
      // Fixed-layout (pre-paginated) books get a renderer without setStyles.
      view.renderer.setStyles?.(bookCss(isDark()));
      goRef.current = (target) => void view.goTo(target);
      // A saved spot can stop fitting (e.g. a book repacked from comic to EPUB): start over then.
      if (start) await view.init({ lastLocation: start }).catch(() => view.init({ showTextStart: true }));
      else await view.init({ showTextStart: true });
    })().catch((e: Error) => !cancelled && onError(e.message));

    const theme = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => viewRef.current?.renderer?.setStyles?.(bookCss(isDark()));
    theme.addEventListener("change", retheme);
    return () => {
      cancelled = true;
      clearTimeout(idle);
      host.removeEventListener("wheel", swipe);
      theme.removeEventListener("change", retheme);
      viewRef.current?.close();
      viewRef.current?.remove();
      viewRef.current = null;
    };
    // Open once per book; later jumps go through goRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const keyTurn = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, .reader__toc")) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") (e.preventDefault(), turn(-1));
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") (e.preventDefault(), turn(1));
  };
  useEffect(() => {
    document.addEventListener("keydown", keyTurn);
    return () => document.removeEventListener("keydown", keyTurn);
  });

  return (
    <div className="reader__paged">
      <button type="button" className="reader__turn reader__turn--prev" aria-label="Previous page" onClick={() => turn(-1)} />
      <div className="reader__host" ref={hostRef} />
      <button type="button" className="reader__turn reader__turn--next" aria-label="Next page" onClick={() => turn(1)} />
    </div>
  );
}

// ---------- pdf.js ----------

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

function PdfView({ book, start, goRef, onReport, onError }: EngineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [width, setWidth] = useState(800);
  const rendered = useRef(new Map<number, { cancel(): void }>());
  // The page to keep in view while page sizes settle (first load, window resizes).
  const anchor = useRef(Math.max(1, Number(start) || 1));

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      // Range requests: big PDFs show their first pages before the whole file arrives.
      loaded = await pdfjs.getDocument({ url: api.fileUrl(book.id), disableAutoFetch: true, rangeChunkSize: 512 * 1024 }).promise;
      if (cancelled) return void loaded.destroy();
      const first = await loaded.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      setRatio(vp.height / vp.width);
      setDoc(loaded);
    })().catch((e: Error) => !cancelled && onError(e.message));
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // Fit pages to the width of the reader, up to a comfortable maximum.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(900, el.clientWidth - 32)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const goToPage = useCallback((p: number, smooth = true) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${p}"]`);
    el?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }, []);

  useEffect(() => {
    goRef.current = (t) => ((anchor.current = Number(t)), goToPage(Number(t)));
  }, [goRef, goToPage]);

  // Keep the anchor page in view whenever page sizes change, including the first layout.
  useLayoutEffect(() => {
    if (doc && anchor.current > 1) goToPage(Math.min(anchor.current, doc.numPages), false);
  }, [doc, width, goToPage]);

  // Render pages near the viewport; drop canvases far away to keep memory flat on long PDFs.
  useEffect(() => {
    const root = scrollRef.current;
    if (!doc || !root) return;
    const map = rendered.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const slot = e.target as HTMLElement;
          const n = Number(slot.dataset.page);
          if (e.isIntersecting && !map.has(n)) {
            let task: { cancel(): void } | null = null;
            map.set(n, { cancel: () => task?.cancel() });
            void doc.getPage(n).then((page) => {
              if (!map.has(n)) return;
              const dpr = Math.min(2, devicePixelRatio || 1);
              const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
              const canvas = document.createElement("canvas");
              canvas.width = Math.floor(vp.width);
              canvas.height = Math.floor(vp.height);
              slot.style.aspectRatio = `${vp.width} / ${vp.height}`;
              const t = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp });
              task = t;
              t.promise.then(() => slot.replaceChildren(canvas)).catch(() => {});
            });
          } else if (!e.isIntersecting && map.has(n)) {
            map.get(n)!.cancel();
            map.delete(n);
            slot.replaceChildren();
          }
        }
      },
      { root, rootMargin: "150% 0px" },
    );
    root.querySelectorAll("[data-page]").forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      map.forEach((t) => t.cancel());
      map.clear();
    };
  }, [doc, width]);

  // Current page from scroll position.
  useEffect(() => {
    const root = scrollRef.current;
    if (!doc || !root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = root.scrollTop + root.clientHeight / 3;
        const slots = root.querySelectorAll<HTMLElement>("[data-page]");
        let page = 1;
        for (const s of slots) {
          if (s.offsetTop > mid) break;
          page = Number(s.dataset.page);
        }
        anchor.current = page;
        const label = [...book.toc].reverse().find((t) => t.page != null && t.page <= page)?.title;
        onReport(doc.numPages > 1 ? (page - 1) / (doc.numPages - 1) : 1, String(page), label ? `${label} · p. ${page}` : `Page ${page} of ${doc.numPages}`);
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => (root.removeEventListener("scroll", onScroll), cancelAnimationFrame(raf));
  }, [doc, book.toc, onReport]);

  return (
    <div className="reader__scroll" ref={scrollRef}>
      {doc &&
        Array.from({ length: doc.numPages }, (_, i) => (
          <div key={i} className="pdf-page" data-page={i + 1} style={{ width, aspectRatio: `1 / ${ratio}` }} />
        ))}
    </div>
  );
}
