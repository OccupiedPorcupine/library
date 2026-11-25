import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import path from "node:path";
import type { ExtractedMeta } from "./index.js";
import { imageType } from "./images.js";

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true });

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object" && "#text" in v) return String((v as { "#text": unknown })["#text"]).trim();
  return undefined;
};

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
  const title = text(arr(meta.title)[0]);
  const authors = arr(meta.creator).map(text).filter(Boolean) as string[];

  // Find the cover: EPUB 3 "cover-image" property, else EPUB 2 <meta name="cover">.
  const items = arr(pkg?.manifest?.item) as Record<string, string>[];
  let coverItem = items.find((i) => (i["@properties"] ?? "").split(/\s+/).includes("cover-image"));
  if (!coverItem) {
    const coverId = (arr(meta.meta) as Record<string, string>[]).find((m) => m["@name"] === "cover")?.["@content"];
    coverItem = items.find((i) => i["@id"] === coverId);
  }
  if (!coverItem) coverItem = items.find((i) => /cover/i.test(i["@id"] ?? "") && /^image\//.test(i["@media-type"] ?? ""));

  let cover: ExtractedMeta["cover"];
  if (coverItem?.["@href"]) {
    const href = path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(coverItem["@href"]));
    const bytes = await zip.file(href)?.async("nodebuffer");
    const type = imageType(href);
    if (bytes && type) cover = { data: bytes, ...type };
  }
  return { title, author: authors.join(", ") || undefined, cover };
}
