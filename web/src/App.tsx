import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BookPanel } from "./components/BookPanel";
import { READABLE, Reader } from "./components/Reader";
import { SettingsMenu } from "./components/SettingsMenu";
import { Shelf3D } from "./components/Shelf3D";
import { ShelfSuggestions, Spark } from "./components/ShelfSuggestions";
import { ShelfEditor } from "./components/ShelfEditor";
import { ShelfTabs } from "./components/ShelfTabs";
import { api, type Book, type LibraryOverview } from "./lib/api";
import type { BookDrop } from "./lib/bookDrag";

const UNSHELVED = "unshelved";
/** Binding colours for books that are still uploading (the server picks the real one). */
const PENDING_SPINES = ["#2f4b6e", "#7a2e35", "#2f5a46", "#5b4a7a", "#8a6a3a", "#3a3d44"];

export function App() {
  const [data, setData] = useState<LibraryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [editingShelves, setEditingShelves] = useState(false);
  const [dragging, setDragging] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const [detailId, setDetailId] = useState<string | null>(bookFromHash);
  const [reading, setReading] = useState(readFromHash);

  // The open book lives in the URL (#book=<id>), so Back closes the panel and links can be shared.
  useEffect(() => {
    const sync = () => (setDetailId(bookFromHash()), setReading(readFromHash()));
    addEventListener("popstate", sync);
    addEventListener("hashchange", sync);
    return () => (removeEventListener("popstate", sync), removeEventListener("hashchange", sync));
  }, []);
  const openDetails = useCallback((b: Book) => {
    if (bookFromHash() === b.id) return;
    history.pushState({ panel: true }, "", `#book=${encodeURIComponent(b.id)}`);
    setDetailId(b.id);
  }, []);
  // The reader sits on top of the preview: #read=<id>&at=<href or page>. Back returns to the preview.
  const openReader = useCallback((id: string, at?: string) => {
    const q = new URLSearchParams({ read: id });
    if (at) q.set("at", at);
    history.pushState({ reader: true }, "", `#${q}`);
    setReading({ id, at: at ?? null });
  }, []);
  const closeReader = useCallback(() => {
    if (history.state?.reader) return history.back();
    const id = readFromHash()?.id;
    history.replaceState(null, "", id ? `#book=${encodeURIComponent(id)}` : location.pathname + location.search);
    setReading(null);
    setDetailId(id ?? null);
  }, []);

  const closeDetails = useCallback(() => {
    if (history.state?.panel) return history.back();
    // Opened from a link: clear the hash without leaving the app.
    history.replaceState(null, "", location.pathname + location.search);
    setDetailId(null);
  }, []);

  const [pending, setPending] = useState<Book[]>([]);

  const load = useCallback(
    () =>
      api
        .library()
        .then((d) => (setData(d), setError(null)))
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => void load(), [load]);

  // The AI shelves new books in the background a little after upload: refresh to show where they went.
  const later = useRef<number[]>([]);
  const refreshSoon = useCallback(() => {
    later.current.forEach(clearTimeout);
    later.current = [8000, 20000, 45000].map((ms) => window.setTimeout(() => void load(), ms));
  }, [load]);
  useEffect(() => () => later.current.forEach(clearTimeout), []);

  const [sorting, setSorting] = useState(false);
  const sortWithAi = useCallback(async () => {
    setSorting(true);
    try {
      const r = await api.sortLibrary();
      setToast(
        [r.placed && `Placed ${r.placed} ${r.placed === 1 ? "book" : "books"}`, r.suggestions.length && `${r.suggestions.length} shelf ${r.suggestions.length === 1 ? "idea" : "ideas"} to review`]
          .filter(Boolean)
          .join(" · ") || "Nothing to change",
      );
      await load();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSorting(false);
    }
  }, [load]);

  const booksById = useMemo(
    () => new Map((data ? [...data.shelves.flatMap((s) => s.books), ...data.unshelved] : []).map((b) => [b.id, b])),
    [data],
  );

  // An action offered on the toast (Undo), cleared with it.
  const [toastAction, setToastAction] = useState<{ label: string; run: () => void; for: string } | null>(null);
  const action = toastAction && toastAction.for === toast ? toastAction : null;
  useEffect(() => {
    if (!toast) return void setToastAction(null);
    const t = setTimeout(() => setToast(null), action ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast, action]);

  /** A book dragged from one shelf onto another (or onto Unshelved, to take it off). */
  const moveBook = useCallback(
    async ({ book, from, to, copy }: BookDrop) => {
      const fromId = from === UNSHELVED ? null : from;
      const toId = to === UNSHELVED ? null : to;
      if (fromId === toId || (!toId && (copy || !fromId))) return;
      const name = (sid: string | null) => data?.shelves.find((s) => s.id === sid)?.name ?? "Unshelved";
      try {
        await api.moveBooks([book.id], toId, copy ? null : fromId);
        await load();
        const text = toId ? `${copy ? "Added" : "Moved"} “${book.title}” to ${name(toId)}` : `Took “${book.title}” off ${name(fromId)}`;
        setToast(text);
        setToastAction({
          for: text,
          label: "Undo",
          run: () =>
            void (toId ? api.moveBooks([book.id], copy ? null : fromId, toId) : api.moveBooks([book.id], fromId))
              .then(load)
              .then(() => setToast(null))
              .catch((e: Error) => setToast(e.message)),
        });
      } catch (e) {
        setToast((e as Error).message);
      }
    },
    [data, load],
  );

  const upload = useCallback(
    async (files: File[], shelfId?: string) => {
      if (!files.length) return;
      // Each file gets a placeholder book that builds up from the bottom as its bytes arrive.
      const stamp = Date.now();
      const placeholders: Book[] = files.map((f, i) => ({
        id: `uploading-${stamp}-${i}`,
        title: f.name.replace(/\.[^.]+$/, ""),
        author: null,
        format: (f.name.split(".").pop() ?? "").toLowerCase(),
        size: f.size,
        coverUrl: null,
        spineColor: PENDING_SPINES[(stamp + i) % PENDING_SPINES.length]!,
        progress: 0,
        finishedAt: null,
        addedAt: new Date().toISOString(),
        transfer: 0,
      }));
      setPending((p) => [...placeholders, ...p]);
      requestAnimationFrame(() =>
        document.getElementById(`shelf-${UNSHELVED}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
      const setTransfer = (id: string, t: number) =>
        setPending((p) => p.map((b) => (b.id === id ? { ...b, transfer: t } : b)));
      const done = (id: string) => setPending((p) => p.filter((b) => b.id !== id));

      // One request per file, two at a time: a single request for many books can pass the
      // proxy's per-request size limit, and one bad file shouldn't sink the rest.
      let added = 0;
      let dup = 0;
      const failed: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          const file = files[i]!;
          const ph = placeholders[i]!;
          try {
            const { results } = await api.upload([file], {
              shelfId,
              onProgress: (loaded, total) => setTransfer(ph.id, Math.min(1, loaded / (total || 1))),
            });
            const r = results[0];
            if (r?.error) failed.push(`${file.name}: ${r.error}`);
            else if (r?.duplicate) dup++;
            else added++;
          } catch (e) {
            failed.push(`${file.name}: ${(e as Error).message}`);
          } finally {
            done(ph.id);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      setToast(
        [added && `Added ${added}`, dup && `${dup} already in library`, failed.length && `${failed.length} failed (${failed[0]})`]
          .filter(Boolean)
          .join(" · "),
      );
      await load();
      // Covers, cleaned titles and AI shelving arrive in the background shortly after.
      if (added) refreshSoon();
    },
    [load, refreshSoon],
  );

  // Drop files anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setDragging(true));
    const leave = (e: DragEvent) => hasFiles(e) && --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // Dropped on a shelf (or its tab)? Put the books there.
      const el = e.target instanceof Element ? e.target : null;
      const target = el?.closest<HTMLElement>("[data-shelf]")?.dataset.shelf ?? el?.closest<HTMLElement>(".tabs [data-id]")?.dataset.id;
      void upload([...(e.dataTransfer?.files ?? [])], target && target !== UNSHELVED ? target : undefined);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [upload]);

  const shelves = useMemo(() => {
    if (!data) return [];
    const q = deferredQuery.trim().toLowerCase();
    const match = (b: Book) => !q || b.title.toLowerCase().includes(q) || (b.author ?? "").toLowerCase().includes(q);
    const all = [...data.shelves];
    // New uploads land unshelved; books still uploading show there first.
    const loose = [...pending, ...data.unshelved];
    if (loose.length) all.push({ id: UNSHELVED, name: "Unshelved", position: 1e9, books: loose });
    return all.map((s) => ({ ...s, books: s.books.filter(match) })).filter((s) => s.books.length > 0);
  }, [data, pending, deferredQuery]);

  const total = data ? new Set([...data.shelves.flatMap((s) => s.books), ...data.unshelved].map((b) => b.id)).size : 0;
  const inProgress = data
    ? new Set([...data.shelves.flatMap((s) => s.books), ...data.unshelved].filter((b) => b.progress > 0 && !b.finishedAt).map((b) => b.id)).size
    : 0;

  return (
    <div className="app">
      <TopBar query={query} onQuery={setQuery} onUpload={upload} />

      <main className="main">
        <header className="hero">
          <p className="hero__eyebrow">
            <span className="hero__dot" aria-hidden />
            Personal library
          </p>
          <h1 className="hero__title">Your shelves</h1>
          <p className="hero__sub">
            {data ? (
              <>
                {total} {total === 1 ? "book" : "books"}
                {inProgress > 0 && <> · {inProgress} in progress</>}
                {data.ai && data.unshelved.length > 0 && (
                  <button type="button" className="hero__sort" onClick={sortWithAi} disabled={sorting}>
                    <Spark /> {sorting ? "Sorting…" : `Sort ${data.unshelved.length} unshelved with AI`}
                  </button>
                )}
              </>
            ) : (
              " "
            )}
          </p>
        </header>

        {error && <p className="notice">Couldn’t load the library: {error}</p>}

        {data && total === 0 && pending.length === 0 && <EmptyState onUpload={upload} />}

        {data && (total > 0 || pending.length > 0) && (
          <>
            <ShelfSuggestions suggestions={data.suggestions ?? []} books={booksById} onChanged={load} onToast={setToast} />
            <ShelfTabs
              shelves={shelves.map((s) => ({ id: s.id, name: s.name, count: s.books.length }))}
              onCreate={(name) =>
                api
                  .createShelf(name)
                  .then(load)
                  .catch((e: Error) => setToast(e.message))
              }
              onEdit={() => setEditingShelves(true)}
            />
            <div className="shelves">
              {shelves.map((s, i) => (
                <Shelf3D
                  key={s.id}
                  index={i}
                  id={s.id}
                  name={s.name}
                  books={s.books}
                  onDetails={openDetails}
                  onMove={moveBook}
                  onRead={(b) => (READABLE.has(b.format) ? openReader(b.id) : window.open(api.fileUrl(b.id), "_blank", "noopener"))}
                />
              ))}
              {shelves.length === 0 && <p className="notice">No books match “{query}”.</p>}
            </div>
          </>
        )}
      </main>

      {detailId && !reading && (
        <BookPanel
          bookId={detailId}
          onClose={closeDetails}
          onChanged={load}
          onRead={(at) => openReader(detailId, at)}
          shelves={data?.shelves.map((s) => ({ id: s.id, name: s.name })) ?? []}
        />
      )}
      {reading && <Reader key={`${reading.id}:${reading.at}`} bookId={reading.id} at={reading.at} onClose={closeReader} onProgress={load} />}

      {editingShelves && data && (
        <ShelfEditor
          shelves={data.shelves.map((s) => ({ id: s.id, name: s.name, count: s.books.length }))}
          onClose={() => setEditingShelves(false)}
          onChanged={load}
          onToast={setToast}
        />
      )}
      {dragging && (
        <div className="dropzone" aria-hidden>
          <div className="dropzone__card">Drop to add to your library, or onto a shelf to put it there</div>
        </div>
      )}
      <div className={`toast${toast ? " is-visible" : ""}${action ? " has-action" : ""}`} role="status">
        {toast}
        {action && (
          <button type="button" className="toast__action" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

const hashParams = () => new URLSearchParams(location.hash.slice(1));
function bookFromHash(): string | null {
  return hashParams().get("book");
}
function readFromHash(): { id: string; at: string | null } | null {
  const p = hashParams();
  const id = p.get("read");
  return id ? { id, at: p.get("at") } : null;
}

function TopBar({ query, onQuery, onUpload }: { query: string; onQuery: (q: string) => void; onUpload: (f: File[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <Logo />
        <span>Library</span>
      </a>
      <label className="search">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.6 10.6 3.4 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input type="search" placeholder="Search books or authors" value={query} onChange={(e) => onQuery(e.target.value)} />
      </label>
      <div className="topbar__actions">
        <SettingsMenu />
        <button type="button" className="btn btn--primary btn--add" onClick={() => fileRef.current?.click()} aria-label="Add books">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span className="btn__label">Add books</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept=".epub,.pdf,.cbz,.zip,.txt,.md,.mobi,.azw3,.azw,.fb2"
          onChange={(e) => {
            onUpload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
    </header>
  );
}

function EmptyState({ onUpload }: { onUpload: (f: File[]) => void }) {
  return (
    <div className="empty">
      <div className="empty__shelf" aria-hidden>
        <div className="empty__ledge" />
      </div>
      <h2>An empty shelf, waiting.</h2>
      <p>Drop EPUB, PDF, CBZ, MOBI, TXT or Markdown files anywhere on this page, or choose them below.</p>
      <label className="btn btn--primary">
        Choose files
        <input
          type="file"
          multiple
          hidden
          accept=".epub,.pdf,.cbz,.zip,.txt,.md,.mobi,.azw3,.azw,.fb2"
          onChange={(e) => onUpload([...(e.target.files ?? [])])}
        />
      </label>
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect x="4" y="6" width="5" height="21" rx="1.2" fill="currentColor" opacity=".9" />
      <rect x="11" y="4" width="5" height="23" rx="1.2" fill="currentColor" opacity=".6" />
      <rect x="19" y="7" width="7" height="20" rx="1.2" fill="currentColor" opacity=".35" transform="rotate(-9 22.5 17)" />
    </svg>
  );
}
