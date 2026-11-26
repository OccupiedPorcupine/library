/*
 * Service worker: keeps the app shell (built scripts, styles, icons and the page itself) so
 * the installed app starts fast and opens without a connection. Groundwork for offline
 * reading (#13).
 *
 * The site sits behind a login. Only plain 200 responses from this site are ever stored, so
 * a redirect to the login page, or the login page itself, never ends up in the cache. API
 * calls and book files always go to the network.
 */
const VERSION = "v1";
const SHELL = `library-shell-${VERSION}`;
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => Promise.all(PRECACHE.map((url) => fetch(url, { credentials: "include" }).then((res) => keep(cache, url, res)).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("library-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Stores a response only if it's a real page or file from this site, never a redirect or a login page. */
function keep(cache, key, res) {
  if (res && res.ok && res.status === 200 && res.type === "basic" && !res.redirected) return cache.put(key, res.clone());
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Always live: the API, book files and covers, and the login service's own paths.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return;

  // Pages: the network first (so a new version and the login always win), the saved shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected && (res.headers.get("content-type") || "").includes("text/html")) {
            const copy = res.clone();
            void caches.open(SHELL).then((cache) => keep(cache, "/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
    return;
  }

  // Built files have content hashes in their names, so a saved copy never goes stale.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            void caches.open(SHELL).then((cache) => keep(cache, req, copy));
            return res;
          }),
      ),
    );
  }
});
