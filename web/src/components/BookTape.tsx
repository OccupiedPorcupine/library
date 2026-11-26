import { memo, type CSSProperties } from "react";
import type { Book } from "../lib/api";
import { isLight } from "../lib/color";
import { shortAuthor } from "../lib/spine";

export interface TapeGeometry {
  /** Spine width in px. */
  ws: number;
  /** Height as a fraction of the shelf's book height. */
  hh: number;
  /** Spine title and author sizes in px, fitted to the spine. */
  ts: number;
  as: number;
}

interface Props {
  book: Book;
  index: number;
  geo: TapeGeometry;
}

/**
 * A book drawn as a 3D box: spine at the front, cover on its right-hand side,
 * page block on top. The shelf turns the whole box with an inline transform,
 * so turning a book to face you is one composited transform, never a re-render.
 * While its file is still uploading (or downloading), the book builds up from the bottom.
 */
export const BookTape = memo(function BookTape({ book, index, geo }: Props) {
  const light = isLight(book.spineColor);
  const style = {
    "--bg": book.spineColor,
    "--fg": light ? "#24211c" : "#f5f1e8",
    "--ws": `${geo.ws}px`,
    "--hh": geo.hh,
    "--ts": `${geo.ts}px`,
    "--as": `${geo.as}px`,
    "--p": book.finishedAt ? 1 : book.progress,
    ...(book.transfer !== undefined && { "--up": book.transfer }),
  } as CSSProperties;
  const moving = book.transfer !== undefined;

  return (
    <div className={`tape${book.finishedAt ? " is-finished" : ""}${moving ? " is-moving" : ""}`} style={style} data-i={index} aria-hidden>
      <div className="tape__face tape__spine">
        <i className="tape__band">{book.format.toUpperCase()}</i>
        <span className="tape__title">{book.title}</span>
        {book.author && <span className="tape__author">{shortAuthor(book.author)}</span>}
        <span className="tape__light" />
        {moving && <span className="tape__front" />}
      </div>
      <div className="tape__face tape__back" />
      <div className="tape__face tape__top" />
      <div className="tape__face tape__cover">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" decoding="async" loading="lazy" draggable={false} />
        ) : (
          <span className="tape__plain">
            <span className="tape__kicker">{book.format.toUpperCase()}</span>
            <span className="tape__ptitle">{book.title}</span>
            {book.author && <span className="tape__pauthor">{book.author}</span>}
          </span>
        )}
        <span className="tape__shade" />
        <span className="tape__light" />
        {moving && <span className="tape__front" />}
      </div>
    </div>
  );
});
