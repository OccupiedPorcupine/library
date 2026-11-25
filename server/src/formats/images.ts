const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export function imageType(name: string): { ext: string; contentType: string } | null {
  const m = /\.[a-z0-9]+$/i.exec(name);
  if (!m) return null;
  const ext = m[0].toLowerCase();
  const contentType = TYPES[ext];
  return contentType ? { ext: ext.slice(1), contentType } : null;
}
