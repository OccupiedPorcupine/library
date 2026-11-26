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

/** Reads pixel width/height from a JPEG, PNG, GIF or WebP header without decoding it. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("latin1", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** Sniffs the image type from magic bytes (for downloaded covers with no useful file name). */
export function sniffImage(b: Buffer): { ext: string; contentType: string } | null {
  if (b[0] === 0xff && b[1] === 0xd8) return { ext: "jpg", contentType: "image/jpeg" };
  if (b.length > 4 && b.readUInt32BE(0) === 0x89504e47) return { ext: "png", contentType: "image/png" };
  if (b.toString("latin1", 0, 3) === "GIF") return { ext: "gif", contentType: "image/gif" };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", contentType: "image/webp" };
  return null;
}
