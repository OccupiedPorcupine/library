import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { api, type BookDetail, type FieldSource, type MetadataPatch, type TocEntry } from "../lib/api";
import { isLight } from "../lib/color";
import { READABLE, tocTarget } from "./Reader";

interface Props {
  bookId: string;
  onClose: () => void;
  /** Called after the book changed (edit, new cover, online refresh) so the shelves can reload. */
  onChanged: () => void;
  /** Opens the in-app reader, optionally at a contents entry (href or PDF page). */
  onRead: (at?: string) => void;
}

const SOURCE_NAMES: Record<FieldSource, string> = {
  filename: "the file name",
  file: "the file",
  ai: "AI reading the opening pages",
  openlibrary: "Open Library",
  googlebooks: "Google Books",
  user: "you",
};

const languageNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(undefined, { type: "language" }) : null;
const language = (code: string) => {
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
};
const published = (s: string) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : s;
};
const fileSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const joinNames = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Polls while the server is still looking the book up online. */
const POLL_MS = 4000;
const POLL_TRIES = 8;

/**
 * A porcelain side panel with everything known about a book: cover, details,
 * description, subjects and table of contents, with an edit mode for fixing anything.
 */
export function BookPanel({ bookId, onClose, onChanged, onRead }: Props) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "refresh" | "save" | "cover">("");
  const [note, setNote] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer = 0;
    setBook(null);
    setEditing(false);
    setError(null);
    const load = () =>
      api
        .book(bookId)
        .then((b) => {
          if (!alive) return;
          setBook((prev) => {
            if (prev?.lookupPending && !b.lookupPending) onChanged();
            return b;
          });
          if (b.lookupPending && ++tries < POLL_TRIES) timer = window.setTimeout(load, POLL_MS);
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Modal behaviour: focus inside, Escape closes, page behind doesn't scroll.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex='0']");
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (last?.focus(), e.preventDefault());
        else if (!e.shiftKey && document.activeElement === last) (first?.focus(), e.preventDefault());
      }
    };
    document.addEventListener("keydown", key);
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.documentElement.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const refresh = async () => {
    if (!book) return;
    setBusy("refresh");
    try {
      const before = JSON.stringify({ ...book, metaCheckedAt: null });
      const b = await api.refreshMetadata(book.id);
      setBook(b);
      onChanged();
      setNote(JSON.stringify({ ...b, metaCheckedAt: null }) === before ? "Nothing new found online." : "Updated from online sources.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const changeCover = async (file: File | undefined) => {
    if (!book || !file) return;
    setBusy("cover");
    try {
      setBook(await api.setCover(book.id, file));
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="panel-root">
      <div className="panel-scrim" onClick={onClose} aria-hidden />
      <div className={`panel${book && !editing ? " panel--preview" : ""}`} ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="panel-title">
        <div className="panel__bar">
          <span className="panel__kicker">{editing ? "Edit details" : "Preview"}</span>
          <button type="button" className="icon-btn" ref={closeRef} onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="m2 2 8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {error && <p className="notice">Couldn’t load this book: {error}</p>}
        {!book && !error && <PanelSkeleton />}

        {book && !editing && (
          <View
            book={book}
            busy={busy}
            onEdit={() => setEditing(true)}
            onRefresh={refresh}
            onRead={onRead}
          />
        )}
        {book && editing && (
          <EditForm
            book={book}
            onCancel={() => setEditing(false)}
            onSaved={(b) => {
              setBook(b);
              setEditing(false);
              onChanged();
              setNote("Saved. Online lookups won’t change what you edited.");
            }}
            onCover={changeCover}
            busy={busy}
            setBusy={setBusy}
          />
        )}

        <div className={`panel__note${note ? " is-visible" : ""}`} role="status">
          {note}
        </div>
      </div>
    </div>
  );
}

function View({
  book,
  busy,
  onEdit,
  onRefresh,
  onRead,
}: {
  book: BookDetail;
  busy: string;
  onEdit: () => void;
  onRefresh: () => void;
  onRead: (at?: string) => void;
}) {
  const [more, setMore] = useState(false);
  const pct = Math.round((book.finishedAt ? 1 : book.progress) * 100);
  const facts: [string, string][] = [];
  if (book.publisher) facts.push(["Publisher", book.publisher]);
  if (book.published) facts.push(["Published", published(book.published)]);
  if (book.pageCount) facts.push(["Pages", String(book.pageCount)]);
  if (book.language) facts.push(["Language", language(book.language)]);
  if (book.isbn13) facts.push(["ISBN", book.isbn13]);
  facts.push(["Format", `${book.format.toUpperCase()} · ${fileSize(book.size)}`]);
  facts.push(["Added", new Date(book.addedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })]);

  const from = [...new Set(Object.values(book.sources).filter((s): s is FieldSource => !!s && s !== "user" && s !== "filename"))];
  const edited = Object.values(book.sources).includes("user");
  const long = (book.description?.length ?? 0) > 420;

  const readable = READABLE.has(book.format);
  return (
    <div className="panel__body preview">
      <div className="panel__hero preview__hero">
        <OpenCover book={book} onRead={() => onRead()} />
        <div className="panel__heading">
          {book.series && (
            <span className="panel__series">
              {book.series}
              {book.seriesIndex != null && ` · Book ${book.seriesIndex}`}
            </span>
          )}
          <h2 id="panel-title" className="panel__title">
            {book.title}
          </h2>
          {book.subtitle && <p className="panel__subtitle">{book.subtitle}</p>}
          <p className="panel__author">{book.author ?? "Unknown author"}</p>
          <span className="caption__progress">
            <span className="meter" style={{ "--p": pct / 100 } as CSSProperties} />
            {book.finishedAt ? "Finished" : pct ? `${pct}% read` : "Not started"}
          </span>
          <div className="panel__actions">
            {readable ? (
              <button type="button" className="btn btn--primary" onClick={() => onRead()}>
                {pct && !book.finishedAt ? "Continue" : "Read"}
              </button>
            ) : (
              <a className="btn btn--primary" href={api.fileUrl(book.id)} target="_blank" rel="noreferrer">
                Open file
              </a>
            )}
            <button type="button" className="btn" onClick={onEdit}>
              Edit
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--lg"
              onClick={onRefresh}
              disabled={!!busy}
              aria-label="Look up details again"
              title="Look up details again"
            >
              <svg className={busy === "refresh" ? "spin" : undefined} width="15" height="15" viewBox="0 0 16 16" aria-hidden>
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <Contents book={book} onRead={onRead} />

      <div className="preview__rest">
      {book.lookupPending && (
        <p className="panel__looking">
          <span className="dot-pulse" aria-hidden /> Looking up details…
        </p>
      )}

      {book.description && (
        <section className="panel__section">
          <h3 className="panel__h">Description</h3>
          <p className={`panel__desc${long && !more ? " is-clamped" : ""}`}>{book.description}</p>
          {long && (
            <button type="button" className="link-btn" onClick={() => setMore((m) => !m)}>
              {more ? "Show less" : "Show more"}
            </button>
          )}
        </section>
      )}

      <section className="panel__section">
        <h3 className="panel__h">Details</h3>
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k} className="facts__row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {book.subjects.length > 0 && (
        <section className="panel__section">
          <h3 className="panel__h">Subjects</h3>
          <ul className="pills">
            {book.subjects.map((s) => (
              <li key={s} className="pill">
                {s}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="panel__sources">
        {from.length > 0 && <>Details from {joinNames(from.map((s) => SOURCE_NAMES[s]))}. </>}
        {edited && <>Some fields edited by you. </>}
        {book.metaCheckedAt
          ? `Checked online ${new Date(book.metaCheckedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.`
          : ""}
        <span className="panel__file">{book.fileName}</span>
      </p>
      </div>
    </div>
  );
}

/** The heart of the preview: every contents entry opens the book right there. */
function Contents({ book, onRead }: { book: BookDetail; onRead: (at?: string) => void }) {
  const [open, setOpen] = useState(book.toc.length <= 30);
  const minLevel = book.toc.length ? Math.min(...book.toc.map((t) => t.level)) : 0;
  const shown = open ? book.toc : book.toc.filter((t) => t.level === minLevel).slice(0, 30);
  return (
    <section className="panel__section preview__contents" aria-labelledby="contents-h">
      <h3 className="panel__h" id="contents-h">
        Contents {book.toc.length > 0 && <span className="panel__count">{book.toc.length}</span>}
      </h3>
      {book.toc.length === 0 ? (
        <p className="preview__empty">
          This file has no table of contents.{" "}
          {READABLE.has(book.format) ? "Tap the cover to start reading." : ""}
        </p>
      ) : (
        <ol className="toc">
          {shown.map((t, i) => {
            const target = tocTarget(book.format, t);
            const inner = (
              <>
                <span className="toc__title">{t.title}</span>
                {t.page != null && <span className="toc__page">{t.page}</span>}
              </>
            );
            return (
              <li key={i} className={`toc__item${t.level === minLevel ? " is-top" : ""}`} style={{ "--lvl": Math.min(4, t.level - minLevel) } as CSSProperties}>
                {target ? (
                  <button type="button" className="toc__row" onClick={() => onRead(target)}>
                    {inner}
                    <svg className="toc__go" width="12" height="10" viewBox="0 0 18 10" aria-hidden>
                      <path d="M1 5h16m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                ) : (
                  <span className="toc__row">{inner}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {book.toc.length > 30 && (
        <button type="button" className="link-btn" onClick={() => setOpen((o) => !o)}>
          {open ? "Show chapters only" : `Show all ${book.toc.length} entries`}
        </button>
      )}
    </section>
  );
}

/** The cover in the preview: tap or click it to open the book. */
function OpenCover({ book, onRead }: { book: BookDetail; onRead: () => void }) {
  const light = isLight(book.spineColor);
  const readable = READABLE.has(book.format);
  const art = book.coverUrl ? (
    <img src={book.coverUrl} alt="" />
  ) : (
    <span className="panel__plain" style={{ background: book.spineColor, color: light ? "#24211c" : "#f5f1e8" }}>
      <span className="tape__kicker">{book.format.toUpperCase()}</span>
      <span className="tape__ptitle">{book.title}</span>
      {book.author && <span className="tape__pauthor">{book.author}</span>}
    </span>
  );
  if (!readable)
    return (
      <a className="panel__cover is-openable" href={api.fileUrl(book.id)} target="_blank" rel="noreferrer" aria-label={`Open ${book.title}`}>
        {art}
      </a>
    );
  return (
    <button type="button" className="panel__cover is-openable" onClick={onRead} aria-label={`Read ${book.title}`}>
      {art}
      <span className="panel__cover-hint">Read</span>
    </button>
  );
}

function Cover({
  book,
  onCover,
  busy,
  editable = false,
}: {
  book: BookDetail;
  onCover: (f: File | undefined) => void;
  busy: boolean;
  editable?: boolean;
}) {
  const light = isLight(book.spineColor);
  const art = book.coverUrl ? (
        <img src={book.coverUrl} alt={`Cover of ${book.title}`} />
      ) : (
        <span className="panel__plain" style={{ background: book.spineColor, color: light ? "#24211c" : "#f5f1e8" }}>
          <span className="tape__kicker">{book.format.toUpperCase()}</span>
          <span className="tape__ptitle">{book.title}</span>
          {book.author && <span className="tape__pauthor">{book.author}</span>}
        </span>
  );
  if (!editable) return <div className="panel__cover">{art}</div>;
  return (
    <label className={`panel__cover is-editable${busy ? " is-busy" : ""}`} title="Change cover">
      {art}
      <span className="panel__cover-hint">{busy ? "Uploading…" : "Change cover"}</span>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => (onCover(e.target.files?.[0]), (e.target.value = ""))} />
    </label>
  );
}

type FormState = Record<
  "title" | "subtitle" | "author" | "series" | "seriesIndex" | "description" | "publisher" | "published" | "pageCount" | "language" | "isbn13" | "subjects",
  string
>;

const toForm = (b: BookDetail): FormState => ({
  title: b.title,
  subtitle: b.subtitle ?? "",
  author: b.author ?? "",
  series: b.series ?? "",
  seriesIndex: b.seriesIndex?.toString() ?? "",
  description: b.description ?? "",
  publisher: b.publisher ?? "",
  published: b.published ?? "",
  pageCount: b.pageCount?.toString() ?? "",
  language: b.language ?? "",
  isbn13: b.isbn13 ?? "",
  subjects: b.subjects.join(", "),
});

function EditForm({
  book,
  onCancel,
  onSaved,
  onCover,
  busy,
  setBusy,
}: {
  book: BookDetail;
  onCancel: () => void;
  onSaved: (b: BookDetail) => void;
  onCover: (f: File | undefined) => void;
  busy: string;
  setBusy: (b: "" | "save") => void;
}) {
  const initial = useRef(toForm(book));
  const [form, setForm] = useState<FormState>(initial.current);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return setError("A book needs a title.");
    // Send only what changed, so untouched fields keep their source and can still be filled online.
    const patch: MetadataPatch = {};
    for (const k of Object.keys(form) as (keyof FormState)[]) {
      if (form[k] === initial.current[k]) continue;
      const v = form[k].trim();
      if (k === "subjects") patch.subjects = v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      else if (k === "seriesIndex" || k === "pageCount") patch[k] = v === "" ? null : Number(v);
      else (patch as Record<string, string | null>)[k] = v || null;
    }
    if (!Object.keys(patch).length) return onCancel();
    setBusy("save");
    setError(null);
    try {
      onSaved(await api.updateMetadata(book.id, patch));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const field = (k: keyof FormState, label: string, props: Record<string, unknown> = {}) => (
    <label className={`field${props.wide ? " field--wide" : ""}`}>
      <span className="field__label">
        {label}
        {book.sources[k] === "user" && <span className="field__tag">edited</span>}
      </span>
      <input className="field__input" value={form[k]} onChange={set(k)} {...{ ...props, wide: undefined }} />
    </label>
  );

  return (
    <form className="panel__body edit" onSubmit={submit}>
      <div className="edit__cover">
        <Cover book={book} onCover={onCover} busy={busy === "cover"} editable />
        <p className="edit__hint">Click the cover to upload your own image. Fields you change here are kept even when details are looked up online again.</p>
      </div>
      <h2 id="panel-title" className="visually-hidden">
        Edit {book.title}
      </h2>
      <div className="edit__grid">
        {field("title", "Title", { wide: true, required: true })}
        {field("subtitle", "Subtitle", { wide: true })}
        {field("author", "Author(s)", { wide: true, placeholder: "Separate several with commas" })}
        {field("series", "Series")}
        {field("seriesIndex", "Number in series", { inputMode: "decimal" })}
        <label className="field field--wide">
          <span className="field__label">
            Description
            {book.sources.description === "user" && <span className="field__tag">edited</span>}
          </span>
          <textarea className="field__input" rows={6} value={form.description} onChange={set("description")} />
        </label>
        {field("publisher", "Publisher")}
        {field("published", "Published", { placeholder: "e.g. 2020 or 2020-09-15" })}
        {field("pageCount", "Pages", { inputMode: "numeric" })}
        {field("language", "Language", { placeholder: "e.g. en" })}
        {field("isbn13", "ISBN", { wide: true, placeholder: "ISBN-10 or ISBN-13" })}
        {field("subjects", "Subjects", { wide: true, placeholder: "Separate with commas" })}
      </div>
      {error && <p className="edit__error">{error}</p>}
      <div className="edit__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy === "save"}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function PanelSkeleton() {
  return (
    <div className="panel__body" aria-hidden>
      <div className="panel__hero">
        <div className="panel__cover skeleton" />
        <div className="panel__heading">
          <span className="skeleton skeleton--line" style={{ width: "80%" }} />
          <span className="skeleton skeleton--line" style={{ width: "50%" }} />
        </div>
      </div>
    </div>
  );
}
