/** ISBN helpers: clean up, validate and convert between ISBN-10 and ISBN-13. */

const digits = (s: string) => s.replace(/[^0-9Xx]/g, "").toUpperCase();

export function isValidIsbn10(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

export function isValidIsbn13(s: string): boolean {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

export function isbn10to13(s: string): string {
  const core = `978${s.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

export function isbn13to10(s: string): string | null {
  if (!s.startsWith("978")) return null;
  const core = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? "X" : String(check));
}

/** Returns both forms of a valid ISBN found in the string, or null. */
export function parseIsbn(raw: string | undefined | null): { isbn10: string | null; isbn13: string } | null {
  if (!raw) return null;
  const d = digits(raw.replace(/^(urn:)?isbn:?/i, ""));
  if (isValidIsbn13(d)) return { isbn13: d, isbn10: isbn13to10(d) };
  if (isValidIsbn10(d)) return { isbn10: d, isbn13: isbn10to13(d) };
  return null;
}

/** Finds the first valid ISBN in free text, e.g. a PDF copyright page. */
export function findIsbn(textBody: string): { isbn10: string | null; isbn13: string } | null {
  const re = /ISBN(?:-1[03])?[:\s]*((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])/gi;
  for (const m of textBody.matchAll(re)) {
    const hit = parseIsbn(m[1]);
    if (hit) return hit;
  }
  return null;
}
