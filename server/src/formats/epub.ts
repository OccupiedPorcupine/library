import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import path from "node:path";
import { parseIsbn } from "../metadata/isbn.js";
import type { ExtractedMeta, TocEntry } from "./index.js";
import { imageType } from "./images.js";

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true });
// Order-preserving parser for nav/NCX documents, where list items must stay arrays.
const navXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  isArray: (name) => ["li", "navPoint", "ol", "nav"].includes(name),
});

type Node = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | undefined => {
  if (typeof v === "string" || typeof v === "number") return String(v).trim() || undefined;
  if (v && typeof v === "object" && "#text" in v) return String((v as { "#text": unknown })["#text"]).trim() || undefined;
  return undefined;
};
/** All text inside a node, e.g. <a><span>1.</span> Intro</a>. */
const deepText = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(deepText).join(" ");
  if (v && typeof v === "object")
    return Object.entries(v)
      .filter(([k]) => !k.startsWith("@"))
      .map(([, c]) => deepText(c))
      .join(" ");
  return "";
};
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const stripHtml = (s: string) =>
  clean(
    s
      .replace(/<\/(p|div|br)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );

const MAX_TOC = 2000;

function navToc(doc: Node, docPath: string): TocEntry[] {
  const out: TocEntry[] = [];
  const findNav = (n: unknown): Node | undefined => {
    if (!n || typeof n !== "object") return undefined;
    for (const [k, v] of Object.entries(n)) {
      if (k === "nav") {
        const navs = arr(v as Node[]);
        return navs.find((x) => String(x["@type"] ?? "").split(/\s+/).includes("toc")) ?? navs[0];
      }
      if (!k.startsWith("@")) {
        for (const c of arr(v)) {
          const hit = findNav(c);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  const walk = (ol: Node | undefined, level: number) => {
    for (const li of arr(ol?.li as Node[])) {
      if (out.length >= MAX_TOC) return;
      const a = (li.a ?? li.span) as Node | string | undefined;
      const title = clean(deepText(a));
      const href = typeof a === "object" ? (a?.["@href"] as string | undefined) : undefined;
      if (title) out.push({ title, level, href: href ? resolveHref(docPath, href) : undefined });
      for (const sub of arr(li.ol as Node[])) walk(sub, level + 1);
    }
  };
  const nav = findNav(doc);
  for (const ol of arr(nav?.ol as Node[])) walk(ol, 0);
  return out;
}

function ncxToc(doc: Node, docPath: string): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (points: Node[], level: number) => {
    for (const p of points) {
      if (out.length >= MAX_TOC) return;
      const title = clean(deepText((p.navLabel as Node | undefined)?.text));
      const src = (p.content as Node | undefined)?.["@src"] as string | undefined;
      if (title) out.push({ title, level, href: src ? resolveHref(docPath, src) : undefined });
      walk(arr(p.navPoint as Node[]), level + 1);
    }
  };
  walk(arr(((doc.ncx as Node | undefined)?.navMap as Node | undefined)?.navPoint as Node[]), 0);
  return out;
}

/** Makes a TOC link relative to the archive root, keeping any #fragment. */
function resolveHref(fromDoc: string, href: string): string {
  const [file, frag] = href.split("#");
  const full = file ? path.posix.normalize(path.posix.join(path.posix.dirname(fromDoc), decodeURIComponent(file))) : fromDoc;
  return frag ? `${full}#${frag}` : full;
}

export async function extractEpub(data: Buffer): Promise<ExtractedMeta> {
  const zip = await JSZip.loadAsync(data);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) return {};
  const rootfile = arr(xml.parse(container)?.container?.rootfiles?.rootfile)[0] as Record<string, string> | undefined;
  const opfPath = rootfile?.["@full-path"];
  if (!opfPath) return {};
  const opfText = await zip.file(opfPath)?.async("string");
  if (!opfText) return {};
  const pkg = xml.parse(opfText)?.package;
  const meta = pkg?.metadata ?? {};
  const metas = arr(meta.meta) as Node[];
  const opfDir = path.posix.dirname(opfPath);

  // EPUB 3 refinements: <meta refines="#id" property="title-type">subtitle</meta>
  const refine = (id: string | undefined, prop: string) =>
    id ? text(metas.find((m) => m["@refines"] === `#${id}` && m["@property"] === prop)) : undefined;

  const titles = arr(meta.title) as unknown[];
  const titleOf = (t: unknown) => text(t);
  const idOf = (t: unknown) => (t && typeof t === "object" ? ((t as Node)["@id"] as string | undefined) : undefined);
  const main = titles.find((t) => refine(idOf(t), "title-type") === "main") ?? titles[0];
  const sub = titles.find((t) => refine(idOf(t), "title-type") === "subtitle");
  const authors = (arr(meta.creator) as unknown[])
    .filter((c) => {
      const role = (c as Node)?.["@role"] ?? refine(idOf(c), "role");
      return !role || role === "aut";
    })
    .map(text)
    .filter(Boolean) as string[];

  let isbn: ReturnType<typeof parseIsbn> = null;
  for (const id of arr(meta.identifier)) {
    isbn = parseIsbn(text(id));
    if (isbn) break;
  }

  // Series: calibre's <meta name="calibre:series">, or EPUB 3 belongs-to-collection.
  let series = text(metas.find((m) => m["@name"] === "calibre:series")?.["@content"]);
  let seriesIndex = Number(metas.find((m) => m["@name"] === "calibre:series_index")?.["@content"]) || undefined;
  if (!series) {
    const coll = metas.find((m) => m["@property"] === "belongs-to-collection");
    series = text(coll);
    if (coll) seriesIndex = Number(refine(coll["@id"] as string, "group-position")) || undefined;
  }

  const description = text(arr(meta.description)[0]);
  const subjects = [...new Set((arr(meta.subject) as unknown[]).map(text).filter(Boolean) as string[])];

  // Find the cover: EPUB 3 "cover-image" property, else EPUB 2 <meta name="cover">.
  const items = arr(pkg?.manifest?.item) as Record<string, string>[];
  let coverItem = items.find((i) => (i["@properties"] ?? "").split(/\s+/).includes("cover-image"));
  if (!coverItem) {
    const coverId = (metas as Record<string, string>[]).find((m) => m["@name"] === "cover")?.["@content"];
    coverItem = items.find((i) => i["@id"] === coverId);
  }
  if (!coverItem) coverItem = items.find((i) => /cover/i.test(i["@id"] ?? "") && /^image\//.test(i["@media-type"] ?? ""));

  let cover: ExtractedMeta["cover"];
  if (coverItem?.["@href"]) {
    const href = path.posix.join(opfDir, decodeURIComponent(coverItem["@href"]));
    const bytes = await zip.file(href)?.async("nodebuffer");
    const type = imageType(href);
    if (bytes && type) cover = { data: bytes, ...type };
  }

  // Table of contents: EPUB 3 nav document, else the EPUB 2 NCX.
  let toc: TocEntry[] = [];
  try {
    const navItem = items.find((i) => (i["@properties"] ?? "").split(/\s+/).includes("nav"));
    if (navItem?.["@href"]) {
      const navPath = path.posix.join(opfDir, decodeURIComponent(navItem["@href"]));
      const navText = await zip.file(navPath)?.async("string");
      if (navText) toc = navToc(navXml.parse(navText), navPath);
    }
    if (!toc.length) {
      const ncxId = pkg?.spine?.["@toc"] as string | undefined;
      const ncxItem = items.find((i) => i["@id"] === ncxId) ?? items.find((i) => i["@media-type"] === "application/x-dtbncx+xml");
      if (ncxItem?.["@href"]) {
        const ncxPath = path.posix.join(opfDir, decodeURIComponent(ncxItem["@href"]));
        const ncxText = await zip.file(ncxPath)?.async("string");
        if (ncxText) toc = ncxToc(navXml.parse(ncxText), ncxPath);
      }
    }
  } catch {
    // A broken TOC shouldn't lose the rest of the metadata.
  }

  // Text of the first few spine documents: title page, copyright page, opening chapter.
  let sampleText = "";
  try {
    const byId = new Map(items.map((i) => [i["@id"], i]));
    for (const ref of arr(pkg?.spine?.itemref) as Record<string, string>[]) {
      if (sampleText.length >= 8000) break;
      const it = byId.get(ref["@idref"]);
      if (!it?.["@href"] || !/html|xml/.test(it["@media-type"] ?? "")) continue;
      const html = await zip.file(path.posix.join(opfDir, decodeURIComponent(it["@href"])))?.async("string");
      if (html) sampleText += stripHtml(html.replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, " ")) + "\n\n";
    }
  } catch {
    // optional
  }

  return {
    sampleText: sampleText.trim().slice(0, 8000) || undefined,
    title: titleOf(main),
    subtitle: titleOf(sub),
    author: authors.join(", ") || undefined,
    series,
    seriesIndex,
    description: description ? stripHtml(description) : undefined,
    publisher: text(arr(meta.publisher)[0]),
    published: text(arr(meta.date)[0])?.slice(0, 10),
    language: text(arr(meta.language)[0]),
    isbn10: isbn?.isbn10,
    isbn13: isbn?.isbn13,
    subjects: subjects.length ? subjects : undefined,
    toc: toc.length ? toc : undefined,
    cover,
  };
}
