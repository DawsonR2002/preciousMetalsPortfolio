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
  // - MetalPriceAPI_KEY
  // --------------------------------------------------

  const providerDefinitions_Array = [];

  // ------------------------------
  // GoldAPI.io (market)
  // ------------------------------

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

  // ------------------------------
  // Metals.Dev (market)
  // ------------------------------

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

  // ------------------------------
  // MetalpriceAPI (market)
  // ------------------------------

  // NOTE: Your Cloudflare secret name uses this exact casing:
  // "MetalPriceAPI_KEY"
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

  // If none are configured, return cleanly (no error).
  if (providerDefinitions_Array.length === 0) {
    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: null,
      usedCount: 0,
      fetchedOkCount: 0,
      updatedAtUtcIso: new Date().toISOString(),
      marketPriceUsdPerTroyOunce: null,
      retailPriceUsdPerTroyOunce: null,
      providers: []
    });
  }

  const settledResults = await Promise.allSettled(
    providerDefinitions_Array.map(function ProviderInvoker_Wrapper(def) {
      return def.invoke(metal);
    })
  );

  let retailPriceUsdPerTroyOunce_NumberOrNull = null;

  // We now have MULTIPLE market providers, so we collect them and compute a robust aggregate.
  const marketPrices_Array = [];

  let fetchedOkCount_Number = 0;

  const providersReport_Array = [];

  for (let i = 0; i < settledResults.length; i += 1) {
    const result = settledResults[i];
    const providerDef = providerDefinitions_Array[i];

    if (result.status === "fulfilled") {
      fetchedOkCount_Number += 1;

      const payload = result.value;

      providersReport_Array.push({
        name: providerDef.providerName,
        kind: providerDef.kind,
        ok: true,
        price: payload.price
      });

      if (payload.kind === "retail") {
        retailPriceUsdPerTroyOunce_NumberOrNull = payload.price;
      }

      if (
        payload.kind === "market" &&
        Number.isFinite(payload.price) &&
        payload.price > 0
      ) {
        marketPrices_Array.push(payload.price);
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
  // Choose market aggregate:
  // - With 3 sources, MEDIAN is the safest "average" when one source goes weird.
  // --------------------------------------------------

  let marketPriceUsdPerTroyOunce_NumberOrNull = null;

  if (marketPrices_Array.length > 0) {
    marketPriceUsdPerTroyOunce_NumberOrNull = CalculateMedian(marketPrices_Array);
  }

  // Keep the old "main" price behavior:
  // - If market exists, use market as main
  // - Else if retail exists, use retail
  const collectedPrices_Array = [];

  if (
    Number.isFinite(marketPriceUsdPerTroyOunce_NumberOrNull) &&
    marketPriceUsdPerTroyOunce_NumberOrNull > 0
  ) {
    collectedPrices_Array.push(marketPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (
    Number.isFinite(retailPriceUsdPerTroyOunce_NumberOrNull) &&
    retailPriceUsdPerTroyOunce_NumberOrNull > 0
  ) {
    collectedPrices_Array.push(retailPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (collectedPrices_Array.length === 0) {
    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: null,
      usedCount: 0,
      fetchedOkCount: fetchedOkCount_Number,
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
    usedCount: marketPrices_Array.length + (Number.isFinite(retailPriceUsdPerTroyOunce_NumberOrNull) && retailPriceUsdPerTroyOunce_NumberOrNull > 0 ? 1 : 0),
    fetchedOkCount: fetchedOkCount_Number,
    updatedAtUtcIso: new Date().toISOString(),
    marketPriceUsdPerTroyOunce: marketPriceUsdPerTroyOunce_NumberOrNull,
    retailPriceUsdPerTroyOunce: retailPriceUsdPerTroyOunce_NumberOrNull,
    providers: providersReport_Array
  });
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
/* Provider — GoldAPI.io (Licensed API)               */
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

  if (
    !Number.isFinite(priceUsdPerTroyOunce_Number) ||
    priceUsdPerTroyOunce_Number <= 0
  ) {
    throw new Error("GoldAPI.io returned invalid price");
  }

  return {
    name: "GoldAPI.io",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Provider — Metals.Dev (Licensed API)               */
/* -------------------------------------------------- */

async function FetchFromMetalsDev_Market(metal, metalsDevKey) {

  // Metals.Dev "latest" endpoint returns a JSON object with metals.gold and metals.silver,
  // already in USD per troy-ounce when unit=toz and currency=USD.
  // Docs: https://metals.dev/docs (Latest Endpoint)
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

  if (
    !Number.isFinite(priceUsdPerTroyOunce_Number) ||
    priceUsdPerTroyOunce_Number <= 0
  ) {
    throw new Error("Metals.Dev returned invalid price for " + metalsDevKeyForMetal);
  }

  return {
    name: "Metals.Dev",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Provider — MetalpriceAPI (Licensed API)            */
/* -------------------------------------------------- */

async function FetchFromMetalPriceApi_Market(metal, metalPriceApiKey) {

  // MetalpriceAPI "latest" endpoint:
  // https://api.metalpriceapi.com/v1/latest?api_key=KEY&base=USD&currencies=XAU,XAG
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

  // MetalpriceAPI returns rates relative to base.
  // With base=USD, rate is typically metal-units per 1 USD, so USD per 1 metal = 1 / rate.
  const priceUsdPerTroyOunce_Number = 1 / rawRate_Number;

  if (
    !Number.isFinite(priceUsdPerTroyOunce_Number) ||
    priceUsdPerTroyOunce_Number <= 0
  ) {
    throw new Error("MetalpriceAPI conversion produced invalid price for " + metal);
  }

  return {
    name: "MetalpriceAPI",
    kind: "market",
    price: priceUsdPerTroyOunce_Number
  };
}

/* -------------------------------------------------- */
/* Median                                             */
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
/* JSON Response                                      */
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