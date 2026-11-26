/**
 * Merges metadata from the book file, online sources and manual edits into a book row.
 *
 * Rules:
 * - A field the user edited ("user") is never overwritten.
 * - File metadata wins over online data for title and author (it describes this exact copy).
 * - Online data fills anything still empty. When matched by ISBN it also replaces a filename-guessed title.
 * - Covers: the embedded cover is kept unless it is missing, tiny, or a PDF page render
 *   that an ISBN-matched online cover can replace.
 */
import type { ExtractedMeta, TocEntry } from "../formats/index.js";
import type { AiMeta } from "./ai.js";
import { parseIsbn } from "./isbn.js";
import type { OnlineMeta } from "./online.js";

export type FieldSource = "filename" | "file" | "ai" | "openlibrary" | "googlebooks" | "user";

export const META_FIELDS = [
  "title",
  "subtitle",
  "author",
  "series",
  "seriesIndex",
  "description",
  "publisher",
  "published",
  "pageCount",
  "language",
  "isbn13",
  "subjects",
  "toc",
] as const;
export type MetaField = (typeof META_FIELDS)[number];

export interface BookMeta {
  title: string;
  subtitle: string | null;
  author: string | null;
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
}

export type Sources = Partial<Record<MetaField | "cover", FieldSource>>;

const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Metadata for a freshly indexed file. */
export function fromFile(meta: ExtractedMeta, fallbackTitle: string): { meta: BookMeta; sources: Sources } {
  const m: BookMeta = {
    title: meta.title || fallbackTitle,
    subtitle: meta.subtitle ?? null,
    author: meta.author ?? null,
    series: meta.series ?? null,
    seriesIndex: meta.seriesIndex ?? null,
    description: meta.description ?? null,
    publisher: meta.publisher ?? null,
    published: meta.published ?? null,
    pageCount: meta.pageCount ?? null,
    language: meta.language ?? null,
    isbn10: meta.isbn10 ?? null,
    isbn13: meta.isbn13 ?? null,
    subjects: meta.subjects ?? [],
    toc: meta.toc ?? [],
  };
  const sources: Sources = {};
  for (const f of META_FIELDS) if (!empty(m[f])) sources[f] = "file";
  sources.title = meta.title ? "file" : "filename";
  if (meta.cover) sources.cover = "file";
  return { meta: m, sources };
}

/**
 * Applies the AI's reading of the opening pages. It may correct the title, subtitle and author
 * that came from the file or file name (often junk), and fills other empty fields. Never touches
 * your edits or anything found online.
 */
export function mergeAi(meta: BookMeta, sources: Sources, ai: AiMeta): MetaField[] {
  if (ai.confidence === "low") return [];
  const changed: MetaField[] = [];
  const replaceable = (f: MetaField) => sources[f] === undefined || sources[f] === "filename" || sources[f] === "file";
  const set = <K extends MetaField>(f: K, v: BookMeta[K]) => {
    if (JSON.stringify(meta[f]) === JSON.stringify(v)) return;
    meta[f] = v;
    sources[f] = "ai";
    changed.push(f);
  };
  if (ai.title?.trim() && replaceable("title")) set("title", ai.title.trim());
  if (ai.subtitle?.trim() && replaceable("subtitle")) set("subtitle", ai.subtitle.trim());
  if (ai.authors.length && replaceable("author")) set("author", ai.authors.map((a) => a.trim()).filter(Boolean).join(", "));
  const fill = <K extends MetaField>(f: K, v: BookMeta[K] | null) => {
    if (!empty(v) && empty(meta[f]) && sources[f] !== "user") set(f, v as BookMeta[K]);
  };
  fill("series", ai.series);
  fill("seriesIndex", ai.seriesIndex);
  fill("publisher", ai.publisher);
  fill("published", ai.year && /^\d{4}$/.test(ai.year) ? ai.year : null);
  fill("language", ai.language);
  const isbn = parseIsbn(ai.isbn);
  if (isbn && empty(meta.isbn13) && sources.isbn13 !== "user") {
    set("isbn13", isbn.isbn13);
    meta.isbn10 = isbn.isbn10;
  }
  return changed;
}

/** Fills gaps from online results, in priority order. Returns the fields it changed. */
export function mergeOnline(meta: BookMeta, sources: Sources, results: OnlineMeta[]): MetaField[] {
  const changed: MetaField[] = [];
  const set = <K extends MetaField>(f: K, v: BookMeta[K], src: FieldSource) => {
    meta[f] = v;
    sources[f] = src;
    changed.push(f);
  };
  for (const r of results) {
    const weak = (f: MetaField) => sources[f] === undefined || (f === "title" && sources[f] === "filename" && r.matchedBy === "isbn");
    if (r.title && weak("title")) set("title", r.title, r.source);
    if (r.subtitle && empty(meta.subtitle) && sources.subtitle !== "user") {
      // Don't add a subtitle that the title already contains.
      if (!meta.title.toLowerCase().includes(r.subtitle.toLowerCase())) set("subtitle", r.subtitle, r.source);
    }
    const fill = <K extends MetaField>(f: K, v: BookMeta[K] | undefined) => {
      if (!empty(v) && empty(meta[f]) && sources[f] !== "user") set(f, v as BookMeta[K], r.source);
    };
    fill("author", r.author ?? null);
    fill("series", r.series ?? null);
    fill("description", r.description ?? null);
    fill("publisher", r.publisher ?? null);
    fill("published", r.published ?? null);
    fill("pageCount", r.pageCount ?? null);
    fill("language", r.language ?? null);
    fill("subjects", r.subjects ?? []);
    fill("toc", r.toc ?? []);
    if (r.isbn13 && empty(meta.isbn13) && sources.isbn13 !== "user" && r.matchedBy === "isbn") {
      set("isbn13", r.isbn13, r.source);
      meta.isbn10 = r.isbn10 ?? null;
    }
  }
  return changed;
}

/** Whether an online cover should replace the current one. */
export function wantsOnlineCover(
  sources: Sources,
  current: { width: number; height: number } | null,
  hasCover: boolean,
  format: string,
  best: OnlineMeta | undefined,
): boolean {
  if (!best?.coverUrls?.length || sources.cover === "user") return false;
  if (!hasCover) return true;
  if (sources.cover !== "file") return false;
  if (current && Math.max(current.width, current.height) < 400) return true;
  // A PDF's page 1 is often a title page, not the cover: trust an exact ISBN match over it.
  return format === "pdf" && best.matchedBy === "isbn";
}
