import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BookPanel } from "./components/BookPanel";
import { SettingsMenu } from "./components/SettingsMenu";
import { Shelf3D } from "./components/Shelf3D";
import { ShelfTabs } from "./components/ShelfTabs";
import { api, type Book, type LibraryOverview } from "./lib/api";

const UNSHELVED = "unshelved";

export function App() {
  const [data, setData] = useState<LibraryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const [detailId, setDetailId] = useState<string | null>(bookFromHash);

  // The open book lives in the URL (#book=<id>), so Back closes the panel and links can be shared.
  useEffect(() => {
    const sync = () => setDetailId(bookFromHash());
    addEventListener("popstate", sync);
    addEventListener("hashchange", sync);
    return () => (removeEventListener("popstate", sync), removeEventListener("hashchange", sync));
  }, []);
  const openDetails = useCallback((b: Book) => {
    if (bookFromHash() === b.id) return;
    history.pushState({ panel: true }, "", `#book=${encodeURIComponent(b.id)}`);
    setDetailId(b.id);
  }, []);
  const closeDetails = useCallback(() => {
    if (history.state?.panel) return history.back();
    // Opened from a link: clear the hash without leaving the app.
    history.replaceState(null, "", location.pathname + location.search);
    setDetailId(null);
  }, []);

  const load = useCallback(() => {
    api
      .library()
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setToast(`Uploading ${files.length} ${files.length === 1 ? "file" : "files"}…`);
      try {
        const { results } = await api.upload(files);
        const failed = results.filter((r) => r.error);
        const dup = results.filter((r) => r.duplicate).length;
        const added = results.length - failed.length - dup;
        setToast(
          [added && `Added ${added}`, dup && `${dup} already in library`, failed.length && `${failed.length} failed: ${failed[0]!.error}`]
            .filter(Boolean)
            .join(" · "),
        );
        load();
      } catch (e) {
        setToast(`Upload failed: ${(e as Error).message}`);
      }
    },
    [load],
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
      void upload([...(e.dataTransfer?.files ?? [])]);
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
    if (data.unshelved.length) all.push({ id: UNSHELVED, name: "Unshelved", position: 1e9, books: data.unshelved });
    return all.map((s) => ({ ...s, books: s.books.filter(match) })).filter((s) => s.books.length > 0);
  }, [data, deferredQuery]);

  const total = data ? new Set([...data.shelves.flatMap((s) => s.books), ...data.unshelved].map((b) => b.id)).size : 0;
  const reading = data
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
                {reading > 0 && <> · {reading} in progress</>}
              </>
            ) : (
              " "
            )}
          </p>
        </header>

        {error && <p className="notice">Couldn’t load the library: {error}</p>}

        {data && total === 0 && <EmptyState onUpload={upload} />}

        {data && total > 0 && (
          <>
            <ShelfTabs
              shelves={shelves.map((s) => ({ id: s.id, name: s.name, count: s.books.length }))}
              onCreate={(name) =>
                api
                  .createShelf(name)
                  .then(load)
                  .catch((e: Error) => setToast(e.message))
              }
            />
            <div className="shelves">
              {shelves.map((s, i) => (
                <Shelf3D key={s.id} index={i} id={s.id} name={s.name} books={s.books} onDetails={openDetails} />
              ))}
              {shelves.length === 0 && <p className="notice">No books match “{query}”.</p>}
            </div>
          </>
        )}
      </main>

      {detailId && <BookPanel bookId={detailId} onClose={closeDetails} onChanged={load} />}

      {dragging && (
        <div className="dropzone" aria-hidden>
          <div className="dropzone__card">Drop to add to your library</div>
        </div>
      )}
      <div className={`toast${toast ? " is-visible" : ""}`} role="status">
        {toast}
      </div>
    </div>
  );
}

function bookFromHash(): string | null {
  const m = /^#book=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
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
          accept=".epub,.pdf,.cbz,.txt,.md,.mobi,.azw3,.azw,.fb2"
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
          accept=".epub,.pdf,.cbz,.txt,.md,.mobi,.azw3,.azw,.fb2"
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
