import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { createCanvas } from "@napi-rs/canvas";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { isSameBook } from "../src/metadata/online.js";

function testConfig(): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-test-"));
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    dbPath: path.join(dir, "library.db"),
    webDist: path.join(dir, "no-web"),
    metadataOnline: false,
    googleBooksApiKey: undefined,
    maxUploadBytes: 50 * 1024 * 1024,
    storage: { driver: "local", localPath: path.join(dir, "books"), s3: {} as Config["storage"]["s3"] },
  };
}

async function epub(title: string, author: string, extra = ""): Promise<Buffer> {
  const z = new JSZip();
  z.file("mimetype", "application/epub+zip", { compression: "STORE" });
  z.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  z.file("content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>${extra}</metadata><manifest/><spine/></package>`);
  return z.generateAsync({ type: "nodebuffer" });
}

const jpeg = async (w: number, h: number) => Buffer.from(await createCanvas(w, h).encode("jpeg", 80));

/** Fake Open Library + Google Books, recording which URLs were asked for. */
async function fakeFetch() {
  const cover = await jpeg(400, 600);
  const calls: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const u = new URL(url);
    if (u.host === "openlibrary.org" && u.pathname === "/search.json") {
      if (u.searchParams.get("title") === "Piranesi" || u.searchParams.get("isbn") === "9781635575637")
        return json({
          docs: [
            {
              key: "/works/OL1W",
              title: "Piranesi",
              author_name: ["Susanna Clarke"],
              first_publish_year: 2020,
              publisher: ["Bloomsbury"],
              number_of_pages_median: 272,
              language: ["eng"],
              subject: ["Fantasy fiction", "Labyrinths"],
              cover_i: 42,
              isbn: ["9781635575637"],
            },
          ],
        });
      return json({ docs: [{ key: "/works/OL9W", title: "Something Else Entirely", author_name: ["Nobody"] }] });
    }
    if (url === "https://openlibrary.org/works/OL1W.json") return json({ description: { value: "Piranesi lives in the House." } });
    if (u.host === "openlibrary.org" && u.pathname.startsWith("/isbn/"))
      return json({ publishers: ["Bloomsbury Publishing"], number_of_pages: 245, table_of_contents: [{ title: "Part 1", level: 0 }] });
    if (u.host === "covers.openlibrary.org") return new Response(cover);
    if (u.host === "www.googleapis.com")
      return json({ items: [{ volumeInfo: { title: "Piranesi", authors: ["Susanna Clarke"], description: "<b>GB</b> blurb", categories: ["Fiction / Fantasy"] } }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

test("title matching rejects other books and wrong authors", () => {
  assert.ok(isSameBook({ title: "The Piranesi", author: "Susanna Clarke" }, "Piranesi", ["Clarke, Susanna"]));
  assert.ok(isSameBook({ title: "Probability Theory: The Logic of Science" }, "Probability Theory", undefined));
  assert.ok(!isSameBook({ title: "Piranesi", author: "Susanna Clarke" }, "Piranesi", ["Someone Else"]));
  assert.ok(!isSameBook({ title: "Solaris" }, "Solar Power Basics", undefined));
});

test("upload, online fill-in, manual edits stick, cover replaced", async () => {
  const { f, calls } = await fakeFetch();
  const { app, library } = await buildApp(testConfig(), { logger: false, fetch: f });
  try {
    const { book } = await library.addBook("piranesi.epub", await epub("Piranesi", "Susanna Clarke", "<dc:language>en</dc:language>"));
    let d = library.getDetail(book.id);
    assert.equal(d.sources.title, "file");
    assert.equal(d.metaCheckedAt, null);

    d = await library.refreshMetadata(book.id);
    assert.equal(d.description, "Piranesi lives in the House.");
    assert.equal(d.sources.description, "openlibrary");
    assert.equal(d.publisher, "Bloomsbury");
    assert.equal(d.pageCount, 272);
    assert.equal(d.language, "en"); // from the file, kept
    assert.equal(d.sources.language, "file");
    assert.deepEqual(d.subjects, ["Fantasy fiction", "Labyrinths"]);
    assert.equal(d.isbn13, null, "title matches don't assign an ISBN");
    assert.ok(d.coverUrl, "online cover fetched");
    assert.equal(d.sources.cover, "openlibrary");
    assert.ok(d.metaCheckedAt);

    // Manual edit wins over later refreshes.
    d = library.updateMetadata(book.id, { description: "My own note", isbn13: "978-1-63557-563-7", subjects: ["Favourites", " "] });
    assert.equal(d.sources.description, "user");
    assert.equal(d.isbn10, "163557563X");
    assert.deepEqual(d.subjects, ["Favourites"]);
    calls.length = 0;
    d = await library.refreshMetadata(book.id);
    assert.equal(d.description, "My own note");
    assert.deepEqual(d.subjects, ["Favourites"]);
    assert.ok(calls.some((c) => c.includes("isbn=9781635575637")), "uses the ISBN once known");
    assert.deepEqual(d.toc, [{ title: "Part 1", level: 0 }]);

    assert.throws(() => library.updateMetadata(book.id, { isbn13: "12345" }), /ISBN/);

    // HTTP routes
    const res = await app.inject({ method: "PATCH", url: `/api/books/${book.id}/metadata`, payload: { series: "Halls", seriesIndex: "2" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().seriesIndex, 2);
    assert.equal((await app.inject({ url: `/api/books/${book.id}` })).json().series, "Halls");
  } finally {
    await app.close();
  }
});

test("no match leaves the book alone and still marks it checked", async () => {
  const { f } = await fakeFetch();
  const { app, library } = await buildApp(testConfig(), { logger: false, fetch: f });
  try {
    const { book } = await library.addBook("x.epub", await epub("A Very Obscure Zine", "Me"));
    const d = await library.refreshMetadata(book.id);
    assert.equal(d.description, null);
    assert.equal(d.coverUrl, null);
    assert.ok(d.metaCheckedAt);
  } finally {
    await app.close();
  }
});

test("user cover upload", async () => {
  const { app, library } = await buildApp(testConfig(), { logger: false });
  try {
    const { book } = await library.addBook("x.epub", await epub("Cover Test", "Me"));
    const d = await library.setUserCover(book.id, await jpeg(300, 450));
    assert.equal(d.sources.cover, "user");
    const img = await app.inject({ url: d.coverUrl! });
    assert.equal(img.headers["content-type"], "image/jpeg");
    await assert.rejects(library.setUserCover(book.id, Buffer.from("not an image")), /JPEG/);
  } finally {
    await app.close();
  }
});
