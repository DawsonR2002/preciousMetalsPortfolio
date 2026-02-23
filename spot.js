// functions/api/spot.js

export async function onRequestGet(Context_Object) {
  try {
    const Url_Object = new URL(Context_Object.request.url);
    const MetalRaw_String = (Url_Object.searchParams.get("metal") || "").trim().toUpperCase();

    if (MetalRaw_String !== "XAU" && MetalRaw_String !== "XAG") {
      return JsonResponse_Object(
        {
          error: "Invalid or missing 'metal' query parameter. Use XAU or XAG."
        },
        400
      );
    }

    // ---- Cache for a short time (reduces provider calls) ----
    const CacheKey_String = "spot:" + MetalRaw_String;
    const Cached_Object = await TryReadFromCacheAsync_CacheKey(CacheKey_String);
    if (Cached_Object !== null) {
      return JsonResponse_Object(Cached_Object, 200);
    }

    const OutlierBandFraction_Number = 0.015;

    // Provider list. Add more providers by appending to this array.
    const Providers_Array = [
      {
        source: "gold-api.com",
        isEnabled: true,
        fetchPriceUsdPerTroyOunceAsync: FetchPriceFromGoldApiAsync_MetalCode
      },
      {
        source: "metalpriceapi.com",
        isEnabled: (Context_Object.env && Context_Object.env.METALPRICEAPI_API_KEY) ? true : false,
        fetchPriceUsdPerTroyOunceAsync: FetchPriceFromMetalPriceApiAsync_MetalCode
      }
    ];

    const ProviderResults_Object = await FetchAllProvidersAsync_ProvidersArray_MetalCode_Context(
      Providers_Array,
      MetalRaw_String,
      Context_Object
    );

    const Accepted_Array = ProviderResults_Object.accepted;
    const ProviderErrors_Array = ProviderResults_Object.providerErrors;

    if (Accepted_Array.length === 0) {
      const FailurePayload_Object = BuildFailurePayload_Object_MetalCode_ProviderErrors(
        MetalRaw_String,
        OutlierBandFraction_Number,
        ProviderErrors_Array
      );

      await WriteCacheAsync_CacheKey_Payload(CacheKey_String, FailurePayload_Object, 30);

      // 502 = “bad gateway” = upstream providers failed
      return JsonResponse_Object(FailurePayload_Object, 502);
    }

    const AcceptedPrices_Array = Accepted_Array.map(function MapAcceptedEntryToPrice_Number(Entry_Object) {
      return Number(Entry_Object.price);
    });

    const MedianPrice_Number = ComputeMedian_NumberArray(AcceptedPrices_Array);

    // Apply outlier rejection (simple band around median)
    const FinalAccepted_Array = [];
    const FinalRejected_Array = [];

    for (const Entry_Object of Accepted_Array) {
      const Price_Number = Number(Entry_Object.price);
      const DeviationFraction_Number = Math.abs(Price_Number - MedianPrice_Number) / MedianPrice_Number;

      const NewEntry_Object = {
        source: Entry_Object.source,
        price: Price_Number,
        deviationFraction: DeviationFraction_Number
      };

      if (DeviationFraction_Number <= OutlierBandFraction_Number) {
        FinalAccepted_Array.push(NewEntry_Object);
      } else {
        FinalRejected_Array.push(NewEntry_Object);
      }
    }

    // If everything got rejected, fall back to the raw accepted list
    const UsedAccepted_Array = (FinalAccepted_Array.length > 0) ? FinalAccepted_Array : Accepted_Array;

    const UsedPrices_Array = UsedAccepted_Array.map(function MapEntryToPrice_Number(Entry_Object) {
      return Number(Entry_Object.price);
    });

    const FinalMedianPrice_Number = ComputeMedian_NumberArray(UsedPrices_Array);

    const SuccessPayload_Object = {
      metal: MetalRaw_String,
      priceUsdPerTroyOunce: FinalMedianPrice_Number,
      medianUsdPerTroyOunce: FinalMedianPrice_Number,
      usedCount: UsedAccepted_Array.length,
      fetchedOkCount: UsedAccepted_Array.length,
      outlierBandFraction: OutlierBandFraction_Number,
      accepted: UsedAccepted_Array,
      rejected: FinalRejected_Array,
      providerErrors: ProviderErrors_Array,
      updatedAtUtcIso: new Date().toISOString()
    };

    // Cache briefly so multiple refreshes don’t spam providers
    await WriteCacheAsync_CacheKey_Payload(CacheKey_String, SuccessPayload_Object, 30);

    return JsonResponse_Object(SuccessPayload_Object, 200);
  } catch (Error_Object) {
    return JsonResponse_Object(
      {
        error: "Unhandled server error",
        detail: String(Error_Object)
      },
      500
    );
  }
}

/* -----------------------------
   Providers
------------------------------ */

async function FetchPriceFromGoldApiAsync_MetalCode(MetalCode_String, Context_Object) {
  // This is the endpoint you proved works locally:
  // https://api.gold-api.com/price/XAU or XAG
  const Url_String = "https://api.gold-api.com/price/" + encodeURIComponent(MetalCode_String);

  const Response_Object = await fetch(Url_String, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (Response_Object.ok !== true) {
    throw new Error("HTTP " + String(Response_Object.status));
  }

  const Payload_Object = await Response_Object.json();
  const Price_Number = Number(Payload_Object && Payload_Object.price);

  if (Number.isFinite(Price_Number) !== true || Price_Number <= 0) {
    throw new Error("Invalid price in response");
  }

  return Price_Number;
}

async function FetchPriceFromMetalPriceApiAsync_MetalCode(MetalCode_String, Context_Object) {
  const ApiKey_String = (Context_Object.env && Context_Object.env.METALPRICEAPI_API_KEY)
    ? String(Context_Object.env.METALPRICEAPI_API_KEY).trim()
    : "";

  if (ApiKey_String === "") {
    throw new Error("skipped (missing key)");
  }

  const Url_String =
    "https://api.metalpriceapi.com/v1/latest" +
    "?api_key=" + encodeURIComponent(ApiKey_String) +
    "&base=USD" +
    "&currencies=XAU,XAG";

  const Response_Object = await fetch(Url_String, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (Response_Object.ok !== true) {
    throw new Error("HTTP " + String(Response_Object.status));
  }

  const Payload_Object = await Response_Object.json();
  const Rates_Object = (Payload_Object && Payload_Object.rates) ? Payload_Object.rates : null;

  if (Rates_Object === null || typeof Rates_Object !== "object") {
    throw new Error("Missing rates in response");
  }

  // metalpriceapi uses keys like "USDXAU" and "USDXAG"
  const RateKey_String = "USD" + MetalCode_String;
  const Price_Number = Number(Rates_Object[RateKey_String]);

  if (Number.isFinite(Price_Number) !== true || Price_Number <= 0) {
    throw new Error("Missing/invalid rate key: " + RateKey_String);
  }

  return Price_Number;
}

/* -----------------------------
   Multi-provider fetch wrapper
------------------------------ */

async function FetchAllProvidersAsync_ProvidersArray_MetalCode_Context(Providers_Array, MetalCode_String, Context_Object) {
  const Accepted_Array = [];
  const ProviderErrors_Array = [];

  // Run providers sequentially (simpler + less rate-limit drama)
  for (const Provider_Object of Providers_Array) {
    if (Provider_Object.isEnabled !== true) {
      ProviderErrors_Array.push({
        source: Provider_Object.source,
        error: "skipped (missing key or disabled)",
        skipped: true
      });
      continue;
    }

    try {
      const Price_Number = await Provider_Object.fetchPriceUsdPerTroyOunceAsync(MetalCode_String, Context_Object);

      Accepted_Array.push({
        source: Provider_Object.source,
        price: Price_Number,
        deviationFraction: 0
      });
    } catch (Error_Object) {
      ProviderErrors_Array.push({
        source: Provider_Object.source,
        error: String(Error_Object),
        skipped: false
      });
    }
  }

  return {
    accepted: Accepted_Array,
    providerErrors: ProviderErrors_Array
  };
}

/* -----------------------------
   Cache helpers (30s)
------------------------------ */

async function TryReadFromCacheAsync_CacheKey(CacheKey_String) {
  try {
    const Cache_Object = caches.default;
    const Request_Object = new Request("https://cache.internal/" + CacheKey_String);

    const Response_Object = await Cache_Object.match(Request_Object);
    if (!Response_Object) {
      return null;
    }

    const Payload_Object = await Response_Object.json();
    return Payload_Object;
  } catch {
    return null;
  }
}

async function WriteCacheAsync_CacheKey_Payload(CacheKey_String, Payload_Object, TtlSeconds_Number) {
  try {
    const Cache_Object = caches.default;
    const Request_Object = new Request("https://cache.internal/" + CacheKey_String);

    const Response_Object = new Response(JSON.stringify(Payload_Object), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=" + String(TtlSeconds_Number)
      }
    });

    await Cache_Object.put(Request_Object, Response_Object);
  } catch {
    // If caching fails, we just proceed without it.
  }
}

/* -----------------------------
   Math + responses
------------------------------ */

function ComputeMedian_NumberArray(NumberArray_Array) {
  const Sorted_Array = NumberArray_Array.slice().sort(function CompareNumbers(A_Number, B_Number) {
    return A_Number - B_Number;
  });

  const Count_Number = Sorted_Array.length;
  if (Count_Number === 0) {
    return NaN;
  }

  const MiddleIndex_Number = Math.floor(Count_Number / 2);

  if (Count_Number % 2 === 1) {
    return Sorted_Array[MiddleIndex_Number];
  }

  const LeftMiddle_Number = Sorted_Array[MiddleIndex_Number - 1];
  const RightMiddle_Number = Sorted_Array[MiddleIndex_Number];

  return (LeftMiddle_Number + RightMiddle_Number) / 2;
}

function BuildFailurePayload_Object_MetalCode_ProviderErrors(MetalCode_String, OutlierBandFraction_Number, ProviderErrors_Array) {
  return {
    metal: MetalCode_String,
    priceUsdPerTroyOunce: null,
    medianUsdPerTroyOunce: null,
    usedCount: 0,
    fetchedOkCount: 0,
    outlierBandFraction: OutlierBandFraction_Number,
    accepted: [],
    rejected: [],
    providerErrors: ProviderErrors_Array,
    updatedAtUtcIso: new Date().toISOString()
  };
}

function JsonResponse_Object(Payload_Object, StatusCode_Number) {
  return new Response(JSON.stringify(Payload_Object), {
    status: StatusCode_Number,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}