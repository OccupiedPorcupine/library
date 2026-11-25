# Performance budget

## Goal
The app should feel instant: quick to open, snappy to scroll, and smooth on iPhone. Performance is a feature, with budgets that CI enforces.

## Budgets (on the tailnet, mid-range iPhone)
- Home shelf view interactive in under **1.5 s** cold, under **0.5 s** warm (service worker cache).
- Largest Contentful Paint under 1.5 s, Interaction to Next Paint under 100 ms, no layout shift (CLS < 0.05).
- **60 fps** while swiping a shelf or scrolling between shelves, including with 1000+ books.
- Initial JavaScript for the shelf page under **120 KB gzipped**. Reader engines (foliate-js, pdf.js) load only when a book opens.
- Opening a book shows the first page in under 1 s for EPUB, under 1.5 s for a large PDF.

## How
- **Rendering:** animate only `transform` and `opacity`, GPU-friendly 3D transforms, `will-change` only while animating. No heavy `backdrop-filter` blurs or large box-shadows on many elements; shadows on shelves, not on every book.
- **Virtualise** both directions: only shelves near the viewport are mounted, and only books near the visible part of each shelf. `content-visibility: auto` on off-screen shelves.
- **Spines are CSS, not images:** title/author/colour drawn with text and gradients, so a shelf of 50 books needs no image downloads. Only the featured/pulled-out book loads a cover.
- **Reflections:** cheap version only (mirrored, masked copy for the few visible books, or a single gradient), and dropped automatically on low-power devices.
- **Covers:** generated server-side at import (#3) in a few sizes as AVIF/WebP, with dominant colour stored for instant placeholders and spine colour. Served with long-lived immutable cache headers. Lazy-loaded with `loading="lazy"` / IntersectionObserver.
- **Data:** one API call returns everything the home page needs (shelves + first N books each, compact JSON). Further books load as you scroll. Prefetch book metadata and the reader chunk on hover/press.
- **Caching:** service worker caches the app shell and recent covers (ties in with #13). HTTP/2 and Brotli compression.
- **Server:** book files streamed with range requests; SQLite queries indexed; responses under 50 ms for library endpoints.
- **Measure:** Lighthouse CI and a bundle-size check in GitHub Actions that fail when a budget is broken. A simple dev overlay showing fps and render counts.

## Acceptance criteria
- [ ] Lighthouse performance score 95+ on the home page (mobile profile).
- [ ] Bundle size check in CI fails on budget overrun.
- [ ] Scrolling a 1000-book library on an iPhone stays at 60 fps in Safari's timeline.
- [ ] `prefers-reduced-motion` and a "low power" setting turn off reflections and 3D tilts.

