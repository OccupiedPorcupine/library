import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { extractPdf } from "../src/formats/pdf.js";

test("PDF: info, page count, bookmarks, ISBN from text and a rendered cover", async () => {
  const m = await extractPdf(fs.readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)));
  assert.equal(m.title, "Probability Theory");
  assert.equal(m.author, "E. T. Jaynes");
  assert.equal(m.description, "The logic of science");
  assert.deepEqual(m.subjects, ["probability", "bayesian"]);
  assert.equal(m.pageCount, 3);
  assert.equal(m.isbn13, "9780521592710");
  assert.deepEqual(m.toc, [
    { title: "Cover", level: 0, page: 1 },
    { title: "Part I", level: 0, page: 2 },
    { title: "Plausible reasoning", level: 1, page: 3 },
  ]);
  assert.equal(m.cover?.contentType, "image/jpeg");
  assert.ok(m.cover!.data.length > 1000);
});

test("PDF: extraction leaves the caller's buffer intact", async () => {
  // Large enough not to come from Node's shared buffer pool.
  const data = Buffer.concat([fs.readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)), Buffer.alloc(64 * 1024)]);
  const before = data.length;
  await extractPdf(data).catch(() => undefined);
  assert.equal(data.length, before);
});
