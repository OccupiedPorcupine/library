import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { Config } from "../config.js";
import type { ByteRange, Storage, StoredObject } from "./types.js";

/** Any S3-compatible endpoint: MinIO, Garage, SeaweedFS, AWS. */
export class S3Storage implements Storage {
  readonly name = "s3";
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(cfg: Config["storage"]["s3"]) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix ? cfg.prefix.replace(/\/?$/, "/") : "";
  }

  private k(key: string) {
    return this.prefix + key;
  }

  async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType }),
    );
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    let size = res.ContentLength ?? 0;
    const cr = res.ContentRange?.split("/")[1];
    if (cr && cr !== "*") size = Number(cr);
    return { stream: res.Body as Readable, size, contentType: res.ContentType };
  }

  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }

  async *list(prefix = ""): AsyncIterable<{ key: string; size: number }> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.k(prefix), ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) yield { key: o.Key.slice(this.prefix.length), size: o.Size ?? 0 };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }
}
