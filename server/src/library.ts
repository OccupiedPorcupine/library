import crypto from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BookRow, Db, ShelfRow } from "./db.js";
import { CONTENT_TYPES, detectFormat, extractMeta, isSupported, titleFromFileName } from "./formats/index.js";
import type { Storage } from "./storage/index.js";

/** Cloth-binding colours for CSS-drawn spines (see docs/performance.md: spines need no images). */
const SPINE_COLORS = ["#1f3354", "#7a2630", "#234a37", "#ece6d8", "#4f6b8a", "#2e3138", "#8a6a3b", "#5b4a6b"];

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BookDto {
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

export interface ShelfDto {
  id: string;
  name: string;
  position: number;
  books: BookDto[];
}

export function toDto(b: BookRow): BookDto {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    format: b.format,
    size: b.file_size,
    coverUrl: b.cover_key ? `/api/books/${b.id}/cover?v=${encodeURIComponent(b.updated_at)}` : null,
    spineColor: b.spine_color,
    progress: b.progress,
    finishedAt: b.finished_at,
    addedAt: b.added_at,
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const safeName = (n: string) => path.basename(n).replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "book";

export class Library {
  constructor(
    private db: Db,
    private storage: Storage,
  ) {}

  getBook(id: string): BookRow {
    const row = this.db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
    if (!row) throw new HttpError(404, "Book not found");
    return row;
  }

  /** Everything the home page needs in one call. */
  overview(): { shelves: ShelfDto[]; unshelved: BookDto[] } {
    const shelves = this.db.prepare("SELECT * FROM shelves ORDER BY position, name").all() as ShelfRow[];
    const inShelf = this.db.prepare(
      `SELECT b.* FROM books b JOIN shelf_books sb ON sb.book_id = b.id
       WHERE sb.shelf_id = ? ORDER BY sb.position, b.title COLLATE NOCASE`,
    );
    const unshelved = this.db
      .prepare(
        `SELECT * FROM books WHERE id NOT IN (SELECT book_id FROM shelf_books)
         ORDER BY added_at DESC`,
      )
      .all() as BookRow[];
    return {
      shelves: shelves.map((s) => ({ ...s, books: (inShelf.all(s.id) as BookRow[]).map(toDto) })),
      unshelved: unshelved.map(toDto),
    };
  }

  async addBook(fileName: string, data: Buffer, shelfId?: string): Promise<{ book: BookDto; duplicate: boolean }> {
    const format = detectFormat(fileName, data.subarray(0, 128));
    if (!format) throw new HttpError(415, `Unsupported file type: ${fileName}`);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const existing = this.db.prepare("SELECT * FROM books WHERE file_hash = ?").get(hash) as BookRow | undefined;
    if (existing) return { book: toDto(existing), duplicate: true };

    const id = crypto.randomUUID();
    const fileKey = `books/${id}/${safeName(fileName)}`;
    await this.storage.put(fileKey, data, CONTENT_TYPES[format]);
    return { book: await this.index(id, fileKey, fileName, data, hash, shelfId), duplicate: false };
  }

  /** Creates the DB row (and cover) for a file already in storage. */
  private async index(id: string, fileKey: string, fileName: string, data: Buffer, hash: string, shelfId?: string) {
    const format = detectFormat(fileName, data.subarray(0, 128))!;
    const meta = await extractMeta(format, data);
    let coverKey: string | null = null;
    if (meta.cover) {
      coverKey = `covers/${id}.${meta.cover.ext}`;
      await this.storage.put(coverKey, meta.cover.data, meta.cover.contentType);
    }
    const title = meta.title || titleFromFileName(fileName);
    const spine = SPINE_COLORS[crypto.createHash("md5").update(title).digest()[0]! % SPINE_COLORS.length]!;
    this.db
      .prepare(
        `INSERT INTO books (id, title, author, format, file_key, file_name, file_size, file_hash, cover_key, spine_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, meta.author ?? null, format, fileKey, path.basename(fileName), data.length, hash, coverKey, spine);
    if (shelfId) this.addToShelf(shelfId, id);
    return toDto(this.getBook(id));
  }

  /** Imports supported files that are already in storage (e.g. an existing NAS folder). */
  async scan(): Promise<{ imported: number; skipped: number }> {
    const known = new Set(
      (this.db.prepare("SELECT file_key FROM books").all() as { file_key: string }[]).map((r) => r.file_key),
    );
    let imported = 0;
    let skipped = 0;
    for await (const obj of this.storage.list("")) {
      if (obj.key.startsWith("covers/") || known.has(obj.key) || !isSupported(obj.key)) continue;
      const { stream } = await this.storage.get(obj.key);
      const data = await readAll(stream);
      const hash = crypto.createHash("sha256").update(data).digest("hex");
      if (this.db.prepare("SELECT 1 FROM books WHERE file_hash = ?").get(hash)) {
        skipped++;
        continue;
      }
      await this.index(crypto.randomUUID(), obj.key, obj.key, data, hash);
      imported++;
    }
    return { imported, skipped };
  }

  async deleteBook(id: string): Promise<void> {
    const b = this.getBook(id);
    this.db.prepare("DELETE FROM books WHERE id = ?").run(id);
    await this.storage.delete(b.file_key);
    if (b.cover_key) await this.storage.delete(b.cover_key);
  }

  setProgress(id: string, progress: number): BookDto {
    this.getBook(id);
    const p = Math.min(1, Math.max(0, progress));
    this.db
      .prepare(
        `UPDATE books SET progress = ?,
           finished_at = CASE WHEN ? >= 1 THEN COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(p, p, id);
    return toDto(this.getBook(id));
  }

  createShelf(name: string): ShelfRow {
    const id = crypto.randomUUID();
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM shelves").get() as { p: number }).p;
    this.db.prepare("INSERT INTO shelves (id, name, position) VALUES (?, ?, ?)").run(id, name.trim(), pos);
    return { id, name: name.trim(), position: pos };
  }

  updateShelf(id: string, patch: { name?: string; position?: number }): void {
    const res = this.db
      .prepare("UPDATE shelves SET name = COALESCE(?, name), position = COALESCE(?, position) WHERE id = ?")
      .run(patch.name?.trim() ?? null, patch.position ?? null, id);
    if (res.changes === 0) throw new HttpError(404, "Shelf not found");
  }

  deleteShelf(id: string): void {
    this.db.prepare("DELETE FROM shelves WHERE id = ?").run(id);
  }

  addToShelf(shelfId: string, bookId: string): void {
    const pos = (
      this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM shelf_books WHERE shelf_id = ?").get(shelfId) as {
        p: number;
      }
    ).p;
    this.db.prepare("INSERT OR IGNORE INTO shelf_books (shelf_id, book_id, position) VALUES (?, ?, ?)").run(shelfId, bookId, pos);
  }

  /** Replaces the set of shelves a book is on. */
  setBookShelves(bookId: string, shelfIds: string[]): void {
    this.getBook(bookId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM shelf_books WHERE book_id = ? AND shelf_id NOT IN (SELECT value FROM json_each(?))").run(
        bookId,
        JSON.stringify(shelfIds),
      );
      for (const s of shelfIds) this.addToShelf(s, bookId);
    })();
  }
}
