import crypto from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BookRow, Db, ShelfRow } from "./db.js";
import { CONTENT_TYPES, detectFormat, extractMeta, isSupported, titleFromFileName, type TocEntry } from "./formats/index.js";
import { imageSize, sniffImage } from "./formats/images.js";
import { type BookMeta, fromFile, META_FIELDS, mergeOnline, type MetaField, type Sources, wantsOnlineCover } from "./metadata/enrich.js";
import { parseIsbn } from "./metadata/isbn.js";
import { googleBooks, type LookupQuery, openLibrary, type OnlineMeta, type OnlineOptions } from "./metadata/online.js";
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

/** Everything the detail panel shows. */
export interface BookDetailDto extends BookDto {
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
  sources: Sources;
  metaCheckedAt: string | null;
  shelfIds: string[];
}

export type MetadataPatch = Partial<Omit<BookMeta, "isbn10">>;

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

function rowMeta(b: BookRow): BookMeta {
  return {
    title: b.title,
    subtitle: b.subtitle,
    author: b.author,
    series: b.series,
    seriesIndex: b.series_index,
    description: b.description,
    publisher: b.publisher,
    published: b.published,
    pageCount: b.page_count,
    language: b.language,
    isbn10: b.isbn10,
    isbn13: b.isbn13,
    subjects: JSON.parse(b.subjects || "[]") as string[],
    toc: JSON.parse(b.toc || "[]") as TocEntry[],
  };
}

export function toDetailDto(b: BookRow, shelfIds: string[]): BookDetailDto {
  return {
    ...toDto(b),
    ...rowMeta(b),
    fileName: b.file_name,
    sources: JSON.parse(b.meta_sources || "{}") as Sources,
    metaCheckedAt: b.meta_checked_at,
    shelfIds,
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const safeName = (n: string) => path.basename(n).replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "book";

export interface LibraryOptions {
  /** Look books up on Open Library and Google Books. */
  online?: boolean;
  onlineOptions?: OnlineOptions;
  log?: (msg: string, err?: unknown) => void;
}

/** Pause between books in the background queue, to be polite to the free APIs. */
const QUEUE_GAP_MS = 1500;

export class Library {
  private queue: string[] = [];
  private queued = new Set<string>();
  private draining: Promise<void> | null = null;
  private closed = false;

  constructor(
    private db: Db,
    private storage: Storage,
    private opts: LibraryOptions = {},
  ) {}

  getDetail(id: string): BookDetailDto {
    const shelfIds = (this.db.prepare("SELECT shelf_id FROM shelf_books WHERE book_id = ?").all(id) as { shelf_id: string }[]).map(
      (r) => r.shelf_id,
    );
    return toDetailDto(this.getBook(id), shelfIds);
  }

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
    const { meta: m, sources } = fromFile(meta, titleFromFileName(fileName));
    const spine = SPINE_COLORS[crypto.createHash("md5").update(m.title).digest()[0]! % SPINE_COLORS.length]!;
    this.db
      .prepare(
        `INSERT INTO books (id, title, author, format, file_key, file_name, file_size, file_hash, cover_key, spine_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, m.title, m.author, format, fileKey, path.basename(fileName), data.length, hash, coverKey, spine);
    this.saveMeta(id, m, sources);
    if (shelfId) this.addToShelf(shelfId, id);
    this.enqueue(id);
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

  // ---------- metadata ----------

  private saveMeta(id: string, m: BookMeta, sources: Sources, checked = false): void {
    this.db
      .prepare(
        `UPDATE books SET title = ?, subtitle = ?, author = ?, series = ?, series_index = ?, description = ?,
           publisher = ?, published = ?, page_count = ?, language = ?, isbn10 = ?, isbn13 = ?,
           subjects = ?, toc = ?, meta_sources = ?,
           meta_checked_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE meta_checked_at END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(
        m.title,
        m.subtitle,
        m.author,
        m.series,
        m.seriesIndex,
        m.description,
        m.publisher,
        m.published,
        m.pageCount,
        m.language,
        m.isbn10,
        m.isbn13,
        JSON.stringify(m.subjects),
        JSON.stringify(m.toc),
        JSON.stringify(sources),
        checked ? 1 : 0,
        id,
      );
  }

  private async putCover(id: string, data: Buffer, type: { ext: string; contentType: string }): Promise<void> {
    const old = this.getBook(id).cover_key;
    const key = `covers/${id}.${type.ext}`;
    await this.storage.put(key, data, type.contentType);
    if (old && old !== key) await this.storage.delete(old).catch(() => {});
    this.db
      .prepare("UPDATE books SET cover_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(key, id);
  }

  /** Manual edits. Edited fields are marked as yours, so online refreshes leave them alone. */
  updateMetadata(id: string, patch: MetadataPatch): BookDetailDto {
    const b = this.getBook(id);
    const m = rowMeta(b);
    const sources = JSON.parse(b.meta_sources || "{}") as Sources;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const num = (v: unknown) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    for (const f of META_FIELDS) {
      if (!(f in patch)) continue;
      const v = (patch as Record<string, unknown>)[f];
      switch (f) {
        case "title":
          m.title = str(v) ?? m.title;
          break;
        case "seriesIndex":
          m.seriesIndex = num(v);
          break;
        case "pageCount":
          m.pageCount = num(v) === null ? null : Math.round(num(v)!);
          break;
        case "subjects":
          m.subjects = Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => !!x))] : [];
          break;
        case "toc":
          m.toc = Array.isArray(v) ? (v as TocEntry[]).filter((t) => t && typeof t.title === "string" && t.title.trim()) : [];
          break;
        case "isbn13": {
          if (v === null || v === "") {
            m.isbn13 = m.isbn10 = null;
          } else {
            const isbn = parseIsbn(String(v));
            if (!isbn) throw new HttpError(400, "That ISBN doesn't look valid");
            m.isbn13 = isbn.isbn13;
            m.isbn10 = isbn.isbn10;
          }
          break;
        }
        default:
          m[f] = str(v);
      }
      sources[f] = "user";
    }
    this.saveMeta(id, m, sources);
    return this.getDetail(id);
  }

  async setUserCover(id: string, data: Buffer): Promise<BookDetailDto> {
    const b = this.getBook(id);
    const type = sniffImage(data);
    if (!type) throw new HttpError(415, "Cover must be a JPEG, PNG, GIF or WebP image");
    await this.putCover(id, data, type);
    const sources = JSON.parse(b.meta_sources || "{}") as Sources;
    sources.cover = "user";
    this.db.prepare("UPDATE books SET meta_sources = ? WHERE id = ?").run(JSON.stringify(sources), id);
    return this.getDetail(id);
  }

  /** Asks Open Library, then Google Books, and fills in whatever is missing. */
  async refreshMetadata(id: string): Promise<BookDetailDto> {
    const b = this.getBook(id);
    const m = rowMeta(b);
    const sources = JSON.parse(b.meta_sources || "{}") as Sources;
    const q: LookupQuery = {
      isbn13: m.isbn13,
      title: m.title,
      author: m.author,
    };
    const results: OnlineMeta[] = [];
    const errors: string[] = [];
    for (const lookup of [openLibrary, googleBooks]) {
      try {
        const r = await lookup(q, this.opts.onlineOptions);
        if (r) results.push(r);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    // Only fail loudly when every source errored; "no match" is a normal outcome.
    if (!results.length && errors.length === 2) {
      this.opts.log?.(`metadata lookup failed for ${id}: ${errors.join("; ")}`);
      throw new HttpError(502, "Couldn't reach Open Library or Google Books. Try again later.");
    }
    // An ISBN match is more trustworthy than a title match, whatever the source.
    results.sort((a, z) => (a.matchedBy === z.matchedBy ? 0 : a.matchedBy === "isbn" ? -1 : 1));
    mergeOnline(m, sources, results);

    const best = results.find((r) => r.coverUrls?.length);
    const current = b.cover_key ? await this.storage.get(b.cover_key).then((o) => readAll(o.stream)).catch(() => null) : null;
    if (wantsOnlineCover(sources, current ? imageSize(current) : null, !!b.cover_key, b.format, best)) {
      for (const r of results) {
        const cover = await this.downloadCover(r.coverUrls ?? []);
        if (cover) {
          await this.putCover(id, cover.data, cover.type);
          sources.cover = r.source;
          break;
        }
      }
    }
    this.saveMeta(id, m, sources, true);
    return this.getDetail(id);
  }

  private async downloadCover(urls: string[]): Promise<{ data: Buffer; type: { ext: string; contentType: string } } | null> {
    const f = this.opts.onlineOptions?.fetch ?? fetch;
    for (const url of urls) {
      try {
        const res = await f(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const data = Buffer.from(await res.arrayBuffer());
        const type = sniffImage(data);
        const size = imageSize(data);
        // Skip "no image" placeholders and thumbnails too small to look good on the shelf.
        if (type && size && size.width >= 120 && size.height >= 160 && data.length > 2000) return { data, type };
      } catch {
        // try the next one
      }
    }
    return null;
  }

  /** Queues a book for a background online lookup. */
  enqueue(id: string): void {
    if (!this.opts.online || this.closed || this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.draining ??= this.drain().finally(() => (this.draining = null));
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      try {
        await this.reextractIfNeeded(id);
        await this.refreshMetadata(id);
      } catch (e) {
        if (!(e instanceof HttpError && e.statusCode === 404)) this.opts.log?.(`metadata for ${id}`, e);
      }
      await new Promise((r) => setTimeout(r, QUEUE_GAP_MS));
    }
  }

  /** Books indexed before rich metadata existed only have a title and author: read their file again. */
  private async reextractIfNeeded(id: string): Promise<void> {
    const b = this.getBook(id);
    if (b.meta_sources !== "{}") return;
    const data = await readAll((await this.storage.get(b.file_key)).stream);
    const meta = await extractMeta(b.format, data);
    const { meta: m, sources } = fromFile(meta, b.title);
    if (meta.cover && !b.cover_key) await this.putCover(id, meta.cover.data, meta.cover);
    if (!meta.cover && b.cover_key) sources.cover = "file";
    this.saveMeta(id, m, sources);
  }

  /** On startup: look up every book that hasn't been checked online yet. */
  resumeQueue(): void {
    const ids = this.db.prepare("SELECT id FROM books WHERE meta_checked_at IS NULL ORDER BY added_at").all() as { id: string }[];
    for (const { id } of ids) this.enqueue(id);
  }

  close(): void {
    this.closed = true;
    this.queue = [];
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
