import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface Props {
  shelves: { id: string; name: string; count: number }[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

/** Rename, reorder (drag the handle or use the arrows), add and delete shelves. */
export function ShelfEditor({ shelves, onClose, onChanged, onToast }: Props) {
  const [order, setOrder] = useState(shelves);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startY: number; h: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // Keep counts and names fresh without losing an in-progress drag.
  useEffect(() => {
    if (!drag.current) setOrder((o) => shelves.map((s) => ({ ...s, name: o.find((x) => x.id === s.id)?.name ?? s.name })));
  }, [shelves]);

  useEffect(() => {
    dialogRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const saveOrder = async (next: typeof order) => {
    setOrder(next);
    try {
      await api.reorderShelves(next.map((s) => s.id));
      onChanged();
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void saveOrder(next);
  };
  const rename = async (id: string, name: string) => {
    const was = shelves.find((s) => s.id === id)?.name;
    if (!name.trim() || name.trim() === was) return;
    try {
      await api.renameShelf(id, name.trim());
      onChanged();
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    setConfirm(null);
    try {
      await api.deleteShelf(id);
      setOrder((o) => o.filter((s) => s.id !== id));
      onChanged();
      onToast("Shelf deleted. Its books are still in your library.");
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const add = async () => {
    if (!newName.trim()) return;
    try {
      await api.createShelf(newName.trim());
      setNewName("");
      onChanged();
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  // Drag the handle to reorder: rows swap as you pass their middle.
  const onHandleDown = (e: React.PointerEvent, id: string) => {
    const row = (e.currentTarget as HTMLElement).closest("li")!;
    drag.current = { id, startY: e.clientY, h: row.getBoundingClientRect().height };
    setDragging(id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    const steps = Math.trunc(dy / d.h);
    if (!steps) return;
    setOrder((o) => {
      const i = o.findIndex((s) => s.id === d.id);
      const j = Math.max(0, Math.min(o.length - 1, i + steps));
      if (i === j) return o;
      const next = [...o];
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item!);
      d.startY += (j - i) * d.h;
      return next;
    });
  };
  const onHandleUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(null);
    void saveOrder(order);
  };

  return (
    <div className="panel-root">
      <div className="panel-scrim" onClick={onClose} aria-hidden />
      <div className="editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" tabIndex={-1} ref={dialogRef}>
        <div className="panel__bar">
          <span className="panel__kicker" id="editor-title">
            Edit shelves
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="m2 2 8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="editor__hint">Drag the handle to reorder. To move a book, drag it from one shelf onto another (or onto a shelf name in the bar), or tick its shelves in its preview.</p>
        <ol className="editor__list" ref={listRef}>
          {order.map((s, i) => (
            <li key={s.id} className={`editor__row${dragging === s.id ? " is-dragging" : ""}`}>
              <button
                type="button"
                className="editor__handle"
                aria-label={`Reorder ${s.name}`}
                onPointerDown={(e) => onHandleDown(e, s.id)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") (move(i, -1), e.preventDefault());
                  if (e.key === "ArrowDown") (move(i, 1), e.preventDefault());
                }}
              >
                <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
                  {[2, 7, 12].map((y) => [3, 9].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
                </svg>
              </button>
              <input
                className="field__input editor__name"
                defaultValue={s.name}
                aria-label="Shelf name"
                onBlur={(e) => void rename(s.id, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              <span className="editor__count">{s.count}</span>
              {confirm === s.id ? (
                <span className="editor__confirm">
                  <button type="button" className="btn btn--danger" onClick={() => void remove(s.id)}>
                    Delete
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="icon-btn" aria-label={`Delete ${s.name}`} title="Delete shelf" onClick={() => setConfirm(s.id)}>
                  <svg width="13" height="14" viewBox="0 0 13 14" aria-hidden>
                    <path d="M1.5 3.5h10M5 3.5V2h3v1.5M3 3.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ol>
        <form
          className="editor__add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="field__input" placeholder="New shelf name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New shelf name" />
          <button type="submit" className="btn btn--primary" disabled={!newName.trim()}>
            Add shelf
          </button>
        </form>
      </div>
    </div>
  );
}
