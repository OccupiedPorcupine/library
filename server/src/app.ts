import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { CONTENT_TYPES } from "./formats/index.js";
import { HttpError, Library, type MetadataPatch } from "./library.js";
import { createStorage, type Storage } from "./storage/index.js";

export async function buildApp(
  config: Config,
  opts: { storage?: Storage; logger?: boolean; fetch?: typeof fetch; background?: boolean } = {},
) {
  const app = Fastify({ logger: opts.logger ?? true });
  const storage = opts.storage ?? createStorage(config.storage);
  await storage.check();
  const db = openDb(config.dbPath);
  const library = new Library(db, storage, {
    online: config.metadataOnline,
    onlineOptions: { googleBooksKey: config.googleBooksApiKey, fetch: opts.fetch },
    ai: { ...config.openai, fetch: opts.fetch },
    aiAutoShelve: config.aiAutoShelve,
    background: opts.background,
    log: (msg, err) => app.log.warn({ err }, msg),
  });
  app.addHook("onClose", async () => {
    library.close();
    db.close();
  });
  app.addHook("onReady", async () => void library.resumeQueue().catch((e) => app.log.error(e)));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: err.message });
  });

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50 } });

  app.get("/api/health", async () => ({ ok: true, storage: storage.name }));

  app.get("/api/library", async () => library.overview());

  app.post("/api/library/scan", async () => library.scan());

  // Upload one or more files. Optional ?shelf=<id> puts them straight onto a shelf.
  app.post<{ Querystring: { shelf?: string } }>("/api/books", async (req) => {
    const results = [];
    for await (const part of req.files()) {
      const data = await part.toBuffer();
      try {
        results.push({ file: part.filename, ...(await library.addBook(part.filename, data, req.query.shelf)) });
      } catch (e) {
        results.push({ file: part.filename, error: (e as Error).message });
      }
    }
    return { results };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id", async (req) => {
    return library.getDetail(req.params.id);
  });

  // Manual edits; edited fields are never overwritten by online lookups.
  app.patch<{ Params: { id: string }; Body: MetadataPatch }>(
    "/api/books/:id/metadata",
    { schema: { body: { type: "object" } } },
    async (req) => library.updateMetadata(req.params.id, req.body),
  );

  // Look the book up on Open Library / Google Books now.
  // Runs the AI pass again first (when set up), so the online search uses its cleaned title.
  app.post<{ Params: { id: string } }>("/api/books/:id/metadata/refresh", async (req) => {
    await library.aiPass(req.params.id, true).catch((e: Error) => app.log.warn({ err: e }, "AI metadata failed"));
    return library.refreshMetadata(req.params.id);
  });

  // AI shelf sorting: places unshelved books and suggests new shelves.
  app.post("/api/library/sort", async () => library.sortBooks());

  app.post<{ Params: { id: string }; Body: { name?: string } }>("/api/shelf-suggestions/:id/accept", async (req, reply) =>
    reply.status(201).send(library.acceptSuggestion(req.params.id, req.body?.name)),
  );

  app.delete<{ Params: { id: string } }>("/api/shelf-suggestions/:id", async (req, reply) => {
    library.dismissSuggestion(req.params.id);
    reply.status(204).send();
  });

  // Replace the cover with an uploaded image.
  app.put<{ Params: { id: string } }>("/api/books/:id/cover", async (req) => {
    const part = await req.file();
    if (!part) throw new HttpError(400, "No image uploaded");
    return library.setUserCover(req.params.id, await part.toBuffer());
  });

  app.delete<{ Params: { id: string } }>("/api/books/:id", async (req, reply) => {
    await library.deleteBook(req.params.id);
    reply.status(204).send();
  });

  // Streams the book file with HTTP range support (needed by pdf.js and for big files).
  app.get<{ Params: { id: string } }>("/api/books/:id/file", async (req, reply) => {
    const book = library.getBook(req.params.id);
    const type = CONTENT_TYPES[book.format];
    const total = book.file_size;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", type);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(book.file_name)}`);
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : total - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : total - 1;
      start = Math.max(0, start);
      end = Math.min(end, total - 1);
      if (start > end) {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.status(416).send();
      }
      const obj = await storage.get(book.file_key, { start, end });
      reply.status(206).header("Content-Range", `bytes ${start}-${end}/${total}`).header("Content-Length", end - start + 1);
      return reply.send(obj.stream);
    }
    const obj = await storage.get(book.file_key);
    reply.header("Content-Length", total);
    return reply.send(obj.stream);
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/cover", async (req, reply) => {
    const book = library.getBook(req.params.id);
    if (!book.cover_key) throw new HttpError(404, "No cover");
    const obj = await storage.get(book.cover_key);
    const ext = book.cover_key.split(".").pop();
    reply.header("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
    // URL carries ?v=updated_at, so it can be cached forever.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(obj.stream);
  });

  app.put<{ Params: { id: string }; Body: { progress: number } }>(
    "/api/books/:id/progress",
    { schema: { body: { type: "object", required: ["progress"], properties: { progress: { type: "number" } } } } },
    async (req) => library.setProgress(req.params.id, req.body.progress),
  );

  app.put<{ Params: { id: string }; Body: { shelfIds: string[] } }>(
    "/api/books/:id/shelves",
    {
      schema: {
        body: {
          type: "object",
          required: ["shelfIds"],
          properties: { shelfIds: { type: "array", items: { type: "string" } } },
        },
      },
    },
    async (req) => {
      library.setBookShelves(req.params.id, req.body.shelfIds);
      return { ok: true };
    },
  );

  app.post<{ Body: { name: string } }>(
    "/api/shelves",
    { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } } } },
    async (req, reply) => reply.status(201).send(library.createShelf(req.body.name)),
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; position?: number } }>("/api/shelves/:id", async (req) => {
    library.updateShelf(req.params.id, req.body ?? {});
    return { ok: true };
  });

  app.put<{ Body: { ids: string[] } }>(
    "/api/shelves/order",
    { schema: { body: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } } } },
    async (req) => {
      library.reorderShelves(req.body.ids);
      return { ok: true };
    },
  );

  // Move (or with no "from", add) books to a shelf. A null "to" takes them off "from".
  app.post<{ Body: { bookIds: string[]; to: string | null; from?: string | null } }>(
    "/api/books/move",
    {
      schema: {
        body: {
          type: "object",
          required: ["bookIds", "to"],
          properties: {
            bookIds: { type: "array", items: { type: "string" }, minItems: 1 },
            to: { type: ["string", "null"] },
            from: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req) => {
      library.moveBooks(req.body.bookIds, req.body.to, req.body.from ?? null);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/shelves/:id", async (req, reply) => {
    library.deleteShelf(req.params.id);
    reply.status(204).send();
  });

  // Production: serve the built web app, with SPA fallback.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${"/"}assets${"/"}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/assets/")) return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, library, storage, db };
}
