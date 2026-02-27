export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
  }

  // --------------------------------------------------
  // Providers (GoldAPI only — licensed API)
  // --------------------------------------------------

  const providers = [];

  let resolvedGoldApiKey = null;

  if (
    context &&
    context.env &&
    typeof context.env.GOLDAPI_IO_KEY === "string" &&
    context.env.GOLDAPI_IO_KEY.trim().length > 0
  ) {
    resolvedGoldApiKey = context.env.GOLDAPI_IO_KEY.trim();
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
/* Provider — GoldAPI.io (Licensed API)              */
/* -------------------------------------------------- */

async function FetchFromGoldApiIo_Market(metal, goldApiIoKey) {
  const endpointUrl =
    "https://www.goldapi.io/api/" + encodeURIComponent(metal) + "/USD";

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