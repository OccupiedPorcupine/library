/**
 * Free online metadata sources: Open Library (no key) and Google Books (key optional).
 * Each lookup returns normalized fields plus how it matched, so callers can judge confidence.
 */
import type { TocEntry } from "../formats/index.js";
import { parseIsbn } from "./isbn.js";

export type OnlineSource = "openlibrary" | "googlebooks";

export interface OnlineMeta {
  source: OnlineSource;
  /** "isbn" is a near-certain match; "title" was matched by title (and author when known). */
  matchedBy: "isbn" | "title";
  title?: string;
  subtitle?: string;
  author?: string;
  series?: string;
  description?: string;
  publisher?: string;
  published?: string;
  pageCount?: number;
  language?: string;
  isbn10?: string | null;
  isbn13?: string;
  subjects?: string[];
  toc?: TocEntry[];
  /** Best first; later ones are fallbacks if a download fails or is a placeholder. */
  coverUrls?: string[];
}

export interface LookupQuery {
  isbn13?: string | null;
  title?: string | null;
  author?: string | null;
}

export interface OnlineOptions {
  fetch?: typeof fetch;
  googleBooksKey?: string;
  timeoutMs?: number;
}

// A generic client name: no personal details go to outside services.
const USER_AGENT = "library-selfhosted/0.1 (personal book library)";

async function getJson<T>(url: string, opts: OnlineOptions): Promise<T | null> {
  const f = opts.fetch ?? fetch;
  const res = await f(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Lowercase, no accents or punctuation, no leading article. */
export function normTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[:;(\[].*$/, "") // drop subtitles and bracketed edition notes
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

const surnames = (s: string) =>
  new Set(
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/\s*(?:,|&|\band\b|;)\s*/)
      .map((n) => n.trim().split(/\s+/).pop() ?? "")
      .filter((n) => n.length > 1 && n !== "al" && n !== "et"),
  );

/** True when a title search hit plausibly is the same book. */
export function isSameBook(q: LookupQuery, title: string | undefined, authors: string[] | undefined): boolean {
  if (!q.title || !title) return false;
  const a = normTitle(q.title);
  const b = normTitle(title);
  if (!a || !b || (a !== b && !(a.startsWith(b) && b.length >= 6) && !(b.startsWith(a) && a.length >= 6))) return false;
  if (!q.author || !authors?.length) return true;
  const want = surnames(q.author);
  const got = surnames(authors.join(", "));
  return [...want].some((n) => got.has(n));
}

const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim() : undefined);
const stripHtml = (s: string | undefined) =>
  s ? clean(s.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")) : undefined;
const uniq = (xs: (string | undefined)[], max = 15) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const v = clean(x);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, max);
};

// ---------- Open Library ----------

interface OlSearch {
  docs: {
    key: string;
    title?: string;
    subtitle?: string;
    author_name?: string[];
    first_publish_year?: number;
    publisher?: string[];
    number_of_pages_median?: number;
    language?: string[];
    subject?: string[];
    cover_i?: number;
    isbn?: string[];
  }[];
}
interface OlWork {
  description?: string | { value: string };
  subjects?: string[];
}
interface OlEdition {
  title?: string;
  subtitle?: string;
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  covers?: number[];
  series?: string[];
  languages?: { key: string }[];
  table_of_contents?: { title?: string; level?: number; pagenum?: string }[];
  description?: string | { value: string };
}

const OL_FIELDS = "key,title,subtitle,author_name,first_publish_year,publisher,number_of_pages_median,language,subject,cover_i,isbn";
/** ISO 639-2 codes Open Library uses, mapped to the short codes books use. */
const LANG3: Record<string, string> = { eng: "en", fre: "fr", ger: "de", spa: "es", ita: "it", por: "pt", dut: "nl", jpn: "ja", chi: "zh", rus: "ru", kor: "ko", swe: "sv", dan: "da", nor: "no", fin: "fi", pol: "pl", tur: "tr", ara: "ar", heb: "he", gre: "el", lat: "la", may: "ms", ind: "id" };
const lang3 = (code: string | undefined) => (code ? (LANG3[code] ?? code) : undefined);
const olText = (d: OlWork["description"]) => clean(typeof d === "string" ? d : d?.value)?.replace(/\s*\(\[source\]\[\d+\]\)[\s\S]*$/, "");

export async function openLibrary(q: LookupQuery, opts: OnlineOptions = {}): Promise<OnlineMeta | null> {
  const base = "https://openlibrary.org";
  let matchedBy: OnlineMeta["matchedBy"] = "isbn";
  let search: OlSearch | null = null;
  if (q.isbn13) search = await getJson<OlSearch>(`${base}/search.json?isbn=${q.isbn13}&fields=${OL_FIELDS}&limit=1`, opts);
  if (!search?.docs.length) {
    if (!q.title) return null;
    matchedBy = "title";
    const params = new URLSearchParams({ title: q.title, fields: OL_FIELDS, limit: "5" });
    if (q.author) params.set("author", q.author);
    search = await getJson<OlSearch>(`${base}/search.json?${params}`, opts);
  }
  const doc = search?.docs.find((d) => matchedBy === "isbn" || isSameBook(q, d.title, d.author_name));
  if (!doc) return null;

  const out: OnlineMeta = {
    source: "openlibrary",
    matchedBy,
    title: clean(doc.title),
    subtitle: clean(doc.subtitle),
    author: doc.author_name?.length ? uniq(doc.author_name).join(", ") : undefined,
    publisher: clean(doc.publisher?.[0]),
    published: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
    pageCount: doc.number_of_pages_median,
    language: lang3(doc.language?.[0]),
    subjects: doc.subject?.length ? uniq(doc.subject) : undefined,
    coverUrls: doc.cover_i ? [`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg?default=false`] : undefined,
  };
  const isbn = parseIsbn(q.isbn13 ?? doc.isbn?.find((i) => parseIsbn(i)));
  if (isbn) Object.assign(out, isbn);

  const work = await getJson<OlWork>(`${base}${doc.key}.json`, opts).catch(() => null);
  out.description = olText(work?.description);
  if (!out.subjects && work?.subjects?.length) out.subjects = uniq(work.subjects);

  // The exact edition has the publisher, page count, series and sometimes a contents list.
  if (matchedBy === "isbn" && q.isbn13) {
    const ed = await getJson<OlEdition>(`${base}/isbn/${q.isbn13}.json`, opts).catch(() => null);
    if (ed) {
      out.subtitle ??= clean(ed.subtitle);
      out.publisher = clean(ed.publishers?.[0]) ?? out.publisher;
      out.pageCount = ed.number_of_pages ?? out.pageCount;
      out.language = lang3(ed.languages?.[0]?.key.split("/").pop()) ?? out.language;
      out.series = clean(ed.series?.[0]?.replace(/\s*[;,]?\s*(no\.|v\.|#)\s*\d+.*$/i, ""));
      out.description ??= olText(ed.description);
      if (ed.covers?.[0] && ed.covers[0] > 0)
        out.coverUrls = [`https://covers.openlibrary.org/b/id/${ed.covers[0]}-L.jpg?default=false`, ...(out.coverUrls ?? [])];
      const toc = (ed.table_of_contents ?? [])
        .map((t) => ({ title: clean(t.title) ?? "", level: t.level ?? 0, page: Number(t.pagenum) || undefined }))
        .filter((t) => t.title);
      if (toc.length) out.toc = toc;
    }
  }
  return out;
}

// ---------- Google Books ----------

interface GbVolumes {
  items?: {
    volumeInfo: {
      title?: string;
      subtitle?: string;
      authors?: string[];
      publisher?: string;
      publishedDate?: string;
      description?: string;
      industryIdentifiers?: { type: string; identifier: string }[];
      pageCount?: number;
      categories?: string[];
      language?: string;
      imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    };
  }[];
}

const https = (u: string) => u.replace(/^http:/, "https:");

export async function googleBooks(q: LookupQuery, opts: OnlineOptions = {}): Promise<OnlineMeta | null> {
  const key = opts.googleBooksKey ? `&key=${encodeURIComponent(opts.googleBooksKey)}` : "";
  const base = "https://www.googleapis.com/books/v1/volumes";
  let matchedBy: OnlineMeta["matchedBy"] = "isbn";
  let res: GbVolumes | null = null;
  if (q.isbn13) res = await getJson<GbVolumes>(`${base}?q=isbn:${q.isbn13}&maxResults=1${key}`, opts);
  if (!res?.items?.length) {
    if (!q.title) return null;
    matchedBy = "title";
    const terms = [`intitle:${q.title}`, q.author ? `inauthor:${q.author.split(/,|&| and /)[0]!.trim()}` : ""].filter(Boolean).join(" ");
    res = await getJson<GbVolumes>(`${base}?q=${encodeURIComponent(terms)}&maxResults=5&printType=books${key}`, opts);
  }
  const item = res?.items?.find((i) => matchedBy === "isbn" || isSameBook(q, i.volumeInfo.title, i.volumeInfo.authors));
  if (!item) return null;
  const v = item.volumeInfo;
  const ids = v.industryIdentifiers ?? [];
  const isbn = parseIsbn(q.isbn13 ?? ids.find((i) => i.type === "ISBN_13")?.identifier ?? ids.find((i) => i.type === "ISBN_10")?.identifier);
  // Thumbnails are tiny; asking for zoom=0 without the page-curl gives the largest image Google has.
  const thumb = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail;
  return {
    source: "googlebooks",
    matchedBy,
    title: clean(v.title),
    subtitle: clean(v.subtitle),
    author: v.authors?.length ? uniq(v.authors).join(", ") : undefined,
    publisher: clean(v.publisher),
    published: clean(v.publishedDate),
    description: stripHtml(v.description),
    pageCount: v.pageCount || undefined,
    language: clean(v.language),
    subjects: v.categories?.length ? uniq(v.categories.flatMap((c) => c.split(/\s*\/\s*/))) : undefined,
    coverUrls: thumb
      ? [...new Set([https(thumb).replace(/&edge=curl/, "").replace(/zoom=\d/, "zoom=0"), https(thumb).replace(/&edge=curl/, "")])]
      : undefined,
    ...(isbn ?? {}),
  };
}
