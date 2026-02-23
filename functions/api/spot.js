export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metal = String(url.searchParams.get("metal") || "").toUpperCase();

  if (metal !== "XAU" && metal !== "XAG") {
    return JsonResponse({ error: "Invalid metal code" }, 400);
  }

  const providers = BuildProviderList(metal);

  const results = await Promise.allSettled(
    providers.map(p => FetchWithTimeout(p.url, 4000))
  );

  const prices = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (result.status !== "fulfilled") continue;

    try {
      const parsedPrice = providers[i].parse(result.value);
      if (Number.isFinite(parsedPrice) && parsedPrice > 0) {
        prices.push(parsedPrice);
      }
    } catch {
      continue;
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

  // Reject outliers outside ±2%
  const filtered = prices.filter(price => {
    const deviation = Math.abs(price - median) / median;
    return deviation <= 0.02;
  });

  const finalPrices = filtered.length > 0 ? filtered : prices;
  const finalMedian = CalculateMedian(finalPrices);

  return JsonResponse({
    metal,
    priceUsdPerTroyOunce: finalMedian,
    usedCount: finalPrices.length,
    fetchedOkCount: prices.length,
    updatedAtUtcIso: new Date().toISOString()
  });
}

/* -------------------------------------------------- */
/* Provider List */
/* -------------------------------------------------- */

function BuildProviderList(metal) {
  const metalLower = metal.toLowerCase();

  return [
    {
      name: "gold-api",
      url: `https://gold-api.com/price/${metal}`,
      parse: json => Number(json.price)
    },
    {
      name: "gold-api-lowercase",
      url: `https://gold-api.com/price/${metalLower}`,
      parse: json => Number(json.price)
    },
    {
      name: "metalpriceapi-demo",
      url: `https://api.metalpriceapi.com/v1/latest?api_key=demo&base=USD&currencies=${metal}`,
      parse: json => {
        const rate = json && json.rates ? json.rates[metal] : null;
        return rate ? 1 / Number(rate) : NaN;
      }
    }
  ];
}

/* -------------------------------------------------- */
/* Fetch With Timeout */
/* -------------------------------------------------- */

async function FetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(url, {
    method: "GET",
    signal: controller.signal
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return await response.json();
}

/* -------------------------------------------------- */
/* Median Calculation */
/* -------------------------------------------------- */

function CalculateMedian(numbersArray) {
  const sorted = [...numbersArray].sort((a, b) => a - b);
  const middleIndex = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
  }

  return sorted[middleIndex];
}

/* -------------------------------------------------- */
/* JSON Response Helper */
/* -------------------------------------------------- */

function JsonResponse(object, statusCode = 200) {
  return new Response(JSON.stringify(object), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
