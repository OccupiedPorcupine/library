import { useState } from "react";
import { api, type Book, type ShelfSuggestion } from "../lib/api";

interface Props {
  suggestions: ShelfSuggestion[];
  books: Map<string, Book>;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

/** Shelves the AI suggests. Nothing is created until you accept, and you can rename first. */
export function ShelfSuggestions({ suggestions, books, onChanged, onToast }: Props) {
  if (!suggestions.length) return null;
  return (
    <section className="suggest" aria-label="Suggested shelves">
      <p className="suggest__label">
        <Spark /> Suggested shelves
      </p>
      <div className="suggest__list">
        {suggestions.map((s) => (
          <Card key={s.id} s={s} books={books} onChanged={onChanged} onToast={onToast} />
        ))}
      </div>
    </section>
  );
}

function Card({ s, books, onChanged, onToast }: { s: ShelfSuggestion; books: Map<string, Book>; onChanged: () => void; onToast: (m: string) => void }) {
  const [name, setName] = useState(s.name);
  const [busy, setBusy] = useState(false);
  const titles = s.bookIds.map((id) => books.get(id)?.title).filter(Boolean) as string[];
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      onToast(done);
      onChanged();
    } catch (e) {
      onToast((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <article className="suggest__card">
      <input className="suggest__name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Shelf name" />
      {s.reason && <p className="suggest__reason">{s.reason}</p>}
      <p className="suggest__books">
        {titles.slice(0, 4).join(" · ")}
        {titles.length > 4 && ` and ${titles.length - 4} more`}
      </p>
      <div className="suggest__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.dismissSuggestion(s.id), "Suggestion dismissed")}>
          Dismiss
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !name.trim()}
          onClick={() => act(() => api.acceptSuggestion(s.id, name.trim()), `Added the “${name.trim()}” shelf`)}
        >
          Add shelf ({s.bookIds.length})
        </button>
      </div>
    </article>
  );
}

export function Spark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" fill="currentColor" />
    </svg>
  );
}
