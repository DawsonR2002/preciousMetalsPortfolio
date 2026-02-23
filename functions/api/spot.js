export async function onRequest(context) {
  try {
    const requestUrl = new URL(context.request.url);
    const metal = String(requestUrl.searchParams.get("metal") || "").toUpperCase();

    if (metal !== "XAU" && metal !== "XAG") {
      return JsonResponse({ error: "Invalid metal code. Use XAU or XAG." }, 400);
    }

    // IMPORTANT:
    // Use the global fetch directly, but we also run one tiny sanity fetch first.
    // If THIS fails, something is deeply wrong, and we will report it clearly.
    const sanity = await fetch("https://example.com", { cache: "no-store" });
    if (!sanity || !sanity.ok) {
      return JsonResponse(
        {
          metal: metal,
          error: "Sanity fetch failed unexpectedly",
          sanityStatus: sanity ? sanity.status : null
        },
        500
      );
    }

    const providers = [
      { name: "GoldPrice", kind: "retail", fn: FetchFromGoldPriceOrg },
      { name: "MetalsLive", kind: "market", fn: FetchFromMetalsLive }
    ];

    const results = await Promise.allSettled(
      providers.map(async function (provider) {
        const price = await provider.fn(metal);
        return { provider: provider, price: price };
      })
    );

    let retailPriceUsdPerTroyOunce = null;
    let marketPriceUsdPerTroyOunce = null;

    const pricesAllOk = [];
    const providerReports = [];

    for (let i = 0; i < results.length; i++) {
      const providerInfo = providers[i];
      const result = results[i];

      if (result.status === "fulfilled") {
        const price = Number(result.value.price);

        if (Number.isFinite(price) && price > 0) {
          pricesAllOk.push(price);

          if (providerInfo.kind === "retail") {
            retailPriceUsdPerTroyOunce = price;
          }
          if (providerInfo.kind === "market") {
            marketPriceUsdPerTroyOunce = price;
          }

          providerReports.push({
            name: providerInfo.name,
            kind: providerInfo.kind,
            ok: true,
            price: price
          });
        } else {
          providerReports.push({
            name: providerInfo.name,
            kind: providerInfo.kind,
            ok: false,
            error: "Invalid numeric price"
          });
        }
      } else {
        providerReports.push({
          name: providerInfo.name,
          kind: providerInfo.kind,
          ok: false,
          error: String(result.reason)
        });
      }
    }

    let priceUsdPerTroyOunce = null;
    if (pricesAllOk.length > 0) {
      priceUsdPerTroyOunce = CalculateMedian(pricesAllOk);
    }

    return JsonResponse({
      metal: metal,
      priceUsdPerTroyOunce: priceUsdPerTroyOunce,
      usedCount: pricesAllOk.length,
      fetchedOkCount: pricesAllOk.length,
      updatedAtUtcIso: new Date().toISOString(),

      marketPriceUsdPerTroyOunce: marketPriceUsdPerTroyOunce,
      retailPriceUsdPerTroyOunce: retailPriceUsdPerTroyOunce,

      providers: providerReports
    });
  } catch (err) {
    return JsonResponse(
      {
        error: "Unhandled exception in /api/spot",
        message: String(err),
        stack: (err && err.stack) ? String(err.stack) : null
      },
      500
    );
  }
}

/* -------------------------------------------------- */
/* Provider 1 — GoldPrice.org                          */
/* -------------------------------------------------- */

async function FetchFromGoldPriceOrg(metal) {
  const response = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("GoldPrice failed HTTP " + response.status);
  }

  const json = await response.json();

  if (!json || !Array.isArray(json.items) || json.items.length === 0) {
    throw new Error("Invalid GoldPrice format");
  }

  const data = json.items[0];

  if (metal === "XAU") {
    return Number(data.xauPrice);
  }

  if (metal === "XAG") {
    return Number(data.xagPrice);
  }

  throw new Error("Metal not supported");
}

/* -------------------------------------------------- */
/* Provider 2 — Metals.live                            */
/* -------------------------------------------------- */

async function FetchFromMetalsLive(metal) {
  const response = await fetch("https://api.metals.live/v1/spot", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("MetalsLive failed HTTP " + response.status);
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
      return price;
    }

    if (metal === "XAG" && symbol === "silver") {
      return price;
    }
  }

  throw new Error("Metal not found");
}

/* -------------------------------------------------- */
/* Median                                              */
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
/* JSON Response                                       */
/* -------------------------------------------------- */

function JsonResponse(object, statusCode) {
  const code = Number.isFinite(Number(statusCode)) ? Number(statusCode) : 200;

  return new Response(JSON.stringify(object), {
    status: code,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
