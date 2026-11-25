import type { ExtractedMeta } from "./index.js";

/**
 * Reads Title/Author from an uncompressed PDF Info dictionary.
 * Cheap best-effort only: a proper pass with pdf.js (and a first-page cover) is tracked in #3.
 */
export function extractPdf(data: Buffer): ExtractedMeta {
  const sample = data.subarray(Math.max(0, data.length - 64 * 1024)).toString("latin1") + data.subarray(0, 64 * 1024).toString("latin1");
  const field = (name: string) => {
    const m = new RegExp(`/${name}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(sample);
    if (!m) return undefined;
    const raw = m[1]!.replace(/\\([()\\])/g, "$1");
    // Skip UTF-16 encoded strings rather than show garbage.
    if (raw.startsWith("þÿ")) return undefined;
    return raw.trim() || undefined;
  };
  return { title: field("Title"), author: field("Author") };
}
