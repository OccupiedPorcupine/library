import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { api, type Book } from "../lib/api";
import { hash } from "../lib/color";
import { BookTape, type TapeGeometry } from "./BookTape";

interface Props {
  index: number;
  id: string;
  name: string;
  books: Book[];
}

const GAP = 3;
const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Book to feature first: the one being read, else the middle one. */
function initialIndex(books: Book[]): number {
  const reading = books.findIndex((b) => b.progress > 0 && !b.finishedAt);
  return reading >= 0 ? reading : Math.floor((books.length - 1) / 2);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * One themed shelf. Books stand as 3D boxes showing their spines; the focused book
 * swings round to show its cover while its neighbours slide apart. Drag, swipe,
 * scroll sideways, click a spine, or use the arrow keys to browse.
 *
 * Position is a float ("pos") eased towards an integer target in a rAF loop that
 * writes transforms straight to the DOM; React only re-renders when the focused
 * book changes. Only books near the viewport are mounted.
 */
export function Shelf3D({ index, id, name, books }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 300 });
  const [focus, setFocus] = useState(() => initialIndex(books));

  const n = books.length;
  const pos = useRef(focus);
  const target = useRef(focus);
  const raf = useRef(0);
  const last = useRef(0);
  const drag = useRef<{ x: number; pos: number; t: number; v: number; moved: boolean; id: number } | null>(null);
  const wheelTimer = useRef(0);

  // Per-book shape: varied spine widths and heights, stable per book.
  const geo = useMemo<TapeGeometry[]>(() => {
    const k = size.h / 300;
    return books.map((b) => {
      const h = hash(b.id);
      return { ws: Math.round((34 + (h % 6) * 3.4) * k), hh: 0.86 + ((h >>> 5) % 8) * 0.02 };
    });
  }, [books, size.h]);

  // Centre of each spine along the shelf, in px.
  const centres = useMemo(() => {
    const c: number[] = [];
    let x = 0;
    geo.forEach((g, i) => {
      if (i) x += geo[i - 1]!.ws / 2 + GAP + g.ws / 2;
      c.push(x);
    });
    return c;
  }, [geo]);

  const dd = Math.round(size.h * 0.68); // cover width = depth of the box
  const avgStep = n > 1 ? centres[n - 1]! / (n - 1) : 40;

  const centreAt = useCallback(
    (p: number) => {
      if (!n) return 0;
      const lo = clamp(Math.floor(p), 0, n - 1);
      const hi = clamp(lo + 1, 0, n - 1);
      const base = centres[lo]! + (centres[hi]! - centres[lo]!) * (p - lo);
      // Past either end, keep sliding at the average spacing (rubber band).
      return p < 0 ? p * avgStep : p > n - 1 ? centres[n - 1]! + (p - n + 1) * avgStep : base;
    },
    [centres, n, avgStep],
  );

  // Which books are mounted: those within reach of the viewport.
  const reach = Math.ceil(size.w / 2 / avgStep) + 4;
  const from = Math.max(0, focus - reach);
  const to = Math.min(n - 1, focus + reach);

  const layout = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const g = pos.current;
    const cg = centreAt(g);
    const tapes = stage.querySelectorAll<HTMLElement>(".tape");
    for (const el of tapes) {
      const i = Number(el.dataset.i);
      const a = i - g;
      const o = Math.abs(a);
      const l = smooth(Math.max(0, 1 - o));
      const ws = geo[i]?.ws ?? 40;
      const gap = dd / 2 - ws / 2 + size.h * 0.07;
      const x = centres[i]! - cg + Math.sign(a) * gap * Math.min(1, o);
      const hidden = Math.abs(x) > size.w / 2 + dd;
      el.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) continue;
      el.style.transform = `translate3d(${x.toFixed(2)}px,${(-10 * l).toFixed(2)}px,${(60 * l).toFixed(2)}px) rotateZ(${(-4 * l).toFixed(3)}deg) rotateY(${(-90 * l).toFixed(3)}deg)`;
      el.style.zIndex = String(1000 - Math.round(o * 4));
      el.style.setProperty("--shade", (0.5 * (1 - l)).toFixed(3));
      el.style.setProperty("--sshade", (0.55 * l).toFixed(3));
    }
  }, [centreAt, centres, dd, geo, size]);

  const tick = useCallback(
    (now: number) => {
      const dt = Math.min(64, now - (last.current || now));
      last.current = now;
      if (!drag.current) {
        const d = target.current - pos.current;
        pos.current += reducedMotion ? d : d * (1 - Math.exp(-dt / 95));
        if (Math.abs(d) < 0.0008) pos.current = target.current;
      }
      layout();
      const f = clamp(Math.round(pos.current), 0, n - 1);
      setFocus((cur) => (cur === f ? cur : f));
      if (drag.current || pos.current !== target.current) raf.current = requestAnimationFrame(tick);
      else (raf.current = 0), (last.current = 0);
    },
    [layout, n],
  );

  const kick = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const goTo = useCallback(
    (i: number) => {
      target.current = clamp(Math.round(i), 0, Math.max(0, n - 1));
      kick();
    },
    [kick, n],
  );

  // Size the shelf from its container.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e!.contentRect.width;
      setSize({ w, h: w < 720 ? 210 : 290 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-lay out whenever the mounted set or geometry changes.
  useLayoutEffect(layout, [layout, from, to]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Keep focus valid when the shelf's books change (search, uploads).
  useEffect(() => {
    if (target.current > n - 1) goTo(n - 1);
  }, [n, goTo]);

  const open = (b: Book) => window.open(api.fileUrl(b.id), "_blank", "noopener");

  // ---- Pointer: drag / swipe / click ----
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, pos: pos.current, t: performance.now(), v: 0, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent) => {
    moveCursor(e);
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true;
      stageRef.current?.setPointerCapture(d.id);
    }
    if (!d.moved) return;
    const now = performance.now();
    let p = d.pos - dx / avgStep;
    if (p < 0) p = -Math.sqrt(-p) * 0.6;
    if (p > n - 1) p = n - 1 + Math.sqrt(p - n + 1) * 0.6;
    d.v = 0.8 * d.v + 0.2 * ((p - pos.current) / Math.max(1, now - d.t));
    d.t = now;
    pos.current = p;
    kick();
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      goTo(pos.current + d.v * 180);
      return;
    }
    // A click: bring a spine forward, or open the book already facing you.
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tape");
    const i = el ? Number(el.dataset.i) : NaN;
    if (Number.isNaN(i)) return;
    if (i === target.current && Math.abs(pos.current - i) < 0.05) open(books[i]!);
    else goTo(i);
  };

  // Sideways trackpad scrolling browses; vertical scrolling still scrolls the page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (!drag.current) drag.current = { x: 0, pos: pos.current, t: 0, v: 0, moved: true, id: -1 };
      pos.current = clamp(pos.current + e.deltaX / avgStep / 1.4, -0.4, n - 0.6);
      kick();
      clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        drag.current = null;
        goTo(pos.current);
      }, 110);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [avgStep, goTo, kick, n]);

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, PageDown: 5, PageUp: -5 }[e.key];
    if (step) (goTo(target.current + step), e.preventDefault());
    if (e.key === "Home") (goTo(0), e.preventDefault());
    if (e.key === "End") (goTo(n - 1), e.preventDefault());
    if (e.key === "Enter" && books[target.current]) open(books[target.current]!);
  };

  // A round cursor that says what a click will do.
  const moveCursor = (e: PointerEvent) => {
    const c = cursorRef.current;
    if (!c || !finePointer) return;
    c.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tape");
    const label = drag.current?.moved ? "Drag" : el && Number(el.dataset.i) === target.current ? "Open" : el ? "Pick" : "Drag";
    if (c.dataset.label !== label) (c.dataset.label = label), (c.firstElementChild!.textContent = label);
  };

  const current = books[focus];
  const pct = current ? Math.round(current.progress * 100) : 0;
  const num = String(index + 1).padStart(2, "0");

  return (
    <section className="shelf" id={`shelf-${id}`} aria-labelledby={`shelf-${id}-title`} data-shelf={id}>
      <header className="shelf__head">
        <h2 id={`shelf-${id}-title`} className="shelf__title">
          <span className="shelf__num">{num}</span>
          {name}
        </h2>
        <span className="shelf__count">
          {n} {n === 1 ? "book" : "books"}
        </span>
      </header>

      <div
        className={`stage${finePointer ? " has-cursor" : ""}`}
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${name} shelf. Use arrow keys to browse, Enter to open.`}
        style={{ "--h": `${size.h}px`, "--dd": `${dd}px` } as CSSProperties}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((drag.current = null), goTo(pos.current))}
        onPointerEnter={() => cursorRef.current?.classList.add("is-on")}
        onPointerLeave={() => cursorRef.current?.classList.remove("is-on")}
      >
        <div className="stage__wall" aria-hidden />
        <div className="stage__floor" aria-hidden>
          <div className="stage__pool" />
        </div>
        <div className="stage__books">
          {books.slice(from, to + 1).map((b, k) => (
            <BookTape key={b.id} book={b} index={from + k} geo={geo[from + k]!} />
          ))}
        </div>
      </div>
      {finePointer && (
        <div className="shelf-cursor" ref={cursorRef} aria-hidden>
          <span>Drag</span>
        </div>
      )}

      {current && (
        <div className="caption" aria-live="polite">
          <div className="caption__text" key={current.id}>
            <span className="caption__kicker">
              {current.author ?? "Unknown author"} · {current.format.toUpperCase()}
            </span>
            <h3 className="caption__title">{current.title}</h3>
            <span className="caption__progress">
              <span className="meter" style={{ "--p": current.finishedAt ? 1 : current.progress } as CSSProperties} />
              {current.finishedAt ? "Finished" : pct ? `${pct}% read` : "Not started"}
            </span>
          </div>
          <div className="caption__nav">
            <button type="button" className="round-btn" onClick={() => goTo(target.current - 1)} disabled={focus <= 0} aria-label="Previous book">
              <Arrow dir="left" />
            </button>
            <a className="btn btn--primary" href={api.fileUrl(current.id)} target="_blank" rel="noreferrer">
              Open
            </a>
            <button type="button" className="round-btn" onClick={() => goTo(target.current + 1)} disabled={focus >= n - 1} aria-label="Next book">
              <Arrow dir="right" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden>
      <path
        d={dir === "left" ? "M17 5H1m4-4L1 5l4 4" : "M1 5h16m-4-4 4 4-4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
