"use strict";

// --------------------------------------------------
// DOM elements
// --------------------------------------------------

const Status_Element = document.getElementById("Status_Element");
const LastUpdated_Element = document.getElementById("LastUpdated_Element");
const HoldingsContainer_Element = document.getElementById("HoldingsContainer_Element");
const Totals_Element = document.getElementById("Totals_Element");

const PurchaseHistoryContainer_Element = document.getElementById("PurchaseHistoryContainer_Element");

const RefreshSpotPrices_Button = document.getElementById("RefreshSpotPrices_Button");
const ApplyAllChanges_Button = document.getElementById("ApplyAllChanges_Button");
const ResetSavedData_Button = document.getElementById("ResetSavedData_Button");
const DownloadCsv_Button = document.getElementById("DownloadCsv_Button");

// --------------------------------------------------
// Bias UI elements (safe if not present yet)
// --------------------------------------------------

const BiasTowardRetailPercent_Slider = document.getElementById("BiasTowardRetailPercent_Slider");
const BiasMarketPercent_Label = document.getElementById("BiasMarketPercent_Label");
const BiasRetailPercent_Label = document.getElementById("BiasRetailPercent_Label");
const BiasAdjustedSpotPrice_Label = document.getElementById("BiasAdjustedSpotPrice_Label");

// --------------------------------------------------
// Storage keys (localStorage = long-term memory)
// --------------------------------------------------

// Draft edits: what Mom is typing in right now (NOT committed to “owned” until Apply is clicked)
const StorageKey_DraftEdits_ByHoldingId_Object = "draft_edits_v1_units_purchase_and_price";

// Owned portfolio state: committed “truth” about what is owned and what was paid
const StorageKey_OwnedState_ByHoldingId_Object = "owned_state_v1_units_totalpaid_lastprice";

// Purchase history ledger: every “Apply Purchase” becomes a row here (so we can delete/undo)
const StorageKey_PurchaseHistory_Array = "purchase_history_v1_ledger_rows";

// Spot cache (offline fallback)
const StorageKey_SpotCache = "cached_spot_prices_v1";

// Bias storage key (int percent toward Retail)
const StorageKey_BiasTowardRetailPercent_Int = "bias_toward_retail_percent_v1";

// --------------------------------------------------
// Backend
// --------------------------------------------------

const BackendBaseUrl_String = "";
//const BackendBaseUrl_String = "http://localhost:8787";

// --------------------------------------------------
// Runtime UI references (so Apply All can commit even if inputs never blurred)
// --------------------------------------------------

const CurrentRenderedInputs_ByHoldingId_Object = {};

// --------------------------------------------------
// Holdings Catalog
// --------------------------------------------------

const HoldingsCatalog_Array = [
  {
    HoldingId: "gold_eagle_1oz_2010",
    DisplayName: "Gold American Eagle 1 oz (2010)",
    MetalCode_String: "XAU",
    OuncesPerUnit_Number: 1.0,
    Purchases: [
      { Units: 5, PricePerUnit: 2429.13, TotalPaid_LimitedToSpecificPurchases: 12145.65 }
    ],
    MarketPricePerUnit_Default_Number: 5011.30
  },
  {
    HoldingId: "silver_bar_highland_mint_buffalo_10oz",
    DisplayName: "Silver Bar Highland Mint Buffalo 10oz",
    MetalCode_String: "XAG",
    OuncesPerUnit_Number: 10.0,
    Purchases: [
      { Units: 31, PricePerUnit: 299.89, TotalPaid_LimitedToSpecificPurchases: 9296.59 }
    ],
    MarketPricePerUnit_Default_Number: 807.06
  },
  {
    HoldingId: "silver_bar_golden_state_mint_10oz",
    DisplayName: "Silver Bar Golden State Mint 10oz",
    MetalCode_String: "XAG",
    OuncesPerUnit_Number: 10.0,
    Purchases: [
      { Units: 84, PricePerUnit: 299.89, TotalPaid_LimitedToSpecificPurchases: 25190.76 }
    ],
    MarketPricePerUnit_Default_Number: 807.06
  },
  {
    HoldingId: "silver_round_asahi_1oz",
    DisplayName: "Silver Round Asahi 1 Oz",
    MetalCode_String: "XAG",
    OuncesPerUnit_Number: 1.0,
    Purchases: [
      { Units: 229, PricePerUnit: 32.23, TotalPaid_LimitedToSpecificPurchases: 9636.32 }
    ],
    MarketPricePerUnit_Default_Number: 80.71
  },
  {
    HoldingId: "gold_st_helena_eagle_snake_1_4oz",
    DisplayName: "Gold St Helena Eagle & Snake 1/4oz",
    MetalCode_String: "XAU",
    OuncesPerUnit_Number: 0.25,
    Purchases: [
      { Units: 30, PricePerUnit: 977.74, TotalPaid_LimitedToSpecificPurchases: 29332.20 }
    ],
    MarketPricePerUnit_Default_Number: 1252.82
  },
  {
    HoldingId: "silver_bar_10oz_jbr",
    DisplayName: "Silver Bar 10oz JBR",
    MetalCode_String: "XAG",
    OuncesPerUnit_Number: 10.0,
    Purchases: [
      { Units: 64, PricePerUnit: 426.96, TotalPaid_LimitedToSpecificPurchases: 27325.44 }
    ],
    MarketPricePerUnit_Default_Number: 807.06
  }
];

// --------------------------------------------------
// Purchases helpers (seed calculations)
// --------------------------------------------------

function CalculatePurchases_TotalUnits_Number(purchasesArray) {
  let sum = 0;

  if (!Array.isArray(purchasesArray)) {
    return 0;
  }

  for (const purchase of purchasesArray) {
    const units = Number(purchase && purchase.Units != null ? purchase.Units : 0);
    if (Number.isFinite(units) && units > 0) {
      sum += units;
    }
  }

  return sum;
}

function CalculatePurchases_TotalPaid_Number(purchasesArray) {
  let sum = 0;

  if (!Array.isArray(purchasesArray)) {
    return 0;
  }

  for (const purchase of purchasesArray) {
    const explicitTotalPaid = Number(
      purchase && purchase.TotalPaid_LimitedToSpecificPurchases != null
        ? purchase.TotalPaid_LimitedToSpecificPurchases
        : NaN
    );

    if (Number.isFinite(explicitTotalPaid) && explicitTotalPaid >= 0) {
      sum += explicitTotalPaid;
      continue;
    }

    const units = Number(purchase && purchase.Units != null ? purchase.Units : 0);
    const pricePerUnit = Number(purchase && purchase.PricePerUnit != null ? purchase.PricePerUnit : 0);

    if (Number.isFinite(units) && Number.isFinite(pricePerUnit) && units > 0 && pricePerUnit >= 0) {
      sum += (units * pricePerUnit);
    }
  }

  return sum;
}

// --------------------------------------------------
// Draft edits
// --------------------------------------------------

function CreateDefaultDraftEdits_Object() {
  return {
    UnitsBeingPurchasedNow_Number: 0,
    MarketPricePerUnit_Input_Number: 0
  };
}

function LoadDraftEdits_ByHoldingId_Object() {
  const raw = localStorage.getItem(StorageKey_DraftEdits_ByHoldingId_Object);
  if (!raw) return {};

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
    return {};
  } catch {
    return {};
  }
}

function SaveDraftEdits_ByHoldingId_Object(draftEditsByHoldingId_Object) {
  localStorage.setItem(StorageKey_DraftEdits_ByHoldingId_Object, JSON.stringify(draftEditsByHoldingId_Object));
}

// --------------------------------------------------
// Owned state
// --------------------------------------------------

function CreateOwnedState_DefaultForHolding_FromCatalog(holdingObject) {
  const unitsOwned = CalculatePurchases_TotalUnits_Number(holdingObject.Purchases);
  const totalPaid = CalculatePurchases_TotalPaid_Number(holdingObject.Purchases);

  const defaultLastPrice =
    (Number.isFinite(Number(holdingObject.MarketPricePerUnit_Default_Number)) && Number(holdingObject.MarketPricePerUnit_Default_Number) > 0)
      ? Number(holdingObject.MarketPricePerUnit_Default_Number)
      : 0;

  return {
    UnitsOwned_Number: unitsOwned,
    TotalPaidOwned_Number: totalPaid,
    LastKnownMarketPricePerUnit_Number: defaultLastPrice
  };
}

function LoadOwnedState_ByHoldingId_Object() {
  const raw = localStorage.getItem(StorageKey_OwnedState_ByHoldingId_Object);
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
    return null;
  } catch {
    return null;
  }
}

function SaveOwnedState_ByHoldingId_Object(ownedStateByHoldingId_Object) {
  localStorage.setItem(StorageKey_OwnedState_ByHoldingId_Object, JSON.stringify(ownedStateByHoldingId_Object));
}

function EnsureOwnedStateSeeded_FromCatalogIfMissing() {
  const existing = LoadOwnedState_ByHoldingId_Object();
  if (existing != null) {
    return;
  }

  const seeded = {};

  for (const holding of HoldingsCatalog_Array) {
    seeded[holding.HoldingId] = CreateOwnedState_DefaultForHolding_FromCatalog(holding);
  }

  SaveOwnedState_ByHoldingId_Object(seeded);
}

// --------------------------------------------------
// Purchase history ledger
// --------------------------------------------------

function LoadPurchaseHistory_Array() {
  const raw = localStorage.getItem(StorageKey_PurchaseHistory_Array);
  if (!raw) return [];

  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch {
    return [];
  }
}

function SavePurchaseHistory_Array(historyArray) {
  localStorage.setItem(StorageKey_PurchaseHistory_Array, JSON.stringify(historyArray));
}

function CreatePurchaseRecord_Object(holdingId_String, unitsPurchased_Number, pricePerUnit_Number) {
  const totalCost = unitsPurchased_Number * pricePerUnit_Number;

  return {
    PurchaseId_String: "p_" + Date.now().toString() + "_" + Math.floor(Math.random() * 1000000).toString(),
    HoldingId_String: holdingId_String,
    PurchasedAtUtcIso_String: new Date().toISOString(),
    UnitsPurchased_Number: unitsPurchased_Number,
    PricePerUnit_Number: pricePerUnit_Number,
    TotalCost_Number: totalCost
  };
}

function AppendPurchaseRecord_ToHistory(holdingId_String, unitsPurchased_Number, pricePerUnit_Number) {
  const history = LoadPurchaseHistory_Array();
  const record = CreatePurchaseRecord_Object(holdingId_String, unitsPurchased_Number, pricePerUnit_Number);
  history.push(record);
  SavePurchaseHistory_Array(history);
}

function FindHolding_DisplayName(holdingId_String) {
  for (const holding of HoldingsCatalog_Array) {
    if (holding.HoldingId === holdingId_String) {
      return holding.DisplayName;
    }
  }
  return holdingId_String;
}

function FindHolding_MetalCode_String(holdingId_String) {
  for (let i = 0; i < HoldingsCatalog_Array.length; i += 1) {
    const holding = HoldingsCatalog_Array[i];
    if (holding.HoldingId === holdingId_String) {
      return holding.MetalCode_String;
    }
  }
  return "";
}

function FindHolding_OuncesPerUnit_Number(holdingId_String) {
  for (let i = 0; i < HoldingsCatalog_Array.length; i += 1) {
    const holding = HoldingsCatalog_Array[i];
    if (holding.HoldingId === holdingId_String) {
      return Number(holding.OuncesPerUnit_Number);
    }
  }
  return null;
}

function DeletePurchaseRecord_AndReverseOwnedImpact(purchaseId_String) {
  const history = LoadPurchaseHistory_Array();
  const ownedState = LoadOwnedState_ByHoldingId_Object();
  if (ownedState == null) return;

  let recordToDelete = null;
  const nextHistory = [];

  for (const record of history) {
    if (record && record.PurchaseId_String === purchaseId_String) {
      recordToDelete = record;
      continue;
    }
    nextHistory.push(record);
  }

  if (recordToDelete == null) {
    return;
  }

  const holdingId = String(recordToDelete.HoldingId_String || "");
  const units = Number(recordToDelete.UnitsPurchased_Number);
  const totalCost = Number(recordToDelete.TotalCost_Number);

  if (ownedState[holdingId] != null) {
    const owned = ownedState[holdingId];

    const currentUnitsOwned = Number(owned.UnitsOwned_Number) || 0;
    const currentTotalPaid = Number(owned.TotalPaidOwned_Number) || 0;

    const nextUnitsOwned = currentUnitsOwned - (Number.isFinite(units) ? units : 0);
    const nextTotalPaid = currentTotalPaid - (Number.isFinite(totalCost) ? totalCost : 0);

    owned.UnitsOwned_Number = nextUnitsOwned < 0 ? 0 : nextUnitsOwned;
    owned.TotalPaidOwned_Number = nextTotalPaid < 0 ? 0 : nextTotalPaid;

    ownedState[holdingId] = owned;
    SaveOwnedState_ByHoldingId_Object(ownedState);
  }

  SavePurchaseHistory_Array(nextHistory);
}

function UndoLastPurchase_ForHoldingId(holdingId_String) {
  const history = LoadPurchaseHistory_Array();

  let newest = null;

  for (const record of history) {
    if (!record) continue;
    if (record.HoldingId_String !== holdingId_String) continue;

    if (newest == null) {
      newest = record;
      continue;
    }

    const a = String(newest.PurchasedAtUtcIso_String || "");
    const b = String(record.PurchasedAtUtcIso_String || "");
    if (b > a) {
      newest = record;
    }
  }

  if (newest == null) {
    return;
  }

  DeletePurchaseRecord_AndReverseOwnedImpact(newest.PurchaseId_String);
}

// --------------------------------------------------
// Bias helpers (INT ONLY)
// --------------------------------------------------

function ClampInt_0To100(value_Int) {
  const n = Number(value_Int);
  if (!Number.isFinite(n)) return 0;

  const floored = Math.floor(n);

  if (floored < 0) return 0;
  if (floored > 100) return 100;

  return floored;
}

function LoadBiasTowardRetailPercent_Int() {
  const raw = localStorage.getItem(StorageKey_BiasTowardRetailPercent_Int);
  if (raw == null) return 0;

  return ClampInt_0To100(raw);
}

function SaveBiasTowardRetailPercent_Int(value_Int) {
  const clamped = ClampInt_0To100(value_Int);
  localStorage.setItem(StorageKey_BiasTowardRetailPercent_Int, String(clamped));
}

function UpdateBiasUi_FromStoredValue() {
  if (!BiasTowardRetailPercent_Slider || !BiasMarketPercent_Label || !BiasRetailPercent_Label) {
    return;
  }

  const retailPercent_Int = LoadBiasTowardRetailPercent_Int();
  const marketPercent_Int = 100 - retailPercent_Int;

  BiasTowardRetailPercent_Slider.value = String(retailPercent_Int);
  BiasMarketPercent_Label.textContent = "Market Spot: " + String(marketPercent_Int) + "%";
  BiasRetailPercent_Label.textContent = "Bullion Retail: " + String(retailPercent_Int) + "%";
}

function CalculateAdjustedSpotPrice_Number_FromMarketAndRetail(
  marketSpotPricePerOunce_NumberOrNull,
  retailSpotPricePerOunce_NumberOrNull,
  biasTowardRetailPercent_Int
) {
  const market = Number(marketSpotPricePerOunce_NumberOrNull);
  const retail = Number(retailSpotPricePerOunce_NumberOrNull);

  const marketOk = Number.isFinite(market) && market > 0;
  const retailOk = Number.isFinite(retail) && retail > 0;

  if (!marketOk && !retailOk) {
    return null;
  }

  if (marketOk && !retailOk) {
    return market;
  }

  if (!marketOk && retailOk) {
    return retail;
  }

  const wRetail_Int = ClampInt_0To100(biasTowardRetailPercent_Int);

  return market + ((retail - market) * wRetail_Int / 100);
}

// --------------------------------------------------
// CSV export (Download)
// --------------------------------------------------

function EscapeCsvField(rawValue) {
  const s = String(rawValue == null ? "" : rawValue);

  const mustQuote =
    s.indexOf(",") >= 0 ||
    s.indexOf('"') >= 0 ||
    s.indexOf("\r") >= 0 ||
    s.indexOf("\n") >= 0;

  if (!mustQuote) {
    return s;
  }

  const escapedQuotes = s.replace(/"/g, '""');
  return '"' + escapedQuotes + '"';
}

function ConvertRowsToCsvText(headerColumns_Array, rows_ArrayOfObjects) {
  const lines_Array = [];

  lines_Array.push(
    headerColumns_Array.map(function HeaderColumnMap(col) {
      return EscapeCsvField(col);
    }).join(",")
  );

  for (let i = 0; i < rows_ArrayOfObjects.length; i += 1) {
    const rowObject = rows_ArrayOfObjects[i];

    const rowLine = headerColumns_Array.map(function RowColumnMap(col) {
      return EscapeCsvField(rowObject[col]);
    }).join(",");

    lines_Array.push(rowLine);
  }

  return lines_Array.join("\r\n") + "\r\n";
}

function DownloadTextFile_AsBrowserDownload(filename_String, mimeType_String, textContent_String) {
  const blob = new Blob([textContent_String], { type: mimeType_String });
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename_String;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(objectUrl);
}

function GetUtcTimestampForFilename_String() {
  const iso = new Date().toISOString();
  return iso.replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function CalculateTotalPaidFromLedger_ForHoldingId_NumberOrNull(purchaseHistory_Array, holdingId_String) {
  if (!Array.isArray(purchaseHistory_Array)) {
    return null;
  }

  let sum = 0;
  let sawAny = false;

  for (let i = 0; i < purchaseHistory_Array.length; i += 1) {
    const record = purchaseHistory_Array[i];
    if (!record) continue;

    if (String(record.HoldingId_String || "") !== String(holdingId_String || "")) {
      continue;
    }

    const totalCost = Number(record.TotalCost_Number);
    if (Number.isFinite(totalCost) && totalCost >= 0) {
      sum += totalCost;
      sawAny = true;
    }
  }

  return sawAny ? sum : null;
}

function GetOwnedTotalPaidUsd_ForHolding_NumberOrNull(ownedObject, purchaseHistory_Array, holdingId_String) {
  const direct = Number(ownedObject && ownedObject.TotalPaidOwned_Number != null ? ownedObject.TotalPaidOwned_Number : NaN);
  if (Number.isFinite(direct) && direct >= 0) {
    return direct;
  }

  const computed = CalculateTotalPaidFromLedger_ForHoldingId_NumberOrNull(purchaseHistory_Array, holdingId_String);
  if (Number.isFinite(computed) && computed >= 0) {
    return computed;
  }

  return null;
}

function GetSpotPricePerOunce_ForHolding(holdingObject, spotCacheObject) {
  if (!holdingObject) return null;
  if (!spotCacheObject) return null;

  const metal = String(holdingObject.MetalCode_String || "").toUpperCase().trim();
  const biasTowardRetailPercent_Int = LoadBiasTowardRetailPercent_Int();

  if (metal === "XAU") {
    const retail = (spotCacheObject.XAU != null && Number.isFinite(spotCacheObject.XAU)) ? Number(spotCacheObject.XAU) : null;
    const market = (spotCacheObject.XAU_Market != null && Number.isFinite(spotCacheObject.XAU_Market)) ? Number(spotCacheObject.XAU_Market) : null;

    const pair = CreateSyntheticMarketOrRetailIfMissing_Object(market, retail);
    return CalculateAdjustedSpotPrice_Number_FromMarketAndRetail(pair.market, pair.retail, biasTowardRetailPercent_Int);
  }

  if (metal === "XAG") {
    const retail = (spotCacheObject.XAG != null && Number.isFinite(spotCacheObject.XAG)) ? Number(spotCacheObject.XAG) : null;
    const market = (spotCacheObject.XAG_Market != null && Number.isFinite(spotCacheObject.XAG_Market)) ? Number(spotCacheObject.XAG_Market) : null;

    const pair = CreateSyntheticMarketOrRetailIfMissing_Object(market, retail);
    return CalculateAdjustedSpotPrice_Number_FromMarketAndRetail(pair.market, pair.retail, biasTowardRetailPercent_Int);
  }

  return null;
}

function GetOuncesPerUnit_ForHolding(holdingObject) {
  const oz = Number(holdingObject && holdingObject.OuncesPerUnit_Number != null ? holdingObject.OuncesPerUnit_Number : NaN);
  if (!Number.isFinite(oz) || oz <= 0) return 0;
  return oz;
}

function GetOwnedLastPricePerUnitUsd_ForHolding_NumberOrNull(ownedObject, holdingObject, spotCacheObject) {
  const direct = Number(ownedObject && ownedObject.LastKnownMarketPricePerUnit_Number != null ? ownedObject.LastKnownMarketPricePerUnit_Number : NaN);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const spotPerOunce = GetSpotPricePerOunce_ForHolding(holdingObject, spotCacheObject);
  const ouncesPerUnit = GetOuncesPerUnit_ForHolding(holdingObject);

  if (spotPerOunce != null && Number.isFinite(spotPerOunce) && spotPerOunce > 0 && ouncesPerUnit > 0) {
    return spotPerOunce * ouncesPerUnit;
  }

  return null;
}

function BuildPortfolioExportRows_ArrayOfObjects() {
  EnsureOwnedStateSeeded_FromCatalogIfMissing();

  const ownedState = LoadOwnedState_ByHoldingId_Object() || {};
  const purchaseHistory = LoadPurchaseHistory_Array();
  const spotCache = LoadSpotCacheObject();
  const biasPercent_Int = LoadBiasTowardRetailPercent_Int();

  const rows = [];

  let totals_TotalSpentUsd = 0;
  let totals_TotalValueUsd = 0;
  let totals_TotalGainLossUsd = 0;

  // ---- Holdings snapshot rows (with per-item net gain/loss)
  for (let i = 0; i < HoldingsCatalog_Array.length; i += 1) {
    const holding = HoldingsCatalog_Array[i];
    const holdingId = holding.HoldingId;

    const owned = ownedState[holdingId] || {};
    const unitsOwned_Number = Number(owned.UnitsOwned_Number);

    const totalPaid_NumberOrNull = GetOwnedTotalPaidUsd_ForHolding_NumberOrNull(owned, purchaseHistory, holdingId);
    const lastPricePerUnit_NumberOrNull = GetOwnedLastPricePerUnitUsd_ForHolding_NumberOrNull(owned, holding, spotCache);

    const totalPaidOk = (totalPaid_NumberOrNull != null && Number.isFinite(totalPaid_NumberOrNull));
    const lastPriceOk = (lastPricePerUnit_NumberOrNull != null && Number.isFinite(lastPricePerUnit_NumberOrNull));

    const unitsOk = Number.isFinite(unitsOwned_Number);

    const valueOfOwnedUsd_NumberOrNull =
      (unitsOk && lastPriceOk)
        ? (unitsOwned_Number * lastPricePerUnit_NumberOrNull)
        : null;

    const netGainLossUsd_NumberOrNull =
      (valueOfOwnedUsd_NumberOrNull != null && Number.isFinite(valueOfOwnedUsd_NumberOrNull) && totalPaidOk)
        ? (valueOfOwnedUsd_NumberOrNull - totalPaid_NumberOrNull)
        : null;

    if (totalPaidOk) {
      totals_TotalSpentUsd += totalPaid_NumberOrNull;
    }
    if (valueOfOwnedUsd_NumberOrNull != null && Number.isFinite(valueOfOwnedUsd_NumberOrNull)) {
      totals_TotalValueUsd += valueOfOwnedUsd_NumberOrNull;
    }
    if (netGainLossUsd_NumberOrNull != null && Number.isFinite(netGainLossUsd_NumberOrNull)) {
      totals_TotalGainLossUsd += netGainLossUsd_NumberOrNull;
    }

    const ouncesPerUnit_Number = Number(holding.OuncesPerUnit_Number);
    const metalCode_String = String(holding.MetalCode_String || "").toUpperCase().trim();

    const spotMarketUsdPerOz_NumberOrNull =
      metalCode_String === "XAU" ? spotCache.XAU_Market :
      metalCode_String === "XAG" ? spotCache.XAG_Market :
      null;

    const spotRetailUsdPerOz_NumberOrNull =
      metalCode_String === "XAU" ? spotCache.XAU :
      metalCode_String === "XAG" ? spotCache.XAG :
      null;

    rows.push({
      RowType: "HoldingSnapshot",
      ExportedAtUtcIso: new Date().toISOString(),

      HoldingId: holdingId,
      DisplayName: holding.DisplayName,
      MetalCode: metalCode_String,
      OuncesPerUnit: Number.isFinite(ouncesPerUnit_Number) ? ouncesPerUnit_Number : "",

      UnitsOwned: unitsOk ? unitsOwned_Number : "",
      TotalPaidUsd: totalPaidOk ? totalPaid_NumberOrNull : "",
      LastPricePerUnitUsd: lastPriceOk ? lastPricePerUnit_NumberOrNull : "",

      ValueOfOwnedUsd: (valueOfOwnedUsd_NumberOrNull != null && Number.isFinite(valueOfOwnedUsd_NumberOrNull)) ? valueOfOwnedUsd_NumberOrNull : "",
      NetGainLossUsd: (netGainLossUsd_NumberOrNull != null && Number.isFinite(netGainLossUsd_NumberOrNull)) ? netGainLossUsd_NumberOrNull : "",

      SpotMarketUsdPerTroyOunce: Number.isFinite(spotMarketUsdPerOz_NumberOrNull) ? spotMarketUsdPerOz_NumberOrNull : "",
      SpotRetailUsdPerTroyOunce: Number.isFinite(spotRetailUsdPerOz_NumberOrNull) ? spotRetailUsdPerOz_NumberOrNull : "",

      BiasTowardRetailPercent: biasPercent_Int,

      PurchaseId: "",
      PurchasedAtUtcIso: "",
      UnitsPurchased: "",
      PricePerUnitUsd: "",
      TotalCostUsd: ""
    });
  }

  // ---- Purchase ledger rows
  for (let j = 0; j < purchaseHistory.length; j += 1) {
    const record = purchaseHistory[j] || {};

    rows.push({
      RowType: "PurchaseLedger",
      ExportedAtUtcIso: new Date().toISOString(),

      HoldingId: record.HoldingId_String || "",
      DisplayName: FindHolding_DisplayName(record.HoldingId_String || ""),
      MetalCode: (FindHolding_MetalCode_String(record.HoldingId_String || "") || ""),
      OuncesPerUnit: (FindHolding_OuncesPerUnit_Number(record.HoldingId_String || "") || ""),

      UnitsOwned: "",
      TotalPaidUsd: "",
      LastPricePerUnitUsd: "",

      ValueOfOwnedUsd: "",
      NetGainLossUsd: "",

      SpotMarketUsdPerTroyOunce: "",
      SpotRetailUsdPerTroyOunce: "",
      BiasTowardRetailPercent: "",

      PurchaseId: record.PurchaseId_String || "",
      PurchasedAtUtcIso: record.PurchasedAtUtcIso_String || "",
      UnitsPurchased: record.UnitsPurchased_Number != null ? Number(record.UnitsPurchased_Number) : "",
      PricePerUnitUsd: record.PricePerUnit_Number != null ? Number(record.PricePerUnit_Number) : "",
      TotalCostUsd: record.TotalCost_Number != null ? Number(record.TotalCost_Number) : ""
    });
  }

  // ---- Bottom totals row
  rows.push({
    RowType: "PortfolioTotals",
    ExportedAtUtcIso: new Date().toISOString(),

    HoldingId: "",
    DisplayName: "(TOTALS)",
    MetalCode: "",
    OuncesPerUnit: "",

    UnitsOwned: "",
    TotalPaidUsd: totals_TotalSpentUsd,
    LastPricePerUnitUsd: "",

    ValueOfOwnedUsd: totals_TotalValueUsd,
    NetGainLossUsd: totals_TotalGainLossUsd,

    SpotMarketUsdPerTroyOunce: "",
    SpotRetailUsdPerTroyOunce: "",
    BiasTowardRetailPercent: "",

    PurchaseId: "",
    PurchasedAtUtcIso: "",
    UnitsPurchased: "",
    PricePerUnitUsd: "",
    TotalCostUsd: ""
  });

  return rows;
}

function BuildPortfolioExportCsvText() {
  const headerColumns_Array = [
    "RowType",
    "ExportedAtUtcIso",

    "HoldingId",
    "DisplayName",
    "MetalCode",
    "OuncesPerUnit",

    "UnitsOwned",
    "TotalPaidUsd",
    "LastPricePerUnitUsd",

    "ValueOfOwnedUsd",
    "NetGainLossUsd",

    "SpotMarketUsdPerTroyOunce",
    "SpotRetailUsdPerTroyOunce",
    "BiasTowardRetailPercent",

    "PurchaseId",
    "PurchasedAtUtcIso",
    "UnitsPurchased",
    "PricePerUnitUsd",
    "TotalCostUsd"
  ];

  const rows = BuildPortfolioExportRows_ArrayOfObjects();
  return ConvertRowsToCsvText(headerColumns_Array, rows);
}

function HandleDownloadCsvClick() {
  try {
    const csvText = BuildPortfolioExportCsvText();
    const filename = "PreciousMetalsPortfolio_" + GetUtcTimestampForFilename_String() + ".csv";
    DownloadTextFile_AsBrowserDownload(filename, "text/csv;charset=utf-8", csvText);

    Status_Element.textContent = "Status: CSV exported (" + String(filename) + ")";
  } catch (err) {
    Status_Element.textContent = "Status: CSV export failed: " + String(err);
  }
}

// --------------------------------------------------
// Formatting helpers
// --------------------------------------------------

function FormatCurrency(numberValue) {
  const n = Number(numberValue);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function FormatUtcIsoToLocalReadable(utcIsoString) {
  if (!utcIsoString) return "(unknown)";
  const d = new Date(utcIsoString);
  if (Number.isNaN(d.getTime())) return "(unknown)";
  return d.toLocaleString();
}

function ParseDecimalOrZero_FromInputString(inputString) {
  const n = Number(inputString);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return n;
}

function ParseIntegerOrZero_FromInputString(inputString) {
  const n = Number(inputString);
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  return floored;
}

function GetGainLossCssClass_ForNumber(numberValue) {
  const n = Number(numberValue);
  if (!Number.isFinite(n)) return "";
  if (n > 0) return "gain-positive";
  if (n < 0) return "gain-negative";
  return "";
}

// --------------------------------------------------
// Numeric-only input helpers
// --------------------------------------------------

function CreateNumericOnlyIntegerTextBox(initialValueNumber) {
  const input = document.createElement("input");

  input.type = "text";
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";

  input.value = String(Number.isFinite(initialValueNumber) ? initialValueNumber : 0);

  function HandleInput_CleanDigitsOnly() {
    const cleaned = String(input.value).replace(/[^0-9]/g, "");
    input.value = cleaned;
  }

  input.addEventListener("input", HandleInput_CleanDigitsOnly);

  return input;
}

function CreateNumericOnlyDecimalTextBox(initialValueNumber) {
  const input = document.createElement("input");

  input.type = "text";
  input.inputMode = "decimal";
  input.pattern = "[0-9]*[.]?[0-9]*";

  input.value = String(Number.isFinite(initialValueNumber) ? initialValueNumber : 0);

  function HandleInput_CleanDecimalOnly() {
    let cleaned = String(input.value).replace(/[^0-9.]/g, "");

    const firstDotIndex = cleaned.indexOf(".");
    if (firstDotIndex >= 0) {
      const before = cleaned.substring(0, firstDotIndex + 1);
      const after = cleaned.substring(firstDotIndex + 1).replace(/\./g, "");
      cleaned = before + after;
    }

    input.value = cleaned;
  }

  input.addEventListener("input", HandleInput_CleanDecimalOnly);

  return input;
}

// --------------------------------------------------
// Spot cache (localStorage)
// --------------------------------------------------

function CreateEmptySpotCacheObject() {
  return {
    XAU: null,
    XAG: null,
    XAU_Market: null,
    XAG_Market: null,
    LastUpdatedUtcIso: null,
    SourcesUsedText: null
  };
}

function LoadSpotCacheObject() {
  const raw = localStorage.getItem(StorageKey_SpotCache);
  if (!raw) return CreateEmptySpotCacheObject();

  try {
    const obj = JSON.parse(raw);

    return {
      XAU: (obj && obj.XAU != null) ? Number(obj.XAU) : null,
      XAG: (obj && obj.XAG != null) ? Number(obj.XAG) : null,

      XAU_Market: (obj && obj.XAU_Market != null) ? Number(obj.XAU_Market) : null,
      XAG_Market: (obj && obj.XAG_Market != null) ? Number(obj.XAG_Market) : null,

      LastUpdatedUtcIso: (obj && obj.LastUpdatedUtcIso) ? String(obj.LastUpdatedUtcIso) : null,
      SourcesUsedText: (obj && obj.SourcesUsedText) ? String(obj.SourcesUsedText) : null
    };
  } catch {
    return CreateEmptySpotCacheObject();
  }
}

function SaveSpotCacheObject(spotCacheObject) {
  localStorage.setItem(StorageKey_SpotCache, JSON.stringify(spotCacheObject));
}

// --------------------------------------------------
// Spot estimate helpers (NOW ALWAYS WEIGHTED)
// --------------------------------------------------

const SyntheticSpreadFraction_Number = 0.02; // 2% (tune this whenever)

function CreateSyntheticMarketOrRetailIfMissing_Object(marketOrNull, retailOrNull) {
  const market = Number(marketOrNull);
  const retail = Number(retailOrNull);

  const marketOk = Number.isFinite(market) && market > 0;
  const retailOk = Number.isFinite(retail) && retail > 0;

  if (marketOk && retailOk) {
    return { market: market, retail: retail, usedSynthetic: false };
  }

  if (retailOk && !marketOk) {
    const syntheticMarket = retail * (1 - SyntheticSpreadFraction_Number);
    return { market: syntheticMarket, retail: retail, usedSynthetic: true };
  }

  if (marketOk && !retailOk) {
    const syntheticRetail = market * (1 + SyntheticSpreadFraction_Number);
    return { market: market, retail: syntheticRetail, usedSynthetic: true };
  }

  return { market: null, retail: null, usedSynthetic: false };
}

// --------------------------------------------------
// Backend calls
// --------------------------------------------------

async function FetchSpotForMetalAsync(metalCode) {
  const url = BackendBaseUrl_String + "/api/spot?metal=" + encodeURIComponent(metalCode);

  const response = await fetch(url, { method: "GET", cache: "no-store" });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  const json = await response.json();

  const price = Number(json.priceUsdPerTroyOunce);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid spot price payload for " + metalCode);
  }

  const usedCount = Number(json.usedCount);
  const fetchedOkCount = Number(json.fetchedOkCount);

  const updatedAtUtcIso =
    (json.updatedAtUtcIso != null && String(json.updatedAtUtcIso).trim() !== "")
      ? String(json.updatedAtUtcIso)
      : null;

  const marketPrice = (json.marketPriceUsdPerTroyOunce != null) ? Number(json.marketPriceUsdPerTroyOunce) : null;
  const retailPrice = (json.retailPriceUsdPerTroyOunce != null) ? Number(json.retailPriceUsdPerTroyOunce) : null;

  return {
    metal: metalCode,
    priceUsdPerTroyOunce: price,
    marketPriceUsdPerTroyOunce: (Number.isFinite(marketPrice) && marketPrice > 0) ? marketPrice : null,
    retailPriceUsdPerTroyOunce: (Number.isFinite(retailPrice) && retailPrice > 0) ? retailPrice : null,
    usedCount: Number.isFinite(usedCount) ? usedCount : null,
    fetchedOkCount: Number.isFinite(fetchedOkCount) ? fetchedOkCount : null,
    updatedAtUtcIso: updatedAtUtcIso
  };
}

async function RefreshSpotCacheFromBackendAsync() {
  const results = await Promise.allSettled([
    FetchSpotForMetalAsync("XAU"),
    FetchSpotForMetalAsync("XAG")
  ]);

  const xauResult = results[0];
  const xagResult = results[1];

  const existing = LoadSpotCacheObject();
  const next = CreateEmptySpotCacheObject();

  next.XAU = existing.XAU;
  next.XAG = existing.XAG;
  next.XAU_Market = existing.XAU_Market;
  next.XAG_Market = existing.XAG_Market;
  next.LastUpdatedUtcIso = existing.LastUpdatedUtcIso;
  next.SourcesUsedText = existing.SourcesUsedText;

  let anySuccess = false;
  const usedCountTextParts = [];

  if (xauResult.status === "fulfilled") {
    next.XAU = xauResult.value.priceUsdPerTroyOunce;

    if (xauResult.value.marketPriceUsdPerTroyOunce != null) {
      next.XAU_Market = xauResult.value.marketPriceUsdPerTroyOunce;
    }
    if (xauResult.value.retailPriceUsdPerTroyOunce != null) {
      next.XAU = xauResult.value.retailPriceUsdPerTroyOunce;
    }

    anySuccess = true;

    if (xauResult.value.usedCount != null && xauResult.value.fetchedOkCount != null) {
      usedCountTextParts.push("Gold sources: " + xauResult.value.usedCount + "/" + xauResult.value.fetchedOkCount);
    }
    if (xauResult.value.updatedAtUtcIso) {
      next.LastUpdatedUtcIso = xauResult.value.updatedAtUtcIso;
    }
  }

  if (xagResult.status === "fulfilled") {
    next.XAG = xagResult.value.priceUsdPerTroyOunce;

    if (xagResult.value.marketPriceUsdPerTroyOunce != null) {
      next.XAG_Market = xagResult.value.marketPriceUsdPerTroyOunce;
    }
    if (xagResult.value.retailPriceUsdPerTroyOunce != null) {
      next.XAG = xagResult.value.retailPriceUsdPerTroyOunce;
    }

    anySuccess = true;

    if (xagResult.value.usedCount != null && xagResult.value.fetchedOkCount != null) {
      usedCountTextParts.push("Silver sources: " + xagResult.value.usedCount + "/" + xagResult.value.fetchedOkCount);
    }
    if (xagResult.value.updatedAtUtcIso) {
      next.LastUpdatedUtcIso = xagResult.value.updatedAtUtcIso;
    }
  }

  if (usedCountTextParts.length > 0) {
    next.SourcesUsedText = usedCountTextParts.join(" | ");
  }

  if (anySuccess) {
    SaveSpotCacheObject(next);
  }

  const errors = [];

  if (xauResult.status === "rejected") {
    errors.push("Gold refresh failed: " + String(xauResult.reason));
  }
  if (xagResult.status === "rejected") {
    errors.push("Silver refresh failed: " + String(xagResult.reason));
  }

  return {
    spotCacheObject: LoadSpotCacheObject(),
    errors: errors
  };
}

// --------------------------------------------------
// Apply / Commit logic
// --------------------------------------------------

function ApplyPurchase_ForHoldingId(holdingId_String) {
  const ownedState = LoadOwnedState_ByHoldingId_Object();
  if (ownedState == null) return;

  const drafts = LoadDraftEdits_ByHoldingId_Object();
  const draftForHolding = drafts[holdingId_String] != null ? drafts[holdingId_String] : CreateDefaultDraftEdits_Object();

  const unitsPurchase = Number(draftForHolding.UnitsBeingPurchasedNow_Number);
  const unitPrice = Number(draftForHolding.MarketPricePerUnit_Input_Number);

  const unitsPurchase_Number = (Number.isFinite(unitsPurchase) && unitsPurchase > 0) ? Math.floor(unitsPurchase) : 0;
  const unitPrice_Number = (Number.isFinite(unitPrice) && unitPrice > 0) ? unitPrice : 0;

  if (unitsPurchase_Number <= 0) {
    return;
  }

  if (unitPrice_Number <= 0) {
    return;
  }

  const owned = ownedState[holdingId_String];
  if (owned == null) return;

  const purchaseTotalCost = unitsPurchase_Number * unitPrice_Number;

  owned.UnitsOwned_Number = Number(owned.UnitsOwned_Number) + unitsPurchase_Number;
  owned.TotalPaidOwned_Number = Number(owned.TotalPaidOwned_Number) + purchaseTotalCost;
  owned.LastKnownMarketPricePerUnit_Number = unitPrice_Number;

  ownedState[holdingId_String] = owned;
  SaveOwnedState_ByHoldingId_Object(ownedState);

  AppendPurchaseRecord_ToHistory(holdingId_String, unitsPurchase_Number, unitPrice_Number);

  draftForHolding.UnitsBeingPurchasedNow_Number = 0;
  drafts[holdingId_String] = draftForHolding;
  SaveDraftEdits_ByHoldingId_Object(drafts);
}

function UpdateMarketPrice_ForHoldingId_IfValid(holdingId_String) {
  const ownedState = LoadOwnedState_ByHoldingId_Object();
  if (ownedState == null) return;

  const drafts = LoadDraftEdits_ByHoldingId_Object();
  const draftForHolding = drafts[holdingId_String] != null ? drafts[holdingId_String] : CreateDefaultDraftEdits_Object();

  const unitPrice = Number(draftForHolding.MarketPricePerUnit_Input_Number);
  const unitPrice_Number = (Number.isFinite(unitPrice) && unitPrice > 0) ? unitPrice : 0;

  if (unitPrice_Number <= 0) {
    return;
  }

  const owned = ownedState[holdingId_String];
  if (owned == null) return;

  owned.LastKnownMarketPricePerUnit_Number = unitPrice_Number;

  ownedState[holdingId_String] = owned;
  SaveOwnedState_ByHoldingId_Object(ownedState);
}

// --------------------------------------------------
// Reset / Delete long-term memory
// --------------------------------------------------

function ResetAllSavedData() {
  localStorage.removeItem(StorageKey_DraftEdits_ByHoldingId_Object);
  localStorage.removeItem(StorageKey_OwnedState_ByHoldingId_Object);
  localStorage.removeItem(StorageKey_PurchaseHistory_Array);
  localStorage.removeItem(StorageKey_SpotCache);
  localStorage.removeItem(StorageKey_BiasTowardRetailPercent_Int);
}

// --------------------------------------------------
// Apply All Changes
// --------------------------------------------------

function CommitAllRenderedInputs_ToDraftStorage() {
  const nextDrafts = LoadDraftEdits_ByHoldingId_Object();

  for (const holding of HoldingsCatalog_Array) {
    const holdingId = holding.HoldingId;

    const refs = CurrentRenderedInputs_ByHoldingId_Object[holdingId];
    if (!refs || !refs.UnitsPurchase_Input || !refs.MarketPrice_Input) {
      continue;
    }

    const unitsCleaned = String(refs.UnitsPurchase_Input.value || "").trim();
    const priceCleaned = String(refs.MarketPrice_Input.value || "").trim();

    const existingDraft = nextDrafts[holdingId] != null
      ? nextDrafts[holdingId]
      : CreateDefaultDraftEdits_Object();

    existingDraft.UnitsBeingPurchasedNow_Number = ParseIntegerOrZero_FromInputString(unitsCleaned);
    existingDraft.MarketPricePerUnit_Input_Number = ParseDecimalOrZero_FromInputString(priceCleaned);

    nextDrafts[holdingId] = existingDraft;
  }

  SaveDraftEdits_ByHoldingId_Object(nextDrafts);
}

function ApplyAllChanges_ForAllHoldings() {
  CommitAllRenderedInputs_ToDraftStorage();

  for (const holding of HoldingsCatalog_Array) {
    UpdateMarketPrice_ForHoldingId_IfValid(holding.HoldingId);
    ApplyPurchase_ForHoldingId(holding.HoldingId);
  }
}

// --------------------------------------------------
// Totals rendering helpers
// --------------------------------------------------

function CreateTotalsSectionElement(titleText, totalsRowObject, footnoteTextOrNull) {
  const section = document.createElement("div");
  section.className = "totals-section";

  const title = document.createElement("div");
  title.className = "totals-title";
  title.textContent = titleText;
  section.appendChild(title);

  const table = document.createElement("table");
  table.className = "totals-table";

  const headerRow = document.createElement("tr");
  headerRow.innerHTML =
    "<th>Total Cost of Purchase</th>" +
    "<th>Total Paid (Owned)</th>" +
    "<th>Value of Owned</th>" +
    "<th>Gain/Loss (Owned)</th>";
  table.appendChild(headerRow);

  const dataRow = document.createElement("tr");

  const purchaseTd = document.createElement("td");
  purchaseTd.textContent = FormatCurrency(totalsRowObject.TotalCostOfPurchase_Number);

  const paidTd = document.createElement("td");
  paidTd.textContent = FormatCurrency(totalsRowObject.TotalPaidOwned_Number);

  const valueTd = document.createElement("td");
  valueTd.textContent = FormatCurrency(totalsRowObject.ValueOfOwned_Number);

  const gainLossTd = document.createElement("td");
  gainLossTd.textContent = FormatCurrency(totalsRowObject.GainLossOwned_Number);

  const gainLossClass = GetGainLossCssClass_ForNumber(totalsRowObject.GainLossOwned_Number);
  if (gainLossClass) {
    gainLossTd.classList.add(gainLossClass);
  }

  dataRow.appendChild(purchaseTd);
  dataRow.appendChild(paidTd);
  dataRow.appendChild(valueTd);
  dataRow.appendChild(gainLossTd);

  table.appendChild(dataRow);
  section.appendChild(table);

  if (footnoteTextOrNull) {
    const foot = document.createElement("div");
    foot.className = "totals-footnote";
    foot.textContent = footnoteTextOrNull;
    section.appendChild(foot);
  }

  return section;
}

// --------------------------------------------------
// Rendering
// --------------------------------------------------

function RenderHeaderFromSpotCache() {
  const spotCache = LoadSpotCacheObject();

  const goldSpotAdjusted = GetSpotPricePerOunce_ForHolding({ MetalCode_String: "XAU" }, spotCache);
  const silverSpotAdjusted = GetSpotPricePerOunce_ForHolding({ MetalCode_String: "XAG" }, spotCache);

  const goldSpotDisplay =
    (goldSpotAdjusted != null && Number.isFinite(goldSpotAdjusted))
      ? FormatCurrency(goldSpotAdjusted)
      : "(not loaded)";

  const silverSpotDisplay =
    (silverSpotAdjusted != null && Number.isFinite(silverSpotAdjusted))
      ? FormatCurrency(silverSpotAdjusted)
      : "(not loaded)";

  Status_Element.innerHTML =
    "<strong>Estimated Price Per Ounce (Oz.):</strong><br>" +
    "• Gold: " + goldSpotDisplay + "<br>" +
    "• Silver: " + silverSpotDisplay;

  if (BiasAdjustedSpotPrice_Label) {
    if (goldSpotAdjusted != null && silverSpotAdjusted != null) {
      BiasAdjustedSpotPrice_Label.textContent = "Gold " + FormatCurrency(goldSpotAdjusted) + " | Silver " + FormatCurrency(silverSpotAdjusted);
    } else if (goldSpotAdjusted != null) {
      BiasAdjustedSpotPrice_Label.textContent = "Gold " + FormatCurrency(goldSpotAdjusted);
    } else if (silverSpotAdjusted != null) {
      BiasAdjustedSpotPrice_Label.textContent = "Silver " + FormatCurrency(silverSpotAdjusted);
    } else {
      BiasAdjustedSpotPrice_Label.textContent = "(not loaded)";
    }
  }

  const lastUpdatedReadable = FormatUtcIsoToLocalReadable(spotCache.LastUpdatedUtcIso);
  const sourcesText = spotCache.SourcesUsedText ? spotCache.SourcesUsedText : null;

  if (sourcesText) {
    LastUpdated_Element.textContent = "Last updated: " + lastUpdatedReadable + " | " + sourcesText;
  } else {
    LastUpdated_Element.textContent = "Last updated: " + lastUpdatedReadable;
  }

  UpdateBiasUi_FromStoredValue();
}

function RenderHoldingsTable() {
  const drafts = LoadDraftEdits_ByHoldingId_Object();
  const ownedState = LoadOwnedState_ByHoldingId_Object();
  const spotCache = LoadSpotCacheObject();

  for (const key of Object.keys(CurrentRenderedInputs_ByHoldingId_Object)) {
    delete CurrentRenderedInputs_ByHoldingId_Object[key];
  }

  let totals_PurchaseNowCost_UserMarket = 0;
  let totals_TotalPaidOwned = 0;
  let totals_OwnedValue_UserMarket = 0;
  let totals_OwnedGainLoss_UserMarket = 0;

  let totals_PurchaseNowCost_SpotEstimate = 0;
  let totals_OwnedValue_SpotEstimate = 0;
  let totals_OwnedGainLoss_SpotEstimate = 0;

  let spotRowsIncluded_Count = 0;
  let spotRowsMissing_Count = 0;

  HoldingsContainer_Element.innerHTML = "";

  const tableElement = document.createElement("table");
  tableElement.border = "1";
  tableElement.cellPadding = "6";

  const headerRow = document.createElement("tr");
  headerRow.innerHTML =
    "<th>Item</th>" +
    "<th>Units Owned</th>" +
    "<th>Units Being Purchased Now</th>" +
    "<th>Market Price / Unit</th>" +
    "<th>Total Cost of Purchase</th>" +
    "<th>Total Paid (Owned)</th>" +
    "<th>Last Known Market Price / Unit</th>" +
    "<th>Value of Owned</th>" +
    "<th>Gain/Loss (Owned)</th>" +
    "<th>Spot Est. Price / Unit</th>" +
    "<th>Value of Owned (Spot Est.)</th>" +
    "<th>Actions</th>";
  tableElement.appendChild(headerRow);

  for (const holding of HoldingsCatalog_Array) {
    const owned = ownedState[holding.HoldingId];

    const unitsOwned_ReadOnly = Number(owned.UnitsOwned_Number) || 0;
    const totalPaidOwned_ReadOnly = Number(owned.TotalPaidOwned_Number) || 0;
    const lastKnownMarketPricePerUnit_ReadOnly = Number(owned.LastKnownMarketPricePerUnit_Number) || 0;

    const draftExisting = drafts[holding.HoldingId];
    const draft = draftExisting != null ? draftExisting : CreateDefaultDraftEdits_Object();

    const draftUnitsPurchase = Number(draft.UnitsBeingPurchasedNow_Number) || 0;
    const draftMarketPrice = Number(draft.MarketPricePerUnit_Input_Number) || 0;

    const totalCostOfPurchase = draftUnitsPurchase * draftMarketPrice;

    const valueOfOwned = unitsOwned_ReadOnly * lastKnownMarketPricePerUnit_ReadOnly;
    const gainLossOwned = valueOfOwned - totalPaidOwned_ReadOnly;

    const spotPricePerOunce = GetSpotPricePerOunce_ForHolding(holding, spotCache);
    const ouncesPerUnit = GetOuncesPerUnit_ForHolding(holding);

    const spotEstimatedPricePerUnit =
      (spotPricePerOunce != null && Number.isFinite(spotPricePerOunce) && spotPricePerOunce > 0 && ouncesPerUnit > 0)
        ? (spotPricePerOunce * ouncesPerUnit)
        : null;

    const valueOfOwned_SpotEstimate =
      (spotEstimatedPricePerUnit != null)
        ? (unitsOwned_ReadOnly * spotEstimatedPricePerUnit)
        : null;

    const totalCostOfPurchase_SpotEstimate =
      (spotEstimatedPricePerUnit != null)
        ? (draftUnitsPurchase * spotEstimatedPricePerUnit)
        : null;

    const gainLossOwned_SpotEstimate =
      (valueOfOwned_SpotEstimate != null)
        ? (valueOfOwned_SpotEstimate - totalPaidOwned_ReadOnly)
        : null;

    totals_PurchaseNowCost_UserMarket += totalCostOfPurchase;
    totals_TotalPaidOwned += totalPaidOwned_ReadOnly;
    totals_OwnedValue_UserMarket += valueOfOwned;
    totals_OwnedGainLoss_UserMarket += gainLossOwned;

    if (valueOfOwned_SpotEstimate != null && gainLossOwned_SpotEstimate != null) {
      totals_OwnedValue_SpotEstimate += valueOfOwned_SpotEstimate;
      totals_OwnedGainLoss_SpotEstimate += gainLossOwned_SpotEstimate;
      spotRowsIncluded_Count += 1;

      if (totalCostOfPurchase_SpotEstimate != null) {
        totals_PurchaseNowCost_SpotEstimate += totalCostOfPurchase_SpotEstimate;
      }
    } else {
      spotRowsMissing_Count += 1;
    }

    const row = document.createElement("tr");

    const unitsPurchase_Input = CreateNumericOnlyIntegerTextBox(draftUnitsPurchase);
    const marketPrice_Input = CreateNumericOnlyDecimalTextBox(draftMarketPrice);

    CurrentRenderedInputs_ByHoldingId_Object[holding.HoldingId] = {
      UnitsPurchase_Input: unitsPurchase_Input,
      MarketPrice_Input: marketPrice_Input
    };

    function CommitDraftEdits_FromInputs_ToLocalStorage() {
      const nextDrafts = LoadDraftEdits_ByHoldingId_Object();

      const existingDraft = nextDrafts[holding.HoldingId] != null
        ? nextDrafts[holding.HoldingId]
        : CreateDefaultDraftEdits_Object();

      const unitsCleaned = String(unitsPurchase_Input.value).trim();
      const priceCleaned = String(marketPrice_Input.value).trim();

      existingDraft.UnitsBeingPurchasedNow_Number = ParseIntegerOrZero_FromInputString(unitsCleaned);
      existingDraft.MarketPricePerUnit_Input_Number = ParseDecimalOrZero_FromInputString(priceCleaned);

      nextDrafts[holding.HoldingId] = existingDraft;
      SaveDraftEdits_ByHoldingId_Object(nextDrafts);
    }

    function HandleUnitsBlur() {
      CommitDraftEdits_FromInputs_ToLocalStorage();
      Render();
    }

    function HandlePriceBlur() {
      CommitDraftEdits_FromInputs_ToLocalStorage();
      Render();
    }

    function HandleUnitsKeyDown(event) {
      if (event && event.key === "Enter") {
        unitsPurchase_Input.blur();
      }
      if (event && event.key === "Escape") {
        unitsPurchase_Input.blur();
      }
    }

    function HandlePriceKeyDown(event) {
      if (event && event.key === "Enter") {
        marketPrice_Input.blur();
      }
      if (event && event.key === "Escape") {
        marketPrice_Input.blur();
      }
    }

    unitsPurchase_Input.addEventListener("blur", HandleUnitsBlur);
    marketPrice_Input.addEventListener("blur", HandlePriceBlur);

    unitsPurchase_Input.addEventListener("keydown", HandleUnitsKeyDown);
    marketPrice_Input.addEventListener("keydown", HandlePriceKeyDown);

    const itemCell = document.createElement("td");
    itemCell.textContent = holding.DisplayName;

    const unitsOwnedCell = document.createElement("td");
    unitsOwnedCell.textContent = String(unitsOwned_ReadOnly);

    const unitsPurchaseCell = document.createElement("td");
    unitsPurchaseCell.appendChild(unitsPurchase_Input);

    const marketPriceCell = document.createElement("td");
    marketPriceCell.appendChild(marketPrice_Input);

    const totalCostCell = document.createElement("td");
    totalCostCell.textContent = FormatCurrency(totalCostOfPurchase);

    const totalPaidOwnedCell = document.createElement("td");
    totalPaidOwnedCell.textContent = FormatCurrency(totalPaidOwned_ReadOnly);

    const lastKnownPriceCell = document.createElement("td");
    lastKnownPriceCell.textContent =
      (lastKnownMarketPricePerUnit_ReadOnly > 0)
        ? FormatCurrency(lastKnownMarketPricePerUnit_ReadOnly)
        : "(not set)";

    const valueOwnedCell = document.createElement("td");
    valueOwnedCell.textContent = FormatCurrency(valueOfOwned);

    const gainLossCell = document.createElement("td");
    gainLossCell.textContent = FormatCurrency(gainLossOwned);

    const gainLossClass = GetGainLossCssClass_ForNumber(gainLossOwned);
    if (gainLossClass) {
      gainLossCell.classList.add(gainLossClass);
    }

    const spotEstimatedPricePerUnitCell = document.createElement("td");
    spotEstimatedPricePerUnitCell.textContent =
      (spotEstimatedPricePerUnit != null)
        ? FormatCurrency(spotEstimatedPricePerUnit)
        : "(spot not loaded)";

    const spotEstimatedValueOwnedCell = document.createElement("td");
    spotEstimatedValueOwnedCell.textContent =
      (valueOfOwned_SpotEstimate != null)
        ? FormatCurrency(valueOfOwned_SpotEstimate)
        : "(spot not loaded)";

    const actionsCell = document.createElement("td");

    const updatePriceButton = document.createElement("button");
    updatePriceButton.type = "button";
    updatePriceButton.textContent = "Update Market Price";

    function HandleUpdatePriceClick() {
      CommitDraftEdits_FromInputs_ToLocalStorage();
      UpdateMarketPrice_ForHoldingId_IfValid(holding.HoldingId);
      Render();
    }

    updatePriceButton.addEventListener("click", HandleUpdatePriceClick);

    const applyPurchaseButton = document.createElement("button");
    applyPurchaseButton.type = "button";
    applyPurchaseButton.textContent = "Apply Purchase";

    function HandleApplyPurchaseClick() {
      CommitDraftEdits_FromInputs_ToLocalStorage();
      ApplyPurchase_ForHoldingId(holding.HoldingId);
      Render();
    }

    applyPurchaseButton.addEventListener("click", HandleApplyPurchaseClick);

    const undoLastPurchaseButton = document.createElement("button");
    undoLastPurchaseButton.type = "button";
    undoLastPurchaseButton.textContent = "Undo Last Purchase";

    function HandleUndoLastPurchaseClick() {
      UndoLastPurchase_ForHoldingId(holding.HoldingId);
      Render();
    }

    undoLastPurchaseButton.addEventListener("click", HandleUndoLastPurchaseClick);

    actionsCell.appendChild(updatePriceButton);
    actionsCell.appendChild(document.createTextNode(" "));
    actionsCell.appendChild(applyPurchaseButton);
    actionsCell.appendChild(document.createTextNode(" "));
    actionsCell.appendChild(undoLastPurchaseButton);

    row.appendChild(itemCell);
    row.appendChild(unitsOwnedCell);
    row.appendChild(unitsPurchaseCell);
    row.appendChild(marketPriceCell);
    row.appendChild(totalCostCell);
    row.appendChild(totalPaidOwnedCell);
    row.appendChild(lastKnownPriceCell);
    row.appendChild(valueOwnedCell);
    row.appendChild(gainLossCell);
    row.appendChild(spotEstimatedPricePerUnitCell);
    row.appendChild(spotEstimatedValueOwnedCell);
    row.appendChild(actionsCell);

    tableElement.appendChild(row);

    if (draftExisting == null) {
      const seededDraft = CreateDefaultDraftEdits_Object();

      const defaultPrice = Number(holding.MarketPricePerUnit_Default_Number);
      if (Number.isFinite(defaultPrice) && defaultPrice > 0) {
        seededDraft.MarketPricePerUnit_Input_Number = defaultPrice;
      }

      drafts[holding.HoldingId] = seededDraft;
      SaveDraftEdits_ByHoldingId_Object(drafts);
    }
  }

  HoldingsContainer_Element.appendChild(tableElement);

  Totals_Element.innerHTML = "";

  const userMarketTotals_Object = {
    TotalCostOfPurchase_Number: totals_PurchaseNowCost_UserMarket,
    TotalPaidOwned_Number: totals_TotalPaidOwned,
    ValueOfOwned_Number: totals_OwnedValue_UserMarket,
    GainLossOwned_Number: totals_OwnedGainLoss_UserMarket
  };

  const spotTotals_Object = {
    TotalCostOfPurchase_Number: totals_PurchaseNowCost_SpotEstimate,
    TotalPaidOwned_Number: totals_TotalPaidOwned,
    ValueOfOwned_Number: totals_OwnedValue_SpotEstimate,
    GainLossOwned_Number: totals_OwnedGainLoss_SpotEstimate
  };

  const userMarketSection = CreateTotalsSectionElement(
    "User Market Price / Unit Totals",
    userMarketTotals_Object,
    null
  );

  const spotSection = CreateTotalsSectionElement(
    "Spot Price Totals (Gold/Silver per-oz estimate)",
    spotTotals_Object,
    "Spot rows included: " + String(spotRowsIncluded_Count) + " | Spot rows missing: " + String(spotRowsMissing_Count)
  );

  Totals_Element.appendChild(userMarketSection);
  Totals_Element.appendChild(spotSection);
}

function RenderPurchaseHistoryTable() {
  const history = LoadPurchaseHistory_Array();

  PurchaseHistoryContainer_Element.innerHTML = "";

  if (!history || history.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "(No purchases have been applied yet.)";
    PurchaseHistoryContainer_Element.appendChild(empty);
    return;
  }

  const sorted = [...history].sort(function (a, b) {
    const aa = String(a && a.PurchasedAtUtcIso_String ? a.PurchasedAtUtcIso_String : "");
    const bb = String(b && b.PurchasedAtUtcIso_String ? b.PurchasedAtUtcIso_String : "");
    if (aa === bb) return 0;
    return bb > aa ? 1 : -1;
  });

  const table = document.createElement("table");
  table.border = "1";
  table.cellPadding = "6";

  const header = document.createElement("tr");
  header.innerHTML =
    "<th>Date/Time</th>" +
    "<th>Item</th>" +
    "<th>Units</th>" +
    "<th>Price / Unit</th>" +
    "<th>Total Cost</th>" +
    "<th>Actions</th>";
  table.appendChild(header);

  for (const record of sorted) {
    const row = document.createElement("tr");

    const dtCell = document.createElement("td");
    dtCell.textContent = FormatUtcIsoToLocalReadable(record.PurchasedAtUtcIso_String);

    const itemCell = document.createElement("td");
    itemCell.textContent = FindHolding_DisplayName(record.HoldingId_String);

    const unitsCell = document.createElement("td");
    unitsCell.textContent = String(Number(record.UnitsPurchased_Number) || 0);

    const priceCell = document.createElement("td");
    priceCell.textContent = FormatCurrency(Number(record.PricePerUnit_Number) || 0);

    const totalCell = document.createElement("td");
    totalCell.textContent = FormatCurrency(Number(record.TotalCost_Number) || 0);

    const actionsCell = document.createElement("td");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";

    function HandleDeletePurchaseClick() {
      DeletePurchaseRecord_AndReverseOwnedImpact(record.PurchaseId_String);
      Render();
    }

    deleteButton.addEventListener("click", HandleDeletePurchaseClick);
    actionsCell.appendChild(deleteButton);

    row.appendChild(dtCell);
    row.appendChild(itemCell);
    row.appendChild(unitsCell);
    row.appendChild(priceCell);
    row.appendChild(totalCell);
    row.appendChild(actionsCell);

    table.appendChild(row);
  }

  PurchaseHistoryContainer_Element.appendChild(table);
}

function Render() {
  RenderHeaderFromSpotCache();
  RenderHoldingsTable();
  RenderPurchaseHistoryTable();
}

// --------------------------------------------------
// Buttons
// --------------------------------------------------

function HandleRefreshSpotPricesClick() {
  Startup_RefreshSpotOnlyAsync();
}

function HandleApplyAllChangesClick() {
  ApplyAllChanges_ForAllHoldings();
  Render();
}

function HandleResetSavedDataClick() {
  ResetAllSavedData();
  EnsureOwnedStateSeeded_FromCatalogIfMissing();
  Render();
}

RefreshSpotPrices_Button.addEventListener("click", HandleRefreshSpotPricesClick);
ApplyAllChanges_Button.addEventListener("click", HandleApplyAllChangesClick);
ResetSavedData_Button.addEventListener("click", HandleResetSavedDataClick);

if (DownloadCsv_Button) {
  DownloadCsv_Button.addEventListener("click", HandleDownloadCsvClick);
}

// --------------------------------------------------
// Bias slider wiring
// --------------------------------------------------

function HandleBiasTowardRetailPercent_Slider_Input() {
  if (!BiasTowardRetailPercent_Slider) {
    return;
  }

  const newValue_Int = ClampInt_0To100(BiasTowardRetailPercent_Slider.value);

  SaveBiasTowardRetailPercent_Int(newValue_Int);
  UpdateBiasUi_FromStoredValue();
  Render();
}

if (BiasTowardRetailPercent_Slider) {
  BiasTowardRetailPercent_Slider.addEventListener("input", HandleBiasTowardRetailPercent_Slider_Input);
}

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function Startup_RefreshSpotOnlyAsync() {
  try {
    const result = await RefreshSpotCacheFromBackendAsync();
    Render();

    // CHANGED:
    // Do NOT append errors to the UI.
    // Log to console only.
    if (result && result.errors && result.errors.length > 0) {
      console.warn("Spot refresh errors:", result.errors);
    }
  } catch (err) {
    Render();
    LastUpdated_Element.textContent =
      "Offline mode (using cached spot if available). " + String(err);
  }
}

async function StartupAsync() {
  EnsureOwnedStateSeeded_FromCatalogIfMissing();
  UpdateBiasUi_FromStoredValue();
  Render();
  await Startup_RefreshSpotOnlyAsync();
}

StartupAsync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}