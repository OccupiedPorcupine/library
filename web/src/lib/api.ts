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

  fileUrl: (id: string) => `/api/books/${id}/file`,
};
