"use strict";

// BUMP THIS any time you change index.html/app.js in a way you want to force-update.
const CacheName_String = "precious-metals-portfolio-cache-v5";

// Only cache what you actually serve as static files.
// If you add css/images later, put them here too.
const PrecacheUrls_Array = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest"
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
    // Delete old caches so old HTML/JS can’t come back.
    const keys = await caches.keys();
    for (const key of keys) {
      if (key !== CacheName_String) {
        await caches.delete(key);
      }
    }

    // Take control of pages right away.
    await self.clients.claim();
  })());
});

function IsNavigationRequest(request) {
  return request.mode === "navigate";
}

function IsIndexOrAppJs(requestUrl) {
  const path = requestUrl.pathname || "";
  return (
    path.endsWith("/") ||
    path.endsWith("/index.html") ||
    path.endsWith("/app.js")
  );
}

function IsApiRequest(requestUrl) {
  const path = requestUrl.pathname || "";
  // Your backend is /api/spot
  return path.indexOf("/api/") >= 0;
}

async function NetworkFirst(request) {
  const cache = await caches.open(CacheName_String);

  try {
    const response = await fetch(request, { cache: "no-store" });

    // Only cache good responses
    if (response && response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function CacheFirst(request) {
  const cache = await caches.open(CacheName_String);

  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request, { cache: "no-store" });
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", function (event) {
  const request = event.request;

  // Only handle GET
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // IMPORTANT:
  // Never cache /api/* responses. Always go to network.
  // This prevents you from getting "stuck" on an old spot payload or an old provider outcome.
  if (IsApiRequest(url)) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // For the app shell (index/app.js), do NETWORK-FIRST so refresh gets latest.
  // For everything else, cache-first is fine.
  if (IsNavigationRequest(request) || IsIndexOrAppJs(url)) {
    event.respondWith(NetworkFirst(request));
    return;
  }

  event.respondWith(CacheFirst(request));
});