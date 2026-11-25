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

  fileUrl: (id: string) => `/api/books/${id}/file`,
};
