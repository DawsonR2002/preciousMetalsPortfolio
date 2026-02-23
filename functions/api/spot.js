export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
  }

  const providers = [
    FetchFromGoldPriceOrg_Retail,
    FetchFromStooq_Market
  ];

  const settledResults = await Promise.allSettled(
    providers.map(function ProviderInvoker(providerFunction) {
      return providerFunction(metal);
    })
  );

  // We want to return:
  // - retailPriceUsdPerTroyOunce
  // - marketPriceUsdPerTroyOunce
  // - priceUsdPerTroyOunce (a single “main” value for compatibility)
  //   (For now: if both exist, use the median of both; if one exists, use it.)

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

    // rejected
    providersReport_Array.push({
      name: "(unknown)",
      kind: "(unknown)",
      ok: false,
      error: String(result.reason)
    });
  }

  const collectedPrices_Array = [];

  if (Number.isFinite(retailPriceUsdPerTroyOunce_NumberOrNull) && retailPriceUsdPerTroyOunce_NumberOrNull > 0) {
    collectedPrices_Array.push(retailPriceUsdPerTroyOunce_NumberOrNull);
  }

  if (Number.isFinite(marketPriceUsdPerTroyOunce_NumberOrNull) && marketPriceUsdPerTroyOunce_NumberOrNull > 0) {
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

    // Compatibility field your app already reads:
    priceUsdPerTroyOunce: mainPrice_Number,

    usedCount: collectedPrices_Array.length,
    fetchedOkCount: collectedPrices_Array.length,
    updatedAtUtcIso: new Date().toISOString(),

    // New explicit fields for weighting:
    marketPriceUsdPerTroyOunce: marketPriceUsdPerTroyOunce_NumberOrNull,
    retailPriceUsdPerTroyOunce: retailPriceUsdPerTroyOunce_NumberOrNull,

    // Debug/visibility:
    providers: providersReport_Array
  });
}

/* -------------------------------------------------- */
/* Provider 1 — GoldPrice.org (Retail/Reference)       */
/* -------------------------------------------------- */

async function FetchFromGoldPriceOrg_Retail(metal) {
  const response = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { cache: "no-store" });

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
  // Stooq symbols:
  // XAUUSD = Gold (ozt) / USD
  // XAGUSD = Silver (ozt) / USD
  //
  // We use their CSV endpoint (daily). It returns a header + one row.
  // Example: https://stooq.com/q/l/?s=xauusd&i=d

  let symbol = null;

  if (metal === "XAU") {
    symbol = "xauusd";
  }

  if (metal === "XAG") {
    symbol = "xagusd";
  }

  const endpointUrl =
    "https://stooq.com/q/l/?s=" + encodeURIComponent(symbol) + "&i=d";

  const response = await fetch(endpointUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Stooq failed HTTP " + String(response.status));
  }

  const text = await response.text();

  // CSV format:
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  // XAUUSD,2026-02-23,23:00:00,....,....,....,5227.60,0
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
