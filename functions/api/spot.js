// functions/api/spot.js

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase().trim();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
  }

  // --------------------------------------------------
  // Providers
  // Keep the current ones, add old ones without removing.
  // Each provider returns: { name, kind, price }
  // where kind is "retail" or "market".
  // --------------------------------------------------

  const providers = [
    // Current
    FetchFromGoldPriceOrg_Retail,
    FetchFromStooq_Market,

    // Old (added back)
    FetchFromGoldApiDotCom_Market,
    FetchFromMetalsLive_Market
  ];

  // Run them all in parallel
  const settledResults = await Promise.allSettled(
    providers.map(function ProviderInvoker(providerFunction) {
      return providerFunction(metal);
    })
  );

  // We want to return:
  // - retailPriceUsdPerTroyOunce (retail/reference)
  // - marketPriceUsdPerTroyOunce (market headline-ish)
  // - priceUsdPerTroyOunce (compat main)
  //
  // For the "main" value:
  // - If we have BOTH buckets, we use median of [marketMedian, retailMedian]
  // - If only one bucket exists, we use that bucket's median
  //
  // This preserves your ability to bias/weight in app.js using explicit fields,
  // while still keeping backward compatibility.

  const retailPrices_Array = [];
  const marketPrices_Array = [];
  const providersReport_Array = [];

  for (let i = 0; i < settledResults.length; i += 1) {
    const result = settledResults[i];
    const providerFunction = providers[i];

    // Each providerFunction has ProviderInfo attached for better error reporting.
    const providerName = providerFunction.ProviderInfo_Name || "(unknown)";
    const providerKind = providerFunction.ProviderInfo_Kind || "(unknown)";

    if (result.status === "fulfilled") {
      const payload = result.value;

      providersReport_Array.push({
        name: payload.name,
        kind: payload.kind,
        ok: true,
        price: payload.price
      });

      if (payload.kind === "retail") {
        retailPrices_Array.push(payload.price);
      }

      if (payload.kind === "market") {
        marketPrices_Array.push(payload.price);
      }

      continue;
    }

    // rejected
    providersReport_Array.push({
      name: providerName,
      kind: providerKind,
      ok: false,
      error: String(result.reason)
    });
  }

  const retailMedian_NumberOrNull =
    (retailPrices_Array.length > 0) ? CalculateMedian(retailPrices_Array) : null;

  const marketMedian_NumberOrNull =
    (marketPrices_Array.length > 0) ? CalculateMedian(marketPrices_Array) : null;

  if (
    (!Number.isFinite(retailMedian_NumberOrNull) || retailMedian_NumberOrNull <= 0) &&
    (!Number.isFinite(marketMedian_NumberOrNull) || marketMedian_NumberOrNull <= 0)
  ) {
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

  // "Main" compatibility value:
  // - If both exist: median of the two medians
  // - Else: the one that exists
  const mainCandidates_Array = [];

  if (Number.isFinite(marketMedian_NumberOrNull) && marketMedian_NumberOrNull > 0) {
    mainCandidates_Array.push(marketMedian_NumberOrNull);
  }

  if (Number.isFinite(retailMedian_NumberOrNull) && retailMedian_NumberOrNull > 0) {
    mainCandidates_Array.push(retailMedian_NumberOrNull);
  }

  const mainPrice_Number =
    (mainCandidates_Array.length > 0)
      ? CalculateMedian(mainCandidates_Array)
      : null;

  const fetchedOkCount_Number = retailPrices_Array.length + marketPrices_Array.length;

  return JsonResponse({
    metal: metal,

    // Compatibility field your app already reads:
    priceUsdPerTroyOunce: mainPrice_Number,

    usedCount: fetchedOkCount_Number,
    fetchedOkCount: fetchedOkCount_Number,
    updatedAtUtcIso: new Date().toISOString(),

    // Explicit bucket medians:
    marketPriceUsdPerTroyOunce: marketMedian_NumberOrNull,
    retailPriceUsdPerTroyOunce: retailMedian_NumberOrNull,

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
FetchFromGoldPriceOrg_Retail.ProviderInfo_Name = "GoldPrice";
FetchFromGoldPriceOrg_Retail.ProviderInfo_Kind = "retail";

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

  const endpointUrl =
    "https://stooq.com/q/l/?s=" + encodeURIComponent(symbol) + "&i=d";

  const response = await fetch(endpointUrl, { cache: "no-store" });

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
FetchFromStooq_Market.ProviderInfo_Name = "Stooq";
FetchFromStooq_Market.ProviderInfo_Kind = "market";

/* -------------------------------------------------- */
/* Provider 3 — gold-api.com (Market-ish)              */
/* -------------------------------------------------- */

async function FetchFromGoldApiDotCom_Market(metal) {
  const endpointUrl =
    "https://api.gold-api.com/price/" + encodeURIComponent(metal);

  const response = await fetch(endpointUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("gold-api.com failed HTTP " + String(response.status));
  }

  const json = await response.json();

  const price = Number(json && json.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("gold-api.com returned invalid price");
  }

  return {
    name: "gold-api.com",
    kind: "market",
    price: price
  };
}
FetchFromGoldApiDotCom_Market.ProviderInfo_Name = "gold-api.com";
FetchFromGoldApiDotCom_Market.ProviderInfo_Kind = "market";

/* -------------------------------------------------- */
/* Provider 4 — metals.live (Market-ish)               */
/* -------------------------------------------------- */

async function FetchFromMetalsLive_Market(metal) {
  const response = await fetch("https://api.metals.live/v1/spot", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("MetalsLive failed HTTP " + String(response.status));
  }

  const json = await response.json();

  if (!Array.isArray(json)) {
    throw new Error("Invalid MetalsLive format");
  }

  for (const row of json) {
    if (!Array.isArray(row) || row.length !== 2) continue;

    const symbol = String(row[0]).toLowerCase();
    const price = Number(row[1]);

    if (metal === "XAU" && symbol === "gold") {
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("MetalsLive invalid gold price");
      }
      return {
        name: "metals.live",
        kind: "market",
        price: price
      };
    }

    if (metal === "XAG" && symbol === "silver") {
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("MetalsLive invalid silver price");
      }
      return {
        name: "metals.live",
        kind: "market",
        price: price
      };
    }
  }

  throw new Error("MetalsLive metal not found");
}
FetchFromMetalsLive_Market.ProviderInfo_Name = "metals.live";
FetchFromMetalsLive_Market.ProviderInfo_Kind = "market";

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
