/**
 * Fills an empty library with demo books (tiny generated EPUBs) on themed shelves,
 * so the shelf UI can be tried without uploading anything. Run: npm run seed --workspace server
 */
import JSZip from "jszip";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const SHELVES: Record<string, [string, string][]> = {
  "Probability & statistics": [
    ["Probability Theory", "E. T. Jaynes"],
    ["Statistical Inference", "Casella & Berger"],
    ["Bayesian Data Analysis", "Gelman et al."],
    ["All of Statistics", "Larry Wasserman"],
    ["Stochastic Processes", "Sheldon Ross"],
    ["Introduction to Probability", "Blitzstein & Hwang"],
    ["Monte Carlo Methods", "Robert & Casella"],
    ["Time Series Analysis", "Hamilton"],
    ["Regression and Other Stories", "Gelman, Hill & Vehtari"],
  ],
  "Fiction": [
    ["The Left Hand of Darkness", "Ursula K. Le Guin"],
    ["Piranesi", "Susanna Clarke"],
    ["Invisible Cities", "Italo Calvino"],
    ["The Remains of the Day", "Kazuo Ishiguro"],
    ["Stoner", "John Williams"],
    ["Solaris", "Stanisław Lem"],
    ["Klara and the Sun", "Kazuo Ishiguro"],
  ],
  "Design & craft": [
    ["The Design of Everyday Things", "Don Norman"],
    ["Thinking with Type", "Ellen Lupton"],
    ["A Pattern Language", "Christopher Alexander"],
    ["The Elements of Typographic Style", "Robert Bringhurst"],
    ["Grid Systems", "Josef Müller-Brockmann"],
    ["Interaction of Color", "Josef Albers"],
  ],
};

async function makeEpub(title: string, author: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${encodeURIComponent(title)}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author.replace(/&/g, "&amp;")}</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file("OEBPS/c1.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${title}</h1><p>Demo book.</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const { app, library } = await buildApp(config, { logger: false });
if (library.overview().shelves.length > 0) {
  console.log("Library already has shelves, not seeding.");
} else {
  let i = 0;
  for (const [name, books] of Object.entries(SHELVES)) {
    const shelf = library.createShelf(name);
    for (const [title, author] of books) {
      const { book } = await library.addBook(`${title}.epub`, await makeEpub(title, author), shelf.id);
      // Spread out reading progress so the "lights up as you read" effect is visible.
      const p = [0, 0.15, 0.4, 0.7, 1, 0, 0.55, 0.9][i++ % 8]!;
      if (p) library.setProgress(book.id, p);
    }
  }
  console.log("Seeded demo library.");
}
await app.close();
