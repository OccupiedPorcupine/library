import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type Book } from "../lib/api";
import { BookItem } from "./BookItem";

interface Props {
  index: number;
  id: string;
  name: string;
  books: Book[];
}

/** Picks the book to feature first: the one being read most recently, else the middle one. */
function initialSelection(books: Book[]): string | undefined {
  const reading = books.filter((b) => b.progress > 0 && !b.finishedAt);
  return (reading[0] ?? books[Math.floor(books.length / 2)])?.id;
}

export function ShelfRow({ index, id, name, books }: Props) {
  const [selected, setSelected] = useState(() => initialSelection(books));
  const trackRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  const current = books.find((b) => b.id === selected) ?? books[0];
  const pos = current ? books.indexOf(current) : -1;

  useEffect(() => {
    if (!books.some((b) => b.id === selected)) setSelected(initialSelection(books));
  }, [books, selected]);

  // Keep the open book in view.
  useEffect(() => {
    const el = trackRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(current?.id ?? "")}"]`);
    if (!el || !trackRef.current) return;
    const track = trackRef.current;
    const left = el.offsetLeft - track.clientWidth / 2 + el.offsetWidth / 2;
    track.scrollTo({ left, behavior: firstRender.current ? "instant" : "smooth" });
    firstRender.current = false;
  }, [current?.id]);

  const step = useCallback(
    (d: number) => {
      if (pos < 0) return;
      const next = books[Math.min(books.length - 1, Math.max(0, pos + d))];
      if (next) setSelected(next.id);
    },
    [books, pos],
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") (step(1), e.preventDefault());
    if (e.key === "ArrowLeft") (step(-1), e.preventDefault());
  };

  const num = String(index + 1).padStart(2, "0");
  const pct = current ? Math.round(current.progress * 100) : 0;

  return (
    <section className="shelf" id={`shelf-${id}`} aria-labelledby={`shelf-${id}-title`} data-shelf={id}>
      <header className="shelf__head">
        <h2 id={`shelf-${id}-title`} className="shelf__title">
          <span className="shelf__num">{num}</span> <span className="shelf__slash">/</span> {name}
        </h2>
        <div className="shelf__meta">
          <span>
            {books.length} {books.length === 1 ? "book" : "books"}
          </span>
          <div className="shelf__arrows">
            <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={pos <= 0} aria-label="Previous book">
              <Chevron dir="left" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => step(1)}
              disabled={pos >= books.length - 1}
              aria-label="Next book"
            >
              <Chevron dir="right" />
            </button>
          </div>
        </div>
      </header>

      <div className="shelf__stage">
        <div className="shelf__track" ref={trackRef} onKeyDown={onKey} role="group" aria-label={`${name} shelf`}>
          {books.map((b) => (
            <BookItem key={b.id} book={b} open={b.id === current?.id} onSelect={setSelected} />
          ))}
        </div>
        <div className="shelf__ledge" aria-hidden />
      </div>

      {current && (
        <div className="shelf__detail" aria-live="polite">
          <div className="detail__text">
            <h3 className="detail__title">{current.title}</h3>
            <p className="detail__sub">
              {current.author ?? "Unknown author"}
              <span className="chip">{current.format.toUpperCase()}</span>
              <span className="detail__progress">
                {current.finishedAt ? "Finished" : pct ? `${pct}% read` : "Not started"}
              </span>
            </p>
          </div>
          <a className="btn btn--primary" href={api.fileUrl(current.id)} target="_blank" rel="noreferrer">
            Open book
            <Arrow />
          </a>
        </div>
      )}
    </section>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d={dir === "left" ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M4 10 10 4M5 4h5v5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
