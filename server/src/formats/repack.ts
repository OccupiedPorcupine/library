import path from "node:path";
import JSZip from "jszip";

const EPUB_MIME = "application/epub+zip";
const junk = (name: string) => name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name);

/**
 * A zip that holds an EPUB but isn't a valid one: most often an Apple Books export, which is
 * a folder ("Book.epub/") that was zipped, so everything sits under that folder and there's no
 * leading mimetype. Returns the book repacked as a proper EPUB (mimetype first, uncompressed),
 * or null when the zip is not an EPUB or is already valid.
 */
export async function repackEpubZip(fileName: string, data: Buffer): Promise<{ fileName: string; data: Buffer } | null> {
  if (!data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return null;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null;
  }
  const containers = Object.keys(zip.files).filter((n) => !junk(n) && /(^|\/)META-INF\/container\.xml$/i.test(n));
  // Shallowest container wins; it decides the folder the book lives in.
  const container = containers.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!container) return null;
  const prefix = container.slice(0, container.length - "META-INF/container.xml".length);
  const valid = !prefix && data.subarray(30, 58).toString("latin1") === `mimetype${EPUB_MIME}`;
  if (valid) return null;

  const out = new JSZip();
  out.file("mimetype", EPUB_MIME, { compression: "STORE", date: new Date(0) });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || junk(entry.name) || !entry.name.startsWith(prefix)) continue;
    const name = entry.name.slice(prefix.length);
    if (!name || name === "mimetype") continue;
    out.file(name, await entry.async("nodebuffer"), { compression: "DEFLATE", date: entry.date });
  }
  const repacked = await out.generateAsync({ type: "nodebuffer", platform: "UNIX" });

  // "Book.epub/" (the folder) names the book better than "Book.epub.zip".
  const folder = prefix.split("/").filter(Boolean).pop();
  const base = folder ?? path.basename(fileName);
  const stem = base.replace(/(\.epub)?(\.(zip|cbz))?$/i, "");
  return { fileName: `${stem || "book"}.epub`, data: repacked };
}
