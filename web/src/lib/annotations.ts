import { useCallback, useEffect, useState } from "react";

/**
 * Highlights, notes and bookmarks (#48): the API client, a hook that keeps a book's list in
 * step with the server, and the colours both reader engines draw with.
 *
 * Where an annotation points:
 * - EPUB, MOBI/AZW3, FB2, CBZ: `locator` is a CFI.
 * - PDF: `locator` is "page:<n>" and `rects` are [x, y, w, h] as fractions of the page.
 */
export type AnnotationKind = "highlight" | "bookmark";
export const COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type AnnotationColor = (typeof COLORS)[number];
export type PageRect = [number, number, number, number];

export interface Annotation {
  id: string;
  bookId: string;
  kind: AnnotationKind;
  locator: string;
  page: number | null;
  rects: PageRect[];
  text: string | null;
  note: string | null;
  color: AnnotationColor | null;
  label: string | null;
  fraction: number;
  createdAt: string;
  updatedAt: string;
}

export type NewAnnotation = Pick<Annotation, "kind" | "locator"> &
  Partial<Pick<Annotation, "page" | "rects" | "text" | "note" | "color" | "label" | "fraction">>;

/** Screen position of a selection or highlight, for placing the toolbar next to it. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Text the reader has just selected, ready to become a highlight. */
export type Selected = Omit<NewAnnotation, "kind" | "color"> & { at: ScreenRect };

/** What a reader engine needs from the annotations layer. */
export interface MarksBridge {
  /** Everything to draw (highlights; engines ignore bookmarks). */
  list: Annotation[];
  /** New text selected, or the selection went away (null). */
  select(s: Selected | null): void;
  /** The page was touched: close whatever toolbar is open. */
  dismiss(): void;
  /** An existing highlight was tapped. */
  pick(a: Annotation, at: ScreenRect): void;
}

/** Highlight colours, tuned to read through the page in each theme. */
export const SWATCH: Record<AnnotationColor, { light: string; dark: string; name: string }> = {
  yellow: { light: "#f4cf3f", dark: "#d9b43a", name: "Yellow" },
  green: { light: "#86cf7d", dark: "#6fae67", name: "Green" },
  blue: { light: "#7fb2ee", dark: "#6a98d0", name: "Blue" },
  pink: { light: "#f193bb", dark: "#d27ca0", name: "Pink" },
  purple: { light: "#b99aee", dark: "#9c82cc", name: "Purple" },
};
export const swatch = (c: AnnotationColor | null, dark: boolean) => SWATCH[c ?? "yellow"][dark ? "dark" : "light"];

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const annotationsApi = {
  list: (bookId: string) => fetch(`/api/books/${bookId}/annotations`).then((r) => json<Annotation[]>(r)),
  create: (bookId: string, a: NewAnnotation) => fetch(`/api/books/${bookId}/annotations`, send("POST", a)).then((r) => json<Annotation>(r)),
  update: (id: string, patch: Partial<Pick<Annotation, "note" | "color">>) =>
    fetch(`/api/annotations/${id}`, send("PATCH", patch)).then((r) => json<Annotation>(r)),
  remove: (id: string) =>
    fetch(`/api/annotations/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 404) throw new Error(`${r.status} ${r.statusText}`);
    }),
};

const byPosition = (a: Annotation, b: Annotation) => a.fraction - b.fraction || a.createdAt.localeCompare(b.createdAt);

/** A book's annotations, kept sorted by position. Changes show at once and roll back if the server says no. */
export function useAnnotations(bookId: string) {
  const [list, setList] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setList([]);
    annotationsApi
      .list(bookId)
      .then((l) => live && setList(l))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [bookId]);

  const fail = useCallback((e: Error) => setError(e.message), []);

  const create = useCallback(
    async (a: NewAnnotation) => {
      try {
        const made = await annotationsApi.create(bookId, a);
        setList((l) => [...l, made].sort(byPosition));
        return made;
      } catch (e) {
        fail(e as Error);
        return null;
      }
    },
    [bookId, fail],
  );

  const update = useCallback(
    (id: string, patch: Partial<Pick<Annotation, "note" | "color">>) => {
      let before: Annotation | undefined;
      setList((l) => l.map((x) => (x.id === id ? ((before = x), { ...x, ...patch }) : x)));
      annotationsApi
        .update(id, patch)
        .then((saved) => setList((l) => l.map((x) => (x.id === id ? saved : x))))
        .catch((e: Error) => {
          if (before) setList((l) => l.map((x) => (x.id === id ? before! : x)));
          fail(e);
        });
    },
    [fail],
  );

  const remove = useCallback(
    (id: string) => {
      let gone: Annotation | undefined;
      setList((l) => l.filter((x) => (x.id === id ? ((gone = x), false) : true)));
      annotationsApi.remove(id).catch((e: Error) => {
        if (gone) setList((l) => [...l, gone!].sort(byPosition));
        fail(e);
      });
    },
    [fail],
  );

  return { list, error, clearError: () => setError(null), create, update, remove };
}
