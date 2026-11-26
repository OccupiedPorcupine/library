import { memo, type CSSProperties } from "react";
import type { Book } from "../lib/api";
import { hash, isLight } from "../lib/color";

interface Props {
  book: Book;
  open: boolean;
  onSelect: (id: string) => void;
}

/**
 * One book on a shelf. Closed books are CSS-drawn spines (no image downloads);
 * the open one turns to show its cover. Reading progress lights the book from the bottom up.
 */
export const BookItem = memo(function BookItem({ book, open, onSelect }: Props) {
  const h = hash(book.id);
  const light = isLight(book.spineColor);
  const style = {
    "--spine": book.spineColor,
    "--spine-ink": light ? "#2a2620" : "#f4efe4",
    "--h": `${88 + (h % 13)}%`,
    "--w": `${40 + ((h >> 4) % 18)}px`,
    "--p": book.progress,
  } as CSSProperties;
  const pct = Math.round(book.progress * 100);
  const label = `${book.title}${book.author ? ` by ${book.author}` : ""}, ${book.finishedAt ? "finished" : pct ? `${pct}% read` : "unread"}`;

  return (
    <button
      type="button"
      className={`book${open ? " is-open" : ""}${book.finishedAt ? " is-finished" : ""}`}
      style={style}
      onClick={() => onSelect(book.id)}
      aria-label={label}
      aria-pressed={open}
      data-id={book.id}
    >
      <span className="book__body">
        {open ? <Cover book={book} /> : <Spine book={book} />}
        <span className="book__light" aria-hidden />
      </span>
    </button>
  );
});

function Spine({ book }: { book: Book }) {
  return (
    <span className="spine">
      <span className="spine__band" />
      <span className="spine__title">{book.title}</span>
      {book.author && <span className="spine__author">{shortAuthor(book.author)}</span>}
      <span className="spine__band spine__band--low" />
    </span>
  );
}

function Cover({ book }: { book: Book }) {
  if (book.coverUrl) {
    return (
      <span className="cover">
        <img src={book.coverUrl} alt="" decoding="async" />
      </span>
    );
  }
  // Generated cover in the book's binding colour.
  return (
    <span className="cover cover--generated">
      <span className="cover__title">{book.title}</span>
      <span className="cover__rule" />
      {book.author && <span className="cover__author">{book.author}</span>}
      <span className="cover__format">{book.format.toUpperCase()}</span>
    </span>
  );
}

function shortAuthor(a: string): string {
  const first = a.split(/,| & | and /)[0]!.trim();
  const parts = first.split(/\s+/);
  return (parts[parts.length - 1] ?? first).toUpperCase();
}
