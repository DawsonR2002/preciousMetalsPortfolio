export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code" }, 400);
  }

  const providers = [
    FetchFromGoldPriceOrg,
    FetchFromMetalsLive
  ];

  const results = await Promise.allSettled(
    providers.map(fn => fn(metal))
  );

  const prices = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const price = result.value;
      if (Number.isFinite(price) && price > 0) {
        prices.push(price);
      }
    }
  }

  if (prices.length === 0) {
    return JsonResponse({
      metal,
      priceUsdPerTroyOunce: null,
      usedCount: 0,
      fetchedOkCount: 0,
      updatedAtUtcIso: new Date().toISOString()
    });
  }

  const median = CalculateMedian(prices);

  return JsonResponse({
    metal,
    priceUsdPerTroyOunce: median,
    usedCount: prices.length,
    fetchedOkCount: prices.length,
    updatedAtUtcIso: new Date().toISOString()
  });
}

/* -------------------------------------------------- */
/* Provider 1 — GoldPrice.org */
/* -------------------------------------------------- */

async function FetchFromGoldPriceOrg(metal) {
  const response = await fetch(
    "https://data-asg.goldprice.org/dbXRates/USD",
    { cache: "no-store" }
  );

  if (!response.ok) throw new Error("GoldPrice failed");

  const json = await response.json();

  if (!json || !Array.isArray(json.items)) {
    throw new Error("Invalid GoldPrice format");
  }

  const data = json.items[0];

  if (metal === "XAU") return Number(data.xauPrice);
  if (metal === "XAG") return Number(data.xagPrice);

  throw new Error("Metal not supported");
}

/* -------------------------------------------------- */
/* Provider 2 — Metals.live */
/* -------------------------------------------------- */

async function FetchFromMetalsLive(metal) {
  const response = await fetch(
    "https://api.metals.live/v1/spot",
    { cache: "no-store" }
  );

  if (!response.ok) throw new Error("MetalsLive failed");

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
  const sorted = [...numbersArray].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

/* -------------------------------------------------- */
/* JSON Response */
/* -------------------------------------------------- */

function JsonResponse(object, statusCode = 200) {
  return new Response(JSON.stringify(object), {
    status: statusCode,
    headers: { "Content-Type": "application/json" }
  });
}
