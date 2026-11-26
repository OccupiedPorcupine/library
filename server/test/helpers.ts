/** Shared test helpers (not a test file itself). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { Config } from "../src/config.js";

export function testConfig(): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-test-"));
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    dbPath: path.join(dir, "library.db"),
    webDist: path.join(dir, "no-web"),
    metadataOnline: false,
    googleBooksApiKey: undefined,
    openai: { apiKey: undefined, model: "test-model", baseUrl: "https://ai.test/v1" },
    aiAutoShelve: true,
    maxUploadBytes: 50 * 1024 * 1024,
    storage: { driver: "local", localPath: path.join(dir, "books"), s3: {} as Config["storage"]["s3"] },
  };
}

export async function epub(title: string, author: string, extra = ""): Promise<Buffer> {
  const z = new JSZip();
  z.file("mimetype", "application/epub+zip", { compression: "STORE" });
  z.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  z.file("content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>${extra}</metadata><manifest/><spine/></package>`);
  return z.generateAsync({ type: "nodebuffer" });
}
