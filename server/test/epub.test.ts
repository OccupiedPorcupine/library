import JSZip from "jszip";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEpub } from "../src/formats/epub.js";
async function mk(v3: boolean) {
  const z = new JSZip();
  z.file("mimetype", "application/epub+zip");
  z.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  z.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:identifier opf:scheme="ISBN">978-1-63557-563-7</dc:identifier><dc:title id="t1">Piranesi</dc:title><dc:title id="t2">A Novel</dc:title>
  <meta refines="#t1" property="title-type">main</meta><meta refines="#t2" property="title-type">subtitle</meta>
  <dc:creator opf:role="aut">Susanna Clarke</dc:creator><dc:creator opf:role="ill">Someone</dc:creator>
  <dc:description>&lt;p&gt;A &lt;b&gt;house&lt;/b&gt; of halls.&lt;/p&gt;</dc:description><dc:publisher>Bloomsbury</dc:publisher><dc:date>2020-09-15T00:00:00Z</dc:date><dc:language>en</dc:language>
  <dc:subject>Fantasy</dc:subject><dc:subject>Fiction</dc:subject>
  <meta name="calibre:series" content="Halls"/><meta name="calibre:series_index" content="1"/>
  </metadata><manifest>${v3 ? `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` : ""}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/></spine></package>`);
  z.file("OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks"><ol><li><a href="x.xhtml">Cover</a></li></ol></nav><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="text/c1.xhtml"><span>Part 1</span> Piranesi</a><ol><li><a href="text/c1.xhtml#s1">Entry for the First Day</a></li><li><a href="text/c1.xhtml#s2">Second</a></li></ol></li><li><a href="text/c2.xhtml">Part 2</a></li></ol></nav></body></html>`);
  z.file("OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="a"><navLabel><text>NCX One</text></navLabel><content src="text/c1.xhtml"/><navPoint id="b"><navLabel><text>NCX Sub</text></navLabel><content src="text/c1.xhtml#x"/></navPoint></navPoint><navPoint id="c"><navLabel><text>NCX Two</text></navLabel><content src="text/c2.xhtml"/></navPoint></navMap></ncx>`);
  return z.generateAsync({ type: "nodebuffer" });
}
test("EPUB 3: reads full metadata and the nav table of contents", async () => {
  const m = await extractEpub(await mk(true));
  assert.equal(m.title, "Piranesi");
  assert.equal(m.subtitle, "A Novel");
  assert.equal(m.author, "Susanna Clarke");
  assert.equal(m.isbn13, "9781635575637");
  assert.equal(m.isbn10, "163557563X");
  assert.equal(m.description, "A house of halls.");
  assert.equal(m.publisher, "Bloomsbury");
  assert.equal(m.published, "2020-09-15");
  assert.equal(m.language, "en");
  assert.deepEqual(m.subjects, ["Fantasy", "Fiction"]);
  assert.equal(m.series, "Halls");
  assert.equal(m.seriesIndex, 1);
  assert.deepEqual(m.toc, [
    { title: "Part 1 Piranesi", level: 0, href: "OEBPS/text/c1.xhtml" },
    { title: "Entry for the First Day", level: 1, href: "OEBPS/text/c1.xhtml#s1" },
    { title: "Second", level: 1, href: "OEBPS/text/c1.xhtml#s2" },
    { title: "Part 2", level: 0, href: "OEBPS/text/c2.xhtml" },
  ]);
});

test("EPUB 2: falls back to the NCX table of contents", async () => {
  const m = await extractEpub(await mk(false));
  assert.deepEqual(
    m.toc?.map((t) => [t.title, t.level]),
    [["NCX One", 0], ["NCX Sub", 1], ["NCX Two", 0]],
  );
});

test("EPUB page count: the printed page list when there is one, else an estimate from the text", async () => {
  const z = await JSZip.loadAsync(await mk(true));
  z.file("OEBPS/text/c1.xhtml", `<html><body><p>${"word ".repeat(1800)}</p></body></html>`);
  const est = await extractEpub(await z.generateAsync({ type: "nodebuffer" }));
  assert.equal(est.pageCount, 5);
  assert.equal(est.pageCountEstimated, true);

  const nav = (await z.file("OEBPS/nav.xhtml")!.async("string")).replace(
    "</body>",
    `<nav epub:type="page-list"><ol>${Array.from({ length: 12 }, (_, i) => `<li><a href="text/c1.xhtml#p${i + 1}">${i + 1}</a></li>`).join("")}</ol></nav></body>`,
  );
  z.file("OEBPS/nav.xhtml", nav);
  const printed = await extractEpub(await z.generateAsync({ type: "nodebuffer" }));
  assert.equal(printed.pageCount, 12);
  assert.equal(printed.pageCountEstimated, false);
});
