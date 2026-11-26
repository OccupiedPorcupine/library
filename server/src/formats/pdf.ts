import { findIsbn, parseIsbn } from "../metadata/isbn.js";
import type { ExtractedMeta, TocEntry } from "./index.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;
const loadPdfJs = () => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

const MAX_TOC = 2000;
const SAMPLE_CHARS = 8000;
const COVER_WIDTH = 600;

/** Placeholder values PDF tools write when nothing was set. */
const PLACEHOLDER = /^(\(?anonymous\)?|unknown|unspecified|none|n\/a|untitled|author|title|-)$/i;
const str = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s && !PLACEHOLDER.test(s) ? s : undefined;
};

/** Title fields that are really file names or tool output ("Microsoft Word - draft.docx"). */
const junkTitle = (t: string) => /^(untitled|microsoft word|document\d*$)|\.(docx?|pdf|tex|indd|qxd)$/i.test(t);

/**
 * Reads the info dictionary, XMP, page count and bookmarks with pdf.js,
 * looks for an ISBN on the first and last pages, and renders page 1 as the cover.
 */
export async function extractPdf(data: Buffer): Promise<ExtractedMeta> {
  const { getDocument } = await loadPdfJs();
  const doc = await getDocument({
    // A copy: pdf.js transfers (detaches) the buffer it is given, which would empty the caller's Buffer.
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const out: ExtractedMeta = { pageCount: doc.numPages };
    const { info, metadata } = (await doc.getMetadata().catch(() => ({ info: {}, metadata: null }))) as {
      info: Record<string, unknown>;
      metadata: { get(k: string): unknown } | null;
    };
    const xmp = (k: string) => {
      const v = metadata?.get(k);
      return str(Array.isArray(v) ? v.join(", ") : v);
    };
    const title = xmp("dc:title") ?? str(info.Title);
    if (title && !junkTitle(title)) out.title = title;
    out.author = xmp("dc:creator") ?? str(info.Author);
    out.description = xmp("dc:description") ?? str(info.Subject);
    out.language = xmp("dc:language") ?? str(info.Language);
    out.publisher = xmp("dc:publisher");
    const keywords = str(info.Keywords);
    if (keywords) out.subjects = [...new Set(keywords.split(/[;,]/).map((k) => k.trim()).filter(Boolean))].slice(0, 20);
    // Not using CreationDate: that's when the file was made, not when the book came out.
    const isbn = parseIsbn(xmp("dc:identifier") ?? xmp("prism:isbn"));
    if (isbn) Object.assign(out, isbn);

    out.toc = await outline(doc);

    // The opening pages hold the title page and copyright page: keep their text for the AI pass,
    // and look there for an ISBN (or on the back cover).
    const pages = [...new Set([1, 2, 3, 4, 5, 6, doc.numPages].filter((p) => p >= 1 && p <= doc.numPages))];
    const texts: string[] = [];
    for (const p of pages) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      texts.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" ").replace(/\s+/g, " ").trim());
      page.cleanup();
    }
    if (!out.isbn13) {
      for (const t of texts) {
        const hit = findIsbn(t);
        if (hit) {
          Object.assign(out, hit);
          break;
        }
      }
    }
    out.sampleText = texts.filter(Boolean).join("\n\n").slice(0, SAMPLE_CHARS);

    out.cover = await renderCover(doc).catch(() => undefined);
    return out;
  } finally {
    await doc.destroy();
  }
}

type Doc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

async function outline(doc: Doc): Promise<TocEntry[] | undefined> {
  const items = await doc.getOutline().catch(() => null);
  if (!items?.length) return undefined;
  const out: TocEntry[] = [];
  const pageOf = async (dest: unknown): Promise<number | undefined> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : undefined;
      if (ref == null) return undefined;
      if (typeof ref === "number") return ref + 1;
      return (await doc.getPageIndex(ref)) + 1;
    } catch {
      return undefined;
    }
  };
  const walk = async (list: typeof items, level: number) => {
    for (const it of list) {
      if (out.length >= MAX_TOC) return;
      const title = str(it.title);
      if (title) out.push({ title, level, page: await pageOf(it.dest) });
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(items, 0);
  return out.length ? out : undefined;
}

/** Renders page 1 to a JPEG. Needs @napi-rs/canvas (an optional pdf.js dependency); skipped without it. */
async function renderCover(doc: Doc): Promise<ExtractedMeta["cover"]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
  page.cleanup();
  const jpg = await canvas.encode("jpeg", 82);
  return { data: Buffer.from(jpg), ext: "jpg", contentType: "image/jpeg" };
}
