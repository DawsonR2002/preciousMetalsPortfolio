import "dotenv/config";
import express from "express";

// -------------------------------
// Environment helpers
// -------------------------------
function ReadEnvString(key, fallbackValue) {
  const value = process.env[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallbackValue;
  }
  return String(value).trim();
}

function ReadEnvNumber(key, fallbackValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallbackValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }
  return parsed;
}

// -------------------------------
// Config
// -------------------------------
const Port_Number = ReadEnvNumber("PORT", 8787);

const CacheTtlMilliseconds_Number = ReadEnvNumber("CACHE_TTL_MS", 60000);
const OutlierBandGold_Fraction = ReadEnvNumber("OUTLIER_BAND_GOLD", 0.01);
const OutlierBandSilver_Fraction = ReadEnvNumber("OUTLIER_BAND_SILVER", 0.02);

// Provider keys (optional)
const MetalsApi_AccessKey_String = ReadEnvString("METALS_API_KEY", "");
const CommoditiesApi_AccessKey_String = ReadEnvString("COMMODITIES_API_KEY", "");
const MetalpriceApi_ApiKey_String = ReadEnvString("METALPRICEAPI_KEY", "");
const MetalsDev_ApiKey_String = ReadEnvString("METALS_DEV_KEY", "");
const CommodityPriceApi_ApiKey_String = ReadEnvString("COMMODITYPRICEAPI_KEY", "");
const GoldApiIo_ApiKey_String = ReadEnvString("GOLDAPI_IO_KEY", "");
const ApiNinjas_ApiKey_String = ReadEnvString("API_NINJAS_KEY", "");

// -------------------------------
// Cache (in-memory)
// -------------------------------
const Cache_ByMetalCode_Map = new Map();
// Cache entry shape:
// { createdAtUtcMs, payloadObject }

function TryGetCache(metalCode) {
  const cached = Cache_ByMetalCode_Map.get(metalCode);
  if (!cached) return null;

  const ageMs = Date.now() - cached.createdAtUtcMs;
  if (ageMs > CacheTtlMilliseconds_Number) {
    Cache_ByMetalCode_Map.delete(metalCode);
    return null;
  }

  return cached.payloadObject;
}

function PutCache(metalCode, payloadObject) {
  Cache_ByMetalCode_Map.set(metalCode, {
    createdAtUtcMs: Date.now(),
    payloadObject: payloadObject
  });
}

// -------------------------------
// Math helpers (robust aggregation)
// -------------------------------
function ComputeMedian(valuesArray) {
  const sorted = [...valuesArray].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;

  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function ComputeMean(valuesArray) {
  if (valuesArray.length === 0) return null;
  let sum = 0;
  for (const v of valuesArray) sum += v;
  return sum / valuesArray.length;
}

function ComputeFractionalDeviation(value, center) {
  if (!Number.isFinite(value) || !Number.isFinite(center) || center === 0) return null;
  return Math.abs(value - center) / center;
}

// -------------------------------
// Provider fetch helpers
// -------------------------------
async function FetchJson(url, headersObject) {
  const response = await fetch(url, {
    method: "GET",
    headers: headersObject ? headersObject : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return await response.json();
}

function CreateProviderResult(sourceName, metalCode, priceNumber) {
  return {
    source: sourceName,
    metal: metalCode,
    priceUsdPerTroyOunce: priceNumber
  };
}

// -------------------------------
// Providers (each returns {source, metal, priceUsdPerTroyOunce})
// Notes:
// - Some providers return "rates" as XAU-per-USD or USD-per-XAU (varies).
//   We'll normalize to USD per troy ounce.
// -------------------------------

async function Provider_GoldApiDotCom(metalCode) {
  // gold-api.com: free "Get Price" endpoint (no auth). Docs show base URL and "Get Price". :contentReference[oaicite:8]{index=8}
  // Endpoint format from their site examples is: https://api.gold-api.com/price/XAU (and XAG).
  const url = "https://api.gold-api.com/price/" + metalCode;
  const json = await FetchJson(url, null);

  const price = Number(json.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Bad price");
  }

  return CreateProviderResult("gold-api.com", metalCode, price);
}

async function Provider_MetalsApiDotCom(metalCode) {
  // metals-api.com: /api/latest?access_key=...&base=USD&symbols=XAU,XAG :contentReference[oaicite:9]{index=9}
  if (!MetalsApi_AccessKey_String) {
    return null;
  }

  const url =
    "https://metals-api.com/api/latest" +
    "?access_key=" + encodeURIComponent(MetalsApi_AccessKey_String) +
    "&base=USD" +
    "&symbols=" + encodeURIComponent(metalCode);

  const json = await FetchJson(url, null);

  // Their docs show "rates" are returned; examples on the site indicate values like XAU per 1 USD,
  // meaning: rates.XAU = XAU per USD. To convert to USD per XAU, do 1 / rate.
  const rate = json && json.rates ? Number(json.rates[metalCode]) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Bad rate");
  }

  const usdPerOunce = 1 / rate;
  return CreateProviderResult("metals-api.com", metalCode, usdPerOunce);
}

async function Provider_CommoditiesApiDotCom(metalCode) {
  // commodities-api.com latest endpoint: /api/latest?access_key=...&base=USD&symbols=... :contentReference[oaicite:10]{index=10}
  if (!CommoditiesApi_AccessKey_String) {
    return null;
  }

  const url =
    "https://commodities-api.com/api/latest" +
    "?access_key=" + encodeURIComponent(CommoditiesApi_AccessKey_String) +
    "&base=USD" +
    "&symbols=" + encodeURIComponent(metalCode);

  const json = await FetchJson(url, null);

  // Similar “rate” convention as metals-api (commonly XAU per USD); normalize the same way.
  const rate = json && json.rates ? Number(json.rates[metalCode]) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Bad rate");
  }

  const usdPerOunce = 1 / rate;
  return CreateProviderResult("commodities-api.com", metalCode, usdPerOunce);
}

async function Provider_MetalpriceApi(metalCode) {
  // MetalpriceAPI: /v1/latest returns "rates" for metals. :contentReference[oaicite:11]{index=11}
  if (!MetalpriceApi_ApiKey_String) {
    return null;
  }

  const url =
    "https://api.metalpriceapi.com/v1/latest" +
    "?api_key=" + encodeURIComponent(MetalpriceApi_ApiKey_String) +
    "&base=USD";

  const json = await FetchJson(url, null);

  const rate = json && json.rates ? Number(json.rates[metalCode]) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Bad rate");
  }

  // MetalpriceAPI returns "rates" as metal per 1 USD in many services. Normalize like above.
  const usdPerOunce = 1 / rate;
  return CreateProviderResult("metalpriceapi.com", metalCode, usdPerOunce);
}

async function Provider_CommodityPriceApi(metalCode) {
  // CommodityPriceAPI: base URL https://api.commoditypriceapi.com/v2 and
  // latest endpoint example uses x-api-key and symbols like xau. :contentReference[oaicite:12]{index=12}
  if (!CommodityPriceApi_ApiKey_String) {
    return null;
  }

  const symbolLower = metalCode.toLowerCase(); // XAU -> xau
  const url =
    "https://api.commoditypriceapi.com/v2/rates/latest" +
    "?symbols=" + encodeURIComponent(symbolLower);

  const headers = {
    "x-api-key": CommodityPriceApi_ApiKey_String
  };

  const json = await FetchJson(url, headers);

  // Their response shape may vary; we handle common patterns:
  // json.data.rates.xau or json.rates.xau, etc.
  let price = NaN;

  if (json && json.data && json.data.rates && json.data.rates[symbolLower] != null) {
    price = Number(json.data.rates[symbolLower]);
  } else if (json && json.rates && json.rates[symbolLower] != null) {
    price = Number(json.rates[symbolLower]);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Bad price");
  }

  // CommodityPriceAPI markets itself as returning prices like USD/T.oz in examples. :contentReference[oaicite:13]{index=13}
  return CreateProviderResult("commoditypriceapi.com", metalCode, price);
}

async function Provider_GoldApiIo(metalCode) {
  // GoldAPI.io example endpoint format: https://www.goldapi.io/api/XAU/USD :contentReference[oaicite:14]{index=14}
  if (!GoldApiIo_ApiKey_String) {
    return null;
  }

  const url = "https://www.goldapi.io/api/" + metalCode + "/USD";
  const headers = {
    "x-access-token": GoldApiIo_ApiKey_String
  };

  const json = await FetchJson(url, headers);

  // GoldAPI.io commonly returns "price"
  const price = Number(json.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Bad price");
  }

  return CreateProviderResult("goldapi.io", metalCode, price);
}

async function Provider_MetalsDev(metalCode) {
  if (!MetalsDev_ApiKey_String) {
    return null;
  }

  const url =
    "https://api.metals.dev/v1/latest" +
    "?api_key=" + encodeURIComponent(MetalsDev_ApiKey_String) +
    "&currency=USD" +
    "&unit=toz";

  const json = await FetchJson(url, null);

  const metalMapKey =
    (metalCode === "XAU") ? "gold"
    : (metalCode === "XAG") ? "silver"
    : null;

  if (!metalMapKey) {
    throw new Error("Unsupported metal code for Metals.dev: " + metalCode);
  }

  const price = (json && json.metals && json.metals[metalMapKey] != null)
    ? Number(json.metals[metalMapKey])
    : NaN;

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Bad price from Metals.dev");
  }

  return CreateProviderResult("metals.dev", metalCode, price);
}

async function Provider_ApiNinjas_CommodityPrice(metalCode) {
  // API Ninjas commodity price is futures-based and depends on its symbol catalog. :contentReference[oaicite:16]{index=16}
  if (!ApiNinjas_ApiKey_String) {
    return null;
  }

  // Many futures symbols won't map 1:1 to XAU/XAG spot. Treat as optional/experimental.
  // Leaving as disabled by default.
  return null;
}

// -------------------------------
// Provider runner
// -------------------------------
function GetProvidersArray() {
  // Add more providers here over time.
  return [
    { name: "gold-api.com", func: Provider_GoldApiDotCom },
    { name: "metals-api.com", func: Provider_MetalsApiDotCom },
    { name: "commodities-api.com", func: Provider_CommoditiesApiDotCom },
    { name: "metalpriceapi.com", func: Provider_MetalpriceApi },
    { name: "commoditypriceapi.com", func: Provider_CommodityPriceApi },
    { name: "goldapi.io", func: Provider_GoldApiIo },
    { name: "metals.dev", func: Provider_MetalsDev },
    { name: "api-ninjas", func: Provider_ApiNinjas_CommodityPrice }
  ];
}

async function FetchQuotesForMetalAsync(metalCode) {
  const providers = GetProvidersArray();

  const tasks = [];
  for (const provider of providers) {
    tasks.push((async () => {
      try {
        const result = await provider.func(metalCode);
        if (result === null) {
          return { ok: false, skipped: true, source: provider.name, error: "skipped (missing key or disabled)" };
        }
        return { ok: true, skipped: false, source: provider.name, value: result.priceUsdPerTroyOunce };
      } catch (err) {
        return { ok: false, skipped: false, source: provider.name, error: String(err && err.message ? err.message : err) };
      }
    })());
  }

  const results = await Promise.all(tasks);

  const okValues = [];
  const okDetails = [];
  const errors = [];

  for (const r of results) {
    if (r.ok) {
      okValues.push(r.value);
      okDetails.push({ source: r.source, price: r.value });
    } else {
      errors.push({ source: r.source, error: r.error, skipped: r.skipped });
    }
  }

  return { okValues, okDetails, errors };
}

function AggregateQuotes(metalCode, okDetails, outlierBandFraction) {
  const values = okDetails.map(x => x.price).filter(x => Number.isFinite(x) && x > 0);

  const median = ComputeMedian(values);
  if (median === null) {
    return {
      metal: metalCode,
      aggregatedPrice: null,
      median: null,
      usedCount: 0,
      totalCount: okDetails.length,
      accepted: [],
      rejected: []
    };
  }

  const accepted = [];
  const rejected = [];

  for (const q of okDetails) {
    const deviation = ComputeFractionalDeviation(q.price, median);
    if (deviation === null) {
      rejected.push({ source: q.source, price: q.price, reason: "invalid deviation" });
      continue;
    }

    if (deviation <= outlierBandFraction) {
      accepted.push({ source: q.source, price: q.price, deviationFraction: deviation });
    } else {
      rejected.push({ source: q.source, price: q.price, deviationFraction: deviation, reason: "outlier" });
    }
  }

  const acceptedValues = accepted.map(x => x.price);
  const meanAccepted = ComputeMean(acceptedValues);

  return {
    metal: metalCode,
    aggregatedPrice: meanAccepted,
    median: median,
    usedCount: accepted.length,
    totalCount: okDetails.length,
    accepted: accepted,
    rejected: rejected
  };
}

// -------------------------------
// Express app
// -------------------------------
const app = express();

app.use(function PreciousMetalsPortfolio_CorsMiddleware_AllowLocalDevOrigins_AndPreflightRequests(req, res, next) {

  // In dev, your PWA is served from: http://127.0.0.1:5500
  // Your backend is:              http://localhost:8787
  //
  // Browsers treat 127.0.0.1 and localhost as DIFFERENT origins,
  // so we allow both for local development.

  const origin = req.headers.origin;

  if (origin === "http://127.0.0.1:5500" || origin === "http://localhost:5500") {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // If you want to be lazy in dev, you can allow all:
  // res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.get("/api/spot", async (req, res) => {
  const metalCodeRaw = String(req.query.metal || "").toUpperCase().trim();

  if (metalCodeRaw !== "XAU" && metalCodeRaw !== "XAG") {
    res.status(400).json({ error: "metal must be XAU or XAG" });
    return;
  }

  const cached = TryGetCache(metalCodeRaw);
  if (cached) {
    res.json(cached);
    return;
  }

  const outlierBand = metalCodeRaw === "XAU" ? OutlierBandGold_Fraction : OutlierBandSilver_Fraction;

  const fetched = await FetchQuotesForMetalAsync(metalCodeRaw);

  const aggregate = AggregateQuotes(metalCodeRaw, fetched.okDetails, outlierBand);

  const payload = {
    metal: metalCodeRaw,
    priceUsdPerTroyOunce: aggregate.aggregatedPrice,
    medianUsdPerTroyOunce: aggregate.median,
    usedCount: aggregate.usedCount,
    fetchedOkCount: aggregate.totalCount,
    outlierBandFraction: outlierBand,
    accepted: aggregate.accepted,
    rejected: aggregate.rejected,
    providerErrors: fetched.errors,
    updatedAtUtcIso: new Date().toISOString()
  };

  PutCache(metalCodeRaw, payload);

  res.json(payload);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, timeUtcIso: new Date().toISOString() });
});

app.listen(Port_Number, () => {
  console.log("Spot aggregator listening on http://localhost:" + Port_Number);
});