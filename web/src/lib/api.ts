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
}

export interface TocEntry {
  title: string;
  level: number;
  href?: string;
  page?: number;
}

export type FieldSource = "filename" | "file" | "openlibrary" | "googlebooks" | "user";

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

export interface LibraryOverview {
  shelves: Shelf[];
  unshelved: Book[];
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

  upload: (files: File[], shelfId?: string) => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    const q = shelfId ? `?shelf=${encodeURIComponent(shelfId)}` : "";
    return fetch(`/api/books${q}`, { method: "POST", body: form }).then((r) =>
      json<{ results: { file: string; error?: string; duplicate?: boolean }[] }>(r),
    );
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

  setProgress: (id: string, progress: number) =>
    fetch(`/api/books/${id}/progress`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ progress }),
    }).then((r) => json<Book>(r)),

  fileUrl: (id: string) => `/api/books/${id}/file`,
};
