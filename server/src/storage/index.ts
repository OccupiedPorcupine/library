import type { Config } from "../config.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { Storage } from "./types.js";

export type { Storage, ByteRange, StoredObject } from "./types.js";

export function createStorage(cfg: Config["storage"]): Storage {
  switch (cfg.driver) {
    case "local":
      return new LocalStorage(cfg.localPath);
    case "s3":
      return new S3Storage(cfg.s3);
    default:
      throw new Error(`Unknown STORAGE_DRIVER "${cfg.driver as string}" (use "local" or "s3")`);
  }
}
