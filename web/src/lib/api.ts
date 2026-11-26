export interface Book {
  id: string;
  title: string;
  author: string | null;
  format: string;
  size: number;
  coverUrl: string | null;
  spineColor: string;
  progress: number;
  finishedAt: string | null;
  addedAt: string;
  /** Page count when known (from metadata); used for spine thickness. */
  pageCount?: number | null;
  /** Set while the file is still moving (uploading now; downloading for offline later): 0 to 1. */
  transfer?: number;
}

export interface TocEntry {
  title: string;
  level: number;
  href?: string;
  page?: number;
}

export type FieldSource = "filename" | "file" | "ai" | "openlibrary" | "googlebooks" | "user";

export interface BookDetail extends Book {
  subtitle: string | null;
  series: string | null;
  seriesIndex: number | null;
  description: string | null;
  publisher: string | null;
  published: string | null;
  pageCount: number | null;
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  subjects: string[];
  toc: TocEntry[];
  fileName: string;
  sources: Partial<Record<string, FieldSource>>;
  metaCheckedAt: string | null;
  lookupPending: boolean;
  shelfIds: string[];
}

export type MetadataPatch = Partial<
  Pick<
    BookDetail,
    "title" | "subtitle" | "author" | "series" | "seriesIndex" | "description" | "publisher" | "published" | "pageCount" | "language" | "isbn13" | "subjects"
  >
>;

export interface Shelf {
  id: string;
  name: string;
  position: number;
  books: Book[];
}

export interface ShelfSuggestion {
  id: string;
  name: string;
  reason: string | null;
  bookIds: string[];
}

export interface LibraryOverview {
  shelves: Shelf[];
  unshelved: Book[];
  /** New shelves the AI suggests, waiting for you to accept or dismiss. */
  suggestions: ShelfSuggestion[];
  /** Whether the server has an AI key set up. */
  ai: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  library: () => fetch("/api/library").then((r) => json<LibraryOverview>(r)),

  /** Uploads files in one request, reporting bytes sent as it goes (fetch can't report upload progress). */
  upload: (files: File[], opts: { shelfId?: string; onProgress?: (loaded: number, total: number) => void } = {}) => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    const q = opts.shelfId ? `?shelf=${encodeURIComponent(opts.shelfId)}` : "";
    type Result = { results: { file: string; error?: string; duplicate?: boolean }[] };
    return new Promise<Result>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/books${q}`);
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded, e.total);
      xhr.onload = () => {
        const body = xhr.response as (Result & { error?: string }) | null;
        if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
        else if (xhr.status === 413) reject(new Error(body?.error ?? "too large to upload (over the size limit)"));
        else reject(new Error(body?.error ?? `${xhr.status} ${xhr.statusText || "Upload failed"}`));
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(form);
    });
  },

  createShelf: (name: string) =>
    fetch("/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ id: string }>(r)),

  book: (id: string) => fetch(`/api/books/${id}`).then((r) => json<BookDetail>(r)),

  updateMetadata: (id: string, patch: MetadataPatch) =>
    fetch(`/api/books/${id}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<BookDetail>(r)),

  refreshMetadata: (id: string) => fetch(`/api/books/${id}/metadata/refresh`, { method: "POST" }).then((r) => json<BookDetail>(r)),

  setCover: (id: string, file: File) => {
    const form = new FormData();
    form.append("cover", file, file.name);
    return fetch(`/api/books/${id}/cover`, { method: "PUT", body: form }).then((r) => json<BookDetail>(r));
  },

  /** Move books to a shelf (from one shelf, or none for an add). `to: null` takes them off `from`. */
  moveBooks: (bookIds: string[], to: string | null, from?: string | null) =>
    fetch("/api/books/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookIds, to, from: from ?? null }),
    }).then((r) => json<{ ok: true }>(r)),

  setBookShelves: (id: string, shelfIds: string[]) =>
    fetch(`/api/books/${id}/shelves`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shelfIds }),
    }).then((r) => json<{ ok: true }>(r)),

  renameShelf: (id: string, name: string) =>
    fetch(`/api/shelves/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ ok: true }>(r)),

  deleteShelf: (id: string) =>
    fetch(`/api/shelves/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),

  reorderShelves: (ids: string[]) =>
    fetch("/api/shelves/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ ok: true }>(r)),

  sortLibrary: () =>
    fetch("/api/library/sort", { method: "POST" }).then((r) => json<{ placed: number; suggestions: ShelfSuggestion[] }>(r)),

  acceptSuggestion: (id: string, name?: string) =>
    fetch(`/api/shelf-suggestions/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    }).then((r) => json<{ id: string; name: string }>(r)),

  dismissSuggestion: (id: string) =>
    fetch(`/api/shelf-suggestions/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),

  setProgress: (id: string, progress: number) =>
    fetch(`/api/books/${id}/progress`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ progress }),
    }).then((r) => json<Book>(r)),

  fileUrl: (id: string) => `/api/books/${id}/file`,
};
