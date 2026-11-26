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
