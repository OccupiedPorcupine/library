import type { Readable } from "node:stream";

export interface ByteRange {
  start: number;
  /** Inclusive end byte. */
  end: number;
}

export interface StoredObject {
  stream: Readable;
  /** Total size of the object, not of the range. */
  size: number;
  contentType?: string;
}

/**
 * Where book files and derived files (covers) live.
 * Keys are POSIX-style relative paths, e.g. "books/<id>/file.epub".
 */
export interface Storage {
  readonly name: string;
  /** Throws if storage is not reachable or writable. */
  check(): Promise<void>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string, range?: ByteRange): Promise<StoredObject>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Recursively lists keys under a prefix. */
  list(prefix?: string): AsyncIterable<{ key: string; size: number }>;
}
