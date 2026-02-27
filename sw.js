"use strict";

// BUMP THIS any time you change index.html/app.js/manifest in a way you want to force-update.
const CacheName_String = "precious-metals-portfolio-cache-v10";

// This should match the querystring version in index.html.
const AssetVersion_String = "10";

// Only cache what you actually serve as static files.
// If you add css/images later, put them here too.
const PrecacheUrls_Array = [
  "./",
  "./index.html?v=" + AssetVersion_String,
  "./app.js?v=" + AssetVersion_String,
  "./manifest.webmanifest?v=" + AssetVersion_String
];

self.addEventListener("install", function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CacheName_String);
    await cache.addAll(PrecacheUrls_Array);

    // Immediately activate the new SW (otherwise the old SW can linger)
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    // Delete old caches so old index/app doesn't remain offline forever.
    const keys = await caches.keys();

    for (const key of keys) {
      if (key !== CacheName_String) {
        await caches.delete(key);
      }
    }

    // Start controlling open tabs immediately.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", function (event) {
  const request = event.request;

  if (!request || request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // For API calls, prefer network (fresh), fallback to cache if any.
  // We do NOT precache API results.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith((async function () {
      try {
        const networkResponse = await fetch(request);
        return networkResponse;
      } catch (e) {
        const cached = await caches.match(request);
        return cached || new Response("Offline and no cached API response.", {
          status: 503,
          headers: { "Content-Type": "text/plain" }
        });
      }
    })());
    return;
  }

  // For static assets: cache-first for offline support.
  event.respondWith((async function () {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request);

    // Cache a copy
    const cache = await caches.open(CacheName_String);
    cache.put(request, response.clone());

    return response;
  })());
});