// ===========================================================================
//  sw.js — offline shell + push notifications
//
//  Strategy is stale-while-revalidate: a repeat visit is served straight out
//  of the cache (no network in the critical path at all) while a fresh copy
//  downloads quietly in the background for next time.
// ===========================================================================

const VERSION = "sc-v6";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./store.js",
  "./sb.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;              // Supabase calls go straight to the network

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: false });

      // cache:"no-cache" forces a conditional request to the origin. Without it
      // the browser's own HTTP cache answers this (GitHub Pages sends
      // max-age=600) and we just re-store the same stale bytes, so a
      // deployment stays invisible until that expires.
      const network = fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }))
        .then(async (res) => {
          if (!res || !res.ok || res.type !== "basic") return res;
          // Did this file actually change since the copy we just served?
          const before = cached?.headers.get("ETag") || cached?.headers.get("Last-Modified");
          const after = res.headers.get("ETag") || res.headers.get("Last-Modified");
          await cache.put(req, res.clone());
          if (cached && before && after && before !== after) announceUpdate();
          return res;
        })
        .catch(() => null);

      // Cached copy wins the race; the network copy refreshes the cache behind it.
      if (cached) { e.waitUntil(network); return cached; }

      const fresh = await network;
      return fresh || (await cache.match("./index.html")) || new Response("Offline", { status: 503 });
    })
  );
});

// Serving from cache means a deployment would otherwise only appear on the load
// *after* next. When a revalidation turns up genuinely new bytes, tell the page
// so it can refresh itself at a moment that won't interrupt her.
let announceTimer = null;
function announceUpdate() {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "sc-updated" });
  }, 400);
}

// ------------------------------------------------------------------- push ---
self.addEventListener("push", (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch { payload = { body: e.data ? e.data.text() : "" }; }

  e.waitUntil(self.registration.showNotification(payload.title || "Nour’s Calendar", {
    body: payload.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: payload.tag || "shift-calendar",
    renotify: true,
    data: { date: payload.date || null },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const date = e.notification.data?.date;
  const target = new URL(date ? `./index.html?date=${date}` : "./index.html", self.location.href).href;

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
