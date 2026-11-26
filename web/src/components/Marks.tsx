import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { COLORS, SWATCH, type Annotation, type AnnotationColor, type ScreenRect } from "../lib/annotations";
import "../styles/marks.css";

/**
 * The reader's highlight, note and bookmark tools (#48): the toolbar that appears over
 * selected text, the note editor, and the panel listing everything in the book.
 */

const coarse = () => matchMedia("(pointer: coarse)").matches;

/** Floating toolbar for new text (pick a colour to highlight) or a tapped highlight (recolour, note, delete). */
export function SelectionMenu({
  at,
  current,
  onColor,
  onNote,
  onCopy,
  onDelete,
}: {
  at: ScreenRect;
  current: Annotation | null;
  onColor: (c: AnnotationColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onDelete?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  // Above the text, or below it on touch screens, where the phone's own menu sits above.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    const mid = (at.left + at.right) / 2;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, mid - w / 2));
    const roomAbove = at.top - h - gap > 64;
    const roomBelow = at.bottom + h + gap < window.innerHeight - 40;
    const below = coarse() ? roomBelow || !roomAbove : !roomAbove && roomBelow;
    const top = below ? at.bottom + gap : roomAbove ? at.top - h - gap : Math.max(64, (at.top + at.bottom) / 2 - h / 2);
    setPos({ left, top });
  }, [at]);

  // Buttons must not take the selection away before they're pressed.
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="marks-menu" ref={ref} style={pos} role="toolbar" aria-label={current ? "Highlight" : "Highlight selection"} onMouseDown={keep}>
      <div className="marks-menu__swatches">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`marks-swatch${current?.color === c ? " is-on" : ""}`}
            style={{ "--swatch": SWATCH[c].light } as CSSProperties}
            aria-label={`${SWATCH[c].name} highlight`}
            aria-pressed={current ? current.color === c : undefined}
            onClick={() => onColor(c)}
          />
        ))}
      </div>
      <span className="marks-menu__rule" aria-hidden />
      <button type="button" className="marks-menu__btn" onClick={onNote}>
        {current?.note ? "Edit note" : "Note"}
      </button>
      <button type="button" className="marks-menu__btn" onClick={onCopy}>
        Copy
      </button>
      {onDelete && (
        <button type="button" className="marks-menu__btn marks-menu__btn--danger" onClick={onDelete} aria-label="Remove highlight">
          Remove
        </button>
      )}
    </div>
  );
}

/** A sheet for writing a note on a highlight. */
export function NoteEditor({
  quote,
  color,
  initial,
  onSave,
  onCancel,
}: {
  quote: string | null;
  color: AnnotationColor | null;
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);
  return (
    <div className="marks-sheet" role="dialog" aria-label="Note" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <div className="marks-sheet__card">
        {quote && (
          <blockquote className="marks-quote" style={{ "--swatch": SWATCH[color ?? "yellow"].light } as CSSProperties}>
            {quote}
          </blockquote>
        )}
        <textarea
          ref={ref}
          className="marks-sheet__text"
          value={text}
          rows={5}
          maxLength={20000}
          placeholder="Write a note…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(text.trim());
          }}
        />
        <div className="marks-sheet__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onSave(text.trim())}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

type Filter = "all" | "highlight" | "note" | "bookmark";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["highlight", "Highlights"],
  ["note", "Notes"],
  ["bookmark", "Bookmarks"],
];

/** Everything marked in the book, in reading order; tap one to go there. */
export function MarksPanel({
  list,
  onGo,
  onEdit,
  onDelete,
}: {
  list: Annotation[];
  onGo: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = list.filter((a) =>
    filter === "all" ? true : filter === "note" ? !!a.note : filter === "highlight" ? a.kind === "highlight" : a.kind === "bookmark",
  );
  const count = (f: Filter) => list.filter((a) => (f === "all" ? true : f === "note" ? !!a.note : a.kind === f)).length;
  return (
    <div className="reader__toc marks-panel" role="dialog" aria-label="Highlights, notes and bookmarks">
      <div className="marks-panel__filters" role="tablist">
        {FILTERS.map(([f, name]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`marks-filter${filter === f ? " is-on" : ""}`} onClick={() => setFilter(f)}>
            {name}
            <span className="marks-filter__n">{count(f)}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="marks-panel__empty">
          {list.length === 0
            ? "Select text to highlight it, or use the bookmark button to mark a page."
            : "Nothing here yet."}
        </p>
      ) : (
        <ol className="marks-list">
          {shown.map((a) => (
            <li key={a.id} className="marks-item">
              <button type="button" className="marks-item__go" onClick={() => onGo(a)}>
                <span className="marks-item__where">
                  {a.kind === "bookmark" ? (
                    <BookmarkIcon filled />
                  ) : (
                    <span className="marks-dot" style={{ "--swatch": SWATCH[a.color ?? "yellow"].light } as CSSProperties} aria-hidden />
                  )}
                  {where(a)}
                </span>
                {a.text && <span className="marks-item__text">{a.text}</span>}
                {a.note && <span className="marks-item__note">{a.note}</span>}
              </button>
              <div className="marks-item__tools">
                {a.kind === "highlight" && (
                  <button type="button" className="marks-item__tool" onClick={() => onEdit(a)}>
                    {a.note ? "Edit note" : "Add note"}
                  </button>
                )}
                <button type="button" className="marks-item__tool marks-item__tool--danger" onClick={() => onDelete(a)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function where(a: Annotation) {
  const pct = `${Math.round(a.fraction * 100)}%`;
  if (a.page != null) return a.label ? `${a.label} · p. ${a.page}` : `Page ${a.page}`;
  return a.label ? `${a.label} · ${pct}` : pct;
}

export function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="12" height="15" viewBox="0 0 12 15" aria-hidden className="bookmark-icon">
      <path d="M1.5 1.5h9v12L6 10.4 1.5 13.5z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function NotesIcon() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>
      <path d="M1.5 2h13M1.5 7h13M1.5 12h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
