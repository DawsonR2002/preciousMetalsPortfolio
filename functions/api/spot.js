
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
  }

  // --------------------------------------------------
  // Providers (some are conditional on env keys)
  // --------------------------------------------------

  const providers = [];

  // Existing no-key providers:
  providers.push(FetchFromGoldPriceOrg_Retail);
  providers.push(FetchFromStooq_Market);

  // “Old references that worked but hit monthly limits”
  // These are added back in a safe/conditional way:
  if (
    context &&
    context.env &&
    typeof context.env.METALS_API_KEY === "string" &&
    context.env.METALS_API_KEY.trim().length > 0
  ) {
    providers.push(function ProviderInvoker_MetalsApiLayer(m) {
      return FetchFromMetalsApiLayer_Market(m, context.env.METALS_API_KEY);
    });
  }

  // ---------------------------------------------
  // GoldAPI.io Key Support (ENV or Hardcoded)
  // ---------------------------------------------

  // ✅✅✅ EDIT THIS LINE to paste your real key (optional fallback) ✅✅✅
  const HARDCODED_GOLDAPI_IO_KEY_PLACEHOLDER = "goldapi-72cmsmlwyskzt-io";
  // ✅✅✅ END EDIT LINE ✅✅✅

  let resolvedGoldApiKey = null;

  // Priority 1: Environment variable (recommended)
  if (
    context &&
    context.env &&
    typeof context.env.GOLDAPI_IO_KEY === "string" &&
    context.env.GOLDAPI_IO_KEY.trim().length > 0
  ) {
    resolvedGoldApiKey = context.env.GOLDAPI_IO_KEY.trim();
  }

  // Priority 2: Hardcoded fallback
  if (
    !resolvedGoldApiKey &&
    typeof HARDCODED_GOLDAPI_IO_KEY_PLACEHOLDER === "string" &&
    HARDCODED_GOLDAPI_IO_KEY_PLACEHOLDER !== "goldapi-72cmsmlwyskzt-io" &&
    HARDCODED_GOLDAPI_IO_KEY_PLACEHOLDER.trim().length > 0
  ) {
    resolvedGoldApiKey = HARDCODED_GOLDAPI_IO_KEY_PLACEHOLDER.trim();
  }

  if (resolvedGoldApiKey) {
    providers.push(function ProviderInvoker_GoldApiIo(m) {
      return FetchFromGoldApiIo_Market(m, resolvedGoldApiKey);
    });
  }

  const settledResults = await Promise.allSettled(
    providers.map(function ProviderInvoker(providerFunction) {
      return providerFunction(metal);
    })
  );

  let retailPriceUsdPerTroyOunce_NumberOrNull = null;
  let marketPriceUsdPerTroyOunce_NumberOrNull = null;

  const providersReport_Array = [];

  for (let i = 0; i < settledResults.length; i += 1) {
    const result = settledResults[i];

    if (result.status === "fulfilled") {
      const payload = result.value;

      providersReport_Array.push({
        name: payload.name,
        kind: payload.kind,
        ok: true,
        price: payload.price
      });

      if (payload.kind === "retail") {
        retailPriceUsdPerTroyOunce_NumberOrNull = payload.price;
      }

      if (payload.kind === "market") {
        marketPriceUsdPerTroyOunce_NumberOrNull = payload.price;
      }

      continue;
    }

    providersReport_Array.push({
      name: "(unknown)",
      kind: "(unknown)",
      ok: false,
      error: String(result.reason)
    });
  }

  const collectedPrices_Array = [];

  if (
    Number.isFinite(retailPriceUsdPerTroyOunce_NumberOrNull) &&
    retailPriceUsdPerTroyOunce_NumberOrNull > 0
  ) {
    collectedPrices_Array.push(retailPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (
    Number.isFinite(marketPriceUsdPerTroyOunce_NumberOrNull) &&
    marketPriceUsdPerTroyOunce_NumberOrNull > 0
  ) {
    collectedPrices_Array.push(marketPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (collectedPrices_Array.length === 0) {
    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: null,
      usedCount: 0,
      fetchedOkCount: 0,
      updatedAtUtcIso: new Date().toISOString(),

      marketPriceUsdPerTroyOunce: null,
      retailPriceUsdPerTroyOunce: null,
      providers: providersReport_Array
    });
  }

  const mainPrice_Number = CalculateMedian(collectedPrices_Array);

  return JsonResponse({
    metal: metal,
    priceUsdPerTroyOunce: mainPrice_Number,
    usedCount: collectedPrices_Array.length,
    fetchedOkCount: collectedPrices_Array.length,
    updatedAtUtcIso: new Date().toISOString(),
    marketPriceUsdPerTroyOunce: marketPriceUsdPerTroyOunce_NumberOrNull,
    retailPriceUsdPerTroyOunce: retailPriceUsdPerTroyOunce_NumberOrNull,
    providers: providersReport_Array
  });
}

/* -------------------------------------------------- */
/* Provider 1 — GoldPrice.org (Retail/Reference)       */
/* -------------------------------------------------- */

async function FetchFromGoldPriceOrg_Retail(metal) {
  const response = await fetch("https://data-asg.goldprice.org/dbXRates/USD", {
    cf: { cacheTtl: 300 },
    headers: {
      "Cache-Control": "max-age=0"
    }
  });

  if (!response.ok) {
    throw new Error("GoldPrice failed HTTP " + String(response.status));
  }

  const json = await response.json();

  if (!json || !Array.isArray(json.items) || json.items.length === 0) {
    throw new Error("GoldPrice invalid format");
  }

  const data = json.items[0];

  let price = null;

  if (metal === "XAU") {
    price = Number(data.xauPrice);
  }

  if (metal === "XAG") {
    price = Number(data.xagPrice);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("GoldPrice returned invalid price");
  }

  return {
    name: "GoldPrice",
    kind: "retail",
    price: price
  };
}

/* -------------------------------------------------- */
/* Provider 2 — Stooq (Market-ish “headline” source)   */
/* -------------------------------------------------- */

async function FetchFromStooq_Market(metal) {
  let symbol = null;

  if (metal === "XAU") {
    symbol = "xauusd";
  }

  if (metal === "XAG") {
    symbol = "xagusd";
  }

  const endpointUrl = "https://stooq.com/q/l/?s=" + encodeURIComponent(symbol) + "&i=d";

  const response = await fetch(endpointUrl, {
    cf: { cacheTtl: 300 },
    headers: {
      "Cache-Control": "max-age=0"
    }
  });

  if (!response.ok) {
    throw new Error("Stooq failed HTTP " + String(response.status));
  }

  const text = await response.text();

  const lines = String(text).trim().split(/\r?\n/);

  if (lines.length < 2) {
    throw new Error("Stooq CSV invalid (not enough lines)");
  }

  const header = lines[0].split(",");
  const dataRow = lines[1].split(",");

  const closeIndex = header.indexOf("Close");
  if (closeIndex < 0) {
    throw new Error("Stooq CSV missing Close column");
  }

  const closeValue_String = dataRow[closeIndex];
  const closeValue_Number = Number(closeValue_String);

  if (!Number.isFinite(closeValue_Number) || closeValue_Number <= 0) {
    throw new Error("Stooq returned invalid Close price");
  }

  return {
    name: "Stooq",
    kind: "market",
    price: closeValue_Number
  };
}

/* -------------------------------------------------- */
/* Provider 3 — Metals-API (API key; monthly limits)   */
/* -------------------------------------------------- */

async function FetchFromMetalsApiLayer_Market(metal, metalsApiKey) {
  const endpointUrl =
    "https://metals-api.com/api/latest" +
    "?access_key=" + encodeURIComponent(metalsApiKey) +
    "&base=USD" +
    "&symbols=XAU,XAG";

  const response = await fetch(endpointUrl, {
    cf: { cacheTtl: 300 },
    headers: {
      "Cache-Control": "max-age=0"
    }
  });

  if (response.status === 429) {
    throw new Error("Metals-API rate/plan limit hit (HTTP 429)");
  }

  if (!response.ok) {
    throw new Error("Metals-API failed HTTP " + String(response.status));
  }

  const json = await response.json();

  if (!json || typeof json !== "object" || !json.rates || typeof json.rates !== "object") {
    throw new Error("Metals-API invalid format");
  }

  const rate_Number = Number(json.rates[metal]);

  if (!Number.isFinite(rate_Number) || rate_Number <= 0) {
    throw new Error("Metals-API returned invalid rate for " + metal);
  }

  const priceUsdPerTroyOunce_Number = 1 / rate_Number;

  if (!Number.isFinite(priceUsdPerTroyOunce_Number) || priceUsdPerTroyOunce_Number <= 0) {
    throw new Error("Metals-API produced invalid inverted price");
  }

  return {
    name: "Metals-API",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Provider 4 — GoldAPI.io (API key; monthly limits)   */
/* -------------------------------------------------- */

async function FetchFromGoldApiIo_Market(metal, goldApiIoKey) {
  const endpointUrl = "https://www.goldapi.io/api/" + encodeURIComponent(metal) + "/USD";

  const response = await fetch(endpointUrl, {
    cf: { cacheTtl: 300 },
    headers: {
      "Cache-Control": "max-age=0",
      "x-access-token": goldApiIoKey
    }
  });

  if (response.status === 429) {
    throw new Error("GoldAPI.io rate/plan limit hit (HTTP 429)");
  }

  if (!response.ok) {
    throw new Error("GoldAPI.io failed HTTP " + String(response.status));
  }

  const json = await response.json();

  const priceUsdPerTroyOunce_Number = json ? Number(json.price) : NaN;

  if (!Number.isFinite(priceUsdPerTroyOunce_Number) || priceUsdPerTroyOunce_Number <= 0) {
    throw new Error("GoldAPI.io returned invalid price");
  }

  return {
    name: "GoldAPI.io",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Median                                              */
/* -------------------------------------------------- */

function CalculateMedian(numbersArray) {
  const sorted = [...numbersArray].sort(function SortAscending(a, b) {
    return a - b;
  });

  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

/* -------------------------------------------------- */
/* JSON Response                                       */
/* -------------------------------------------------- */

function JsonResponse(object, statusCode = 200) {
  return new Response(JSON.stringify(object), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
