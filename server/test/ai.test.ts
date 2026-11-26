import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { epub, testConfig } from "./helpers.js";

/** A fake OpenAI endpoint: answers by schema name and records what it was sent. */
function fakeOpenAi(answers: { meta?: object; sort?: (body: { shelves: { id: string }[]; books: { id: string }[] }) => object }) {
  const requests: { auth: string; schema: string; user: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://ai.test/v1/chat/completions")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init!.body)) as { response_format: { json_schema: { name: string } }; messages: { content: string }[] };
    const schema = body.response_format.json_schema.name;
    const user = body.messages[1]!.content;
    requests.push({ auth: String((init!.headers as Record<string, string>).authorization), schema, user });
    const content = schema === "book_metadata" ? answers.meta : answers.sort?.(JSON.parse(user));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  }) as typeof fetch;
  return { f, requests };
}

const meta = (over: object = {}) => ({
  title: "Probability Theory",
  subtitle: "The Logic of Science",
  authors: ["E. T. Jaynes"],
  series: null,
  seriesIndex: null,
  publisher: "Cambridge University Press",
  year: "2003",
  language: "en",
  isbn: "9780521592710",
  confidence: "high",
  ...over,
});

const aiConfig = () => {
  const c = testConfig();
  c.openai.apiKey = "sk-test";
  return c;
};

test("AI pass cleans a junk title and author, keeps edits, and rejects an ISBN not in the text", async () => {
  const { f, requests } = fakeOpenAi({ meta: meta() });
  const { app, library } = await buildApp(aiConfig(), { logger: false, fetch: f, background: false });
  try {
    const { book } = await library.addBook("jaynes_prob_theory_FINAL(2).epub", await epub("Microsoft Word - jaynes.doc", "admin"));
    library.updateMetadata(book.id, { publisher: "My own publisher" });
    await library.aiPass(book.id);
    const d = library.getDetail(book.id);
    assert.equal(d.title, "Probability Theory");
    assert.equal(d.subtitle, "The Logic of Science");
    assert.equal(d.author, "E. T. Jaynes");
    assert.equal(d.sources.title, "ai");
    assert.equal(d.publisher, "My own publisher", "edited field kept");
    assert.equal(d.published, "2003");
    assert.equal(d.isbn13, null, "ISBN wasn't in the text sent, so it's dropped");
    assert.equal(requests[0]!.auth, "Bearer sk-test");
    assert.match(requests[0]!.user, /jaynes_prob_theory_FINAL/);
    // Already checked: no second call unless forced.
    assert.equal(await library.aiPass(book.id), false);
    assert.equal(requests.length, 1);
  } finally {
    await app.close();
  }
});

test("low-confidence AI answers change nothing", async () => {
  const { f } = fakeOpenAi({ meta: meta({ title: "Wild Guess", confidence: "low" }) });
  const { app, library } = await buildApp(aiConfig(), { logger: false, fetch: f, background: false });
  try {
    const { book } = await library.addBook("x.epub", await epub("Real Title", "Real Author"));
    await library.aiPass(book.id);
    assert.equal(library.getDetail(book.id).title, "Real Title");
  } finally {
    await app.close();
  }
});

test("AI sorting places books on existing shelves and suggests new ones to accept or dismiss", async () => {
  let shelfId = "";
  const { f } = fakeOpenAi({
    sort: (body) => ({
      assignments: body.books.map((b, i) => ({ bookId: b.id, shelfIds: i === 0 ? [shelfId, "not-a-shelf"] : [] })),
      newShelves: [
        { name: "Space opera", reason: "Two big space novels", bookIds: body.books.slice(1).map((b) => b.id) },
        { name: "fiction", reason: "duplicate of an existing shelf", bookIds: [body.books[0]!.id] },
        ...(body.books.length === 1 ? [{ name: "Golden age SF", reason: "Classic science fiction", bookIds: [body.books[0]!.id] }] : []),
      ],
    }),
  });
  const { app, library } = await buildApp(aiConfig(), { logger: false, fetch: f, background: false });
  try {
    shelfId = library.createShelf("Fiction").id;
    const a = (await library.addBook("a.epub", await epub("Stoner", "John Williams"))).book;
    const b = (await library.addBook("b.epub", await epub("Hyperion", "Dan Simmons"))).book;
    const c = (await library.addBook("c.epub", await epub("Dune", "Frank Herbert"))).book;

    const res = await library.sortBooks();
    assert.equal(res.placed, 1);
    assert.deepEqual(library.getDetail(a.id).shelfIds, [shelfId]);
    assert.equal(res.suggestions.length, 1, "duplicate of an existing shelf is ignored");
    assert.equal(res.suggestions[0]!.name, "Space opera");
    assert.deepEqual(res.suggestions[0]!.bookIds.sort(), [b.id, c.id].sort());

    // Accept via HTTP, renamed.
    const accepted = await app.inject({ method: "POST", url: `/api/shelf-suggestions/${res.suggestions[0]!.id}/accept`, payload: { name: "Science fiction" } });
    assert.equal(accepted.statusCode, 201);
    const overview = (await app.inject({ url: "/api/library" })).json();
    assert.equal(overview.ai, true);
    assert.deepEqual(overview.suggestions, []);
    const sf = overview.shelves.find((s: { name: string }) => s.name === "Science fiction");
    assert.equal(sf.books.length, 2);

    // A dismissed name isn't suggested again.
    const d = (await library.addBook("d.epub", await epub("Foundation", "Isaac Asimov"))).book;
    let again = await library.sortBooks([d.id]);
    assert.equal(again.suggestions.length, 1);
    library.dismissSuggestion(again.suggestions[0]!.id);
    again = await library.sortBooks([d.id]);
    assert.equal(again.suggestions.length, 0);
  } finally {
    await app.close();
  }
});

test("without a key the AI steps are off and sorting explains why", async () => {
  const { app, library } = await buildApp(testConfig(), { logger: false });
  try {
    const { book } = await library.addBook("x.epub", await epub("T", "A"));
    assert.equal(await library.aiPass(book.id), false);
    await assert.rejects(library.sortBooks(), /OPENAI_API_KEY/);
    assert.equal((await app.inject({ url: "/api/library" })).json().ai, false);
  } finally {
    await app.close();
  }
});

test("chat answers from the catalog and only changes things once an action is confirmed", async () => {
  let sent: { system: string; messages: { role: string; content: string }[] } | null = null;
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[] };
    sent = { system: body.messages[0]!.content, messages: body.messages.slice(1) };
    const content = {
      reply: "Dune is ready to move to Sci-fi.",
      actions: [
        { type: "move_books", bookIds: ["b1"], shelfId: "s2", fromShelfId: "s1", name: null, summary: "Move Dune to Sci-fi" },
        { type: "create_shelf", bookIds: ["b2"], shelfId: null, fromShelfId: null, name: "Favourites", summary: "New shelf Favourites" },
        { type: "move_books", bookIds: ["b99"], shelfId: "s2", fromShelfId: null, name: null, summary: "Unknown book: dropped" },
      ],
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  }) as typeof fetch;
  const { app, library } = await buildApp(aiConfig(), { logger: false, fetch: f, background: false });
  try {
    const { book: dune } = await library.addBook("dune.epub", await epub("Dune", "Frank Herbert"));
    const { book: emma } = await library.addBook("emma.epub", await epub("Emma", "Jane Austen"));
    const classics = library.createShelf("Classics");
    const scifi = library.createShelf("Sci-fi");
    library.moveBooks([dune.id], classics.id, null);

    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { messages: [{ role: "user", content: "Move Dune to Sci-fi" }] } });
    assert.equal(res.statusCode, 200);
    const { reply, actions } = res.json() as { reply: string; actions: { type: string; bookIds: string[]; shelfId: string | null }[] };
    assert.match(reply, /Dune/);
    assert.equal(actions.length, 2, "action with an unknown book dropped");
    assert.deepEqual(actions[0]!.bookIds, [dune.id]);
    assert.equal(actions[0]!.shelfId, scifi.id);
    assert.match(sent!.system, /b1 \| Dune \| Frank Herbert .*shelves: s1/);
    assert.equal(sent!.messages[0]!.content, "Move Dune to Sci-fi");

    // Nothing moved until it's confirmed.
    assert.deepEqual(library.getDetail(dune.id).shelfIds, [classics.id]);
    const ok = await app.inject({ method: "POST", url: "/api/chat/apply", payload: { action: actions[0] } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(library.getDetail(dune.id).shelfIds, [scifi.id]);
    await app.inject({ method: "POST", url: "/api/chat/apply", payload: { action: actions[1] } });
    const fav = library.overview().shelves.find((s) => s.name === "Favourites");
    assert.deepEqual(fav?.books.map((b) => b.id), [emma.id]);

    const bad = await app.inject({ method: "POST", url: "/api/chat/apply", payload: { action: { type: "delete_shelf", shelfId: "nope", bookIds: [] } } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("chat explains how to turn it on without a key", async () => {
  const { app } = await buildApp(testConfig(), { logger: false, background: false });
  try {
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /API key/);
  } finally {
    await app.close();
  }
});
