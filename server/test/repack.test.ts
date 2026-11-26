import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { repackEpubZip } from "../src/formats/repack.js";
import { detectFormat } from "../src/formats/index.js";
import { buildApp } from "../src/app.js";
import { epub, testConfig } from "./helpers.js";

/** An Apple Books export: the EPUB is a folder, zipped with Finder's "Compress". */
async function appleBooksZip(title: string): Promise<Buffer> {
  const inner = await JSZip.loadAsync(await epub(title, "Some Author"));
  const z = new JSZip();
  for (const f of Object.values(inner.files)) {
    if (f.dir || f.name === "mimetype") continue;
    z.file(`${title}.epub/${f.name}`, await f.async("nodebuffer"));
  }
  z.file(`__MACOSX/${title}.epub/._content.opf`, "junk");
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("a zipped EPUB folder is repacked into a valid EPUB", async () => {
  const r = await repackEpubZip("Folder Book.epub.zip", await appleBooksZip("Folder Book"));
  assert.ok(r);
  assert.equal(r.fileName, "Folder Book.epub");
  assert.equal(detectFormat(r.fileName, r.data.subarray(0, 128)), "epub");
  assert.equal(r.data.subarray(30, 58).toString("latin1"), "mimetypeapplication/epub+zip");
  const names = Object.keys((await JSZip.loadAsync(r.data)).files);
  assert.ok(names.includes("META-INF/container.xml"));
  assert.ok(!names.some((n) => n.startsWith("__MACOSX")));
  assert.equal(await repackEpubZip(r.fileName, r.data), null, "already valid");
  assert.equal(await repackEpubZip("x.epub", await epub("Fine", "Me")), null);
});

test("uploads and stored books that are zipped EPUB folders become EPUBs", async () => {
  const { app, library, db } = await buildApp(testConfig(), { logger: false, background: false });
  try {
    const { book } = await library.addBook("Upload Book.epub.zip", await appleBooksZip("Upload Book"));
    assert.equal(book.format, "epub");
    assert.equal(book.title, "Upload Book");

    // One stored before the fix, as a comic.
    const { book: b2 } = await library.addBook("Placeholder.epub", await epub("Placeholder", "Me"));
    const key = `books/${b2.id}/Old Book.epub.zip`;
    await (library as unknown as { storage: { put(k: string, d: Buffer, t: string): Promise<void> } }).storage.put(key, await appleBooksZip("Old Book"), "application/zip");
    db.prepare("UPDATE books SET format = 'cbz', title = 'Old Book.epub', file_key = ?, file_name = 'Old Book.epub.zip', meta_sources = '{}' WHERE id = ?").run(key, b2.id);
    assert.equal(await library.repackStored(), 1);
    const d = library.getDetail(b2.id);
    assert.equal(d.format, "epub");
    assert.equal(d.title, "Old Book");
    assert.match(d.fileName, /\.epub$/);
  } finally {
    await app.close();
  }
});
