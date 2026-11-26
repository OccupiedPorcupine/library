import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { epub, testConfig } from "./helpers.js";

async function withBook() {
  const { app, library, db } = await buildApp(testConfig(), { logger: false, background: false });
  const { book } = await library.addBook("Notes.epub", await epub("Notes", "Someone"));
  return { app, db, id: book.id };
}

test("highlights, notes and bookmarks round-trip through the API", async () => {
  const { app, id } = await withBook();
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/books/${id}/annotations`,
      payload: { kind: "highlight", locator: "epubcfi(/6/4!/4/2,/1:0,/1:12)", text: "Hello world.", color: "green", fraction: 0.4 },
    });
    assert.equal(created.statusCode, 201);
    const h = created.json();
    assert.equal(h.color, "green");
    assert.equal(h.note, null);

    const pdf = await app.inject({
      method: "POST",
      url: `/api/books/${id}/annotations`,
      payload: { kind: "highlight", locator: "page:3", page: 3, rects: [[0.1, 0.2, 0.5, 0.03], [2, -1, 0.5, 0.03], "bad"], fraction: 0.1 },
    });
    assert.deepEqual(pdf.json().rects, [[0.1, 0.2, 0.5, 0.03], [1, 0, 0.5, 0.03]], "rects are clamped and invalid ones dropped");
    assert.equal(pdf.json().color, "yellow", "default colour");

    const mark = await app.inject({ method: "POST", url: `/api/books/${id}/annotations`, payload: { kind: "bookmark", locator: "page:9", color: "pink", fraction: 0.9 } });
    assert.equal(mark.json().color, null, "bookmarks have no colour");

    const edited = await app.inject({ method: "PATCH", url: `/api/annotations/${h.id}`, payload: { note: "Remember this", color: "purple" } });
    assert.equal(edited.json().note, "Remember this");
    assert.equal(edited.json().color, "purple");
    const badColor = await app.inject({ method: "PATCH", url: `/api/annotations/${h.id}`, payload: { color: "chartreuse" } });
    assert.equal(badColor.json().color, "purple", "unknown colours are ignored");

    const list = (await app.inject({ url: `/api/books/${id}/annotations` })).json();
    assert.deepEqual(
      list.map((a: { kind: string; fraction: number }) => [a.kind, a.fraction]),
      [["highlight", 0.1], ["highlight", 0.4], ["bookmark", 0.9]],
      "sorted by position in the book",
    );

    assert.equal((await app.inject({ method: "DELETE", url: `/api/annotations/${mark.json().id}` })).statusCode, 204);
    assert.equal((await app.inject({ url: `/api/books/${id}/annotations` })).json().length, 2);
  } finally {
    await app.close();
  }
});

test("annotations reject bad input and go away with their book", async () => {
  const { app, db, id } = await withBook();
  try {
    assert.equal((await app.inject({ method: "POST", url: `/api/books/${id}/annotations`, payload: { kind: "scribble", locator: "x" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/books/${id}/annotations`, payload: { kind: "bookmark" } })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/books/nope/annotations` })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/annotations/nope`, payload: {} })).statusCode, 404);

    await app.inject({ method: "POST", url: `/api/books/${id}/annotations`, payload: { kind: "bookmark", locator: "page:1" } });
    assert.equal((await app.inject({ method: "DELETE", url: `/api/books/${id}` })).statusCode, 204);
    assert.equal((db.prepare("SELECT count(*) AS n FROM annotations").get() as { n: number }).n, 0);
  } finally {
    await app.close();
  }
});
