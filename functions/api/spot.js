export async function onRequest(context) {
  // ----------------------------
  // CORS / Preflight
  // ----------------------------

  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CreateCorsHeaders()
    });
  }

  // ----------------------------
  // Parse + validate
  // ----------------------------

  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code" }, 400);
  }

  // ----------------------------
  // Provider strategy
  //
  // IMPORTANT:
  // - We treat Metals.live as "market-ish" (futures/spot style feed)
  // - We treat GoldPrice as "retail/reference-ish"
  //
  // This is not perfect, but it gives you TWO lanes to blend with the bias slider.
  // ----------------------------

  const providerDefinitions_Array = [
    { Name: "GoldPrice", Kind: "retail", Fn: FetchFromGoldPriceOrg },
    { Name: "MetalsLive", Kind: "market", Fn: FetchFromMetalsLive }
  ];

  // ----------------------------
  // Fetch (with timeouts)
  // ----------------------------

  const results = await Promise.allSettled(
    providerDefinitions_Array.map(async function (p) {
      const price = await FetchWithTimeout_NumberAsync(function () {
        return p.Fn(metal);
      }, 7000);

      return {
        ProviderName: p.Name,
        ProviderKind: p.Kind,
        PriceUsdPerTroyOunce: price
      };
    })
  );

  // ----------------------------
  // Collect
  // ----------------------------

  const successfulPrices_All_Array = [];
  let marketPrice_NumberOrNull = null;
  let retailPrice_NumberOrNull = null;

  const providerDebug_Array = [];

  for (let i = 0; i < results.length; i += 1) {
    const def = providerDefinitions_Array[i];
    const r = results[i];

    if (r.status === "fulfilled") {
      const payload = r.value;
      const price = Number(payload.PriceUsdPerTroyOunce);

      providerDebug_Array.push({
        name: payload.ProviderName,
        kind: payload.ProviderKind,
        ok: true,
        price: Number.isFinite(price) ? price : null
      });

      if (Number.isFinite(price) && price > 0) {
        successfulPrices_All_Array.push(price);

        if (payload.ProviderKind === "market") {
          marketPrice_NumberOrNull = price;
        }

        if (payload.ProviderKind === "retail") {
          retailPrice_NumberOrNull = price;
        }
      }
    } else {
      providerDebug_Array.push({
        name: def.Name,
        kind: def.Kind,
        ok: false,
        error: String(r.reason)
      });
    }
  }

  // ----------------------------
  // Decide the "main" price
  // (Keep your existing contract: priceUsdPerTroyOunce)
  // ----------------------------

  if (successfulPrices_All_Array.length === 0) {
    return JsonResponse(
      {
        metal,
        priceUsdPerTroyOunce: null,
        usedCount: 0,
        fetchedOkCount: 0,
        updatedAtUtcIso: new Date().toISOString(),

        // new optional fields
        marketPriceUsdPerTroyOunce: null,
        retailPriceUsdPerTroyOunce: null,
        providers: providerDebug_Array
      },
      200,
      CreateCorsHeaders()
    );
  }

  const median = CalculateMedian(successfulPrices_All_Array);

  return JsonResponse(
    {
      metal,

      // keep old name for app.js compatibility
      priceUsdPerTroyOunce: median,

      usedCount: successfulPrices_All_Array.length,
      fetchedOkCount: successfulPrices_All_Array.length,
      updatedAtUtcIso: new Date().toISOString(),

      // new optional fields (for your bias slider to blend later)
      marketPriceUsdPerTroyOunce: marketPrice_NumberOrNull,
      retailPriceUsdPerTroyOunce: retailPrice_NumberOrNull,

      // debugging breadcrumbs (you can remove later)
      providers: providerDebug_Array
    },
    200,
    CreateCorsHeaders()
  );
}

/* -------------------------------------------------- */
/* Provider 1 — GoldPrice.org (retail/reference-ish) */
/* -------------------------------------------------- */

async function FetchFromGoldPriceOrg(metal) {
  const response = await fetch("https://data-asg.goldprice.org/dbXRates/USD", {
    cache: "no-store",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error("GoldPrice failed: HTTP " + response.status);

  const json = await response.json();

  if (!json || !Array.isArray(json.items) || json.items.length < 1) {
    throw new Error("Invalid GoldPrice format");
  }

  const data = json.items[0];

  if (metal === "XAU") return Number(data.xauPrice);
  if (metal === "XAG") return Number(data.xagPrice);

  throw new Error("Metal not supported");
}

/* -------------------------------------------------- */
/* Provider 2 — Metals.live (market-ish) */
/* -------------------------------------------------- */

async function FetchFromMetalsLive(metal) {
  const response = await fetch("https://api.metals.live/v1/spot", {
    cache: "no-store",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error("MetalsLive failed: HTTP " + response.status);

  const json = await response.json();

  if (!Array.isArray(json)) throw new Error("Invalid MetalsLive format");

  for (const row of json) {
    if (!Array.isArray(row) || row.length !== 2) continue;

    const symbol = String(row[0]).toLowerCase();
    const price = Number(row[1]);

    if (metal === "XAU" && symbol === "gold") return price;
    if (metal === "XAG" && symbol === "silver") return price;
  }

  throw new Error("Metal not found");
}

/* -------------------------------------------------- */
/* Median */
/* -------------------------------------------------- */

function CalculateMedian(numbersArray) {
  const sorted = [...numbersArray].sort(function (a, b) {
    return a - b;
  });

  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

/* -------------------------------------------------- */
/* Timeout helper */
/* -------------------------------------------------- */

async function FetchWithTimeout_NumberAsync(fetchFunctionReturningPromise, timeoutMs_Int) {
  const timeoutMs = Number(timeoutMs_Int);
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 7000;

  const controller = new AbortController();
  const timerId = setTimeout(function () {
    controller.abort();
  }, ms);

  try {
    // Give provider fetch access to the AbortSignal by binding globally:
    // (Providers in this file use fetch directly; Cloudflare fetch supports AbortSignal.)
    // We'll temporarily wrap global fetch with the signal via a closure approach:
    const originalFetch = fetch;

    function FetchWithSignal(input, init) {
      const nextInit = init ? { ...init } : {};
      nextInit.signal = controller.signal;
      return originalFetch(input, nextInit);
    }

    // Monkey patch within this call scope only
    const savedFetch = fetch;
    // eslint-disable-next-line no-global-assign
    fetch = FetchWithSignal;

    const value = await fetchFunctionReturningPromise();

    // restore
    // eslint-disable-next-line no-global-assign
    fetch = savedFetch;

    return Number(value);
  } finally {
    clearTimeout(timerId);
  }
}

/* -------------------------------------------------- */
/* JSON Response + CORS */
/* -------------------------------------------------- */

function CreateCorsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function JsonResponse(object, statusCode = 200, extraHeadersOrNull = null) {
  const headers = extraHeadersOrNull ? extraHeadersOrNull : { "Content-Type": "application/json" };

  return new Response(JSON.stringify(object), {
    status: statusCode,
    headers: headers
  });
}
