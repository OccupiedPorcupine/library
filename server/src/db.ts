import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Format = "epub" | "pdf" | "cbz" | "txt" | "md" | "mobi" | "azw3" | "fb2";

export interface BookRow {
  id: string;
  title: string;
  author: string | null;
  format: Format;
  file_key: string;
  file_name: string;
  file_size: number;
  file_hash: string;
  cover_key: string | null;
  spine_color: string;
  progress: number;
  finished_at: string | null;
  added_at: string;
  updated_at: string;
  subtitle: string | null;
  series: string | null;
  series_index: number | null;
  description: string | null;
  publisher: string | null;
  published: string | null;
  page_count: number | null;
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  /** JSON string[] */
  subjects: string;
  /** JSON TocEntry[] */
  toc: string;
  /** JSON Record<field, "file" | "openlibrary" | "googlebooks" | "user"> */
  meta_sources: string;
  /** When online sources were last asked; null means never. */
  meta_checked_at: string | null;
  /** Opening text of the book, for the AI pass. */
  text_sample: string | null;
  /** When the AI pass ran; null means never. */
  ai_checked_at: string | null;
}

export interface ShelfSuggestionRow {
  id: string;
  name: string;
  /** JSON string[] */
  book_ids: string;
  reason: string | null;
  status: "open" | "accepted" | "dismissed";
  created_at: string;
}

export interface ShelfRow {
  id: string;
  name: string;
  position: number;
}

/**
 * Schema migrations, applied in order. Add new ones at the end; never edit old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE books (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT,
    format      TEXT NOT NULL,
    file_key    TEXT NOT NULL UNIQUE,
    file_name   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    file_hash   TEXT NOT NULL UNIQUE,
    cover_key   TEXT,
    spine_color TEXT NOT NULL,
    progress    REAL NOT NULL DEFAULT 0,
    finished_at TEXT,
    added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE shelves (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE shelf_books (
    shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (shelf_id, book_id)
  );
  CREATE INDEX shelf_books_book ON shelf_books(book_id);
  CREATE INDEX books_title ON books(title COLLATE NOCASE);
  `,
  // Rich metadata: from the file first, then Open Library / Google Books, then manual edits.
  `
  ALTER TABLE books ADD COLUMN subtitle TEXT;
  ALTER TABLE books ADD COLUMN series TEXT;
  ALTER TABLE books ADD COLUMN series_index REAL;
  ALTER TABLE books ADD COLUMN description TEXT;
  ALTER TABLE books ADD COLUMN publisher TEXT;
  ALTER TABLE books ADD COLUMN published TEXT;
  ALTER TABLE books ADD COLUMN page_count INTEGER;
  ALTER TABLE books ADD COLUMN language TEXT;
  ALTER TABLE books ADD COLUMN isbn10 TEXT;
  ALTER TABLE books ADD COLUMN isbn13 TEXT;
  ALTER TABLE books ADD COLUMN subjects TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE books ADD COLUMN toc TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE books ADD COLUMN meta_sources TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE books ADD COLUMN meta_checked_at TEXT;
  CREATE INDEX books_isbn13 ON books(isbn13);
  `,
  // AI pass (#29) and AI shelf suggestions (#34).
  `
  ALTER TABLE books ADD COLUMN text_sample TEXT;
  ALTER TABLE books ADD COLUMN ai_checked_at TEXT;
  CREATE TABLE shelf_suggestions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    book_ids   TEXT NOT NULL DEFAULT '[]',
    reason     TEXT,
    -- 'open' until accepted or dismissed; dismissed names are not suggested again
    status     TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
];

export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export type Db = ReturnType<typeof openDb>;
