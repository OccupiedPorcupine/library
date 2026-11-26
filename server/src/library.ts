import crypto from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BookRow, Db, ShelfRow, ShelfSuggestionRow } from "./db.js";
import { CONTENT_TYPES, detectFormat, extractMeta, isSupported, titleFromFileName, type TocEntry } from "./formats/index.js";
import { imageSize, sniffImage } from "./formats/images.js";
import { repackEpubZip } from "./formats/repack.js";
import { type AiOptions, aiEnabled, aiMetadata, aiSortShelves } from "./metadata/ai.js";
import { type BookMeta, fromFile, isJunkMeta, META_FIELDS, mergeAi, mergeOnline, type MetaField, type Sources, wantsOnlineCover } from "./metadata/enrich.js";
import { spineColorFromCover } from "./metadata/color.js";
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
  /** True while a background online lookup is still due. */
  lookupPending: boolean;
  shelfIds: string[];
}

export type MetadataPatch = Partial<Omit<BookMeta, "isbn10">>;

export interface ShelfSuggestionDto {
  id: string;
  name: string;
  reason: string | null;
  bookIds: string[];
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
    lookupPending: false,
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
  /** OpenAI settings; the AI steps are skipped without an API key. */
  ai?: AiOptions;
  /** Put books on existing shelves automatically after the AI pass. */
  aiAutoShelve?: boolean;
  /** Run the background pass after uploads (off in tests, which call the steps directly). */
  background?: boolean;
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
    const b = this.getBook(id);
    const pending = (!!this.opts.online && !b.meta_checked_at) || (aiEnabled(this.opts.ai) && !b.ai_checked_at);
    return { ...toDetailDto(b, shelfIds), lookupPending: pending };
  }

  getBook(id: string): BookRow {
    const row = this.db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
    if (!row) throw new HttpError(404, "Book not found");
    return row;
  }

  /** Everything the home page needs in one call. */
  overview(): { shelves: ShelfDto[]; unshelved: BookDto[]; suggestions: ShelfSuggestionDto[]; ai: boolean } {
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
      suggestions: this.suggestions(),
      ai: aiEnabled(this.opts.ai),
    };
  }

  async addBook(fileName: string, data: Buffer, shelfId?: string): Promise<{ book: BookDto; duplicate: boolean }> {
    // A zipped EPUB folder (an Apple Books export) becomes a real EPUB.
    const repacked = await repackEpubZip(fileName, data);
    if (repacked) ({ fileName, data } = repacked);
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
    const spine =
      (meta.cover && (await spineColorFromCover(meta.cover.data))) ||
      SPINE_COLORS[crypto.createHash("md5").update(m.title).digest()[0]! % SPINE_COLORS.length]!;
    this.db
      .prepare(
        `INSERT INTO books (id, title, author, format, file_key, file_name, file_size, file_hash, cover_key, spine_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, m.title, m.author, format, fileKey, path.basename(fileName), data.length, hash, coverKey, spine);
    this.saveMeta(id, m, sources);
    this.db.prepare("UPDATE books SET text_sample = ? WHERE id = ?").run(meta.sampleText ?? null, id);
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
    const spine = await spineColorFromCover(data);
    this.db
      .prepare(
        "UPDATE books SET cover_key = ?, spine_color = COALESCE(?, spine_color), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      )
      .run(key, spine, id);
  }

  /** Books from before spines matched their covers: recolour them once, in the background. */
  async recolorSpines(): Promise<number> {
    const rows = this.db
      .prepare(`SELECT id, cover_key FROM books WHERE cover_key IS NOT NULL AND spine_color IN (${SPINE_COLORS.map(() => "?").join(",")})`)
      .all(...SPINE_COLORS) as { id: string; cover_key: string }[];
    let n = 0;
    for (const r of rows) {
      if (this.closed) break;
      const data = await this.storage
        .get(r.cover_key)
        .then((o) => readAll(o.stream))
        .catch(() => null);
      const spine = data && (await spineColorFromCover(data));
      if (!spine) continue;
      this.db.prepare("UPDATE books SET spine_color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(spine, r.id);
      n++;
    }
    return n;
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

  /** Queues a book for the background pass: AI clean-up, online lookup, then shelf sorting. */
  enqueue(id: string): void {
    if (this.opts.background === false || (!this.opts.online && !aiEnabled(this.opts.ai)) || this.closed || this.queued.has(id)) return;
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
        await this.aiPass(id).catch((e) => this.opts.log?.(`AI metadata for ${id}`, e));
        if (this.opts.online && !this.getBook(id).meta_checked_at) await this.refreshMetadata(id);
        await this.autoShelve(id).catch((e) => this.opts.log?.(`AI shelving for ${id}`, e));
      } catch (e) {
        if (!(e instanceof HttpError && e.statusCode === 404)) this.opts.log?.(`metadata for ${id}`, e);
      }
      await new Promise((r) => setTimeout(r, QUEUE_GAP_MS));
    }
  }

  /** Books indexed before rich metadata existed only have a title and author: read their file again. */
  private async reextractIfNeeded(id: string): Promise<void> {
    const b = this.getBook(id);
    const needSample = aiEnabled(this.opts.ai) && !b.ai_checked_at && b.text_sample === null;
    if (b.meta_sources !== "{}" && !needSample) return;
    const data = await readAll((await this.storage.get(b.file_key)).stream);
    const meta = await extractMeta(b.format, data);
    // An empty string marks "looked, found no text", so the file isn't read again.
    this.db.prepare("UPDATE books SET text_sample = ? WHERE id = ?").run(meta.sampleText ?? "", id);
    if (b.meta_sources !== "{}") return;
    const { meta: m, sources } = fromFile(meta, b.title);
    if (meta.cover && !b.cover_key) await this.putCover(id, meta.cover.data, meta.cover);
    if (!meta.cover && b.cover_key) sources.cover = "file";
    this.saveMeta(id, m, sources);
  }

  // ---------- AI ----------

  /** Has the AI read the opening pages and clean up the title, author and other fields. */
  async aiPass(id: string, force = false): Promise<boolean> {
    const ai = this.opts.ai;
    if (!aiEnabled(ai)) return false;
    const b = this.getBook(id);
    if (b.ai_checked_at && !force) return false;
    const m = rowMeta(b);
    const sources = JSON.parse(b.meta_sources || "{}") as Sources;
    const embedded = Object.fromEntries(
      (["title", "subtitle", "author", "series", "publisher", "published", "language", "isbn13"] as const)
        .filter((f) => m[f] != null && sources[f] !== "filename")
        .map((f) => [f, m[f]]),
    );
    const result = await aiMetadata(ai, { fileName: b.file_name, format: b.format, embedded, sampleText: b.text_sample });
    if (result) {
      mergeAi(m, sources, result);
      this.saveMeta(id, m, sources);
    }
    this.db.prepare("UPDATE books SET ai_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    return true;
  }

  /** After upload: a book that landed on no shelf gets placed (or a new shelf suggested). */
  private async autoShelve(id: string): Promise<void> {
    if (!aiEnabled(this.opts.ai) || !this.opts.aiAutoShelve) return;
    const onShelf = this.db.prepare("SELECT 1 FROM shelf_books WHERE book_id = ?").get(id);
    if (onShelf) return;
    await this.sortBooks([id]);
  }

  /**
   * Asks the AI where books belong. Unshelved books are placed on matching existing shelves;
   * themes no shelf covers come back as suggestions for you to accept or dismiss.
   */
  async sortBooks(ids?: string[]): Promise<{ placed: number; suggestions: ShelfSuggestionDto[] }> {
    if (!aiEnabled(this.opts.ai)) throw new HttpError(400, "AI isn't set up: add OPENAI_API_KEY to the server's .env");
    const targets = ids
      ? ids
      : (this.db.prepare("SELECT id FROM books WHERE id NOT IN (SELECT book_id FROM shelf_books) ORDER BY added_at").all() as { id: string }[]).map(
          (r) => r.id,
        );
    const shelves = this.db.prepare("SELECT * FROM shelves ORDER BY position").all() as ShelfRow[];
    const examples = this.db.prepare(
      `SELECT b.title FROM books b JOIN shelf_books sb ON sb.book_id = b.id WHERE sb.shelf_id = ? ORDER BY sb.position LIMIT 8`,
    );
    const avoid = (this.db.prepare("SELECT name FROM shelf_suggestions").all() as { name: string }[]).map((r) => r.name);
    let placed = 0;
    // Batches keep each request small.
    for (let i = 0; i < targets.length; i += 30) {
      const books = targets.slice(i, i + 30).map((id) => {
        const b = this.getBook(id);
        return { id, title: b.title, author: b.author, subjects: JSON.parse(b.subjects || "[]") as string[], description: b.description };
      });
      const res = await aiSortShelves(this.opts.ai, {
        shelves: shelves.map((s) => ({ id: s.id, name: s.name, examples: (examples.all(s.id) as { title: string }[]).map((r) => r.title) })),
        books,
        avoidNames: avoid,
      });
      if (!res) break;
      this.db.transaction(() => {
        for (const a of res.assignments) {
          const unshelved = !this.db.prepare("SELECT 1 FROM shelf_books WHERE book_id = ?").get(a.bookId);
          if (!unshelved || !a.shelfIds.length) continue;
          for (const s of a.shelfIds) this.addToShelf(s, a.bookId);
          placed++;
        }
        for (const n of res.newShelves) this.addSuggestion(n.name, n.reason, n.bookIds);
      })();
      avoid.push(...res.newShelves.map((n) => n.name));
    }
    return { placed, suggestions: this.suggestions() };
  }

  private addSuggestion(name: string, reason: string, bookIds: string[]): void {
    const key = name.trim().toLowerCase();
    if ((this.db.prepare("SELECT 1 FROM shelves WHERE lower(name) = ?").get(key))) return;
    const existing = this.db.prepare("SELECT * FROM shelf_suggestions WHERE lower(name) = ?").get(key) as ShelfSuggestionRow | undefined;
    if (existing) {
      if (existing.status !== "open") return; // dismissed or already accepted: don't bring it back
      const merged = [...new Set([...(JSON.parse(existing.book_ids) as string[]), ...bookIds])];
      this.db.prepare("UPDATE shelf_suggestions SET book_ids = ? WHERE id = ?").run(JSON.stringify(merged), existing.id);
      return;
    }
    this.db
      .prepare("INSERT INTO shelf_suggestions (id, name, book_ids, reason) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), name.trim(), JSON.stringify(bookIds), reason || null);
  }

  suggestions(): ShelfSuggestionDto[] {
    const rows = this.db.prepare("SELECT * FROM shelf_suggestions WHERE status = 'open' ORDER BY created_at").all() as ShelfSuggestionRow[];
    const exists = this.db.prepare("SELECT 1 FROM books WHERE id = ?");
    return rows
      .map((r) => ({ id: r.id, name: r.name, reason: r.reason, bookIds: (JSON.parse(r.book_ids) as string[]).filter((b) => exists.get(b)) }))
      .filter((r) => r.bookIds.length > 0);
  }

  /** Creates the suggested shelf (optionally renamed) and puts its books on it. */
  acceptSuggestion(id: string, name?: string): ShelfRow {
    const row = this.db.prepare("SELECT * FROM shelf_suggestions WHERE id = ? AND status = 'open'").get(id) as ShelfSuggestionRow | undefined;
    if (!row) throw new HttpError(404, "Suggestion not found");
    return this.db.transaction(() => {
      const shelf = this.createShelf(name?.trim() || row.name);
      for (const b of JSON.parse(row.book_ids) as string[]) if (this.db.prepare("SELECT 1 FROM books WHERE id = ?").get(b)) this.addToShelf(shelf.id, b);
      this.db.prepare("UPDATE shelf_suggestions SET status = 'accepted' WHERE id = ?").run(id);
      return shelf;
    })();
  }

  dismissSuggestion(id: string): void {
    const res = this.db.prepare("UPDATE shelf_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(id);
    if (res.changes === 0) throw new HttpError(404, "Suggestion not found");
  }

  /**
   * Clears junk that came from files before the filter existed (e.g. a watermark as the author),
   * and marks those books to be looked up again.
   */
  cleanJunk(): number {
    let fixed = 0;
    for (const b of this.db.prepare("SELECT * FROM books").all() as BookRow[]) {
      const sources = JSON.parse(b.meta_sources || "{}") as Sources;
      const m = rowMeta(b);
      let dirty = false;
      for (const f of ["title", "author", "publisher"] as const) {
        const src = sources[f];
        // Books added before sources were tracked have none: treat them like file metadata.
        if ((!src || src === "file" || src === "filename" || src === "ai") && isJunkMeta(m[f])) {
          if (f === "title") {
            m.title = titleFromFileName(b.file_name);
            sources.title = "filename";
          } else {
            m[f] = null;
            delete sources[f];
          }
          dirty = true;
        }
      }
      if (!dirty) continue;
      this.saveMeta(b.id, m, sources);
      this.db.prepare("UPDATE books SET meta_checked_at = NULL, ai_checked_at = NULL WHERE id = ?").run(b.id);
      fixed++;
    }
    if (fixed) this.opts.log?.(`cleared junk metadata on ${fixed} book(s); looking them up again`);
    return fixed;
  }

  /**
   * Books stored as comics that are really zipped EPUB folders (Apple Books exports, from
   * before uploads were repacked): repack them and read their metadata again. Your edits stay.
   */
  async repackStored(): Promise<number> {
    let fixed = 0;
    for (const b of this.db.prepare("SELECT * FROM books WHERE format = 'cbz'").all() as BookRow[]) {
      try {
        const r = await repackEpubZip(b.file_name, await readAll((await this.storage.get(b.file_key)).stream));
        if (!r) continue;
        const key = `books/${b.id}/${safeName(r.fileName)}`;
        await this.storage.put(key, r.data, CONTENT_TYPES.epub);
        const hash = crypto.createHash("sha256").update(r.data).digest("hex");
        this.db
          .prepare("UPDATE books SET format = 'epub', file_key = ?, file_name = ?, file_size = ?, file_hash = ? WHERE id = ?")
          .run(key, r.fileName, r.data.length, hash, b.id);
        if (key !== b.file_key) await this.storage.delete(b.file_key).catch(() => {});

        const meta = await extractMeta("epub", r.data);
        const before = JSON.parse(b.meta_sources || "{}") as Sources;
        const old = rowMeta(b);
        const { meta: m, sources } = fromFile(meta, titleFromFileName(r.fileName));
        for (const f of META_FIELDS) {
          if (before[f] !== "user") continue;
          (m as unknown as Record<string, unknown>)[f] = old[f];
          sources[f] = "user";
        }
        if (before.cover === "user") sources.cover = "user";
        else if (meta.cover) await this.putCover(b.id, meta.cover.data, meta.cover);
        this.saveMeta(b.id, m, sources);
        this.db
          .prepare("UPDATE books SET text_sample = ?, meta_checked_at = NULL, ai_checked_at = NULL WHERE id = ?")
          .run(meta.sampleText ?? null, b.id);
        fixed++;
      } catch (e) {
        this.opts.log?.(`repacking ${b.id}`, e);
      }
    }
    if (fixed) this.opts.log?.(`repacked ${fixed} zipped EPUB folder(s) stored as comics`);
    return fixed;
  }

  /** On startup: pick up every book that still needs an online lookup or AI pass. */
  async resumeQueue(): Promise<void> {
    await this.repackStored().catch((e) => this.opts.log?.("repacking stored books", e));
    this.cleanJunk();
    void this.recolorSpines().catch((e) => this.opts.log?.("recolouring spines", e));
    const ai = aiEnabled(this.opts.ai);
    const ids = this.db
      .prepare(
        `SELECT id FROM books WHERE (? AND meta_checked_at IS NULL) OR (? AND ai_checked_at IS NULL) ORDER BY added_at`,
      )
      .all(this.opts.online ? 1 : 0, ai ? 1 : 0) as { id: string }[];
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

  /** Puts shelves in the given order (ids not listed keep their place after these). */
  reorderShelves(ids: string[]): void {
    const set = this.db.prepare("UPDATE shelves SET position = ? WHERE id = ?");
    this.db.transaction(() => ids.forEach((id, i) => set.run(i, id)))();
  }

  /** Moves books onto a shelf; from a given shelf (a move) or from none (an add). null target = take off `from`. */
  moveBooks(bookIds: string[], toShelfId: string | null, fromShelfId: string | null): void {
    if (toShelfId && !this.db.prepare("SELECT 1 FROM shelves WHERE id = ?").get(toShelfId)) throw new HttpError(404, "Shelf not found");
    this.db.transaction(() => {
      for (const id of bookIds) {
        this.getBook(id);
        if (fromShelfId && fromShelfId !== toShelfId) this.db.prepare("DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?").run(fromShelfId, id);
        if (toShelfId) this.addToShelf(toShelfId, id);
      }
    })();
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
