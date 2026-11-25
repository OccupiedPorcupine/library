import JSZip from "jszip";
import type { ExtractedMeta } from "./index.js";
import { imageType } from "./images.js";

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorted image entries of a comic archive: the reading order. */
export function comicPages(zip: JSZip): string[] {
  return Object.values(zip.files)
    .filter((f) => !f.dir && !f.name.startsWith("__MACOSX") && imageType(f.name))
    .map((f) => f.name)
    .sort(natural.compare);
}

export async function extractCbz(data: Buffer): Promise<ExtractedMeta> {
  const zip = await JSZip.loadAsync(data);
  const meta: ExtractedMeta = {};
  const info = await zip.file(/(^|\/)ComicInfo\.xml$/i)[0]?.async("string");
  if (info) {
    const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(info)?.[1]?.trim();
    const series = pick("Series");
    const number = pick("Number");
    meta.title = pick("Title") ?? (series ? `${series}${number ? ` #${number}` : ""}` : undefined);
    meta.author = pick("Writer");
  }
  const first = comicPages(zip)[0];
  if (first) {
    const bytes = await zip.file(first)!.async("nodebuffer");
    meta.cover = { data: bytes, ...imageType(first)! };
  }
  return meta;
}
