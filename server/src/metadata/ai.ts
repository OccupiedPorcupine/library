/**
 * AI helpers (OpenAI Chat Completions with structured JSON output), called only from the server.
 * The key lives in the gitignored .env; without one every helper is skipped.
 */
import { parseIsbn } from "./isbn.js";

export interface AiOptions {
  apiKey?: string;
  model: string;
  /** Any OpenAI-compatible endpoint. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const aiEnabled = (o: AiOptions | undefined): o is AiOptions & { apiKey: string } => !!o?.apiKey;

async function chatJson<T>(o: AiOptions, name: string, schema: object, system: string, user: string): Promise<T> {
  const f = o.fetch ?? fetch;
  const res = await f(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
    signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    body: JSON.stringify({
      model: o.model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
    }),
  });
  if (!res.ok) {
    // Never echo the request (it carries the key); the status and the API's message are enough.
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`AI request failed (${res.status}): ${body.error?.message ?? res.statusText}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`AI gave no answer${data.choices?.[0]?.message?.refusal ? `: ${data.choices[0].message.refusal}` : ""}`);
  return JSON.parse(content) as T;
}

const str = { type: ["string", "null"] };
const num = { type: ["number", "null"] };

// ---------- Metadata ----------

export interface AiMetaInput {
  fileName: string;
  format: string;
  embedded: Record<string, unknown>;
  sampleText: string | null;
}

export interface AiMeta {
  title: string | null;
  subtitle: string | null;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  publisher: string | null;
  year: string | null;
  language: string | null;
  isbn: string | null;
  confidence: "high" | "medium" | "low";
}

const META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "authors", "series", "seriesIndex", "publisher", "year", "language", "isbn", "confidence"],
  properties: {
    title: str,
    subtitle: str,
    authors: { type: "array", items: { type: "string" } },
    series: str,
    seriesIndex: num,
    publisher: str,
    year: str,
    language: { type: ["string", "null"], description: "ISO 639-1 code, e.g. en" },
    isbn: str,
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

const META_SYSTEM = `You identify books for a personal library catalogue.
You get a file name, the metadata embedded in the file (often missing, wrong or junk such as "Microsoft Word - draft.docx" or "untitled"), and text from the book's opening pages.
Return the book's real bibliographic details in clean form:
- title: the real title in normal title case, without the subtitle, edition notes, file extensions, underscores or author names.
- subtitle: only if the book has one.
- authors: personal names in "First Last" order; no roles like "editor"; empty if unknown.
- series and seriesIndex only if the book clearly belongs to a numbered series.
- year: four-digit year of publication if stated.
- isbn: only an ISBN that literally appears in the provided text; otherwise null. Never invent one.
- confidence: "high" when the title page or copyright page confirms it, "low" when you are guessing from the file name alone.
Use null for anything you cannot tell.`;

/** Asks the AI for clean metadata. Returns null when the feature is off. */
export async function aiMetadata(o: AiOptions | undefined, input: AiMetaInput): Promise<AiMeta | null> {
  if (!aiEnabled(o)) return null;
  const user = [
    `File name: ${input.fileName}`,
    `Format: ${input.format}`,
    `Embedded metadata: ${JSON.stringify(input.embedded)}`,
    `Opening pages:\n"""\n${(input.sampleText ?? "(no text available)").slice(0, 8000)}\n"""`,
  ].join("\n\n");
  const out = await chatJson<AiMeta>(o, "book_metadata", META_SCHEMA, META_SYSTEM, user);
  // Guard against an invented ISBN: it must be valid and present in the text we sent.
  if (out.isbn) {
    const isbn = parseIsbn(out.isbn);
    const digits = (input.sampleText ?? "").replace(/[^0-9Xx]/g, "");
    out.isbn = isbn && (digits.includes(isbn.isbn13) || (isbn.isbn10 && digits.includes(isbn.isbn10))) ? isbn.isbn13 : null;
  }
  return out;
}

// ---------- Shelf sorting ----------

export interface SortInput {
  shelves: { id: string; name: string; examples: string[] }[];
  books: { id: string; title: string; author: string | null; subjects: string[]; description: string | null }[];
  /** Shelf names already suggested or dismissed, which shouldn't come back. */
  avoidNames: string[];
}

export interface SortResult {
  assignments: { bookId: string; shelfIds: string[] }[];
  newShelves: { name: string; reason: string; bookIds: string[] }[];
}

const SORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assignments", "newShelves"],
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bookId", "shelfIds"],
        properties: { bookId: { type: "string" }, shelfIds: { type: "array", items: { type: "string" } } },
      },
    },
    newShelves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason", "bookIds"],
        properties: { name: { type: "string" }, reason: { type: "string" }, bookIds: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const SORT_SYSTEM = `You organise a personal library into themed shelves.
You get the existing shelves (with a few example books on each) and some books to place.
- assignments: for each book, the ids of the existing shelves it clearly belongs on (usually one, at most two). Use an empty list if none fits well. Only use shelf ids from the list.
- newShelves: when two or more books share a theme that no existing shelf covers, suggest a new shelf: a short, natural name (1 to 4 words, like "Probability & statistics" or "Japanese fiction"), a one-sentence reason, and the ids of the books for it. A single book may get a new shelf only if there are no shelves at all. Don't suggest names that duplicate or nearly duplicate an existing shelf or a name in the avoid list.`;

export async function aiSortShelves(o: AiOptions | undefined, input: SortInput): Promise<SortResult | null> {
  if (!aiEnabled(o) || !input.books.length) return null;
  const user = JSON.stringify({
    shelves: input.shelves,
    avoid: input.avoidNames,
    books: input.books.map((b) => ({ ...b, description: b.description?.slice(0, 400) ?? null, subjects: b.subjects.slice(0, 8) })),
  });
  const out = await chatJson<SortResult>(o, "shelf_sorting", SORT_SCHEMA, SORT_SYSTEM, user);
  const shelfIds = new Set(input.shelves.map((s) => s.id));
  const bookIds = new Set(input.books.map((b) => b.id));
  return {
    assignments: out.assignments
      .filter((a) => bookIds.has(a.bookId))
      .map((a) => ({ bookId: a.bookId, shelfIds: [...new Set(a.shelfIds.filter((s) => shelfIds.has(s)))].slice(0, 2) })),
    newShelves: out.newShelves
      .map((n) => ({ name: n.name.trim().slice(0, 60), reason: n.reason.trim().slice(0, 200), bookIds: [...new Set(n.bookIds.filter((b) => bookIds.has(b)))] }))
      .filter((n) => n.name && n.bookIds.length),
  };
}
