import path from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required env var ${name}`);
    return fallback;
  }
  return v;
}

const dataDir = path.resolve(env("DATA_DIR", "./data"));

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  dataDir,
  dbPath: path.join(dataDir, "library.db"),
  /** Built web app to serve in production. */
  webDist: path.resolve(env("WEB_DIST", path.join(import.meta.dirname, "../../web/dist"))),
  maxUploadBytes: Number(env("MAX_UPLOAD_MB", "1024")) * 1024 * 1024,
  storage: {
    driver: env("STORAGE_DRIVER", "local") as "local" | "s3",
    localPath: path.resolve(env("LOCAL_STORAGE_PATH", path.join(dataDir, "books"))),
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: env("S3_REGION", "us-east-1"),
      bucket: env("S3_BUCKET", "library"),
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      forcePathStyle: env("S3_FORCE_PATH_STYLE", "true") === "true",
      prefix: process.env.S3_PREFIX ?? "",
    },
  },
};

export type Config = typeof config;
