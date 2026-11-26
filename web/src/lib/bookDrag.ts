import type { Book } from "./api";

export interface BookDrop {
  book: Book;
  from: string;
  /** Shelf id under the pointer when released. */
  to: string;
  /** Alt/Option held: add to the new shelf and keep it on this one. */
  copy: boolean;
}

/** Finds the shelf (section or tab in the shelf bar) under a point. */
function shelfAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>(".tabs [data-id], [data-shelf]") ?? null;
}
const shelfId = (el: HTMLElement) => el.dataset.shelf ?? el.dataset.id ?? "";

/**
 * Picks a book up off a shelf: a small card follows the pointer, the shelf or tab under it
 * lights up, and releasing over another shelf reports the drop. Escape cancels.
 */
export function startBookDrag(book: Book, from: string, start: { x: number; y: number }, onDrop: (d: BookDrop) => void) {
  const ghost = document.createElement("div");
  ghost.className = "book-ghost";
  ghost.style.setProperty("--spine", book.spineColor);
  if (book.coverUrl) {
    const img = document.createElement("img");
    img.src = book.coverUrl;
    img.alt = "";
    ghost.append(img);
  }
  const label = document.createElement("span");
  label.textContent = book.title;
  ghost.append(label);
  document.body.append(ghost);
  document.documentElement.classList.add("is-dragging-book");
  navigator.vibrate?.(12);

  let over: HTMLElement | null = null;
  let x = start.x;
  let y = start.y;
  let copy = false;
  const place = () => {
    ghost.style.transform = `translate(${x}px, ${y}px) translate(14px, 14px) rotate(-3deg)`;
    const next = shelfAt(x, y);
    const target = next && shelfId(next) !== from ? next : null;
    if (target !== over) {
      over?.classList.remove("is-drop-target");
      target?.classList.add("is-drop-target");
      over = target;
    }
    ghost.classList.toggle("is-copy", copy);
  };
  place();

  // Keep the page from scrolling under a finger while carrying the book, but scroll it
  // gently when the book is held near the top or bottom edge.
  const noScroll = (e: TouchEvent) => e.cancelable && e.preventDefault();
  let raf = 0;
  const edgeScroll = () => {
    const edge = 70;
    const dy = y < edge ? -(edge - y) : y > innerHeight - edge ? y - (innerHeight - edge) : 0;
    if (dy) {
      scrollBy(0, dy * 0.25);
      place();
    }
    raf = requestAnimationFrame(edgeScroll);
  };
  raf = requestAnimationFrame(edgeScroll);

  const move = (e: PointerEvent) => {
    x = e.clientX;
    y = e.clientY;
    copy = e.altKey;
    place();
  };
  const finish = (drop: boolean) => {
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", cancel);
    removeEventListener("keydown", key);
    removeEventListener("touchmove", noScroll);
    over?.classList.remove("is-drop-target");
    document.documentElement.classList.remove("is-dragging-book");
    ghost.classList.add(drop && over ? "is-dropped" : "is-cancelled");
    setTimeout(() => ghost.remove(), 220);
    if (drop && over) onDrop({ book, from, to: shelfId(over), copy });
  };
  const up = (e: PointerEvent) => {
    copy = e.altKey;
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => e.key === "Escape" && finish(false);
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", cancel);
  addEventListener("keydown", key);
  addEventListener("touchmove", noScroll, { passive: false });
}
