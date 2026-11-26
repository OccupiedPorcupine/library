import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { HttpError } from "./library.js";

/**
 * Highlights, notes and bookmarks (#48).
 *
 * Kept in their own module and table so the reader tools stay separate from the
 * library and metadata code. The table is created idempotently on start-up.
 *
 * Where an annotation points:
 * - EPUB, MOBI/AZW3, FB2, CBZ: `locator` is a CFI from foliate-js.
 * - PDF: `locator` is "page:<n>" and `rects` holds highlight boxes as fractions of the page (0–1),
 *   so they line up at any zoom or screen size.
 */
export type AnnotationKind = "highlight" | "bookmark";

export const COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type AnnotationColor = (typeof COLORS)[number];

export interface Annotation {
  id: string;
  bookId: string;
  kind: AnnotationKind;
  locator: string;
  page: number | null;
  rects: [number, number, number, number][];
  text: string | null;
  note: string | null;
  color: AnnotationColor | null;
  label: string | null;
  /** Position in the book, 0–1, for sorting. */
  fraction: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  book_id: string;
  kind: AnnotationKind;
  locator: string;
  page: number | null;
  rects: string;
  text: string | null;
  note: string | null;
  color: AnnotationColor | null;
  label: string | null;
  fraction: number;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS annotations (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    locator    TEXT NOT NULL,
    page       INTEGER,
    rects      TEXT NOT NULL DEFAULT '[]',
    text       TEXT,
    note       TEXT,
    color      TEXT,
    label      TEXT,
    fraction   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS annotations_book ON annotations(book_id, fraction);
`;

const toAnnotation = (r: Row): Annotation => ({
  id: r.id,
  bookId: r.book_id,
  kind: r.kind,
  locator: r.locator,
  page: r.page,
  rects: JSON.parse(r.rects) as Annotation["rects"],
  text: r.text,
  note: r.note,
  color: r.color,
  label: r.label,
  fraction: r.fraction,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const MAX_TEXT = 4000;
const MAX_NOTE = 20000;
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : null);
const isColor = (c: unknown): c is AnnotationColor => COLORS.includes(c as AnnotationColor);

function cleanRects(v: unknown): Annotation["rects"] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 200)
    .filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)))
    .map((r) => r.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 1e5) / 1e5) as Annotation["rects"][number]);
}

export class Annotations {
  constructor(private db: Db) {
    db.exec(SCHEMA);
  }

  list(bookId: string): Annotation[] {
    this.requireBook(bookId);
    return (this.db.prepare(`SELECT * FROM annotations WHERE book_id = ? ORDER BY fraction, created_at`).all(bookId) as Row[]).map(
      toAnnotation,
    );
  }

  create(bookId: string, body: Record<string, unknown>): Annotation {
    this.requireBook(bookId);
    const kind = body.kind;
    if (kind !== "highlight" && kind !== "bookmark") throw new HttpError(400, "kind must be highlight or bookmark");
    const locator = clip(body.locator, 2000);
    if (!locator) throw new HttpError(400, "locator is required");
    const color = kind === "highlight" ? (isColor(body.color) ? body.color : "yellow") : null;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO annotations (id, book_id, kind, locator, page, rects, text, note, color, label, fraction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        bookId,
        kind,
        locator,
        typeof body.page === "number" ? Math.round(body.page) : null,
        JSON.stringify(cleanRects(body.rects)),
        clip(body.text, MAX_TEXT),
        clip(body.note, MAX_NOTE) || null,
        color,
        clip(body.label, 300),
        typeof body.fraction === "number" ? Math.min(1, Math.max(0, body.fraction)) : 0,
      );
    return this.get(id);
  }

  update(id: string, body: Record<string, unknown>): Annotation {
    const a = this.get(id);
    const color = body.color === undefined ? a.color : isColor(body.color) && a.kind === "highlight" ? body.color : a.color;
    const note = body.note === undefined ? a.note : clip(body.note, MAX_NOTE) || null;
    this.db
      .prepare(`UPDATE annotations SET color = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(color, note, id);
    return this.get(id);
  }

  remove(id: string) {
    this.get(id);
    this.db.prepare(`DELETE FROM annotations WHERE id = ?`).run(id);
  }

  get(id: string): Annotation {
    const row = this.db.prepare(`SELECT * FROM annotations WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new HttpError(404, "Annotation not found");
    return toAnnotation(row);
  }

  private requireBook(bookId: string) {
    if (!this.db.prepare(`SELECT 1 FROM books WHERE id = ?`).get(bookId)) throw new HttpError(404, "Book not found");
  }
}

export function registerAnnotationRoutes(app: FastifyInstance, db: Db) {
  const notes = new Annotations(db);
  type P = { Params: { id: string } };
  app.get<P>("/api/books/:id/annotations", async (req) => notes.list(req.params.id));
  app.post<P & { Body: Record<string, unknown> }>("/api/books/:id/annotations", async (req, reply) =>
    reply.status(201).send(notes.create(req.params.id, req.body ?? {})),
  );
  app.patch<P & { Body: Record<string, unknown> }>("/api/annotations/:id", async (req) => notes.update(req.params.id, req.body ?? {}));
  app.delete<P>("/api/annotations/:id", async (req, reply) => {
    notes.remove(req.params.id);
    return reply.status(204).send();
  });
  return notes;
}
