import path from "node:path";
import type { Format } from "../db.js";
import { extractEpub } from "./epub.js";
import { extractCbz } from "./cbz.js";
import { extractPdf } from "./pdf.js";

/** One table-of-contents line. `href` is used by reflowable formats, `page` (1-based) by fixed-layout ones. */
export interface TocEntry {
  title: string;
  level: number;
  href?: string;
  page?: number;
}

export interface ExtractedMeta {
  title?: string;
  subtitle?: string;
  author?: string;
  series?: string;
  seriesIndex?: number;
  description?: string;
  publisher?: string;
  published?: string;
  pageCount?: number;
  language?: string;
  isbn10?: string | null;
  isbn13?: string;
  subjects?: string[];
  toc?: TocEntry[];
  cover?: { data: Buffer; ext: string; contentType: string };
}

export const CONTENT_TYPES: Record<Format, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  fb2: "application/x-fictionbook+xml",
};

const EXT: Record<string, Format> = {
  ".epub": "epub",
  ".pdf": "pdf",
  ".cbz": "cbz",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".mobi": "mobi",
  ".azw3": "azw3",
  ".azw": "azw3",
  ".fb2": "fb2",
};

/** Detects the format from magic bytes, falling back to the extension. */
export function detectFormat(fileName: string, head: Buffer): Format | null {
  const ext = EXT[path.extname(fileName).toLowerCase()] ?? null;
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // ZIP container: EPUB declares its mimetype as the first entry.
    if (head.subarray(30, 58).toString("latin1") === "mimetypeapplication/epub+zip") return "epub";
    return ext === "epub" ? "epub" : "cbz";
  }
  if (head.subarray(60, 68).toString("latin1") === "BOOKMOBI") return ext === "azw3" ? "azw3" : "mobi";
  return ext;
}

export function titleFromFileName(fileName: string): string {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractMeta(format: Format, data: Buffer): Promise<ExtractedMeta> {
  try {
    switch (format) {
      case "epub":
        return await extractEpub(data);
      case "cbz":
        return await extractCbz(data);
      case "pdf":
        return await extractPdf(data);
      default:
        return {};
    }
  } catch {
    // Broken metadata should never block an upload.
    return {};
  }
}

export function isSupported(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() in EXT;
}
