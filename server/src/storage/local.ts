import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ByteRange, Storage, StoredObject } from "./types.js";

/** Stores files in a folder: a local disk or a mounted NAS share (NFS/SMB). */
export class LocalStorage implements Storage {
  readonly name = "local";
  constructor(private root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Key escapes storage root: ${key}`);
    }
    return full;
  }

  async check(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.write-test-${process.pid}`);
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, full);
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject> {
    const full = this.resolve(key);
    const { size } = await fsp.stat(full);
    const stream = fs.createReadStream(full, range ? { start: range.start, end: range.end } : undefined);
    return { stream, size };
  }

  async head(key: string) {
    try {
      const { size } = await fsp.stat(this.resolve(key));
      return { size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async *list(prefix = ""): AsyncIterable<{ key: string; size: number }> {
    const start = this.resolve(prefix || ".");
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(start, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const key = path.posix.join(prefix, e.name);
      if (e.isDirectory()) yield* this.list(key);
      else if (e.isFile()) yield { key, size: (await fsp.stat(this.resolve(key))).size };
    }
  }
}
