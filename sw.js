"use strict";

// BUMP THIS any time you change index.html/app.js in a way you want to force-update.
const CacheName_String = "precious-metals-portfolio-cache-v8";

// This must match the querystring version in index.html.
const AssetVersion_String = "8";

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

    // Immediately activate new SW (otherwise old SW can hang around)
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    // Delete old caches so old app.js doesn't remain offline forever.
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

  // Only handle GET requests safely.
  if (!request || request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) {
    return;
  }

  // If this is an API request (spot price backend), prefer network, fallback to cache if available.
  // (This avoids caching stale API responses aggressively.)
  if (url.pathname.indexOf("/api/") === 0) {
    event.respondWith((async function () {
      try {
        const networkResponse = await fetch(request);
        return networkResponse;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        throw err;
      }
    })());
    return;
  }

  // Navigation requests: try network, fallback to cached index.html for offline.
  if (request.mode === "navigate") {
    event.respondWith((async function () {
      try {
        const networkResponse = await fetch(request);
        return networkResponse;
      } catch (err) {
        const cachedIndex = await caches.match("./index.html?v=" + AssetVersion_String);
        if (cachedIndex) {
          return cachedIndex;
        }
        throw err;
      }
    })());
    return;
  }

  // Static assets: cache-first, network fallback.
  event.respondWith((async function () {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request);

    // Opportunistically cache same-origin successful responses.
    try {
      const cache = await caches.open(CacheName_String);
      cache.put(request, response.clone());
    } catch {
      // If caching fails, still return response.
    }

    return response;
  })());
});