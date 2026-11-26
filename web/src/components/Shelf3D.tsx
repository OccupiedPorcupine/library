import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { api, type Book } from "../lib/api";
import { hash } from "../lib/color";
import { BookTape, type TapeGeometry } from "./BookTape";

interface Props {
  index: number;
  id: string;
  name: string;
  books: Book[];
  /** Opens the book's detail panel. */
  onDetails: (book: Book) => void;
  /** Opens the book in the reader. */
  onRead: (book: Book) => void;
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
const mod = (a: number, m: number) => ((a % m) + m) % m;

/**
 * One themed shelf. Books stand as 3D boxes showing their spines; the focused book
 * swings round to show its cover while its neighbours slide apart. Drag, swipe,
 * scroll sideways, click a spine, or use the arrow keys to browse.
 *
 * Position is a float ("pos") eased towards an integer target in a rAF loop that
 * writes transforms straight to the DOM; React only re-renders when the focused
 * book changes. Only books near the viewport are mounted.
 */
export function Shelf3D({ index, id, name, books, onDetails, onRead }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const booksRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 300 });
  // "slot" is an unbounded position along the shelf; on long shelves it wraps round.
  const [slot, setSlot] = useState(() => initialIndex(books));

  const n = books.length;
  const pos = useRef(slot);
  const target = useRef(slot);
  const raf = useRef(0);
  const last = useRef(0);
  const drag = useRef<{ x: number; y: number; lx: number; lt: number; pos: number; v: number; axis: "" | "h" | "v"; id: number } | null>(
    null,
  );
  const wheeling = useRef(false);
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
  // One full lap of the shelf, used when it wraps round.
  const lap = n ? centres[n - 1]! + geo[n - 1]!.ws / 2 + GAP + geo[0]!.ws / 2 : 0;
  const avgStep = n ? lap / n : 40;
  // Wrap round endlessly, like a carousel, once there are enough books to fill the room.
  const loop = n > 1 && lap > size.w + dd;
  const focus = n ? mod(slot, n) : 0;

  /** Centre of the book in (unbounded) slot i, in px. */
  const centreOf = useCallback(
    (i: number) => {
      if (loop) return Math.floor(i / n) * lap + centres[mod(i, n)]!;
      // Past either end, keep sliding at the average spacing (rubber band).
      return i < 0 ? i * avgStep : i > n - 1 ? centres[n - 1]! + (i - n + 1) * avgStep : centres[i]!;
    },
    [loop, n, lap, centres, avgStep],
  );
  const centreAt = useCallback(
    (p: number) => {
      const lo = Math.floor(p);
      return centreOf(lo) + (centreOf(lo + 1) - centreOf(lo)) * (p - lo);
    },
    [centreOf],
  );

  // Which slots are mounted: those within reach of the viewport.
  const reach = Math.ceil(size.w / 2 / avgStep) + 4;
  const from = loop ? slot - reach : Math.max(0, slot - reach);
  const to = loop ? slot + reach : Math.min(n - 1, slot + reach);

  const layout = useCallback(() => {
    const stage = booksRef.current;
    if (!stage || !n) return;
    const g = pos.current;
    const cg = centreAt(g);
    for (const el of stage.children as HTMLCollectionOf<HTMLElement>) {
      const i = Number(el.dataset.i);
      const a = i - g;
      const o = Math.abs(a);
      const l = smooth(Math.max(0, 1 - o));
      const ws = geo[mod(i, n)]!.ws;
      // Neighbours slide apart to make room for the open cover.
      const gap = dd / 2 - ws / 2 + size.h * 0.07;
      const x = centreOf(i) - cg + Math.sign(a) * gap * Math.min(1, o);
      const hidden = Math.abs(x) > size.w / 2 + dd;
      el.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) continue;
      el.style.transform = `translate3d(${x.toFixed(2)}px,${(-10 * l).toFixed(2)}px,${(60 * l).toFixed(2)}px) rotateZ(${(-4 * l).toFixed(3)}deg) rotateY(${(-90 * l).toFixed(3)}deg)`;
      el.style.zIndex = String(1000 - Math.round(o * 4));
      el.style.setProperty("--shade", (0.5 * (1 - l)).toFixed(3));
      el.style.setProperty("--sshade", (0.55 * l).toFixed(3));
    }
  }, [centreAt, centreOf, dd, geo, n, size]);

  const tick = useCallback(
    (now: number) => {
      const dt = Math.min(64, now - (last.current || now));
      last.current = now;
      const held = drag.current?.axis === "h" || wheeling.current;
      if (!held) {
        // Ease towards the target: about 16% of the way each frame at 60 fps.
        const d = target.current - pos.current;
        pos.current += reducedMotion ? d : d * (1 - Math.pow(0.84, dt / 16.7));
        if (Math.abs(d) < 0.0008) pos.current = target.current;
      }
      layout();
      const s = Math.round(pos.current);
      setSlot((cur) => (cur === s ? cur : s));
      if (held || pos.current !== target.current) raf.current = requestAnimationFrame(tick);
      else (raf.current = 0), (last.current = 0);
    },
    [layout],
  );

  const kick = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const goTo = useCallback(
    (i: number) => {
      const r = Math.round(i);
      target.current = loop ? r : clamp(r, 0, Math.max(0, n - 1));
      kick();
    },
    [kick, loop, n],
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

  // When wrapping turns off (narrower room is wider now, or books were filtered), fold back into range.
  useLayoutEffect(() => {
    if (loop || !n) return;
    const t = clamp(mod(target.current, n), 0, n - 1);
    if (t !== target.current || pos.current < -0.5 || pos.current > n - 0.5) {
      pos.current = target.current = t;
      setSlot(t);
    }
  }, [loop, n]);

  // Bring a book that has just started uploading to the front.
  const movingId = books.find((b) => b.transfer !== undefined)?.id;
  useEffect(() => {
    if (!movingId) return;
    const i = books.findIndex((b) => b.id === movingId);
    goTo(target.current - mod(target.current, n) + i);
    // Only when a new upload appears, not on every progress tick.
  }, [movingId]);

  // Re-lay out whenever the mounted set or geometry changes.
  useLayoutEffect(layout, [layout, from, to]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const open = (b: Book) => onDetails(b);

  // ---- Pointer: drag / swipe / click ----
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const now = performance.now();
    drag.current = { x: e.clientX, y: e.clientY, lx: e.clientX, lt: now, pos: pos.current, v: 0, axis: "", id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent) => {
    tilt(e);
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.axis) {
      // A mostly vertical swipe belongs to the page, not the shelf.
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) return void (d.axis = "v");
      if (Math.abs(dx) <= 6) return;
      d.axis = "h";
      d.pos = pos.current;
      d.x = e.clientX;
      try {
        stageRef.current?.setPointerCapture(d.id);
      } catch {
        /* pointer already gone */
      }
      kick();
    }
    if (d.axis !== "h") return;
    const now = performance.now();
    let p = d.pos - (e.clientX - d.x) / avgStep;
    if (!loop && p < 0) p = -Math.sqrt(-p) * 0.6;
    if (!loop && p > n - 1) p = n - 1 + Math.sqrt(p - n + 1) * 0.6;
    pos.current = p;
    d.v = (e.clientX - d.lx) / Math.max(1, now - d.lt);
    d.lx = e.clientX;
    d.lt = now;
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.axis === "h") {
      // Fling: carry on in the direction of travel, then settle on a book.
      goTo(pos.current - (d.v * 260) / avgStep);
      return;
    }
    if (d.axis === "v" || Math.abs(e.clientX - d.x) > 6) return;
    // A click: bring a spine forward, or open the book already facing you.
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tape");
    const i = el ? Number(el.dataset.i) : NaN;
    if (Number.isNaN(i)) return;
    const b = books[mod(i, n)]!;
    if (i === target.current && Math.abs(pos.current - i) < 0.05) b.transfer === undefined && open(b);
    else goTo(i);
  };

  // Sideways trackpad scrolling moves the shelf 1:1 and settles on a book when you stop.
  // Vertical scrolling still scrolls the page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      wheeling.current = true;
      let p = pos.current + e.deltaX / avgStep;
      if (!loop) p = clamp(p, -0.45, n - 0.55);
      pos.current = target.current = p;
      kick();
      clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        wheeling.current = false;
        goTo(pos.current);
      }, 90);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [avgStep, goTo, kick, loop, n]);

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, PageDown: 5, PageUp: -5 }[e.key];
    if (step) (goTo(target.current + step), e.preventDefault());
    const start = target.current - mod(target.current, n);
    if (e.key === "Home") (goTo(start), e.preventDefault());
    if (e.key === "End") (goTo(start + n - 1), e.preventDefault());
    const b = n ? books[mod(target.current, n)] : undefined;
    if (e.key === "Enter" && b && b.transfer === undefined) open(b);
  };

  // Arrow keys also browse the shelf in the middle of the screen, without focusing it first.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [role=dialog], .stage")) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const r = stageRef.current?.getBoundingClientRect();
      const mid = innerHeight / 2;
      if (!r || r.top > mid || r.bottom + 120 < mid) return;
      keyRef.current(e as unknown as KeyboardEvent);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  // The view tilts a little towards the pointer, so the books feel solid.
  const tilt = (e: PointerEvent) => {
    const el = booksRef.current;
    if (!el || !finePointer || reducedMotion) return;
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    el.style.perspectiveOrigin = `${(50 - nx * 18).toFixed(1)}% ${(12 - ny * 14).toFixed(1)}%`;
  };

  const current = books[focus];
  const moving = current?.transfer !== undefined;
  const pct = current ? Math.round((moving ? current.transfer! : current.progress) * 100) : 0;
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
        className="stage"
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${name} shelf. Use arrow keys to browse, Enter for details.`}
        style={{ "--h": `${size.h}px`, "--dd": `${dd}px` } as CSSProperties}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((drag.current = null), goTo(pos.current))}
        onPointerLeave={() => {
          if (booksRef.current) booksRef.current.style.perspectiveOrigin = "";
        }}
      >
        <div className="stage__wall" aria-hidden />
        <div className="stage__floor" aria-hidden>
          <div className="stage__pool" />
        </div>
        <div className="stage__books" ref={booksRef}>
          {n > 0 &&
            Array.from({ length: to - from + 1 }, (_, k) => {
              const i = from + k;
              return <BookTape key={i} book={books[mod(i, n)]!} index={i} geo={geo[mod(i, n)]!} />;
            })}
        </div>
      </div>

      {current && (
        <div className="caption" aria-live="polite">
          <div className="caption__text" key={current.id}>
            <span className="caption__kicker">
              {current.author ?? "Unknown author"} · {current.format.toUpperCase()}
            </span>
            <h3 className="caption__title">{current.title}</h3>
            <span className="caption__progress">
              <span className="meter" style={{ "--p": moving ? current.transfer : current.finishedAt ? 1 : current.progress } as CSSProperties} />
              {moving ? (pct < 100 ? `Uploading ${pct}%` : "Adding to library…") : current.finishedAt ? "Finished" : pct ? `${pct}% read` : "Not started"}
            </span>
          </div>
          <div className="caption__nav">
            <button type="button" className="round-btn" onClick={() => goTo(target.current - 1)} disabled={!loop && focus <= 0} aria-label="Previous book">
              <Arrow dir="left" />
            </button>
            {moving ? (
              <span className="btn btn--primary is-disabled" aria-disabled>
                Read
              </span>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => onDetails(current)}>
                  Details
                </button>
                <button type="button" className="btn btn--primary" onClick={() => onRead(current)}>
                  Read
                </button>
              </>
            )}
            <button type="button" className="round-btn" onClick={() => goTo(target.current + 1)} disabled={!loop && focus >= n - 1} aria-label="Next book">
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
