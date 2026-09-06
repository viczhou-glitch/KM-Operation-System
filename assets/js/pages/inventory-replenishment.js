// Inventory Replenishment - Add SKU Modal

// F1-4B-FM5-R4UI-R3 (§9): the visible "Target Days" filter was removed — the canonical replenishment horizons are
// FIXED at D18/D30/D45/D90 and the materialized gap authority never consumes a UI target-days value, so a user must
// not be able to alter the horizon authority. This internal constant preserves the ONE legacy consumer that still
// records a target-days figure in the shipping-plan Decision Snapshot (snapshot_target_days / allocation draft).
var REPLEN_TARGET_DAYS = 90;

// F1-SHIPMENT-INCOMING-R4 — canonical MUTUALLY-EXCLUSIVE ETA bucket model for the "Shipping Shipment" card.
// A shipment line's REMAINING incoming (max(0, shipment_qty − shipment_received_qty)) lands in EXACTLY ONE
// bucket by its ETA distance in whole days from today. NOT cumulative (a +25-day line is 19_30 ONLY, never
// also 0_18). Boundaries: 0–18 (0..18) · 19–30 · 31–45 · 45+ (>=46). ETA before today (< 0) is OVERDUE — the
// planning authority has no canonical overdue treatment (reported SHIPMENT_OVERDUE_BUCKET_AUTHORITY_GAP), so
// this returns a distinct 'overdue' key by default; pass foldOverdueIntoEarliest=true to fold it into 0_18.
// Pure: no clock (caller supplies etaDays), no locale, no mutation.
function _irShipmentEtaBucket(etaDays, foldOverdueIntoEarliest) {
  var d = parseFloat(etaDays);
  if (!isFinite(d)) return 'unknown';
  if (d < 0) return foldOverdueIntoEarliest ? 'd0_18' : 'overdue';
  if (d <= 18) return 'd0_18';
  if (d <= 30) return 'd19_30';
  if (d <= 45) return 'd31_45';
  return 'd45_plus';
}

// Frontend mirror of the canonical remaining-incoming authority (backend owner = supply candidate
// quantityRemaining / procShipmentRemainingQty_). max(0, shipmentQty − receivedQty); blank/invalid → 0.
function _irRemainingIncoming(shipmentQty, receivedQty) {
  var s = parseFloat(shipmentQty); if (!isFinite(s) || s < 0) s = 0;
  var r = parseFloat(receivedQty); if (!isFinite(r) || r < 0) r = 0;
  var rem = s - r;
  return rem > 0 ? rem : 0;
}

// Aggregate remaining incoming into the four mutually-exclusive ETA buckets. lines = [{ etaDays, remaining }].
// Returns { d0_18, d19_30, d31_45, d45_plus, overdue } (numbers). This is the bucket MODEL the card consumes
// once wired to real shipment data; it never double-counts a line across buckets.
function _irBucketRemainingByEta(lines, foldOverdueIntoEarliest) {
  var b = { d0_18: 0, d19_30: 0, d31_45: 0, d45_plus: 0, overdue: 0, unknown: 0 };
  (lines || []).forEach(function (ln) {
    var key = _irShipmentEtaBucket(ln.etaDays, foldOverdueIntoEarliest);
    var q = parseFloat(ln.remaining); if (!isFinite(q) || q < 0) q = 0;
    b[key] = (b[key] || 0) + q;
  });
  return b;
}
// F1-SHIPMENT-INCOMING-R5 — canonical receiver identity + shipment→receiver remaining-incoming projection.
// Receiver key = company|country|marketplace|sku (lowercased). NEVER derived from destination display text
// or warehouse_code; warehouse identity is separate. A MULTI-marketplace (merged) shipment keys as
// '…|multi|…' so it never lands on a specific-marketplace receiver row (merged per-receiver split has no
// frozen shipment-line→plan-line linkage — MERGED_SHIPMENT_FROZEN_SHARE_AUTHORITY_GAP; excluded here).
function _irReceiverKey(company, country, marketplace, sku) {
  return [company, country, marketplace, sku].map(function (x) { return String(x == null ? '' : x).trim().toLowerCase(); }).join('|');
}
// R7C: mirrors the core owner's isSpecificReceiver — a receiver is specific only with a company + country +
// a non-merged marketplace (blank / multi / merged / mixed / combined are NOT a specific receiver).
function _irIsSpecificReceiver(company, country, marketplace) {
  var c = String(company == null ? '' : company).trim(), cy = String(country == null ? '' : country).trim();
  var m = String(marketplace == null ? '' : marketplace).trim().toLowerCase();
  return c.length > 0 && cy.length > 0 && m.length > 0 && !/multi|merged|mixed|combined/.test(m);
}
// Strict YYYY-MM-DD → UTC ms (midnight). Returns null on anything else (no clock, no locale).
function _irEtaMs(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
// Terminal shipment statuses contribute ZERO incoming (mirrors the procurement CLOSED set / R4 filter).
var _IR_TERMINAL_SHIPMENT_STATUS = { completed: 1, received: 1, closed: 1, cancelled: 1, canceled: 1, delivered: 1 };

// ONE projection owner: shipments + shipment_lines → { receiverKey → { overdue, d0_18, d19_30, d31_45,
// d45_plus, unknown } } of REMAINING incoming (MAX(0, shipment_qty − shipment_received_qty)), bucketed
// mutually-exclusively by the shipment ETA distance in whole days from todayMs. Terminal shipments and
// fully-received lines contribute 0. wh_on_the_way_* is NEVER read. Pure (todayMs supplied by caller).
// lineReceiverById (R6, optional): shipping_plan_line_id → { company, country, marketplace } FROZEN receiver
// lineage. When a shipment line carries valid lineage, the line is attributed to that receiver (this is how a
// MERGED/MULTI shipment's lines land on their real receivers — deterministic, dispatch-time, never live FC
// Share). When absent (historical rows / ordinary shipments), the shipment HEADER scope is used (ordinary =
// correct; MULTI header → '…|multi|…' → excluded from any specific-marketplace receiver, exactly as R5).
function _irBuildShipmentRemainingByReceiver(shipments, shipmentLines, todayMs, lineReceiverById) {
  var byId = {};
  (shipments || []).forEach(function (s) { if (s && s.shipmentId) byId[s.shipmentId] = s; });
  var lineRecv = lineReceiverById || {};
  var map = {};
  (shipmentLines || []).forEach(function (ln) {
    if (!ln) return;
    var s = byId[ln.shipmentId]; if (!s) return;
    if (_IR_TERMINAL_SHIPMENT_STATUS[String(s.status || '').trim().toLowerCase()]) return;   // terminal → 0
    var remaining = _irRemainingIncoming(ln.shipmentQty, ln.shipmentReceivedQty);
    if (remaining <= 0) return;   // fully received / nothing remaining
    var etaMs = _irEtaMs(s.eta);
    var days = (etaMs === null) ? null : Math.floor((etaMs - todayMs) / 86400000);
    var bucket = (days === null) ? 'unknown' : _irShipmentEtaBucket(days);   // negative → 'overdue'
    // R7C card parity with the core resolver (KMSLS): FROZEN lineage wins (1:1 shipment_line→plan_line). A
    // PRESENT-but-unresolvable lineage FAILS CLOSED — it must NOT silently fall back to the shipment header
    // (that would mis-attribute a merged line to a MULTI/wrong header). Only a BLANK lineage uses header scope
    // (ordinary rows correct; a MULTI header then yields a '…|multi|…' key excluded from specific receivers).
    var rcv;
    if (ln.shippingPlanLineId) {
      var lr = lineRecv[ln.shippingPlanLineId];
      if (!lr || !_irIsSpecificReceiver(lr.company, lr.country, lr.marketplace)) return;   // present but unresolved → fail closed
      rcv = lr;
    } else {
      rcv = s;   // blank lineage → header scope
    }
    var key = _irReceiverKey(rcv.company, rcv.country, rcv.marketplace, ln.sku);
    var rec = map[key] || (map[key] = { overdue: 0, d0_18: 0, d19_30: 0, d31_45: 0, d45_plus: 0, unknown: 0 });
    rec[bucket] += remaining;
  });
  return map;
}
if (typeof window !== 'undefined') {
  window._irShipmentEtaBucket = _irShipmentEtaBucket;
  window._irRemainingIncoming = _irRemainingIncoming;
  window._irBucketRemainingByEta = _irBucketRemainingByEta;
  window._irReceiverKey = _irReceiverKey;
  window._irIsSpecificReceiver = _irIsSpecificReceiver;
  window._irBuildShipmentRemainingByReceiver = _irBuildShipmentRemainingByReceiver;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _irShipmentEtaBucket: _irShipmentEtaBucket, _irRemainingIncoming: _irRemainingIncoming, _irBucketRemainingByEta: _irBucketRemainingByEta, _irReceiverKey: _irReceiverKey, _irIsSpecificReceiver: _irIsSpecificReceiver, _irEtaMs: _irEtaMs, _irBuildShipmentRemainingByReceiver: _irBuildShipmentRemainingByReceiver };
}

function openReplenAddSkuModal() {
  const modal = document.getElementById('replen-add-sku-modal');
  const overlay = document.getElementById('replen-modal-overlay');

  if (!modal || !overlay) return;

  // Marketplace dropdown is sourced from the active marketplaces registry.
  populateReplenAddSkuMarketplaces();

  // Company / Country / Currency are derived (read-only) from the selected marketplace.
  ['replen-add-company', 'replen-add-country', 'replen-add-currency'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.disabled = true;
  });

  // Reset SKU + Site SKU (Site SKU re-prefills from SKU).
  var skuEl = document.getElementById('replen-add-sku');
  if (skuEl) skuEl.value = '';
  var siteEl = document.getElementById('replen-add-site-sku');
  if (siteEl) { siteEl.value = ''; siteEl.dataset.autofill = '1'; }

  modal.classList.add('is-open');
  overlay.classList.add('is-open');
}

// Ensure a select carries (and selects) a value even if it's not in the static option list.
function setSelectValueEnsureOption(sel, val) {
  if (!sel) return;
  val = val || '';
  if (val) {
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === val) { found = true; break; }
    }
    if (!found) {
      var o = document.createElement('option');
      o.value = val; o.textContent = val;
      sel.appendChild(o);
    }
  }
  sel.value = val;
}

// Populate the Add SKU marketplace dropdown from active marketplaces (registry).
function populateReplenAddSkuMarketplaces() {
  var sel = document.getElementById('replen-add-marketplace');
  if (!sel) return;
  var list = _irWsGet('getMarketplaces');   // F1-7J-A: read-model-first (Workspace → _irReadModel; Legacy → getter) — BEFORE==AFTER
  var active = list.filter(function(m) { var s = (m.status || '').toLowerCase(); return !s || s === 'active'; });
  sel.innerHTML = '';
  if (active.length === 0) {
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'No active marketplaces — add one first';
    sel.appendChild(ph);
  } else {
    var ph0 = document.createElement('option');
    ph0.value = '';
    ph0.textContent = 'Select marketplace…';
    sel.appendChild(ph0);
    active.forEach(function(m) {
      var o = document.createElement('option');
      o.value = m.marketplaceId || '';
      o.setAttribute('data-company', m.company || '');
      o.setAttribute('data-country', m.country || '');
      o.setAttribute('data-marketplace', m.marketplace || '');
      o.setAttribute('data-currency', m.currency || '');
      o.setAttribute('data-fulfillment', m.fulfillmentModel || '');
      o.textContent = (m.marketplaceDisplayName || m.marketplace || '') + ' (' + (m.company || '') + ' / ' + (m.country || '') + ')';
      sel.appendChild(o);
    });
  }
  onReplenAddMarketplaceChange();
}

// When a marketplace is selected, auto-fill company / country / currency / marketplace_id.
function onReplenAddMarketplaceChange() {
  var sel = document.getElementById('replen-add-marketplace');
  var opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  var company = opt ? (opt.getAttribute('data-company') || '') : '';
  var country = opt ? (opt.getAttribute('data-country') || '') : '';
  var currency = opt ? (opt.getAttribute('data-currency') || '') : '';
  var ffModel = opt ? (opt.getAttribute('data-fulfillment') || '') : '';
  var mpId = opt ? (opt.value || '') : '';
  setSelectValueEnsureOption(document.getElementById('replen-add-company'), company);
  setSelectValueEnsureOption(document.getElementById('replen-add-country'), country);
  setSelectValueEnsureOption(document.getElementById('replen-add-currency'), currency);
  var idEl = document.getElementById('replen-add-marketplace-id');
  if (idEl) idEl.value = mpId;

  // Fulfillment Model lock rule (platform/self locked; hybrid lets PM choose platform/self).
  var ffSel = document.getElementById('replen-add-fulfillment');
  var ffHint = document.getElementById('replen-add-fulfillment-hint');
  if (!mpId) {
    if (ffSel) { ffSel.innerHTML = '<option value=""></option>'; ffSel.disabled = true; ffSel.value = ''; }
    if (ffHint) ffHint.textContent = 'Select a marketplace first.';
  } else {
    applyFulfillmentLock(ffSel, ffHint, ffModel, '');
  }
  // ASIN required rule: required for Amazon marketplaces, optional otherwise — driven by the SAME owner the
  // submit validation uses (isReplenAmazonMarketplace). Updates immediately on marketplace switch; never clears
  // the existing ASIN value.
  var marketplaceToken = opt ? (opt.getAttribute('data-marketplace') || '') : '';
  updateReplenAsinRequirement(marketplaceToken);
}

// Canonical Amazon-marketplace detection (ONE owner for the ASIN required indicator + submit validation). Matches
// by PLATFORM PREFIX of the canonical marketplace token (AMAZON_<country>, e.g. AMAZON_US / AMAZON_UK / AMAZON_CA,
// and a literal "Amazon") — NOT a hardcoded list of Amazon countries. Non-Amazon tokens (Walmart / KM Walmart /
// WALMART_US / …) return false. "AMAZONIA"-style false-positives are excluded by the letter boundary.
function isReplenAmazonMarketplace(marketplaceToken) {
  var s = String(marketplaceToken == null ? '' : marketplaceToken).trim().toUpperCase();
  return /^AMAZON(?:$|[^A-Z])/.test(s);
}
// Apply the ASIN requirement to the label (* suffix) + input required state from the SAME authority. Never clears
// the value (a marketplace switch keeps whatever ASIN was already typed).
function updateReplenAsinRequirement(marketplaceToken) {
  var amazon = isReplenAmazonMarketplace(marketplaceToken);
  var label = document.getElementById('replen-add-asin-label');
  var input = document.getElementById('replen-add-asin');
  if (label) label.textContent = amazon ? 'ASIN *' : 'ASIN';
  if (input) {
    if (amazon) { input.setAttribute('required', 'required'); input.setAttribute('aria-required', 'true'); }
    else { input.removeAttribute('required'); input.setAttribute('aria-required', 'false'); }
    input.setAttribute('data-asin-required', amazon ? 'true' : 'false');   // shared flag (DOM required state)
  }
}
window.isReplenAmazonMarketplace = isReplenAmazonMarketplace;
window.updateReplenAsinRequirement = updateReplenAsinRequirement;

// Fulfillment Model lock rule (shared by Add SKU / Edit SKU):
//  - marketplace = platform_fulfilled | self_fulfilled  -> SKU value auto-filled + locked.
//  - marketplace = hybrid                               -> PM picks platform_fulfilled / self_fulfilled.
//  - marketplace model unknown/blank                    -> free choice (no enforcement).
var FULFILLMENT_LABELS = { platform_fulfilled: 'Platform Fulfilled', self_fulfilled: 'Self Fulfilled', hybrid: 'Hybrid' };
function applyFulfillmentLock(selectEl, hintEl, marketplaceModel, currentValue) {
  if (!selectEl) return;
  marketplaceModel = String(marketplaceModel || '').trim();
  function opt(v) { return '<option value="' + v + '">' + (FULFILLMENT_LABELS[v] || v) + '</option>'; }
  if (marketplaceModel === 'platform_fulfilled' || marketplaceModel === 'self_fulfilled') {
    selectEl.innerHTML = opt(marketplaceModel);
    selectEl.value = marketplaceModel;
    selectEl.disabled = true;
    if (hintEl) hintEl.textContent = 'Locked — inherited from marketplace (' + FULFILLMENT_LABELS[marketplaceModel] + ').';
  } else if (marketplaceModel === 'hybrid') {
    selectEl.innerHTML = opt('platform_fulfilled') + opt('self_fulfilled');
    selectEl.value = (currentValue === 'platform_fulfilled' || currentValue === 'self_fulfilled') ? currentValue : 'platform_fulfilled';
    selectEl.disabled = false;
    if (hintEl) hintEl.textContent = 'Hybrid marketplace — select this SKU\'s fulfillment model.';
  } else {
    selectEl.innerHTML = '<option value="">(marketplace has no fulfillment model)</option>' + opt('platform_fulfilled') + opt('self_fulfilled') + opt('hybrid');
    selectEl.value = currentValue || '';
    selectEl.disabled = false;
    if (hintEl) hintEl.textContent = 'Marketplace has no fulfillment model set; choose if known.';
  }
}

window.populateReplenAddSkuMarketplaces = populateReplenAddSkuMarketplaces;
window.onReplenAddMarketplaceChange = onReplenAddMarketplaceChange;
window.applyFulfillmentLock = applyFulfillmentLock;

// ============================================================================
// IRMap — Inventory Table Mapping (Phase 1)
// Pure mapping/calculation helpers from existing snapshot/forecast/inventory data
// to the 貨物庫存表 fields. Implements docs/planning/INVENTORY_TABLE_MAPPING_SPEC.md v1.0
// (Stock Card, Long Term Storage, Sales Trend, First Layer Summary, Days-of-Supply UI,
// AI Suggestion column structure, Fulfillment Model foundation).
//
// Constraints: read-only mapping. NO source is fabricated — every missing field/table
// safe-falls-back to 0 / empty (never random / placeholder values that look like data).
// The Need-bucket calculation engine is NOT implemented in Phase 1 (returns 0 structure).
// ============================================================================
window.IRMap = (function () {
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function eq(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  function ymd(s) { return String(s == null ? '' : s).trim().slice(0, 10); }
  // Country compatibility (System Repair 1) — delegates to the shared inventory-compat contract
  // (UK ≡ GB same-market alias; EU sales aggregation handled separately). Safe exact-match fallback
  // if the shared module has not loaded, so behavior degrades to the previous exact comparison.
  function _irCountryMatch(rowCountry, scopeCountry) {
    return (typeof window !== 'undefined' && window.IRCountry)
      ? window.IRCountry.matches(rowCountry, scopeCountry)
      : eq(rowCountry, scopeCountry);
  }

  function todayYmd() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function ymdNDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // Pick the row with the latest snapshotDate matching company + country + sku (marketplace optional).
  // company is enforced only when the row carries one (Amazon snapshot tables have no company column;
  // isolation is guaranteed upstream by the company-scoped SKU universe — see _getCloudReplenishmentData).
  function latestSnapshot(rows, scope) {
    if (!rows || !rows.length) return null;
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!eq(r.sku, scope.sku)) continue;
      if (scope.company && r.company && !eq(r.company, scope.company)) continue;
      // Country is alias-aware (UK ≡ GB — same market; e.g. amazon_inventory_snapshot.country='GB'
      // for an Amazon UK site). NO EU aggregation here — inventory identity is per single market.
      if (scope.country && r.country && !_irCountryMatch(r.country, scope.country)) continue;
      if (scope.marketplace && r.marketplace && !eq(r.marketplace, scope.marketplace)) continue;
      if (!best || ymd(r.snapshotDate) > ymd(best.snapshotDate)) best = r;
    }
    return best;
  }

  // Stock Card ← amazon_inventory_snapshot
  function stockCard(inv) {
    return {
      available: inv ? num(inv.availableQty) : 0,
      fcTransfer: inv ? num(inv.fcTransferQty) : 0,
      fcProcessing: inv ? num(inv.fcProcessingQty) : 0,
      customerOrders: inv ? num(inv.customerOrderQty) : 0,
      unsellable: inv ? num(inv.unfulfillableQty) : 0
    };
  }

  // Long Term Storage ← amazon_inventory_health_snapshot.
  // Over 90+ = 91–180 bucket; Over 180+ = 181_270 + 271_365 + 366_455 + 456_plus.
  // The finer 366_455 / 456_plus buckets may be absent → safe 0 (no error).
  // Long Term Storage (unified, no country branch; missing/blank → 0):
  //   Over 90+  = inv_age_91_to_180_days   (inv_age_0_to_90_days is NOT included)
  //   Over 180+ = inv_age_181_to_270_days + inv_age_271_to_365_days + inv_age_365_plus_days
  //               + inv_age_366_to_455_days + inv_age_456_plus_days
  // (INVENTORY_TABLE_MAPPING_SPEC §5; never uses inv_age_61_to_90_days.)
  function longTermStorage(h) {
    if (!h) return { over90: 0, over180: 0 };
    var over90 = num(h.invAge91To180Days);
    var over180 = num(h.invAge181To270Days) + num(h.invAge271To365Days)
                + num(h.invAge365PlusDays) + num(h.invAge366To455Days) + num(h.invAge456PlusDays);
    return { over90: over90, over180: over180 };
  }

  // Sales Trend — exactly SEVEN calendar dates ending on the LATEST available sales date in the
  // scoped DB result (NOT browser-today, NOT the last N returned rows). Range = latest_db_date − 6
  // … latest_db_date, sorted chronologically. A date within the window with no row is still rendered
  // (its `units` is null = explicit no-data GAP, never a fabricated 0 — see DO-NOT rule). Returns []
  // only when the scope has zero daily rows (honest empty chart). (INVENTORY_TABLE_MAPPING_SPEC §6.)
  function salesTrend7d(dailyRows, scope) {
    var byDate = {}, latest = '';
    // Country membership (System Repair 1): UK ≡ GB alias; Amazon EU sums IT/DE/ES/FR per date
    // (byDate accumulation naturally sums the member markets). Legacy 'EU' rows are used only when no
    // per-country member row exists (salesTrendCountries applies that precedence).
    var _trendSet = (typeof window !== 'undefined' && window.IRCountry)
      ? window.IRCountry.salesTrendCountries(dailyRows || [], scope) : null;
    (dailyRows || []).forEach(function (r) {
      if (!eq(r.sku, scope.sku)) return;
      if (scope.company && r.company && !eq(r.company, scope.company)) return;
      if (scope.country && r.country) {
        if (_trendSet) { if (!_trendSet.any && _trendSet.members.indexOf(window.IRCountry.up(r.country)) === -1) return; }
        else if (!eq(r.country, scope.country)) return;
      }
      if (scope.marketplace && r.marketplace && !eq(r.marketplace, scope.marketplace)) return;
      var d = ymd(r.snapshotDate);
      if (!d) return;
      byDate[d] = (byDate[d] || 0) + num(r.salesUnits);
      if (d > latest) latest = d;   // latest DB date in the SCOPED result
    });
    if (!latest) return [];   // no scoped sales data → honest empty (never fabricated)
    // Build the 7 calendar dates ending on `latest`, oldest → newest.
    var parts = latest.split('-');
    var end = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    var out = [];
    for (var i = 6; i >= 0; i--) {
      var dt = new Date(end.getTime());
      dt.setUTCDate(end.getUTCDate() - i);
      var key = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
      var has = byDate.hasOwnProperty(key);
      out.push({ date: key, label: key.slice(5).replace('-', '/'), units: has ? byDate[key] : null, hasData: has });
    }
    return out;   // always 7 entries when any scoped data exists
  }

  // Avg Sales / Day ← amazon_weekly_sales_snapshot.sales_units_7d / 7 (1 decimal).
  // Country handling (System Repair 1) is delegated to the shared inventory-compat contract:
  //   - single market: the latest week's units (UK ≡ GB alias-aware)
  //   - Amazon EU (scope.country='EU'): SUM of IT + DE + ES + FR (each market's OWN latest week;
  //     legacy pan-EU 'EU' row used only as a fallback, never double-counted)
  // Isolation: Amazon FR/DE/ES/IT and every non-EU context stay single-market. The /7 rounding is
  // unchanged (no formula change). Falls back to the previous exact-match logic if the module is absent.
  function avgSalesPerDay(weeklyRows, scope) {
    if (!weeklyRows || !weeklyRows.length) return 0;
    var units;
    if (typeof window !== 'undefined' && window.IRCountry) {
      units = window.IRCountry.weeklyUnits7d(weeklyRows, scope);
    } else {
      var best = null;
      weeklyRows.forEach(function (r) {
        if (!eq(r.sku, scope.sku)) return;
        if (scope.company && r.company && !eq(r.company, scope.company)) return;
        if (scope.country && r.country && !eq(r.country, scope.country)) return;
        if (scope.marketplace && r.marketplace && !eq(r.marketplace, scope.marketplace)) return;
        var key = r.weekEndDate || r.snapshotWeek || '';
        if (!best || String(key) > String(best.weekEndDate || best.snapshotWeek || '')) best = r;
      });
      units = best ? num(best.salesUnits7d) : null;
    }
    if (units == null) return 0;
    return Math.round((units / 7) * 10) / 10;
  }

  // Resolve the single applicable Target Rule % (SKU > Series > Category). Default 100%.
  function targetPct(rules, scope) {
    if (!rules || !rules.length) return 100;
    function inScope(r) {
      if (r.company && scope.company && !eq(r.company, scope.company)) return false;
      if (r.country && scope.country && !eq(r.country, scope.country)) return false;
      if (r.marketplace && scope.marketplace && !eq(r.marketplace, scope.marketplace)) return false;
      return true;
    }
    var levels = [['sku', scope.sku], ['series', scope.series], ['category', scope.category]];
    for (var i = 0; i < levels.length; i++) {
      var type = levels[i][0], id = levels[i][1];
      if (!id) continue;
      var hit = rules.find(function (r) {
        return inScope(r) && r.scopeType === type && eq(r.scopeId, id) && r.targetPercentage != null;
      });
      if (hit) return num(hit.targetPercentage);
    }
    return 100;
  }

  // F1-4B-FM5-R4UI-R7 §0/§F — canonical "90 days FC" USER REFERENCE field (independent of Planning Model):
  //   SUM of the next 3 forecast months' Base FC  +  SUM of Special Event fc_qty whose applicable month falls
  //   inside those same 3 forecast months (each event counted ONCE). This is a display reference ONLY — NOT
  //   D90 demandQty, NOT Avg Sales/day × 90, NO inventory subtraction, NO gap logic, NO Target% (it is Base FC).
  //   It reuses the SAME already-loaded fc_regular_forecast + fc_special_events facts that power the Forecast
  //   Breakdown + Upcoming Event cards. Sales-Driven and Forecast-Driven SKUs display the SAME reference.
  //   (`rules` retained in the signature for call-site compatibility; Target% is intentionally NOT applied.)
  function forecast60d(fcRows, rules, scope, events) {
    var cm = new Date().getMonth();
    var base = 0;
    if (fcRows && fcRows.length) {
      var fc = fcRows.find(function (r) {
        return eq(r.sku, scope.sku)
          && (!scope.company || !r.company || eq(r.company, scope.company))
          && (!scope.country || !r.country || eq(r.country, scope.country))
          && (!scope.marketplace || !r.marketplace || eq(r.marketplace, scope.marketplace));
      });
      if (fc) base = num(fc[MONTHS[(cm + 1) % 12]]) + num(fc[MONTHS[(cm + 2) % 12]]) + num(fc[MONTHS[(cm + 3) % 12]]);
    }
    // Special events whose applicable calendar month ∈ the next-3 forecast months, active + scope-matched, once.
    var allowed = {}; allowed[((cm + 1) % 12) + 1] = 1; allowed[((cm + 2) % 12) + 1] = 1; allowed[((cm + 3) % 12) + 1] = 1;
    var evtQty = 0;
    (events || []).forEach(function (ev) {
      if (!_irEventActive(ev) || !_irEventScopeMatch(ev, scope)) return;
      var mo = parseEventMonth(ev);
      if (mo === null) { var sd = _irParseDate(ev.eventStartDate); if (sd) mo = sd.getMonth() + 1; }
      if (mo === null || !allowed[mo]) return;
      evtQty += num(ev.fcQty);
    });
    return Math.round(base + evtQty);
  }

  // Planning-only 2-month Target%-adjusted forecast used by the 3PL 18-day site-planning allocation (§20/§23/§24).
  // Kept SEPARATE from the UI "90 days FC" reference (forecast60d) so the R7 §F reference-field redefinition never
  // leaks into a planning/shortage calc. This preserves the pre-R7 3PL allocation behavior byte-for-byte.
  function _irForecastPlanning2mo(fcRows, rules, scope) {
    if (!fcRows || !fcRows.length) return 0;
    var fc = fcRows.find(function (r) {
      return eq(r.sku, scope.sku)
        && (!scope.company || !r.company || eq(r.company, scope.company))
        && (!scope.country || !r.country || eq(r.country, scope.country))
        && (!scope.marketplace || !r.marketplace || eq(r.marketplace, scope.marketplace));
    });
    if (!fc) return 0;
    var cm = new Date().getMonth();
    var pct = targetPct(rules, {
      company: scope.company, country: scope.country, marketplace: scope.marketplace,
      sku: scope.sku, series: fc.series || scope.series, category: fc.category || scope.category
    }) / 100;
    return Math.round((num(fc[MONTHS[(cm + 1) % 12]]) + num(fc[MONTHS[(cm + 2) % 12]])) * pct);
  }

  function parseEventMonth(ev) {
    if (ev.eventMonth) { var em = parseInt(ev.eventMonth, 10); if (em >= 1 && em <= 12) return em; }
    var m = String(ev.eventPeriod || '').match(/(\d{1,2})\s*[\/\-]/);
    if (m) { var mm = parseInt(m[1], 10); if (mm >= 1 && mm <= 12) return mm; }
    return null;
  }

  // Parse an ISO-ish yyyy-mm-dd (or yyyy/mm/dd) date string → Date (local midnight), else null.
  function _irParseDate(d) {
    var s = String(d == null ? '' : d).trim(); if (!s) return null;
    var m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); if (!m) return null;
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  // First day of the month, addMonths from `date`.
  function _irFirstOfMonthPlus(date, addMonths) { return new Date(date.getFullYear(), date.getMonth() + addMonths, 1); }
  // Event is active unless explicitly inactive/cancelled/archived/closed (blank status = active, since
  // the live schema has no status column yet — never silently drop a blank-status event).
  function _irEventActive(ev) {
    var st = String(ev.status == null ? '' : ev.status).trim().toLowerCase();
    return !(st === 'inactive' || st === 'cancelled' || st === 'canceled' || st === 'archived' || st === 'closed' || st === 'draft');
  }
  function _irEventScopeMatch(ev, scope) {
    if (ev.country && scope.country && !eq(ev.country, scope.country)) return false;
    if (ev.marketplace && scope.marketplace && !eq(ev.marketplace, scope.marketplace)) return false;
    return (ev.sku && eq(ev.sku, scope.sku)) ||
      (ev.scopeType === 'sku' && eq(ev.scopeId, scope.sku)) ||
      (ev.scopeType === 'series' && eq(ev.scopeId, scope.series)) ||
      (ev.scopeType === 'category' && eq(ev.scopeId, scope.category)) ||
      (!ev.sku && !ev.scopeId);
  }

  // Dynamic Upcoming Events (scope-matched, active) from today through the next three calendar months.
  // Eligibility: event_end_date >= today AND event_start_date < first_day_of_month(today + 4 months).
  // Legacy rows without parseable start/end dates fall back to a month-window check (never dropped).
  // Returns the matched events (NOT merged) sorted nearest-first — the caller may total them, but the
  // underlying records stay separate.
  function upcomingEvents(events, scope) {
    if (!events || !events.length) return [];
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var windowEnd = _irFirstOfMonthPlus(today, 4);   // exclusive upper bound (start < windowEnd)
    var out = [];
    events.forEach(function (ev) {
      if (!_irEventActive(ev)) return;
      if (!_irEventScopeMatch(ev, scope)) return;
      var start = _irParseDate(ev.eventStartDate);
      var end = _irParseDate(ev.eventEndDate);
      if (start && end) {
        if (!(end >= today && start < windowEnd)) return;
      } else {
        // Legacy fallback: month-based window (current month + next 3). Unparseable month → included.
        var mo = parseEventMonth(ev);
        if (mo !== null) {
          var allowed = [today.getMonth() + 1, ((today.getMonth() + 1) % 12) + 1, ((today.getMonth() + 2) % 12) + 1, ((today.getMonth() + 3) % 12) + 1];
          if (allowed.indexOf(mo) === -1) return;
        }
      }
      out.push(ev);
    });
    out.sort(function (a, b) {
      var sa = _irParseDate(a.eventStartDate), sb = _irParseDate(b.eventStartDate);
      if (sa && sb) return sa - sb; if (sa) return -1; if (sb) return 1; return 0;
    });
    return out;
  }

  // Upcoming Event total = sum of fc_qty across the matched events (count-once; records stay separate).
  function upcomingEventQty(events, scope) {
    var list = upcomingEvents(events, scope);
    return list.reduce(function (s, ev) { return s + num(ev.fcQty); }, 0);
  }

  // 3rd Party Stock = Σ available_stock across eligible overseas warehouses (same country).
  function thirdPartyStock(overseasRows, warehouses, scope) {
    if (!overseasRows || !overseasRows.length) return 0;
    var whById = {};
    (warehouses || []).forEach(function (w) { if (w.warehouseId) whById[w.warehouseId] = w; });
    var total = 0;
    overseasRows.forEach(function (r) {
      if (!eq(r.sku, scope.sku)) return;
      var wh = whById[r.warehouseId];
      // Eligible = same country; exclude factory warehouses (warehouse country is the source of truth).
      if (wh) {
        if (scope.country && wh.country && !eq(wh.country, scope.country)) return;
        var isFactory = String((wh.raw && wh.raw.is_factory_warehouse) || '').toLowerCase();
        if (isFactory === 'true' || isFactory === '1' || isFactory === 'yes') return;
      }
      total += num(r.availableStock);
    });
    return total;
  }

  // ===== 3PL shared-pool 18-day virtual planning allocation (SUPPLY_PLANNING_CALCULATION_RULES §20/§23/§24) =====
  // Analysis/display only — moves no inventory, reserves nothing, writes nothing, creates no movement.

  // Eligible 3PL warehouses for a company+country scope: warehouse_type='3PL', is_active TRUE,
  // company AND country match. Never matched by warehouse_name / display text (identity is warehouse_id).
  function eligible3plWarehouses(warehouses, scope) {
    return (warehouses || []).filter(function (w) {
      if (!w || !w.warehouseId) return false;
      if (scope.company) { if (!w.company || !eq(w.company, scope.company)) return false; }
      if (scope.country) { if (!w.country || !eq(w.country, scope.country)) return false; }
      if (String(w.warehouseType || '').trim().toUpperCase() !== '3PL') return false;
      if (w.isActive !== true) return false;   // tri-state _whBool: require explicit TRUE (blank/unknown excluded)
      return true;
    });
  }

  // Shared physical pool for company+country+Master SKU. Joins overseas_inventory_snapshot to eligible
  // 3PL warehouses by warehouse_id + sku, retains warehouse-level detail, dedups by warehouse_id
  // (never by marketplace). Returns eligibility + snapshot presence so callers can show honest states.
  function sharedPhysicalPool(overseasRows, warehouses, scope) {
    var eligible = eligible3plWarehouses(warehouses, scope);
    var eligById = {}; eligible.forEach(function (w) { eligById[w.warehouseId] = w; });
    var byWh = {}; var snapshotAt = ''; var matchedAny = false;
    (overseasRows || []).forEach(function (r) {
      if (!eq(r.sku, scope.sku)) return;
      if (!eligById[r.warehouseId]) return;   // join strictly on eligible warehouse_id + sku
      matchedAny = true;
      byWh[r.warehouseId] = (byWh[r.warehouseId] || 0) + (num(r.availableStock) || 0);
      var ts = r.snapshotDate || r.lastMovementAt || r.updatedAt || r.createdAt || '';
      if (String(ts) > String(snapshotAt)) snapshotAt = String(ts);
    });
    var contributions = eligible.map(function (w) {
      return { warehouseId: w.warehouseId, warehouseName: w.warehouseName || w.warehouseId,
        qty: byWh[w.warehouseId] || 0, hasRow: Object.prototype.hasOwnProperty.call(byWh, w.warehouseId) };
    });
    var poolQty = contributions.reduce(function (s, c) { return s + c.qty; }, 0);
    return { eligibleCount: eligible.length, hasEligibleWarehouse: eligible.length > 0,
      hasSnapshot: matchedAny, poolQty: poolQty, contributions: contributions, snapshotAt: snapshotAt };
  }

  function _findMktReg(reg, scope) {
    return (reg || []).filter(function (m) {
      return (scope.marketplaceId && m.marketplaceId && m.marketplaceId === scope.marketplaceId) ||
        (eq(m.country, scope.country) && eq(m.marketplace, scope.marketplace) && (!scope.company || eq(m.company, scope.company)));
    })[0] || null;
  }

  // Allocate the shared pool across eligible self-fulfilled sites (§24). PHASE-1 SCOPE:
  //  - NORMAL (pool >= Σ 18-day need): each site protected to its 18-day need; the remainder stays
  //    UNALLOCATED. The §24.5-step-3 / Mode-B distribution of surplus BEYOND the 18-day floor requires
  //    the site's "applicable calculated Need" (Suggested-Qty engine), which is NOT implemented and which
  //    this task must not enable — so no surplus is distributed (reported as a known gap).
  //  - SHORTAGE (pool < Σ 18-day need): §24.7 weighted largest-remainder, deterministic tie-break
  //    (higher allocation_priority → larger unmet 18-day need → stable marketplace key). Caps at need.
  // Invariant: Σ allocations ≤ pool; each ≤ its 18-day need; non-negative integers; deterministic.
  function _allocateShared(pool, sites) {
    var byKey = {}; sites.forEach(function (s) { byKey[s.key] = 0; });
    var sumNeed = sites.reduce(function (a, s) { return a + Math.max(s.minNeed, 0); }, 0);
    if (!sites.length || sumNeed <= 0) {
      return { mode: 'NO_DEMAND', byKey: byKey, coverageRate: null,
        basis: 'No 18-day demand for any eligible site', warn: '' };
    }
    if (pool >= sumNeed) {
      sites.forEach(function (s) { byKey[s.key] = Math.max(s.minNeed, 0); });
      return { mode: 'NORMAL_ALLOCATION', byKey: byKey, coverageRate: 1,
        basis: '18-day protected need — each eligible site fully protected; surplus unallocated', warn: '' };
    }
    // SHORTAGE (§24.7)
    var rows = sites.map(function (s) {
      var w = Math.max(s.minNeed, 0) * Math.max(s.allocationPriority, 1);
      return { s: s, w: w };
    });
    var sumW = rows.reduce(function (a, x) { return a + x.w; }, 0);
    rows.forEach(function (x) {
      var raw = sumW > 0 ? (pool * x.w / sumW) : 0;
      var fl = Math.floor(raw);
      if (fl > x.s.minNeed) fl = x.s.minNeed;
      x.raw = raw; x.frac = raw - Math.floor(raw); x.qty = fl;
    });
    var assigned = rows.reduce(function (a, x) { return a + x.qty; }, 0);
    var remainder = pool - assigned;
    var order = rows.slice().sort(function (a, b) {
      if (b.frac !== a.frac) return b.frac - a.frac;                                  // largest remainder
      if (b.s.allocationPriority !== a.s.allocationPriority) return b.s.allocationPriority - a.s.allocationPriority; // (1)
      var ua = a.s.minNeed - a.qty, ub = b.s.minNeed - b.qty;
      if (ub !== ua) return ub - ua;                                                  // (2) larger unmet 18-day need
      return String(a.s.key) < String(b.s.key) ? -1 : (String(a.s.key) > String(b.s.key) ? 1 : 0); // (3) stable key
    });
    while (remainder > 0) {
      var placed = false;
      for (var i = 0; i < order.length && remainder > 0; i++) {
        if (order[i].qty < order[i].s.minNeed) { order[i].qty += 1; remainder -= 1; placed = true; }
      }
      if (!placed) break;   // every site capped at its 18-day need
    }
    rows.forEach(function (x) { byKey[x.s.key] = x.qty; });
    var warn = rows.some(function (x) { return x.qty === 0 && x.s.minNeed > 0; })
      ? 'Shortage: a site is allocated 0 vs its 18-day need — review allocation_priority.' : '';
    return { mode: 'SHORTAGE_ALLOCATION', byKey: byKey, coverageRate: pool / sumNeed,
      basis: 'Weighted shortage (18-day need × priority), deterministic largest-remainder', warn: warn };
  }

  // Orchestrator: build the pool + eligible self-fulfilled sibling sites (same company+country+Master
  // SKU), run the §24 engine, and return the CURRENT site's planning allocation + full display detail.
  // ctx = { scope, overseasRows, warehouses, mpSkus, marketplacesReg, weeklyRows, fcRows, targetRules }
  function sitePlanningAllocation(ctx) {
    var scope = ctx.scope;
    var pool = sharedPhysicalPool(ctx.overseasRows, ctx.warehouses, scope);

    // 3PL reserve is REPLENISHMENT RESERVE for the whole company+country scope. Fulfillment type does
    // NOT gate participation (fix 2026-07-22): a platform-fulfilled marketplace can still own/use the
    // overseas 3PL reserve as future platform-warehouse replenishment. Eligibility is warehouse-side
    // only (company + country + warehouse_type='3PL' + is_active), never marketplace fulfillment model.
    var participates = true;

    // Sibling sites sharing this pool = every scoped marketplace_sku (company + country + Master SKU),
    // regardless of fulfillment model. Each contributes its 18-day need to the shared allocation.
    var siteRows = (ctx.mpSkus || []).filter(function (m) {
      return eq(m.sku, scope.sku) && eq(m.country, scope.country) && (!scope.company || eq(m.company, scope.company)); });
    var sites = [];
    siteRows.forEach(function (m) {
      var reg = _findMktReg(ctx.marketplacesReg, { company: m.company, country: m.country, marketplace: m.marketplace, marketplaceId: m.marketplaceId });
      var siteScope = { company: m.company, country: m.country, marketplace: m.marketplace, sku: m.sku, series: '', category: '' };
      var demandMode = (m.replenishmentModel || 'sales_driven');
      var daily;
      if (demandMode === 'forecast_driven') {
        var fc60 = _irForecastPlanning2mo(ctx.fcRows, ctx.targetRules, siteScope);   // planning-only (NOT the UI 90-day reference)
        daily = fc60 > 0 ? (fc60 / 60) : 0;
      } else {
        daily = avgSalesPerDay(ctx.weeklyRows, siteScope);               // §22 canonical Avg Sales/Day
      }
      sites.push({
        key: m.marketplaceId || (m.company + '|' + m.country + '|' + m.marketplace),
        marketplace: m.marketplace, company: m.company, country: m.country,
        demandMode: demandMode, dailyDemand: daily,
        minNeed: Math.ceil(daily * 18),                                  // §24.4 CEILING(daily × 18)
        allocationPriority: (reg && reg.allocationPriority) || 0,
        isCurrent: eq(m.marketplace, scope.marketplace)
      });
    });

    var alloc = _allocateShared(pool.poolQty, sites);
    var cur = sites.filter(function (s) { return s.isCurrent; })[0];
    var curAlloc = cur ? (alloc.byKey[cur.key] || 0) : 0;
    var allocatedTotal = Object.keys(alloc.byKey).reduce(function (s, k) { return s + alloc.byKey[k]; }, 0);

    var state = 'OK';
    if (!pool.hasEligibleWarehouse) state = 'NO_ELIGIBLE_3PL';
    else if (!pool.hasSnapshot) state = 'MISSING_SNAPSHOT';
    // (No NOT_SELF_FULFILLED state — platform-fulfilled sites participate in the shared 3PL reserve.)

    return {
      state: state, participates: participates,
      sitePlanningAvailable: (state === 'OK') ? curAlloc : null,
      physicalPool: pool.poolQty, minNeed: cur ? cur.minNeed : 0,
      allocationMode: alloc.mode, allocationBasis: alloc.basis,
      allocatedToCurrent: curAlloc, allocatedToOthers: Math.max(allocatedTotal - curAlloc, 0),
      unallocatedPool: Math.max(pool.poolQty - allocatedTotal, 0),
      contributions: pool.contributions, eligibleCount: pool.eligibleCount,
      snapshotAt: pool.snapshotAt, coverageRate: alloc.coverageRate, warn: alloc.warn || '',
      siteCount: sites.length
    };
  }

  // ===== FACTORY: PHYSICAL TOTAL vs THIS SITE'S ALLOCATION (F1-7N-FB-4E-R4B-R1 §1) =========================
  //
  // These are two different numbers and the page used to show only the first one, under every scope. The
  // physical total below is the whole pool; it is a WAREHOUSE fact and belongs to Factory Inventory. What a
  // marketplace site may plan against is its ALLOCATION of that pool, which is what the CN / TW columns render.
  //
  // physicalFactoryByCountry is kept because the conservation proof needs the undivided figure to compare
  // against, and because "what does the factory physically hold" is a real question. It must NEVER be rendered
  // in a marketplace-scoped column again: that is the defect (one pool shown N times as if each site owned it).
  //
  // Σ factory_stock.current_stock joined to warehouses by warehouse_id, filtered by warehouse country (CN / TW).
  // NOTE it sums current_stock, NOT the canonical available quantity - it is the PHYSICAL total by definition.
  function physicalFactoryByCountry(factoryRows, warehouses, sku, countryCode) {
    if (!factoryRows || !factoryRows.length) return 0;
    var whById = {};
    (warehouses || []).forEach(function (w) { if (w.warehouseId) whById[w.warehouseId] = w; });
    var total = 0;
    factoryRows.forEach(function (f) {
      if (!eq(f.sku, sku)) return;
      var wh = whById[f.warehouseId];
      var c = (wh && wh.country) || f.country || '';
      // Fallback: parse country from the WH-{COMPANY}-{COUNTRY}-... id convention.
      if (!c && f.warehouseId) { var parts = f.warehouseId.split('-'); if (parts.length >= 3) c = parts[2]; }
      if (eq(c, countryCode)) total += num(f.currentStock);
    });
    return total;
  }

  // THIS SITE's factory availability - the canonical projection (KMFSA), shared verbatim with Order Planning.
  // ctx = { scope, factoryRows, warehouses, mpSkus, fcRows, calculationMonth }
  // Returns { cn, tw, state, projection }. state names WHY a number is what it is, so a real zero (this site is
  // not an eligible receiver of the TW source) can never be mistaken for a missing one:
  //   OK                      - allocated from at least one pool
  //   NO_FACTORY_STOCK        - no factory_stock row for this SKU at all
  //   NOT_ELIGIBLE            - pools exist but this site is in no eligible receiver set
  //   NO_FORECAST_DENOMINATOR - eligible, but the rolling 4-month FC of the whole receiver set is 0
  //   UNAVAILABLE             - the projection module is not loaded (never a silent physical-total fallback)
  function factorySiteAllocation(ctx) {
    var K = (typeof window !== 'undefined' && window.KM && window.KM.factorySiteAllocation) || null;
    if (!K) return { cn: null, tw: null, state: 'UNAVAILABLE', projection: null };
    var proj;
    try {
      proj = K.project({
        sku: ctx.scope.sku, factoryRows: ctx.factoryRows, warehouses: ctx.warehouses,
        sites: ctx.mpSkus, forecastRows: ctx.fcRows, calculationMonth: ctx.calculationMonth
      });
    } catch (e) { return { cn: null, tw: null, state: 'UNAVAILABLE', projection: null }; }
    var mine = K.siteFactoryAvailability(proj, ctx.scope);
    var state = 'OK';
    if (!proj.pools.length) state = 'NO_FACTORY_STOCK';
    else if (mine.total === 0) {
      var eligibleAnywhere = false, zeroDenom = false;
      proj.pools.forEach(function (p) {
        if (p.eligibleSiteKeys.indexOf(mine.siteKey) !== -1) {
          eligibleAnywhere = true;
          if (p.unallocatedReason === 'ZERO_FORECAST_DENOMINATOR') zeroDenom = true;
        }
      });
      state = !eligibleAnywhere ? 'NOT_ELIGIBLE' : (zeroDenom ? 'NO_FORECAST_DENOMINATOR' : 'OK');
    }
    return { cn: mine.cn, tw: mine.tw, state: state, projection: proj };
  }

  function daysOfSupply(currentStock, avgPerDay) {
    if (!avgPerDay || avgPerDay <= 0) return null; // undefined coverage — show '--', never fake
    return Math.round((num(currentStock) / avgPerDay) * 10) / 10;
  }

  // Days of Supply UI color: <30 red, 30–150 normal, >150 khaki/brown (long inventory warning).
  function dosColorClass(dos) {
    if (dos === null || dos === undefined || dos === '' || dos === '--') return '';
    var n = parseFloat(dos);
    if (isNaN(n)) return '';
    if (n < 30) return 'ir-dos--red';
    if (n > 150) return 'ir-dos--khaki';
    return '';
  }

  // Fulfillment model resolution + lock rule (Marketplace SKU overrides only when marketplace = hybrid).
  function resolveFulfillment(mpRow, mpSkuRow) {
    var mpModel = (mpRow && mpRow.fulfillmentModel) || '';
    var skuModel = (mpSkuRow && mpSkuRow.fulfillmentModel) || '';
    if (mpModel === 'platform_fulfilled') return { model: 'platform_fulfilled', locked: true, source: 'marketplace' };
    if (mpModel === 'self_fulfilled') return { model: 'self_fulfilled', locked: true, source: 'marketplace' };
    if (mpModel === 'hybrid') return { model: skuModel || 'hybrid', locked: false, source: skuModel ? 'sku' : 'marketplace' };
    // Marketplace model unknown (column absent): fall back to the SKU-level value if present.
    return { model: skuModel || '', locked: false, source: skuModel ? 'sku' : 'none' };
  }

  // Need-bucket structure. Phase 1: the calculation engine is NOT implemented → return 0s.
  // The bucket windows and Suggested Qty roll-up shape match the spec so the engine can drop in.
  function needBuckets() {
    return { need0_18: 0, need19_30: 0, need31_45: 0, need46_90: 0, suggestedQty: 0 };
  }

  return {
    num: num, latestSnapshot: latestSnapshot, stockCard: stockCard,
    longTermStorage: longTermStorage, salesTrend7d: salesTrend7d, avgSalesPerDay: avgSalesPerDay,
    targetPct: targetPct, forecast60d: forecast60d, upcomingEventQty: upcomingEventQty, upcomingEvents: upcomingEvents,
    thirdPartyStock: thirdPartyStock, physicalFactoryByCountry: physicalFactoryByCountry,
    factorySiteAllocation: factorySiteAllocation,
    eligible3plWarehouses: eligible3plWarehouses, sharedPhysicalPool: sharedPhysicalPool,
    sitePlanningAllocation: sitePlanningAllocation,
    daysOfSupply: daysOfSupply, dosColorClass: dosColorClass,
    resolveFulfillment: resolveFulfillment, needBuckets: needBuckets
  };
})();

// Format an Upcoming Event date range as "M.D~M.D" for the 3-month window (year always dropped —
// same-month 7.27~7.31, cross-month 7.29~8.4, cross-year 12.29~1.4 all render year-less). Parsing is
// done by regex on the Y-M-D / Y.M.D / Y/M/D string (NOT new Date()) to avoid any UTC off-by-one
// shift. The underlying event dates are NEVER mutated — this is display formatting only. Returns null
// when neither end parses so callers keep their existing safe fallback.
function _irParseYMD(s) {
    if (s == null) return null;
    var m = String(s).trim().match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return null;
    var mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    return { m: mo, d: d };
}
function _irFmtEventDate(s) {
    var p = _irParseYMD(s);
    return p ? (p.m + '.' + p.d) : null;
}
function _irFmtEventRange(start, end) {
    var a = _irFmtEventDate(start), b = _irFmtEventDate(end);
    if (a && b) return a + '~' + b;
    return a || b || null;
}
window._irFmtEventRange = _irFmtEventRange;

// Render the Upcoming Event card body from a matched, nearest-first event list (IRMap.upcomingEvents):
// nearest event (name + start/end + fc_qty) shown first, remaining events in an expandable "+N more"
// (native <details> — keyboard accessible). Events are displayed separately (never merged into one row).
function _irRenderUpcoming(list) {
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function qty(v){ return (window.IRMap && IRMap.num) ? IRMap.num(v) : (parseFloat(v) || 0); }
  if (!list || !list.length) {
    return '<div class="replen-card__row"><span class="replen-card__label">No upcoming event</span><span class="replen-card__value">-</span></div>';
  }
  function line(ev){
    // Display "M.D~M.D" (year-less); keep the full range in title= for accessibility / hover.
    var fullR = (ev.eventStartDate && ev.eventEndDate) ? (ev.eventStartDate + ' ~ ' + ev.eventEndDate) : (ev.eventPeriod || '');
    var dates = _irFmtEventRange(ev.eventStartDate, ev.eventEndDate) || fullR;
    var titleAttr = fullR ? (' title="' + esc(fullR) + '"') : '';
    return '<div class="replen-card__row"><span class="replen-card__label">' + esc(ev.event || ev.scopeId || 'Event') +
      (dates ? (' <span class="replen-evt-dates"' + titleAttr + '>(' + esc(dates) + ')</span>') : '') +
      '</span><span class="replen-card__value">' + qty(ev.fcQty) + '</span></div>';
  }
  var html = line(list[0]);
  if (list.length > 1) {
    html += '<details class="replen-evt-more"><summary>+' + (list.length - 1) + ' more</summary>' +
      list.slice(1).map(line).join('') + '</details>';
  }
  return html;
}

// Render the 3rd Party Stock (Site Planning Available) detail body from a sitePlanningAllocation() result.
// Honest missing-data states — never a fabricated zero. Labels the number "Planning Available" (a
// distribution of the shared pool), never implying the site owns the whole pool.
// 3rd Party Stock card — SIMPLIFIED daily view (2026-07-22): shows only the physical 3PL warehouses
// contributing stock to the current Company/Country/Marketplace/SKU scope + their Available Physical
// Quantity + an optional Total. The full allocation/runtime detail (site_planning_available,
// physical_3pl_pool, protected_need, allocation_method, allocated_to_other_sites, unallocated_pool,
// coverage_rate, snapshot_as_of, priority/weighted-shortage/largest-remainder) is NOT deleted — it
// stays on the returned `plan` object (thirdPartyPlan) for the replenishment/shortage engine, the API
// response, and Admin Debug / Calculation Details. It is only hidden from this daily SKU-expand card.
function _irRenderThirdPartyDetail(plan) {
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmt(v){ return (Math.round(Number(v)) || 0).toLocaleString(); }
  function whRow(name, qty){ return '<div class="replen-card__row replen-tp-wh"><span class="replen-card__label">' + esc(name) + '</span><span class="replen-card__value">' + fmt(qty) + '</span></div>'; }
  if (!plan) return '<div class="replen-tp-empty">No 3rd Party Stock</div>';
  // SINGLE shared source (Round 4 Decision A): the summary total and this detail use the SAME rows
  // from IRWarehouse.buildPhysicalThirdPartyBreakdown → total = SUM(rows.qty). One row per physical
  // 3PL warehouse (deduped by warehouse_id; UK/GB same physical row never double-counted). Physical
  // availability only — never sitePlanningAvailable / FBA / virtual allocation.
  var bd = (window.IRWarehouse && window.IRWarehouse.buildPhysicalThirdPartyBreakdown)
    ? window.IRWarehouse.buildPhysicalThirdPartyBreakdown(plan)
    : { rows: (plan.contributions || []).map(function (c) { return { warehouseName: c.warehouseName || c.warehouseId, qty: Number(c.qty) || 0 }; }), total: 0, hasRows: (plan.contributions || []).length > 0 };
  var visible = bd.rows.filter(function (r) { return (Number(r.qty) || 0) > 0; });
  if (!visible.length) return '<div class="replen-tp-empty">No 3rd Party Stock</div>';
  var html = visible.map(function (r) { return whRow(r.warehouseName || r.warehouseId, r.qty); }).join('');
  html += '<div class="replen-card__row replen-tp-total"><span class="replen-card__label">Total</span><span class="replen-card__value">' + fmt(bd.total) + '</span></div>';
  return html;
}

// Persisted Recommendation Summary snapshot for a scope + SKU. Reads the active shipping_allocation_draft
// (SSOT) matching company+country+marketplace whose status is not cancelled, returns its RAW draft-line
// rows for this SKU (snake_case, as the Recommendation Summary reads them). Empty [] → honest empty state
// (no recommendation generated / backend not deployed). The engine that fills these is NOT activated here.
function _shippingDraftLinesFor(scope, drafts, lines) {
    if (!scope || !drafts || !drafts.length || !lines || !lines.length) return [];
    function lo(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
    var draft = drafts.filter(function (d) {
        return lo(d.country) === lo(scope.country) && lo(d.marketplace) === lo(scope.marketplace) &&
            (!scope.company || !d.company || lo(d.company) === lo(scope.company)) &&
            lo(d.status) !== 'cancelled';
    }).sort(function (a, b) { return String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1; })[0];
    if (!draft) return [];
    return lines.filter(function (l) {
        return l.allocationDraftId === draft.allocationDraftId && lo(l.sku) === lo(scope.sku);
    }).map(function (l) { return l.raw || l; });   // raw snake_case rows for the Recommendation Summary
}

// Plain-text tooltip for the results-table 3rd Party Stock cell (hover). Detail lives in the expand card.
function _irThirdPartyTitle(plan) {
  // Simplified hover: list the contributing physical 3PL warehouses (name + qty). Allocation detail
  // stays on the plan object for the engine / Admin Debug, not surfaced here.
  if (!plan) return '';
  var contribs = (plan.contributions || []).filter(function (c) { return (Number(c.qty) || 0) > 0; })
    .sort(function (a, b) { return (Number(b.qty) - Number(a.qty)) || String(a.warehouseName || '').localeCompare(String(b.warehouseName || '')); });
  if (!contribs.length) return 'No 3rd Party Stock in scope.';
  return '3rd Party Stock (physical, by warehouse):\n' +
    contribs.map(function (c) { return (c.warehouseName || c.warehouseId) + ': ' + Math.round(c.qty).toLocaleString(); }).join('\n');
}

function closeReplenModal() {
  const modal = document.getElementById('replen-add-sku-modal');
  const overlay = document.getElementById('replen-modal-overlay');
  
  if (!modal || !overlay) return;
  
  modal.classList.remove('is-open');
  overlay.classList.remove('is-open');
  
  const skuInput = document.getElementById('replen-add-sku');
  if (skuInput) skuInput.value = '';

  const siteInput = document.getElementById('replen-add-site-sku');
  if (siteInput) { siteInput.value = ''; siteInput.dataset.autofill = '1'; }
}

// F1-SMALL: after a CONFIRMED successful Add SKU, reset the WHOLE modal form to a brand-new-SKU state so the
// NEXT open never inherits the just-created SKU's field values. The Inventory Add SKU modal has NO draft cache —
// closeReplenModal()/open reset only SKU + Site SKU, so ASIN / Product URL / Launch Date / Planning Model /
// Fulfillment leaked across a successful create. This clears exactly those leaked DOM fields (text → blank;
// selects → their existing HTML default option — NO invented defaults; marketplace/company/country/currency
// re-derive on the next open via populateReplenAddSkuMarketplaces). Called ONLY on success; Cancel/close and the
// failure branches are deliberately untouched so unsaved / failed values are preserved for retry.
function resetReplenAddSkuForm() {
  ['replen-add-sku', 'replen-add-site-sku', 'replen-add-asin', 'replen-add-product-url', 'replen-add-launch-date'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  var siteEl = document.getElementById('replen-add-site-sku'); if (siteEl) siteEl.dataset.autofill = '1';
  ['replen-add-model', 'replen-add-fulfillment'].forEach(function (id) {
    var sel = document.getElementById(id); if (sel && sel.options && sel.options.length) sel.selectedIndex = 0;   // existing HTML default option
  });
}
window.resetReplenAddSkuForm = resetReplenAddSkuForm;

function saveReplenSku() {
  const sku = document.getElementById('replen-add-sku')?.value.trim();
  let siteSku = (document.getElementById('replen-add-site-sku')?.value || '').trim();
  const status = 'active';
  const model = document.getElementById('replen-add-model')?.value || 'sales_driven';
  const launchDate = document.getElementById('replen-add-launch-date')?.value || '';
  const fulfillmentModel = document.getElementById('replen-add-fulfillment')?.value || '';
  // SKU Domain v2.0: the field is a platform-neutral marketplace_product_id (UI may label it "ASIN"
  // for Amazon). We send marketplace_product_id and never write the legacy `asin` column.
  const asinEl = document.getElementById('replen-add-asin');
  const marketplaceProductId = asinEl ? asinEl.value.trim() : '';
  // product_url is a regional identity field (sku_regional_details.product_url). Required on Add SKU.
  const productUrl = (document.getElementById('replen-add-product-url')?.value || '').trim();

  // Company / country / marketplace / currency / marketplace_id come from the selected
  // marketplaces-registry option (authoritative), so they stay consistent.
  const mpSelect = document.getElementById('replen-add-marketplace');
  const opt = mpSelect && mpSelect.selectedOptions && mpSelect.selectedOptions[0];
  const marketplaceId = opt ? (opt.value || '').trim() : '';
  const marketplace = opt ? (opt.getAttribute('data-marketplace') || '').trim() : '';
  const company = opt ? (opt.getAttribute('data-company') || '').trim() : '';
  const country = opt ? (opt.getAttribute('data-country') || '').trim() : '';
  const currency = opt ? (opt.getAttribute('data-currency') || '').trim() : '';

  if (!sku) { alert('SKU is required'); return; }
  if (!siteSku) siteSku = sku; // default/prefill from SKU
  if (!marketplaceId || !marketplace || !company || !country) {
    alert('Please select a marketplace. If the list is empty, add one via + Marketplace first.');
    return;
  }
  if (!currency) { alert('The selected marketplace has no currency configured.'); return; }
  // ASIN / marketplace_product_id required ONLY for Amazon marketplaces (case preserved; no fixed length —
  // marketplaces differ). Non-Amazon marketplaces (Walmart / KM Walmart / …) accept an empty ASIN. Same
  // authority (isReplenAmazonMarketplace) that drives the label * / input required state. Empty non-Amazon
  // ASIN keeps the existing blank contract — NO fabricated 'N/A' / 'NONE' placeholder.
  if (isReplenAmazonMarketplace(marketplace) && !marketplaceProductId) { alert('ASIN (Marketplace Product ID) is required for Amazon marketplaces.'); return; }
  // Product URL required. Accept any http(s) URL (do not force a specific marketplace domain).
  if (!productUrl) { alert('Product URL is required.'); return; }
  if (!/^https?:\/\/\S+/i.test(productUrl)) { alert('Product URL must be a valid http:// or https:// link.'); return; }

  // Primary path: shared import backend chain
  // (creates marketplace_skus + pricing_list + fc_regular_forecast).
  if (window.KM && window.KM.DB && window.KM.DB.importMarketplaceSkusBatch) {
    var oneRow = {
      sku: sku,
      company: company,
      country: country,
      marketplace: marketplace,
      marketplace_id: marketplaceId,
      site_sku: siteSku,
      currency: currency,
      marketplace_product_id: marketplaceProductId,
      product_url: productUrl,
      marketplace_sku_status: status,
      replenishment_model: model,
      fulfillment_model: fulfillmentModel,
      launch_date: launchDate
    };
    window.KM.DB.importMarketplaceSkusBatch([oneRow], {
      priceStatusDefault: 'draft',
      forecastStatusDefault: 'draft'
    }).then(function(result) {
      if (!result || result.success === false) {
        alert('Could not add SKU. ' + (result && result.error ? result.error : 'Please check the API connection and try again.'));
        return;
      }
      var data = result.data || {};
      var rr = (data.results && data.results[0]) || {};
      if (rr.status === 'error') {
        alert('Could not add SKU. ' + (rr.message || 'Validation failed.'));
        return;
      }
      alert('SKU "' + sku + '" ' + (rr.status || 'processed') + ' for ' + country + ' - ' + marketplace + (rr.message ? ('\n' + rr.message) : ''));
      closeReplenModal();
      resetReplenAddSkuForm();   // F1-SMALL: confirmed success → clear leaked fields so the next Add SKU starts fresh
      _irAfterWrite(function () { renderReplenishment(); });   // Workspace: scoped re-read; Legacy: render-only
    }).catch(function(err) {
      alert('Error: ' + (err && err.message ? err.message : err));
    });
    return;
  }

  // Fallback: legacy single-row upsert (only if import method is unavailable).
  if (window.KM && window.KM.DB && window.KM.DB.upsertMarketplaceSku) {
    window.KM.DB.upsertMarketplaceSku({
      sku: sku,
      country: country,
      marketplace: marketplace,
      marketplace_sku_status: status,
      replenishment_model: model,
      launch_date: launchDate
    }).then(function(result) {
      if (result && result.success === false) {
        alert('Could not add SKU. ' + (result.error || 'Please check the API connection and try again.'));
        return;
      }
      alert('SKU "' + sku + '" added to ' + country + ' - ' + marketplace);
      closeReplenModal();
      resetReplenAddSkuForm();   // F1-SMALL: confirmed success → clear leaked fields so the next Add SKU starts fresh
      _irAfterWrite(function () { renderReplenishment(); });   // Workspace: scoped re-read; Legacy: render-only
    }).catch(function(err) {
      alert('Error: ' + err.message);
    });
    return;
  }

  // Fallback: in-memory only (demo/mock, no KM.DB methods present)
  if (!window.replenishmentData) window.replenishmentData = [];
  var exists = replenishmentData.some(function(item) {
    return item.sku === sku && item.country === country && item.marketplace === marketplace;
  });
  if (exists) {
    alert('SKU "' + sku + '" already exists for ' + country + ' - ' + marketplace);
    return;
  }
  replenishmentData.push({ sku: sku, country: country, marketplace: marketplace, status: status, currentStock: 0, onTheWay: 0, thirdPartyStock: 0, avgSalesPerDay: 0, fc60Days: 0, upcomingEvent: '', daysOfSupply: 0, suggestedQty: 0, plannedQty: 0, cnStock: 0, twStock: 0 });
  if (typeof renderReplenishment === 'function') renderReplenishment();
  closeReplenModal();
  resetReplenAddSkuForm();   // F1-SMALL: confirmed success → clear leaked fields so the next Add SKU starts fresh
  alert('SKU "' + sku + '" added (in-memory only)');
}

function prefillReplenSiteSku() {
  var skuEl = document.getElementById('replen-add-sku');
  var siteEl = document.getElementById('replen-add-site-sku');
  if (!skuEl || !siteEl) return;
  // Auto-fill Site SKU from SKU while the user hasn't manually edited it.
  if (!siteEl.value.trim() || siteEl.dataset.autofill === '1') {
    siteEl.value = skuEl.value.trim();
    siteEl.dataset.autofill = '1';
  }
}
window.prefillReplenSiteSku = prefillReplenSiteSku;
  
// The modal-overlay listener lives inside the partial markup (Phase 3-12), so it is bound
// once via _inventoryReplenStaticInit() after the markup is injected. On the initial
// DOMContentLoaded (before the user opens the page) the markup isn't present yet, so this
// is a safe no-op; the page lifecycle mount calls it again once the partial exists.
document.addEventListener('DOMContentLoaded', () => {
  _inventoryReplenStaticInit();
});

// ========================================
// Inventory Replenishment - 從 app.js 搬移 (批次 1: Mock Data + 核心計算渲染)
// ========================================

const replenishmentMockData = [
    { sku: "CO1100-R", lifecycle: "Mature", productName: "Can Opener Pro", forecast90d: 450, onTheWay: 20, unitsPerCarton: 40 },
    { sku: "CO1100-S", lifecycle: "New", productName: "Manual Opener Basic", forecast90d: 320, onTheWay: 15, unitsPerCarton: 50 },
    { sku: "CO1150-R", lifecycle: "Mature", productName: "Kitchen Tool Set", forecast90d: 1100, onTheWay: 50, unitsPerCarton: 30 },
    { sku: "CO1150-AG", lifecycle: "Mature", productName: "Electric Peeler", forecast90d: 380, onTheWay: 10, unitsPerCarton: 40 },
    { sku: "SP3120-R", lifecycle: "New", productName: "Smart Opener", forecast90d: 600, onTheWay: 30, unitsPerCarton: 50 },
    { sku: "SP3410-R", lifecycle: "Phasing Out", productName: "Classic Knife", forecast90d: 280, onTheWay: 5, unitsPerCarton: 30 },
    { sku: "MO5600-R", lifecycle: "Mature", productName: "Food Processor", forecast90d: 750, onTheWay: 40, unitsPerCarton: 40 }
];

const specialEvents = [
    { name: "Spring Deal", startDate: "3/22", endDate: "3/29", month: 3, tag: "Special Event" },
    { name: "Prime Day", startDate: "7/15", endDate: "7/16", month: 7, tag: "Special Event" },
    { name: "Fall Prime", startDate: "10/20", endDate: "10/21", month: 10, tag: "Special Event" },
    { name: "BFCM", startDate: "11/20", endDate: "12/1", month: 11, tag: "Special Event" }
];

const skuEventData = [
    { sku: "CO1100-R", events: [{ name: "Spring Deal", qty: 500 }, { name: "Prime Day", qty: 800 }] },
    { sku: "CO1100-S", events: [{ name: "BFCM", qty: 1200 }] },
    { sku: "CO1150-R", events: [{ name: "Prime Day", qty: 1500 }, { name: "Fall Prime", qty: 900 }] },
    { sku: "CO1150-AG", events: [{ name: "Spring Deal", qty: 400 }] },
    { sku: "SP3120-R", events: [{ name: "BFCM", qty: 2000 }] },
    { sku: "SP3410-R", events: [] },
    { sku: "MO5600-R", events: [{ name: "Prime Day", qty: 1000 }, { name: "BFCM", qty: 1800 }] }
];

// 運輸方式資料結構 (Stage 1 靜態資料)
const shippingMethodsByMarket = {
    'US-amazon': [
        { name: '3rd Party', leadTime: 7, priority: 1, costLevel: 'Medium' },
        { name: 'Air Freight', leadTime: 12, priority: 4, costLevel: 'High' },
        { name: 'Private Ship', leadTime: 25, priority: 3, costLevel: 'Medium' },
        { name: 'AGL Ship', leadTime: 45, priority: 2, costLevel: 'Low' }
    ],
    'UK-amazon': [
        { name: '3rd Party', leadTime: 7, priority: 1, costLevel: 'Medium' },
        { name: 'Air Freight', leadTime: 10, priority: 4, costLevel: 'High' },
        { name: 'Sea Freight', leadTime: 35, priority: 2, costLevel: 'Low' }
    ],
    'DE-amazon': [
        { name: '3rd Party', leadTime: 7, priority: 1, costLevel: 'Medium' },
        { name: 'Air Freight', leadTime: 10, priority: 4, costLevel: 'High' },
        { name: 'Sea Freight', leadTime: 35, priority: 2, costLevel: 'Low' }
    ]
};

let currentExpandedRow = null;
let replenishmentPlans = {};
let replenishmentNotes = {};
let replenishmentShippingMethods = {};
let cachedExpandData = {};

// Stage 2 預留：多方案運輸計算函數
function calculateShippingSuggestions(skuData, marketplace) {
    // Stage 1: 返回空陣列
    // Stage 2: 實作多方案計算邏輯
    // 計算邏輯：
    // 1. 計算斷貨時間點
    // 2. 優先使用 3rd Party Stock
    // 3. 從 AGL Ship (最慢/最便宜) 開始填補缺口
    // 4. 依序使用 Private Ship, Air Freight
    return [];
}

function getReplenishmentData() {
    // === Demo Data Layer: Phase 2A ===
    if (window.KM && window.KM.DemoData && window.KM.DemoData.isEnabled && window.KM.DemoData.isEnabled()) {
        return _getDemoReplenishmentData();
    }

    // === End Demo Data Layer ===
    // Demo OFF: search-triggered loading from KM.DB. The Inventory Table (貨物庫存表) is mapped
    // from existing snapshot/forecast/inventory tables via IRMap (Phase 1). Source tables that
    // are not yet exposed to the frontend return [] → every field safe-falls-back to 0 / '--'
    // (no fabricated data). See docs/planning/INVENTORY_TABLE_MAPPING_SPEC.md v1.0.
    return _getCloudReplenishmentData();
    return siteData.map(item => {
        const mockData = replenishmentMockData.find(m => m.sku === item.sku) || {
            lifecycle: "Mature",
            productName: item.sku + " Product",
            forecast90d: Math.floor(Math.random() * 500) + 200,
            onTheWay: Math.floor(Math.random() * 30),
            unitsPerCarton: 40
        };
        
        // Add marketplace and company from siteData
        mockData.marketplace = item.site;
        // Assign company based on SKU
        if (item.sku === 'CO1100-R' || item.sku === 'CO1150-R' || item.sku === 'SP3120-R' || item.sku === 'MO5600-R') {
            mockData.company = 'Res US';
        } else if (item.sku === 'CO1100-S' || item.sku === 'CO1150-AG' || item.sku === 'SP3410-R') {
            mockData.company = 'Res TW';
        } else {
            mockData.company = 'Kitchen Mama';
        }
        
        // Mock expand panel data - 根據 SKU 設定不同規模
        // 使用快取避免每次展開時數據變動
        if (!cachedExpandData[item.sku]) {
            let available, fcTransfer, fcProcessing, winitStock, onusStock, within18days, within30days, within45days, lastWeek;
            let fcNextMonth, fcNext2Month, fcLastMonth, fcLast2Month, achievementLastMonth, achievementLast2Month;
            let salesDay2, salesDay3, salesDay4;
            
            if (item.sku === 'CO1100-R' || item.sku === 'CO1100-S') {
            // 大規模數量
            available = Math.floor(Math.random() * 2000) + 3000;
            fcTransfer = Math.floor(Math.random() * 500) + 800;
            fcProcessing = Math.floor(Math.random() * 500) + 600;
            winitStock = Math.floor(Math.random() * 300) + 500;
            onusStock = Math.floor(Math.random() * 300) + 400;
            within18days = Math.floor(Math.random() * 800) + 1200;
            within30days = Math.floor(Math.random() * 600) + 800;
            within45days = Math.floor(Math.random() * 600) + 800;
            lastWeek = Math.floor(Math.random() * 500) + 1500;
            fcNextMonth = Math.floor(Math.random() * 5000) + 8000;
            fcNext2Month = Math.floor(Math.random() * 5000) + 7000;
            fcLastMonth = Math.floor(Math.random() * 5000) + 7500;
            fcLast2Month = Math.floor(Math.random() * 4000) + 7000;
            salesDay2 = Math.floor(Math.random() * 100) + 200;
            salesDay3 = Math.floor(Math.random() * 100) + 180;
            salesDay4 = Math.floor(Math.random() * 100) + 170;
        } else if (item.sku === 'CO1150-R' || item.sku === 'CO1150-AG') {
            // 小規模數量
            available = Math.floor(Math.random() * 100) + 50;
            fcTransfer = Math.floor(Math.random() * 30) + 20;
            fcProcessing = Math.floor(Math.random() * 30) + 15;
            winitStock = Math.floor(Math.random() * 20) + 10;
            onusStock = Math.floor(Math.random() * 20) + 8;
            within18days = Math.floor(Math.random() * 50) + 30;
            within30days = Math.floor(Math.random() * 40) + 20;
            within45days = Math.floor(Math.random() * 40) + 20;
            lastWeek = Math.floor(Math.random() * 80) + 120;
            fcNextMonth = Math.floor(Math.random() * 500) + 800;
            fcNext2Month = Math.floor(Math.random() * 500) + 700;
            fcLastMonth = Math.floor(Math.random() * 500) + 750;
            fcLast2Month = Math.floor(Math.random() * 400) + 700;
            salesDay2 = Math.floor(Math.random() * 20) + 15;
            salesDay3 = Math.floor(Math.random() * 20) + 12;
            salesDay4 = Math.floor(Math.random() * 20) + 10;
        } else {
            // 中等規模數量
            available = Math.floor(Math.random() * 500) + 300;
            fcTransfer = Math.floor(Math.random() * 100) + 80;
            fcProcessing = Math.floor(Math.random() * 100) + 60;
            winitStock = Math.floor(Math.random() * 80) + 50;
            onusStock = Math.floor(Math.random() * 60) + 40;
            within18days = Math.floor(Math.random() * 200) + 150;
            within30days = Math.floor(Math.random() * 150) + 100;
            within45days = Math.floor(Math.random() * 150) + 100;
            lastWeek = Math.floor(Math.random() * 200) + 400;
            fcNextMonth = Math.floor(Math.random() * 2000) + 3000;
            fcNext2Month = Math.floor(Math.random() * 2000) + 2500;
            fcLastMonth = Math.floor(Math.random() * 2000) + 2800;
            fcLast2Month = Math.floor(Math.random() * 1500) + 2500;
            salesDay2 = Math.floor(Math.random() * 40) + 50;
            salesDay3 = Math.floor(Math.random() * 40) + 45;
            salesDay4 = Math.floor(Math.random() * 40) + 40;
        }
        
            // Monthly Achievement Rate has NO defined source/formula → never fabricated (not even in
            // demo). The honest table (_irRenderMonthlyAchievement) shows "—" for these.
            achievementLastMonth = null;
            achievementLast2Month = null;
            
            // LTS data - 部分 SKU 設為 0 以測試篩選
            let over90, over180;
            if (item.sku === 'CO1100-S' || item.sku === 'CO1150-AG') {
                over90 = 0;
                over180 = 0;
            } else if (item.sku === 'SP3410-R') {
                over90 = Math.floor(Math.random() * 15) + 5;
                over180 = 0;
            } else {
                over90 = Math.floor(Math.random() * 15) + 5;
                over180 = Math.floor(Math.random() * 8) + 2;
            }
            
            // Factory stock - 快取以避免每次計算時變動
            const cnStock = Math.floor(Math.random() * 5000) + 1000;
            const twStock = Math.floor(Math.random() * 3000) + 500;
            
            cachedExpandData[item.sku] = {
                available, fcTransfer, fcProcessing, winitStock, onusStock,
                within18days, within30days, within45days, lastWeek, fcNextMonth, fcNext2Month,
                fcLastMonth, fcLast2Month, achievementLastMonth, achievementLast2Month,
                salesDay2, salesDay3, salesDay4, over90, over180, cnStock, twStock
            };
        }
        
        const expandData = cachedExpandData[item.sku];
        
        // Dynamic sales trend (past 3 days)
        const today = new Date();
        const day2ago = new Date(today);
        day2ago.setDate(today.getDate() - 2);
        const day3ago = new Date(today);
        day3ago.setDate(today.getDate() - 3);
        const day4ago = new Date(today);
        day4ago.setDate(today.getDate() - 4);
        
        // Dynamic forecast months
        const monthNames = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
        const currentMonth = today.getMonth();
        const nextMonthIndex = (currentMonth + 1) % 12;
        const next2MonthIndex = (currentMonth + 2) % 12;
        const next3MonthIndex = (currentMonth + 3) % 12;
        const lastMonthIndex = (currentMonth - 1 + 12) % 12;
        const last2MonthIndex = (currentMonth - 2 + 12) % 12;
        
        // Generate FC for next 3 months
        const fcNext3Month = Math.floor(Math.random() * 5000) + 7000;
        
        // 60 days FC = The Following 前兩個月份的 FC 總和
        const forecast60d = expandData.fcNextMonth + expandData.fcNext2Month;
        
        // Get upcoming events for this SKU (檢查接下來三個月內的事件)
        const skuEvents = skuEventData.find(e => e.sku === item.sku)?.events || [];
        const next3Months = [
            (currentMonth + 1) % 12 || 12,
            (currentMonth + 2) % 12 || 12,
            (currentMonth + 3) % 12 || 12
        ];
        
        // 篩選出接下來三個月內的事件
        const filteredEvents = skuEvents.filter(e => {
            const event = specialEvents.find(se => se.name === e.name);
            return event && next3Months.includes(event.month);
        });
        
        const upcomingEventQty = filteredEvents.length > 0 ? filteredEvents[0].qty : null;
        
        const upcomingEventsText = filteredEvents.length > 0
            ? filteredEvents.map(e => {
                const event = specialEvents.find(se => se.name === e.name);
                // "M.D~M.D" year-less display; full range preserved in title= for accessibility.
                const fullR = `${event?.startDate}~${event?.endDate}`;
                const shortR = _irFmtEventRange(event?.startDate, event?.endDate) || fullR;
                return `<div class="replen-card__row"><span class="replen-card__label" title="${fullR}">${e.name} (${shortR})</span><span class="replen-card__value">${e.qty}</span></div>`;
              }).join('')
            : '<div class="replen-card__row"><span class="replen-card__label">No upcoming event</span><span class="replen-card__value">-</span></div>';
        
        // 1. Current Stock = Available + FC Transfer + FC Processing
        const currentInventory = expandData.available + expandData.fcTransfer + expandData.fcProcessing;
        
        // 2. On the Way = 根據期望天數動態計算
        let onTheWay;
        if (targetDays <= 18) {
            onTheWay = expandData.within18days;
        } else if (targetDays <= 30) {
            onTheWay = expandData.within18days + expandData.within30days;
        } else {
            onTheWay = expandData.within18days + expandData.within30days + expandData.within45days;
        }
        
        // 3. 3rd Party Stock = 3rd Party Stock 加總
        const thirdPartyStock = expandData.winitStock + expandData.onusStock;
        
        // 4. Avg. Sales/day = Last Week / 7
        const avgDailySales = expandData.lastWeek / 7;
        
        // Days of Supply = Current Stock / Avg. Sales
        const daysOfSupply = (currentInventory / avgDailySales).toFixed(1);
        
        // 檢查是否需要紅燈警示：Days of Supply < 18 且 (Current Stock + Within 18 days) / Avg. Sales < 18
        const daysWithin18 = ((currentInventory + expandData.within18days) / avgDailySales).toFixed(1);
        const needsAlert = parseFloat(daysOfSupply) < 18 && parseFloat(daysWithin18) < 18;
        
        // Suggested Qty - 依產品生命週期計算 (不包含 3rd Party Stock)
        let need18, need30, need45Plus;
        
        if (mockData.lifecycle === 'New') {
            // New 產品：60 days FC + 本月剩餘天數銷售 - (Current Stock + On the Way)
            const totalInventory = currentInventory + onTheWay;
            
            // 計算本月剩餘天數
            const today = new Date();
            const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            const remainingDays = lastDayOfMonth.getDate() - today.getDate();
            const remainingSales = remainingDays > 0 ? remainingDays * avgDailySales : 0;
            
            // New 產品的分時段計算（基於 FC）
            const totalDemand = forecast60d + remainingSales;
            const demand18 = totalDemand * (Math.min(18, targetDays) / targetDays);
            const demand30 = totalDemand * (Math.min(30, targetDays) / targetDays);
            
            const available18 = currentInventory + expandData.within18days;
            const available30 = currentInventory + expandData.within18days + expandData.within30days;
            const availableTotal = currentInventory + expandData.within18days + expandData.within30days + expandData.within45days;
            
            need18 = Math.max(0, Math.ceil(demand18 - available18));
            need30 = Math.max(0, Math.ceil(demand30 - available30 - need18));
            need45Plus = Math.max(0, Math.ceil(totalDemand - availableTotal - need18 - need30));
        } else {
            // Mature / Phasing Out：分時段計算（基於 Avg Sales）
            const demand18 = avgDailySales * Math.min(18, targetDays);
            const demand30 = avgDailySales * Math.min(30, targetDays);
            const demandTotal = avgDailySales * targetDays;
            
            const available18 = currentInventory + expandData.within18days;
            const available30 = currentInventory + expandData.within18days + expandData.within30days;
            const availableTotal = currentInventory + expandData.within18days + expandData.within30days + expandData.within45days;
            
            need18 = Math.max(0, Math.ceil(demand18 - available18));
            need30 = Math.max(0, Math.ceil(demand30 - available30 - need18));
            need45Plus = Math.max(0, Math.ceil(demandTotal - availableTotal - need18 - need30));
        }
        
        // Suggested Qty = 三個時段的加總
        let suggestedQty = need18 + need30 + need45Plus;
        
        // 進位到整箱數量
        const unitsPerCarton = mockData.unitsPerCarton || 40;
        if (suggestedQty > 0) {
            suggestedQty = Math.ceil(suggestedQty / unitsPerCarton) * unitsPerCarton;
        }
        
        return {
            sku: item.sku,
            lifecycle: mockData.lifecycle,
            productName: mockData.productName,
            marketplace: mockData.marketplace,
            company: mockData.company,
            currentInventory: currentInventory,
            avgDailySales: avgDailySales.toFixed(2),
            forecast60d: forecast60d,
            daysOfSupply: daysOfSupply,
            needsAlert: needsAlert,
            onTheWay: onTheWay,
            thirdPartyStock: thirdPartyStock,
            suggestedQty: suggestedQty,
            need18: need18,
            need30: need30,
            need45Plus: need45Plus,
            plannedQty: replenishmentPlans[item.sku] || 0,
            note: replenishmentNotes[item.sku] || '',
            status: suggestedQty > 0 ? "Need Restock" : "Sufficient",
            upcomingEventQty: upcomingEventQty,
            cnStock: expandData.cnStock,
            twStock: expandData.twStock,
            // Expand panel data
            available: expandData.available,
            fcTransfer: expandData.fcTransfer,
            fcProcessing: expandData.fcProcessing,
            winitStock: expandData.winitStock,
            onusStock: expandData.onusStock,
            within18days: expandData.within18days,
            within30days: expandData.within30days,
            within45days: expandData.within45days,
            lastWeek: expandData.lastWeek,
            // Sales trend dates and values
            day2ago: `${day2ago.getMonth() + 1}/${day2ago.getDate()}`,
            day3ago: `${day3ago.getMonth() + 1}/${day3ago.getDate()}`,
            day4ago: `${day4ago.getMonth() + 1}/${day4ago.getDate()}`,
            salesDay2: expandData.salesDay2,
            salesDay3: expandData.salesDay3,
            salesDay4: expandData.salesDay4,
            // Forecast months
            nextMonth: monthNames[nextMonthIndex],
            next2Month: monthNames[next2MonthIndex],
            next3Month: monthNames[next3MonthIndex],
            lastMonth: monthNames[lastMonthIndex],
            last2Month: monthNames[last2MonthIndex],
            fcNextMonth: expandData.fcNextMonth,
            fcNext2Month: expandData.fcNext2Month,
            fcNext3Month: fcNext3Month,
            fcLastMonth: expandData.fcLastMonth,
            fcLast2Month: expandData.fcLast2Month,
            achievementLastMonth: expandData.achievementLastMonth,
            achievementLast2Month: expandData.achievementLast2Month,
            upcomingEventsText: upcomingEventsText
        };
    }).filter(item => {
        if (!ltsFilter) return true;
        const expandData = cachedExpandData[item.sku];
        if (!expandData) return true;
        
        if (ltsFilter === 'over90') return expandData.over90 > 0;
        if (ltsFilter === 'over180') return expandData.over180 > 0;
        return true;
    });
}

// ========================================
// Main table Category tabs — filter the 貨物庫存表 main table by sku_details.category so the
// page stays focused instead of rendering every SKU at once. Tabs are built dynamically from the
// distinct non-empty categories present in the current (search-scoped) result set, plus "All".
// Mirrors the Request Order Category filter (sku_details.category; canonical values only — category
// is NEVER guessed from the SKU prefix/series). The dedupe + sort matches Request Order's _roDistinct
// so the Category tab order is identical to Request Order's.
// ========================================
var replenCategoryTab = 'All';

// Canonical category value for a row (trimmed). Uncategorized rows return '' and only appear under
// the "All" tab — category is never inferred from the SKU/series.
function _replenCategoryOf(item) {
    return item && item.category != null ? String(item.category).trim() : '';
}

function setReplenCategoryTab(category) {
    replenCategoryTab = category;
    renderReplenishment();
}
window.setReplenCategoryTab = setReplenCategoryTab;

// One category tab — uses Inventory Replenishment's OWN page-scoped rail markup
// (.replen-category-rail__tab / __label / __count). These are INDEPENDENT of the shared
// km-tab-rail / km-category-card component (Round 3): own class/id/state/event owner, styled in
// inventory-replenishment.css to visually match the Order Planning category bar. Clicking re-renders
// (via the inline onclick); active state is rebuilt on every render from `replenCategoryTab`.
function _replenCatTabHtml(name, count, active) {
    var safe = escapeReplenHtml(name);
    var arg = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<button type="button" class="replen-category-rail__tab' + (active ? ' is-active' : '') + '" data-cat="' + safe +
        '" onclick="setReplenCategoryTab(\'' + arg + '\')">' +
        '<span class="replen-category-rail__label">' + safe + '</span>' +
        '<span class="replen-category-rail__count">' + count + '</span></button>';
}

// Build the Category Tab Rail. All categories live in ONE horizontally-scrollable rail (the old
// measure-based overflow dropdown that hid later categories was removed 2026-07-28) — the shared
// KM.ui.tabRail handles wheel/keyboard/scroll-into-view, and the last category is always reachable.
function renderReplenCategoryTabs(allData) {
    var bar = document.getElementById('replenCategoryTabs');
    if (!bar) return;

    // Empty-data state: the Category Bar shell is NEVER hidden. The old empty-data gate (which hid the
    // rail via an inline none display) is removed — we always render at least `All (0)` so the bar is a
    // clearly-visible standalone panel even before a Marketplace/dataset is chosen.
    var rows = allData || [];

    // Distinct non-empty categories in the current (upstream-filtered) result set — dedupe +
    // alphabetical sort (matches Request Order's category order).
    var seen = {}, categoryList = [];
    rows.forEach(function (it) {
        var c = _replenCategoryOf(it);
        if (c && !seen[c]) { seen[c] = 1; categoryList.push(c); }
    });
    categoryList.sort();

    // Reset to All if the previously-active category is no longer present (data changed / empty).
    if (replenCategoryTab !== 'All' && categoryList.indexOf(replenCategoryTab) === -1) replenCategoryTab = 'All';

    // 'All' is always first; counts come from the full upstream-scoped set (computed BEFORE the
    // category filter is applied) so selecting a category never zeroes the other category counts.
    var tabs = [{ name: 'All', count: rows.length }].concat(categoryList.map(function (c) {
        return { name: c, count: rows.filter(function (it) { return _replenCategoryOf(it) === c; }).length };
    }));

    // Actively clear any stale inline display (the old empty-gate could leave display:none in the DOM);
    // the bar always shows.
    bar.style.display = '';
    bar.innerHTML = tabs.map(function (t) {
        return _replenCatTabHtml(t.name, t.count, t.name === replenCategoryTab);
    }).join('');

    if (window.KM && window.KM.ui && window.KM.ui.tabRail) {
        window.KM.ui.tabRail.enhance(bar);
        window.KM.ui.tabRail.scrollActiveIntoView(bar);
    }
}
window.renderReplenCategoryTabs = renderReplenCategoryTabs;

// ── Planning Model display (Canonical Decision 1) ────────────────────────────────────────────────
// The first column holds the canonical replenishment_model value (sales_driven / forecast_driven).
// The DB / API / payload / filter-state keep the canonical value; the UI shows ONLY the friendly label
// via this single shared formatter (table cell + Add/Edit forms + anywhere the field is displayed).
// Never render "Sales Driven" / "Forecast Driven" / "Status" for this field anymore.
function _replenPlanningModelLabel(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'forecast_driven') return 'Forecast';
    if (s === 'sales_driven') return 'Sales';
    return v ? String(v) : 'Sales';
}
window._replenPlanningModelLabel = _replenPlanningModelLabel;

// ── Whole-row expand: interactive-target guard (mirrors request-order._roIsInteractiveTarget) ─────
// A click on any control (button/link/input/select/…) or a [data-no-row-toggle] element must NOT
// toggle the row — those elements own their own behaviour.
var IR_INTERACTIVE_TAGS = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, OPTION: 1 };
function _irIsInteractiveTarget(el, stopAt) {
    while (el && el !== stopAt && el.nodeType === 1) {
        if (IR_INTERACTIVE_TAGS[el.tagName]) return true;
        if (el.isContentEditable) return true;
        var role = el.getAttribute && el.getAttribute('role');
        if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'textbox' || role === 'switch') return true;
        if (el.hasAttribute && el.hasAttribute('data-no-row-toggle')) return true;
        el = el.parentNode;
    }
    return false;
}

// Canonical row key for the expanded-row state — prefer marketplace_sku_id; fall back to the composite
// (company|country|marketplace|sku) when that field isn't on the row. Exposed for callers/tests.
function _irRowKey(item) {
    if (!item) return '';
    if (item.marketplaceSkuId) return String(item.marketplaceSkuId);
    return [item.company, item.country, item.marketplace, item.sku]
        .map(function (v) { return String(v == null ? '' : v); }).join('|');
}
// Pure single-state toggle decision: returns the NEXT expanded key. One variable drives BOTH the left
// (fixed) and right (scroll) sides, so they can never desync no matter how fast the user clicks.
function _irNextExpandedKey(currentKey, clickedKey) {
    return currentKey === clickedKey ? null : clickedKey;
}
// Stable detail-panel DOM id for aria-controls (sku sanitised to an id-safe token).
function _irPanelId(sku) {
    return 'replen-detail-' + String(sku == null ? '' : sku).replace(/[^A-Za-z0-9_-]/g, '-');
}
// Escape a sku for safe interpolation into an inline on* handler argument.
function _irSkuArg(sku) {
    return String(sku == null ? '' : sku).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
window._irRowKey = _irRowKey;
window._irNextExpandedKey = _irNextExpandedKey;
window._irIsInteractiveTarget = _irIsInteractiveTarget;

// Row-level click handler: toggle unless the click landed on an interactive control (which handles
// itself). Bound on BOTH the fixed row and the scroll row so the whole row is a hit target.
function _replenRowClick(event, sku) {
    if (event && _irIsInteractiveTarget(event.target, event.currentTarget)) return;
    toggleReplenRow(sku);
}
// Chevron click: stopPropagation so the row handler doesn't also fire (no double-toggle), then toggle
// exactly once. aria-expanded / rotation are synced inside toggleReplenRow.
function _replenChevronClick(event, sku) {
    if (event) { try { event.stopPropagation(); } catch (_e) {} }
    toggleReplenRow(sku);
}
window._replenRowClick = _replenRowClick;
window._replenChevronClick = _replenChevronClick;

// F1-7N-UX-SITE-INVENTORY-FULFILLMENT-AWARE-COLUMNS-R1 — ONE presentation-layer Inventory-column model derived from the
// canonical marketplace fulfillment_model. SELF_FULFILLED omits the platform "Current Stock" column (its physical
// authority is the 3rd Party / warehouse-grain stock); PLATFORM / HYBRID / UNKNOWN keep the full 3-column Inventory
// group. PURE — no DOM, no data/formula/authority change. Drives header colspan + body cell visibility via ONE class.
function _irInventoryColumnModel(fulfillmentModel) {
    var hide = String(fulfillmentModel == null ? '' : fulfillmentModel).trim().toLowerCase() === 'self_fulfilled';
    // F1-7N-UX-SITE-INVENTORY-INVENTORY-COLUMN-ORDER-R1 — stock-flow reading order: Current Stock → 3rd Party Stock →
    // On the Way (what exists now → what sits in external/self warehouses → what is still inbound). SELF keeps Current
    // Stock structurally omitted, leaving 3rd Party Stock → On the Way. Presentation order only.
    return { hideCurrentStock: hide, inventoryLeafSpan: hide ? 2 : 3,
        columns: hide ? ['thirdPartyStock', 'onTheWay'] : ['currentStock', 'thirdPartyStock', 'onTheWay'] };
}
// Canonical fulfillment_model of the CURRENTLY selected marketplace scope (reuses the existing read-model helper; never
// inferred from a name). '' when no single marketplace is selected → fail-safe to the full column structure.
function _irScopeFulfillmentModel() {
    try {
        var scope = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : {};
        if (!scope || !scope.marketplaceId) return '';
        return (typeof _replenDarFulfillmentOf === 'function') ? _replenDarFulfillmentOf(_replenDarReadMarketplaces(), scope.marketplaceId) : '';
    } catch (_e) { return ''; }
}
// Apply the ONE model to the live table: a single container class drives BOTH the header (Current Stock leaf + Inventory
// group width, via CSS) and the body cell, so header/body can never drift. data-leaf-span is kept in sync for the contract.
function _irApplyInventoryColumnModel(fulfillmentModel) {
    var m = _irInventoryColumnModel(fulfillmentModel);
    var tbl = document.getElementById('replen-detail-table');
    if (tbl) tbl.classList.toggle('ir-hide-current-stock', m.hideCurrentStock);
    var invGroup = document.querySelector('#ops-section .km-table__header-cell--inventory');
    if (invGroup) invGroup.setAttribute('data-leaf-span', String(m.inventoryLeafSpan));
    return m;
}

// =============================================================================================================
// F1-7N-FB-4E-R4B-R3 §2/§3 — THE ROW BUILDERS AND THE RENDER-INTEGRITY CONTRACT.
//
// The row markup lives in named builders (not inline in renderReplenishment) for one reason: the render loop
// can then wrap EACH row in its own try/catch, so a single malformed row fails closed as one visibly-typed row
// instead of aborting the map and erasing every row after it.
//
// The leaf-column contract is DERIVED, never pinned: S(data-leaf-span) across the level-1 group header row IS
// how many body cells one row must carry. A number written here would be a second source of truth and would
// drift the first time a column is added.
// =============================================================================================================
function _irHeaderLeafSpan_() {
    var cells = document.querySelectorAll('#ops-section .km-table__header-row--level1 .km-table__header-cell');
    if (!cells || !cells.length) return 0;
    var n = 0;
    for (var i = 0; i < cells.length; i++) {
        var v = parseInt(cells[i].getAttribute('data-leaf-span'), 10);
        n += (isNaN(v) ? 1 : v);
    }
    return n;
}
// A REAL zero and an unavailable figure are different statements, and the cell says which it is.
var _IR_FACTORY_STATE_TITLE_ = {
    OK: 'Allocated share of the physical factory pool (frozen rolling 4-month FC share).',
    NO_FACTORY_STOCK: 'Zero: there is no factory_stock row for this SKU.',
    NOT_ELIGIBLE: 'Zero: this site is not an eligible receiver of this factory source.',
    NO_FORECAST_DENOMINATOR: 'Zero: the rolling 4-month Regular FC of the whole eligible receiver set is 0, so no share can be computed. Nothing was allocated.',
    UNAVAILABLE: 'Unavailable: the factory site-allocation projection could not run. This is NOT a zero allocation.'
};
function _irFactoryCellTitle_(item) {
    var s = String((item && item.factoryAllocState) || '');
    var t = Object.prototype.hasOwnProperty.call(_IR_FACTORY_STATE_TITLE_, s) ? _IR_FACTORY_STATE_TITLE_[s] : '';
    return escapeReplenHtml(t ? (s + ' — ' + t) : s);
}
function _irFactoryCellHtml_(v, item) {
    // null = the projection could not run; 0 = a real, computed zero. `|| 0` would collapse the two.
    return '<div class="scroll-cell" data-factory-state="' + escapeReplenHtml(String((item && item.factoryAllocState) || '')) +
        '" title="' + _irFactoryCellTitle_(item) + '">' + (v == null ? '--' : v) + '</div>';
}
function _irFixedRowHtml_(item) {
    const arg = _irSkuArg(item.sku);
    const skuText = escapeReplenHtml(item.sku);
    return '\n        <div class="fixed-row" data-sku="' + item.sku + '" data-rowkey="' + escapeReplenHtml(_irRowKey(item)) + '" onclick="_replenRowClick(event, \'' + arg + '\')">' +
        '<button type="button" class="replen-row-chevron" aria-expanded="false" aria-controls="' + _irPanelId(item.sku) + '"' +
        ' aria-label="Toggle replenishment details for ' + skuText + '"' +
        ' onclick="_replenChevronClick(event, \'' + arg + '\')">' +
        '<span class="replen-row-chevron__icon" aria-hidden="true">&#9656;</span>' +
        '</button>' +
        '<span class="replen-row-sku">' + skuText + '</span>' +
        '</div>\n    ';
}
// The Days-of-Supply cell's colour class, resolved where the cell is emitted. Computing it ahead of the row
// would put item.daysOfSupply in the SOURCE before Current Stock, and the body-cell ORDER is a contract read
// from this builder - source order and render order must not be allowed to disagree.
function _irDosCellClass_(item) {
    return (window.IRMap ? window.IRMap.dosColorClass(item.daysOfSupply) : '') + (item.needsAlert ? ' alert-red' : '');
}
function _irScrollRowHtml_(item) {
    return '\n        <div class="scroll-row" data-sku="' + item.sku + '" data-rowkey="' + escapeReplenHtml(_irRowKey(item)) + '" onclick="_replenRowClick(event, \'' + _irSkuArg(item.sku) + '\')">' +
        '<div class="scroll-cell">' + _replenPlanningModelLabel(item.replenishmentModel) + '</div>' +
        '<div class="scroll-cell">' + item.company + '</div>' +
        '<div class="scroll-cell">' + _replenMarketplaceLabel(item.marketplace, item.company, item.country) + '</div>' +
        '<div class="scroll-cell replen-cell--current-stock">' + item.currentInventory + '</div>' +
        '<div class="scroll-cell" title="' + String(item.thirdPartyTitle || '').replace(/"/g, '&quot;') + '">' + item.thirdPartyStock + '</div>' +
        '<div class="scroll-cell">' + item.onTheWay + '</div>' +
        '<div class="scroll-cell">' + item.avgDailySales + '</div>' +
        '<div class="scroll-cell">' + item.forecast60d + '</div>' +
        '<div class="scroll-cell">' + (item.upcomingEventQty !== null ? item.upcomingEventQty : '-') + '</div>' +
        '<div class="scroll-cell ' + _irDosCellClass_(item) + '">' + item.daysOfSupply + '</div>' +
        '<div class="scroll-cell replen-suggested-cell">' + _irSuggestedCellHtml(item) + '</div>' +
        _irFactoryCellHtml_(item.cnStock, item) +
        _irFactoryCellHtml_(item.twStock, item) +
        '<div class="scroll-cell ai-action-cell" role="button" data-no-row-toggle onclick="openAISuggestion(event, \'' + _irSkuArg(item.sku) + '\')" style="width: 175px; min-width: 175px; max-width: 175px; flex-shrink: 0;">' +
        '<span class="ai-action-cell__text">View Recommendation</span>' +
        '</div>' +
        '</div>\n    ';
}
// A row that could not be built. It keeps its SKU identity and its leaf-column count so the table stays aligned,
// and it says so — it is never a blank row and never a fabricated number.
var _irRowFailures = [];
function _irNoteRowFailure_(item, err, side) {
    _irRowFailures.push({ sku: (item && item.sku) || '', side: side, message: String((err && err.message) || err) });
    try { console.error('[Replenishment] row render failed (' + side + ') for SKU ' + ((item && item.sku) || '?'), err); } catch (_e) {}
}
function _irFixedRowFailedHtml_(item) {
    var sku = escapeReplenHtml((item && item.sku) || '');
    return '\n        <div class="fixed-row fixed-row--failed" data-sku="' + sku + '" data-row-failed="1">' +
        '<span class="replen-row-sku">' + sku + '</span></div>\n    ';
}
function _irScrollRowFailedHtml_(item) {
    var sku = escapeReplenHtml((item && item.sku) || '');
    var leaves = _irHeaderLeafSpan_() || 1;
    var cells = '';
    for (var i = 0; i < leaves; i++) {
        cells += '<div class="scroll-cell">' + (i === 0 ? 'row unavailable' : '--') + '</div>';
    }
    return '\n        <div class="scroll-row scroll-row--failed" data-sku="' + sku + '" data-row-failed="1" ' +
        'title="This row could not be rendered. Nothing was read or written for it; every other row is unaffected.">' +
        cells + '</div>\n    ';
}
// The render checks its own output. A render that silently emits fewer rows than it was given, or rows whose
// leaf-column count disagrees with the header, is exactly the failure R4B-R3 had to diagnose from a screenshot;
// it is now reported by the page itself, with numbers.
function _irVerifyRenderedRows_(expectedRows) {
    var scope = document.querySelectorAll ? document : null;
    if (!scope) return null;
    var fixed = scope.querySelectorAll('#ops-section .fixed-body .fixed-row').length;
    var rows = scope.querySelectorAll('#ops-section .scroll-body .scroll-row');
    var leafSpan = _irHeaderLeafSpan_();
    var badCells = 0, seen = {}, duplicate = 0;
    for (var i = 0; i < rows.length; i++) {
        if (leafSpan && rows[i].querySelectorAll('.scroll-cell').length !== leafSpan) badCells++;
        var k = rows[i].getAttribute('data-sku') || '';
        if (seen[k]) duplicate++; else seen[k] = 1;
    }
    var res = {
        expected: expectedRows, fixedRows: fixed, scrollRows: rows.length,
        leafSpan: leafSpan, rowsWithWrongCellCount: badCells, duplicateRowKeys: duplicate,
        failedRows: _irRowFailures.length,
        ok: (fixed === expectedRows && rows.length === expectedRows && badCells === 0 && duplicate === 0)
    };
    _irRenderIntegrity = res;
    _irRenderIntegrityNotice_(res);
    return res;
}
var _irRenderIntegrity = null;
function _irRenderIntegrityNotice_(res) {
    var host = document.getElementById('replen-render-integrity');
    if (res && res.ok && !res.failedRows) { if (host && host.remove) host.remove(); return; }
    if (!host) {
        var tbl = document.getElementById('replen-detail-table');
        if (!tbl || !tbl.parentNode) return;
        host = document.createElement('div');
        host.id = 'replen-render-integrity';
        host.setAttribute('role', 'alert');
        host.style.cssText = 'margin:8px 0;padding:8px 10px;border:1px solid #EF4444;background:#FEF2F2;color:#B91C1C;font-size:12px;border-radius:4px;';
        tbl.parentNode.insertBefore(host, tbl);
    }
    host.textContent = 'Inventory table render incomplete — ' + res.scrollRows + ' of ' + res.expected +
        ' rows rendered' + (res.rowsWithWrongCellCount ? ', ' + res.rowsWithWrongCellCount + ' row(s) do not match the ' + res.leafSpan + '-column header' : '') +
        (res.failedRows ? ', ' + res.failedRows + ' row(s) failed to build' : '') +
        '. Nothing was read or written. Reload and search again; if it persists, report this line.';
}
window._irVerifyRenderedRows_ = _irVerifyRenderedRows_;
window._irHeaderLeafSpan_ = _irHeaderLeafSpan_;
window._irRenderIntegrity_ = function () { return _irRenderIntegrity; };

function renderReplenishment() {
    // F1-7N-FB-2A §B — THE gate. Placed before getReplenishmentData() so that NO caller of
    // renderReplenishment() — the mount, an LTS change, a post-write reconcile, the async recommendation
    // re-render — can paint inventory rows the user never searched for. Demo mode is unchanged (it needs no
    // Search and holds its own static dataset).
    if (!(typeof _replenDemoOn === 'function' && _replenDemoOn()) && !_irSearchApplied_()) { _irRenderSearchGate_(); return; }
    if (_irSearch.status === 'LOADING' || _irSearch.status === 'ERROR') { _irRenderSearchGate_(); return; }
    const allData = getReplenishmentData();

    // Category rail renders FIRST and UNCONDITIONALLY — BEFORE the table-body guard below. It must
    // appear across initial mount, loading, empty-data, filter-change, and remount even when the table
    // bodies are not (yet) in the DOM, so `.replen-category-shell` is never left as an empty container.
    // (Universal Filter UI Repair root-cause fix: the rail render used to sit AFTER the
    // `if (!fixedBody || !scrollBody) return;` guard, so an absent/late table body left the shell blank.)
    renderReplenCategoryTabs(allData);
    // Keep the Category Section header title in sync with the active tab (persists across re-render/switch).
    var _catTitleEl = document.getElementById('replenCategoryTitle');
    if (_catTitleEl) _catTitleEl.textContent = (replenCategoryTab === 'All') ? 'All Categories' : replenCategoryTab;

    const fixedBody = document.getElementById('replenFixedBody');
    const scrollBody = document.getElementById('replenScrollBody');
    if (!fixedBody || !scrollBody) return;

    const data = (replenCategoryTab === 'All')
        ? allData
        : allData.filter(function (it) { return _replenCategoryOf(it) === replenCategoryTab; });

    currentExpandedRow = null;
    // F1-7N-FB-4G-A1 §D.6 - the rows (and with them every expanded panel) are about to be replaced, so no
    // reveal may still be pending for the old ones. A new Search reaches here too.
    if (typeof _irRevealAbandon_ === 'function') _irRevealAbandon_();
    _irRowFailures = [];
    // Render fixed column (chevron + SKU). The chevron is a native <button> (Enter/Space operable) with
    // aria-expanded synced to the open state and aria-controls pointing at the detail panel it opens.
    // Clicking it stopPropagation()s so the row + chevron handlers never double-fire.
    // F1-7N-FB-4E-R4B-R3 §3 — ONE row, ONE builder, and a failure that cannot take the table with it. A row
    // that throws is rendered as a TYPED failed row (same leaf-column count, so the header can still line up)
    // and every later row still renders.
    fixedBody.innerHTML = data.map(item => {
        try { return _irFixedRowHtml_(item); }
        catch (e) { _irNoteRowFailure_(item, e, 'fixed'); return _irFixedRowFailedHtml_(item); }
    }).join('');

    // Render scrollable columns.
    //
    // F1-7N-FB-4E-R4B-R3 §2 — WHY THERE IS NO HTML COMMENT IN THIS TEMPLATE, EVER.
    //
    // R4B-R1 put an explanatory HTML comment INSIDE this template literal, and that comment contained a pair
    // of BACKTICKS around a code fragment. A backtick ends a template literal, so the row template silently
    // became  `…allocated share, and ` || 0 `…the entire rest of the row…`  — a truthy string OR-ed with a
    // tagged template that short-circuit evaluation never reaches. Every row was therefore emitted TRUNCATED,
    // ending in an unterminated `<!--`, and the browser swallowed CN, TW, AI Action AND every subsequent row
    // into that comment. `node --check` passes on it and every unit test passed on it; only the EMITTED HTML
    // shows it. Two rules follow, and they are enforced below rather than remembered:
    //   1. no HTML comment is emitted inside a row — explanations live in JS comments, out here;
    //   2. the render VERIFIES its own output (_irVerifyRenderedRows_) instead of trusting it.
    //
    // THE FACTORY CELLS. A real zero prints 0 — a site that is an eligible receiver and was allocated nothing,
    // a TW pool outside ResUS, and a zero forecast denominator are all REAL zeros, and each carries its reason
    // in the cell's title. null means the projection could not run at all, and prints the same em dash every
    // other unavailable number on this page uses. `|| 0` would erase that difference.
    scrollBody.innerHTML = data.map(item => {
        try { return _irScrollRowHtml_(item); }
        catch (e) { _irNoteRowFailure_(item, e, 'scroll'); return _irScrollRowFailedHtml_(item); }
    }).join('');
    
    // F1-7N-FB-2A §B — EMPTY is a distinct state and reachable ONLY from a rendered (i.e. successful,
    // applied) Search. It is never shown before one: PRE_SEARCH owns that case. Placed after the row render
    // so an LTS change re-evaluates it too, and it replaces the previously BLANK body on a zero-row result.
    if (!data.length && !(typeof _replenDemoOn === 'function' && _replenDemoOn())) {
        _irSearch.status = 'EMPTY';
        scrollBody.innerHTML = '<div class="replen-empty replen-search-empty" style="color:#64748B;padding:10px;">' +
            'No SKUs match the searched Country / Marketplace' + ((_irRenderScope_().ltsFilter) ? ' and LTS filter' : '') + '.</div>';
        fixedBody.innerHTML = '';
    } else if (data.length) {
        _irSearch.status = 'READY';
    }
    // Initialize header scroll sync
    initReplenHeaderSync();
    // F1-7N: adapt the Inventory columns to the selected marketplace's fulfillment model (SELF_FULFILLED hides Current Stock).
    _irApplyInventoryColumnModel(_irScopeFulfillmentModel());
    // F1-7N-FB-4E-R4B-R3 §3 - the render checks its own output rather than trusting it.
    _irVerifyRenderedRows_(data.length);
}

function initReplenHeaderSync() {
    // Select the detail table scroll-col (not the ir-overview one)
    var tables = document.querySelectorAll('#ops-section .dual-layer-table:not(.ir-overview-table)');
    var detailTable = tables[tables.length - 1]; // last dual-layer-table is the detail table
    if (!detailTable) return;
    var scrollCol = detailTable.querySelector('.scroll-col');
    var scrollHeader = detailTable.querySelector('.scroll-header');
    
    if (!scrollCol || !scrollHeader) return;
    
    // Remove existing listener to avoid duplicates
    if (scrollCol._syncHandler) {
        scrollCol.removeEventListener('scroll', scrollCol._syncHandler);
    }
    
    // Create and store handler
    scrollCol._syncHandler = function() {
        scrollHeader.style.transform = 'translateX(-' + scrollCol.scrollLeft + 'px)';
    };
    
    scrollCol.addEventListener('scroll', scrollCol._syncHandler);
}


// ========================================
// Inventory Replenishment - 從 app.js 搬移 (批次 2: toggleReplenRow + 操作函式 + Shipping Allocation)
// ========================================

// F1-4B-FM3a: top-table Suggested Qty = a NUMERIC PRESENTATION AGGREGATION of the canonical recommendation
// lines for this SKU (NOT a formula — see _irAggregateActionableRecommendedQty). Sums ONLY source-proven,
// non-blocked, finite recommendedQty across the SKU's destination lines (MARKETPLACE and/or each WAREHOUSE);
// provisional / blocked / null / residual are excluded. Valid canonical 0 shows "0". When no actionable
// canonical line exists (all blocked / none), it shows an honest "—" (never a fake 0) and the expanded
// Recommendation Summary explains why. Before the scope result is available it shows a compact "…" pending
// marker. When the workspace is OFF (kill switch), the legacy suggestedQty number is preserved verbatim.
// (Supersedes the FM2B "— breakdown" indicator, per the FM3 audit authorization.)
// F1-7N-FB-4G-A0 §I — THE SUGGESTED QTY IS ONE VALUE WITH ONE AUTHORITY, AND IT NOW HAS ONE OWNER.
//
// The top-table cell and the default Execution Plan editor were reading two DIFFERENT sources for the same
// number. The cell reads the MATERIALIZED gap (_irMatState → d90_suggested_qty); the editor read the legacy
// per-row `item.suggestedQty`, which the materialized read never populates and which is therefore 0. That is
// why the screenshot shows Suggested Qty 2120 in the row and Qty 0 in the editor two inches below it — not a
// missing allocation and not a hydration failure, but one quantity fetched from two places.
//
// This resolver is the single authority. It returns the VALUE and the STATE, never a rendered string, so the
// cell and the editor can present the same answer differently without recomputing it:
//   READY   — a real number (a valid 0 IS a real number and must print as 0)
//   PENDING — the read has not completed; nothing is known yet
//   NONE    — BLOCKED / not calculated / no actionable line; there is no number and none may be invented
//   LEGACY  — recommendation workspace off; the legacy per-row field verbatim, as before
// A caller that needs a quantity uses READY/LEGACY only. PENDING and NONE are NOT zero — the cell prints
// "…"/"—" for them, and the editor seeds 0 because a route with no proven recommendation starts empty.
function _irSuggestedQtyState_(item) {
  if (_irUseMaterializedGapRead()) {
    var st = _irMatState.status;
    if (st === 'IDLE' || st === 'LOADING' || st === 'CONTEXT_NOT_READY') return { state: 'PENDING', value: null };
    var row = (item && _irMatState.bySku[String(item.sku)]) || null;
    if (!row || String(row.calculation_status) !== 'READY') return { state: 'NONE', value: null };
    var v = _irMatNum(row.d90_suggested_qty);   // furthest cumulative checkpoint = the single actionable total
    if (v === null) return { state: 'NONE', value: null, reason: 'NO_STORED_VALUE' };
    return { state: 'READY', value: v };
  }
  if (!_irRecommendationWorkspaceEnabled()) {
    return { state: 'LEGACY', value: (item && item.suggestedQty != null ? item.suggestedQty : 0) };
  }
  var lines = (typeof _irRecoLinesForSku === 'function') ? _irRecoLinesForSku(item) : null;
  if (lines === null) return { state: 'PENDING', value: null };
  var agg = _irAggregateActionableRecommendedQty(lines);
  if (agg.actionableCount === 0) return { state: 'NONE', value: null };
  return { state: 'READY', value: agg.total };
}
// A whole number for a caller that needs a quantity, and 0 for every state that has no proven number.
// NEVER a fabricated figure: PENDING and NONE both seed 0, which is what "nothing has been allocated yet"
// looks like, and the operator types the real number or runs AI Plan.
function _irSuggestedQtyNumber_(item) {
  var s = _irSuggestedQtyState_(item);
  if (s.state !== 'READY' && s.state !== 'LEGACY') return 0;
  var n = parseInt(s.value, 10);
  return isFinite(n) ? n : 0;
}
function _irSuggestedCellHtml(item) {
  // F1-4B-FM5-R4UI-R5 §5 — the top-table Suggested Qty is the MATERIALIZED actionable total from
  // inventory_replenishment_gap. D18/D30/D45/D90 are CUMULATIVE checkpoints, so summing them double-counts need;
  // the ONE actionable replenishment recommendation is the FURTHEST configured horizon's stored suggested qty
  // (canonical max horizon = D90). READY → stored d90_suggested_qty (valid 0 → "0"); BLOCKED / not-calculated →
  // "—"; still loading → "…". No page-side gap math, no live per-SKU calculation.
  var sug = _irSuggestedQtyState_(item);
  var materialized = _irUseMaterializedGapRead();
  if (sug.state === 'PENDING') {
    return materialized
      ? '<span class="replen-suggested-cell__value replen-suggested-cell__value--pending" title="Loading materialized replenishment gap…">…</span>'
      : '<span class="replen-suggested-cell__value replen-suggested-cell__value--pending" title="Calculating recommendation…">…</span>';
  }
  if (sug.state === 'NONE') {
    if (sug.reason === 'NO_STORED_VALUE') return '<span class="replen-suggested-cell__value replen-suggested-cell__value--none">—</span>';
    return materialized
      ? '<span class="replen-suggested-cell__value replen-suggested-cell__value--none" title="No actionable materialized recommendation — run Recalculate All Sites / see the expanded Recommendation Summary">—</span>'
      : '<span class="replen-suggested-cell__value replen-suggested-cell__value--none" title="No actionable canonical recommendation — see the expanded Recommendation Summary">—</span>';
  }
  return '<span class="replen-suggested-cell__value">' + sug.value + '</span>';
}

// Recommendation Summary table body (read-only system suggestion — NOT the submitted plan).
// Rows: 0–18d / 19–30d / 31–45d / 46–90d / Total. Columns: Window / Qty / Route / Reason.
// First version: Qty from the need-bucket data; Route is a placeholder ('--') until
// replenishment_route_rules is implemented; Reason is a placeholder from the allowed set
// (AI Pending / Stock Sufficient). See INVENTORY_TABLE_MAPPING_SPEC §11.
// Recommendation Summary body — FINAL 5 columns: Window / Calculated Gap / Recommended Qty / Route /
// Reason (§11.2). Read-only. Displays the persisted system recommendation snapshot when one exists
// (skuData._recDraftLines); otherwise renders an HONEST empty/not-generated state — never fabricates
// recommended quantities (the formal engine is NOT active; needBuckets returns 0 pre-engine).
function _recSummaryRows(skuData) {
    function num(v) { return (typeof v === 'number') ? v : (parseInt(v, 10) || 0); }
    var draftLines = skuData && skuData._recDraftLines;   // persisted snapshot (Draft), when hydrated
    var windows;
    if (draftLines && draftLines.length) {
        var byWin = {}; draftLines.forEach(function (l) { byWin[l.window_code || l.windowCode] = l; });
        windows = ['0–18d', '19–30d', '31–45d', '46–90d'].map(function (w, i) {
            var code = ['0-18', '19-30', '31-45', '46-90'][i];
            var l = byWin[code] || byWin[w] || {};
            // Route is DERIVED from recommended transport fields (a route display string is never persisted, §C).
            var routeTxt = [l.recommended_shipping_method, l.recommended_last_mile_delivery].filter(Boolean).join(' / ') || '--';
            return { label: w, gap: num(l.calculated_gap_qty), rec: num(l.recommended_qty),
                route: routeTxt, reason: l.recommendation_reason || '' };
        });
    } else {
        // No persisted snapshot + engine inactive → honest empty state.
        var total0 = num(skuData && skuData.suggestedQty);
        var anyGap = total0 > 0 || num(skuData && skuData.need0_18) > 0 || num(skuData && skuData.need19_30) > 0 ||
            num(skuData && skuData.need31_45) > 0 || num(skuData && skuData.need46_90) > 0;
        if (!anyGap) {
            return '<tr><td colspan="5" class="replen-recsum-empty">No recommendation generated — the recommendation engine is not active. Build routes in the Execution Plan below.</td></tr>';
        }
        // Pre-engine placeholder: Calculated Gap and Recommended Qty share the bucket value (source-
        // availability / carton / route-feasibility adjustment is applied by the engine, which is off).
        windows = [
            { label: '0–18d', gap: num(skuData.need0_18), rec: num(skuData.need0_18), route: '--', reason: 'AI Pending' },
            { label: '19–30d', gap: num(skuData.need19_30), rec: num(skuData.need19_30), route: '--', reason: 'AI Pending' },
            { label: '31–45d', gap: num(skuData.need31_45), rec: num(skuData.need31_45), route: '--', reason: 'AI Pending' },
            { label: '46–90d', gap: num(skuData.need46_90), rec: num(skuData.need46_90), route: '--', reason: 'AI Pending' }
        ];
    }
    function evBadge(w) {
        // Special-event badge on affected Window rows (event qty is shown in Reason, not a wide column §11.2).
        return (skuData && skuData.upcomingEventQty && (w.label === '0–18d' || w.label === '19–30d'))
            ? ' <span class="replen-recsum-evt" title="Special event in window">EVENT</span>' : '';
    }
    function row(w, isTotal) {
        var style = isTotal ? 'border-top: 1px solid var(--border-light); font-weight: 600;' : '';
        return '<tr style="' + style + '">' +
            '<td>' + w.label + (isTotal ? '' : evBadge(w)) + '</td>' +
            '<td class="replen-recsum-table__num">' + w.gap + '</td>' +
            '<td class="replen-recsum-table__num">' + w.rec + '</td>' +
            '<td style="color: #94A3B8;">' + (isTotal ? '' : (w.route || '--')) + '</td>' +
            '<td style="color: #64748B;">' + (isTotal ? '' : (w.reason || '')) + '</td>' +
            '</tr>';
    }
    var html = windows.map(function (w) { return row(w, false); }).join('');
    var totGap = windows.reduce(function (s, w) { return s + w.gap; }, 0);
    var totRec = windows.reduce(function (s, w) { return s + w.rec; }, 0);
    html += row({ label: 'Total', gap: totGap, rec: totRec, route: '', reason: '' }, true);
    return html;
}

// FM5-R4UI-R7 §2 — the expanded master row + its detail panel are ONE natural scroll unit. The R6 fixed-overlay
// clone pinned the master row below the header, but ANY pin (native sticky OR a floating overlay) necessarily
// FLOATS over the content that scrolls beneath it — which occluded the top of the second-level detail (the reported
// R6 defect). There is no offset that removes that occlusion for free vertical scrolling. So the pin is removed:
// the active master row keeps ONLY the .is-active-selected highlight (no reposition, no float) and scrolls TOGETHER
// with its detail panel — zero jump, zero occlusion, zero detachment; collapse/switch restores normal layout.
// These are safe no-op stubs kept so the toggleReplenRow call sites are unchanged; _irRemoveStickyOverlay also tears
// down any legacy #ir-sticky-overlay node a stale (R6) build may have left in the DOM.
function _irBindStickyScrollOnce() { _irRemoveStickyOverlay(); }

// F1-4B-FM5-R4UI-R5G §1 — expanded LEFT/RIGHT bottom-baseline parity when the right `.scroll-col` shows a
// HORIZONTAL scrollbar. That scrollbar consumes ~scrollbar-height of vertical space inside `.scroll-col`, which
// `align-items:stretch` makes the scrollbar-free `.fixed-col` match — pushing the LEFT divider below the RIGHT one.
// No CSS property reserves BOTTOM-scrollbar space, so we measure the LIVE scrollbar thickness (0 on overlay/macOS,
// ~15–17px on Windows) and expose it as `--km-hscroll-gutter`; the CSS lifts the fixed panel's divider by exactly
// that. This reads ONE metric (offsetHeight − clientHeight, with overflow-y hidden the h-scrollbar is its only
// contributor); it is NOT a height sync and NOT a poll — it fires only on mount, expand/collapse, and window resize.
function _irUpdateHScrollGutter_() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var sec = document.getElementById('ops-section'); if (!sec) return;
    var col = sec.querySelector('.dual-layer-table .scroll-col');
    var gutter = col ? Math.max(0, col.offsetHeight - col.clientHeight) : 0;   // horizontal scrollbar thickness (0 if none/overlay)
    sec.style.setProperty('--km-hscroll-gutter', gutter + 'px');
}
var _irHScrollGutterResizeBound = false;
function _irBindHScrollGutterResizeOnce_() {
    if (_irHScrollGutterResizeBound || typeof window === 'undefined' || !window.addEventListener) return;
    _irHScrollGutterResizeBound = true;
    window.addEventListener('resize', function () { _irUpdateHScrollGutter_(); });   // event-driven, not polling
}
if (typeof window !== 'undefined') { window._irUpdateHScrollGutter_ = _irUpdateHScrollGutter_; }
function _irRemoveStickyOverlay() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var ov = document.getElementById('ir-sticky-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}

// ================================================================================================================
// F1-7N-FB-4G-A1-R1 - PANEL-LOCAL PLANNING READINESS.
//
// A1 revealed the Recommendation Summary and the Execution Plan in ONE frame. That removed a real two-stage
// paint and it also coupled two panels whose slowest input is not shared. Production produced the case the
// coupling cannot survive - measured on the shipped A1 gate:
//
//       0:EXPAND (both skeletons)
//      40:gap read settled
//   60000:carrier catalogue settled            <- the transport's read bound elapsed
//   60000:RECOMMENDATION_SUMMARY_VISIBLE       <- 59 960 ms of avoidable wait
//   60000:EXECUTION_PLAN_VISIBLE (ERROR/REQUEST_TIMEOUT)
//
// A1's rule - a panel appears once, complete, and is never corrected in view - was right. The mistake was
// the scope it was applied at. Each panel now owns its own gate, its own generation and its own single
// reveal; neither can delay the other, and their data still loads in parallel exactly as before.
// ================================================================================================================
var _irRecoGateSingleton = null, _irExecGateSingleton = null;
var _irRowGen = 0;   // the expanded-row generation - bumped by every expand AND every collapse
// rAF, or an immediate call where there is no rAF (headless). NEVER setTimeout: a timer would be an
// artificial wait, and it would paint AFTER a frame rather than inside one.
function _irRevealFrame_(cb) {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') { window.requestAnimationFrame(cb); return; }
    cb();
}
function _irRevealNow_() {
    try { if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now(); } catch (e) {}
    return Date.now();
}
function _irRecoGate_() {
    if (_irRecoGateSingleton) return _irRecoGateSingleton;
    if (typeof window === 'undefined' || !window.IRPlanningReveal) return null;
    _irRecoGateSingleton = window.IRPlanningReveal.createPanelGate({
        name: 'recommendation', frame: _irRevealFrame_, now: _irRevealNow_, onReveal: _irRecoRevealPaint_
    });
    return _irRecoGateSingleton;
}
function _irExecGate_() {
    if (_irExecGateSingleton) return _irExecGateSingleton;
    if (typeof window === 'undefined' || !window.IRPlanningReveal) return null;
    _irExecGateSingleton = window.IRPlanningReveal.createPanelGate({
        name: 'execution', frame: _irRevealFrame_, now: _irRevealNow_, onReveal: _irExecRevealPaint_
    });
    return _irExecGateSingleton;
}
// The APPLIED station. A report carrying a different one is refused, so an answer that outlived a Search
// cannot paint into the station now on screen.
function _irRevealScopeKey_() {
    var sc = (typeof _irMethodScope_ === 'function') ? _irMethodScope_() : {};
    return [String(sc.company || ''), String(sc.country || ''), String(sc.marketplace || '')].join('|').toLowerCase();
}
function _irRevealSearchGen_() { return (typeof _irSearch !== 'undefined' && _irSearch) ? _irSearch.seq : null; }
function _irRevealCtx_(sku) {
    return { sku: sku, scopeKey: _irRevealScopeKey_(), searchGen: _irRevealSearchGen_(), rowGen: _irRowGen };
}
function _irRevealSkuData_(sku) {
    try {
        var data = (typeof getReplenishmentData === 'function') ? (getReplenishmentData() || []) : [];
        for (var i = 0; i < data.length; i++) { if (data[i] && data[i].sku === sku) return data[i]; }
    } catch (e) {}
    return null;
}
// WHICH read authority answers for the Recommendation Summary - the same selection _irRecoSummaryCardBody
// makes, so the panel and its readiness can never be reading different sources. NOTHING else is consulted:
// not the hydration, not the warehouse options, not the catalogue, not the lead times.
function _irRecoReadinessInput_() {
    if (typeof _irUseMaterializedGapRead === 'function' && _irUseMaterializedGapRead()) {
        return { mode: 'materialized', status: _irMatState.status, error: _irMatState.error };
    }
    if (typeof _irRecommendationWorkspaceEnabled === 'function' && _irRecommendationWorkspaceEnabled()) {
        return { mode: 'workspace', status: _irRecoState.status, error: (_irRecoState.errors && _irRecoState.errors[0]) || null };
    }
    return { mode: 'legacy' };
}
// EVERY input the first correct route paint needs, and only those.
function _irExecReadinessInput_(sku) {
    var reg = (typeof window !== 'undefined' && window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    var cat = 'LOADING', err = null;
    if (!reg) { cat = 'ERROR'; err = { code: 'METHOD_REGISTRY_MODULE_UNAVAILABLE', message: 'The shared method registry is not loaded on this page.' }; }
    else {
        var sc = (typeof _irMethodScope_ === 'function') ? _irMethodScope_() : {};
        err = reg.getError(sc);
        if (reg.isLoaded(sc)) cat = 'READY';
        else if (err) cat = 'ERROR';
    }
    var readModelReady = (typeof _irEffectiveWorkspace === 'function' && _irEffectiveWorkspace())
        ? !!_irReadModel : true;                                   // Legacy reads the broad cache, already present
    var rows = (typeof _allocationDraftRowsFor === 'function') ? _allocationDraftRowsFor(sku) : null;
    var hasRoutes = !!(rows && rows.length) || !!_irRevealSkuData_(sku);
    return { readModelReady: readModelReady, hydrationInFlight: !!_irDraftHydrateInFlight, catalogue: cat, error: err, hasRoutes: hasRoutes };
}
// Each panel reports independently, at the points its OWN source already settles. Neither call reads the
// other panel's state, and there is no code path that makes one wait for the other.
function _irRevealPumpReco_() {
    var gate = _irRecoGate_(); if (!gate) return null;
    var snap = gate.snapshot(); if (!snap) return null;
    gate.report(snap.gen, window.IRPlanningReveal.recommendationReadiness(_irRecoReadinessInput_()), _irRevealCtx_(snap.sku));
    return gate.snapshot();
}
function _irRevealPumpExec_() {
    var gate = _irExecGate_(); if (!gate) return null;
    var snap = gate.snapshot(); if (!snap) return null;
    gate.report(snap.gen, window.IRPlanningReveal.executionReadiness(_irExecReadinessInput_(snap.sku)), _irRevealCtx_(snap.sku));
    return gate.snapshot();
}
function _irRevealPump_() { _irRevealPumpReco_(); _irRevealPumpExec_(); }
window._irRevealPump_ = _irRevealPump_;
// Collapse, a table re-render, or a new Search. Afterwards neither panel has a current generation, so a late
// response has nowhere to land and cannot re-open a row the user closed.
function _irRevealAbandon_() {
    _irRowGen++;
    var r = _irRecoGate_(); if (r) r.abandon();
    var e = _irExecGate_(); if (e) e.abandon();
}
window._irRevealAbandon_ = _irRevealAbandon_;
// Open a generation for each panel and pump both SYNCHRONOUSLY. A source that has already settled - the
// ordinary case for the second and every later expand in a station - reveals in the SAME frame the panel was
// inserted in, so its skeleton never reaches the glass.
function _irRevealBegin_(sku) {
    var rg = _irRecoGate_(), eg = _irExecGate_();
    if (!rg || !eg) {                                // shared module absent: no barrier, previous behaviour
        if (typeof initializeShippingAllocation === 'function') initializeShippingAllocation(sku, _irRevealSkuData_(sku));
        return null;
    }
    var ctx = _irRevealCtx_(sku);
    rg.begin(ctx); eg.begin(ctx);
    // The catalogue is deduped and cached per applied scope, and after a Search it has normally been ADOPTED
    // from the workspace read - so this is a cache hit costing zero requests. It remains here for the paths
    // where adoption was not possible.
    if (typeof _irLoadCarrierPlanning_ === 'function') {
        try { _irLoadCarrierPlanning_().then(function () { _irRevealPumpExec_(); })['catch'](function () { _irRevealPumpExec_(); }); } catch (e) {}
    }
    _irRevealPumpReco_();
    _irRevealPumpExec_();
    return { recommendation: rg.snapshot(), execution: eg.snapshot() };
}
// Skeletons. Fixed, content-shaped and inert: no fabricated 0, no empty route, no 'Loading methods...'
// select - the three things a user could otherwise mistake for an answer.
function _irRevealRecoSkeletonHtml_() {
    var rows = '';
    for (var i = 0; i < 4; i++) rows += '<div class="ir-skel__row"><span class="ir-skel__bar ir-skel__bar--w"></span><span class="ir-skel__bar"></span><span class="ir-skel__bar"></span><span class="ir-skel__bar ir-skel__bar--wide"></span></div>';
    return '<div class="ir-skel ir-skel--table" role="status" aria-live="polite" aria-label="Loading Recommendation Summary">' + rows + '</div>';
}
function _irRevealExecSkeletonHtml_() {
    var rows = '';
    for (var i = 0; i < 2; i++) rows += '<div class="ir-skel__row ir-skel__row--route"><span class="ir-skel__bar"></span><span class="ir-skel__bar"></span><span class="ir-skel__bar ir-skel__bar--n"></span><span class="ir-skel__bar"></span><span class="ir-skel__bar"></span><span class="ir-skel__bar ir-skel__bar--n"></span></div>';
    return '<div class="ir-skel ir-skel--routes" role="status" aria-live="polite" aria-label="Loading Execution Plan">' + rows + '</div>';
}
// ONE builder for the Execution Plan card, used by the pending paint and the reveal paint alike, so the two
// cannot drift into different markup.
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §1 — THE SCOPE WAS COMPLETE AND THE SCREEN NEVER SAID SO.
//
// `_replenSelectedScope` derives company from the selected marketplace_id, the option values are marketplace_ids
// and distinct ids are never collapsed — so the page HAS always known which company it is looking at. What it
// never did was SAY. An operator reading "US / Amazon / CO1100-R" cannot tell KM's Amazon station from ResUS's,
// and the option label only appends the company when two labels collide EXACTLY, which is a coincidence and not
// a guarantee.
//
// §1 requires the company to be displayed or unambiguously identifiable before Submit. It is displayed.
// ================================================================================================================
function _irScopeCompanyBadgeHtml_() {
    var sc = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : {};
    var company = String((sc && sc.company) || '').trim();
    if (!company) {
        // Fail-closed and SAID so: an unknown company is the state in which the hydrate refuses to adopt any
        // stored route, and an operator must be able to see that rather than wonder where their plan went.
        return '<span class="ir-scope-company ir-scope-company--unknown" title="This marketplace record carries no company, '
            + 'so no stored Execution Plan can be attributed to it. Nothing was loaded and nothing was changed.">'
            + 'Company unknown</span>';
    }
    return '<span class="ir-scope-company" title="Company of the selected marketplace. Recommendation, Execution Plan, '
        + 'edit, delete and Submit all operate on company + country + marketplace + SKU.">' + escapeReplenHtml(company) + '</span>';
}
window._irScopeCompanyBadgeHtml_ = _irScopeCompanyBadgeHtml_;

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §3 — 760 AND 520 WERE ON THE SAME SCREEN WITH NOTHING SAYING HOW THEY RELATE.
//
// The live screen showed a recommendation of 760 above an Execution Plan totalling 520, and every reading an
// operator could take from that pair was wrong in a different direction: that the 760 had been applied, that the
// 520 was what the AI had just produced, or that the two agreed and only a carrier was missing. None is true.
// The 520 is what was ALREADY there, the 760 is ADVICE, and 240 units of the advice are not in any route.
//
// So the relationship is stated as an arithmetic identity rather than left to be inferred from two numbers in
// different cards. `remaining` is never auto-planned: materialization is flag-gated and off, and a difference
// an operator has not acted on is a decision they still have to make.
// ================================================================================================================
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R4 §5 — WHY 920 / 520 / 400 WAS NOWHERE ON THE SCREEN.
//
// The strip was complete, styled, hosted and repainted on every quantity change. It rendered nothing, because
// its FIRST line is `if (r.recommended_quantity === null) return ''` and it read the recommendation from
// `_irRecoByKey` — a map that is populated in exactly one place, inside handleReplenAiPlan, i.e. only after
// somebody clicks Generate AI Plan. On an ordinary load (Search, expand a SKU) it is `{}`, so the number was
// null and the whole block returned an empty string. Nothing was broken; it was asking a source that a normal
// session never fills.
//
// The number the operator can already see in the table comes from `_irSuggestedQtyState_`, which the page
// declares as THE single authority for this quantity (F1-7N-FB-4G-A0 §I, written after the top cell and the
// editor were caught reading two different sources for one number). So that is what this asks, and the AI DTO
// is preferred only when one actually exists. Both are reported by NAME — an AI plan's recommendation and the
// standing suggested quantity are different claims with different freshness, and a strip that showed a number
// without saying which it was would be the same class of defect in a new place.
// ================================================================================================================
function _irAdviceVsPlan_(sku) {
    function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
    var dto = (typeof _irRecoByKey !== 'undefined' && _irRecoByKey) ? _irRecoByKey[String(sku)] : null;
    var recommended = dto ? n(dto.suggestedQty) : null;
    var recSource = dto ? 'AI_PLAN_RECOMMENDATION' : '';
    var recState = dto ? 'READY' : '';
    if (recommended === null) {
        // The standing recommendation, through its declared owner. PENDING and NONE are NOT zero and must not
        // become one: a strip that printed 0 would read as "nothing is recommended", which is a claim the page
        // has no basis for while the read is still in flight or the gap row is BLOCKED.
        try {
            var _items = (typeof getReplenishmentData === 'function') ? (getReplenishmentData() || []) : [];
            var _item = null;
            _items.forEach(function (it) { if (!_item && it && String(it.sku) === String(sku)) _item = it; });
            if (_item && typeof _irSuggestedQtyState_ === 'function') {
                var _st = _irSuggestedQtyState_(_item);
                recState = _st.state;
                if (_st.state === 'READY' || _st.state === 'LEGACY') {
                    recommended = n(_st.value);
                    recSource = (_st.state === 'LEGACY') ? 'LEGACY_SUGGESTED_QTY' : 'MATERIALIZED_SUGGESTED_QTY';
                }
            }
        } catch (_eRQ) {}
    }
    var planned = 0, routeCount = 0;
    var list = (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('shipping-methods-' + sku) : null;
    // R6-R6 §2 — WHETHER THE PLAN CAN BE COUNTED AT ALL. Absent host = the Execution Plan has not
    // rendered yet, and its total is UNAVAILABLE. An empty host is a real, countable zero. Printing
    // 0 for both is the recommendation-side defect R6-R4 removed, in the other column.
    var plannedState = list ? 'READY' : 'UNAVAILABLE';
    if (list && list.querySelectorAll) {
        list.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
            if (typeof _irIsComposerEl_ === 'function' && _irIsComposerEl_(rowEl)) return;   // a half-typed row is not a plan
            var q = rowEl.querySelector('[data-field="qty"]');
            planned += n(q && q.value);
            routeCount++;
        });
    }
    var _bothKnown = (recommended !== null) && (plannedState === 'READY');
    var remaining = _bothKnown ? Math.max(0, recommended - planned) : null;
    var over = _bothKnown ? Math.max(0, planned - recommended) : null;
    // ==========================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §5 — TWO NUMBERS ABOUT DIFFERENT WAREHOUSES ARE NOT A DIFFERENCE.
    //
    // The live screen recommends 920 units sourced from an overseas 3PL and shows 520 units already routed from
    // a CN factory. Printing "920 recommended, 520 planned, 400 remaining" invites the one reading that is
    // certainly wrong: that the 520 is part of the 920 and 400 is what is left to do. They are separate supply
    // decisions from separate stock, and subtracting them is arithmetic without meaning.
    //
    // So both sides now say where their units come from. The existing routes' origin is read from the ROWS
    // THEMSELVES — the From select's own warehouse identity, never a label parsed for a country name — and the
    // recommendation's is read from the server's advice, verbatim. When the advice does not name one, this says
    // so; it does not guess, and it never presents the route's origin as the recommendation's.
    // ==========================================================================================================
    var routeSources = [], routeSourceCountries = [];
    if (list && list.querySelectorAll) {
        list.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
            if (typeof _irIsComposerEl_ === 'function' && _irIsComposerEl_(rowEl)) return;
            var f = rowEl.querySelector('[data-field="source_warehouse_id"]');
            if (!f || !f.options || f.selectedIndex < 0) return;
            var o = f.options[f.selectedIndex];
            if (!o) return;
            var id = String(f.value || '').trim();
            var nm = String(o.getAttribute('data-wh-name') || '').trim();
            var ct = String(o.getAttribute('data-wh-country') || '').trim();
            var ty = String(o.getAttribute('data-wh-type') || '').trim();
            if (!id) return;
            var hit = null;
            routeSources.forEach(function (x) { if (x.warehouse_id === id) hit = x; });
            if (!hit) routeSources.push({ warehouse_id: id, name: nm, country: ct, warehouse_type: ty });
            if (ct && routeSourceCountries.indexOf(ct) === -1) routeSourceCountries.push(ct);
        });
    }
    var adv = (typeof window !== 'undefined' && window._irLastAdvice) ? window._irLastAdvice : null;
    var recSources = [];
    try {
        (((adv && adv.scopes) || [])).forEach(function (sc) {
            ((sc && sc.supply_sources) || []).forEach(function (x) {
                var id = String((x && (x.warehouse_id || x.source_warehouse_id)) || x || '').trim();
                if (id && recSources.indexOf(id) === -1) recSources.push(id);
            });
        });
    } catch (eS) { recSources = []; }
    // A difference is only a quantity gap when both sides describe the SAME supply. When they do not, the
    // number is still shown — an operator asked for it — but it is named for what it is.
    var sameSupply = null;
    if (recSources.length && routeSources.length) {
        sameSupply = routeSources.every(function (r) { return recSources.indexOf(r.warehouse_id) !== -1; });
    }
    return {
        recommended_quantity: recommended,
        // WHICH recommendation answered, and what state its owner is in. Never inferred from the number.
        recommendation_source: recSource || 'NONE',
        recommendation_state: recState || 'NONE',
        currently_planned_quantity: planned,
        // R6-R6 §2 — READY (the number is countable, including a true 0) or UNAVAILABLE (it is not).
        currently_planned_state: plannedState,
        route_count: routeCount,
        remaining_unplanned: remaining,
        over_planned: over,
        // §5 provenance. `null`/empty means NOT STATED, which is different from "the same".
        recommendation_supply_sources: recSources,
        existing_route_sources: routeSources,
        existing_route_source_countries: routeSourceCountries,
        supply_sources_comparable: sameSupply,
        // Whether THIS run changed the stored plan. It is false on every flag-off run by construction: nothing
        // on that path writes. Stated as a fact rather than as reassurance.
        execution_plan_changed_by_this_run: (typeof window !== 'undefined' && window._irExecPlanChangedByLastRun === true),
        materialization_enabled: (typeof _irInventoryAiPlanDbGenerationEnabled_ === 'function')
            ? _irInventoryAiPlanDbGenerationEnabled_() : false
    };
}
window._irAdviceVsPlan_ = _irAdviceVsPlan_;

// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6 §2 — THE OPERATOR ASKED FOR THREE NUMBERS, NOT AN ESSAY.
//
// What shipped was correct and unusable. Every sentence in it was defending against a specific misreading —
// that the standing quantity was an AI recommendation, that this run had applied it, that two numbers about
// different warehouses could be subtracted — and each defence was a paragraph printed under a card whose job
// is to be operated. Five lines of prose sat between the plan total and the next control, and the operator
// said so: the screen must be clean, and the commentary was in the way of the work.
//
// A paragraph is not the only way to be honest, and it turned out to be the worst one available here. Every
// claim the prose was making is now made STRUCTURALLY instead, which is both quieter and harder to get wrong:
//
//   • The strip never says APPLIED, CREATED, ADDED or SAVED BY THIS RUN, because it has no sentences at all.
//     A label that cannot form a verb cannot make a false claim about what this run did. The old note existed
//     to deny something the compact strip never asserts.
//   • PENDING and UNAVAILABLE render as an em dash, never as 0. This is the R6-R4 rule applied to the second
//     column as well: `0 planned` and `the plan has not loaded` are different facts and were the same glyph.
//   • A plan larger than the recommendation is EXCESS, not a negative Remaining. `max(rec - planned, 0)` alone
//     would have silently printed 0 for an over-plan, which reads as `nothing left to do` for the one state
//     that most needs an operator to look at it.
//   • Different supply sources stay a WARNING, but a four-word one. The detail — which stock each side means —
//     moves to the title/aria-label, where an operator who wants it can get it and everyone else is not made
//     to read it. The warning is suppressed entirely when the sources agree, so its presence is information.
//
// The internal vocabulary (AI_PLAN_RECOMMENDATION, MATERIALIZED_SUGGESTED_QTY, run state, source authority)
// is not deleted — it moves to data-* attributes, where diagnostics and tests can still read every one of them
// and the operator is not asked to. That is the whole trade: same facts, no prose.
// ==============================================================================================================
function _irReconTooltip_(r) {
    // Built from the DATA on both sides, never from a hardcoded warehouse or carrier label.
    var out = [];
    var rs = (r.recommendation_supply_sources || []);
    if (rs.length) out.push('Recommendation: ' + rs.join(', '));
    var ps = (r.existing_route_sources || []).map(function (x) {
        return (x.name || x.warehouse_id) + (x.country ? ' (' + x.country + ')' : '');
    });
    if (ps.length) out.push('Current plan: ' + ps.join(', '));
    return out.join('\n');
}
window._irReconTooltip_ = _irReconTooltip_;

// One compact cell. `title` carries the detail for the states where a bare dash would be a question.
function _irReconCell_(label, value, valueClass, title) {
    return '<span class="ir-plan-recon__cell"' + (title ? ' title="' + _execEsc(title) + '"' : '') + '>'
        + '<span class="ir-plan-recon__label">' + _execEsc(label) + '</span>'
        + '<strong class="ir-plan-recon__value' + (valueClass ? ' ' + valueClass : '') + '">'
        + _execEsc(String(value)) + '</strong></span>';
}

// The reconciliation strip. Rendered under the Execution Plan total, where the two numbers actually meet.
function _irAdviceVsPlanHtml_(sku) {
    var r = _irAdviceVsPlan_(sku);
    var recKnown = (r.recommended_quantity !== null);
    var planKnown = (r.currently_planned_state === 'READY');
    // Nothing known and nothing planned is not a reconciliation — it is an empty card, and an empty card gets
    // no strip. This is the one case that renders nothing at all.
    if (!recKnown && (!r.currently_planned_quantity && !r.route_count)) return '';
    var DASH = '\u2014';
    // Column 3 is one of three things, and it SAYS which by its label rather than by its sign.
    var thirdLabel, thirdValue, thirdClass;
    if (!recKnown || !planKnown) {
        thirdLabel = 'Remaining'; thirdValue = DASH; thirdClass = '';
    } else if (r.over_planned > 0) {
        thirdLabel = 'Excess'; thirdValue = r.over_planned; thirdClass = 'ir-plan-recon__over';
    } else {
        thirdLabel = 'Remaining'; thirdValue = r.remaining_unplanned;
        thirdClass = (r.remaining_unplanned > 0) ? 'ir-plan-recon__remaining' : 'ir-plan-recon__matched';
    }
    // The only reason a number is missing, kept out of the main line and available on hover.
    var recTitle = recKnown ? ''
        : (r.recommendation_state === 'PENDING' ? 'Still loading' : 'Not available');
    var planTitle = planKnown ? '' : 'Not available';
    var flag = '';
    if (r.supply_sources_comparable === false) {
        // Four words on screen; the specifics live in the accessible description, not in the layout.
        var tip = _irReconTooltip_(r);
        flag = '<span class="ir-plan-recon__flag" tabindex="0" role="note"'
            + ' title="' + _execEsc(tip) + '" aria-label="Different inventory sources. ' + _execEsc(tip) + '">'
            + 'Different inventory sources</span>';
    }
    return '<div class="ir-plan-recon" id="ir-plan-recon-' + sku + '" role="status"'
        + ' data-recommendation-source="' + _execEsc(r.recommendation_source) + '"'
        + ' data-recommendation-state="' + _execEsc(r.recommendation_state) + '"'
        + ' data-planned-state="' + _execEsc(r.currently_planned_state) + '"'
        + ' data-difference-kind="' + _execEsc(thirdLabel.toUpperCase()) + '"'
        + ' data-supply-comparable="' + String(r.supply_sources_comparable) + '"'
        + ' data-route-count="' + r.route_count + '"'
        + ' data-plan-changed-by-this-run="' + String(r.execution_plan_changed_by_this_run === true) + '">'
        + _irReconCell_('Recommended', recKnown ? r.recommended_quantity : DASH, '', recTitle)
        + _irReconCell_('Planned', planKnown ? r.currently_planned_quantity : DASH, '', planTitle)
        + _irReconCell_(thirdLabel, thirdValue, thirdClass, '')
        + flag
        + '</div>';
}
window._irAdviceVsPlanHtml_ = _irAdviceVsPlanHtml_;

function _irExecPlanCardInnerHtml_(sku, ready) {
    var addBtn = ready
        ? '<button class="replen-card__add-route-btn" onclick="addExecutionRoute(event, \'' + sku + '\')" onmousedown="event.stopPropagation()">+ Add Route</button>'
        : '<button class="replen-card__add-route-btn" disabled aria-disabled="true" title="Loading the Execution Plan">+ Add Route</button>';
    // R6-R1 §3 — CURRENT Execution Plan. The word is load-bearing: it is what is stored now, not what the AI
    // just proposed, and the two were being read as one thing.
    var head = '<div class="replen-card__title-row"><h4 class="replen-card__title" style="margin: 0;">Current Execution Plan</h4>'
        + _irScopeCompanyBadgeHtml_() + addBtn + '</div>'
        + '<div class="ir-exec-plan__grid ir-exec-plan__grid--head"><span>From</span><span>To</span><span class="ir-exec-plan__qty">Qty</span><span>Method</span><span>Last Mile</span><span>Expected Arrival</span><span>Action</span></div>';
    if (!ready) return head + _irRevealExecSkeletonHtml_();
    return head
        + '<div id="shipping-methods-' + sku + '" class="exec-routes-list"></div>'
        + '<div class="replen-card__summary" style="border-top: 1px solid var(--border-light); margin-top: 4px; padding-top: 4px; display: flex; justify-content: space-between; font-weight: 600;">'
        + '<span class="replen-card__summary-label">Currently planned total</span><span class="replen-card__summary-value" id="allocation-total-' + sku + '">0</span></div>'
        + '<div id="ir-plan-recon-host-' + sku + '"></div>'
        + '<div class="replen-card__hint" id="allocation-hint-' + sku + '" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Factory Stock Available</div>'
        + '<div class="replen-card__carton-error" id="allocation-carton-error-' + sku + '" style="display: none; font-size: 11px; color: #EF4444; margin-top: 4px;"></div>'
        // F1-7N-FC-1B-E3-R2 §D.1/§D.2 — THE NEUTRAL SURFACE, AND IT IS ITS OWN ELEMENT.
        //
        // "You have not finished typing" and "the database refused your write" are different facts with
        // different owners and different colours, and they can be true at the same time (one route refused, a
        // second route half-edited). Sharing one <div> forced the last writer to erase the other's sentence,
        // which is a large part of why the incomplete notice was rendered through the failure renderer at all.
        // The hint carries no `color` of its own: §D.2 wants amber, and the stylesheet owns it so a future
        // round cannot quietly turn it red with an inline style the way the error surface does.
        + '<div class="ir-route-hint" id="allocation-route-hint-' + sku + '" style="display: none;" role="status"></div>';
}
// TWO independent reveal containers. They are siblings, not one wrapper, precisely so that no CSS rule and no
// query can accidentally re-couple them.
function _irDecisionAreaHtml_(sku) {
    return '<div class="ir-panel-column ir-panel-column--action ir-decision-area">'
        + '<div class="ir-reveal" id="ir-reveal-reco-' + sku + '" data-ir-reveal="recommendation" data-ir-sku="' + sku + '" data-reveal-state="pending">'
        + '<article class="replen-card replen-card--recommendation-summary" id="recommendation-summary-' + sku + '">'
        + '<h4 class="replen-card__title">Recommendation Summary</h4>' + _irRevealRecoSkeletonHtml_() + '</article></div>'
        + '<div class="ir-reveal" id="ir-reveal-exec-' + sku + '" data-ir-reveal="execution" data-ir-sku="' + sku + '" data-reveal-state="pending">'
        + '<article class="replen-card replen-card--execution-plan" id="execution-plan-' + sku + '">' + _irExecPlanCardInnerHtml_(sku, false) + '</article></div>'
        + '</div>';
}
// A settled failure is STATED, with the code that names it and the one action that can help. It is never
// degraded into an empty panel, and it never borrows another failure's sentence - a read that timed out, a
// backend that refused and a scope the user has not chosen are three different problems.
var IR_REVEAL_SENTENCE = {
    INVALID_SCOPE: 'Select a valid Country / Marketplace.',
    REQUEST_TIMEOUT: 'No answer arrived before the request timed out.',
    BACKEND_BUSINESS_REJECTION: 'The server refused this request.',
    STALE_SCOPE: 'Press Search to load this station.',
    NO_DATA: 'No stored result for this station.',
    NOT_CALCULATED: 'Not calculated.',
    READ_FAILED: 'The read did not complete.'
};
function _irRevealErrorHtml_(readiness, retryLabel, retryCall) {
    var code = (readiness && readiness.code) || 'READ_FAILED';
    var detail = (readiness && readiness.error && readiness.error.code) ? String(readiness.error.code) : '';
    var sentence = IR_REVEAL_SENTENCE[code] || IR_REVEAL_SENTENCE.READ_FAILED;
    return '<div class="ir-reveal__error" role="alert">'
        + '<span class="ir-reveal__error-code">' + escapeReplenHtml(code) + (detail && detail !== code ? ' \u00b7 ' + escapeReplenHtml(detail) : '') + '</span>'
        + '<span class="ir-reveal__error-msg">' + escapeReplenHtml(sentence) + '</span>'
        + (retryCall ? '<button type="button" class="ir-reveal__retry" onclick="' + retryCall + '" onmousedown="event.stopPropagation()">' + escapeReplenHtml(retryLabel) + '</button>' : '')
        + '</div>';
}
// THE RECOMMENDATION PANEL'S OWN PAINT. It reads nothing about the Execution Plan and touches nothing in it.
function _irRecoRevealPaint_(snap) {
    if (typeof document === 'undefined' || !snap || !snap.sku) return;
    var host = document.getElementById('ir-reveal-reco-' + snap.sku);
    if (!host) return;                                   // collapsed or re-rendered between settling and painting
    var card = document.getElementById('recommendation-summary-' + snap.sku);
    if (card) {
        card.innerHTML = '<h4 class="replen-card__title">Recommendation Summary</h4>'
            + (snap.readiness.state === 'ERROR'
                ? _irRevealErrorHtml_(snap.readiness, 'Retry', 'retryRecommendationSummary(event)')
                : _irRecoSummaryCardBody(_irRevealSkuData_(snap.sku)));
    }
    host.setAttribute('data-reveal-state', snap.readiness.state === 'ERROR' ? 'error' : 'ready');
    host.setAttribute('data-reveal-frame', String(snap.frameId || ''));
    if (typeof _irUpdateHScrollGutter_ === 'function') { try { _irUpdateHScrollGutter_(); } catch (e) {} }
}
// THE EXECUTION PANEL'S OWN PAINT.
//
// IT NEVER REBUILDS A PANEL THAT ALREADY HOLDS ROUTES. A rebuild would re-render from the Working Draft, and
// that is the one operation capable of destroying a route the operator added with + Add Route, resetting a
// Total the operator can see, or discarding an edit that has not been captured yet. A panel is built ONCE;
// after that only in-place updates touch it (the Method options and the ETAs, by their own owners).
function _irExecRevealPaint_(snap) {
    if (typeof document === 'undefined' || !snap || !snap.sku) return;
    var sku = snap.sku;
    var host = document.getElementById('ir-reveal-exec-' + sku);
    if (!host) return;
    if (document.getElementById('shipping-methods-' + sku)) return;   // already built - never rebuilt
    var card = document.getElementById('execution-plan-' + sku);
    if (card) {
        card.innerHTML = _irExecPlanCardInnerHtml_(sku, true)
            + (snap.readiness.state === 'ERROR'
                ? _irRevealErrorHtml_(snap.readiness, 'Retry Methods', 'retryExecutionMethods(event, \'' + sku + '\')')
                : '');
        // The catalogue is TERMINAL by construction here, so the routes are painted once, correctly: the
        // persisted service selects against a complete option list and the ETA resolves against real lead
        // times. Nothing is scheduled to come back and fix them.
        if (typeof initializeShippingAllocation === 'function') initializeShippingAllocation(sku, _irRevealSkuData_(sku), { catalogueSettled: true });
    }
    host.setAttribute('data-reveal-state', snap.readiness.state === 'ERROR' ? 'error' : 'ready');
    host.setAttribute('data-reveal-frame', String(snap.frameId || ''));
    if (typeof _irRevealSyncActionAvailability_ === 'function') _irRevealSyncActionAvailability_();
    if (typeof _irUpdateHScrollGutter_ === 'function') { try { _irUpdateHScrollGutter_(); } catch (e) {} }
}
// RETRY THE RECOMMENDATION READ, and nothing else. One request per click; no loop, no auto-retry, and the
// Execution Plan is not touched - its routes, its edits and its user-added rows are none of this button's
// business.
function retryRecommendationSummary(event) {
    if (event) { event.stopPropagation(); if (event.preventDefault) event.preventDefault(); }
    var g = _irRecoGate_(); var snap = g ? g.snapshot() : null;
    var sku = snap ? snap.sku : '';
    var host = sku ? document.getElementById('ir-reveal-reco-' + sku) : null;
    var card = sku ? document.getElementById('recommendation-summary-' + sku) : null;
    if (host && card && g) {
        host.setAttribute('data-reveal-state', 'pending');
        card.innerHTML = '<h4 class="replen-card__title">Recommendation Summary</h4>' + _irRevealRecoSkeletonHtml_();
        g.begin(_irRevealCtx_(sku));
    }
    if (typeof refreshInventoryGapAfterRecalc_ === 'function') refreshInventoryGapAfterRecalc_();
    return false;
}
window.retryRecommendationSummary = retryRecommendationSummary;
// RETRY THE METHOD / LEAD-TIME READ, and nothing else. Exactly ONE request per click (the registry's own
// retry), then an IN-PLACE repaint of the Method options and the ETAs. It does NOT re-read the
// Recommendation, does NOT re-read the workspace, does NOT rebuild any route, and therefore cannot remove a
// user-added route, change a Total, or overwrite an edited From / To / Qty / Method.
function retryExecutionMethods(event, sku) {
    if (event) { event.stopPropagation(); if (event.preventDefault) event.preventDefault(); }
    var host = document.getElementById('ir-reveal-exec-' + sku);
    if (host) host.setAttribute('data-reveal-state', 'retrying');
    if (typeof _irRetryMethodRegistry_ !== 'function') return false;
    _irRetryMethodRegistry_(sku).then(function () {
        if (typeof _irUpdateRouteEtas === 'function') _irUpdateRouteEtas(sku);
        var h = document.getElementById('ir-reveal-exec-' + sku);
        var reg = (window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
        var ok = !!(reg && reg.isLoaded(_irMethodScope_()));
        if (h) h.setAttribute('data-reveal-state', ok ? 'ready' : 'error');
        if (ok) {
            var banner = document.querySelector('#execution-plan-' + sku + ' .ir-reveal__error');
            if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        }
        if (typeof _irRevealSyncActionAvailability_ === 'function') _irRevealSyncActionAvailability_();
    });
    return false;
}
window.retryExecutionMethods = retryExecutionMethods;
// Submit Plan commits the Working Draft for EVERY sku, so it must not be pressable while an Execution Plan on
// screen is still a shell or is in a named failure. A RECOMMENDATION failure does not disable it: the
// Recommendation Summary is a system suggestion and Submit has never read it.
function _irRevealSyncActionAvailability_() {
    if (typeof document === 'undefined' || !document.querySelector) return;
    var blocked = !!document.querySelector('#ops-section [data-ir-reveal="execution"][data-reveal-state="pending"]')
        || !!document.querySelector('#ops-section [data-ir-reveal="execution"][data-reveal-state="error"]')
        || !!document.querySelector('#ops-section [data-ir-reveal="execution"][data-reveal-state="retrying"]');
    var btns = document.querySelectorAll('#ops-section [onclick="submitReplenishmentPlans()"]');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = blocked; if (blocked) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); });
}
window._irRevealSyncActionAvailability_ = _irRevealSyncActionAvailability_;

// F1-7N-FB-4G-A2-R3-R1 §G — WHILE A SAVE IS IN FLIGHT, THE OPERATOR CANNOT START A SECOND ONE.
//
// Nothing stopped a second Save, a Submit, or a + Add Route while the first batch was still being written, so
// an operator watching a slow save could stack requests over rows whose identities the first batch had not yet
// stamped. The inputs stay VISIBLE and editable — the work is never taken away — but the three actions that
// START A WRITE are held until the batch settles. The state is derived from _draftDbInFlight, so it can never
// disagree with whether a write is actually outstanding.
function _irAnySaveInFlight_() {
    try { return Object.keys(_draftDbInFlight).some(function (k) { return !!_draftDbInFlight[k]; }); }
    catch (e) { return false; }
}
function _irSaveBusySync_() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var busy = _irAnySaveInFlight_();
    var sel = '#ops-section [onclick="submitReplenishmentPlans()"], #ops-section .replen-card__add-route-btn';
    var btns = document.querySelectorAll(sel);
    Array.prototype.forEach.call(btns, function (b) {
        if (busy) {
            if (!b.hasAttribute('data-ir-save-busy-was-disabled')) b.setAttribute('data-ir-save-busy-was-disabled', b.disabled ? '1' : '0');
            b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.setAttribute('data-ir-save-busy', 'true');
        } else if (b.hasAttribute('data-ir-save-busy')) {
            var was = b.getAttribute('data-ir-save-busy-was-disabled') === '1';
            b.disabled = was; if (!was) b.removeAttribute('aria-disabled');
            b.removeAttribute('data-ir-save-busy'); b.removeAttribute('data-ir-save-busy-was-disabled');
        }
    });
    try { if (typeof _irRevealSyncActionAvailability_ === 'function' && !busy) _irRevealSyncActionAvailability_(); } catch (e) {}
}
window._irSaveBusySync_ = _irSaveBusySync_;
// §G.2 — the per-route state the operator reads. One route's outcome never describes another's.
// F1-7N-FC-1B-E3-R2 §B — `INCOMPLETE` joins them. It was missing, so a row the operator had not
// finished typing was badged `Not saved` — true of the database and useless to the operator, who had not
// asked for anything to be saved. "Not saved" is the outcome of an ATTEMPT; this state is the absence of one.
var IR_ROUTE_SAVE_STATES_ = { SAVING: 'Saving', SAVED: 'Saved', NOT_SAVED: 'Not saved',
    RECONCILING: 'Reconciling', OUTCOME_UNKNOWN: 'Outcome unknown', INCOMPLETE: 'Not yet complete' };
function _irSetRouteSaveState_(sku, instanceIds, state) {
    if (!IR_ROUTE_SAVE_STATES_[state]) return 0;
    var want = {}; (instanceIds || []).forEach(function (k) { if (k) want[String(k)] = 1; });
    var n = 0;
    var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
    rows.forEach(function (r) {
        if (!want[String(r.client_route_instance_id || '')]) return;
        r.route_save_state = state; n++;
    });
    try {
        if (typeof document === 'undefined' || !document.getElementById) return n;
        var host = document.getElementById('shipping-methods-' + sku); if (!host) return n;
        var els = host.querySelectorAll('[data-route-instance]');
        for (var i = 0; i < els.length; i++) {
            if (!want[String(els[i].getAttribute('data-route-instance') || '')]) continue;
            els[i].setAttribute('data-route-save-state', state);
            els[i].setAttribute('data-route-save-label', IR_ROUTE_SAVE_STATES_[state]);
        }
    } catch (e) {}
    return n;
}
window._irSetRouteSaveState_ = _irSetRouteSaveState_;

// F1-7N-FC-1B-E3-R2 §B — the row's UI state, from IRRouteUiState (pure, shared with the tests) with a
// tiny inline fallback for a failed module load. The fallback is deliberately CONSERVATIVE: if it cannot tell,
// it answers with a non-failure state, because rendering a red database-failure over an editor state is the
// defect this round removes and a module load is the wrong thing to have it depend on.
function _irIsComposerRow_(r) {
    if (window.IRRouteComposer && typeof window.IRRouteComposer.isComposer === 'function') return window.IRRouteComposer.isComposer(r);
    return !!r && String((r && r.route_kind) || '').toUpperCase() === 'MANUAL_COMPOSER';
}
window._irIsComposerRow_ = _irIsComposerRow_;
function _irRouteUiState_(r, ctx) {
    if (window.IRRouteUiState && typeof window.IRRouteUiState.of === 'function') return window.IRRouteUiState.of(r, ctx);
    var complete = (typeof _isRouteComplete === 'function') ? !!_isRouteComplete(r) : false;
    if (_irIsComposerRow_(r) && !complete) return (r && r.composer_touched === true) ? 'TOUCHED_INCOMPLETE_COMPOSER' : 'PRISTINE_COMPOSER';
    if (!complete) return String((r && r.allocation_draft_id) || '').trim() ? 'PERSISTED_ROUTE_EDIT_INCOMPLETE' : 'TOUCHED_INCOMPLETE_COMPOSER';
    return 'SAVE_PENDING';
}
window._irRouteUiState_ = _irRouteUiState_;
function _irRouteUiStateIsFailure_(s) {
    if (window.IRRouteUiState && typeof window.IRRouteUiState.isFailure === 'function') return window.IRRouteUiState.isFailure(s);
    return String(s) === 'SAVE_FAILED' || String(s) === 'SAVE_OUTCOME_UNKNOWN';
}
window._irRouteUiStateIsFailure_ = _irRouteUiStateIsFailure_;

function toggleReplenRow(sku) {
    const fixedRows = document.querySelectorAll('#ops-section .fixed-row');
    const scrollRows = document.querySelectorAll('#ops-section .scroll-row');
    const fixedBody = document.getElementById('replenFixedBody');
    const scrollBody = document.getElementById('replenScrollBody');
    
    // ONE render transaction drives BOTH sides. Collapse everything first (both bodies, both rows'
    // .expanded class, and every chevron's aria-expanded/rotation) so left and right can never desync.
    const existingFixedPanels = document.querySelectorAll('#ops-section .fixed-body .replen-expand-panel');
    const existingScrollPanels = document.querySelectorAll('#ops-section .scroll-body .replen-expand-panel');
    existingFixedPanels.forEach(panel => panel.remove());
    existingScrollPanels.forEach(panel => panel.remove());

    // FM5-R4UI-R4 §2: clear the active-selected + active-sticky state everywhere on every collapse pass so only the
    // ONE currently expanded master row is ever highlighted/sticky (collapse fully restores normal row flow).
    fixedRows.forEach(row => { row.classList.remove('expanded'); row.classList.remove('is-active-sticky'); row.classList.remove('is-active-selected'); });
    scrollRows.forEach(row => { row.classList.remove('expanded'); row.classList.remove('is-active-sticky'); row.classList.remove('is-active-selected'); });
    // FM5-R4UI-R6 §5 — every collapse pass tears down the sticky visual overlay so a stale pinned bar can never
    // linger (also covers the re-click-to-collapse path, which returns before re-adding .is-active-selected below).
    if (typeof _irRemoveStickyOverlay === 'function') _irRemoveStickyOverlay();
    document.querySelectorAll('#ops-section .replen-row-chevron').forEach(function (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('is-open');
    });

    // Single source of truth: currentExpandedRow. _irNextExpandedKey collapses on re-click, else opens.
    const nextKey = _irNextExpandedKey(currentExpandedRow, sku);
    // Every expand pass has already removed both panels above, so ANY open generation is now orphaned -
    // abandon it before a new one starts, and on the collapse path leave none open at all. This is what
    // stops a late response from re-opening or repainting a row the user has closed (§D.7).
    _irRevealAbandon_();
    if (nextKey === null) {
        currentExpandedRow = null;
        if (typeof _irRevealSyncActionAvailability_ === 'function') _irRevealSyncActionAvailability_();
        return;
    }

    currentExpandedRow = nextKey;
    const fixedRow = Array.from(fixedRows).find(row => row.dataset.sku === sku);
    const scrollRow = Array.from(scrollRows).find(row => row.dataset.sku === sku);

    // Both containers receive their expanded class in the SAME synchronous pass (no per-side setTimeout).
    // FM5-R4UI-R4 §2: on expand the active master row gets ONLY the subtle selected highlight (.is-active-selected)
    // — NOT position:sticky — so expanding causes ZERO vertical jump (the earlier R3 code applied sticky+top at
    // expand, which clamped a near-top row downward). The sticky positioning (.is-active-sticky) is added lazily by
    // the scroll handler once the user actually scrolls, so the row only pins under the header when it would leave
    // the viewport (see _irBindStickyScrollOnce). Collapse clears BOTH classes → normal flow restored.
    if (fixedRow) { fixedRow.classList.add('expanded'); fixedRow.classList.add('is-active-selected'); }
    if (scrollRow) { scrollRow.classList.add('expanded'); scrollRow.classList.add('is-active-selected'); }
    _irBindStickyScrollOnce();
    if (fixedRow) {
        const chevron = fixedRow.querySelector('.replen-row-chevron');
        if (chevron) { chevron.setAttribute('aria-expanded', 'true'); chevron.classList.add('is-open'); }
    }

    const data = getReplenishmentData();
    const skuData = data.find(item => item.sku === sku);
    
    const expandFixedHTML = `
        <div class="replen-expand-panel replen-expand-panel--fixed">
            <div class="replen-expand-fixed">
                <strong>${sku}</strong>
                <div style="margin-top: 8px; font-size: 14px; color: #333;">
                    ${skuData?.productName || 'Product Name'}
                </div>
                <div style="margin-top: 8px; font-size: 12px; color: #666;">
                    Click row to close
                </div>
            </div>
        </div>
    `;
    
    // TODO (Stage 2 / 3):
    // Replace rule-based suggestion with AI / seasonality model
    // - incorporate historical promotions, deals, yearly cycle
    // - weekly replenishment recommendation
    
    const expandScrollHTML = `
        <div class="replen-expand-panel replen-expand-panel--scroll" id="${_irPanelId(sku)}">
            <div class="replen-expand-scroll">
                <div class="ir-panel ir-panel--inventory-group ir-fulfillment--${skuData?.fulfillmentModel || 'unset'}" data-fulfillment="${skuData?.fulfillmentModel || ''}">
                    <section class="replen-expand-section--inventory">
                        <div class="replen-card-grid">
                            <article class="replen-card replen-card--stock">
                                <h4 class="replen-card__title">Stock${skuData?.fulfillmentModel ? ` <span class="ir-ff-badge">${skuData.fulfillmentModel}</span>` : ''}</h4>
                                <div class="replen-card__row"><span class="replen-card__label">Available</span><span class="replen-card__value">${skuData?.available || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">FC Transfer</span><span class="replen-card__value">${skuData?.fcTransfer || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">FC Processing</span><span class="replen-card__value">${skuData?.fcProcessing || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">Customer Orders</span><span class="replen-card__value">${skuData?.customerOrders || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">Unsellable</span><span class="replen-card__value">${skuData?.unsellable || 0}</span></div>
                            </article>
                            <article class="replen-card replen-card--lts">
                                <h4 class="replen-card__title">Long Term Storage</h4>
                                <div class="replen-card__row"><span class="replen-card__label">Over 90+</span><span class="replen-card__value">${skuData?.over90 || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">Over 180+</span><span class="replen-card__value">${skuData?.over180 || 0}</span></div>
                            </article>
                            <article class="replen-card replen-card--shipping">
                                <h4 class="replen-card__title">Shipping Shipment</h4>
                                ${(skuData?.shipOverdue || 0) > 0 ? ('<div class="replen-card__row replen-card__row--overdue"><span class="replen-card__label">Overdue</span><span class="replen-card__value">' + (skuData.shipOverdue) + '</span></div>') : ''}
                                <div class="replen-card__row"><span class="replen-card__label">Within 18 days</span><span class="replen-card__value">${skuData?.within18days || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">Within 30 days</span><span class="replen-card__value">${skuData?.within30days || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">Within 45 days</span><span class="replen-card__value">${skuData?.within45days || 0}</span></div>
                                <div class="replen-card__row"><span class="replen-card__label">45+ days</span><span class="replen-card__value">${skuData?.within45plus || 0}</span></div>
                            </article>
                            <article class="replen-card replen-card--third-party">
                                <h4 class="replen-card__title">3rd Party Stock</h4>
                                ${skuData?.thirdPartyDetailHtml || ('<div class="replen-card__row"><span class="replen-card__label">Winit</span><span class="replen-card__value">' + (skuData?.winitStock || 0) + '</span></div><div class="replen-card__row"><span class="replen-card__label">ONUS</span><span class="replen-card__value">' + (skuData?.onusStock || 0) + '</span></div>')}
                            </article>
                        </div>
                    </section>
                </div>
                <div class="ir-panel-column ir-panel-column--context">
                    <article class="ir-panel replen-card replen-card--forecast">
                        <h4 class="replen-card__title">Forecast Breakdown</h4>
                        <div class="replen-card__row" style="font-weight: 600; margin-top: 4px;"><span class="replen-card__label">The Following</span><span class="replen-card__value"></span></div>
                        <div class="replen-card__row"><span class="replen-card__label">${skuData?.nextMonth || '-'}</span><span class="replen-card__value">${skuData?.fcNextMonth || 0}</span></div>
                        <div class="replen-card__row"><span class="replen-card__label">${skuData?.next2Month || '-'}</span><span class="replen-card__value">${skuData?.fcNext2Month || 0}</span></div>
                        <div class="replen-card__row"><span class="replen-card__label">${skuData?.next3Month || '-'}</span><span class="replen-card__value">${skuData?.fcNext3Month || 0}</span></div>
                        <div class="replen-card__row" style="font-weight: 600;"><span class="replen-card__label">Total</span><span class="replen-card__value">${(skuData?.fcNextMonth || 0) + (skuData?.fcNext2Month || 0) + (skuData?.fcNext3Month || 0)}</span></div>
                    </article>
                    <article class="ir-panel replen-card replen-card--upcoming">
                        <h4 class="replen-card__title">Upcoming Event</h4>
                        ${skuData?.upcomingEventsText || '<div class="replen-card__row"><span class="replen-card__label">No upcoming event</span><span class="replen-card__value">-</span></div>'}
                    </article>
                </div>
                <!-- Analysis area (insight column): Sales Trend + Monthly Achievement Rate directly below it (§11.5). -->
                <div class="ir-panel-column ir-panel-column--insight">
                    <article class="ir-panel replen-card replen-card--sales-trend">
                        <h4 class="replen-card__title">Sales Trend (Past Week)</h4>
                        <canvas id="sales-trend-chart-${sku}" style="max-height: 100px;"></canvas>
                    </article>
                    <article class="ir-panel replen-card replen-card--achievement">
                        <h4 class="replen-card__title">Monthly Achievement Rate <span class="replen-card__title-note">(past 3 completed months)</span></h4>
                        ${_irRenderMonthlyAchievement(skuData)}
                    </article>
                </div>
                <!-- Decision area (action column): Recommendation Summary directly ABOVE Execution Plan,
                     stacked, same width, technically separate (§11.5). -->
                <!-- F1-7N-FB-4G-A1 - the two DECISION panels are revealed together. Both are shells in this
                     first frame; the barrier replaces both in ONE later frame, once BOTH are terminal. The
                     Stock / Forecast / Sales Trend blocks above are NOT behind it and paint immediately. -->
                ${_irDecisionAreaHtml_(sku)}
            </div>
        </div>
    `;
    
    const expandPanelFixed = document.createElement('div');
    expandPanelFixed.innerHTML = expandFixedHTML;
    const fixedElement = expandPanelFixed.firstElementChild;
    
    const expandPanelScroll = document.createElement('div');
    expandPanelScroll.innerHTML = expandScrollHTML;
    const scrollElement = expandPanelScroll.firstElementChild;
    
    const rowIndex = Array.from(fixedRows).indexOf(fixedRow);
    if (rowIndex < fixedRows.length - 1) {
        fixedRows[rowIndex + 1].before(fixedElement);
        scrollRows[rowIndex + 1].before(scrollElement);
    } else {
        fixedBody.appendChild(fixedElement);
        scrollBody.appendChild(scrollElement);
    }
    
    // Expand-row equal height is CSS-native (flex-column .fixed-col / .fixed-body + the
    // .replen-expand-panel--fixed { flex:1 } that stretches to the taller .scroll-col) — the SKU identity panel is
    // full height in the FIRST paint, with NO JS height sync and NO inline height writes. This tick only seeds
    // routes + charts, then refreshes --km-hscroll-gutter (R5G §1): after async content the right column's
    // horizontal overflow (hence its scrollbar) is settled, so the LEFT panel can reserve the matching bottom gutter.
    // F1-7N-FB-4G-A1 - the Execution Plan is seeded by the REVEAL, not here, and the barrier opens
    // SYNCHRONOUSLY: a generation is started and both sources are polled in this same call, so a station
    // whose data is already settled reveals inside the frame this panel was inserted in. Nothing about the
    // decision area waits on a timer any more.
    _irRevealBegin_(sku);
    if (typeof _irRevealSyncActionAvailability_ === 'function') _irRevealSyncActionAvailability_();
    // The Sales Trend chart is NOT behind the barrier (§D) - it keeps its own existing tick, which is a
    // Chart.js mount requirement and not a readiness wait.
    setTimeout(() => {
        initSalesTrendChart(sku, skuData);
        if (typeof _irUpdateHScrollGutter_ === 'function') _irUpdateHScrollGutter_();
    }, 0);
}

function updatePlannedQty(sku, qty) {
    replenishmentPlans[sku] = parseInt(qty) || 0;
}

function updateShippingMethod(sku, method) {
    replenishmentShippingMethods[sku] = method;
}

function updateGlobalShippingMethod(method) {
    // 全域運輸方式選擇，可用於批次設定或顯示
    console.log('Global shipping method selected:', method);
}

function updateReplenNote(sku, note) {
    replenishmentNotes[sku] = note;
}

function createPlan(sku) {
    console.log('Create plan for SKU:', sku);
    alert(`Create plan for ${sku} - Stage 1 placeholder`);
}

async function submitReplenishmentPlans() {
    const data = getReplenishmentData();
    // Country + marketplace NAME are derived from the selected scope (the Marketplace dropdown value is a
    // marketplace_id in Cloud mode), so the payload carries the marketplace NAME — not the raw id.
    const _scope = _replenSelectedScope();
    const country = _scope.country;
    const marketplace = _scope.marketplace;
    // F1-4B-FM5-R4UI-R3 (§9): the visible "Target Days" control was removed — the canonical horizons are fixed at
    // D18/D30/D45/D90 and the materialized gap authority never consumes a UI target-days value. The legacy
    // shipping-plan Decision Snapshot still records a target-days figure, so fall back to the internal constant when
    // the (now-absent) control is not present. Reads the control ONLY if a page variant still renders it.
    var _tdEl = document.getElementById('replenTargetDays');
    const targetDays = _tdEl ? _tdEl.value : REPLEN_TARGET_DAYS;
    const shippingPlans = {};
    
    console.log('=== Submit Plan Debug ===');
    console.log('Total SKUs:', data.length);
    
    // Submit Plan reads ONLY the Execution Plan state (the Working Draft) — the single source of
    // the PM's actual shipping decision. It NEVER reads the Recommendation Summary (system
    // suggestion) or the live DOM. A SKU whose Execution Plan the PM never customized (no draft
    // row) is NOT submitted. Each Execution Plan route carries ship_from / destination /
    // shipping_method / qty. This is the only place that turns the Execution Plan into
    // shipping_plans — Decision Commit.
    data.forEach(item => {
        const draftRows = _allocationDraftRowsFor(item.sku);
        if (!draftRows || !draftRows.length) return;
        draftRows.forEach(r => {
            const method = r.shipping_method;
            const qty = parseInt(r.qty) || 0;
            if (qty > 0 && method) {
                if (!shippingPlans[method]) shippingPlans[method] = [];
                shippingPlans[method].push({
                    sku: item.sku,
                    qty: qty,
                    skuData: item,
                    ship_from: r.ship_from || '',                         // display name
                    source_warehouse_id: r.source_warehouse_id || '',    // canonical From id
                    ship_from_type: r.ship_from_type || '',
                    destination: r.destination || '',                    // display name
                    destination_warehouse_id: r.destination_warehouse_id || '',  // canonical To id
                    destination_type: r.destination_type || '',
                    sourceReason: r.source_reason || 'pm_adjustment'
                });
            }
        });
    });
    
    console.log('Shipping Plans:', shippingPlans);
    console.log('Total Methods:', Object.keys(shippingPlans).length);
    
    // 檢查是否有任何數值
    let totalSkus = 0;
    Object.keys(shippingPlans).forEach(method => {
        totalSkus += shippingPlans[method].length;
    });
    
    if (totalSkus === 0) {
        alert('No SKUs Submitted');
        return;
    }

    var targetDaysNum = parseFloat(targetDays) || 0;

    // Build a flat line list (one row per SKU×method). The backend groups into shipping_plans by
    // the six-value key (company + country + marketplace + ship_from + destination + shipping_method)
    // and freezes the per-SKU Decision Snapshot. See WEEKLY_SHIPPING_PLAN_MAPPING_SPEC.md.
    var planLines = [];
    Object.keys(shippingPlans).forEach(function(method) {
        shippingPlans[method].forEach(function(item) {
            var sd = item.skuData || {};
            var mock = (typeof replenishmentMockData !== 'undefined') ? replenishmentMockData.find(function(m){ return m.sku === item.sku; }) : null;
            var lineCompany = (sd.company && sd.company !== '--') ? sd.company : '';   // backend resolves if blank
            planLines.push({
                company: lineCompany,
                country: country,
                marketplace: marketplace,
                ship_from: item.ship_from || '',                             // display name (Warehouse Name is display-only)
                source_warehouse_id: item.source_warehouse_id || '',        // canonical From (warehouse_id)
                ship_from_type: item.ship_from_type || '',
                destination: item.destination || '',                        // display name
                destination_warehouse_id: item.destination_warehouse_id || '',  // canonical To (warehouse_id)
                destination_type: item.destination_type || '',
                shipping_method: method,
                sku: item.sku,
                requested_qty: item.qty,
                units_per_carton: (mock && mock.unitsPerCarton) || sd.unitsPerCarton || '',
                source_page: 'inventory_replenishment',
                source_reason: item.sourceReason || 'manual_submit',
                inventory_snapshot_date: '',
                snapshot_current_stock: sd.currentInventory != null ? sd.currentInventory : '',
                snapshot_avg_sales_per_day: sd.avgDailySales != null ? sd.avgDailySales : '',
                snapshot_days_of_supply: sd.daysOfSupply != null ? sd.daysOfSupply : '',
                snapshot_suggested_qty: sd.suggestedQty != null ? sd.suggestedQty : '',
                snapshot_target_days: targetDaysNum,
                snapshot_fc_context: sd.forecast60d != null ? sd.forecast60d : '',
                snapshot_event_context: (sd.upcomingEventQty != null ? sd.upcomingEventQty : '')
            });
        });
    });

    // Carton validation gate (Fix 7): every submitted line qty must be an integer multiple of
    // units_per_carton; a missing units_per_carton blocks Submit Plan. Never silently round.
    var cartonErrors = [];
    var badSkus = {};
    planLines.forEach(function(l) {
        var upc = parseInt(l.units_per_carton) || 0;
        var qty = parseInt(l.requested_qty) || 0;
        if (qty <= 0) return;
        if (!upc) {
            cartonErrors.push(l.sku + ' (units per carton missing)');
            badSkus[l.sku] = true;
        } else if (qty % upc !== 0) {
            cartonErrors.push(l.sku + ' (qty ' + qty + ' not a multiple of ' + upc + ')');
            badSkus[l.sku] = true;
        }
    });
    if (cartonErrors.length) {
        // Surface inline red text on any expanded allocation blocks for the offending SKUs.
        Object.keys(badSkus).forEach(function(sku) {
            if (typeof validateAllocationCartons === 'function') validateAllocationCartons(sku);
        });
        alert('Cannot Submit Plan — Shipping Qty must be a full carton multiple.\n\n' + cartonErrors.join('\n'));
        return;
    }

    // F1-7N-FA-4B — CANONICAL SERVER-OWNED Submit (STAGED). The backend re-reads the persisted allocation drafts; the
    // frontend NO LONGER sends authored plan lines. It sends only the selected allocation_draft_id(s) + a stable
    // execution key. Single-flight: one in-flight Promise per execution key; a second click shares it (never a second
    // mutation). The Working Draft is cleared only on a confirmed terminal CREATED/REUSED. planLines above are retained
    // solely for the client-side carton pre-gate — they are NOT transmitted. (Old createShippingPlansBatch line-trusting
    // call removed; the API name remains a deprecated compatibility wrapper.)
    // F1-7N-FB-2 §C/§E — SUBMIT FAILS CLOSED. The eligibility predicate is now a CONFIGURATION fact
    // (isProductionWriteEligible), not a cache-load fact. isCloudWriteEnabled() required a primed broad
    // _opDbCache, which an F1-7L zero-prime session never has — so on the deployed site this gate silently
    // failed and Submit fell into the sessionStorage branch below, alerting "created (Demo / local mode)" while
    // persisting NOTHING. A business write must never have an automatic production fallback.
    // F1-7N-FB-2A §D — Submit must never carry an unpersisted Execution Plan row. The canonical Submit sends
    // only persisted allocation_draft_id(s) and the backend re-reads the persisted rows, so an unsaved route
    // would be SILENTLY DROPPED from the submitted plan — a partially-submitted plan that looks complete. Fail
    // CLOSED instead, naming the routes that must be fixed first. This runs before any request.
    // F1-7N-FB-4G-A2-R1 §3 — SUBMIT DOES NOT SAVE. FB-3B §G used to flush the debounced Execution-Plan writes
    // here and wait for them, so that the gate below would decide on a settled state. Measured, that call
    // CLEARED each 400 ms debounce timer and invoked _flushDraftDbPersist IMMEDIATELY - two pending routes
    // produced two write requests - then polled every 100 ms for up to 6 s and CARRIED ON BY ITSELF once the
    // writes landed (and carried on anyway when the 6 s guard expired with a write still in the air).
    //
    // That made the button a SAVE button, and it made the guard below decide on state the button had just
    // created rather than on the state the operator was looking at when they pressed it. One click could
    // legitimately end at a confirmation for 800 units or for 1600 depending only on whether the write landed
    // in time. Submit now REFUSES a dirty plan with a typed code and touches nothing: the auto-save the
    // operator's own edit scheduled still completes on its own schedule, and the button never accelerates it,
    // flushes it, waits for it or takes it over. FB-3B's intent - that Submit can never race the write it
    // depends on - is served more strictly by refusing than it was by racing.
    //
    // §6 — ONE PREFLIGHT DECIDES, and it decides from named state rather than from a row count.
    // It covers every condition the three separate gates below used to own (a failed save, a debounced write not
    // yet sent, a write in flight, an edit that landed during a write, an unpersisted delete, an Execution panel
    // that is a shell or a named failure, a missing destination, a duplicate line identity) plus the candidate
    // set and the confirmation totals. The alert() bodies are its RENDERERS, not separate decisions.
    var _pf = (typeof _irSubmitPreflight_ === 'function') ? _irSubmitPreflight_()
        : { ok: false, code: 'PREFLIGHT_UNAVAILABLE', blocking: { skus: [], reasons: [] }, candidate: null, excluded: [] };
    if (!_pf.ok && _pf.code !== 'NO_PERSISTED_CANDIDATE') {
        if (typeof _irAlertSubmitBlocked_ === 'function') _irAlertSubmitBlocked_(_pf);
        return;   // fail CLOSED — ZERO requests, ZERO writes, and the dirty routes are left exactly as they are
    }
    // F1-7N-FB-4B-ADDENDUM §E (duplicate stored identity) and F1-7N-FB-4F-B6 §I (a planned quantity with no
    // persisted destination) are BOTH still fail-closed and both still name every offending route. They are
    // decided by the ONE preflight above and rendered by _irAlertSubmitBlocked_, so there is no second place
    // that can disagree with it about whether Submit may proceed.
    var _db = window.KM && window.KM.DB;
    var _hasSubmitApi = !!(_db && _db.submitAllocationDraftsToShippingPlans);
    var _writeEligible = !!(_db && _db.isProductionWriteEligible && _db.isProductionWriteEligible());
    if (_hasSubmitApi && _writeEligible) {
        // F1-7N-FB-4G-A2 §7 — NO IDENTITY IS MINTED BEFORE THE OPERATOR CONFIRMS. _replenSubmitExecutionKey()
        // both creates the submit execution key AND persists it, so calling it here made a Cancel leave a
        // durable identity behind for a submit that never happened. It is minted after the confirmation now.
        // F1-7N-FB-4G-A2-R1 §6 — THE SUBMITTED SELECTION IS THE PREFLIGHT'S CANDIDATE SET, and only that.
        //
        // A2 took it from _replenActiveAllocationDraftIds() instead, which collects the header of every
        // COMPLETE route and applies none of the candidate rules - no positive-quantity rule, no cancelled-line
        // rule, no terminal-lifecycle rule, no station rule. So the two owners could disagree, and when they
        // did the consequence was not a wrong count: NO_PERSISTED_CANDIDATE did not return, this list came back
        // non-empty, _pf.confirmation was null, the `if (_pf.confirmation)` guard was skipped and the request
        // WENT OUT WITH NO CONFIRMATION AT ALL over a candidate set the preflight had rejected.
        //
        // FB-4B-ADDENDUM §A.10 still holds - every header a submitted route belongs to is sent, because the
        // candidate set collects the draft id of each candidate route - and that function is kept as a
        // CROSS-CHECK: it is the wider set, so the candidate must be a subset of it. A disagreement means two
        // owners no longer agree about the selection, and that fails closed rather than picking one.
        var _draftIds = (_pf && _pf.candidate && _pf.candidate.draftIds) ? _pf.candidate.draftIds.slice() : [];
        if (!_draftIds.length) {
            if (typeof _irAlertSubmitBlocked_ === 'function') _irAlertSubmitBlocked_({ code: 'NO_PERSISTED_CANDIDATE', blocking: { skus: [], reasons: [] }, excluded: (_pf && _pf.excluded) || [] });
            else alert('No persisted allocation draft to submit yet — adjust the Execution Plan (which saves the draft) and try again.');
            return;
        }
        var _wider = {};
        try { _replenActiveAllocationDraftIds().forEach(function (id) { _wider[String(id)] = 1; }); } catch (_eW) {}
        var _notInWider = _draftIds.filter(function (id) { return !_wider[String(id)]; });
        if (_notInWider.length) {
            alert('Cannot Submit Plan \u2014 SELECTION_DISAGREEMENT.' + NL2 +
                'The preflight proposes allocation draft(s) the route collector does not: ' + _notInWider.join(', ') + '.' + NL2 +
                'Nothing was submitted and nothing was written. Reload the page and try again.');
            return;   // fail CLOSED — two owners disagreeing about the selection is never resolved by choosing one
        }
        // F1-7N-FB-3B §G steps 2-3 — READ THE PERSISTED ROUTES BACK AND VERIFY THE USER-EDITED QUANTITIES before
        // committing. A PROVEN drift between the screen and the database blocks the Submit: committing would ship
        // the older stored quantity while the operator is looking at the newer one. An inconclusive read never
        // blocks and is never reported as a verification (see _irVerifyPersistedRouteQuantities_).
        var _qv = { verdict: 'UNVERIFIABLE', drifted: [] };
        try { _qv = await _irVerifyPersistedRouteQuantities_((typeof _irAppliedSubmitScope_ === 'function') ? _irAppliedSubmitScope_() : null); } catch (_eV) {}
        if (_qv.verdict === 'CORRUPTED') {
            alert('Cannot Submit Plan — the database holds duplicate rows under one Execution Plan line identity.' + NL2 +
                (_qv.duplicates || []).slice(0, 8).map(function (d) { return '  · ' + d.sku + ' — ' + d.allocation_draft_line_id + ' names ' + d.physical_rows + ' physical rows'; }).join(String.fromCharCode(10)) + NL2 +
                'Nothing was submitted and nothing was written or deleted. Run the duplicate cleanup first.');
            return;   // fail CLOSED
        }
        if (_qv.verdict === 'ROUTES_MISSING') {
            alert('Cannot Submit Plan — ' + _qv.route_count.on_screen + ' route(s) are on screen but only ' +
                _qv.route_count.in_database + ' are stored in the database.' + NL2 +
                'On screen: ' + _qv.total_quantity.on_screen + ' unit(s); in database: ' + _qv.total_quantity.in_database + ' unit(s).' + NL2 +
                'Submit only ever commits persisted routes, so the missing one would be silently absent from the ' +
                'plan. Nothing was submitted and nothing was written. Re-save the missing route, then Submit again.');
            return;   // fail CLOSED
        }
        if (_qv.verdict === 'DRIFTED') {
            alert('Cannot Submit Plan — the saved quantities do not match what is on screen.' + NL2 +
                _qv.drifted.slice(0, 8).map(function (d) { return '  · ' + d.sku + ' — on screen ' + d.on_screen + ', in database ' + d.in_database; }).join(String.fromCharCode(10)) + NL2 +
                'Nothing was submitted and nothing was written. Re-enter the quantity so it saves, then Submit again.');
            return;   // fail CLOSED — never commit the older stored quantity
        }
        // §5/§7 — THE CONFIRMATION IS BUILT HERE, after the persisted read-back and the quantity verification,
        // from the PERSISTED candidate set and from nothing else (never the DOM). A2 built it inside the
        // preflight, BEFORE the read-back had run, and skipped it entirely whenever it came back null - so the
        // one step that cannot be skipped was guarded by `if (it exists)`. It is now REQUIRED: no confirmation
        // object means no submit. It carries the read-back's own verdict verbatim, so an inconclusive read is
        // shown as inconclusive rather than presented as a verification that happened.
        var _conf = window.IRSubmitPreflight ? window.IRSubmitPreflight.buildConfirmation(_pf, _qv) : null;
        if (!_conf) {
            alert('Cannot Submit Plan \u2014 CONFIRMATION_NOT_AVAILABLE.' + NL2 +
                'The persisted candidate set could not be confirmed, so nothing was submitted and nothing was ' +
                'written. Reload the page and try again.');
            return;   // fail CLOSED — an unconfirmable submit is never an unconfirmed submit
        }
        if (!_irConfirmSubmit_(_conf)) return;   // Cancel → nothing sent, nothing minted, nothing lost
        var submitExecutionKey = _replenSubmitExecutionKey();   // minted ONLY after an explicit confirmation
        _replenCanonicalSubmit(_draftIds, submitExecutionKey, _conf.lineCount);
        return;
    }

    // The local branch below is DEVELOPMENT-ONLY and is unreachable from the production build: it requires both
    // a local dev host AND an explicit human opt-in (window.KM_DEV_LOCAL_MODE === true). Anywhere else, an
    // ineligible write fails closed with an actionable error and writes nothing at all — no sessionStorage
    // record, no success alert, no navigation that would imply a plan exists.
    if (!(_db && _db.isDevLocalModeAllowed && _db.isDevLocalModeAllowed())) {
        var _why = !_hasSubmitApi ? 'SUBMIT_API_UNAVAILABLE' : 'API_NOT_CONFIGURED';
        var _msg = (_db && _db.describeWriteFailure)
            ? _db.describeWriteFailure('submitAllocationDraftsToShippingPlans', { code: _why, zero_write: true,
                message: 'The Operation DB API is not available to this page, so the plan cannot be persisted.' })
            : ('Could not submit — the Operation DB API is unavailable. Nothing was written. Reason: ' + _why);
        alert(_msg);
        return;   // fail CLOSED — no local plan, no success notification, no navigation
    }

    // DEVELOPMENT-ONLY fallback (local host + explicit opt-in): sessionStorage so local navigation works.
    var allPlans = [];
    var existingData = sessionStorage.getItem('allShippingPlans');
    if (existingData) { allPlans = JSON.parse(existingData); }
    var newPlan = {
        id: Date.now(),
        date: new Date().toISOString().split('T')[0],
        country: country,
        marketplace: marketplace,
        targetDays: targetDays,
        plans: shippingPlans,
        status: {},
        notes: {}
    };
    Object.keys(shippingPlans).forEach(function(method) {
        newPlan.status[method] = 'draft';
        newPlan.notes[method] = [];
    });
    allPlans.push(newPlan);
    sessionStorage.setItem('allShippingPlans', JSON.stringify(allPlans));
    // Demo fallback success → also clear the Working Draft (kept separate from the demo store).
    _clearAllocationDraft();
    alert('[DEV LOCAL MODE] Nothing was saved to the database.\n\nThis is a local browser-only record for development navigation.\nTotal SKUs: ' + totalSkus + '\nMethods: ' + Object.keys(shippingPlans).length);
    showSection('shippingplan');
    setTimeout(function() { renderShippingPlan(); }, 100);
}

window.renderReplenishment = renderReplenishment;
window.toggleReplenRow = toggleReplenRow;
window.updatePlannedQty = updatePlannedQty;
window.updateShippingMethod = updateShippingMethod;
window.updateGlobalShippingMethod = updateGlobalShippingMethod;
window.updateReplenNote = updateReplenNote;
window.createPlan = createPlan;
window.submitReplenishmentPlans = submitReplenishmentPlans;

function openShippingAllocation(event, sku) {
    event.stopPropagation();
    const fixedRows = document.querySelectorAll('#ops-section .fixed-row');
    const targetRow = Array.from(fixedRows).find(row => row.dataset.sku === sku);
    
    if (targetRow && targetRow.classList.contains('expanded')) {
        toggleReplenRow(sku);
    } else {
        if (!targetRow || !targetRow.classList.contains('expanded')) {
            toggleReplenRow(sku);
        }
        setTimeout(() => {
            const execCard = document.getElementById(`execution-plan-${sku}`);
            if (execCard) {
                execCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 100);
    }
}

function openAISuggestion(event, sku) {
    event.stopPropagation();
    const fixedRows = document.querySelectorAll('#ops-section .fixed-row');
    const targetRow = Array.from(fixedRows).find(row => row.dataset.sku === sku);
    if (!targetRow || !targetRow.classList.contains('expanded')) {
        toggleReplenRow(sku);
    }
    // Scroll to the Recommendation Summary (system suggestion) block.
    setTimeout(() => {
        const recCard = document.getElementById(`recommendation-summary-${sku}`);
        if (recCard) recCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

// ============================================================================
// Shipping Allocation Working Draft (Temporary Decision — NOT a Decision Snapshot)
// Lives only inside Inventory Replenishment before Submit Plan. JS State is the live
// editing state; sessionStorage is temporary recovery only. It NEVER writes shipping_plans
// or updates Weekly Shipping Plan — only Submit Plan (Decision Commit) does that.
// See SUPPLY_CHAIN_ARCHITECTURE_PRINCIPLES.md (Working Draft Principle) +
//     WEEKLY_SHIPPING_PLAN_MAPPING_SPEC.md (Shipping Allocation Working Draft).
// ============================================================================
var REPLEN_ALLOC_DRAFT_KEY = 'km_replen_alloc_draft_v1';
var replenAllocationDraft = { context: { company: '', country: '', marketplace: '' }, targetDays: '', bySku: {} };
if (!window.KM) window.KM = {};
window.KM.shippingAllocationDraft = replenAllocationDraft;

function _replenCtx() {
    // Company + marketplace NAME are derived from the selected marketplace_id (no Company select); this
    // keeps the allocation-draft context keyed on stable, human-meaningful scope values (not the raw id).
    var s = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : { company: '', country: '', marketplace: '' };
    return { company: s.company, country: s.country, marketplace: s.marketplace };
}
function _replenCtxEq(a, b) {
    return !!a && !!b && a.company === b.company && a.country === b.country && a.marketplace === b.marketplace;
}
function _persistAllocationDraft() {
    // sessionStorage is a UI RECOVERY CACHE only — NOT the Draft SSOT (Round 4 Decision E). F1-7N-FB-2A §D:
    // the cache now carries the UNSAVED marks alongside the typed values, so restoring it after a reload
    // re-establishes "this route was never persisted" instead of promoting a failed write into canonical
    // state. The values are kept ONLY so the user can correct and retry them.
    try {
        var snapshot = {};
        for (var k in replenAllocationDraft) { if (Object.prototype.hasOwnProperty.call(replenAllocationDraft, k)) snapshot[k] = replenAllocationDraft[k]; }
        snapshot._unsavedRoutes = (typeof _irUnsavedRoutes === 'object' && _irUnsavedRoutes) ? _irUnsavedRoutes : {};
        sessionStorage.setItem(REPLEN_ALLOC_DRAFT_KEY, JSON.stringify(snapshot));
    } catch (e) {}
}
// ============================================================================
// F1-7N-FB-2A §D — NO LOCAL PERSISTENCE FALLBACK FOR A BUSINESS WRITE.
// ----------------------------------------------------------------------------
// The production screenshot said "Could not save to the database — kept locally", which is a false
// persistence claim: the route lived on only in the sessionStorage recovery cache, was restored on reload as
// though it were canonical, and Submit Plan read that same in-memory Working Draft. The frozen rule now is:
//   • a failed write is NEVER represented as Saved;
//   • the typed values STAY VISIBLE so the user can correct and retry — labelled `Unsaved — database update
//     failed`, never silently;
//   • the sessionStorage cache carries the UNSAVED marks with it, so a reload cannot promote a failed write
//     into canonical state;
//   • Submit Plan FAILS CLOSED while any route is unsaved;
//   • Saved requires a backend acknowledgement carrying the persisted primary key AND its
//     persisted/reused classification (created|updated) — never a bare success flag;
//   • retry reuses the SAME idempotency identity (the deterministic allocation_draft_id / line id the
//     handler assigns), so a retry updates the same row instead of inserting a duplicate.
var _irUnsavedRoutes = {};   // sku -> { code, message, table, requestId, retryable, nextAction, at }
function _irMarkRouteUnsaved_(sku, err) {
    var s = (err && err.structured) || {};
    _irUnsavedRoutes[String(sku)] = {
        code: String(s.code || 'SAVE_FAILED'),
        message: String(s.message || (err && err.message) || 'save failed'),
        table: String(s.table || ''),
        requestId: String(s.requestId || ''),
        retryable: s.retryable !== false,
        nextAction: String(s.nextAction || ''),
        at: String(s.at || '')
    };
    _persistAllocationDraft();   // carries the UNSAVED marks — see _persistAllocationDraft
    _irRenderUnsavedBanner_();
}
function _irClearRouteUnsaved_(sku) {
    if (_irUnsavedRoutes[String(sku)]) { delete _irUnsavedRoutes[String(sku)]; _persistAllocationDraft(); _irRenderUnsavedBanner_(); }
}
function _irUnsavedSkus_() { return Object.keys(_irUnsavedRoutes); }
function _irHasUnsavedRoutes_() { return _irUnsavedSkus_().length > 0; }
// A backend save counts as PERSISTED only with the primary key AND the insert/update classification.
//
// F1-7N-FB-4G-A2-R3-R1 §F3 — THE ATOMIC ENVELOPE CLASSIFIES ITSELF, AND IT DOES NOT USE BOOLEANS.
//
// This used to read `created === true || updated === true` and nothing else. That is the two-call HEADER
// writer's contract, where both really are booleans. The ATOMIC writer — which A2-R3 made the only path a
// route ticket is written by — reuses those two names for the LINE COUNTS it wrote (`var created = 0,
// updated = 0` … `updated++`), so a perfectly good single-line UPDATE answers `created: 0, updated: 1` and
// `1 === true` is false. EVERY atomic write was therefore unacknowledgeable: the row was written, the client
// called it PERSISTENCE_NOT_ACKNOWLEDGED, the operator was shown OUTCOME UNKNOWN, and — because only the
// acknowledged path stamps ids and the new draft_version — the NEXT save of that route was refused
// STALE_OPTIMISTIC_TOKEN for ever. That is the production failure this round was opened for.
//
// The atomic envelope already states its own outcome unambiguously in two places, so those are read first and
// the ambiguous pair is never consulted on that path.
function _irSaveAcknowledged_(res) {
    if (!res || res.success === false) return null;
    var d = res.data || {};
    var pk = String(d.allocation_draft_id == null ? '' : d.allocation_draft_id).trim();
    if (!pk) return null;
    // (1) the atomic envelope's own header classification — a boolean the writer sets from newHeaderCreated.
    if (d.header_created === true) return { allocation_draft_id: pk, classification: 'created' };
    if (d.header_updated === true) return { allocation_draft_id: pk, classification: 'updated' };
    // (2) the outcome token, which every atomic answer carries (CREATED / REGENERATED / UPDATED / REUSED /
    //     CREATE_REPLAYED). A replay is a SUCCESS: an earlier attempt of this same click already committed.
    var outcome = String(d.outcome == null ? '' : d.outcome).trim().toUpperCase();
    if (outcome === 'CREATED') return { allocation_draft_id: pk, classification: 'created' };
    if (outcome === 'CREATE_REPLAYED') return { allocation_draft_id: pk, classification: 'created' };
    if (outcome === 'REGENERATED' || outcome === 'UPDATED' || outcome === 'REUSED') return { allocation_draft_id: pk, classification: 'updated' };
    // (3) the persisted-header record's resolution, for an answer that carried neither of the above.
    var ph = (d.persisted_headers && d.persisted_headers[0]) || null;
    var resn = ph ? String(ph.resolution || '').trim().toUpperCase() : '';
    if (resn === 'CREATED') return { allocation_draft_id: pk, classification: 'created' };
    if (resn === 'UPDATED' || resn === 'REUSED') return { allocation_draft_id: pk, classification: 'updated' };
    // (4) the two-call header writer's boolean contract, unchanged.
    var created = d.created === true, updated = d.updated === true;
    if (!created && !updated) return null;   // no persisted/reused classification -> NOT proven persisted
    return { allocation_draft_id: pk, classification: created ? 'created' : 'updated' };
}
function _irRenderUnsavedBanner_() {
    var host = _irStateHost_(); if (!host) return;
    var skus = _irUnsavedSkus_();
    var existing = host.querySelector('.replen-unsaved-banner');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!skus.length) { if (!host.innerHTML) { host.style.display = 'none'; } return; }
    var html = '<div class="replen-unsaved-banner" role="alert" style="background:#FEF2F2;border-left:3px solid #EF4444;color:#B91C1C;padding:8px 10px;margin:0 0 8px;font-size:12px;">' +
        '<strong>Unsaved — database update failed.</strong> ' + _irEsc_(String(skus.length)) +
        ' Execution Plan route(s) were NOT saved: ' + _irEsc_(skus.join(', ')) +
        '. They are kept on screen so you can correct and retry them. Submit Plan is blocked until every route is saved.' +
        '</div>';
    host.insertAdjacentHTML('afterbegin', html);
    host.style.display = '';
}

// ================================================================================================================
// F1-7N-FB-4B-ADDENDUM §E — DUPLICATE CORRUPTION IS DISCLOSED AND FAILS SUBMIT CLOSED.
// ----------------------------------------------------------------------------------------------------------------
// The writer can no longer create a second physical row under one primary key, but rows created BEFORE that fix
// are still in the database (the three live SADL-K2-16F4E4F9 rows). Two rules apply while they remain:
//   · the read path renders ONE row per primary key, so three 800-unit rows never display as 2400; and
//   · the page says so plainly and Submit refuses the affected SKU, because committing a plan built on an
//     ambiguous identity would carry the corruption into a durable shipping plan.
// This is disclosure only. It never deletes, merges or rewrites a row — the cleanup stays a separate, gated,
// user-authorized operation.
function _irDuplicateLineIdentities_() {
    try { return (replenAllocationDraft && replenAllocationDraft.duplicateLineIdentities) || []; } catch (e) { return []; }
}
function _irHasDuplicateCorruption_() { return _irDuplicateLineIdentities_().length > 0; }
function _irDuplicateCorruptedSkus_() {
    var seen = {}, out = [];
    _irDuplicateLineIdentities_().forEach(function (d) {
        var k = String(d.sku || '').trim();
        if (k && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
}
function _irRenderDuplicateCorruptionBanner_() {
    var host = _irStateHost_(); if (!host) return;
    var existing = host.querySelector('.replen-dupe-banner');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var dupes = _irDuplicateLineIdentities_();
    if (!dupes.length) { if (!host.innerHTML) { host.style.display = 'none'; } return; }
    var skus = _irDuplicateCorruptedSkus_();
    var rows = dupes.slice(0, 6).map(function (d) {
        return _irEsc_(String(d.sku || '')) + ' — ' + _irEsc_(String(d.allocation_draft_line_id || '')) +
            ' names ' + _irEsc_(String(d.physical_rows)) + ' physical rows';
    }).join('<br>');
    var html = '<div class="replen-dupe-banner" role="alert" style="background:#FFF7ED;border-left:3px solid #EA580C;color:#9A3412;padding:8px 10px;margin:0 0 8px;font-size:12px;">' +
        '<strong>Duplicate plan rows found in the database.</strong> ' +
        _irEsc_(String(dupes.length)) + ' Execution Plan line identit' + (dupes.length === 1 ? 'y names' : 'ies name') +
        ' more than one stored row:<br>' + rows +
        '<br>Only one row per identity is shown, so the quantities above are NOT inflated. ' +
        'Submit Plan is blocked for ' + _irEsc_(skus.join(', ')) +
        ' until the duplicates are cleaned up. Nothing has been deleted or changed.' +
        '</div>';
    host.insertAdjacentHTML('afterbegin', html);
    host.style.display = '';
}
window._irDuplicateLineIdentities_ = _irDuplicateLineIdentities_;
window._irHasDuplicateCorruption_ = _irHasDuplicateCorruption_;
window._irDuplicateCorruptedSkus_ = _irDuplicateCorruptedSkus_;
window._irRenderDuplicateCorruptionBanner_ = _irRenderDuplicateCorruptionBanner_;
window._irUnsavedRoutes_ = function () { return _irUnsavedRoutes; };
window._irHasUnsavedRoutes_ = _irHasUnsavedRoutes_;
window._irSaveAcknowledged_ = _irSaveAcknowledged_;

// ── Draft DB persistence (Round 4 Decision E + System Repair 2 Part A) ───────────────────────────────
// SSOT = shipping_allocation_drafts / _lines. A working-draft route is persisted ONLY when it is a
// COMPLETE Execution Plan line (From + To + Qty>0 + Method — the single shared IRDraft.isRouteComplete
// gate, §4/§7); an incomplete route stays frontend-only and NEVER reaches the DB (§20). Persistence is
// incremental upsert-by-line-id (never a blanket REPLACE): each complete route carries a STABLE
// allocation_draft_line_id so repeated edits UPDATE the same line instead of inserting duplicates
// (§6/§13). A user edit sends planned_qty + selected_* only; recommended_qty is sent ONLY for a
// system-generated line (protects the immutable snapshot). Amazon logical destination persists as
// selected_destination_warehouse_id=null. The header is upserted ONLY when ≥1 complete line exists —
// never an empty header (§20); when the last valid line is gone the header is soft-cancelled (§5.3).
// BROWSER/LIVE-DB-UNVERIFIED: when the API is not configured (headless), the adapter no-ops and the
// sessionStorage recovery cache remains — behaviour is unchanged until deployed.

// Shared completeness predicate (single source — §7). Prefer the pure IRDraft implementation so the
// frontend gate and the Node unit tests exercise the exact same logic; keep a tiny inline fallback so
// the page still gates correctly if the shared module failed to load.
function _isRouteComplete(route) {
    if (window.IRDraft && typeof window.IRDraft.isRouteComplete === 'function') return window.IRDraft.isRouteComplete(route);
    route = route || {};
    // F1-7N-FB-4G-A0-R2 — the fallback copy of the rule, and it had the same `toReal || logical` a route
    // carrying BOTH destinations passed. It is only reached when IRWarehouse/IRDraft are unavailable, which is
    // precisely when a divergence would go unnoticed, so it applies the identical XOR: exactly one canonical
    // destination, and a snapshot/label/scope is never one of them.
    var from = String(route.source_warehouse_id == null ? '' : route.source_warehouse_id).trim();
    var toReal = String(route.destination_warehouse_id == null ? '' : route.destination_warehouse_id).trim();
    var mkt = String(route.destination_marketplace == null ? '' : route.destination_marketplace).trim();
    var hasTo = (window.IRWarehouse && typeof window.IRWarehouse.destinationIdentity === 'function')
        ? window.IRWarehouse.destinationIdentity(route).ok
        : ((!!toReal) !== (!!mkt));
    var qty = Number(route.planned_qty != null ? route.planned_qty : route.qty); if (!isFinite(qty)) qty = 0;
    var method = String(route.shipping_method == null ? '' : route.shipping_method).trim();
    return !!from && hasTo && qty > 0 && !!method && method.toLowerCase().indexOf('no available') === -1;
}
window._isRouteComplete = _isRouteComplete;

// Stable client-side draft line id (§6): assigned when a route first becomes COMPLETE so every later
// edit upserts the SAME shipping_allocation_draft_lines row (idempotent — no duplicate lines). Survives
// reload because the DB stores the row under this id and _hydrateAllocationDraftFromDb reads it back.
// F1-7N-FB-4B §B — THIS IS A LOCAL PLACEHOLDER, NOT AN IDENTITY. The server owns line identity: under a K2 draft
// it mints the canonical SADL-K2-<hash of sku|site_sku|window_code> and IGNORES whatever id arrives. Treating this
// random value as a durable id is precisely what produced three physical rows under one primary key: the page kept
// sending an id the database never stored, the server never found it, fell into its INSERT branch, minted the same
// canonical id again and appended. _irAdoptPersistedLineIds_ below now replaces this placeholder with the id the
// server reports it actually persisted, so the second save UPDATES instead of appending.
function _newDraftLineId() {
    var rnd = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return 'SADL-LOCAL-' + rnd.slice(0, 10);
}

// F1-7N-FB-4B §B — adopt the ids the SERVER reports it persisted. Matching is by the canonical business identity
// (sku + site_sku + window_code) — the exact key the server resolves on — never by array position.
//
// BOTH stores must be updated. The draft model is what _flushDraftDbPersist reads, but a row's id is re-collected
// from the DOM attribute (data-line-id) on the next edit, so leaving the attribute stale would put the placeholder
// straight back and reopen the append loop this fixes.
//
// F1-7N-FB-4B-ADDENDUM §D.9 — SCOPED TO ONE HEADER. The business identity (sku + site_sku + window_code) is
// IDENTICAL for Route A and Route B of one SKU, because route is a HEADER dimension and deliberately not part of
// line identity. Matching on identity alone across a multi-route save would therefore hand Route B's persisted id
// to Route A's row and the next save would rewrite the wrong header's line. The draft id is the discriminator, so
// only rows already bound to THIS header are eligible.
// F1-7N-FB-4D §B4 — the header group is now a VERIFIED parameter, not an assumption. `wantGroupKey` is the
// route group this call asked about; 16_ stamps the group key it actually stored onto every persisted line. A
// line whose stored group key disagrees is NOT adopted: it describes a row under a different shipment group,
// and adopting it is precisely how Route A ends up holding Route B's identity. A server that sends no group key
// (an older deployment) is tolerated — the draft-id scope still applies — so this stays deploy-order-safe.
function _irAdoptPersistedLineIds_(sku, draftId, persistedLines, wantGroupKey) {
    if (!persistedLines || !persistedLines.length) return 0;
    var wantDraft = String(draftId == null ? '' : draftId).trim();
    var wantGroup = String(wantGroupKey == null ? '' : wantGroupKey).trim();
    var rows = ((replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || []).filter(function (r) {
        return !wantDraft || String(r.allocation_draft_id || '').trim() === wantDraft;
    });
    function k(o) {
        return [String(o.sku == null ? '' : o.sku).trim().toLowerCase(),
            String(o.site_sku == null ? '' : o.site_sku).trim().toLowerCase(),
            String(o.window_code == null ? '' : o.window_code).trim().toLowerCase()].join('|');
    }
    var byKey = {};
    persistedLines.forEach(function (p) {
        if (String(p.line_status || '').trim().toLowerCase() === 'cancelled') return;
        // §B4 — cross-header adoption guard. Both keys are compared only when BOTH sides carry one.
        var pDraft = String((p && p.allocation_draft_id) || '').trim();
        if (wantDraft && pDraft && pDraft !== wantDraft) return;
        var pGroup = String((p && p.route_group_key) || '').trim();
        if (wantGroup && pGroup && pGroup !== wantGroup) return;
        var id = String(p.allocation_draft_line_id || '').trim();
        if (id) byKey[k(p)] = id;
    });
    var adopted = 0;
    rows.forEach(function (r) {
        var canonical = byKey[k(r)];
        if (!canonical) return;
        var previous = String(r.allocation_draft_line_id || '');
        if (previous === canonical) return;
        // re-stamp the DOM row that still carries the placeholder, so the next collect reads the canonical id
        if (previous) {
            try {
                var els = document.querySelectorAll('[data-line-id]');
                for (var i = 0; i < els.length; i++) {
                    if (els[i].getAttribute('data-line-id') === previous) { els[i].setAttribute('data-line-id', canonical); break; }
                }
            } catch (e) {}
        }
        r.allocation_draft_line_id = canonical;
        adopted++;
    });
    if (adopted) { try { _persistAllocationDraft(); } catch (e3) {} }
    return adopted;
}

// F1-7N-FA-3C-R6E1-R1 — STABLE Submit execution key (idempotency). ONE key per Submit intention: generated once,
// stored on the working draft (so a re-render / navigation NEVER mints a new one for the same pending plan), reused
// verbatim on a retry after a failure, and dropped only when a Decision Commit is confirmed (_clearAllocationDraft
// rebuilds the draft object). The backend (handleCreateShippingPlansBatch_) treats this as submit_batch_id and does
// find-or-reuse under a ScriptLock: same key + equivalent payload → REUSED (zero writes); different payload →
// SUBMIT_EXECUTION_DUPLICATE_CONFLICT. Mirrors the existing stable-id pattern (_newDraftLineId).
function _newSubmitExecutionKey() {
    var rnd = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return 'SB-' + rnd.slice(0, 12);
}
function _replenSubmitExecutionKey() {
    if (!replenAllocationDraft.submitExecutionKey) {
        replenAllocationDraft.submitExecutionKey = _newSubmitExecutionKey();
        try { _persistAllocationDraft(); } catch (e) {}
    }
    return replenAllocationDraft.submitExecutionKey;
}
window._newSubmitExecutionKey = _newSubmitExecutionKey;

// F1-7N-FA-4B — the selected allocation_draft_id(s) for the canonical Submit. The manual Execution-Plan path persists
// ONE active draft header per scope (replenAllocationDraft.allocationDraftId); K2 generation may create several. Returns
// a de-duplicated, non-blank id list — the ONLY submit selection the frontend sends (never authored plan lines).
function _replenActiveAllocationDraftIds() {
    var ids = [];
    // F1-7N-FB-4B-ADDENDUM §A.10 — Submit must send EVERY header the applied station's persisted routes belong to.
    // One SKU with two routes is two headers, and selecting only the last one written would submit half the plan.
    try {
        var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
        Object.keys(bySku).forEach(function (sku) {
            (bySku[sku] || []).forEach(function (r) {
                if (!_isRouteComplete(r)) return;
                var id = String(r.allocation_draft_id || '').trim();
                if (id) ids.push(id);
            });
        });
    } catch (e0) {}
    // F1-7N-FB-4F-B6 §I — A HEADER WITH NO QUANTITY-BEARING ROUTE IS NEVER SENT TO SUBMIT.
    //
    // These two fallbacks used to add EVERY header the hydrate had seen for the station, including active ones
    // holding zero lines. That is not a harmless extra id: sadSubmitToShippingPlansCore_ validates every
    // requested draft and a header with no lines fails gate (3) NO_LINES — and one failure fails the WHOLE
    // batch with SUBMIT_VALIDATION_FAILED and zero writes. Two empty legacy headers in a station therefore made
    // Submit permanently impossible for every REAL route beside them, and §J forbids deleting those headers to
    // get out of it. The loop above already collects the header of every complete route, which is exactly the
    // set the server can accept, so the fallbacks are restricted to ids that set already contains rather than
    // being removed (they still guard against a route that lost its binding mid-edit).
    var fromRoutes = {}; ids.forEach(function (id) { fromRoutes[id] = 1; });
    try { var pId = String((replenAllocationDraft && replenAllocationDraft.allocationDraftId) || '').trim(); if (pId && fromRoutes[pId]) ids.push(pId); } catch (e) {}
    try { if (replenAllocationDraft && replenAllocationDraft.allocationDraftIds && replenAllocationDraft.allocationDraftIds.length) replenAllocationDraft.allocationDraftIds.forEach(function (x) { var t = String(x || '').trim(); if (t && fromRoutes[t]) ids.push(t); }); } catch (e2) {}
    var seen = {}, out = []; ids.forEach(function (id) { if (id && !seen[id]) { seen[id] = 1; out.push(id); } }); return out;
}
window._replenActiveAllocationDraftIds = _replenActiveAllocationDraftIds;

// ============================================================================================================
// F1-7N-FB-3B §G — SITE INVENTORY STATION SCOPE + PRE-SUBMIT READ-AFTER-WRITE VERIFICATION.
// ------------------------------------------------------------------------------------------------------------
// Site Inventory is DELIBERATELY the opposite of Request Order Send. Send Request is comprehensive across every
// country and marketplace by frozen business rule; Submit Plan commits EXACTLY ONE station — the currently
// APPLIED Country + Marketplace — and must reject anything else.
//
// WHY THE APPLIED SCOPE, NOT THE LIVE SELECTS. _replenSelectedScope() reads the <select> elements, which the user
// may have changed AFTER the last successful Search. Those newer values describe a station whose rows are not on
// screen. The APPLIED scope (_irSearch.applied — the single place the search gate ever assigns) is the station
// the visible plan actually belongs to, so that is what is declared to the server. A divergence between the two
// is precisely the "stale selector" case, and the server now names it (APPLIED_SCOPE_MISMATCH) instead of
// writing to whichever station the draft ids happened to carry.
function _irAppliedSubmitScope_() {
    var applied = (typeof _irSearch !== 'undefined' && _irSearch && _irSearch.applied) ? _irSearch.applied : null;
    if (!applied) return null;
    var list = [];
    try { list = _irWsGet('getMarketplaces') || []; } catch (e) { list = []; }
    var rec = null;
    for (var i = 0; i < list.length; i++) { if (String(list[i].marketplaceId) === String(applied.marketplaceId)) { rec = list[i]; break; } }
    return { company: (rec && rec.company) || '', country: (rec && rec.country) || applied.country || '',
        marketplace: (rec && rec.marketplace) || '', marketplaceId: String(applied.marketplaceId || '') };
}
window._irAppliedSubmitScope_ = _irAppliedSubmitScope_;

// F1-7N-FB-4G-A2-R1 §6 — _irFlushPendingRouteWritesForSubmit_ IS GONE, not merely unused.
//
// It cleared every pending 400 ms debounce timer, called _flushDraftDbPersist immediately, awaited the writes
// and then polled _draftDbInFlight for up to 6 s before returning to the Submit chain, which continued on its
// own. Submit had exactly ONE caller of it and no other flow used it. A helper named "flush pending route
// writes FOR SUBMIT" that Submit must never call is a trap for the next reader, so it is removed rather than
// left behind: the only thing Submit is allowed to do about a pending write now is REFUSE, and the state it
// refuses on is reported by _irSubmitStateSnapshot_.

// §G — PRE-SUBMIT READ-AFTER-WRITE VERIFICATION of the user-edited planned quantities.
// Reads the persisted draft back through the EXISTING targeted read-back (getShippingAllocationDraftWorkspace —
// never a whole-DB reload) and compares each persisted planned_qty against the value on screen, keyed by the
// stable allocation_draft_line_id the client owns.
//
// AI Suggested Qty is NEVER a source here: the comparison reads the user-owned planned_qty only, so a later
// user-edited planned quantity can never be overwritten or out-voted by a recommendation value.
//
// THE ONE RULE THAT MATTERS: an inconclusive read is NOT a verification, and it is NOT a failure either. It
// returns UNVERIFIABLE and Submit proceeds — the server re-reads the persisted drafts anyway and the
// unsaved-route gate has already run. What is NEVER allowed is claiming a verification that did not happen, or
// blocking a legitimate Submit because a diagnostic read was unavailable. A PROVEN drift blocks.
async function _irVerifyPersistedRouteQuantities_(appliedScope) {
    var out = { verdict: 'UNVERIFIABLE', checked: 0, drifted: [], reason: '' };
    var db = window.KM && window.KM.DB;
    if (!db || typeof db.getShippingAllocationDraftWorkspace !== 'function') { out.reason = 'READBACK_API_UNAVAILABLE'; return out; }
    if (!appliedScope || !appliedScope.country) { out.reason = 'NO_APPLIED_SCOPE'; return out; }
    var res;
    try {
        res = await db.getShippingAllocationDraftWorkspace({ company: appliedScope.company, country: appliedScope.country,
            marketplace: appliedScope.marketplace, source_page: 'inventory_replenishment' });
    } catch (e) { out.reason = 'READBACK_FAILED'; return out; }
    var data = (res && res.data) || {};
    // F1-7N-FB-4B-ADDENDUM — a station holding several shipment groups reads back as ACTIVE_DRAFT_GROUP_FOUND.
    // That is the normal multi-route state, not an inconclusive read, and its `lines` span every header.
    if (!res || res.success === false || (data.status !== 'ACTIVE_DRAFT_FOUND' && data.status !== 'ACTIVE_DRAFT_GROUP_FOUND')) { out.reason = 'READBACK_' + String(data.status || 'INCONCLUSIVE'); return out; }
    // §E — a proven duplicate identity blocks Submit outright. This is a PROVEN corruption, not an inconclusive
    // read, so unlike a failed diagnostic it is allowed to stop the commit.
    var dupes = data.duplicate_line_identities || [];
    if (dupes.length) {
        out.verdict = 'CORRUPTED';
        out.duplicates = dupes;
        out.reason = 'DUPLICATE_LINE_IDENTITY_PERSISTED';
        return out;
    }
    out.draft_count = data.draft_count || (data.drafts ? data.drafts.length : 1);
    var persisted = {};
    (data.lines || []).forEach(function (l) {
        var id = String((l && l.allocation_draft_line_id) || '').trim();
        if (!id) return;
        if (String((l && l.line_status) || '').trim().toLowerCase() === 'cancelled') return;
        persisted[id] = Number(l.planned_qty);
    });
    if (!Object.keys(persisted).length) { out.reason = 'READBACK_NO_LINES'; return out; }
    var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
    Object.keys(bySku).forEach(function (sku) {
        (bySku[sku] || []).forEach(function (r) {
            if (!_isRouteComplete(r)) return;
            var id = String(r.allocation_draft_line_id || '').trim();
            if (!id || !(id in persisted)) return;   // not part of this persisted draft — not evidence of drift
            var onScreen = Number(r.planned_qty != null ? r.planned_qty : r.qty);
            out.checked++;
            if (Number(persisted[id]) !== onScreen) {
                out.drifted.push({ sku: sku, allocation_draft_line_id: id, on_screen: onScreen, in_database: Number(persisted[id]) });
            }
        });
    });
    // §D.10 — route count and total quantity, so a MISSING route is caught as well as a wrong one. A per-line
    // comparison alone can pass while an entire route silently failed to persist.
    var onScreenRoutes = 0, onScreenTotal = 0;
    Object.keys(bySku).forEach(function (sku) {
        (bySku[sku] || []).forEach(function (r) {
            if (!_isRouteComplete(r)) return;
            onScreenRoutes++; onScreenTotal += Number(r.planned_qty != null ? r.planned_qty : r.qty) || 0;
        });
    });
    var dbRoutes = 0, dbTotal = 0;
    Object.keys(persisted).forEach(function (id) { dbRoutes++; dbTotal += Number(persisted[id]) || 0; });
    out.route_count = { on_screen: onScreenRoutes, in_database: dbRoutes };
    out.total_quantity = { on_screen: onScreenTotal, in_database: dbTotal };
    if (onScreenRoutes > dbRoutes) {
        out.verdict = 'ROUTES_MISSING';
        out.reason = 'ROUTE_COUNT_MISMATCH';
        return out;
    }
    out.verdict = out.drifted.length ? 'DRIFTED' : (out.checked ? 'VERIFIED' : 'UNVERIFIABLE');
    if (!out.checked) out.reason = 'NO_MATCHED_LINES';
    return out;
}
window._irVerifyPersistedRouteQuantities_ = _irVerifyPersistedRouteQuantities_;

// F1-7N-FA-4B — SINGLE-FLIGHT canonical Submit. One in-flight Promise per execution key: a second click while a Submit
// is in flight for the SAME key SHARES that Promise (no second mutation). Button disabled on first click, restored only
// on a terminal response. CREATED/REUSED → clear draft + show the plan. CONFLICT → require refresh/review (keep draft).
// IN_PROGRESS_SAME_EXECUTION_KEY → show Processing + begin readback (never a blind retry). The execution key is stable
// across navigation/re-entry (persisted on replenAllocationDraft).
var NL2 = String.fromCharCode(10) + String.fromCharCode(10);   // paragraph break inside an alert()
var _replenSubmitInFlight = {};   // execKey -> Promise (the single in-flight mutation)
function _replenSetSubmitButtonDisabled(disabled) {
    try { var b = document.querySelector('[onclick*="submitReplenishmentPlans"]') || document.getElementById('replen-submit-plan-btn'); if (b) b.disabled = !!disabled; } catch (e) {}
}
// ================================================================================================================
// F1-7N-FB-4G-A2 - SUBMIT PLAN PREFLIGHT. ONE STATE SNAPSHOT, ONE VERDICT, ONE CONFIRMATION.
//
// Submit already failed closed on several conditions, but each was decided by its own map and reported with its
// own sentence: _irUnsavedRoutes (save FAILURES), _draftDbTimers (debounced writes not yet sent),
// _draftDbInFlight (writes in the air), _draftDbDirty (an edit that landed during a write),
// _pendingDraftCancels (deletes not yet persisted) and - since A1-R1 - the Execution panel's reveal state.
// Six owners, five of them booleans, and nowhere that could answer the one question Submit depends on: is what
// the operator is looking at the same as what the database holds?
//
// This gathers those six into ONE named snapshot and hands it to ONE pure predicate (IRSubmitPreflight). The
// verdict is derived from NAMED STATE - deliberately NOT from "the DOM row count equals the stored row count",
// because two routes can be equal in number and different in every value.
//
// AND IT NEVER SAVES FOR THE OPERATOR. Persisting a pending edit on their behalf would be a mutation they did
// not ask for, on data they may be about to correct. It reports; they act.
function _irSubmitStateSnapshot_() {
    function truthyKeys(map) {
        var out = [];
        try { Object.keys(map || {}).forEach(function (k) { if (map[k]) out.push(k); }); } catch (e) {}
        return out;
    }
    function nonEmptyKeys(map) {
        var out = [];
        try { Object.keys(map || {}).forEach(function (k) { var v = map[k]; if (v && v.length) out.push(k); }); } catch (e) {}
        return out;
    }
    // The Execution panel's own readiness, per open row (A1-R1). A disabled button is not a guard: a direct
    // call, a stale enabled button or a keyboard activation all bypass it, so the state is read HERE too.
    var panels = [];
    try {
        if (typeof document !== 'undefined' && document.querySelectorAll) {
            var hosts = document.querySelectorAll('#ops-section [data-ir-reveal="execution"]');
            Array.prototype.forEach.call(hosts, function (h) {
                panels.push({ sku: String(h.getAttribute('data-ir-sku') || ''),
                    execState: String(h.getAttribute('data-reveal-state') || '').toUpperCase() });
            });
        }
    } catch (e2) {}
    // The persisted route model, exactly as the hydrate and the collect maintain it. `persisted` is decided by
    // the presence of the STORED identities the server will re-read, never by a DOM row existing.
    var routes = [];
    // F1-7N-FB-4G-A2-R1 — the scope key belongs to the DRAFT CONTAINER, which is what owns these routes: the
    // hydrate loads one station's drafts into replenAllocationDraft.context. A2's preflight already filtered
    // on r.scopeKey, but the snapshot never supplied the field, so `sstr(r.scopeKey)` was always '' and the
    // filter could not fire on a real snapshot - it was live only under a hand-built one. Supplying it makes
    // the filter (and the OUT_OF_APPLIED_SCOPE exclusion it reports) real: a stale selector now excludes the
    // routes of the station that is no longer applied instead of proposing them.
    var _dctx = (replenAllocationDraft && replenAllocationDraft.context) || {};
    var _draftScopeKey = [String(_dctx.company || ''), String(_dctx.country || ''), String(_dctx.marketplace || '')].join('|').toLowerCase();
    var scope0 = (typeof _irMethodScope_ === 'function') ? (_irMethodScope_() || {}) : {};
    var _whCountryById = {};
    try {
        (_irWsGet('getWarehouses') || []).forEach(function (w) {
            var id = String((w && w.warehouseId) || '').trim();
            if (id) _whCountryById[id] = String((w && w.country) || '').trim();
        });
    } catch (_eW) {}
    try {
        var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
        Object.keys(bySku).forEach(function (sku) {
            (bySku[sku] || []).forEach(function (r) {
                var di = (window.IRWarehouse && typeof window.IRWarehouse.destinationIdentity === 'function')
                    ? window.IRWarehouse.destinationIdentity(r) : { type: '', id: '', ok: false, code: '' };
                var _complete = (typeof _isRouteComplete === 'function') ? !!_isRouteComplete(r) : false;
                // F1-7N-FB-4G-A3 §E — an incomplete route now BLOCKS Submit, so the block has to be able to
                // say WHICH fields are missing. _irMissingRouteFields_ is the same owner the save-time
                // UNSAVED_INCOMPLETE_ROUTE notice uses, so the two can never disagree about what is missing.
                var _missing = (!_complete && typeof _irMissingRouteFields_ === 'function') ? _irMissingRouteFields_(r) : [];
                // §B — "no Method chosen" and "no Method EXISTS for this route" are different problems with
                // different owners: one is the operator, the other is carrier master data. The registry has
                // always known which it is; nothing ever asked it. `EMPTY_CONFIGURATION` is the catalogue
                // answering successfully that it covers nothing here — never a read failure.
                var _methodCfgMissing = false;
                try {
                    if (_missing.length === 1 && _missing[0] === 'Method' && typeof _execResolveMethods === 'function') {
                        var _srcId = String((r && r.source_warehouse_id) || '').trim();
                        var _res = _execResolveMethods(_execMethodRouteCtx(
                            _whCountryById[_srcId] || '', String(scope0.country || ''),
                            String(scope0.marketplace || ''), _srcId,
                            String((r && r.destination_warehouse_code) || '')));
                        _methodCfgMissing = !!(_res && _res.status === 'EMPTY_CONFIGURATION');
                    }
                } catch (_eM) {}
                routes.push({
                    sku: sku,
                    scopeKey: _draftScopeKey,
                    // F1-7N-FC-1B-E1 §H.4 — carried so the preflight can refuse a candidate that cannot
                    // say how it came to exist. The EFFECTIVE provenance, not the raw field: a model row
                    // restored from a pre-E1 recovery cache carries no field but does carry its stored
                    // identities, and refusing to submit a route the database demonstrably holds would be a
                    // worse failure than the one this round removes.
                    route_provenance: _irRouteProvenanceOf_(r),
                    // F1-7N-FC-1B-E2 §C/§F — a composer is judged as a composer, so the preflight has to
                    // be able to tell one from a route. Reported verbatim from the model; the snapshot never
                    // decides which state a row is in.
                    route_kind: String((r && r.route_kind) || ''),
                    composer_touched: (r && r.composer_touched) === true,
                    allocation_draft_id: String((r && r.allocation_draft_id) || ''),
                    allocation_draft_line_id: String((r && r.allocation_draft_line_id) || ''),
                    qty: r && r.qty,
                    complete: _complete,
                    missingFields: _missing,
                    methodConfigurationMissing: _methodCfgMissing,
                    routeLabel: (typeof _irRouteLabel_ === 'function') ? _irRouteLabel_({ routes: [r], header: {} }) : '',
                    shipping_method: String((r && r.shipping_method) || ''),
                    destination_type: di.type || '',
                    destination_code: di.type === 'MARKETPLACE' ? (di.marketplace || di.id || '') : (di.warehouse_id || di.id || ''),
                    // §I.2 — the dimensions 11_ shippingPlanRouteGroupKey_ groups on, supplied from the SAME
                    // persisted route model the server will re-read. Without them every route hashed to one
                    // blank key and the plan-group count would have been 1 for any submit at all.
                    company: String(_dctx.company || ''),
                    country: String(_dctx.country || ''),
                    ship_from: String((r && (r.source_warehouse_code || r.source_warehouse_id)) || ''),
                    source_warehouse_id: String((r && r.source_warehouse_id) || ''),
                    destination_warehouse_id: (di.type === 'WAREHOUSE') ? String(di.warehouse_id || di.id || '') : '',
                    destination: di.type === 'MARKETPLACE' ? String(di.marketplace || di.id || '') : String((r && r.destination_warehouse_code) || di.warehouse_id || di.id || ''),
                    last_mile_delivery: String((r && r.last_mile_delivery) || ''),
                    planning_cycle: String(_dctx.planning_cycle || ''),
                    lineCancelled: String((r && r.line_status) || '').trim().toLowerCase() === 'cancelled',
                    terminal: ['submitted', 'cancelled', 'expired'].indexOf(String((r && r.status) || '').trim().toLowerCase()) !== -1
                });
            });
        });
    } catch (e3) {}
    var scope = (typeof _irAppliedSubmitScope_ === 'function') ? (_irAppliedSubmitScope_() || {}) : {};
    return {
        scope: scope,
        appliedScopeKey: [String(scope.company || ''), String(scope.country || ''), String(scope.marketplace || '')].join('|').toLowerCase(),
        pendingWrites: truthyKeys(typeof _draftDbTimers !== 'undefined' ? _draftDbTimers : null),
        inFlightWrites: truthyKeys(typeof _draftDbInFlight !== 'undefined' ? _draftDbInFlight : null),
        dirtyAfterWrite: truthyKeys(typeof _draftDbDirty !== 'undefined' ? _draftDbDirty : null),
        pendingCancels: nonEmptyKeys(typeof _pendingDraftCancels !== 'undefined' ? _pendingDraftCancels : null),
        saveFailed: (typeof _irUnsavedSkus_ === 'function') ? _irUnsavedSkus_() : [],
        panels: panels,
        routesMissingDestination: (typeof _irRoutesMissingDestination_ === 'function') ? _irRoutesMissingDestination_() : [],
        duplicateCorruption: (typeof _irDuplicateLineIdentities_ === 'function') ? _irDuplicateLineIdentities_() : [],
        routes: routes,
        // F1-7N-FC-1B-E3 §G.14 — an AI Plan run whose rows the server did not acknowledge. Submit is
        // refused while this stands, because the station's stored plan is not known to be the plan on screen.
        aiPlanUnreconciled: (window._irAiPlanUnreconciled && window._irAiPlanUnreconciled.reason)
            ? String(window._irAiPlanUnreconciled.reason) : '',
        // The page does not know how many ACTIVE headers the station holds with zero lines - the hydrate
        // produces routes, not a header inventory. That count belongs to the read-only census
        // (TEMP_SHIPPING_ALLOCATION_SUBMIT_PLAN_A2_SUMMARY), and is reported there rather than guessed here.
        zeroLineHeaderCount: 0
    };
}
window._irSubmitStateSnapshot_ = _irSubmitStateSnapshot_;
function _irSubmitPreflight_() {
    if (!(typeof window !== 'undefined' && window.IRSubmitPreflight)) {
        return { ok: false, code: 'PREFLIGHT_UNAVAILABLE', blocking: { skus: [], reasons: [] },
            candidate: { draftIds: [], routeCount: 0, lineCount: 0, totalQty: 0, skus: [], methods: [], destinations: [] },
            excluded: [] };
    }
    return window.IRSubmitPreflight.evaluate(_irSubmitStateSnapshot_());
}
window._irSubmitPreflight_ = _irSubmitPreflight_;
// The per-code message. These are RENDERERS of the one verdict, not separate decisions - which is what stops
// the page growing a seventh owner the next time a condition is added.
function _irAlertSubmitBlocked_(pf) {
    var C = window.IRSubmitPreflight ? window.IRSubmitPreflight.CODES : {};
    var by = {};
    (pf.blocking.reasons || []).forEach(function (r) { (by[r.reason] = by[r.reason] || []).push(r.sku); });
    function list(n) {
        return (pf.blocking.reasons || []).slice(0, 8).map(function (r) { return '  \u00b7 ' + r.sku + ' \u2014 ' + r.reason; }).join(String.fromCharCode(10));
    }
    if (pf.code === C.UNSAVED_EXECUTION_PLAN_CHANGES) {
        alert('Cannot Submit Plan \u2014 UNSAVED_EXECUTION_PLAN_CHANGES.' + NL2 +
            pf.blocking.skus.length + ' Execution Plan route(s) differ from what the database holds:' + NL2 + list() + NL2 +
            'Nothing was submitted and NOTHING was written. Submit only ever commits persisted rows, so an ' +
            'unsaved change would be silently missing from the plan \u2014 and it never submits the routes beside ' +
            'it on their own, because half a plan that looks whole is worse than no plan.' + NL2 +
            'Each route saves by itself a moment after you stop typing. WAIT for that to finish, or remove the ' +
            'change you do not want, then Submit again. Submit will not save on your behalf.');
        return;
    }
    // F1-7N-FB-4G-A2-R1 §3 — a save IN FLIGHT and a save that FAILED need opposite things from the operator, so
    // they are separate codes rather than one. Waiting fixes the first and can never fix the second.
    if (pf.code === C.EXECUTION_PLAN_SAVE_IN_PROGRESS) {
        alert('Cannot Submit Plan \u2014 EXECUTION_PLAN_SAVE_IN_PROGRESS.' + NL2 + list() + NL2 +
            'A route is being saved right now. Nothing was submitted and nothing was written, and the save was ' +
            'not interrupted \u2014 it finishes on its own. Wait for it, then Submit again.');
        return;
    }
    if (pf.code === C.EXECUTION_PLAN_SAVE_FAILED) {
        alert('Cannot Submit Plan \u2014 EXECUTION_PLAN_SAVE_FAILED.' + NL2 + list() + NL2 +
            'A route could not be saved, so the database does not hold it. Nothing was submitted and nothing ' +
            'was written. WAITING WILL NOT FIX THIS: re-enter the route so it saves, or remove it, then Submit ' +
            'again. Submit will not retry the save for you.');
        return;
    }
    if (pf.code === C.EXECUTION_PLAN_NOT_READY) {
        alert('Cannot Submit Plan \u2014 EXECUTION_PLAN_NOT_READY.' + NL2 + list() + NL2 +
            'An Execution Plan on screen has not finished loading, or is showing a named failure. Nothing was ' +
            'submitted and nothing was written. Wait for it to load, or use Retry Methods, then Submit again.');
        return;
    }
    if (pf.code === C.ROUTE_DESTINATION_MISSING) {
        var nd = _irRoutesMissingDestination_();
        alert('Cannot Submit Plan \u2014 ' + nd.length + ' route(s) plan a quantity but have no destination saved.' + NL2 +
            nd.slice(0, 8).map(function (d) {
                return '  \u00b7 ' + d.sku + ' \u2014 ' + d.qty + ' unit(s)' + (d.shipping_method ? (' by ' + d.shipping_method) : '') + ', ' + (d.destination_code || 'To is empty');
            }).join(String.fromCharCode(10)) + NL2 +
            'Choose a destination for each one and confirm the save, then Submit again. Nothing was submitted and ' +
            'nothing was written.');
        return;
    }
    // F1-7N-FB-4G-A3 §E/§J.17 — AN INCOMPLETE ROUTE ON SCREEN STOPS THE WHOLE SUBMIT.
    //
    // Until A3 this route was PERSISTED (A2-R4 correctly stopped erasing its identity) and therefore silently
    // EXCLUDED: Submit went ahead, committed a plan built from the routes beside it, and this one's quantity
    // was simply not in it. Naming it is the point — and naming WHICH of the two causes it is, because a
    // Method nobody has chosen is thirty seconds of the operator's time, while a Method that does not EXIST
    // for this lane is a carrier master-data task that Submit can never resolve by waiting.
    if (pf.code === C.EXECUTION_PLAN_ROUTE_INCOMPLETE) {
        var _cfg = (pf.blocking.reasons || []).filter(function (r) { return r.reason === 'NO_ELIGIBLE_METHOD_CONFIGURED'; });
        var _detail = (pf.blocking.reasons || []).slice(0, 8).map(function (r) {
            return '  \u00b7 ' + r.sku + (r.route ? (' \u2014 ' + r.route) : '') +
                (r.reason === 'NO_ELIGIBLE_METHOD_CONFIGURED'
                    ? ' \u2014 NO ELIGIBLE METHOD IS CONFIGURED for this route'
                    : ' \u2014 needs ' + ((r.missing || []).join(' + ') || 'a valid route'));
        }).join(String.fromCharCode(10));
        alert('Cannot Submit Plan \u2014 EXECUTION_PLAN_ROUTE_INCOMPLETE.' + NL2 +
            pf.blocking.skus.length + ' route(s) on screen are not complete:' + NL2 + _detail + NL2 +
            'Nothing was submitted and NOTHING was written. Submit commits complete routes only, so submitting ' +
            'now would create a Weekly Shipping Plan that looks whole while these quantities were silently ' +
            'left out of it.' + NL2 +
            (_cfg.length
                ? ('A route marked NO ELIGIBLE METHOD IS CONFIGURED cannot be finished on this screen: no active ' +
                   'carrier_rate_cards row covers that origin / destination / marketplace, so the Method list is ' +
                   'genuinely empty. Add or activate the rate card, reload, then Submit again \u2014 or remove the ' +
                   'route if it is not meant to ship.')
                : 'Finish each route (which saves it to the ticket it already has) or remove it, then Submit again.'));
        return;
    }
    if (pf.code === C.DUPLICATE_LINE_IDENTITY) {
        var dl = _irDuplicateLineIdentities_().slice(0, 8).map(function (d) {
            return '  \u00b7 ' + d.sku + ' \u2014 ' + d.allocation_draft_line_id + ' names ' + d.physical_rows + ' physical rows';
        }).join(String.fromCharCode(10));
        alert('Cannot Submit Plan \u2014 duplicate rows exist in the database.' + NL2 + dl + NL2 +
            'One Execution Plan line must name exactly one stored row. Nothing was submitted and nothing was ' +
            'written or deleted. Run the duplicate cleanup first, then Submit again.');
        return;
    }
    if (pf.code === C.NO_PERSISTED_CANDIDATE) {
        alert('No persisted allocation draft to submit yet \u2014 adjust the Execution Plan (which saves the draft) and try again.' +
            ((pf.excluded && pf.excluded.length) ? (NL2 + 'Excluded: ' + pf.excluded.map(function (e) { return e.reason + ' \u00d7' + e.count; }).join(', ')) : ''));
        return;
    }
    alert('Cannot Submit Plan (' + (pf.code || 'BLOCKED') + '). Nothing was submitted and nothing was written.');
}
// THE CONFIRMATION. Built from the PERSISTED candidate set and from nothing else - never from the DOM - so what
// it promises is exactly what the server will re-read. Cancel issues no request and mints no identity.
function _irConfirmSubmit_(conf) {
    if (!conf) return false;
    var lines = [];
    lines.push('Submit Weekly Shipping Plan?');
    lines.push('');
    lines.push('Station: ' + [conf.scope.company, conf.scope.country, conf.scope.marketplace].filter(Boolean).join(' / '));
    lines.push('Saved routes: ' + conf.routeCount);
    lines.push('SKUs: ' + conf.skuCount + '   ·   Plan lines: ' + conf.lineCount);
    lines.push('Total planned quantity: ' + conf.totalQty);
    // F1-7N-FB-4G-A3 SS.I.2/SS.I.3 - the RESULT of the submit, not only its input. Routes do not map one-to-one
    // onto Weekly Shipping Plans: physically compatible routes consolidate into ONE plan (same company,
    // country, source warehouse, destination, method, last mile and planning cycle) and incompatible ones
    // never do. An operator who submits four routes and is shown "4" has not been told what they are creating.
    // The count mirrors 11_ shippingPlanRouteGroupKey_; the server still derives the real grouping when it
    // commits, and a parity test executes both over the same rows so the mirror cannot drift.
    lines.push('Weekly Shipping Plans to create: ' + conf.planGroupCount +
        (conf.planGroupCount < conf.routeCount
            ? ('   (' + conf.routeCount + ' route(s) consolidate \u2014 physically compatible)')
            : ''));
    if (conf.destinations.length) lines.push('Destination: ' + conf.destinations.map(function (d) { return d.type + (d.code ? (' ' + d.code) : ''); }).join(', '));
    if (conf.methods.length) lines.push('Shipping method: ' + conf.methods.join(', '));
    if (conf.excluded.length) {
        lines.push('');
        lines.push('Not included: ' + conf.excluded.map(function (e) { return e.reason + ' \u00d7' + e.count; }).join(', '));
    }
    // F1-7N-FB-4G-A2-R1 — report the read-back verdict VERBATIM. It is not a claim of correctness: MATCHED
    // means the persisted quantities were read and compared, UNVERIFIABLE means the diagnostic read was
    // unavailable and nothing was compared. FB-3B deliberately lets an inconclusive read through (the server
    // re-reads the drafts anyway), and the one thing that is never allowed is presenting it as a verification.
    var _v = conf.verification || {};
    lines.push('Saved quantities: ' + (_v.verdict === 'MATCHED'
        ? ('re-read from the database and matched (' + (_v.checked || 0) + ' line(s))')
        : ('NOT RE-READ before this dialog (' + (_v.verdict || 'UNVERIFIABLE') + ') \u2014 the server re-reads them on submit')));
    lines.push('');
    lines.push('ONLY SAVED DATA IS SUBMITTED. Anything not yet saved to the database is not part of this plan.');
    if (typeof confirm !== 'function') return true;   // headless: no dialog to answer
    return confirm(lines.join(String.fromCharCode(10)));
}
window._irConfirmSubmit_ = _irConfirmSubmit_;

function _replenCanonicalSubmit(draftIds, execKey, expectedLineCount) {
    if (_replenSubmitInFlight[execKey]) return _replenSubmitInFlight[execKey];   // share the in-flight Promise (no 2nd mutation)
    _replenSetSubmitButtonDisabled(true);
    // F1-7N-FB-3B §G — declare the APPLIED station so the server can revalidate it. The server refuses a
    // mixed-station payload even without this field; declaring it additionally catches a STALE SELECTOR, which
    // no server-side check could otherwise see. Scope identity on the server still comes from the persisted
    // header, never from this declaration — the payload cannot assert a station it does not own.
    var _appliedScope = (typeof _irAppliedSubmitScope_ === 'function') ? _irAppliedSubmitScope_() : null;
    var p = window.KM.DB.submitAllocationDraftsToShippingPlans({
        allocation_draft_ids: draftIds, execution_key: execKey, submitted_by: 'inventory-replenishment',
        applied_scope: _appliedScope || undefined
    }).then(function (result) {
        result = result || {};
        if (result.success) {
            var d = result.data || {};
            _clearAllocationDraft();   // confirmed terminal (CREATED or REUSED) → drop the Working Draft + execution key
            // F1-7N-FB-3C §I — report the server's EXACT output verification rather than only "created".
            // The plan writer returning success is not proof that the committed lines carry the operator's
            // planned quantities; the server now re-reads them field by field and says so on the wire.
            var ov = d.output_verification || null;
            var ovLine = !ov ? ''
                : (ov.skipped ? ('\nLine verification: NOT PERFORMED (' + (ov.reason || 'skipped') + ') — not claimed as verified')
                    : ('\nLine verification: ' + (ov.verified ? 'PASSED' : 'FAILED') +
                       ' — ' + (ov.verified_lines || 0) + '/' + (ov.expected_lines || 0) + ' line(s), ' +
                       (ov.verified_qty || 0) + ' unit(s) matched against the frozen Execution Plan' +
                       (ov.applied_station ? ('\nStation verified: ' + [ov.applied_station.company, ov.applied_station.country, ov.applied_station.marketplace].filter(Boolean).join(' / ')) : '')));
            alert('Weekly Shipping Plan ' + (d.reused ? 'already created (reused)' : 'created') + '.\nShipping Plans: ' + (d.plan_count || (d.plans ? d.plans.length : 0)) + '\nSKU lines: ' + (d.line_count || expectedLineCount || 0) + '\nStatus: Draft' + ovLine);
            showSection('shippingplan'); setTimeout(function () { renderShippingPlan(); }, 100);
            return result;
        }
        var code = result.code || '';
        if (code === 'IN_PROGRESS_SAME_EXECUTION_KEY') {
            alert('Submit is already processing for this plan. Reading back the result…');   // NOT a blind retry
            try { if (typeof _refreshAllocationDraftWorkspace === 'function') _refreshAllocationDraftWorkspace(); } catch (e) {}
        } else if (code === 'SHIPPING_PLAN_OUTPUT_VERIFICATION_FAILED') {
            // F1-7N-FB-3C §I — the plan WAS committed and the drafts ARE submitted; what failed is the
            // field-by-field match against the frozen route quantities. Nothing is rolled back, because
            // reversing a durable plan on the strength of a verification read would be a second mutation.
            // The operator is told exactly which lines disagree, and told not to approve the plan yet.
            var vf = ((result.data || {}).failures || []).slice(0, 8).map(function (f) {
                return '  · ' + (f.code || 'MISMATCH') + ' ' + (f.sku || '') +
                    (f.expected_user_planned_qty != null ? (' — on screen ' + f.expected_user_planned_qty + ', in plan ' + f.found_requested_qty) : '');
            }).join(String.fromCharCode(10));
            alert('Weekly Shipping Plan was created, but its lines DO NOT match your Execution Plan quantities.' + NL2 +
                vf + NL2 +
                'Nothing was rolled back. Do NOT approve this plan yet — review the named lines first, then correct and re-submit.');
        } else if (code === 'MIXED_SITE_PAYLOAD') {
            // F1-7N-FB-3B §G — fail-closed station scope. Submit Plan commits ONE Country + Marketplace.
            alert('Cannot Submit Plan — MIXED_SITE_PAYLOAD.' + NL2 +
                'The selected Execution Plan drafts belong to more than one Country/Marketplace station, and ' +
                'Submit Plan commits ONE station at a time. Nothing was written.' + NL2 +
                'Re-apply Search for a single station and submit that station only.');
        } else if (code === 'APPLIED_SCOPE_MISMATCH') {
            alert('Cannot Submit Plan — APPLIED_SCOPE_MISMATCH.' + NL2 +
                'The Execution Plan drafts belong to a different Country/Marketplace than the applied selection, ' +
                'so the selector is stale. Nothing was written.' + NL2 +
                'Press Search to re-apply the station you intend to submit, then Submit Plan again.');
        } else if (code === 'CONFLICT' || code === 'SUBMIT_EXECUTION_DUPLICATE_CONFLICT' || code === 'SUBMIT_DRAFT_ALREADY_SUBMITTED') {
            alert('This plan changed since it was prepared, or was already submitted under a different attempt. Refresh and review before submitting again.');   // CONFLICT → refresh/review
        } else {
            alert('Could not create Weekly Shipping Plan (' + (code || 'error') + '). ' + (result.error || '') + '\nThe draft is kept so you can retry.');   // keep draft
        }
        return result;
    }).catch(function (err) {
        alert('Error creating Weekly Shipping Plan: ' + (err && err.message ? err.message : err) + '\nThe draft is kept so you can retry.');
        return { success: false, error: String(err && err.message ? err.message : err) };
    }).then(function (r) {
        delete _replenSubmitInFlight[execKey]; _replenSetSubmitButtonDisabled(false);   // terminal → restore UI
        return r;
    });
    _replenSubmitInFlight[execKey] = p;
    return p;
}
window._replenCanonicalSubmit = _replenCanonicalSubmit;

// Debounced DB sync (§5.4/§7): rapid Qty keystrokes / re-renders collapse into ONE write after the edit
// settles, and an in-flight guard prevents duplicate concurrent writes / out-of-order overwrite.
var _draftDbTimers = {};        // sku -> setTimeout handle
var _pendingDraftCancels = {};  // sku -> [ line_id, ... ] lines to soft-cancel on the next flush (§5)
var _draftDbInFlight = {};      // sku -> bool
var _draftDbDirty = {};         // sku -> bool (an edit landed while a write was in flight)
// ================================================================================================================
// F1-7N-FB-4G-A2-R2 - EVENT-SCOPED PERSISTENCE, AND WHY IT IS DERIVED RATHER THAN DECLARED.
//
// MEASURED: one edit, or one + Add Route, re-sent EVERY complete route the SKU held. _saveAllocationDraftFromDom
// rebuilds all rows from the DOM and calls the debounced writer with the SKU, and the writer then partitions
// ALL of them into canonical groups and writes each group's header and lines. That is where the operator's
// "3 route(s) for CO1100-R: 2 saved, 1 not saved" came from: adding a third route re-saved the two that were
// already there, so a refusal on any one of them became a partial state across routes the operator had not
// touched. A single UI event must carry a single route intent.
//
// The touched set is DERIVED BY DIFFING the rebuilt rows against the model, not declared by the caller. An
// event-plumbed instance id would be only as good as the caller's belief about which row changed; a diff makes
// "an untouched route is never re-sent" true even when the caller is wrong, and it needs no new event wiring.
//
// A route instance id is minted once per DOM row and never changes - it is what a request, a response and an
// error are correlated by. It is NOT an entity identity: allocation_draft_id / allocation_draft_line_id are
// (§4), and this is the client-side handle that survives until they exist.
var _draftDbTouched = {};       // sku -> { client_route_instance_id: 1 }  (accumulates across debounced edits)
var _irRouteInstanceSeq = 0;
function _newRouteInstanceId() {
    _irRouteInstanceSeq++;
    return 'CRI-' + Date.now().toString(36).toUpperCase() + '-' + _irRouteInstanceSeq;
}
window._newRouteInstanceId = _newRouteInstanceId;

// The fields whose change makes a route worth writing. Display-only values are deliberately absent: a
// re-rendered label is not an edit, and treating it as one would put us straight back to re-sending everything.
var IR_ROUTE_PERSISTABLE_FIELDS = ['source_warehouse_id', 'destination_warehouse_id', 'destination_marketplace',
    'shipping_method', 'last_mile_delivery', 'qty', 'units_per_carton', 'recommendation_group_no',
    'override_reason', 'note', 'window_code', 'site_sku'];
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §3/§4 — THE SIGNATURE COMPARES WHAT A PERSON AUTHORED.
//
// This decides whether a route is a write candidate, so every value it reads has to be a value somebody put
// there. A last mile the LANE supplied (the single eligible option on a one-profile service) or that a
// re-render BLANKED (the stored value is no longer eligible for the chosen method) is neither of those, and
// comparing it is precisely how one gesture on Route A came to write Route B on 2026-09-06: the derived
// `parcel` sitting in a route nobody had touched compared as an edit against the blank the database held.
//
// The row KEEPS the derived value — it is what that route would actually ship under, and it is written when
// the row is written for a real reason, such as the operator changing its method. What it stops being is
// evidence that there IS a real reason.
//
// Written inline rather than as a helper on purpose: four suites lift this function on its own, so a symbol
// it calls by name is a symbol that can be absent where it runs. Guarding that call with `typeof` would be
// worse than either option, because the fallback would silently restore the old comparison and a harness
// would pass while measuring the defect.
function _irRouteSignature_(r) {
    var derived = !!(r && r.last_mile_derived === true);
    return IR_ROUTE_PERSISTABLE_FIELDS.map(function (fld) {
        var v = (derived && fld === 'last_mile_delivery') ? (r && r.last_mile_persisted) : (r && r[fld]);
        return String(v == null ? '' : v).trim();
    }).join('\u0001');
}
function _irMarkRouteTouched_(sku, instanceId) {
    var k = String(instanceId || '').trim(); if (!k) return;
    (_draftDbTouched[sku] = _draftDbTouched[sku] || {})[k] = 1;
}
window._irMarkRouteTouched_ = _irMarkRouteTouched_;
function _irTouchedInstances_(sku) { return Object.keys(_draftDbTouched[sku] || {}); }

// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6 §7 — A WRITE WHOSE OUTCOME IS UNKNOWN MUST NOT INVITE ANOTHER WRITE.
//
// THE GAP, MEASURED ON THE SHIPPED FLUSH. A route that times out becomes `indeterminate`, is reconciled
// against the database, and — when the read-back cannot settle it — is badged OUTCOME_UNKNOWN. It also STAYS
// in the touched set, deliberately, so that it is retried rather than quietly dropped. That is the right
// instinct for a route that is proven unsaved and the wrong one for a route nobody can classify: the very
// next edit anywhere on the SKU flushes, finds it still touched, and re-sends a mutation that may already
// have committed. Nobody clicked Retry; the retry is a side effect of the operator continuing to work.
//
// The idempotency identity makes that survivable — a CREATE replays under the same key, an UPDATE is guarded
// by expected_draft_version — but survivable is not the same as correct, and neither guard covers the case the
// read-back could not classify in the first place. §7 is explicit: an ambiguous read-back STOPS and asks for
// operator review.
//
// So an unclassifiable route is HELD. It keeps its identity, its edit and its badge; what it loses is its
// automatic place in the write scope. The hold is released by exactly two things: a read-back that later
// settles it, or an operator who is shown the state and explicitly chooses. Nothing else clears it, and in
// particular no amount of ordinary editing does.
//
// WHAT IS NOT HELD, and this is the half that keeps the page usable: a route the read-back PROVED unsaved is
// not ambiguous — it is a known zero-write — so it stays retryable under the same idempotency identity, which
// is what §7 permits. Only genuine ambiguity stops the line.
// ==============================================================================================================
var _irAckUnknown = {};      // sku -> instanceId -> { code, reconciliation, identity fields, at }
// The store is reached through a resolver rather than by name, and the reason is a failure mode this page has
// already been bitten by once. `_flushDraftDbPersist` wraps its whole body in a try/catch, so a symbol that is
// missing where the flush runs does not raise — it SILENTLY CANCELS THE WRITE. The A2-R3-R1 harness note says
// exactly that about a missing dependency, and it says it because nineteen assertions about the database once
// failed instead of one about the harness. A module-level `var` is not visible to a suite that lifts these
// functions individually, so reaching it by name would reintroduce that defect for every future harness.
//
// The fallback is the SAME SHAPE and the same lifetime, so the hold behaves identically wherever it resolves;
// what changes is only which cell holds it.
function _irAckStore_() {
    if (typeof _irAckUnknown !== 'undefined' && _irAckUnknown) return _irAckUnknown;
    var g = (typeof globalThis !== 'undefined') ? globalThis
          : ((typeof window !== 'undefined' && window) ? window : null);
    if (!g) return {};
    if (!g.__irAckUnknownStore) g.__irAckUnknownStore = {};
    return g.__irAckUnknownStore;
}
function _irAckUnknownHeld_(sku) { return Object.keys(_irAckStore_()[sku] || {}); }
function _irAckUnknownIsHeld_(sku, instanceId) {
    var s = _irAckStore_();
    return !!(s[sku] && s[sku][String(instanceId || '')]);
}
// Record the hold from the outcome, carrying the SAME identity a later retry must reuse. Stored rather than
// re-derived, because re-deriving it after a re-render is how a retry acquires a new identity and mints a
// second ticket.
function _irHoldAckUnknown_(sku, o) {
    var s = _irAckStore_();
    if (!s[sku]) s[sku] = {};
    (o.instanceIds || []).forEach(function (k) {
        if (!k) return;
        s[sku][String(k)] = {
            code: String(o.code || ''),
            reconciliation: String(o.reconciliation || ''),
            intent: String(o.intent || ''),
            allocation_draft_id: String(o.allocation_draft_id || ''),
            create_idempotency_key: String(o.create_idempotency_key || ''),
            expected_draft_version: String(o.expected_draft_version || ''),
            at: new Date().toISOString()
        };
    });
}
// Released when a read-back settles the route, in EITHER direction: proven saved and proven not saved are both
// classifications, and only the absence of one is a reason to hold.
function _irClearAckUnknown_(sku, instanceIds) {
    var s = _irAckStore_();
    if (!s[sku]) return 0;
    var n = 0;
    (instanceIds || []).forEach(function (k) {
        if (s[sku][String(k)]) { delete s[sku][String(k)]; n++; }
    });
    return n;
}
// The ONLY operator-facing release. It is deliberately not wired to any edit: an explicit gesture is what §7
// asks for, and an implicit one is what this whole mechanism exists to prevent. The route keeps its stored
// identity, so the retry it enables is the SAME mutation, never a new one.
function _irReleaseAckUnknown_(sku, instanceId) {
    var released = _irClearAckUnknown_(sku, [String(instanceId || '')]);
    if (released) _irMarkRouteTouched_(sku, String(instanceId || ''));
    return released > 0;
}
window._irAckUnknownHeld_ = _irAckUnknownHeld_;
window._irAckUnknownIsHeld_ = _irAckUnknownIsHeld_;
window._irReleaseAckUnknown_ = _irReleaseAckUnknown_;
window._irAckUnknownRecord_ = function (sku, k) { return (_irAckStore_()[sku] || {})[String(k)] || null; };
window._irTouchedInstances_ = _irTouchedInstances_;

function _scheduleDraftDbPersist(sku) {
    if (_draftDbTimers[sku]) clearTimeout(_draftDbTimers[sku]);
    _draftDbTimers[sku] = setTimeout(function () { _draftDbTimers[sku] = null; _flushDraftDbPersist(sku); }, 400);
}
window._scheduleDraftDbPersist = _scheduleDraftDbPersist;

// Soft-cancel the (now empty) Draft Header once its last valid line is gone (§5.3) — never a hard
// delete, never an orphan/empty header. Upserts the header with status='cancelled' so it is excluded
// from hydrate; the local id is cleared so a future complete route starts a fresh header.
//
// F1-7N-FB-4B-ADDENDUM — one SKU losing its last route must not cancel a header ANOTHER SKU or another route
// still occupies. _irCancelUnusedDraftHeaders_ computes which headers are still referenced by any live complete
// route and cancels only the ones nothing points at any more.
function _irCancelUnusedDraftHeaders_(sku) {
    try {
        // F1-7N-FB-4G-A2-R4 §I — A HEADER IS STILL IN USE WHILE ANY ROW ON SCREEN NAMES IT.
        //
        // This required _isRouteComplete(r), so a route whose Method had just been cleared by a From change
        // stopped counting as a user of its own header — and when it was the SKU's only route the sweep
        // CANCELLED the stored header. Measured: SADH-K4-BBB soft-cancelled by nothing but an editor state.
        // §I lists exactly what may cancel a draft, and "a field is momentarily blank" is not on it. The sweep
        // keeps its real purpose: releasing a header no row references any more.
        var stillUsed = {};
        var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
        Object.keys(bySku).forEach(function (k) {
            (bySku[k] || []).forEach(function (r) {
                var id = String(r.allocation_draft_id || '').trim();
                if (id) stillUsed[id] = 1;
            });
        });
        var candidates = {};
        (((replenAllocationDraft || {}).bySku || {})[sku] || []).forEach(function (r) {
            var id = String(r.allocation_draft_id || '').trim();
            if (id && !stillUsed[id]) candidates[id] = 1;
        });
        // every header this station is known to have written — the authority that survives a row losing its own
        // binding when it became incomplete
        ((replenAllocationDraft || {}).allocationDraftIds || []).forEach(function (x) {
            var id = String(x || '').trim();
            if (id && !stillUsed[id]) candidates[id] = 1;
        });
        // legacy single-id field: only a candidate when no live route references it
        var legacy = String((replenAllocationDraft || {}).allocationDraftId || '').trim();
        if (legacy && !stillUsed[legacy]) candidates[legacy] = 1;
        var ids = Object.keys(candidates);
        if (!ids.length) { if (!Object.keys(stillUsed).length) replenAllocationDraft.allocationDraftId = ''; return; }
        replenAllocationDraft.allocationDraftIds = ((replenAllocationDraft || {}).allocationDraftIds || [])
            .filter(function (x) { return !candidates[String(x || '').trim()]; });
        return Promise.all(ids.map(function (id) { return _cancelAllocationDraftHeader(id); }));
    } catch (e) { console.warn('[replen] header sweep error:', e); }
}
window._irCancelUnusedDraftHeaders_ = _irCancelUnusedDraftHeaders_;

// Soft-cancel the queued lines, each under the header it actually belongs to. A line that is STILL a live
// complete route this flush is never cancelled (the user cleared then retyped a Qty inside the debounce window).
function _irDispatchLineCancels_(sku, cancels, complete) {
    var liveIds = {};
    (complete || []).forEach(function (r) { if (r.allocation_draft_line_id) liveIds[String(r.allocation_draft_line_id)] = 1; });
    var seen = {};
    (cancels || []).forEach(function (c) {
        var lid = String(c.line_id || '');
        if (!lid || seen[lid] || liveIds[lid]) return;
        seen[lid] = 1;
        if (typeof _cancelAllocationDraftLine === 'function') _cancelAllocationDraftLine(lid, c.allocation_draft_id);
    });
}

function _cancelAllocationDraftHeader(explicitDraftId) {
    try {
        var draftId = String(explicitDraftId == null ? '' : explicitDraftId).trim() || replenAllocationDraft.allocationDraftId;
        if (!draftId || !(window.KM && window.KM.DB && window.KM.DB.upsertShippingAllocationDraft && window.IRDraft)) { if (!explicitDraftId) replenAllocationDraft.allocationDraftId = ''; return; }
        if (typeof isOperationDbApiConfigured === 'function' && !isOperationDbApiConfigured()) { if (!explicitDraftId) replenAllocationDraft.allocationDraftId = ''; return; }
        var ctx = _replenCtx();
        var header = window.IRDraft.buildDraftHeaderPayload({ allocation_draft_id: draftId, company: ctx.company, country: ctx.country, marketplace: ctx.marketplace, status: 'cancelled' });
        if (String(replenAllocationDraft.allocationDraftId || '') === draftId) replenAllocationDraft.allocationDraftId = '';
        // F1-7N-FB-2A §D — the local id is cleared optimistically (a fresh complete route must start a new
        // header), so a FAILED cancel would otherwise be invisible: the draft stays active in the DB while the
        // page has forgotten it, and the next save resolves to a second active draft — a BLOCKED_CONFLICT with
        // no explanation. Record the failure as UNSAVED so it is visible and Submit is blocked.
        return Promise.resolve(window.KM.DB.upsertShippingAllocationDraft(header))
            .then(function (res) {
                if (!res || res.success === false) {
                    _irMarkRouteUnsaved_('draft:' + draftId, _irMakeDraftSaveError_(res && res.error, 'shipping_allocation_drafts', 'draft header cancel failed'));
                }
                return res;
            })['catch'](function (e2) {
                _irMarkRouteUnsaved_('draft:' + draftId, _irMakeDraftSaveError_({ code: 'HTTP_TRANSPORT_ERROR', message: (e2 && e2.message) || String(e2) }, 'shipping_allocation_drafts', 'draft header cancel failed'));
            });
    } catch (e) { console.warn('[replen] cancel draft header error:', e); }
}
window._cancelAllocationDraftHeader = _cancelAllocationDraftHeader;

// ================================================================================================================
// F1-7N-FB-4B-ADDENDUM — MULTI-ROUTE PERSISTENCE HELPERS.
// One SKU may hold several Execution Plan routes. Each distinct canonical route group is its OWN shipment group and
// therefore its OWN SADH-K2- header, with that SKU's line underneath it. These helpers keep the page's per-row
// binding (which header a row belongs to) exact, so an id is never adopted across routes and a route that moved to
// a different header does not leave a countable line behind on the old one.
// ================================================================================================================

// A short human label for one route group — used in operator-facing per-route reporting.
function _irRouteLabel_(g) {
    var r = (g && g.routes && g.routes[0]) || {};
    var from = r.ship_from || (g && g.header && g.header.recommended_source_warehouse_id) || '?';
    var to = r.destination || (g && g.header && g.header.recommended_destination_warehouse_id) || '?';
    var m = r.shipping_method || (g && g.header && g.header.recommended_shipping_method) || '?';
    return from + ' → ' + to + ' / ' + m;
}

// Bind every row of a group to the header the server actually resolved, in BOTH stores: the draft model that the
// next flush reads, and the DOM attribute the next collect reads. Leaving either behind reopens the class of bug
// where the page sends an identity the server never stored.
// F1-7N-FB-4G-A2-R3-R1 §F2.5 — THE VERSION THE SERVER JUST MOVED TO IS ADOPTED HERE.
//
// This stamped the draft id and the group key and nothing else. draft_version was set once, at hydrate, and
// never again — so after the first successful UPDATE the stored row was at 2 while the page still declared it
// expected 1, and every later edit of that route was refused STALE_OPTIMISTIC_TOKEN with zero writes. Retrying
// could not help, because the retry re-sent the same stale number; only a Search reload cleared it. The server
// returns the version it wrote, so the row adopts it, and the OPTIMISTIC TOKEN stays meaningful: it still
// refuses a write over a change made in another tab, because that version came from somewhere else.
function _irStampRouteGroupIds_(sku, g, draftId, draftVersion) {
    var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
    var ver = String(draftVersion == null ? '' : draftVersion).trim();
    (g.routes || []).forEach(function (r) {
        r.allocation_draft_id = draftId;
        r.route_group_key = g.groupKey;
        if (ver) r.draft_version = ver;
        // F1-7N-FB-4F-B6 §F — the adoption has happened; the stored row now HAS a destination. Clearing the
        // state here is what stops the confirmation from being asked again on every later edit of the same
        // route, and it is cleared only on the path that runs after a header was actually persisted.
        r.destination_state = '';
    });
    // re-stamp the DOM rows that belong to this group so a later collect carries the header binding
    try {
        var host = document.getElementById('shipping-methods-' + sku);
        if (host) {
            var els = host.querySelectorAll('[data-line-id]');
            for (var i = 0; i < els.length; i++) {
                var lid = els[i].getAttribute('data-line-id');
                for (var j = 0; j < (g.routes || []).length; j++) {
                    if (g.routes[j] && String(g.routes[j].allocation_draft_line_id || '') === String(lid)) {
                        els[i].setAttribute('data-draft-id', draftId);
                        els[i].setAttribute('data-group-key', g.groupKey);
                        // R6-R6-R4-R2 — the DOM adopts the new version too. Without this the next edit
                        // would re-send the version this save just consumed and be refused STALE, which is
                        // the failure the model-side adoption above was written to end.
                        if (ver) els[i].setAttribute('data-draft-version', ver);
                        els[i].removeAttribute('data-dest-state');
                    }
                }
            }
        }
    } catch (e) {}
    return rows.length;
}

// A route whose route context changed belongs to a different header now. Soft-cancel its line under the header it
// LEFT, so the plan is never counted under both. Never a hard delete; never a re-key of a stored identity.
function _irQueueStaleGroupCancels_(sku, groups) {
    (groups || []).forEach(function (g) {
        (g.routes || []).forEach(function (r) {
            var prevGroup = String(r.route_group_key || '');
            var prevDraft = String(r.allocation_draft_id || '');
            var prevLine = String(r.allocation_draft_line_id || '');
            if (!prevGroup || !prevDraft || !prevLine) return;
            if (prevGroup === g.groupKey) return;                       // unchanged route — nothing to release
            // F1-7N-FB-4G-A2-R2 §2/§4 - THIS IS WHERE A ROUTE'S IDENTITY WAS DESTROYED BY AN EDIT.
            //
            // MEASURED on the shipped functions: changing From, Shipping Method, Last Mile, or a marketplace
            // destination to a warehouse one changes the 10-dimension K2 key, and this branch then ERASED
            // allocation_draft_id and allocation_draft_line_id and soft-cancelled the stored line - after
            // which the header write (which deliberately sent no id) resolved by natural key and CREATED a
            // new header. One route edited across three dimensions is three headers, which is exactly the
            // live SADH-K2-E7AF9242 / -179FBB0E / -C3E2031A shape.
            //
            // §4 freezes the opposite: allocation_draft_id and allocation_draft_line_id are IMMUTABLE ENTITY
            // IDENTITIES and the K4 key is a uniqueness/collision signature only. An id is allowed to stop
            // hashing to its own current field values, because it names the entity and not its contents. So
            // the route KEEPS its identity and the header is UPDATED in place; only the group key is refreshed
            // so the next diff compares against what is now stored.
            r.route_group_key = g.groupKey;
        });
    });
}

// F1-7N-FB-4G-A2-R2 §5 - the draft_version the client believes this header is at, so the server can refuse a
// stale write instead of silently overwriting a change made elsewhere. It is read from the hydrated model only:
// a version the client never saw is sent as absent rather than guessed, and an absent expectation is not an
// assertion that the row is unchanged.
function _irStoredDraftVersion_(draftId) {
    var id = String(draftId || '').trim(); if (!id) return '';
    var found = '';
    try {
        var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
        Object.keys(bySku).forEach(function (sk) {
            (bySku[sk] || []).forEach(function (r) {
                if (String((r && r.allocation_draft_id) || '').trim() !== id) return;
                var v = String((r && r.draft_version) || '').trim();
                if (v) found = v;
            });
        });
    } catch (e) {}
    return found;
}
window._irStoredDraftVersion_ = _irStoredDraftVersion_;

// F1-7N-FB-4G-A2-R2 §7 - MULTI-LINE HEADER: DISCLOSE OR BLOCK, NEVER SILENTLY RE-ROUTE.
//
// From / To / Method / Last Mile are HEADER-level columns, so changing one of them on a header that several
// lines share moves EVERY one of those lines - including lines for SKUs the operator cannot see, because the
// Execution Plan shows one SKU at a time. H3 is exactly that shape: one header, five lines, 220 units.
//
// §7 requires the affected SKUs and lines to be disclosed BEFORE such an edit, and requires a BLOCK when the
// UI cannot express it. It cannot: there is no place in a single-SKU route row to show "this also moves four
// other SKUs", and a confirm() that asked would still be a confirm() about an operation the operator did not
// intend. So it BLOCKS, names every affected line, and says what the intended operation would be. Letting a
// single SKU leave its header is a MOVE_LINE / SPLIT_ROUTE operation, which is deliberately not improvised here.
function _irMultiLineHeaderBlock_(sku, routes) {
    var HEADER_DIMS = ['source_warehouse_id', 'destination_warehouse_id', 'destination_marketplace',
        'shipping_method', 'last_mile_delivery'];
    var offending = null;
    (routes || []).forEach(function (r) {
        if (offending) return;
        var id = String((r && r.allocation_draft_id) || '').trim();
        if (!id) return;                                   // a CREATE owns no existing header
        var stored = String((r && r.route_group_key) || '').trim();
        var now = '';
        try { now = window.IRDraft.canonicalRouteGroupKey(_replenCtx(), r); } catch (e) { return; }
        if (!stored || stored === now) return;             // no header-level dimension changed
        // Every persisted line under that same header, across ALL SKUs - which is the whole point.
        var siblings = [];
        try {
            var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
            Object.keys(bySku).forEach(function (sk) {
                (bySku[sk] || []).forEach(function (o) {
                    if (String((o && o.allocation_draft_id) || '').trim() !== id) return;
                    var lid = String((o && o.allocation_draft_line_id) || '').trim();
                    if (!lid) return;
                    if (String((o && o.client_route_instance_id) || '') === String((r && r.client_route_instance_id) || '')) return;
                    siblings.push({ sku: sk, allocation_draft_line_id: lid, qty: o.qty });
                });
            });
        } catch (e2) {}
        if (!siblings.length) return;                      // sole line - editing the header affects only it
        offending = { route: r, allocation_draft_id: id, siblings: siblings,
            changed: HEADER_DIMS.filter(function (f) { return true; }) };
    });
    if (!offending) return null;
    var others = offending.siblings;
    var skus = {}; others.forEach(function (o) { skus[o.sku] = 1; });
    return {
        structured: {
            code: 'MULTI_LINE_HEADER_EDIT_BLOCKED', reasonCode: 'MULTI_LINE_HEADER_EDIT_BLOCKED',
            table: 'shipping_allocation_drafts', retryable: false,
            allocation_draft_id: offending.allocation_draft_id,
            affected_skus: Object.keys(skus), affected_lines: others,
            message: 'This route belongs to a shipment (' + offending.allocation_draft_id + ') that also carries ' +
                others.length + ' other line(s) across ' + Object.keys(skus).length + ' other SKU(s): ' +
                others.map(function (o) { return o.sku + ' (' + o.qty + ')'; }).join(', ') + '. From, To, Method and ' +
                'Last Mile are properties of the SHIPMENT, so changing one here would move every one of those ' +
                'lines too - including SKUs this screen is not showing you. Nothing was written.',
            nextAction: 'Undo this change and edit the shipment from a view that shows all of its SKUs, or ' +
                'reduce this SKU\'s quantity to zero here and enter it as its own route. Moving one SKU out of a ' +
                'shared shipment is a separate operation and is not performed automatically.'
        },
        message: 'MULTI_LINE_HEADER_EDIT_BLOCKED - this shipment carries ' + others.length + ' other line(s); nothing was written.'
    };
}
window._irMultiLineHeaderBlock_ = _irMultiLineHeaderBlock_;

// Persist ONE canonical route group: resolve/create its header, then upsert its line under that header.
// Returns a per-route outcome and never throws, so one failing route cannot abort the routes after it.
// F1-7N-FB-4G-A2-R4 §G.8/§F.2 — what an edit that left the route incomplete says for itself.
//
// It is NOT a failure: nothing was attempted and nothing was written, and the database still holds this
// route's last complete version. It is a state the operator has to be able to see, because the alternative —
// what shipped — was a change that produced no request and no message at all.
function _irMissingRouteFields_(r) {
    var miss = [];
    if (!String((r && r.source_warehouse_id) || '').trim()) miss.push('From');
    var toReal = String((r && r.destination_warehouse_id) || '').trim();
    var mkt = String((r && r.destination_marketplace) || '').trim();
    if (!((!!toReal) !== (!!mkt))) miss.push('To');
    var q = Number((r && (r.planned_qty != null ? r.planned_qty : r.qty)));
    if (!isFinite(q) || q <= 0) miss.push('Qty');
    var m = String((r && r.shipping_method) || '').trim();
    if (!m || m.toLowerCase().indexOf('no available') !== -1) miss.push('Method');
    return miss;
}
function _irIncompleteRouteNotice_(sku, routes) {
    var lines = (routes || []).map(function (r) {
        return '  · ' + _irRouteLabel_({ routes: [r], header: {} }) + ' — needs ' + (_irMissingRouteFields_(r).join(' + ') || 'a valid route');
    });
    var e = new Error('UNSAVED_INCOMPLETE_ROUTE');
    // F1-7N-FC-1B-E3-R2 §A/§B — THE ENVELOPE DECLARES ITS SEVERITY AND ITS STATE.
    //
    // This notice was correct and was rendered by the wrong surface. `zeroWrite: 'true'` already said no
    // request had been made, and the single renderer ignored it and opened with "database update failed".
    // `severity` is what the renderers now branch on, and `uiStates` names the §B state of every row the
    // notice covers, so the neutral line can be worded from the state rather than from a colour.
    var _states = (routes || []).map(function (r) { return _irRouteUiState_(r); });
    e.structured = {
        code: 'UNSAVED_INCOMPLETE_ROUTE',
        reasonCode: 'UNSAVED_INCOMPLETE_ROUTE',
        severity: 'NEUTRAL',
        uiStates: _states,
        table: '',
        zeroWrite: 'true',
        retryable: 'true',
        nextAction: 'Finish the route, and it saves to the same ticket it already has.',
        incompleteInstanceIds: (routes || []).map(function (r) { return String(r.client_route_instance_id || ''); }),
        message: (routes || []).length + ' route(s) for ' + sku + ' are edited but not yet complete, so nothing was sent. ' +
            'The database still holds each one’s last complete version, and each keeps its saved ticket — ' +
            'finishing the route UPDATES that same ticket rather than creating another.\n' + lines.join('\n')
    };
    return e;
}

// F1-7N-FB-4G-A2-R3-R1 §F2.3 — READ-AFTER-TIMEOUT RECONCILIATION.
//
// A write whose response never arrived is not "not saved". The server may have committed after the browser
// stopped listening, so the only honest way to settle it is to ASK THE DATABASE. One scoped, read-only
// workspace readback answers for every indeterminate route in the batch at once, and each one is settled by
// the identity it already owns:
//
//   • a CREATE by its create_idempotency_key — the key IS the question "did my click land?", and it is stored;
//   • an UPDATE by its allocation_draft_id and the version it expected — a version that MOVED is proof the
//     write landed, a version that did not is proof it did not.
//
// A readback that itself fails changes nothing: the route stays OUTCOME UNKNOWN, which is the truthful state
// and the one that keeps Submit blocked. This never writes.
function _irReconcileIndeterminate_(sku, outcomes) {
    var unknown = (outcomes || []).filter(function (o) { return o && o.status === 'indeterminate'; });
    if (!unknown.length) return Promise.resolve(outcomes);
    if (!(window.KM && window.KM.DB && typeof window.KM.DB.getShippingAllocationDraftWorkspace === 'function')) {
        unknown.forEach(function (o) { o.reconciliation = 'READBACK_UNAVAILABLE'; o.classification = 'ACK_UNKNOWN_NEEDS_REVIEW'; });
        return Promise.resolve(outcomes);
    }
    var scope = (typeof _allocWorkspaceScope === 'function') ? _allocWorkspaceScope() : null;
    return Promise.resolve(window.KM.DB.getShippingAllocationDraftWorkspace(scope))
        .then(function (res) {
            if (!res || res.success === false || !res.data) {
                unknown.forEach(function (o) { o.reconciliation = 'READBACK_FAILED'; o.classification = 'ACK_UNKNOWN_NEEDS_REVIEW'; });
                return outcomes;
            }
            var drafts = res.data.drafts || [];
            function byId(id) {
                var want = String(id || '').trim(); if (!want) return null;
                for (var i = 0; i < drafts.length; i++) {
                    if (String((drafts[i].draft && drafts[i].draft.allocation_draft_id) || drafts[i].allocation_draft_id || '').trim() === want) return drafts[i];
                }
                return null;
            }
            function byCreateKey(key) {
                var want = String(key || '').trim(); if (!want) return null;
                for (var i = 0; i < drafts.length; i++) {
                    var d = drafts[i].draft || {};
                    if (String(d.create_idempotency_key || '').trim() === want) return drafts[i];
                }
                return null;
            }
            unknown.forEach(function (o) {
                var hit = null;
                if (o.intent === 'CREATE_NEW_ROUTE') {
                    hit = byCreateKey(o.create_idempotency_key);
                    if (!hit) {
                        // The key is stored on every create this contract writes, so its ABSENCE from the
                        // station's active drafts is proof the create did not land.
                        o.status = 'not_persisted'; o.reconciliation = 'READBACK_NOT_SAVED';
                        o.classification = 'NOT_COMMITTED_CONFIRMED_BY_READBACK';
                        o.message = 'The request did not complete, and a read-back of this station finds no draft carrying this Add Route’s idempotency key, so nothing was created. Saving again is safe.';
                        return;
                    }
                } else {
                    hit = byId(o.allocation_draft_id || _irRouteInstanceDraftId_(sku, o.instanceIds));
                    if (!hit) { o.reconciliation = 'READBACK_INCONCLUSIVE'; o.classification = 'ACK_UNKNOWN_NEEDS_REVIEW'; return; }   // stays OUTCOME UNKNOWN
                    var storedVer = String((hit.draft && hit.draft.draft_version) || '').trim();
                    var expected = String(o.expected_draft_version || '').trim();
                    if (expected && storedVer && storedVer === expected) {
                        o.status = 'not_persisted'; o.reconciliation = 'READBACK_NOT_SAVED';
                        o.classification = 'NOT_COMMITTED_CONFIRMED_BY_READBACK';
                        o.message = 'The request did not complete, and the stored route is still at the version this edit expected, so the change was not applied. Saving again is safe.';
                        return;
                    }
                    if (!expected || !storedVer) { o.reconciliation = 'READBACK_INCONCLUSIVE'; o.classification = 'ACK_UNKNOWN_NEEDS_REVIEW'; return; }
                }
                // The write DID land. Adopt exactly what the database holds, so the row stops being dirty and
                // a retry cannot write it a second time.
                var did = String((hit.draft && hit.draft.allocation_draft_id) || hit.allocation_draft_id || '').trim();
                // §7 — the named classification, not a bare status. COMMITTED_CONFIRMED_BY_READBACK is the
                // one outcome that permits the row to stop being dirty on evidence rather than on a response.
                o.status = 'persisted'; o.reconciliation = 'READBACK_SAVED';
                o.classification = 'COMMITTED_CONFIRMED_BY_READBACK'; o.allocation_draft_id = did;
                o.draft_version = String((hit.draft && hit.draft.draft_version) || '');
                o.message = 'The response was lost, but a read-back confirms this route IS saved. Nothing was written twice.';
                try { _irAdoptReconciledRoute_(sku, o, hit); } catch (eR) {}
            });
            return outcomes;
        })['catch'](function () {
            unknown.forEach(function (o) { o.reconciliation = 'READBACK_FAILED'; o.classification = 'ACK_UNKNOWN_NEEDS_REVIEW'; });
            return outcomes;
        });
}
// The stored header a route instance already believes it owns — used when the response that would have named
// it never arrived.
function _irRouteInstanceDraftId_(sku, instanceIds) {
    var want = {}; (instanceIds || []).forEach(function (k) { want[String(k)] = 1; });
    var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
    for (var i = 0; i < rows.length; i++) {
        if (want[String(rows[i].client_route_instance_id || '')] && String(rows[i].allocation_draft_id || '').trim()) {
            return String(rows[i].allocation_draft_id).trim();
        }
    }
    return '';
}
// Bind a route the read-back proved is saved back to its stored identity, by INSTANCE — never by position.
function _irAdoptReconciledRoute_(sku, o, hit) {
    var want = {}; (o.instanceIds || []).forEach(function (k) { want[String(k)] = 1; });
    var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
    var did = String((hit.draft && hit.draft.allocation_draft_id) || hit.allocation_draft_id || '').trim();
    var ver = String((hit.draft && hit.draft.draft_version) || '').trim();
    var lines = hit.lines || [];
    rows.forEach(function (r) {
        if (!want[String(r.client_route_instance_id || '')]) return;
        r.allocation_draft_id = did;
        if (ver) r.draft_version = ver;
        if (!String(r.allocation_draft_line_id || '').trim()) {
            for (var i = 0; i < lines.length; i++) {
                if (String(lines[i].sku || '') === String(r.sku || '') &&
                    String(lines[i].site_sku || '') === String(r.site_sku || '') &&
                    String(lines[i].window_code || '') === String(r.window_code || '')) {
                    r.allocation_draft_line_id = String(lines[i].allocation_draft_line_id || ''); break;
                }
            }
        }
    });
}
function _irPersistOneRouteGroup_(sku, ctx, g, allowLegacyAdoption) {
    var h = g.header || {};
    // F1-7N-FB-4G-A2-R2 §2 - THE INTENT IS DECLARED, NEVER INFERRED.
    //
    // This used to send NO allocation_draft_id on purpose, reasoning that "the server resolves a route-complete
    // header by the canonical K2 group key - same route REUSEs, different route CREATEs - which is idempotent
    // by construction". It is idempotent, and it is also the bug: it makes the natural key the entity identity,
    // so editing a route dimension silently means "a different entity", and a key that matches nothing means
    // "create one". Neither is ever what the operator asked for.
    //
    // A request now says which it is. UPDATE_EXISTING_ROUTE carries the route's own immutable
    // allocation_draft_id and the draft_version it expects, so the server updates that row or refuses; it must
    // NEVER fall back to CREATE. CREATE_NEW_ROUTE is only what + Add Route produced - a route instance with no
    // persisted identity - and carries the instance id as its create idempotency key so a retry cannot mint a
    // second票. allow_legacy_reconcile is never sent by either: adopting a legacy or zero-line header is a
    // separate, explicitly-confirmed migration, not something an Add Route may drift into (§4).
    var _persistedIds = {};
    (g.routes || []).forEach(function (r) {
        var id = String((r && r.allocation_draft_id) || '').trim();
        if (id) _persistedIds[id] = 1;
    });
    var _idList = Object.keys(_persistedIds);
    var _intent = _idList.length ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE';
    // Two different stored headers inside one group means the client model disagrees with itself about which
    // entity this route is. Refusing is the only safe answer - picking one would rewrite the other.
    if (_idList.length > 1) {
        return Promise.resolve({ status: 'not_persisted', groupKey: g.groupKey, route: _irRouteLabel_(g),
            instanceIds: (g.routes || []).map(function (r) { return String((r && r.client_route_instance_id) || ''); }),
            code: 'ROUTE_IDENTITY_AMBIGUOUS',
            message: 'this route group carries more than one stored allocation_draft_id (' + _idList.join(', ') +
                '), so which row it names is not determinable; nothing was written' });
    }
    var _instanceIds = (g.routes || []).map(function (r) { return String((r && r.client_route_instance_id) || ''); }).filter(Boolean);
    var header = window.IRDraft.buildDraftHeaderPayload({
        intent: _intent,
        allocation_draft_id: _idList[0] || undefined,
        expected_draft_version: _idList.length ? (_irStoredDraftVersion_(_idList[0]) || undefined) : undefined,
        create_idempotency_key: _idList.length ? undefined : (_instanceIds[0] || undefined),
        applied_scope_key: [String(ctx.company || ''), String(ctx.country || ''), String(ctx.marketplace || '')].join('|').toLowerCase(),
        company: ctx.company, country: ctx.country, marketplace: ctx.marketplace,
        source_warehouse_id: h.recommended_source_warehouse_id,
        source_warehouse_code: h.source_warehouse_code,                 // display-name snapshot
        destination_warehouse_id: h.recommended_destination_warehouse_id,   // '' for an Amazon logical destination
        destination_warehouse_code: h.destination_warehouse_code,
        shipping_method: h.recommended_shipping_method,
        last_mile_delivery: h.recommended_last_mile_delivery || undefined,
        destination_marketplace: h.destination_marketplace || undefined,
        // F1-7N-FB-4F-B6 §G — the operator's EXPLICIT adoption authority, and only when it was actually given.
        // The server re-checks every condition (exactly one unclassifiable candidate, every K2 dimension equal, a
        // destination actually supplied); this flag only says a human was asked and said yes.
        allow_legacy_reconcile: (allowLegacyAdoption === true) ? true : undefined
    });
    var draftIdSeen = '', serverGroupKey = '';

    // F1-7N-FB-4G-A2-R3 §D — ONE REQUEST WRITES THE TICKET, OR NOTHING IS WRITTEN.
    //
    // This used to be TWO requests: upsertShippingAllocationDraft, then upsertShippingAllocationDraftLines. That
    // cannot be atomic, and it was measured failing exactly as you would expect — the header committed, the line
    // was refused PLAN_LINE_INCOMPLETE, and the table was left holding 1 header and 0 lines. An orphan zero-line
    // header is not a cosmetic leftover: it is an ACTIVE draft of the station that later blocks Submit for every
    // real route beside it, and §J forbids deleting it to get out of that.
    //
    // upsertShippingAllocationDraftAtomic validates the header AND every line before the first write, holds one
    // lock, and compensates a new header by soft-cancelling it if the line write throws. §D.4 forbids
    // simulating that with two calls, so there is no two-call path here any more — not even as a fallback.
    var lines = (g.routes || []).map(function (r) {
        return window.IRDraft.buildDraftLinePayload(sku, r, { scope: ctx, system: r.generation_type === 'system_generated' });
    });

    // §E.6 — FAIL CLOSED. A deployment without the atomic action cannot write a route ticket safely, and the
    // one thing we must never do is quietly return to the path that produced the orphan headers. The deployment
    // probe (KM_REQUIRED_DEPLOYED_ACTIONS_) names this as a deployment fact before a save is ever attempted;
    // this is the second gate, at the call site.
    if (!(window.KM && window.KM.DB && typeof window.KM.DB.upsertShippingAllocationDraftAtomic === 'function')) {
        return Promise.resolve({ status: 'not_persisted', groupKey: g.groupKey, route: _irRouteLabel_(g),
            intent: _intent, instanceIds: _instanceIds, code: 'ROUTE_ATOMIC_WRITER_UNAVAILABLE',
            message: 'This build saves a route as one atomic header+line write, and the deployment does not ' +
                'provide upsertShippingAllocationDraftAtomic. Nothing was written, and no partial two-call ' +
                'save was attempted. Sync the Apps Script deployment, then save again.' });
    }

    var atomicBody = {
        header: header,
        lines: lines,
        // The create idempotency key travels at the TOP of the body as well as on the header, because the server
        // reads it from either: the header is where it is stored, the body is where a caller naturally puts it.
        create_idempotency_key: header.create_idempotency_key || undefined,
        expected_draft_version: header.expected_draft_version || undefined
    };
    return Promise.resolve(window.KM.DB.upsertShippingAllocationDraftAtomic(atomicBody)).then(function (hres) {
        if (!hres || hres.success === false) throw _irMakeDraftSaveError_(hres && hres.error, 'shipping_allocation_drafts', 'atomic route ticket write failed');
        // F1-7N-FB-2A §D — a bare success flag is NOT proof of persistence. Require the persisted primary key AND
        // the created/updated classification; anything less is a failed save, never a Saved one.
        var ack = _irSaveAcknowledged_(hres);
        if (!ack) throw _irMakeDraftSaveError_({ code: 'PERSISTENCE_NOT_ACKNOWLEDGED',
            message: 'The save response did not contain a persisted allocation_draft_id with a created/updated classification, so the row cannot be treated as persisted.' },
            'shipping_allocation_drafts', 'draft header upsert unacknowledged');
        draftIdSeen = ack.allocation_draft_id;
        // F1-7N-FB-4D §B4 — DID THE SERVER RESOLVE THE HEADER WE ASKED ABOUT? 16_ now returns the group key it
        // stored. If it names a DIFFERENT shipment group than this route's, the header is real but it is not
        // this route's header, and binding this route's rows to it would hand one route another's identity.
        // That is not a failure to write and not a success either — it is genuinely indeterminate, which is the
        // state that blocks Submit until a scoped readback settles it (§A2.11). Absent key → older deployment,
        // tolerated, and the draft-id scope still applies.
        serverGroupKey = String((hres.data && hres.data.route_group_key) || '').trim();
        if (serverGroupKey && String(g.groupKey || '').trim() && serverGroupKey !== String(g.groupKey).trim()) {
            var gkErr = new Error('the header the server resolved belongs to a different shipment group than this route');
            gkErr.structured = { code: 'ROUTE_GROUP_KEY_MISMATCH', message: gkErr.message,
                requested_group_key: String(g.groupKey), server_group_key: serverGroupKey,
                allocation_draft_id: draftIdSeen };
            throw gkErr;
        }
        // ONE response now carries both halves: there is no second request to issue.
        return hres;
    }).then(function (lres) {
        if (!lres || lres.success === false) throw _irMakeDraftSaveError_(lres && lres.error, 'shipping_allocation_draft_lines', 'atomic route ticket write failed');
        // §D.9 — adopt only into THIS header's rows. F1-7N-FB-4G-A2-R3-R1: BIND THE ROWS TO THE HEADER FIRST.
        //
        // These two ran the other way round, and for a CREATE that made the adoption a no-op:
        // _irAdoptPersistedLineIds_ keeps only rows whose allocation_draft_id already equals this header, and a
        // route + Add Route just created has no header id until _irStampRouteGroupIds_ puts one there. So a new
        // route ended up holding a draft id and NO line id — routeIsPersisted stays false, A2-R1's dirty guard
        // blocks Submit over a route that IS saved, and the next save sends an UPDATE with no line identity,
        // which writes a SECOND line under the same header. Stamping first makes the cross-header guard do
        // exactly what it was written for: this group's rows are in, every other header's rows are out.
        try { _irStampRouteGroupIds_(sku, g, draftIdSeen, (lres.data && lres.data.draft_version)); } catch (eS) {}
        try { _irAdoptPersistedLineIds_(sku, draftIdSeen, (lres.data && lres.data.persisted_lines) || [], serverGroupKey || g.groupKey); } catch (eA) {}
        // keep the legacy single-id field pointing at a real persisted header for older readers
        replenAllocationDraft.allocationDraftId = draftIdSeen;
        // Remember EVERY header this station has written. A row that later becomes incomplete drops its own
        // allocation_draft_id, so without this list a second header would be orphaned as an active empty draft
        // the moment its last route was cleared.
        if (!replenAllocationDraft.allocationDraftIds) replenAllocationDraft.allocationDraftIds = [];
        if (replenAllocationDraft.allocationDraftIds.indexOf(draftIdSeen) === -1) replenAllocationDraft.allocationDraftIds.push(draftIdSeen);
        return { status: 'persisted', groupKey: g.groupKey, allocation_draft_id: draftIdSeen, route: _irRouteLabel_(g),
            intent: _intent, instanceIds: _instanceIds,
            // §F.4 — CREATE_REPLAYED means an earlier attempt of this same click had already committed and the
            // server returned ITS ids with zero further writes. It is a SUCCESS, and it is not a second ticket.
            outcome: String((lres.data && lres.data.outcome) || ''),
            create_idempotency_key: String((lres.data && lres.data.create_idempotency_key) || header.create_idempotency_key || ''),
            draft_version: String((lres.data && lres.data.draft_version) || ''),
            line_count: (g.routes || []).length,
            server_group_key: serverGroupKey,
            verification: (lres.data && lres.data.verification) || null,
            persisted_headers: (lres.data && lres.data.persisted_headers) || [],
            persisted_lines: (lres.data && lres.data.persisted_lines) || [] };
    })['catch'](function (err) {
        var st = (err && err.structured) || {};
        var code = String(st.code || (err && err.code) || 'SAVE_FAILED');
        // §D.7 — a write whose outcome is genuinely unknown must not be reported as "not persisted". A transport
        // failure or a timeout may have committed on the server; only a refusal the server itself named is a
        // proven zero-write. The execution key is the group key, so a reconcile retry is idempotent.
        // FB-4D §B4 — ROUTE_GROUP_KEY_MISMATCH is INDETERMINATE, not not_persisted: a header was resolved and a
        // row may well exist, just not under the identity this route believes it owns. Only a scoped readback can
        // settle that, so Submit must stay blocked rather than trust either reading.
        var INDETERMINATE = { REQUEST_TIMEOUT_WRITE_INDETERMINATE: 1, HTTP_TRANSPORT_ERROR: 1, LINE_OUTPUT_VERIFICATION_FAILED: 1, PERSISTENCE_NOT_ACKNOWLEDGED: 1, ROUTE_GROUP_KEY_MISMATCH: 1 };
        return { status: INDETERMINATE[code] ? 'indeterminate' : 'not_persisted', groupKey: g.groupKey,
            allocation_draft_id: draftIdSeen, route: _irRouteLabel_(g), code: code,
            intent: _intent, instanceIds: _instanceIds,
            server_group_key: serverGroupKey,
            // §F2.3/§F2.4 — the two identities a lost response is settled by, carried on the outcome so the
            // reconciler never has to guess which request this was. The create key is the route INSTANCE id,
            // so a retry of the same click reuses it and cannot mint a second ticket.
            create_idempotency_key: String(header.create_idempotency_key || ''),
            expected_draft_version: String(header.expected_draft_version || ''),
            message: String(st.message || (err && err.message) || err) };
    });
}

// §D.6 — the operator-facing envelope for a pre-flight refusal. Nothing was written.
function _irRouteGroupConflictEnvelope_(sku, conflicts) {
    var c = (conflicts && conflicts[0]) || {};
    var msg, next;
    if (c.code === 'ROUTE_QUANTITY_CONFLICT') {
        msg = 'The same route was entered twice for ' + sku + ' with two different quantities (' +
            c.first_planned_qty + ' and ' + c.duplicate_planned_qty + '). One route carries one quantity, and there is ' +
            'no safe way to choose between them.';
        next = 'Delete one of the duplicated route rows, or make both quantities the same. Nothing was written to the database.';
    } else if (c.code === 'ROUTE_IDENTITY_NOT_PERSISTABLE') {
        msg = 'Two of these routes differ only in a value the Execution Plan header does not store, so both would ' +
            'be saved as the SAME shipment group and one quantity would be lost.';
        next = 'Give the routes different From / To / Method values, or enter them in separate Submit cycles. Nothing was written to the database.';
    } else {
        msg = 'The Execution Plan routes for ' + sku + ' could not be resolved into shipment groups.';
        next = 'Review the routes for this SKU. Nothing was written to the database.';
    }
    return {
        structured: { code: c.code || 'ROUTE_PREFLIGHT_FAILED', reasonCode: c.code || 'ROUTE_PREFLIGHT_FAILED',
            table: 'shipping_allocation_draft_lines', zeroWrite: 'true', retryable: false,
            message: msg, nextAction: next, conflicts: conflicts || [] },
        message: (c.code || 'ROUTE_PREFLIGHT_FAILED') + ' — ' + msg + ' NOT SAVED TO DB.'
    };
}

// §D.7 — per-route persisted / not_persisted / indeterminate, never a single ambiguous SAVE_FAILED.
function _irMultiRouteOutcomeEnvelope_(sku, outcomes) {
    var ok = outcomes.filter(function (o) { return o.status === 'persisted'; });
    var no = outcomes.filter(function (o) { return o.status === 'not_persisted'; });
    var un = outcomes.filter(function (o) { return o.status === 'indeterminate'; });
    // F1-7N-FB-4G-A2-R2 §6 - NAME THE ROUTE INSTANCE, NOT A POSITION.
    //
    // The operator was shown "NOT SAVED: CN侑鑫 → Amazon / sea" for a row they had entered as
    // CN侑鑫 → Amazon / air / 120. This label is built from the FIRST route of a canonical GROUP, and a group
    // is keyed by natural key - so which DOM row a failure belonged to was not recoverable from the message at
    // all. Every outcome now carries the stable client_route_instance_id(s) it was built from, and the label
    // carries the intent, so a refusal can be attached to the row that caused it.
    function list(a) {
        return a.map(function (o) {
            return '  · ' + o.route + (o.intent ? (' [' + o.intent + ']') : '') +
                ((o.instanceIds && o.instanceIds.length) ? (' {' + o.instanceIds.join(',') + '}') : '') +
                (o.code ? (' \u2014 ' + o.code) : '');
        }).join(String.fromCharCode(10));
    }
    var parts = [];
    if (ok.length) parts.push('SAVED (' + ok.length + '):' + String.fromCharCode(10) + list(ok));
    if (no.length) parts.push('NOT SAVED (' + no.length + '):' + String.fromCharCode(10) + list(no));
    if (un.length) parts.push('OUTCOME UNKNOWN (' + un.length + ') — may or may not have been written:' + String.fromCharCode(10) + list(un));
    var first = (no[0] || un[0] || {});
    return {
        structured: {
            code: first.code || 'ROUTE_GROUP_PARTIAL_FAILURE', reasonCode: 'ROUTE_GROUP_PARTIAL_FAILURE',
            table: 'shipping_allocation_draft_lines', retryable: true,
            message: outcomes.length + ' route(s) for ' + sku + ': ' + ok.length + ' saved, ' + no.length +
                ' not saved, ' + un.length + ' unknown.' + String.fromCharCode(10) + parts.join(String.fromCharCode(10)),
            nextAction: un.length
                ? 'Do NOT re-enter the unknown route by hand. Press Search to reload from the database and see which routes are actually stored, then correct only what is missing — a repeat of the same route updates the same row rather than adding one.'
                : 'Correct and re-save the routes listed as NOT SAVED. Routes already saved are unaffected.',
            outcomes: outcomes
        },
        message: 'ROUTE_GROUP_PARTIAL_FAILURE — ' + ok.length + '/' + outcomes.length + ' route(s) saved for ' + sku + '.'
    };
}

// F1-7N-FB-4F-B6 §F — WHICH GROUPS ARE ADOPTIONS OF AN EXISTING RECORD.
//
// A route the DATABASE returned with no destination, which the operator has now given one, is not an ordinary
// edit: saving it takes over an existing stored header — keeping its id, its lines and its quantity — and gives
// it the destination it never had. That is a migration of a live row, so it is the one save on this page that
// must be confirmed explicitly before any request is issued. `destination_state` is carried from the hydrate
// through the DOM (data-dest-state) and back out of the collect, so this asks about what was PERSISTED rather
// than re-deriving it from the current selection.
function _irAdoptionGroupsNeedingConfirmation_(groups) {
    var out = [];
    (groups || []).forEach(function (g) {
        var needs = (g.routes || []).some(function (r) {
            return r && (r.destination_state === 'DESTINATION_CONFIRMATION_REQUIRED' ||
                         r.destination_state === 'DESTINATION_AMBIGUOUS');
        });
        if (needs) out.push(g);
    });
    return out;
}
// The exact facts §F.3 requires the operator to see. Quantity is the SUM of the group's routes, because the
// group is one header and that is what the header will hold.
function _irAdoptionConfirmationDetail_(g) {
    var h = (g && g.header) || {};
    var routes = (g && g.routes) || [];
    var r0 = routes[0] || {};
    var qty = 0;
    routes.forEach(function (r) { qty += Number(r.planned_qty != null ? r.planned_qty : r.qty) || 0; });
    var eta = '';
    routes.forEach(function (r) { if (!eta && r && String(r.expected_arrival || '').trim()) eta = String(r.expected_arrival).trim(); });
    return {
        from: r0.ship_from || h.recommended_source_warehouse_id || '',
        to: r0.destination || r0.destination_marketplace || h.recommended_destination_warehouse_id || '',
        method: h.recommended_shipping_method || r0.shipping_method || '',
        qty: qty,
        expected_arrival: eta,
        allocation_draft_id: String(r0.allocation_draft_id || '').trim()
    };
}
// §F.4 — EXPLICIT means explicit. No confirm function reachable is NOT consent: it returns false, and the
// caller writes nothing at all rather than proceeding on the assumption that the operator would have agreed.
function _irConfirmLegacyAdoption_(g) {
    if (!(window.IRDraft && typeof window.IRDraft.buildLegacyAdoptionConfirmation === 'function')) return false;
    var built = window.IRDraft.buildLegacyAdoptionConfirmation(_irAdoptionConfirmationDetail_(g));
    if (typeof window.confirm !== 'function') return false;
    return window.confirm(built.text) === true;
}
window._irAdoptionGroupsNeedingConfirmation_ = _irAdoptionGroupsNeedingConfirmation_;
window._irAdoptionConfirmationDetail_ = _irAdoptionConfirmationDetail_;
window._irConfirmLegacyAdoption_ = _irConfirmLegacyAdoption_;

// F1-7N-FB-4F-B6 §I — ROUTES THAT PLAN QUANTITY WITH NOWHERE TO SEND IT.
// Before B6 this could not happen on screen, because the hydrate synthesised a destination for every route; now
// a destination-less legacy row comes back honestly, so Submit needs its own named refusal. Reported per route,
// with the SKU, so the operator can go and confirm each one rather than being told "something is wrong".
function _irRoutesMissingDestination_() {
    var out = [];
    try {
        var bySku = (replenAllocationDraft && replenAllocationDraft.bySku) || {};
        Object.keys(bySku).forEach(function (sku) {
            (bySku[sku] || []).forEach(function (r) {
                if (!r) return;
                var qty = Number(r.planned_qty != null ? r.planned_qty : r.qty) || 0;
                if (qty <= 0) return;
                // F1-7N-FB-4G-A0-R2 — this asked "is EITHER field set" and returned, so a route carrying BOTH
                // — the one shape that most needs saying out loud — was the one shape it never reported. The
                // question is whether the route HAS a canonical destination, and BOTH does not.
                var _d = (window.IRWarehouse && typeof window.IRWarehouse.destinationIdentity === 'function')
                    ? window.IRWarehouse.destinationIdentity(r)
                    : null;
                var wid = String(r.destination_warehouse_id == null ? '' : r.destination_warehouse_id).trim();
                var mkt = String(r.destination_marketplace == null ? '' : r.destination_marketplace).trim();
                var okDest = _d ? _d.ok : ((!!wid) !== (!!mkt));
                if (okDest) return;
                out.push({ sku: sku, qty: qty, allocation_draft_id: String(r.allocation_draft_id || '').trim(),
                    shipping_method: String(r.shipping_method || '').trim(),
                    // The typed reason, so "confirm a destination" and "these two contradict" are different
                    // sentences rather than one vague one.
                    destination_code: _d ? _d.code : (wid && mkt ? 'ROUTE_DESTINATION_AMBIGUOUS' : 'ROUTE_DESTINATION_MISSING'),
                    destination_state: String(r.destination_state || '') });
            });
        });
    } catch (e) {}
    return out;
}
window._irRoutesMissingDestination_ = _irRoutesMissingDestination_;

// The actual DB sync for one SKU: soft-cancel any queued now-invalid lines, then upsert the header +
// the COMPLETE line set (or cancel the header if nothing valid remains). Called by the debounced flush.
function _flushDraftDbPersist(sku) {
    try {
        var cancels = _pendingDraftCancels[sku] || []; _pendingDraftCancels[sku] = [];
        // F1-7N-FB-4G-A2-R3 §D/§E.6 — the ATOMIC writer is what a route ticket is written with now, so it is
        // what this guard requires. The two-call entry points are still needed for the LIFECYCLE operations
        // beside it (soft-cancelling an empty header, soft-cancelling a line), which carry no route intent.
        if (!(window.KM && window.KM.DB && window.KM.DB.upsertShippingAllocationDraftAtomic &&
              window.KM.DB.upsertShippingAllocationDraftLines && window.IRDraft)) return;
        if (typeof isOperationDbApiConfigured === 'function' && !isOperationDbApiConfigured()) return; // headless → cache only
        if (_draftDbInFlight[sku]) { _draftDbDirty[sku] = true; if (cancels.length) _pendingDraftCancels[sku] = (_pendingDraftCancels[sku] || []).concat(cancels); return; }

        var ctx = _replenCtx();
        var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
        // F1-7N-FB-4G-A2-R2 §3 - EVENT SCOPE. Only the routes this event actually changed are candidates for
        // a write. Everything else on screen is left exactly as the database holds it, which is what makes a
        // single-row operation incapable of producing a cross-route partial failure.
        var _touched = _irTouchedInstances_(sku);
        var _touchedSet = {}; _touched.forEach(function (k) { _touchedSet[k] = 1; });
        // F1-7N-FC-1B-E3-R2 §A/§B.1 — A COMPOSER IS NOT IN THE WRITE SCOPE, IN EITHER BRANCH.
        //
        // MEASURED on the shipped flush, and this is the whole mechanism of the false red error. The collector
        // deliberately does NOT mark a composer touched (it has nothing to update and nothing to create), so
        // when the operator's only edit is IN the composer the touched set is EMPTY — and the empty-set
        // fallback below widens the scope to every row on screen, which is how the row that was excluded
        // upstream came back downstream and landed in `_incomplete`. Zero writes, and a full red
        // "database update failed" panel with Technical details and "Retryable: yes".
        //
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §3 — THE FALLBACK IS GONE. An empty touched set used to widen the
        // scope to EVERY row on screen, on the reasoning that `_persistAllocationDraftToDb` (the AI Plan and
        // older callers) schedules a flush without marking anything. That made "which routes did this event
        // change?" answerable two ways, and the weaker answer was reachable from any caller that forgot to
        // mark — including one that had nothing to write at all. An empty intent set is now literally empty:
        // no dirty route, no request. The legacy callers DECLARE their scope instead (see
        // `_persistAllocationDraftToDb`), so the widening still happens where it is wanted and is now a
        // statement someone made rather than a consequence of a missing one.
        var _scoped = rows
            .filter(function (r) { return _touchedSet[String(r.client_route_instance_id || '')]; })
            .filter(function (r) { return !(_irIsComposerRow_(r) && !_isRouteComplete(r)); });
        // R6-R6 §7 — A ROUTE UNDER AN ACK_UNKNOWN HOLD IS NOT A WRITE CANDIDATE, IN EITHER BRANCH.
        // Filtered here rather than at the call sites for the reason R2 gave for the composer: two statements
        // that must agree are better as one statement. Note this also covers the empty-touched-set fallback,
        // which widens the scope to every row on screen — the exact path by which a held route would have been
        // re-sent by an edit that had nothing to do with it.
        var _held = _scoped.filter(function (r) { return _irAckUnknownIsHeld_(sku, r.client_route_instance_id); });
        _scoped = _scoped.filter(function (r) { return !_irAckUnknownIsHeld_(sku, r.client_route_instance_id); });
        if (_held.length) {
            _irSetRouteSaveState_(sku, _held.map(function (r) { return String(r.client_route_instance_id || ''); }),
                'OUTCOME_UNKNOWN');
            console.warn('[replen] ' + _held.length + ' route(s) held at ACK_UNKNOWN — not re-sent; ' +
                'operator review required (window._irReleaseAckUnknown_).');
        }
        var complete = _scoped.filter(_isRouteComplete);
        // F1-7N-FB-4G-A2-R4 §G.8 — A DIRTY BUT INCOMPLETE ROUTE IS NAMED, NEVER SILENTLY SKIPPED.
        //
        // An edit that leaves the route incomplete — the Method cleared by a From change is the everyday case —
        // is correctly NOT written (§F.4: an incomplete UPDATE must never be sent). But it was then dropped in
        // silence, so the operator saw a change they had made produce no request, no error and no state: the
        // "silent no-write" in the report. The route keeps its identity, its edit and its place in the queue;
        // what changes is that it says so.
        var _incomplete = _scoped.filter(function (r) { return !_isRouteComplete(r); });
        // F1-7N-FC-1B-E3-R2 §B.2 — A TOUCHED COMPOSER STILL SAYS SOMETHING, and it is computed from the
        // WHOLE row set rather than from the write scope: a composer's state does not depend on which OTHER row
        // an event happened to touch. Before R2 a touched composer beside a route the operator had edited was
        // filtered out and then said NOTHING AT ALL (measured: no state, no message), while the same composer
        // alone produced the red panel. One row, two opposite answers, decided by an unrelated row.
        // A PRISTINE composer is excluded here and stays silent (§B.1): it is furniture.
        var _hintRows = rows.filter(function (r) {
            return _irIsComposerRow_(r) && !_isRouteComplete(r) && r.composer_touched === true;
        }).concat(_incomplete);
        if (_hintRows.length) {
            _hintRows.forEach(function (r) {
                // §B — `INCOMPLETE`, not `NOT_SAVED`. Nothing was attempted, so there is no outcome to
                // report; a badge claiming one is the red panel's sentence in miniature.
                _irSetRouteSaveState_(sku, [String(r.client_route_instance_id || '')], 'INCOMPLETE');
            });
            if (typeof _irShowRouteStateHint_ === 'function') {
                _irShowRouteStateHint_(sku, _irIncompleteRouteNotice_(sku, _hintRows));
            }
        } else if (typeof _irHideRouteStateHint_ === 'function') {
            _irHideRouteStateHint_(sku);
        }
        // F1-7N-FB-4G-A2-R2 §7 - A MULTI-LINE HEADER IS NOT SILENTLY RE-ROUTED. From/To/Method live on the
        // HEADER, so changing one of them on a header several SKUs share would move every one of those lines.
        // The Execution Plan shows one SKU at a time and cannot express that, so it BLOCKS and discloses
        // rather than deciding for the operator. Splitting the票 is a future MOVE_LINE/SPLIT_ROUTE operation
        // and is deliberately NOT improvised here.
        var _mlBlock = (typeof _irMultiLineHeaderBlock_ === 'function') ? _irMultiLineHeaderBlock_(sku, complete) : null;
        if (_mlBlock) {
            if (typeof _irShowDraftSaveError === 'function') _irShowDraftSaveError(sku, _mlBlock);
            if (typeof _irMarkRouteUnsaved_ === 'function') _irMarkRouteUnsaved_(sku, _mlBlock);
            if (cancels.length) _pendingDraftCancels[sku] = (_pendingDraftCancels[sku] || []).concat(cancels);
            return;   // ZERO WRITE - no request issued
        }

        // A queued cancel now carries the header it belongs to. Under multi-route there is no single "the"
        // draft id, so a cancel that did not name its own header could soft-cancel a line under the wrong one.
        // Bare strings are still accepted for back-compat and fall back to this SKU's most recent header.
        function _normCancel(c) {
            if (!c) return null;
            if (typeof c === 'string') return { line_id: c, allocation_draft_id: '' };
            return { line_id: String(c.line_id || ''), allocation_draft_id: String(c.allocation_draft_id || '') };
        }
        cancels = cancels.map(_normCancel).filter(function (c) { return c && c.line_id; });

        // No valid line left → never keep an empty header (§5.3). Cancels are dispatched first so the lines
        // are released before their headers are.
        if (!complete.length) {
            _irDispatchLineCancels_(sku, cancels, complete);
            _irCancelUnusedDraftHeaders_(sku);
            return;
        }

        // F1-7N-FB-4B-ADDENDUM §D.1-§D.6 — RESOLVE AND PRE-FLIGHT THE WHOLE BATCH BEFORE THE FIRST WRITE.
        //
        // This used to refuse the SKU outright when it held more than one route context. The refusal reasoned
        // correctly from the frozen K2 contract (a Header is ONE shipment group, so two routes can never be two
        // lines under one header) and then drew the wrong conclusion: two routes are TWO HEADERS. `+ Add Route`
        // is a real feature, so a second route must CREATE its own canonical header — never be rejected.
        //
        // Grouping is the client mirror of the server's 10-dimension K2 group key, so the partition computed here
        // is exactly the set of headers sadResolveActiveDraftK2OrK3_ will resolve. A pre-flight failure returns
        // before any request is issued, which is what makes the zero-write claim true rather than hopeful.
        var pf = window.IRDraft.preflightRouteGroups(ctx, sku, complete);
        if (!pf.ok) {
            var c0 = pf.conflicts[0] || {};
            var envelope = _irRouteGroupConflictEnvelope_(sku, pf.conflicts);
            if (typeof _irShowDraftSaveError === 'function') _irShowDraftSaveError(sku, envelope);
            if (typeof _irMarkRouteUnsaved_ === 'function') _irMarkRouteUnsaved_(sku, envelope);
            console.warn('[replen] route pre-flight refused (zero rows written):', c0.code, c0.detail);
            // A soft-cancel is itself a business write, so the queued cancels are PUT BACK rather than dispatched.
            // That is what makes "nothing was written" literally true for a pre-flight refusal.
            if (cancels.length) _pendingDraftCancels[sku] = (_pendingDraftCancels[sku] || []).concat(cancels);
            return;   // ZERO WRITE — no request was issued
        }

        // F1-7N-FB-4F-B6 §F.3/§F.4 — CONFIRM BEFORE MUTATING AN EXISTING RECORD, and place the question HERE:
        // ahead of the stale-group cancels and ahead of the line-cancel dispatch, both of which are themselves
        // business writes. Asking after them would make "cancelling writes nothing" false.
        var _adoptApproved = {};
        var _adoptGroups = _irAdoptionGroupsNeedingConfirmation_(pf.groups);
        for (var _ai = 0; _ai < _adoptGroups.length; _ai++) {
            if (!_irConfirmLegacyAdoption_(_adoptGroups[_ai])) {
                // §F.4 — ZERO REQUEST, ZERO WRITE. The queued cancels are put back exactly as the pre-flight
                // refusal above puts them back, so nothing at all happened.
                if (cancels.length) _pendingDraftCancels[sku] = (_pendingDraftCancels[sku] || []).concat(cancels);
                console.warn('[replen] legacy adoption NOT confirmed — zero rows written, zero requests issued');
                return;
            }
            _adoptApproved[_adoptGroups[_ai].groupKey] = true;
        }

        // A route whose From/To/Method changed now belongs to a DIFFERENT header. Its line under the OLD header
        // is not migrated (that would re-key an identity); it is soft-cancelled so the plan cannot be counted
        // twice — once under the header it left and once under the header it joined.
        _irQueueStaleGroupCancels_(sku, pf.groups);
        cancels = cancels.concat((_pendingDraftCancels[sku] || []).map(_normCancel).filter(Boolean));
        _pendingDraftCancels[sku] = [];
        _irDispatchLineCancels_(sku, cancels, complete);

        _draftDbInFlight[sku] = true;
        // §G.1/§G.2 — the batch has begun: hold the write actions and mark every route it covers as Saving.
        try { _irSaveBusySync_(); } catch (eB) {}
        try {
            pf.groups.forEach(function (g0) {
                _irSetRouteSaveState_(sku, (g0.routes || []).map(function (r0) { return String((r0 && r0.client_route_instance_id) || ''); }), 'SAVING');
            });
        } catch (eS0) {}
        // §D.3/§D.4 — each canonical group resolves/creates ITS OWN header and upserts ITS OWN line under it.
        // Groups are written in sequence, never concurrently: two headers of one station are resolved by the same
        // server-side group authority, and overlapping writes would race that resolution.
        var outcomes = [];
        var chain = Promise.resolve();
        pf.groups.forEach(function (g) {
            chain = chain.then(function () { return _irPersistOneRouteGroup_(sku, ctx, g, _adoptApproved[g.groupKey] === true); })
                .then(function (o) { outcomes.push(o); });
        });
        // §F2.3 — before ANY of this is reported, a lost response is settled against the database. The
        // reconciler is read-only and runs once for the whole batch.
        return chain.then(function () {
            // §G.2 — a lost response is being settled against the database, and the operator is told so
            // rather than being shown a bare failure while the answer is still being fetched.
            outcomes.forEach(function (o) {
                if (o && o.status === 'indeterminate') _irSetRouteSaveState_(sku, o.instanceIds, 'RECONCILING');
            });
            return _irReconcileIndeterminate_(sku, outcomes);
        }).then(function () {
            _draftDbInFlight[sku] = false;
            outcomes.forEach(function (o) {
                if (!o) return;
                _irSetRouteSaveState_(sku, o.instanceIds,
                    o.status === 'persisted' ? 'SAVED' : (o.status === 'indeterminate' ? 'OUTCOME_UNKNOWN' : 'NOT_SAVED'));
                // R6-R6 §7 — the hold goes on for exactly the routes the read-back could NOT classify, and
                // comes off for every route it could, in either direction. A route proven unsaved is a known
                // zero-write and stays freely retryable; only ambiguity stops the line.
                if (o.status === 'indeterminate') _irHoldAckUnknown_(sku, o);
                else _irClearAckUnknown_(sku, o.instanceIds);
            });
            try { _irSaveBusySync_(); } catch (eB2) {}
            // §D.7 — report PER ROUTE. A single bare SAVE_FAILED across a multi-header write is exactly the
            // ambiguity that leaves an operator unable to tell which route reached the database.
            // F1-7N-FB-4G-A2-R2 §3 - a route leaves the touched set only when its OWN write is persisted. A
            // route that failed or whose outcome is unknown stays touched, so it is retried on the next flush
            // and never quietly dropped - and it is still the ONLY route that will be sent.
            outcomes.forEach(function (o) {
                if (o.status !== 'persisted') return;
                (o.instanceIds || []).forEach(function (k) {
                    if (_draftDbTouched[sku]) delete _draftDbTouched[sku][k];
                });
            });
            var bad = outcomes.filter(function (o) { return o.status !== 'persisted'; });
            if (!bad.length) {
                _irClearRouteUnsaved_(sku);
                if (typeof _irHideDraftSaveError === 'function') _irHideDraftSaveError(sku);
            } else {
                var env = _irMultiRouteOutcomeEnvelope_(sku, outcomes);
                _irMarkRouteUnsaved_(sku, env);
                if (typeof _irShowDraftSaveError === 'function') _irShowDraftSaveError(sku, env);
                console.warn('[replen] one or more routes did NOT persist:', env.structured.message);
            }
            try { _persistAllocationDraft(); } catch (eP) {}
            // A coalesced edit gets one more write — but ONLY if something is still actually dirty. A save
            // clicked three times in a row leaves the dirty flag set with nothing left touched, and this used
            // to re-enter the flush, where an empty touched set falls back to EVERY route on screen and
            // re-sends routes the operator never edited. That is the A2-R2 whole-SKU re-send, reached through
            // the back door.
            if (_draftDbDirty[sku]) {
                _draftDbDirty[sku] = false;
                if (_irTouchedInstances_(sku).length) _flushDraftDbPersist(sku);
            }
        })['catch'](function (err) {
            _draftDbInFlight[sku] = false;
            // The batch is over however it ended, so the write actions are released.
            try { _irSaveBusySync_(); } catch (eB3) {}
            _irMarkRouteUnsaved_(sku, err);
            if (typeof _irShowDraftSaveError === 'function') _irShowDraftSaveError(sku, err);
            console.warn('[replen] Draft DB persistence FAILED:', err && err.message ? err.message : err);
        });
    } catch (e) { _draftDbInFlight[sku] = false; try { _irSaveBusySync_(); } catch (eB4) {} console.warn('[replen] Draft DB persistence error:', e); }
}
window._flushDraftDbPersist = _flushDraftDbPersist;

// Back-compat entry point (older callers / AI Plan): route through the debounced flush.
//
// R6-R2 §3 — IT DECLARES ITS SCOPE. This used to schedule a flush and mark nothing, and the flush's
// empty-touched-set fallback then wrote every complete route on screen. The behaviour is kept exactly
// (a caller that persists "the draft" means all of it) and is now SAID: the routes this call intends to
// write are marked as its intent, so the flush needs no rule about what an absence of intent means.
function _persistAllocationDraftToDb(sku) {
    try {
        ((replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || []).forEach(function (r) {
            if (!r || String(r.route_kind || '') === _irComposerKind_()) return;
            if (!_isRouteComplete(r)) return;
            _irMarkRouteTouched_(sku, r.client_route_instance_id);
        });
    } catch (e) { try { console.warn('[replen] draft persist scope declaration failed:', e); } catch (e2) {} }
    _scheduleDraftDbPersist(sku);
}
window._persistAllocationDraftToDb = _persistAllocationDraftToDb;

// F1-7N-FA-3C-R6E-P0 — normalize a raw save error (a plain string OR the structured envelope {code,message,details}
// from _kmCmdErr_) into a safe Error carrying a JSON-safe `.structured` view. This is what fixes the "[object Object]"
// message: the previous `new Error(hres.error)` stringified the envelope OBJECT via String() → "[object Object]".
function _irMakeDraftSaveError_(raw, table, fallbackMsg) {
    var info = (raw && typeof raw === 'object') ? raw : { message: (raw == null ? '' : String(raw)) };
    var det = (info && info.details) || {};
    var e = new Error(String(info.message || fallbackMsg || 'save failed'));
    var msg = String(info.message || fallbackMsg || 'save failed');
    var code = String(info.code || 'SAVE_FAILED');
    e.structured = {
        code: code,
        // F1-7N-FB-2A §E — the TYPED INNER REASON. `BUSINESS_COMMAND_ERROR` is not a backend reason at all: it
        // is the client's fallback label for a handler error string it has no code for, and the real reason has
        // always been sitting in `message` — which the previous UI rendered nowhere. The allocation-draft
        // handler can answer with a dozen typed reasons outside the canonical code list (ROUTE_INCOMPLETE_NEW_
        // DRAFT / LEGACY_ROUTE_RECONCILIATION_REQUIRED / K2_ROUTE_RECONCILIATION_REQUIRED, a lock-unavailable
        // stage, or a PRODUCTION_SAFETY:<schema token> thrown by the validate-only prodRequireSheet_ gate), so
        // the reason is extracted and shown instead of being thrown away.
        reasonCode: _irTypedReasonCode_(code, msg),
        table: String(det.table || det.affectedTable || table || ''),
        missingHeader: String(det.missingHeader || det.header || ''),
        missingFields: (det.missing && det.missing.join) ? det.missing.join(', ') : String(det.missingFields || ''),
        schemaMismatch: String(det.schemaStatus || det.schemaMismatch || ''),
        entityKey: String(det.existing_id || det.allocation_draft_id || ''),
        requestId: String(det.requestId || det.command || ''),
        // Zero-write is only claimed when the server said so, or when the reason is a documented pre-write
        // gate. It is never assumed from a generic failure.
        zeroWrite: (det.zero_write === true) || _irReasonIsPreWrite_(msg) ? 'true' : 'unknown',
        retryable: _irReasonRetryable_(code, msg),
        nextAction: _irReasonNextAction_(code, msg),
        message: msg
    };
    return e;
}
// Extract the handler's own typed token from the error text when the transport layer had no code for it. The
// canonical tokens are LEADING in the handler's error string, and PRODUCTION_SAFETY carries its token inline.
var IR_DRAFT_TYPED_REASONS_ = ['ROUTE_INCOMPLETE_NEW_DRAFT', 'LEGACY_ROUTE_RECONCILIATION_REQUIRED',
    'K2_ROUTE_RECONCILIATION_REQUIRED', 'PLAN_HEADER_INCOMPLETE', 'PLAN_LINE_INCOMPLETE', 'BLOCKED_CONFLICT',
    'IMMUTABLE_TERMINAL_STATUS', 'NO_ACTIVE_DRAFT', 'VERSION_CONFLICT', 'SOURCE_AVAILABLE_QTY_EXCEEDED',
    'PERSISTENCE_NOT_ACKNOWLEDGED',
    // F1-7N-FB-4B — identity/idempotency refusals the writer names.
    'DUPLICATE_LINE_IDENTITY_IN_BATCH', 'LINE_IDENTITY_CONFLICT', 'LINE_PRIMARY_KEY_ALREADY_EXISTS',
    'LINE_OUTPUT_VERIFICATION_FAILED',
    // F1-7N-FB-4B-ADDENDUM — multi-route group pre-flight refusals. MULTIPLE_ROUTE_CONTEXTS_UNSUPPORTED_PHASE1 is
    // deliberately GONE: several route contexts are several shipment groups, which is now persisted rather than
    // refused, so keeping the token would let a stale deployment's message re-type as a supported state.
    'ROUTE_IDENTITY_NOT_PERSISTABLE', 'ROUTE_QUANTITY_CONFLICT', 'ROUTE_GROUP_PARTIAL_FAILURE',
    // F1-7N-FB-4G-A2-R3-R1 §D — the route-ticket refusals A2-R3 introduced. This list is the SECOND place a
    // typed reason could be lost (the transport adapter's KM_CANONICAL_CODES was the first), and both were
    // stale in the same way: the server named its reason and the browser threw the name away.
    'ROUTE_INTENT_REQUIRED', 'ROUTE_INTENT_CONTRADICTORY', 'ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED',
    'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE', 'ROUTE_IDENTITY_MINT_FAILED', 'ROUTE_IDENTITY_CONTRACT_NOT_LOADED',
    'ALLOCATION_DRAFT_NOT_FOUND', 'ALLOCATION_DRAFT_SCHEMA_COLUMN_ABSENT', 'APPLIED_SCOPE_MISMATCH',
    'STALE_OPTIMISTIC_TOKEN', 'ROUTE_ATOMIC_WRITER_UNAVAILABLE', 'ROUTE_GROUP_KEY_MISMATCH',
    'ROUTE_IDENTITY_AMBIGUOUS', 'ROUTE_DESTINATION_MISSING', 'ROUTE_DESTINATION_AMBIGUOUS',
    'ROUTE_DESTINATION_UNRESOLVED'];
function _irTypedReasonCode_(code, message) {
    var m = String(message == null ? '' : message);
    var ps = m.match(/PRODUCTION_SAFETY:([A-Z_]+)/);
    if (ps) return 'PRODUCTION_SAFETY:' + ps[1];
    for (var i = 0; i < IR_DRAFT_TYPED_REASONS_.length; i++) {
        if (m.indexOf(IR_DRAFT_TYPED_REASONS_[i]) !== -1) return IR_DRAFT_TYPED_REASONS_[i];
    }
    if (/could not acquire lock/i.test(m)) return 'LOCK_UNAVAILABLE';
    if (/^lock error/i.test(m)) return 'LOCK_ERROR';
    return String(code || 'SAVE_FAILED');
}
// A documented pre-write gate proves ZERO rows were written; the handler states it explicitly.
function _irReasonIsPreWrite_(message) {
    var m = String(message == null ? '' : message);
    return /zero rows written/i.test(m) || /PRODUCTION_SAFETY:/.test(m) || /could not acquire lock/i.test(m);
}
function _irReasonRetryable_(code, message) {
    var r = _irTypedReasonCode_(code, message);
    if (r === 'LOCK_UNAVAILABLE' || r === 'LOCK_ERROR' || code === 'HTTP_TRANSPORT_ERROR' || code === 'NON_JSON_RESPONSE') return true;
    if (r.indexOf('PRODUCTION_SAFETY:') === 0) return false;      // a schema/target fault will not fix itself
    if (r === 'ROUTE_INCOMPLETE_NEW_DRAFT' || r === 'PLAN_HEADER_INCOMPLETE' || r === 'PLAN_LINE_INCOMPLETE') return true;   // fix the route, then retry
    if (r === 'LEGACY_ROUTE_RECONCILIATION_REQUIRED' || r === 'K2_ROUTE_RECONCILIATION_REQUIRED' ||
        r === 'BLOCKED_CONFLICT' || r === 'IMMUTABLE_TERMINAL_STATUS') return false;   // needs an explicit migration/decision
    return true;
}
function _irReasonNextAction_(code, message) {
    var r = _irTypedReasonCode_(code, message);
    if (r.indexOf('PRODUCTION_SAFETY:') === 0)
        return 'The database tab or its header row does not match the expected schema, so the write was refused before touching any cell. Run TEMP_SHIPPING_ALLOCATION_DRAFT_DIAGNOSE in the Apps Script editor — it reports the exact table and header difference read-only.';
    if (r === 'ROUTE_INCOMPLETE_NEW_DRAFT' || r === 'PLAN_HEADER_INCOMPLETE')
        return 'Complete the route (From + To + Method) on this Execution Plan row, then retry.';
    if (r === 'PLAN_LINE_INCOMPLETE') return 'Give the line a SKU and a quantity greater than zero, then retry.';
    if (r === 'LEGACY_ROUTE_RECONCILIATION_REQUIRED' || r === 'K2_ROUTE_RECONCILIATION_REQUIRED')
        return 'An existing Draft for this scope cannot be reconciled automatically. It needs an explicit user migration — it is never auto-healed or overwritten.';
    if (r === 'BLOCKED_CONFLICT') return 'More than one active Draft exists for this scope. Resolve the duplicate before saving.';
    if (r === 'IMMUTABLE_TERMINAL_STATUS') return 'This Draft is already submitted or cancelled and can no longer be edited.';
    if (r === 'LOCK_UNAVAILABLE' || r === 'LOCK_ERROR') return 'The database was briefly locked by another write. Retry in a moment — nothing was written.';
    if (r === 'PERSISTENCE_NOT_ACKNOWLEDGED') return 'The server did not confirm a persisted row id. Retry, then verify with TEMP_SHIPPING_ALLOCATION_DRAFT_DIAGNOSE before submitting.';
    if (code === 'HTTP_TRANSPORT_ERROR' || code === 'NON_JSON_RESPONSE')
        return 'The request never reached a working deployment. Verify the Apps Script deployment (system.health), then retry.';
    return 'Correct the route and retry. Nothing has been saved for this row.';
}
// F1-7N-FC-1B-E3-R2 §D.2 — THE NEUTRAL ROW-LOCAL LINE. ONE LINE, and everything the failure surface
// offers is deliberately absent: no reason code, no transport code, no affected table, no request id, no
// zero-write/retryable rows, no <details> disclosure. An operator who has not finished typing has nothing to
// diagnose, and offering a diagnosis is what made the state read as a fault.
//
// The sentence is composed from the §B state, not from a colour or a code:
//   TOUCHED_INCOMPLETE_COMPOSER      "Complete Qty and Method to save."   (a new route being typed)
//   PERSISTED_ROUTE_EDIT_INCOMPLETE  "... The saved version is unchanged." (a stored route mid-edit — the
//                                    reassurance is the point: the database still holds the last complete one)
// The missing FIELDS come from _irMissingRouteFields_, the same owner the Submit block and the save-time
// notice use, so the three can never disagree about what is missing.
function _irRouteHintSentence_(sku, err) {
    var s = (err && err.structured) || {};
    var states = (s.uiStates && s.uiStates.join) ? s.uiStates : [];
    var rows = (replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || [];
    var miss = {}, n = 0;
    rows.forEach(function (r) {
        if (typeof _isRouteComplete === 'function' && _isRouteComplete(r)) return;
        if (typeof _irMissingRouteFields_ !== 'function') return;
        var st = _irRouteUiState_(r);
        if (st === 'PRISTINE_COMPOSER') return;                 // furniture says nothing (§B.1)
        if (typeof _irRouteUiStateIsFailure_ === 'function' && _irRouteUiStateIsFailure_(st)) return;
        _irMissingRouteFields_(r).forEach(function (f) { miss[f] = 1; });
        n++;
    });
    if (!n) return '';
    var fields = Object.keys(miss);
    var persisted = states.indexOf('PERSISTED_ROUTE_EDIT_INCOMPLETE') !== -1;
    // Read aloud: "From, To and Qty", not "From and To and Qty". Four missing fields is the everyday case
    // for a composer the operator has only just started typing in, so this is not a rare shape.
    var list = fields.length <= 1 ? (fields[0] || '')
      : fields.slice(0, -1).join(', ') + ' and ' + fields[fields.length - 1];
    var what = fields.length ? ('Complete ' + list + ' to save.') : 'Complete this route to save.';
    return persisted ? (what + ' The saved version is unchanged.') : what;
}
function _irShowRouteStateHint_(sku, err) {
    var el = document.getElementById('allocation-route-hint-' + sku);
    if (!el) return false;
    var line = _irRouteHintSentence_(sku, err);
    if (!line) { _irHideRouteStateHint_(sku); return false; }
    var esc = (typeof _execEsc === 'function') ? _execEsc : function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
    el.innerHTML = esc(line);
    el.style.display = 'block';
    return true;
}
window._irShowRouteStateHint_ = _irShowRouteStateHint_;
function _irHideRouteStateHint_(sku) {
    var el = document.getElementById('allocation-route-hint-' + sku);
    if (!el) return false;
    el.innerHTML = ''; el.style.display = 'none';
    return true;
}
window._irHideRouteStateHint_ = _irHideRouteStateHint_;

// F1-7N-FC-1B-E3-R2 §E — READ-TIMEOUT DIAGNOSIS, ON DEMAND, OVER RECORDS THAT ALREADY EXIST.
//
// The live report is one 60s timeout on the first inventory read and a successful second Search. Four readings
// fit that and they have four different owners, so the reading is CLASSIFIED rather than assumed. This is the
// caller: it hands the transport's own bounded sample list to the pure classifier and returns the verdict.
//
// It changes nothing about the request path — no bound, no retry count, and it never presents a cached
// answer as a fresh one. It reads `KM.transport.metrics().samples`, which the transport keeps whether anyone
// asks or not (400 entries max; action, kind, code, phase, ms — no URL, no payload, no row).
//
// Called from the console after a slow load: `_irReadTimeoutDiagnosis_()`, or with an action to narrow it.
function _irReadTimeoutDiagnosis_(action) {
    var out = { available: false, classification: 'NO_SAMPLES', reads: 0, timeouts: 0 };
    try {
        if (!(window.KM && window.KM.transport && typeof window.KM.transport.metrics === 'function')) {
            out.classification = 'TRANSPORT_METRICS_UNAVAILABLE';
            return out;
        }
        if (!(window.IRReadTimeoutDiagnostic && typeof window.IRReadTimeoutDiagnostic.classify === 'function')) {
            out.classification = 'CLASSIFIER_UNAVAILABLE';
            return out;
        }
        var samples = (window.KM.transport.metrics() || {}).samples || [];
        var r = window.IRReadTimeoutDiagnostic.classify(samples, action);
        r.available = true;
        return r;
    } catch (e) {
        out.classification = 'DIAGNOSIS_THREW';
        out.error = (e && e.message) ? String(e.message) : String(e);
        return out;
    }
}
window._irReadTimeoutDiagnosis_ = _irReadTimeoutDiagnosis_;

// F1-7N-FC-1B-E3-R3-R1 §8 — PER-STAGE MEASUREMENT FOR THE RECURRING FIRST-ATTEMPT TIMEOUT.
//
// THE STATUS CHANGED, SO THE REPORT MUST. This was carried as NOT REPRODUCED; it has now been observed
// repeatedly across acceptance rounds in the same shape — the FIRST entry into Site Inventory times out
// at the 60s client bound, the second read succeeds, and every read after that succeeds. That is
// RECURRING_FIRST_ATTEMPT_TIMEOUT with SUCCESS_AFTER_RETRY, and it is NOT the forecast gap: the forecast is a
// server-side data question and this is a first-request latency question, with no causal path between them.
//
// WHAT THIS ADDS IS MEASUREMENT AND NOTHING ELSE. No bound is raised, no retry is added, and nothing cached is
// ever presented as a fresh answer. "Cold start" is a HYPOTHESIS, and the point of measuring per stage is to
// find out whether it survives contact with the numbers: a cold Apps Script container, a first-call
// authorization round trip, an unwarmed cache table, a redirect that only the first request follows, and a
// concurrency pile-up all produce the same one-line symptom and need different fixes.
//
// It reads what the transport ALREADY records (bounded at 400 samples: action, kind, code, phase, ms — no
// URL, no payload, no row) plus one page-boot mark taken here. Server execution time is NOT available: the
// transport records client elapsed only, so it is reported as null rather than estimated from the client
// number, which would be a guess wearing a measurement's clothes.
//
// Call `_irReadStageReport_()` from the console after a slow first load.
var _IR_BOOT_MS_ = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
// F1-7N-FC-1B-E3-R4-A1 §4 — THE MAP WAS WRONG, AND THE REPORT COULD NOT SAY SO.
//
// The live first-failure report is the whole indictment: request_count = 4, and every named stage
// attempts = 0. Four requests happened and the diagnostic placed none of them. Then it printed
// COLD_START_OR_TRANSIENT_TIMEOUT, a root-cause claim derived from nothing, next to a first_attempt of
// `getClientCapabilities` succeeding in 3 768 ms — which says nothing at all about the inventory read.
//
// The cause was mundane and entirely mine: I mapped ACTION NAMES I HAD GUESSED. The transport records the
// workspace action as `inventoryReplenishment.workspace.get`; I wrote `getInventoryReplenishmentWorkspace`,
// which nothing emits. Same for every other stage. A map of names that do not exist classifies nothing, and
// because unmatched samples were silently dropped, "no request reached this stage" and "I do not recognise
// this action" produced the identical zero.
//
// Two things change. The names are the ones the transport actually records, taken from the DTO builders and
// the GET action table rather than from memory. And an action that matches NO stage is now COUNTED and NAMED
// in `unclassified_requests`, so the arithmetic is visible: when classified + ignored is less than
// request_count, the verdict is INSTRUMENTATION_INCOMPLETE and no root cause is offered at all.
//
// A diagnostic that cannot fail is worse than none, because it is believed.
var IR_READ_STAGES_ = [
  { stage: 'deployment_contract', actions: ['system.health', 'getClientCapabilities'] },
  { stage: 'scope_registry', actions: ['inventoryScope.registry.get'] },
  { stage: 'inventory_workspace', actions: ['inventoryReplenishment.workspace.get'] },
  { stage: 'recommendation_read', actions: ['recommendation.workspace.get', 'inventoryReplenishmentGap.get', 'gapJob.status.get'] },
  { stage: 'allocation_hydration', actions: ['getShippingAllocationDraftWorkspace', 'shippingAllocationDraft.workspace.get'] },
  { stage: 'carrier_authorities', actions: ['getCarrierRateCards', 'getWarehouseAllocationConfig', 'carrier.rateCards.get'] }
];
// Actions that legitimately belong to no read stage. They are EXPLICITLY ignored rather than unclassified, so
// the accounting stays exact and a genuinely unknown action still surfaces.
var IR_STAGE_IGNORED_ACTIONS_ = ['weeklyAiPlan.generate', 'submitAllocationDraftsToShippingPlans',
  'upsertShippingAllocationDraftAtomic', 'upsertShippingAllocationDraftLines', 'upsertShippingAllocationDraft',
  'cancelShippingAllocationDraft', 'inventoryReplenishmentGap.job.start', 'inventoryReplenishmentGap.job.cancel'];
function _irReadStageReport_() {
  var out = { available: false, page_boot_elapsed_ms: null, client_total_elapsed_ms: null,
    server_execution_ms: null, request_count: 0, coalesced_count: 0, retry_count: 0, stages: [],
    first_attempt: null, retry_attempt: null, classification: 'NO_SAMPLES' };
  try {
    out.page_boot_elapsed_ms = ((typeof Date !== 'undefined' && Date.now) ? Date.now() : 0) - _IR_BOOT_MS_;
    if (!(window.KM && window.KM.transport && typeof window.KM.transport.metrics === 'function')) {
      out.classification = 'TRANSPORT_METRICS_UNAVAILABLE';
      return out;
    }
    var m = window.KM.transport.metrics() || {};
    var samples = m.samples || [];
    out.available = true;
    out.request_count = m.requests || 0;
    out.coalesced_count = m.coalesced || 0;
    out.retry_count = m.retries || 0;
    // F1-7N-FC-1B-E3-R4 §B — RESTATED. R3-R1 reported this as null on the grounds that the transport
    // records client elapsed only. That was true of the TRANSPORT and false of the ANSWER: the workspace
    // envelope has always carried meta.serverDurationMs, and the page discarded it. It is now captured on
    // every successful primary read and reported here. It stays null when no read has completed — which is
    // exactly the first-attempt-timeout case, and "the server never told us" is the honest reading of that.
    out.server_execution_ms = (_irLastReadMeta && typeof _irLastReadMeta.server_execution_ms === 'number')
        ? _irLastReadMeta.server_execution_ms : null;
    out.server_tables_read = (_irLastReadMeta && _irLastReadMeta.tables_read) || null;
    // §A1 — THE REQUEST CONTRACT, not an inference from it. `recent_window_requested` true beside
    // `recent_window_applied` false is the exact shape of the defect R4 shipped: the page asked, the DTO
    // dropped the field, and the server never saw it. Reading a falling row count as proof would have missed
    // it entirely, because 13 107 rows is simply how big this database is.
    out.recent_window_requested = (_irLastReadMeta && _irLastReadMeta.recent_window_requested) === true;
    out.recent_window_applied = (_irLastReadMeta && _irLastReadMeta.recent_window_applied) === true;
    out.server_only_requested = (_irLastReadMeta && _irLastReadMeta.only_requested) || null;
    out.server_open_ms = (_irLastReadMeta && typeof _irLastReadMeta.open_ms === 'number') ? _irLastReadMeta.open_ms : null;
    out.server_slowest_tables = (_irLastReadMeta && _irLastReadMeta.slowest_tables) || null;
    out.server_rows_returned = (_irLastReadMeta && typeof _irLastReadMeta.rows_returned === 'number')
        ? _irLastReadMeta.rows_returned : null;
    out.recent_window = (_irLastReadMeta && _irLastReadMeta.recent_window) || null;
    // §4 — EVERY sample, not only the ones labelled 'read'. The previous filter dropped anything the
    // transport classified differently, which is another way an unclassified request became an invisible one.
    var reads = samples.slice();
    out.client_total_elapsed_ms = reads.reduce(function (a, x) { return a + (Number(x.ms) || 0); }, 0);
    var claimed = {};
    IR_READ_STAGES_.forEach(function (st) {
      var mine = reads.filter(function (x) { return st.actions.indexOf(String(x.action || '')) !== -1; });
      mine.forEach(function (x) { claimed[reads.indexOf(x)] = true; });
      out.stages.push({
        stage: st.stage,
        attempts: mine.length,
        actions: mine.map(function (x) { return String(x.action || ''); }),
        elapsed_ms: mine.length ? mine.map(function (x) { return Number(x.ms) || 0; }) : null,
        codes: mine.map(function (x) { return String(x.code || '') || 'SUCCESS'; }),
        phases: mine.map(function (x) { return String(x.phase || ''); }),
        slowest_ms: mine.length ? mine.reduce(function (a, x) { return Math.max(a, Number(x.ms) || 0); }, 0) : null
      });
    });
    // §4 — THE ACCOUNTING. Anything neither classified nor explicitly ignored is named, not dropped.
    out.classified_count = 0;
    for (var ci in claimed) { if (Object.prototype.hasOwnProperty.call(claimed, ci)) out.classified_count++; }
    out.ignored_count = 0;
    out.unclassified_requests = [];
    reads.forEach(function (x, i) {
      if (claimed[i]) return;
      var a = String(x.action || '');
      if (IR_STAGE_IGNORED_ACTIONS_.indexOf(a) !== -1) { out.ignored_count++; return; }
      out.unclassified_requests.push({ action: a || '(unnamed)', ms: Number(x.ms) || 0,
        code: String(x.code || '') || 'SUCCESS', kind: String(x.kind || ''), phase: String(x.phase || '') });
    });
    out.sample_count = reads.length;
    // The transport's own counter and the samples it kept can differ (samples are bounded at 400). Both are
    // reported so a shortfall is attributable rather than mysterious.
    out.instrumentation_complete = (out.unclassified_requests.length === 0)
      && (out.classified_count + out.ignored_count >= out.request_count);
    // FIRST ATTEMPT vs RETRY, which is the whole question: what is DIFFERENT about the second request.
    if (reads.length) {
      out.first_attempt = { action: String(reads[0].action || ''), ms: Number(reads[0].ms) || 0,
        code: String(reads[0].code || '') || 'SUCCESS', phase: String(reads[0].phase || '') };
      var retry = null;
      for (var i = 1; i < reads.length; i++) {
        if (String(reads[i].action || '') === out.first_attempt.action) { retry = reads[i]; break; }
      }
      out.retry_attempt = retry ? { action: String(retry.action || ''), ms: Number(retry.ms) || 0,
        code: String(retry.code || '') || 'SUCCESS', phase: String(retry.phase || '') } : null;
      if (out.retry_attempt) out.first_vs_retry_delta_ms = out.first_attempt.ms - out.retry_attempt.ms;
    }
    // §4 — A CLASSIFICATION IS ONLY OFFERED WHEN THE EVIDENCE IS COMPLETE.
    //
    // The live report printed COLD_START_OR_TRANSIENT_TIMEOUT while it had placed exactly zero of four
    // requests. That is not a weak conclusion, it is a conclusion drawn from an empty set, and it sent the
    // investigation somewhere there was no reason to go. When the accounting does not balance, the ONLY thing
    // this reports is that it cannot see, and it says which actions it failed to recognise.
    if (!out.instrumentation_complete) {
      out.classification = 'INSTRUMENTATION_INCOMPLETE';
      out.classification_withheld = 'requests were issued that this report could not place: '
        + out.unclassified_requests.map(function (u) { return u.action; }).join(', ')
        + ' (classified ' + out.classified_count + ' + ignored ' + out.ignored_count
        + ' of ' + out.request_count + ')';
      return out;
    }
    // ==========================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §16.3 — WHO DISPATCHED EACH READ.
    //
    // The live report could say that two identical workspace reads happened and nothing else about them. The
    // ledger names the owner, the reason, the wall clock and a payload fingerprint of each, so a duplicate is
    // attributable instead of a mystery, and OVERLAP is decidable: two dispatches whose windows intersect are
    // a coalescing question, and two that do not are a SCHEDULING question with a different fix entirely.
    out.read_dispatches = (typeof _irReadDispatches !== 'undefined' ? _irReadDispatches : []).map(function (d) {
      return { owner: d.owner, reason: d.reason, at: d.at, seq: d.seq, quiet: d.quiet === true,
        payload_fingerprint: d.payload_fingerprint, settled_at: d.settled_at, outcome: d.outcome,
        elapsed_ms: (d.settled_at && d.at) ? (d.settled_at - d.at) : null };
    });
    out.duplicate_reads = (function () {
      var byFp = {}, dups = [];
      out.read_dispatches.forEach(function (d) { (byFp[d.payload_fingerprint] = byFp[d.payload_fingerprint] || []).push(d); });
      for (var fp in byFp) {
        if (!Object.prototype.hasOwnProperty.call(byFp, fp) || byFp[fp].length < 2) continue;
        var g = byFp[fp];
        // Did the second dispatch start while the first was still open? That single fact decides which fix
        // applies, and asserting either answer without it is how a scheduling defect gets "fixed" by adding
        // a cache.
        var overlapped = false;
        for (var i = 0; i < g.length; i++) {
          for (var j = i + 1; j < g.length; j++) {
            var a = g[i], b = g[j];
            if (a.settled_at == null || b.at == null) continue;
            if (b.at < a.settled_at && a.at <= b.at) overlapped = true;
          }
        }
        dups.push({ payload_fingerprint: fp, count: g.length,
          owners: g.map(function (d) { return d.owner; }),
          reasons: g.map(function (d) { return d.reason; }),
          dispatched_at: g.map(function (d) { return d.at; }),
          concurrent: overlapped,
          finding: overlapped
            ? 'CONCURRENT_IDENTICAL_READ: the second dispatch began while the first was still open — these must share one in-flight request'
            : 'SEQUENTIAL_IDENTICAL_READ: the second dispatch began after the first had settled — in-flight sharing cannot help; this is a scheduling question' });
      }
      return dups;
    })();
    if (window.IRReadTimeoutDiagnostic && typeof window.IRReadTimeoutDiagnostic.classify === 'function') {
      var c = window.IRReadTimeoutDiagnostic.classify(samples, null);
      out.classification = c.classification;
      // §16.2 — the cross-action evidence, carried out so the classification can be CHECKED rather than
      // taken on trust. Four different actions failing at one bound is the whole reason this is not reported
      // as a workspace cost, and a reader must be able to see the four.
      out.timeout_actions = c.timeoutActions || null;
      out.distinct_timeout_actions = (typeof c.distinctTimeoutActions === 'number') ? c.distinctTimeoutActions : null;
      out.server_evidence = (typeof c.serverEvidence === 'boolean') ? c.serverEvidence : null;
      out.server_evidence_known = c.serverEvidenceKnown === true;
      // §16.1 — where in the lifecycle it stopped, and what is still missing to decide.
      out.reach = c.reach || null;
      out.request_reached_server = (c.reach && c.reach.classification) || null;
      // §16.6 — the two questions are kept APART. A shared transport outage and the workspace's own cost
      // are different findings with different fixes, and a report that let one stand in for the other is how
      // "we optimised the tables" comes to be offered as an answer to "nothing loads at all".
      out.finding_split = {
        shared_transport: out.classification === 'SHARED_TRANSPORT_OR_DISPATCH_TIMEOUT'
          ? 'UNAVAILABLE: lightweight and heavyweight actions failed together with no server evidence'
          : 'NOT_OBSERVED_IN_THIS_SESSION',
        workspace_server_cost: (typeof out.server_execution_ms === 'number')
          ? (out.server_execution_ms + ' ms of server execution on the last completed primary read')
          : 'UNMEASURED: no primary read completed in this session, so its cost is unknown'
      };
      // §8 — once the same first-attempt timeout has been seen more than once, "transient" is no longer
      // an available reading, and the report says the name the evidence supports.
      if (c.classification === 'SUCCESS_AFTER_RETRY' && c.timeouts >= 1) {
        out.recurring_status = 'RECURRING_FIRST_ATTEMPT_TIMEOUT';
      }
    }
    return out;
  } catch (e) {
    out.classification = 'STAGE_REPORT_THREW';
    out.error = (e && e.message) ? String(e.message) : String(e);
    return out;
  }
}
window._irReadStageReport_ = _irReadStageReport_;

// F1-7N-FA-3C-R6E-P0 — SAFE STRUCTURED save-error surface. Never fakes success (no "Saved"), never renders
// "[object Object]", never exposes a stack/token. Concise user line + a COLLAPSED technical disclosure (code /
// affected table / missing header / request id — all HTML-escaped). Keeps the sessionStorage recovery cache.
//
// F1-7N-FC-1B-E3-R2 §D.1/§D.5 — IT REFUSES A NON-FAILURE, AT THE DOOR.
//
// Removing the one call site that passed an editor state in here would have fixed the live report and left the
// door open, and the door is the actual defect: this function opens with "Unsaved — database update
// failed. This route was NOT saved to the database." for WHATEVER it is handed, so any future caller reaching
// for the only row-local surface there was would reintroduce the same false sentence. A NEUTRAL envelope is
// now redirected to the surface that owns it and this one renders nothing. Everything else is untouched:
// §D.5 — a real failure keeps the red panel, the reason code, the disclosure and the retry advice.
function _irShowDraftSaveError(sku, err) {
    var el = document.getElementById('allocation-carton-error-' + sku);
    if (!el) return;
    var s = (err && err.structured) || {};
    if (String(s.severity || '') === 'NEUTRAL') {
        if (typeof _irShowRouteStateHint_ === 'function') _irShowRouteStateHint_(sku, err);
        return;                          // NOT a failure: this surface says nothing about it
    }
    var esc = (typeof _execEsc === 'function') ? _execEsc : function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
    // F1-7N-FB-2A §E — the concise line states the TRUTH (nothing was saved) and never claims a local save.
    // Everything diagnosable is in the collapsed Technical Details: the typed inner reason, the affected
    // table, missing/invalid fields, any schema mismatch, a safe entity key, the request id, the zero-write
    // status and whether a retry can succeed. No token, spreadsheet id, Drive id or stack ever appears.
    var rows = '<div><strong>Reason:</strong> ' + esc(s.reasonCode || s.code || 'SAVE_FAILED') + '</div>';
    if (s.message && s.message !== s.reasonCode) rows += '<div><strong>Server message:</strong> ' + esc(s.message) + '</div>';
    if (s.code && s.code !== s.reasonCode) rows += '<div><strong>Transport code:</strong> ' + esc(s.code) + '</div>';
    if (s.table) rows += '<div><strong>Affected table:</strong> ' + esc(s.table) + '</div>';
    if (s.missingHeader) rows += '<div><strong>Missing header:</strong> ' + esc(s.missingHeader) + '</div>';
    if (s.missingFields) rows += '<div><strong>Missing/invalid fields:</strong> ' + esc(s.missingFields) + '</div>';
    if (s.schemaMismatch) rows += '<div><strong>Schema mismatch:</strong> ' + esc(s.schemaMismatch) + '</div>';
    if (s.entityKey) rows += '<div><strong>Existing record:</strong> ' + esc(s.entityKey) + '</div>';
    if (s.requestId) rows += '<div><strong>Request:</strong> ' + esc(s.requestId) + '</div>';
    rows += '<div><strong>Rows written:</strong> ' + esc(s.zeroWrite === 'true' ? 'none (zero-write confirmed)' : 'not confirmed by the server') + '</div>';
    rows += '<div><strong>Retryable:</strong> ' + esc(s.retryable === false ? 'no' : 'yes') + '</div>';
    // F1-7N-FB-4A §D — THE TYPED BACKEND REASON IS PROMOTED OUT OF THE COLLAPSED DISCLOSURE. The live report was
    // "Database update failed" plus one generic sentence, with the actual reason code hidden behind "Technical
    // details" — so two DIFFERENT backend refusals (a legacy row needing a user migration, a K2 row belonging to
    // another shipment group, a duplicate group) all read as one indistinguishable failure and the operator had
    // nothing to act on. The reason code and the server's own sentence are now on the face of the message, above
    // the fold, and the collapsed section keeps everything else exactly as before.
    var _reasonCode = esc(s.reasonCode || s.code || 'SAVE_FAILED');
    var _serverLine = (s.message && s.message !== s.reasonCode) ? esc(s.message) : '';
    el.innerHTML = '<div class="ir-save-error-user"><strong>Unsaved — database update failed.</strong> ' +
            'This route was NOT saved to the database. Your entries are kept on screen so you can correct and retry them; ' +
            'Submit Plan is blocked until every route is saved.</div>' +
        '<div class="ir-save-error-reason"><strong>Reason:</strong> <code>' + _reasonCode + '</code>' +
            (_serverLine ? '<span class="ir-save-error-reason__msg"> — ' + _serverLine + '</span>' : '') + '</div>' +
        (s.entityKey ? '<div class="ir-save-error-reason"><strong>Blocking record:</strong> <code>' + esc(s.entityKey) + '</code></div>' : '') +
        (s.nextAction ? '<div class="ir-save-error-next">' + esc(s.nextAction) + '</div>' : '') +
        '<details class="ir-save-error-detail"><summary>Technical details</summary>' + rows + '</details>';
    el.style.display = 'block'; el.style.color = '#dc2626';
}
// Clear the inline save error once the same route is genuinely persisted.
// F1-7N-FC-1B-E3-R2 — the COLOUR is part of the message and is cleared with it. _irShowDraftSaveError sets
// `style.color = '#dc2626'` inline; emptying only the innerHTML left the element red, so whatever was rendered
// there next inherited the failure's colour without any of its words.
function _irHideDraftSaveError(sku) {
    var el = document.getElementById('allocation-carton-error-' + sku);
    if (!el) return;
    try { el.style.color = ''; } catch (_eC) {}
    if (el.querySelector && el.querySelector('.ir-save-error-user')) { el.innerHTML = ''; el.style.display = 'none'; }
}
window._irHideDraftSaveError = _irHideDraftSaveError;
// Soft-cancel ONE persisted draft line (Decision E §16) — never hard delete. line_status='cancelled'.
function _cancelAllocationDraftLine(lineId, explicitDraftId) {
    try {
        if (!lineId || !(window.KM && window.KM.DB && window.KM.DB.upsertShippingAllocationDraftLines && window.IRDraft)) return;
        if (typeof isOperationDbApiConfigured === 'function' && !isOperationDbApiConfigured()) return;
        // Under multi-route the header MUST come from the line itself; there is no single "current" draft to
        // fall back on without risking a soft-cancel against the wrong shipment group.
        var draftId = String(explicitDraftId == null ? '' : explicitDraftId).trim() || replenAllocationDraft.allocationDraftId;
        if (!draftId) return;
        // F1-7N-FB-2A §D — a soft-cancel is a business WRITE. If it fails, the line still exists in the DB
        // while the UI shows it removed, which is the same false-persistence class as a failed save. Record it
        // as UNSAVED so Submit is blocked and the failure is visible rather than swallowed by a console warn.
        return Promise.resolve(window.KM.DB.upsertShippingAllocationDraftLines(window.IRDraft.buildCancelLinePayload(draftId, lineId)))
            .then(function (res) {
                if (!res || res.success === false) {
                    var err = _irMakeDraftSaveError_(res && res.error, 'shipping_allocation_draft_lines', 'draft line cancel failed');
                    _irMarkRouteUnsaved_('line:' + lineId, err);
                }
                return res;
            })['catch'](function (e2) {
                _irMarkRouteUnsaved_('line:' + lineId, _irMakeDraftSaveError_({ code: 'HTTP_TRANSPORT_ERROR', message: (e2 && e2.message) || String(e2) }, 'shipping_allocation_draft_lines', 'draft line cancel failed'));
            });
    } catch (e) { console.warn('[replen] cancel draft line error:', e); }
}
window._cancelAllocationDraftLine = _cancelAllocationDraftLine;
// Async-race guard: only the newest context hydrate may write the working draft.
var _replenHydrateToken = 0;
// Hydrate the working draft from the DB (SSOT) for the current scope. DB state wins over the
// sessionStorage cache when present; cancelled lines are excluded. Reads the already-loaded adapter
// cache (getShippingAllocationDrafts/_Lines). BROWSER/LIVE-DB-UNVERIFIED.
function _hydrateAllocationDraftFromDb(ctx, opts) {
    // F1-7N-FC-1B-E1 §C.1/§E.2 — WHICH EXPLICIT ACT PUT THESE ROWS ON SCREEN, declared by the caller
    // that knows. An ordinary Search reads what the database already held: PERSISTED_ACTIVE_DRAFT. The readback
    // that follows a SUCCESSFUL AI Plan the operator asked for is the AI half appearing for the first time, and
    // it says so. Never inferred from generation_type or any other stored column - a row's provenance is how it
    // reached THIS screen in THIS session, which is a fact only the call site has.
    var _prov = String((opts && opts.provenance) || '').trim() || 'PERSISTED_ACTIVE_DRAFT';
    var myToken = ++_replenHydrateToken;
    try {
        // F1-7N-FB-4G-A0 §D.4/§D.6 — THE ROWS WERE NEVER IN THE SOURCE THIS FUNCTION READ.
        //
        // window.KM.DB.getShippingAllocationDrafts() returns `_opDbCache.shippingAllocationDrafts`, and NOTHING
        // fills that slice for this page. There are exactly two writers of it and BOTH are refused by the
        // deployed server: `getOperationDb` does not list shipping_allocation_drafts /
        // shipping_allocation_draft_lines in its validTabs, and neither does `getTable` — so the
        // refreshCacheTables(['shipping_allocation_drafts','shipping_allocation_draft_lines']) that ran just
        // before this call threw BACKEND_BUSINESS_REJECTION ("Invalid table name") on BOTH names, was swallowed
        // by its own ['catch'], and left the slice at []. `activeDrafts.length` was therefore 0 on every Search,
        // the hydrate returned false, and initializeShippingAllocation fell to the default Add Route editor.
        //
        // The rows were never far away. inventoryReplenishment.workspace.get — the read this very Search just
        // completed — serves BOTH tables as raw passthrough (60_ SIR_WORKSPACE_TABLES_, no include gate), and
        // adaptInventoryReplenishmentWorkspace already normalises them into the read model under these exact
        // getter names. Every other read on this page goes through _irWsGet; this one did not.
        //
        // _irWsGet is read-model-first and falls back to the SAME broad getter in Legacy mode, so Legacy
        // behaviour is byte-identical and Workspace mode now reads the rows the Search already fetched.
        if (typeof _irWsGet !== 'function') return false;
        var drafts = _irWsGet('getShippingAllocationDrafts') || [];
        var lines = _irWsGet('getShippingAllocationDraftLines') || [];
        function lo(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
        // F1-7N-FB-4B-ADDENDUM §F.9 — HYDRATE EVERY ACTIVE HEADER FOR THE STATION, NOT JUST THE NEWEST.
        // This used to sort by updated_at and take [0]. Under the frozen K2 contract one station legitimately holds
        // several shipment groups — that is what a second route IS — so taking one header silently dropped every
        // other route on refresh and made a two-route plan look like a one-route plan.
        // ==========================================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §1 — COMPANY WAS THE ONE AXIS THIS FILTER TREATED AS OPTIONAL.
        //
        // The clause was `(!ctx.company || !d.company || lo(d.company) === lo(ctx.company))`. Read it as three
        // separate permissions, because that is how it behaves:
        //
        //   !ctx.company  — if the PAGE does not know its company, every draft in the country/marketplace
        //                   matches. `_replenSelectedScope` derives company from the selected marketplace_id,
        //                   so a marketplaces row with a blank company makes this true.
        //   !d.company    — if the STORED ROW does not name a company, it matches EVERY company. One legacy
        //                   header with a blank company is adopted into whichever company is on screen.
        //
        // KM/US/Amazon and ResUS/US/Amazon are two real, separate stations. Country and marketplace cannot tell
        // them apart, and company was the axis that could — made optional in both directions. This is the one
        // filter on the page that could put another company's route into this company's Execution Plan, and
        // everything downstream (edit, delete, Submit) then operates on it under the wrong scope.
        //
        // It is now EXACT and FAIL-CLOSED: an unknown page company hydrates nothing, and a row that names no
        // company is never adopted. Both exclusions are COUNTED and reported rather than silently applied — a
        // route that vanishes without explanation is the failure mode this page keeps being asked about.
        // ==========================================================================================================
        // ==========================================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §2 — THE PREDICATE MOVES TO ITS OWN OWNER.
        //
        // R6-R1 wrote the company rule here and got it right. What it could not fix from here is that the SAME
        // question was also being answered, differently, by the read-only census — which is how a screen showing
        // 520 units and a census reporting `active_allocation_drafts: 0` were both produced honestly in the same
        // minute. (The census tested `status === 'active'`; that value is not in 16_ SAD_STATUSES_ and no writer
        // has ever produced it, so its zero was a constant rather than a measurement.)
        //
        // KMARC is now the one owner of "is this header part of this station's current plan", and both consume it.
        // Two things change here beyond the move, and both are corrections:
        //
        //   * STATUS IS A POSITIVE TEST, not a list of two exclusions. It was `not cancelled and not submitted`,
        //     which admits `expired` and admits any unrecognised value. 16_ states the rule in the other
        //     direction — "An expired row is READ-ONLY: it is not editable, not submittable, and not part of any
        //     active set" — and its three ACTIVE literals are {draft, site_confirmed, partially_submitted}. An
        //     expired header rendered as part of the current plan is exactly §2's cause D.
        //   * COUNTRY AND MARKETPLACE fail closed on a blank, as company already did. A stored row with no
        //     country was previously compared `'' === 'us'` and excluded by luck rather than by rule; a row with
        //     no marketplace likewise. Now they are refused BY NAME, and counted.
        //
        // Every exclusion is COUNTED and published. A route that vanishes without explanation is the failure mode
        // this page keeps being asked about.
        // ==========================================================================================================
        var _scopeCompany = lo(ctx.company);
        var _arc = (typeof window !== 'undefined' && window.KMARC) ? window.KMARC : null;
        var _classified = [], _excludedDetail = [], _byReason = {};
        drafts.forEach(function (d) {
            // The DTO carries camelCase; KMARC reads either spelling, and the raw sheet row is preferred when
            // present so the classification sees exactly what is stored.
            var row = (d && d.raw) ? d.raw : d;
            var c = _arc ? _arc.classifyHeader({
                allocation_draft_id: d.allocationDraftId || (row && row.allocation_draft_id),
                status: (row && row.status != null && row.status !== '') ? row.status : d.status,
                company: (row && row.company != null && row.company !== '') ? row.company : d.company,
                country: (row && row.country != null && row.country !== '') ? row.country : d.country,
                marketplace: (row && row.marketplace != null && row.marketplace !== '') ? row.marketplace : d.marketplace,
                destination_marketplace: (row && row.destination_marketplace) || d.destinationMarketplace || ''
            }, { company: ctx.company, country: ctx.country, marketplace: ctx.marketplace }) : null;
            // No KMARC on the page is a REFUSAL, not a fallback to the old rule. A second copy of the predicate
            // living here is the thing this round removed; re-adding it as a fallback would re-create the drift.
            if (!c || !c.counts_toward_current_plan) {
                var reasons = c ? c.exclusion_reasons : ['ACTIVE_ROUTE_CLASSIFICATION_MODULE_UNAVAILABLE'];
                _excludedDetail.push({ allocation_draft_id: String((d && d.allocationDraftId) || ''), reasons: reasons });
                reasons.forEach(function (k) { _byReason[k] = (_byReason[k] || 0) + 1; });
                return;
            }
            _classified.push(d);
        });
        var activeDrafts = _classified.sort(function (a, b) { return String(a.allocationDraftId || '') < String(b.allocationDraftId || '') ? -1 : 1; });
        // Published so a diagnostic (and §2's provenance report) can state WHY a row on the sheet is not on the
        // screen, instead of leaving an operator to compare two counts that disagree.
        window._irHydrateScopeAudit = {
            at: new Date().toISOString(),
            scope: { company: ctx.company || '', country: ctx.country || '', marketplace: ctx.marketplace || '' },
            scope_company_known: !!_scopeCompany,
            authority: 'KMARC',
            authority_present: !!_arc,
            contract: _arc ? _arc.CONTRACT : null,
            examined: drafts.length,
            hydrated: activeDrafts.length,
            hydrated_ids: activeDrafts.map(function (d) { return String(d.allocationDraftId || ''); }),
            excluded: _excludedDetail.length,
            excluded_ids_with_reason: _excludedDetail,
            excluded_by_reason: _byReason,
            // Kept under their R6-R1 names so an existing reader of this audit does not silently lose a field.
            excluded_row_has_no_company: _byReason[_arc ? _arc.EXCLUSION.COMPANY_BLANK_ON_ROW : 'COMPANY_BLANK_ON_ROW'] || 0,
            excluded_row_belongs_to_another_company: _byReason[_arc ? _arc.EXCLUSION.COMPANY_MISMATCH : 'COMPANY_MISMATCH'] || 0,
            rule: 'company + country + marketplace, all three EXACT, plus a POSITIVE status test. A blank on '
                + 'either side of any axis is never a wildcard.'
        };
        if (!_arc) {
            try {
                console.warn('[replen] ACTIVE_ROUTE_CLASSIFICATION_MODULE_UNAVAILABLE - the Execution Plan was ' +
                    'not hydrated. Nothing was rendered and nothing was written.');
            } catch (eArc) {}
            return false;
        }
        if (!_scopeCompany) return false;
        if (myToken !== _replenHydrateToken) return false;   // a newer context request superseded this one
        if (!activeDrafts.length) return false;

        var bySku = {};
        var corrupted = [];
        activeDrafts.forEach(function (draft) {
            // R6F HYDRATION_FIELD_MAP fix: route context (From / To / Method / Last-Mile) is HEADER-level
            // (recommended_*), NOT on the 30/31-col line, and there are NO selected_* columns. Read the route from
            // the draft HEADER — which under K2 IS the shipment group — and per-line qty/note/source from the line
            // row. The line's only source axis is its own `source_warehouse_id` (R3C2 col 29), which overrides the
            // header From when present.
            var dh = draft.raw || draft || {};
            function hstr(snake, camel) { var v = (dh[snake] != null && dh[snake] !== '') ? dh[snake] : (draft[camel] != null ? draft[camel] : ''); return String(v == null ? '' : v).trim(); }
            var hFrom = hstr('recommended_source_warehouse_id', 'recommendedSourceWarehouseId');
            var hTo = hstr('recommended_destination_warehouse_id', 'recommendedDestinationWarehouseId');
            // F1-7N-FB-4F-B6 §D.3 — the OTHER persisted destination axis. B4 appended destination_marketplace to
            // the header, so a marketplace route finally has somewhere to be stored; before that this hydrate had
            // no persisted marketplace to read and invented one from the page filter instead.
            var hMkt = hstr('destination_marketplace', 'destinationMarketplace');
            // §D.1-§D.5 — ONE AUTHORITY, and it is the STORED ROW. IRWarehouse.resolvePersistedDestination is the
            // client mirror of 69_ ricDestinationIdentity_ (warehouse XOR marketplace, else a typed state). The
            // page scope is passed ONLY so the marketplace token can carry the country the option list is built
            // with — it can no longer supply the destination itself.
            var hDest = (window.IRWarehouse && window.IRWarehouse.resolvePersistedDestination)
                ? window.IRWarehouse.resolvePersistedDestination({ destination_warehouse_id: hTo, destination_marketplace: hMkt }, ctx)
                : { state: hTo ? 'PERSISTED_WAREHOUSE' : 'DESTINATION_CONFIRMATION_REQUIRED',
                    type: '', warehouse_id: hTo, marketplace: '', token: hTo, confirmationRequired: !hTo };
            // F1-7N-FB-4G-A0-R1 §G.1/§G.2 — the stored code snapshots, carried VERBATIM and used for nothing but
            // display continuity. The destination one is the legacy misuse itself (H4 holds 'Amazon' in a
            // warehouse-code column); reading it must never promote it to a destination — that is
            // resolvePersistedDestination's job and it looks at the id/marketplace columns only — and page load
            // must never clear it, which is guaranteed here by the hydrate performing no write at all.
            var hSrcCode = hstr('recommended_source_warehouse_code_snapshot', 'recommendedSourceWarehouseCodeSnapshot');
            var hDestCode = hstr('recommended_destination_warehouse_code_snapshot', 'recommendedDestinationWarehouseCodeSnapshot');
            var hMethod = hstr('recommended_shipping_method', 'recommendedShippingMethod');
            var hLastMile = hstr('recommended_last_mile_delivery', 'recommendedLastMileDelivery');
            var hGenType = hstr('generation_type', 'generationType') || 'user_created';
            var mine = lines.filter(function (l) {
                return l.allocationDraftId === draft.allocationDraftId && lo(l.lineStatus || l.line_status) !== 'cancelled';
            });
            // §E — DUPLICATE PRIMARY KEYS ARE DISCLOSED, NEVER SUMMED. The three live rows sharing
            // SADL-K2-16F4E4F9 all carry planned_qty 800; adding them would render 2400 and present corrupt data
            // as a larger healthy plan. Exactly ONE physical row per primary key is rendered and the duplication
            // is recorded so the UI can say so and Submit can fail closed until the cleanup is run.
            var seenPk = {};
            mine.forEach(function (l) {
                var raw = l.raw || l;
                var sku = raw.sku;
                if (!sku) return;
                var pk = String(raw.allocation_draft_line_id || '').trim();
                if (pk) {
                    if (seenPk[pk]) {
                        seenPk[pk].physical_rows++;
                        return;   // do NOT render or count a second physical row under one primary key
                    }
                    seenPk[pk] = { allocation_draft_id: draft.allocationDraftId, allocation_draft_line_id: pk, sku: sku, physical_rows: 1 };
                }
                var lineSrc = String(raw.source_warehouse_id == null ? '' : raw.source_warehouse_id).trim();
                (bySku[sku] = bySku[sku] || []).push({
                    // §C.1 - this row exists because an ACTIVE header and an ACTIVE line were read for it.
                    // A cancelled or submitted header never reaches here (the activeDrafts filter), and a
                    // cancelled line never reaches here (the `mine` filter), so a header whose lines are all
                    // cancelled - the orphan / zero-active-line shape - contributes NO route at all and the
                    // SKU falls to the empty state rather than to a seeded one.
                    route_provenance: _prov,
                    allocation_draft_line_id: pk,
                    allocation_draft_id: draft.allocationDraftId,
                    // F1-7N-FB-4G-A2-R2 §5 — the header version this route was READ at, carried so an UPDATE
                    // can declare what it expects and the server can refuse a write that would silently
                    // overwrite a change made elsewhere. Read-only: the client never computes or bumps it.
                    draft_version: hstr('draft_version', 'draftVersion'),
                    sku: sku,
                    site_sku: raw.site_sku || '',           // R6F: carry the natural-key fields so an edit reconciles the
                    window_code: raw.window_code || '',     //      exact generated line by natural key (16_ fallback).
                    route_no: raw.route_no || '',
                    // F1-7N-FB-4F-B6-R1 §D.5/§D.7 — THE STORED SNAPSHOT, EXACTLY AS STORED.
                    // A blank stays blank: the hydrate reads, validates the shape, and neither computes nor
                    // repairs. `expected_arrival_basis` records which canonical service the stored date belongs
                    // to, so a later Method change can tell "this snapshot no longer describes this route" from
                    // "this snapshot is still the answer" without recomputing to find out.
                    expected_arrival: _irCanonicalDateOrBlank_(raw.expected_arrival),
                    // The basis is the header's own persisted method, stored RAW. Canonicalising it here would
                    // give the hydrate a second dependency for no gain: _irRouteEtaFor canonicalises BOTH sides
                    // when it compares them, so 'Sea Express' and 'sea_express' are one basis either way.
                    expected_arrival_basis: _irCanonicalDateOrBlank_(raw.expected_arrival) ? hMethod : '',
                    expected_arrival_source: _irCanonicalDateOrBlank_(raw.expected_arrival) ? 'PERSISTED' : '',
                    planned_qty: Number(raw.planned_qty) || 0,
                    qty: Number(raw.planned_qty) || 0,
                    recommended_qty: (raw.recommended_qty == null || raw.recommended_qty === '') ? null : Number(raw.recommended_qty),
                    note: raw.note == null ? '' : String(raw.note),
                    source_warehouse_id: lineSrc || hFrom,  // line-level source wins; else the header From (route on header)
                    // F1-7N-FB-4F-B6 §D — THE THREE DESTINATION FIELDS NOW COME FROM ONE RESOLVED ANSWER.
                    // They used to read:
                    //     destination_warehouse_id: hTo,
                    //     destination_type: hTo ? '' : 'MARKETPLACE_DESTINATION',
                    //     destination_marketplace: hTo ? '' : (ctx.marketplace || ''),
                    // so EVERY header with a blank warehouse came back claiming a marketplace destination equal to
                    // whatever the page was filtered to. That value then passed the completeness gate, was written
                    // back on the next save, and made a destination-less legacy row indistinguishable from a real
                    // Amazon route. A blank stored destination now stays blank.
                    destination_warehouse_id: hDest.warehouse_id,
                    destination_type: hDest.type,
                    destination_marketplace: hDest.marketplace,
                    // §D.6/§D.7 — the EXACT selector option value, so a persisted destination actually renders as
                    // selected. This is the half of the round trip the save path always emitted and the hydrate
                    // never did, which is why the To cell showed its placeholder for a route that HAD hydrated.
                    destination_token: hDest.token,
                    // §D.5 — the typed state a destination-less route carries, so the UI can say "confirm this"
                    // instead of silently selecting something.
                    destination_state: hDest.state,
                    source_warehouse_code: hSrcCode,        // stored snapshot, verbatim — never a display name
                    destination_warehouse_code: hDestCode,  // §G: legacy value preserved, NOT promoted, NOT cleared
                    shipping_method: hMethod,               // Method — header route
                    last_mile_delivery: hLastMile,          // Last-Mile — header route
                    generation_type: hGenType               // generation_type is a HEADER column, not a line column
                });
            });
            Object.keys(seenPk).forEach(function (k) { if (seenPk[k].physical_rows > 1) corrupted.push(seenPk[k]); });
        });
        // Recompute each hydrated row's canonical group key so a later edit can tell whether its route changed.
        try {
            Object.keys(bySku).forEach(function (sk) {
                (bySku[sk] || []).forEach(function (r) { r.route_group_key = window.IRDraft.canonicalRouteGroupKey(ctx, r); });
            });
        } catch (eK) {}
        var primaryId = activeDrafts.length === 1 ? activeDrafts[0].allocationDraftId : '';
        replenAllocationDraft = { context: ctx, allocationDraftId: primaryId,
            allocationDraftIds: activeDrafts.map(function (d) { return d.allocationDraftId; }),
            duplicateLineIdentities: corrupted,
            targetDays: replenAllocationDraft.targetDays || '', bySku: bySku };
        try { _irRenderDuplicateCorruptionBanner_(); } catch (eB) {}
        if (corrupted.length) {
            console.warn('[replen] DUPLICATE_LINE_IDENTITY_PERSISTED — ' + corrupted.length +
                ' primary key(s) name more than one physical row. Submit is blocked for the affected SKU(s) until the cleanup is run.');
        }
        window.KM.shippingAllocationDraft = replenAllocationDraft;
        _persistAllocationDraft();
        return true;
    } catch (e) { console.warn('[replen] hydrate draft error:', e); return false; }
}
window._hydrateAllocationDraftFromDb = _hydrateAllocationDraftFromDb;

// F1-7N-FB-4F-B6 §C.3 — THE HYDRATE HAD NO SCOPE TO RUN IN, WHICH IS WHY 800 RENDERED AS 0.
//
// _restoreAllocationDraftFromSession is called at MOUNT, and its first act is `var ctx = _replenCtx()`, which
// reads the two <select> elements. At mount those selects have just been injected with the markup and are
// EMPTY — populateReplenFiltersFromRegistry and _irBootstrapScope_/_irSetSelectors_ both run later, inside
// _irMountAfterLoad. So `ctx.country` and `ctx.marketplace` are both '', the guard
// `(ctx.country || ctx.marketplace)` is false, and _hydrateAllocationDraftFromDb IS NEVER CALLED AT ALL.
//
// The page then had no other hydrate on the normal path (the only other call site is the AI-Plan generation
// readback, which is gated off), so replenAllocationDraft.bySku stayed empty, _allocationDraftRowsFor returned
// null, and initializeShippingAllocation fell to its SECOND branch: the default Add Route editor seeded with
// `parseInt(skuData.suggestedQty) || 0`. That editor showing 0 is the "Qty 0" the operator sees. The persisted
// 800 was never lost — it was never read.
//
// So the hydrate happens where the scope is actually KNOWN and VALIDATED: a confirmed Search. That is a user
// action, not page load, and it is already the one place _irSearch.applied is assigned. Single-flight and
// scope-guarded, so a superseded Search cannot paint an older station's routes.
var _irDraftHydrateInFlight = false;
var _irDraftHydrateScopeKey = '';
function _irHydrateDraftForAppliedScope_() {
    var ctx = (typeof _replenCtx === 'function') ? _replenCtx() : null;
    if (!ctx || !(ctx.country || ctx.marketplace)) return Promise.resolve(false);
    var key = [ctx.company, ctx.country, ctx.marketplace].join('|');
    if (_irDraftHydrateInFlight) { _irDraftHydrateScopeKey = key; return Promise.resolve(false); }
    _irDraftHydrateInFlight = true;
    _irDraftHydrateScopeKey = key;
    function done(v) { _irDraftHydrateInFlight = false; return v; }
    return Promise.resolve()
        .then(function () {
            // F1-7N-FB-4G-A0 §D.4 — in WORKSPACE mode there is nothing to refresh and never was. The read
            // model the hydrate reads is the product of the Search that is calling this function, so it is
            // already as fresh as a read can be; and the getTable refresh below cannot reach these two tables
            // at all (the deployed handler's validTabs lists neither), so it only ever contributed two refused
            // requests per Search and the appearance that data was being loaded. Legacy mode keeps the broad
            // cache as its source, so it keeps the call it has always made, failure-tolerant as before.
            if (typeof _irEffectiveWorkspace === 'function' && _irEffectiveWorkspace()) return null;
            if (window.KM && window.KM.DB && typeof window.KM.DB.refreshCacheTables === 'function' &&
                typeof isOperationDbApiConfigured === 'function' && isOperationDbApiConfigured()) {
                return window.KM.DB.refreshCacheTables(['shipping_allocation_drafts', 'shipping_allocation_draft_lines']);
            }
            return null;
        })
        ['catch'](function () { return null; })
        .then(function () {
            if (_irDraftHydrateScopeKey !== key) return done(false);   // a newer Search superseded this one
            var ok = false;
            try { ok = _hydrateAllocationDraftFromDb(ctx); } catch (e) { ok = false; }
            if (ok) {
                // The DB is the SSOT for what is persisted, so any prior UNSAVED mark is void — the same rule
                // _restoreAllocationDraftFromSession applies after its own successful hydrate.
                _irUnsavedRoutes = {};
                try { _irRenderUnsavedBanner_(); } catch (eB) {}
                try { renderReplenishment(); } catch (eR) {}
            }
            // F1-7N-FB-4G-A1-R1 - hydration is one of the EXECUTION panel's four readiness inputs and none of
            // the Recommendation's, so only that gate is told.
            if (typeof _irRevealPumpExec_ === 'function') { try { _irRevealPumpExec_(); } catch (eP) {} }
            return done(ok);
        })['catch'](function () { if (typeof _irRevealPumpExec_ === 'function') { try { _irRevealPumpExec_(); } catch (eP2) {} } return done(false); });
}
window._irHydrateDraftForAppliedScope_ = _irHydrateDraftForAppliedScope_;
function _clearAllocationDraft() {
    replenAllocationDraft = { context: { country: '', marketplace: '' }, targetDays: '', bySku: {} };
    window.KM.shippingAllocationDraft = replenAllocationDraft;
    try { sessionStorage.removeItem(REPLEN_ALLOC_DRAFT_KEY); } catch (e) {}
}
// ===== C2-D2A-UI: Allocation Draft persistence UI workspace (truthful state machine + targeted readback) =====
// One controller (IRDraftWorkspace, inventory-compat.js — deps-injected) owns the canonical persistence state; the
// compact panel renders ONLY from committed DB acknowledgements + the targeted readback
// (getShippingAllocationDraftWorkspace) — never from toast text and never via a whole-DB reload.
var _allocWorkspace = null;
function _allocWorkspaceScope() {
    var ctx = _replenCtx() || {};
    return { planning_cycle: ctx.planning_cycle || ctx.planningCycle || '', company: ctx.company || '', country: ctx.country || '', marketplace: ctx.marketplace || '', source_page: 'inventory_replenishment' };
}
function _getAllocWorkspace() {
    if (_allocWorkspace) return _allocWorkspace;
    if (!(window.IRDraftWorkspace && window.KM && window.KM.DB && window.KM.DB.getShippingAllocationDraftWorkspace)) return null;
    _allocWorkspace = window.IRDraftWorkspace.create({
        readback: function (scope) { return window.KM.DB.getShippingAllocationDraftWorkspace(scope); },
        save: function (header) { return window.KM.DB.upsertShippingAllocationDraft(header); },
        saveLines: function (payload) { return window.KM.DB.upsertShippingAllocationDraftLines(payload); },
        cancel: function (payload) { return window.KM.DB.cancelShippingAllocationDraft(payload); },
        onState: _renderAllocDraftPanel,
        getLocalBuffer: function () { try { return !!sessionStorage.getItem(REPLEN_ALLOC_DRAFT_KEY); } catch (e) { return false; } }
    });
    return _allocWorkspace;
}
function _allocStateLabel(state) {
    var map = { NOT_SAVED: 'Not Saved', SAVING: 'Saving…', SAVED: 'Saved to DB', SAVE_FAILED: 'Save Failed', CONFLICT: 'Conflict', CANCELLED: 'Cancelled', SUBMITTED: 'Submitted' };
    return '● ' + (map[state] || state);   // glyph + text (non-color indicator, accessibility)
}
// Migration: remove ONLY a body-level panel wrongly attached by previously-loaded code (never a page-local one).
function _removeLegacyBodyAllocPanel() {
    var legacy = document.querySelector('body > #alloc-draft-persistence-panel');
    if (legacy && legacy.remove) legacy.remove();
}
function _ensureAllocDraftPanel() {
    // The Allocation Draft persistence panel belongs to the Inventory Replenishment page ONLY. Its host is the page
    // content root (#opsSection, inside the #ops-section module-section) — NEVER document.body. A body-level panel
    // stays in document flow on every page and pushes the whole app-layout down (the persistent cream top strip).
    // The previous host lookup targeted #inventory-replenishment / .inventory-replenishment which DO NOT EXIST, so
    // it silently fell back to <body>. Fail closed (return null) when the page root is absent so the panel is never
    // orphaned onto <body>; while the panel is page-owned it is hidden with the section on non-Inventory pages.
    var host = document.getElementById('opsSection') || document.getElementById('ops-section');
    if (!host) { _removeLegacyBodyAllocPanel(); return null; }
    var el = document.getElementById('alloc-draft-persistence-panel');
    if (el) {
        if (el.parentElement !== host) host.insertBefore(el, host.firstChild);   // migrate a stale/body-level node into the page root
        return el;
    }
    el = document.createElement('div');
    el.id = 'alloc-draft-persistence-panel';
    el.className = 'alloc-draft-panel';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    host.insertBefore(el, host.firstChild);
    return el;
}
// Truthful persistence panel — renders from the controller state snapshot only (never from toast text).
function _renderAllocDraftPanel(s) {
    var el = _ensureAllocDraftPanel(); if (!el) return;
    var draftId = (s.draft && (s.draft.allocation_draft_id || s.draft.allocationDraftId)) || '—';
    var version = (s.draft && (s.draft.draft_version || s.draft.draftVersion)) || '—';
    var when = s.savedAt || '—';
    var source = s.source === 'DB' ? 'Database' : 'Local Recovery';
    var conflict = (s.conflictIds && s.conflictIds.length) ? (' [' + s.conflictIds.join(', ') + ']') : '';
    var issues = (s.issues && s.issues.length) ? s.issues.map(function (i) { return String(i.code) + (i.missing ? (': ' + i.missing.join('/')) : (i.routeContexts ? (': ' + i.routeContexts.length + ' routes') : '')); }).join('; ') : '';
    el.setAttribute('data-alloc-state', s.state);
    var html = '<div class="alloc-draft-panel__row"><span class="alloc-draft-panel__label">Status</span>' +
        '<span class="alloc-draft-panel__badge alloc-draft-panel__badge--' + String(s.state).toLowerCase() + '">' + _allocStateLabel(s.state) + conflict + '</span></div>' +
        '<div class="alloc-draft-panel__row"><span>Draft</span><span>' + draftId + '</span></div>' +
        '<div class="alloc-draft-panel__row"><span>Version</span><span>' + version + '</span></div>' +
        '<div class="alloc-draft-panel__row"><span>Last DB confirmation</span><span>' + when + '</span></div>' +
        '<div class="alloc-draft-panel__row"><span>Source</span><span>' + source + '</span></div>';
    if (issues) html += '<div class="alloc-draft-panel__issues">' + issues + '</div>';
    if (s.code === 'WRITE_COMMITTED_READBACK_FAILED') html += '<div class="alloc-draft-panel__issues">已寫入資料庫，正在重新確認狀態 <button type="button" onclick="_allocDraftRefresh()">Retry Readback</button></div>';
    if (s.state === 'SAVED' && s.draft && (s.draft.allocation_draft_id || s.draft.allocationDraftId)) {
        html += '<div class="alloc-draft-panel__row"><button type="button" class="alloc-draft-cancel-btn" onclick="_allocDraftCancel()">Cancel Draft</button></div>';
    }
    el.innerHTML = html;
}
function _allocDraftRefresh() { var ws = _getAllocWorkspace(); if (ws) ws.refresh(_allocWorkspaceScope()); }
window._allocDraftRefresh = _allocDraftRefresh;
function _allocDraftCancel() {
    var ws = _getAllocWorkspace(); if (!ws) return;
    var st = ws.getState();
    var draftId = (st.draft && (st.draft.allocation_draft_id || st.draft.allocationDraftId)) || '';
    var lineCount = (st.lines && st.lines.length) || 0;
    var okGo = false;
    try { okGo = window.confirm('Cancel Allocation Draft ' + draftId + '?\nScope: ' + JSON.stringify(_allocWorkspaceScope()) + '\nLines: ' + lineCount + '\nCancellation preserves history and cannot be edited afterward.'); } catch (e) { okGo = false; }
    if (!okGo) return;
    var reason = ''; try { reason = window.prompt('Cancel reason (optional):') || ''; } catch (e) { reason = ''; }
    ws.cancel(_allocWorkspaceScope(), { reason: reason });
}
window._allocDraftCancel = _allocDraftCancel;
// A complete K3 planning scope. An incomplete/unselected initial scope is NOT a persistence failure — it must never
// trigger a readback (a failed/empty read is classified SAVE_FAILED, line ~403), and must never open the panel with
// a scary global SAVE_FAILED before the user has picked a valid Country/Marketplace.
function _allocDraftScopeComplete(scope) {
    return !!(scope && scope.planning_cycle && scope.company && scope.country && scope.marketplace);
}
// Initial targeted load for the current scope (ONE request; stale-guarded inside the controller). Never getOperationDb.
function _allocDraftInitialLoad() {
    var ws = _getAllocWorkspace();
    var scope = _allocWorkspaceScope();
    if (!ws || !_allocDraftScopeComplete(scope)) return;   // incomplete scope → no DB read, no panel, no false SAVE_FAILED (stays NOT_SAVED)
    if (typeof isOperationDbApiConfigured === 'function' && isOperationDbApiConfigured()) ws.load(scope);
}
window._allocDraftInitialLoad = _allocDraftInitialLoad;

// Restore the working draft. SSOT = DB (Round 4 Decision E): try DB hydrate for the current scope
// first (DB wins); sessionStorage is only a recovery cache used when the DB has nothing / is not
// configured (headless). Never let a stale cache overwrite a successful DB load.
async function _restoreAllocationDraftFromSession() {
    try {
        var ctx = _replenCtx();
        if (typeof _allocDraftInitialLoad === 'function') { try { _allocDraftInitialLoad(); } catch (e) {} }   // C2-D2A-UI: truthful targeted readback + persistence panel
        if (ctx && (ctx.country || ctx.marketplace) && typeof _hydrateAllocationDraftFromDb === 'function') {
            // F1-7L (HALT E resolved): feed the UNCHANGED sync hydrate from a BOUNDED scoped read of the two
            // canonical draft tables (the SAME tables + normalizer the broad getters used) instead of the retired
            // whole-DB startup prime. The hydrate's country+marketplace/latest-updatedAt selection + bySku
            // transform are byte-identical — only the data transport moved off the global prime. (The scoped
            // getShippingAllocationDraftWorkspace SSOT is NOT used here: it requires planning_cycle + exact company
            // and hard-conflicts on >1 active — a different selection contract — so it is not BEFORE==AFTER.)
            // F1-7N-FB-4G-A0 §D.4 — Workspace mode reads the scoped read model, which this mount does not own
            // and must not trigger a read for (§B: only a confirmed Search loads inventory). Legacy mode keeps
            // the bounded broad-cache load exactly as before.
            try {
                if (!(typeof _irEffectiveWorkspace === 'function' && _irEffectiveWorkspace()) &&
                    window.KM && window.KM.DB && typeof window.KM.DB.refreshCacheTables === 'function' &&
                    typeof isOperationDbApiConfigured === 'function' && isOperationDbApiConfigured()) {
                    await window.KM.DB.refreshCacheTables(['shipping_allocation_drafts', 'shipping_allocation_draft_lines']);
                }
            } catch (e) { /* bounded load failed → fall through to the sessionStorage recovery cache below (as before) */ }
            if (_hydrateAllocationDraftFromDb(ctx)) {
                // F1-7N-FB-2A §D — the DB is the SSOT: what it returns IS the persisted truth, so any prior
                // UNSAVED mark is void (a route that failed to save simply is not in these rows, and correctly
                // disappears from the UI rather than lingering as a fake row).
                _irUnsavedRoutes = {};
                _irRenderUnsavedBanner_();
                return;   // DB SSOT loaded → do not overlay the cache
            }
        }
        var raw = sessionStorage.getItem(REPLEN_ALLOC_DRAFT_KEY);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && parsed.bySku) {
            replenAllocationDraft = {
                context: parsed.context || { country: '', marketplace: '' },
                targetDays: parsed.targetDays || '',
                bySku: parsed.bySku || {}
            };
            window.KM.shippingAllocationDraft = replenAllocationDraft;
            // F1-7N-FB-2A §D — restore the UNSAVED marks WITH the values. A reload therefore cannot launder a
            // failed write into canonical state: the routes come back visibly labelled and Submit stays blocked
            // until each one is actually persisted.
            _irUnsavedRoutes = (parsed._unsavedRoutes && typeof parsed._unsavedRoutes === 'object') ? parsed._unsavedRoutes : {};
            _irRenderUnsavedBanner_();
        }
    } catch (e) {}
}
// Discard the draft if the stored context no longer matches the active Country/Marketplace.
function _clearAllocationDraftIfContextChanged() {
    var ctx = _replenCtx();
    if (!_replenCtxEq(replenAllocationDraft.context, ctx)) _clearAllocationDraft();
}
// Returns the draft rows for a SKU only when the draft context matches the active search.
function _allocationDraftRowsFor(sku) {
    var ctx = _replenCtx();
    if (!_replenCtxEq(replenAllocationDraft.context, ctx)) return null;
    var rows = replenAllocationDraft.bySku[sku];
    return (rows && rows.length) ? rows : null;
}
// Capture the current Execution Plan route rows for a SKU into the Working Draft (live +
// sessionStorage). One draft row per Execution Plan route: { ship_from, destination,
// shipping_method, qty }. This is the SINGLE source Submit Plan reads (API-ready — never the DOM).
function _saveAllocationDraftFromDom(sku) {
    var routesList = document.getElementById('shipping-methods-' + sku);
    if (!routesList) return;
    var ctx = _replenCtx();
    replenAllocationDraft.context = ctx;
    replenAllocationDraft.targetDays = (document.getElementById('replenTargetDays') || {}).value || REPLEN_TARGET_DAYS;   // FM5-R4UI-R3: control removed → internal default
    // F1-7N-FB-4G-A2-R2 - the model as it stood BEFORE this rebuild, keyed by route instance. The diff below
    // is what makes one UI event write one route.
    var _priorByInstance = {}, _priorByLine = {};
    try {
        ((replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || []).forEach(function (pr) {
            var pk = String((pr && pr.client_route_instance_id) || '').trim();
            if (pk) _priorByInstance[pk] = pr;
            // A row hydrated from the database has no instance id yet, so the FIRST collect after a Search
            // would otherwise find no prior for any route, call them all new, and re-send the whole SKU. The
            // stored line id is the durable fallback key, which makes the diff correct from the first edit.
            var pl = String((pr && pr.allocation_draft_line_id) || '').trim();
            if (pl) _priorByLine[pl] = pr;
        });
    } catch (_ep) {}
    var rows = [];
    // F1-7N-FC-1B-E1 §H.3 — THE SECOND GATE, AND IT GUARDS THE MODEL RATHER THAN THE SCREEN.
    //
    // This function rebuilds the canonical model from EVERY .exec-route-row in the DOM, which is precisely how
    // the seeded placeholder got in: it was painted by a pure render, swept up here, given a
    // client_route_instance_id and a CREATE_NEW_ROUTE intent, and became a Submit candidate that then blocked
    // the whole batch. _renderExecutionRoute can no longer paint an unattributable row, so on a current build
    // there is nothing here to drop. A STALE row can still exist - a browser holding an older cached page, a
    // row left by a build from before this round - and the model must not adopt one just because the DOM has
    // it. Counted rather than silently skipped: a row that vanishes without explanation is the failure mode
    // this whole round is about.
    var _stalePlaceholders = 0;
    routesList.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
        function fieldVal(f) {
            var el = rowEl.querySelector('[data-field="' + f + '"]');
            return el ? String(el.value || '').trim() : '';
        }
        // Read the display name + warehouse_type off the SELECTED <option> of a warehouse picker (so
        // ship_from/destination stay the human label while *_warehouse_id holds the canonical value).
        function selOptData(f, attr) {
            var el = rowEl.querySelector('[data-field="' + f + '"]');
            if (!el || !el.options || el.selectedIndex < 0) return '';
            var opt = el.options[el.selectedIndex];
            return opt ? String(opt.getAttribute(attr) || '').trim() : '';
        }
        var method = fieldVal('shipping_method');
        var qty = parseInt(fieldVal('qty')) || 0;
        var sourceWarehouseId = fieldVal('source_warehouse_id');       // canonical id (option value)
        var destRawValue = fieldVal('destination_warehouse_id');       // real warehouse_id OR Amazon logical token
        var shipFrom = selOptData('source_warehouse_id', 'data-wh-name');       // display name
        var shipFromType = selOptData('source_warehouse_id', 'data-wh-type');   // warehouse_type snapshot
        var destination = selOptData('destination_warehouse_id', 'data-wh-name');
        var destType = selOptData('destination_warehouse_id', 'data-wh-type');
        // F1-7N-FB-4G-A0-R1 §D/§E — the warehouse CODE, which is what the *_warehouse_code_snapshot columns
        // are for. The collect used to hand routeHeaderFields the display NAME, so a marketplace destination
        // wrote 'Amazon' into a warehouse-code column. The Amazon logical option deliberately carries NO
        // data-wh-code, so this comes out blank for it by construction rather than by a special case.
        var shipFromCode = selOptData('source_warehouse_id', 'data-wh-code') ||
            String(rowEl.getAttribute('data-src-code-persisted') || '');
        var destinationCode = selOptData('destination_warehouse_id', 'data-wh-code');
        // Round 4 Decision B: an Amazon logical destination (MARKETPLACE_DESTINATION token) persists as
        // marketplace=Amazon + destination_warehouse_id=null (NEVER a fake warehouse_id). Real 3PL keeps
        // its warehouse_id. The actual FBA warehouse_id is resolved later at the Shipment Draft stage.
        var destPayload = (window.IRWarehouse && window.IRWarehouse.resolveDestinationPayload)
            ? window.IRWarehouse.resolveDestinationPayload(destRawValue, ctx)
            : { selected_destination_warehouse_id: (destRawValue && destRawValue.indexOf('MARKETPLACE_DESTINATION:') === 0) ? null : (destRawValue || null) };
        var isLogicalAmazon = (destType === 'MARKETPLACE_DESTINATION') || (typeof destRawValue === 'string' && destRawValue.indexOf('MARKETPLACE_DESTINATION:') === 0);
        var destWarehouseId = isLogicalAmazon ? '' : destRawValue;   // canonical To id ('' = none/logical)
        // F1-7N-FB-4F-B6-R1 §C — THE STRUCTURED VALUE, NEVER THE RENDERED TEXT.
        // This read `etaEl.textContent`, so `row.expected_arrival` held '2026-11-02 (est. 15d)' — a sentence,
        // not a date. Nothing persisted it, so it never reached the database, but it was the value the B6
        // confirmation dialog showed the operator and it is what any future wiring would have written into a
        // date column. The date now comes from the attribute the renderer publishes, and is re-validated here
        // rather than trusted: a DOM attribute is still the DOM.
        var etaEl = rowEl.querySelector('[data-field="expected_arrival"]');
        var expectedArrival = etaEl ? _irCanonicalDateOrBlank_(etaEl.getAttribute('data-eta')) : '';
        var expectedArrivalBasis = etaEl ? String(etaEl.getAttribute('data-eta-basis') || '') : '';
        var expectedArrivalSource = etaEl ? String(etaEl.getAttribute('data-eta-source') || '') : '';
        // F1-7N-FB-4G-A2-R4 §D — THE MODEL OWNS THE IDENTITY; THE DOM MIRRORS IT.
        //
        // These three were read from DOM attributes and from nothing else, so any path that dropped an
        // attribute — a re-render, a rebuilt row, the incompleteness branch below — silently turned a
        // persisted route into a brand-new one. The attribute is still read FIRST (it is the freshest thing a
        // render just wrote), but when it is absent the last known model row for THIS route instance supplies
        // it. §D.1: once a route has hydrated with an identity, it keeps that identity until the row is
        // explicitly removed or reaches a terminal status — a render can never re-derive it away.
        var _instAttr = String(rowEl.getAttribute('data-route-instance') || '').trim();
        var _priorRow = _instAttr ? _priorByInstance[_instAttr] : null;
        // §C — the row's declared provenance, read from the DOM first (a render just wrote it), then from the
        // model row this instance already had. A row with neither, and with no persisted identity to make it a
        // PERSISTED_ACTIVE_DRAFT, is a stale placeholder: it is NOT given an identity and NOT put in the model.
        var _rowProv = String(rowEl.getAttribute('data-route-provenance') || '').trim() ||
            String((_priorRow && _priorRow.route_provenance) || '').trim();
        var lineId = rowEl.getAttribute('data-line-id') ||
            String((_priorRow && _priorRow.allocation_draft_line_id) || '');   // persisted Draft line identity (§6)
        // F1-7N-FB-4F-B6 §F — what the DATABASE held for this route's destination when it was hydrated.
        var priorDestState = rowEl.getAttribute('data-dest-state') || '';
        var boundDraftId = rowEl.getAttribute('data-draft-id') ||
            String((_priorRow && _priorRow.allocation_draft_id) || '');   // the header this route is persisted under
        var boundGroupKey = rowEl.getAttribute('data-group-key') ||
            String((_priorRow && _priorRow.route_group_key) || '');       // the route group it was persisted as
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R2 — THE HEADER VERSION THIS ROUTE WAS READ AT, and the reason it
        // has to live on the row: this collector REPLACES replenAllocationDraft.bySku[sku] with what it
        // rebuilds, so anything the hydrate put on the model and this literal does not carry is destroyed by
        // the first edit — which is the event that schedules the write. draft_version was exactly that.
        // _irStoredDraftVersion_ then found nothing, the header omitted expected_draft_version, and 16_'s
        // optimistic guard runs ONLY when that field is present, so every Execution Plan save since this
        // collector shipped was an UPDATE with no concurrency precondition at all. The DB version still
        // advanced, because the writer increments whatever it finds — which is why a row at 3 was never
        // evidence that the request had declared 2.
        //
        // Read-only, and never computed: the client adopts what the server returned and sends it back. A
        // version this page never saw stays absent, and absence is now a REFUSAL rather than a free pass.
        var boundDraftVersion = rowEl.getAttribute('data-draft-version') ||
            String((_priorRow && _priorRow.draft_version) || '');
        // Re-publish what the model owns, so the DOM and the model can never disagree about identity.
        try {
            if (lineId) rowEl.setAttribute('data-line-id', lineId);
            if (boundDraftId) rowEl.setAttribute('data-draft-id', boundDraftId);
            if (boundGroupKey) rowEl.setAttribute('data-group-key', boundGroupKey);
            if (boundDraftVersion) rowEl.setAttribute('data-draft-version', boundDraftVersion);
        } catch (_eId) {}
        // ALL rows are kept in the local render/recovery draft so an in-progress (still incomplete) route
        // survives collapse/expand. Whether a row is PERSISTED to the DB is decided ONLY by the shared
        // four-field completeness gate below — a truthy "any intent" check is NOT enough (§4).
        // R6-R2 §4 — WHO AUTHORED THIS LAST MILE. The effective value is still collected exactly as before,
        // because a row that IS being written must carry the last mile it will actually ship under. What is
        // recorded beside it is whether the row is that value's author: a lane that filled the cell in, or a
        // re-render that blanked an ineligible value, is not. The touched diff reads THIS, so a derived value
        // can no longer make a route a write candidate on its own.
        var _lmEl = rowEl.querySelector('[data-field="last_mile_delivery"]');
        var _lmDerived = !!(_lmEl && _lmEl.getAttribute && _lmEl.getAttribute('data-lastmile-derived') === '1')
            && String(rowEl.getAttribute('data-lastmile-dirty') || '') !== '1';
        var row = {
            shipping_method: method,
            // R6-R1 §5 — collected from whichever control the row rendered: a picker when the method is
            // ambiguous, a hidden field carrying the single value when it is not. Blank stays blank; nothing
            // is invented, and nothing is written into a field that is not its own.
            last_mile_delivery: fieldVal('last_mile_delivery'),
            last_mile_derived: _lmDerived,
            last_mile_persisted: String(rowEl.getAttribute('data-lastmile-persisted') || ''),
            qty: qty,                              // = planned_qty (canonical)
            planned_qty: qty,
            source_warehouse_id: sourceWarehouseId,   // canonical From (warehouse_id)
            ship_from: shipFrom,                       // display name only
            ship_from_type: shipFromType,
            // F1-7N-FB-4G-A0-R1 §D — the CODE that belongs in recommended_source_warehouse_code_snapshot. It sits
            // beside the display name rather than replacing it: `ship_from` is still what the UI shows.
            source_warehouse_code: shipFromCode,
            // Amazon logical destination → destination_warehouse_id null + marketplace=Amazon (Decision B).
            destination_warehouse_id: (destPayload.selected_destination_warehouse_id == null ? '' : destPayload.selected_destination_warehouse_id),
            destination: isLogicalAmazon ? 'Amazon' : destination,   // display name only
            destination_type: isLogicalAmazon ? 'MARKETPLACE_DESTINATION' : destType,
            // §D XOR — a marketplace destination has NO warehouse code, and writing one blank is how an
            // explicit Amazon save CLEARS the legacy `Amazon` value the live H4 header carries in this column.
            destination_warehouse_code: isLogicalAmazon ? '' : destinationCode,
            // §D — the marketplace comes from the SELECTED option's own identity, never from the page filter.
            // resolveDestinationPayload derives it from the MARKETPLACE_DESTINATION token the user picked.
            destination_marketplace: isLogicalAmazon
                ? String((destPayload && destPayload.marketplace) || 'Amazon').trim() : '',
            destination_country: isLogicalAmazon ? (destPayload.country || (ctx && ctx.country) || '') : '',
            expected_arrival: expectedArrival,
            expected_arrival_basis: expectedArrivalBasis,
            expected_arrival_source: expectedArrivalSource,
            source_reason: 'pm_adjustment',
            allocation_draft_id: boundDraftId,
            route_group_key: boundGroupKey,
            // R6-R6-R4-R2 — carried, not recomputed. This is what _irStoredDraftVersion_ reads.
            draft_version: boundDraftVersion,
            // §D.6 — the selector's own value, kept so a re-render selects exactly what the user selected. For a
            // warehouse this equals destination_warehouse_id; for a marketplace it is the logical token.
            destination_token: destRawValue,
            // §F — carried forward, never re-derived: this row's PERSISTED destination state.
            destination_state: priorDestState
        };
        // F1-7N-FC-1B-E2 §C — A COMPOSER IS CLASSIFIED, NOT ADOPTED.
        //
        // A pristine composer never reaches here: it carries no `.exec-route-row` class and this loop selects
        // on that class. A TOUCHED one does, and it must be kept (the operator's edit is not thrown away) and
        // must still be denied everything a route has until it is finished: no provenance, no line id, no
        // header id, no place in the write queue. It graduates on the SAME four-field gate as everything else.
        if (_irIsComposerEl_(rowEl)) {
            row.route_kind = _irComposerKind_();
            row.composer_touched = String(rowEl.getAttribute('data-composer-touched') || '') === '1';
            if (!_isRouteComplete(row)) {
                // still a composer. Deliberately NOT given an identity, and deliberately not queued: an
                // unfinished composer has nothing to update and nothing to create.
                row.route_incomplete = true;
                row.allocation_draft_line_id = '';
                row.allocation_draft_id = '';
                row.route_provenance = '';
                row.route_intent = '';
                var _cci = String(rowEl.getAttribute('data-route-instance') || '').trim();
                if (_cci) row.client_route_instance_id = _cci;   // reuse only; never MINTED for a composer
                rows.push(row);
                return;
            }
            // COMPLETE — it graduates. From here it is an ordinary user-created route and falls through to
            // exactly the same identity, intent and queueing code every + Add Route row uses.
            row.route_provenance = (window.IRRouteProvenance && window.IRRouteProvenance.SOURCES.USER_EXPLICIT_ADD_ROUTE) ||
                'USER_EXPLICIT_ADD_ROUTE';
            try {
                rowEl.setAttribute('data-route-provenance', row.route_provenance);
                rowEl.removeAttribute && rowEl.removeAttribute('data-route-kind');
            } catch (_eG) {}
            delete row.route_kind;
            delete row.composer_touched;
        }
        row.route_provenance = row.route_provenance || _irRouteProvenanceOf_({
            route_provenance: _rowProv,
            allocation_draft_id: boundDraftId,
            allocation_draft_line_id: lineId
        });
        if (!row.route_provenance) {
            _stalePlaceholders++;
            try {
                console.warn('[replen] STALE_EXECUTION_ROUTE_DROPPED - a route row for ' + sku + ' carries no ' +
                    'provenance and no persisted identity, so it was not adopted into the Execution Plan model. ' +
                    'Nothing was written. Reload to get the current page.');
            } catch (_eSP) {}
            try { if (rowEl.parentNode) rowEl.parentNode.removeChild(rowEl); } catch (_eRm) {}
            return;
        }
        if (_isRouteComplete(row)) {
            // A complete route is persistable. Assign a STABLE line id the first time so every later edit
            // UPDATES the same shipping_allocation_draft_lines row (idempotent — no duplicate lines, §6/§13).
            if (!lineId) { lineId = _newDraftLineId(); rowEl.setAttribute('data-line-id', lineId); }
            row.allocation_draft_line_id = lineId;
            row.route_incomplete = false;
        } else {
            // F1-7N-FB-4G-A2-R4 §0/§F — A TEMPORARILY INCOMPLETE ROUTE KEEPS ITS IDENTITY.
            //
            // THIS WAS THE CANCEL + REPLACEMENT. When the route went incomplete this branch queued a
            // soft-cancel of the stored line AND erased allocation_draft_id / allocation_draft_line_id from
            // both the model and the DOM. Measured on the shipped collector: changing From rebuilds the Method
            // options, the previous Method is no longer valid so the select is cleared, the route is briefly
            // incomplete — and the route's identity was destroyed right there, its intent flipping
            // UPDATE_EXISTING -> CREATE_NEW_ROUTE. When the operator then picked a valid Method the row minted
            // a FRESH line id and the save cancelled the old ticket and created a replacement. That is the
            // live "cancelled headers + new headers" shape, and it was caused by an editor state, not by any
            // decision the operator made.
            //
            // The erasure was defended as "never overwrite the stored line with a null/invalid payload", and
            // that guarantee does not depend on it: the flush writes only `complete` routes, so an incomplete
            // route is never sent whether it holds an id or not. §F.5/§F.6 freeze the opposite — the DB keeps
            // its last complete snapshot, the row keeps its identity and its UPDATE intent, and the operator's
            // next valid Method updates THE SAME header and line.
            row.route_incomplete = true;
            row.allocation_draft_line_id = lineId;      // '' only if it was never persisted
        }
        // F1-7N-FB-4G-A2-R2 - the row's own instance identity, minted once and carried in the DOM so it
        // survives every re-render. Correlation of a request, a response and an error is by THIS, never by an
        // array position (see §6: the operator was shown a failure labelled with another route's values).
        var _cri = String(rowEl.getAttribute('data-route-instance') || '').trim();
        if (!_cri) { _cri = _newRouteInstanceId(); rowEl.setAttribute('data-route-instance', _cri); }
        row.client_route_instance_id = _cri;
        // F1-7N-FB-4G-A2-R3 §G.1 — THE ROW SAYS WHICH OPERATION IT IS, and it says so from ITS OWN persisted
        // state: a row the database already holds is an UPDATE of that row, a row it does not hold is the
        // CREATE that + Add Route produced. Deliberately NOT derived from whether a field was edited (§G.2),
        // from an array index, or from a natural key (§G.3) — each of those was a way of guessing which ticket
        // this is, and guessing is what turned one edited route into three headers.
        row.route_intent = String(row.allocation_draft_id || '').trim() ? 'UPDATE_EXISTING' : 'CREATE_NEW_ROUTE';
        try { rowEl.setAttribute('data-route-intent', row.route_intent); } catch (_eRI) {}
        rows.push(row);
    });
    if (rows.length) replenAllocationDraft.bySku[sku] = rows;
    else delete replenAllocationDraft.bySku[sku];
    if (_stalePlaceholders) {
        try { _execSyncEmptyState_(sku); } catch (_eES) {}
        try { if (typeof updateShippingAllocationTotal === 'function') updateShippingAllocationTotal(sku); } catch (_eT) {}
    }
    window.KM.shippingAllocationDraft = replenAllocationDraft;
    _persistAllocationDraft();            // recovery cache (not SSOT)
    // F1-7N-FB-4G-A2-R2 - MARK ONLY WHAT THIS EVENT ACTUALLY CHANGED. A route whose persistable signature is
    // unchanged is not re-sent, so a refusal on one route can never touch another. A complete route that holds
    // no persisted identity yet is always touched: it is the CREATE this event is for.
    rows.forEach(function (r) {
        // F1-7N-FC-1B-E2 §C.2 — A COMPOSER IS NEVER QUEUED. It is kept in the model so the operator's
        // edit survives a re-render, and that is ALL it is kept for: it has nothing to update (no stored row)
        // and nothing to create (it is not a legal route yet). Skipped HERE rather than relying on the flush's
        // completeness filter, because a guarantee that lives one layer downstream is exactly the "default
        // preview that writes nothing" claim E1 had to remove.
        if (r && String(r.route_kind || '') === _irComposerKind_()) return;
        var prior = _priorByInstance[String(r.client_route_instance_id || '')] ||
                    _priorByLine[String(r.allocation_draft_line_id || '')];
        var isNew = !(prior);
        var changed = isNew || (_irRouteSignature_(prior) !== _irRouteSignature_(r));
        var unpersisted = !String(r.allocation_draft_id || '').trim() || !String(r.allocation_draft_line_id || '').trim();
        if (changed || (unpersisted && _isRouteComplete(r))) _irMarkRouteTouched_(sku, r.client_route_instance_id);
    });
    _scheduleDraftDbPersist(sku);         // SSOT: shipping_allocation_drafts/_lines — debounced; only COMPLETE **touched** routes are written
}
// Explicit user edit on an Execution Plan route: recompute totals AND capture the Working Draft.
// (Pure render must NOT call this.)
function onExecutionRouteEdit(sku) {
    _execEnforceDistinctWarehouses(sku);   // From and To can never be the same warehouse_id (verify #19)
    _execRebuildMethodOptions(sku);        // re-filter Method from carrier_rate_cards on From/scope change (§3.5)
    // F1-7N-FC-1B-E1 §G — REMOVING THE LAST ROUTE LEAVES AN EMPTY PLAN, NOT AN EMPTY-LOOKING ONE. The
    // cancel path removes the row and calls this; before E1 the next pure re-render would then re-seed the
    // Suggested Qty placeholder into the slot the operator had just deliberately emptied, so a cancelled route
    // appeared to come back as a 520-unit blank.
    //
    // F1-7N-FC-1B-E2 §E.5 — what refills it now is a PRISTINE COMPOSER with a BLANK Qty. That is the whole
    // difference between "here is somewhere to type" and "your cancelled route came back": the slot is empty
    // of any quantity, holds no identity, and is not a submit candidate. Re-seeding the 520 here would be the
    // E1 defect restored under a new name, so a test asserts the Qty is blank rather than trusting the comment.
    _execSyncEmptyState_(sku);
    updateShippingAllocationTotal(sku);
    _irUpdateRouteEtas(sku);        // recompute Expected Arrival on From/To/Method change (§11.3)
    _saveAllocationDraftFromDom(sku);
}
// Back-compat alias (older callers).
function onAllocationEdit(sku) { onExecutionRouteEdit(sku); }
window.onExecutionRouteEdit = onExecutionRouteEdit;
window.onAllocationEdit = onAllocationEdit;
window._clearAllocationDraft = _clearAllocationDraft;

// Resolve units_per_carton for a SKU (cloud: sku_details; demo/mock: replenishmentMockData). 0 = missing.
function _replenUnitsPerCarton(sku) {
    try {
        var data = getReplenishmentData();
        var item = data && data.find(function (d) { return d.sku === sku; });
        if (item && item.unitsPerCarton) return parseInt(item.unitsPerCarton) || 0;
    } catch (e) {}
    var mock = (typeof replenishmentMockData !== 'undefined') ? replenishmentMockData.find(function (m) { return m.sku === sku; }) : null;
    return (mock && mock.unitsPerCarton) ? (parseInt(mock.unitsPerCarton) || 0) : 0;
}

// Carton-multiple validation for a SKU's Shipping Allocation (Fix 7). Shows inline red text and
// returns { valid, unitsPerCarton, reason }. Each method qty must be an integer multiple of UPC;
// a missing UPC is invalid (blocks Submit Plan).
function validateAllocationCartons(sku) {
    var methodsList = document.getElementById('shipping-methods-' + sku);
    var errDiv = document.getElementById('allocation-carton-error-' + sku);
    var upc = _replenUnitsPerCarton(sku);
    function showErr(msg) { if (errDiv) { errDiv.textContent = msg; errDiv.style.display = 'block'; } }
    function clearErr() { if (errDiv) { errDiv.textContent = ''; errDiv.style.display = 'none'; } }

    var qtys = [];
    if (methodsList) {
        methodsList.querySelectorAll('input[data-field="qty"]').forEach(function (inp) {
            qtys.push(parseInt(inp.value) || 0);
        });
    }
    var hasQty = qtys.some(function (q) { return q > 0; });
    if (!hasQty) { clearErr(); return { valid: true, unitsPerCarton: upc, reason: '' }; }

    if (!upc || upc <= 0) {
        showErr('Units per carton is missing for this SKU. Submit Plan is blocked until it is set.');
        return { valid: false, unitsPerCarton: 0, reason: 'missing_upc' };
    }
    var bad = qtys.some(function (q) { return q > 0 && (q % upc !== 0); });
    if (bad) {
        showErr('Shipping Qty must be a full carton multiple. Units per carton: ' + upc + '.');
        return { valid: false, unitsPerCarton: upc, reason: 'not_multiple' };
    }
    clearErr();
    return { valid: true, unitsPerCarton: upc, reason: '' };
}
window.validateAllocationCartons = validateAllocationCartons;

function updateShippingAllocationTotal(sku) {
    const methodsList = document.getElementById(`shipping-methods-${sku}`);
    if (!methodsList) return;

    const inputs = methodsList.querySelectorAll('input[data-field="qty"]');
    let total = 0;
    inputs.forEach(input => {
        total += parseInt(input.value) || 0;
    });

    const totalSpan = document.getElementById(`allocation-total-${sku}`);
    const hintDiv = document.getElementById(`allocation-hint-${sku}`);

    if (totalSpan) totalSpan.textContent = total;

    // R6-R1 §3 — the reconciliation is repainted wherever the planned total moves, so "AI recommends 760 /
    // currently planned 520 / 240 not yet in a route" can never drift out of step with the number above it.
    try {
        var _reconHost = document.getElementById('ir-plan-recon-host-' + sku);
        if (_reconHost && typeof _irAdviceVsPlanHtml_ === 'function') _reconHost.innerHTML = _irAdviceVsPlanHtml_(sku);
    } catch (_eRecon) {}

    // Live carton-multiple validation (inline red text under the allocation block).
    validateAllocationCartons(sku);

    if (hintDiv) {
        // 獲取工廠庫存 (CN + TW)
        const data = getReplenishmentData();
        const skuData = data.find(item => item.sku === sku);
        const factoryStock = (skuData?.cnStock || 0) + (skuData?.twStock || 0);
        
        if (total > factoryStock) {
            hintDiv.style.color = '#991B1B';
            hintDiv.textContent = `Insufficient Stock (Factory: ${factoryStock}, Need: ${total})`;
        } else {
            hintDiv.style.color = 'var(--text-muted)';
            hintDiv.textContent = `Factory Stock Available: ${factoryStock} units`;
        }
    }
}

// Escape a value for use inside an HTML attribute (Execution Plan route inputs).
function _execEsc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Execution Plan shipping-method options — REAL carrier_rate_cards read path (2026-07-28) ──────────
// Method is NO LONGER a hardcoded list. Options are derived live from `carrier_rate_cards`
// (KM.DB.getCarrierRateCards) matched to the route: origin country (From warehouse) + destination
// country (selected Marketplace/Site country — for Amazon this comes from the Site context, NEVER from
// an FBA warehouse) + marketplace. The displayed value is the rate card's real shipping_method (label
// falls back to shipping_method_label when present). No mock, no static fallback — when nothing matches
// the picker shows an explicit "No available methods" empty state. See CARRIER_AND_ROUTE_SPEC.

// A rate card is usable if it is not explicitly inactive and (when effective dates are present) today
// falls inside the effective window. carrier_rate_cards has NO is_active column — the only status
// signal is the free-text `status` field, so we exclude explicit inactive tokens rather than allow-list.
function _execRateCardUsable(rc) {
    if (!rc) return false;
    var st = String(rc.status || '').trim().toLowerCase();
    if (st === 'inactive' || st === 'disabled' || st === 'archived' || st === 'expired' || st === 'void' || st === 'deleted') return false;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    function parseD(s) { var d = new Date(String(s == null ? '' : s).trim()); return isNaN(d.getTime()) ? null : d; }
    var from = rc.effectiveFrom ? parseD(rc.effectiveFrom) : null;
    var to = rc.effectiveTo ? parseD(rc.effectiveTo) : null;
    if (from && today < from) return false;
    if (to && today > to) return false;
    return true;
}

// F1-7N-FB-4C §C — the Method picker now asks the SCOPED METHOD REGISTRY (KM.methodRegistry), which owns the
// catalogue request, its cache, its single-flight latch and the five real states. This function stays as the
// page's adapter: it builds the CANONICAL route context the registry scopes on and returns the resolution.
//
// The route context is built from IDENTITIES, never from the text in a dropdown: the source warehouse id, the
// destination warehouse CODE (or blank for a marketplace-logical destination), and the applied station's
// country + marketplace. A label is display metadata and is never an eligibility input.
function _execMethodRouteCtx(originCountry, destCountry, marketplace, sourceWarehouseId, destWarehouseCode) {
    return {
        originCountry: String(originCountry == null ? '' : originCountry).trim(),
        destinationCountry: String(destCountry == null ? '' : destCountry).trim(),
        marketplace: String(marketplace == null ? '' : marketplace).trim(),
        sourceWarehouseId: String(sourceWarehouseId == null ? '' : sourceWarehouseId).trim(),
        destinationWarehouseCode: String(destWarehouseCode == null ? '' : destWarehouseCode).trim()
    };
}
// Returns the FULL registry resolution { status, methods, error?, configuration? } for a route.
function _execResolveMethods(routeCtx) {
    var reg = (typeof window !== 'undefined' && window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg) return { status: 'ERROR', methods: [], error: { code: 'METHOD_REGISTRY_MODULE_UNAVAILABLE', message: 'The shared method registry is not loaded on this page.' } };
    return reg.resolve(_irMethodScope_(), routeCtx);
}
// The APPLIED station a catalogue belongs to. Deliberately the APPLIED scope, not the live selects: a picker
// must answer about the station whose rows are on screen, and a changed-but-unapplied selector is exactly the
// STALE_SCOPE case the registry reports rather than answering about the wrong station.
function _irMethodScope_() {
    var applied = (typeof _irSearch !== 'undefined' && _irSearch && _irSearch.applied) ? _irSearch.applied : null;
    if (applied) return { company: applied.company || '', country: applied.country || '', marketplace: applied.marketplace || '' };
    var sc = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : {};
    return { company: sc.company || '', country: sc.country || '', marketplace: sc.marketplace || '' };
}
// Back-compat shim for callers that only want the option list.
function _execRateCardMethods(originCountry, destCountry, marketplace) {
    return _execResolveMethods(_execMethodRouteCtx(originCountry, destCountry, marketplace, '', '')).methods || [];
}

// Build the Method <select> option HTML. Empty match set → single explicit empty-state option (never a
// fabricated method). A previously-saved method that is no longer in the set is dropped (not re-added).
// F1-7N-FB-4C §C — FIVE STATES, FIVE SENTENCES. The old version had one branch for "not loaded yet", ONE for
// every possible failure ("Unable to load methods"), and one for empty. A stale deployment, a failed read and a
// missing rate card are different problems with different fixes, so they can no longer share a sentence — and a
// genuine empty configuration is never reported as a transport failure.
// `resolution` is the registry's own answer; the legacy (methods, selected) call shape is still accepted.
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §5 — WHERE THE LAST MILE HAD NOWHERE TO GO.
//
// The diagnosis §5 asks for, stated plainly: the ROUTE SCHEMA can hold it. `recommended_last_mile_delivery` is a
// real column on shipping_allocation_drafts, the K2 header builder writes it, and ricK4GroupKey_ counts it as a
// route-identity dimension. What could not hold it was the ROUTE ROW IN THIS PAGE, which has five controls —
// From, To, Qty, Method, ETA — and no sixth. So a manual route saved from here has always written a BLANK
// last mile, and two services that differ only in their last mile collapsed to one identity.
//
// That is a silent drop, and §5 forbids both silent dropping and stuffing the value into a field that is not
// its own. So it gets its own control, in the Method cell rather than in a new grid column (a new column would
// mean a CSS layout change this round has no measurements for), and it appears ONLY when there is a real
// choice to make: a method offering exactly one last mile carries it invisibly on the option, and a method
// offering two or more renders the picker instead of choosing for the operator.
// ================================================================================================================
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R4 §2 — A DEMAND TO CHOOSE, WITH NOTHING TO CHOOSE WITH.
//
// R6-R1 gave the row a last-mile control. R6-R3 gave the arrival calculator a transit-profile authority. On
// the live screen the operator saw the calculator's sentence — "Choose a last mile" — beside a Method cell
// that offered no second control at all, and there was no way to answer it.
//
// MEASURED CAUSE, by running both owners on one lane. The picker's ambiguity comes from the METHOD OPTION
// (`m.lastMileAmbiguous`); the calculator's comes from `serviceProfilesForRoute` read straight off
// `carrier_lead_times`. The registry builds those options from EITHER table — rate cards when the lane is
// priced, lead times when it is not — and only the lead-time branch ever carried a last mile. So on a priced
// lane the option said nothing, the picker rendered a hidden field, and the calculator (which never reads the
// options) still saw two profiles and correctly refused to pick one. Two authorities, one question.
//
// The registry now attaches the transit authority's last-mile facts to every option whichever table named it,
// so the two agree by construction. This is the SECOND guarantee, and it is the one that cannot drift: the
// cell is built from the option list AND from the calculator's own candidate list, so a round that reintroduces
// a disagreement produces a CONTROL, not a dead-end sentence.
//
// WHY NOT ONE COMPOUND METHOD OPTION PER SERVICE PROFILE. The catalogue does define distinct profiles, and a
// compound option is the shape §2 prefers — but the option's DOM value cannot express one. `ricK4GroupKey_`
// takes the canonical service and the last mile as TWO SEPARATE route-identity axes, and the header stores
// them in two columns (`recommended_shipping_method`, `recommended_last_mile_delivery`). A value carrying both
// would be persisted as the method, corrupting one axis and leaving the other blank — which is the exact defect
// R6-R1 §5 existed to repair. Two profiles of one method therefore share one option VALUE and cannot be told
// apart by a <select>, so the honest design is the explicit control §2 calls Design B: it appears only when
// there is a real fork, and a method that runs exactly one last mile still carries it without asking anyone.
// ================================================================================================================

// The eligible last miles for the chosen method on this lane, and whether a person must choose between them.
// `eta` is the arrival calculator's answer for the same row when one is available — a SECOND WITNESS, never a
// replacement: its candidates are merged in, so the sentence and the control are produced from one set.
function _irLastMileChoices_(methods, selectedMethod, selectedLastMile, eta) {
    var svc = (typeof window !== 'undefined' && window.IRService && typeof window.IRService.matches === 'function')
        ? window.IRService.matches
        : function (a, b) { return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim(); };
    var m = null;
    (methods || []).forEach(function (x) { if (!m && svc(selectedMethod, x.value)) m = x; });
    var opts = (m && m.lastMileOptions) ? m.lastMileOptions.slice() : [];
    if (eta && eta.source === 'LAST_MILE_REQUIRED') {
        (eta.last_mile_options || []).forEach(function (v) {
            var s = String(v == null ? '' : v).trim();
            if (s && opts.indexOf(s) === -1) opts.push(s);
        });
        opts.sort();
    }
    var sel = String(selectedLastMile == null ? '' : selectedLastMile).trim();
    var selLow = sel.toLowerCase();
    var stillEligible = false;
    opts.forEach(function (o) { if (String(o).toLowerCase() === selLow) stillEligible = true; });
    // INVALIDATION, in the one place that can do it consistently (§2: reset when Method / From / To change
    // incompatibly). A stored value the method no longer runs is NOT kept — keeping it produced
    // LAST_MILE_NOT_ON_THIS_METHOD and an arrival that read as missing data. But when the lane knows NO
    // profiles at all, the stored value is kept verbatim: nothing has contradicted it, and silently blanking a
    // persisted K4 identity axis because a reference table is thin would be a data change nobody asked for.
    var value;
    if (!opts.length) value = sel;
    else if (opts.length === 1) value = opts[0];
    else value = stillEligible ? sel : '';
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §4 — DERIVED, AND IT SAYS SO.
    //
    // Two of these three branches can return a value the ROW never held: a lane with exactly one eligible
    // last mile fills it in, and an ineligible stored value is blanked. Both are right for what the operator
    // SEES — a single-option lane has nothing to ask, and an invalidated value must not be shown as still
    // chosen. Neither is an operator's decision, and on 2026-09-06 the difference was invisible: the derived
    // value went into the same DOM field the collector reads as intent, so a route nobody had touched
    // compared as edited and was written. The value is unchanged; what is added is the fact that the row is
    // not its author.
    var derived = String(value).toLowerCase() !== selLow;
    return { options: opts, ambiguous: opts.length > 1, value: value, derived: derived,
        invalidated: !!(sel && opts.length && !stillEligible), method_matched: !!m };
}
window._irLastMileChoices_ = _irLastMileChoices_;

// The Last Mile CELL — its own grid track (§6), and always present so the seven columns line up whether or not
// this particular row has a choice to make. A row with one eligible last mile shows it as text and carries it in
// a hidden field; a row with a real fork gets the picker. Either way the value is visible, which it never was
// while it lived invisibly on an option.
function _irLastMileCellHtml_(methods, selectedMethod, selectedLastMile, eta, sku, isComposer) {
    var c = _irLastMileChoices_(methods, selectedMethod, selectedLastMile, eta);
    var onchange = (isComposer ? 'onExecutionComposerEdit' : 'onExecutionMethodEdit') + '(\'' + sku + '\', this)';
    // Published on the control itself rather than on the row, because it is a fact about THIS value: a later
    // repaint that produces an authored value clears it by construction, with nothing to remember to reset.
    var derivedAttr = c.derived ? ' data-lastmile-derived="1"' : '';
    if (c.ambiguous) {
        var opts = '<option value="">Last mile…</option>';
        var selLow = String(c.value).toLowerCase();
        c.options.forEach(function (lm) {
            opts += '<option value="' + _execEsc(lm) + '"' +
                (selLow === String(lm).toLowerCase() ? ' selected' : '') + '>' + _execEsc(lm) + '</option>';
        });
        return '<select class="replen-card__select replen-card__select--lastmile" data-field="last_mile_delivery"'
            + derivedAttr
            + ' aria-label="Last mile" title="Last mile" onchange="' + onchange + '"'
            + ' onclick="event.stopPropagation()">' + opts + '</select>';
    }
    // Not a choice: state what it IS. "—" means the lane names no last mile for this service, which is a
    // different fact from an unanswered question and must not look like one.
    var shown = c.value || '—';
    return '<span class="replen-card__lastmile-static" title="' + _execEsc(shown) + '">' + _execEsc(shown) + '</span>'
        + '<input type="hidden" data-field="last_mile_delivery"' + derivedAttr
        + ' value="' + _execEsc(c.value) + '">';
}
window._irLastMileCellHtml_ = _irLastMileCellHtml_;

// Repaint one row's Last Mile cell, preserving whatever the operator has already chosen. The single place that
// swaps a picker for a static value and back, so the two can never end up in the wrong combination.
function _irPaintLastMileCell_(rowEl, methods, selectedMethod, eta, sku) {
    if (!rowEl || !rowEl.querySelector) return null;
    var cell = rowEl.querySelector('.replen-card__lastmile-cell');
    if (!cell) return null;
    var cur = cell.querySelector('[data-field="last_mile_delivery"]');
    var chosen = cur ? String(cur.value || '').trim() : '';
    // R6-R2 §4 — WITHOUT THIS, DERIVED-NESS EVAPORATES ON THE SECOND REPAINT. This function feeds the
    // current control value back into the choice, so once a single-option lane has filled the cell in, the
    // next repaint sees that value as the row's own and returns derived=false. The marker would then be
    // true exactly once and false forever after, which is worse than never having it. So a control that is
    // still carrying a derived value is fed the ROW'S STORED value instead — the same input the first
    // paint had — and the answer is stable across any number of repaints.
    var _lmWasDerived = !!(cur && cur.getAttribute && cur.getAttribute('data-lastmile-derived') === '1');
    var _lmAuthored = !!(rowEl.getAttribute && rowEl.getAttribute('data-lastmile-dirty') === '1');
    if (_lmWasDerived && !_lmAuthored) {
        chosen = String((rowEl.getAttribute && rowEl.getAttribute('data-lastmile-persisted')) || '').trim();
    }
    // The row already knows whether it is a composer; asking it here means no caller has to carry the answer,
    // and no caller can get it wrong. Guarded, because a composer row is a page concept and this is also
    // exercised in isolation.
    var isComposer = (typeof _irIsComposerEl_ === 'function') ? _irIsComposerEl_(rowEl) : false;
    cell.innerHTML = _irLastMileCellHtml_(methods, selectedMethod, chosen, eta, sku, isComposer);
    return cell;
}

function _execLastMileOptionsHtml(methods, selectedMethod, selectedLastMile, eta) {
    // R6-R4 §2 — delegated, so the option list and the cell can never disagree about what is eligible.
    var c = _irLastMileChoices_(methods, selectedMethod, selectedLastMile, eta);
    if (!c.ambiguous) return '';
    var sel = String(c.value).toLowerCase();
    var opts = '<option value="">Last mile…</option>';
    c.options.forEach(function (lm) {
        opts += '<option value="' + _execEsc(lm) + '"' + (sel === String(lm).toLowerCase() ? ' selected' : '') +
            '>' + _execEsc(lm) + '</option>';
    });
    return opts;
}
window._execLastMileOptionsHtml = _execLastMileOptionsHtml;

function _execMethodOptionsHtml(resolution, selected) {
    var res = (resolution && resolution.status) ? resolution
        : { status: (resolution && resolution.length) ? 'READY' : 'EMPTY_CONFIGURATION', methods: resolution || [] };
    var methods = res.methods || [];
    if (!methods.length) {
        if (res.status === 'LOADING' || res.status === 'IDLE') return '<option value="">Loading methods…</option>';
        if (res.status === 'STALE_SCOPE') return '<option value="">Press Search to load methods for this station</option>';
        if (res.status === 'ERROR') {
            var code = (res.error && res.error.code) || 'METHOD_REGISTRY_READ_FAILED';
            return '<option value="">Methods unavailable (' + _execEsc(code) + ') — Retry</option>';
        }
        // EMPTY_CONFIGURATION — the catalogue was read successfully and simply covers nothing here. This is a
        // CONFIGURATION answer, and it must never read like a failure.
        //
        // F1-7N-FB-4G-A3 SS.B.6/SS.B.10 — AND IT NAMES WHICH CONFIGURATION ANSWER IT IS. The registry has
        // always computed a full diagnosis for this case (which axis eliminated the cards, how many were
        // usable, and the exact row that would fix it) and the page threw all of it away, leaving the operator
        // one sentence that could equally mean an empty table, an expired effective window, a wrong
        // destination axis, or cards that match but name no method. Those have different fixes and different
        // owners, so the reason token is shown. The full proposed row stays on the resolution object for the
        // diagnostic surfaces; a <select> option is not the place for it.
        var cfgReason = (res.configuration && res.configuration.reason) || '';
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §4 — NAME THE TABLE THAT IS ACTUALLY MISSING.
        //
        // Until this round the only authority consulted was `carrier_rate_cards`, so every empty answer read
        // as "add a rate card" — and on a lane whose real gap is a missing `carrier_lead_times` row that
        // sends an operator to the wrong table, where the row they add will not help. Both authorities are
        // consulted now, and the sentence says which one is silent.
        var _ta = res.transit_authority;
        if (_ta && _ta.checked === true) {
            return '<option value="">No shipping service is configured for this lane' +
                (cfgReason && cfgReason !== 'RESOLVED' ? (' (' + _execEsc(cfgReason) + ')') : '') +
                ' — carrier_lead_times has no row for it either</option>';
        }
        return '<option value="">No eligible method configured for this route' +
            (cfgReason && cfgReason !== 'RESOLVED' ? (' (' + _execEsc(cfgReason) + ')') : '') + '</option>';
    }
    // F1-7N-FB-4G-A0-R1 §C — THE SELECTION WAS AN EXACT-TEXT COMPARISON, AND NOTHING ELSE IN THE SYSTEM
    // COMPARES SERVICES THAT WAY. The option VALUE is the rate card's `shipping_method` column verbatim (see
    // method-registry methodsForRoute); the persisted value is the header's `recommended_shipping_method`. The
    // server matches rate cards case-insensitively (crcFindRateCards_ uses eqi) and computes route identity
    // through ricCanonicalService_, and this page's own lead-time mapper lowercases before it looks anything up.
    // Only this line demanded byte equality — so a header persisted as `sea` did not select an option valued
    // `Sea`, and the operator saw the right label sitting in the list, unselected.
    //
    // IRService.matches is the shared identity test: exact text first, then canonical identity through the
    // mirror of 69_ ricCanonicalService_. An UNRECOGNISED spelling matches nothing but itself, so an unknown
    // service can never quietly select the first option, and `sea` can never answer for `sea_express`.
    // R6-R1 §5 — THE LAST MILE TRAVELS WITH THE OPTION.
    //
    // `sea + truck` and `sea + parcel` are two different services with two different transit times, and
    // `recommended_last_mile_delivery` is a real header column AND a K4 route-identity dimension — so losing
    // it here does not merely lose a label, it merges two distinct routes into one identity. The option
    // carries the last mile it belongs to, and where a method offers more than one the row renders a second
    // control rather than picking the first (see _execLastMileOptionsHtml).
    var svc = (typeof window !== 'undefined' && window.IRService && typeof window.IRService.matches === 'function')
        ? window.IRService.matches
        : function (a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); };
    var html = '<option value="">Method…</option>';
    methods.forEach(function (m) {
        var sel = svc(selected, m.value) ? ' selected' : '';
        var lmList = (m.lastMileOptions || []).join(',');
        html += '<option value="' + _execEsc(m.value) + '"' + sel +
            ' data-last-mile="' + _execEsc(m.lastMileDelivery || '') + '"' +
            ' data-last-mile-options="' + _execEsc(lmList) + '"' +
            ' data-method-source="' + _execEsc(m.source || 'CARRIER_RATE_CARDS') + '"' +
            ' data-carrier-selection="' + _execEsc(m.carrierSelection || '') + '"' +
            '>' + _execEsc(m.label) + '</option>';
    });
    return html;
}

// Re-filter every route row's Method options after a From/To/scope change: origin country is read off the
// selected From option; a still-valid selection is preserved, an out-of-scope one is cleared (§3.5).
function _execRebuildMethodOptions(sku) {
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list) return;
    var scope = _replenSelectedScope();
    list.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
        var fromEl = rowEl.querySelector('[data-field="source_warehouse_id"]');
        var toEl = rowEl.querySelector('[data-field="destination_warehouse_id"]');
        var methodEl = rowEl.querySelector('[data-field="shipping_method"]');
        if (!methodEl) return;
        var originCountry = '', sourceId = '';
        if (fromEl && fromEl.options && fromEl.selectedIndex >= 0) {
            var opt = fromEl.options[fromEl.selectedIndex];
            originCountry = opt ? String(opt.getAttribute('data-wh-country') || '').trim() : '';
            sourceId = String(fromEl.value || '').trim();
        }
        // Canonical destination identity: a real warehouse contributes its CODE; an Amazon logical destination
        // contributes none (it is identified by the marketplace axis instead), which is why the code is blank
        // rather than the word "Amazon".
        var destCode = '';
        if (toEl && toEl.options && toEl.selectedIndex >= 0) {
            var topt = toEl.options[toEl.selectedIndex];
            var isLogical = topt && String(topt.getAttribute('data-wh-type') || '') === 'MARKETPLACE_DESTINATION';
            if (!isLogical) destCode = topt ? String(topt.getAttribute('data-wh-code') || '').trim() : '';
        }
        var res = _execResolveMethods(_execMethodRouteCtx(originCountry, scope.country, scope.marketplace, sourceId, destCode));
        var methods = res.methods || [];
        // F1-7N-FB-4G-A0-R1 §C.4 — THIS IS WHERE THE PERSISTED METHOD WAS DESTROYED, and it needed no spelling
        // mismatch to happen. The route's method lives in the ROUTE MODEL; this function read it from the
        // <select>. On the FIRST paint of an expanded row the carrier catalogue is usually still in flight
        // (initializeShippingAllocation kicks off _irLoadCarrierPlanning_ and renders immediately), so
        // _execMethodOptionsHtml emits the single 'Loading methods…' option and methodEl.value is ''. This
        // function then ran on the .then() of that same load, read `current` = '', found it invalid, and
        // re-rendered the now-complete catalogue with selected = '' — leaving the correct label visible in the
        // list and nothing chosen. Measured: option present, not selected, exactly the reported symptom. Worse,
        // the collect reads the DOM, so the next save would have written a BLANK method over a stored `sea`.
        //
        // The row therefore carries its persisted method (data-method-persisted, the same discipline
        // data-eta-persisted uses), and the select's own value wins ONLY when the user has actually touched it.
        // An untouched, still-empty select falls back to what the database said.
        var userTouched = rowEl.getAttribute('data-method-dirty') === '1';
        var persistedMethod = rowEl.getAttribute('data-method-persisted') || '';
        var current = methodEl.value || (userTouched ? '' : persistedMethod);
        var svcEq = (typeof window !== 'undefined' && window.IRService && typeof window.IRService.matches === 'function')
            ? window.IRService.matches
            : function (a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); };
        var match = '';
        methods.forEach(function (m) { if (!match && svcEq(current, m.value)) match = m.value; });
        var stillValid = !!match;
        methodEl.innerHTML = _execMethodOptionsHtml(res, stillValid ? match : '');
        methodEl.value = stillValid ? match : '';
        methodEl.disabled = !methods.length;
        // The reason lives next to the control, so an operator never has to guess which of the five states
        // produced the placeholder they are looking at.
        methodEl.setAttribute('data-method-state', res.status);
        // ======================================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §5 — THE SIBLING HAS TO MOVE WITH IT.
        //
        // This function runs when the carrier catalogue finishes loading, which is normally AFTER the first
        // paint. On that first paint there were no methods, so `_execLastMileOptionsHtml` returned nothing and
        // the row rendered the hidden field. Repainting only the method <select> would leave that hidden field
        // in place next to a now-ambiguous method — and the operator would have no way to choose a last mile
        // until something else happened to re-render the row.
        //
        // The two controls are one answer to one question, so they are repainted together. A value the operator
        // has already chosen is preserved: it is read off the existing control before the swap, never reset.
        // ======================================================================================================
        // R6-R4 §2/§6 — ONE OWNER REPAINTS THE WHOLE CELL. The version below this did the swap by hand in four
        // branches, and the branch that mattered most was wrong: an unambiguous method arriving where a value
        // was already typed kept the OLD value (`only && !lmCurrent`), so changing the Method left a last mile
        // the new method does not run — which resolves to LAST_MILE_NOT_ON_THIS_METHOD and reads on screen as
        // missing lead-time data. The eligibility test and the invalidation now live in _irLastMileChoices_,
        // and this simply asks for the cell again.
        _irPaintLastMileCell_(rowEl, methods, methodEl.value, null, sku);
        if (res.status === 'ERROR' && res.error) methodEl.setAttribute('title', res.error.code + ' — ' + (res.error.message || ''));
        else if (res.status === 'EMPTY_CONFIGURATION' && res.configuration) methodEl.setAttribute('title', res.configuration.code + ' — ' + res.configuration.next_action);
        else methodEl.removeAttribute('title');
    });
}

// F1-7N-FB-4F-B1 §A/§F — EXACT SERVICE IDENTITY. THIS FUNCTION USED TO TURN sea_express INTO Sea.
//
// It was a prefix ladder:
//
//     if (m.indexOf('air') === 0) return 'Air';
//     if (m.indexOf('sea express') === 0) return 'Sea Express';   // a SPACE
//     if (m.indexOf('sea') === 0) return 'Sea';                   // caught sea_express
//
// The canonical enum is `sea_express` with an UNDERSCORE (CARRIER_AND_ROUTE_SPEC §4.5), so it missed the second
// line and matched the third. Measured, not inferred: 'sea_express' -> 'Sea'. Every Expected Arrival shown for an
// express-ocean route was therefore computed from the REGULAR ocean lead time, which is a different service with
// different transit days — a silently wrong date on a planning screen, which is worse than a blank one.
//
// It is the exact defect class the round was told to hunt: startsWith('sea') as a family fallback. So there is no
// ladder any more. Two explicit tables, canonical enum and display label, and an unknown value maps to NOTHING —
// the caller already renders 'Lead time unavailable' for that, which is the correct answer for a service whose
// lead time nobody has configured. Guessing the neighbouring service's number is not.
//
// `carrier_lead_times.shipping_method` holds the main-mode DISPLAY vocabulary (Sea / Sea Express / Air / Courier,
// CARRIER_AND_ROUTE_SPEC v1.5), which is why this mapping exists at all; `transit_type` holds the enum. Rail and
// truck have no lead-time vocabulary entry and are left unmapped rather than invented.
var IR_SERVICE_TO_LEAD_KEY_ = {
    'air': 'Air',
    'sea': 'Sea',
    'sea_express': 'Sea Express',
    'courier': 'Courier'
    // rail / truck: deliberately absent — no carrier_lead_times vocabulary for them
};
// The display forms the picker or a carrier import may legitimately carry, mapped EXACTLY. No prefix, no
// family, no transport-mode collapse. '美森海卡' is an express-ocean service and resolves to Sea Express,
// never to Sea — the label is display, `sea_express` is the identity.
var IR_LABEL_TO_LEAD_KEY_ = {
    'air': 'Air', 'sea': 'Sea', 'sea express': 'Sea Express', 'courier': 'Courier', 'express': 'Courier',
    '空運': 'Air', '普船': 'Sea', '快船': 'Sea Express', '美森海卡': 'Sea Express'
};
function _irMethodToLeadKey(method) {
    var m = String(method || '').trim().toLowerCase();
    if (!m) return '';
    if (IR_SERVICE_TO_LEAD_KEY_.hasOwnProperty(m)) return IR_SERVICE_TO_LEAD_KEY_[m];
    if (IR_LABEL_TO_LEAD_KEY_.hasOwnProperty(m)) return IR_LABEL_TO_LEAD_KEY_[m];
    return '';   // unknown service -> no lead-time mapping, and no neighbouring service's number
}

// Expected Arrival for an Execution Plan route (§11.3). ETA priority: runtime actual ETA → formal
// planned ETA → carrier_lead_times estimate. In Inventory Replenishment (planning) there is no
// runtime/formal shipment yet, so the estimate is the carrier_lead_times avg_days from today's ship
// date. If lead-time data is incomplete → explicit unavailable state (never a fabricated ETA).
// Route-template node offsets are NEVER used as a lead-time source.
// F1-7N-FB-4F-B6-R1 §E — THE PROJECT'S CALENDAR DAY, NOT THE BROWSER'S.
//
// The ETA used to be built from `new Date()` with `setHours(0,0,0,0)` — the browser's LOCAL midnight. Two
// operators looking at the same plan from two timezones could therefore read two different Expected Arrivals
// for the same route, and a value computed that way is one day out from the project calendar for anyone west
// of Taipei for part of every day. Asia/Taipei is the project's canonical wall clock (the same Shared rule F.1
// the Request Order month windows follow, and the same zone `sadCanonDate_` uses server-side to turn a Sheets
// Date into a calendar date), so the base day is read in that zone.
//
// The fallback is the browser's own date, used ONLY when Intl or the timezone database is unavailable. That is
// a degraded reading rather than a wrong one, and it is the same fallback the existing shared helper takes.
function _irProjectCalendarDay_() {
    try {
        var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
        var y, m, d;
        parts.forEach(function (p) {
            if (p.type === 'year') y = parseInt(p.value, 10);
            else if (p.type === 'month') m = parseInt(p.value, 10);
            else if (p.type === 'day') d = parseInt(p.value, 10);
        });
        if (y && m && d) return { y: y, m: m, d: d };
    } catch (e) { /* fall through */ }
    var dd = new Date();
    return { y: dd.getFullYear(), m: dd.getMonth() + 1, d: dd.getDate() };
}
// Add whole days to a calendar day and render `yyyy-MM-dd`. The arithmetic runs in UTC on purpose: a local-time
// Date crossing a DST boundary can land on 23:00 the previous day, which is exactly the silent off-by-one §E
// forbids. Nothing here ever calls toISOString() on a local-midnight Date, which is the other classic shift.
function _irIsoPlusDays_(cal, days) {
    var t = new Date(Date.UTC(cal.y, cal.m - 1, cal.d) + (Number(days) || 0) * 86400000);
    function z(n) { return ('0' + n).slice(-2); }
    return t.getUTCFullYear() + '-' + z(t.getUTCMonth() + 1) + '-' + z(t.getUTCDate());
}
// The project's canonical stored date shape. A value that is not exactly this is NOT a date, and is refused
// rather than repaired — §E: an invalid date stays blank, it is never auto-corrected into a different day.
var IR_ISO_DATE_RE_ = /^\d{4}-\d{2}-\d{2}$/;
function _irCanonicalDateOrBlank_(v) {
    var t = String(v == null ? '' : v).trim();
    if (!IR_ISO_DATE_RE_.test(t)) return '';
    var y = +t.slice(0, 4), m = +t.slice(5, 7), d = +t.slice(8, 10);
    var probe = new Date(Date.UTC(y, m - 1, d));
    // Rejects 2026-02-30 and friends instead of letting Date roll them forward into March.
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) return '';
    return t;
}
window._irProjectCalendarDay_ = _irProjectCalendarDay_;
window._irIsoPlusDays_ = _irIsoPlusDays_;
window._irCanonicalDateOrBlank_ = _irCanonicalDateOrBlank_;

// F1-7N-FB-4F-B6-R1 §C — ONE ETA CALCULATOR, RETURNING A STRUCTURED VALUE.
//
// This used to return `{ text, available }` where text was `'2026-11-02 (est. 15d)'` — a DISPLAY STRING with
// the date embedded in it. That was the only place the computed date existed, so the only way for anything
// else to obtain it was to read the rendered cell back and parse it, which is precisely what the collect was
// doing (see _saveAllocationDraftFromDom). A display string is not a value: `(est. 15d)` is not part of any
// date, and anything that persisted that field would have written the whole sentence into a date column.
//
// So the calculation now yields the DATE, and the display string is derived FROM it. There is still exactly
// one calculator; what changed is that its answer is structured.
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R3 §3 — THE DROPDOWN AND THE ARRIVAL WERE READING THE SAME TABLE IN TWO VOCABULARIES.
//
// MEASURED, by running the shipped owners against the lane the live screen shows. The Method picker offered
// three services, and every one of them produced "Lead time unavailable" — by two DIFFERENT routes to the
// same wrong answer:
//
//   two of the three -> NO_LEAD_KEY   (absent from both mapping tables, so no key at all)
//   the third        -> NO_LEAD_TIME  (mapped to a key, then no row on the lane IS spelled that way)
//
// The labels themselves are deliberately NOT written here. They are operator-maintained carrier data, and
// A0 §G.9 is the rule that keeps them out of every shipped source, precisely so that no source change can
// rename one. Quoting them inside the comment that explains why they must not be quoted would have been the
// same defect in a smaller font.
//
// The cause is one sentence. THE OPTION VALUE IS `carrier_lead_times.shipping_method` VERBATIM — the registry
// builds the picker straight from that column (methodsFromLeadTimes: `value: p.method`) — and this calculator
// then TRANSLATED it away before looking the row back up. IR_SERVICE_TO_LEAD_KEY_ was written when the sheet
// held an English display vocabulary (Sea / Sea Express / Air / Courier); the live sheet holds Chinese. So the
// picker matched the row and the arrival could not, and the two disagreed about what a method IS.
//
// THE LABEL IS NOT PARSED AND NOTHING IS TRANSLATED. What is matched is the TOKEN the header persists
// (`recommended_shipping_method`) and that ricK4GroupKey_ treats as route identity, compared through the ONE
// shared identity test (IRService.matches: exact text first, canonical identity second, an unrecognised
// spelling matching nothing but itself). Whether that token reads `sea_express` or `美森海卡` is a property of
// the data, not a thing this function is entitled to have an opinion about.
//
// THE FOLD IS NOT REIMPLEMENTED. The conservative profile — slowest max, slowest avg, fastest min, per
// (origin, destination, method, last-mile) — already has an owner in method-registry.serviceProfilesForRoute,
// and it is the same owner that produced the option. Asking it is what makes the picker and the arrival one
// answer rather than two; computing a second fold here is how they drifted apart in the first place.
//
// LAST MILE IS PART OF THE QUESTION. One ocean service delivered by truck and the same ocean service delivered
// by parcel are two services, with two transit times and two K4 identities. When the chosen method runs on
// exactly one last mile, that one is used. When it runs on more and the row has not chosen, this REFUSES with
// a named state rather than taking the first — which is the silent pick §3 forbids.
// ================================================================================================================
function _irLeadTimeProfileFor_(rows, lane, method, lastMile) {
    var reg = (typeof window !== 'undefined' && window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg || typeof reg.serviceProfilesForRoute !== 'function') {
        return { status: 'NO_PROFILE_AUTHORITY', profile: null, candidates: [] };
    }
    var svcEq = (typeof window !== 'undefined' && window.IRService && typeof window.IRService.matches === 'function')
        ? window.IRService.matches
        : function (a, b) { return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim(); };
    var all = reg.serviceProfilesForRoute(rows || [], lane || {}) || [];
    // EXACT TOKEN FIRST, canonical identity only as a fallback. Both steps are IRService.matches' own order,
    // applied to SET SELECTION rather than to a single comparison — and that distinction matters: a lane
    // carrying two spellings of one canonical service holds two token sets, and collecting both at once would
    // report an ambiguity between two last miles that no operator's choice created. A row whose token is
    // present is answered by its own token; only a token no row spells is widened.
    //
    // R6-R4 §2 — and the rule is the REGISTRY'S, not a second copy of it. The picker's option list is built by
    // the same selection, so the set this resolves over and the set the row offers are the same set. The local
    // fallback below runs only if the deployment predates the shared helper.
    var mine = (typeof reg.profilesForMethod === 'function') ? reg.profilesForMethod(all, method) : null;
    if (mine === null) {
        mine = all.filter(function (p) {
            return String(p.method == null ? '' : p.method).trim() === String(method == null ? '' : method).trim();
        });
        if (!mine.length) mine = all.filter(function (p) { return svcEq(method, p.method); });
    }
    if (!mine.length) return { status: 'NO_PROFILE_FOR_METHOD', profile: null, candidates: all };
    var want = String(lastMile == null ? '' : lastMile).trim().toLowerCase();
    if (want) {
        var exact = mine.filter(function (p) { return String(p.lastMileDelivery || '').trim().toLowerCase() === want; });
        if (exact.length) return { status: 'RESOLVED', profile: exact[0], candidates: mine };
        // A last mile the method does not run is a MISMATCH, never a reason to fall back to a different one.
        return { status: 'LAST_MILE_NOT_ON_THIS_METHOD', profile: null, candidates: mine };
    }
    // AN AMBIGUITY IS TWO CHOICES, NOT TWO ROWS. A profile whose last mile is BLANK makes no competing claim
    // about the last mile — it is a row that did not say. So the question "must a person choose?" is asked of
    // the DISTINCT NON-BLANK last miles: two of those are a real fork an operator has to resolve, and anything
    // less is not.
    var distinct = [];
    mine.forEach(function (p) {
        var v = String(p.lastMileDelivery || '').trim();
        if (v && distinct.indexOf(v) === -1) distinct.push(v);
    });
    if (distinct.length > 1) return { status: 'AMBIGUOUS_LAST_MILE', profile: null, candidates: mine };
    if (mine.length === 1) return { status: 'RESOLVED', profile: mine[0], candidates: mine };
    // Several rows, one (or no) last mile between them — the same service written more than one way. Take the
    // SLOWEST, for the reason the registry's own fold gives: one fast operator must never make a service look
    // quicker than the slowest one who actually runs it. A profile with no usable max cannot win, but it is
    // still eligible when nothing else has one, so the caller still gets a typed NO_USABLE_MAX_DAYS rather
    // than a missing answer.
    var best = null;
    mine.forEach(function (p) {
        if (best === null) { best = p; return; }
        var a = p.maxDays, b = best.maxDays;
        if (a === null || a === undefined) return;
        if (b === null || b === undefined || a > b) best = p;
    });
    return { status: 'RESOLVED_SLOWEST_OF_EQUIVALENT_SPELLINGS', profile: best, candidates: mine };
}

function _irComputeRouteEta(destCountry, route, originCountry) {
    var method = route && route.shipping_method;
    var none = { text: '—', available: false, date: '', days: null, lead_key: '', source: 'NONE' };
    if (!method) return none;
    var rows = _irCarrierGet('getCarrierLeadTimes');   // F1-7J-A2: scoped carrier reference (Workspace) / broad getter (Legacy)
    var _lane = { originCountry: originCountry, destinationCountry: destCountry };
    var _lm = String((route && route.last_mile_delivery) || '').trim();
    // R6-R3 §3 — ASK THE AUTHORITY THAT PRODUCED THE OPTION. See the note above _irLeadTimeProfileFor_.
    var _pf = _irLeadTimeProfileFor_(rows, _lane, method, _lm);
    if (_pf.status === 'AMBIGUOUS_LAST_MILE') {
        // The method runs on more than one last mile and the route has not said which. Two of them are two
        // transit times, so there is no single arrival to show, and picking one would be inventing the answer.
        return { text: 'Choose a last mile', available: false, date: '', days: null, lead_key: '',
            last_mile_options: _pf.candidates.map(function (p) { return p.lastMileDelivery; }),
            source: 'LAST_MILE_REQUIRED' };
    }
    if (_pf.profile) {
        var _mx = _pf.profile.maxDays;
        if (_mx === null || _mx === undefined) {
            // A blank max_days on every carrier that runs this service. Fail CLOSED — an absent number is not a
            // zero-day transit, and a zero-day transit would present itself as arriving before it ships.
            return { text: 'Lead time unavailable', available: false, date: '', days: null,
                lead_key: _pf.profile.method, min_days: _pf.profile.minDays, avg_days: _pf.profile.avgDays,
                max_days: null, last_mile_delivery: _pf.profile.lastMileDelivery,
                resolved_by: 'CARRIER_LEAD_TIMES_TRANSIT_PROFILE', profile_status: _pf.status,
                source: 'NO_USABLE_MAX_DAYS' };
        }
        var _d = Math.round(_mx);
        var _iso = _irIsoPlusDays_(_irProjectCalendarDay_(), _d);
        var _early = (_pf.profile.minDays === null || _pf.profile.minDays === undefined)
            ? '' : _irIsoPlusDays_(_irProjectCalendarDay_(), Math.round(_pf.profile.minDays));
        return { text: _iso + ' (latest, ' + _d + 'd)', available: true, date: _iso, days: _d,
            lead_key: _pf.profile.method, min_days: _pf.profile.minDays, avg_days: _pf.profile.avgDays,
            max_days: _mx, last_mile_delivery: _pf.profile.lastMileDelivery,
            carrier_ids: _pf.profile.carrierIds, carrier_selection: _pf.profile.carrierSelection,
            earliest_date: _early,
            range_text: _early ? (_early + ' \u2013 ' + _iso) : _iso,
            basis: 'MAX_DAYS_CONSERVATIVE',
            pricing: { available: false, reason: 'NOT_REQUIRED_FOR_TRANSIT',
                note: 'A rate card prices a lane; it does not decide how long the lane takes. No rate card is '
                    + 'consulted here and none is required.' },
            buffer_excluded_note: 'The 7-day operational buffer is a safety input for the AI Plan and is NOT part '
                + 'of this transit time. It is never added to a displayed arrival.',
            // `source` keeps its shipped value: it is published as data-eta-source and read back off the row,
            // and a second way of reaching the same date is not a reason to change what a stored field says.
            // Which authority answered is reported alongside it rather than inside it.
            resolved_by: 'CARRIER_LEAD_TIMES_TRANSIT_PROFILE',
            profile_key: _pf.profile.profileKey || '',
            profile_status: _pf.status,
            source: 'COMPUTED' };
    }
    // FALLBACK — the mapped display vocabulary. Kept, not replaced: a route saved before this round may hold a
    // value like `sea_express` that is no longer any row's spelling, and it must keep resolving to the row it
    // always resolved to. It can only ever ADD an answer where the authority above had none.
    var key = _irMethodToLeadKey(method);
    // §D.10 — an unmapped service resolves to NOTHING. It never borrows a neighbouring service's number, so
    // `sea_express` can never be answered by `sea`, in either direction.
    if (!key) return { text: 'Lead time unavailable', available: false, date: '', days: null, lead_key: '',
        profile_status: _pf.status, source: 'NO_LEAD_KEY' };
    function lo(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
    // ==========================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §6 — THE ARRIVAL WAS THE AVERAGE, AND THE LANE WAS HALF A LANE.
    //
    // Two things were wrong with the same three lines.
    //
    // (1) THE LANE. The filter matched `destinationCountry` and never `originCountry`, so a US -> US domestic
    //     row and a CN -> US ocean row were both "a US destination" and either could answer for the other.
    //     With `.filter(...)[0]` deciding it, the answer was whichever row happened to come first out of the
    //     sheet — a first-row-wins pick, on a number an operator plans a shipment around.
    //
    // (2) THE NUMBER. It used `avg_days`. An average is the middle of a distribution: roughly half of real
    //     shipments arrive AFTER it. Presenting that as the expected arrival tells an operator a date that is
    //     a coin-flip, and every downstream safety judgement inherits the optimism. The conservative arrival
    //     is `max_days` — the slowest the service is known to run — and that is what is shown.
    //
    // THE 7-DAY BUFFER IS NOT ADDED HERE, DELIBERATELY. It is operational slack the AI Plan uses to decide
    // whether a method is SAFE; it is not part of any carrier's transit commitment, and adding it to a
    // displayed arrival would present our own caution as the carrier's promise. Safety judgement and quoted
    // transit are different claims and stay in different places.
    //
    // A BLANK IS NOT A ZERO. `Number('')` is 0 and passes isFinite, so an empty max_days would render as an
    // arrival of TODAY — the fastest service on the lane, arriving before it ships. Absence is checked before
    // any coercion, and a row with no usable number simply does not answer.
    // ==========================================================================================================
    function nDays(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'string' && v.trim() === '') return null;
        var n = Number(v);
        return isFinite(n) ? n : null;
    }
    var matches = rows.filter(function (r) {
        if (lo(r.shippingMethod) !== lo(key)) return false;
        // A blank on the row is a wildcard; a blank on the query does not constrain. Marketplace is not an
        // axis here and never was — carrier_lead_times has no such column.
        if (originCountry && r.originCountry && lo(r.originCountry) !== lo(originCountry)) return false;
        if (destCountry && r.destinationCountry && lo(r.destinationCountry) !== lo(destCountry)) return false;
        return true;
    });
    // Fold CONSERVATIVELY across every carrier that runs this service on this lane: the slowest max. One fast
    // operator must not make the service look quicker than the slowest one who actually runs it.
    var maxDays = null, minDays = null, avgDays = null;
    matches.forEach(function (r) {
        var mx = nDays(r.maxDays), mn = nDays(r.minDays), av = nDays(r.avgDays);
        if (mx !== null) maxDays = (maxDays === null) ? mx : Math.max(maxDays, mx);
        if (mn !== null) minDays = (minDays === null) ? mn : Math.min(minDays, mn);
        if (av !== null) avgDays = (avgDays === null) ? av : Math.max(avgDays, av);
    });
    // §D.10 — no exact lead time = blank and an explicit unavailable state. No date is guessed.
    if (maxDays === null) {
        return { text: 'Lead time unavailable', available: false, date: '', days: null, lead_key: key,
            min_days: minDays, avg_days: avgDays, max_days: null,
            source: matches.length ? 'NO_USABLE_MAX_DAYS' : 'NO_LEAD_TIME' };
    }
    var days = Math.round(maxDays);
    var iso = _irIsoPlusDays_(_irProjectCalendarDay_(), days);
    var earliest = (minDays === null) ? '' : _irIsoPlusDays_(_irProjectCalendarDay_(), Math.round(minDays));
    return { text: iso + ' (latest, ' + days + 'd)', available: true, date: iso, days: days, lead_key: key,
        min_days: minDays, avg_days: avgDays, max_days: maxDays,
        earliest_date: earliest,
        // The range an operator plans against, and the basis of the single date shown.
        range_text: earliest ? (earliest + ' \u2013 ' + iso) : iso,
        basis: 'MAX_DAYS_CONSERVATIVE',
        buffer_excluded_note: 'The 7-day operational buffer is a safety input for the AI Plan and is NOT part '
            + 'of this transit time. It is never added to a displayed arrival.',
        source: 'COMPUTED' };
}

// F1-7N-FB-4F-B6-R1 §D.5/§D.6 — THE SINGLE OWNER OF "WHICH ETA DOES THIS ROUTE SHOW?".
//
// A PERSISTED expected_arrival is a SNAPSHOT of what was true when it was saved. It must not move because
// someone later edited the carrier lead-time table — that would silently rewrite a commitment the operator
// already made. So a stored date wins over a live computation, and the live computation is what an UNSAVED
// route shows.
//
// The snapshot is pinned to the SERVICE it was computed under: change the Method and the row is a different
// route (service is a K4 identity dimension), so the snapshot no longer describes it and the live figure
// takes over. Changing the method does not edit the stored value — the stored row keeps its own date until a
// save replaces it.
function _irRouteEtaFor(destCountry, route, originCountry) {
    route = route || {};
    var snapshot = _irCanonicalDateOrBlank_(route.expected_arrival);
    if (snapshot) {
        // Both sides go through the SAME canonicaliser, so a display spelling and its enum are one basis and
        // `sea` still never equals `sea_express`. An empty basis means "no service recorded", which is treated
        // as still-applicable rather than as a mismatch: a stored date with no recorded basis is still stored.
        // ==========================================================================================
        // R6-R3 §3 — THE TWO SIDES OF THIS COMPARISON WERE NOT THE SAME FUNCTION.
        //
        // `basis` fell back to its RAW value when the mapping table did not know it; `nowKey` did not. With a
        // live vocabulary the mapping table has never heard of — and two of the three services on the lane are
        // exactly that — the asymmetry made the two sides incomparable in both directions at once: a snapshot
        // saved under an unmapped service had a non-empty basis and a blank nowKey, so it was always
        // discarded; and had both sides collapsed to blank, EVERY unmapped method would have matched every
        // other one, and changing the Method would have left a stale date sitting under a service that never
        // earned it. (The labels are not written here: A0 §G.9 keeps operator carrier data out of every
        // shipped source, so that no source change can rename one.)
        //
        // Both sides now go through the SAME normalisation — the mapped key when there is one, otherwise the
        // token itself — and are compared through the shared service identity test. A snapshot with NO recorded
        // basis is still treated as applicable, exactly as before: a stored date with no recorded basis is
        // still a stored date, and this round is not entitled to discard one.
        // ==========================================================================================
        function _basisKey(v) {
            var raw = String(v == null ? '' : v).trim();
            if (!raw) return '';
            return String(_irMethodToLeadKey(raw) || raw).trim().toLowerCase();
        }
        var nowKey = _basisKey(route.shipping_method);
        var basis = _basisKey(route.expected_arrival_basis);
        var _svcEq = (typeof window !== 'undefined' && window.IRService && typeof window.IRService.matches === 'function')
            ? window.IRService.matches : function (a, b) { return String(a) === String(b); };
        if (!basis || basis === nowKey || _svcEq(route.expected_arrival_basis, route.shipping_method)) {
            return { text: snapshot, available: true, date: snapshot, days: null, lead_key: nowKey, source: 'PERSISTED' };
        }
    }
    return _irComputeRouteEta(destCountry, route, originCountry);
}
window._irRouteEtaFor = _irRouteEtaFor;

// Recompute + write every route row's Expected Arrival cell for a SKU (called on any route edit).
function _irUpdateRouteEtas(sku) {
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list) return;
    var destCountry = '';
    try { var data = getReplenishmentData(); var sd = data && data.find(function (d) { return d.sku === sku; }); destCountry = sd ? sd.country : ''; } catch (e) {}
    list.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
        var method = (rowEl.querySelector('[data-field="shipping_method"]') || {}).value || '';
        var cell = rowEl.querySelector('[data-field="expected_arrival"]');
        if (!cell) return;
        // F1-7N-FB-4F-B6-R1 §D.5 — THIS FUNCTION RUNS WHEN THE CARRIER REFERENCE FINISHES LOADING, which is
        // not a user edit. It must therefore never replace a PERSISTED snapshot with a freshly computed figure:
        // doing so would make a saved commitment drift every time the lead-time table changed. The row's own
        // stored value is carried on the cell, so the shared owner can make the same decision it makes at render.
        // R6-R1 §6 — the ORIGIN half of the lane, read from the row's own From selection exactly as the
        // method refresh above reads it. Without it a US -> US domestic row could answer for a CN -> US
        // ocean one, and whichever came first out of the sheet would win.
        var _fromEl = rowEl.querySelector('[data-field="source_warehouse_id"]');
        var _originCountry = '';
        if (_fromEl && _fromEl.options && _fromEl.selectedIndex >= 0) {
            var _fopt = _fromEl.options[_fromEl.selectedIndex];
            _originCountry = _fopt ? String(_fopt.getAttribute('data-wh-country') || '').trim() : '';
        }
        // R6-R3 §3 — THE LAST MILE HAD TO COME WITH IT. This synthetic route carried the method and nothing
        // else, so after a Method change (or a late catalogue settle) the profile lookup could not tell one
        // service's truck last mile from its parcel one — two different transit times — and a method offering
        // more than one would have read as ambiguous even when the operator had already chosen. It is read off
        // the row's own control, exactly as _execRebuildMethodOptions reads it.
        var _lmEl = rowEl.querySelector('[data-field="last_mile_delivery"]');
        var eta = _irRouteEtaFor(destCountry, {
            shipping_method: method,
            last_mile_delivery: _lmEl ? String(_lmEl.value || '').trim() : '',
            expected_arrival: cell.getAttribute('data-eta-persisted') || '',
            expected_arrival_basis: cell.getAttribute('data-eta-basis') || ''
        }, _originCountry);
        cell.textContent = eta.text;
        cell.setAttribute('title', eta.text || '');   // R6-R3 §4 — the clipped cell's full value, kept current
        cell.setAttribute('data-eta', eta.date || '');
        cell.setAttribute('data-eta-source', eta.source || '');
        cell.classList.toggle('replen-card__eta--na', !eta.available);
        // ==================================================================================================
        // R6-R4 §2 — NEVER "Choose a last mile" WITHOUT SOMETHING TO CHOOSE WITH.
        //
        // This is the function that writes that sentence into the cell, so it is the function that must be
        // able to answer it. It repaints the Last Mile cell on the SAME pass, from the same `eta` — which
        // carries the candidate list the refusal was based on. A future round can reintroduce a disagreement
        // between the picker's authority and the arrival's; it cannot reintroduce a dead end, because the
        // demand and the control are now one statement.
        //
        // The repaint is not conditional on the refusal: a method that STOPPED being ambiguous must lose its
        // picker just as surely, or the row would keep offering a choice that no longer exists.
        // ==================================================================================================
        try {
            var _lmMethods = (typeof _execResolveMethods === 'function' && typeof _execMethodRouteCtx === 'function')
                ? (_execResolveMethods(_execMethodRouteCtx(_originCountry, destCountry,
                    (typeof _replenSelectedScope === 'function' ? (_replenSelectedScope().marketplace || '') : ''),
                    _fromEl ? String(_fromEl.value || '') : '', '')).methods || [])
                : [];
            _irPaintLastMileCell_(rowEl, _lmMethods, method, eta, sku);
        } catch (_eLM) {}
    });
}

// ── Execution Plan warehouse pickers (2026-07-28) ────────────────────────────────────────────────
// From / To are Dropdowns sourced from the `warehouses` master — no free text. Each option's VALUE is
// the canonical warehouse_id; the label is warehouse_name (Warehouse Name is display-only, NEVER a
// stored key). Candidates are scoped to the current Company + the selected Marketplace country:
//   FROM = Factory warehouses (ANY country — factory source may be CN/TW) + company/country 3PL.
//   TO   = company/country 3PL + (Amazon marketplace only) real Amazon FBA destinations in that country.
// Every concrete option is a real warehouse_id (no fabricated Amazon id). Country/Marketplace/Company
// changes re-derive candidates on the next render; a saved selection no longer in scope is cleared.
function _execEq(a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); }
function _execWhType(w) { return String((w && w.warehouseType) || '').trim().toUpperCase(); }

function _execWarehouseCandidates() {
    var scope = _replenSelectedScope();
    var whs = _irWsGet('getWarehouses');   // F1-7J-A2: warehouses from the scoped IR read-model (Workspace) / broad getter (Legacy)

    // One central candidate contract for EVERY site (System Repair 1) — see inventory-compat.js
    // IRWarehouse.buildCandidates. Classification is by warehouse master fields (warehouse_type /
    // is_factory_warehouse), never by display name; country is UK≡GB alias-aware (no EU expansion for
    // warehouses). FROM = Factory (any country) + same-company/country Active 3PL Overseas. TO =
    // same-company/country Active 3PL Overseas + (Amazon only) matching Active FBA — every option a
    // REAL warehouse_id.
    if (window.IRWarehouse && window.IRWarehouse.buildCandidates) {
        return window.IRWarehouse.buildCandidates(whs, scope);
    }

    // Fallback (shared module absent): previous inline logic, kept only for resilience. Aligned with
    // the Round 2 strict contract — STRICT active (is_active must resolve to TRUE; blank/null/false
    // excluded) and Factory company-scoped (no blank-company sharing). It does NOT enumerate FBA
    // destinations (Amazon To handled by the legacy _execToOptionsHtml path).
    var isAmazon = _execEq(scope.marketplace, 'Amazon');
    function activeStrict(w) {
        if (!w || !w.warehouseId) return false;
        var v = w.isActive;
        if (v === true) return true;
        if (v === false) return false;
        var s = String(v == null ? '' : v).trim().toLowerCase();
        return s === 'true' || s === 'yes' || s === 'y' || s === '1';
    }
    function companyStrict(w) { return !scope.company || _execEq(w.company, scope.company); }
    function countryStrict(w) { return !scope.country || _execEq(w.country, scope.country); }

    var from = [], to = [];
    whs.forEach(function (w) {
        if (!activeStrict(w)) return;
        var t = _execWhType(w);
        var isFactory = (w.isFactoryWarehouse === true) || t === 'FACTORY';
        if (isFactory && companyStrict(w)) from.push(w);
        else if (t === '3PL' && companyStrict(w) && countryStrict(w)) from.push(w);
        if (!isAmazon && t === '3PL' && companyStrict(w) && countryStrict(w)) to.push(w);
    });
    return { from: _execDedupWh(from), to: _execDedupWh(to), isAmazon: isAmazon };
}

function _execDedupWh(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (w) { var id = String(w.warehouseId); if (seen[id]) return; seen[id] = 1; out.push(w); });
    out.sort(function (a, b) { return String(a.warehouseName || a.warehouseId).localeCompare(String(b.warehouseName || b.warehouseId)); });
    return out;
}

// Resolve a warehouse_id from a saved display name (legacy drafts that stored only ship_from/destination
// text before the picker existed). Returns '' if no candidate name matches.
function _execResolveIdByName(list, name) {
    if (!name) return '';
    var hit = (list || []).filter(function (w) { return _execEq(w.warehouseName, name); })[0];
    return hit ? String(hit.warehouseId) : '';
}

function _execNameKey(w) { return String((w && w.warehouseName) || '').trim().toLowerCase(); }
function _execNameCounts(list) {
    var counts = {};
    (list || []).forEach(function (w) { var k = _execNameKey(w); counts[k] = (counts[k] || 0) + 1; });
    return counts;
}
// One <option>. Secondary info (code / country) is appended to the label ONLY when names repeat — the
// VALUE always stays the raw warehouse_id.
function _execWhOption(w, selectedId, ambiguous) {
    var name = w.warehouseName || w.warehouseId;
    var label = name;
    if (ambiguous) { var extra = [w.warehouseCode, w.country].filter(Boolean).join(' / '); if (extra) label = name + ' (' + extra + ')'; }
    var sel = (selectedId && String(w.warehouseId) === String(selectedId)) ? ' selected' : '';
    // F1-7N-FB-4C - data-wh-code carries the warehouse CODE, which is the canonical destination axis the
    // carrier_rate_cards catalogue is keyed on (destination_warehouse_code). Without it the Method picker had to
    // fall back to country text, so it could not tell two destinations in one country apart.
    return '<option value="' + _execEsc(String(w.warehouseId)) + '" data-wh-name="' + _execEsc(name) +
        '" data-wh-code="' + _execEsc(w.warehouseCode || '') +
        '" data-wh-type="' + _execEsc(w.warehouseType || '') + '" data-wh-country="' + _execEsc(w.country || '') + '"' + sel + '>' + _execEsc(label) + '</option>';
}
function _execFromOptionsHtml(list, selectedId) {
    if (!list.length) return '<option value="">No warehouses</option>';
    var counts = _execNameCounts(list);
    var html = '<option value="">From…</option>';
    list.forEach(function (w) { html += _execWhOption(w, selectedId, (counts[_execNameKey(w)] || 0) > 1); });
    return html;
}
function _execToOptionsHtml(list, selectedId, isAmazon) {
    // Round 4 Decision B (Weekly Shipping Plan / planning level): To = eligible real 3PL warehouses
    // (value = real warehouse_id) PLUS — for an Amazon marketplace — EXACTLY ONE Amazon logical
    // destination (value = MARKETPLACE_DESTINATION token, NOT a warehouse_id; no individual FBA codes).
    // buildCandidates already appended the single logical destination for Amazon. The real FBA
    // warehouse_id is resolved later at the Shipment Draft execution stage (contract unchanged).
    if (!list.length) return '<option value="">No eligible warehouses</option>';
    var reals = list.filter(function (w) { return !w.logicalDestination; });
    var counts = _execNameCounts(reals);
    var html = '<option value="">To…</option>';
    list.forEach(function (w) {
        if (w.logicalDestination) {
            var lsel = (selectedId && String(selectedId) === String(w.token)) ? ' selected' : '';
            html += '<option value="' + _execEsc(String(w.token)) + '" data-wh-name="Amazon" data-wh-type="MARKETPLACE_DESTINATION" data-wh-country="' + _execEsc(w.country || '') + '"' + lsel + '>Amazon</option>';
        } else {
            html += _execWhOption(w, selectedId, (counts[_execNameKey(w)] || 0) > 1);
        }
    });
    return html;
}
// From and To must never be the same warehouse_id — clear the To selection if it collides (verify #19).
function _execEnforceDistinctWarehouses(sku) {
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list) return;
    list.querySelectorAll('.exec-route-row').forEach(function (rowEl) {
        var fromEl = rowEl.querySelector('[data-field="source_warehouse_id"]');
        var toEl = rowEl.querySelector('[data-field="destination_warehouse_id"]');
        if (fromEl && toEl && fromEl.value && toEl.value && fromEl.value === toEl.value) {
            toEl.value = '';
            toEl.classList.add('replen-card__select--error');
            setTimeout(function () { if (toEl) toEl.classList.remove('replen-card__select--error'); }, 1500);
        }
    });
}

// Render one Execution Plan route row: From / To / Qty / Method / Expected Arrival / Action (§11.3).
// =============================================================================================================
// F1-7N-FC-1B-E1 §B/§C — RECOMMENDATION IS NOT EXECUTION.
// -------------------------------------------------------------------------------------------------------------
// THE DEFECT, MEASURED BEFORE IT WAS REMOVED. initializeShippingAllocation had two branches: rebuild from the
// working draft, or — failing that — seed ONE blank route carrying the Suggested Qty. On the live
// CO1100-R / ResUS / US / Amazon station, with zero active allocation drafts, cancelled historical drafts, AI
// Plan never clicked and + Add Route never pressed, the shipped function rendered:
//
//     routes.length = 1 | From '' | To '' | Method '' | Qty 520 | no allocation_draft_id | no line id
//     Execution Plan Total = 520
//
// It was called a "default preview" and defended as writing nothing, and the second half was true — but
// only until the next collect. _saveAllocationDraftFromDom rebuilds the model from EVERY .exec-route-row in the
// DOM, so the first edit anywhere in that SKU's panel — pressing + Add Route to enter a real route is the
// everyday one — swept the phantom in, minted it a client_route_instance_id, stamped it
// route_intent CREATE_NEW_ROUTE, and put it in the model Submit reads. It could not be SAVED (the flush writes
// only complete routes), so it did the other thing: it BLOCKED Submit for the whole batch as an unsaved
// incomplete route. A quantity nobody had committed to stopped plans that were ready.
//
// And it was never really "seeded from the Suggested Qty" at all: with the recommendation at 0 the same blank
// row appeared carrying Qty 0. It was an unconditional default row that happened to borrow the suggestion.
//
// A Suggested Qty is a number someone might act on. An Execution Route is a thing someone has decided. There
// are exactly three ways a route may enter this model, all of them explicit acts, and IRRouteProvenance owns
// the list. There is deliberately no fourth.
// =============================================================================================================
function _irRouteProvenanceOf_(route) {
    var RP = (typeof window !== 'undefined' && window.IRRouteProvenance) ? window.IRRouteProvenance : null;
    var declared = String((route && route.route_provenance) || '').trim();
    if (RP && RP.isLegal(declared)) return declared;
    if (!RP && declared) return declared;    // module unavailable: trust the declaration rather than blank the screen
    // THE ONE PERMITTED DERIVATION, and it is not a guess about shape. A row that carries the stored identities
    // the server will re-read IS a persisted active draft - that is what those columns MEAN. Everything the
    // provenance rule forbids inferring from (a route's Qty, its group key, its completeness, the Suggested
    // Qty) is deliberately not consulted: each of those was a way of deciding a phantom looked real enough.
    var hasIdentity = !!String((route && route.allocation_draft_id) || '').trim() &&
        !!String((route && route.allocation_draft_line_id) || '').trim();
    if (hasIdentity) return 'PERSISTED_ACTIVE_DRAFT';
    return '';
}
// =============================================================================================================
// F1-7N-FC-1B-E2 §B/§C — THE MANUAL ROUTE COMPOSER.
// -------------------------------------------------------------------------------------------------------------
// E1 was right about the ROUTE and wrong about the INPUT. Removing the Suggested-Qty phantom removed a row that
// pretended to be a decision, and it also removed the only place an operator with no active route could type
// one. So the row returns as a COMPOSER, and everything that made the phantom dangerous is addressed by name:
//
//   the phantom carried Qty 520      -> a composer's Qty is BLANK. There is no number to mistake for a choice.
//   the collector adopted it         -> a PRISTINE composer does not carry `.exec-route-row`, and the collector
//                                       selects on that class, so "it is only furniture" is true of the
//                                       SELECTOR rather than of a branch further down.
//   it blocked Submit for the batch  -> a pristine composer is dropped from every preflight judgement.
//   it claimed CREATE_NEW_ROUTE      -> a composer holds no identity until all four fields are legal.
//
// It becomes an execution route at exactly one moment: when From, To, Qty > 0 and an ELIGIBLE Method are all
// present, judged by the SAME four-field gate every other route is judged by. Then it graduates to
// USER_EXPLICIT_ADD_ROUTE, mints its instance id, and is the CREATE the atomic writer takes.
// =============================================================================================================
function _irComposerKind_() {
    return (window.IRRouteComposer && window.IRRouteComposer.DOM.KIND) || 'manual-composer';
}
function _irIsComposerEl_(rowEl) {
    try { return String(rowEl.getAttribute('data-route-kind') || '') === _irComposerKind_(); } catch (e) { return false; }
}
// A composer becomes VISIBLE to the persisted-route collector the moment the operator touches it, and not
// before. Promotion is one-way and idempotent: the row keeps its composer KIND for its whole life, so a
// collect can always tell what it is, but it stops being invisible once there is an edit to preserve.
function _irPromoteComposerToTouched_(rowEl) {
    if (!rowEl || !_irIsComposerEl_(rowEl)) return false;
    if (String(rowEl.getAttribute('data-composer-touched') || '') === '1') return false;
    try {
        rowEl.setAttribute('data-composer-touched', '1');
        var cls = String(rowEl.className || '');
        if (cls.indexOf('exec-route-row') === -1) rowEl.className = (cls + ' exec-route-row').trim();
    } catch (e) { return false; }
    return true;
}
// The composer edit entry point. It promotes first, so the very edit that made the row real is the edit the
// collector sees, and then runs the ORDINARY edit path — there is no second edit pipeline to drift.
function onExecutionComposerEdit(sku, el) {
    try {
        var rowEl = (el && el.closest) ? el.closest('.ir-exec-plan__grid') : null;
        if (rowEl) _irPromoteComposerToTouched_(rowEl);
    } catch (e) {}
    if (typeof onExecutionRouteEdit === 'function') onExecutionRouteEdit(sku);
}
window.onExecutionComposerEdit = onExecutionComposerEdit;
window._irPromoteComposerToTouched_ = _irPromoteComposerToTouched_;

// F1-7N-FC-1B-E3 §A — THE EMPTY PLAN IS ONE BLANK ROW, AND NOTHING ELSE.
//
// E1 gave the empty plan a sentence because there was nothing else in it. E2 put a composer under that
// sentence, and the sentence became an instruction for a row that was sitting right there - and a row nobody
// could read as a form, because every control style in the stylesheet was scoped to `.exec-route-row`, a
// class a pristine composer deliberately does not carry (see the layout contract in
// inventory-replenishment.css). The fix for "the operator cannot tell this row is a form" was the LAYOUT, not
// more prose, so the prose is gone: `_irExecutionEmptyStateHtml_` is deleted rather than shortened, and so is
// the element it painted, because an empty <div> left behind is the blank height §A.2 forbids.
//
// The column header (From / To / Qty / Method / Expected Arrival / Action) sits directly above this row and
// names every field (§A.3), and each control carries its own accessible label (§A.5), so nothing that
// the sentence used to say is now unsaid.
function _execRenderEmptyState_(sku) {
    if (typeof document === 'undefined') return false;
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list) return false;
    if (list.querySelector && list.querySelector('.exec-route-row')) return false;   // never over a real route
    list.innerHTML = '';
    // §E.1 — EXACTLY ONE pristine composer, so an operator with no active route has somewhere to
    // type. Rendered here rather than by the caller so that every path which empties the plan (initial
    // render, the last route cancelled, a stale row dropped) produces the same one row.
    _renderManualComposer_(sku);
    return true;
}
// §B — the pristine composer. Blank From, blank To, BLANK Qty, Method disabled, no identity of any kind.
// It goes through the one row builder every other route goes through, so its pickers cannot behave differently
// from a real route's; what differs is declared in the route object, not forked in the renderer.
function _renderManualComposer_(sku) {
    return _renderExecutionRoute(sku, {
        route_kind: _irComposerKind_(),
        ship_from: '', destination: '', shipping_method: '',
        qty: '',                       // BLANK, never the Suggested Qty — that substitution was the E1 defect
        expected_arrival: ''
    });
}
window._renderManualComposer_ = _renderManualComposer_;
// F1-7N-FC-1B-E3 §A/§H.2 — what used to remove the empty-plan MESSAGE now removes the empty
// plan's COMPOSER, at the same call site and for the same reason: a plan that holds a real route must not
// still be showing the furniture that stood in for one. It is a PRISTINE composer only. A TOUCHED one holds
// the operator's own typing and is never removed by a render - the AI Plan path refuses to run over one
// (§H.3) rather than deleting it here, because a render is the wrong place to discard an edit.
function _execDropPristineComposers_(sku) {
    if (typeof document === 'undefined') return false;
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list || !list.querySelectorAll) return false;
    var rows = list.querySelectorAll('.exec-route-composer'), dropped = 0;
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var touched = String((r.getAttribute && r.getAttribute('data-composer-touched')) || '') === '1';
        if (!touched && r.parentNode) { r.parentNode.removeChild(r); dropped++; }
    }
    return dropped > 0;
}
// Show the empty state exactly when there is nothing to show, called after any path that can remove the last
// route. §G: this is what stops a cancelled route's slot being refilled by anything at all.
function _execSyncEmptyState_(sku) {
    if (typeof document === 'undefined') return;
    var list = document.getElementById('shipping-methods-' + sku);
    if (!list || !list.querySelectorAll) return;
    // F1-7N-FC-1B-E2 — THREE STATES, because a composer is neither a route nor nothing.
    //
    // A touched composer carries `.exec-route-row` (that promotion is what makes it collectable) and is still
    // NOT a route, so counting that class alone answers wrongly in both directions: it would delete an edit in
    // progress by re-rendering over it, and it would clear the empty-plan message for a plan that holds no
    // route at all. Real routes are the rows that are not composers.
    var all = list.querySelectorAll('.exec-route-row');
    var composerCount = list.querySelectorAll('.exec-route-composer').length;
    var routeCount = 0;
    for (var _i = 0; _i < all.length; _i++) { if (!_irIsComposerEl_(all[_i])) routeCount++; }
    if (routeCount === 0 && composerCount === 0) {
        _execRenderEmptyState_(sku);            // nothing at all: ONE fresh blank composer
    } else if (routeCount > 0) {
        _execDropPristineComposers_(sku);       // a real route exists: the empty plan's furniture goes
    }
    // routeCount === 0 && composerCount > 0 — the operator is composing. Left exactly as they left it.
}
window._execSyncEmptyState_ = _execSyncEmptyState_;
window._execDropPristineComposers_ = _execDropPristineComposers_;

function _renderExecutionRoute(sku, route) {
    route = route || {};
    // §C — A ROW THIS FUNCTION CANNOT ATTRIBUTE IS NOT PAINTED. The fourth source is not merely absent
    // from the code, it is unrepresentable: the only creator of an .exec-route-row refuses to make one that
    // cannot say which of the three explicit acts produced it. A future reintroduction of the seeded
    // placeholder therefore has to defeat this gate in the open rather than by adding a call.
    // F1-7N-FC-1B-E2 — a COMPOSER is exempt from the provenance gate because it is not claiming to be an
    // execution route. It gets no provenance, no identity and no `.exec-route-row` class until it is complete;
    // what it gets is the same pickers, so the operator is typing into the real thing.
    var _isComposer = String(route.route_kind || '') === _irComposerKind_();
    var _prov = _isComposer ? '' : _irRouteProvenanceOf_(route);
    if (!_isComposer && !_prov) {
        try {
            console.warn('[replen] ROUTE_PROVENANCE_REQUIRED - refused to render an execution route for ' + sku +
                ' with no declared provenance. Nothing was rendered and nothing was written.');
        } catch (e) {}
        return false;
    }
    // A composer's Qty is BLANK, not 0: `0` is a quantity someone could read as a decision, and the E1 defect
    // was exactly a number nobody had chosen being presented as one. An execution route keeps its stored value.
    var qty = _isComposer ? '' : (parseInt(route.qty) || 0);
    var scope = _replenSelectedScope();
    var destCountry = '';
    try { var data = getReplenishmentData(); var sd = data && data.find(function (d) { return d.sku === sku; }); destCountry = sd ? sd.country : ''; } catch (e) {}
    if (!destCountry) destCountry = scope.country;   // Amazon dest country comes from Site/Marketplace context
    // R6-R1 §6 — the ETA is computed BELOW, once the From warehouse (and therefore the origin country) is
    // resolved. It used to be computed here, before anything knew where the shipment starts, so the lookup
    // matched on destination alone and a domestic row could answer for an international one.
    // Warehouse picker candidates for the current scope + the saved (or name-resolved) selections.
    var cand = _execWarehouseCandidates();
    var fromSelId = route.source_warehouse_id || _execResolveIdByName(cand.from, route.ship_from);
    // F1-7N-FB-4F-B6 §D.6/§E.2 — the persisted TOKEN selects first. For a warehouse the token IS the id, so
    // this is a no-op for that case; for a marketplace it is the only value the option list can match. The
    // display-name fallback is kept last for a locally-collected row that carries no token.
    var toSelId = route.destination_token || route.destination_warehouse_id || _execResolveIdByName(cand.to, route.destination);
    // §E.3/§F.1 — a persisted route whose destination the database does not hold. It renders with its real
    // From / Method / Qty and a BLANK To carrying a stated requirement — never a pre-selected marketplace.
    var needsDest = (route.destination_state === 'DESTINATION_CONFIRMATION_REQUIRED' ||
        route.destination_state === 'DESTINATION_AMBIGUOUS');
    var fromDisabled = cand.from.length ? '' : ' disabled';
    // System Repair 1: To is enabled only when there are REAL candidates (Amazon no longer force-enabled
    // via a synthetic option). Empty → disabled + explicit empty state, for every site type alike.
    var toDisabled = cand.to.length ? '' : ' disabled';
    // Method options from real carrier_rate_cards, keyed on the chosen From origin country (if any) +
    // destination country + marketplace. No hardcoded fallback.
    var fromWh = cand.from.filter(function (w) { return String(w.warehouseId) === String(fromSelId); })[0];
    var originCountry = fromWh ? fromWh.country : '';
    var eta = _irRouteEtaFor(destCountry, route, originCountry);
    var toWh = cand.to.filter(function (w) { return !w.logicalDestination && String(w.warehouseId) === String(toSelId); })[0];
    var _mres = _execResolveMethods(_execMethodRouteCtx(originCountry, destCountry, scope.marketplace,
        fromSelId || '', toWh ? (toWh.warehouseCode || '') : ''));
    var methods = _mres.methods || [];
    var methodOpts = _execMethodOptionsHtml(_mres, route.shipping_method);
    // R6-R1 §5 / R6-R4 §2 — the last mile that belongs to the chosen method. Both the choices and the single
    // carried value are now resolved by _irLastMileChoices_, which is also what the repaint and the arrival
    // refresher use, so the three cannot form three opinions about one route.
    // F1-7N-FC-1B-E2 §D.1-§D.3 — A METHOD CANNOT BE OFFERED FOR A ROUTE THAT DOES NOT EXIST YET.
    //
    // Until BOTH From and To are chosen there is no lane to look a carrier up for, so the Method select stays
    // disabled rather than showing options resolved from a half-known route. This is a real distinction, not
    // cosmetics: the existing resolver keys on origin country + destination country + marketplace, and with a
    // blank From it would answer for a lane the operator has not described. §D.7 is preserved downstream —
    // NO_LEAD_TIME (a method exists, its transit time does not) and NO_ELIGIBLE_METHOD_CONFIGURED (the rate
    // cards cover nothing here) stay separate answers from KMWRR/_execResolveMethods, never merged into one.
    var _routeResolvable = !!String(fromSelId || '').trim() && !!String(toSelId || '').trim();
    var methodDisabled = (methods.length && _routeResolvable) ? '' : ' disabled';
    // The edit entry point differs for a composer: its first edit has to PROMOTE the row before the ordinary
    // collect runs, or the collector would still be selecting past it.
    var _editFn = _isComposer ? 'onExecutionComposerEdit' : 'onExecutionRouteEdit';
    var _editArg = _isComposer ? ', this' : '';
    var row = document.createElement('div');
    // §B — a PRISTINE composer deliberately does NOT carry `.exec-route-row`. The collector selects on that
    // class, so this is what makes "not collected while untouched" a property of the SELECTOR rather than a
    // branch the next round could forget. It is added by _irPromoteComposerToTouched_ on the first edit.
    row.className = _isComposer ? 'exec-route-composer ir-exec-plan__grid' : 'exec-route-row ir-exec-plan__grid';
    if (_isComposer) row.setAttribute('data-route-kind', _irComposerKind_());
    // §C — carried on the row because a collect rebuilds the model FROM the DOM: a provenance that does
    // not survive a re-render is a provenance the next collect has to guess at.
    if (!_isComposer) row.setAttribute('data-route-provenance', _prov);
    // Persisted Draft line identity (Round 4 Decision E) — enables incremental update + soft-cancel of
    // the SAME shipping_allocation_draft_lines row (empty for a new/unsaved route).
    if (route && route.allocation_draft_line_id) row.setAttribute('data-line-id', String(route.allocation_draft_line_id));
    // F1-7N-FB-4B-ADDENDUM — the header this route is bound to. A collect rebuilds every row from the DOM, so
    // without these the page would forget which of a SKU's several headers each route belongs to and the next
    // save could soft-cancel or overwrite the wrong shipment group.
    if (route && route.allocation_draft_id) row.setAttribute('data-draft-id', String(route.allocation_draft_id));
    if (route && route.route_group_key) row.setAttribute('data-group-key', String(route.route_group_key));
    // R6-R6-R4-R2 — and the version that header was READ at. It travels with the identity because the
    // collector rebuilds from the DOM; a version left only on the model does not survive one edit.
    if (route && route.draft_version) row.setAttribute('data-draft-version', String(route.draft_version));
    // F1-7N-FB-4F-B6 §F — a collect rebuilds every row from the DOM, so the fact that THIS row came out of the
    // database WITHOUT a destination has to survive on the row itself. Without it the next save could not tell an
    // adoption of an existing legacy header apart from an ordinary edit, and adoption is the one that needs an
    // explicit confirmation before anything is written.
    if (route && route.destination_state) row.setAttribute('data-dest-state', String(route.destination_state));
    // F1-7N-FB-4G-A0-R1 §C.4 — the STORED service, kept with the row. The Method <select> cannot hold it while
    // the carrier catalogue is still loading, and the async rebuild that follows reads the DOM; without this the
    // persisted service is simply gone by the time the options exist. Never a label — the stored value itself.
    row.setAttribute('data-method-persisted', String((route && route.shipping_method) || ''));
    // R6-R2 §4 — the STORED last mile, for exactly the reason the stored method needs one: a collect
    // rebuilds every row from the DOM, and the cell may be showing a value the lane derived rather than the
    // one the database holds. Without this the row has no way to answer 'what did I actually come in as?'.
    row.setAttribute('data-lastmile-persisted', String((route && route.last_mile_delivery) || ''));
    // §D/§G — the STORED source warehouse code snapshot, kept with the row for the same reason: a collect
    // rebuilds every row from the DOM, and a snapshot that is not on the row cannot survive one.
    row.setAttribute('data-src-code-persisted', String((route && route.source_warehouse_code) || ''));
    row.innerHTML =
        '<select class="replen-card__select replen-card__select--wh" data-field="source_warehouse_id" aria-label="From" title="From" onchange="' + _editFn + '(\'' + sku + '\'' + _editArg + ')" onclick="event.stopPropagation()"' + fromDisabled + '>' + _execFromOptionsHtml(cand.from, fromSelId) + '</select>' +
        '<span class="replen-card__to-cell' + (needsDest ? ' replen-card__to-cell--needs-confirm' : '') + '">' +
        '<select class="replen-card__select replen-card__select--wh" data-field="destination_warehouse_id" aria-label="To" title="To" onchange="' + _editFn + '(\'' + sku + '\'' + _editArg + ')" onclick="event.stopPropagation()"' + toDisabled + '>' + _execToOptionsHtml(cand.to, toSelId, cand.isAmazon) + '</select>' +
        (needsDest ? '<span class="replen-card__to-warning" data-field="destination_confirmation">Destination confirmation required</span>' : '') +
        '</span>' +
        '<input class="replen-card__input" type="number" data-field="qty" aria-label="Qty" title="Qty" value="' + qty + '" oninput="' + _editFn + '(\'' + sku + '\'' + _editArg + ')" onclick="event.stopPropagation()">' +
        // R6-R1 §5 — the Method cell holds the SERVICE, and a service is (method, last mile). The second
        // control appears only when the chosen method actually runs on more than one last mile; otherwise the
        // single value rides invisibly on the option and is collected from the hidden field beside it.
        '<span class="replen-card__method-cell">' +
        '<select class="replen-card__select" data-field="shipping_method" aria-label="Method" title="' + (methodDisabled ? 'Choose From and To first' : 'Method') + '" onchange="' + (_isComposer ? 'onExecutionComposerEdit' : 'onExecutionMethodEdit') + '(\'' + sku + '\', this)" onclick="event.stopPropagation()"' + methodDisabled + '>' + methodOpts + '</select>' +
        '</span>' +
        // R6-R4 §6 — the Last Mile gets a TRACK, not a corner of the Method cell. It is a route-identity axis
        // in its own right (ricK4GroupKey_ counts it separately from the service), and while it lived inside
        // the Method cell it was invisible on every row that had no choice to make — so an operator could not
        // see what a saved route's last mile actually was. The cell is ALWAYS rendered, so the seven columns
        // line up whether this row shows a picker, a single value, or a lane that names none.
        '<span class="replen-card__lastmile-cell">' + _irLastMileCellHtml_(methods, route.shipping_method, route.last_mile_delivery, eta, sku, _isComposer) + '</span>' +
        // F1-7N-FB-4F-B6-R1 §C — the cell carries the STRUCTURED date in data-eta and the human sentence in its
        // text. A later collect reads the attribute; nothing ever parses the sentence. data-eta-persisted keeps
        // the stored snapshot with the row so an async recompute cannot quietly replace it with a live figure.
        // R6-R3 §4 — the cell CLIPS to its track, so the full string travels in `title`.
        '<span class="replen-card__eta' + (eta.available ? '' : ' replen-card__eta--na') + '" data-field="expected_arrival" aria-label="Expected Arrival" title="' + _execEsc(eta.text || '') + '"' +
        ' data-eta="' + _execEsc(eta.date || '') + '" data-eta-source="' + _execEsc(eta.source || '') + '"' +
        ' data-eta-persisted="' + _execEsc(_irCanonicalDateOrBlank_(route.expected_arrival)) + '"' +
        ' data-eta-basis="' + _execEsc(String(route.expected_arrival_basis || '')) + '">' + _execEsc(eta.text) + '</span>' +
        '<button class="replen-card__remove-btn" onclick="removeExecutionRoute(event, \'' + sku + '\')" aria-label="' + (_isComposer ? 'Clear this row' : 'Delete this route') + '" title="' + (_isComposer ? 'Clear' : 'Delete') + '">×</button>';
    var list = document.getElementById('shipping-methods-' + sku);
    // F1-7N-FC-1B-E3 — a REAL route arriving retires the empty plan's composer (§H.2: after an AI
    // Plan the operator must see the AI routes, not the AI routes plus a leftover blank row). A composer
    // appending itself obviously does not, or the first one would delete the second.
    if (list) { if (!_isComposer) _execDropPristineComposers_(sku); list.appendChild(row); }
    return true;
}

// F1-7N-FB-4G-A0-R1 §C.4 — a METHOD change is the one edit that has to be distinguishable from every other,
// because the async catalogue rebuild has to know whether an empty <select> means "the user cleared it" or "the
// options had not arrived yet". Marking the row is the only thing this adds; everything else is the existing
// edit path, unchanged.
function onExecutionMethodEdit(sku, el) {
    try {
        var row = el && el.closest ? el.closest('.exec-route-row') : null;
        // R6-R2 §4 — THE LAST MILE PICKER ALSO ARRIVES HERE, and it used to mark the METHOD dirty. That
        // is not a cosmetic mislabel: `data-method-dirty` is what tells the async catalogue rebuild that an
        // empty Method <select> means 'the operator cleared it' rather than 'the options had not loaded',
        // so choosing a last mile could make the row forget its own persisted service. Each control now
        // marks its own field, and the last mile gains the marker that gives its value operator authority.
        var _field = String((el && el.getAttribute && el.getAttribute('data-field')) || '');
        if (row) row.setAttribute(_field === 'last_mile_delivery' ? 'data-lastmile-dirty' : 'data-method-dirty', '1');
    } catch (e) {}
    if (typeof onExecutionRouteEdit === 'function') onExecutionRouteEdit(sku);
}
window.onExecutionMethodEdit = onExecutionMethodEdit;

// + Add Route: append a blank Execution Plan route the PM fills in.
function addExecutionRoute(event, sku) {
    if (event) event.stopPropagation();
    // F1-7N-FB-4G-A2-R3-R1 §G.1/§G.3 — a save that is still in flight owns the routes it is writing. Adding a
    // route now would enter the next batch before this one has stamped the identities it is about to return,
    // and the operator would be editing rows whose persisted state is not yet known. The button is disabled
    // while a batch runs; this is the second gate, at the call site, for a keyboard or programmatic caller.
    if (typeof _irAnySaveInFlight_ === 'function' && _irAnySaveInFlight_()) {
        try { alert('A save is still in progress.\n\nAdd Route is available again as soon as the current routes finish saving — this prevents a new route from being written before the running save has recorded what it saved.'); } catch (e) {}
        return false;
    }
    // F1-7N-FB-4G-A2-R4 §K.2 — A DEPLOYMENT THAT CANNOT SAVE MUST NOT LET A ROUTE BE ADDED.
    //
    // A route ticket is written by exactly one action. When the deployment does not provide it the save fails
    // closed with ROUTE_ATOMIC_WRITER_UNAVAILABLE — correct, but only AFTER the operator has typed a whole
    // route. This is the same fact, checked before the work: adding a route that provably cannot be saved is
    // not an editable state, it is a trap. (The live incident reached this through a REQUIRED action that
    // lived in a TEMP file; §J moved it, and this is the second, independent guard.)
    if (!(window.KM && window.KM.DB && typeof window.KM.DB.upsertShippingAllocationDraftAtomic === 'function')) {
        try { alert('Cannot add a route — ROUTE_ATOMIC_WRITER_UNAVAILABLE.\n\nThis deployment does not provide the action a route ticket is saved with, so a new route could not be saved. Nothing was added and nothing was written. Sync the Apps Script deployment and publish a new version, then reload.'); } catch (e) {}
        return false;
    }
    // F1-7N-FC-1B-E1 §F — the provenance is the BUTTON, and this is the only call site that may claim
    // it. The row starts blank on purpose (§F.3: the operator's own intent is the row's justification, not a
    // prefilled quantity) and, being incomplete, is written nowhere until it is finished.
    var _added = _renderExecutionRoute(sku, {
        route_provenance: (window.IRRouteProvenance && window.IRRouteProvenance.SOURCES.USER_EXPLICIT_ADD_ROUTE) ||
            'USER_EXPLICIT_ADD_ROUTE'
    });
    if (!_added) return false;
    onExecutionRouteEdit(sku);
    syncExpandPanelHeight(sku);
}

// Delete an Execution Plan route = SOFT CANCEL the persisted Draft line (Round 4 Decision E §16);
// never a hard delete. If the row was persisted (has data-line-id) its DB line is soft-cancelled
// (line_status='cancelled'); the remaining rows are re-saved incrementally. New/unsaved rows just
// drop from the DOM. (No-op headless — API not configured.)
function removeExecutionRoute(event, sku) {
    if (event) event.stopPropagation();
    // F1-7N-FC-1B-E3 — the composer's Action cell was DEAD: this selected `.exec-route-row`, and a
    // pristine composer does not carry that class, so its X did nothing whatsoever. Clearing a composer is a
    // zero-write act by construction (it holds no line id and no draft id to cancel), and _execSyncEmptyState_
    // puts one fresh blank row back when it was the only thing on screen.
    var _crow = event.target.closest ? event.target.closest('.exec-route-composer') : null;
    if (_crow && !_crow.classList.contains('exec-route-row')) {
        if (_crow.parentNode) _crow.parentNode.removeChild(_crow);
        _execSyncEmptyState_(sku);
        updateShippingAllocationTotal(sku);
        return false;
    }
    var row = event.target.closest('.exec-route-row');
    if (row) {
        var lineId = row.getAttribute('data-line-id');
        var lineDraftId = row.getAttribute('data-draft-id') || '';
        // F1-7N-FB-4G-A2-R4 §I.1 — CANCELLING A PERSISTED ROUTE IS AN EXPLICIT, CONFIRMED ACT.
        //
        // §I freezes the list of things allowed to soft-cancel a draft, and the first entry requires the
        // operator to confirm. This removed a stored ticket from the database on a single click with no
        // question asked — the only remaining unconfirmed cancel once the edit-driven ones were removed.
        // An UNSAVED row has nothing to cancel and is dropped without a prompt, as before.
        if (lineId && typeof _cancelAllocationDraftLine === 'function') {
            var _goCancel = false;
            try {
                _goCancel = window.confirm('Remove this saved route from the Execution Plan?\n\n' +
                    'Route ticket: ' + lineDraftId + '\nLine: ' + lineId + '\n\n' +
                    'The stored draft line is cancelled (kept for audit, never hard-deleted). ' +
                    'This is not how you change a route — editing From / To / Method / Qty updates this same ticket in place.');
            } catch (e) { _goCancel = false; }
            if (!_goCancel) return false;      // ZERO WRITE, and the row stays exactly as it is
            _cancelAllocationDraftLine(lineId, lineDraftId);
        }
        row.remove();
        onExecutionRouteEdit(sku);
        syncExpandPanelHeight(sku);
    }
}
window.addExecutionRoute = addExecutionRoute;
window.removeExecutionRoute = removeExecutionRoute;

function syncExpandPanelHeight(sku) {
    // No-op. Expand-row equal height is now CSS-native: .fixed-col / .fixed-body are flex columns and
    // .replen-expand-panel--fixed { flex:1 } stretches the SKU identity panel to the taller .scroll-col
    // (via .table-body-bar's default align-items:stretch). This must NEVER write inline height again —
    // doing so reintroduced the two-stage first-paint height flash. Kept as a stub so existing callers
    // (Execution Plan route add/remove) don't break; when the right panel's content changes height, the
    // left panel re-stretches in the same frame with no measurement.
}

// Render the Execution Plan routes for a SKU (from Working Draft, or a default preview).
function initializeShippingAllocation(sku, skuData, opts) {
    const methodsList = document.getElementById(`shipping-methods-${sku}`);
    if (!methodsList || !skuData) return;

    // F1-7J-A2: lazily load the scoped carrier reference (carrier_lead_times + carrier_rate_cards) ONCE via the IR
    // workspace include.carrierPlanning, then refresh this SKU's method options + ETAs. Legacy mode resolves
    // instantly from the broad getter. No broad Operation DB in the canonical path.
    //
    // F1-7N-FB-4G-A1 - THIS .then() WAS THE SECOND PAINT. It corrected the Method select and the Expected
    // Arrival of routes that had already been shown, which is why the operator saw 'Loading methods...'
    // become the stored service's label (A0 §G.9: those labels are operator DATA and are deliberately
    // spelled in no shipped source) and 'Lead time unavailable' become a date. When the barrier has waited
    // for the catalogue to reach a TERMINAL state there is nothing left to correct - re-running it would
    // repaint identical HTML one frame later, which is the second render transaction §E forbids. Every other
    // caller (a scope change, an explicit retry) still gets the refresh, because for them it is a refresh.
    if (!(opts && opts.catalogueSettled) && typeof _irLoadCarrierPlanning_ === 'function') {
        _irLoadCarrierPlanning_().then(function () {
            if (typeof _execRebuildMethodOptions === 'function') _execRebuildMethodOptions(sku);
            if (typeof _irUpdateRouteEtas === 'function') _irUpdateRouteEtas(sku);
        });
    }

    // 1) If a Working Draft exists for this SKU (same context), rebuild the Execution Plan from it
    //    so PM edits survive collapse / expand. This is a pure render — it must NOT re-capture.
    var draftRows = _allocationDraftRowsFor(sku);
    if (draftRows && draftRows.length) {
        draftRows.forEach(function (r) { _renderExecutionRoute(sku, r); });
        updateShippingAllocationTotal(sku);
        _execSyncEmptyState_(sku);      // every row refused for want of provenance leaves the plan empty, not blank
        return;
    }

    // 2) NOTHING HAS BEEN PLANNED YET, and that is now what the screen says.
    //
    // F1-7N-FC-1B-E1 §B/§D — THIS BRANCH USED TO SEED A ROUTE. It rendered one blank row carrying the
    // Suggested Qty, and the Suggested Qty is a RECOMMENDATION: a number the operator may act on, not a
    // decision they have made. Presenting it as an Execution Route made the two indistinguishable on screen,
    // gave the phantom a Total of 520 to display, and handed the next collect a row to adopt into the
    // canonical model. See the block above _renderExecutionRoute for the measured consequence.
    //
    // The Recommendation Summary, the Suggested Qty cell and the Gap are UNCHANGED and still shown: removing
    // the phantom removes an execution artefact, not the advice. What is gone is the pretence that the advice
    // had already been acted on. No route object, no instance id, no dirty mark, no scheduled write —
    // this branch now paints text and recomputes a total that is 0 because there is nothing to add up.
    _execRenderEmptyState_(sku);
    updateShippingAllocationTotal(sku);
}

window.initializeShippingAllocation = initializeShippingAllocation;

window.openShippingAllocation = openShippingAllocation;
window.openAISuggestion = openAISuggestion;
window.updateShippingAllocationTotal = updateShippingAllocationTotal;


// ========================================
// Inventory Replenishment - 從 app.js 搬移 (批次 3: Charts + Modals)
// ========================================

// ========================================

function initSalesTrendChart(sku, skuData) {
    const canvas = document.getElementById(`sales-trend-chart-${sku}`);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const today = new Date();
    const labels = [];
    const data = [];

    const realTrend = skuData && Array.isArray(skuData.salesTrend7d) ? skuData.salesTrend7d : null;
    if (realTrend && realTrend.length) {
        // Cloud mapping: SEVEN calendar dates ending on the latest DB date (#2). Every date is shown on
        // the x-axis; a day with no row has units === null → rendered as a GAP (never a fabricated 0).
        realTrend.forEach(function(pt) { labels.push(pt.label); data.push(pt.units == null ? null : pt.units); });
    } else if (skuData && skuData._source === 'cloud-mapping') {
        // Cloud mapping with no daily-sales data — show empty (never fabricate sales).
    } else {
        // Demo fallback: synthetic past-7-day shape derived from the weekly average.
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(today.getDate() - i);
            labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
            const baseValue = skuData.lastWeek / 7;
            const variance = baseValue * 0.3;
            data.push(Math.round(baseValue + (Math.random() - 0.5) * variance));
        }
    }

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Sales Units',
                data: data,
                borderColor: '#3B82F6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                tension: 0.3,
                fill: true,
                spanGaps: false,      // missing days stay as gaps (no fabricated bridge / no 0)
                pointRadius: 3,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 10
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });
}

// The random-data Achievement Rate chart was removed (2026-07-22). Monthly Achievement Rate is now an
// honest read-only TABLE (see _irRenderMonthlyAchievement): no mock/random/fabricated percentages, and
// no 0% (which would imply a computed-zero). Kept as a no-op so any legacy caller can't throw.
function initAchievementChart(/* sku, skuData */) { /* intentionally empty — see _irRenderMonthlyAchievement */ }

// The N most-recently COMPLETED calendar months ending with the month BEFORE referenceDate's month
// (the current partial month is excluded). Handles year rollover. Returns oldest→newest.
// e.g. getPreviousCompletedMonths(2026-07-22, 3) → [Apr 2026, May 2026, Jun 2026].
function getPreviousCompletedMonths(referenceDate, n) {
    var ref = referenceDate ? new Date(referenceDate) : new Date();
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var out = [];
    for (var i = n; i >= 1; i--) {
        // First day of (this month − i) safely handles year boundaries.
        var d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
        out.push({ year: d.getFullYear(), monthIdx: d.getMonth(), label: MON[d.getMonth()] + ' ' + d.getFullYear() });
    }
    return out;
}

// PLACEHOLDER interface — the canonical Monthly Achievement metric is NOT defined/implemented yet.
// Returns an explicit unavailable state; NEVER computes a rate from FC / sales / any approximation.
// When the formal metric is defined, this is the single wiring point.
function getMonthlyAchievementMetrics(/* { marketplace_sku_id, company, country, marketplace, year, month } */) {
    return { status: 'unavailable', achievementRate: null, actual: null, sessions: null, usp: null };
}

// Real historical FC Qty for a scoped SKU + a specific completed year/month, from fc_regular_forecast
// (company + country + marketplace, company-safe). Returns a number or null (→ "—"; never fabricated 0).
var _IR_MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function _irHistoricalFcQty(skuData, year, monthIdx) {
    if (!skuData || !skuData.sku) return null;
    var DB = (window.KM && window.KM.DB) ? window.KM.DB : null;
    if (!DB || !DB.getFcRegularForecast) return null;
    function up(v){ return String(v == null ? '' : v).trim().toUpperCase(); }
    function lo(v){ return String(v == null ? '' : v).trim().toLowerCase(); }
    var rows = DB.getFcRegularForecast() || [];
    var row = rows.filter(function (r) {
        return up(r.sku) === up(skuData.sku) && String(r.year) === String(year) &&
            (!skuData.company || !r.company || up(r.company) === up(skuData.company)) &&
            (!skuData.country || !r.country || up(r.country) === up(skuData.country)) &&
            (!skuData.marketplace || !r.marketplace || lo(r.marketplace) === lo(skuData.marketplace));
    })[0];
    if (!row) return null;
    var raw = row[_IR_MONTH_KEYS[monthIdx]];
    if (raw === '' || raw == null) return null;
    var num = Number(raw);
    return isNaN(num) ? null : Math.round(num);
}

// Monthly Achievement Rate — honest read-only table for the past 3 COMPLETED months. Achievement Rate /
// Actual / Sessions / USP have no defined source yet → "—" (never 0%, never mock). FC Qty shows real
// historical fc_regular_forecast when present, else "—".
function _irRenderMonthlyAchievement(skuData) {
    var DASH = '—';
    var months = getPreviousCompletedMonths(new Date(), 3);
    var body = months.map(function (m) {
        var metrics = getMonthlyAchievementMetrics({
            marketplace_sku_id: skuData ? skuData.marketplaceSkuId : '', company: skuData ? skuData.company : '',
            country: skuData ? skuData.country : '', marketplace: skuData ? skuData.marketplace : '',
            year: m.year, month: m.monthIdx + 1
        });
        var ach = (metrics && metrics.achievementRate != null) ? (metrics.achievementRate + '%') : DASH;
        var fcQty = _irHistoricalFcQty(skuData, m.year, m.monthIdx);
        var fcDisp = (fcQty == null) ? DASH : fcQty.toLocaleString();
        var actual = (metrics && metrics.actual != null) ? Number(metrics.actual).toLocaleString() : DASH;
        var sessions = (metrics && metrics.sessions != null) ? Number(metrics.sessions).toLocaleString() : DASH;
        var usp = (metrics && metrics.usp != null) ? metrics.usp : DASH;
        return '<tr><td>' + m.label + '</td><td>' + ach + '</td><td class="replen-achv__num">' + fcDisp +
            '</td><td class="replen-achv__num">' + actual + '</td><td class="replen-achv__num">' + sessions +
            '</td><td class="replen-achv__num">' + usp + '</td></tr>';
    }).join('');
    return '<table class="replen-achv-table"><thead><tr>' +
        '<th>Month</th><th>Achievement</th><th class="replen-achv__num">FC Qty</th>' +
        '<th class="replen-achv__num">Actual</th><th class="replen-achv__num">Sessions</th><th class="replen-achv__num">USP</th>' +
        '</tr></thead><tbody>' + body + '</tbody></table>';
}

window.initSalesTrendChart = initSalesTrendChart;
window.initAchievementChart = initAchievementChart;
window.getPreviousCompletedMonths = getPreviousCompletedMonths;
window.getMonthlyAchievementMetrics = getMonthlyAchievementMetrics;


// Add Marketplace Modal Functions
function openAddMarketplaceModal() {
    const modal = document.getElementById('add-marketplace-modal');
    const overlay = document.getElementById('replen-modal-overlay');
    if (modal && overlay) {
        modal.classList.add('is-open');
        overlay.classList.add('is-open');
    }
}

function closeAddMarketplaceModal() {
    const modal = document.getElementById('add-marketplace-modal');
    const overlay = document.getElementById('replen-modal-overlay');
    if (modal && overlay) {
        modal.classList.remove('is-open');
        overlay.classList.remove('is-open');
    }
    // Clear inputs
    document.getElementById('add-mp-country').value = 'US';
    document.getElementById('add-mp-company').value = 'KM';
    document.getElementById('add-mp-marketplace').value = '';
    var curEl = document.getElementById('add-mp-currency');
    if (curEl) curEl.value = 'USD';
    var dnEl = document.getElementById('add-mp-display-name');
    if (dnEl) dnEl.value = '';
    var ffEl = document.getElementById('add-mp-fulfillment');
    if (ffEl) ffEl.value = 'platform_fulfilled';
}

function saveMarketplace() {
    const country = document.getElementById('add-mp-country').value;
    const company = document.getElementById('add-mp-company').value;
    const marketplace = document.getElementById('add-mp-marketplace').value.trim();
    const curEl = document.getElementById('add-mp-currency');
    const currency = curEl ? curEl.value : 'USD';
    const dnEl = document.getElementById('add-mp-display-name');
    const displayName = dnEl ? dnEl.value.trim() : '';
    const ffEl = document.getElementById('add-mp-fulfillment');
    const fulfillmentModel = ffEl ? ffEl.value : '';

    if (!marketplace) { alert('Please enter marketplace name'); return; }
    if (!company || !country) { alert('Company and Country are required'); return; }
    if (!currency) { alert('Currency is required'); return; }
    if (!fulfillmentModel) { alert('Fulfillment Model is required'); return; }

    if (!(window.KM && window.KM.DB && window.KM.DB.upsertMarketplace)) {
        alert('Marketplace API is not available.');
        return;
    }

    window.KM.DB.upsertMarketplace({
        company: company,
        country: country,
        marketplace: marketplace,
        marketplace_display_name: displayName || marketplace,
        // MVP: alias defaults to the marketplace value. (Backend also defaults this when blank.)
        marketplace_alias: marketplace,
        fulfillment_model: fulfillmentModel,
        currency: currency,
        status: 'active'
    }).then(function(result) {
        if (result && result.success === false) {
            alert('Could not save marketplace. ' + (result.error || 'Please check the API connection and try again.'));
            return;
        }
        var st = (result && result.status) ? result.status : 'saved';
        alert('Marketplace ' + st + ': ' + company + ' / ' + country + ' / ' + marketplace);
        closeAddMarketplaceModal();
        // Refresh registry-backed dropdowns/filters.
        if (typeof populateReplenFiltersFromRegistry === 'function') populateReplenFiltersFromRegistry();
    }).catch(function(err) {
        alert('Could not save marketplace. ' + (err && err.message ? err.message : err));
    });
}

window.openAddMarketplaceModal = openAddMarketplaceModal;
window.closeAddMarketplaceModal = closeAddMarketplaceModal;
window.saveMarketplace = saveMarketplace;

// ============================================================================
// F1-7N-D-2j / F1-7N-D-2k-R1 — Site Inventory → More Options → Warehouse Allocation config modal.
// Edits ONLY the SELF_FULFILLED demand-allocation for the selected (company,country,marketplace) — the sole
// planning-membership authority (D-2i-R1). Platform/FBA lanes are unaffected. The PICKER candidate set = frozen 3PL
// inclusion (warehouse_type='3PL' + active + company + country) — convenience only — UNIONed with warehouses already
// referenced by active rules (so current membership is never hidden). FBA/RETURN/FACTORY execution warehouses are
// excluded from the picker. Phase-2 may add a durable eligibility authority to admit future non-3PL self-operated
// inventory warehouses.
// F1-7N-D-2k-R1 STORAGE: the config persists in the KM_WAREHOUSE_ALLOCATION_CONFIG Script-Property blob (backend +
// scheduler readable, no user-managed Sheet tab). The modal hydrates via getWarehouseAllocationConfig(scope) — a
// scope-targeted READ, not the whole-DB cache — and saves via saveReplenishmentDemandAllocationRules. PURE helpers
// below are Node-verified.
// ============================================================================
function _replenDarEqv(a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); }
function _replenDarRuleActive(r) { var st = String(r && r.status == null ? '' : r.status).trim().toLowerCase(); return st === 'active' || (r && r.status === true) || st === ''; }

// PURE: candidate rows for the modal. warehouses = normalized getWarehouses rows; rules = normalized
// getReplenishmentDemandAllocationRules rows; scope = {company,country,marketplace}. Returns ordered
// [{warehouseId, warehouseName, warehouseType, checked, forecastPct, salesPct, fromRule}].
function _replenDarCandidates(warehouses, rules, scope) {
    scope = scope || {};
    var activeRuleByWh = {};
    (rules || []).forEach(function (r) {
        if (!_replenDarEqv(r.company, scope.company) || !_replenDarEqv(r.country, scope.country) || !_replenDarEqv(r.marketplace, scope.marketplace)) return;
        if (!_replenDarRuleActive(r)) return;
        var wh = String(r.destinationWarehouseId || '').trim();
        if (wh) activeRuleByWh[wh] = r;
    });
    var whById = {}, out = [], seen = {};
    (warehouses || []).forEach(function (w) { if (w && w.warehouseId) whById[String(w.warehouseId).trim()] = w; });
    function push(w) {
        var id = String((w && w.warehouseId) || '').trim(); if (!id || seen[id]) return; seen[id] = 1;
        var ar = activeRuleByWh[id];
        out.push({
            warehouseId: id,
            warehouseName: (w && (w.warehouseName || w.warehouseCode)) || id,
            warehouseType: (w && w.warehouseType) || '',
            checked: !!ar,
            forecastPct: (ar && ar.forecastAllocationRatio != null) ? Math.round(ar.forecastAllocationRatio * 10000) / 100 : '',
            salesPct: (ar && ar.salesAllocationRatio != null) ? Math.round(ar.salesAllocationRatio * 10000) / 100 : '',
            fromRule: !!ar
        });
    }
    // Phase-1 picker filter: frozen 3PL inclusion (mirrors eligible3plWarehouses / §23.6). Excludes FBA/RETURN/FACTORY.
    (warehouses || []).forEach(function (w) {
        if (!w || !w.warehouseId) return;
        if (scope.company && !_replenDarEqv(w.company, scope.company)) return;
        if (scope.country && !_replenDarEqv(w.country, scope.country)) return;
        if (String(w.warehouseType || '').trim().toUpperCase() !== '3PL') return;
        if (w.isActive !== true) return;
        push(w);
    });
    // Always show currently-rule-linked warehouses even if not 3PL/active (membership authority = the rules).
    Object.keys(activeRuleByWh).forEach(function (id) { if (!seen[id]) push(whById[id] || { warehouseId: id }); });
    out.sort(function (a, b) { return a.warehouseId < b.warehouseId ? -1 : a.warehouseId > b.warehouseId ? 1 : 0; });
    return out;
}

// PURE: validate the UI rows. Each of forecast & sales (over CHECKED rows) must sum to exactly 100%; ≥1 selected.
function _replenDarValidate(rows) {
    var selected = (rows || []).filter(function (r) { return r.checked; });
    if (!selected.length) return { ok: false, error: 'Select at least one warehouse.' };
    var fBp = 0, sBp = 0, bad = null;
    selected.forEach(function (r) {
        var f = Number(r.forecastPct), s = Number(r.salesPct);
        if (!isFinite(f) || f < 0 || f > 100) bad = bad || ('Enter a valid Forecast % for ' + r.warehouseId);
        if (!isFinite(s) || s < 0 || s > 100) bad = bad || ('Enter a valid Sales % for ' + r.warehouseId);
        fBp += Math.round(f * 100); sBp += Math.round(s * 100);
    });
    if (bad) return { ok: false, error: bad };
    if (fBp !== 10000) return { ok: false, error: 'Forecast Total must be 100% (currently ' + (fBp / 100) + '%).' };
    if (sBp !== 10000) return { ok: false, error: 'Sales Total must be 100% (currently ' + (sBp / 100) + '%).' };
    return { ok: true };
}

// PURE: map a warehouseAllocation.get response (snake allocations) → the camelCase rule rows _replenDarCandidates
// consumes. Keeps the frozen candidate helper storage-agnostic (F1-7N-D-2k-R1: source is the Script-Property config,
// not the DB cache). data = { company, country, marketplace, allocations:[{destination_warehouse_id, forecast_ratio,
// sales_ratio, status }] }.
function _replenDarConfigToRuleRows(data) {
    data = data || {};
    return (data.allocations || []).map(function (a) {
        return {
            company: data.company, country: data.country, marketplace: data.marketplace,
            destinationWarehouseId: a.destination_warehouse_id,
            forecastAllocationRatio: (a.forecast_ratio == null ? null : Number(a.forecast_ratio)),
            salesAllocationRatio: (a.sales_ratio == null ? null : Number(a.sales_ratio)),
            status: a.status || 'active'
        };
    });
}

// PURE: build the save payload from the UI rows.
function _replenDarBuildPayload(scope, rows) {
    return {
        company: (scope || {}).company, country: (scope || {}).country, marketplace: (scope || {}).marketplace,
        allocations: (rows || []).filter(function (r) { return r.checked; }).map(function (r) {
            return { destination_warehouse_id: r.warehouseId, forecast_ratio: Math.round(Number(r.forecastPct) * 100) / 10000, sales_ratio: Math.round(Number(r.salesPct) * 100) / 10000 };
        })
    };
}

// F1-7N-D-2k-UX1 — PURE: the canonical fulfillment_model for the selected marketplace, from the ALREADY-loaded
// marketplace read-model (getMarketplaces) — NO extra API call, NO broad DB read. '' when the marketplace is absent
// (→ fail-closed by the classifier below). Never inferred from a marketplace NAME.
function _replenDarFulfillmentOf(marketplaces, marketplaceId) {
    var want = String(marketplaceId == null ? '' : marketplaceId).trim();
    if (!want) return '';
    var rec = (marketplaces || []).filter(function (m) { return String((m && m.marketplaceId) == null ? '' : m.marketplaceId).trim() === want; })[0];
    return rec ? String(rec.fulfillmentModel == null ? '' : rec.fulfillmentModel).trim().toLowerCase() : '';
}

// F1-7N-D-2k-UX1 — PURE: Warehouse Allocation applicability by CANONICAL fulfillment_model (never marketplace name).
// self_fulfilled / hybrid → editor applies (hybrid = self lane only). platform_fulfilled → not applicable (platform
// plans to the logical MARKETPLACE; physical FCs are chosen later at shipment execution). blank/unknown → FAIL CLOSED.
function _replenDarApplicability(model) {
    var m = String(model == null ? '' : model).trim().toLowerCase();
    if (m === 'self_fulfilled' || m === 'hybrid') return { applicable: true, kind: m, message: '' };
    if (m === 'platform_fulfilled') return { applicable: false, kind: 'platform_fulfilled',
        message: 'Warehouse Allocation is not required for this marketplace.\nPlatform-fulfilled inventory is planned to the marketplace directly.\nPhysical fulfillment centers are selected later during shipment execution.' };
    return { applicable: false, kind: 'unknown',
        message: 'Fulfillment configuration unavailable for this marketplace.\nSet the marketplace fulfillment_model (self_fulfilled / platform_fulfilled / hybrid) before configuring Warehouse Allocation.' };
}

// ---- DOM wiring (thin) -----------------------------------------------------
var _replenDarSaving = false;              // save-in-flight guard: backdrop/Escape must NOT dismiss mid-write
var _replenDarBackdropHandler = null;      // overlay click listener (attached only while the modal is open)
var _replenDarKeyHandler = null;           // document Escape listener (attached only while the modal is open)
function _replenDarModalEls() { return { modal: document.getElementById('replen-dar-modal'), overlay: document.getElementById('replen-modal-overlay') }; }
function _replenDarReadWarehouses() { try { return (typeof _irWsGet === 'function') ? (_irWsGet('getWarehouses') || []) : []; } catch (_e) { return []; } }
function _replenDarReadMarketplaces() { try { return (typeof _irWsGet === 'function') ? (_irWsGet('getMarketplaces') || []) : []; } catch (_e) { return []; } }
// F1-7N-D-2k-R1: hydrate from the Script-Property config (scope-targeted READ), NOT the whole-DB cache.
async function _replenDarReadRules(scope) {
    try {
        if (window.KM && window.KM.DB && typeof window.KM.DB.getWarehouseAllocationConfig === 'function') {
            var data = await window.KM.DB.getWarehouseAllocationConfig(scope);
            if (data && data.success === false) return [];
            return _replenDarConfigToRuleRows(data);
        }
    } catch (_e) {}
    return [];
}

async function openReplenDemandAllocationModal() {
    var scope = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : { company: '', country: '', marketplace: '' };
    if (!scope.company || !scope.country || !scope.marketplace) { alert('Select a Country and Marketplace first, then open Warehouse Allocation.'); return; }
    // F1-7N-D-2k-UX1 — PLATFORM/UNKNOWN GUARD (canonical fulfillment_model only): platform-fulfilled scopes do NOT open
    // the editor and do NOT call warehouseAllocation.get; unknown fulfillment fails closed. Both show a bounded notice.
    var model = _replenDarFulfillmentOf(_replenDarReadMarketplaces(), scope.marketplaceId);
    var app = _replenDarApplicability(model);
    if (!app.applicable) { alert(app.message); return; }
    // Applicable (self_fulfilled / hybrid): acknowledge the click IMMEDIATELY — show the modal shell with a Loading
    // state, then hydrate rows once the scoped async config read returns (no broad DB read, no getOperationDb).
    var ctx = document.getElementById('replen-dar-context');
    if (ctx) ctx.textContent = 'Company: ' + scope.company + '   Country: ' + scope.country + '   Marketplace: ' + scope.marketplace;
    _replenDarShowLoading();
    var e = _replenDarModalEls();
    if (e.modal && e.overlay) { e.modal.classList.add('is-open'); e.overlay.classList.add('is-open'); }
    _replenDarBindDismiss();
    var ruleRows = await _replenDarReadRules(scope);
    // Ignore a late hydration if the user already closed the modal.
    if (e.modal && !e.modal.classList.contains('is-open')) return;
    var rows = _replenDarCandidates(_replenDarReadWarehouses(), ruleRows, scope);
    _replenDarRenderRows(rows);
}
// Immediate Loading affordance (rows container) — replaced by real rows on hydrate.
function _replenDarShowLoading() {
    var tb = document.getElementById('replen-dar-rows');
    var empty = document.getElementById('replen-dar-empty');
    if (empty) empty.style.display = 'none';
    if (tb) tb.innerHTML = '<tr><td colspan="4" style="color:#94A3B8;font-size:13px;padding:10px 0;">Loading…</td></tr>';
    var msg = document.getElementById('replen-dar-msg'); if (msg) msg.textContent = '';
    var ft = document.getElementById('replen-dar-forecast-total'), st = document.getElementById('replen-dar-sales-total');
    if (ft) { ft.textContent = '0%'; ft.style.color = '#DC2626'; }
    if (st) { st.textContent = '0%'; st.style.color = '#DC2626'; }
}
// Backdrop-click + Escape dismiss, attached ONLY while the modal is open (does not affect other modals). Inside-click
// is inherently protected: the overlay is a SIBLING of the modal, so a click on modal content is never the overlay
// target. A dismiss is suppressed while a save is in flight (E/H).
function _replenDarBindDismiss() {
    var e = _replenDarModalEls();
    _replenDarUnbindDismiss();
    if (e.overlay) { _replenDarBackdropHandler = function (ev) { if (_replenDarSaving) return; if (ev.target === e.overlay) closeReplenDemandAllocationModal(); }; e.overlay.addEventListener('click', _replenDarBackdropHandler); }
    _replenDarKeyHandler = function (ev) { if ((ev.key === 'Escape' || ev.keyCode === 27) && !_replenDarSaving) closeReplenDemandAllocationModal(); };
    document.addEventListener('keydown', _replenDarKeyHandler);
}
function _replenDarUnbindDismiss() {
    var e = _replenDarModalEls();
    if (_replenDarBackdropHandler && e.overlay) { e.overlay.removeEventListener('click', _replenDarBackdropHandler); }
    if (_replenDarKeyHandler) { document.removeEventListener('keydown', _replenDarKeyHandler); }
    _replenDarBackdropHandler = null; _replenDarKeyHandler = null;
}
function _replenDarRenderRows(rows) {
    var tb = document.getElementById('replen-dar-rows'); if (!tb) return;
    var empty = document.getElementById('replen-dar-empty');
    if (empty) empty.style.display = rows.length ? 'none' : 'block';
    tb.innerHTML = rows.map(function (r) {
        var pctStyle = 'width:70px;padding:2px 4px;';
        return '<tr data-wh="' + r.warehouseId + '">'
            + '<td><input type="checkbox" class="replen-dar-chk"' + (r.checked ? ' checked' : '') + ' onchange="_replenDarOnChange()"></td>'
            + '<td>' + (r.warehouseName || r.warehouseId) + '<div style="font-size:11px;color:#94A3B8;">' + r.warehouseId + (r.fromRule ? ' · configured' : '') + '</div></td>'
            + '<td><input type="number" min="0" max="100" step="0.01" class="replen-dar-fpct" value="' + (r.forecastPct === '' ? '' : r.forecastPct) + '" style="' + pctStyle + '" oninput="_replenDarOnChange()"></td>'
            + '<td><input type="number" min="0" max="100" step="0.01" class="replen-dar-spct" value="' + (r.salesPct === '' ? '' : r.salesPct) + '" style="' + pctStyle + '" oninput="_replenDarOnChange()"></td>'
            + '</tr>';
    }).join('');
    _replenDarOnChange();
}
// Read current DOM state into rows[]; single-checked convenience → auto 100/100 when its inputs are blank.
function _replenDarCollectRows() {
    var trs = Array.prototype.slice.call(document.querySelectorAll('#replen-dar-rows tr'));
    var rows = trs.map(function (tr) {
        var chk = tr.querySelector('.replen-dar-chk'), f = tr.querySelector('.replen-dar-fpct'), s = tr.querySelector('.replen-dar-spct');
        return { warehouseId: tr.getAttribute('data-wh'), checked: !!(chk && chk.checked), forecastPct: f ? f.value : '', salesPct: s ? s.value : '', _f: f, _s: s };
    });
    var checked = rows.filter(function (r) { return r.checked; });
    if (checked.length === 1) {
        var only = checked[0];
        if (only.forecastPct === '' || Number(only.forecastPct) === 0) { only.forecastPct = 100; if (only._f) only._f.value = 100; }
        if (only.salesPct === '' || Number(only.salesPct) === 0) { only.salesPct = 100; if (only._s) only._s.value = 100; }
    }
    return rows;
}
function _replenDarOnChange() {
    var rows = _replenDarCollectRows();
    var sel = rows.filter(function (r) { return r.checked; });
    var fBp = 0, sBp = 0;
    sel.forEach(function (r) { var f = Number(r.forecastPct), s = Number(r.salesPct); if (isFinite(f)) fBp += Math.round(f * 100); if (isFinite(s)) sBp += Math.round(s * 100); });
    var ft = document.getElementById('replen-dar-forecast-total'), st = document.getElementById('replen-dar-sales-total');
    if (ft) { ft.textContent = (fBp / 100) + '%'; ft.style.color = (fBp === 10000) ? '#16A34A' : '#DC2626'; }
    if (st) { st.textContent = (sBp / 100) + '%'; st.style.color = (sBp === 10000) ? '#16A34A' : '#DC2626'; }
}
function closeReplenDemandAllocationModal() {
    if (_replenDarSaving) return;   // never dismiss mid-write (buttons are disabled; backdrop/Escape already guarded)
    _replenDarUnbindDismiss();
    var e = _replenDarModalEls();
    if (e.modal && e.overlay) { e.modal.classList.remove('is-open'); e.overlay.classList.remove('is-open'); }
    var msg = document.getElementById('replen-dar-msg'); if (msg) msg.textContent = '';
}
// Toggle the save-in-flight lock: disable Cancel/Save + suppress backdrop/Escape dismiss so the user is never left
// uncertain whether the write completed.
function _replenDarSetSaving(on) {
    _replenDarSaving = !!on;
    var save = document.getElementById('replen-dar-save-btn'), cancel = document.getElementById('replen-dar-cancel-btn');
    if (save) { save.disabled = !!on; save.textContent = on ? 'Saving…' : 'Save'; }
    if (cancel) { cancel.disabled = !!on; }
}
function saveReplenDemandAllocation() {
    if (_replenDarSaving) return;   // ignore double-submit
    var scope = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope() : {};
    var rows = _replenDarCollectRows();
    var v = _replenDarValidate(rows);
    var msg = document.getElementById('replen-dar-msg');
    if (!v.ok) { if (msg) msg.textContent = v.error; else alert(v.error); return; }
    if (!(window.KM && window.KM.DB && window.KM.DB.saveReplenishmentDemandAllocationRules)) { alert('Warehouse Allocation API is not available.'); return; }
    var payload = _replenDarBuildPayload(scope, rows);
    _replenDarSetSaving(true);
    window.KM.DB.saveReplenishmentDemandAllocationRules(payload).then(function (result) {
        _replenDarSetSaving(false);
        if (result && result.success === false) { if (msg) msg.textContent = result.error || 'Save failed.'; return; }
        closeReplenDemandAllocationModal();
        alert('Allocation updated for ' + scope.company + ' / ' + scope.country + ' / ' + scope.marketplace + '.\nRecalculate this scope to apply the new demand split.');
    }).catch(function (err) { _replenDarSetSaving(false); if (msg) msg.textContent = (err && err.message) ? err.message : String(err); });
}
window.openReplenDemandAllocationModal = openReplenDemandAllocationModal;
window.closeReplenDemandAllocationModal = closeReplenDemandAllocationModal;
window.saveReplenDemandAllocation = saveReplenDemandAllocation;
window._replenDarOnChange = _replenDarOnChange;
window._replenDarCandidates = _replenDarCandidates;
window._replenDarValidate = _replenDarValidate;
window._replenDarBuildPayload = _replenDarBuildPayload;
window._replenDarConfigToRuleRows = _replenDarConfigToRuleRows;
window._replenDarFulfillmentOf = _replenDarFulfillmentOf;
window._replenDarApplicability = _replenDarApplicability;
window._irInventoryColumnModel = _irInventoryColumnModel;
window._irApplyInventoryColumnModel = _irApplyInventoryColumnModel;

// ---- Sync Regional Details (idempotent, resumable backfill trigger) ----
// Scans marketplace_skus and CREATES the missing sku_regional_details row for each
// (match key sku+company+country+marketplace). Idempotent: existing rows are skipped, never rewritten.
// Batched server-side (default 300 creates/run) to avoid timeouts — if it stops early, click again to
// continue. Repeatable without creating duplicates. Compliance-document fields are never touched.
function syncRegionalDetails() {
    if (!window.KM || !window.KM.DB || typeof window.KM.DB.syncMarketplaceSkusToSkuRegionalDetails !== 'function') {
        alert('Sync is unavailable (KM.DB API not loaded).');
        return;
    }
    if (!confirm('Backfill SKU Regional Details from marketplace_skus?\n\n' +
        '• Missing regional rows are CREATED.\n' +
        '• Rows that already exist are SKIPPED (never rewritten).\n' +
        '• Runs in batches (default 300 per click) to avoid timeouts.\n' +
        '• Safe to run repeatedly — no duplicates. If it stops early, click again to continue.\n\n' +
        'Continue?')) {
        return;
    }
    var btn = document.querySelector('button[onclick="syncRegionalDetails()"]');
    var prevLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

    window.KM.DB.syncMarketplaceSkusToSkuRegionalDetails().then(function(res) {
        var r = res || {};
        var finished = (r.finished !== false) && !(r.remaining_count > 0);
        var lines = [
            finished ? 'SKU Regional Details sync FINISHED.' : 'SKU Regional Details batch done — more rows remain.',
            '',
            'Created:                ' + (r.created_count || 0),
            'Skipped (already exists): ' + (r.skipped_exists_count || 0),
            'Skipped (invalid):       ' + (r.skipped_invalid_count || 0),
            'Remaining:               ' + (r.remaining_count || 0),
            'Finished:                ' + (finished ? 'true' : 'false')
        ];
        if (!finished) {
            lines.push('', '➡ Click "Sync Regional Details" again to continue (already-created rows are skipped).');
        }
        if (r.warnings && r.warnings.length) {
            lines.push('', '— Warnings —');
            lines.push.apply(lines, r.warnings.slice(0, 20));
            if (r.warnings.length > 20) lines.push('…and ' + (r.warnings.length - 20) + ' more');
        }
        if (r.errors && r.errors.length) {
            lines.push('', '— Errors —');
            lines.push.apply(lines, r.errors.slice(0, 20));
            if (r.errors.length > 20) lines.push('…and ' + (r.errors.length - 20) + ' more');
        }
        alert(lines.join('\n'));
    }).catch(function(err) {
        alert('Sync failed. ' + (err && err.message ? err.message : err));
    }).then(function() {
        if (btn) { btn.disabled = false; btn.textContent = prevLabel; }
    });
}
window.syncRegionalDetails = syncRegionalDetails;

// Add Country Functions
function showAddCountryInput() {
    const container = document.getElementById('add-country-input-container');
    if (container) {
        container.style.display = 'block';
    }
}

function cancelAddCountry() {
    const container = document.getElementById('add-country-input-container');
    const input = document.getElementById('new-country-code');
    if (container) container.style.display = 'none';
    if (input) input.value = '';
}

function addNewCountry() {
    const input = document.getElementById('new-country-code');
    const select = document.getElementById('add-mp-country');
    
    if (!input || !select) return;
    
    const countryCode = input.value.trim().toUpperCase();
    
    if (!countryCode) {
        alert('Please enter a country code');
        return;
    }
    
    // Check if country already exists
    const existingOptions = Array.from(select.options);
    if (existingOptions.some(opt => opt.value === countryCode)) {
        alert('Country code already exists');
        return;
    }
    
    // Add new option
    const newOption = document.createElement('option');
    newOption.value = countryCode;
    newOption.textContent = countryCode;
    select.appendChild(newOption);
    
    // Select the new option
    select.value = countryCode;
    
    // Clear and hide input
    input.value = '';
    const container = document.getElementById('add-country-input-container');
    if (container) container.style.display = 'none';
}

window.showAddCountryInput = showAddCountryInput;
window.cancelAddCountry = cancelAddCountry;
window.addNewCountry = addNewCountry;



// ----------------------------------------------------------------------------------------------------------
// F1-7I · scoped Inventory Replenishment workspace read cutover (mirrors the F1-7B/7F/7G/7H pattern)
// The PRIMARY render (the main replenishment table assembled by _getCloudReplenishmentData) sources its 19 tables from
// ONE scoped `inventoryReplenishment` workspace — NO broad Operation DB for the primary render. Kill switch:
// KM.api.setWorkspaceEnabled('inventoryReplenishment', false) → instant Legacy broad-cache. Canonical default ON.
// Inventory Gap (inventoryReplenishmentGap.get), Recommendation (recommendation.workspace.get) and the allocation-draft
// SSOT (getShippingAllocationDraftWorkspace) are ALREADY scoped and stay on their own owners (not duplicated here). The
// incoming reconstruction stays presentation-side over the scoped raw rows (deferred INCOMING_INVENTORY_AUTHORITY_
// REDESIGN_REQUIRED). FLOW-A preserved: this path creates NO Request Order / Purchase Order.
// ----------------------------------------------------------------------------------------------------------
function _irEffectiveWorkspace() {
    return !!(window.KM && window.KM.api && typeof window.KM.api.workspaceApiActive === 'function' &&
        window.KM.api.workspaceApiActive('inventoryReplenishment'));
}
var _irReadModel = null;   // workspace-sourced { getX: [...] } keyed by getter name, or null = Legacy
var _irReadSeq = 0;

// Read-model-first table access: Workspace mode → scoped DTO array; Legacy → the broad-cache getter unchanged.
// F1-7N-FB-3 §C — the SLIM SCOPE REGISTRY sits between them for the scope slice only: before a Search there is
// no inventory read model, but the selectors (and _replenSelectedScope, which resolves company/country/
// marketplace from a marketplace_id) still need `getMarketplaces`. The registry supplies exactly that slice and
// nothing else, so scope resolution works pre-Search without any inventory read.
function _irWsGet(name) {
    if (_irReadModel) return _irReadModel[name] || [];
    if (name === 'getMarketplaces' && typeof _irRegistry !== 'undefined' && _irRegistry && _irRegistry.model) return _irRegistry.model.getMarketplaces || [];
    return (window.KM && window.KM.DB && window.KM.DB[name]) ? (window.KM.DB[name]() || []) : [];
}
// ============================================================================
// F1-7N-FB-3 §C — SLIM SCOPE REGISTRY: selector loading is now SEPARATE from inventory loading.
// ----------------------------------------------------------------------------
// THE B1 DEFECT this closes. FB-2A deferred the selector population to first selector interaction, but it
// still populated them by calling _irWorkspaceRefresh_() — the FULL 20-table inventoryReplenishment read. That
// function is also the owner of the inventory table's load region (_irRegion_().beginLoad()), whose renderer
// writes "Loading Inventory Replenishment…" into #replenScrollBody. So touching a dropdown put the INVENTORY
// TABLE into LOADING while Country and Marketplace were still unselected — a direct PRE_SEARCH violation — and
// it cost a whole-workspace read to draw two dropdowns (the B2 slowness).
//
// The two concerns are now genuinely independent:
//   • the SELECTORS are fed by inventoryScope.registry.get — ONE table, a six-column bounded projection, no
//     inventory row of any kind. It has its own status, its own error surface and its own Retry, rendered NEXT
//     TO THE SELECTORS, and it NEVER touches the table's load region.
//   • the TABLE is fed by inventoryReplenishment.workspace.get, and ONLY by a confirmed Search.
// A registry failure therefore cannot blank or "load" the table, and an inventory failure cannot disable the
// selectors.
var _irRegistry = { status: 'IDLE', model: null, error: null, seq: 0 };   // IDLE|LOADING|READY|EMPTY|ERROR
var _irRegistryPending = null;                                            // the single in-flight promise
// The registry DTO shaped exactly like the read-model slice the page already consumes, so every existing
// consumer (refreshReplenCountryOptions / refreshReplenMarketplaceOptions / _replenSelectedScope) works
// unchanged against either source. No second adapter, no second field vocabulary.
function _irAdaptScopeRegistry_(data) {
    var rows = (data && data.marketplaces) || [];
    return {
        getMarketplaces: rows.map(function (m) {
            return {
                marketplaceId: String(m.marketplace_id == null ? '' : m.marketplace_id),
                company: String(m.company == null ? '' : m.company),
                country: String(m.country == null ? '' : m.country),
                marketplace: String(m.marketplace == null ? '' : m.marketplace),
                marketplaceDisplayName: String(m.marketplace_display_name == null ? '' : m.marketplace_display_name),
                status: 'active'                                  // the registry emits ELIGIBLE scopes only
            };
        }),
        countries: (data && data.countries) || [],
        marketplaceIdsByCountry: (data && data.marketplace_ids_by_country) || {},
        empty: !!(data && data.empty),
        emptyReason: (data && data.empty_reason) || ''
    };
}
// The selector-scoped host: created next to the filter row, never inside the table.
function _irRegistryHost_() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    var el = document.getElementById('replenScopeRegistryState');
    if (el) return el;
    var anchor = document.getElementById('replenLTSFilter') || document.getElementById('replenMarketplace') || document.getElementById('replenCountry');
    var row = anchor && anchor.closest ? anchor.closest('.replen-filters') : null;
    var host = row || (anchor && anchor.parentNode);
    if (!host) return null;
    el = document.createElement('div');
    el.id = 'replenScopeRegistryState';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.display = 'none';
    el.style.flexBasis = '100%';
    host.appendChild(el);
    return el;
}
function _irRenderRegistryState_() {
    var el = _irRegistryHost_(); if (!el) return;
    var s = _irRegistry.status;
    if (s === 'READY' || s === 'IDLE') { el.style.display = 'none'; el.innerHTML = ''; return; }
    var html = '';
    if (s === 'LOADING') {
        html = '<span class="replen-scope-loading" style="color:#64748B;font-size:12px;">Loading Country / Marketplace options…</span>';
    } else if (s === 'EMPTY') {
        html = '<span class="replen-scope-empty" style="color:#92400E;font-size:12px;">No active marketplace scopes are configured, so there is nothing to search yet.</span>';
    } else {
        var e = _irRegistry.error || {};
        var codeTxt = String(e.code || 'SCOPE_REGISTRY_READ_FAILED');
        // F1-7N-FB-3A §C — a STALE DEPLOYMENT is not a read failure and must not read like one. When the
        // deployed Web App does not contain the action, the actionable fact is "publish a new deployment
        // version", and Retry is relabelled accordingly: retrying cannot publish anything, so offering a bare
        // "Retry" would invite a pointless loop. The button still issues exactly ONE registry request.
        var stale = (codeTxt === 'DEPLOYMENT_CONTRACT_MISMATCH');
        var lead = stale
            ? 'Country / Marketplace options unavailable — the deployed Apps Script is out of date.'
            : 'Could not load the Country / Marketplace options.';
        var retryLabel = stale ? 'Re-check' : 'Retry';
        html = '<span class="replen-scope-error" role="alert" style="color:#B91C1C;font-size:12px;">' +
            '<strong>' + _irEsc_(lead) + '</strong> ' + _irEsc_(e.message || '') +
            ' <code>' + _irEsc_(codeTxt) + '</code>' +
            (stale ? '<span class="replen-scope-hint" style="display:block;color:#7F1D1D;margin-top:2px;">Nothing was read or written. Site Inventory stays in its pre-search state until the options load.</span>' : '') +
            ' <button type="button" class="replen-scope-retry" onclick="_irReloadScopeRegistry_()" ' +
            'style="margin-left:6px;padding:2px 8px;border:1px solid #EF4444;background:#fff;color:#B91C1C;border-radius:3px;cursor:pointer;font-size:11px;">' + retryLabel + '</button>' +
            '</span>';
    }
    el.innerHTML = html;
    el.style.display = '';
}
// Load the registry ONCE per mount. Single-flight, sequence-guarded, and terminal on EVERY path — success,
// empty, error and timeout all leave a state the user can act on. It NEVER touches the table's load region.
function _irEnsureRegistryLoaded_(opts) {
    if (typeof _replenDemoOn === 'function' && _replenDemoOn()) return Promise.resolve(null);   // Demo owns its static options
    var force = !!(opts && opts.force);
    if (!force && _irRegistry.status === 'READY' && _irRegistry.model) return Promise.resolve(_irRegistry.model);
    if (_irRegistryPending) return _irRegistryPending;                                          // single-flight
    // R6-R5 §4 — DECLARED HERE, where a request is actually about to be issued. Declaring it at the mount
    // instead would make "pending" mean "we intend to read", and a read that is never issued would hold the
    // primary read until the cap. The two branches above return without reading and correctly declare nothing.
    var _regSettle = (window.KM && window.KM.bootArbiter)
        ? window.KM.bootArbiter.declare('scopeRegistry') : function () {};

    // F1-7N-FB-4C §B2 — THE REQUEST, THE CACHE AND THE SINGLE-FLIGHT LATCH NOW LIVE IN ONE PLACE.
    // This page and the "AI Plan — Inventory" scope modal used to be two independent registry consumers with
    // two caches and two failure modes; the modal's had no visible ERROR state at all. Both now go through
    // KM.scopeRegistry, so the registry is fetched at most once per session, concurrent consumers share that
    // one request, and READY / EMPTY / ERROR mean the same thing on both surfaces.
    // This function keeps ownership of its OWN UI (the selector-row state line + the filter repopulate);
    // only the data layer moved.
    var reg = _irSharedRegistry_();
    if (!reg) {
        _irRegistry.status = 'ERROR';
        _irRegistry.error = { code: 'SCOPE_REGISTRY_MODULE_UNAVAILABLE', message: 'The shared scope registry module is not loaded on this page.' };
        _irRenderRegistryState_();
        return Promise.resolve(null);
    }
    var mySeq = ++_irRegistry.seq;
    _irRegistry.status = 'LOADING'; _irRegistry.error = null;
    _irRenderRegistryState_();
    _irRegistryPending = Promise.resolve(reg.ensureLoaded({ force: force, retry: true })).then(function (snap) {
        _irRegistryPending = null;
        _regSettle(!!(snap && snap.status !== reg.STATUS.ERROR));
        if (mySeq !== _irRegistry.seq) return _irRegistry.model;      // superseded by a newer load
        if (!snap || snap.status === reg.STATUS.ERROR) {
            _irRegistry.status = 'ERROR';
            _irRegistry.error = (snap && snap.error) || { code: 'SCOPE_REGISTRY_READ_FAILED', message: 'The scope registry could not be read.' };
            // F1-7N-FB-3A §C — a registry failure NEVER starts an inventory workspace read and never advances
            // the table's own state: _irSearch.applied stays null, so the table stays PRE_SEARCH. Only Search
            // reads the inventory workspace, and only a successful Search applies filters. Recovery is the
            // Retry button on this surface — no page navigation is required, and none would help.
            _irRenderRegistryState_();
            return null;
        }
        _irRegistry.model = snap.model;
        _irRegistry.status = (snap.status === reg.STATUS.EMPTY) ? 'EMPTY' : 'READY';
        _irRenderRegistryState_();
        if (typeof populateReplenFiltersFromRegistry === 'function') populateReplenFiltersFromRegistry();
        return _irRegistry.model;
    })['catch'](function (err) {
        _irRegistryPending = null;
        _regSettle(false);
        if (mySeq !== _irRegistry.seq) return null;
        _irRegistry.status = 'ERROR';
        _irRegistry.error = { code: (err && err.code) || 'SCOPE_REGISTRY_READ_FAILED', message: (err && err.message) || 'The scope registry could not be read.' };
        _irRenderRegistryState_();
        return null;   // TERMINAL — never a hanging promise, so no caller can be left latched
    });
    return _irRegistryPending;
}
function _irSharedRegistry_() {
    return (typeof window !== 'undefined' && window.KM && window.KM.scopeRegistry) ? window.KM.scopeRegistry : null;
}

// =============================================================================================================
// F1-7N-FB-4E-R3 §B — ONE COHERENT BOOTSTRAP, WITHOUT LOADING EVERY SITE'S INVENTORY.
//
// WHAT WAS ACTUALLY WRONG, because it was not the search gate. R3 §A measured this mount at ONE request (the slim
// scope registry) and the Search at ONE more (the scoped workspace) — no whole-DB read, and no per-site loading.
// The explicit Search gate is a FROZEN UX CONTRACT and stays exactly as it is: it is what stopped a dropdown
// touch from costing a 20-table read. What the user experienced as "two loading phases" is the SEQUENCE for a
// RETURNING user: wait for the registry, re-pick the scope you already had, then wait again for the data.
//
// So neither request is removed and neither is widened. What changes is that a returning user stops WAITING
// TWICE for something already known:
//
//   REMEMBERED SCOPE (the returning case): the registry validation and the scoped workspace read start
//     TOGETHER, under ONE loading state, and the table paints ONCE when both have resolved and the scope has
//     been VALIDATED against the registry. The two waits become one, and the registry half is usually already
//     answered from its versioned TTL snapshot, so in practice one request overlaps zero.
//
//   NO REMEMBERED SCOPE (first use): registry only, then wait for a choice. Byte-for-byte today's behaviour,
//     because there is nothing to overlap and guessing a scope would be worse than asking for one.
//
// §B.5 IS STRUCTURAL HERE, NOT BEST-EFFORT. `applied` is assigned in exactly one place (_irApplySearch_) and
// nothing renders scope-dependent data from anything else, so a scope that fails validation is never applied and
// therefore CANNOT be painted — not even for a frame. A remembered scope the registry rejects is discarded and
// the page falls back to the pre-search state, with the reason available rather than silent.
// =============================================================================================================
// F1-7N-FB-4E-R4B §A -- WHY THE PAGE SAID "Searching..." OVER AN ANSWER IT ALREADY HAD.
//
// R3 gave the mount a coalesced bootstrap: with a remembered scope it validates the registry and reads the
// scoped workspace TOGETHER under one loading state. That was right for a page that has nothing. It was wrong
// for a page that has EVERYTHING: leaving Site Inventory and coming back re-entered LOADING unconditionally, so
// the table painted "Searching..." over a model that was still in memory and a scope that was still applied.
// Pressing Search then "restored" the result instantly -- which is the tell: nothing had to be fetched at all.
// The bootstrap simply had no branch for "the answer is already here".
//
// R4A1 §E's in-flight reuse cannot help. It shares an OPEN request and evicts on settlement, by design: it is
// what stops two mounts issuing two reads, not what lets a finished read be reused. Reuse of a FINISHED result
// is a different mechanism, and this is it.
//
// WHAT MAKES REUSE SAFE HERE, and it is a property of this page rather than a general licence:
//   * the workspace read is scope-INDEPENDENT -- the server returns the primary-render table set and the CLIENT
//     scopes it at render time from `applied`. So a retained model is not "the previous scope's data"; the
//     scope lives in `applied`, which is assigned in exactly one validated place (§B.5).
//   * only a SUCCESSFUL read is retained, and only a successful read stamps a completion time, so a failure is
//     never restorable and never paints as current.
//   * the restore is BOUNDED by that stamp. An aged result is not painted; it is re-read like any other.
//   * an explicit Search never restores. It always performs a fresh read, because a person pressing Search is
//     asking for exactly that.
//   * revalidation runs QUIETLY: it may replace data, it may never replace a valid table with a loading one.
var _IR_RESULT_TTL_MS = 10 * 60 * 1000;   // ten minutes: long enough for navigation, short enough to be current
var _irReadModelAt = 0;                    // when the retained model COMPLETED (0 = never)
function _irNowMs_() { try { return Date.now(); } catch (e) { return 0; } }
// Canonical scope equality. Compared field by field on normalized strings, never by object identity and never
// by JSON key order, so two equivalent scopes built at different times compare equal and two different ones
// never do.
function _irSameScope_(a, b) {
    if (!a || !b) return false;
    return String(a.country || '') === String(b.country || '')
        && String(a.marketplaceId || '') === String(b.marketplaceId || '');
}
// Is there a completed result that may be painted right now, for THIS scope?
function _irRestorableResult_(scope) {
    if (!scope || !_irReadModel || !_irReadModelAt) return { ok: false, reason: 'NO_COMPLETED_RESULT' };
    if (!_irSameScope_(_irSearch.applied, scope)) return { ok: false, reason: 'SCOPE_NOT_APPLIED' };
    var age = _irNowMs_() - _irReadModelAt;
    if (age < 0 || age > _IR_RESULT_TTL_MS) return { ok: false, reason: 'RESULT_EXPIRED', ageMs: age };
    return { ok: true, ageMs: age };
}
var _IR_SCOPE_MEMORY_KEY = 'km_site_inventory_last_scope_v1';
var _IR_SCOPE_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // a month: this is a convenience, not an authority
var _irBootstrap = { ran: false, mode: null, scopeValid: null, registryRequests: 0, workspaceRequests: 0, reason: null };
function _irScopeStore_() {
    try { return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null; } catch (e) { return null; }
}
function _irRememberScope_(scope) {
    var st = _irScopeStore_(); if (!st || !scope || !scope.country || !scope.marketplaceId) return false;
    try { st.setItem(_IR_SCOPE_MEMORY_KEY, JSON.stringify({ country: String(scope.country), marketplaceId: String(scope.marketplaceId), at: Date.now() })); return true; }
    catch (e) { return false; }                       // private mode / quota: a lost convenience, never an error
}
function _irForgetScope_() { var st = _irScopeStore_(); if (st) { try { st.removeItem(_IR_SCOPE_MEMORY_KEY); } catch (e) {} } }
function _irRestoreScope_() {
    var st = _irScopeStore_(); if (!st) return null;
    try {
        var o = JSON.parse(st.getItem(_IR_SCOPE_MEMORY_KEY) || 'null');
        if (!o || !o.country || !o.marketplaceId || typeof o.at !== 'number') return null;
        if ((Date.now() - o.at) > _IR_SCOPE_MEMORY_TTL_MS) { _irForgetScope_(); return null; }
        return { country: String(o.country), marketplaceId: String(o.marketplaceId) };
    } catch (e) { return null; }
}
// Is a remembered scope still a REAL option? Asked of the registry, which is the picker authority (§B.1) — never
// assumed, because a marketplace can be retired between visits and offering it would be worse than asking again.
function _irScopeIsValid_(model, scope) {
    if (!model || !scope) return false;
    var list = model.getMarketplaces || [];
    for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (String(m.marketplace_id || m.marketplaceId || '') === scope.marketplaceId
            && String(m.country || '') === scope.country) return true;
    }
    return false;
}
function _irSetSelectors_(scope) {
    if (typeof document === 'undefined' || !scope) return;
    try {
        var c = document.getElementById('replenCountry'); if (c) c.value = scope.country;
        var m = document.getElementById('replenMarketplace'); if (m) m.value = scope.marketplaceId;
    } catch (e) {}
}
// THE MOUNT ENTRY POINT. Replaces the bare _irEnsureRegistryLoaded_() call, and is the only thing that changed
// about when requests are issued.
function _irBootstrapScope_() {
    _irBootstrap = { ran: true, mode: null, scopeValid: null, registryRequests: 0, workspaceRequests: 0, reason: null };
    var remembered = _irRestoreScope_();
    if (!remembered) {
        _irBootstrap.mode = 'REGISTRY_ONLY';
        _irBootstrap.reason = 'no remembered scope — the registry alone, then wait for a choice';
        _irBootstrap.registryRequests = 1;
        return Promise.resolve(_irEnsureRegistryLoaded_());
    }
    if (typeof _replenDemoOn === 'function' && _replenDemoOn()) {
        _irBootstrap.mode = 'REGISTRY_ONLY';
        _irBootstrap.reason = 'Demo owns its own static options';
        return Promise.resolve(_irEnsureRegistryLoaded_());
    }
    // F1-7N-FB-4E-R4B §A -- THE RESTORE BRANCH, and it comes BEFORE anything that can paint a loading state.
    // A validated completed result for this exact scope is painted immediately: zero blocking requests, no
    // "Searching...", the table exactly as it was left. Revalidation still runs, quietly, so the server keeps the
    // final word without the screen going empty to ask for it.
    var restorable = _irRestorableResult_(remembered);
    if (restorable.ok) {
        _irBootstrap.mode = 'RESTORED';
        _irBootstrap.reason = 'a completed result for this scope was still valid (' + Math.round(restorable.ageMs / 1000) + 's old) -- painted immediately, revalidating quietly';
        _irBootstrap.registryRequests = 0;
        _irBootstrap.workspaceRequests = 0;
        _irSetSelectors_(remembered);
        _irSearch.status = 'READY';
        _irSearch.error = null;
        if (typeof renderReplenishment === 'function') renderReplenishment();
        // QUIET revalidation. It never touches `status`, so it cannot turn a painted table back into a loading
        // one, and a failure leaves the restored result exactly where it is -- the data on screen was valid when
        // it was read and a failed revalidation does not make it invalid.
        _irBootstrap.revalidating = true;
        var qSeq = _irSearch.seq;
        Promise.resolve(_irWorkspaceRefresh_({ quiet: true, carrier: true,
            owner: 'RESTORED_MOUNT_REVALIDATION',
            reason: 'a retained model was restored; this re-reads behind it without a loading state' })).then(function () {
            if (qSeq !== _irSearch.seq) return;                  // a real Search superseded the restore
            if (!_irSameScope_(_irSearch.applied, remembered)) return;   // the scope moved on
            _irBootstrap.revalidating = false;
            _irBootstrap.revalidated = true;
            if (typeof renderReplenishment === 'function') renderReplenishment();
        }, function () { _irBootstrap.revalidating = false; _irBootstrap.revalidateFailed = true; });
        return Promise.resolve(remembered);
    }
    _irBootstrap.restoreReason = restorable.reason;

    _irBootstrap.mode = 'COALESCED';
    _irBootstrap.reason = 'a remembered scope: registry validation and the scoped workspace read run together';
    _irBootstrap.registryRequests = 1;
    _irBootstrap.workspaceRequests = 1;
    var mySeq = ++_irSearch.seq;
    _irSearch.status = 'LOADING';
    _irSearch.error = null;
    var rg = _irRegion_(); if (rg && window.KM && window.KM.loadState) rg.beginLoad(false);   // ONE loading state
    // R6-R5 §4 — PAINT THE WAITING STATE NOW. The bootstrap sets LOADING and then awaits; without this the
    // table's own bodies keep whatever they had until the first render after the reads resolve, so a user who
    // navigates immediately sees the pre-search sentence while a read is being prepared for them.
    if (typeof _irRenderSearchGate_ === 'function') { try { _irRenderSearchGate_(); } catch (_eG) {} }
    // STARTED TOGETHER. The workspace read is scope-INDEPENDENT (the server returns the primary-render table set
    // and the client scopes it), which is exactly why it can overlap the validation instead of following it.
    var regP = Promise.resolve(_irEnsureRegistryLoaded_())['catch'](function () { return null; });
    var wsP = Promise.resolve(_irWorkspaceRefresh_({ carrier: true,
        owner: 'COALESCED_BOOTSTRAP',
        reason: 'a remembered scope: registry validation and the scoped workspace read run together' }))
        .then(function (m) { return { ok: true, model: m }; },
        function (err) { return { ok: false, error: err }; });
    return Promise.all([regP, wsP]).then(function (r) {
        if (mySeq !== _irSearch.seq) return null;                    // a real Search superseded the bootstrap
        var model = _irRegistry.model;
        var valid = _irScopeIsValid_(model, remembered);
        _irBootstrap.scopeValid = valid;
        if (!valid) {
            // The scope is gone, or the registry could not be read. Either way: forget it, apply nothing, and
            // leave the page in its ordinary pre-search state. Nothing scope-dependent has been rendered.
            _irForgetScope_();
            _irBootstrap.reason = model
                ? 'the remembered scope is no longer offered by the registry — discarded, pre-search state'
                : 'the registry could not be read — the remembered scope cannot be validated, so it is not applied';
            _irSearch.status = 'PRE_SEARCH';
            if (typeof _irRenderSearchGate_ === 'function') _irRenderSearchGate_();
            return null;
        }
        var ws = r[1];
        if (!ws || !ws.ok) {
            // F1-7N-FC-1B-E3-R4 §D — SHOW THE SCOPE WE ALREADY KNOW.
            //
            // This branch used to leave both selectors reading "Select Country" / "Select Marketplace" under a red
            // read error, because _irSetSelectors_ ran only on the success path. That is the exact failure screen
            // this round was asked to explain, and it made the page look as though it had failed with no scope
            // chosen — which sent the diagnosis after a cause that does not exist. The remembered scope was
            // VALIDATED against the registry two lines above; the read is what failed. Showing it costs nothing,
            // applies nothing, and lets the operator press Search instead of re-choosing what the page knew.
            _irSetSelectors_(remembered);
            _irSearch.status = 'ERROR';
            _irSearch.error = { code: (ws && ws.error && ws.error.code) || 'INVENTORY_REPLENISHMENT_READ_FAILED',
                message: (ws && ws.error && ws.error.message) || 'Inventory Replenishment read failed' };
            _irBootstrap.reason = 'the scoped workspace read failed — reported, the remembered scope is SHOWN but NOT applied';
            _irBootstrap.selectorsShown = true;
            // FAIL CLOSED FIRST (_irRenderError_ drops the read model so nothing can fall back to a broad
            // cache), then paint through the SAME gate a failed Search uses — which is the one that offers a
            // Retry. The bootstrap's own painter has none, so a failed restore left the operator with a red
            // line and no button.
            if (typeof _irRenderError_ === 'function') _irRenderError_(ws && ws.error);
            if (typeof _irRenderSearchGate_ === 'function') _irRenderSearchGate_();
            return null;
        }
        _irSetSelectors_(remembered);
        // ONE paint, through the SAME single assignment point a manual Search uses. No second code path can
        // make data appear, which is what keeps §B.5 true by construction.
        _irApplySearch_(remembered, mySeq);
        return remembered;
    });
}
// Read-only: what the mount actually did, so "why two phases / why one" has an answer without guessing.
window._irBootstrapDiagnostic_ = function () {
    var reg = _irSharedRegistry_();
    var snap = reg ? reg.getState() : null;
    return {
        mode: _irBootstrap.mode, reason: _irBootstrap.reason, scope_valid: _irBootstrap.scopeValid,
        // F1-7N-FB-4E-R4B §A
        restore_reason: _irBootstrap.restoreReason || null,
        revalidating: _irBootstrap.revalidating === true,
        revalidated: _irBootstrap.revalidated === true,
        revalidate_failed: _irBootstrap.revalidateFailed === true,
        result_age_ms: _irReadModelAt ? (_irNowMs_() - _irReadModelAt) : null,
        result_ttl_ms: _IR_RESULT_TTL_MS,
        registry_requests: _irBootstrap.registryRequests, workspace_requests: _irBootstrap.workspaceRequests,
        registry_from_cache: snap ? (snap.from_cache === true) : null,
        registry_total_requests: snap ? snap.requests : null,
        remembered_scope: _irRestoreScope_(),
        note: 'COALESCED = a remembered scope, so registry validation and the scoped workspace read ran together '
            + 'under one loading state. REGISTRY_ONLY = first use: the registry alone, then wait for a choice. '
            + 'Neither mode loads every site inventory, and neither reads the whole database.'
    };
};
window._irBootstrapScope_ = _irBootstrapScope_;
window._irRememberScope_ = _irRememberScope_;
window._irRestoreScope_ = _irRestoreScope_;
window._irForgetScope_ = _irForgetScope_;
window._irScopeIsValid_ = _irScopeIsValid_;
function _irReloadScopeRegistry_() { return _irEnsureRegistryLoaded_({ force: true }); }
window._irEnsureRegistryLoaded_ = _irEnsureRegistryLoaded_;
window._irReloadScopeRegistry_ = _irReloadScopeRegistry_;
window._irRegistryState_ = function () { return _irRegistry; };


// ============================================================================
// F1-7N-FB-2A §B — EXPLICIT SEARCH GATE (frozen UX contract).
// ----------------------------------------------------------------------------
// Selecting Country or Marketplace NEVER loads data and NEVER repaints the table. Nothing appears until
// the user presses Search. TWO filter states exist and are never conflated:
//   • PENDING — whatever the selectors currently hold (owned by the DOM).
//   • APPLIED — the filters of the last SUCCESSFUL Search (owned by _irSearch.applied).
// The primary render reads APPLIED, so the contract holds no matter WHO calls renderReplenishment().
//
// The three source-proven auto-load paths this replaces:
//   1. the mount ran _irWorkspaceRefresh_() and then renderReplenishment() — one full workspace read AND a
//      rendered table before any Search, scoped to whatever the selectors happened to default to;
//   2. initReplenRecoContext() (mount) called _irRecoTrigger() → the materialized-gap read AND
//      recommendation.workspace.get, both pre-Search;
//   3. onReplenRecoScopeChanged() — bound to BOTH selector onchange handlers and documented at each binding
//      as "Pure page-input recompute — NO API call", which was FALSE — called _irRecoTrigger() again on every
//      selector change, and _irRecoRefreshVelocityCells_() then re-rendered the whole main table when the
//      response arrived. That is the "changing Country/Marketplace loads data" defect: two requests per
//      change plus an unrequested table repaint.
var _irSearch = {
    applied: null,     // { country, marketplaceId } of the last SUCCESSFUL Search — null = never searched
    status: 'PRE_SEARCH',   // PRE_SEARCH | LOADING | READY | EMPTY | ERROR
    seq: 0,            // monotonic Search sequence (stale-response guard)
    inFlight: false,   // single-flight: rapid repeat clicks never start a second concurrent read
    stale: false,      // a selector changed after a successful Search → Search again
    error: null
};
function _irSearchState_() { return _irSearch; }
function _irPendingFilters_() {
    var c = document.getElementById('replenCountry');
    var m = document.getElementById('replenMarketplace');
    return { country: (c && c.value) ? String(c.value) : '', marketplaceId: (m && m.value) ? String(m.value) : '' };
}
// The render scope. Country + Marketplace come from the APPLIED filters — atomically: a selector change is
// invisible to the table until the next successful Search. The LTS filter is DELIBERATELY read live: it is a
// CLIENT-SIDE filter over the already-loaded result set (_replenLtsFilter, applied in the row expand data) and
// issues no request of any kind, so its existing immediate behaviour is preserved unchanged.
function _irRenderScope_() {
    var a = _irSearch.applied;
    var lts = document.getElementById('replenLTSFilter');
    return { country: a ? a.country : '', marketplaceId: a ? a.marketplaceId : '',
        ltsFilter: (lts && lts.value) ? String(lts.value) : '' };
}
function _irSearchApplied_() { return !!_irSearch.applied; }
function _irFiltersDiffer_(a, b) {
    if (!a || !b) return true;
    return a.country !== b.country || a.marketplaceId !== b.marketplaceId;
}
// A selector changed. NO request, NO render — only a stale mark, so the user knows the displayed result no
// longer matches the selectors and Search is required again. The last CONFIRMED result stays on screen.
function _irMarkSearchStale_() {
    if (!_irSearch.applied) { _irRenderSearchGate_(); return; }
    _irSearch.stale = _irFiltersDiffer_(_irPendingFilters_(), _irSearch.applied);
    _irRenderStaleNotice_();
}
function _irEsc_(v) {
    return (typeof escapeReplenHtml === 'function') ? escapeReplenHtml(v)
        : String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; });
}
// The one banner host, created next to the table (never on <body>). Idempotent.
function _irStateHost_() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    var el = document.getElementById('replenSearchState');
    if (el) return el;
    var table = document.getElementById('replen-detail-table');
    if (!table || !table.parentNode) return null;
    el = document.createElement('div');
    el.id = 'replenSearchState';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.display = 'none';
    table.parentNode.insertBefore(el, table);
    return el;
}
function _irRenderStaleNotice_() {
    var host = _irStateHost_(); if (!host) return;
    if (!_irSearch.stale) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.innerHTML = '<div class="replen-search-stale" style="background:#FFFBEB;border-left:3px solid #F59E0B;color:#92400E;padding:8px 10px;margin:0 0 8px;font-size:12px;">' +
        '<strong>Filters changed — results are out of date.</strong> The table still shows the last confirmed search. Press <em>Search</em> to apply the new Country / Marketplace.' +
        '</div>';
    host.style.display = '';
}
// PRE_SEARCH / LOADING / ERROR render INTO the table bodies, so they are mutually exclusive with rows and with
// each other. "No data" is NEVER shown before a successful Search.
function _irRenderSearchGate_() {
    var body = document.getElementById('replenScrollBody');
    var fixed = document.getElementById('replenFixedBody');
    if (!body) return;
    var html = '';
    if (_irSearch.status === 'LOADING') {
        // R6-R5 §4 — "Preparing" and "Searching" are different truths and the user is owed the right one.
        // While the arbiter is waiting for the boot reads to settle, NO inventory request has been dispatched
        // yet; saying "Searching…" there claims work that is not happening. The state is still LOADING (§7
        // keeps four states, not five) — this only tells the truth about which half of it we are in.
        var _ba = (window.KM && window.KM.bootArbiter) ? window.KM.bootArbiter : null;
        var _preparing = false;
        try {
          _preparing = !!(_ba && typeof _irCriticalReadKey_ === 'function' &&
            _ba.phaseFor(_irCriticalReadKey_({ carrier: true })) === _ba.PHASE.PREPARING);
        } catch (_ePh) { _preparing = false; }
        html = _preparing
          ? '<div class="replen-empty replen-search-loading" data-load-phase="PREPARING" style="color:#64748B;padding:10px;">Preparing… waiting for the page to finish starting up, then this search runs.</div>'
          : '<div class="replen-empty replen-search-loading" data-load-phase="READING" style="color:#64748B;padding:10px;">Searching…</div>';
    } else if (_irSearch.status === 'ERROR') {
        var e = _irSearch.error || {};
        var code = _irEsc_(e.code || 'INVENTORY_REPLENISHMENT_READ_FAILED');
        var msg = _irEsc_(e.message || 'The inventory search could not be completed.');
        html = '<div class="replen-search-error" role="alert" style="color:#B91C1C;background:#FEF2F2;border-left:3px solid #EF4444;padding:10px;">' +
            '<div style="font-weight:600;">Search failed — no results were loaded</div>' +
            '<div style="margin-top:3px;">' + msg + ' <code>' + code + '</code></div>' +
            '<div style="margin-top:4px;font-size:12px;">This is a read failure, not an empty result — nothing about your data changed.</div>' +
            '<button type="button" class="replen-search-retry" onclick="searchReplenishment()" style="margin-top:8px;padding:5px 12px;border:1px solid #EF4444;background:#fff;color:#B91C1C;border-radius:4px;cursor:pointer;font-size:12px;">Retry search</button>' +
            '</div>';
    } else {
        html = '<div class="replen-empty replen-pre-search" style="color:#64748B;padding:10px;">Select Country and Marketplace, then press Search.</div>';
    }
    body.innerHTML = html;
    if (fixed) fixed.innerHTML = '';
    if (typeof renderReplenCategoryTabs === 'function') { try { renderReplenCategoryTabs([]); } catch (e2) {} }
    _irRenderStaleNotice_();
}
// F1-7N-FB-3 §C — the FB-2A workspace-backed selector loader that lived here has been REMOVED. It populated
// the selectors by calling _irWorkspaceRefresh_(), which owns the inventory table's load region, so opening a
// dropdown printed "Loading Inventory Replenishment…" into the table while nothing was selected (defect B1) and
// cost a 20-table read to draw two dropdowns (defect B2). Selector population now has exactly ONE authority:
// the slim scope registry declared above (inventoryScope.registry.get). Keeping both would have been worse than
// either — they shared the function name, and this one, being later in the file, would have won by hoisting.
window._irSearchState_ = _irSearchState_;
window._irRenderScope_ = _irRenderScope_;
window._irMarkSearchStale_ = _irMarkSearchStale_;
window._irEnsureRegistryLoaded_ = _irEnsureRegistryLoaded_;

// F1-7J-A2 · SECONDARY Execution-Plan carrier reference (carrier_lead_times + carrier_rate_cards). Loaded LAZILY (once
// per page load) via the EXISTING inventoryReplenishment workspace with include.carrierPlanning — NOT part of the primary
// render (secondary-panel-only). Canonical mode reads this scoped model (fail-closed: [] until loaded, NO broad fallback);
// Legacy mode reads the broad getter unchanged. Reference data only — the page keeps its existing ETA / method logic.
var _irCarrierModel = null;   // { getCarrierLeadTimes:[...], getCarrierRateCards:[...] } or null (not yet loaded / Legacy)
var _irCarrierSeq = 0;
// F1-7N-FA-3C-R6E-P0 — in-flight dedupe + explicit load status so the Method dropdown shows a real "Loading methods…"
// state (never a false "No available method" before the catalog resolves) and concurrent row-expands share ONE fetch.
var _irCarrierPending = null;   // the single in-flight catalog promise (dedupe)
var _irCarrierStatus = 'IDLE';  // IDLE | LOADING | LOADED | ERROR
// F1-7N-FB-4C §C — THE CATALOGUE NOW HAS ONE OWNER. These three functions used to hold the request, the cache,
// the in-flight latch and a three-value status between them, and they threw the ERROR CODE away — which is why
// a stale deployment, a failed read and a schema refusal all reached the user as "Unable to load methods".
// KM.methodRegistry owns all of that now, keyed by APPLIED SCOPE, so a catalogue can never answer for a station
// it does not belong to. These remain as the page's adapters.
function _irCarrierGet(name) {
    var reg = (window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (reg) {
        var sc = _irMethodScope_();
        if (name === 'getCarrierRateCards') return reg.getRateCards(sc) || [];
        if (name === 'getCarrierLeadTimes') return reg.getLeadTimes(sc) || [];
    }
    if (_irEffectiveWorkspace()) return [];                                                         // scoped only — no broad fallback
    return (window.KM && window.KM.DB && window.KM.DB[name]) ? (window.KM.DB[name]() || []) : [];   // Legacy
}
// Legacy three-value view kept for older callers. The picker itself now reads the registry's FIVE states.
function _irMethodsState_() {
    var reg = (window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg) return _irEffectiveWorkspace() ? 'ERROR' : 'LOADED';
    var sc = _irMethodScope_();
    if (reg.isLoaded(sc)) return 'LOADED';
    if (reg.getError(sc)) return 'ERROR';
    return 'LOADING';
}
// Preload the catalogue for the APPLIED scope. Deduped and cached by the registry, so one Search preloads once
// and every later row-expand — twenty SKUs or twenty routes inside one SKU — costs ZERO further requests.
// Deliberately returns a promise the caller may ignore: §C forbids blocking the first paint of inventory rows.
function _irLoadCarrierPlanning_() {
    var reg = (window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg) return Promise.resolve(null);
    return Promise.resolve(reg.ensureLoaded(_irMethodScope_()));
}
// F1-7N-FB-4G-A1-R1 - seed the registry for the APPLIED station from the workspace read the page already
// completed. Returns false when there is nothing legitimate to adopt, and the caller then falls back to the
// lazy load. NO request is issued on either path through this function.
function _irAdoptCarrierCatalogue_() {
    var reg = (typeof window !== 'undefined' && window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg || typeof reg.adopt !== 'function') return false;
    if (!_irReadModelHasCarrier || !_irReadModel) return false;
    return reg.adopt(_irMethodScope_(), _irReadModel);
}
window._irAdoptCarrierCatalogue_ = _irAdoptCarrierCatalogue_;

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §3 — THE PIPELINE, END TO END, AS A MEASUREMENT.
//
// §3 asks for a count at every boundary between the sheet and the dropdown, because the failure lived at one of
// them and no surface reported any of them. Each boundary is read from the SHIPPED owner of that boundary — the
// transport ledger, the registry cache, the warehouse authority, the registry's own resolution — so the trace can
// never drift from what the page actually did. It issues NO request and writes NOTHING.
// ================================================================================================================
function _irCarrierPipelineTrace_(routeCtx) {
    var reg = (typeof window !== 'undefined' && window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    var scope = _irMethodScope_();
    var out = {
        contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §3 — read-only boundary census. No request, no write.',
        scope: scope, scope_key: reg && reg.scopeKey ? reg.scopeKey(scope) : null,
        transport: _irCarrierTransport,
        registry_module_present: !!reg,
        registry_settled: !!(reg && reg.isLoaded && reg.isLoaded(scope)),
        registry_error: (reg && reg.getError) ? reg.getError(scope) : null,
        cached_lead_time_rows: (reg && reg.getLeadTimes) ? (reg.getLeadTimes(scope) || []).length : null,
        cached_rate_card_rows: (reg && reg.getRateCards) ? (reg.getRateCards(scope) || []).length : null,
        registry_request_count: (reg && reg.requestCount) ? reg.requestCount() : null,
        route: null
    };
    if (routeCtx && reg) {
        var lts = reg.getLeadTimes(scope) || [];
        var profiles = (reg.serviceProfilesForRoute) ? reg.serviceProfilesForRoute(lts, routeCtx) : [];
        // The rejection histogram §3 asks for: why each lead-time row did NOT describe this lane. A row is
        // counted under the FIRST axis that eliminated it, so the counts sum to the rows examined.
        var hist = { ORIGIN_COUNTRY_MISMATCH: 0, DESTINATION_COUNTRY_MISMATCH: 0, NO_SHIPPING_METHOD_ON_ROW: 0, MATCHED: 0 };
        function lo(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
        lts.forEach(function (lt) {
            var ro = lo(lt.originCountry), rd = lo(lt.destinationCountry);
            var qo = lo(routeCtx.originCountry), qd = lo(routeCtx.destinationCountry);
            if (ro && qo && ro !== qo) { hist.ORIGIN_COUNTRY_MISMATCH++; return; }
            if (rd && qd && rd !== qd) { hist.DESTINATION_COUNTRY_MISMATCH++; return; }
            if (!String(lt.shippingMethod || '').trim()) { hist.NO_SHIPPING_METHOD_ON_ROW++; return; }
            hist.MATCHED++;
        });
        var res = reg.resolve(scope, routeCtx);
        out.route = {
            requested: routeCtx,
            lead_time_rows_examined: lts.length,
            rejection_histogram: hist,
            service_profiles: profiles.map(function (p) {
                return { profile_key: p.profileKey, method: p.method, last_mile: p.lastMileDelivery,
                    min_days: p.minDays, avg_days: p.avgDays, max_days: p.maxDays,
                    carrier_ids: p.carrierIds, carrier_selection: p.carrierSelection };
            }),
            resolution_status: res.status,
            method_source: res.method_source || null,
            final_options: (res.methods || []).map(function (m) {
                return { value: m.value, last_mile_options: m.lastMileOptions || [], ambiguous: !!m.lastMileAmbiguous };
            }),
            transit_authority: res.transit_authority || null,
            pricing: res.pricing || null
        };
    }
    return out;
}
window._irCarrierPipelineTrace_ = _irCarrierPipelineTrace_;
// Explicit operator retry from the Method picker's ERROR state — exactly ONE request, then a repaint.
function _irRetryMethodRegistry_(sku) {
    var reg = (window.KM && window.KM.methodRegistry) ? window.KM.methodRegistry : null;
    if (!reg) return Promise.resolve(null);
    return Promise.resolve(reg.retry(_irMethodScope_())).then(function () {
        if (sku && typeof _execRebuildMethodOptions === 'function') _execRebuildMethodOptions(sku);
        else if (typeof _irRebuildAllMethodOptions_ === 'function') _irRebuildAllMethodOptions_();
    });
}
window._irRetryMethodRegistry_ = _irRetryMethodRegistry_;
// Repaint every expanded SKU's Method pickers (used after a retry / after a scope change).
function _irRebuildAllMethodOptions_() {
    if (typeof document === 'undefined') return;
    try {
        var lists = document.querySelectorAll('[id^="shipping-methods-"]');
        for (var i = 0; i < lists.length; i++) {
            var sku = String(lists[i].id || '').replace('shipping-methods-', '');
            if (!sku) continue;
            if (typeof _execRebuildMethodOptions === 'function') _execRebuildMethodOptions(sku);
            // R6-R2 §7 — THE ARRIVAL HAD TO MOVE WITH THE METHOD, AND IT DID NOT.
            //
            // This is the repaint that runs when the catalogue settles for the whole station. It refreshed the
            // Method select and left the Expected Arrival cell exactly as the first paint wrote it — so a row
            // rendered before hydration kept saying "Lead time unavailable" beside a Method that had just
            // acquired real options, until some unrelated event happened to re-render it. The per-SKU path
            // (initializeShippingAllocation's catalogue .then) has always refreshed both; this one did not, and
            // it is the path a station-wide settle takes.
            //
            // _irUpdateRouteEtas is an in-place cell rewrite that issues no request and honours a PERSISTED
            // snapshot over a computed one, so adding it here cannot move a saved commitment.
            if (typeof _irUpdateRouteEtas === 'function') _irUpdateRouteEtas(sku);
        }
    } catch (e) {}
    // F1-7N-FB-4G-A1-R1 - the catalogue's settle reaches the EXECUTION gate only. The Recommendation Summary
    // has never depended on the carrier catalogue and no longer waits for it.
    if (typeof _irRevealPumpExec_ === 'function') _irRevealPumpExec_();
}
window._irRebuildAllMethodOptions_ = _irRebuildAllMethodOptions_;

// Bounded loading/error region for the main table (reuses KM.loadState — no new loading infra).
// F1-7N-FB-4G-A1-R1 - true only when the workspace read that produced _irReadModel asked for the carrier
// include. It gates adoption; nothing else reads it.
var _irReadModelHasCarrier = false;
// R6-R2 §3 — the transport boundary, recorded rather than inferred. What the read asked for, what the server
// returned, what survived normalization, and whether any of it was adoptable. Measurement only.
var _irCarrierTransport = null;
// F1-7N-FC-1B-E3-R4 §B — what the SERVER said about the last primary read. Measurement only; nothing
// reads it to make a decision.
var _irLastReadMeta = null;
var _irRegionCtl = null;
function _irRegion_() {
    if (typeof document === 'undefined' || !(window.KM && window.KM.loadState)) return null;
    if (_irRegionCtl) return _irRegionCtl;
    _irRegionCtl = window.KM.loadState.createRegion({
        render: function (state) {
            var S = window.KM.loadState.STATES;
            if (state === S.INITIAL_LOADING) {
                var b = document.getElementById('replenScrollBody');
                if (b) b.innerHTML = '<div class="replen-empty" style="color:#64748B;padding:8px;">Loading Inventory Replenishment…</div>';
            }
        }
    });
    return _irRegionCtl;
}
// F1-7N-FB-4E §F — the safe error field set, from the ONE shared formatter (KM.transport.errorLine). The
// banner previously showed "<message> [<code>]", which named neither the action, nor the request id, nor
// whether retrying could possibly help. It degrades to the old two-field form if the transport module is
// absent, so a load failure costs detail rather than the banner itself.
function _irErrDetail_(err) {
    try {
        if (window.KM && window.KM.transport && typeof window.KM.transport.errorLine === 'function') {
            return window.KM.transport.errorLine(err);
        }
    } catch (e) {}
    return String((err && err.message) || 'failed') + ' [' + String((err && err.code) || 'READ_FAILED') + ']';
}
function _irRenderError_(err) {
    _irReadModel = null;   // fail closed — NEVER fall back to the broad cache for the primary render
    var rg = _irRegion_(); if (rg) rg.set(window.KM.loadState.STATES.ERROR);
    var code = (err && err.code) || 'INVENTORY_REPLENISHMENT_READ_FAILED';
    var message = (err && err.message) || 'Inventory Replenishment read failed';
    var html = '<div class="replen-empty" role="alert" style="color:#B91C1C;padding:8px;text-align:left;overflow-wrap:break-word;word-break:break-word;">Inventory Replenishment read error: '
        + _irEsc_(_irErrDetail_({ code: code, message: message, transport: (err && (err.transport || err.kmTransport)) || null })) + '</div>';
    var b = document.getElementById('replenScrollBody'); if (b) b.innerHTML = html;
    var f = document.getElementById('replenFixedBody'); if (f) f.innerHTML = '';
}

// Scoped read: Workspace (canonical) → getWorkspace('inventoryReplenishment') → adapt → _irReadModel. Fail-closed (throws;
// NO silent legacy broad fallback). Returns a Promise. Also the scoped POST-WRITE refresh path.
// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 §16.3 — TWO WORKSPACE REQUESTS, AND NOTHING COULD SAY WHO SENT THEM.
//
// The live evidence was exact and unhelpful in equal measure: inventory_workspace attempts = 2, the same
// action twice, coalesced_count = 0, retry_count = 0. So the transport did not retry, nothing was shared, and
// two physically separate reads of the identical payload were dispatched — by whom, the report could not say.
//
// It could not say because `_irWorkspaceRefresh_` has FOUR distinct owners and recorded none of them:
//
//   COALESCED_BOOTSTRAP          a mount with a remembered scope, validating the registry and reading together
//   RESTORED_MOUNT_REVALIDATION  a mount that restored a retained model and is quietly re-reading behind it
//   SEARCH_CLICK                 a person pressing Search, which always performs a fresh read by design
//   POST_WRITE_READBACK          reconciling what a write just persisted
//
// The first two are mutually exclusive per mount, so the pairing that produces two reads of one payload is a
// restored mount whose quiet revalidation is still open (or has just failed) when the operator presses Search
// — which is exactly what a person does when a page looks wrong. That is a HYPOTHESIS, and it is written here
// as one: this ledger is what lets the next live run confirm or refute it instead of reasoning about it again.
//
// It records the owner, the reason, the dispatch WALL CLOCK, the sequence number and a payload fingerprint, so
// two dispatches can be compared on identity rather than on the action name they share. Bounded at 20 entries;
// no payload contents, no rows, no URL.
var _irReadDispatches = [];
// §6 — the last late answer this page refused because its scope had moved on. Reported, never silent.
var _irLastStaleDrop_ = null;
var IR_READ_OWNERS_ = ['COALESCED_BOOTSTRAP', 'RESTORED_MOUNT_REVALIDATION', 'SEARCH_CLICK',
    'POST_WRITE_READBACK', 'UNDECLARED'];
function _irReadPayloadFingerprint_(payload) {
    try {
        var tp = window.KM && window.KM.transport;
        if (tp && typeof tp.canonicalScope === 'function') return tp.canonicalScope({ v: null, p: payload || null });
        return JSON.stringify(payload || null);
    } catch (e) { return ''; }
}
function _irRecordReadDispatch_(entry) {
    try { if (_irReadDispatches.length < 20) _irReadDispatches.push(entry); } catch (e) {}
}
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R5 §5 — WHAT EACH TABLE IN THE PRIMARY READ IS ACTUALLY FOR.
//
// §5 asks whether the twenty-one-table read should be split into a critical response and a deferred detail
// response. That is a question about EVIDENCE, and the evidence needed to answer it is the one thing the live
// report did not have: `server_execution_ms: null`. Until a cold-boot run returns the §3 stage evidence, "the
// payload is too big" and "the read waited for a slot" are both available readings, and the second is the one
// this round MEASURED (queue wait 6 480 ms out of a 60 000 ms budget, reproduced end to end).
//
// So the classification is shipped and the split is NOT taken. That is the §5 instruction followed, not dodged:
// "If splitting is not justified, optimize the existing scoped Workspace request instead" — which is what the
// arbitration above does. What the table below records is the ANALYSIS, so the decision can be revisited from
// data rather than re-derived from scratch:
//
//   · four of the twenty-one tables are DETAIL-ONLY — nothing in the initial table reads them;
//   · the server already supports the subset (`payload.only`) and the recent-period projection
//     (`payload.recentWindow`), so a split needs no new server surface, only a reason;
//   · and the four detail tables are exactly the ones R6-R2 and R6-R4 depend on being present at Search time
//     (the carrier catalogue is ADOPTED from this response, and the Execution Plan hydrates from the drafts).
//     Deferring them without care would reintroduce the empty-catalogue adoption R6-R2 removed, which is why
//     this is a decision and not an oversight.
//
// `scope_filterable_server_side` records a separate, real observation: this action carries NO scope (see
// _irCriticalReadKey_), so no table is filtered by station before serialization. Several could be. That is the
// largest single reduction available to a future round, and it is written down here rather than discovered again.
// ================================================================================================================
var IR_WORKSPACE_TABLE_ROLES_ = [
    { table: 'marketplaces',                     initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'scope + filter options' },
    { table: 'marketplace_skus',                 initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'the SKU list itself' },
    { table: 'sku_details',                      initial: true,  detail: false, route: false, scope_filterable_server_side: false, note: 'category, units per carton' },
    { table: 'warehouses',                       initial: true,  detail: true,  route: true,  scope_filterable_server_side: false, note: 'filters AND the From/To pickers' },
    { table: 'amazon_inventory_snapshot',        initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'current stock' },
    { table: 'amazon_inventory_health_snapshot', initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'stock health' },
    { table: 'amazon_daily_sales_snapshot',      initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'avg sales per day; recentWindow-projected' },
    { table: 'amazon_weekly_sales_snapshot',     initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'sales; recentWindow-projected' },
    { table: 'fc_regular_forecast',              initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'forecast + days of supply' },
    { table: 'fc_target_rules',                  initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'forecast targets' },
    { table: 'fc_special_events',                initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'the upcoming-event column' },
    { table: 'overseas_inventory_snapshot',      initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: '3PL stock column' },
    { table: 'factory_stock',                    initial: true,  detail: true,  route: false, scope_filterable_server_side: false, note: 'CN/TW stock + the allocation hint' },
    { table: 'shipments',                        initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'on-the-way' },
    { table: 'shipment_lines',                   initial: true,  detail: false, route: false, scope_filterable_server_side: false, note: 'on-the-way' },
    { table: 'shipping_plans',                   initial: true,  detail: false, route: false, scope_filterable_server_side: true,  note: 'qualified incoming' },
    { table: 'shipping_plan_lines',              initial: true,  detail: false, route: false, scope_filterable_server_side: false, note: 'qualified incoming' },
    { table: 'shipping_allocation_drafts',       initial: false, detail: true,  route: true,  scope_filterable_server_side: true,  note: 'Execution Plan hydration only' },
    { table: 'shipping_allocation_draft_lines',  initial: false, detail: true,  route: true,  scope_filterable_server_side: false, note: 'Execution Plan hydration only' },
    { table: 'carrier_lead_times',               initial: false, detail: true,  route: true,  scope_filterable_server_side: false, note: 'Method options + arrival; include-gated' },
    { table: 'carrier_rate_cards',               initial: false, detail: true,  route: true,  scope_filterable_server_side: false, note: 'Method options; include-gated' }
];
// The analysis §5 asks to be REPORTED, merged with whatever the server said about its own read. Read-only, and
// it issues nothing: `slowestTables` / `counts` are already on the last response's meta.
function _irWorkspaceTableRoles_() {
    // Reads the page's EXISTING last-read meta rather than a second copy of it: one owner for the server's
    // own numbers, whoever is reporting them.
    var meta = (typeof _irLastReadMeta !== 'undefined' && _irLastReadMeta) ? _irLastReadMeta : null;
    var slow = {}, counts = (meta && meta.counts) || {};
    ((meta && meta.slowest_tables) || []).forEach(function (s) { slow[s.table] = s.ms; });
    var rows = IR_WORKSPACE_TABLE_ROLES_.map(function (r) {
        return { table: r.table, rows_returned: (counts[r.table] === undefined ? null : counts[r.table]),
            server_read_ms: (slow[r.table] === undefined ? null : slow[r.table]),
            needed_for_initial_table: r.initial, needed_only_after_expanding_a_sku: r.detail && !r.initial,
            needed_only_for_route_or_carrier: r.route && !r.initial,
            already_lazy_loaded_elsewhere: false,
            safely_cacheable: !r.initial,
            scope_filterable_server_side: r.scope_filterable_server_side, note: r.note };
    });
    return {
        contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R5 §5 — per-table role analysis for inventoryReplenishment.workspace.get',
        tables: rows,
        initial_count: rows.filter(function (r) { return r.needed_for_initial_table; }).length,
        detail_only_count: rows.filter(function (r) { return !r.needed_for_initial_table; }).length,
        server_meta_present: !!meta,
        server_duration_ms: (meta && typeof meta.server_execution_ms === 'number') ? meta.server_execution_ms : null,
        server_stages: (meta && meta.server_stages) || null,
        server_entry: (meta && meta.server_entry) || null,
        split_taken: false,
        split_blocked_on: 'A live cold-boot run returning the §3 stage evidence. The measured cause of the '
            + 'observed timeout is dispatch contention (queue wait inside the client bound), not payload size, '
            + 'and no split may be justified by an unmeasured hypothesis. The server already supports '
            + 'payload.only and payload.recentWindow, so the split needs a reason rather than new surface.'
    };
}
window._irWorkspaceTableRoles_ = _irWorkspaceTableRoles_;

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R5 §4/§6 — THE PRIMARY READ GOES THROUGH THE ARBITER.
//
// Two things change and nothing else does. First, the read WAITS for the boot reads it was measured to compete
// with — by their settlement, never by a timer — so its 60 s budget is spent on its own execution instead of on
// other requests' queueing. Second, it is SINGLE-FLIGHT BY SCOPE: a Search pressed while the bootstrap read is
// still open attaches to that request rather than starting a second one, and so does a remount.
//
// The scope is IN THE KEY, which is what makes the sharing safe. Two reads that collide on this key are, by
// construction, requests for the same answer; a genuinely different scope has a different key and a new
// generation, so it can neither be served by nor overwritten by the old one.
// ================================================================================================================
// THE KEY IS THE PAYLOAD, NOT THE SCOPE — because the payload is where the scope would have to be, and it is
// not there. `inventoryReplenishment.workspace.get` is dispatched with `{ recentWindow: true }` and nothing
// else: the server returns the primary-render table set and the CLIENT scopes it (see the note above
// _irWorkspaceRefresh_, and the live evidence's own `payload` field). Keying on the selected scope would
// therefore invent a distinction the request does not have, and it would break the one case §4 names: the
// bootstrap read is dispatched before the selectors are populated, so a Search pressed a moment later would
// compute a DIFFERENT key for a BYTE-IDENTICAL request and issue a second one.
//
// Sharing is safe here for the strongest possible reason: two reads that collide on this key are not merely
// expected to be the same request, they ARE the same request.
function _irCriticalReadKey_(opts) {
    return 'inventoryReplenishment.workspace.get|' + (opts && opts.carrier ? 'carrier' : 'plain') +
        '|' + (opts && opts.recentWindow === false ? 'full' : 'recent');
}
// A QUIET revalidation behind an already-painted table is not on the critical path and must not be arbitrated
// as though it were: nothing is waiting for it, and holding it would only delay a refresh nobody can see.
function _irReadIsCritical_(opts) { return !(opts && opts.quiet); }

function _irWorkspaceRefresh_(opts) {
    var _ba = (typeof window !== 'undefined' && window.KM && window.KM.bootArbiter) ? window.KM.bootArbiter : null;
    if (_ba && _irReadIsCritical_(opts) && !(opts && opts.__arbitrated)) {
        var _key = _irCriticalReadKey_(opts);
        var _inner = Object.assign({}, opts || {}, { __arbitrated: true });
        // THE DEPENDENCY SET IS THE MEASURED MINIMUM, not everything that happens to be in flight.
        //
        // Both boot reads were candidates. Measured across backend concurrencies 1, 2 and 4, waiting for the
        // capability read as well bought NOTHING at concurrency 1 (identical table-ready) and cost ~4s at 2 and
        // 4 — because the registry read is already queued behind capabilities, so waiting for the registry
        // ALREADY waits out the capability read wherever that matters. Depending on it too would be ordering
        // for its own sake, which is what §4 forbids.
        //
        // `scopeRegistry` earns its place twice over: it is the measured contender for the same slot, AND §4
        // requires registry validation and remembered-scope resolution to complete in a deterministic order.
        // `capabilities` is still DECLARED by app.js, because observing it costs nothing and the arbiter's
        // state report is where the next investigation will start.
        return _ba.critical(_key, function () { return _irWorkspaceRefresh_(_inner); },
            { deps: ['scopeRegistry'] })
            .then(function (r) {
                // ==========================================================================================
                // §6 — WHAT A GENERATION CHANGE MEANS FOR *THIS* READ, AND WHY IT IS NOT A DROP.
                //
                // The generation is recorded, and a read that outlived its generation is reported as such. It
                // is NOT discarded, and discarding it would be a defect rather than a safeguard: this read
                // carries no scope, so its answer is not about the old scope at all — the same bytes serve
                // whatever the operator has selected by the time they arrive. Rejecting it would mean a Search
                // pressed during bootstrap fails for no reason and issues a second identical read, which is
                // exactly what §4 requires it not to do.
                //
                // Scope safety is enforced where the scope actually enters: every consumer compares its own
                // sequence before it applies anything, so a late answer can neither apply a stale FILTER nor
                // clear a newer request's error. That is asserted in the suite rather than assumed here.
                // ==========================================================================================
                if (r && r.stale) _irLastStaleDrop_ = { key: _key, generation: r.generation,
                    current_generation: _ba.generation(), scope_independent: true, applied: false };
                if (r && r.ok) return r.value;
                return Promise.reject(r ? r.error : { code: 'WORKSPACE_READ_FAILED' });
            });
    }
    var mySeq = ++_irReadSeq;
    // §16.3 — an UNDECLARED owner is recorded as such rather than guessed. A ledger that invented a
    // plausible owner would be worse than none: it is the attribution itself that is in question.
    var _owner = (opts && opts.owner) ? String(opts.owner) : 'UNDECLARED';
    if (IR_READ_OWNERS_.indexOf(_owner) === -1) _owner = 'UNDECLARED';
    // F1-7N-FB-4E-R4B §A -- a QUIET read drives no load region at all. This is the difference between "refresh
    // the data behind a table that is already correct" and "tell the user we have nothing", and the two must not
    // share a code path: the second is what painted "Searching..." over a valid result.
    var quiet = !!(opts && opts.quiet);
    var rg = quiet ? null : _irRegion_(); if (rg) rg.beginLoad(!!_irReadModel);
    if (!(window.KM && window.KM.api && typeof window.KM.api.getWorkspace === 'function')) {
        return Promise.reject({ code: 'WORKSPACE_UNAVAILABLE', message: 'Inventory Replenishment Workspace API unavailable.' });
    }
    // F1-7N-FB-4G-A1-R1 - THE CARRIER INCLUDE RIDES ON THE PRIMARY READ.
    //
    // It used to be asked for separately, by the method registry, as
    // getWorkspace('inventoryReplenishment', { include: { carrierPlanning: true } }) - the SAME action,
    // differing only by the flag. The workspace is a FULL-SET raw passthrough of nineteen tables, so that
    // second call re-read and re-transferred all nineteen in order to obtain two small reference tables. It is
    // the most expensive read on the page, it was issued twice per Search, and the second copy is what reached
    // the transport's 60 000 ms read bound and surfaced as METHOD_CATALOGUE_ERROR - REQUEST_TIMEOUT.
    //
    // F1-7J-A2 gated those two tables so the PRIMARY render would not pay for a SECONDARY panel's reference
    // data. That reasoning was sound while the carrier read was genuinely optional. It has not been optional
    // since FB-4C: _irApplySearch_ preloads the catalogue on EVERY confirmed Search, so the gate was no longer
    // saving a read - it was buying a duplicate of the other nineteen tables to avoid two small ones.
    //
    // So this is a REDUCTION, not an addition: ~40 tables transferred per Search becomes ~21, and one request
    // replaces two. It applies to the PRIMARY read only - the post-write readback keeps its exact previous
    // payload, so the separate bounded-readback deferral recorded by 7M-B/7M-B2 is untouched.
    // F1-7N-FC-1B-E3-R4 §C/§D — ASK FOR THE BOUNDED PAYLOAD.
    //
    // This request has never carried a scope, and the handler has never had one to honour: every primary read
    // returns twenty-one whole tables. Measured through the shipped code, a complete US/Amazon Search sends the
    // BYTE-IDENTICAL request a blank page would, and a Search after a timeout re-sends that same request again.
    // So the blank Country/Marketplace on the failure screen is not the cause of anything — a blank or partial
    // scope issues ZERO inventory requests and is refused before dispatch.
    //
    // What IS unbounded is time: the daily and weekly sales snapshots gain rows every day forever, and their
    // consumers read seven days and one week. `recentWindow` asks the server to keep each scope's own most
    // recent periods. It is opt-in, so no other caller's payload changes, and the server reports what it
    // dropped so the reduction is visible rather than assumed.
    // F1-7N-FC-1B-E3-R4-A1 §D — THE PRIMARY RENDER STOPS PAYING FOR REFERENCE DATA IT DOES NOT DISPLAY.
    //
    // `opts.carrier` no longer adds two sheets to the read the screen is waiting on. It now marks the read as
    // one that SHOULD be followed by a catalogue load, which the method registry performs separately against
    // two tables. The blocking read drops from twenty-one sheets to nineteen; the catalogue costs two, off the
    // critical path, and only for a scope whose rows can actually be expanded.
    //
    // Adoption from the primary read is therefore no longer possible, and `_irReadModelHasCarrier` stays false
    // — which is the correct answer, not a regression: adopting a payload that did not carry the include would
    // install two empty tables as a settled catalogue and report a configuration problem that does not exist.
    var _wsPayload = { recentWindow: true };
    var _dispatch = { owner: _owner, reason: (opts && opts.reason) ? String(opts.reason) : null,
        at: _irNowMs_ ? _irNowMs_() : 0, seq: mySeq, quiet: quiet,
        payload_fingerprint: _irReadPayloadFingerprint_(_wsPayload),
        settled_at: null, outcome: null };
    _irRecordReadDispatch_(_dispatch);
    return Promise.resolve(window.KM.api.getWorkspace('inventoryReplenishment', _wsPayload)).then(function (env) {
        _dispatch.settled_at = _irNowMs_ ? _irNowMs_() : 0;
        _dispatch.outcome = (env && env.success) ? 'SUCCESS' : 'FAILED';
        if (mySeq !== _irReadSeq) return _irReadModel;   // a newer read superseded this one
        if (env && env.success && env.data) {
            // §B — the server's OWN execution time, which it has always reported and the page has always
            // thrown away. R3-R1 reported server_execution_ms as null because the transport records client
            // elapsed only; the envelope meta carries the real number, so the stage report now uses it.
            try {
                var _m = (env && env.meta) || {};
                _irLastReadMeta = { server_execution_ms: (typeof _m.serverDurationMs === 'number') ? _m.serverDurationMs : null,
                    tables_read: (typeof _m.tablesRead === 'number') ? _m.tablesRead : null,
                    rows_returned: (typeof _m.rowsReturned === 'number') ? _m.rowsReturned : null,
                    recent_window: _m.recentWindow || null, request_id: _m.requestId || null,
                    // §A1 — the echoed contract and the per-table timing.
                    recent_window_requested: _m.recentWindowRequested === true,
                    recent_window_applied: _m.recentWindowApplied === true,
                    only_requested: _m.onlyRequested || null,
                    open_ms: (typeof _m.openMs === 'number') ? _m.openMs : null,
                    slowest_tables: _m.slowestTables || null,
                    // R6-R5 §3 — the server-side entry and stage evidence, carried through so the reach
                    // question ("did it reach Apps Script, and when?") is answerable from a SUCCESSFUL read
                    // too. A baseline from healthy runs is what makes a slow one legible.
                    server_entry: _m.entry || null,
                    server_stages: _m.stages || null,
                    server_handler: _m.handler || null,
                    server_build: _m.serverBuild || null,
                    server_lock: (_m.lock === undefined) ? undefined : _m.lock,
                    counts: (env.data && env.data.counts) || null,
                    at: _irNowMs_() };
            } catch (e) { _irLastReadMeta = null; }
            _irReadModel = window.KM.DB.adaptInventoryReplenishmentWorkspace(env.data);
            // ==========================================================================================
            // F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §3 — THE CATALOGUE WAS SETTLED EMPTY, AND THAT IS WHY THE
            // LANE HAD NO METHODS.
            //
            // The comment above this line stated the rule correctly and the code did not implement it.
            // `opts.carrier` USED to mean "this read carries include.carrierPlanning", and R4-A1 §D changed
            // it to mean "this read should be FOLLOWED BY a separate catalogue load" — it removed the
            // include from `_wsPayload` and left this assignment reading the same flag. All three primary
            // readers (SEARCH_CLICK, COALESCED_BOOTSTRAP, RESTORED_MOUNT_REVALIDATION) pass carrier:true,
            // so from that round onward every Search:
            //
            //   1. sent { recentWindow: true } — no include — and 60_ correctly SKIPPED both carrier tables
            //      (`if (spec.include && !include[spec.include]) continue;`),
            //   2. set _irReadModelHasCarrier = true anyway,
            //   3. adopted a model whose getCarrierLeadTimes/getCarrierRateCards are both [],
            //   4. and, because adoption REPORTED SUCCESS, never fell through to the lazy load.
            //
            // The registry then held an empty catalogue as a SETTLED one. resolve() answers
            // EMPTY_CONFIGURATION with transit_authority.checked = true — "carrier_lead_times has no row
            // for it either" — for a lane that has twenty-one perfectly good rows, and getLeadTimes()
            // returns [] so every arrival reads "Lead time unavailable". This is the whole of the live
            // CN -> US symptom, and it is why R6-R1's registry fix appeared to change nothing: correct code
            // was being handed an empty table.
            //
            // THE GATE IS NOW EVIDENCE, NOT INTENT. What may be adopted is decided by what the response
            // ACTUALLY CONTAINS, not by what the caller meant to ask for. This keeps the mixed-deployment
            // path the R4-A1 note describes — a 60_ that predates the include gate returns those tables on
            // the primary read, and seeding from them is correct BECAUSE THEY ARE THERE — while making it
            // impossible for an absent table to install itself as a settled answer. A request that did ask
            // for the include and got nothing back is a genuinely empty catalogue, so it still adopts.
            // ==========================================================================================
            var _wsAskedCarrier = !!(_wsPayload.include && _wsPayload.include.carrierPlanning);
            var _wsDataHasCarrier = !!((env.data.carrier_lead_times && env.data.carrier_lead_times.length) ||
                (env.data.carrier_rate_cards && env.data.carrier_rate_cards.length));
            _irReadModelHasCarrier = _wsAskedCarrier || _wsDataHasCarrier;
            // The boundary counts §3 asks for, recorded where the transport actually settles. Measurement
            // only — nothing reads this to make a decision.
            _irCarrierTransport = { asked_include: _wsAskedCarrier, requested_owner: (opts && opts.carrier) ? String(_owner) : null,
                server_lead_time_rows: (env.data.carrier_lead_times || []).length,
                server_rate_card_rows: (env.data.carrier_rate_cards || []).length,
                normalized_lead_time_rows: (_irReadModel.getCarrierLeadTimes || []).length,
                normalized_rate_card_rows: (_irReadModel.getCarrierRateCards || []).length,
                adoptable: _irReadModelHasCarrier,
                reason: _irReadModelHasCarrier
                    ? (_wsAskedCarrier ? 'READ_REQUESTED_THE_INCLUDE' : 'SERVER_RETURNED_CARRIER_TABLES_UNASKED')
                    : 'NO_CARRIER_TABLES_IN_THIS_RESPONSE - the catalogue loads separately; nothing empty is adopted',
                at: _irNowMs_ ? _irNowMs_() : 0 };
            // F1-7N-FB-4E-R4B §A — the completion stamp. Only a SUCCESSFUL read sets it, so a failure can never
            // present itself as a completed result, and an aged result can be told from a current one.
            _irReadModelAt = _irNowMs_();
            if (rg) rg.set((_irReadModel.getMarketplaceSkus && _irReadModel.getMarketplaceSkus.length) ? window.KM.loadState.STATES.READY : window.KM.loadState.STATES.EMPTY);
            return _irReadModel;
        }
        throw (env && env.errors && env.errors[0]) || { code: 'INVENTORY_REPLENISHMENT_READ_FAILED', message: 'Inventory Replenishment workspace request failed.' };
    });
}

// Post-write reconcile: Workspace mode → scoped re-read then cb (the primary render ignores the broad cache the db-api
// writer reloaded); Legacy → cb immediately (the writer already reloaded the cache).
// F1-7N-FB-4G-A1-R1 - deliberately WITHOUT the carrier include. A post-write readback exists to reconcile what
// was just written; the catalogue is reference data that cannot have changed, and this path carries its own
// documented bounded-readback deferral (7M-B / 7M-B2) which this round does not disturb.
function _irAfterWrite(cb) {
    if (!_irEffectiveWorkspace()) { if (typeof cb === 'function') cb(); return; }
    _irWorkspaceRefresh_({ owner: 'POST_WRITE_READBACK',
        reason: 'reconciling what a write just persisted' })
        .then(function () { if (typeof cb === 'function') cb(); }).catch(function (err) { _irRenderError_(err); });
}

// ========================================
// Search-triggered loading (Demo OFF + Cloud Read)
// ========================================
// F1-7N-FB-2A §B — Search is now the ONLY thing that loads or applies anything.
//   • Filters are VALIDATED first, so an invalid Search costs zero requests.
//   • SINGLE-FLIGHT: a second click while a read is in flight is dropped (no duplicate concurrent read).
//   • A monotonic sequence guard means an older in-flight response can never overwrite a newer Search.
//   • The pending filters become APPLIED only on SUCCESS — atomically, together — so a failed Search leaves
//     the previous confirmed result and its filters untouched.
//   • Failure shows an actionable error with a Retry, never an empty result.
function searchReplenishment() {
    // A new search (incl. Country / Marketplace change then Search) resets the Category tab to All.
    replenCategoryTab = 'All';

    // Demo ON: just re-render (demo does not need search)
    if (typeof _replenDemoOn === 'function' && _replenDemoOn()) {
        renderReplenishment();
        return;
    }

    // Validate the PENDING selector values BEFORE anything else — a blocked Search issues NO request.
    var pending = _irPendingFilters_();
    if (!pending.country && !pending.marketplaceId) { alert('Please select Country and Marketplace before searching.'); return; }
    if (!pending.country) { alert('Please select a Country.'); return; }
    if (!pending.marketplaceId) { alert('Please select a Marketplace.'); return; }

    if (_irSearch.inFlight) return;   // single-flight — repeated rapid clicks share the in-flight read

    // Canonical: scoped inventoryReplenishment workspace (NO broad Operation DB for the primary render). The
    // read model is scope-INDEPENDENT, so once it is loaded a Search is pure client-side filtering and costs
    // ZERO further requests. Fail-closed — a bounded region error, never a silent legacy broad fallback.
    if (_irEffectiveWorkspace()) {
        var mySeq = ++_irSearch.seq;
        if (_irReadModel) { _irApplySearch_(pending, mySeq); return; }
        _irSearch.inFlight = true; _irSearch.status = 'LOADING'; _irSearch.error = null;
        _irRenderSearchGate_();
        // F1-7N-FB-3 §C — Search is the ONLY thing that reads the inventory workspace. (FB-2A routed this
        // through the registry loader, which is what coupled selector loading to the table's load state.)
        _irWorkspaceRefresh_({ carrier: true,
            owner: 'SEARCH_CLICK',
            reason: 'a person pressed Search, which always performs a fresh read' }).then(function () {
            _irSearch.inFlight = false;
            if (mySeq !== _irSearch.seq) return;   // a newer Search superseded this response
            _irApplySearch_(pending, mySeq);
        })['catch'](function (err) {
            _irSearch.inFlight = false;
            if (mySeq !== _irSearch.seq) return;   // stale failure — never overwrite a newer Search
            _irSearch.status = 'ERROR';
            _irSearch.error = { code: (err && err.code) || 'INVENTORY_REPLENISHMENT_READ_FAILED',
                message: (err && err.message) || 'Inventory Replenishment read failed' };
            _irRenderSearchGate_();
        });
        return;
    }

    // Legacy (kill switch OFF): if the DB cache isn't loaded yet, load once, populate filters, then search.
    var lSeq = ++_irSearch.seq;
    if (!window._opDbCache) {
        var loader = (window.KM && window.KM.DB && window.KM.DB.loadOperationDb)
            ? window.KM.DB.loadOperationDb
            : (window.reloadOperationDb || null);
        if (loader) {
            _irSearch.inFlight = true; _irSearch.status = 'LOADING'; _irSearch.error = null;
            _irRenderSearchGate_();
            loader({ force: true }).then(function() {
                _irSearch.inFlight = false;
                if (lSeq !== _irSearch.seq) return;
                _irApplySearch_(pending, lSeq);
            })['catch'](function(err) {
                _irSearch.inFlight = false;
                if (lSeq !== _irSearch.seq) return;
                _irSearch.status = 'ERROR';
                _irSearch.error = { code: (err && err.code) || 'OPERATION_DB_LOAD_FAILED',
                    message: (err && err.message) || 'The Operation DB could not be loaded.' };
                _irRenderSearchGate_();
            });
            return;
        }
    }
    _irApplySearch_(pending, lSeq);
}

// Commit the PENDING filters as APPLIED (atomic — both or neither) and render exactly once. This is the ONLY
// place _irSearch.applied is ever assigned, so nothing else in the page can make data appear.
function _irApplySearch_(pending, mySeq) {
    if (mySeq !== _irSearch.seq) return;                  // superseded while resolving
    if (typeof populateReplenFiltersFromRegistry === 'function') populateReplenFiltersFromRegistry();
    // R6-R5 §6 — a genuinely DIFFERENT applied scope advances the arbiter's generation. Nothing is discarded
    // on this page as a result (the primary read carries no scope), but the boundary is recorded so a late
    // answer can always be told which side of a scope change it belongs to.
    try {
        var _prevApplied = _irSearch.applied;
        if (window.KM && window.KM.bootArbiter && (!_prevApplied ||
            String(_prevApplied.country || '') !== String(pending.country || '') ||
            String(_prevApplied.marketplaceId || '') !== String(pending.marketplaceId || ''))) {
            window.KM.bootArbiter.newGeneration('APPLIED_SCOPE_CHANGED');
        }
    } catch (_eGen) {}
    _irSearch.applied = { country: pending.country, marketplaceId: pending.marketplaceId };
    // F1-7N-FB-4E-R3 §B.4 — remember the scope of a SUCCESSFUL Search, and only here. This is already the one
    // place `applied` is assigned, so it is the only place a scope is known to be valid AND to have produced a
    // real result. Remembering a merely SELECTED scope would persist something that was never proven to work.
    if (typeof _irRememberScope_ === 'function') _irRememberScope_(_irSearch.applied);
    _irSearch.stale = false;
    _irSearch.error = null;
    _irSearch.status = 'READY';                           // renderReplenishment downgrades to EMPTY on 0 rows
    renderReplenishment();
    // F1-4B-B / FM5-R1: the SCOPE-dependent reads (materialized gap, at most one live
    // recommendation.workspace.get) belong to Search and to nothing else. They used to also fire on mount and
    // on every selector change — that was root cause 2/3 of the pre-Search auto-load. One request set per
    // confirmed Search; never per SKU; never both engines.
    if (typeof _irRecoTrigger === 'function') _irRecoTrigger();
    // F1-7N-FB-4F-B6 §C.3 — hydrate the persisted Execution Plan for the station that was just APPLIED. The
    // mount cannot do this (see _irHydrateDraftForAppliedScope_): at mount there is no scope to hydrate for.
    // NOT AWAITED — it re-renders itself when it has something, and it never blocks the first paint.
    if (typeof _irHydrateDraftForAppliedScope_ === 'function') {
        try { _irHydrateDraftForAppliedScope_(); } catch (eH) {}
    }
    // F1-7N-FC-1B-E3-R4-A1 §A1 - RESTATED, because the trade underneath it has changed sides.
    //
    // FB-4G-A1-R1 seeded the registry from the primary read to avoid a SECOND read of all nineteen other
    // tables, which is what reached the 60 s bound as METHOD_CATALOGUE_ERROR. Live measurement has since shown
    // the cost is per-TABLE, not per-row, and the workspace now accepts an explicit table subset - so the
    // catalogue is two sheets rather than twenty-one, and carrying it on the read the SCREEN waits for is no
    // longer the cheaper side of the trade.
    //
    // The primary read therefore no longer asks for the include, adoption reports false, and this falls
    // through to the lazy load by design. The adoption path is KEPT rather than deleted: a mixed deployment
    // whose 60_ predates the `only` parameter still returns the include-gated tables on the primary read, and
    // seeding from them is correct when they are genuinely present.
    if (typeof _irAdoptCarrierCatalogue_ === 'function' && _irAdoptCarrierCatalogue_()) {
        if (typeof _irRebuildAllMethodOptions_ === 'function') _irRebuildAllMethodOptions_();
    } else if (typeof _irLoadCarrierPlanning_ === 'function') {
        try {
            _irLoadCarrierPlanning_().then(function () {
                if (typeof _irRebuildAllMethodOptions_ === 'function') _irRebuildAllMethodOptions_();
            });
        } catch (e) {}
    }
}
window.searchReplenishment = searchReplenishment;
window._irApplySearch_ = _irApplySearch_;

// ---- F1-4B-FM5-R4J · "Recalculate All Sites" (Inventory Replenishment Gap) — BACKEND-OWNED RESUMABLE JOB ------
// The ~14-min all-site materialization is NO LONGER owned by the browser request. One click STARTS one backend job
// (a quick write returning { runId, status, scopesTotal }; NO calculation in the request, NO write retry) and the
// page then POLLS a strictly READ-ONLY status endpoint until terminal, showing Starting… / Calculating N/M /
// Refreshing… / Completed. The backend owns the job to completion even if this tab is closed/refreshed (recovered
// on mount by _irResumeGapJobOnMount_). On DONE the page refreshes the materialized read — NO page-side formula.
var _irRecalcAllBusy = false;
var _irActiveRunId = null;         // LIVE4 — the backend runId of the in-flight job (for a targeted Cancel)
var _irCancelRequested = false;    // LIVE4 — set once by the Cancel button so the poller stops cooperatively
function _irRecalcBtn_() { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('replen-recalc-all-btn') : null; }
function _irCancelBtn_() { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('replen-cancel-recalc-btn') : null; }
function _irShowCancel_(show) { var c = _irCancelBtn_(); if (c) { c.style.display = show ? '' : 'none'; if (show) c.disabled = false; } }
// LIVE10 §13/§14 — ONE handler, optional bounded scope. scopeSpec = { mode:'ALL_SITES'|'CURRENT_COUNTRY'|
// 'CURRENT_SCOPE', company?, country?, marketplace? }; omitted ⇒ ALL_SITES (the existing button, unchanged). The
// scope is passed to the backend job START; nothing else about the lifecycle changes (one START → poll → refresh).
function handleRecalcAllInventoryGap(scopeSpec) {
  // F1-7N-FB-4E-R4B-R3 §4 - every one of these early returns used to end the click in silence, because the only
  // surface they had was a menu item the click itself had already hidden.
  if (_irRecalcAllBusy) {
    _irAiSupportNotice_('info', 'Recalculate', 'A recalculation is already running. The click was ignored; nothing was started twice.');
    return;
  }
  if (!(window.KM && window.KM.DB && typeof window.KM.DB.startInventoryReplenishmentGapJob === 'function')) {
    _irAiSupportTriggerIdle_('recalc');
    _irAiSupportNotice_('bad', 'Recalculate', 'Recalculation service is unavailable (Operation DB API not configured). Nothing was run and nothing was changed.');
    alert('Recalculation service is unavailable (Operation DB API not configured).');
    return;
  }
  var _scopeMode = (scopeSpec && scopeSpec.mode) ? String(scopeSpec.mode) : 'ALL_SITES';
  var _scopeText = _scopeMode === 'CURRENT_SCOPE' ? 'the SELECTED site' : (_scopeMode === 'CURRENT_COUNTRY' ? 'the SELECTED country' : 'ALL sites');
  if (typeof window.confirm === 'function' && !window.confirm('Start a recalculation of the materialized replenishment gap for ' + _scopeText + '?\n\nThis runs as a backend job that keeps going even if you close or refresh this page. The latest result per site/SKU is overwritten.')) {
    _irAiSupportTriggerIdle_('recalc');
    _irAiSupportNotice_('info', 'Recalculate', 'Recalculation was not confirmed. Nothing was run and nothing was changed.');
    return;
  }
  var btn = _irRecalcBtn_();
  var label = (btn && btn.dataset && btn.dataset.idleLabel) ? btn.dataset.idleLabel : (btn ? btn.textContent : '');
  if (btn && btn.dataset) btn.dataset.idleLabel = label || 'Recalculate All Sites';
  _irRecalcAllBusy = true; _irActiveRunId = null; _irCancelRequested = false;
  // The menu item lives inside a panel the click already hid, so every state it is given is MIRRORED onto the
  // trigger, which stays on screen. Without this the whole progress lifecycle is painted where nobody can see it.
  function setBtn(txt, disabled) {
    if (btn) { btn.disabled = !!disabled; btn.textContent = txt; }
    if (disabled) _irAiSupportTriggerBusy_('recalc', txt); else _irAiSupportTriggerIdle_('recalc');
  }
  // §8 the ONE deterministic reset — always hides Cancel and returns the button to idle (used by every terminal path).
  function restore() { _irRecalcAllBusy = false; _irActiveRunId = null; _irShowCancel_(false); setBtn(label || 'Recalculate All Sites', false); _irAiSupportTriggerIdle_('recalc'); }
  var _recalcTitle = (_scopeMode === 'CURRENT_SCOPE') ? 'Recalculate Current Scope' : 'Recalculate All Sites';
  var gr = (window.KM && window.KM.gapRecalc) ? window.KM.gapRecalc : null;
  var startFn = function () { return window.KM.DB.startInventoryReplenishmentGapJob(scopeSpec ? { payload: { scope: scopeSpec } } : {}); };   // the WRITE POST — exactly ONCE (optional bounded scope §13)
  var statusFn = function () { return window.KM.DB.getGapJobStatus('INVENTORY'); };            // READ-ONLY poll
  var refreshFn = function () { if (typeof refreshInventoryGapAfterRecalc_ === 'function') return refreshInventoryGapAfterRecalc_(); };
  if (!gr || typeof gr.runJob !== 'function') {                                                // module absent → start + single refresh
    setBtn('Starting…', true);
    return Promise.resolve(startFn()).then(function () { refreshFn(); restore(); }).catch(function () { restore(); });
  }
  return gr.runJob(startFn, statusFn, {
    product: 'INVENTORY',   // LIVE7 §3 — names the product in the [GapJob] START_ERROR DevTools diagnostic
    refresh: refreshFn,
    onRunId: function (rid) { _irActiveRunId = rid; },
    isCancelled: function () { return _irCancelRequested; },
    ui: {
      starting: function () { setBtn('Starting…', true); },
      progress: function (st) { if (!(st && st.status)) return; var n = (st && st.scopesProcessed != null) ? st.scopesProcessed : 0, m = (st && st.scopesTotal != null) ? st.scopesTotal : 0; setBtn((st && st.recovering ? 'Recovering… ' : 'Calculating… ') + n + ' / ' + m, true); _irShowCancel_(true); },   // LIVE10 §11 guard non-status polls; §7 show Recovering while the backend self-heals
      refreshing: function () { _irShowCancel_(false); setBtn('Refreshing…', true); },
      // F1-SMALL-GAP-JOB-DONE-NOTICE-R1: this MANUAL runJob done() fires only on terminal DONE, AFTER refresh() — so the
      // notice is truthful and never precedes fresh data. Keyed to _irActiveRunId (one notice per manual run). The
      // resume-on-mount done() below deliberately does NOT announce, so scheduled/resumed jobs stay silent.
      done: function (finalState) { _irShowCancel_(false); setBtn('Completed', true); try { if (gr && typeof gr.announceManualDone === 'function') gr.announceManualDone(_irActiveRunId, gr.formatDoneMessage('Inventory', scopeSpec, finalState)); } catch (e) {} _irAiSupportNotice_('ok', _recalcTitle, 'Recalculation completed and the materialized replenishment gap was refreshed.'); if (typeof setTimeout === 'function') setTimeout(restore, 1500); else restore(); },
      cancelled: function () { _irShowCancel_(false); setBtn('Cancelled — results preserved', true); try { console.info('[GapJob] Calculation cancelled. Latest completed results are preserved.'); } catch (e) {} _irAiSupportNotice_('warn', _recalcTitle, 'Recalculation was cancelled. The latest completed results are preserved.'); if (typeof setTimeout === 'function') setTimeout(restore, 1500); else restore(); },
      failed: function (st) { _irAiSupportNotice_('bad', _recalcTitle, _irGapJobFailMsg_('Inventory', st)); alert(_irGapJobFailMsg_('Inventory', st)); restore(); }
    }
  });
}
window.handleRecalcAllInventoryGap = handleRecalcAllInventoryGap;
// LIVE10 §14 — STABLE AI-Assist callable contracts (no toolbar redesign in this round). A later UI round places these
// under an "AI Assist" menu alongside the existing Generate AI Plan (handleReplenAiPlan). They REUSE the one recalc
// handler above (no duplicated lifecycle) and default to the current on-screen scope; a caller may pass an explicit
// { company, country, marketplace }. If the page cannot resolve a current scope they fall back to ALL_SITES.
function _irCurrentScopeSpec_(mode) {
  var sc = (typeof _irScope !== 'undefined' && _irScope) ? _irScope : ((typeof _irMatState !== 'undefined' && _irMatState && _irMatState.scope) ? _irMatState.scope : null);
  if (!sc || !sc.company) return { mode: 'ALL_SITES' };
  return { mode: mode, company: sc.company, country: sc.country, marketplace: sc.marketplace };
}
function recalcInventoryGapAllSites() { return handleRecalcAllInventoryGap({ mode: 'ALL_SITES' }); }
function recalcInventoryGapCurrentCountry() { return handleRecalcAllInventoryGap(_irCurrentScopeSpec_('CURRENT_COUNTRY')); }
function recalcInventoryGapCurrentScope() { return handleRecalcAllInventoryGap(_irCurrentScopeSpec_('CURRENT_SCOPE')); }
window.recalcInventoryGapAllSites = recalcInventoryGapAllSites;
window.recalcInventoryGapCurrentCountry = recalcInventoryGapCurrentCountry;
window.recalcInventoryGapCurrentScope = recalcInventoryGapCurrentScope;

// LIVE4 §6 — manual Cancel: ONE backend cancel write for the active runId, stop this poller cooperatively; the shared
// runJob poller then refreshes the materialized READ and resets the button (never a browser-only cancel, no reload).
function handleCancelInventoryGapJob() {
  if (!_irRecalcAllBusy || _irCancelRequested) return;
  var c = _irCancelBtn_(); if (c) c.disabled = true;
  _irCancelRequested = true;   // the poller returns CANCELLED on its next tick → runJob refreshes + resets
  try { console.info('[GapJob] CANCEL_REQUEST INVENTORY run=' + _irActiveRunId); } catch (e) {}
  if (window.KM && window.KM.DB && typeof window.KM.DB.cancelInventoryReplenishmentGapJob === 'function') {
    try { window.KM.DB.cancelInventoryReplenishmentGapJob(_irActiveRunId); } catch (e) {}   // exactly ONE cancel write
  }
}
window.handleCancelInventoryGapJob = handleCancelInventoryGapJob;

// §5/§12 — truthful terminal message. STALLED / POLL_TIMEOUT = "could not be confirmed" (recoverable, NO auto retry);
// any other non-DONE state = a genuine failure. Either way the button returns to a retryable idle state.
function _irGapJobFailMsg_(product, st) {
  var gr = (window.KM && window.KM.gapRecalc), status = (st && st.status) || 'unknown';
  if (gr && typeof gr.isUnconfirmedJob === 'function' && gr.isUnconfirmedJob(status)) {
    return product + ' calculation status could not be confirmed. Check the latest data before retrying (no automatic retry was issued).';
  }
  var why = (st && st.lastError) ? (' — ' + st.lastError) : '';
  return product + ' recalculation failed (status: ' + status + ')' + why + '.\nNo automatic retry was issued; check the latest data.';
}
window._irGapJobFailMsg_ = _irGapJobFailMsg_;

// §13 mount/reload recovery — if a backend Inventory job is already PENDING/RUNNING (e.g. started in another tab, or
// this tab was refreshed), resume READ-ONLY status polling and refresh on DONE. The original tab need not be alive.
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R5 §4 — DEFERRED, BECAUSE IT WAS MEASURED COMPETING AND IT IS NOT CRITICAL.
//
// This is a status poll for a gap job that is USUALLY NOT RUNNING, fired unconditionally on every mount. In the
// cold-boot timeline it is the fourth concurrent request, and at a serialized backend it was measured taking a
// slot ahead of the read the table is waiting for — and then waiting 45 s behind it anyway. Nothing on screen
// depends on it, so it now runs when the critical lane is clear.
//
// DEFERRED IS NOT DROPPED. It still runs, and a job that IS running is still resumed; it simply stops paying
// for that with the primary read's timeout budget.
function _irResumeGapJobOnMount_() {
  var _ba = (typeof window !== 'undefined' && window.KM && window.KM.bootArbiter) ? window.KM.bootArbiter : null;
  if (_ba && !_irGapResumeDeferred_) {
    _irGapResumeDeferred_ = true;
    return _ba.deferred('gapJob.status.get:INVENTORY', function () {
      _irGapResumeDeferred_ = false;
      return _irResumeGapJobNow_();
    });
  }
  return _irResumeGapJobNow_();
}
var _irGapResumeDeferred_ = false;
function _irResumeGapJobNow_() {
  var gr = (window.KM && window.KM.gapRecalc), db = (window.KM && window.KM.DB);
  if (!gr || typeof gr.resumeIfRunning !== 'function' || !db || typeof db.getGapJobStatus !== 'function') return;
  var btn = _irRecalcBtn_();
  var label = (btn && btn.dataset && btn.dataset.idleLabel) ? btn.dataset.idleLabel : (btn ? btn.textContent : 'Recalculate All Sites');
  if (btn && btn.dataset) btn.dataset.idleLabel = label;
  function setBtn(txt, disabled) { if (btn) { btn.disabled = !!disabled; btn.textContent = txt; } }
  function resReset() { _irRecalcAllBusy = false; _irActiveRunId = null; _irShowCancel_(false); setBtn(label, false); }
  _irCancelRequested = false;
  return gr.resumeIfRunning(function () { return db.getGapJobStatus('INVENTORY'); }, {
    refresh: function () { if (typeof refreshInventoryGapAfterRecalc_ === 'function') return refreshInventoryGapAfterRecalc_(); },
    isCancelled: function () { return _irCancelRequested; },
    ui: {
      resume: function (st) { _irRecalcAllBusy = true; if (st && st.runId) _irActiveRunId = st.runId; },   // a resumed job is cancellable too
      progress: function (st) { if (!(st && st.status)) return; if (st && st.runId) _irActiveRunId = st.runId; var n = (st && st.scopesProcessed != null) ? st.scopesProcessed : 0, m = (st && st.scopesTotal != null) ? st.scopesTotal : 0; setBtn((st && st.recovering ? 'Recovering… ' : 'Calculating… ') + n + ' / ' + m, true); _irShowCancel_(true); },
      refreshing: function () { _irShowCancel_(false); setBtn('Refreshing…', true); },
      done: function () { _irShowCancel_(false); setBtn('Completed', true); if (typeof setTimeout === 'function') setTimeout(resReset, 1500); else resReset(); },
      cancelled: function () { _irShowCancel_(false); setBtn('Cancelled — results preserved', true); if (typeof setTimeout === 'function') setTimeout(resReset, 1500); else resReset(); },
      // §5 a resumed job that ends non-DONE (stalled/failed) must NOT leave the button stuck at Calculating.
      failed: function (st) { resReset(); if (st && st.status && st.status !== 'DONE') { try { console.warn(_irGapJobFailMsg_('Inventory', st)); } catch (e) {} } }
    }
  });
}
window._irResumeGapJobOnMount_ = _irResumeGapJobOnMount_;

// F1-4B-FM5-R4UI-R4 §6/§7 — SHARED manual-recalc transport-recovery contract (Inventory + Order Planning use it
// identically, §11.P). A transport error = the browser never received an acknowledged batch envelope. On it we
// refetch the READ ONLY (never the WRITE), then decide from the stored calculated_at: if the newest stored row is
// newer than the pre-recalc snapshot, the batch completed despite the lost response → report completion from the
// refreshed data; otherwise report that completion could not be confirmed (never a fabricated success).
// F1-4B-FM5-R4T — transport-error + recovery now delegate to the ONE shared, bounded-poll, READ-ONLY contract
// (window.KM.gapRecalc, assets/js/utils/gap-recalc-transport.js), used identically by Inventory + Order Planning.
function _irIsTransportError_(e) {
  return (window.KM && window.KM.gapRecalc) ? window.KM.gapRecalc.isTransportError(e)
    : (function () { var c = e && e.code ? String(e.code) : ''; return c === 'HTTP_TRANSPORT_ERROR' || c === 'NON_JSON_RESPONSE'; })();
}
// Newest calculated_at among the currently-loaded materialized rows (server 'YYYY-MM-DD HH:MM:SS' → lexical compare).
function _irMaxCalculatedAt_() {
  var rows = (_irMatState && _irMatState.rows) || []; var mx = '';
  for (var i = 0; i < rows.length; i++) { var c = rows[i] && rows[i].calculated_at ? String(rows[i].calculated_at) : ''; if (c > mx) mx = c; }
  return mx;
}
// Thin delegator to the shared recovery contract: bounded READ-ONLY verification (2s/5s/10s/20s), NEVER a write
// retry. refetchFn re-READs the materialized gap; maxFn re-reads the newest stored calculated_at.
function _irRecalcTransportRecovery_(product, preMax, refetchFn, maxFn, restore) {
  var done = function () { if (typeof restore === 'function') restore(); };
  if (window.KM && window.KM.gapRecalc) {
    return window.KM.gapRecalc.recover(product, preMax, refetchFn, maxFn, { done: done });
  }
  // Fallback (module absent): single READ-ONLY refetch + confirm from calculated_at (no write retry).
  return Promise.resolve(typeof refetchFn === 'function' ? refetchFn() : null).then(function () {
    var postMax = (typeof maxFn === 'function') ? maxFn() : '';
    alert(postMax && (!preMax || postMax > preMax)
      ? (product + ' recalculation completed. The connection was interrupted while receiving the response — results refreshed.')
      : (product + ': unable to confirm completion. Check the latest data before retrying (no automatic retry was issued).'));
    done();
  }).catch(done);
}
window._irRecalcTransportRecovery_ = _irRecalcTransportRecovery_;
window._irIsTransportError_ = _irIsTransportError_;

// AI Plan (Inventory Replenishment) — refreshes replenishment suggestions using the EXISTING Suggested Qty /
// View Recommendation calculation (renderReplenishment recomputes + re-renders with the CURRENT filter /
// planning scope; the same entry used on load + Search). It does NOT reset the Category tab, NEVER runs
// Submit Plan, and NEVER creates a Shipping Plan. No new AI model / API / recommendation schema. Loading
// state guards double-click and shows success/error styling.
// F1-4B-FM6 — AI Plan is now DETERMINISTIC Phase-1 recommendation generation (NOT an LLM): it reads the latest
// MATERIALIZED inventory_replenishment_gap rows already loaded for the scope (_irMatState.rows) and runs the
// canonical KMREC generator (earliest non-zero shortage window D18→D90). It recalculates NO gap, writes NOTHING,
// and never overwrites the gap table — it only produces a Recommended Action decision per SKU held in page state.
var _irRecoByKey = {};   // sku → KMREC inventory recommendation DTO (Phase-1 page state; regenerated by AI Plan)
function _irRecoNow_() { try { return (new Date()).toISOString(); } catch (e) { return null; } }   // display stamp only (DTO identity excludes it)
function _irRecoFmtQty(n) { try { return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString() : '—'; } catch (e) { return String(n); } }
// The Recommended Action block appended UNDER the fixed 4-row summary table (never replaces it). Empty until AI
// Plan runs; hidden/stale-guarded when the stored gap is newer than the recommendation (never shown against a
// newer gap). READY → qty + based-on window + reason; NO_ACTION / BLOCKED → truthful state.
function _irRecoActionHtml(skuData) {
    if (!skuData || typeof window === 'undefined' || !window.KMREC) return '';
    var dto = _irRecoByKey[String(skuData.sku)];
    if (!dto) return '';
    var row = (_irMatState && _irMatState.bySku) ? _irMatState.bySku[String(skuData.sku)] : null;
    if (row && window.KMREC.isStale(dto, row)) return '<div class="replen-reco-action replen-reco-action--stale">⚠ Recommendation outdated — run AI Plan to refresh.</div>';
    if (dto.status === 'BLOCKED') return '<div class="replen-reco-action replen-reco-action--blocked"><div class="replen-reco-action__title">Recommended Action</div><div class="replen-reco-action__reason">Recommendation unavailable.</div></div>';
    if (dto.status === 'NO_ACTION') return '<div class="replen-reco-action replen-reco-action--none"><div class="replen-reco-action__title">Recommended Action</div><div class="replen-reco-action__reason">No action required.</div></div>';
    return '<div class="replen-reco-action replen-reco-action--ready">'
        + '<div class="replen-reco-action__title">Recommended Action</div>'
        + '<div class="replen-reco-action__row"><span class="replen-reco-action__label">Recommended Qty</span><strong class="replen-reco-action__qty">' + _irRecoFmtQty(dto.suggestedQty) + '</strong></div>'
        + '<div class="replen-reco-action__row"><span class="replen-reco-action__label">Based On</span><span class="replen-reco-action__win">' + escapeReplenHtml(dto.primaryWindow) + '</span></div>'
        + '<div class="replen-reco-action__reason">' + escapeReplenHtml(dto.reason) + '</div>'
        + '</div>';
}
// ============================================================================================================
// F1-7N-FC-1B-E3 §C/§D — WHY "Generate AI Plan" BEHAVED LIKE A DEAD BUTTON.
//
// MEASURED by driving the shipped chain (the menu item —> runReplenAiSupport('aiplan') —>
// _openReplenScopeModal —> the modal's Confirm —> handleReplenAiPlan), not by reading it. FIVE
// separate findings, and the feature flag is not among them:
//
//  1. the click DOES fire and the handler IS entered. Nothing in the chain is unwired, and no promise
//     rejection is swallowed on the flag-off path — there is no promise on it at all.
//  2. the scope modal calls close('confirm') BEFORE it calls back, so the button actually labelled
//     "Generate AI Plan" is already dismissed by the time any handler could put a spinner on it.
//  3. `#replen-ai-plan-btn` is NOT that button. It is the MENU ITEM "AI Plan", and runReplenAiSupport hides
//     the whole menu panel on its first line, so `btn.disabled = true` and `classList.add('is-loading')`
//     were being applied to an element inside `[hidden] { display: none }`. Reading `btn.disabled` as the
//     re-entry guard therefore guarded nothing either.
//  4. the trigger label IS visible and IS written (`_irAiSupportTriggerBusy_`), but every step of the
//     flag-off path is SYNCHRONOUS: busy was set and cleared inside one task, so the browser was never given
//     a frame in which to paint it. That is not a race to be tightened — there was no paint opportunity
//     at all.
//  5. and the one surface carrying the actual sentence — `#replen-ai-support-notice`, class
//     `replen-ai-plan-result` — HAD NO CSS RULE ANYWHERE IN THE REPOSITORY. The class was copied from
//     Order Planning's `.ro-ai-plan-result` (position:fixed; right:16px; bottom:16px; z-index:1200) and the
//     stylesheet was not copied with it. So it was appended as the last child of <body>, in normal flow,
//     below a full-viewport app shell, under `body { overflow: hidden }`: present in the DOM, not `hidden`,
//     and unreachable even by scrolling. `_irAiSupportNotice_` then RETURNED TRUE — it asserted a
//     visibility it never observed, which is why every caller believed it had spoken.
//
// So E2's EXECUTION_MATERIALIZATION_NOT_ENABLED sentence WAS written, correctly, into a box painted nowhere.
// The flag was never the reason nothing appeared: with the flag ON and the write failing, the failure would
// have been exactly as invisible. Finding 5 is fixed in the stylesheet; 1-4 are fixed below.
// ============================================================================================================
var IR_AI_PLAN_PHASES = {
    PREPARING: 'Preparing…',
    CALCULATING: 'Calculating routes…',
    SAVING: 'Saving execution plan…',
    RECONCILING: 'Reconciling — outcome unknown…'
};
// §D.6 — THE run guard. A module-level boolean, because the thing it used to be (a hidden menu
// item's `disabled` attribute, re-enabled synchronously in the same task) could not guard a second click and
// could not survive the menu being re-opened.
var _irAiPlanRunning = false;
function _irAiPlanIsRunning_() { return _irAiPlanRunning === true; }
// The seam that lets the busy state PAINT. Deferring is not a delay for its own sake: everything the run does
// is synchronous, so without a task boundary the states set at click time are cleared before any frame.
function _irAiPlanDefer_(fn) {
    if (typeof setTimeout === 'function') return setTimeout(fn, 0);
    return fn();
}
function _irEscNotice_(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
}
// §D.1/§D.2 — the trigger is the on-page proxy for the dismissed Generate button: it is the
// control the operator used to reach Generate, it never leaves the screen, and it is the only one that can
// still be disabled when the request is in flight. The spinner is a CSS pseudo-element keyed on aria-busy,
// because setting textContent would destroy any child element every time the phase changes.
function _irAiPlanTriggerBusy_(text) {
    var painted = _irAiSupportTriggerBusy_('aiplan', text);
    var t = _irAiSupportTriggerEl_();
    if (t) {
        t.disabled = true;
        t.setAttribute('aria-busy', 'true');   // the CSS spinner is keyed on THIS, so there is no second flag
    }
    return painted;
}
function _irAiPlanTriggerIdle_() {
    var t = _irAiSupportTriggerEl_();
    if (t) {
        t.disabled = false;
    }
    _irAiSupportTriggerIdle_('aiplan');
}
// §D.4 — the Execution Plan area is what the run is about to change, so it is what is marked busy.
function _irExecPlanAriaBusy_(on) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return 0;
    var lists = document.querySelectorAll('.exec-routes-list'), n = 0;
    for (var i = 0; i < lists.length; i++) {
        if (on) lists[i].setAttribute('aria-busy', 'true');
        else if (lists[i].removeAttribute) lists[i].removeAttribute('aria-busy');
        n++;
    }
    return n;
}
function _irExecListSku_(list) {
    var id = String((list && list.id) || '');
    var pre = 'shipping-methods-';
    return id.indexOf(pre) === 0 ? id.substring(pre.length) : '';
}
// §D.3/§D.7 — the status the operator keeps. The toast is transient and lives at the edge of the
// screen; this line sits inside the Execution Plan card, directly above the routes, so the outcome is still
// there after the modal has closed and after the toast is dismissed. It is created ONLY when it has something
// to say and REMOVED when cleared, so §A.2 holds: no empty container, no reserved blank height.
function _irExecPlanStatusSet_(text, tone) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return 0;
    var lists = document.querySelectorAll('.exec-routes-list'), n = 0;
    for (var i = 0; i < lists.length; i++) {
        var list = lists[i];
        var host = document.getElementById('exec-plan-status-' + _irExecListSku_(list));
        if (!text) {
            if (host && host.parentNode) host.parentNode.removeChild(host);
            continue;
        }
        if (!host) {
            host = document.createElement('div');
            host.id = 'exec-plan-status-' + _irExecListSku_(list);
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            if (list.parentNode && list.parentNode.insertBefore) list.parentNode.insertBefore(host, list);
            else continue;
        }
        host.className = 'ir-exec-plan__status ir-exec-plan__status--' + (tone || 'info');
        host.textContent = String(text);
        n++;
    }
    return n;
}
// §D.5 — one phase writer, three surfaces, no large overlay and no layout jump (the toast is
// position:fixed and the status line is a single text row inside a card that already has one).
function _irAiPlanPhase_(text) {
    var el = _irAiSupportNoticeEl_();
    if (el) {
        el.className = 'replen-ai-plan-result replen-ai-plan-result--info replen-ai-plan-result--busy';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-busy', 'true');
        el.innerHTML = '<div class="replen-ai-plan-result__head"><span>AI Plan</span></div>' +
            '<div class="replen-ai-plan-result__msg">' +
            '<span class="replen-ai-plan-result__spinner" aria-hidden="true"></span>' + _irEscNotice_(text) +
            '</div>';
        el.hidden = false;
    }
    _irAiPlanTriggerBusy_(text);
    // re-applied on every phase because renderReplenishment() rebuilds these containers mid-run
    _irExecPlanAriaBusy_(true);
    _irExecPlanStatusSet_(text, 'busy');
    return !!el;
}
// §D.5/§D.17 — THE ONLY WAY OUT. Success, typed refusal, transport error, timeout and unknown
// all leave through here, so "every terminal path clears the spinner" is a property of there being one exit
// rather than of five call sites remembering to. §D.9: the tone is the caller's, and only the branch that
// actually saw acknowledged rows passes 'ok'.
function _irAiPlanTerminal_(tone, message, execText) {
    _irAiPlanRunning = false;
    var el = _irAiSupportNoticeEl_();
    if (el && el.removeAttribute) el.removeAttribute('aria-busy');
    _irAiPlanTriggerIdle_();
    _irExecPlanAriaBusy_(false);
    var btn = (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('replen-ai-plan-btn') : null;
    if (btn) {
        if (btn.classList) {
            btn.classList.remove('is-loading');
            btn.classList.add(tone === 'ok' ? 'is-success' : (tone === 'bad' ? 'is-error' : 'is-success'));
        }
        btn.disabled = false;
    }
    _irAiSupportNotice_(tone, 'AI Plan', message);
    // §D.7/§D.10 — the outcome STAYS in the Execution Plan area, and an unknown outcome is a
    // sentence, never a cleared surface.
    _irExecPlanStatusSet_(execText || message, tone === 'bad' ? 'bad' : (tone === 'ok' ? 'ok' : 'warn'));
    return true;
}
// §H.3 — which SKUs hold a composer the operator has STARTED. Read from the DOM's own touched flag,
// which is the same fact the collector and the Submit preflight read.
function _irTouchedComposerSkus_() {
    var out = [];
    if (typeof document === 'undefined' || !document.querySelectorAll) return out;
    var lists = document.querySelectorAll('.exec-routes-list');
    for (var i = 0; i < lists.length; i++) {
        var rows = lists[i].querySelectorAll ? lists[i].querySelectorAll('.exec-route-composer') : [];
        for (var j = 0; j < rows.length; j++) {
            var t = rows[j].getAttribute ? rows[j].getAttribute('data-composer-touched') : '';
            if (String(t || '') === '1') { out.push(_irExecListSku_(lists[i]) || String(lists[i].id || '')); break; }
        }
    }
    return out;
}
// §H.4 — which SKUs hold a PERSISTED route the operator created themselves. Provenance is read from
// the row, where the render stamped it; a hydrated AI route carries AI_PLAN_EXPLICITLY_REQUESTED and is not a
// user edit, so regenerating over it needs no confirmation.
function _irPersistedManualRouteSkus_() {
    var out = [], seen = {};
    if (typeof document === 'undefined' || !document.querySelectorAll) return out;
    var lists = document.querySelectorAll('.exec-routes-list');
    var MANUAL = (window.IRRouteProvenance && window.IRRouteProvenance.SOURCES &&
        window.IRRouteProvenance.SOURCES.USER_EXPLICIT_ADD_ROUTE) || 'USER_EXPLICIT_ADD_ROUTE';
    for (var i = 0; i < lists.length; i++) {
        var sku = _irExecListSku_(lists[i]);
        var rows = lists[i].querySelectorAll ? lists[i].querySelectorAll('.exec-route-row') : [];
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            if (!r.getAttribute) continue;
            if (!String(r.getAttribute('data-line-id') || '')) continue;         // not persisted: nothing to lose
            if (String(r.getAttribute('data-route-provenance') || '') !== MANUAL) continue;
            if (!seen[sku]) { seen[sku] = 1; out.push(sku); }
            break;
        }
    }
    return out;
}
// §D.15 — a request that never answers is its own outcome. Note what this does NOT claim: a timeout
// after the POST left the browser is UNKNOWN, not failed, so it terminates as RECONCILING and the readback is
// what decides (§G.14).
function _irAiPlanWithTimeout_(p, ms) {
    if (typeof Promise === 'undefined') return p;
    return new Promise(function (resolve, reject) {
        var done = false;
        var timer = (typeof setTimeout === 'function') ? setTimeout(function () {
            if (done) return; done = true;
            reject({ __irAiPlanTimeout: true, ms: ms });
        }, ms) : null;
        Promise.resolve(p).then(function (v) {
            if (done) return; done = true;
            if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
            resolve(v);
        }, function (e) {
            if (done) return; done = true;
            if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
            reject(e);
        });
    });
}
window._irAiPlanPhase_ = _irAiPlanPhase_;
window._irAiPlanTerminal_ = _irAiPlanTerminal_;
window._irExecPlanStatusSet_ = _irExecPlanStatusSet_;
window._irAiPlanIsRunning_ = _irAiPlanIsRunning_;

function handleReplenAiPlan(scope) {
    // §D.6 — ONE guard, and not a hidden element's attribute (finding 3 above).
    if (_irAiPlanIsRunning_()) {
        _irAiSupportNotice_('info', 'AI Plan', 'An AI Plan run is already in progress. The click was ignored; nothing was started twice.');
        return false;
    }
    _irAiPlanRunning = true;
    var btn = document.getElementById('replen-ai-plan-btn');
    // F1-AI-SUPPORT-SCOPE-R1: capture the user-chosen { company, country, marketplace, marketplaceId } DTO when the
    // scope modal supplied one. HONEST BOUNDARY: the canonical page-level AI Plan generator (window.KMREC) is not
    // yet FM6-R4 scope-parameterized — it deterministically derives from the MATERIALIZED gap rows already loaded
    // for the on-screen scope. The DTO is threaded + retained (window._irAiPlanScope) so FM6-R4 can later route it
    // to the canonical persister → DB draft → Execution Plan; this round does NOT invent a scope-filtered engine.
    if (scope && typeof scope === 'object') { window._irAiPlanScope = scope; }
    // ---- §D.1-§D.5: EVERYTHING VISIBLE HAPPENS NOW, in the click's own event-loop turn -----------
    if (btn) { btn.disabled = true; btn.classList.remove('is-success', 'is-error'); btn.classList.add('is-loading'); }
    _irAiPlanPhase_(IR_AI_PLAN_PHASES.PREPARING);
    // ---- and the WORK happens in the NEXT one. This is finding 4: the recommendation regeneration and
    // renderReplenishment() are synchronous, so setting a busy state and clearing it around them left the
    // browser no frame in which to paint either one. The deferral is what makes the state above reachable.
    _irAiPlanDefer_(function () { _irAiPlanRun_(scope, btn); });
    return true;
}
window.handleReplenAiPlan = handleReplenAiPlan;

// The run itself, one task after the click. Every exit goes through _irAiPlanTerminal_.
function _irAiPlanRun_(scope, btn) {
    // ---- §H.3: A TOUCHED COMPOSER IS THE OPERATOR'S OWN TYPING ---------------------------------------
    // An AI Plan REPLACES the Execution Plan, so running it over a half-typed route would discard work the
    // operator can still see on screen. It is refused BY NAME before anything is calculated, rather than
    // resolved by silently clearing the row or by hoping the render happens to preserve it.
    var _touched = _irTouchedComposerSkus_();
    if (_touched.length) {
        return _irAiPlanTerminal_('warn',
            'AI Plan was NOT run. ' + _touched.length + ' SKU(s) have a route you have started and not finished (' +
            _touched.slice(0, 4).join(', ') + (_touched.length > 4 ? ', —' : '') + '). Nothing was calculated' +
            ' and NOTHING was written. Finish those rows or clear them with the X in the Action column, then run' +
            ' AI Plan again — an AI Plan replaces the Execution Plan, and it will not discard an edit you' +
            ' are in the middle of.',
            'AI Plan not run — an unfinished route is open here. Nothing was changed.');
    }
    _irAiPlanPhase_(IR_AI_PLAN_PHASES.CALCULATING);
    try {
        // Deterministic generation from the MATERIALIZED gap rows already loaded for the scope (no gap recalc, no API).
        if (window.KMREC && _irMatState && Array.isArray(_irMatState.rows)) {
            var now = _irRecoNow_();
            _irRecoByKey = {};
            _irMatState.rows.forEach(function (r) { var dto = window.KMREC.generateInventoryRecommendation(r, { now: now }); if (dto) _irRecoByKey[String(r.sku)] = dto; });
        }
        renderReplenishment();   // re-render surfaces the Recommended Action block (does NOT run Submit Plan)
    } catch (err) {
        console.error('[AI Plan] recommendation generation failed:', err);
        return _irAiPlanTerminal_('bad',
            'Recommendation generation failed: ' + String((err && err.message) || err) +
            '. NOTHING was written and your Execution Plan is unchanged.',
            'AI Plan failed — the recommendation could not be recalculated. Nothing was changed.');
    }
    // F1-7N-FA-3C-R6D1 — DB-BACKED GENERATION (staged behind a backend-owned flag; DEFAULT OFF). handleReplenAiPlan is the
    // MANUAL-CLICK path only (no background/resume caller), so a result popup here is inherently manual-only. When the flag
    // is ON and cloud write is eligible, this routes the manual click to the canonical 61_ weeklyAiPlan.generate writer,
    // then hydrates from the DB readback and reveals atomically. When OFF (this round's default) it keeps the page-state-
    // only behavior above (zero DB write) — deploying R6D1 changes NO live behavior until the USER enables the flag.
    var _nReco = Object.keys(_irRecoByKey || {}).length;
    if (_irInventoryAiPlanDbGenerationEnabled_() && _irAiPlanDbGenEligible_()) {
        // ---- §H.4: REGENERATING OVER THE OPERATOR'S OWN SAVED ROUTES IS CONFIRMED ------------------
        // The payload has always carried confirmRegenerateOverUserEdits and the page has never set it, so a
        // station holding a manual route would have been refused server-side with BLOCKED_CONFLICT that the
        // operator never saw (finding 5). The existing policy is used as it stands: ask, and pass the answer.
        var _edits = _irPersistedManualRouteSkus_();
        var _confirmOver = false;
        if (_edits.length) {
            try {
                _confirmOver = window.confirm('Regenerate the Execution Plan over your own saved routes?\n\n' +
                    _edits.length + ' SKU(s) hold a route you created and saved yourself (' +
                    _edits.slice(0, 6).join(', ') + (_edits.length > 6 ? ', —' : '') + ').\n\n' +
                    'AI Plan will supersede those routes with its own. The superseded drafts are expired and kept' +
                    ' for audit, never hard-deleted. Cancel to leave everything exactly as it is — cancelling' +
                    ' writes nothing at all.');
            } catch (e) { _confirmOver = false; }
            if (!_confirmOver) {
                return _irAiPlanTerminal_('info',
                    'AI Plan was cancelled at the confirmation. NOTHING was calculated on the server and NOTHING' +
                    ' was written — your saved routes are untouched.',
                    'AI Plan cancelled — your saved routes are untouched.');
            }
        }
        _irAiPlanPhase_(IR_AI_PLAN_PHASES.SAVING);
        return _irRunInventoryAiPlanGeneration_(btn, { confirmRegenerateOverUserEdits: _confirmOver === true });
    }
    // ============================================================================================================
    // F1-7N-FC-1B-E2 §I — SAY WHICH HALF RAN, AND WHY THE OTHER HALF DID NOT.
    //
    // THE REPORTED DEFECT: the operator opens AI Support, picks Amazon US, presses Generate AI Plan, and the
    // Execution Plan does not change and no allocation draft appears. Traced end to end, nothing is broken and
    // nothing is missing — the router action, the adapter, the 61_ writer and the KMWRR route allocator are
    // ALL present and complete. What stops it is a FEATURE FLAG:
    // INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ is false in 00_config.gs, mirrored to the client through
    // KM.api.inventoryAiPlanDbGenerationEnabled(), and its flip is USER-owned by that file's own record.
    //
    // So this round does not flip it (that is a production behaviour change and a live-verification gate); it
    // stops the message from IMPLYING that a plan was produced. The old text said recommendations were
    // regenerated and nothing was written — both true, and together they read to an operator who pressed
    // "Generate AI Plan" as "the plan ran and produced nothing". The two halves are now named separately, and
    // the reason execution materialization did not happen is stated instead of left as an empty screen.
    // ============================================================================================================
    // §E.2 — the flag is OFF (or the writer is unreachable). The recommendation half DID run; the
    // execution half did not, and the reason is named rather than left as an unchanged screen. This is now a
    // 'warn', not an 'info': "your plan was not written" is not neutral news to someone who pressed Generate.
    var _matReason = !_irAiPlanDbGenEligible_()
        ? 'EXECUTION_MATERIALIZATION_UNAVAILABLE'
        : 'EXECUTION_MATERIALIZATION_NOT_ENABLED';
    // ============================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §7 — THIS IS THE SENTENCE THE LIVE BUTTON PRODUCES, AND IT LED WITH A CODE.
    //
    // MEASURED, and it corrects an assumption the previous round made: R6 rewrote the notice on the
    // DB-GENERATION path, which is only reachable when the materialization flag is ON. The flag is OFF, so the
    // live click has never reached a line of it. THIS is the path a hundred-SKU run actually takes, and it was
    // still saying "RECOMMENDATIONS regenerated ... EXECUTION_MATERIALIZATION_NOT_ENABLED" — an outcome
    // announced by its internal reason code.
    //
    // What the run genuinely did: it refreshed the advice for every SKU in the scope and changed nothing. That
    // is a COMPLETE, SUCCESSFUL answer, and the wording now says so first and names the flag second.
    //
    // ONE COUNT, AND IT IS THE BATCH'S. A single SKU's suggested quantity is a per-SKU fact and belongs in that
    // SKU's expanded row, where the reconciliation strip states it beside what is currently planned. Putting it
    // in a batch notice would present one SKU's number as the hundred-SKU total, so no per-SKU quantity appears
    // here at all — not a smaller one, none.
    // ============================================================================================================
    var _needsMethod = 0;
    try {
        Object.keys(_irRecoByKey || {}).forEach(function (k) {
            var d = _irRecoByKey[k];
            if (d && Number(d.suggestedQty) > 0) _needsMethod++;
        });
    } catch (_eNm) { _needsMethod = 0; }
    return _irAiPlanTerminal_('warn',
        'AI recommendations refreshed for ' + _nReco + ' SKU(s). Advice generation COMPLETED — this is not a failure.' +
        ' Your current Execution Plans are UNCHANGED and nothing was written to the database' +
        (_matReason === 'EXECUTION_MATERIALIZATION_UNAVAILABLE'
            ? ': this deployment does not expose the AI Plan generation action, so no route could be written.'
            : ': automatic route materialization is behind a backend feature flag that this deployment reports as OFF.') +
        (_needsMethod ? ' ' + _needsMethod + ' SKU(s) have a suggested quantity and need a route with a shipping'
            + ' method chosen by hand.' : '') +
        ' Expand a SKU to see its recommended quantity, its source, and how it compares with what is already planned.',
        'AI recommendations refreshed for ' + _nReco + ' SKU(s) — Execution Plans unchanged, nothing written.');
}
window._irAiPlanRun_ = _irAiPlanRun_;
// R6D1 — the DB-generation feature flag (mirrors the backend owner-of-record via KM.api). Default OFF (fail-safe: if the
// capability is unavailable → OFF, page-state-only).
function _irInventoryAiPlanDbGenerationEnabled_() {
    try { if (window.KM && window.KM.api && typeof window.KM.api.inventoryAiPlanDbGenerationEnabled === 'function') return window.KM.api.inventoryAiPlanDbGenerationEnabled() === true; } catch (e) {}
    return false;
}
function _irAiPlanDbGenEligible_() {
    return !!(window.KM && window.KM.DB && typeof window.KM.DB.generateWeeklyAiPlanDraft === 'function' &&
        (typeof isOperationDbApiConfigured !== 'function' || isOperationDbApiConfigured()));
}
// R6D1 — classify the 61_ generation envelope truthfully (never conceal committed rows). status ∈ COMPLETED | PARTIAL |
// NO_DEMAND | BLOCKED_INPUT | FAILED; per-marketplace results carry draftId/draftVersion/lineCount/status/reason.
// ============================================================================================================
// F1-7N-FC-1B-E3-R1 §D — THE TYPED READINESS ANSWER, AND WHERE IT USED TO DIE.
//
// The server named its refusal and the browser transport carried it faithfully: _kmWeeklyCommand_ reads
// `json.errors[0].code` VERBATIM (that is what F1-7N-FB-4G-A2-R3-R1 fixed) and returns
// `{ success:false, data:null, error:{ code, message, details } }`.
//
// This classifier then read `res.errors` — PLURAL. The command result has no such field; it has `error`,
// singular. So `cls.errors` was always `[]`, `cls.status` fell through to the literal 'FAILED', and the
// operator was shown "AI Plan could not complete — FAILED." with an EMPTY Technical details panel, while
// the server had answered HARVEST_NOT_READY with a reason. Nothing was flattening the code; the page was
// reading a field that does not exist.
// ============================================================================================================
var IR_READINESS_SENTENCES = {
  SOURCE_DATA_AS_OF_MISSING: 'Source data timestamp is missing, so no ship date can be derived for the lane.',
  PLANNING_CYCLE_MISSING: 'Planning cycle could not be resolved.',
  REQUESTED_SCOPE_EMPTY: 'This scope produced no planning rows at all.',
  SKU_FACTS_MISSING: 'SKU facts are incomplete — no SKU in this scope has a complete set of canonical planning facts.',
  SUGGESTED_QTY_UNRESOLVED: 'The recommended quantity has no canonical basis — the forecast months it is derived from are incomplete.',
  FACTORY_SOURCE_UNRESOLVED: 'No eligible source pool could be resolved for this lane.',
  DESTINATION_UNRESOLVED: 'The destination could not be resolved to a canonical warehouse or marketplace.',
  CANONICAL_MAPPING_INCOMPLETE: 'The canonical facts could not be assembled from the harvest.'
};
// One issue → one sentence the operator can act on, plus the identity it applies to. The typed code is
// kept alongside the sentence rather than replaced by it: the sentence is for the operator and the code is what
// a report or a bug is filed against.
function _irReadinessSentence_(issue) {
    if (!issue) return '';
    var code = String(issue.code || '');
    var s = IR_READINESS_SENTENCES[code] || ('Canonical readiness refused: ' + (code || 'UNKNOWN') + '.');
    var sc = issue.affected_scope || {};
    var who = [sc.marketplace, sc.sku].filter(function (x) { return !!x; }).join(' / ');
    var where = [];
    if (issue.source_table) where.push(String(issue.source_table));
    if (issue.source_header) where.push(String(issue.source_header));
    return s +
        (who ? ' Affected: ' + who + '.' : '') +
        (issue.field ? ' Field: ' + issue.field + '.' : '') +
        (where.length ? ' Source: ' + where.join(' → ') + '.' : '') +
        ' [' + (code || '?') + (issue.engine_code && issue.engine_code !== code ? '/' + issue.engine_code : '') + ']';
}
window._irReadinessSentence_ = _irReadinessSentence_;

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — SAYING WHAT THE PLAN ADVISES, INSTEAD OF WHAT IT DID NOT WRITE.
//
// The reported behaviour: an operator opens AI Support, picks Amazon US, presses Generate AI Plan, and is told
// the AI Plan found NO ELIGIBLE ROUTE and that nothing in the current data supports a shipment here. What the
// server actually returned was a finished recommendation — 760 units, sourced entirely from the in-country 3PL,
// nothing needed from a factory — held back from an execution route only because no carrier_lead_times row
// covers the last leg and a person therefore picks the method.
//
// "Nothing supports a shipment" and "everything supports a shipment except one human decision" are opposite
// statements, and the page was making the first one. An operator who believes it does not ship.
//
// This builds the sentence for the middle case. Rules it follows, all from §4:
//   * it leads with what SUCCEEDED (the recommendation), not with what is missing;
//   * it names the quantity and the source warehouse, because a total with no source is not actionable;
//   * it states the factory allocation even at zero — an omitted zero reads as "we did not look";
//   * it says the Execution Plan was NOT changed, as a fact the server measured;
//   * it never uses the words failed, error, or database, and never asks for Carrier master data as a
//     precondition for a recommendation that has already been made.
// ================================================================================================================
function _irAiPlanAdviceSentence_(cls) {
    var a = cls && cls.advice;
    if (!a || a.recommendation_ready !== true) return null;
    var q = a.quantities || {};
    var n = function (v) { var x = Number(v); return isFinite(x) ? x : 0; };
    var parts = [];
    parts.push('AI recommendation completed. Suggested quantity ' + n(q.authorized) + ' unit(s)' +
        (n(q.unresolved_supply) === 0 ? ', fully sourced' : ', ' + n(q.unresolved_supply) + ' unit(s) not sourced') + '.');
    // The source split, by name. One warehouse is the common case and reads best as a sentence; several read
    // best as a list, and either way the FACTORY total is stated even when it is zero.
    var srcs = [], factoryQty = 0, sawFactoryField = false;
    (a.scopes || []).forEach(function (sc) {
        var ss = sc && sc.sources;
        if (!ss) return;
        sawFactoryField = true;
        factoryQty += n(ss.factory_quantity);
        (ss.by_warehouse || []).forEach(function (w) {
            srcs.push(n(w.quantity) + ' from ' + (w.warehouse_code ? w.warehouse_code + ' / ' : '') + w.warehouse_id);
        });
    });
    if (srcs.length) parts.push('Source: ' + srcs.join('; ') + '.');
    if (sawFactoryField) parts.push('Factory allocation ' + factoryQty + ' unit(s).');
    // What a person still has to do, named by CODE rather than guessed from wording.
    var codes = cls.adviceWarningCodes || [];
    var has = function (k) { return codes.indexOf(k) !== -1; };
    if (has('NO_TRANSIT_AUTHORITY_FOR_LANE') || has('ROUTE_METHOD_MANUAL_REVIEW_REQUIRED')) {
        parts.push('An automatic shipping method is not available for this lane, so the route needs a method' +
            ' chosen by hand. This does not affect the quantity or the source above.');
    }
    if (has('CARRIER_PRICING_DEFERRED') || has('MANUAL_CARRIER_SELECTION_REQUIRED')) {
        parts.push('Carrier selection and pricing are deferred to the Weekly Shipping Plan.');
    }
    if (a.execution_plan_changed === true) {
        parts.push('The Execution Plan below is the readback of what was stored.');
    } else {
        parts.push('The Execution Plan was NOT changed automatically and nothing on screen was discarded.');
    }
    return parts.join(' ');
}

function _irClassifyGenerationResult_(res) {
    var d = (res && res.data) || {};
    // §D.2 — read the SINGULAR `error` the command result actually carries, as well as the plural
  // `errors` a raw server envelope carries. Reading only one of the two is what silently discarded the code.
    // `errors` a raw server envelope carries. Reading only one of the two is what silently discarded the code.
    var _e1 = (res && res.error) ? res.error : null;
    var _errList = (res && Array.isArray(res.errors) && res.errors.length) ? res.errors : (_e1 ? [_e1] : []);
    var _det = (_e1 && _e1.details) || {};
    var _rd = (String(_det.stage || '') === 'READINESS') ? {
        reason: String(_det.readiness_reason || ''),
        issues: Array.isArray(_det.issues) ? _det.issues : [],
        warnings: Array.isArray(_det.warnings) ? _det.warnings : [],
        predicates: Array.isArray(_det.predicates) ? _det.predicates : [],
        harvest: _det.harvest || null, scope: _det.scope || null,
        planning_cycle: String(_det.planning_cycle || '')
    } : null;
    var status = String(d.status || (res && res.success ? 'COMPLETED' : 'FAILED'));
    var mkts = Array.isArray(d.marketplaceResults) ? d.marketplaceResults : [];
    var lineTotal = mkts.reduce(function (s, m) { return s + (Number(m && m.lineCount) || 0); }, 0);
    var draftIds = mkts.map(function (m) { return m && m.draftId; }).filter(Boolean);
    var blocked = mkts.filter(function (m) { return m && (m.status === 'BLOCKED_CONFLICT' || m.success === false); });
    var backendOk = !!(res && res.success) && (status === 'COMPLETED' || status === 'PARTIAL');
    // F1-7N-FB-4C §E/§G — a ZERO-RESULT run is a SUCCESSFUL run. "This cycle needs no shipping" is a real
    // answer, and the backend treats it as success precisely so it still replaces the previous proposal. The
    // classifier must agree, or the page would refuse to refresh after a run that did expire last week's plan.
    var zeroResult = (d.zero_result === true) || String(d.job_status || '') === 'NO_DEMAND';
    // F1-7N-FC-1B-E3-R4 §G — "NOTHING NEEDS REPLENISHING" AND "NOTHING COULD BE ROUTED" ARE NOT THE SAME
    // ANSWER, and collapsing them is how an operator ends up looking for a routing problem that does not exist.
    // The first means every site's canonical demand is zero: there is nothing to ship, and that is a complete,
    // correct result. The second means demand EXISTS and no route could be built for it, which is worth
    // investigating. The server names the first explicitly; the page keeps them apart.
    var noReplenishmentRequired = String(d.code || '') === 'NO_REPLENISHMENT_REQUIRED';
    return {
        ok: backendOk || (zeroResult && !!(res && res.success)), status: status,
        marketplaceCount: (d.marketplaceCount != null ? d.marketplaceCount : mkts.length),
        skuCount: (d.skuCount != null ? d.skuCount : null),
        lineTotal: lineTotal, draftIds: draftIds, blockedCount: blocked.length,
        marketplaceResults: mkts,
        // §G — the lifecycle projection, reported verbatim. These are the numbers that let an operator see that
        // the previous plan was replaced rather than merely that a new one appeared.
        generationRunId: d.generation_run_id || null,
        executionKey: d.execution_key || null,
        createdHeaders: Number(d.created_headers) || 0, updatedHeaders: Number(d.updated_headers) || 0,
        createdLines: Number(d.created_lines) || 0, updatedLines: Number(d.updated_lines) || 0,
        expiredHeaders: Number(d.expired_headers) || 0, expiredLines: Number(d.expired_lines) || 0,
        activeCount: Number(d.active_count) || 0, expiredCount: Number(d.expired_count) || 0,
        zeroResult: zeroResult,
        noReplenishmentRequired: noReplenishmentRequired,
        demandBasisTotal: (d.demand_basis_total == null) ? null : Number(d.demand_basis_total),
        canonicalDemandTotal: (d.canonical_demand_total == null) ? null : Number(d.canonical_demand_total),
        verification: d.verification || null,
        lifecycle: d.lifecycle || null,
        errors: _errList,
        // the server's own top-level code, so a refusal is reported by name and never as the literal 'FAILED'
        code: String((_e1 && _e1.code) || ''),
        readiness: _rd,
        // ==========================================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — THE THIRD OUTCOME. THERE WERE ONLY EVER TWO, AND THE TRUTH NEEDED THREE.
        //
        // This classifier could say `ok` or not `ok`. A run that computed a complete recommendation — the right
        // quantity, from the right warehouse, by the right date — and wrote no execution route because a person
        // still has to choose a shipping method is neither of those. It was landing on the `ok` path with a zero
        // line count, and the zero-line branch then told the operator that nothing in the current data supports a
        // shipment here. The server knew better the entire time; nothing in the response reached this function in
        // a form it could branch on.
        //
        // `adviceOutcome` is the server's own three-valued answer, read verbatim rather than re-derived. Deriving
        // it here would be a second opinion about a question the server has already answered, and the two would
        // eventually disagree — which is precisely the class of defect this round is closing.
        // ==========================================================================================================
        advice: (function () {
            var _a = (d.advice && typeof d.advice === 'object') ? d.advice : null;
            // R6-R2 §5 — the advice is also kept on the page, because the reconciliation strip needs to name
            // WHERE the recommended units would come from. Held as page state only; nothing reads it to decide.
            try { if (typeof window !== 'undefined') window._irLastAdvice = _a; } catch (eA) {}
            return _a;
        })(),
        adviceOutcome: (d.advice && d.advice.outcome) ? String(d.advice.outcome) : null,
        adviceReady: !!(d.advice && d.advice.recommendation_ready === true),
        adviceWarningCodes: (d.advice && Array.isArray(d.advice.warning_codes)) ? d.advice.warning_codes : [],
        executionPlanChanged: !!(d.advice && d.advice.execution_plan_changed === true),
        reason: zeroResult ? 'no allocation needed this cycle'
            : status === 'BLOCKED_INPUT' ? 'blocked (input)'
            : (blocked.length ? 'blocked/conflict on ' + blocked.length + ' marketplace(s)' : '')
    };
}
// R6D1 (Objective B/D/E) — run the manual DB generation, then hydrate from the DB readback + reveal atomically, then show
// a manual (dismissible) result popup. Fail-closed: a reported failure never conceals committed rows (the popup lists the
// per-marketplace draftIds/lineCounts the backend returned). NOTE: this path is gated OFF by default this round; the
// generated-line hydration field-mapping + line-id reconciliation are Stage-3 controlled-run prerequisites (see docs §40).
/**
 * F1-7N-FC-1B-E3-R4 §E.2 — WHAT THE SCREEN IS LOOKING AT, DECLARED SO THE SERVER CAN DISAGREE.
 *
 * This is deliberately NOT "send the quantity the operator saw and let the server use it". The DOM is not a
 * source of truth and this does not make it one: the server reads the canonical materialized row for itself
 * and allocates THAT. What this adds is an EXPECTATION, and its only power is to stop the run.
 *
 * The case it exists for is the quiet one. The operator searched, read Suggested Qty 520, and pressed AI Plan.
 * Between those two moments a re-materialization moved the row to 460. Without a declared expectation the plan
 * is built for 460 and looks entirely successful; the operator approves a plan for a number they never saw.
 * With it, the server refuses (EXPECTED_DEMAND_CONFLICT) and names both values, and neither side wins by
 * default — which is the whole point, because there is no way to tell from here which one is right.
 *
 * The values come from _irMatState, the SAME materialized rows the cells render, so what is declared is what
 * was on screen by construction rather than by a second read that could differ from both.
 */
function _irExpectedDemandFromSnapshot_() {
    try {
        if (typeof _irUseMaterializedGapRead !== 'function' || !_irUseMaterializedGapRead()) return null;
        if (!_irMatState || _irMatState.status !== 'READY' || !_irMatState.bySku) return null;
        var applied = (typeof _irSearch !== 'undefined' && _irSearch && _irSearch.applied) ? _irSearch.applied : null;
        var scope = (typeof _irAppliedSubmitScope_ === 'function') ? _irAppliedSubmitScope_() : null;
        var marketplace = (scope && scope.marketplace) || '';
        if (!applied || !marketplace) return null;
        var out = [];
        for (var sku in _irMatState.bySku) {
            if (!Object.prototype.hasOwnProperty.call(_irMatState.bySku, sku)) continue;
            var row = _irMatState.bySku[sku];
            // Only a READY row carries a declarable quantity. A BLOCKED or absent one has no expectation to
            // state, and inventing one would be exactly the fabrication this guards against.
            if (!row || String(row.calculation_status) !== 'READY') continue;
            var byWin = {};
            var d90 = _irMatNum(row.d90_suggested_qty);
            if (d90 === null) continue;
            byWin.D90 = d90;
            out.push({ marketplace: marketplace, sku: String(sku),
                calculation_status: String(row.calculation_status),
                calculation_date: String(row.calculation_date || ''),
                suggestedByWindow: byWin });
        }
        return out.length ? out : null;
    } catch (e) { return null; }
}
window._irExpectedDemandFromSnapshot_ = _irExpectedDemandFromSnapshot_;

function _irRunInventoryAiPlanGeneration_(btn, opts) {
    var ctx = _replenCtx();
    // §G.1/§G.13 — the scope is the modal's, threaded through _replenCtx (which the applied
    // filters own), so a REPEATED Generate for the same scope resolves to the same server execution key and
    // therefore UPDATES the same route ticket instead of minting a second one. The identity is the server's;
    // the client's contribution is not to vary the scope between runs.
    var payload = { company: ctx.company, country: ctx.country, mode: 'MANUAL_REGENERATE', currentMarketplace: ctx.marketplace, actor: 'inventory-replenishment',
        confirmRegenerateOverUserEdits: !!(opts && opts.confirmRegenerateOverUserEdits === true) };
    // §E.2 — identity + the lineage/quantity the screen is showing. Absent when there is no READY snapshot
    // to declare, which is not a failure: the server still reads its own canonical rows and still refuses if
    // they are missing. This only ever adds a way to STOP, never a way to proceed.
    // Guarded the way this page guards every other optional helper. The expectation is an ADDITIONAL way to
    // stop a run, never a prerequisite for one: if it cannot be built, the server still reads its own
    // canonical rows and still refuses on its own terms.
    var _expected = (typeof _irExpectedDemandFromSnapshot_ === 'function') ? _irExpectedDemandFromSnapshot_() : null;
    if (_expected) payload.expectedDemand = _expected;
    return _irAiPlanWithTimeout_(Promise.resolve(window.KM.DB.generateWeeklyAiPlanDraft(payload)), 60000).then(function (res) {
        var cls = _irClassifyGenerationResult_(res);
        // §G.8 — an AI Plan FAILURE must never clear the current Execution Plan. The only path that re-hydrates
        // is a SUCCESSFUL run (including a zero-result one, which legitimately empties the AI half); a failure
        // leaves every on-screen route exactly where it was and just reports why.
        if (cls.ok) {
            // Atomic hydration from the DB readback (E) — mirror the mount's hydrate-then-render sequence.
            // The readback excludes `expired` rows server-side, so §G.3 (never show an expired row) holds by
            // construction rather than by a client-side filter that could drift.
            // F1-7N-FB-4G-A0 §D.4 — refresh the source the hydrate ACTUALLY reads. In Workspace mode that is
            // the scoped read model (_irAfterWrite re-reads the workspace, which carries both draft tables);
            // in Legacy mode _irAfterWrite calls back immediately and the broad-cache refresh below still runs.
            return new Promise(function (resolve) {
                if (typeof _irEffectiveWorkspace === 'function' && _irEffectiveWorkspace()) {
                    _irAfterWrite(function () { resolve(null); });
                    return;
                }
                resolve(window.KM.DB.refreshCacheTables(['shipping_allocation_drafts', 'shipping_allocation_draft_lines']));
            })
                .then(function () {
                    // F1-7N-FC-1B-E1 §E.2 - the routes appearing here are the readback of a generation the
                    // operator explicitly requested and which SUCCEEDED (cls.ok). A failed or blocked run never
                    // reaches this branch, which is what §E.4 requires: no fallback route, and the routes
                    // already on screen are left exactly as they were.
                    try {
                        _hydrateAllocationDraftFromDb(_replenCtx(), {
                            provenance: (window.IRRouteProvenance && window.IRRouteProvenance.SOURCES.AI_PLAN_EXPLICITLY_REQUESTED) ||
                                'AI_PLAN_EXPLICITLY_REQUESTED'
                        });
                    } catch (e) {}
                    renderReplenishment();
                })
                .then(function () {
                    _irShowAiPlanResult_(cls);
                    // ---- §G.14 / §D.10: ACKNOWLEDGED, OR RECONCILING. NEVER "PROBABLY SAVED" -----
                    //
                    // Acknowledgement is decided from what the SERVER said, not from what is on screen: only
                    // EXPANDED SKUs render routes, so counting DOM rows would report an unacknowledged plan
                    // for a perfectly good one whose row happens to be collapsed. Three server facts have to
                    // agree — the line total equals created+updated, the readback verification did not
                    // fail, and the supersede lifecycle completed. If any disagrees the run does NOT report
                    // full success: it reports an UNKNOWN outcome, and Submit is blocked until a run does
                    // reconcile (§G.14 / the AI_PLAN_UNRECONCILED preflight code).
                    var rec = _irAiPlanReconcile_(cls);
                    if (!rec.ok) {
                        window._irAiPlanUnreconciled = { at: new Date().toISOString(), reason: rec.reason,
                            expected: rec.expected, acknowledged: rec.acknowledged };
                        _irAiPlanPhase_(IR_AI_PLAN_PHASES.RECONCILING);
                        return _irAiPlanTerminal_('warn',
                            'AI Plan ran and the OUTCOME IS UNKNOWN — ' + rec.reason + ' (server reported ' +
                            rec.expected + ' line(s), acknowledged ' + rec.acknowledged + ').' +
                            ' Rows may have been written. Nothing has been discarded and nothing is being guessed:' +
                            ' Submit Plan is BLOCKED until a run reconciles, so a half-written plan cannot be' +
                            ' submitted. Reload to re-read the stored plan, then run AI Plan again.',
                            'AI Plan outcome UNKNOWN — ' + rec.reason + '. Submit is blocked until this reconciles.');
                    }
                    window._irAiPlanUnreconciled = null;
                    if (cls.zeroResult || !cls.lineTotal) {
                        // F1-7N-FC-1B-E3-R4 §G — a scope with nothing to replenish is a NEUTRAL result, not a
                        // warning. No red, no amber, no Retry: the question was asked and the answer is none.
                        if (cls.noReplenishmentRequired) {
                            return _irAiPlanTerminal_('ok',
                                'No replenishment is required for this scope.' +
                                ' Every site in this company/country has a canonical demand of 0 for this cycle,' +
                                ' so 0 route(s) were written and nothing was changed in the database.' +
                                (cls.expiredHeaders ? ' ' + cls.expiredHeaders + ' superseded route(s) were expired (kept for audit).' : ''),
                                'No replenishment is required for this scope.');
                        }
                        // R6 §4 — ADVICE OUTRANKS "no route". A run that produced a recommendation and wrote
                        // no route because a person still has to choose a method is a SUCCESSFUL run with a
                        // decision outstanding, and it must be reported as one. The old wording below is
                        // reached only when the server has no recommendation to offer either — which is the
                        // case it was actually written for.
                        var _adv = _irAiPlanAdviceSentence_(cls);
                        if (_adv) {
                            return _irAiPlanTerminal_(
                                cls.adviceOutcome === 'SUCCESS_WITH_WARNINGS' ? 'warn' : 'ok',
                                _adv + ' Open + Add Route, or edit the route below, to choose the method.',
                                'AI recommendation ready — ' +
                                Number((cls.advice.quantities || {}).authorized || 0) +
                                ' unit(s). A shipping method still needs to be chosen.');
                        }
                        // §D.12 — a zero-result run is a real, successful answer and says so as one.
                        return _irAiPlanTerminal_('warn',
                            'AI Plan found NO ELIGIBLE ROUTE for this scope this cycle — 0 route(s) written.' +
                            (cls.expiredHeaders ? ' ' + cls.expiredHeaders + ' superseded route(s) were expired (kept for audit).' : '') +
                            ' This is an answer, not a failure: nothing in the current data supports a shipment here.' +
                            ' Use + Add Route if you intend to ship anyway.',
                            'AI Plan: no eligible route found. 0 route(s) written.');
                    }
                    return _irAiPlanTerminal_('ok',
                        'AI Plan saved ' + cls.lineTotal + ' route(s) — ' + rec.units + ' unit(s) across ' +
                        (cls.marketplaceCount || 0) + ' marketplace(s). ' + cls.createdHeaders + ' ticket(s) created, ' +
                        cls.updatedHeaders + ' updated' +
                        (cls.expiredHeaders ? ', ' + cls.expiredHeaders + ' superseded and expired (kept for audit)' : '') +
                        '. The Execution Plan below is the readback of what was stored.',
                        'AI Plan saved ' + cls.lineTotal + ' route(s) — ' + rec.units + ' unit(s).');
                });
        }
        _irShowAiPlanResult_(cls);   // truthful blocked/no-demand/failed — never conceals committed draftIds
        // ==========================================================================================================
        // F1-7N-FC-1B-E3-R4-A2-R1-R6 §4 — THIS IS THE BRANCH THE LIVE RUN ACTUALLY TOOK, AND IT SHOWED RED.
        //
        // Measured, not assumed. On the ResUS scope the server returns success:false with job_status ALL_BLOCKED,
        // because `runSucceeded` means "something committed" and nothing did. So the run never reached the
        // zero-result wording at all — it fell all the way through to the generic failure at the bottom of this
        // function and told an operator "AI Plan could not complete — ALL_BLOCKED", in the error tone, about a
        // run that had just produced a complete and correct recommendation for 760 units.
        //
        // The server's `success` flag is LEFT ALONE. It answers "did anything commit", which is the question the
        // lifecycle depends on: flipping it to true would expire last week's superseded drafts on a run that
        // wrote nothing, leaving the operator with no active plan at all. That flag is right; the page's reading
        // of it was too coarse.
        //
        // So the advice is consulted HERE, before the failure wording, and only when there is nothing else to
        // report: no readiness refusal, no per-marketplace conflict, no server error. Any of those is a real
        // finding an operator must see, and none of them is silenced by a recommendation being available.
        // Nothing is re-hydrated on this path and nothing on screen is touched — which is already correct, and
        // is exactly what the message now says out loud.
        // ==========================================================================================================
        if (!cls.readiness && !cls.blockedCount && !(cls.errors && cls.errors.length)) {
            var _advBlocked = _irAiPlanAdviceSentence_(cls);
            if (_advBlocked) {
                return _irAiPlanTerminal_(
                    cls.adviceOutcome === 'SUCCESS_WITH_WARNINGS' ? 'warn' : 'ok',
                    _advBlocked + ' Open + Add Route, or edit the route below, to choose the method.',
                    'AI recommendation ready — ' +
                    Number((cls.advice.quantities || {}).authorized || 0) +
                    ' unit(s). A shipping method still needs to be chosen.');
            }
        }
        // F1-7N-FC-1B-E3-R1 §D.3 — A READINESS REFUSAL IS NOT A GENERIC FAILURE.
        //
        // "AI Plan could not complete — FAILED" tells an operator nothing they can act on. When the server
        // refused on canonical readiness it now says WHICH field, in WHICH table, for WHICH scope, and the page
        // says it in a sentence. Zero writes either way, and the spinner leaves through the same one exit.
        if (cls.readiness) {
            var _rdB = cls.readiness.issues.filter(function (i) { return i && i.blocking !== false; });
            var _rdShow = (_rdB.length ? _rdB : cls.readiness.issues).slice(0, 3);
            var _rdWarn = cls.readiness.warnings.map(function (i) { return _irReadinessSentence_(i); });
            var _hv = cls.readiness.harvest || {};
            return _irAiPlanTerminal_('bad',
                'AI Plan did NOT run: the canonical facts for this scope are not ready, so NOTHING was' +
                ' calculated and NOTHING was written. ' +
                _rdShow.map(function (i) { return _irReadinessSentence_(i); }).join(' ') +
                (_rdB.length > 3 ? ' (+' + (_rdB.length - 3) + ' more)' : '') +
                (_hv.site_count != null ? ' Harvest saw ' + _hv.site_count + ' site(s) and produced ' +
                    (_hv.receiver_count == null ? '?' : _hv.receiver_count) + ' receiver(s).' : '') +
                (_rdWarn.length ? ' Also noted (not blocking): ' + _rdWarn.join(' ') : '') +
                ' Your current Execution Plan is UNCHANGED.',
                'AI Plan not run — ' + (_rdShow.length ? _irReadinessSentence_(_rdShow[0]) : 'canonical facts not ready') +
                ' Nothing was written.');
        }
        // §H.4/§H.5 — a BLOCKED_CONFLICT is reported by name and the routes on screen are left
        // exactly as they are. §H.6: a refused run leaves no half-built route, because it never rendered one.
        return _irAiPlanTerminal_('bad',
            'AI Plan could not complete — ' + (cls.code || cls.status || 'FAILED') + (cls.reason ? ' (' + cls.reason + ')' : '') +
            (cls.blockedCount ? '. ' + cls.blockedCount + ' marketplace(s) were BLOCKED_CONFLICT: a saved route' +
                ' there was not superseded, so nothing was overwritten' : '') +
            '. Your current Execution Plan is UNCHANGED' +
            (cls.draftIds && cls.draftIds.length ? ' apart from ticket(s) the server did report writing: ' +
                cls.draftIds.join(', ') + ' — open Technical details' : '') + '.',
            'AI Plan could not complete — ' + (cls.code || cls.status || 'FAILED') + '. Nothing on screen was changed.');
    }).catch(function (err) {
        // §D.13 — a rejection is NOT swallowed. §D.15: a timeout is UNKNOWN, not failed, because
        // the request had already left the browser; it terminates as RECONCILING and blocks Submit.
        if (err && err.__irAiPlanTimeout) {
            window._irAiPlanUnreconciled = { at: new Date().toISOString(), reason: 'REQUEST_TIMED_OUT', expected: '?', acknowledged: 0 };
            _irShowAiPlanResult_({ ok: false, status: 'TIMEOUT', marketplaceResults: [], draftIds: [], lineTotal: 0,
                errors: [{ message: 'no response within ' + Math.round((err.ms || 0) / 1000) + 's' }], reason: 'request timed out' });
            return _irAiPlanTerminal_('warn',
                'AI Plan TIMED OUT after ' + Math.round((err.ms || 0) / 1000) + 's with no answer. The request had' +
                ' already been sent, so whether anything was written is UNKNOWN — this is not being reported as' +
                ' a failure. Submit Plan is BLOCKED until a run reconciles. Reload to re-read the stored plan.',
                'AI Plan timed out — outcome unknown. Submit is blocked until this reconciles.');
        }
        _irShowAiPlanResult_({ ok: false, status: 'FAILED', marketplaceResults: [], draftIds: [], lineTotal: 0, errors: [{ message: String(err && err.message || err) }], reason: 'request failed' });
        return _irAiPlanTerminal_('bad',
            'AI Plan request FAILED before any answer: ' + String((err && err.message) || err) +
            '. Your current Execution Plan is unchanged.',
            'AI Plan request failed. Nothing on screen was changed.');
    });
}
// §G.14 — acknowledgement, from server facts only. `units` is reported alongside so the success
// message can state a quantity the server actually confirmed rather than one read back off the screen.
function _irAiPlanReconcile_(cls) {
    var expected = Number(cls && cls.lineTotal) || 0;
    var ack = (Number(cls && cls.createdLines) || 0) + (Number(cls && cls.updatedLines) || 0);
    var units = 0;
    try {
        (cls.marketplaceResults || []).forEach(function (m) { units += Number(m && (m.totalQty || m.total_qty)) || 0; });
    } catch (e) {}
    if (cls && cls.lifecycle && cls.lifecycle.ok === false) {
        return { ok: false, reason: 'SUPERSEDED_DRAFTS_NOT_EXPIRED', expected: expected, acknowledged: ack, units: units };
    }
    if (cls && cls.verification && cls.verification.ok === false) {
        return { ok: false, reason: 'READBACK_VERIFICATION_FAILED', expected: expected, acknowledged: ack, units: units };
    }
    if (expected !== ack) {
        return { ok: false, reason: 'LINE_COUNT_NOT_ACKNOWLEDGED', expected: expected, acknowledged: ack, units: units };
    }
    return { ok: true, reason: '', expected: expected, acknowledged: ack, units: units };
}
window._irAiPlanReconcile_ = _irAiPlanReconcile_;
// R6D1 — MANUAL-ONLY dismissible result popup (business-readable + a collapsed Technical-details disclosure; no raw tokens
// in the headline). Reuses the R6E structured-disclosure template. Background/resume never call this (manual-click only).
function _irShowAiPlanResult_(cls) {
    if (typeof document === 'undefined') return;
    var esc = (typeof escapeReplenHtml === 'function') ? escapeReplenHtml : function (v) { return String(v == null ? '' : v); };
    // §G — say what was REPLACED, not only what was created. A run that quietly expired eight superseded routes
    // and created three new ones is a very different event from one that created three, and the operator has to
    // be able to tell them apart without opening the database.
    var replaced = cls.expiredHeaders
        ? (' Replaced ' + cls.expiredHeaders + ' superseded route(s) (now expired, kept for audit).')
        : '';
    var headline = cls.ok
        ? (cls.zeroResult
            ? ('AI Plan: no recommendation for this scope this cycle.' + replaced)
            : ('AI Plan generated — ' + (cls.marketplaceCount || 0) + ' marketplace(s), ' + (cls.lineTotal || 0) + ' line(s).' + replaced))
        : (cls.status === 'BLOCKED_INPUT' ? 'AI Plan blocked — input not ready. Your current Execution Plan is unchanged.'
            : ('AI Plan could not complete' + (cls.reason ? ' — ' + esc(cls.reason) : '') + '. Your current Execution Plan is unchanged.'));
    var rows = '<div><strong>Status:</strong> ' + esc(cls.status || '') + '</div>';
    if (cls.generationRunId) rows += '<div><strong>Run:</strong> ' + esc(cls.generationRunId) + '</div>';
    rows += '<div><strong>Headers:</strong> ' + cls.createdHeaders + ' created · ' + cls.updatedHeaders + ' updated · ' + cls.expiredHeaders + ' expired</div>';
    rows += '<div><strong>Lines:</strong> ' + cls.createdLines + ' created · ' + cls.updatedLines + ' updated · ' + cls.expiredLines + ' expired</div>';
    if (cls.lifecycle && cls.lifecycle.ok === false) {
        rows += '<div style="color:#B91C1C;"><strong>Lifecycle:</strong> superseded drafts were NOT fully expired (' +
            esc(cls.lifecycle.reason || 'unknown') + '). The previous plan may still be active — do not submit until this is resolved.</div>';
    }
    (cls.marketplaceResults || []).forEach(function (m) {
        rows += '<div><strong>' + esc(m && m.marketplace) + ':</strong> ' + esc(m && m.status) + ' — ' + (Number(m && m.lineCount) || 0) + ' line(s)' + ((m && m.draftId) ? ' · draft ' + esc(m.draftId) : '') + ((m && m.reason) ? ' · ' + esc(m.reason) : '') + '</div>';
    });
    (cls.errors || []).forEach(function (e) { rows += '<div><strong>Error:</strong> ' + esc(e && (e.code ? (e.code + ' — ' + (e.message || '')) : (e.message || e))) + '</div>'; });
  // F1-7N-FC-1B-E3-R1 — the typed readiness detail, verbatim: code, engine code, field, and the table and
  // header it points at. This is the audit surface; the operator's sentence is in the notice.
  if (cls.readiness) {
    if (cls.readiness.reason) rows += '<div><strong>Readiness:</strong> ' + esc(cls.readiness.reason) + '</div>';
    (cls.readiness.issues || []).concat(cls.readiness.warnings || []).forEach(function (i) {
      rows += '<div><strong>' + esc(i && i.code) + '</strong>' + (i && i.blocking === false ? ' (not blocking)' : '') +
        ': ' + esc((i && i.field) || '') + ' — ' + esc((i && i.actual) || '') +
        ((i && i.source_table) ? ' &middot; ' + esc(i.source_table) : '') +
        ((i && i.source_header) ? ' [' + esc(i.source_header) + ']' : '') + '</div>';
    });
    (cls.readiness.predicates || []).filter(function (p) { return p && p.required && !p.passed; }).forEach(function (p) {
      rows += '<div><strong>Predicate FAILED:</strong> ' + esc(p.name) + ' — ' + esc(p.detail) + '</div>';
    });
  }
    var host = document.getElementById('replen-ai-plan-result');
    if (!host) {
        host = document.createElement('div'); host.id = 'replen-ai-plan-result'; host.className = 'replen-ai-plan-result';
        host.setAttribute('role', 'status'); host.style.cssText = 'position:fixed;right:16px;bottom:16px;max-width:420px;z-index:9999;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:12px 14px;font-size:13px;';
        (document.body || document.documentElement).appendChild(host);
    }
    host.innerHTML = '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">' +
        '<div class="replen-ai-plan-result__msg">' + esc(headline) + '</div>' +
        '<button type="button" class="replen-ai-plan-result__close" aria-label="Dismiss" onclick="var h=document.getElementById(\'replen-ai-plan-result\'); if(h&&h.remove)h.remove();" style="border:none;background:none;cursor:pointer;font-size:16px;line-height:1;">×</button></div>' +
        '<details class="replen-ai-plan-result__detail" style="margin-top:6px;"><summary>Technical details</summary>' + rows + '</details>';
    host.style.borderColor = cls.ok ? '#16a34a' : '#dc2626';
}

// ========================================
// Cloud mapping (Demo OFF): Inventory Table Phase 1 mapping via IRMap
// ========================================
function _getCloudReplenishmentData() {
    var DB = (window.KM && window.KM.DB) ? window.KM.DB : null;
    var IR = window.IRMap;
    // IDENTITY: the Marketplace dropdown value is the marketplace_id (no Company select). Company +
    // country + marketplace are DERIVED from the marketplaces master for that marketplace_id below.
    // F1-7N-FB-2A §B — read the APPLIED search filters, never the live selectors. This is what makes Search
    // ATOMIC: changing Country/Marketplace cannot alter the rendered result set, only mark it stale. The LTS
    // filter stays LIVE inside _irRenderScope_ because it is a client-side filter over this same result set.
    var _irScope = _irRenderScope_();
    var marketplaceId = _irScope.marketplaceId;
    var country = _irScope.country;
    var ltsFilter = _irScope.ltsFilter;
    if (!marketplaceId || !DB || !DB.getMarketplaceSkus || !IR) return [];

    function eqv(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
    // F1-7I: single choke point — Workspace mode reads the scoped read-model (keyed by getter name); Legacy reads the
    // broad-cache getter unchanged. The whole main-table assembly below therefore needs NO broad Operation DB in Workspace mode.
    function get(name) { if (_irReadModel) return _irReadModel[name] || []; return (DB[name]) ? (DB[name]() || []) : []; }

    // Source tables — all safe [] when not yet exposed to the frontend.
    var marketplacesReg = get('getMarketplaces');
    // Resolve the selected marketplace_id to its marketplaces master record; company + country +
    // marketplace all come from THIS record (the SSOT). No Company select, no first-row fallback.
    var scopeMkt = marketplacesReg.find(function (m) { return String(m.marketplaceId) === String(marketplaceId); });
    if (!scopeMkt) return [];
    var company = scopeMkt.company;
    var marketplace = scopeMkt.marketplace;
    var mktCountry = scopeMkt.country;

    var mpSkus = get('getMarketplaceSkus');
    // STRICT SCOPE: identity-first on marketplace_id (which already encodes company+country+marketplace,
    // so KM/US/Amazon and ResUS/US/Amazon never merge — the company bleed is impossible). Legacy rows
    // without a marketplace_id fall back to the master's derived company+country+marketplace.
    var filtered = mpSkus.filter(function (mp) {
        if (mp.marketplaceId) return String(mp.marketplaceId) === String(marketplaceId);
        return eqv(mp.company, company) && eqv(mp.country, mktCountry) && eqv(mp.marketplace, marketplace);
    });
    if (filtered.length === 0) return [];

    var invSnaps = get('getAmazonInventorySnapshot');
    var healthSnaps = get('getAmazonInventoryHealthSnapshot');
    var dailyRows = get('getAmazonDailySalesSnapshot');
    var weeklyRows = get('getAmazonWeeklySalesSnapshot');
    var fcRows = get('getFcRegularForecast');
    var targetRules = get('getFcTargetRules');
    var events = get('getFcSpecialEvents');
    var overseas = get('getOverseasInventorySnapshot');
    var warehouses = get('getWarehouses');
    var factory = get('getFactoryStock');
    var skuDetails = get('getSkuDetails');

    // F1-SHIPMENT-INCOMING-R5 — Shipping Shipment card now derives from REAL shipment authority (NOT the
    // mock/dead within* block, NOT wh_on_the_way_*). Build the receiver→remaining-incoming-by-ETA map ONCE
    // for this marketplace scope. REMAINING = MAX(0, shipment_qty − shipment_received_qty); terminal
    // shipments + fully-received lines contribute 0; MULTI/merged shipments are excluded from per-marketplace
    // attribution (MERGED_SHIPMENT_FROZEN_SHARE_AUTHORITY_GAP — see completion report).
    var shipments = get('getShipments');
    var shipmentLines = get('getShipmentLines');
    // R6 — FROZEN receiver lineage map: shipping_plan_line_id → {company,country,marketplace} resolved via
    // shipping_plan_lines → shipping_plans. Lets a merged (MULTI) shipment's lines attribute to their real
    // receivers deterministically (dispatch-time lineage; NOT live FC Share, NOT destination text).
    var planLinesReg = get('getShippingPlanLines');
    var plansReg = get('getShippingPlans');
    var _planById = {}; plansReg.forEach(function (p) { if (p && p.shippingPlanId) _planById[p.shippingPlanId] = p; });
    var lineReceiverById = {};
    planLinesReg.forEach(function (pl) {
        if (!pl || !pl.shippingPlanLineId) return;
        var p = _planById[pl.shippingPlanId] || {};
        lineReceiverById[pl.shippingPlanLineId] = { company: p.company || '', country: p.country || '', marketplace: p.marketplace || '' };
    });
    var _irNow = new Date();
    var _irTodayMs = Date.UTC(_irNow.getFullYear(), _irNow.getMonth(), _irNow.getDate());
    var shipRemainByReceiver = _irBuildShipmentRemainingByReceiver(shipments, shipmentLines, _irTodayMs, lineReceiverById);

    // F1-7N-FB-4E-R4B-R1 - the factory projection's window anchor is INJECTED (the module never reads a clock),
    // and the whole-SKU projection is computed ONCE per SKU rather than once per marketplace row.
    var _irFactoryCalcMonth = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); })();
    var _irFactoryAllocCache = {};
    function _irFactoryAllocFor_(sku, siteScope, factoryRows, whRows, siteRows, fcRowsIn) {
        var k = String(sku == null ? '' : sku).toUpperCase();
        if (!Object.prototype.hasOwnProperty.call(_irFactoryAllocCache, k)) {
            _irFactoryAllocCache[k] = IR.factorySiteAllocation({
                scope: siteScope, factoryRows: factoryRows, warehouses: whRows, mpSkus: siteRows,
                fcRows: fcRowsIn, calculationMonth: _irFactoryCalcMonth
            });
        }
        var proj = _irFactoryAllocCache[k].projection;
        if (!proj) return _irFactoryAllocCache[k];
        // The projection is per-SKU; the SITE slice is per row, so it is read fresh for this scope.
        var K = (typeof window !== 'undefined' && window.KM && window.KM.factorySiteAllocation) || null;
        if (!K) return _irFactoryAllocCache[k];
        var mine = K.siteFactoryAvailability(proj, siteScope);
        return { cn: mine.cn, tw: mine.tw, state: _irFactoryAllocCache[k].state, projection: proj };
    }

    var monthNames = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
    var MK = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    var cm = new Date().getMonth();

    var rows = filtered.map(function (mp) {
        var det = skuDetails.find(function (d) { return eqv(d.sku, mp.sku); }) || {};
        // The marketplaces master (scopeMkt) is authoritative for this marketplace_id. If a
        // marketplace_skus row carries a denormalized company/country/marketplace that DISAGREES with
        // the master, prefer the master and warn (mapping-integrity note) — never silently take the row.
        var scopeMktReg = scopeMkt;
        if (mp.marketplaceId && (
                (mp.company && !eqv(mp.company, scopeMkt.company)) ||
                (mp.country && !eqv(mp.country, scopeMkt.country)) ||
                (mp.marketplace && !eqv(mp.marketplace, scopeMkt.marketplace)))) {
            console.warn('[Replenishment] marketplace_skus scope disagrees with marketplaces master for marketplace_id ' +
                marketplaceId + ' (sku ' + mp.sku + '); using master.',
                { row: { company: mp.company, country: mp.country, marketplace: mp.marketplace },
                  master: { company: scopeMkt.company, country: scopeMkt.country, marketplace: scopeMkt.marketplace } });
        }
        var scope = {
            company: scopeMkt.company, country: scopeMkt.country, marketplace: scopeMkt.marketplace, sku: mp.sku,
            marketplaceId: marketplaceId,
            series: det.series || '', category: det.category || det.productLine || ''
        };
        // R5 — real Shipping Shipment buckets for THIS receiver (canonical company/country/marketplace/sku).
        var shipRem = shipRemainByReceiver[_irReceiverKey(scopeMkt.company, scopeMkt.country, scopeMkt.marketplace, mp.sku)]
            || { overdue: 0, d0_18: 0, d19_30: 0, d31_45: 0, d45_plus: 0 };

        var inv = IR.latestSnapshot(invSnaps, scope);
        var health = IR.latestSnapshot(healthSnaps, scope);
        var stock = IR.stockCard(inv);
        var lts = IR.longTermStorage(health);
        var trend = IR.salesTrend7d(dailyRows, scope);
        var avg = IR.avgSalesPerDay(weeklyRows, scope);
        var fc60 = IR.forecast60d(fcRows, targetRules, scope, events);   // R7 §F: 3-month Base FC + scoped Special Events (once)
        var eventQty = IR.upcomingEventQty(events, scope);
        // 3rd Party Stock = Site Planning Available (18-day virtual planning allocation of the shared
        // 3PL pool; §20/§23/§24). Display-only — no movement, no reserve, no snapshot write.
        var thirdPartyPlan = IR.sitePlanningAllocation({
          scope: scope, overseasRows: overseas, warehouses: warehouses, mpSkus: mpSkus,
          marketplacesReg: marketplacesReg, weeklyRows: weeklyRows, fcRows: fcRows, targetRules: targetRules
        });
        // Recommendation Summary snapshot: hydrate the read-only system recommendation from the persisted
        // shipping_allocation_draft (the SSOT, §11.4) when one exists for this scope + SKU; otherwise the
        // Recommendation Summary renders its honest "not generated" empty state (engine is inactive).
        var recDraftLines = _shippingDraftLinesFor(scope, get('getShippingAllocationDrafts'), get('getShippingAllocationDraftLines'));
        // 3rd Party Stock card = PHYSICAL 3PL availability (Round 4 Decision A). Summary total and the
        // expanded detail use the SAME shared breakdown rows (IRWarehouse.buildPhysicalThirdPartyBreakdown);
        // it is NEVER sitePlanningAvailable (the 18-day virtual planning allocation stays in the planning
        // path only). Empty → state label (No 3PL / No Data), never a fallback to the virtual value.
        var _tpBreakdown = (window.IRWarehouse && window.IRWarehouse.buildPhysicalThirdPartyBreakdown)
          ? window.IRWarehouse.buildPhysicalThirdPartyBreakdown(thirdPartyPlan)
          : { total: 0, hasRows: false, rows: (thirdPartyPlan.contributions || []) };
        var thirdPartyDisplay = (thirdPartyPlan.state === 'NO_ELIGIBLE_3PL') ? 'No 3PL'
          : (thirdPartyPlan.state === 'MISSING_SNAPSHOT') ? 'No Data'
          : (thirdPartyPlan.state === 'OK' || _tpBreakdown.hasRows) ? String(Math.round(_tpBreakdown.total).toLocaleString())
          : '—';
        // F1-7N-FB-4E-R4B-R1 §1 - THIS SITE's share of each physical factory pool, from the ONE canonical
        // projection Order Planning also reads. Previously both lines were the COMPLETE physical quantity, which
        // is why every marketplace scope showed the same full factory number. Memoized per SKU: the projection
        // is a whole-SKU calculation and the row map would otherwise repeat it once per marketplace.
        var _fa = _irFactoryAllocFor_(mp.sku, scope, factory, warehouses, mpSkus, fcRows);
        var cnStock = _fa.cn;
        var twStock = _fa.tw;
        var need = IR.needBuckets();

        var currentStock = stock.available + stock.fcTransfer + stock.fcProcessing;
        var dos = IR.daysOfSupply(currentStock, avg);
        // F1-4B-FM5-R4J-LIVE9 — align the Sales-Driven Avg Sales/day + Days of Supply to the CANONICAL horizon
        // sales-rate (horizonBasis.avgSalesPerDay = the SAME KMCALC normalized rate D18/D30/D45/D90 uses), closing
        // SALES_DOS_HORIZON_AUTHORITY_DIVERGENCE. The value is CARRIED from the workspace read (never recomputed on
        // the page — reuses IR.daysOfSupply, adds NO calculator). Forecast-Driven and the weekly Sales Trend chart
        // are untouched. A Sales-Driven SKU whose canonical rate is unavailable shows '--' (never a silent weekly
        // fallback); rate 0 → IR.daysOfSupply returns null → '--' (safe no-demand). When no canonical basis is
        // resolved (e.g. workspace read off), the existing weekly display is preserved (no regression).
        var _avgDisplay = avg.toFixed(1);
        var _dosDisplay = (dos === null ? '--' : String(dos));
        var _canonBasis = (typeof _irCanonicalSalesBasis_ === 'function') ? _irCanonicalSalesBasis_(mp.sku) : null;
        if (_canonBasis && _canonBasis.demandMode === 'sales_driven') {
          var _cr = _canonBasis.avgSalesPerDay;
          if (_cr == null) { _avgDisplay = '--'; _dosDisplay = '--'; }
          else {
            _avgDisplay = (Math.round(_cr * 10) / 10).toFixed(1);
            var _cdos = IR.daysOfSupply(currentStock, _cr);
            _dosDisplay = (_cdos === null ? '--' : String(_cdos));
          }
        }

        // Forecast breakdown (next 3 months, Target Rule applied)
        var fcRow = fcRows.find(function (r) {
            return eqv(r.sku, mp.sku) && (!r.company || eqv(r.company, mp.company)) &&
                (!r.country || eqv(r.country, mp.country)) && (!r.marketplace || eqv(r.marketplace, mp.marketplace));
        });
        var pct = IR.targetPct(targetRules, scope) / 100;
        function fcMonth(off) { return fcRow ? Math.round((parseFloat(fcRow[MK[(cm + off) % 12]]) || 0) * pct) : 0; }

        // Fulfillment model resolution — reuse the company-safe registry match resolved above.
        var ff = IR.resolveFulfillment(scopeMktReg, mp);

        // Upcoming event display: dynamic, date-eligible (today .. first day of month(today+4mo)),
        // scope-matched, active. Shows the nearest event (name + start/end + fc_qty), then "+N more"
        // in an expandable list. Multiple events are NOT merged — each record stays separate.
        var evRows = IR.upcomingEvents(events, scope);
        var upcomingEventsText = _irRenderUpcoming(evRows);

        return {
            sku: mp.sku,
            siteSku: mp.siteSku || '',   // F1-4B-B canonical row identity (with sku + destination) for API line matching
            lifecycle: det.lifecycle || '--',
            replenishmentModel: mp.replenishmentModel || 'sales_driven',
            company: scope.company || '--',       // derived from the marketplaces master (marketplace_id)
            country: scope.country,
            marketplace: scope.marketplace,
            marketplaceId: scope.marketplaceId,
            series: scope.series || '',
            category: scope.category || '',        // Category tab filter (sku_details.category)
            // First Layer Summary
            currentInventory: currentStock,
            onTheWay: 0,                       // Shipping Shipment — pending mapping (spec §9)
            _recDraftLines: recDraftLines,               // persisted Recommendation Summary snapshot (raw draft lines) or []
            thirdPartyStock: thirdPartyDisplay,          // Site Planning Available (or state label)
            thirdPartyPlan: thirdPartyPlan,              // full allocation detail (tooltip/expand)
            thirdPartyDetailHtml: _irRenderThirdPartyDetail(thirdPartyPlan),
            thirdPartyTitle: _irThirdPartyTitle(thirdPartyPlan),
            avgDailySales: _avgDisplay,        // LIVE9: canonical horizon rate for Sales-Driven; weekly otherwise (1 decimal)
            forecast60d: fc60,
            upcomingEventQty: eventQty > 0 ? eventQty : null,
            daysOfSupply: _dosDisplay,
            needsAlert: false,                 // color now driven by IRMap.dosColorClass
            suggestedQty: need.suggestedQty,
            cnStock: cnStock,
            twStock: twStock,
            // F1-7N-FB-4E-R4B-R3 §3 - the projection's own verdict travels with the number, so a real zero
            // (not an eligible receiver / zero FC denominator) can never be read as a missing one.
            factoryAllocState: _fa.state,
            unitsPerCarton: det.unitsPerCarton || 0,   // from sku_details — drives carton validation
            // AI Suggestion buckets (Phase 1 structure — engine not implemented)
            need0_18: need.need0_18, need19_30: need.need19_30, need31_45: need.need31_45, need46_90: need.need46_90,
            plannedQty: (typeof replenishmentPlans !== 'undefined' && replenishmentPlans[mp.sku]) || 0,
            note: (DB.getAmazonInventorySnapshot && get('getAmazonInventorySnapshot').length === 0) ? 'Cloud read — Amazon snapshot data pending' : '',
            status: need.suggestedQty > 0 ? 'Need Restock' : 'Sufficient',
            productName: mp.siteSku || mp.sku,
            // Stock Card detail (expand)
            available: stock.available,
            fcTransfer: stock.fcTransfer,
            fcProcessing: stock.fcProcessing,
            customerOrders: stock.customerOrders,
            unsellable: stock.unsellable,
            // Long Term Storage
            over90: lts.over90,
            over180: lts.over180,
            // Shipping Shipment — REAL shipment-derived remaining incoming, mutually-exclusive ETA buckets (R5).
            within18days: shipRem.d0_18, within30days: shipRem.d19_30, within45days: shipRem.d31_45,
            within45plus: shipRem.d45_plus, shipOverdue: shipRem.overdue,
            // 3rd Party detail (only aggregate available in Phase 1)
            winitStock: 0, onusStock: 0,
            // Forecast breakdown (next 3 months)
            nextMonth: monthNames[(cm + 1) % 12], next2Month: monthNames[(cm + 2) % 12], next3Month: monthNames[(cm + 3) % 12],
            fcNextMonth: fcMonth(1), fcNext2Month: fcMonth(2), fcNext3Month: fcMonth(3),
            upcomingEventsText: upcomingEventsText,
            // Sales trend (past 7 completed days)
            salesTrend7d: trend,
            lastWeek: Math.round(avg * 7),
            // Fulfillment model foundation
            fulfillmentModel: ff.model, fulfillmentLocked: ff.locked,
            _source: 'cloud-mapping'
        };
    });

    // LTS filter (Over 90+ / Over 180+)
    if (ltsFilter === 'over90') rows = rows.filter(function (r) { return r.over90 > 0; });
    else if (ltsFilter === 'over180') rows = rows.filter(function (r) { return r.over180 > 0; });
    return rows;
}

// ========================================
// Demo Data Layer: Phase 2A - Inventory Mapping
// ========================================
function _getDemoReplenishmentData() {
    var country = document.getElementById('replenCountry')?.value || '';
    var marketplace = document.getElementById('replenMarketplace')?.value || '';
    var rows = window.KM.DemoData.getInventoryRows({});
    return rows.filter(function(r) {
        // Filter by selected country + marketplace
        if (country && r.country && r.country !== country) return false;
        if (marketplace && r.marketplace && r.marketplace !== marketplace) return false;
        return true;
    }).map(function(r) {
        var avgDaily = r.sales_30d > 0 ? (r.sales_30d / 30) : 0;
        var currentInv = r.fba_stock + r.third_wh_david + r.third_wh_winit;
        var onTheWay = r.overseas_on_way_18d + r.overseas_on_way_45d;
        var thirdParty = r.third_wh_david + r.third_wh_winit;
        var daysOfSupply = avgDaily > 0 ? (currentInv / avgDaily).toFixed(1) : '999';
        var forecast60d = Math.round(avgDaily * 60);
        var suggestedQty = Math.max(0, Math.round(avgDaily * 90 - currentInv - onTheWay));
        var needsAlert = parseFloat(daysOfSupply) < 18;
        return {
            sku: r.sku,
            lifecycle: r.warning_status === 'upcoming' ? 'New' : 'Mature',
            replenishmentModel: r.replenishment_model || 'sales_driven',
            company: 'Kitchen Mama',
            country: r.country || 'US',
            marketplace: r.marketplace,
            series: r.series || '',
            category: r.category || '',   // Category tab filter (sku_details.category)
            currentInventory: currentInv,
            onTheWay: onTheWay,
            thirdPartyStock: thirdParty,
            avgDailySales: avgDaily.toFixed(2),
            forecast60d: forecast60d,
            upcomingEventQty: null,
            daysOfSupply: daysOfSupply,
            needsAlert: needsAlert,
            suggestedQty: suggestedQty,
            cnStock: r.factory_youxin,
            twStock: r.factory_shengyi,
            unitsPerCarton: r.units_per_carton || 0,   // drives carton validation
            need18: 0,
            need30: 0,
            need45Plus: suggestedQty,
            // New AI Suggestion bucket structure (Phase 1: engine not implemented → 0)
            need0_18: 0, need19_30: 0, need31_45: 0, need46_90: 0,
            plannedQty: 0,
            note: r.recommendation || '',
            status: suggestedQty > 0 ? 'Need Restock' : 'Sufficient',
            productName: r.product_name,
            available: r.fba_stock,
            fcTransfer: 0,
            fcProcessing: 0,
            customerOrders: 0,
            unsellable: 0,
            over90: 0,
            over180: 0,
            winitStock: r.third_wh_winit,
            onusStock: r.third_wh_david,
            within18days: r.overseas_on_way_18d,
            within30days: 0,
            within45days: r.overseas_on_way_45d,
            lastWeek: Math.round(avgDaily * 7),
            salesTrend7d: [],
            fulfillmentModel: '', fulfillmentLocked: false
        };
    });
}

function _showDemoBadge() {
    var panel = document.querySelector('#ops-section .replen-control-panel');
    if (!panel) return;
    if (panel.querySelector('.demo-badge')) return;
    var badge = document.createElement('span');
    badge.className = 'demo-badge';
    badge.style.cssText = 'background:#8b5cf6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:12px;vertical-align:middle;';
    badge.textContent = 'Demo Data Mode';
    panel.appendChild(badge);
}

function _removeDemoBadge() {
    var badge = document.querySelector('#ops-section .demo-badge');
    if (badge) badge.remove();
}

// Patch renderReplenishment to show/hide badge
var _originalRenderReplenishment = renderReplenishment;
renderReplenishment = function() {
    _originalRenderReplenishment();
    if (window.KM && window.KM.DemoData && window.KM.DemoData.isEnabled && window.KM.DemoData.isEnabled()) {
        _showDemoBadge();
    } else {
        _removeDemoBadge();
    }
};
window.renderReplenishment = renderReplenishment;

// Debug helper
// ========================================
// Edit SKU / Delete SKU
// ========================================

var _editSkuTarget = null;

function openEditSkuModal() {
    // Find selected SKU from current table (use first expanded or prompt user)
    var fixedRows = document.querySelectorAll('#ops-section .dual-layer-table:not(.ir-overview-table) .fixed-row');
    var selectedSku = null;
    fixedRows.forEach(function(row) {
        if (row.classList.contains('expanded')) selectedSku = row.dataset.sku;
    });
    if (!selectedSku) {
        // Prompt user to select
        var allSkus = Array.from(fixedRows).map(function(r) { return r.dataset.sku; }).filter(Boolean);
        if (allSkus.length === 0) { alert('No SKU data available. Please search first.'); return; }
        selectedSku = prompt('Enter SKU to edit (or expand a row first):\n\nAvailable: ' + allSkus.slice(0, 10).join(', ') + (allSkus.length > 10 ? '...' : ''));
        if (!selectedSku) return;
    }

    // Find the SKU in current data
    var data = getReplenishmentData();
    var item = data.find(function(d) { return d.sku === selectedSku; });
    if (!item) { alert('SKU not found in current results: ' + selectedSku); return; }

    // Also try to get marketplace_skus record for current values
    var mpSkus = _irWsGet('getMarketplaceSkus');   // Workspace (scoped) → read-model; Legacy → getMarketplaceSkus()
    var _selCompany = item.company || _replenSelectedCompany();
    function _eqLo(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
    var mpRecord = mpSkus.find(function(mp) {
        // Company-safe: never match a different company's row for the same SKU + country + marketplace.
        return mp.sku === selectedSku &&
            (!_selCompany || _eqLo(mp.company, _selCompany)) &&
            mp.country === (item.country || document.getElementById('replenCountry')?.value) &&
            mp.marketplace === (item.marketplace || document.getElementById('replenMarketplace')?.value);
    });

    _editSkuTarget = {
        sku: selectedSku,
        company: _selCompany || '',
        country: item.country || document.getElementById('replenCountry')?.value || '',
        marketplace: item.marketplace || document.getElementById('replenMarketplace')?.value || '',
        marketplaceSkuId: mpRecord ? mpRecord.marketplaceSkuId : '',
        replenishmentModel: mpRecord ? mpRecord.replenishmentModel : 'sales_driven',
        marketplaceSkuStatus: mpRecord ? mpRecord.marketplaceSkuStatus : 'active',
        launchDate: mpRecord ? mpRecord.launchDate : '',
        fulfillmentModel: mpRecord ? mpRecord.fulfillmentModel : ''
    };

    // Populate modal
    document.getElementById('edit-sku-code').value = selectedSku;
    document.getElementById('edit-sku-site').value = _editSkuTarget.country + ' / ' + _editSkuTarget.marketplace;
    document.getElementById('edit-sku-model').value = _editSkuTarget.replenishmentModel || 'sales_driven';
    document.getElementById('edit-sku-status').value = _editSkuTarget.marketplaceSkuStatus || 'active';
    document.getElementById('edit-sku-launch-date').value = _editSkuTarget.launchDate || '';

    // Fulfillment Model with the same lock rule, resolved from the marketplace registry.
    var _mpReg = _irWsGet('getMarketplaces').find(function(m) {   // F1-7J-A: read-model-first — BEFORE==AFTER
        if (mpRecord && mpRecord.marketplaceId && m.marketplaceId === mpRecord.marketplaceId) return true;
        return String(m.country || '').toLowerCase() === String(_editSkuTarget.country || '').toLowerCase()
            && String(m.marketplace || '').toLowerCase() === String(_editSkuTarget.marketplace || '').toLowerCase();
    });
    applyFulfillmentLock(
        document.getElementById('edit-sku-fulfillment'),
        document.getElementById('edit-sku-fulfillment-hint'),
        _mpReg ? _mpReg.fulfillmentModel : '',
        _editSkuTarget.fulfillmentModel
    );

    // Open modal
    var modal = document.getElementById('replen-edit-sku-modal');
    var overlay = document.getElementById('replen-modal-overlay');
    if (modal && overlay) {
        modal.classList.add('is-open');
        overlay.classList.add('is-open');
    }
}

function closeEditSkuModal() {
    var modal = document.getElementById('replen-edit-sku-modal');
    var overlay = document.getElementById('replen-modal-overlay');
    if (modal && overlay) {
        modal.classList.remove('is-open');
        overlay.classList.remove('is-open');
    }
    _editSkuTarget = null;
}

function saveEditSku() {
    if (!_editSkuTarget) { alert('No SKU selected'); return; }

    var model = document.getElementById('edit-sku-model').value;
    var status = document.getElementById('edit-sku-status').value;
    var launchDate = document.getElementById('edit-sku-launch-date').value;
    var fulfillmentModel = document.getElementById('edit-sku-fulfillment') ? document.getElementById('edit-sku-fulfillment').value : '';

    var payload = {
        marketplace_sku_id: _editSkuTarget.marketplaceSkuId,
        sku: _editSkuTarget.sku,
        country: _editSkuTarget.country,
        marketplace: _editSkuTarget.marketplace,
        replenishment_model: model,
        marketplace_sku_status: status,
        fulfillment_model: fulfillmentModel,
        launch_date: launchDate
    };

    if (window.KM && window.KM.DB && window.KM.DB.updateMarketplaceSkuModel) {
        window.KM.DB.updateMarketplaceSkuModel(payload).then(function(result) {
            if (result && result.success === false) {
                alert('Could not update SKU. ' + (result.error || 'Please check the API connection and try again.'));
                return;
            }
            alert('SKU updated successfully.');
            closeEditSkuModal();
            _irAfterWrite(function () { renderReplenishment(); });   // Workspace: scoped re-read; Legacy: render-only
        }).catch(function(err) {
            alert('Error: ' + err.message);
        });
    } else {
        alert('Cloud write not available. Edit saved locally only.');
        closeEditSkuModal();
    }
}

function handleDeleteSku() {
    alert('Delete SKU is not enabled yet.');
}

window.openEditSkuModal = openEditSkuModal;
window.closeEditSkuModal = closeEditSkuModal;
window.saveEditSku = saveEditSku;
window.handleDeleteSku = handleDeleteSku;

// ========================================
// Import SKU (CSV -> KM.DB.importMarketplaceSkusBatch)
// ========================================

// Marketplace-scoped import: user picks Country + Marketplace (display name); company/country/
// marketplace/currency/marketplace_id are resolved from the registry. CSV carries only
// sku, site_sku, replenishment_model.
var REPLEN_VALID_MODELS = ['sales_driven', 'forecast_driven'];
var _replenImportResolved = null; // { company, country, marketplace, marketplaceId, currency, displayName }

function _replenImportActiveMarketplaces() {
    var list = _irWsGet('getMarketplaces');   // F1-7J-A: read-model-first (Workspace → _irReadModel; Legacy → getter) — BEFORE==AFTER
    return list.filter(function(m) { var s = (m.status || '').toLowerCase(); return !s || s === 'active'; });
}

function _replenImportRowValue(m) {
    return (m.marketplaceId && m.marketplaceId !== '') ? m.marketplaceId : (m.company + '|' + m.country + '|' + m.marketplace);
}

function _replenImportSetResolvedText(message, color) {
    var el = document.getElementById('replen-import-resolved');
    if (!el) return;
    el.style.color = color || '#475569';
    el.textContent = message;
}

function openReplenImportModal() {
    var modal = document.getElementById('replen-import-sku-modal');
    var overlay = document.getElementById('replen-modal-overlay');
    if (!modal || !overlay) return;

    var countrySel = document.getElementById('replen-import-country');
    if (countrySel) {
        var active = _replenImportActiveMarketplaces();
        var countries = [];
        active.forEach(function(m) { if (m.country && countries.indexOf(m.country) === -1) countries.push(m.country); });
        countries.sort();
        countrySel.innerHTML = '<option value="">Select Country</option>' +
            countries.map(function(c) { return '<option value="' + escapeReplenHtml(c) + '">' + escapeReplenHtml(c) + '</option>'; }).join('');
    }
    var mpSel = document.getElementById('replen-import-marketplace');
    if (mpSel) mpSel.innerHTML = '<option value="">Select Marketplace</option>';
    _replenImportResolved = null;
    _replenImportSetResolvedText('Select Country + Marketplace to resolve company/currency.', '#475569');

    var fileInput = document.getElementById('replen-import-file');
    if (fileInput) fileInput.value = '';
    var resultBox = document.getElementById('replen-import-result');
    if (resultBox) { resultBox.style.display = 'none'; resultBox.innerHTML = ''; }
    var runBtn = document.getElementById('replen-import-run-btn');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Import'; }
    modal.classList.add('is-open');
    overlay.classList.add('is-open');
}

function closeReplenImportModal() {
    var modal = document.getElementById('replen-import-sku-modal');
    var overlay = document.getElementById('replen-modal-overlay');
    if (modal) modal.classList.remove('is-open');
    if (overlay) overlay.classList.remove('is-open');
}

function onReplenImportCountryChange() {
    var countrySel = document.getElementById('replen-import-country');
    var mpSel = document.getElementById('replen-import-marketplace');
    var country = countrySel ? countrySel.value : '';
    if (mpSel) {
        var active = _replenImportActiveMarketplaces();
        var rowsForCountry = active.filter(function(m) { return !country || m.country === country; });
        mpSel.innerHTML = '<option value="">Select Marketplace</option>' +
            rowsForCountry.map(function(m) {
                var val = _replenImportRowValue(m);
                var label = m.marketplaceDisplayName || m.marketplace || m.marketplaceId || val;
                return '<option value="' + escapeReplenHtml(val) + '">' + escapeReplenHtml(label) + '</option>';
            }).join('');
    }
    _replenImportResolved = null;
    _replenImportSetResolvedText('Select Country + Marketplace to resolve company/currency.', '#475569');
}

// Resolve exactly one active registry row by the selected option value (marketplace_id / composite key).
function _resolveReplenImportMarketplace() {
    _replenImportResolved = null;
    var mpSel = document.getElementById('replen-import-marketplace');
    var val = mpSel ? mpSel.value : '';
    if (!val) return { ok: false, error: 'Select Country and Marketplace.' };
    var matches = _replenImportActiveMarketplaces().filter(function(m) { return _replenImportRowValue(m) === val; });
    if (matches.length === 0) return { ok: false, error: 'Selected marketplace not found in the active registry.' };
    if (matches.length > 1) return { ok: false, error: 'Selected marketplace value is ambiguous in the registry.' };
    var m = matches[0];
    _replenImportResolved = {
        company: m.company,
        country: m.country,
        marketplace: m.marketplace,
        marketplaceId: m.marketplaceId || '',
        currency: m.currency || 'USD',
        fulfillmentModel: m.fulfillmentModel || '',
        displayName: m.marketplaceDisplayName || m.marketplace || (m.marketplaceId || '')
    };
    return { ok: true };
}

function onReplenImportMarketplaceChange() {
    var res = _resolveReplenImportMarketplace();
    if (_replenImportResolved) {
        var isHybrid = _replenImportResolved.fulfillmentModel === 'hybrid';
        _replenImportSetResolvedText(
            'Resolved → Company: ' + _replenImportResolved.company +
            ' | Country: ' + _replenImportResolved.country +
            ' | Marketplace: ' + (_replenImportResolved.displayName || _replenImportResolved.marketplace) +
            ' | Marketplace ID: ' + (_replenImportResolved.marketplaceId || '(none)') +
            ' | Currency: ' + _replenImportResolved.currency +
            ' | Fulfillment: ' + (_replenImportResolved.fulfillmentModel || '(unset)') +
            (isHybrid ? '  ⚠ Hybrid — CSV must include a fulfillment_model column (platform_fulfilled / self_fulfilled).' : ''),
            '#166534'
        );
    } else {
        _replenImportSetResolvedText((res && res.error) ? res.error : 'Select Country + Marketplace to resolve company/currency.', '#b91c1c');
    }
}

// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, and CRLF/LF.
function parseReplenCsv(text) {
    var rows = [];
    var field = '', row = [], inQuotes = false;
    text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else { field += c; }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else { field += c; }
        }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

// (csvRowsToImportObjects removed — Import SKU is now marketplace-scoped; parsing is inline in runReplenImport.)

function escapeReplenHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderReplenImportError(message) {
    var box = document.getElementById('replen-import-result');
    if (!box) { alert(message); return; }
    box.style.display = 'block';
    box.innerHTML = '<div class="replen-import__status replen-import__status--error">Error: ' + escapeReplenHtml(message) + '</div>';
}

function renderReplenImportResult(data) {
    var box = document.getElementById('replen-import-result');
    if (!box) return;
    var summary = data.summary || { total: 0, created: 0, updated: 0, skipped: 0, error: 0 };
    var results = data.results || [];

    var html = '<div class="replen-import__summary">' +
        '<span>Total: ' + summary.total + '</span>' +
        '<span class="replen-import__status--created">Created: ' + summary.created + '</span>' +
        '<span class="replen-import__status--updated">Updated: ' + summary.updated + '</span>' +
        '<span class="replen-import__status--skipped">Skipped: ' + summary.skipped + '</span>' +
        '<span class="replen-import__status--error">Error: ' + summary.error + '</span>' +
        '</div>';

    html += results.map(function(rr) {
        return '<div class="replen-import__row">' +
            '<span class="replen-import__status replen-import__status--' + escapeReplenHtml(rr.status) + '">' + escapeReplenHtml(rr.status) + '</span>' +
            '<span>#' + escapeReplenHtml(String(rr.rowIndex)) + '</span>' +
            '<span>' + escapeReplenHtml(rr.sku || '') + '</span>' +
            '<span>' + escapeReplenHtml(rr.message || '') + '</span>' +
            '</div>';
    }).join('');

    box.style.display = 'block';
    box.innerHTML = html;
}

function runReplenImport() {
    var res = _resolveReplenImportMarketplace();
    if (!_replenImportResolved) { renderReplenImportError((res && res.error) ? res.error : 'Select Country and Marketplace first.'); return; }

    var fileInput = document.getElementById('replen-import-file');
    var runBtn = document.getElementById('replen-import-run-btn');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) { alert('Please choose a CSV file first.'); return; }
    if (!(window.KM && window.KM.DB && window.KM.DB.importMarketplaceSkusBatch)) { alert('Import API is not available.'); return; }

    var meta = _replenImportResolved;
    var file = fileInput.files[0];
    var reader = new FileReader();
    reader.onload = function(e) {
        var cells;
        try { cells = parseReplenCsv(e.target.result); } catch (err) { renderReplenImportError('Failed to parse CSV: ' + (err && err.message ? err.message : err)); return; }
        if (!cells || cells.length < 2) { renderReplenImportError('No data rows found (need a header row + at least one data row).'); return; }
        var headers = cells[0].map(function(h) { return String(h == null ? '' : h).trim().toLowerCase(); });
        var skuIdx = headers.indexOf('sku');
        var siteIdx = headers.indexOf('site_sku');
        var modelIdx = headers.indexOf('replenishment_model');
        var ffIdx = headers.indexOf('fulfillment_model');
        var isHybridImport = meta.fulfillmentModel === 'hybrid';
        if (skuIdx === -1 || siteIdx === -1) { renderReplenImportError('CSV must include "sku" and "site_sku" headers.'); return; }
        if (isHybridImport && ffIdx === -1) { renderReplenImportError('Hybrid marketplace requires a "fulfillment_model" column (platform_fulfilled / self_fulfilled).'); return; }

        var rows = [];
        var clientErrors = [];
        var dataRowNum = 0;
        for (var r = 1; r < cells.length; r++) {
            var raw = cells[r];
            var allEmpty = raw.every(function(v) { return String(v == null ? '' : v).trim() === ''; });
            if (allEmpty) continue;
            dataRowNum++;
            var sku = String(raw[skuIdx] == null ? '' : raw[skuIdx]).trim();
            var siteSku = String(raw[siteIdx] == null ? '' : raw[siteIdx]).trim();
            var model = modelIdx === -1 ? '' : String(raw[modelIdx] == null ? '' : raw[modelIdx]).trim();

            if (!sku) { clientErrors.push({ rowIndex: dataRowNum, sku: sku, status: 'error', message: 'SKU is required' }); continue; }
            if (!siteSku) { clientErrors.push({ rowIndex: dataRowNum, sku: sku, status: 'error', message: 'site_sku is required' }); continue; }
            if (model && REPLEN_VALID_MODELS.indexOf(model) === -1) {
                clientErrors.push({ rowIndex: dataRowNum, sku: sku, status: 'error', message: 'Invalid replenishment_model: "' + model + '" (use sales_driven or forecast_driven)' });
                continue;
            }

            // Fulfillment model: only consumed for Hybrid marketplaces (required there);
            // ignored for platform/self marketplaces (model is fixed by the marketplace).
            var ff = ffIdx === -1 ? '' : String(raw[ffIdx] == null ? '' : raw[ffIdx]).trim();
            if (isHybridImport) {
                if (!ff) { clientErrors.push({ rowIndex: dataRowNum, sku: sku, status: 'error', message: 'fulfillment_model required for Hybrid (platform_fulfilled / self_fulfilled)' }); continue; }
                if (ff !== 'platform_fulfilled' && ff !== 'self_fulfilled') { clientErrors.push({ rowIndex: dataRowNum, sku: sku, status: 'error', message: 'Invalid fulfillment_model: "' + ff + '" (use platform_fulfilled / self_fulfilled)' }); continue; }
            }

            rows.push({
                sku: sku,
                site_sku: siteSku,
                company: meta.company,
                country: meta.country,
                marketplace: meta.marketplace,
                marketplace_id: meta.marketplaceId,
                currency: meta.currency,
                marketplace_sku_status: 'active',
                replenishment_model: model || 'sales_driven',
                fulfillment_model: isHybridImport ? ff : '',
                asin: '',
                launch_date: ''
            });
        }

        if (rows.length === 0 && clientErrors.length === 0) { renderReplenImportError('No data rows found.'); return; }
        if (rows.length === 0) {
            // All rows rejected client-side; show errors, nothing sent to backend.
            renderReplenImportResult({ summary: { total: clientErrors.length, created: 0, updated: 0, skipped: 0, error: clientErrors.length }, results: clientErrors });
            return;
        }

        if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Importing...'; }
        window.KM.DB.importMarketplaceSkusBatch(rows, { priceStatusDefault: 'draft', forecastStatusDefault: 'draft' })
            .then(function(result) {
                if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Import'; }
                if (!result || result.success === false) {
                    renderReplenImportError(result && result.error ? result.error : 'Import failed. API may not be configured.');
                    return;
                }
                var data = result.data || {};
                var s = data.summary || { total: 0, created: 0, updated: 0, skipped: 0, error: 0 };
                var mergedSummary = {
                    total: (s.total || 0) + clientErrors.length,
                    created: s.created || 0,
                    updated: s.updated || 0,
                    skipped: s.skipped || 0,
                    error: (s.error || 0) + clientErrors.length
                };
                var mergedResults = clientErrors.concat(data.results || []);
                renderReplenImportResult({ summary: mergedSummary, results: mergedResults });
                // Batch F (F1-7K): the writer no longer reloads the whole DB, so this import owns its readback the
                // same way the single-row Add path does — _irAfterWrite does a scoped IR re-read in Workspace mode
                // (Legacy render-only, where the writer's posture-gated fallback already refreshed the cache).
                _irAfterWrite(function () { if (typeof renderReplenishment === 'function') renderReplenishment(); });
            })
            .catch(function(err) {
                if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Import'; }
                renderReplenImportError(err && err.message ? err.message : 'Import request failed.');
            });
    };
    reader.onerror = function() { renderReplenImportError('Could not read the selected file.'); };
    reader.readAsText(file);
}

function downloadReplenImportTemplate() {
    var res = _resolveReplenImportMarketplace();
    if (!_replenImportResolved) { alert('Please select Country and Marketplace first.' + (res && res.error ? ('\n' + res.error) : '')); return; }
    // Hybrid marketplace: template gains a fulfillment_model column (platform_fulfilled / self_fulfilled).
    // Non-hybrid: column is omitted (the SKU model is fixed by the marketplace).
    var isHybrid = _replenImportResolved.fulfillmentModel === 'hybrid';
    var headers = isHybrid ? 'sku,site_sku,replenishment_model,fulfillment_model' : 'sku,site_sku,replenishment_model';
    var sample = isHybrid ? 'SAMPLE-SKU,SAMPLE-SITE-SKU,sales_driven,platform_fulfilled' : 'SAMPLE-SKU,SAMPLE-SITE-SKU,sales_driven';
    var csv = headers + '\n' + sample + '\n';

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'marketplace_skus_import_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.openReplenImportModal = openReplenImportModal;
window.closeReplenImportModal = closeReplenImportModal;
window.onReplenImportCountryChange = onReplenImportCountryChange;
window.onReplenImportMarketplaceChange = onReplenImportMarketplaceChange;
window.runReplenImport = runReplenImport;
window.downloadReplenImportTemplate = downloadReplenImportTemplate;

// Populate the main Country / Marketplace filters from the marketplaces registry
// (cloud mode only, non-destructive: keeps static options when registry is empty or in Demo mode).
function _replenDemoOn() {
    return !!(window.KM && window.KM.DemoData && window.KM.DemoData.isEnabled && window.KM.DemoData.isEnabled());
}

function _replenActiveMarketplaces() {
    var list = _irWsGet('getMarketplaces');   // Workspace (scoped) → read-model; Legacy → getMarketplaces()
    return list.filter(function(m) { var s = (m.status || '').toLowerCase(); return !s || s === 'active'; });
}

// Resolve the CURRENT scope from the Marketplace dropdown. There is no Company select: in Cloud mode
// the dropdown value is a marketplace_id, so company + country + marketplace are DERIVED from the
// marketplaces master. In Demo mode the dropdown keeps its static marketplace-NAME options, so the
// value is the marketplace name directly (and company is unused for the demo scope).
function _replenSelectedScope() {
    var country = (document.getElementById('replenCountry') || {}).value || '';
    var mpVal = (document.getElementById('replenMarketplace') || {}).value || '';
    if (_replenDemoOn()) {
        return { company: '', country: country, marketplace: mpVal, marketplaceId: '' };
    }
    var list = _irWsGet('getMarketplaces');   // F1-7J-A: read-model-first (Workspace → _irReadModel; Legacy → getter) — BEFORE==AFTER
    var rec = mpVal ? list.find(function(m){ return String(m.marketplaceId) === String(mpVal); }) : null;
    if (!rec) return { company: '', country: country, marketplace: '', marketplaceId: mpVal };
    return { company: rec.company || '', country: rec.country || country, marketplace: rec.marketplace || '', marketplaceId: rec.marketplaceId || mpVal };
}
window._replenSelectedScope = _replenSelectedScope;

// Selected replenishment company ('' = none) — now DERIVED from the selected marketplace_id (no
// Company select). Kept for callers that still ask for the company of the current scope.
function _replenSelectedCompany() {
    return _replenSelectedScope().company;
}
window._replenSelectedCompany = _replenSelectedCompany;

// Rebuild Country options from active marketplaces. Demo OFF only. Resets an invalid selection.
function refreshReplenCountryOptions() {
    if (_replenDemoOn()) return;
    var countrySel = document.getElementById('replenCountry');
    if (!countrySel) return;

    var active = _replenActiveMarketplaces();
    var selCountry = countrySel.value;

    var countries = [];
    active.forEach(function(m) {
        if (!m.country) return;
        if (countries.indexOf(m.country) === -1) countries.push(m.country);
    });
    countries.sort();

    countrySel.innerHTML = '<option value="">Select Country</option>' +
        countries.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
    countrySel.value = (selCountry && countries.indexOf(selCountry) !== -1) ? selCountry : '';
}

// Rebuild Marketplace options, scoped to the selected Country + active status. Demo OFF only.
// Each option's value = marketplace_id (identity), label = marketplace_display_name. Company is NOT a
// separate selector — it is carried by the marketplace_id and derived downstream. Distinct marketplace_ids
// are never collapsed, so KM/US/Amazon and ResUS/US/Amazon remain two separate options.
function refreshReplenMarketplaceOptions() {
    if (_replenDemoOn()) return;
    var countrySel = document.getElementById('replenCountry');
    var mpSel = document.getElementById('replenMarketplace');
    if (!mpSel) return;

    var active = _replenActiveMarketplaces();
    var selCountry = countrySel ? countrySel.value : '';
    var selMarketplaceId = mpSel.value;

    var opts = [], ids = {};
    active.forEach(function(m) {
        if (!m.marketplaceId) return;
        if (selCountry && m.country !== selCountry) return;
        if (ids[m.marketplaceId]) return; ids[m.marketplaceId] = 1;
        opts.push({ value: m.marketplaceId, label: m.marketplaceDisplayName || m.marketplace || m.marketplaceId, company: m.company || '' });
    });

    // Canonical Decision 2: the option LABEL is marketplace_display_name only — NO country suffix (the
    // Country filter already scopes the list). The value stays marketplace_id (identity); the display
    // string is never used as identity. Single-select must resolve to ONE marketplace_id, so ONLY when
    // two options within this country share the EXACT same display name (rare KM vs ResUS case) do we
    // append a minimal company hint to disambiguate — otherwise the label is channel-only.
    var labelCount = {};
    opts.forEach(function(o) { labelCount[o.label] = (labelCount[o.label] || 0) + 1; });
    opts.forEach(function(o) { o.display = (labelCount[o.label] > 1 && o.company) ? (o.label + ' (' + o.company + ')') : o.label; });
    opts.sort(function(a, b) { return a.display.localeCompare(b.display); });

    mpSel.innerHTML = '<option value="">Select Marketplace</option>' +
        opts.map(function(o) { return '<option value="' + escapeReplenHtml(o.value) + '">' + escapeReplenHtml(o.display) + '</option>'; }).join('');
    // Keep the current marketplace_id ONLY if it still belongs to the (new) country scope — otherwise
    // reset to "" (no US/first-match fallback, no silent fallback to the first marketplace).
    mpSel.value = (selMarketplaceId && ids[selMarketplaceId]) ? selMarketplaceId : '';
}

// Resolve a canonical marketplace key to its display label (marketplace_display_name if present,
// else the key). Optionally disambiguate by company + country.
function _replenMarketplaceLabel(key, company, country) {
    key = String(key == null ? '' : key).trim();
    if (!key) return '';
    var list = _irWsGet('getMarketplaces');   // F1-7J-A: read-model-first (Workspace → _irReadModel; Legacy → getter) — BEFORE==AFTER
    function up(v){ return String(v == null ? '' : v).trim().toUpperCase(); }
    var exact = list.filter(function(m){ return up(m.marketplace) === up(key) &&
        (!company || up(m.company) === up(company)) && (!country || up(m.country) === up(country)) &&
        m.marketplaceDisplayName; })[0];
    if (exact) return exact.marketplaceDisplayName;
    var any = list.filter(function(m){ return up(m.marketplace) === up(key) && m.marketplaceDisplayName; })[0];
    return any ? any.marketplaceDisplayName : key;
}
window._replenMarketplaceLabel = _replenMarketplaceLabel;

// Full (initial) population of both filters from the registry. Demo OFF only;
// in Demo mode this is a no-op so the static demo options/behavior are preserved.
function populateReplenFiltersFromRegistry() {
    if (_replenDemoOn()) return;
    refreshReplenCountryOptions();
    refreshReplenMarketplaceOptions();
}

// Bind dependency handlers. Idempotent (onchange property assignment). Canonical scope:
// Country → Marketplace (marketplace_id). There is no Company select — company is derived from the
// selected marketplace_id. Changing Country resets the marketplace if its id no longer belongs.
function bindReplenFilterDependencies() {
    var countrySel = document.getElementById('replenCountry');
    var mpSel = document.getElementById('replenMarketplace');
    if (countrySel) {
        countrySel.onchange = function() {
            // Context (Country) changed → discard the Shipping Allocation Working Draft (both modes).
            _clearAllocationDraft();
            if (_replenDemoOn()) { if (typeof onReplenRecoScopeChanged === 'function') onReplenRecoScopeChanged(); return; }
            // Country changed -> re-scope Marketplace options; resets the marketplace_id selection if it
            // does not belong to the new country (no fallback to US / first marketplace).
            refreshReplenMarketplaceOptions();
            // Recommendation Context (F1-4B-B-PRE): re-scope destination options + drop a now-invalid
            // destination selection. Pure page-input recompute — genuinely NO API call now: F1-7N-FB-2A §B
            // removed the _irRecoTrigger() that used to fire two scope reads from inside this handler.
            if (typeof onReplenRecoScopeChanged === 'function') onReplenRecoScopeChanged();
            // §B — a selector change marks the displayed result STALE and requires Search again. It never
            // loads and never repaints the table (the APPLIED filters are unchanged until Search succeeds).
            if (typeof _irMarkSearchStale_ === 'function') _irMarkSearchStale_();
        };
    }
    if (mpSel) {
        mpSel.onchange = function() {
            // Context (Marketplace) changed → discard the Shipping Allocation Working Draft (both modes).
            // The chosen marketplace_id already belongs to the selected Country (options are country-scoped),
            // so no further re-scoping is needed.
            _clearAllocationDraft();
            // Recommendation Context (F1-4B-B-PRE): re-scope destination options for the new marketplace
            // scope + drop a now-invalid destination. Pure page-input recompute — genuinely NO API call now.
            if (typeof onReplenRecoScopeChanged === 'function') onReplenRecoScopeChanged();
            if (typeof _irMarkSearchStale_ === 'function') _irMarkSearchStale_();
        };
    }
}

window.populateReplenFiltersFromRegistry = populateReplenFiltersFromRegistry;
window.refreshReplenCountryOptions = refreshReplenCountryOptions;
window.refreshReplenMarketplaceOptions = refreshReplenMarketplaceOptions;
window.bindReplenFilterDependencies = bindReplenFilterDependencies;

// ============================================================================
// F1-4B-B-PRE — Recommendation Context Input Authority (page-local; NO API call).
// ----------------------------------------------------------------------------
// Explicit, truthful page ownership of the THREE caller-owned inputs the read endpoint
// recommendation.workspace.get (F1-4B-A) mandates and the frozen Phase-1 registry forbids
// inferring:
//   • destinationWarehouseId — D-F1-5B-1: an explicit canonical warehouse_id, VALIDATED
//     (active + same company + compatible country); NEVER auto-selected/inferred.
//   • calculationMonth        — D-F1-5B-3: explicit injected "YYYY-MM"; NEVER the browser clock.
//   • planningCycle           — explicit caller/scheduler run identifier (opaque required string;
//     the runtime echoes it as windowCode and never parses it — no strict format is frozen, so we
//     require an explicit non-empty deterministic value and DO NOT invent a format validator).
// This slice ONLY establishes the input authority + a validated normalized context. It does NOT
// call the API, does NOT touch/replace any Recommendation Summary placeholder, authors NO
// formula/runtime, imports no runtime module, and performs NO write (sessionStorage page-input
// preference only). Pure helpers live in window.IRContext; DOM wiring below is thin.
// __IRCTX_START__ (test extraction marker — do not remove)
window.IRContext = (function () {
  'use strict';
  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function s(v) { return String(v == null ? '' : v).trim(); }
  function eqv(a, b) { return s(a).toLowerCase() === s(b).toLowerCase(); }
  // Country compatibility reuses the shared inventory-compat contract (UK ≡ GB alias) with a safe
  // exact-match fallback — identical to how the rest of this page matches country. A blank country on
  // EITHER side is not a proven mismatch (never over-exclude a valid destination on missing data).
  function countryMatch(whCountry, scopeCountry) {
    if (!s(whCountry) || !s(scopeCountry)) return true;
    return (typeof window !== 'undefined' && window.IRCountry && window.IRCountry.matches)
      ? window.IRCountry.matches(whCountry, scopeCountry) : eqv(whCountry, scopeCountry);
  }

  // Eligible destination options for a scope (§5): canonical warehouse_id, explicitly active, same
  // company (no cross-company borrowing), compatible country. Identity is ALWAYS warehouse_id — never a
  // display name. Returns a deterministic, sorted list. Does NOT select anything.
  function eligibleDestinationWarehouses(warehouses, scope) {
    scope = scope || {};
    var out = (warehouses || []).filter(function (w) {
      if (!w || !s(w.warehouseId)) return false;         // identity is warehouse_id (never name)
      if (w.isActive !== true) return false;             // explicit active only (tri-state; blank/null excluded)
      if (scope.company && !eqv(w.company, scope.company)) return false;   // same company only
      if (!countryMatch(w.country, scope.country)) return false;          // compatible country scope
      return true;
    }).map(function (w) {
      return { warehouseId: s(w.warehouseId), warehouseCode: s(w.warehouseCode),
        warehouseName: s(w.warehouseName), warehouseType: s(w.warehouseType) };
    });
    out.sort(function (a, b) {
      var ka = a.warehouseCode || a.warehouseId, kb = b.warehouseCode || b.warehouseId;
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.warehouseId < b.warehouseId ? -1 : (a.warehouseId > b.warehouseId ? 1 : 0);
    });
    return out;
  }

  // Explicit YYYY-MM only. Blank → UNSELECTED (never a browser-clock default); malformed → INVALID_FORMAT.
  function validateCalculationMonth(v) {
    var raw = s(v);
    if (raw === '') return { value: null, state: 'UNSELECTED' };
    if (!MONTH_RE.test(raw)) return { value: null, state: 'INVALID_FORMAT' };
    return { value: raw, state: 'VALID' };
  }

  // Planning cycle: explicit non-empty run identifier (deterministic whitespace-normalized). No frozen
  // strict format exists, so we do NOT invent one; blank → UNSELECTED, any non-empty value → VALID.
  function validatePlanningCycle(v) {
    var raw = s(v).replace(/\s+/g, ' ');
    if (raw === '') return { value: null, state: 'UNSELECTED' };
    return { value: raw, state: 'VALID' };
  }

  // Destination sub-state from an EXPLICIT selection over the eligible set — never auto-picks a first/
  // only option. An array with >1 distinct id → DESTINATION_AUTHORITY_CONFLICT (mirrors the runtime).
  function destinationState(scope, eligible, selected) {
    scope = scope || {}; eligible = eligible || [];
    var sel;
    if (Array.isArray(selected)) {
      var distinct = [], seen = {};
      selected.forEach(function (x) { var id = s(x); if (id && !seen[id]) { seen[id] = 1; distinct.push(id); } });
      if (distinct.length > 1) return { state: 'DESTINATION_AUTHORITY_CONFLICT', destinationWarehouseId: null };
      sel = distinct[0] || '';
    } else { sel = s(selected); }
    if (eligible.length === 0) {
      return { state: (s(scope.fulfillmentModel).toLowerCase() === 'platform_fulfilled')
        ? 'PLATFORM_DESTINATION_IDENTITY_UNRESOLVED' : 'NO_ELIGIBLE_DESTINATION', destinationWarehouseId: null };
    }
    var ids = {}; eligible.forEach(function (w) { ids[w.warehouseId] = 1; });
    if (sel === '') return { state: 'UNSELECTED', destinationWarehouseId: null };
    if (ids[sel] === 1) return { state: 'SELECTED_VALID', destinationWarehouseId: sel };
    return { state: 'SELECTED_INVALID', destinationWarehouseId: null };
  }

  function contextScopeKey(scope) {
    scope = scope || {};
    return [s(scope.company), s(scope.country), s(scope.marketplaceId) || s(scope.marketplace)].join('|');
  }

  // The ONE page-local normalized context model (the shape the next round reads via toRequestContext).
  function normalizeRecommendationContext(input) {
    input = input || {};
    var scope = input.scope || {};
    var eligible = input.eligibleWarehouses || eligibleDestinationWarehouses(input.warehouses, scope);
    var dest = destinationState(scope, eligible, input.destinationSelectedId);
    var cm = validateCalculationMonth(input.calculationMonthRaw);
    var pc = validatePlanningCycle(input.planningCycleRaw);

    var model = {
      status: 'NOT_READY',
      company: s(scope.company) || null,
      country: s(scope.country) || null,
      marketplace: s(scope.marketplace) || null,
      marketplaceId: s(scope.marketplaceId) || null,
      destinationWarehouseId: dest.destinationWarehouseId,
      calculationMonth: cm.value,
      planningCycle: pc.value,
      destinationState: dest.state,
      calculationMonthState: cm.state,
      planningCycleState: pc.state,
      missing: [],
      issues: []
    };
    if (!model.company) model.missing.push('company');
    if (!model.country) model.missing.push('country');
    if (!model.marketplace) model.missing.push('marketplace');
    if (!model.destinationWarehouseId) model.missing.push('destinationWarehouseId');
    if (!model.calculationMonth) model.missing.push('calculationMonth');
    if (!model.planningCycle) model.missing.push('planningCycle');

    var hardInvalid = (cm.state === 'INVALID_FORMAT') || (dest.state === 'SELECTED_INVALID') || (dest.state === 'DESTINATION_AUTHORITY_CONFLICT');
    var destBlocked = (dest.state === 'NO_ELIGIBLE_DESTINATION') || (dest.state === 'PLATFORM_DESTINATION_IDENTITY_UNRESOLVED');
    if (cm.state === 'INVALID_FORMAT') model.issues.push('INVALID_CALCULATION_MONTH');
    if (dest.state === 'SELECTED_INVALID') model.issues.push('SELECTED_INVALID_DESTINATION');
    if (dest.state === 'DESTINATION_AUTHORITY_CONFLICT') model.issues.push('DESTINATION_AUTHORITY_CONFLICT');
    if (dest.state === 'NO_ELIGIBLE_DESTINATION') model.issues.push('NO_ELIGIBLE_DESTINATION');
    if (dest.state === 'PLATFORM_DESTINATION_IDENTITY_UNRESOLVED') model.issues.push('PLATFORM_DESTINATION_IDENTITY_UNRESOLVED');

    if (hardInvalid) model.status = 'INVALID';
    else if (destBlocked) model.status = 'DESTINATION_BLOCKED';
    else if (model.missing.length === 0) model.status = 'READY';
    else model.status = 'NOT_READY';
    return model;
  }

  // Pure predicate re-derived from a normalized model (idempotent truth check).
  function validateRecommendationContext(model) {
    model = model || {};
    var ready = !!(model.company && model.country && model.marketplace &&
      model.destinationWarehouseId && model.calculationMonth && model.planningCycle) &&
      model.status === 'READY';
    return { ready: ready, status: model.status || 'NOT_READY',
      missing: (model.missing || []).slice(), issues: (model.issues || []).slice() };
  }

  // The normalized context DTO the NEXT round (F1-4B-B) passes to recommendation.workspace.get.
  // Returned ONLY when READY; null otherwise (never a partial/guessed context). The key set matches the
  // F1-4B-A request contract (scope + explicit destination + injected month + planning cycle).
  function toRequestContext(model) {
    if (!validateRecommendationContext(model).ready) return null;
    return {
      company: model.company, country: model.country, marketplace: model.marketplace,
      destinationWarehouseId: model.destinationWarehouseId,
      calculationMonth: model.calculationMonth, planningCycle: model.planningCycle
    };
  }

  // F1-4B-FM1-T: the SCOPE-ONLY request context (company/country/marketplace). The server owns destination
  // expansion + calculation month/cycle, so the request NO LONGER carries destination/month/cycle. Returned only
  // when the business scope is complete; null otherwise (never a partial/guessed scope).
  function toScopeRequest(model) {
    model = model || {};
    var company = s(model.company), country = s(model.country), marketplace = s(model.marketplace);
    if (!company || !country || !marketplace) return null;
    return { company: company, country: country, marketplace: marketplace };
  }

  // Validate a restored (session) selection against the CURRENT scope + options; drop anything invalid.
  // Destination is kept only when the stored scope key matches AND the id is still eligible.
  function restoreContextSelection(stored, scope, eligible) {
    stored = stored || {};
    var out = { destinationSelectedId: '', calculationMonthRaw: '', planningCycleRaw: '' };
    var ids = {}; (eligible || []).forEach(function (w) { ids[w.warehouseId] = 1; });
    if (s(stored.scopeKey) && s(stored.scopeKey) === contextScopeKey(scope) && ids[s(stored.destinationWarehouseId)] === 1) {
      out.destinationSelectedId = s(stored.destinationWarehouseId);
    }
    if (validateCalculationMonth(stored.calculationMonth).state === 'VALID') out.calculationMonthRaw = s(stored.calculationMonth);
    var pc = validatePlanningCycle(stored.planningCycle);
    if (pc.state === 'VALID') out.planningCycleRaw = pc.value;
    return out;
  }

  return {
    eligibleDestinationWarehouses: eligibleDestinationWarehouses,
    validateCalculationMonth: validateCalculationMonth,
    validatePlanningCycle: validatePlanningCycle,
    destinationState: destinationState,
    contextScopeKey: contextScopeKey,
    normalizeRecommendationContext: normalizeRecommendationContext,
    validateRecommendationContext: validateRecommendationContext,
    toRequestContext: toRequestContext,
    toScopeRequest: toScopeRequest,
    restoreContextSelection: restoreContextSelection
  };
})();
// __IRCTX_END__ (test extraction marker — do not remove)

// ---- F1-4B-C — Recommendation Context is now INTERNAL (no UI). ---------------------------------------
// The three inputs the Recommendation Runtime requires (destinationWarehouseId / calculationMonth /
// planningCycle) were briefly surfaced as page controls (F1-4B-B-PRE). That was an implementation leak —
// users should never be asked for Recommendation-Runtime internals. F1-4B-C REMOVES the "Recommendation
// Context" panel from the UI and keeps the context purely as INTERNAL, HIDDEN page state: no control, no
// readiness indicator, no session-persisted user selection, no render. The pure IRContext MODEL is
// retained (frozen decisions unchanged); the Runtime still receives the three inputs, but now ONLY from
// this internal context (populated by a non-UI seam), never from user input. The Country / Marketplace
// filters remain the ONLY scope controls. Absent an internal populator the context stays NOT_READY, so
// the Recommendation Summary keeps its honest legacy placeholder until the runtime is truly Ready.
var _irctxLastContext = null;   // last normalized context model (INTERNAL; read by loadRecommendationWorkspace_)
// Internal (hidden) Recommendation-Runtime context. NOT user-entered, NOT rendered. Defaults empty; a
// future authorized non-UI seam (scheduler/config) sets it via _irSetInternalRecommendationContext.
var _irInternalContext = { destinationWarehouseId: null, calculationMonth: null, planningCycle: null };

function _irctxWarehouses() {
  // F1-7J-A: read-model-first — Workspace mode reads the scoped IR read-model (warehouses are in the IR workspace
  // payload); Legacy reads the broad getter unchanged. No new fetch, no whole-DB reload, never getOperationDb. BEFORE==AFTER.
  return _irWsGet('getWarehouses');
}
// Internal context scope = the page's selected scope + the marketplace's fulfillment model.
function _irctxScope() {
  var scope = (typeof _replenSelectedScope === 'function') ? _replenSelectedScope()
    : { company: '', country: '', marketplace: '', marketplaceId: '' };
  var ff = '';
  var list = _irWsGet('getMarketplaces');   // F1-7J-A: read-model-first (Workspace → _irReadModel; Legacy → getter) — BEFORE==AFTER
  var rec = scope.marketplaceId ? list.find(function (m) { return String(m.marketplaceId) === String(scope.marketplaceId); }) : null;
  if (rec) ff = rec.fulfillmentModel || '';
  return { company: scope.company, country: scope.country, marketplace: scope.marketplace, marketplaceId: scope.marketplaceId, fulfillmentModel: ff };
}
function _irctxEligible(scope) { return window.IRContext.eligibleDestinationWarehouses(_irctxWarehouses(), scope || _irctxScope()); }

// Recompute the INTERNAL normalized context from the current scope + the hidden internal inputs.
// Renders NOTHING (the readiness indicator was removed). Never calls the API; never writes.
function updateReplenRecoContext() {
  var scope = _irctxScope();
  var model = window.IRContext.normalizeRecommendationContext({
    scope: scope, eligibleWarehouses: _irctxEligible(scope),
    destinationSelectedId: _irInternalContext.destinationWarehouseId || '',
    calculationMonthRaw: _irInternalContext.calculationMonth || '',
    planningCycleRaw: _irInternalContext.planningCycle || ''
  });
  _irctxLastContext = model;
  return model;
}

// Fire the read cutover if it exists (F1-4B-B). No-op unless Workspace mode is effective + context READY.
// FM5-R1: in materialized mode the trigger READS the stored gap (no live calculation) as the AUTHORITATIVE gap
// source. F1-4B-FM5-R4J-LIVE9: the trigger now ALSO issues the one-per-scope recommendation.workspace.get so the
// main table can CARRY the canonical Sales-Driven velocity (horizonBasis.avgSalesPerDay) used by the D-horizon —
// closing SALES_DOS_HORIZON_AUTHORITY_DIVERGENCE. loadRecommendationWorkspace_ self-gates on
// workspaceApiActive('recommendation') + dedupes/caches; when it is off the rate is simply absent (no recompute).
// The materialized gap read remains the sole gap/suggested authority — populating _irRecoState never changes which
// source the Recommendation Summary / Suggested cell display (both prefer _irMatState).
function _irRecoTrigger() {
  var matReady = (typeof _irUseMaterializedGapRead === 'function' && _irUseMaterializedGapRead()
    && window.KM && window.KM.DB && typeof window.KM.DB.getInventoryReplenishmentGap === 'function');
  if (matReady && typeof loadInventoryGap_ === 'function') loadInventoryGap_();
  if (typeof loadRecommendationWorkspace_ === 'function') loadRecommendationWorkspace_();
}

// Non-UI internal seam: a scheduler/config (NOT the user) supplies the Runtime context. Recomputes the
// internal model and re-triggers the (flag-gated) read. There is no control bound to this.
function _irSetInternalRecommendationContext(ctx) {
  ctx = ctx || {};
  if (Object.prototype.hasOwnProperty.call(ctx, 'destinationWarehouseId')) _irInternalContext.destinationWarehouseId = ctx.destinationWarehouseId || null;
  if (Object.prototype.hasOwnProperty.call(ctx, 'calculationMonth')) _irInternalContext.calculationMonth = ctx.calculationMonth || null;
  if (Object.prototype.hasOwnProperty.call(ctx, 'planningCycle')) _irInternalContext.planningCycle = ctx.planningCycle || null;
  updateReplenRecoContext();
  _irRecoTrigger();
  return _irctxLastContext;
}

// Per-mount init: compute the internal context ONLY. F1-7N-FB-2A §B — this used to call _irRecoTrigger(),
// which issued the materialized-gap read AND recommendation.workspace.get on page open, before any Search.
// The context is a pure page-input recompute; the reads now belong exclusively to _irApplySearch_.
function initReplenRecoContext() {
  updateReplenRecoContext();
}

// Scope change (Country/Marketplace) → recompute the internal context ONLY. F1-7N-FB-2A §B — this used to
// call _irRecoTrigger() from BOTH selector onchange handlers (two requests per selector change), and the
// arriving response then re-rendered the main table via _irRecoRefreshVelocityCells_. That was the
// "selecting a Country loads data" defect. Recompute the internal context; load nothing.
function onReplenRecoScopeChanged() {
  updateReplenRecoContext();
}

window.updateReplenRecoContext = updateReplenRecoContext;
window.initReplenRecoContext = initReplenRecoContext;
window.onReplenRecoScopeChanged = onReplenRecoScopeChanged;
window._irSetInternalRecommendationContext = _irSetInternalRecommendationContext;

// ============================================================================
// F1-4B-B — Recommendation READ cutover (recommendation.workspace.get; default-false flags).
// ----------------------------------------------------------------------------
// When Recommendation Workspace mode is EFFECTIVE (Foundation workspaceApiActive('recommendation') —
// master USE_WORKSPACE_API + per-workspace recommendation, both ON) AND the F1-4B-B-PRE page context is
// READY, this issues ONE recommendation.workspace.get request per full page scope and maps the canonical
// response INTO the Recommendation Summary. The page ONLY validates context, sends the request, maps the
// response, and renders state — it authors NO formula, recomputes NONE of currentStockQty /
// qualifiedIncomingQty / calculatedGap / recommendedQty, imports no runtime module, performs NO write,
// creates NO Allocation Draft / Execution Plan route / Submit, and issues NO per-SKU HTTP loop and NO
// whole-DB reload. When flags are OFF the existing legacy Recommendation Summary (placeholders) is
// preserved verbatim. Note: the main results-table columns keep their existing (FBA/legacy) meaning and
// labels — the API's destination-scoped currentStockQty ≠ the table's FBA "Current Inventory", so the
// source-proven recommendation values are presented ONLY in the correctly-labeled Recommendation Summary.
// __IRRECO_START__ (test extraction marker — do not remove)
var _irRecoSeq = 0;              // monotonic request sequence (stale-response guard)
var _irRecoAbort = null;         // AbortController for the in-flight request (browser response invalidation)
function _irRecoBlank(status) {
  return { status: status || 'DISABLED', contextKey: null, requestId: null, lines: [], linesBySku: {},
    pagination: null, dataVersion: null, errors: [], updatedAt: null, seq: _irRecoSeq, scope: null,
    calculationMonth: null, planningCycle: null, loadedOk: false };
}
var _irRecoState = _irRecoBlank('DISABLED');   // page-local read state (separate from Allocation Draft state)

// Effective cutover predicate — the SINGLE source of truth (delegates to the Foundation effective logic).
function _irRecommendationWorkspaceEnabled() {
  return !!(window.KM && window.KM.api && typeof window.KM.api.workspaceApiActive === 'function' &&
    window.KM.api.workspaceApiActive('recommendation'));
}

// ---- F1-4B-FM3a · Suggested-Qty PRESENTATION aggregation (NOT a recommendation formula) --------------
// Sum ONLY source-proven, non-blocked, finite recommendedQty across a SKU's canonical destination lines.
// Excludes provisional (provisionalOrderNeed), blocked lines, null/non-finite recommendedQty, and residual
// shortage. A legitimate canonical 0 is INCLUDED (valid zero). Returns { total, actionableCount } — the
// caller shows the numeric total when actionableCount>0, else an honest "—" (never a fake 0). No gap /
// stock / forecast / incoming / carton math here — pure read-side summation of already-computed canonical
// recommendedQty values.
function _irAggregateActionableRecommendedQty(lines) {
  var total = 0, actionableCount = 0;
  (lines || []).forEach(function (L) {
    if (!L || L.blocked === true) return;                 // blocked → not actionable
    var q = L.recommendedQty;
    if (typeof q !== 'number' || !isFinite(q)) return;    // null / provisional-only / missing → excluded
    total += q; actionableCount++;
  });
  return { total: total, actionableCount: actionableCount };
}

// ---- F1-4B-FM3a · bounded SESSION cache for successful Recommendation READ results -------------------
// Session-only (sessionStorage + in-memory mirror). Prevents a redundant recommendation.workspace.get on
// repeated navigation / re-expand of the SAME canonical scope. NEVER localStorage/IndexedDB/DB. Only a
// SUCCESSFUL canonical envelope is stored (blocked lines and valid zero ARE valid successes and cacheable);
// transport/API failure, CONFIG_NOT_READY, aborted, and stale responses are NEVER stored. JSON-safe record;
// the canonical envelope is never mutated.
var _IR_RECO_CACHE_KEY = 'km_ir_reco_cache_v1';
var _irRecoCacheMem = null;                                // lazy in-memory mirror of the session store
function _irRecoCacheLoad() {
  if (_irRecoCacheMem) return _irRecoCacheMem;
  _irRecoCacheMem = {};
  try {
    if (typeof sessionStorage !== 'undefined') {
      var raw = sessionStorage.getItem(_IR_RECO_CACHE_KEY);
      if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') _irRecoCacheMem = o; }
    }
  } catch (e) { _irRecoCacheMem = {}; }
  return _irRecoCacheMem;
}
function _irRecoCachePersist() {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(_IR_RECO_CACHE_KEY, JSON.stringify(_irRecoCacheMem || {})); } catch (e) {}
}
// Scope-only key (the Inventory request is company/country/marketplace scoped; server owns month/cycle).
function _irRecoCacheKey(scopeReq) {
  if (!scopeReq) return null;
  return [scopeReq.company || '', scopeReq.country || '', scopeReq.marketplace || ''].join('||');
}
function _irRecoCacheGet(scopeReq) {
  var k = _irRecoCacheKey(scopeReq); if (!k) return null;
  var e = _irRecoCacheLoad()[k];
  return (e && e.envelopeData) ? e : null;
}
function _irRecoCacheSet(scopeReq, env) {
  var k = _irRecoCacheKey(scopeReq); if (!k || !env || env.success !== true) return;   // successes only
  var c = _irRecoCacheLoad();
  c[k] = {
    requestScope: { company: scopeReq.company, country: scopeReq.country, marketplace: scopeReq.marketplace },
    envelopeData: (env.data && typeof env.data === 'object') ? env.data : {},
    meta: {
      requestId: (env.meta && env.meta.requestId) || null,
      calculationMonth: (env.meta && env.meta.calculationMonth) || null,
      planningCycle: (env.meta && env.meta.planningCycle) || null,
      dataVersion: (env.data && env.data.dataVersion) || null
    },
    cachedAt: (typeof Date !== 'undefined' && Date.now) ? Date.now() : null
  };
  _irRecoCacheMem = c; _irRecoCachePersist();
}
// Narrow programmatic invalidation (no UI this round). No arg → clear all; scopeReq → drop that key.
function invalidateRecommendationSessionCache(scopeReq) {
  var c = _irRecoCacheLoad();
  if (scopeReq === undefined || scopeReq === null) { _irRecoCacheMem = {}; }
  else { var k = _irRecoCacheKey(scopeReq); if (k && c[k]) { delete c[k]; _irRecoCacheMem = c; } }
  _irRecoCachePersist();
}

// explicit null/undefined/'' → null (preserve a legitimate 0; NEVER value || 0).
function _irNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v); return isFinite(n) ? n : null;
}
// F1-4B-FM2B: canonical server codes that mean "server configuration is incomplete" (calc-month Script
// Property) — distinct from a transport/API failure. Presented as CONFIG_NOT_READY with truthful wording.
function _irRecoIsConfigCode(code) {
  return code === 'RECOMMENDATION_CALCULATION_MONTH_NOT_CONFIGURED' || code === 'RECOMMENDATION_CALCULATION_MONTH_INVALID';
}
// F1-4B-FM1-T: the SCOPE-ONLY request context (company/country/marketplace). The server owns destination expansion
// + calculation month/cycle — the request NO LONGER depends on _irInternalContext destination/month/cycle.
// F1-7N-FB-4G-A1-R1 - THIS PREFERRED A CACHE THAT CAN PREDATE THE READ MODEL, AND THAT IS THE WHOLE DEFECT.
//
// Measured layer by layer on the shipped functions, in the shipped order:
//
//   MOUNT   initReplenRecoContext() -> updateReplenRecoContext(). The workspace read has NOT completed, so
//           _irWsGet('getMarketplaces') is [] and _replenSelectedScope() cannot resolve the selected
//           marketplace_id: {company:'', country:'US', marketplace:''}. The model is cached like that.
//   READ    the workspace lands; _replenSelectedScope() is now {ResUS, US, Amazon}. NOTHING recomputes
//           the cached model.
//   SEARCH  _irRecoTrigger -> loadInventoryGap_ -> here -> `_irctxLastContext ||` returns the MOUNT model
//           -> toScopeRequest -> null -> _irMatState.status = 'CONTEXT_NOT_READY'
//           -> the Summary prints "Select a valid Country / Marketplace" while the selectors read US/Amazon.
//
// A single recompute at step 3 yields {ResUS, US, Amazon} and the read is issued - proven by executing both.
// updateReplenRecoContext is a pure page-input recompute (its own contract: renders nothing, never calls the
// API, never writes), so asking it each time costs nothing and cannot be stale. The cached model stays for
// the callers that legitimately want the last computed CONTEXT; it is no longer the source of the SCOPE.
function _irRecoScopeRequest() {
  var model = (typeof updateReplenRecoContext === 'function') ? updateReplenRecoContext() : _irctxLastContext;
  if (!model || !window.IRContext || typeof window.IRContext.toScopeRequest !== 'function') return null;
  return window.IRContext.toScopeRequest(model);
}
// Map ONE canonical destination-node API line → the fields the summary renders (direct passthrough; no ||0).
function _irRecoMapLine(L) {
  L = L || {};
  return {
    recommendationLineId: L.recommendationLineId, recommendationMode: L.recommendationMode,
    sku: L.sku, siteSku: L.siteSku, destinationType: L.destinationType, destinationKey: L.destinationKey,
    destinationLabel: L.destinationLabel || L.destinationRefId || L.warehouseId || L.marketplaceId || null,
    warehouseId: L.warehouseId || null, marketplaceId: L.marketplaceId || null,
    allocatedForecastQty: _irNumOrNull(L.allocatedForecastQty), allocatedSalesQty: _irNumOrNull(L.allocatedSalesQty),
    currentStockQty: _irNumOrNull(L.currentStockQty), qualifiedIncomingQty: _irNumOrNull(L.qualifiedIncomingQty),
    incomingCompleteness: (L.incomingCompleteness == null ? null : String(L.incomingCompleteness)),
    calculatedGap: _irNumOrNull(L.calculatedGap), allocatedSupplyQty: _irNumOrNull(L.allocatedSupplyQty),
    recommendedQty: _irNumOrNull(L.recommendedQty), provisionalOrderNeed: _irNumOrNull(L.provisionalOrderNeed),
    residualShortageQty: _irNumOrNull(L.residualShortageQty),
    blocked: L.blocked === true, blockedReason: (L.blockedReason == null ? null : String(L.blockedReason)),
    formulaVersion: (L.formulaVersion == null ? null : String(L.formulaVersion)),
    sourceDataAsOf: (L.sourceDataAsOf == null ? null : String(L.sourceDataAsOf)),
    // F1-4B-FM4b: additive canonical D18/D30/D45/D90 day-horizon projection (server-owned; null when absent).
    // Pure passthrough — the page authors NO horizon math (no gap/covered/suggested computed here).
    horizons: Array.isArray(L.horizons) ? L.horizons.map(_irRecoMapHorizon) : null,
    // F1-4B-FM5-R4J-LIVE9: additive passthrough of the canonical Sales-Driven velocity basis the horizon engine
    // resolved (demandMode + KMCALC-normalized avgSalesPerDay + Site-Stock opening). The page authors NO rate here —
    // it CARRIES the server value so Avg Sales/day + Days of Supply align to the SAME authority as D18/D30/D45/D90.
    horizonBasis: (L.horizonBasis && typeof L.horizonBasis === 'object') ? {
      demandMode: (L.horizonBasis.demandMode == null ? null : String(L.horizonBasis.demandMode)),
      avgSalesPerDay: _irNumOrNull(L.horizonBasis.avgSalesPerDay),
      horizonOpeningQty: _irNumOrNull(L.horizonBasis.horizonOpeningQty),
      qualifiedIncomingCount: _irNumOrNull(L.horizonBasis.qualifiedIncomingCount)
    } : null,
    diagnostics: (L.diagnostics && Array.isArray(L.diagnostics.issues)) ? L.diagnostics.issues.slice() : []
  };
}
// F1-4B-FM4b: map ONE canonical horizon checkpoint → the fields the Horizon Summary renders (direct passthrough,
// preserve a legitimate 0; NEVER value || 0). The page computes NO gap/covered/suggested — all are server facts.
function _irRecoMapHorizon(h) {
  h = h || {};
  return {
    windowCode: (h.windowCode == null ? null : String(h.windowCode)),
    requiredByDate: (h.requiredByDate == null ? null : String(h.requiredByDate)),
    demandQty: _irNumOrNull(h.demandQty), openingSupplyQty: _irNumOrNull(h.openingSupplyQty),
    incomingAddedQty: _irNumOrNull(h.incomingAddedQty), coveredQty: _irNumOrNull(h.coveredQty),
    remainingSupplyQty: _irNumOrNull(h.remainingSupplyQty), gapQty: _irNumOrNull(h.gapQty),
    suggestedOrderQty: _irNumOrNull(h.suggestedOrderQty)
  };
}
// Apply a canonical envelope → state. Failure stays visible (never masked); success indexes lines by SKU
// (each SKU may carry MULTIPLE destination lines — MARKETPLACE and/or one per WAREHOUSE — kept distinct).
function _irRecoApplyEnvelope(env, ctxKey, reqScope) {
  if (!env || env.success !== true) {
    var _errs = (env && Array.isArray(env.errors) && env.errors.length) ? env.errors
      : [{ code: 'WORKSPACE_ERROR', message: 'Recommendation workspace request failed.', details: null }];
    // F1-4B-FM2B: a missing/malformed calculation-month Script Property is a CONFIG state (distinct from a
    // transport/API failure) — surfaced with its own status + wording, never "engine is not active".
    var _isConfig = _irRecoIsConfigCode(_errs[0] && _errs[0].code);
    _irRecoState = _irRecoBlank(_isConfig ? 'CONFIG_NOT_READY' : 'API_ERROR');
    _irRecoState.contextKey = ctxKey; _irRecoState.scope = reqScope;
    _irRecoState.errors = _errs;
    _irRecoState.requestId = (env && env.meta && env.meta.requestId) || null;
    return;
  }
  var data = env.data || {};
  var lines = Array.isArray(data.lines) ? data.lines : [];
  var bySku = {}, mapped = [];
  lines.forEach(function (L) { var m = _irRecoMapLine(L); mapped.push(m); (bySku[m.sku] = bySku[m.sku] || []).push(m); });
  _irRecoState = _irRecoBlank(lines.length ? 'READY' : 'EMPTY');
  _irRecoState.contextKey = ctxKey; _irRecoState.scope = reqScope;
  _irRecoState.lines = mapped; _irRecoState.linesBySku = bySku;
  _irRecoState.pagination = data.pagination || null; _irRecoState.dataVersion = data.dataVersion || null;
  _irRecoState.requestId = (env.meta && env.meta.requestId) || null;
  _irRecoState.calculationMonth = (env.meta && env.meta.calculationMonth) || null;
  _irRecoState.planningCycle = (env.meta && env.meta.planningCycle) || null;
  _irRecoState.updatedAt = (data.dataVersion && data.dataVersion.sourceDataAsOf) || null;   // server value, not browser clock
  _irRecoState.loadedOk = true;
}
// All destination lines for one page SKU (null when scope not loaded; [] when the SKU has no line).
function _irRecoLinesForSku(skuData) {
  if (!skuData || !_irRecoState.scope) return null;
  return _irRecoState.linesBySku[skuData.sku] || [];
}
// F1-4B-FM5-R4J-LIVE9: the canonical Sales-Driven velocity basis for a SKU, sourced (never recomputed) from the
// workspace MARKETPLACE line's horizonBasis — the SAME KMCALC-normalized rate the D18/D30/D45/D90 horizon uses.
// Returns null when the workspace read did not resolve a basis (→ caller keeps the existing weekly display; NO
// page-side sales-rate calculator, NO KMCALC call, NO DOM copy). Marketplace-grain (warehouse lines carry none).
function _irCanonicalSalesBasis_(sku) {
  if (sku == null || !_irRecoState || !_irRecoState.scope || !_irRecoState.linesBySku) return null;
  var lines = _irRecoState.linesBySku[String(sku)];
  if (!lines || !lines.length) return null;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] && lines[i].destinationType === 'MARKETPLACE' && lines[i].horizonBasis) return lines[i].horizonBasis;
  }
  return null;
}
// Invalidate any in-flight request (bump seq + abort browser response) and reset to a clean status.
function _irRecoInvalidate(status) {
  _irRecoSeq++;
  if (_irRecoAbort && _irRecoAbort.abort) { try { _irRecoAbort.abort(); } catch (e) {} }
  _irRecoAbort = null;
  _irRecoState = _irRecoBlank(status || 'CONTEXT_NOT_READY');
}

// The read cutover: at most ONE scope-only recommendation.workspace.get per READY scope. Deduped, stale-guarded.
// The server owns destination fanout + calc context, so a valid Country/Marketplace scope is the ONLY prerequisite.
function loadRecommendationWorkspace_() {
  if (!_irRecommendationWorkspaceEnabled()) { _irRecoInvalidate('DISABLED'); _irRecoRerenderSummaries(); return null; }
  var scopeReq = _irRecoScopeRequest();
  if (!scopeReq) { _irRecoInvalidate('CONTEXT_NOT_READY'); _irRecoRerenderSummaries(); return null; }
  var ctxKey = JSON.stringify(scopeReq);
  // dedupe: identical scope already loading or loaded → no duplicate request from repeated calls / renders
  if (_irRecoState.contextKey === ctxKey && (_irRecoState.status === 'LOADING' || _irRecoState.loadedOk)) return null;
  // F1-4B-FM3a SESSION CACHE HIT: a previously-successful canonical result for this exact scope → restore it
  // with ZERO HTTP (survives navigate-away/back + re-expand within the browser session). Abort any in-flight
  // request for a superseded scope and bump the sequence so a late response can't clobber the cached state.
  var cachedEntry = _irRecoCacheGet(scopeReq);
  if (cachedEntry) {
    if (_irRecoAbort && _irRecoAbort.abort) { try { _irRecoAbort.abort(); } catch (e) {} }
    _irRecoAbort = null; _irRecoSeq++;
    var cachedEnv = { success: true, data: cachedEntry.envelopeData,
      meta: Object.assign({ source: 'session-cache' }, cachedEntry.meta || {}), errors: [] };
    _irRecoApplyEnvelope(cachedEnv, ctxKey, scopeReq);
    _irRecoState.fromCache = true;
    _irRecoRerenderSummaries();
    _irRecoUpdateSuggestedCells();
    _irRecoRefreshVelocityCells_();   // LIVE9V: cache-hit path also refreshes the velocity cells to the canonical rate
    return null;
  }
  if (!(window.KM && window.KM.api && typeof window.KM.api.getWorkspace === 'function')) {
    _irRecoInvalidate('API_ERROR'); _irRecoState.contextKey = ctxKey;
    _irRecoState.errors = [{ code: 'WORKSPACE_UNAVAILABLE', message: 'Recommendation Workspace is enabled but the API client is unavailable.', details: null }];
    _irRecoRerenderSummaries(); return null;
  }
  var my = ++_irRecoSeq;
  if (_irRecoAbort && _irRecoAbort.abort) { try { _irRecoAbort.abort(); } catch (e) {} }
  _irRecoAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var signal = _irRecoAbort ? _irRecoAbort.signal : undefined;
  _irRecoState = _irRecoBlank('LOADING');
  _irRecoState.contextKey = ctxKey; _irRecoState.seq = my; _irRecoState.scope = scopeReq;
  _irRecoRerenderSummaries();
  var _t0 = (typeof Date !== 'undefined' && Date.now) ? Date.now() : null;   // client-latency stamp (diagnostic only)
  // ONE scope-only request (server expands destinations + loops SKUs internally — no per-SKU HTTP, no dest/month/cycle).
  var params = { scope: { company: scopeReq.company, country: scopeReq.country, marketplace: scopeReq.marketplace, sku: null, siteSku: null },
    filters: { lts: null, series: null, category: null, sku: null, siteSku: null },
    pagination: { page: 1, size: 100 }, include: { diagnostics: true } };
  return Promise.resolve(window.KM.api.getWorkspace('recommendation', params, { signal: signal })).then(function (env) {
    if (my !== _irRecoSeq) return;   // STALE_IGNORED — a newer scope superseded this response (never cached)
    _irRecoRecordDiag(_t0);
    _irRecoApplyEnvelope(env, ctxKey, scopeReq);
    _irRecoCacheSet(scopeReq, env);   // FM3a: cache ONLY a successful canonical envelope (guarded inside)
    _irRecoRerenderSummaries();
    _irRecoUpdateSuggestedCells();
    _irRecoRefreshVelocityCells_();   // LIVE9V: re-render Avg Sales/day + Days of Supply with the now-loaded canonical rate
  }).catch(function (err) {
    if (my !== _irRecoSeq) return;
    _irRecoRecordDiag(_t0);
    _irRecoState = _irRecoBlank('API_ERROR'); _irRecoState.contextKey = ctxKey; _irRecoState.seq = my;
    _irRecoState.errors = [{ code: (err && err.apiCode) || 'PAGE_READ_FAILED', message: String(err && err.message || err), details: null }];
    _irRecoRerenderSummaries();
  });
}
// F1-4B-FM2A: push the client-side latency for the Inventory consumer into the safe Foundation diagnostic
// (guarded — a no-op when the recorder is absent, e.g. unit tests with a stubbed api).
function _irRecoRecordDiag(t0) {
  if (t0 == null || !(window.KM && window.KM.api && typeof window.KM.api.recordRecommendationDiagnostic === 'function')) return;
  try { window.KM.api.recordRecommendationDiagnostic({ lastClientDurationMs: Date.now() - t0 }); } catch (e) {}
}

// ---- Recommendation Summary presentation (workspace vs legacy) --------------------------------------
function _legacyRecSummaryTableHtml(skuData) {
  return '<table class="replen-recsum-table">'
    + '<thead><tr><th>Window</th><th class="replen-recsum-table__num">Calculated Gap</th>'
    + '<th class="replen-recsum-table__num">Recommended Qty</th><th>Route</th><th>Reason</th></tr></thead>'
    + '<tbody>' + _recSummaryRows(skuData) + '</tbody></table>';
}
// Inner diagnostics content (issue list + version meta) WITHOUT the <details> wrapper, so callers can compose
// it inside a single Diagnostics section (avoids nested <details>). Returns '' when nothing to show.
function _irRecoDiagnosticsInnerHtml(line) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  var items = [];
  (line.diagnostics || []).forEach(function (d) {
    var code = (d && d.code) ? '<code>' + esc(d.code) + '</code> ' : '';
    var msg = esc((d && d.message) ? d.message : (typeof d === 'string' ? d : ''));
    items.push('<li>' + code + msg + '</li>');
  });
  var meta = [];
  if (line.formulaVersion) meta.push('formulaVersion: ' + esc(line.formulaVersion));
  if (line.sourceDataAsOf) meta.push('sourceDataAsOf: ' + esc(line.sourceDataAsOf));
  if (_irRecoState.requestId) meta.push('requestId: ' + esc(_irRecoState.requestId));
  if (!items.length && !meta.length) return '';
  return (items.length ? ('<ul>' + items.join('') + '</ul>') : '')
    + (meta.length ? ('<div class="replen-recsum-ws__meta">' + meta.join(' · ') + '</div>') : '');
}
function _irRecoDiagnosticsHtml(line) {
  var inner = _irRecoDiagnosticsInnerHtml(line);
  if (!inner) return '';
  return '<details class="replen-recsum-ws__diag"><summary>Diagnostics</summary>' + inner + '</details>';
}
// F1-4B-FM1-T minimal destination presentation — ONE compact row per response destination (MARKETPLACE and/or
// each WAREHOUSE). Distinguishes canonical / valid-zero / blocked / partial-provisional / missing-rule /
// source-insufficient (residual) / API-error / no-line. No Execution-Plan mutation, Submit, or persistence here.
function _irRecoDestModeLabel(mode) {
  if (mode === 'MARKETPLACE_ORDER_NEED') return 'Marketplace Order Need';
  if (mode === 'WAREHOUSE_REPLENISHMENT') return 'Warehouse Replenishment';
  return mode || '—';
}
function _irRecoDestRowHtml(line) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  function num(v) { return (v === null || v === undefined) ? '—' : esc(String(v)); }
  var status, statusCls, recCell;
  var reason = line.blockedReason ? ('<code>' + esc(line.blockedReason) + '</code>') : '';
  if (line.blocked) {
    if (line.incomingCompleteness === 'PARTIAL' || line.incomingCompleteness === 'UNAVAILABLE') {
      status = 'Partial incoming — provisional'; statusCls = 'is-partial';
      recCell = '<span class="replen-recsum-ws__provisional">prov. ' + num(line.provisionalOrderNeed) + '</span>';
    } else { status = 'Blocked'; statusCls = 'is-blocked'; recCell = '—'; }
  } else if (line.recommendedQty === 0) {
    status = 'No replenishment needed'; statusCls = 'is-zero'; recCell = '0';
  } else {
    var short = (typeof line.residualShortageQty === 'number' && line.residualShortageQty > 0);
    status = short ? ('Source short by ' + num(line.residualShortageQty)) : 'OK';
    statusCls = short ? 'is-short' : 'is-ok'; recCell = num(line.recommendedQty);
  }
  var demand = (line.recommendationMode === 'MARKETPLACE_ORDER_NEED') ? line.calculatedGap : line.allocatedForecastQty;
  return '<tr class="' + statusCls + '">'
    + '<td>' + esc(line.destinationLabel) + '</td>'
    + '<td>' + esc(_irRecoDestModeLabel(line.recommendationMode)) + '</td>'
    + '<td class="replen-recsum-table__num">' + num(demand) + ' / ' + num(line.calculatedGap) + '</td>'
    + '<td class="replen-recsum-table__num">' + num(line.currentStockQty) + '</td>'
    + '<td class="replen-recsum-table__num">' + num(line.qualifiedIncomingQty) + (line.incomingCompleteness && line.incomingCompleteness !== 'COMPLETE' ? (' <em>(' + esc(line.incomingCompleteness) + ')</em>') : '') + '</td>'
    + '<td class="replen-recsum-table__num">' + recCell + '</td>'
    + '<td>' + esc(status) + '</td>'
    + '<td>' + reason + '</td>'
    + '</tr>';
}
// ---- F1-4B-FM4b · Horizon Summary (the PRIMARY decision surface) -------------------------------------
// Renders the server-owned D18/D30/D45/D90 CUMULATIVE checkpoints for ONE destination line. The page does
// NO horizon math: Window/Required By/Demand/Covered/Gap/Suggested come verbatim from line.horizons[]. A
// legitimate canonical 0 renders "0"; a missing/unavailable value renders "—". The four windows are cumulative
// checkpoints and are NEVER summed together. A short destination-type badge ("Warehouse" / "Marketplace") is
// shown for identity — deliberately NOT the "Warehouse Replenishment" mode phrase (that stays in Diagnostics).
var _IR_HORIZON_WINDOWS = [{ code: 'D18', label: '18 Days' }, { code: 'D30', label: '30 Days' }, { code: 'D45', label: '45 Days' }, { code: 'D90', label: '90 Days' }];
function _irRecoDestTypeBadge(line) {
  if (line.destinationType === 'WAREHOUSE') return 'Warehouse';
  if (line.destinationType === 'MARKETPLACE') return 'Marketplace';
  return line.destinationType || '';
}
function _irRecoHorizonTableHtml(line) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  function num(v) { return (v === null || v === undefined) ? '—' : esc(String(v)); }   // valid 0 → "0"; missing → "—"
  var byWin = {};
  (line.horizons || []).forEach(function (h) { if (h && h.windowCode) byWin[h.windowCode] = h; });
  var rows = _IR_HORIZON_WINDOWS.map(function (w) {
    var h = byWin[w.code];
    if (!h) return '<tr class="is-missing"><td>' + w.label + '</td><td>—</td>'
      + '<td class="replen-recsum-table__num">—</td><td class="replen-recsum-table__num">—</td>'
      + '<td class="replen-recsum-table__num">—</td><td class="replen-recsum-table__num">—</td></tr>';
    return '<tr>'
      + '<td>' + w.label + '</td>'
      + '<td>' + (h.requiredByDate ? esc(h.requiredByDate) : '—') + '</td>'
      + '<td class="replen-recsum-table__num">' + num(h.demandQty) + '</td>'
      + '<td class="replen-recsum-table__num">' + num(h.coveredQty) + '</td>'
      + '<td class="replen-recsum-table__num">' + num(h.gapQty) + '</td>'
      + '<td class="replen-recsum-table__num">' + num(h.suggestedOrderQty) + '</td>'
      + '</tr>';
  }).join('');
  return '<table class="replen-horizon-table replen-horizon-table--detail"><thead><tr>'
    + '<th>Window</th><th>Required By</th><th class="replen-recsum-table__num">Demand</th>'
    + '<th class="replen-recsum-table__num">Covered</th><th class="replen-recsum-table__num">Gap</th>'
    + '<th class="replen-recsum-table__num">Suggested</th></tr></thead><tbody>' + rows + '</tbody></table>';
}
// F1-4B-FM6 · truthful per-window Note derived ONLY from the canonical gap (no page formula): missing → "—";
// valid zero → "No shortage"; positive gap → "Replenishment required".
function _irRecoHorizonNote_(h) {
  if (h && h.note != null && String(h.note) !== '') return String(h.note);   // explicit truthful note (e.g. a BLOCKED reason) wins
  if (!h || typeof h.gapQty !== 'number' || !isFinite(h.gapQty)) return '—';
  return h.gapQty <= 0 ? 'No shortage' : 'Replenishment required';
}
// F1-4B-FM6 · FROZEN PRIMARY surface — the compact decision table: Window | Gap | Suggested Qty | Note ONLY.
// Required By is a subtle sub-line under Window (not a column). Demand/Covered and all technical fields live under
// Diagnostics. Valid 0 → "0"; missing → "—". The table is wrapped in an overflow-x container so a very large
// number or a narrow viewport scrolls INTERNALLY and never overflows the SKU card.
function _irRecoHorizonOutlookTableHtml(line) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  function num(v) { return (v === null || v === undefined) ? '—' : esc(String(v)); }
  var byWin = {};
  (line.horizons || []).forEach(function (h) { if (h && h.windowCode) byWin[h.windowCode] = h; });
  // F1-4B-FM5-R4UI-R4 §3 — TRUE fixed schema: the four windows ALWAYS render, each cell carries a stable identity
  // (data-ir-gap-window / data-ir-suggested-window / data-ir-note-window) so async data PATCHES cell content in place
  // (see _irRecoPatchSummaryCells) instead of regenerating the table. Missing/absent data → "—"/"…", never dropped.
  var rows = _IR_HORIZON_WINDOWS.map(function (w) {
    var h = byWin[w.code];
    var by = (h && h.requiredByDate) ? ('<span class="replen-horizon-by">by ' + esc(h.requiredByDate) + '</span>') : '';
    var winCell = '<td class="replen-horizon-table__win"><span class="replen-horizon-win">' + w.label + '</span>' + by + '</td>';
    var gap = h ? num(h.gapQty) : '—', sug = h ? num(h.suggestedOrderQty) : '—', note = h ? esc(_irRecoHorizonNote_(h)) : '—';
    return '<tr' + (h ? '' : ' class="is-missing"') + '>' + winCell
      + '<td class="replen-recsum-table__num" data-ir-gap-window="' + w.code + '">' + gap + '</td>'
      + '<td class="replen-recsum-table__num" data-ir-suggested-window="' + w.code + '">' + sug + '</td>'
      + '<td class="replen-horizon-table__note" data-ir-note-window="' + w.code + '">' + note + '</td>'
      + '</tr>';
  }).join('');
  return '<div class="replen-horizon-tablewrap"><table class="replen-horizon-table replen-horizon-table--outlook" data-ir-summary="1"><thead><tr>'
    + '<th class="replen-horizon-table__win">Window</th><th class="replen-recsum-table__num">Gap</th>'
    + '<th class="replen-recsum-table__num">Suggested Qty</th><th class="replen-horizon-table__note">Note</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}
// ONE destination subsection (MARKETPLACE → one; WAREHOUSE → one per warehouse; never pooled). Blocked and
// horizon-unavailable states are shown truthfully instead of a fabricated table.
function _irRecoHorizonSectionHtml(line) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  var badge = _irRecoDestTypeBadge(line);
  var head = '<div class="replen-horizon-dest"><div class="replen-horizon-dest__hd">'
    + '<span class="replen-horizon-dest__name">' + esc(line.destinationLabel || '—') + '</span>'
    + (badge ? (' <span class="replen-horizon-dest__badge">' + esc(badge) + '</span>') : '');
  if (line.blocked) {
    var reason = line.blockedReason ? ('<code>' + esc(line.blockedReason) + '</code>') : 'blocked';
    if (line.incomingCompleteness === 'PARTIAL' || line.incomingCompleteness === 'UNAVAILABLE') {
      return head + '</div><div class="replen-horizon-dest__blocked">Partial incoming — provisional; horizon withheld ' + reason + '</div></div>';
    }
    return head + '</div><div class="replen-horizon-dest__blocked">Blocked — ' + reason + '</div></div>';
  }
  if (!line.horizons || !line.horizons.length) {
    return head + '</div><div class="replen-horizon-dest__na">Horizon projection unavailable for this destination. <code>HORIZONS_NOT_AVAILABLE</code></div></div>';
  }
  return head + '</div>' + _irRecoHorizonOutlookTableHtml(line) + '</div>';
}
// The legacy per-destination technical table (Destination/Mode/Demand-Gap/Stock/Incoming/Recommended/Status/
// Reason) — RELOCATED under Diagnostics (no longer the primary surface). Content preserved verbatim.
function _irRecoLegacyDestTableHtml(lines) {
  var rows = lines.map(_irRecoDestRowHtml).join('');
  return '<table class="replen-recsum-table replen-recsum-ws__table"><thead><tr>'
    + '<th>Destination</th><th>Mode</th><th class="replen-recsum-table__num">Demand / Gap</th>'
    + '<th class="replen-recsum-table__num">Stock</th><th class="replen-recsum-table__num">Incoming</th>'
    + '<th class="replen-recsum-table__num">Recommended</th><th>Status</th><th>Reason</th></tr></thead><tbody>'
    + rows + '</tbody></table>';
}
function _irRecoWorkspaceBody(skuData) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  function wrap(cls, inner) { return '<div class="replen-recsum-ws ' + cls + '" role="status" aria-live="polite">' + inner + '</div>'; }
  var st = _irRecoState;
  if (st.status === 'DISABLED') return _legacyRecSummaryTableHtml(skuData);   // safety net (should not reach when enabled)
  if (st.status === 'CONTEXT_NOT_READY') return wrap('replen-recsum-ws--info', 'Recommendation scope is not ready. Select a valid Country / Marketplace.');
  if (st.status === 'LOADING') return wrap('replen-recsum-ws--loading', 'Calculating recommendation…');
  if (st.status === 'CONFIG_NOT_READY') {
    var ce = (st.errors && st.errors[0]) || { code: 'RECOMMENDATION_CALCULATION_MONTH_NOT_CONFIGURED' };
    var crid = st.requestId ? (' <span class="replen-recsum-ws__reqid">[' + esc(st.requestId) + ']</span>') : '';
    return wrap('replen-recsum-ws--config', 'Recommendation configuration is incomplete: <code>' + esc(ce.code || 'RECOMMENDATION_CALCULATION_MONTH_NOT_CONFIGURED') + '</code>. Ask an administrator to set RECOMMENDATION_CALCULATION_MONTH.' + crid);
  }
  if (st.status === 'API_ERROR') {
    var e = (st.errors && st.errors[0]) || { code: 'API_ERROR', message: 'Recommendation request failed.' };
    var rid = st.requestId ? (' <span class="replen-recsum-ws__reqid">[' + esc(st.requestId) + ']</span>') : '';
    return wrap('replen-recsum-ws--error', 'Recommendation request failed: ' + esc(e.message || '') + ' <code>' + esc(e.code || 'API_ERROR') + '</code>' + rid);
  }
  if (st.status === 'EMPTY') return wrap('replen-recsum-ws--info', 'No SKU matched the current recommendation scope.');
  var lines = _irRecoLinesForSku(skuData);
  if (!lines || !lines.length) return wrap('replen-recsum-ws--info', 'No recommendation line for this SKU in the current scope. <code>RECOMMENDATION_LINE_NOT_FOUND</code>');
  var meta = [];
  if (st.calculationMonth) meta.push('month: ' + esc(st.calculationMonth));
  if (st.planningCycle) meta.push('cycle: ' + esc(st.planningCycle));
  if (st.requestId) meta.push('requestId: ' + esc(st.requestId));
  // PRIMARY surface: one Horizon Summary subsection per destination line (MARKETPLACE → one; WAREHOUSE →
  // one per warehouse; never pooled, never summed across windows).
  var sections = '<div class="replen-horizon-summary">' + lines.map(_irRecoHorizonSectionHtml).join('') + '</div>';
  var metaHtml = meta.length ? ('<div class="replen-recsum-ws__meta">' + meta.join(' · ') + '</div>') : '';
  // Technical destination/runtime detail is DEMOTED under a collapsed <details> — no longer the decision surface.
  // Wide tables (legacy destination table + the full horizon detail: Required By / Demand / Covered) scroll
  // INTERNALLY inside their own overflow-x container so they never widen or overflow the SKU card.
  var horizonDetail = lines.map(function (L) {
    return (L.horizons && L.horizons.length) ? ('<div class="replen-recsum-ws__scroll">' + _irRecoHorizonTableHtml(L) + '</div>') : '';
  }).join('');
  var diag = '<details class="replen-recsum-ws__diag replen-recsum-ws__diag--dest"><summary>Diagnostics</summary>'
    + '<div class="replen-recsum-ws__scroll">' + _irRecoLegacyDestTableHtml(lines) + '</div>'
    + horizonDetail + _irRecoDiagnosticsInnerHtml(lines[0]) + '</details>';
  return wrap('replen-recsum-ws--ready', sections + metaHtml + diag);
}
// The card body: MATERIALIZED read (FM5-R1) is the primary surface once a materialized load has occurred for the
// scope; else the live Workspace presentation (diagnostic/fallback); else the unchanged legacy table.
function _irRecoSummaryCardBody(skuData) {
  if (_irUseMaterializedGapRead() && _irMatState.status !== 'IDLE') return _irMatOutlookBody(skuData);
  if (!_irRecommendationWorkspaceEnabled()) return _legacyRecSummaryTableHtml(skuData);
  return _irRecoWorkspaceBody(skuData);
}

// ================= F1-4B-FM5-R1 · MATERIALIZED GAP READ (inventory_replenishment_gap) =================
// The normal page reads the STORED batch result — it does NOT run recommendation.workspace.get on expand and does
// NO gap math in the browser. recommendation.workspace.get is demoted to the batch owner + a diagnostic/fallback.
// Flag USE_MATERIALIZED_GAP_READ (default true) changes the READ SOURCE only — it is NOT a second engine.
function _irUseMaterializedGapRead() {
  if (typeof window !== 'undefined' && window.KM_FLAGS && typeof window.KM_FLAGS.USE_MATERIALIZED_GAP_READ === 'boolean') return window.KM_FLAGS.USE_MATERIALIZED_GAP_READ;
  return true;
}
var _irMatState = { status: 'IDLE', scopeKey: null, bySku: {}, rows: [], loadedOk: false, error: null };
var _irMatSeq = 0;
// Explicit numeric coercion: '' / null / undefined → null (renders "—", never a fabricated 0); a real number
// (including 0) is preserved. NO arithmetic — the stored value is displayed verbatim.
function _irMatNum(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(v); return isFinite(n) ? n : null; }
// STALE: only when the client is told the currently-expected calculation date and the stored row is older. No
// silent recalculation on expansion — a stale row is shown with a subtle indicator, never recomputed.
function _irMatExpectedCalcDate() { return (typeof window !== 'undefined' && window.KM_FLAGS && window.KM_FLAGS.EXPECTED_CALCULATION_DATE) ? String(window.KM_FLAGS.EXPECTED_CALCULATION_DATE) : null; }
function _irMatIsStale(row) { var exp = _irMatExpectedCalcDate(); var cd = row && row.calculation_date ? String(row.calculation_date) : ''; return !!(exp && cd && cd < exp); }
// Map ONE stored gap row → the frozen horizons-shaped line the FROZEN outlook renderer consumes (no new render).
// Map ONE stored gap row → the frozen horizons-shaped line the outlook renderer consumes (no new render, NO math).
// F1-4B-FM5-R4UI: a non-READY (BLOCKED/ERROR) row has blank gap cells → every window renders "—" plus the truthful
// stored reason (row.note, else the status) as its per-window Note. A READY row leaves note undefined so the
// per-window business Note is derived (No shortage / Replenishment required) from the stored gap. Stored values only.
function _irMatToLine(row) {
  var st = row.calculation_status ? String(row.calculation_status) : '';
  // F1-4B-FM5-R4UI-R5A §3 — the normal Recommendation Summary must NOT surface raw internal codes
  // (SALES_BASIS_* / HORIZONS_NOT_AVAILABLE / …). Show a short user-safe note; the technical row.note stays in the
  // DB and is still visible under Diagnostics (IR_DEBUG_DIAGNOSTICS). READY rows keep the derived business note.
  var reason = (st && st !== 'READY') ? 'Calculation unavailable' : null;
  function hz(code, g, s) { var h = { windowCode: code, gapQty: _irMatNum(g), suggestedOrderQty: _irMatNum(s) }; if (reason) h.note = reason; return h; }
  return {
    destinationType: 'MARKETPLACE', destinationLabel: null, calculationStatus: st,
    horizons: [
      hz('D18', row.d18_gap_qty, row.d18_suggested_qty),
      hz('D30', row.d30_gap_qty, row.d30_suggested_qty),
      hz('D45', row.d45_gap_qty, row.d45_suggested_qty),
      hz('D90', row.d90_gap_qty, row.d90_suggested_qty)
    ]
  };
}
// F1-4B-FM5-R4UI: panel-level engineering metadata (calculation_status / calc date / as-of / aggregate note) is
// DEMOTED under a collapsed Diagnostics section — it is NOT part of the normal presentation. Only the actionable
// "stale" warning stays visible in the normal view (business signal → run Recalculate All Sites). The per-window
// business Note remains in the primary table.
// F1-4B-FM5-R4UI-R4 §3 — the normal user-facing card shows ONLY the fixed 4-row table + (when applicable) the
// actionable "stale" business banner. Engineering metadata (status / calc date / as-of / aggregate note) is NO
// LONGER shown in production — it is emitted ONLY when the developer debug flag is explicitly enabled
// (window.KM_FLAGS.IR_DEBUG_DIAGNOSTICS === true). This removes the collapsed Diagnostics control from ordinary UI.
function _irRecoDebugDiagnosticsEnabled() { return !!(typeof window !== 'undefined' && window.KM_FLAGS && window.KM_FLAGS.IR_DEBUG_DIAGNOSTICS === true); }
function _irMatMetaHtml(row) {
  function esc(v) { return escapeReplenHtml(v == null ? '' : v); }
  var stale = _irMatIsStale(row) ? '<div class="replen-recsum-ws__meta"><span class="replen-mat-stale">⚠ stale — run Recalculate All Sites</span></div>' : '';
  if (!_irRecoDebugDiagnosticsEnabled()) return stale;   // production: no Diagnostics control in the normal card
  var bits = [];
  if (row.calculation_status) bits.push('status: ' + esc(row.calculation_status));
  if (row.calculation_date) bits.push('calc date: ' + esc(row.calculation_date));
  if (row.calculated_at) bits.push('as of ' + esc(row.calculated_at));
  if (row.note != null && String(row.note) !== '') bits.push('note: ' + esc(row.note));
  var diag = bits.length ? ('<details class="replen-recsum-ws__diag replen-recsum-ws__diag--mat"><summary>Diagnostics</summary><div class="replen-recsum-ws__meta">' + bits.join(' · ') + '</div></details>') : '';
  return stale + diag;
}
function _irMatOutlookBody(skuData) {
  function wrap(cls, inner) { return '<div class="replen-recsum-ws ' + cls + '" role="status" aria-live="polite">' + inner + '</div>'; }
  // F1-4B-FM5-R4UI-R5E §1 — TRUE FIXED SCHEMA (like Monthly Achievement): the fixed 4-window outlook table ALWAYS
  // exists from the moment the SKU expands, in EVERY load state. Loading / not-calculated / read-error only change
  // the per-window Note CELL + the wrapper's state class — they NEVER replace the table — so the card DOM and its
  // height are stable from expand and async data PATCHES cells in place (see _irRecoPatchSummaryCells). A response
  // never decides the table structure or height. Only the fixed 4-row table is the primary surface; panel-level
  // engineering metadata stays under the collapsed Diagnostics (debug-flag) section.
  function placeholderLine(note) {
    return { destinationType: 'MARKETPLACE', horizons: _IR_HORIZON_WINDOWS.map(function (w) { return { windowCode: w.code, gapQty: null, suggestedOrderQty: null, note: note }; }) };
  }
  var st = _irMatState, stateCls = 'replen-recsum-ws--ready', line, meta = '';
  if (st.status === 'CONTEXT_NOT_READY') { stateCls = 'replen-recsum-ws--info'; line = placeholderLine('Select a valid Country / Marketplace'); }
  else if (st.status === 'IDLE' || st.status === 'LOADING') { stateCls = 'replen-recsum-ws--loading'; line = placeholderLine('Loading…'); }
  else if (st.status === 'READ_ERROR') { stateCls = 'replen-recsum-ws--error'; line = placeholderLine('Calculation unavailable'); }
  else {
    var row = (skuData && _irMatState.bySku[String(skuData.sku)]) || null;
    if (!row) { stateCls = 'replen-recsum-ws--info'; line = placeholderLine('Not calculated'); }
    else { stateCls = 'replen-recsum-ws--ready'; line = _irMatToLine(row); meta = _irMatMetaHtml(row); }
  }
  var section = '<div class="replen-horizon-summary"><div class="replen-horizon-dest">'
    + _irRecoHorizonOutlookTableHtml(line) + '</div></div>';
  // F1-4B-FM6 — append the deterministic Recommended Action (from AI Plan) UNDER the fixed 4-row gap table; never
  // replaces it (the materialized gap display is preserved). Empty string until AI Plan generates for this SKU.
  return wrap(stateCls, section + meta + (typeof _irRecoActionHtml === 'function' ? _irRecoActionHtml(skuData) : ''));
}
// ONE materialized read per scope (deduped, stale-guarded). Reads STORED rows; no calculation, no per-SKU HTTP.
function loadInventoryGap_(force) {
  if (!_irUseMaterializedGapRead()) return null;
  var scopeReq = _irRecoScopeRequest();
  if (!scopeReq) { _irMatState = { status: 'CONTEXT_NOT_READY', scopeKey: null, bySku: {}, rows: [], loadedOk: false, error: null }; _irRecoRerenderSummaries(); return null; }
  var key = JSON.stringify(scopeReq);
  if (!force && _irMatState.scopeKey === key && _irMatState.loadedOk) { _irRecoRerenderSummaries(); return null; }
  if (!(window.KM && window.KM.DB && typeof window.KM.DB.getInventoryReplenishmentGap === 'function')) {
    _irMatState = { status: 'READ_ERROR', scopeKey: key, bySku: {}, rows: [], loadedOk: false, error: { code: 'READER_UNAVAILABLE', message: 'materialized gap reader unavailable' } };
    _irRecoRerenderSummaries(); return null;
  }
  var my = ++_irMatSeq;
  _irMatState = { status: 'LOADING', scopeKey: key, bySku: {}, rows: [], loadedOk: false, error: null };
  _irRecoRerenderSummaries();
  return Promise.resolve(window.KM.DB.getInventoryReplenishmentGap(scopeReq)).then(function (res) {
    if (my !== _irMatSeq) return;
    if (!res || !res.success) { _irMatState = { status: 'READ_ERROR', scopeKey: key, bySku: {}, rows: [], loadedOk: false, error: (res && res.error) || { code: 'READ_FAILED', message: 'materialized gap read failed' } }; _irRecoRerenderSummaries(); return; }
    var rows = (res.data && res.data.rows) || [];
    var bySku = {}; rows.forEach(function (r) { if (r && r.sku != null) bySku[String(r.sku)] = r; });
    _irMatState = { status: rows.length ? 'READY' : 'EMPTY', scopeKey: key, bySku: bySku, rows: rows, loadedOk: true, error: null };
    _irRecoRerenderSummaries(); _irRecoUpdateSuggestedCells();
  }).catch(function (err) {
    if (my !== _irMatSeq) return;
    _irMatState = { status: 'READ_ERROR', scopeKey: key, bySku: {}, rows: [], loadedOk: false, error: { code: 'READ_FAILED', message: String(err && err.message || err) } };
    _irRecoRerenderSummaries();
  });
}
// Manual-recalc refresh: invalidate the materialized cache + refetch the stored rows (no per-SKU live calc).
function refreshInventoryGapAfterRecalc_() { _irMatState.loadedOk = false; _irMatState.scopeKey = null; return loadInventoryGap_(true); }
window.loadInventoryGap_ = loadInventoryGap_;
// Re-render any OPEN Recommendation Summary card(s) from the current read state (no full-page overlay).
// F1-7N-FB-4G-A1 - the RENDER half, kept under its own name. _irRecoRerenderSummaries below is the name
// every existing caller uses and now also reports the recommendation side's settle to the reveal barrier.
// Two `function` declarations of ONE name in ONE scope do not compose - the second simply replaces the
// first - so the base has its own name rather than being captured from a variable.
function _irRecoRerenderSummariesRender_() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  var cards = document.querySelectorAll('#ops-section .replen-card--recommendation-summary');
  if (!cards || !cards.length) return;
  var data = (typeof getReplenishmentData === 'function') ? (getReplenishmentData() || []) : [];
  Array.prototype.forEach.call(cards, function (card) {
    // F1-7N-FB-4G-A1-R1 - a card still behind ITS OWN barrier is not filled early; the recommendation gate's
    // paint builds it. This consults the RECOMMENDATION container only - the Execution Plan's state is not
    // read here and cannot hold this card back.
    if (card.parentNode && card.parentNode.getAttribute && card.parentNode.getAttribute('data-reveal-state') === 'pending') return;
    var sku = String(card.id || '').replace('recommendation-summary-', '');
    var skuData = null; for (var i = 0; i < data.length; i++) { if (data[i].sku === sku) { skuData = data[i]; break; } }
    // F1-4B-FM5-R4UI-R4 §3 — once the fixed 4-row schema exists in this card, a subsequent materialized-READY read
    // PATCHES the cell values in place (never regenerates the table). The full rebuild runs only on the FIRST render
    // or on a structural state change (loading / error / not-calculated / fallback mode).
    if (_irRecoPatchSummaryCells(card, skuData)) return;
    card.innerHTML = '<h4 class="replen-card__title">Recommendation Summary</h4>' + _irRecoSummaryCardBody(skuData);
  });
}
// F1-7N-FB-4G-A1 - _irRecoRerenderSummaries is called on EVERY transition of both recommendation read
// states (materialized gap and workspace alike), which makes it the single honest place to tell the barrier
// the recommendation side may have settled. It adds no listener, no interval and no request.
function _irRecoRerenderSummaries() {
  _irRecoRerenderSummariesRender_();
  // ONLY the recommendation side. This function runs on every recommendation read transition and on nothing
  // else, so telling the Execution Plan about it would be a coupling with no cause.
  if (typeof _irRevealPumpReco_ === 'function') _irRevealPumpReco_();
}
// Returns true when it patched an existing fixed-schema table in place (materialized READY row present); false when
// a full (re)build is required. Only cell text/notes change — the 4-row structure + identities are untouched.
function _irRecoPatchSummaryCells(card, skuData) {
  if (!_irUseMaterializedGapRead()) return false;
  if (_irMatState.status !== 'READY' && _irMatState.status !== 'EMPTY') return false;
  var table = card.querySelector && card.querySelector('[data-ir-summary]');
  if (!table) return false;
  var row = (skuData && _irMatState.bySku[String(skuData.sku)]) || null;
  // F1-4B-FM5-R4UI-R5E §1 — patch cells in place even when this SKU has no stored row (not-calculated): set the
  // window cells to "—" + a user-safe Note. NEVER fall through to an innerHTML rebuild once the skeleton exists,
  // so the summary DOM/height stays stable after any data load.
  var line = row ? _irMatToLine(row)
    : { horizons: _IR_HORIZON_WINDOWS.map(function (w) { return { windowCode: w.code, gapQty: null, suggestedOrderQty: null, note: 'Not calculated' }; }) };
  var byWin = {}; line.horizons.forEach(function (h) { if (h && h.windowCode) byWin[h.windowCode] = h; });
  function setCell(attr, code, val) { var c = table.querySelector('[data-ir-' + attr + '-window="' + code + '"]'); if (c) c.textContent = val; }
  _IR_HORIZON_WINDOWS.forEach(function (w) {
    var h = byWin[w.code];
    setCell('gap', w.code, (h && h.gapQty != null) ? String(h.gapQty) : '—');
    setCell('suggested', w.code, (h && h.suggestedOrderQty != null) ? String(h.suggestedOrderQty) : '—');
    setCell('note', w.code, _irRecoHorizonNote_(h));
  });
  return true;
}
// F1-4B-FM3a: repaint the main-table Suggested Qty cells from the current recommendation state (numeric
// actionable total per SKU) once the scope result is available (live or from the session cache). No table
// re-render — patches only the .replen-suggested-cell content, so nothing else in the row is disturbed.
function _irRecoUpdateSuggestedCells() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  var rows = document.querySelectorAll('#ops-section .scroll-row[data-sku]');
  if (!rows || !rows.length) return;
  var data = (typeof getReplenishmentData === 'function') ? (getReplenishmentData() || []) : [];
  Array.prototype.forEach.call(rows, function (row) {
    var cell = row.querySelector('.replen-suggested-cell'); if (!cell) return;
    var sku = row.getAttribute('data-sku');
    var skuData = null; for (var i = 0; i < data.length; i++) { if (data[i].sku === sku) { skuData = data[i]; break; } }
    cell.innerHTML = _irSuggestedCellHtml(skuData || { sku: sku });
  });
}
// F1-4B-FM5-R4J-LIVE9V — the canonical Sales-Driven velocity (horizonBasis.avgSalesPerDay) arrives via the ASYNC
// recommendation.workspace.get, which completes AFTER the synchronous main-table render. renderReplenishment()
// computes the Avg Sales/day + Days of Supply cells from _irCanonicalSalesBasis_, so those cells stay on the weekly
// fallback until the table is re-rendered — and neither _irRecoRerenderSummaries (summary cards) nor
// _irRecoUpdateSuggestedCells (Suggested cell) touches the velocity cells. This performs ONE bounded re-render of
// the main table once a Sales-Driven canonical basis has actually loaded, so the displayed Avg Sales/day + Days of
// Supply align to the same authority as the D-horizon. Guarded (only when a sales_driven basis is present) so a
// Forecast-only scope never re-renders; renderReplenishment does NOT re-fire the workspace read (no loop), and the
// scope read is deduped so this runs once per scope. NO recompute here — renderReplenishment is the sole owner.
function _irRecoHasSalesDrivenBasis_() {
  var by = _irRecoState && _irRecoState.linesBySku; if (!by) return false;
  for (var sku in by) { if (!by.hasOwnProperty(sku)) continue; var ls = by[sku] || [];
    for (var i = 0; i < ls.length; i++) { var b = ls[i] && ls[i].horizonBasis; if (b && b.demandMode === 'sales_driven' && b.avgSalesPerDay != null) return true; } }
  return false;
}
function _irRecoRefreshVelocityCells_() {
  // F1-7N-FB-2A §B — never repaint before a confirmed Search. renderReplenishment() enforces this itself, but
  // asserting it here keeps the intent explicit at the async call site that used to cause the surprise repaint.
  if (typeof _irSearchApplied_ === 'function' && !_irSearchApplied_() && !(typeof _replenDemoOn === 'function' && _replenDemoOn())) return;
  if (_irRecoState && _irRecoState.status === 'READY' && _irRecoHasSalesDrivenBasis_() && typeof renderReplenishment === 'function') renderReplenishment();
}
// __IRRECO_END__ (test extraction marker — do not remove)

window._irRecommendationWorkspaceEnabled = _irRecommendationWorkspaceEnabled;
window.loadRecommendationWorkspace_ = loadRecommendationWorkspace_;
window._irRecoSummaryCardBody = _irRecoSummaryCardBody;
window.invalidateRecommendationSessionCache = invalidateRecommendationSessionCache;

// ============================================================================
// Toolbar "More Options" dropdown (renamed 2026-07-23) — UI-only consolidation of the five data-management buttons
// (Add / Import / Edit / Delete SKU, Add Marketplace). Each item calls the EXISTING handler verbatim
// (no second flow); the menu just opens/closes accessibly. No business logic / payload / handler change.
// ============================================================================
var _replenActionsBound = false;
function _replenActionsEls() {
    return {
        menu: document.getElementById('replenActionsMenu'),
        trigger: document.getElementById('replenActionsTrigger'),
        list: document.getElementById('replenActionsList')
    };
}
function _replenActionsItems() {
    var e = _replenActionsEls();
    if (!e.list) return [];
    return Array.prototype.slice.call(e.list.querySelectorAll('.replen-actions-menu__item'))
        .filter(function (b) { return !b.disabled; });
}
function _replenActionsOpen() {
    var e = _replenActionsEls();
    if (!e.list || !e.trigger || !e.list.hidden) return;
    e.list.hidden = false;
    e.trigger.setAttribute('aria-expanded', 'true');
    if (e.menu) e.menu.classList.add('is-open');
    _replenBindActionsMenuGlobal();
    var first = _replenActionsItems()[0];
    if (first) first.focus();
}
function _replenActionsClose(returnFocus) {
    var e = _replenActionsEls();
    if (!e.list || e.list.hidden) return;
    e.list.hidden = true;
    if (e.trigger) e.trigger.setAttribute('aria-expanded', 'false');
    if (e.menu) e.menu.classList.remove('is-open');
    if (returnFocus && e.trigger) e.trigger.focus();
}
// Click trigger → toggle. stopPropagation so the just-fired click doesn't hit the outside-click closer.
function toggleReplenActionsMenu(ev) {
    if (ev) { try { ev.stopPropagation(); } catch (_e) {} }
    var e = _replenActionsEls();
    if (!e.list) return;
    if (e.list.hidden) _replenActionsOpen(); else _replenActionsClose(false);
}
// Run one action = reuse the EXISTING handler verbatim, then close the menu. One item → one handler
// call (no double-trigger). Each handler keeps its own selection / validation / confirmation / modal.
function runReplenAction(kind) {
    _replenActionsClose(false);
    if (kind === 'add' && typeof openReplenAddSkuModal === 'function') return openReplenAddSkuModal();
    if (kind === 'import' && typeof openReplenImportModal === 'function') return openReplenImportModal();
    if (kind === 'edit' && typeof openEditSkuModal === 'function') return openEditSkuModal();
    if (kind === 'delete' && typeof handleDeleteSku === 'function') return handleDeleteSku();
    if (kind === 'marketplace' && typeof openAddMarketplaceModal === 'function') return openAddMarketplaceModal();
    if (kind === 'demandAllocation' && typeof openReplenDemandAllocationModal === 'function') return openReplenDemandAllocationModal();
}
// Bind outside-click + keyboard once (guarded). Only acts while the menu is open.
function _replenBindActionsMenuGlobal() {
    if (_replenActionsBound) return;
    document.addEventListener('click', function (ev) {
        var e = _replenActionsEls();
        if (!e.list || e.list.hidden) return;
        if (ev.target && ev.target.closest && ev.target.closest('#replenActionsMenu')) return; // inside
        _replenActionsClose(false);
    });
    document.addEventListener('keydown', function (ev) {
        var e = _replenActionsEls();
        if (!e.list || e.list.hidden) return;
        var items = _replenActionsItems();
        if (!items.length) return;
        var idx = items.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); _replenActionsClose(true); }           // return focus to trigger
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); (items[(idx + 1) % items.length] || items[0]).focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); (items[(idx - 1 + items.length) % items.length] || items[items.length - 1]).focus(); }
        else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
        else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
        else if (ev.key === 'Tab') { _replenActionsClose(false); }                              // let focus leave naturally
    });
    _replenActionsBound = true;
}
window.toggleReplenActionsMenu = toggleReplenActionsMenu;
window.runReplenAction = runReplenAction;

// ============================================================================
// F1-UI-RUNTIME-CLOSURE-R1 — "AI Support" dropdown (AI Plan + Recalculate Current Scope + Recalculate All Sites).
// UI-only relocation out of the main toolbar. Each item REUSES the existing handler verbatim (no second gap engine,
// no duplicate recommendation engine). Same accessible open/close pattern as More Options; the existing outside-click
// closers mean opening one menu closes the other (one-at-a-time). Recalculate Current Scope uses the LIVE10 scoped
// gap-job wrapper (recalcInventoryGapCurrentScope → CURRENT_SCOPE payload), so scoped recalc IS backend-supported.
// ============================================================================
var _replenAiSupportBound = false;
function _replenAiEls() {
    return { menu: document.getElementById('replenAiSupportMenu'), trigger: document.getElementById('replenAiSupportTrigger'), list: document.getElementById('replenAiSupportList') };
}
function _replenAiItems() {
    var e = _replenAiEls();
    if (!e.list) return [];
    return Array.prototype.slice.call(e.list.querySelectorAll('.km-action-menu__item')).filter(function (b) { return !b.disabled; });
}
function _replenAiOpen() {
    var e = _replenAiEls();
    if (!e.list || !e.trigger || !e.list.hidden) return;
    e.list.hidden = false; e.trigger.setAttribute('aria-expanded', 'true'); if (e.menu) e.menu.classList.add('is-open');
    _replenBindAiSupportGlobal();
    var first = _replenAiItems()[0]; if (first) first.focus();
}
function _replenAiClose(returnFocus) {
    var e = _replenAiEls();
    if (!e.list || e.list.hidden) return;
    e.list.hidden = true; if (e.trigger) e.trigger.setAttribute('aria-expanded', 'false'); if (e.menu) e.menu.classList.remove('is-open');
    if (returnFocus && e.trigger) e.trigger.focus();
}
function toggleReplenAiSupportMenu(ev) {
    if (ev) { try { ev.stopPropagation(); } catch (_e) {} }
    var e = _replenAiEls(); if (!e.list) return;
    if (e.list.hidden) _replenAiOpen(); else _replenAiClose(false);
}
// F1-7N-FB-4E-R4B-R3 §4 — SITE INVENTORY'S AI SUPPORT NOW HAS A PLACE TO SPEAK.
//
// R4B-R1 gave Order Planning a notice surface OUTSIDE the menu panel and left this page without one, so even
// when the shared modal started throwing there was nowhere for the failure to appear. The menu is closed by the
// first line of runReplenAiSupport, and `.km-action-menu__panel[hidden] { display: none }` means anything painted
// into it is invisible — so the trigger (which stays on screen) and a body-mounted notice are the only two
// surfaces a click can use. Both are used here, and they mirror the Order Planning contract exactly.
var _irAiSupportTriggerOwner = null;          // 'aiplan' | 'recalc' | null — one owner at a time
function _irAiSupportTriggerEl_() { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('replenAiSupportTrigger') : null; }
function _irAiSupportTriggerBusy_(owner, text) {
    var t = _irAiSupportTriggerEl_(); if (!t) return false;
    if (_irAiSupportTriggerOwner && _irAiSupportTriggerOwner !== owner) return false;   // the other flow owns it
    _irAiSupportTriggerOwner = owner;
    if (t.dataset && t.dataset.idleLabel == null) t.dataset.idleLabel = t.textContent;
    t.textContent = '✦ ' + String(text == null ? '' : text);
    t.setAttribute('aria-busy', 'true');
    return true;
}
function _irAiSupportTriggerIdle_(owner) {
    var t = _irAiSupportTriggerEl_();
    if (_irAiSupportTriggerOwner && owner && _irAiSupportTriggerOwner !== owner) return;
    _irAiSupportTriggerOwner = null;
    if (!t) return;
    var idle = (t.dataset && t.dataset.idleLabel) ? t.dataset.idleLabel : '✦ AI Support';
    t.textContent = idle; t.removeAttribute('aria-busy');
    if (t.dataset) delete t.dataset.idleLabel;
}
// Its OWN id, so it never races the AI Plan RESULT panel (#replen-ai-plan-result) for one element.
function _irAiSupportNoticeEl_() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    var el = document.getElementById('replen-ai-support-notice');
    if (!el && document.body) {
        el = document.createElement('div');
        el.id = 'replen-ai-support-notice'; el.className = 'replen-ai-plan-result'; el.hidden = true;
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    return el || null;
}
function _irClearAiSupportNotice_() { var el = _irAiSupportNoticeEl_(); if (el) { el.hidden = true; el.innerHTML = ''; } }
// tone: 'ok' | 'info' | 'warn' | 'bad'. Returns TRUE when something visible was actually painted — the callers
// use the return value, so a missing DOM degrades to alert()/console rather than to silence.
function _irAiSupportNotice_(tone, title, message) {
    var el = _irAiSupportNoticeEl_();
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]; }); };
    if (el) {
        el.className = 'replen-ai-plan-result replen-ai-plan-result--' + (tone || 'info');
        el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
        el.setAttribute('aria-live', tone === 'bad' ? 'assertive' : 'polite');
        el.innerHTML = '<div class="replen-ai-plan-result__head"><span>' + esc(title) + '</span>' +
            '<button type="button" class="replen-ai-plan-result__close" onclick="_irClearAiSupportNotice_()" aria-label="Close">×</button></div>' +
            '<div class="replen-ai-plan-result__msg">' + esc(message) + '</div>';
        el.hidden = false;
        return true;
    }
    try { if (typeof window.alert === 'function') { window.alert(title + ' - ' + message); return true; } } catch (e) {}
    try { if (typeof console !== 'undefined' && console.error) console.error('[IR][AI_SUPPORT] ' + title + ' - ' + message); } catch (e) {}
    return false;
}
function _irAiActionTitle_(action) { return action === 'aiplan' ? 'AI Plan' : 'Recalculate Current Scope'; }
// One item -> one existing handler (no duplicated calculation logic). Close first so a backend job's button-state
// updates land on the (now-hidden) menu item without holding the menu open; everything this click has to say from
// here on is said on the trigger or in the notice, both of which stay visible.
// F1-AI-SUPPORT-SCOPE-R1: "AI Plan" and "Recalculate Current Scope" open the shared scope-selection modal so the
// user picks a CONCRETE Country / Marketplace before running; on Confirm they delegate to the SAME existing
// handlers (no new route/engine). "Recalculate All Sites" is unchanged (runs directly against the all-sites job).
function runReplenAiSupport(kind) {
    _replenAiClose(false);
    _irClearAiSupportNotice_();
    if (kind === 'aiplan') return _openReplenScopeModal('aiplan');
    if (kind === 'recalcScope') return _openReplenScopeModal('recalc');
    if (kind === 'recalcAll') {
        if (typeof handleRecalcAllInventoryGap === 'function') return handleRecalcAllInventoryGap();
        return _irAiSupportNotice_('bad', 'Recalculate All Sites', 'The recalculation handler is not available on this page. Nothing was run and nothing was changed.');
    }
    // An unrecognised item used to return undefined and leave the operator with a closed menu and no explanation.
    return _irAiSupportNotice_('bad', 'AI Support', 'Unrecognised action "' + String(kind) + '". Nothing was run and nothing was changed.');
}
// Prefill the modal from the current toolbar scope (DOM-held). The Marketplace select value is a marketplace_id
// on the live path; "All"/blank is left unselected (never silently treated as a concrete current scope — §6).
function _irScopeModalPrefill_() {
    var c = document.getElementById('replenCountry');
    var m = document.getElementById('replenMarketplace');
    return { country: (c && c.value) ? String(c.value) : '', marketplaceId: (m && m.value) ? String(m.value) : '' };
}
// F1-7N-FB-4E-R4B-R3 §4 — GUARD THE OUTCOME, NOT THE PRESENCE.
//
// The previous guard asked whether window.KM.scopeModal.open was a function. It WAS one. It threw on its first
// statement (see scope-select-modal.js), and a throw inside an inline onclick is swallowed by the browser — so
// "the module is loaded" and "the click did something" were being treated as the same fact for five days. They
// are now separate: the call is made inside a try, and a throw becomes a stated refusal that names the error.
function _irScopeModalUnavailable_(action, detail) {
    var msg = 'The scope selector could not be opened, so "' + _irAiActionTitle_(action) + '" was not started. '
        + 'Nothing was run and nothing was changed.' + (detail ? ' (' + detail + ')' : '')
        + ' Reload the page; if it repeats, assets/js/utils/scope-select-modal.js is missing or failed to load.';
    return _irAiSupportNotice_('bad', _irAiActionTitle_(action), msg);
}
function _openReplenScopeModal(action) {
    if (!(window.KM && window.KM.scopeModal && typeof window.KM.scopeModal.open === 'function')) {
        // Graceful fallback if the shared modal is unavailable: the argument-less current-on-screen scope path.
        // It is a FALLBACK, never a silent return — if the handler is missing too, the refusal is stated.
        if (action === 'aiplan' && typeof handleReplenAiPlan === 'function') return handleReplenAiPlan();
        if (action === 'recalc' && typeof recalcInventoryGapCurrentScope === 'function') return recalcInventoryGapCurrentScope();
        return _irScopeModalUnavailable_(action, 'SCOPE_MODAL_UNAVAILABLE');
    }
    try {
        window.KM.scopeModal.open({
            title: action === 'aiplan' ? 'AI Plan — Inventory' : 'Recalculate Current Scope — Inventory',
            subtitle: action === 'aiplan' ? 'Select the scope for AI Plan' : 'Select the scope to recalculate',
            confirmLabel: action === 'aiplan' ? 'Generate AI Plan' : 'Recalculate Scope',
            prefill: _irScopeModalPrefill_(),
            // A DISMISSED modal is an outcome. Without this the operator cannot tell "I cancelled" from
            // "the click vanished", which is the same class of silence this whole section exists to end.
            onCancel: function () {
                _irAiSupportNotice_('info', _irAiActionTitle_(action), 'Scope selection was cancelled. Nothing was run and nothing was changed.');
            },
            onConfirm: function (scope) {
                if (action === 'aiplan') {
                    if (typeof handleReplenAiPlan !== 'function') {
                        return _irAiSupportNotice_('bad', 'AI Plan', 'The AI Plan handler is not available on this page. Nothing was run and nothing was changed.');
                    }
                    _irAiSupportTriggerBusy_('aiplan', 'AI Plan…');
                    return handleReplenAiPlan(scope);
                }
                // EXISTING CURRENT_SCOPE gap job (LIVE10 contract) — one site scope = one existing job. No new route.
                if (typeof handleRecalcAllInventoryGap !== 'function') {
                    return _irAiSupportNotice_('bad', 'Recalculate Current Scope', 'The recalculation handler is not available on this page. Nothing was run and nothing was changed.');
                }
                _irAiSupportTriggerBusy_('recalc', 'Starting…');
                return handleRecalcAllInventoryGap({ mode: 'CURRENT_SCOPE', company: scope.company, country: scope.country, marketplace: scope.marketplace });
            }
        });
    } catch (e) {
        return _irScopeModalUnavailable_(action, String((e && e.message) || e));
    }
    return true;
}
function _replenBindAiSupportGlobal() {
    if (_replenAiSupportBound) return;
    document.addEventListener('click', function (ev) {
        var e = _replenAiEls();
        if (!e.list || e.list.hidden) return;
        if (ev.target && ev.target.closest && ev.target.closest('#replenAiSupportMenu')) return;
        _replenAiClose(false);
    });
    document.addEventListener('keydown', function (ev) {
        var e = _replenAiEls();
        if (!e.list || e.list.hidden) return;
        var items = _replenAiItems(); if (!items.length) return;
        var idx = items.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); _replenAiClose(true); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); (items[(idx + 1) % items.length] || items[0]).focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); (items[(idx - 1 + items.length) % items.length] || items[items.length - 1]).focus(); }
        else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
        else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
        else if (ev.key === 'Tab') { _replenAiClose(false); }
    });
    _replenAiSupportBound = true;
}
window.toggleReplenAiSupportMenu = toggleReplenAiSupportMenu;
window.runReplenAiSupport = runReplenAiSupport;
window._irAiSupportNotice_ = _irAiSupportNotice_;
window._irClearAiSupportNotice_ = _irClearAiSupportNotice_;
window._irAiSupportTriggerBusy_ = _irAiSupportTriggerBusy_;
window._irAiSupportTriggerIdle_ = _irAiSupportTriggerIdle_;

window.debugInventoryDemoData = function() {
    var enabled = window.KM && window.KM.DemoData && window.KM.DemoData.isEnabled && window.KM.DemoData.isEnabled();
    console.log('=== Inventory Demo Data Debug ===');
    console.log('Demo enabled:', enabled);
    if (!enabled) { console.log('Demo mode is OFF. Use setDemoDataMode(true) to enable.'); return; }
    var rows = window.KM.DemoData.getInventoryRows({});
    console.log('DemoData inventory rows:', rows.length);
    var mapped = _getDemoReplenishmentData();
    console.log('Mapped replenishment rows:', mapped.length);
    console.log('--- First 5 demo rows ---');
    console.table(rows.slice(0, 5));
    console.log('--- First 10 mapped rows ---');
    console.table(mapped.slice(0, 10));
};

// ========================================
// Lifecycle 註冊
// ========================================
// Ensure the Inventory Replenishment markup is present before initialization runs.
// Idempotent: if #ops-section already exists, resolves immediately (no re-fetch, no
// duplicate). Loads the partial via KM.partialLoader; on any failure it warns and resolves (never throws).
function _ensureInventoryReplenishmentMarkup() {
    if (document.getElementById('ops-section')) {
        return Promise.resolve(true);
    }
    if (window.KM && window.KM.partialLoader && window.KM.partialLoader.loadPartial) {
        return window.KM.partialLoader
            .loadPartial('inventory-replenishment', 'assets/html/pages/inventory-replenishment.html', '#inventory-replenishment-mount')
            .then(function() {
                if (!document.getElementById('ops-section')) {
                    console.warn('[Replenishment] partial loaded but #ops-section not found');
                }
                return true;
            })
            .catch(function(err) {
                console.warn('[Replenishment] failed to load partial:', err);
                return false;
            });
    }
    console.warn('[Replenishment] KM.partialLoader unavailable; markup not loaded.');
    return Promise.resolve(false);
}

// KM Sticky Header Framework binding for the Inventory Replenishment main table.
// The sticky control panel (.replen-control-panel) sits above the main table's two-layer header;
// its height varies (it wraps taller on small screens), so we measure it live and write
// --km-sticky-top-base onto #opsSection. The main table header (.table-header-bar) pins at that
// variable — replacing the old hard-coded top:72px that let the taller/wrapping panel cover the
// Current Stock / On the Way / Avg. Sales/day row. Reusable helper: KM.stickyHeader (core).
var _replenStickyHeaderHandle = null;
var _replenCatRailRO = null;
var _replenCatRailResizeHandler = null;
function _bindReplenStickyHeader() {
    if (!(window.KM && window.KM.stickyHeader && window.KM.stickyHeader.bindToolbar)) return;
    var root = document.getElementById('opsSection');            // .page-inventory (var scope)
    var toolbar = document.querySelector('#ops-section .replen-control-panel');
    if (!root || !toolbar) return;
    if (_replenStickyHeaderHandle && _replenStickyHeaderHandle.destroy) {
        _replenStickyHeaderHandle.destroy();
    }
    _replenStickyHeaderHandle = window.KM.stickyHeader.bindToolbar(root, toolbar);

    // Category rail is sticky just below the control panel; the main table header must pin a further
    // "category-rail height" down so the rail is never covered. Measure the rail's live height into
    // --km-replen-cat-rail-h (derived offset — NOT a hard-coded magic number). Re-measure on resize.
    var shell = document.querySelector('#ops-section .replen-category-shell');
    var measureCatRail = function () {
        var h = (shell && shell.getBoundingClientRect) ? Math.ceil(shell.getBoundingClientRect().height) : 0;
        root.style.setProperty('--km-replen-cat-rail-h', h + 'px');
    };
    measureCatRail();
    try { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureCatRail); } catch (e) {}
    if (_replenCatRailRO && _replenCatRailRO.disconnect) { try { _replenCatRailRO.disconnect(); } catch (e) {} _replenCatRailRO = null; }
    if (window.ResizeObserver && shell) {
        try { _replenCatRailRO = new ResizeObserver(measureCatRail); _replenCatRailRO.observe(shell); } catch (e) { _replenCatRailRO = null; }
    }
    if (_replenCatRailResizeHandler) window.removeEventListener('resize', _replenCatRailResizeHandler);
    _replenCatRailResizeHandler = measureCatRail;
    window.addEventListener('resize', _replenCatRailResizeHandler);
}

// One-time wiring of the modal-overlay close listener + overview scroll sync. These bind plain
// (non-cloneNode) listeners, so they must run EXACTLY once. Markup is partial-loaded (Phase 3-12),
// so this is a safe no-op until #ops-section exists; mount calls it again once the partial is present.
var _invReplenStaticInitDone = false;
function _inventoryReplenStaticInit() {
    if (_invReplenStaticInitDone) return;
    if (!document.getElementById('ops-section')) return;
    var overlay = document.getElementById('replen-modal-overlay');
    if (overlay) {
        overlay.addEventListener('click', function() {
            closeReplenModal();
            closeAddMarketplaceModal();
            closeEditSkuModal();
            closeReplenImportModal();
        });
    }
    _invReplenStaticInitDone = true;
}

if (window.KM && window.KM.lifecycle) {
    KM.lifecycle.register('ops-section', {
        mount() {
            console.log('[Replenishment] mount');
            // R6-R5 §4 — INTENT IS RECORDED BEFORE ANYTHING IS AWAITED. The markup is partial-loaded, so the
            // first thing this mount does is a fetch; without this line the arbiter would not know a Site
            // Inventory read is coming until after that fetch resolved, and the honest "preparing" state the
            // user must see from the first frame would have nothing to render from.
            try { if (window.KM && window.KM.bootArbiter) window.KM.bootArbiter.noteIntent('ops-section'); } catch (_eBA) {}
            // Migration compat: sweep any stale body-level Allocation Draft panel created by previously-loaded
            // (pre-fix) code before this page (re)owns it inside its own root.
            _removeLegacyBodyAllocPanel();
            // Markup is partial-loaded (Phase 3-12). Ensure it exists, then (re)apply the .active
            // class (showSection ran before the async injection on first open), wire the once-only
            // listeners, and run the existing initialization unchanged.
            _ensureInventoryReplenishmentMarkup().then(function() {
                var sec = document.getElementById('ops-section');
                if (sec) sec.classList.add('active');
                _inventoryReplenStaticInit();
                // KM Sticky Header Framework: drive --km-sticky-top-base from the sticky control
                // panel's LIVE height (it wraps taller on small screens), so the main table's
                // two-layer header pins right below it instead of being covered (hard-coded top:72px bug).
                _bindReplenStickyHeader();
                // Recovery: restore the Shipping Allocation Working Draft from sessionStorage (live
                // JS State). It is applied per-SKU only when the active Country/Marketplace context
                // matches the stored context (see _allocationDraftRowsFor); otherwise it stays dormant.
                _restoreAllocationDraftFromSession();
                if (typeof bindReplenFilterDependencies === 'function') bindReplenFilterDependencies();
                // F1-7I: the post-markup init (filter options + reco-context + first render). In Workspace mode this runs
                // AFTER the scoped read-model is fetched, so the filter dropdowns + primary render need NO broad Operation DB.
                var _irMountAfterLoad = function () {
                    if (typeof populateReplenFiltersFromRegistry === 'function') populateReplenFiltersFromRegistry();
                    // F1-7N-FB-3 §C — the mount requests ONLY the slim scope registry (one table, six columns)
                    // so the selectors are usable immediately. It issues ZERO inventoryReplenishment workspace
                    // reads and never puts the inventory table into a loading state — the table stays PRE_SEARCH.
                    // Its own loading/empty/error state renders beside the selectors, with its own Retry.
                    // F1-7N-FB-4E-R3 §B — one coherent bootstrap. With no remembered scope this is exactly the
                    // registry-only call it replaces; with one, the registry validation and the scoped workspace
                    // read run TOGETHER under one loading state and the table paints once, validated.
                    if (typeof _irBootstrapScope_ === 'function') { try { _irBootstrapScope_(); } catch (e) {} }
                    else if (typeof _irEnsureRegistryLoaded_ === 'function') { try { _irEnsureRegistryLoaded_(); } catch (e) {} }
                    // F1-4B-B-PRE: initialize the page-local Recommendation Context inputs (destination /
                    // calculation month / planning cycle). Populates options + restores explicit session
                    // selections + refreshes the readiness indicator. Does NOT call the Recommendation API.
                    if (typeof initReplenRecoContext === 'function') initReplenRecoContext();
                    renderReplenishment();
                    // F1-4B-FM5-R4UI-R5G §1 — bind the (event-driven) horizontal-scrollbar gutter measurement + seed it.
                    if (typeof _irBindHScrollGutterResizeOnce_ === 'function') _irBindHScrollGutterResizeOnce_();
                    if (typeof _irUpdateHScrollGutter_ === 'function') _irUpdateHScrollGutter_();
                    // F1-4B-FM5-R4J §13 — if a backend Inventory gap job is still PENDING/RUNNING (started here before a
                    // refresh, or from another tab / the daily scheduler), resume READ-ONLY status polling and refresh on
                    // DONE. The original tab does not need to have stayed alive.
                    if (typeof _irResumeGapJobOnMount_ === 'function') { try { _irResumeGapJobOnMount_(); } catch (e) {} }
                };
                // F1-7N-FA-3C-R6E-P0 — PRELOAD the carrier/method catalog ONCE per mount, in PARALLEL with the primary
                // read, so the Execution-Plan Method dropdown is warm before any row expand (the dedupe in
                // _irLoadCarrierPlanning_ means a later expand reuses this same in-flight/resolved fetch — never N fetches).
                // Independent of the primary render; never blocks it and never per-SKU.
                // F1-7N-FB-2A §B — THE mount fix. Previously this branch ran _irWorkspaceRefresh_() and then
                // _irMountAfterLoad -> renderReplenishment(), i.e. a full inventory workspace read AND a rendered
                // table on page open, for whatever Country/Marketplace the selectors defaulted to. The mount now
                // performs NO INVENTORY read: it wires the page, shows the pre-search state, and requests only
                // the slim scope registry (one table, six columns) so the selectors are usable immediately.
                // Every INVENTORY read belongs to Search. The carrier-catalog preload moved to _irApplySearch_ for
                // the same reason (it is only reachable from an expanded row, which requires a Search).
                _irMountAfterLoad();
            });
        },
        unmount() {
            console.log('[Replenishment] unmount');
            // Allocation Draft persistence panel is page-owned — drop its DOM node so it never lingers in layout on
            // other pages (the controller state in _allocWorkspace is retained; re-entering Inventory re-renders it
            // in-page). Also sweep any legacy body-level node.
            var _allocPanel = document.getElementById('alloc-draft-persistence-panel');
            if (_allocPanel && _allocPanel.remove) _allocPanel.remove();
            _removeLegacyBodyAllocPanel();
            // Release the sticky-header toolbar observer (ResizeObserver + resize listener).
            if (_replenStickyHeaderHandle && _replenStickyHeaderHandle.destroy) {
                _replenStickyHeaderHandle.destroy();
                _replenStickyHeaderHandle = null;
            }
            // Release the category-rail height observer (sticky offset for the table header).
            if (_replenCatRailRO && _replenCatRailRO.disconnect) { try { _replenCatRailRO.disconnect(); } catch (e) {} _replenCatRailRO = null; }
            if (_replenCatRailResizeHandler) { window.removeEventListener('resize', _replenCatRailResizeHandler); _replenCatRailResizeHandler = null; }
            // 清理展開面板中的 Chart.js 實例
            var expandPanels = document.querySelectorAll('#ops-section .replen-expand-panel');
            expandPanels.forEach(function(panel) { panel.remove(); });
            currentExpandedRow = null;
            // 清理 scroll sync
            var scrollCol = document.querySelector('#ops-section .scroll-col');
            if (scrollCol && scrollCol._syncHandler) {
                scrollCol.removeEventListener('scroll', scrollCol._syncHandler);
            }
            // F1-4B-B: invalidate any in-flight Recommendation Workspace request (bump seq + abort the
            // browser response) and reset the read state so it never applies to a later mount.
            if (typeof _irRecoInvalidate === 'function') _irRecoInvalidate('DISABLED');
        }
    });
}
