export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
  }

  // --------------------------------------------------
  // Providers (3 licensed APIs)
  //
  // Secrets expected in Cloudflare Pages:
  // - GOLDAPI_IO_KEY
  // - METALSDEV_KEY
  // - MetalPriceAPI_KEY   (case-sensitive!)
  // --------------------------------------------------

  const providerDefinitions_Array = [];

  const resolvedGoldApiKey_StringOrNull = ResolveSecretStringOrNull(context, "GOLDAPI_IO_KEY");
  if (resolvedGoldApiKey_StringOrNull) {
    providerDefinitions_Array.push({
      providerName: "GoldAPI.io",
      kind: "market",
      invoke: function ProviderInvoker_GoldApiIo(metalCode) {
        return FetchFromGoldApiIo_Market(metalCode, resolvedGoldApiKey_StringOrNull);
      }
    });
  }

  const resolvedMetalsDevKey_StringOrNull = ResolveSecretStringOrNull(context, "METALSDEV_KEY");
  if (resolvedMetalsDevKey_StringOrNull) {
    providerDefinitions_Array.push({
      providerName: "Metals.Dev",
      kind: "market",
      invoke: function ProviderInvoker_MetalsDev(metalCode) {
        return FetchFromMetalsDev_Market(metalCode, resolvedMetalsDevKey_StringOrNull);
      }
    });
  }

  // NOTE: your secret is exactly "MetalPriceAPI_KEY" (case-sensitive)
  const resolvedMetalPriceApiKey_StringOrNull = ResolveSecretStringOrNull(context, "MetalPriceAPI_KEY");
  if (resolvedMetalPriceApiKey_StringOrNull) {
    providerDefinitions_Array.push({
      providerName: "MetalpriceAPI",
      kind: "market",
      invoke: function ProviderInvoker_MetalPriceApi(metalCode) {
        return FetchFromMetalPriceApi_Market(metalCode, resolvedMetalPriceApiKey_StringOrNull);
      }
    });
  }

  const attemptedCount_Number = providerDefinitions_Array.length;

  if (attemptedCount_Number === 0) {
    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: null,

      // IMPORTANT: success/attempted
      usedCount: 0,
      fetchedOkCount: 0,

      updatedAtUtcIso: new Date().toISOString(),
      marketPriceUsdPerTroyOunce: null,
      retailPriceUsdPerTroyOunce: null,
      providers: []
    }, 200);
  }

  const settledResults = await Promise.allSettled(
    providerDefinitions_Array.map(function ProviderInvoker_Wrapper(def) {
      return def.invoke(metal);
    })
  );

  const providersReport_Array = [];

  // Market values from providers
  const marketPrices_Array = [];

  // Retail is optional (we are not currently using a retail provider in this 3-provider setup)
  let retailPriceUsdPerTroyOunce_NumberOrNull = null;

  let successCount_Number = 0;

  for (let i = 0; i < settledResults.length; i += 1) {
    const result = settledResults[i];
    const providerDef = providerDefinitions_Array[i];

    if (result.status === "fulfilled") {
      successCount_Number += 1;

      const payload = result.value;

      // payload is shaped as: { name, kind, price }
      providersReport_Array.push({
        name: providerDef.providerName,
        kind: providerDef.kind,
        ok: true,
        price: payload && Number.isFinite(payload.price) ? payload.price : null
      });

      if (payload && payload.kind === "retail") {
        if (Number.isFinite(payload.price) && payload.price > 0) {
          retailPriceUsdPerTroyOunce_NumberOrNull = payload.price;
        }
      }

      if (payload && payload.kind === "market") {
        if (Number.isFinite(payload.price) && payload.price > 0) {
          marketPrices_Array.push(payload.price);
        }
      }

      continue;
    }

    providersReport_Array.push({
      name: providerDef.providerName,
      kind: providerDef.kind,
      ok: false,
      error: String(result.reason)
    });
  }

  // --------------------------------------------------
  // Market aggregate:
  // - with 3 sources, MEDIAN is robust against one bad provider
  // --------------------------------------------------

  let marketPriceUsdPerTroyOunce_NumberOrNull = null;

  if (marketPrices_Array.length > 0) {
    marketPriceUsdPerTroyOunce_NumberOrNull = CalculateMedian(marketPrices_Array);
  }

  // Keep the "main" value:
  // - If market exists, use market
  // - Else if retail exists, use retail
  const collectedPrices_Array = [];

  if (Number.isFinite(marketPriceUsdPerTroyOunce_NumberOrNull) && marketPriceUsdPerTroyOunce_NumberOrNull > 0) {
    collectedPrices_Array.push(marketPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (Number.isFinite(retailPriceUsdPerTroyOunce_NumberOrNull) && retailPriceUsdPerTroyOunce_NumberOrNull > 0) {
    collectedPrices_Array.push(retailPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (collectedPrices_Array.length === 0) {
    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: null,

      // IMPORTANT: success/attempted
      usedCount: successCount_Number,
      fetchedOkCount: attemptedCount_Number,

      updatedAtUtcIso: new Date().toISOString(),
      marketPriceUsdPerTroyOunce: null,
      retailPriceUsdPerTroyOunce: null,
      providers: providersReport_Array
    }, 200);
  }

  const mainPrice_Number = CalculateMedian(collectedPrices_Array);

  return JsonResponse({
    metal: metal,
    priceUsdPerTroyOunce: mainPrice_Number,

    // IMPORTANT: success/attempted (this fixes the misleading 1/1)
    usedCount: successCount_Number,
    fetchedOkCount: attemptedCount_Number,

    updatedAtUtcIso: new Date().toISOString(),
    marketPriceUsdPerTroyOunce: marketPriceUsdPerTroyOunce_NumberOrNull,
    retailPriceUsdPerTroyOunce: retailPriceUsdPerTroyOunce_NumberOrNull,
    providers: providersReport_Array
  }, 200);
}

/* -------------------------------------------------- */
/* Helpers                                             */
/* -------------------------------------------------- */

function ResolveSecretStringOrNull(context, secretName) {
  if (!context || !context.env) {
    return null;
  }

  const raw = context.env[secretName];

  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

/* -------------------------------------------------- */
/* Provider — GoldAPI.io                               */
/* -------------------------------------------------- */

async function FetchFromGoldApiIo_Market(metal, goldApiIoKey) {
  const endpointUrl =
    "https://www.goldapi.io/api/" + encodeURIComponent(metal) + "/USD";

  const response = await fetch(endpointUrl, {
    headers: {
      "Cache-Control": "no-store",
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
/* Provider — Metals.Dev                               */
/* -------------------------------------------------- */

async function FetchFromMetalsDev_Market(metal, metalsDevKey) {
  const endpointUrl =
    "https://api.metals.dev/v1/latest" +
    "?api_key=" + encodeURIComponent(metalsDevKey) +
    "&currency=USD" +
    "&unit=toz";

  const response = await fetch(endpointUrl, {
    headers: {
      "Cache-Control": "no-store",
      "Accept": "application/json"
    }
  });

  if (response.status === 429) {
    throw new Error("Metals.Dev rate/plan limit hit (HTTP 429)");
  }

  if (!response.ok) {
    throw new Error("Metals.Dev failed HTTP " + String(response.status));
  }

  const json = await response.json();

  if (!json || !json.metals) {
    throw new Error("Metals.Dev returned malformed response");
  }

  const metalsObject = json.metals;

  const metalsDevKeyForMetal = metal === "XAU" ? "gold" : "silver";

  const priceUsdPerTroyOunce_Number = Number(metalsObject[metalsDevKeyForMetal]);

  if (!Number.isFinite(priceUsdPerTroyOunce_Number) || priceUsdPerTroyOunce_Number <= 0) {
    throw new Error("Metals.Dev returned invalid price for " + metalsDevKeyForMetal);
  }

  return {
    name: "Metals.Dev",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Provider — MetalpriceAPI                            */
/* -------------------------------------------------- */

async function FetchFromMetalPriceApi_Market(metal, metalPriceApiKey) {
  const endpointUrl =
    "https://api.metalpriceapi.com/v1/latest" +
    "?api_key=" + encodeURIComponent(metalPriceApiKey) +
    "&base=USD" +
    "&currencies=" + encodeURIComponent(metal);

  const response = await fetch(endpointUrl, {
    headers: {
      "Cache-Control": "no-store",
      "Accept": "application/json"
    }
  });

  if (response.status === 429) {
    throw new Error("MetalpriceAPI rate/plan limit hit (HTTP 429)");
  }

  if (!response.ok) {
    throw new Error("MetalpriceAPI failed HTTP " + String(response.status));
  }

  const json = await response.json();

  if (!json || !json.rates) {
    throw new Error("MetalpriceAPI returned malformed response");
  }

  const rawRate_Number = Number(json.rates[metal]);

  if (!Number.isFinite(rawRate_Number) || rawRate_Number <= 0) {
    throw new Error("MetalpriceAPI returned invalid rate for " + metal);
  }

  // base=USD → rate is typically METAL per 1 USD → USD per METAL = 1 / rate
  const priceUsdPerTroyOunce_Number = 1 / rawRate_Number;

  if (!Number.isFinite(priceUsdPerTroyOunce_Number) || priceUsdPerTroyOunce_Number <= 0) {
    throw new Error("MetalpriceAPI conversion produced invalid price for " + metal);
  }

  return {
    name: "MetalpriceAPI",
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