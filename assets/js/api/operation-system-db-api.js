// ========================================
// Operation System DB API Adapter
// Google Sheet read-only integration
// ========================================

const OP_DB_API_BASE_URL = 'https://script.google.com/macros/s/AKfycbzQSU0ZR4EW5F79EzpOoBvUDxjJNLZkLrPkFjuaCBwiWXZMBPR4jnxvIS0FZnjNnp9Q/exec';

// ========================================
// Configuration Check
// ========================================

function isOperationDbApiConfigured() {
    return OP_DB_API_BASE_URL &&
        OP_DB_API_BASE_URL !== 'PASTE_WEB_APP_EXEC_URL_HERE' &&
        OP_DB_API_BASE_URL.startsWith('https://script.google.com/');
}

function getOperationDbDataSourceMode() {
    if (!window._opDbCache) return 'not-loaded';
    // F1-7N-FA-3C-R6C — SCOPED-CACHE POISONING FIX. A scoped-table refresh (refreshCacheTables / refreshFactoryStockTables)
    // used to CREATE window._opDbCache WITHOUT a _sourceMode, so this default silently coerced a populated live cache into
    // the 'mock' posture → isScopedReadEligible() then returned false for the rest of the session → after SPA navigation
    // _roUseDb() was false and Order Planning showed a FALSE "No Request Order data available" (the R6C live incident:
    // useDb=false, lastEmptyReason=DB_UNAVAILABLE, while KM.DB itself was intact). The ABSENCE of an explicit marker is
    // NOT a mock posture — only an EXPLICIT 'mock' (unconfigured API / a real fetch-failure fallback, set at the load
    // paths below) is. Default an unmarked-but-populated cache to 'not-loaded' (scoped-read ELIGIBLE); writes still
    // require an explicit 'google-sheet' (isCloudWriteEnabled), so this never opens a write on an unconfirmed source.
    return window._opDbCache._sourceMode || 'not-loaded';
}

var OperationDbState = {
    data: null,
    dataSourceMode: 'not-loaded',
    lastLoadedAt: null,
    lastFetchUrl: '',
    lastFetchStatus: '',
    lastError: null
};

// ========================================
// API Fetch Functions
// ========================================

// F1-7N-FB-4E §A/§C — the WHOLE-DB reader had the same three gaps as the per-table one: an unbounded wait, a
// blind `resp.json()` that turned an HTML 404 into an opaque SyntaxError, and a bare status string that threw
// away which URL answered. It is the most expensive read in the system, so it is also the one whose failure
// most needs to be named rather than guessed at. Same shared classification, same bound, same thrown shape.
async function getOperationDbFromSheet() {
    if (!isOperationDbApiConfigured()) {
        var eCfg = new Error('Operation DB API not configured');
        eCfg.kmTransport = { code: 'API_ENDPOINT_CONFIGURATION_INVALID', phase: 'BUILD', retryable: false, action: 'getOperationDb' };
        throw eCfg;
    }
    var url = OP_DB_API_BASE_URL + '?action=getOperationDb&_ts=' + Date.now();
    var resp;
    try { resp = await _kmFetchBounded_(url, { method: 'GET', cache: 'no-store' }, 'read'); }
    catch (netErr) {
        var eNet = new Error(netErr && netErr.kmTimeout
            ? 'The whole-database read exceeded the client time limit and was aborted.'
            : 'Network error: ' + ((netErr && netErr.message) || netErr));
        eNet.kmTransport = { code: (netErr && netErr.kmTimeout) ? 'REQUEST_TIMEOUT' : 'HTTP_TRANSPORT_ERROR',
            phase: 'DISPATCH', retryable: true, action: 'getOperationDb' };
        throw eNet;
    }
    var text = ''; try { text = await resp.text(); } catch (e) { text = ''; }
    var cls = _kmClassifyAnswer_('getOperationDb', 'read', resp, text, url);
    if (!cls.ok) {
        OperationDbState.lastFetchStatus = 'error';
        var eCls = new Error(_kmTypedTransportMessage_('getOperationDb', cls));
        eCls.kmTransport = Object.assign({}, cls.typed, cls.wire);
        eCls.code = cls.legacyCode;
        throw eCls;
    }
    var json; try { json = JSON.parse(String(text).trim()); }
    catch (pe) {
        var ePar = new Error('The whole-database read returned a body that is not JSON.');
        ePar.kmTransport = { code: 'TRANSPORT_NON_JSON_RESPONSE', phase: 'PARSE', retryable: false, action: 'getOperationDb' };
        throw ePar;
    }
    if (!json.success) {
        var eBiz = new Error(json.error || 'API returned success=false');
        eBiz.kmTransport = { code: _kmIsUnknownActionResponse_(json.error) ? 'DEPLOYMENT_CONTRACT_MISMATCH' : 'BACKEND_BUSINESS_REJECTION',
            phase: 'CONTRACT_VALIDATE', retryable: false, action: 'getOperationDb' };
        throw eBiz;
    }
    OperationDbState.lastFetchUrl = url;
    OperationDbState.lastFetchStatus = 'success';
    return json.data;
}

// ============================================================================================================
// F1-7N-FB-4E §A/§C — THE THIRD TRANSPORT PATH, AND THE ONE THE FOUR HTML-404 PAGES ACTUALLY USE.
// ------------------------------------------------------------------------------------------------------------
// This reader is what `loadScopedTables` calls, which is what Factory Inventory, Overseas Inventory, FC Summary
// and Shipment Draft mount on. It had none of the protections the workspace path gained in earlier rounds, and
// every one of its four gaps shows up in the reported symptoms:
//
//   1. `await resp.json()` was a BLIND PARSE. An HTML body — a 404 page, a Google sign-in page, an expired
//      redirect target — became the opaque "Unexpected token '<' ... is not valid JSON", the exact failure
//      F1-4B-FM4b-R fixed for the workspace path and never for this one. Now read TEXT-FIRST and classified.
//   2. No BOUNDED wait. There was no timeout at all, so an unanswered request held the page mount open
//      indefinitely; the shared read bound now applies here as it does everywhere else.
//   3. `throw new Error('API returned ' + status)` DISCARDED the evidence — the final URL, whether a redirect
//      occurred, the content type and the body — which is why the live "HTTP 404, text/html" could not be
//      attributed to any of its four possible sources. The typed classification now rides on the thrown error.
//   4. It is called from a `Promise.all` FAN-OUT, so a four-table page opened FOUR simultaneous requests at
//      once. Apps Script and the Spreadsheet service are QUOTA'D AND CONTENDED, and unbounded client fan-out
//      raises peak request pressure — which raises the chance that one of the four is the one that fails, and
//      one rejection fails the whole `Promise.all`. See loadScopedTables for the bound that fixes that.
//
// The thrown-Error shape is preserved (callers catch and read `.message`), with the typed facts attached as
// properties so a page can render a real reason instead of an empty table.
// ============================================================================================================
async function getOperationDbTableFromSheet(tableName) {
    if (!isOperationDbApiConfigured()) {
        var eCfg = new Error('Operation DB API not configured');
        eCfg.kmTransport = { code: 'API_ENDPOINT_CONFIGURATION_INVALID', phase: 'BUILD', retryable: false, action: 'getTable' };
        throw eCfg;
    }
    var url = OP_DB_API_BASE_URL + '?action=getTable&table=' + encodeURIComponent(tableName) + '&_ts=' + Date.now();
    var resp;
    var _tt0 = Date.now();
    try { resp = await _kmFetchBounded_(url, { method: 'GET', cache: 'no-store' }, 'read'); }
    catch (netErr) {
        var eNet = new Error(netErr && netErr.kmTimeout
            ? 'The table read exceeded the client time limit and was aborted.'
            : 'Network error: ' + ((netErr && netErr.message) || netErr));
        eNet.kmTransport = { code: (netErr && netErr.kmTimeout) ? 'REQUEST_TIMEOUT' : 'HTTP_TRANSPORT_ERROR',
            phase: 'DISPATCH', retryable: true, action: 'getTable', table: tableName };
        throw eNet;
    }
    var text = ''; try { text = await resp.text(); } catch (e) { text = ''; }
    var cls = _kmClassifyAnswer_('getTable', 'read', resp, text, url);
    try { if (typeof _kmReportSample_ === 'function') _kmReportSample_('getTable', 'read', _tt0, cls.ok ? null : cls.typed.code, cls.ok ? 'SUCCESS' : cls.typed.phase, String(text || '').length); } catch (e) {}
    if (!cls.ok) {
        var eCls = new Error(_kmTypedTransportMessage_('getTable', cls));
        eCls.kmTransport = Object.assign({ table: tableName }, cls.typed, cls.wire);
        eCls.code = cls.legacyCode;
        throw eCls;
    }
    var json; try { json = JSON.parse(String(text).trim()); }
    catch (pe) {
        var ePar = new Error('The table read returned a body that is not JSON.');
        ePar.kmTransport = { code: 'TRANSPORT_NON_JSON_RESPONSE', phase: 'PARSE', retryable: false, action: 'getTable', table: tableName };
        throw ePar;
    }
    if (!json.success) {
        var eBiz = new Error(json.error || 'API returned success=false');
        eBiz.kmTransport = { code: _kmIsUnknownActionResponse_(json.error) ? 'DEPLOYMENT_CONTRACT_MISMATCH' : 'BACKEND_BUSINESS_REJECTION',
            phase: 'CONTRACT_VALIDATE', retryable: false, action: 'getTable', table: tableName };
        throw eBiz;
    }
    return (json.data && json.data.rows) || [];
}

// ========================================
// Normalize Functions
// ========================================

function normalizeSkuDetailsRecord(raw) {
    var r = raw || {};
    var category = String(r.category || '').trim();
    function s(v) { return String(v == null ? '' : v).trim(); }
    // Compose "L x W x H" (numeric only — unit lives in the column header / unit toggle).
    function dim3(l, w, h) {
        var a = [s(l), s(w), s(h)];
        if (a[0] === '' && a[1] === '' && a[2] === '') return '';
        return a.join(' × ');   // "L × W × H" (× is also accepted by the CM/IN converter)
    }
    // New split columns take priority; fall back to the legacy combined column when split is empty.
    var itemDim = dim3(r.item_length, r.item_width, r.item_height) || s(r.item_dimensions);
    var itemDim2 = dim3(r.item_length_2, r.item_width_2, r.item_height_2);   // secondary (display only)
    var packageDim = dim3(r.package_length, r.package_width, r.package_height) || s(r.package_dimensions);
    var cartonDim = dim3(r.carton_length, r.carton_width, r.carton_height) || s(r.carton_dimensions);
    return {
        sku: s(r.sku),
        productName: String(r.product_name || ''),
        productNameCn: String(r.product_name_cn || ''),   // Chinese customs/product name (nullable)
        productUse: s(r.product_use),                     // customs-facing product usage description (nullable)
        category: category,
        productLine: category,
        series: String(r.series || ''),
        lifecycle: String(r.lifecycle || 'Running in the Market'),
        image: String(r.image_url || ''),
        gs1Code: s(r.gs1_code),
        gs1Type: s(r.gs1_type),
        amzAsin: s(r.amz_asin),

        // --- Item dimensions (split + secondary + composed display) ---
        itemLength: s(r.item_length), itemWidth: s(r.item_width), itemHeight: s(r.item_height),
        itemLength2: s(r.item_length_2), itemWidth2: s(r.item_width_2), itemHeight2: s(r.item_height_2),
        itemDimensionUnit: s(r.item_dimension_unit),
        itemDimensions: itemDim,        // composed PRIMARY ("L x W x H") — drives the table + unit toggle
        itemDimensions2: itemDim2,      // composed SECONDARY ("" when *_2 all blank) — display only
        itemWeight: s(r.item_weight),
        itemWeightUnit: s(r.item_weight_unit),

        // --- Package dimensions ---
        packageLength: s(r.package_length), packageWidth: s(r.package_width), packageHeight: s(r.package_height),
        packageDimensionUnit: s(r.package_dimension_unit),
        packageDimensions: packageDim,
        packageWeight: s(r.package_weight),
        packageWeightUnit: s(r.package_weight_unit),

        // --- Carton dimensions (the logistics / CBM basis) ---
        cartonLength: s(r.carton_length), cartonWidth: s(r.carton_width), cartonHeight: s(r.carton_height),
        cartonDimensionUnit: s(r.carton_dimension_unit),
        cartonDimensions: cartonDim,
        cartonWeight: s(r.carton_weight),
        cartonWeightUnit: s(r.carton_weight_unit),
        unitsPerCarton: parseInt(r.units_per_carton) || 0,

        // --- Product attributes (SKU Domain v2.0) ---
        material: s(r.material),
        batteryType: s(r.battery_type),
        magnetType: s(r.magnet_type),

        // --- Brand baseline price (v2.0: single base_currency for all three) ---
        minimumPrice: s(r.minimum_price),
        msrp: s(r.msrp),
        sellingPrice: s(r.selling_price),
        // base_currency is canonical; fall back to legacy *_unit only when blank (read-only migration aid).
        baseCurrency: s(r.base_currency) || s(r.minimum_price_unit) || s(r.msrp_unit) || s(r.selling_unit),

        // --- DEPRECATED (read-fallback only; moved to tax_referral_rates / replaced by base_currency).
        //     Still surfaced for back-compat readers; SKU Details no longer displays or writes these. ---
        hsCode: s(r.hscode),
        declaredValue: s(r.declared_value), declaredValueUnit: s(r.declared_value_unit),
        minimumPriceUnit: s(r.minimum_price_unit), msrpUnit: s(r.msrp_unit), sellingUnit: s(r.selling_unit),

        pm: String(r.pm || ''),
        createdAt: s(r.created_at),
        updatedAt: s(r.updated_at),
        isSellingMaterial: category.toLowerCase() === 'selling material',
        raw: r
    };
}

function normalizeProductFeatureRecord(raw) {
    var r = raw || {};
    var bullets = [];
    for (var i = 1; i <= 7; i++) {
        var bp = r['bullet_point_' + i];
        if (bp && String(bp).trim()) bullets.push(String(bp).trim());
    }
    return {
        featureId: String(r.feature_id || ''),
        scopeType: String(r.scope_type || '').trim().toLowerCase(),
        scopeId: String(r.scope_id || '').trim(),
        country: String(r.country || ''),
        marketplace: String(r.marketplace || ''),
        language: String(r.language || ''),
        productTitle: String(r.product_title || ''),
        productDescription: String(r.product_description || ''),
        bulletPoints: bullets,
        genericKeyword: String(r.generic_keyword || ''),
        createdAt: String(r.created_at || ''),
        updatedAt: String(r.updated_at || ''),
        raw: r
    };
}

function normalizeSkuHandbookSummaryRecord(raw) {
    var r = raw || {};
    return {
        summaryId: String(r.summary_id || ''),
        sku: String(r.sku || '').trim(),
        summaryType: String(r.summary_type || ''),
        summaryText: String(r.summary_text || ''),
        generatedFrom: String(r.generated_from || ''),
        reviewStatus: String(r.review_status || ''),
        reviewedBy: String(r.reviewed_by || ''),
        updatedAt: String(r.updated_at || ''),
        raw: r
    };
}

function normalizeCampaignRecord(raw) {
    var r = raw || {};
    return {
        campaignId: String(r.campaign_id || ''),
        campaignName: String(r.campaign_name || ''),
        // Additive identity (2026-07-22): a campaign is NOT uniquely scoped by country+marketplace
        // alone — the same marketplace name can belong to two companies (KM vs ResUS). company +
        // marketplaceId are the company-safe identity; country/marketplace remain display snapshots.
        company: String(r.company || ''),
        marketplaceId: String(r.marketplace_id || ''),
        country: String(r.country || ''),
        marketplace: String(r.marketplace || ''),
        eventFlag: String(r.event_flag || r.major_event_flag || ''),
        promotionType: String(r.promotion_type || ''),
        majorEventFlag: String(r.major_event_flag || ''),
        year: String(r.year || ''),
        startDate: String(r.start_date || ''),
        endDate: String(r.end_date || ''),
        duration: String(r.duration || ''),
        status: String(r.status || ''),
        eventReportingFee: String(r.event_reporting_fee || ''),
        commission: String(r.commission || ''),
        totalSalesAmount: String(r.total_sales_amount || ''),
        totalSalesUnits: String(r.total_sales_units || ''),
        totalAdCost: String(r.total_ad_cost || ''),
        totalAcos: String(r.total_acos || ''),
        source: String(r.source || ''),
        createdAt: String(r.created_at || ''),
        updatedAt: String(r.updated_at || ''),
        performanceSyncStatus: String(r.performance_sync_status || ''),
        performanceSyncedAt: String(r.performance_synced_at || ''),
        raw: r
    };
}

function normalizeCampaignSkuLineRecord(raw) {
    var r = raw || {};
    return {
        campaignSkuLineId: String(r.campaign_sku_line_id || ''),
        campaignId: String(r.campaign_id || ''),
        // Additive canonical marketplace-SKU identity (2026-07-22); sku kept as Master-SKU snapshot.
        marketplaceSkuId: String(r.marketplace_sku_id || ''),
        sku: String(r.sku || '').trim(),
        promoPrice: String(r.promo_price || ''),
        regularPrice: String(r.regular_price || ''),
        // pricing_list currency snapshot for this line's Regular / Deal price (USD/CAD/AUD/…). NOT a sales value.
        priceUnits: String(r.price_units || ''),
        discountPercent: String(r.discount_percent || ''),
        specialCondition: String(r.special_condition || ''),
        lps: String(r.lps || ''),
        lineStatus: String(r.line_status || ''),
        salesAmount: String(r.sales_amount || ''),
        salesUnits: String(r.sales_units || ''),
        impressions: String(r.impressions || ''),
        sessions: String(r.sessions || ''),
        clicks: String(r.clicks || ''),
        adCost: String(r.ad_cost || ''),
        ctr: String(r.ctr || ''),
        cvr: String(r.cvr || ''),
        acos: String(r.acos || ''),
        source: String(r.source || ''),
        createdAt: String(r.created_at || ''),
        updatedAt: String(r.updated_at || ''),
        performanceSource: String(r.performance_source || ''),
        performanceUpdatedAt: String(r.performance_updated_at || ''),
        raw: r
    };
}


function normalizeMarketplaceSkuRecord(raw) {
    var r = raw || {};
    return {
        marketplaceSkuId: String(r.marketplace_sku_id || '').trim(),
        marketplaceId: String(r.marketplace_id || '').trim(),
        company: String(r.company || '').trim(),
        sku: String(r.sku || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        // Canonical platform-neutral product id (SKU Domain v2.0). Amazon ASIN stored here; UI may label
        // it "ASIN". Legacy `asin` is READ-fallback only during migration — never written.
        marketplaceProductId: String(r.marketplace_product_id || r.asin || '').trim(),
        asin: String(r.asin || '').trim(),   // legacy read-only alias (do not write)
        currency: String(r.currency || 'USD').trim(),
        regularPrice: parseFloat(r.regular_price) || 0,
        minimumPrice: parseFloat(r.minimum_price) || 0,
        msrp: parseFloat(r.msrp) || 0,
        marketplaceSkuStatus: String(r.marketplace_sku_status || '').trim(),
        replenishmentModel: String(r.replenishment_model || 'sales_driven').trim(),
        // Fulfillment model (SKU-level override). Empty when the column is absent — the
        // marketplace-level model then applies. Values: platform_fulfilled | self_fulfilled | hybrid.
        fulfillmentModel: String(r.fulfillment_model || '').trim(),
        launchDate: String(r.launch_date || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Inventory namespace migration (2026-07-21): Factory Stock balance columns are `fac_*`, Overseas
// Warehouse Inventory columns are `wh_*`. TEMPORARY dual-read prefers the new canonical header and falls
// back to the pre-migration name only while the header is absent. REMOVAL CONDITION: delete the old-key
// fallback once the live sheets are renamed and verified (see project-current-state migration entry).
function _invPick(r, canonicalKey, legacyKey) {
    var v = r ? r[canonicalKey] : undefined;
    return (v === undefined || v === null || v === '') ? (r ? r[legacyKey] : undefined) : v;
}

function normalizeFactoryStockRecord(raw) {
    var r = raw || {};
    return {
        factoryStockId: String(r.factory_stock_id || '').trim(),
        sku: String(r.sku || '').trim(),
        // Current factory_stock schema has NO company / factory_name — company & factory name are
        // joined from warehouses via warehouse_id. Legacy fields kept only as defensive fallbacks.
        warehouseId: String(r.warehouse_id || '').trim(),
        company: String(r.company || '').trim(),
        factoryName: String(r.factory_name || '').trim(),
        currentStock: parseFloat(_invPick(r, 'fac_current_stock', 'current_stock')) || 0,   // canonical fac_current_stock
        reservedStock: parseFloat(_invPick(r, 'fac_reserved_stock', 'reserved_stock')) || 0, // canonical fac_reserved_stock
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        lastTransactionAt: String(r.last_transaction_at || '').trim(),
        raw: r
    };
}

function normalizeFactoryStockMovementRecord(raw) {
    var r = raw || {};
    // Canonical factory_stock_movements schema (SHIPMENT_CENTER_SPEC §, finalized):
    //   factory_stock_movement_id, movement_date, sku, warehouse_id, movement_type, qty,
    //   related_entity_type, related_entity_id, before_current_stock, after_current_stock,
    //   before_reserved_stock, after_reserved_stock, note, created_by, created_at
    // The manual Inventory Adjustment writer (handleAdjustFactoryInventory_) fills the 4-way
    // before/after audit columns. Legacy before_qty/after_qty are kept only as defensive fallbacks.
    var num = function(v) { return (v == null || v === '') ? null : (parseFloat(v)); };
    var beforeCurrent = num(r.before_current_stock);
    var afterCurrent = num(r.after_current_stock);
    var beforeReserved = num(r.before_reserved_stock);
    var afterReserved = num(r.after_reserved_stock);
    // Derived available before/after (current - reserved) when the 4-way columns are present;
    // otherwise fall back to legacy before_qty/after_qty (which already carried the tracked balance).
    var availBefore = (beforeCurrent != null && beforeReserved != null)
        ? (beforeCurrent - beforeReserved)
        : (parseFloat(r.before_qty != null && r.before_qty !== '' ? r.before_qty : r.quantity_before) || 0);
    var availAfter = (afterCurrent != null && afterReserved != null)
        ? (afterCurrent - afterReserved)
        : (parseFloat(r.after_qty != null && r.after_qty !== '' ? r.after_qty : r.quantity_after) || 0);
    return {
        movementId: String(r.factory_stock_movement_id || r.movement_id || '').trim(),
        movementDate: String(r.movement_date || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        factoryName: String(r.factory_name || '').trim(),
        sku: String(r.sku || '').trim(),
        movementType: String(r.movement_type || '').trim(),
        quantity: parseFloat(r.qty != null && r.qty !== '' ? r.qty : r.quantity) || 0,
        // Available before/after (primary "before → after" for the movement log).
        availableBefore: availBefore,
        availableAfter: availAfter,
        // Full 4-way audit (null when absent — never fabricated as 0).
        beforeCurrentStock: beforeCurrent,
        afterCurrentStock: afterCurrent,
        beforeReservedStock: beforeReserved,
        afterReservedStock: afterReserved,
        // Legacy generic before/after kept for backward-compatible display.
        quantityBefore: parseFloat(r.before_qty != null && r.before_qty !== '' ? r.before_qty : r.quantity_before) || 0,
        quantityAfter: parseFloat(r.after_qty != null && r.after_qty !== '' ? r.after_qty : r.quantity_after) || 0,
        relatedEntityType: String(r.related_entity_type || r.reference_type || '').trim(),
        relatedEntityId: String(r.related_entity_id || r.reference_id || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

function normalizeMarketplaceRecord(raw) {
    var r = raw || {};
    return {
        marketplaceId: String(r.marketplace_id || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        marketplaceDisplayName: String(r.marketplace_display_name || '').trim(),
        marketplaceAlias: String(r.marketplace_alias || '').trim(),
        // Fulfillment model: platform_fulfilled | self_fulfilled | hybrid (empty when column absent).
        fulfillmentModel: String(r.fulfillment_model || '').trim(),
        // Shared overseas inventory allocation priority (higher = higher priority). 0 when absent.
        allocationPriority: parseFloat(r.allocation_priority) || 0,
        currency: String(r.currency || '').trim(),
        status: String(r.status || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

function normalizePricingListRecord(raw) {
    var r = raw || {};
    return {
        pricingId: String(r.pricing_id || '').trim(),
        marketplaceSkuId: String(r.marketplace_sku_id || '').trim(),
        marketplaceId: String(r.marketplace_id || '').trim(),
        company: String(r.company || '').trim(),
        sku: String(r.sku || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        // Canonical platform-neutral product id (SKU Domain v2.0); legacy `asin` READ-fallback only.
        marketplaceProductId: String(r.marketplace_product_id || r.asin || '').trim(),
        asin: String(r.asin || '').trim(),   // legacy read-only alias (do not write)
        currency: String(r.currency || '').trim(),
        baseCurrency: String(r.base_currency || '').trim(),
        baseRegularPrice: parseFloat(r.base_regular_price) || 0,
        baseMinimumPrice: parseFloat(r.base_minimum_price) || 0,
        baseMsrp: parseFloat(r.base_msrp) || 0,
        fxRate: parseFloat(r.fx_rate) || 0,
        fxRateDate: String(r.fx_rate_date || '').trim(),
        autoRegularPrice: parseFloat(r.auto_regular_price) || 0,
        autoMinimumPrice: parseFloat(r.auto_minimum_price) || 0,
        autoMsrp: parseFloat(r.auto_msrp) || 0,
        regularPrice: parseFloat(r.regular_price) || 0,
        minimumPrice: parseFloat(r.minimum_price) || 0,
        msrp: parseFloat(r.msrp) || 0,
        priceSource: String(r.price_source || '').trim(),
        priceStatus: String(r.price_status || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

function normalizePricingChangeLogRecord(raw) {
    var r = raw || {};
    return {
        logId: String(r.log_id || '').trim(),
        pricingId: String(r.pricing_id || '').trim(),
        fieldName: String(r.field_name || '').trim(),
        oldValue: String(r.old_value || '').trim(),
        newValue: String(r.new_value || '').trim(),
        changedBy: String(r.changed_by || '').trim(),
        changedAt: String(r.changed_at || '').trim(),
        changeReason: String(r.change_reason || '').trim(),
        raw: r
    };
}

function normalizeFcRegularForecastRecord(raw) {
    var r = raw || {};
    return {
        forecastId: String(r.forecast_id || '').trim(),
        year: String(r.year || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        sku: String(r.sku || '').trim(),
        category: String(r.category || '').trim(),
        series: String(r.series || '').trim(),
        jan: parseFloat(r.jan) || 0,
        feb: parseFloat(r.feb) || 0,
        mar: parseFloat(r.mar) || 0,
        apr: parseFloat(r.apr) || 0,
        may: parseFloat(r.may) || 0,
        jun: parseFloat(r.jun) || 0,
        jul: parseFloat(r.jul) || 0,
        aug: parseFloat(r.aug) || 0,
        sep: parseFloat(r.sep) || 0,
        oct: parseFloat(r.oct) || 0,
        nov: parseFloat(r.nov) || 0,
        dec: parseFloat(r.dec) || 0,
        totalFc: parseFloat(r.total_fc) || 0,
        fcShare: String(r.fc_share || '').trim(),
        forecastStatus: String(r.forecast_status || '').trim(),
        source: String(r.source || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// replenishment_demand_allocation_rules (Phase-1 multi-warehouse demand allocation authority, F1-4B-E).
// Read-only normalization of the user-owned config sheet (REPLENISHMENT_DEMAND_ALLOCATION_RULES_SPEC.md).
// Ratios stay numbers (null when blank/non-numeric — never coerced to 0); `raw` is retained so the pure
// demand-allocation runtime (KMDAL) can read the canonical snake_case fields directly.
function normalizeReplenishmentDemandAllocationRuleRecord(raw) {
    var r = raw || {};
    function numOrNull(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(v); return isFinite(n) ? n : null; }
    return {
        allocationRuleId: String(r.allocation_rule_id || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        destinationWarehouseId: String(r.destination_warehouse_id || '').trim(),
        forecastAllocationRatio: numOrNull(r.forecast_allocation_ratio),
        salesAllocationRatio: numOrNull(r.sales_allocation_ratio),
        status: String(r.status || '').trim(),
        effectiveFrom: String(r.effective_from || '').trim(),
        effectiveTo: String(r.effective_to || '').trim(),
        version: String(r.version || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// Interpret a Sheet boolean-ish cell as a real tri-state: true / false / null (blank/unknown).
// Never Boolean(value) — an "N"/"No"/"0"/"FALSE" string is truthy and would flip the flag.
function _whBool(v) {
    if (v === true) return true;
    if (v === false) return false;
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === '') return null;
    if (s === 'true' || s === 'yes' || s === 'y' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === 'n' || s === '0') return false;
    return null;
}

function normalizeWarehouseRecord(raw) {
    var r = raw || {};
    return {
        warehouseId: String(r.warehouse_id || '').trim(),
        // System-derived snapshot source for the Shipment Draft Warehouse Picker: the picker copies
        // this into shipments.warehouse_code (never free-typed). Empty if the sheet has no such column.
        warehouseCode: String(r.warehouse_code || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        warehouseName: String(r.warehouse_name || '').trim(),
        warehouseType: String(r.warehouse_type || '').trim(),
        // Optional: surfaced for Movement Log marketplace filter. Empty if the sheet has no such column.
        marketplace: String(r.marketplace || '').trim(),
        // Picker filtering/eligibility inputs (§22.0 F/G/H). warehouseOwner = physical operator (Amazon/WINIT/...).
        // isActive / isFactoryWarehouse are tri-state (true/false/null) — see _whBool. logisticsRegion + city/state
        // drive candidate ordering and option display. All empty/null when the sheet lacks the column.
        warehouseOwner: String(r.warehouse_owner || '').trim(),
        isActive: _whBool(r.is_active),
        isFactoryWarehouse: _whBool(r.is_factory_warehouse),
        logisticsRegion: String(r.logistics_region || '').trim(),
        city: String(r.city || '').trim(),
        state: String(r.state || '').trim(),
        status: String(r.status || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

function normalizeOverseasInventorySnapshotRecord(raw) {
    var r = raw || {};
    return {
        snapshotId: String(r.overseas_inventory_id || r.snapshot_id || '').trim(),
        snapshotDate: String(r.snapshot_date || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        sku: String(r.sku || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        physicalStock: parseFloat(_invPick(r, 'wh_physical_stock', 'physical_stock')) || 0,
        availableStock: parseFloat(_invPick(r, 'wh_available_stock', 'available_stock')) || 0,
        reservedStock: parseFloat(_invPick(r, 'wh_reserved_stock', 'reserved_stock')) || 0,
        damagedStock: parseFloat(_invPick(r, 'wh_damaged_stock', 'damaged_stock')) || 0,
        onTheWayQty: parseFloat(_invPick(r, 'wh_on_the_way_qty', 'on_the_way_qty')) || 0,
        onTheWayEta: String(_invPick(r, 'wh_on_the_way_eta', 'on_the_way_eta') || '').trim(),
        onTheWayBucket: String(_invPick(r, 'wh_on_the_way_bucket', 'on_the_way_bucket') || '').trim(),
        eventStatus: String(r.event_status || '').trim(),
        // Optional warning-threshold columns (read-only; absent -> 0). Used by MVP display warning only.
        reorderPoint: parseFloat(r.reorder_point) || 0,
        overstockPoint: parseFloat(r.overstock_point) || 0,
        lastMovementAt: String(r.last_movement_at || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

function normalizeOverseasInventoryMovementRecord(raw) {
    var r = raw || {};
    return {
        movementId: String(r.movement_id || '').trim(),
        movementDate: String(r.movement_date || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        sku: String(r.sku || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        movementType: String(r.movement_type || '').trim(),
        // Stock-direction fields (additive; empty if the sheet lacks these columns).
        // Allowed values: available | reserved | damaged | on_the_way | none
        fromStockType: String(r.from_stock_type || '').trim(),
        toStockType: String(r.to_stock_type || '').trim(),
        quantity: parseFloat(_invPick(r, 'wh_quantity', 'quantity')) || 0,
        quantityBefore: parseFloat(_invPick(r, 'wh_quantity_before', 'quantity_before')) || 0,
        quantityAfter: parseFloat(_invPick(r, 'wh_quantity_after', 'quantity_after')) || 0,
        referenceType: String(r.reference_type || '').trim(),
        referenceId: String(r.reference_id || '').trim(),
        sourceModule: String(r.source_module || '').trim(),
        reason: String(r.reason || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// ---- Amazon snapshot + forecast-event source readers (read-only; import-populated tables) ----
// These tables are import-only (see AMAZON_SNAPSHOT_IMPORT_MAPPING_SPEC.md). They live in a
// separate Amazon destination spreadsheet; when the operation-DB payload does not include them
// these normalize to [] and every downstream mapping must safe-fallback to 0 (no fabricated data).

function normalizeAmazonInventorySnapshotRecord(raw) {
    var r = raw || {};
    return {
        snapshotDate: String(r.snapshot_date || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || 'Amazon').trim(),
        sku: String(r.sku || '').trim(),
        asin: String(r.asin || '').trim(),
        availableQty: parseFloat(r.available_qty) || 0,
        fcTransferQty: parseFloat(r.fc_transfer_qty) || 0,
        fcProcessingQty: parseFloat(r.fc_processing_qty) || 0,
        customerOrderQty: parseFloat(r.customer_order_qty) || 0,
        unfulfillableQty: parseFloat(r.unfulfillable_qty) || 0,
        raw: r
    };
}

function normalizeAmazonInventoryHealthSnapshotRecord(raw) {
    var r = raw || {};
    return {
        snapshotDate: String(r.snapshot_date || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || 'Amazon').trim(),
        sku: String(r.sku || '').trim(),
        invAge0To90Days: parseFloat(r.inv_age_0_to_90_days) || 0,
        invAge91To180Days: parseFloat(r.inv_age_91_to_180_days) || 0,
        invAge181To270Days: parseFloat(r.inv_age_181_to_270_days) || 0,
        invAge271To365Days: parseFloat(r.inv_age_271_to_365_days) || 0,
        // Finer top buckets — may be absent in the current source (top bucket is inv_age_365_plus_days).
        // Safe fallback to 0 so Over 180+ never errors (see INVENTORY_TABLE_MAPPING_SPEC §5).
        invAge366To455Days: parseFloat(r.inv_age_366_to_455_days) || 0,
        invAge456PlusDays: parseFloat(r.inv_age_456_plus_days) || 0,
        invAge365PlusDays: parseFloat(r.inv_age_365_plus_days) || 0,
        raw: r
    };
}

function normalizeAmazonDailySalesSnapshotRecord(raw) {
    var r = raw || {};
    return {
        snapshotDate: String(r.snapshot_date || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || 'Amazon').trim(),
        channel: String(r.channel || '').trim(),
        sku: String(r.sku || '').trim(),
        salesUnits: parseFloat(r.sales_units) || 0,
        raw: r
    };
}

function normalizeAmazonWeeklySalesSnapshotRecord(raw) {
    var r = raw || {};
    return {
        snapshotWeek: String(r.snapshot_week || '').trim(),
        weekEndDate: String(r.week_end_date || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || 'Amazon').trim(),
        channel: String(r.channel || '').trim(),
        sku: String(r.sku || '').trim(),
        salesUnits7d: parseFloat(r.sales_units_7d) || 0,
        raw: r
    };
}

// Parse a free-text event_period ("2026/07/15-2026/07/16", "2026-07-15 ~ 2026-07-16", etc.) into
// { start, end } ISO yyyy-mm-dd strings. Returns blanks when it cannot confidently parse two dates.
// Used only as a FALLBACK for legacy rows that predate the event_start_date / event_end_date columns.
function _fcParseEventPeriodDates(period) {
    var out = { start: '', end: '' };
    var s = String(period == null ? '' : period).trim();
    if (!s) return out;
    // Find all yyyy[/-.]mm[/-.]dd tokens (order-preserving).
    var re = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g, m, found = [];
    while ((m = re.exec(s)) !== null) {
        var iso = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        found.push(iso);
    }
    if (found.length >= 1) out.start = found[0];
    if (found.length >= 2) out.end = found[found.length - 1];
    else if (found.length === 1) out.end = found[0];   // single date → same-day event
    return out;
}

function normalizeFcSpecialEventRecord(raw) {
    var r = raw || {};
    var period = String(r.event_period || r.period || '').trim();
    // Canonical start/end dates: prefer explicit columns; fall back to parsing the legacy free-text period.
    var startCol = String(r.event_start_date || r.start_date || '').trim();
    var endCol = String(r.event_end_date || r.end_date || '').trim();
    var parsed = (!startCol || !endCol) ? _fcParseEventPeriodDates(period) : { start: '', end: '' };
    return {
        // Canonical PK is `event_fc_id` (FC_SUMMARY_SPEC §3.1); fall back to legacy `event_id`/`special_event_id`.
        eventFcId: String(r.event_fc_id || r.event_id || r.special_event_id || '').trim(),
        eventId: String(r.event_fc_id || r.event_id || r.special_event_id || '').trim(),
        // Campaign linkage (2026-07-22 additive) — lets the Growth-Rate assist read a base campaign's FC.
        campaignId: String(r.campaign_id || '').trim(),
        campaignSkuLineId: String(r.campaign_sku_line_id || '').trim(),
        marketplaceId: String(r.marketplace_id || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        scopeType: String(r.scope_type || '').trim().toLowerCase(),
        scopeId: String(r.scope_id || '').trim(),
        sku: String(r.sku || '').trim(),
        series: String(r.series || '').trim(),
        category: String(r.category || '').trim(),
        event: String(r.event || r.event_name || '').trim(),
        eventPeriod: period,
        eventStartDate: startCol || parsed.start,
        eventEndDate: endCol || parsed.end,
        eventMonth: String(r.event_month || r.month || '').trim(),
        year: String(r.year || '').trim(),
        status: String(r.status || '').trim(),
        fcQty: parseFloat(r.fc_qty != null && r.fc_qty !== '' ? r.fc_qty : r.qty) || 0,
        raw: r
    };
}

function normalizeFcTargetRuleRecord(raw) {
    var r = raw || {};
    // Defensive: target-rule column names are not finalized. Read several plausible aliases.
    var pct = r.target_percentage != null && r.target_percentage !== '' ? r.target_percentage
            : (r.target_rate != null && r.target_rate !== '' ? r.target_rate
            : (r.target != null && r.target !== '' ? r.target : r.percentage));
    return {
        ruleId: String(r.target_rule_id || r.rule_id || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        scopeType: String(r.scope_type || r.scope || r.level || '').trim().toLowerCase(),
        scopeId: String(r.scope_id || r.sku || r.series || r.category || '').trim(),
        targetPercentage: (pct != null && pct !== '') ? parseFloat(pct) : null,
        raw: r
    };
}

// ---- Weekly Shipping Plan (Decision Layer) readers ----------------
function normalizeShippingPlanRecord(raw) {
    var r = raw || {};
    return {
        shippingPlanId: String(r.shipping_plan_id || '').trim(),
        shippingPlanNo: String(r.shipping_plan_no || '').trim(),
        planName: String(r.plan_name || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        shipFrom: String(r.ship_from || '').trim(),
        // CANONICAL warehouse endpoints (2026-07-28). source_warehouse_id = out-source identity (NO
        // origin_warehouse_id); destination_warehouse_id = out-destination identity; *_type qualifiers.
        sourceWarehouseId: String(r.source_warehouse_id || '').trim(),
        shipFromType: String(r.ship_from_type || '').trim(),
        destination: String(r.destination || '').trim(),
        destinationWarehouseId: String(r.destination_warehouse_id || '').trim(),
        destinationType: String(r.destination_type || '').trim(),
        shippingMethod: String(r.shipping_method || '').trim(),
        lastMileDelivery: String(r.last_mile_delivery || '').trim(),
        customsType: String(r.customs_type || '').trim(),
        // NON-PERSISTENT view fields (2026-07-28): display text derived from the CODE at read time. The
        // *_label snapshot columns are RETIRED — these are never written back to shipping_plans.
        shippingMethodDisplay: codeDisplay_.shippingMethod(r.shipping_method),
        lastMileDeliveryDisplay: codeDisplay_.lastMileDelivery(r.last_mile_delivery),
        customsTypeDisplay: codeDisplay_.customsType(r.customs_type),
        planVersion: parseFloat(r.plan_version) || 1,
        parentShippingPlanId: String(r.parent_shipping_plan_id || '').trim(),
        submitBatchId: String(r.submit_batch_id || '').trim(),
        batchStatus: String(r.batch_status || '').trim(),
        carrierId: String(r.carrier_id || '').trim(),
        // Rough-quote carrier snapshot (Weekly Plan). carrier_rate_type = the rate card charge_type.
        carrierUnitRate: (r.carrier_unit_rate === '' || r.carrier_unit_rate == null) ? '' : (parseFloat(r.carrier_unit_rate) || 0),
        carrierRateType: String(r.carrier_rate_type || '').trim(),
        importDutyTreatment: String(r.import_duty_treatment || '').trim(),
        estimatedFreightCost: (r.estimated_freight_cost === '' || r.estimated_freight_cost == null) ? '' : (parseFloat(r.estimated_freight_cost) || 0),
        estimatedDuty: (r.estimated_duty === '' || r.estimated_duty == null) ? '' : (parseFloat(r.estimated_duty) || 0),
        estimatedCustomsFee: (r.estimated_customs_fee === '' || r.estimated_customs_fee == null) ? '' : (parseFloat(r.estimated_customs_fee) || 0),
        estimatedTotalCost: (r.estimated_total_cost === '' || r.estimated_total_cost == null) ? '' : (parseFloat(r.estimated_total_cost) || 0),
        currency: String(r.currency || '').trim(),
        status: String(r.status || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        submittedBy: String(r.submitted_by || '').trim(),
        submittedAt: String(r.submitted_at || '').trim(),
        approvedBy: String(r.approved_by || '').trim(),
        approvedAt: String(r.approved_at || '').trim(),
        rejectedBy: String(r.rejected_by || '').trim(),
        rejectedAt: String(r.rejected_at || '').trim(),
        rejectedReason: String(r.rejected_reason || '').trim(),
        rejectedComment: String(r.rejected_comment || '').trim(),
        cancelledBy: String(r.cancelled_by || '').trim(),
        cancelledAt: String(r.cancelled_at || '').trim(),
        // Execution-Layer handoff metadata (set when the plan is converted to a Shipment Draft).
        transferredToShipmentAt: String(r.transferred_to_shipment_at || '').trim(),
        transferredShipmentId: String(r.transferred_shipment_id || '').trim(),
        // Decision Layer Completion (Done) — Decision Layer finished; Execution Layer has taken over.
        completedAt: String(r.completed_at || '').trim(),
        completedBy: String(r.completed_by || '').trim(),
        note: String(r.note || '').trim(),
        source: String(r.source || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

function normalizeShippingPlanLineRecord(raw) {
    var r = raw || {};
    return {
        shippingPlanLineId: String(r.shipping_plan_line_id || '').trim(),
        shippingPlanId: String(r.shipping_plan_id || '').trim(),
        sku: String(r.sku || '').trim(),
        // CANONICAL (2026-07-28): each line keeps its REAL marketplace + site SKU (never MULTI on a line).
        siteSku: String(r.site_sku || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        requestedQty: parseFloat(r.requested_qty) || 0,
        approvedQty: parseFloat(r.approved_qty) || 0,
        // CANONICAL plan_carton_qty with legacy carton_qty read-fallback. cartonQty kept as UI alias.
        planCartonQty: parseFloat((r.plan_carton_qty === '' || r.plan_carton_qty == null) ? r.carton_qty : r.plan_carton_qty) || 0,
        cartonQty: parseFloat((r.plan_carton_qty === '' || r.plan_carton_qty == null) ? r.carton_qty : r.plan_carton_qty) || 0,
        unitsPerCarton: parseFloat(r.units_per_carton) || 0,
        sourcePage: String(r.source_page || '').trim(),
        sourceReason: String(r.source_reason || '').trim(),
        inventorySnapshotDate: String(r.inventory_snapshot_date || '').trim(),
        note: String(r.note || '').trim(),
        // Decision Snapshot (per-SKU, immutable after commit)
        snapshotCurrentStock: parseFloat(r.snapshot_current_stock) || 0,
        snapshotAvgSalesPerDay: parseFloat(r.snapshot_avg_sales_per_day) || 0,
        snapshotDaysOfSupply: (r.snapshot_days_of_supply === '' || r.snapshot_days_of_supply == null) ? '' : r.snapshot_days_of_supply,
        snapshotSuggestedQty: parseFloat(r.snapshot_suggested_qty) || 0,
        snapshotTargetDays: parseFloat(r.snapshot_target_days) || 0,
        snapshotFcContext: (r.snapshot_fc_context == null) ? '' : r.snapshot_fc_context,
        snapshotEventContext: (r.snapshot_event_context == null) ? '' : r.snapshot_event_context,
        // Avg-sales provenance snapshots (canonical 2026-07-28).
        snapshotAvgSalesSource: String(r.snapshot_avg_sales_source || '').trim(),
        snapshotNormalDaysCount: (r.snapshot_normal_days_count === '' || r.snapshot_normal_days_count == null) ? '' : (parseFloat(r.snapshot_normal_days_count) || 0),
        snapshotExcludedEventDaysCount: (r.snapshot_excluded_event_days_count === '' || r.snapshot_excluded_event_days_count == null) ? '' : (parseFloat(r.snapshot_excluded_event_days_count) || 0),
        snapshotAvgSalesWarning: String(r.snapshot_avg_sales_warning || '').trim(),
        // Logistics Decision Snapshot (computed at Submit Plan / Save from sku_details carton dims/weights).
        cartonCbm: parseFloat(r.carton_cbm) || 0,
        cbm: parseFloat(r.cbm) || 0,
        grossWeight: parseFloat(r.gross_weight) || 0,
        netWeight: parseFloat(r.net_weight) || 0,
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Canonical customs_type enum → localized (中文) Label. Mirror of CUSTOMS_TYPE_LABELS_ in
// 17_carrier_handlers.gs (backend is the source of truth). Used ONLY as a read-side fallback when a
// stored *_label snapshot is blank (legacy rows). Enum names are frozen; only Labels live here.
var CUSTOMS_TYPE_LABELS_ = {
    third_party_customs: '買單報關',
    formal_customs: '正式報關',
    tax_refund_customs: '退稅報關'
};
function customsTypeLabelFallback_(code) {
    var key = String(code == null ? '' : code).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(CUSTOMS_TYPE_LABELS_, key) ? CUSTOMS_TYPE_LABELS_[key] : '';
}

// ============================================================
// Code → Display Resolver (VIEW / Presentation ONLY — 2026-07-28 Canonical Decision).
// The retired *_label snapshot columns (shipping_plans / shipments shipping_method_label, customs_type_label,
// shipments_customs_type_label) are GONE from the transaction DB. Display text is derived at render time from
// the CODE fields (shipping_method / last_mile_delivery / customs_type / shipments_customs_type). These return
// NON-PERSISTENT values and must NEVER be written back to shipping_plans / shipments. Business logic (rate/carrier
// matching, customs/duty, grouping, dedupe) uses the CODE only — never these display strings.
// Display source priority: (1) canonical enum→Label map (customs); (2) a humanized Code fallback. A future
// shared Enum Display Dictionary / Code Dictionary table can extend this without touching callers or the DB.
// ============================================================
function _codeHumanize_(code) {
    var s = String(code == null ? '' : code).trim();
    if (!s) return '';
    return s.split(/[_\s]+/).map(function (w) { return w ? (w.charAt(0).toUpperCase() + w.slice(1)) : w; }).join(' ');
}
var codeDisplay_ = {
    shippingMethod: function (code) { return _codeHumanize_(code); },
    lastMileDelivery: function (code) { return _codeHumanize_(code); },
    customsType: function (code) { return customsTypeLabelFallback_(code) || _codeHumanize_(code); }
};
// Public render-time resolver. carrierName is looked up LIVE from the carriers master (carrier_id →
// carriers.carrier_name) — carrier_name is NEVER stored on shipping_plans / shipments / carrier_rate_cards.
if (typeof window !== 'undefined') {
    window.KM = window.KM || {};
    window.KM.display = {
        shippingMethod: codeDisplay_.shippingMethod,
        lastMileDelivery: codeDisplay_.lastMileDelivery,
        customsType: codeDisplay_.customsType,
        carrierName: function (carrierId) {
            var id = String(carrierId == null ? '' : carrierId).trim();
            if (!id) return '';
            try {
                var db = (window.KM.DB && typeof window.KM.DB.getOperationDb === 'function') ? window.KM.DB.getOperationDb() : null;
                var carriers = (db && (db.carriers || [])) || [];
                for (var i = 0; i < carriers.length; i++) {
                    var c = carriers[i] || {};
                    if (String(c.carrierId || c.carrier_id || '').trim() === id) return String(c.carrierName || c.carrier_name || '').trim();
                }
            } catch (e) { /* carriers not loaded yet → blank */ }
            return '';
        }
    };
}

// Shipment (Execution Layer) header. Execution Snapshot lives on the lines (see below).
function normalizeShipmentRecord(raw) {
    var r = raw || {};
    return {
        shipmentId: String(r.shipment_id || '').trim(),
        shipmentNo: String(r.shipment_no || '').trim(),
        externalShipmentId: String(r.external_shipment_id || '').trim(),
        shippingPlanId: String(r.shipping_plan_id || '').trim(),
        referenceId: String(r.reference_id || '').trim(),
        // CANONICAL warehouse endpoints (2026-07-28). source_warehouse_id = out-source identity (NO
        // origin_warehouse_id). destination_warehouse_id = out-destination identity; legacy warehouse_id
        // (the old destination identity) is the read-fallback. warehouse_code = DESTINATION code snapshot.
        sourceWarehouseId: String(r.source_warehouse_id || '').trim(),
        destinationWarehouseId: String((r.destination_warehouse_id === '' || r.destination_warehouse_id == null) ? (r.warehouse_id || '') : r.destination_warehouse_id).trim(),
        destinationType: String(r.destination_type || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),   // legacy (destination) read alias
        warehouseCode: String(r.warehouse_code || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),   // actual, or MULTI when the plan combined marketplaces
        shipFrom: String(r.ship_from || '').trim(),
        destination: String(r.destination || '').trim(),
        carrierId: String(r.carrier_id || '').trim(),
        rateCardId: String(r.rate_card_id || '').trim(),
        importDutyTreatment: String(r.import_duty_treatment || '').trim(),
        masterTrackingNumber: String(r.master_tracking_number || '').trim(),
        isCrossDock: String(r.is_cross_dock || '').trim(),
        temperatureRequirement: String(r.temperature_requirement || '').trim(),
        hazmatFlag: String(r.hazmat_flag || '').trim(),
        shippingMethod: String(r.shipping_method || '').trim(),
        lastMileDelivery: String(r.last_mile_delivery || '').trim(),
        // Customs method SNAPSHOT — CODE. Canonical shipments_customs_type; legacy customs_type read-fallback
        // (historical rows). customsType kept as a temporary read-compat alias = shipmentsCustomsType.
        shipmentsCustomsType: String((r.shipments_customs_type === '' || r.shipments_customs_type == null) ? (r.customs_type || '') : r.shipments_customs_type).trim(),
        customsType: String((r.shipments_customs_type === '' || r.shipments_customs_type == null) ? (r.customs_type || '') : r.shipments_customs_type).trim(),
        // NON-PERSISTENT view fields (2026-07-28): the *_label snapshot columns are RETIRED; display text is
        // derived from the CODE at read time and is NEVER written back to shipments. Documents/Export/UI read
        // these (or call KM.display.* at render) — they must not translate the enum inline elsewhere.
        shippingMethodDisplay: codeDisplay_.shippingMethod(r.shipping_method),
        lastMileDeliveryDisplay: codeDisplay_.lastMileDelivery(r.last_mile_delivery),
        customsTypeDisplay: codeDisplay_.customsType((r.shipments_customs_type === '' || r.shipments_customs_type == null) ? r.customs_type : r.shipments_customs_type),
        status: String(r.status || '').trim(),
        salesOrderId: String(r.sales_order_id || '').trim(),
        bookingNo: String(r.booking_no || '').trim(),
        trackingNumber: String(r.tracking_number || '').trim(),
        containerNo: String(r.container_no || '').trim(),
        blNo: String(r.bl_no || '').trim(),
        invoiceNo: String(r.invoice_no || '').trim(),
        etd: String(r.etd || '').trim(),
        eta: String(r.eta || '').trim(),
        actualDepartureDate: String(r.actual_departure_date || '').trim(),
        actualArrivalDate: String(r.actual_arrival_date || '').trim(),
        customsClearanceDate: String(r.customs_clearance_date || '').trim(),
        deliveredDate: String(r.delivered_date || '').trim(),
        // CANONICAL renamed columns (shipment_total_*) with legacy (total_*) read-fallback for old rows.
        // camelCase shipmentTotal* are canonical; totalQty/totalCartons/totalCbm remain as UI read aliases.
        shipmentTotalQty: parseFloat((r.shipment_total_qty === '' || r.shipment_total_qty == null) ? r.total_qty : r.shipment_total_qty) || 0,
        shipmentTotalCartons: parseFloat((r.shipment_total_cartons === '' || r.shipment_total_cartons == null) ? r.total_cartons : r.shipment_total_cartons) || 0,
        shipmentTotalCbm: (function () { var v = (r.shipment_total_cbm === '' || r.shipment_total_cbm == null) ? r.total_cbm : r.shipment_total_cbm; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        totalQty: parseFloat((r.shipment_total_qty === '' || r.shipment_total_qty == null) ? r.total_qty : r.shipment_total_qty) || 0,
        totalCartons: parseFloat((r.shipment_total_cartons === '' || r.shipment_total_cartons == null) ? r.total_cartons : r.shipment_total_cartons) || 0,
        totalCbm: (function () { var v = (r.shipment_total_cbm === '' || r.shipment_total_cbm == null) ? r.total_cbm : r.shipment_total_cbm; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        // CANONICAL shipment_total_gross/net_weight with legacy total_* read-fallback; totalGross/NetWeight kept as UI aliases.
        shipmentTotalGrossWeight: (function () { var v = (r.shipment_total_gross_weight === '' || r.shipment_total_gross_weight == null) ? r.total_gross_weight : r.shipment_total_gross_weight; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        shipmentTotalNetWeight: (function () { var v = (r.shipment_total_net_weight === '' || r.shipment_total_net_weight == null) ? r.total_net_weight : r.shipment_total_net_weight; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        totalGrossWeight: (function () { var v = (r.shipment_total_gross_weight === '' || r.shipment_total_gross_weight == null) ? r.total_gross_weight : r.shipment_total_gross_weight; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        totalNetWeight: (function () { var v = (r.shipment_total_net_weight === '' || r.shipment_total_net_weight == null) ? r.total_net_weight : r.shipment_total_net_weight; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        // Phase-1 Estimated Cost (exact on the shipment; blank = Not Applied / Rate Review — never 0).
        estimatedFreightCost: (r.estimated_freight_cost === '' || r.estimated_freight_cost == null) ? '' : (parseFloat(r.estimated_freight_cost) || 0),
        estimatedDuty: (r.estimated_duty === '' || r.estimated_duty == null) ? '' : (parseFloat(r.estimated_duty) || 0),
        estimatedCustomsFee: (r.estimated_customs_fee === '' || r.estimated_customs_fee == null) ? '' : (parseFloat(r.estimated_customs_fee) || 0),
        estimatedTotalCost: (r.estimated_total_cost === '' || r.estimated_total_cost == null) ? '' : (parseFloat(r.estimated_total_cost) || 0),
        estimatedUnitCost: (r.estimated_unit_cost === '' || r.estimated_unit_cost == null) ? '' : (parseFloat(r.estimated_unit_cost) || 0),
        freightCostActual: (r.freight_cost_actual === '' || r.freight_cost_actual == null) ? '' : (parseFloat(r.freight_cost_actual) || 0),
        dutyActual: (r.duty_actual === '' || r.duty_actual == null) ? '' : (parseFloat(r.duty_actual) || 0),
        totalCostActual: (r.total_cost_actual === '' || r.total_cost_actual == null) ? '' : (parseFloat(r.total_cost_actual) || 0),
        currency: String(r.currency || '').trim(),
        // Ship / Done (Shipment Draft workspace) lifecycle metadata.
        shippedAt: String(r.shipped_at || '').trim(),
        shippedBy: String(r.shipped_by || '').trim(),
        hiddenFromDraftAt: String(r.hidden_from_draft_at || '').trim(),
        hiddenFromDraftBy: String(r.hidden_from_draft_by || '').trim(),
        note: String(r.note || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Shipment line. snapshot_* fields are the Execution Snapshot — a verbatim copy of the Decision
// Snapshot (immutable; never recalculated in the Execution Layer).
function normalizeShipmentLineRecord(raw) {
    var r = raw || {};
    return {
        shipmentLineId: String(r.shipment_line_id || '').trim(),
        shipmentId: String(r.shipment_id || '').trim(),
        sku: String(r.sku || '').trim(),
        // CANONICAL shipment_qty with legacy qty read-fallback. qty kept as UI alias.
        shipmentQty: parseFloat((r.shipment_qty === '' || r.shipment_qty == null) ? r.qty : r.shipment_qty) || 0,
        qty: parseFloat((r.shipment_qty === '' || r.shipment_qty == null) ? r.qty : r.shipment_qty) || 0,
        factoryStockAllocationQty: (r.factory_stock_allocation_qty === '' || r.factory_stock_allocation_qty == null) ? '' : (parseFloat(r.factory_stock_allocation_qty) || 0),
        // Receipt authority (F1-SHIPMENT-RECEIPT-R1B). shipment_received_qty = CUMULATIVE physically-received
        // qty (live DB column; blank/null historical rows normalize to 0). remainingQty is runtime-derived
        // = max(shipmentQty - received, 0) and is NEVER persisted. shipment_qty stays immutable.
        shipmentReceivedQty: (r.shipment_received_qty === '' || r.shipment_received_qty == null) ? 0 : (parseFloat(r.shipment_received_qty) || 0),
        remainingQty: (function () {
            var shipped = parseFloat((r.shipment_qty === '' || r.shipment_qty == null) ? r.qty : r.shipment_qty) || 0;
            var recv = (r.shipment_received_qty === '' || r.shipment_received_qty == null) ? 0 : (parseFloat(r.shipment_received_qty) || 0);
            return Math.max(shipped - recv, 0);
        })(),
        // CANONICAL shipment_carton_qty with legacy carton_qty read-fallback. cartonQty kept as UI alias.
        shipmentCartonQty: parseFloat((r.shipment_carton_qty === '' || r.shipment_carton_qty == null) ? r.carton_qty : r.shipment_carton_qty) || 0,
        cartonQty: parseFloat((r.shipment_carton_qty === '' || r.shipment_carton_qty == null) ? r.carton_qty : r.shipment_carton_qty) || 0,
        cartonNoStart: String(r.carton_no_start || '').trim(),
        cartonNoEnd: String(r.carton_no_end || '').trim(),
        unitsPerCarton: parseFloat(r.units_per_carton) || 0,
        // LINE-TOTAL CBM. Canonical shipment_carton_cbm; legacy per-carton carton_cbm read-fallback
        // (historical rows only). cartonCbm / cbm are frontend read-compat aliases = the same line-total
        // value; outbound writes must use shipment_carton_cbm. NEVER multiplied by cartons in the frontend.
        shipmentCartonCbm: (function () { var v = (r.shipment_carton_cbm === '' || r.shipment_carton_cbm == null) ? r.carton_cbm : r.shipment_carton_cbm; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        cartonCbm: (function () { var v = (r.shipment_carton_cbm === '' || r.shipment_carton_cbm == null) ? r.carton_cbm : r.shipment_carton_cbm; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        cbm: (function () { var v = (r.shipment_carton_cbm === '' || r.shipment_carton_cbm == null) ? r.carton_cbm : r.shipment_carton_cbm; return (v === '' || v == null) ? '' : (parseFloat(v) || 0); })(),
        grossWeight: (r.gross_weight === '' || r.gross_weight == null) ? '' : (parseFloat(r.gross_weight) || 0),
        netWeight: (r.net_weight === '' || r.net_weight == null) ? '' : (parseFloat(r.net_weight) || 0),
        purchaseOrderLineId: String(r.purchase_order_line_id || '').trim(),
        // R6 — FROZEN receiver lineage (blank on historical rows → merged stays fail-closed/MULTI).
        shippingPlanLineId: String(r.shipping_plan_line_id || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        // Execution Snapshot (copied from the Decision Snapshot; immutable)
        snapshotCurrentStock: parseFloat(r.snapshot_current_stock) || 0,
        snapshotAvgSalesPerDay: parseFloat(r.snapshot_avg_sales_per_day) || 0,
        snapshotDaysOfSupply: (r.snapshot_days_of_supply === '' || r.snapshot_days_of_supply == null) ? '' : r.snapshot_days_of_supply,
        snapshotSuggestedQty: parseFloat(r.snapshot_suggested_qty) || 0,
        snapshotTargetDays: parseFloat(r.snapshot_target_days) || 0,
        snapshotFcContext: (r.snapshot_fc_context == null) ? '' : r.snapshot_fc_context,
        snapshotEventContext: (r.snapshot_event_context == null) ? '' : r.snapshot_event_context,
        snapshotAvgSalesSource: String(r.snapshot_avg_sales_source || '').trim(),
        snapshotAvgSalesWarning: String(r.snapshot_avg_sales_warning || '').trim(),
        raw: r
    };
}

// ========================================
// Procurement Layer (Phase 1) normalizers
// request_orders / request_order_lines / purchase_orders / purchase_order_lines.
// See REQUEST_ORDER_AND_PURCHASE_ORDER_SPEC.md + DATABASE_RELATIONSHIP_MAP.md §7.
// ========================================

// Request Order (Procurement Planning Draft) header.
function normalizeRequestOrderRecord(raw) {
    var r = raw || {};
    return {
        requestOrderId: String(r.request_order_id || '').trim(),
        requestOrderNo: String(r.request_order_no || '').trim(),
        requestOrderVersion: parseFloat(r.request_order_version) || 1,
        parentRequestOrderId: String(r.parent_request_order_id || '').trim(),
        company: String(r.company || '').trim(),
        supplierId: String(r.supplier_id || '').trim(),
        supplierName: String(r.supplier_name || '').trim(),
        factoryId: String(r.factory_id || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        // Canonical status = request_status; fall back to legacy `status` for back-compat only.
        requestStatus: String(r.request_status || r.status || '').trim(),
        status: String(r.request_status || r.status || '').trim(),
        tierGroup: String(r.tier_group || '').trim(),
        totalSku: parseFloat(r.total_sku) || 0,
        totalQty: parseFloat(r.total_qty) || 0,
        totalCartons: parseFloat(r.total_cartons) || 0,
        estimatedAmount: (r.estimated_amount === '' || r.estimated_amount == null) ? '' : (parseFloat(r.estimated_amount) || 0),
        currency: String(r.currency || '').trim(),
        source: String(r.source || '').trim(),
        sourceRefType: String(r.source_ref_type || '').trim(),
        sourceRefId: String(r.source_ref_id || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        submittedBy: String(r.submitted_by || '').trim(),
        submittedAt: String(r.submitted_at || '').trim(),
        approvedBy: String(r.approved_by || '').trim(),
        approvedAt: String(r.approved_at || '').trim(),
        rejectedBy: String(r.rejected_by || '').trim(),
        rejectedAt: String(r.rejected_at || '').trim(),
        rejectedReason: String(r.rejected_reason || '').trim(),
        cancelledBy: String(r.cancelled_by || '').trim(),
        cancelledAt: String(r.cancelled_at || '').trim(),
        completedBy: String(r.completed_by || '').trim(),
        completedAt: String(r.completed_at || '').trim(),
        note: String(r.note || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

function normalizeRequestOrderLineRecord(raw) {
    var r = raw || {};
    return {
        requestOrderLineId: String(r.request_order_line_id || '').trim(),
        requestOrderId: String(r.request_order_id || '').trim(),
        sku: String(r.sku || '').trim(),
        series: String(r.series || '').trim(),
        company: String(r.company || '').trim(),
        requestBucket: String(r.request_bucket || '').trim(),   // canonical T1/T2/T3 (tier_type deprecated)
        requestMonth: String(r.request_month || '').trim(),
        inspectionDate: String(r.inspection_date || '').trim(),
        expectedReadyDate: String(r.expected_ready_date || '').trim(),
        expectedShipDate: String(r.expected_ship_date || '').trim(),
        requestedQty: parseFloat(r.requested_qty) || 0,
        approvedQty: parseFloat(r.approved_qty) || 0,
        // Per-company allocation (primary). matched company = qty, others 0.
        kmQty: parseFloat(r.km_qty) || 0,
        resusQty: parseFloat(r.resus_qty) || 0,
        restwQty: parseFloat(r.restw_qty) || 0,
        unitsPerCarton: parseFloat(r.units_per_carton) || 0,
        cartonQty: parseFloat(r.carton_qty) || 0,
        shortageQty: (r.shortage_qty === '' || r.shortage_qty == null) ? '' : (parseFloat(r.shortage_qty) || 0),
        calculationMethod: String(r.calculation_method || '').trim(),
        lineStatus: String(r.line_status || '').trim(),
        // Canonical purchase_order_line_id (traceability); falls back to legacy linked_purchase_order_line_id for old rows.
        purchaseOrderLineId: String(r.purchase_order_line_id || r.linked_purchase_order_line_id || '').trim(),
        supplierId: String(r.supplier_id || '').trim(),
        supplierName: String(r.supplier_name || '').trim(),
        supplierSku: String(r.supplier_sku || '').trim(),
        unitCost: (r.unit_cost === '' || r.unit_cost == null) ? '' : (parseFloat(r.unit_cost) || 0),
        estimatedAmount: (r.estimated_amount === '' || r.estimated_amount == null) ? '' : (parseFloat(r.estimated_amount) || 0),
        currency: String(r.currency || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        // Deprecated columns (read-only back-compat; no longer written / primary).
        productName: String(r.product_name || '').trim(),
        finalOrderQty: (r.final_order_qty === '' || r.final_order_qty == null) ? '' : (parseFloat(r.final_order_qty) || 0),
        raw: r
    };
}

// Purchase Order (Procurement Commitment) header.
function normalizePurchaseOrderRecord(raw) {
    var r = raw || {};
    // Canonical order_status (falls back to legacy `status` for old rows).
    var orderStatus = String(r.order_status || r.status || '').trim();
    // Canonical supplier timeline (falls back to legacy expected_ready_date / confirmed_ready_date).
    var supplierExpectedReady = String(r.supplier_expected_ready_date || r.expected_ready_date || '').trim();
    var supplierConfirmedReady = String(r.supplier_confirmed_ready_date || r.confirmed_ready_date || '').trim();
    var expectedCompletion = String(r.expected_completion_date || supplierExpectedReady || '').trim();
    var poNo = String(r.po_no || r.purchase_order_no || '').trim();
    return {
        purchaseOrderId: String(r.purchase_order_id || '').trim(),
        poNo: poNo,
        kmPoNo: String(r.km_po_no || '').trim(),
        purchaseOrderNo: String(r.purchase_order_no || r.po_no || '').trim(),
        poVersion: parseFloat(r.po_version) || 1,
        parentPurchaseOrderId: String(r.parent_purchase_order_id || '').trim(),
        requestOrderId: String(r.request_order_id || '').trim(),
        requestBucket: String(r.request_bucket || '').trim(),   // T1 or T2_T3
        company: String(r.company || '').trim(),
        supplierId: String(r.supplier_id || '').trim(),
        supplierName: String(r.supplier_name || '').trim(),
        factoryId: String(r.factory_id || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        // order_status is canonical; `status` kept as a back-compat alias (same value) for existing UI.
        orderStatus: orderStatus,
        status: orderStatus,
        orderDate: String(r.order_date || '').trim(),
        currency: String(r.currency || '').trim(),
        totalSku: parseFloat(r.total_sku) || 0,
        totalQty: parseFloat(r.total_qty) || 0,
        totalAmount: (r.total_amount === '' || r.total_amount == null) ? '' : (parseFloat(r.total_amount) || 0),
        subtotalAmount: (r.subtotal_amount === '' || r.subtotal_amount == null) ? '' : (parseFloat(r.subtotal_amount) || 0),
        depositAmount: (r.deposit_amount === '' || r.deposit_amount == null) ? '' : (parseFloat(r.deposit_amount) || 0),
        balanceAmount: (r.balance_amount === '' || r.balance_amount == null) ? '' : (parseFloat(r.balance_amount) || 0),
        paidAmount: (r.paid_amount === '' || r.paid_amount == null) ? '' : (parseFloat(r.paid_amount) || 0),
        paymentStatus: String(r.payment_status || '').trim(),
        paymentTermId: String(r.payment_term_id || '').trim(),
        inspectionDate: String(r.inspection_date || '').trim(),
        expectedCompletionDate: expectedCompletion,
        expectedShipDate: String(r.expected_ship_date || '').trim(),
        depositDueDate: String(r.deposit_due_date || '').trim(),   // = order_date + 5 business days (stamped at Send PO)
        supplierExpectedReadyDate: supplierExpectedReady,
        supplierConfirmedReadyDate: supplierConfirmedReady,
        // Back-compat alias for existing UI (Expected Ready) — mirrors supplier_expected_ready_date.
        expectedReadyDate: supplierExpectedReady,
        confirmedReadyDate: supplierConfirmedReady,
        issuedBy: String(r.issued_by || '').trim(),
        issuedAt: String(r.issued_at || '').trim(),
        confirmedBy: String(r.confirmed_by || '').trim(),
        confirmedAt: String(r.confirmed_at || '').trim(),
        cancelledBy: String(r.cancelled_by || '').trim(),
        cancelledAt: String(r.cancelled_at || '').trim(),
        completedBy: String(r.completed_by || '').trim(),
        completedAt: String(r.completed_at || '').trim(),
        // Closure (auto when all lines remaining_qty=0, or manual with a reason).
        closureReason: String(r.closure_reason || '').trim(),
        closedBy: String(r.closed_by || '').trim(),
        closedAt: String(r.closed_at || '').trim(),
        note: String(r.note || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

function normalizePurchaseOrderLineRecord(raw) {
    var r = raw || {};
    return {
        purchaseOrderLineId: String(r.purchase_order_line_id || '').trim(),
        purchaseOrderId: String(r.purchase_order_id || '').trim(),
        requestOrderLineId: String(r.request_order_line_id || '').trim(),
        requestOrderId: String(r.request_order_id || '').trim(),
        requestBucket: String(r.request_bucket || '').trim(),   // original T1 / T2 / T3
        sku: String(r.sku || '').trim(),
        company: String(r.company || '').trim(),
        // product_name is DEPRECATED on purchase_order_lines; kept as a back-compat alias (blank for v2 lines;
        // product display should join sku_details for labels). Runtime must not depend on it.
        productName: String(r.product_name || '').trim(),
        series: String(r.series || '').trim(),
        factoryItemNo: String(r.factory_item_no || '').trim(),
        factoryItemName: String(r.factory_item_name || '').trim(),
        // Company allocation snapshot (mandatory in PO v2).
        kmQty: parseFloat(r.km_qty) || 0,
        resusQty: parseFloat(r.resus_qty) || 0,
        restwQty: parseFloat(r.restw_qty) || 0,
        recommendedQty: (r.recommended_qty === '' || r.recommended_qty == null) ? '' : (parseFloat(r.recommended_qty) || 0),
        requestedQty: parseFloat(r.requested_qty) || 0,
        approvedQty: parseFloat(r.approved_qty) || 0,
        orderedQty: parseFloat(r.ordered_qty) || 0,
        completedQty: parseFloat(r.completed_qty) || 0,
        shippedQty: parseFloat(r.shipped_qty) || 0,
        remainingQty: (r.remaining_qty === '' || r.remaining_qty == null) ? '' : (parseFloat(r.remaining_qty) || 0),
        unitsPerCarton: parseFloat(r.units_per_carton) || 0,
        cartonQty: parseFloat(r.carton_qty) || 0,
        supplierId: String(r.supplier_id || '').trim(),
        supplierName: String(r.supplier_name || '').trim(),
        supplierSku: String(r.supplier_sku || '').trim(),
        supplierWarehouseId: String(r.supplier_warehouse_id || '').trim(),
        unitCost: (r.unit_cost === '' || r.unit_cost == null) ? '' : (parseFloat(r.unit_cost) || 0),
        lineAmount: (r.line_amount === '' || r.line_amount == null) ? '' : (parseFloat(r.line_amount) || 0),
        currency: String(r.currency || '').trim(),
        lineStatus: String(r.line_status || '').trim(),
        inspectionDate: String(r.inspection_date || '').trim(),
        expectedCompletionDate: String(r.expected_completion_date || '').trim(),
        expectedShipDate: String(r.expected_ship_date || '').trim(),
        relatedShipmentId: String(r.related_shipment_id || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// supplier_price_list — v1 lead-time / cost detail layer. IMPORT/MASTER table; [] when the payload
// lacks it (missing-source safe). `suppliers` master table is future (see REQUEST_ORDER spec §12.6).
function normalizeSupplierPriceListRecord(raw) {
    var r = raw || {};
    return {
        supplierPriceId: String(r.supplier_price_id || r.price_id || '').trim(),
        supplierId: String(r.supplier_id || '').trim(),
        supplierName: String(r.supplier_name || r.supplier_name_snapshot || '').trim(),
        supplierWarehouseId: String(r.supplier_warehouse_id || '').trim(),
        sku: String(r.sku || '').trim(),
        supplierSku: String(r.supplier_sku || '').trim(),
        unitCost: (r.unit_cost === '' || r.unit_cost == null) ? '' : (parseFloat(r.unit_cost) || 0),
        currency: String(r.currency || '').trim(),
        leadTimeDays: (r.lead_time_days === '' || r.lead_time_days == null) ? '' : (parseFloat(r.lead_time_days) || 0),
        moq: (r.moq === '' || r.moq == null) ? '' : (parseFloat(r.moq) || 0),
        isActive: String(r.is_active == null ? '' : r.is_active).trim(),
        effectiveFrom: String(r.effective_from || '').trim(),
        effectiveTo: String(r.effective_to || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// ========================================
// Global Logistics Map read models (READ-ONLY; additive 2026-07-23).
// logistics_locations = physical-place master (canonical coordinates); shipment_route_templates +
// _nodes = owner-maintained route reference; shipment_events = runtime evidence. All normalize to []
// when the payload lacks the tab (missing-tab safe). No writer / no mutation is added here.
// ========================================

// Parse a coordinate cell to a Number ONLY when it is a real, in-range value; otherwise null.
// Blank / non-numeric / out-of-range → null (never coerced to 0 — 0,0 is treated as not-a-coordinate).
function _geoNum(v, kind) {
    if (v === '' || v == null) return null;
    var n = parseFloat(v);
    if (!isFinite(n)) return null;
    if (kind === 'lat' && (n < -90 || n > 90)) return null;
    if (kind === 'lng' && (n < -180 || n > 180)) return null;
    return n;
}

function normalizeLogisticsLocationRecord(raw) {
    var r = raw || {};
    return {
        logisticsLocationId: String(r.logistics_location_id || '').trim(),
        locationCode: String(r.location_code || '').trim(),
        locationName: String(r.location_name || '').trim(),
        localName: String(r.local_name || '').trim(),
        locationType: String(r.location_type || '').trim(),
        country: String(r.country || '').trim(),
        subdivisionCode: String(r.subdivision_code || '').trim(),
        region: String(r.region || '').trim(),
        city: String(r.city || '').trim(),
        district: String(r.district || '').trim(),
        addressLine1: String(r.address_line_1 || '').trim(),
        addressLine2: String(r.address_line_2 || '').trim(),
        postalCode: String(r.postal_code || '').trim(),
        latitude: _geoNum(r.latitude, 'lat'),
        longitude: _geoNum(r.longitude, 'lng'),
        coordinateAccuracy: String(r.coordinate_accuracy || '').trim(),
        coordinateSourceType: String(r.coordinate_source_type || '').trim(),
        coordinateSourceReference: String(r.coordinate_source_reference || '').trim(),
        coordinateVerifiedAt: String(r.coordinate_verified_at || '').trim(),
        coordinateVerifiedBy: String(r.coordinate_verified_by || '').trim(),
        verificationStatus: String(r.verification_status || '').trim(),
        recordStatus: String(r.record_status || r.coordinate_status || '').trim(),
        unLocode: String(r.un_locode || '').trim(),
        iataCode: String(r.iata_code || '').trim(),
        icaoCode: String(r.icao_code || '').trim(),
        portCode: String(r.port_code || '').trim(),
        railTerminalCode: String(r.rail_terminal_code || '').trim(),
        warehouseId: String(r.warehouse_id || '').trim(),
        factoryId: String(r.factory_id || '').trim(),
        timezone: String(r.timezone || '').trim(),
        mapLabelPriority: parseInt(r.map_label_priority, 10) || 0,
        isActive: _whBool(r.is_active),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// shipment_route_templates — owner-maintained; READ-ONLY (never modified by this page).
function normalizeShipmentRouteTemplateRecord(raw) {
    var r = raw || {};
    return {
        routeTemplateId: String(r.route_template_id || '').trim(),
        routeTemplateName: String(r.route_template_name || '').trim(),
        routeVersion: String(r.route_version || '').trim(),
        originCountry: String(r.origin_country || '').trim(),
        originWarehouseId: String(r.origin_warehouse_id || '').trim(),
        destinationCountry: String(r.destination_country || '').trim(),
        destinationRegion: String(r.destination_region || '').trim(),
        destinationWarehouseId: String(r.destination_warehouse_id || '').trim(),
        carrierId: String(r.carrier_id || '').trim(),
        transitType: String(r.transit_type || '').trim(),
        lastMileDelivery: String(r.last_mile_delivery || '').trim(),
        customsType: String(r.customs_type || '').trim(),
        priority: parseInt(r.priority, 10) || 0,
        isActive: _whBool(r.is_active),
        effectiveFrom: String(r.effective_from || '').trim(),
        effectiveTo: String(r.effective_to || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// shipment_route_template_nodes — owner-maintained; READ-ONLY. logistics_location_id /
// location_resolution_type / location_ref_* are read DEFENSIVELY (present only after the additive
// Runtime-Mapping-Sync columns are applied; blank until then).
function normalizeShipmentRouteTemplateNodeRecord(raw) {
    var r = raw || {};
    return {
        routeTemplateNodeId: String(r.route_template_node_id || '').trim(),
        routeTemplateId: String(r.route_template_id || '').trim(),
        nodeSequence: parseInt(r.node_sequence, 10) || 0,
        nodeType: String(r.node_type || '').trim(),
        nodeCode: String(r.node_code || '').trim(),
        nodeName: String(r.node_name || '').trim(),
        country: String(r.country || '').trim(),
        region: String(r.region || '').trim(),
        city: String(r.city || '').trim(),
        latitude: _geoNum(r.latitude, 'lat'),
        longitude: _geoNum(r.longitude, 'lng'),
        plannedEventType: String(r.planned_event_type || '').trim(),
        defaultOffsetDays: (r.default_offset_days === '' || r.default_offset_days == null) ? null : (parseFloat(r.default_offset_days) || 0),
        transportModeToNext: String(r.transport_mode_to_next || '').trim(),
        isDestinationPlaceholder: _whBool(r.is_destination_placeholder),
        isRequired: _whBool(r.is_required),
        logisticsLocationId: String(r.logistics_location_id || '').trim(),
        locationResolutionType: String(r.location_resolution_type || '').trim(),
        locationRefType: String(r.location_ref_type || '').trim(),
        locationRefId: String(r.location_ref_id || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// shipment_events — runtime evidence (append-only ledger). READ-ONLY here; spec-only runtime.
function normalizeShipmentEventRecord(raw) {
    var r = raw || {};
    return {
        shipmentEventId: String(r.shipment_event_id || '').trim(),
        shipmentId: String(r.shipment_id || '').trim(),
        shipmentRouteId: String(r.shipment_route_id || '').trim(),
        eventSequence: parseInt(r.event_sequence, 10) || 0,
        eventTime: String(r.event_time || '').trim(),
        eventType: String(r.event_type || '').trim(),
        eventStatus: String(r.event_status || '').trim(),
        locationName: String(r.location_name || '').trim(),
        country: String(r.country || '').trim(),
        city: String(r.city || '').trim(),
        latitude: _geoNum(r.latitude, 'lat'),
        longitude: _geoNum(r.longitude, 'lng'),
        source: String(r.source || '').trim(),
        sourceEventId: String(r.source_event_id || '').trim(),
        rawStatus: String(r.raw_status || '').trim(),
        logisticsLocationId: String(r.logistics_location_id || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        raw: r
    };
}

// shipment_routes (RUNTIME) — one row per Shipment Route NODE (canonical live schema; there is NO
// separate route-header table and NO shipment_route_node_id — see the 2026-07-24 schema audit). Grouped
// by shipment_id + ordered by sequence_no. READ-ONLY; spec-only runtime (no writer here).
function normalizeShipmentRouteRecord(raw) {
    var r = raw || {};
    return {
        shipmentRouteId: String(r.shipment_route_id || '').trim(),
        shipmentId: String(r.shipment_id || '').trim(),
        routeTemplateId: String(r.route_template_id || '').trim(),
        routeTemplateNodeId: String(r.route_template_node_id || '').trim(),
        sequenceNo: parseInt(r.sequence_no, 10) || 0,
        nodeType: String(r.node_type || '').trim(),
        nodeCode: String(r.node_code || '').trim(),
        locationRefType: String(r.location_ref_type || '').trim(),
        locationRefId: String(r.location_ref_id || '').trim(),
        locationName: String(r.location_name || '').trim(),
        country: String(r.country || '').trim(),
        region: String(r.region || '').trim(),
        city: String(r.city || '').trim(),
        latitude: _geoNum(r.latitude, 'lat'),
        longitude: _geoNum(r.longitude, 'lng'),
        transportMode: String(r.transport_mode || '').trim(),
        plannedEventType: String(r.planned_event_type || '').trim(),
        plannedArrivalDate: String(r.planned_arrival_date || '').trim(),
        plannedDepartureDate: String(r.planned_departure_date || '').trim(),
        actualArrivalDate: String(r.actual_arrival_date || '').trim(),
        actualDepartureDate: String(r.actual_departure_date || '').trim(),
        status: String(r.status || '').trim(),
        raw: r
    };
}

function normalizeOperationDb(rawDb) {
    var db = rawDb || {};
    return {
        // supplier_price_list — [] when the tab is absent from the payload (Lead Time then shows '--').
        supplierPriceList: (db.supplier_price_list || []).map(normalizeSupplierPriceListRecord).filter(function(r) { return r.sku; }),
        skuDetails: (db.sku_details || []).map(normalizeSkuDetailsRecord).filter(function(r) { return r.sku; }),
        productFeatures: (db.product_features || []).map(normalizeProductFeatureRecord),
        skuHandbookSummaries: (db.sku_handbook_summaries || []).map(normalizeSkuHandbookSummaryRecord),
        campaigns: (db.campaigns || []).map(normalizeCampaignRecord).filter(function(r) { return r.campaignId; }),
        campaignSkuLines: (db.campaign_sku_lines || []).map(normalizeCampaignSkuLineRecord).filter(function(r) { return r.campaignSkuLineId; }),
        marketplaces: (db.marketplaces || []).map(normalizeMarketplaceRecord).filter(function(r) { return r.marketplaceId || r.marketplace; }),
        marketplaceSkus: (db.marketplace_skus || []).map(normalizeMarketplaceSkuRecord).filter(function(r) { return r.sku; }),
        pricingList: (db.pricing_list || []).map(normalizePricingListRecord).filter(function(r) { return r.pricingId || r.marketplaceSkuId || r.sku; }),
        pricingChangeLog: (db.pricing_change_log || []).map(normalizePricingChangeLogRecord).filter(function(r) { return r.logId || r.pricingId; }),
        fcRegularForecast: (db.fc_regular_forecast || []).map(normalizeFcRegularForecastRecord).filter(function(r) { return r.forecastId || r.sku; }),
        // Phase-1 multi-warehouse demand-allocation config (F1-4B-E). [] when the tab is absent (missing-source safe).
        replenishmentDemandAllocationRules: (db.replenishment_demand_allocation_rules || []).map(normalizeReplenishmentDemandAllocationRuleRecord).filter(function(r) { return r.allocationRuleId || (r.destinationWarehouseId && r.marketplace); }),
        factoryStock: (db.factory_stock || []).map(normalizeFactoryStockRecord).filter(function(r) { return r.factoryStockId || r.sku; }),
        factoryStockMovements: (db.factory_stock_movements || []).map(normalizeFactoryStockMovementRecord).filter(function(r) { return r.movementId || r.sku; }),
        warehouses: (db.warehouses || []).map(normalizeWarehouseRecord).filter(function(r) { return r.warehouseId || r.warehouseName; }),
        overseasInventorySnapshot: (db.overseas_inventory_snapshot || []).map(normalizeOverseasInventorySnapshotRecord).filter(function(r) { return r.warehouseId && r.sku; }),
        overseasInventoryMovements: (db.overseas_inventory_movements || []).map(normalizeOverseasInventoryMovementRecord).filter(function(r) { return r.movementId || r.warehouseId; }),
        // Amazon snapshot + forecast-event source tables (import-only; [] when payload lacks them).
        amazonInventorySnapshot: (db.amazon_inventory_snapshot || []).map(normalizeAmazonInventorySnapshotRecord).filter(function(r) { return r.sku; }),
        amazonInventoryHealthSnapshot: (db.amazon_inventory_health_snapshot || []).map(normalizeAmazonInventoryHealthSnapshotRecord).filter(function(r) { return r.sku; }),
        amazonDailySalesSnapshot: (db.amazon_daily_sales_snapshot || []).map(normalizeAmazonDailySalesSnapshotRecord).filter(function(r) { return r.sku; }),
        amazonWeeklySalesSnapshot: (db.amazon_weekly_sales_snapshot || []).map(normalizeAmazonWeeklySalesSnapshotRecord).filter(function(r) { return r.sku; }),
        fcSpecialEvents: (db.fc_special_events || []).map(normalizeFcSpecialEventRecord).filter(function(r) { return r.event || r.sku || r.scopeId; }),
        fcTargetRules: (db.fc_target_rules || []).map(normalizeFcTargetRuleRecord).filter(function(r) { return r.scopeId || r.ruleId; }),
        shippingPlans: (db.shipping_plans || []).map(normalizeShippingPlanRecord).filter(function(r) { return r.shippingPlanId; }),
        shippingPlanLines: (db.shipping_plan_lines || []).map(normalizeShippingPlanLineRecord).filter(function(r) { return r.shippingPlanLineId || r.shippingPlanId; }),
        shipments: (db.shipments || []).map(normalizeShipmentRecord).filter(function(r) { return r.shipmentId; }),
        shipmentLines: (db.shipment_lines || []).map(normalizeShipmentLineRecord).filter(function(r) { return r.shipmentLineId || r.shipmentId; }),
        // Global Logistics Map read models (READ-ONLY; [] when the payload lacks the tab). Filters are
        // LENIENT — keep any row carrying an identifying / name / coordinate field so a single mismatched
        // PK column name cannot silently drop the whole dataset. window._opDbDiag records raw-vs-kept counts
        // + the raw column keys so a full column-name mismatch is diagnosable from runtime evidence.
        logisticsLocations: (db.logistics_locations || []).map(normalizeLogisticsLocationRecord).filter(function(r) { return r.logisticsLocationId || r.locationCode || r.locationName || r.warehouseId || r.factoryId || r.latitude !== null; }),
        shipmentRouteTemplates: (db.shipment_route_templates || []).map(normalizeShipmentRouteTemplateRecord).filter(function(r) { return r.routeTemplateId || r.routeTemplateName || r.destinationCountry || r.originCountry; }),
        shipmentRouteTemplateNodes: (db.shipment_route_template_nodes || []).map(normalizeShipmentRouteTemplateNodeRecord).filter(function(r) { return r.routeTemplateNodeId || r.routeTemplateId || r.nodeName || r.nodeCode || r.latitude !== null; }),
        shipmentRoutes: (db.shipment_routes || []).map(normalizeShipmentRouteRecord).filter(function(r) { return r.shipmentRouteId || r.shipmentId || r.locationName || r.latitude !== null; }),
        shipmentEvents: (db.shipment_events || []).map(normalizeShipmentEventRecord).filter(function(r) { return r.shipmentEventId || r.shipmentId || r.eventType; }),
        // Procurement Layer (Phase 1) — [] when the payload lacks the table (missing-header safe).
        requestOrders: (db.request_orders || []).map(normalizeRequestOrderRecord).filter(function(r) { return r.requestOrderId; }),
        requestOrderLines: (db.request_order_lines || []).map(normalizeRequestOrderLineRecord).filter(function(r) { return r.requestOrderLineId || r.requestOrderId; }),
        purchaseOrders: (db.purchase_orders || []).map(normalizePurchaseOrderRecord).filter(function(r) { return r.purchaseOrderId; }),
        purchaseOrderLines: (db.purchase_order_lines || []).map(normalizePurchaseOrderLineRecord).filter(function(r) { return r.purchaseOrderLineId || r.purchaseOrderId; }),
        // Request Order second-layer allocation drafts (planning scratchpads — no stock movement).
        requestOrderAllocationDrafts: (db.request_order_allocation_drafts || []).map(normalizeRequestOrderAllocationDraftRecord).filter(function(r) { return r.requestAllocationDraftId; }),
        requestOrderAllocationDraftLines: (db.request_order_allocation_draft_lines || []).map(normalizeRequestOrderAllocationDraftLineRecord).filter(function(r) { return r.requestAllocationLineId || r.requestAllocationDraftId; }),
        // Inventory Replenishment shipping-allocation drafts (Recommendation/Execution Plan Draft = SSOT).
        shippingAllocationDrafts: (db.shipping_allocation_drafts || []).map(normalizeShippingAllocationDraftRecord).filter(function(r) { return r.allocationDraftId; }),
        shippingAllocationDraftLines: (db.shipping_allocation_draft_lines || []).map(normalizeShippingAllocationDraftLineRecord).filter(function(r) { return r.allocationDraftLineId || r.allocationDraftId; }),
        // Request Order site confirmations (site-level approval state — no stock movement, no request_orders).
        requestOrderSiteConfirmations: (db.request_order_site_confirmations || []).map(normalizeRequestOrderSiteConfirmationRecord).filter(function(r) { return r.siteConfirmationId; }),
        // Request Order line SOURCES — source of truth for company/site/month allocation detail (read-only
        // here; write handler is spec-only / pending). [] when the tab is absent (missing-header safe).
        requestOrderLineSources: (db.request_order_line_sources || []).map(normalizeRequestOrderLineSourceRecord),
        // Carrier / Route master layer (Carrier Rate Card v1 — read-only display + append-only import).
        // [] when the tab is absent (missing-header safe). carrier_rate_cards NEVER stores Lead Time.
        carriers: (db.carriers || []).map(normalizeCarrierRecord).filter(function(r) { return r.carrierId || r.carrierName; }),
        carrierRateCards: (db.carrier_rate_cards || []).map(normalizeCarrierRateCardRecord).filter(function(r) { return r.rateCardId || r.carrierId; }),
        carrierLeadTimes: (db.carrier_lead_times || []).map(normalizeCarrierLeadTimeRecord).filter(function(r) { return r.leadTimeId || r.carrierId; }),
        // SKU Domain v2.0 — Regional/Compliance Master (Layer 2) + Tax/Referral Reference Master (Layer 4).
        // [] when the tab is absent (missing-header safe). Tax reference is READ-ONLY (no engine).
        skuRegionalDetails: (db.sku_regional_details || []).map(normalizeSkuRegionalDetailRecord).filter(function(r) { return r.regionalDetailId || r.sku; }),
        taxReferralRates: (db.tax_referral_rates || []).map(normalizeTaxReferralRateRecord).filter(function(r) { return r.taxRateId || r.series; }),
        taxRateComponents: (db.tax_rate_components || []).map(normalizeTaxRateComponentRecord).filter(function(r) { return r.taxComponentId || r.taxRateId; })
    };
}

// SKU Regional Details (SKU Domain v2.0 Layer 2). Regional identity + compliance-document fields ONLY.
// NO tax/duty/hscode/declared-value here (those live in tax_referral_rates). Match grain: sku+company+country+marketplace.
function normalizeSkuRegionalDetailRecord(raw) {
    var r = raw || {};
    function s(v) { return String(v == null ? '' : v).trim(); }
    return {
        regionalDetailId: s(r.regional_detail_id),
        sku: s(r.sku),
        company: s(r.company),
        country: s(r.country),
        marketplace: s(r.marketplace),
        siteSku: s(r.site_sku),
        // Canonical platform-neutral id; legacy asin READ-fallback only.
        marketplaceProductId: s(r.marketplace_product_id) || s(r.asin),
        productUrl: s(r.product_url),   // country/marketplace-specific product listing URL (nullable)
        packagingRegulation: s(r.packaging_regulation),
        regulationUrl: s(r.regulation_url),
        language: s(r.language) || s(r.manual_language),   // v1 manual_language read-fallback
        manualVersion: s(r.manual_version),
        labelVersion: s(r.label_version),
        batteryRegulation: s(r.battery_regulation),
        createdAt: s(r.created_at),
        updatedAt: s(r.updated_at),
        raw: r
    };
}

// Tax & Referral Rates (SKU Domain v2.0 Layer 4 — Reference Master). READ-ONLY here; no calculation.
// Single source of truth for HS Code / Duty / VAT / Referral / Declared Value. Keyed by series (+ duty_country).
function normalizeTaxReferralRateRecord(raw) {
    var r = raw || {};
    function s(v) { return String(v == null ? '' : v).trim(); }
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        taxRateId: s(r.tax_rate_id),
        series: s(r.series),
        countryOfOrigin: s(r.country_of_origin),
        dutyCountry: s(r.duty_country),
        hscode: s(r.hscode),                                              // canonical (spec §I camelCase = hscode)
        hsCode: s(r.hscode),                                              // existing-consumer alias (sku-handbook / overrides)
        dutyRate: n(r.duty_rate),
        vatNo: s(r.vat_no),                                               // VAT / tax registration number (nullable)
        eoriNo: s(r.eori_no),                                             // EORI registration number for EU/UK customs (nullable)
        vatRate: n(r.vat_rate) !== '' ? n(r.vat_rate) : n(r.vat),          // canonical vat_rate; legacy `vat` READ-fallback only
        portTaxRate: n(r.port_tax_rate) !== '' ? n(r.port_tax_rate) : n(r.port_tax),   // canonical port_tax_rate; legacy `port_tax` READ-fallback only
        referralFeeRate: n(r.referral_fee_rate),
        declaredValue: n(r.declared_value),
        declaredCurrency: s(r.declared_currency),
        effectiveFrom: s(r.effective_from),
        effectiveTo: s(r.effective_to),                                   // blank = open-ended (never invalid)
        note: s(r.note),
        createdAt: s(r.created_at),
        updatedAt: s(r.updated_at),
        raw: r
    };
    // NOTE (v2): retired v1 column `extra_tax_rate` is intentionally NOT exposed as a canonical property.
}

// Tax rate COMPONENT (child of tax_referral_rates). Optional additional/compound tax element.
// See TAX_AND_REFERRAL_RATES_SPEC.md §2.2/§6. Rate convention = whole-number percent (§7).
function normalizeTaxRateComponentRecord(raw) {
    var r = raw || {};
    function s(v) { return String(v == null ? '' : v).trim(); }
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        taxComponentId: s(r.tax_component_id),
        taxRateId: s(r.tax_rate_id),                                      // FK → tax_referral_rates.tax_rate_id
        componentType: s(r.component_type),
        componentCode: s(r.component_code),
        componentName: s(r.component_name),
        rateType: s(r.rate_type),                                         // percentage | amount_per_unit | fixed_amount
        rateValue: n(r.rate_value),                                       // used when rate_type = percentage
        amountPerUnit: n(r.amount_per_unit),
        amountCurrency: s(r.amount_currency),
        quantityUnit: s(r.quantity_unit),
        effectiveFrom: s(r.effective_from),
        effectiveTo: s(r.effective_to),
        sourceUrl: s(r.source_url),
        note: s(r.note),
        createdAt: s(r.created_at),
        updatedAt: s(r.updated_at),
        raw: r
    };
}

// Carrier master (logistics provider). Reference/master data only — not a Decision Layer.
function normalizeCarrierRecord(raw) {
    var r = raw || {};
    return {
        carrierId: String(r.carrier_id || '').trim(),
        carrierCode: String(r.carrier_code || '').trim(),
        carrierName: String(r.carrier_name || '').trim(),
        carrierType: String(r.carrier_type || '').trim(),
        contactName: String(r.contact_name || '').trim(),
        contactEmail: String(r.contact_email || '').trim(),
        contactPhone: String(r.contact_phone || '').trim(),
        isActive: (function(v){ var s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'true' || s === 'yes' || s === '1' || s === 'active'; })(r.is_active),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Carrier rate card (rate + validity ONLY). NO lead time / transit_days here (v1.4 — single source of
// truth for Lead Time is carrier_lead_times). Numbers coerced; blank stays '' where meaningful.
function normalizeCarrierRateCardRecord(raw) {
    var r = raw || {};
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        rateCardId: String(r.rate_card_id || '').trim(),
        carrierId: String(r.carrier_id || '').trim(),
        originCountry: String(r.origin_country || '').trim(),
        originCity: String(r.origin_city || '').trim(),
        destinationCountry: String(r.destination_country || '').trim(),
        destinationCity: String(r.destination_city || '').trim(),
        destinationPostalCodeStart: String(r.destination_postal_code_start || '').trim(),
        destinationPostalCodeEnd: String(r.destination_postal_code_end || '').trim(),
        destinationWarehouseCode: String(r.destination_warehouse_code || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        shippingMethod: String(r.shipping_method || '').trim(),
        lastMileDelivery: String(r.last_mile_delivery || '').trim(),
        // Localized display label for the service combination (display metadata; canonical fields above stay authoritative).
        shippingMethodLabel: String(r.shipping_method_label || '').trim(),
        chargeType: String(r.charge_type || '').trim(),
        chargeUnit: String(r.charge_unit || '').trim(),
        dimDivisor: n(r.dim_divisor),
        minBoxWeight: n(r.min_box_weight),
        minBoxWeightUnit: String(r.min_box_weight_unit || '').trim(),
        weightTier: n(r.weight_tier),
        weightTierUnit: String(r.weight_tier_unit || '').trim(),
        currency: String(r.currency || '').trim(),
        unitRate: n(r.unit_rate),
        minCharge: n(r.min_charge),
        fuelSurcharge: n(r.fuel_surcharge),
        customsFee: n(r.customs_fee),
        docFee: n(r.doc_fee),
        transitType: String(r.transit_type || '').trim(),
        batteryType: String(r.battery_type || '').trim(),
        customsType: String(r.customs_type || '').trim(),
        // Localized customs Label (display metadata; enum stays authoritative). Blank rows derive from the map.
        customsTypeLabel: String(r.customs_type_label || '').trim() || customsTypeLabelFallback_(r.customs_type),
        // import_duty_treatment: included_in_rate | excluded_in_rate | '' (blank = needs data completion;
        // NEVER auto-derived from customs_type; a blank must NOT be treated as a known cross-border result).
        importDutyTreatment: String(r.import_duty_treatment || '').trim(),
        note: String(r.note || '').trim(),
        effectiveFrom: String(r.effective_from || '').trim(),
        effectiveTo: String(r.effective_to || '').trim(),
        status: String(r.status || '').trim(),
        sourceFileName: String(r.source_file_name || '').trim(),
        importBatchId: String(r.import_batch_id || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Carrier lead time — the SINGLE SOURCE OF TRUTH for Lead Time (display-only join on the Rate Card page).
function normalizeCarrierLeadTimeRecord(raw) {
    var r = raw || {};
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        leadTimeId: String(r.lead_time_id || '').trim(),
        carrierId: String(r.carrier_id || '').trim(),
        originCountry: String(r.origin_country || '').trim(),
        destinationCountry: String(r.destination_country || '').trim(),
        shippingMethod: String(r.shipping_method || '').trim(),
        lastMileDelivery: String(r.last_mile_delivery || '').trim(),
        minDays: n(r.min_days),
        maxDays: n(r.max_days),
        avgDays: n(r.avg_days),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Request Order line source — the append-only company/site/month allocation detail behind each request
// line. Source of truth for the Company Allocation popup. Written at request creation (13_ createRequestOrderDraft).
// Reads whatever the tab contains (numbers coerced). PK = request_order_line_source_id (legacy line_source_id
// read as fallback). tier_type / source_bucket = T1/T2/T3; source_month = YYYY-MM.
function normalizeRequestOrderLineSourceRecord(raw) {
    var r = raw || {};
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        lineSourceId: String(r.request_order_line_source_id || r.line_source_id || '').trim(),
        requestOrderLineId: String(r.request_order_line_id || '').trim(),
        requestOrderId: String(r.request_order_id || '').trim(),
        sku: String(r.sku || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        marketplaceProductId: String(r.marketplace_product_id || r.asin || '').trim(),
        tierType: String(r.tier_type || r.request_bucket || '').trim(),
        sourceMonth: String(r.source_month || r.request_month || '').trim(),
        forecastQty: n(r.forecast_qty),
        currentStock: n(r.current_stock),
        onTheWayQty: n(r.on_the_way_qty),
        shortageQty: n(r.shortage_qty),
        reallocationQty: n(r.reallocation_qty),
        recommendedQty: n(r.recommended_qty),
        requestedQty: parseFloat(r.requested_qty) || 0,
        approvedQty: parseFloat(r.approved_qty) || 0,
        allocationMethod: String(r.allocation_method || '').trim(),
        sourceBucket: String(r.source_bucket || r.tier_type || '').trim(),
        sourcePriority: n(r.source_priority),
        sourceType: String(r.source_type || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// Request Order site confirmation. Upsert key = planning_cycle + company + country + marketplace +
// series + bucket. status enum pending/confirmed/cancelled. Records approval only (Confirm Site).
function normalizeRequestOrderSiteConfirmationRecord(raw) {
    var r = raw || {};
    return {
        siteConfirmationId: String(r.site_confirmation_id || '').trim(),
        planningCycle: String(r.planning_cycle || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        series: String(r.series || '').trim(),
        bucket: String(r.bucket || '').trim(),
        status: String(r.status || '').trim(),
        confirmedBy: String(r.confirmed_by || '').trim(),
        confirmedAt: String(r.confirmed_at || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Request Order second-layer allocation draft (header). Planning scratchpad only (no stock effect).
// Request Order second-layer allocation draft (header). CANONICAL fields (2026-07-27 DB sync);
// generation_type replaces the retired source_type, category_snapshot/series_snapshot replace
// category/series. Legacy columns are read ONLY as a compatibility fallback (never written).
function normalizeRequestOrderAllocationDraftRecord(raw) {
    var r = raw || {};
    function pick(canon, legacy) { var v = r[canon]; if (v == null || v === '') v = legacy != null ? r[legacy] : ''; return String(v || '').trim(); }
    return {
        requestAllocationDraftId: String(r.request_allocation_draft_id || '').trim(),
        planningCycle: String(r.planning_cycle || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        sku: String(r.sku || '').trim(),
        categorySnapshot: pick('category_snapshot', r.category),   // legacy: category
        seriesSnapshot: pick('series_snapshot', r.series),         // legacy: series
        status: String(r.status || '').trim(),
        generationType: pick('generation_type', r.source_type),    // legacy: source_type (retired)
        draftPurpose: String(r.draft_purpose || '').trim(),
        calculationRunId: String(r.calculation_run_id || '').trim(),
        formulaVersion: String(r.formula_version || '').trim(),
        calculatedAt: String(r.calculated_at || '').trim(),
        sourceDataAsOf: String(r.source_data_as_of || '').trim(),
        draftVersion: String(r.draft_version || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        submittedBy: String(r.submitted_by || '').trim(),
        submittedAt: String(r.submitted_at || '').trim(),
        cancelledBy: String(r.cancelled_by || '').trim(),
        cancelledAt: String(r.cancelled_at || '').trim(),
        cancelReason: String(r.cancel_reason || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// Request Order second-layer allocation draft (line). request_bucket = T1/T2/T3. CANONICAL fields
// (2026-07-27 DB sync): regular_demand_snapshot (legacy fc_qty_snapshot) · destination_stock_snapshot
// (legacy site_stock_snapshot) · third_party_available_qty_snapshot (legacy third_party_stock_snapshot)
// · factory_available_qty_snapshot (legacy factory_stock_snapshot). recommended_qty (system Suggested
// Order snapshot) and order_qty (user input) stay independent. Blank numeric snapshots stay blank (a
// not-yet-calculated Engine A/B value is never coerced to 0). Legacy columns are read-only fallbacks.
function normalizeRequestOrderAllocationDraftLineRecord(raw) {
    var r = raw || {};
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    function nfb(canon, legacy) { var v = r[canon]; if (v == null || v === '') v = legacy; return n(v); }
    return {
        requestAllocationLineId: String(r.request_allocation_line_id || '').trim(),
        requestAllocationDraftId: String(r.request_allocation_draft_id || '').trim(),
        requestMonth: String(r.request_month || '').trim(),
        requestBucket: String(r.request_bucket || '').trim(),
        regularDemandSnapshot: nfb('regular_demand_snapshot', r.fc_qty_snapshot),
        specialEventDemandSnapshot: n(r.special_event_demand_snapshot),
        destinationStockSnapshot: nfb('destination_stock_snapshot', r.site_stock_snapshot),
        thirdPartyAvailableQtySnapshot: nfb('third_party_available_qty_snapshot', r.third_party_stock_snapshot),
        qualifiedIncomingSnapshot: n(r.qualified_incoming_snapshot),
        approvedSupplySnapshot: n(r.approved_supply_snapshot),
        factoryAvailableQtySnapshot: nfb('factory_available_qty_snapshot', r.factory_stock_snapshot),
        targetPctSnapshot: n(r.target_pct_snapshot),
        calculatedGapQtySnapshot: n(r.calculated_gap_qty_snapshot),
        recommendedShippingQtySnapshot: n(r.recommended_shipping_qty_snapshot),
        residualProductionRequiredSnapshot: n(r.residual_production_required_snapshot),
        reallocationInQtySnapshot: n(r.reallocation_in_qty_snapshot),
        reallocationOutQtySnapshot: n(r.reallocation_out_qty_snapshot),
        netOrderNeedSnapshot: n(r.net_order_need_snapshot),
        recommendedQty: n(r.recommended_qty),
        orderQty: n(r.order_qty),
        cartonQty: n(r.carton_qty),
        unitsPerCarton: n(r.units_per_carton),
        allocationMethod: String(r.allocation_method || '').trim(),
        recommendationReason: String(r.recommendation_reason || '').trim(),
        recommendationFlags: String(r.recommendation_flags || '').trim(),
        lineStatus: String(r.line_status || '').trim(),
        submittedBy: String(r.submitted_by || '').trim(),
        submittedAt: String(r.submitted_at || '').trim(),
        note: String(r.note || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// Inventory Replenishment shipping-allocation draft (header). Persisted Draft = SSOT for the cycle
// (INVENTORY_TABLE_MAPPING_SPEC §11.4). Planning only — no stock effect. generation_type replaces
// the legacy source_type. `raw` is preserved so the Recommendation Summary can read snapshot columns.
function normalizeShippingAllocationDraftRecord(raw) {
    var r = raw || {};
    return {
        allocationDraftId: String(r.allocation_draft_id || '').trim(),
        planningCycle: String(r.planning_cycle || '').trim(),
        sourcePage: String(r.source_page || '').trim(),
        company: String(r.company || '').trim(),
        country: String(r.country || '').trim(),
        marketplace: String(r.marketplace || '').trim(),
        status: String(r.status || '').trim(),
        generationType: String(r.generation_type || r.source_type || '').trim(),   // source_type = legacy read-fallback
        calculationRunId: String(r.calculation_run_id || '').trim(),
        calculatedAt: String(r.calculated_at || '').trim(),
        sourceDataAsOf: String(r.source_data_as_of || '').trim(),
        draftVersion: String(r.draft_version || '').trim(),
        createdBy: String(r.created_by || '').trim(),
        createdAt: String(r.created_at || '').trim(),
        updatedBy: String(r.updated_by || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        submittedBy: String(r.submitted_by || '').trim(),
        submittedAt: String(r.submitted_at || '').trim(),
        note: String(r.note || '').trim(),
        raw: r
    };
}

// Inventory Replenishment shipping-allocation draft (line). recommended_qty = immutable system
// snapshot (legacy alias recommand_shipment_draft_qty); planned_qty = user execution qty (legacy
// aliases shipment_draft_qty / qty). MUST-NOT-store display fields are never read as canonical.
function normalizeShippingAllocationDraftLineRecord(raw) {
    var r = raw || {};
    function n(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v); }
    return {
        allocationDraftLineId: String(r.allocation_draft_line_id || '').trim(),
        allocationDraftId: String(r.allocation_draft_id || '').trim(),
        sku: String(r.sku || '').trim(),
        siteSku: String(r.site_sku || '').trim(),
        routeNo: String(r.route_no || '').trim(),
        lineStatus: String(r.line_status || '').trim(),
        windowCode: String(r.window_code || '').trim(),
        requiredByDate: String(r.required_by_date || '').trim(),
        calculatedGapQty: n(r.calculated_gap_qty),
        // recommended_qty canonical; recommand_shipment_draft_qty = legacy read/migration alias only.
        recommendedQty: n(r.recommended_qty != null && r.recommended_qty !== '' ? r.recommended_qty : r.recommand_shipment_draft_qty),
        recommendedShippingMethod: String(r.recommended_shipping_method || '').trim(),
        recommendedCarrierId: String(r.recommended_carrier_id || '').trim(),
        recommendedLastMileDelivery: String(r.recommended_last_mile_delivery || '').trim(),
        recommendedExpectedArrival: String(r.recommended_expected_arrival || '').trim(),
        recommendationReason: String(r.recommendation_reason || '').trim(),
        // planned_qty canonical; shipment_draft_qty / qty = legacy read/migration aliases only.
        plannedQty: n(r.planned_qty != null && r.planned_qty !== '' ? r.planned_qty : (r.shipment_draft_qty != null && r.shipment_draft_qty !== '' ? r.shipment_draft_qty : r.qty)),
        shipFrom: String(r.ship_from || '').trim(),
        destination: String(r.destination || '').trim(),
        selectedShippingMethod: String(r.selected_shipping_method || '').trim(),
        selectedLeadTimeId: String(r.selected_lead_time_id || '').trim(),
        selectedCarrierId: String(r.selected_carrier_id || '').trim(),
        expectedArrival: String(r.expected_arrival || '').trim(),
        overrideReason: String(r.override_reason || '').trim(),
        unitsPerCarton: n(r.units_per_carton),
        createdAt: String(r.created_at || '').trim(),
        updatedAt: String(r.updated_at || '').trim(),
        raw: r
    };
}

// ========================================
// Product Features Relation
// ========================================

function getProductFeatureForSku(skuItem, productFeatures) {
    if (!skuItem || !productFeatures || productFeatures.length === 0) return null;
    var sku = (skuItem.sku || '').trim().toLowerCase();
    var series = (skuItem.series || '').trim().toLowerCase();
    var category = (skuItem.category || skuItem.productLine || '').trim().toLowerCase();

    // Priority 1: scope_type = sku
    var match = productFeatures.find(function(pf) {
        return pf.scopeType === 'sku' && pf.scopeId.toLowerCase() === sku;
    });
    if (match) return match;

    // Priority 2: scope_type = series
    match = productFeatures.find(function(pf) {
        return pf.scopeType === 'series' && pf.scopeId.toLowerCase() === series;
    });
    if (match) return match;

    // Priority 3: scope_type = category
    match = productFeatures.find(function(pf) {
        return pf.scopeType === 'category' && pf.scopeId.toLowerCase() === category;
    });
    if (match) return match;

    return null;
}

// ========================================
// Merge: SKU Knowledge Items
// ========================================

function buildSkuKnowledgeItems(skuDetails, productFeatures, handbookSummaries) {
    return skuDetails.map(function(item) {
        var pf = getProductFeatureForSku(item, productFeatures);
        var pfMatchLevel = 'none';
        if (pf) {
            var skuLc = (item.sku || '').trim().toLowerCase();
            var seriesLc = (item.series || '').trim().toLowerCase();
            if (pf.scopeType === 'sku' && pf.scopeId.toLowerCase() === skuLc) pfMatchLevel = 'sku';
            else if (pf.scopeType === 'series' && pf.scopeId.toLowerCase() === seriesLc) pfMatchLevel = 'series';
            else pfMatchLevel = 'category';
        }

        // Handbook summary - prioritize: reviewed > ai_draft > any
        var allSummaries = handbookSummaries.filter(function(s) { return s.sku.toLowerCase() === item.sku.toLowerCase(); });
        var summary = null;
        if (allSummaries.length > 0) {
            summary = allSummaries.find(function(s) { return s.reviewStatus === 'reviewed'; })
                || allSummaries.find(function(s) { return s.reviewStatus === 'ai_draft'; })
                || allSummaries[0];
        }

        // displaySummary + summarySource
        var displaySummary = 'Not provided yet.';
        var summarySource = 'none';
        if (summary && summary.summaryText) {
            displaySummary = summary.summaryText;
            if (summary.reviewStatus === 'reviewed') summarySource = 'handbook_summary_reviewed';
            else if (summary.reviewStatus === 'ai_draft') summarySource = 'handbook_summary_ai_draft';
            else summarySource = 'handbook_summary_fallback';
        } else if (pf && pf.productDescription) {
            displaySummary = pf.productDescription.substring(0, 250);
            summarySource = 'product_features_fallback';
        }
        if (item.isSellingMaterial) {
            displaySummary = 'This is an internal selling material / packaging-related SKU used for internal training and operational reference.\n\n' + displaySummary;
        }

        // displayKeyPoints + keyPointsSource
        var displayKeyPoints = [];
        var keyPointsSource = 'none';
        if (pf && pf.bulletPoints && pf.bulletPoints.length > 0) {
            displayKeyPoints = pf.bulletPoints.slice(0, 5);
            keyPointsSource = 'product_features_bullets';
        }

        // rawReferenceContent
        var rawReferenceContent = null;
        if (pf) {
            rawReferenceContent = {
                productTitle: pf.productTitle,
                productDescription: pf.productDescription,
                bulletPoints: pf.bulletPoints,
                genericKeyword: pf.genericKeyword,
                language: pf.language || '',
                source: 'product_features'
            };
        }

        return Object.assign({}, item, {
            productFeature: pf,
            pfMatchLevel: pfMatchLevel,
            handbookSummary: summary,
            displaySummary: displaySummary,
            summarySource: summarySource,
            displayKeyPoints: displayKeyPoints,
            keyPointsSource: keyPointsSource,
            rawReferenceContent: rawReferenceContent,
            isSellingMaterial: item.isSellingMaterial
        });
    });
}

// ========================================
// DB Cache & Public Interface
// ========================================

window._opDbCache = null;

function _buildMockFallbackDb() {
    // Convert existing mock data to normalized format
    var allSkus = [
        ...(window.upcomingSkuData || []).map(function(i) { return Object.assign({}, i, { lifecycle: 'Upcoming SKU' }); }),
        ...(window.runningSkuData || []).map(function(i) { return Object.assign({}, i, { lifecycle: 'Running in the Market' }); }),
        ...(window.phasingOutSkuData || []).map(function(i) { return Object.assign({}, i, { lifecycle: 'Phasing Out' }); })
    ];

    var skuDetails = allSkus.map(function(item) {
        return {
            sku: item.sku || '',
            productName: item.productName || '',
            category: item.category || '',
            productLine: item.category || '',
            series: item.series || '',
            lifecycle: item.lifecycle || 'Running in the Market',
            image: item.image || '',
            gs1Code: item.gs1Code || '',
            gs1Type: item.gs1Type || '',
            amzAsin: item.amzAsin || '',
            itemDimensions: item.itemDimensions || '',
            itemWeight: item.itemWeight || '',
            packageDimensions: item.package || item.packageDimensions || '',
            packageWeight: item.packageWeight || '',
            cartonDimensions: item.cartonDimensions || '',
            cartonWeight: item.cartonWeight || '',
            unitsPerCarton: item.unitsPerCarton || 0,
            hsCode: item.hscode || '',
            declaredValue: item.declaredValue || '',
            minimumPrice: item.minimumPrice || '',
            msrp: item.msrp || '',
            sellingPrice: item.sellingPrice || '',
            pm: item.pm || '',
            createdAt: '',
            updatedAt: '',
            isSellingMaterial: (item.category || '').toLowerCase() === 'selling material',
            raw: item
        };
    });

    return {
        skuDetails: skuDetails,
        productFeatures: [],
        skuHandbookSummaries: [],
        campaigns: [],
        campaignSkuLines: [],
        _sourceMode: 'mock'
    };
}

// Scoped runtime diagnostics for the data chain (Global Logistics Map repair, 2026-07-24). Records, per
// key table, the RAW row count from the Web App response vs the KEPT (normalized+filtered) count, plus the
// raw column keys of the first row — so a break can be located from runtime evidence (raw 0 = getter/sheet/
// router; raw N & kept 0 = normalizer/column-name filter; sampleKeys shows the real column names). Read via
// window._opDbDiag or KM.DB.getDataDiagnostics(). No sensitive full payload is stored (keys + counts only).
function _computeOpDbDiag(rawDb, normalized, sourceMode) {
    var map = {
        logistics_locations: 'logisticsLocations', shipment_route_templates: 'shipmentRouteTemplates',
        shipment_route_template_nodes: 'shipmentRouteTemplateNodes', shipment_routes: 'shipmentRoutes',
        shipment_events: 'shipmentEvents', shipments: 'shipments', warehouses: 'warehouses'
    };
    var diag = { sourceMode: sourceMode || 'unknown', at: new Date().toISOString(), tables: {} };
    Object.keys(map).forEach(function (t) {
        var raw = (rawDb && rawDb[t]) || [];
        var kept = (normalized && normalized[map[t]]) || [];
        diag.tables[t] = { raw: raw.length, kept: kept.length, sampleKeys: raw.length ? Object.keys(raw[0] || {}) : [] };
    });
    return diag;
}

async function loadOperationDb(options) {
    var force = (options && options.force) || false;
    if (!force && window._opDbCache && window._opDbCache._sourceMode === 'google-sheet') {
        return window._opDbCache;
    }
    if (isOperationDbApiConfigured()) {
        try {
            var rawDb = await getOperationDbFromSheet();
            var normalized = normalizeOperationDb(rawDb);
            normalized._sourceMode = 'google-sheet';
            try { window._opDbDiag = _computeOpDbDiag(rawDb, normalized, 'google-sheet'); } catch (dErr) {}
            window._opDbCache = normalized;
            OperationDbState.data = normalized;
            OperationDbState.dataSourceMode = 'google-sheet';
            OperationDbState.lastLoadedAt = new Date().toISOString();
            OperationDbState.lastError = null;
            console.log('[OP DB] Loaded from Google Sheet. SKUs:', normalized.skuDetails.length);
            return normalized;
        } catch (e) {
            OperationDbState.lastFetchStatus = 'failed';
            OperationDbState.lastError = e.message;
            // Preserve a previously-good Google Sheet cache on a (forced) reload failure. Clobbering it
            // with mock data would silently drop shipping_plans / shipments and flip the UI to demo mode
            // (the "card disappears after Save / reappears after refresh" bug). A write that already
            // succeeded server-side stays visible; the next successful load reconciles any staleness.
            if (window._opDbCache && window._opDbCache._sourceMode === 'google-sheet') {
                console.warn('[OP DB] Google Sheet reload failed:', e.message, '- keeping existing cloud cache.');
                window._opDbCache._apiFailed = true;
                OperationDbState.lastLoadedAt = new Date().toISOString();
                return window._opDbCache;
            }
            console.warn('[OP DB] Google Sheet API failed:', e.message, '- falling back to mock data.');
            window._opDbCache = _buildMockFallbackDb();
            window._opDbCache._sourceMode = 'mock';   // explicit: NEVER mistaken for production google-sheet data
            window._opDbCache._apiFailed = true;
            window._opDbCache._apiError = e.message;
            window._opDbDiag = { sourceMode: 'mock', at: new Date().toISOString(), apiError: e.message, tables: {} };
            OperationDbState.dataSourceMode = 'mock';
            OperationDbState.lastLoadedAt = new Date().toISOString();
            return window._opDbCache;
        }
    } else {
        window._opDbCache = _buildMockFallbackDb();
        OperationDbState.dataSourceMode = 'mock';
        OperationDbState.lastLoadedAt = new Date().toISOString();
        console.log('[OP DB] API not configured. Using mock data. SKUs:', window._opDbCache.skuDetails.length);
        return window._opDbCache;
    }
}

// ========================================
// Public KM.DB Interface
// ========================================

if (!window.KM) window.KM = {};
if (!window.KM.DB) window.KM.DB = {};

// ========================================
// F1-7M-C · KM.referenceCache — session dedup for REFERENCE/master data ONLY (never business facts).
// ========================================
// A minimal keyed promise-memo: get(key, loader) shares ONE in-flight request per key and retains the settled
// SUCCESS value for the current session; a FAILED loader is never retained (next get retries the server). Explicit
// invalidate(key) after that reference's own writer forces the next get to refetch. NOT a global data cache — it is
// REFERENCE-ONLY, keyed by resource, in-memory (no LocalStorage / no cross-session persistence), with NO TTL, NO hidden
// background refresh, and NO business-table keys (inventory/forecast/gap/recommendation/status/quantities/rate-cards/
// lead-times/sku_details rows must NEVER be cached here). It does NOT reintroduce window._opDbCache authority.
(function () {
    var store = {};   // key -> { promise, settled, value } — success only; failures are deleted, never retained
    var epoch = {};   // key -> invalidation counter; a load that resolves after an invalidation is dropped, not stored
    function get(key, loader) {
        if (store[key]) return store[key].promise;   // settled OR in-flight → concurrent callers share the same Promise
        var myEpoch = (epoch[key] || 0);
        var entry = { promise: null, settled: false, value: undefined };
        var p;
        try { p = Promise.resolve(loader()); } catch (e) { p = Promise.reject(e); }
        entry.promise = p.then(function (val) {
            // Retain only if this key was NOT invalidated while the load was in flight (else drop → next get refetches).
            if ((epoch[key] || 0) === myEpoch) { entry.settled = true; entry.value = val; }
            else if (store[key] === entry) { delete store[key]; }
            return val;
        }).catch(function (err) {
            if (store[key] === entry) delete store[key];   // failed load is NEVER cached (no stale-on-error fallback)
            throw err;
        });
        store[key] = entry;
        return entry.promise;
    }
    function invalidate(key) { epoch[key] = (epoch[key] || 0) + 1; delete store[key]; }
    function invalidateMany(keys) { (keys || []).forEach(function (k) { invalidate(k); }); }
    function clear() { Object.keys(store).forEach(function (k) { epoch[k] = (epoch[k] || 0) + 1; }); store = {}; }
    window.KM.referenceCache = {
        get: get, invalidate: invalidate, invalidateMany: invalidateMany, clear: clear,
        _hasSettled: function (key) { return !!(store[key] && store[key].settled); }   // test/diagnostic only
    };
})();

// SINGLE canonical frontend Web App endpoint authority (READ-ONLY getter, API Transport Hotfix T1). The API
// Foundation's ApiTransport resolves the Web App URL through this at call time — it does NOT duplicate the
// literal URL. Returns '' when unconfigured (→ fail-closed TRANSPORT_NOT_CONFIGURED). Exposes no new secret:
// the same exec URL Legacy already uses; the Script ID is masked in any Foundation diagnostic/error surface.
window.KM.DB.getApiBaseUrl = function() { return isOperationDbApiConfigured() ? OP_DB_API_BASE_URL : ''; };

window.KM.DB.loadOperationDb = loadOperationDb;

// F1-7J-A3: bounded SCOPED read — fetch ONLY the named tables via the EXISTING generic getTable action, then run the
// SAME `normalizeOperationDb` per-table logic → a `_opDbCache`-shaped object with exactly those tables populated
// (byte-identical to the broad getters, since it's the identical normalizer + per-array filter) and every other table
// []. Reuses getTable (NO new API/route). NEVER mutates the global window._opDbCache (returns a private scoped object the
// caller holds as a page read-model). Rejects on transport error → the page shows a bounded ERROR, NEVER a silent broad
// fallback. This is how the non-workspace primary pages drop their whole-DB loadOperationDb dependency.
// F1-7N-FB-4E §D — BOUND THE FAN-OUT. `Promise.all` over the name list opened ONE SIMULTANEOUS REQUEST PER
// TABLE, so a four-table page mount (Factory Inventory, Overseas Inventory) fired four concurrent requests at
// once, and one rejection failed the whole `Promise.all` — which is how a single transient answer emptied an
// entire page.
//
// WHAT THIS IS AND IS NOT, STATED PRECISELY, BECAUSE AN EARLIER VERSION OF THIS COMMENT GOT IT WRONG.
//
// It claimed the backend's "per-user execution is SERIALIZED" and concluded "the tail latency is the sum
// either way". BOTH HALVES ARE WRONG. Apps Script does NOT guarantee that one user's executions are
// serialized — multiple executions MAY overlap — so the tail latency of four concurrent reads is NOT the sum,
// and this bound is NOT free. Anyone reading the old rationale would have concluded the change could not cost
// anything, which is exactly the premise that stops a real measurement from being taken.
//
// THE HONEST JUSTIFICATION IS DIFFERENT AND DOES NOT NEED THAT PREMISE. Apps Script and the Spreadsheet
// service carry QUOTAS AND CONTENTION. Unbounded client fan-out raises PEAK REQUEST PRESSURE, and higher peak
// pressure makes partial failure more likely — and under `Promise.all` any single partial failure is a total
// page failure. This is a BOUNDED-PRESSURE CONTROL. It is a reliability measure; whether it also makes the
// page faster is an open question that only live measurement can answer, and it may cost latency.
//
// The bound is a small concurrency window rather than a strict serial loop: serial would make a four-table
// mount four full round trips of head-of-line waiting, and the point is to lower peak pressure, not to slow
// the page down. KM_SCOPED_READ_CONCURRENCY_ is the single knob and it is deliberately small.
//
// It is also FAIL-FAST-FREE in the reporting sense: the first rejection still rejects (callers depend on that),
// but the rejected error now carries the typed classification from getOperationDbTableFromSheet, so a page can
// say WHICH table failed and WHY instead of rendering an empty grid.
var KM_SCOPED_READ_CONCURRENCY_ = 2;
window.KM.DB.getScopedReadConcurrency = function () { return KM_SCOPED_READ_CONCURRENCY_; };
// ONE bounded multi-table reader, shared by BOTH fan-out sites (loadScopedTables and _kmRefreshCacheTables_).
// A single knob, so the bound cannot hold in one place and be missing in the other - which is exactly how the
// second site kept its unbounded fan-out through several earlier rounds.
async function _kmReadTablesBounded_(names, opts) {
    // F1-7N-FB-4E-R3 §E — SHARE AN OPEN MOUNT READ; NEVER SHARE A POST-WRITE READ.
    //
    // THE DEFECT. Leaving a page while its tables were still loading and coming back started the whole read
    // again, and two pages that both need `sku_details` or `warehouses` each fetched their own copy. Measured,
    // not assumed: two concurrent identical loadScopedTables calls issued two requests.
    //
    // WHY THIS IS OPT-IN RATHER THAN AUTOMATIC, which is the part that matters for correctness.
    // `_kmRefreshCacheTables_` calls this function too, to re-read the mutable tables AFTER A WRITE. If that
    // read attached to a mount read that was already open when the write landed, it would return PRE-WRITE rows
    // and the page would render the value the user just changed as if the change had not happened. So sharing is
    // requested explicitly by the MOUNT path and is never given to the refresh path: a post-write read always
    // issues its own request.
    //
    // What is shared is an OPEN request only — the shared transport evicts the key on either outcome, so
    // nothing is retained after settlement. There is no TTL and no stored copy here, which is deliberate: it
    // means this can neither serve a stale table nor let one failure poison a later read (§E.6).
    var share = !!(opts && opts.share);
    var tp = null;
    try { tp = (window.KM && window.KM.transport) || null; } catch (e) { tp = null; }
    function readOne(name) {
        if (share && tp && typeof tp.scopedSingleFlight === 'function') {
            // The table name IS the complete scope: getTable takes no filter, so two reads of one table are the
            // same read. That is what makes this key scope-complete rather than merely convenient.
            return tp.scopedSingleFlight('getTable', name, function () { return getOperationDbTableFromSheet(name); });
        }
        return getOperationDbTableFromSheet(name);
    }
    var rawDb = {};
    var next = 0;
    async function worker() {
        while (true) {
            var i = next++;
            if (i >= names.length) return;
            rawDb[names[i]] = await readOne(names[i]);
        }
    }
    var lanes = Math.max(1, Math.min(KM_SCOPED_READ_CONCURRENCY_, names.length));
    var pool = []; for (var w = 0; w < lanes; w++) pool.push(worker());
    await Promise.all(pool);
    return rawDb;
}
window.KM.DB.loadScopedTables = async function(tableNames) {
    var names = (tableNames || []).filter(Boolean);
    // MOUNT read: shareable. See the note in _kmReadTablesBounded_ for why the post-write refresh path is not.
    var rawDb = await _kmReadTablesBounded_(names, { share: true });
    var scoped = normalizeOperationDb(rawDb);
    scoped._sourceMode = 'google-sheet';
    scoped._scopedTables = names.slice();
    return scoped;
};

// F1-7N-FB-4E-R3 §C - ONE SCOPED WORKSPACE READ FOR OVERSEAS STOCK, RETURNING THE SAME MODEL SHAPE.
//
// Overseas Inventory mounted on loadScopedTables(4 tables) = FOUR requests, measured in R3 §A. Each Apps Script
// request is a separate Web App execution, so the mount paid four cold starts, four spreadsheet opens and four
// round trips to draw one page. This is the single-request replacement.
//
// IT RETURNS EXACTLY WHAT loadScopedTables RETURNED, and that is the whole reason the page change is one line.
// 70_ answers with RAW rows under the sheet's own column names, so those rows go through the SAME
// normalizeOperationDb the fan-out fed. Same normalizers, same camelCase keys, same filters and quantities and
// warning thresholds computed on the client from the same rows: BEFORE == AFTER by construction, not by
// inspection.
//
// FAIL-CLOSED, AND NEVER TOWARDS A BROADER READ. On any failure this REJECTS with the typed transport/business
// error. It does not fall back to the four-table fan-out and it certainly does not fall back to getOperationDb:
// a page that silently widens its read when the narrow one fails is how whole-DB reads came back last time. The
// caller decides what to show; this decides nothing.
window.KM.DB.loadOverseasStockWorkspace = async function (opts) {
    var api = (window.KM && window.KM.api) ? window.KM.api : null;
    if (!api || typeof api.getWorkspace !== 'function') {
        var eNo = new Error('The workspace API layer is not loaded on this page.');
        eNo.apiCode = 'WORKSPACE_API_UNAVAILABLE';
        throw eNo;
    }
    var env = await api.getWorkspace('overseasStock', opts || {});
    if (!env || env.success === false) {
        var first = (env && Array.isArray(env.errors) && env.errors[0]) || null;
        var eBad = new Error((first && first.message) || 'The Overseas Stock workspace read failed.');
        eBad.apiCode = (first && first.code) || 'OVERSEAS_STOCK_WORKSPACE_READ_FAILED';
        eBad.details = (first && first.details) || null;
        throw eBad;
    }
    var d = env.data || {};
    var rawDb = {
        overseas_inventory_snapshot: d.overseas_inventory_snapshot || [],
        overseas_inventory_movements: d.overseas_inventory_movements || [],
        warehouses: d.warehouses || [],
        sku_details: d.sku_details || []
    };
    var scoped = normalizeOperationDb(rawDb);
    scoped._sourceMode = 'google-sheet';
    scoped._scopedTables = Object.keys(rawDb);
    scoped._workspaceMeta = { action: 'overseasStock.workspace.get', counts: d.counts || null,
        capped: d.capped || null, projection: d.projection || null, requests: 1 };
    return scoped;
};

window.KM.DB.getSkuDetails = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.skuDetails || [];
};

window.KM.DB.getProductFeatures = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.productFeatures || [];
};

window.KM.DB.getSkuHandbookSummaries = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.skuHandbookSummaries || [];
};

window.KM.DB.getSkuKnowledgeItems = function() {
    if (!window._opDbCache) return [];
    return buildSkuKnowledgeItems(
        window._opDbCache.skuDetails || [],
        window._opDbCache.productFeatures || [],
        window._opDbCache.skuHandbookSummaries || []
    );
};

window.KM.DB.getCampaigns = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.campaigns || [];
};

window.KM.DB.getCampaignSkuLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.campaignSkuLines || [];
};

window.KM.DB.getMarketplaces = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.marketplaces || [];
};

window.KM.DB.getMarketplaceSkus = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.marketplaceSkus || [];
};

window.KM.DB.getPricingList = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.pricingList || [];
};

window.KM.DB.getPricingChangeLog = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.pricingChangeLog || [];
};

window.KM.DB.getFcRegularForecast = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.fcRegularForecast || [];
};

window.KM.DB.getFactoryStock = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.factoryStock || [];
};

// supplier_price_list (v1 lead-time / cost source). [] when the tab is absent (missing-source safe).
window.KM.DB.getSupplierPriceList = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.supplierPriceList || [];
};

window.KM.DB.getFactoryStockMovements = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.factoryStockMovements || [];
};

window.KM.DB.getWarehouses = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.warehouses || [];
};

// replenishment_demand_allocation_rules — Phase-1 multi-warehouse demand-allocation authority (F1-4B-E).
// TARGETED, READ-ONLY over the already-loaded cache — never a whole-DB load, never a fetch, and the runtime
// NEVER creates/repairs the sheet. [] when the cache is unloaded or the tab is absent → downstream
// DEMAND_ALLOCATION_RULE_NOT_CONFIGURED (never a default ratio).
window.KM.DB.getReplenishmentDemandAllocationRules = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.replenishmentDemandAllocationRules || [];
};

window.KM.DB.getOverseasInventorySnapshot = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.overseasInventorySnapshot || [];
};

window.KM.DB.getOverseasInventoryMovements = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.overseasInventoryMovements || [];
};

// Amazon snapshot + forecast-event source getters (read-only). Return [] when the cache is
// unloaded or the payload does not include the table — callers must safe-fallback to 0.
window.KM.DB.getAmazonInventorySnapshot = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.amazonInventorySnapshot || [];
};

window.KM.DB.getAmazonInventoryHealthSnapshot = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.amazonInventoryHealthSnapshot || [];
};

window.KM.DB.getAmazonDailySalesSnapshot = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.amazonDailySalesSnapshot || [];
};

window.KM.DB.getAmazonWeeklySalesSnapshot = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.amazonWeeklySalesSnapshot || [];
};

window.KM.DB.getFcSpecialEvents = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.fcSpecialEvents || [];
};

window.KM.DB.getFcTargetRules = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.fcTargetRules || [];
};

// Weekly Shipping Plan (Decision Layer) getters.
window.KM.DB.getShippingPlans = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shippingPlans || [];
};

window.KM.DB.getShippingPlanLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shippingPlanLines || [];
};

// Shipment (Execution Layer) getters.
window.KM.DB.getShipments = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipments || [];
};

window.KM.DB.getShipmentLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipmentLines || [];
};

// Global Logistics Map getters (READ-ONLY). Return [] when the cache is unloaded or the payload
// does not include the tab (e.g. logistics_locations not yet created, or Apps Script not redeployed).
window.KM.DB.getLogisticsLocations = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.logisticsLocations || [];
};
window.KM.DB.getShipmentRouteTemplates = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipmentRouteTemplates || [];
};
window.KM.DB.getShipmentRouteTemplateNodes = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipmentRouteTemplateNodes || [];
};
window.KM.DB.getShipmentRoutes = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipmentRoutes || [];
};
// Runtime data-chain diagnostics (raw vs kept counts + sample column keys per key table + source mode).
// Used by the Global Logistics Map debug panel to locate a break from runtime evidence.
window.KM.DB.getDataDiagnostics = function() { return window._opDbDiag || null; };
// Current data source: 'google-sheet' (production) | 'mock' (API failed/unconfigured fallback) | 'not-loaded'.
window.KM.DB.getDataSourceMode = function() { return window._opDbCache ? (window._opDbCache._sourceMode || 'mock') : 'not-loaded'; };
window.KM.DB.getShipmentEvents = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shipmentEvents || [];
};

// Procurement Layer (Phase 1) getters. Return [] when the cache is unloaded or the payload
// does not include the table (missing procurement tabs are created on first write).
window.KM.DB.getRequestOrders = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrders || [];
};

window.KM.DB.getRequestOrderLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrderLines || [];
};

window.KM.DB.getPurchaseOrders = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.purchaseOrders || [];
};

// F1-7C: expose the canonical PO normalizers so a scoped-workspace page adapter can produce records IDENTICAL to the
// broad-cache getters from the workspace DTO's raw passthrough (guarantees BEFORE == AFTER). Read-only, pure mappers.
window.KM.DB.normalizePurchaseOrder = function(raw) { return normalizePurchaseOrderRecord(raw); };
window.KM.DB.normalizePurchaseOrderLine = function(raw) { return normalizePurchaseOrderLineRecord(raw); };

// F1-7C: adapt the scoped purchaseOrder workspace View-Model to the SAME record shapes the PO pages consume from the
// broad cache — orders/lines via the canonical normalizers (BEFORE == AFTER), plus the scoped sku/warehouse subsets.
// remaining_qty is BACKEND-OWNED: the DTO always supplies it, so the page never derives max(0, completed - shipped).
window.KM.DB.adaptPurchaseOrderWorkspace = function(data) {
    data = data || {};
    var orders = (data.purchaseOrders || []).map(function(p) { return _kmAttachDocumentDto(normalizePurchaseOrderRecord((p && p.raw) || {}), p); });
    var lines = [];
    var det = data.detailsByPurchaseOrderId || {};
    Object.keys(det).forEach(function(poId) {
        (((det[poId] || {}).lines) || []).forEach(function(l) {
            var n = normalizePurchaseOrderLineRecord((l && l.raw) || {});
            // Backend-owned remaining_qty (persisted, else max(0, completed - shipped)) — override so it is always present.
            if (l && l.remainingQty != null && l.remainingQty !== '') n.remainingQty = parseFloat(l.remainingQty) || 0;
            lines.push(n);
        });
    });
    var skuDetails = (data.skuDetails || []).map(function(s) { return { sku: s.sku, category: s.category, series: s.series }; });
    var warehouses = (data.warehouses || []).map(function(w) { return { warehouseId: w.warehouseId, warehouseName: w.warehouseName }; });
    return { orders: orders, lines: lines, skuDetails: skuDetails, warehouses: warehouses };
};

// F1-7D: expose the canonical Request Order normalizers so a scoped-workspace page adapter produces records IDENTICAL
// to the broad-cache getters from the workspace DTO's raw passthrough (guarantees BEFORE == AFTER). Read-only mappers.
window.KM.DB.normalizeRequestOrder = function(raw) { return normalizeRequestOrderRecord(raw); };
window.KM.DB.normalizeRequestOrderLine = function(raw) { return normalizeRequestOrderLineRecord(raw); };

// F1-7J-A2: expose the canonical sku_details normalizer so the Weekly Shipping read-model adapter can re-normalize the
// bounded SKU-logistics projection (40_ `skuDetails`) into records IDENTICAL to the broad-cache getSkuDetails() records
// (BEFORE == AFTER for _spLineLogistics carton dims + weights). Read-only mapper.
window.KM.DB.normalizeSkuDetail = function(raw) { return normalizeSkuDetailsRecord(raw); };

// F1-7D: adapt the scoped requestOrder workspace View-Model to the SAME record shapes the Request Order Draft page
// consumes from the broad cache. Orders/lines run through the canonical normalizers on the DTO `raw` passthrough; the
// master subsets (line sources / warehouses / sku_details / supplier_price_list) run through their SAME normalizers.
// The per-array filters MATCH normalizeOperationDb so the adapted arrays equal the legacy getters exactly (BEFORE ==
// AFTER). Composes persisted truth ONLY — no Gap/Forecast/Recommendation, no draft engine, no RO->PO.
window.KM.DB.adaptRequestOrderWorkspace = function(data) {
    data = data || {};
    var orders = (data.requestOrders || []).map(function(o) { return normalizeRequestOrderRecord((o && o.raw) || {}); })
        .filter(function(r) { return r.requestOrderId; });
    var lines = [];
    var det = data.detailsByRequestOrderId || {};
    Object.keys(det).forEach(function(roId) {
        (((det[roId] || {}).lines) || []).forEach(function(l) {
            var n = normalizeRequestOrderLineRecord((l && l.raw) || {});
            if (n.requestOrderLineId || n.requestOrderId) lines.push(n);
        });
    });
    var lineSources = (data.lineSources || []).map(function(s) { return normalizeRequestOrderLineSourceRecord(s || {}); });
    var warehouses = (data.warehouses || []).map(function(w) { return normalizeWarehouseRecord(w || {}); })
        .filter(function(r) { return r.warehouseId || r.warehouseName; });
    var skuDetails = (data.skuDetails || []).map(function(d) { return normalizeSkuDetailsRecord(d || {}); })
        .filter(function(r) { return r.sku; });
    var supplierPriceList = (data.supplierPriceList || []).map(function(r) { return normalizeSupplierPriceListRecord(r || {}); })
        .filter(function(r) { return r.sku; });
    return { orders: orders, lines: lines, lineSources: lineSources, warehouses: warehouses, skuDetails: skuDetails, supplierPriceList: supplierPriceList };
};

// F1-7F: expose the canonical Shipment normalizers so a scoped-workspace page adapter produces records IDENTICAL to the
// broad-cache getters from the workspace DTO's raw passthrough (BEFORE == AFTER). Read-only, pure mappers.
window.KM.DB.normalizeShipment = function(raw) { return normalizeShipmentRecord(raw); };
window.KM.DB.normalizeShipmentLine = function(raw) { return normalizeShipmentLineRecord(raw); };

// F1-7F: adapt the scoped shipment workspace View-Model to the SAME arrays the Shipment pages consume from the broad
// cache — each table run through its canonical normalizer with the SAME per-array filter normalizeOperationDb applies,
// so the adapted arrays equal the legacy getters exactly. Composes persisted shipment facts ONLY (no FIFO/allocation/
// PO/receipt/factory authority). Map-extra arrays are present only when the workspace was called with their include.
// F1-7N-FB-1B §P — carry the workspace-projected generated_documents DTOs onto the normalized record. The
// normalizers deliberately read only `raw` (the physical row), but these fields are BACKEND-DERIVED read-model
// facts, not columns, so they are attached here rather than invented in the page. The browser never queries
// Drive: it only follows a folder/file URL the backend already resolved.
function _kmAttachDocumentDto(target, wsRow) {
    var w = wsRow || {};
    target.documents = w.documents || [];
    target.documentFolderUrl = String(w.documentFolderUrl || '').trim();
    target.documentGenerationStatus = String(w.documentGenerationStatus || '').trim();
    target.documentGenerationError = w.documentGenerationError || null;
    target.canRetryDocuments = w.canRetryDocuments === true;
    return target;
}
window.KM.DB.adaptShipmentWorkspace = function(data) {
    data = data || {};
    var shipments = (data.shipments || []).map(function(s) { return _kmAttachDocumentDto(normalizeShipmentRecord((s && s.raw) || {}), s); }).filter(function(r) { return r.shipmentId; });
    var shipmentLines = (data.shipmentLines || []).map(normalizeShipmentLineRecord).filter(function(r) { return r.shipmentLineId || r.shipmentId; });
    var warehouses = (data.warehouses || []).map(normalizeWarehouseRecord).filter(function(r) { return r.warehouseId || r.warehouseName; });
    var carrierRateCards = (data.carrierRateCards || []).map(normalizeCarrierRateCardRecord).filter(function(r) { return r.rateCardId || r.carrierId; });
    var out = { shipments: shipments, shipmentLines: shipmentLines, warehouses: warehouses, carrierRateCards: carrierRateCards };
    // Map-extras (On-the-Way) — same normalizers + filters as normalizeOperationDb; [] when the include was not requested.
    out.shipmentRoutes = (data.shipmentRoutes || []).map(normalizeShipmentRouteRecord).filter(function(r) { return r.shipmentRouteId || r.shipmentId || r.locationName || r.latitude !== null; });
    out.shipmentEvents = (data.shipmentEvents || []).map(normalizeShipmentEventRecord).filter(function(r) { return r.shipmentEventId || r.shipmentId || r.eventType; });
    out.logisticsLocations = (data.logisticsLocations || []).map(normalizeLogisticsLocationRecord).filter(function(r) { return r.logisticsLocationId || r.locationCode || r.locationName || r.warehouseId || r.factoryId || r.latitude !== null; });
    out.shipmentRouteTemplates = (data.shipmentRouteTemplates || []).map(normalizeShipmentRouteTemplateRecord).filter(function(r) { return r.routeTemplateId || r.routeTemplateName || r.destinationCountry || r.originCountry; });
    out.shipmentRouteTemplateNodes = (data.shipmentRouteTemplateNodes || []).map(normalizeShipmentRouteTemplateNodeRecord).filter(function(r) { return r.routeTemplateNodeId || r.routeTemplateId || r.nodeName || r.nodeCode || r.latitude !== null; });
    return out;
};

// F1-7G: adapt the scoped FC Summary workspace View-Model to the SAME arrays the FC Summary page consumes from the broad
// cache — each table run through its canonical normalizer with the SAME per-array filter normalizeOperationDb applies, so
// the adapted arrays equal the legacy getters (getFcRegularForecast / getFcSpecialEvents / getFcTargetRules /
// getMarketplaces) exactly, including the preserved `.raw` passthrough the render getters read. Composes persisted raw
// forecast rows ONLY (no Target% adjustment, no blending, no Gap/Recommendation; the Event Assist WRITE path is untouched).
window.KM.DB.adaptFcSummaryWorkspace = function(data) {
    data = data || {};
    var fcRegularForecast = (data.fcRegularForecast || []).map(normalizeFcRegularForecastRecord).filter(function(r) { return r.forecastId || r.sku; });
    var fcSpecialEvents = (data.fcSpecialEvents || []).map(normalizeFcSpecialEventRecord).filter(function(r) { return r.event || r.sku || r.scopeId; });
    var fcTargetRules = (data.fcTargetRules || []).map(normalizeFcTargetRuleRecord).filter(function(r) { return r.scopeId || r.ruleId; });
    var marketplaces = (data.marketplaces || []).map(normalizeMarketplaceRecord).filter(function(r) { return r.marketplaceId || r.marketplace; });
    return { fcRegularForecast: fcRegularForecast, fcSpecialEvents: fcSpecialEvents, fcTargetRules: fcTargetRules, marketplaces: marketplaces };
};

// F1-7H: adapt the scoped SKU Details workspace View-Model to the SAME arrays the SKU pages consume from the broad cache —
// each table run through its canonical normalizer with the SAME per-array filter normalizeOperationDb applies, so the
// adapted arrays equal the legacy getters (getSkuDetails / getTaxReferralRates / getTaxRateComponents / getMarketplaceSkus
// / getSkuRegionalDetails) exactly, including the preserved `.raw` passthrough the render/edit paths read. Transports raw
// persisted master/reference rows ONLY (no write side effects, no Factory Stock init, no Forecast/Gap/Recommendation). The
// 'regional' arrays are present only when the workspace was called with include.regional.
window.KM.DB.adaptSkuDetailsWorkspace = function(data) {
    data = data || {};
    var skuDetails = (data.skuDetails || []).map(normalizeSkuDetailsRecord).filter(function(r) { return r.sku; });
    var taxReferralRates = (data.taxReferralRates || []).map(normalizeTaxReferralRateRecord).filter(function(r) { return r.taxRateId || r.series; });
    var taxRateComponents = (data.taxRateComponents || []).map(normalizeTaxRateComponentRecord).filter(function(r) { return r.taxComponentId || r.taxRateId; });
    var out = { skuDetails: skuDetails, taxReferralRates: taxReferralRates, taxRateComponents: taxRateComponents };
    // 'regional' arrays (sku-regional-details.js) — same normalizers + filters as normalizeOperationDb; present only when include.regional.
    out.marketplaceSkus = (data.marketplaceSkus || []).map(normalizeMarketplaceSkuRecord).filter(function(r) { return r.sku; });
    out.skuRegionalDetails = (data.skuRegionalDetails || []).map(normalizeSkuRegionalDetailRecord).filter(function(r) { return r.regionalDetailId || r.sku; });
    return out;
};

// F1-7I: adapt the scoped Inventory Replenishment workspace View-Model to the SAME arrays the page's main-table assembly
// (_getCloudReplenishmentData's local get()) consumes from the broad cache — each table run through its canonical
// normalizer with the SAME per-array filter normalizeOperationDb applies, KEYED BY GETTER NAME so the page's get(name)
// choke point returns byte-identical arrays to the legacy KM.DB.getX() getters (BEFORE == AFTER), incl. the preserved
// `.raw` passthrough. Transports raw persisted rows ONLY — no Gap/Recommendation/allocation/FIFO/PO/incoming authority
// (the incoming reconstruction stays presentation-side over these rows; Gap/Reco/draft-SSOT stay on their own scoped owners).
window.KM.DB.adaptInventoryReplenishmentWorkspace = function(data) {
    data = data || {};
    return {
        getMarketplaces: (data.marketplaces || []).map(normalizeMarketplaceRecord).filter(function(r) { return r.marketplaceId || r.marketplace; }),
        getMarketplaceSkus: (data.marketplace_skus || []).map(normalizeMarketplaceSkuRecord).filter(function(r) { return r.sku; }),
        getSkuDetails: (data.sku_details || []).map(normalizeSkuDetailsRecord).filter(function(r) { return r.sku; }),
        getWarehouses: (data.warehouses || []).map(normalizeWarehouseRecord).filter(function(r) { return r.warehouseId || r.warehouseName; }),
        getAmazonInventorySnapshot: (data.amazon_inventory_snapshot || []).map(normalizeAmazonInventorySnapshotRecord).filter(function(r) { return r.sku; }),
        getAmazonInventoryHealthSnapshot: (data.amazon_inventory_health_snapshot || []).map(normalizeAmazonInventoryHealthSnapshotRecord).filter(function(r) { return r.sku; }),
        getAmazonDailySalesSnapshot: (data.amazon_daily_sales_snapshot || []).map(normalizeAmazonDailySalesSnapshotRecord).filter(function(r) { return r.sku; }),
        getAmazonWeeklySalesSnapshot: (data.amazon_weekly_sales_snapshot || []).map(normalizeAmazonWeeklySalesSnapshotRecord).filter(function(r) { return r.sku; }),
        getFcRegularForecast: (data.fc_regular_forecast || []).map(normalizeFcRegularForecastRecord).filter(function(r) { return r.forecastId || r.sku; }),
        getFcTargetRules: (data.fc_target_rules || []).map(normalizeFcTargetRuleRecord).filter(function(r) { return r.scopeId || r.ruleId; }),
        getFcSpecialEvents: (data.fc_special_events || []).map(normalizeFcSpecialEventRecord).filter(function(r) { return r.event || r.sku || r.scopeId; }),
        getOverseasInventorySnapshot: (data.overseas_inventory_snapshot || []).map(normalizeOverseasInventorySnapshotRecord).filter(function(r) { return r.warehouseId && r.sku; }),
        getFactoryStock: (data.factory_stock || []).map(normalizeFactoryStockRecord).filter(function(r) { return r.factoryStockId || r.sku; }),
        getShipments: (data.shipments || []).map(normalizeShipmentRecord).filter(function(r) { return r.shipmentId; }),
        getShipmentLines: (data.shipment_lines || []).map(normalizeShipmentLineRecord).filter(function(r) { return r.shipmentLineId || r.shipmentId; }),
        getShippingPlans: (data.shipping_plans || []).map(normalizeShippingPlanRecord).filter(function(r) { return r.shippingPlanId; }),
        getShippingPlanLines: (data.shipping_plan_lines || []).map(normalizeShippingPlanLineRecord).filter(function(r) { return r.shippingPlanLineId || r.shippingPlanId; }),
        getShippingAllocationDrafts: (data.shipping_allocation_drafts || []).map(normalizeShippingAllocationDraftRecord).filter(function(r) { return r.allocationDraftId; }),
        getShippingAllocationDraftLines: (data.shipping_allocation_draft_lines || []).map(normalizeShippingAllocationDraftLineRecord).filter(function(r) { return r.allocationDraftLineId || r.allocationDraftId; }),
        // F1-7J-A2: carrier reference (Execution-Plan panel) — present ONLY when the workspace was called with
        // include.carrierPlanning; [] otherwise. Same normalizers + filters as normalizeOperationDb → equal to the broad
        // getCarrierLeadTimes / getCarrierRateCards getters (BEFORE == AFTER). Reference data only (no carrier selection).
        getCarrierLeadTimes: (data.carrier_lead_times || []).map(normalizeCarrierLeadTimeRecord).filter(function(r) { return r.leadTimeId || r.carrierId; }),
        getCarrierRateCards: (data.carrier_rate_cards || []).map(normalizeCarrierRateCardRecord).filter(function(r) { return r.rateCardId || r.carrierId; })
    };
};

window.KM.DB.getRequestOrderAllocationDrafts = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrderAllocationDrafts || [];
};

window.KM.DB.getRequestOrderAllocationDraftLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrderAllocationDraftLines || [];
};

// Inventory Replenishment shipping-allocation drafts (Recommendation Summary + Execution Plan SSOT).
window.KM.DB.getShippingAllocationDrafts = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shippingAllocationDrafts || [];
};
window.KM.DB.getShippingAllocationDraftLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.shippingAllocationDraftLines || [];
};

window.KM.DB.getRequestOrderSiteConfirmations = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrderSiteConfirmations || [];
};

window.KM.DB.getRequestOrderLineSources = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.requestOrderLineSources || [];
};

// ---- Carrier / Route master (Carrier Rate Card v1) — all missing-tab/header safe (return []). ----
window.KM.DB.getCarriers = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.carriers || [];
};
// F1-7J-A2: bounded marketplace REFERENCE read for the Request Order scope resolver — reuses the EXISTING generic
// getTable('marketplaces') GET action (single-table server read; NO new API/route), then runs the SAME normalizer + the
// SAME per-array filter as normalizeOperationDb so the result equals getMarketplaces() exactly (BEFORE == AFTER). Async;
// never getOperationDb / never the broad cache. The server-side filterRows_('marketplaces') keeps rows with
// marketplace_id||marketplace — identical to the filter below — so no row-parity drift.
// F1-7M-C1: the marketplace master is SESSION_REFERENCE_SAFE (all callers expect the identical full master — same
// normalizer + same marketplaceId||marketplace filter, no active-filter baked in). Route through KM.referenceCache so
// repeated calls (RO re-mount / any consumer, in one session) share ONE getTable fetch instead of re-fetching every
// call; invalidated after the only marketplace writer (upsertMarketplace). The loader is byte-identical to the prior
// body → BEFORE==AFTER row universe. Fail-closed: a failed fetch is not cached (next call retries), never a stale/broad
// fallback. Falls back to a raw fetch if the cache is somehow absent (defensive; the IIFE above always installs it).
window.KM.DB.getMarketplaceReference = function() {
    var loader = function () {
        return getOperationDbTableFromSheet('marketplaces').then(function (rows) {
            return (rows || []).map(normalizeMarketplaceRecord).filter(function(r) { return r.marketplaceId || r.marketplace; });
        });
    };
    return (window.KM && window.KM.referenceCache) ? window.KM.referenceCache.get('marketplaces', loader) : loader();
};

window.KM.DB.getCarrierRateCards = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.carrierRateCards || [];
};
window.KM.DB.getCarrierLeadTimes = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.carrierLeadTimes || [];
};

// ---- SKU Domain v2.0 — Regional Details (read+write) + Tax/Referral (read-only). Missing-tab safe. ----
window.KM.DB.getSkuRegionalDetails = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.skuRegionalDetails || [];
};
window.KM.DB.getTaxReferralRates = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.taxReferralRates || [];
};
window.KM.DB.getTaxRateComponents = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.taxRateComponents || [];
};

window.KM.DB.getPurchaseOrderLines = function() {
    if (!window._opDbCache) return [];
    return window._opDbCache.purchaseOrderLines || [];
};


window.KM.DB.getDataSourceMode = function() {
    return getOperationDbDataSourceMode();
};

window.KM.DB.isCloudWriteEnabled = function() {
    return isOperationDbApiConfigured() && getOperationDbDataSourceMode() === 'google-sheet';
};

// F1-7M-B2-HOTFIX (SCOPED_ACTIVE_PREDICATE_COLD_START_DEFECT) — cloud SCOPED-READ eligibility that is INDEPENDENT of
// whether the broad window._opDbCache has already been primed. F1-7L deliberately removed the startup whole-DB prime, so
// a cold canonical scoped page has window._opDbCache == null → getDataSourceMode() === 'not-loaded'. The former per-page
// predicate required getDataSourceMode() === 'google-sheet' (reachable ONLY AFTER a broad load), so the FIRST scoped page
// opened in a session wrongly failed the predicate and fell back to the legacy whole-DB loadOperationDb (getOperationDb) —
// violating the F1-7L zero-prime posture. Scoped-read eligibility is a CONFIGURATION fact (the Operation DB API is
// configured AND we are not in an explicit mock posture), NOT a cache-load fact: cold 'not-loaded' IS eligible; only an
// explicit 'mock' posture (unconfigured API, or a prior load that fell back to mock) is not. This deliberately DIFFERS
// from isCloudWriteEnabled (writes still require a confirmed 'google-sheet' cache) and does NOT change getDataSourceMode()
// semantics — DATA-SOURCE CONFIGURATION stays separate from CACHE-LOAD STATE. Demo posture is handled page-side (each
// demo-capable page short-circuits on KM.DemoData.isEnabled() BEFORE its scoped predicate) and is unaffected here.
window.KM.DB.isScopedReadEligible = function() {
    return isOperationDbApiConfigured() && getOperationDbDataSourceMode() !== 'mock';
};

// ============================================================================================================
// F1-7N-FB-2 §C/§D — PRODUCTION WRITE ELIGIBILITY, and the removal of the automatic production fallback.
// ============================================================================================================
// THE DEFECT THIS CLOSES. isCloudWriteEnabled() requires getDataSourceMode() === 'google-sheet', which is only
// reachable AFTER the broad window._opDbCache has been primed. F1-7L deliberately removed the startup whole-DB
// prime, so on a cold canonical session getDataSourceMode() === 'not-loaded' and EVERY write gated on that
// predicate silently fails its gate. Site Inventory's Submit Plan then fell through to a sessionStorage branch
// and reported "Weekly Shipping Plan created (Demo / local mode)" — a fabricated success, with nothing persisted.
// The identical cold-start defect was already found and fixed for scoped READS (isScopedReadEligible); this is
// the write-side counterpart.
//
// Write eligibility is a CONFIGURATION fact, not a cache-load fact: the API is configured and we are not in an
// explicit mock posture. It is intentionally the same predicate shape as the read side.
window.KM.DB.isProductionWriteEligible = function() {
    return isOperationDbApiConfigured() && getOperationDbDataSourceMode() !== 'mock';
};

// Local/mock behaviour survives ONLY behind an explicit development flag that the production build cannot set.
// Two conditions, both required: the page must be served from a local dev host, AND a human must have opted in
// on that host. A GitHub Pages origin (or any other real host) can never satisfy the first, so the production
// deployment has no reachable path into local mode — which is the point.
window.KM.DB.isDevLocalModeAllowed = function() {
    try {
        if (typeof window === 'undefined' || window.KM_DEV_LOCAL_MODE !== true) return false;
        var h = (window.location && window.location.hostname) ? String(window.location.hostname) : '';
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
    } catch (e) { return false; }
};

// One place that turns a failed production write into an ACTIONABLE message. It reports the action, the
// request_id, the HTTP status, the response content type, the typed transport reason and retry guidance, plus
// the zero-write confirmation when the backend proved it. It never includes a token, a spreadsheet id, a Drive
// id or a raw HTML body — the transport layer already reduces a non-JSON body to a sanitized prefix, and that
// prefix is deliberately NOT surfaced here.
window.KM.DB.describeWriteFailure = function(action, res) {
    res = res || {};
    var d = res.details || {};
    var reason = res.code || res.apiCode || res.reason || res.stage || 'WRITE_FAILED';
    var lines = ['Could not save — nothing was written.', '', 'Action: ' + String(action || 'unknown')];
    if (res.requestId || res.request_id) lines.push('Request ID: ' + String(res.requestId || res.request_id));
    if (d.httpStatus != null) lines.push('HTTP status: ' + String(d.httpStatus));
    if (d.contentType) lines.push('Response type: ' + String(d.contentType));
    lines.push('Reason: ' + String(reason));
    if (res.message || res.error) lines.push('Detail: ' + String(res.message || res.error));
    if (res.zero_write === true || res.db_writes === 0) lines.push('Confirmed: 0 database rows were written.');
    lines.push('');
    lines.push(reason === 'TRANSPORT_NON_JSON_RESPONSE'
        ? 'The API endpoint answered with a web page instead of data. Run system.health to check whether the Apps Script deployment is reachable and fully synced, then retry.'
        : 'Retry once. If it fails again, run the read-only system.health check before retrying further.');
    return lines.join('\n');
};

// F1-7N-FB-2 §D — read-only production health probe. A JSON answer proves the deployment is reachable AND that
// the deployed code contains the actions the pages are about to call.
window.KM.DB.getSystemHealth = function() {
    if (!isOperationDbApiConfigured()) return Promise.resolve({ success: false, error: 'API not configured', code: 'TRANSPORT_NOT_CONFIGURED' });
    return fetch(OP_DB_API_BASE_URL, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'system.health' })
    }).then(function (resp) {
        var ctype = '';
        try { ctype = (resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : ''; } catch (e) {}
        return Promise.resolve(resp.text()).then(function (raw) {
            var t = String(raw == null ? '' : raw).trim();
            if (t === '' || /^<(!doctype|html)/i.test(t)) {
                return { success: false, code: 'TRANSPORT_NON_JSON_RESPONSE',
                    details: { httpStatus: resp.status, contentType: ctype },
                    message: 'The endpoint returned a web page instead of JSON. The Apps Script deployment may be unreachable, superseded, or access-restricted.' };
            }
            try { return JSON.parse(t); }
            catch (e2) { return { success: false, code: 'TRANSPORT_NON_JSON_RESPONSE', details: { httpStatus: resp.status, contentType: ctype } }; }
        });
    }).catch(function (e) { return { success: false, code: 'TRANSPORT_ERROR', message: (e && e.message) ? e.message : String(e) }; });
};

// F1-7N-FA-3C-R6C — CANONICAL DB PROVIDER READINESS authority (shell-permanent). window.KM.DB and its config
// (OP_DB_API_BASE_URL const) are created ONCE at shell load and NEVER torn down on SPA navigation, so readiness is a
// pure function of configuration + eligibility — exposed here as ONE idempotent, retryable authority so a page mount can
// wait for READY before EVER declaring the DB unavailable (no false "disconnect" during a transient), and can recover
// without a hard browser refresh. READ-ONLY / no secrets: only an enum + booleans + a generation counter are exposed.
// A stale/failed state can NEVER poison a future mount — whenReady()/state() RECOMPUTE from live config every call, and
// retry() just bumps the generation (there is no cached rejected promise to get stuck). State machine:
//   READY  = configured AND not an explicit 'mock' posture (scoped reads allowed);
//   ERROR  = a real provider failure (unconfigured API, or an explicit 'mock' fallback set by a failed load);
//   IDLE/LOADING are reserved for symmetry — a resident synchronous provider resolves to READY/ERROR immediately.
(function () {
    var _providerGen = 0;
    function _providerState() {
        if (!isOperationDbApiConfigured()) return 'ERROR';                    // genuinely unconfigured provider
        return (getOperationDbDataSourceMode() === 'mock') ? 'ERROR' : 'READY'; // explicit mock = unavailable; else ready
    }
    window.KM.dbProvider = {
        state: function () { return _providerState(); },
        isReady: function () { return _providerState() === 'READY'; },
        generation: function () { return _providerGen; },
        // resolve true when READY (immediately for a resident provider), false on a real provider ERROR — the caller then
        // shows a genuine provider error, NEVER a false "no data". Always RESOLVES (never rejects) so no promise poisons a mount.
        whenReady: function () { return Promise.resolve(_providerState() === 'READY'); },
        // safe retry: recompute readiness (a scoped read elsewhere may have restored eligibility); bump the generation.
        retry: function () { _providerGen++; return this.whenReady(); }
    };
})();

// ── Batch F (F1-7K) — WRITE_FORCES_FULL_RELOAD retirement ─────────────────────────────────────────
// A successful write no longer refreshes the WHOLE Operation DB. Canonical/scoped consumer pages own their
// bounded post-write readback (getWorkspace / loadScopedTables / _xAfterWrite / targeted re-read), so the
// shared global window._opDbCache is deliberately ignored by them and may go stale — acceptable (§13). This
// ONE seam replaces every direct writer's former whole-DB `loadOperationDb({ force: true })`.
//
// _kmScopedPostureActive_() returns true ONLY when we can POSITIVELY confirm the read side is fully scoped
// (every consumer re-reads its own slice; none renders from the broad cache). In that posture the seam does
// NOTHING → the 47 whole-DB writer reloads become 0. Otherwise (any read-side kill switch engaged, Foundation
// unavailable, or anything uncertain) it falls back to the OLD whole-DB reload so a rollback stays
// fresh-after-write with NO second lever. Read-only posture probe — no new cache, no TTL, no mutation logic.
//   Levers that automatically re-arm the reload (mirror the exact signals pages use to pick Legacy render):
//     • window.KM_WRITER_FULL_RELOAD === true  → explicit master rollback for ALL writers (§23)
//     • window.KM_SCOPED_PAGE_READS === false  → the F1-7J-A3 non-workspace scoped-page kill switch
//     • setWorkspaceEnabled(name, false)       → any canonical workspace rolled back to Legacy render
var _KM_CANONICAL_WORKSPACES_ = ['weeklyShipping', 'recommendation', 'purchaseOrder', 'requestOrder',
    'shipment', 'fcSummary', 'skuDetails', 'inventoryReplenishment'];
function _kmScopedPostureActive_() {
    try {
        if (typeof window === 'undefined') return false;
        if (window.KM_WRITER_FULL_RELOAD === true) return false;      // explicit rollback → reload
        if (window.KM_SCOPED_PAGE_READS === false) return false;       // A3 scoped-page kill switch → reload
        var api = window.KM && window.KM.api;
        if (!api || typeof api.workspaceApiActive !== 'function') return false;   // Foundation absent → can't confirm → reload
        for (var i = 0; i < _KM_CANONICAL_WORKSPACES_.length; i++) {
            if (api.workspaceApiActive(_KM_CANONICAL_WORKSPACES_[i]) !== true) return false;   // a workspace rolled back → reload
        }
        return true;   // fully scoped → consumers own their readback → NO whole-DB reload
    } catch (e) { return false; }   // any uncertainty → fall back to the old whole-DB reload (fail-safe)
}
// The single post-write seam every direct writer now awaits instead of loadOperationDb({ force: true }).
async function _kmWriterPostWrite_() {
    // F1-7N-FB-3 §J — inside a declared write batch the (potentially whole-DB) reconcile is deferred to ONE
    // call at the end of the batch. Outside a batch the behaviour is byte-identical to before.
    if (_kmPostWriteDeferred_ > 0) { _kmPostWriteDirty_ = true; return; }
    if (!_kmScopedPostureActive_()) { await loadOperationDb({ force: true }); }
}
// Bounded targeted cache patch (§1 option C / §13-sanctioned; extended in F1-7L) — re-GET only the named tables
// via the EXISTING getTable action, run the SAME normalizeOperationDb per-table logic, and patch ONLY those
// slices into the global cache. Used where a PRIMARY/SECONDARY surface reads a broad-cache slice directly (no
// scoped read-model) and must stay fresh WITHOUT any whole-DB reload — and (F1-7L) so the remaining secondary
// surfaces + the IR allocation-draft hydrate can drop the app.js startup prime by loading their own bounded
// slices on demand. Patches even when a table is now empty (explicit key map, not a non-empty diff), so a
// cleared table correctly clears its slice. Reuses the IDENTICAL normalizer/filter → byte-identical to the
// broad getters (BEFORE == AFTER). NOTE: _opDbCache is NOT canonical startup state after F1-7L — it is only an
// on-demand bounded scratch for these documented compatibility surfaces + legacy kill-switch branches (doc §10).
var _KM_TABLE_CACHE_KEY_ = {
    request_order_site_confirmations: 'requestOrderSiteConfirmations',
    // F1-7L bounded secondary/hydrate reads:
    shipping_allocation_drafts: 'shippingAllocationDrafts',
    shipping_allocation_draft_lines: 'shippingAllocationDraftLines',
    fc_regular_forecast: 'fcRegularForecast',
    fc_special_events: 'fcSpecialEvents',
    fc_target_rules: 'fcTargetRules',
    factory_stock: 'factoryStock',
    warehouses: 'warehouses',
    purchase_orders: 'purchaseOrders',
    purchase_order_lines: 'purchaseOrderLines',
    sku_details: 'skuDetails',
    marketplace_skus: 'marketplaceSkus',
    campaigns: 'campaigns',
    campaign_sku_lines: 'campaignSkuLines',
    pricing_list: 'pricingList',
    marketplaces: 'marketplaces'
};
async function _kmRefreshCacheTables_(tableNames) {
    var names = (tableNames || []).filter(Boolean);
    if (!names.length) return;
    // F1-7N-FB-4E §D — the SECOND fan-out site, and it had the same unbounded `Promise.all(names.map(...))`
    // shape: the FC builder, the Request Order second-layer expand and the allocation-draft hydrate each opened
    // one simultaneous request per table. Same shared bound as loadScopedTables, one knob for both.
    var rawDb = await _kmReadTablesBounded_(names);
    var norm = normalizeOperationDb(rawDb);
    if (!window._opDbCache) window._opDbCache = normalizeOperationDb({});
    names.forEach(function (n) {
        var key = _KM_TABLE_CACHE_KEY_[n];
        if (key && Object.prototype.hasOwnProperty.call(norm, key)) window._opDbCache[key] = norm[key];
    });
    // F1-7N-FA-3C-R6C — a scoped refresh that got here fetched LIVE sheet tables (getOperationDbTableFromSheet), so the
    // cache's data source IS the live sheet. Stamp 'google-sheet' so a later isScopedReadEligible() stays true across SPA
    // navigation (never coerced to 'mock' by the missing-marker default). Do NOT override an explicit 'mock' posture.
    if (window._opDbCache._sourceMode !== 'mock') window._opDbCache._sourceMode = 'google-sheet';
}
// F1-7L: exposed bounded scoped loader for the remaining secondary surfaces (RO 2nd-layer expand, FC builder/
// import modals) + the IR allocation-draft hydrate — the replacement for the retired whole-DB startup prime.
// Fetches ONLY the named tables (getTable) and patches their slices into _opDbCache. NEVER a whole-DB reload.
window.KM.DB.refreshCacheTables = _kmRefreshCacheTables_;

window.KM.DB.updateSkuLifecycle = async function(sku, lifecycle) {
    if (window.KM.DB.isCloudWriteEnabled()) {
        // Cloud mode: sku_details.lifecycle is the SINGLE authority — write the sheet, then re-read fresh.
        // (F1-S1: no browser lifecycle override exists to clear anymore.)
        var result = await updateSkuLifecycleInSheet(sku, lifecycle);
        await _kmWriterPostWrite_();
        return result;
    } else {
        // Mock / no-cloud mode: lifecycle is NOT persisted to the browser (F1-S1 — authority = sku_details
        // only). Patch the in-memory cache so the current session reflects the change; a refresh reloads the
        // mock defaults. No localStorage override is written.
        if (window._opDbCache && Array.isArray(window._opDbCache.skuDetails)) {
            var rec = window._opDbCache.skuDetails.find(function(i) { return i.sku === sku; });
            if (rec) rec.lifecycle = lifecycle;
        }
        return { sku: sku, lifecycle: lifecycle };
    }
};

async function updateSkuLifecycleInSheet(sku, lifecycle) {
    if (!isOperationDbApiConfigured()) {
        throw new Error('Operation DB API not configured');
    }
    var url = OP_DB_API_BASE_URL;
    var resp = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            action: 'updateSkuLifecycle',
            sku: sku,
            lifecycle: lifecycle,
            updated_by: 'operation-system'
        })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    return json.data;
}

// ========================================
// marketplace_skus Write Methods
// ========================================

window.KM.DB.upsertMarketplace = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertMarketplace skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertMarketplace' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert failed');
    // F1-7M-C1: this is the ONLY writer that mutates the `marketplaces` master → invalidate its session reference AFTER
    // a confirmed-successful write (a failed write above threw, so the cache stays valid → no premature invalidation).
    if (window.KM && window.KM.referenceCache) window.KM.referenceCache.invalidate('marketplaces');
    await _kmWriterPostWrite_();
    return json.data;
};

// F1-7N-D-2j — Site Inventory Warehouse Allocation writer. Scope-safe SAVE of the SELF_FULFILLED demand-allocation
// rows for ONE (company,country,marketplace) into replenishment_demand_allocation_rules (the sole planning-membership
// authority). payload = { company, country, marketplace, allocations:[{destination_warehouse_id, forecast_ratio,
// sales_ratio}], updated_by? }. The backend rejects FBA/execution destinations and enforces the 100%-sum contract.
window.KM.DB.saveReplenishmentDemandAllocationRules = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, saveReplenishmentDemandAllocationRules skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'replenishmentDemandAllocation.save' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Save failed');
    // F1-7N-D-2k-R1: persistence is the KM_WAREHOUSE_ALLOCATION_CONFIG Script-Property blob (not a DB sheet), so no
    // whole-DB reference cache needs invalidation. Kept harmless for any legacy consumer of that reference name.
    if (window.KM && window.KM.referenceCache) window.KM.referenceCache.invalidate('replenishment_demand_allocation_rules');
    return json.data;
};

// F1-7N-D-2k-R1 — Warehouse Allocation config READ (Site Inventory → More Options → Warehouse Allocation modal
// hydrate). Reads the KM_WAREHOUSE_ALLOCATION_CONFIG Script-Property blob for ONE scope (NOT the whole-DB cache — the
// config is not a DB sheet). READ-ONLY. Returns { company, country, marketplace, allocations:[{destination_warehouse_id,
// forecast_ratio, sales_ratio, status, allocation_rule_id}] } — [] allocations when nothing saved for the scope.
window.KM.DB.getWarehouseAllocationConfig = async function(scope) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, getWarehouseAllocationConfig skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'warehouseAllocation.get', payload: { scope: scope || {} } })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Read failed');
    return json.data;
};

// F1-7N-TW-FACTORY-OPERATIONAL-CONFIG-R1 — TW factory operational-policy config READ (Factory Inventory → More
// Options → TW Factory Settings modal hydrate). Reads the KM_FACTORY_OPERATION_CONFIG Script-Property blob (NOT a DB
// sheet). READ-ONLY (opening the modal mutates nothing). Absent config → both policies false. Returns
// { version, tw:{ newSkuParticipationEnabled, generalAllocationEnabled }, updatedAt, updatedBy }.
window.KM.DB.getFactoryOperationConfig = async function() {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, getFactoryOperationConfig skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'factoryOperationConfig.get' })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Read failed');
    return json.data;
};

// F1-7N-TW-FACTORY-OPERATIONAL-CONFIG-R1 — TW factory operational-policy config SAVE. Writes ONLY the
// KM_FACTORY_OPERATION_CONFIG Script-Property blob (no inventory mutation, no Sheet tab). payload =
// { tw:{ newSkuParticipationEnabled:boolean, generalAllocationEnabled:boolean }, updated_by? }.
window.KM.DB.saveFactoryOperationConfig = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, saveFactoryOperationConfig skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'factoryOperationConfig.save', payload: payload || {} })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Save failed');
    return json.data;
};

window.KM.DB.upsertMarketplaceSku = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertMarketplaceSku skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertMarketplaceSku' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert failed');
    await _kmWriterPostWrite_();
    return json.data;
};

window.KM.DB.updateMarketplaceSkuModel = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateMarketplaceSkuModel skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updateMarketplaceSkuModel' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Upsert a sku_details row (create/update by sku). Currently writes the customs-facing fields
// product_name_cn / product_use (and any other allowlisted sku_details columns the handler accepts).
// Payload = { sku, product_name_cn?, product_use?, ... }.
window.KM.DB.upsertSkuDetail = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertSkuDetail skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: 'upsertSkuDetail' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) {
        // Preserve the backend's structured error_code (e.g. duplicate_sku / not_found) on the thrown Error.
        var e = new Error(json.error || 'Upsert failed');
        if (json.error_code) e.error_code = json.error_code;
        throw e;
    }
    await _kmWriterPostWrite_();
    return json.data;
};

// SKU Domain v2.0 — upsert a sku_regional_details row (create/update by
// sku+company+country+marketplace). Payload = { sku, company, country, marketplace, site_sku?,
// marketplace_product_id?, product_url?, packaging_regulation?, regulation_url?, language?, manual_version?,
// label_version?, battery_regulation?, sync_marketplace_sku? }. When sync_marketplace_sku is truthy the
// handler also propagates site_sku / marketplace_product_id INTO the matching marketplace_skus row.
window.KM.DB.upsertSkuRegionalDetail = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertSkuRegionalDetail skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertSkuRegionalDetail' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert regional detail failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Tax & Referral Rate Master V2 — upsert ONE tax_referral_rates row (PARENT).
// Payload (snake_case): { tax_rate_id?, series, country_of_origin, duty_country, hscode?, duty_rate?,
//   vat_no?, vat_rate?, eori_no?, port_tax_rate?, referral_fee_rate?, declared_value?, declared_currency?,
//   effective_from, effective_to?, note?, create_version?, close_previous? }.
// tax_rate_id present + no create_version → correction (update in place). Otherwise → new version (new id).
// Returns { tax_rate_id, updated, created, version?, previous_closed?, warnings }. NO fake success —
// resolves only when the handler reports success (real DB write). See TAX_AND_REFERRAL_RATES_SPEC.md §9/§12.
window.KM.DB.upsertTaxReferralRate = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertTaxReferralRate skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: 'upsertTaxReferralRate' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert tax referral rate failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Tax & Referral Rate Master V2 — upsert ONE tax_rate_components row (CHILD).
// Payload (snake_case): { tax_component_id?, tax_rate_id, component_type, component_code, component_name?,
//   rate_type, rate_value?, amount_per_unit?, amount_currency?, quantity_unit?, effective_from?,
//   effective_to?, source_url?, note? }. The parent tax_rate_id MUST exist (handler rejects orphans).
// Returns { tax_component_id, updated, created, warnings }.
window.KM.DB.upsertTaxRateComponent = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertTaxRateComponent skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: 'upsertTaxRateComponent' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert tax rate component failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Confirm Shipment & Dispatch — the single orchestration command (2026-07-24). Finalizes the Formal
// Shipment (in_transit) + snapshots shipment_routes + creates the initial shipment_event + deducts
// factory_stock, atomically + idempotently on the backend. Payload (snake_case): { shipment_id (required),
// route_template_id? (explicit override), actor? }. Returns the FULL backend response { success, data?,
// error?, stage?, already_confirmed? } WITHOUT throwing, so the UI can show the failed stage + shipment_id
// and preserve input. Reloads the DB cache ONLY on success so On-the-Way immediately sees the new data.
window.KM.DB.confirmShipmentAndDispatch = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, confirmShipmentAndDispatch skipped');
        return { success: false, error: 'API not configured', stage: 'config' };
    }
    var json;
    try {
        var resp = await fetch(OP_DB_API_BASE_URL, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'confirmShipmentAndDispatch' }, payload))
        });
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, stage: 'network' };
        json = await resp.json();
    } catch (e) {
        return { success: false, error: (e && e.message) ? e.message : String(e), stage: 'network' };
    }
    if (json && json.success) { await _kmWriterPostWrite_(); }   // refresh cache so On-the-Way sees it
    return json;
};

// F1-5C-EXPORT-R3C — generate (and optionally render the real Drive file for) a shipment document from the frozen
// R2B snapshot via the canonical R3A/R3B/R3C backend chain. The frontend performs NO placeholder mapping / totals /
// master resolution / template selection / version choice — it only sends { shipment_id, document_type,
// generate_file, regenerate? } and opens the returned download_url. Returns the full backend envelope (success +
// document_id + file/download refs, or a fail-closed error/reason such as DOCUMENT_TEMPLATE_A§ET_MISSING).
window.KM.DB.generateShipmentDocument = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, generateShipmentDocument skipped');
        return { success: false, error: 'API not configured', stage: 'config' };
    }
    try {
        var resp = await fetch(OP_DB_API_BASE_URL, {
            method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'shipmentDocument.generate' }, payload || {}))
        });
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, stage: 'network' };
        return await resp.json();
    } catch (e) { return { success: false, error: (e && e.message) ? e.message : String(e), stage: 'network' }; }
};
// ---- F1-7N-FB-1B §P — the canonical generated_documents read path -------------------------------------------
// One transport shape for every document action. The frontend NEVER enumerates Drive and never builds document
// content; it asks the backend for registry metadata and safe links. Errors are returned in the existing
// envelope shape, so a failure is visible rather than silently rendering an empty panel.
function _kmDocumentAction(action, payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, ' + action + ' skipped');
        return Promise.resolve({ success: false, error: 'API not configured', stage: 'config' });
    }
    return fetch(OP_DB_API_BASE_URL, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    }).then(function (resp) {
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, stage: 'network' };
        return resp.json();
    }).catch(function (e) { return { success: false, error: (e && e.message) ? e.message : String(e), stage: 'network' }; });
}
// List the documents registered for ONE entity (shipment or purchase_order), with the resolved folder link,
// the derived batch status and error assistance.
window.KM.DB.listEntityDocuments = function(entityType, entityId) {
    return _kmDocumentAction('document.list', { related_entity_type: entityType, related_entity_id: entityId });
};
window.KM.DB.getGeneratedDocument = function(documentId) {
    return _kmDocumentAction('document.get', { document_id: documentId });
};
// Retry regenerates ONLY the missing/failed documents; the backend reuses anything already generated, so this
// can never duplicate a folder, a file, a PDF or a registry row.
window.KM.DB.retryDocumentGeneration = function(entityType, entityId) {
    return _kmDocumentAction('document.retry', { related_entity_type: entityType, related_entity_id: entityId, actor: 'operation-system' });
};
// READ-ONLY diagnostics. They perform zero writes and create no Drive folder or file — the folders they report
// are preview paths, not created objects.
window.KM.DB.runPoDocumentDiagnostic = function(purchaseOrderId) {
    return _kmDocumentAction('document.diagnostic.purchaseOrder', { purchase_order_id: purchaseOrderId });
};
window.KM.DB.runShipmentDocumentDiagnostic = function(shipmentId) {
    return _kmDocumentAction('document.diagnostic.shipment', { shipment_id: shipmentId });
};

// Open/download a generated document result in a new tab (download_url = PDF when present, else the editable file).
// Presentation only — the frontend never builds document content.
window.KM.DB.openGeneratedDocument = function(res) {
    var url = res && (res.download_url || res.pdf_file_url || res.file_url);
    if (url && typeof window !== 'undefined' && window.open) { window.open(url, '_blank', 'noopener'); return true; }
    return false;
};

// F1-5B-SHIP-R3C — reconcile canonical DRAFT PO→FIFO allocations for a shipment. Thin adapter to the SINGLE R3A
// backend authority (action: generateShipmentLineAllocations); the frontend performs NO FIFO / capacity / shipped
// math. One shipment-scoped call reconciles all lines (no per-SKU fan-out). Refreshes the cache on success so the
// draft shipment_line_allocations are visible before Confirm & Dispatch (R3B).
window.KM.DB.generateShipmentLineAllocations = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, generateShipmentLineAllocations skipped');
        return { success: false, error: 'API not configured', stage: 'config' };
    }
    var json;
    try {
        var resp = await fetch(OP_DB_API_BASE_URL, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'generateShipmentLineAllocations' }, payload))
        });
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, stage: 'network' };
        json = await resp.json();
    } catch (e) {
        return { success: false, error: (e && e.message) ? e.message : String(e), stage: 'network' };
    }
    if (json && json.success) { await _kmWriterPostWrite_(); }   // refresh cache so draft allocations are visible
    return json;
};

// Shipment Receipt (F1-SHIPMENT-RECEIPT-R1B). CUMULATIVE receipt against the live shipment_received_qty
// column; the backend derives shipments.status (partially_received / received) — never authored here.
// Payload (snake_case): { shipment_id (required), lines: [ { shipment_line_id, shipment_received_qty } ],
// actor? }. shipment_received_qty is the NEW CUMULATIVE total (not a per-save increment). Returns the FULL
// backend response { success, data?, error?, code?, invalid_lines? } WITHOUT throwing. Reloads the DB cache
// ONLY on success so On-the-Way immediately reflects the new receipt + derived status.
window.KM.DB.updateShipmentReceipt = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateShipmentReceipt skipped');
        return { success: false, error: 'API not configured', code: 'config' };
    }
    var json;
    try {
        var resp = await fetch(OP_DB_API_BASE_URL, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'shipment.receipt.update' }, payload))
        });
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, code: 'network' };
        json = await resp.json();
    } catch (e) {
        return { success: false, error: (e && e.message) ? e.message : String(e), code: 'network' };
    }
    if (json && json.success) { await _kmWriterPostWrite_(); }
    return json;
};

// Shipment Route Progress (F1-SHIPMENT-RECEIPT-R1B). Set the CURRENT route point on the shipment's
// snapshotted shipment_routes nodes (forward-only; backward fails closed; same-node is an idempotent
// no-op). Payload (snake_case): { shipment_id (required), route_template_node_id (required — canonical
// node identity from this shipment's route), actor? }. Returns the FULL backend response WITHOUT throwing.
window.KM.DB.advanceShipmentRoutePoint = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, advanceShipmentRoutePoint skipped');
        return { success: false, error: 'API not configured', code: 'config' };
    }
    var json;
    try {
        var resp = await fetch(OP_DB_API_BASE_URL, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'shipment.route.advance' }, payload))
        });
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, code: 'network' };
        json = await resp.json();
    } catch (e) {
        return { success: false, error: (e && e.message) ? e.message : String(e), code: 'network' };
    }
    if (json && json.success) { await _kmWriterPostWrite_(); }
    return json;
};

// Shipment ETA update (F1-SHIPMENT-MAP-R10; F1-7N-FB-4A §G). THE one canonical writer — updates ONLY
// shipments.eta plus its audit stamps, and the server proves persistence by reading the cell back.
// Payload (snake_case): { shipment_id (the INTERNAL shipments.shipment_id), eta (YYYY-MM-DD), actor? }.
//
// BOUNDED. The previous version awaited a bare fetch with NO timeout, so a stalled write left the drawer's
// button disabled with "Updating ETA…" on screen for as long as the socket stayed open, and the page could not
// distinguish "still running" from "dead". It is now bound by the SAME KM_WRITE_TIMEOUT_MS_ every other write
// uses, and an abort is reported as REQUEST_TIMEOUT_WRITE_INDETERMINATE — INDETERMINATE, because closing a
// socket does not stop an Apps Script execution, so the write may well have landed. The caller must RECONCILE
// (read the persisted ETA) before offering a retry; it must never blindly repeat the write.
//
// Returns the FULL backend response WITHOUT throwing, so a typed failure (ETA_INVALID / SHIPMENT_NOT_FOUND /
// ETA_HEADER_MISSING / ETA_WRITE_NOT_ACKNOWLEDGED / ETA_READBACK_MISMATCH) reaches the page intact.
window.KM.DB.updateShipmentEta = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateShipmentEta skipped');
        return { success: false, error: 'API not configured', code: 'TRANSPORT_NOT_CONFIGURED' };
    }
    var json;
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, KM_WRITE_TIMEOUT_MS_) : null;
    try {
        var opts = {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'shipment.eta.update' }, payload))
        };
        if (ctl) opts.signal = ctl.signal;
        var resp = await fetch(OP_DB_API_BASE_URL, opts);
        if (timer) { clearTimeout(timer); timer = null; }
        if (!resp.ok) return { success: false, error: 'API returned ' + resp.status, code: 'HTTP_TRANSPORT_ERROR' };
        json = await resp.json();
    } catch (e) {
        if (timer) { clearTimeout(timer); timer = null; }
        var aborted = !!(e && (e.name === 'AbortError' || String(e.message || '').indexOf('abort') !== -1));
        if (aborted) {
            return { success: false, code: 'REQUEST_TIMEOUT_WRITE_INDETERMINATE',
                error: 'The ETA request exceeded ' + KM_WRITE_TIMEOUT_MS_ + ' ms. The server may still have applied it, so the stored ETA must be RECONCILED before any retry.' };
        }
        return { success: false, error: (e && e.message) ? e.message : String(e), code: 'HTTP_TRANSPORT_ERROR' };
    }
    if (json && json.success) { await _kmWriterPostWrite_(); }
    return json;
};

// F1-7N-FB-4A §G — READ-ONLY ETA reconciliation. After an INDETERMINATE timeout the only safe next step is to
// find out what the database actually holds; repeating an indeterminate write is how a double-apply happens.
// This reads the ONE shipment through the existing bounded shipment workspace (no new backend surface, no write,
// no lock) and reports whether the persisted ETA already equals the intended one.
// Returns { success, reconciled, persisted_eta, matches_intended } — never throws.
window.KM.DB.reconcileShipmentEta = async function(shipmentId, intendedEta) {
    var sid = String(shipmentId == null ? '' : shipmentId).trim();
    var want = String(intendedEta == null ? '' : intendedEta).trim();
    if (!sid) return { success: false, reconciled: false, error: 'shipment_id is required', code: 'SHIPMENT_ID_REQUIRED' };
    if (!(window.KM && window.KM.api && typeof window.KM.api.getWorkspace === 'function')) {
        return { success: false, reconciled: false, error: 'the shipment workspace read is unavailable', code: 'RECONCILE_UNAVAILABLE' };
    }
    var env;
    try { env = await Promise.resolve(window.KM.api.getWorkspace('shipment', { filters: { shipmentId: sid } })); }
    catch (e) { return { success: false, reconciled: false, error: String((e && e.message) || e), code: 'RECONCILE_READ_FAILED' }; }
    if (!(env && env.success && env.data)) return { success: false, reconciled: false, error: 'the shipment could not be re-read', code: 'RECONCILE_READ_FAILED' };
    var one = (env.data.shipments || []).filter(function (r) { return String(r.shipmentId || (r.raw && r.raw.shipment_id) || '') === sid; })[0];
    if (!one) return { success: false, reconciled: false, error: 'the shipment was not found on re-read', code: 'SHIPMENT_NOT_FOUND' };
    var persisted = String(one.eta == null ? '' : one.eta).trim();
    return { success: true, reconciled: true, persisted_eta: persisted, matches_intended: !!want && persisted === want };
};

// Backfill / migration: scan ALL existing marketplace_skus rows and create/update sku_regional_details.
// Creates missing regional rows and updates only site_sku + marketplace_product_id on existing rows;
// never touches compliance-document fields. Returns
// { created_count, updated_count, skipped_count, warning_count, errors, warnings }.
window.KM.DB.syncMarketplaceSkusToSkuRegionalDetails = async function() {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, syncMarketplaceSkusToSkuRegionalDetails skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'syncMarketplaceSkusToSkuRegionalDetails' })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Sync regional details failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Weekly Shipping Plan (Decision Layer) write methods.
// Submit Plan → create shipping_plans + shipping_plan_lines (grouped server-side by the six-key).
window.KM.DB.createShippingPlansBatch = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, createShippingPlansBatch skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'createShippingPlansBatch' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Create shipping plans failed');
    await _kmWriterPostWrite_();
    return json.data;
};


// ========================================================================================================
// F1-7N-FB-3 §D — BOUNDED TRANSPORT. Nothing may load forever.
// --------------------------------------------------------------------------------------------------------
// Every business request in both verticals funnels through one of the two canonical runners below
// (_kmGapRead_ for reads, _kmWeeklyCommand_ for commands) or through a direct writer. None of them had a
// timeout: `fetch` against an Apps Script deployment that never answers simply never settles, so the caller's
// await never returns, its latch is never released and the page stays in LOADING forever with no error. That
// is the mechanism behind "waited a long time and produced no visible result" — the client had no upper bound.
//
// A timeout is a TRANSPORT verdict, never a business verdict: it says "no answer arrived", NOT "nothing was
// written". A write that times out is therefore reported as INDETERMINATE and is NEVER auto-retried — only an
// explicit user retry that reuses the SAME idempotency identity is safe, and the caller owns that decision.
var KM_READ_TIMEOUT_MS_ = 45000;    // a bounded scoped read
var KM_WRITE_TIMEOUT_MS_ = 90000;   // a locked DB write; Apps Script cold start + lock wait is legitimately slow
// ============================================================================================================
// F1-7N-FB-4E §A/§C — CAPTURE THE EVIDENCE, THEN CLASSIFY. ONE PLACE.
// ------------------------------------------------------------------------------------------------------------
// THE DEFECT THIS CLOSES. Both shared runners answered a non-2xx with `'API HTTP ' + resp.status` and then
// DISCARDED everything that could say what had actually happened: `resp.url` (which URL finally answered),
// `resp.redirected` (whether a hop occurred at all), the content type, and the body. So the live
// "HTTP 404, text/html" could not be attributed to any of its four possible sources — a GitHub Pages 404, an
// Apps Script deployment 404, a Google login/access page, or an expired script.googleusercontent.com redirect
// target — and every one of those has a different fix. A 404 was also treated as an ordinary transport error,
// which is wrong in the one way that matters: none of the four is repaired by asking again.
//
// TWO CODES, ONE DECISION. `legacyCode` is what the existing consumers and write barriers key on
// (`code === 'HTTP_TRANSPORT_ERROR' || code === 'NON_JSON_RESPONSE'`), so it is preserved EXACTLY. It is now
// DERIVED FROM the typed FB-4E classification rather than computed separately — there is one decision and one
// alias of it, not two classifiers that can disagree. `typed` is the authority: the §C code, the state-machine
// phase, the masked endpoint identity and the HTML fingerprint.
//
// SAFETY. The raw HTML body never leaves this function. KM.transport reduces it to booleans plus at most six
// short tokens, and the Script ID is masked out of every URL before anything is recorded.
// ============================================================================================================
var KM_TRANSPORT_EVIDENCE_BUILD_ = 'F1-7N-FB-4E';
function _kmTransportFactory_() {
    try {
        if (typeof window !== 'undefined' && window.KM && window.KM.transportFactory) return window.KM.transportFactory;
    } catch (e) {}
    return null;
}
// The safe wire facts, read off a Response WITHOUT consuming its body (callers already read text()).
function _kmWireEvidence_(resp, requestedUrl) {
    var tf = _kmTransportFactory_();
    var mask = (tf && typeof tf.maskEndpoint === 'function') ? tf.maskEndpoint : function () { return ''; };
    var ctype = '';
    try { if (resp && resp.headers && typeof resp.headers.get === 'function') ctype = resp.headers.get('content-type') || ''; } catch (e) { ctype = ''; }
    return {
        httpStatus: (resp && typeof resp.status === 'number') ? resp.status : null,
        contentType: ctype || null,
        redirected: !!(resp && resp.redirected === true),
        maskedFinalEndpoint: mask(resp && resp.url) || null,
        maskedRequestedEndpoint: mask(requestedUrl) || null,
        transport_build: KM_TRANSPORT_EVIDENCE_BUILD_
    };
}
// Classify ONE answered request. `kind` is 'read' or 'write' and decides only the zero-write/indeterminate
// wording — never the classification itself.
//   -> { ok, legacyCode, typed:{ code, phase, html_source, fingerprint, ... }, wire }
function _kmClassifyAnswer_(action, kind, resp, text, requestedUrl) {
    var wire = _kmWireEvidence_(resp, requestedUrl);
    var tf = _kmTransportFactory_();
    var trimmed = String(text == null ? '' : text).trim();
    var status = wire.httpStatus;
    var htmlish = trimmed === '' || trimmed.charAt(0) === '<'
        || (/text\/html/i.test(wire.contentType || '') && trimmed.charCodeAt(0) !== 123);   // 123 = JSON object start
    if (htmlish) {
        var fp = (tf && typeof tf.fingerprintHtml === 'function') ? tf.fingerprintHtml({
            body: trimmed, status: status, contentType: wire.contentType, finalUrl: (resp && resp.url) || '',
            requestedUrl: requestedUrl, redirected: wire.redirected,
            frontendOrigin: (typeof window !== 'undefined' && window.location && window.location.origin) ? String(window.location.origin) : ''
        }) : null;
        var typedCode = (tf && typeof tf.codeForHtml === 'function') ? tf.codeForHtml(fp)
            : (status === 404 ? 'HTTP_NOT_FOUND_HTML' : 'TRANSPORT_NON_JSON_RESPONSE');
        return { ok: false,
            // A non-2xx keeps the alias the page barriers already recognise; the REASON is the typed code beside it.
            legacyCode: (status !== null && !(status >= 200 && status < 300)) ? 'HTTP_TRANSPORT_ERROR' : 'NON_JSON_RESPONSE',
            typed: { code: typedCode, phase: 'REDIRECT_RESPONSE', html_source: (fp && fp.source) || null,
                fingerprint: fp, retryable: false, zero_write: (kind !== 'write'), action: action },
            wire: wire };
    }
    if (status !== null && !(status >= 200 && status < 300)) {
        var retryable = (kind === 'read') && (status === 408 || status === 429 || status >= 500);
        return { ok: false, legacyCode: 'HTTP_TRANSPORT_ERROR',
            typed: { code: 'HTTP_TRANSPORT_ERROR', phase: 'REDIRECT_RESPONSE', html_source: null, fingerprint: null,
                retryable: retryable, zero_write: (kind !== 'write'), action: action }, wire: wire };
    }
    if (trimmed.charCodeAt(0) !== 123) {
        return { ok: false, legacyCode: 'NON_JSON_RESPONSE',
            typed: { code: 'TRANSPORT_NON_JSON_RESPONSE', phase: 'PARSE', html_source: null, fingerprint: null,
                retryable: false, zero_write: (kind !== 'write'), action: action }, wire: wire };
    }
    return { ok: true, legacyCode: null, typed: null, wire: wire };
}
// F1-7N-FB-4E §E — report one request's outcome to the shared metric. Duration, bytes and a code; never a URL,
// a payload or a row. Wrapped so a missing transport module can never break a read.
function _kmReportSample_(action, kind, startedAt, code, phase, bytes, extra) {
    try {
        if (typeof window !== 'undefined' && window.KM && window.KM.transport && typeof window.KM.transport.recordExternal === 'function') {
            var s = { action: action, kind: kind, code: code || null, phase: phase || null,
                ms: (startedAt ? (Date.now() - startedAt) : 0), bytes: bytes || 0 };
            if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k]; } }
            window.KM.transport.recordExternal(s);
        }
    } catch (e) { /* observation must never affect the read */ }
}

// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §5 — WHAT A MUTATION REQUEST WOULD CHANGE, WITHOUT ITS VALUES.
//
// After the 2026-09-06 incident the question was not 'did a request fail?' — every request succeeded. It was
// 'which ROWS did the page address, and which COLUMNS was it setting?', and nothing recorded that. Identities,
// counts and field NAMES answer it completely. A quantity, a note or an override reason answers nothing extra
// and is the sort of thing a diagnostic log has no business carrying, so none of them are read here.
// R6-R6-R4 §5 — FOUR FACTS THE AUDIT NEEDED AND THIS COULD NOT REPORT. After the 2026-09-06 incident the
// question asked of a write is no longer 'which rows did it name?' but 'was it the UPDATE we meant, of the
// version we read, or something that could mint a twin?'. `intent`, `expected_draft_version`,
// `has_create_idempotency_key` and `mints_new_row` answer exactly that, and none of them carries a value:
// an intent token, a version string, and two booleans.
//
// `changed_fields` IS NOT A DIFF, and naming it that has always been generous. It is the set of field names
// the payload CARRIES, and an UPDATE echoes the whole header — so a one-column edit legitimately lists a
// dozen names. The proof that only one column moved is the database readback, never this list. Kept under
// its existing name because it is what four suites already read, and stated plainly here instead.
function _kmMutationShape_(command, payload) {
    var out = { routes_in_payload: null, allocation_draft_id: null, allocation_draft_line_ids: null,
        changed_fields: null, intent: null, expected_draft_version: null,
        has_create_idempotency_key: null, mints_new_row: null };
    try {
        var p = payload || {};
        var h = p.header || null;
        var lines = Array.isArray(p.lines) ? p.lines : (p.line ? [p.line] : []);
        var names = {};
        if (h) {
            out.allocation_draft_id = String(h.allocation_draft_id || p.allocation_draft_id || '') || null;
            Object.keys(h).forEach(function (k) { if (h[k] !== undefined) names[k] = 1; });
        } else if (p.allocation_draft_id) {
            out.allocation_draft_id = String(p.allocation_draft_id);
        }
        if (lines.length) {
            out.routes_in_payload = lines.length;
            out.allocation_draft_line_ids = lines.map(function (l) { return String((l && l.allocation_draft_line_id) || '(new)'); });
            lines.forEach(function (l) { Object.keys(l || {}).forEach(function (k) { if (l[k] !== undefined) names['line.' + k] = 1; }); });
        }
        var ks = Object.keys(names);
        if (ks.length) out.changed_fields = ks.sort();
        // The intent and the version are read from the header FIRST and the envelope second, because that is
        // the order the server resolves them in; reporting the envelope's copy when the header disagrees
        // would describe a request the writer never saw.
        out.intent = String((h && h.intent) || p.intent || '') || null;
        out.expected_draft_version = ((h && h.expected_draft_version) != null)
            ? String(h.expected_draft_version)
            : ((p.expected_draft_version != null) ? String(p.expected_draft_version) : null);
        out.has_create_idempotency_key = !!((h && h.create_idempotency_key) || p.create_idempotency_key);
        // A row is MINTED when the payload names no line id for it, or when the intent is a create. Either
        // one turns 'update the route on screen' into 'add a second route that looks like it'.
        out.mints_new_row = (String(out.intent || '').toUpperCase().indexOf('CREATE') !== -1)
            || (Array.isArray(out.allocation_draft_line_ids)
                && out.allocation_draft_line_ids.indexOf('(new)') !== -1);
    } catch (e) { /* a diagnostic that can throw is worse than one that is silent */ }
    return out;
}
// A client-side correlation id for a WRITE. Reads carry km_rid in the URL and the router echoes it; the POST
// path has no such field (01_router reads km_rid from e.parameter only), so this id correlates the dispatch,
// the settle and the outcome WITHIN THIS BROWSER and is honestly labelled as doing only that. Giving a write
// a server-echoed id means changing the POST contract and re-deploying the router, which is a decision of its
// own and is deliberately not smuggled into an incident repair.
function _kmWithOutcome_(shape, outcome) {
    var o = {}; for (var k in shape) { if (Object.prototype.hasOwnProperty.call(shape, k)) o[k] = shape[k]; }
    o.outcome = outcome;
    return o;
}
var _KM_WRITE_RID_SEQ_ = 0;
function _kmNextWriteRequestId_() { _KM_WRITE_RID_SEQ_++; return 'REQ-W' + ('000000' + _KM_WRITE_RID_SEQ_).slice(-6) + '-C'; }
// The safe operator-facing sentence for a typed transport failure. No URL beyond the masked identity, no body.
function _kmTypedTransportMessage_(action, cls) {
    var t = cls.typed || {}, w = cls.wire || {};
    var src = t.html_source || '';
    if (t.code === 'AUTH_OR_ACCESS_HTML') return 'The API answered with a Google sign-in or access page instead of data, so "' + action + '" never ran. Nothing was read.';
    if (src === 'GITHUB_PAGES_404' || src === 'FRONTEND_ORIGIN_RESPONSE') return 'The request for "' + action + '" was answered by the WEBSITE itself with a 404 page, not by the API — the configured endpoint is not reaching the Apps Script Web App.';
    if (src === 'EXPIRED_USERCONTENT_REDIRECT') return 'The API redirect target for "' + action + '" had already expired, so a 404 page came back instead of data. Nothing was read.';
    if (src === 'APPS_SCRIPT_DEPLOYMENT_404') return 'The Apps Script deployment did not answer "' + action + '" — it returned HTTP ' + w.httpStatus + ' as a web page. The deployment may be unpublished, superseded or access-restricted.';
    if (t.code === 'HTTP_NOT_FOUND_HTML') return 'The API answered HTTP 404 with a web page instead of data. Nothing was read.';
    if (t.code === 'TRANSPORT_NON_JSON_RESPONSE') return 'The API answered with a body that is not JSON (HTTP ' + w.httpStatus + ', ' + (w.contentType || 'unknown type') + '). Nothing was read.';
    return 'API HTTP ' + w.httpStatus;
}
function _kmTimeoutMs_(kind) {
    try {
        var o = (typeof window !== 'undefined' && window.KM_REQUEST_TIMEOUT_MS) || null;
        if (o && typeof o === 'object' && o[kind] > 0) return Number(o[kind]);   // explicit operator override
    } catch (e) {}
    return kind === 'write' ? KM_WRITE_TIMEOUT_MS_ : KM_READ_TIMEOUT_MS_;
}
// fetch with an upper bound. Aborts the in-flight request (so the browser stops holding the socket) and throws
// a typed error the runners classify. `AbortController` is assumed present in every supported browser; when it
// is genuinely absent we still bound the WAIT via a rejecting race, so the caller is released either way.
async function _kmFetchBounded_(url, init, kind) {
    var ms = _kmTimeoutMs_(kind);
    var timedOut = false;
    var ctl = null;
    try { ctl = (typeof AbortController === 'function') ? new AbortController() : null; } catch (e) { ctl = null; }
    var timer = null;
    var expiry = new Promise(function (_res, rej) {
        timer = setTimeout(function () {
            timedOut = true;
            try { if (ctl) ctl.abort(); } catch (e2) {}
            var err = new Error('The request exceeded the ' + Math.round(ms / 1000) + 's client time limit and was aborted.');
            err.kmTimeout = true;
            rej(err);
        }, ms);
    });
    var opts = ctl ? Object.assign({}, init, { signal: ctl.signal }) : init;
    try {
        return await Promise.race([fetch(url, opts), expiry]);
    } catch (err) {
        if (timedOut || (err && err.kmTimeout)) { var t = new Error('REQUEST_TIMEOUT'); t.kmTimeout = true; t.timeoutMs = ms; throw t; }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
// The typed transport result for an expired request. A read is retryable; a WRITE is INDETERMINATE — the
// server may or may not have committed, so the client must never present it as either success or zero-write.
function _kmTimeoutError_(action, kind, ms) {
    return kind === 'write'
        ? { code: 'REQUEST_TIMEOUT_WRITE_INDETERMINATE',
            message: 'No answer arrived within ' + Math.round(ms / 1000) + 's. The write may or may not have been committed — verify before retrying.',
            details: { command: action, zero_write: false, indeterminate: true, retryable: false, timeout_ms: ms } }
        : { code: 'REQUEST_TIMEOUT',
            message: 'No answer arrived within ' + Math.round(ms / 1000) + 's.',
            details: { command: action, zero_write: true, retryable: true, timeout_ms: ms } };
}
// F1-7N-FB-3 §J — post-write reconcile suppression for a MULTI-WRITE batch.
// _kmWriterPostWrite_ falls back to loadOperationDb({force:true}) — a WHOLE-DB read — whenever the scoped
// posture cannot be confirmed. Send Request performs 2-3 writes PER SKU in a serial loop, so on any session
// where a single workspace flag is rolled back (or the Foundation is momentarily absent) that loop performed
// one whole-DB reload PER WRITE. A batch declares itself here and reconciles ONCE at the end instead.
var _kmPostWriteDeferred_ = 0;
var _kmPostWriteDirty_ = false;
window.KM.DB.beginWriteBatch = function () { _kmPostWriteDeferred_++; };
// Ends the batch and performs AT MOST ONE reconcile for everything written inside it.
window.KM.DB.endWriteBatch = async function () {
    if (_kmPostWriteDeferred_ > 0) _kmPostWriteDeferred_--;
    if (_kmPostWriteDeferred_ === 0 && _kmPostWriteDirty_) {
        _kmPostWriteDirty_ = false;
        // DELEGATE to the ONE writer seam (now un-deferred) instead of repeating its reload. A batch defers the
        // EXISTING reconcile; it must never become a second whole-DB reload path of its own.
        await _kmWriterPostWrite_();
    }
};
window.KM.DB.isWriteBatchOpen = function () { return _kmPostWriteDeferred_ > 0; };


// ========================================================================================================

// F1-7N-FB-3A §I — PRESERVE THE STRUCTURED ENVELOPE ON A THROWN WRITER ERROR.
// The direct writers signal failure by `throw new Error(json.error)`. That discards EVERYTHING else the handler
// sent. Send PO is the case that exposed it: 13_ answers a blocked document with a rich envelope —
// { stage:'document_generation', document_stage, document_generation:{ reason, missing[], configuration_required,
// … }, note } — and purchase-order-overview.js ALREADY has a branch that renders exactly that. But the branch
// tests `res.stage`, and `res` never arrives: the throw reduced the whole envelope to its one generic sentence,
// so the page fell to its `.catch()` and printed "Send PO failed: Send PO blocked — the required Purchase Order
// document could not be produced." That is precisely the symptom the user reported, and the cause is here, not
// in the backend and not in the document engine.
// Attaching the envelope keeps the existing throw-based contract (every caller still sees a rejection) while
// making the structured cause reachable. `.envelope` is the raw handler response; `.code` is its typed stage.
function _kmWriterError_(json, fallbackMessage) {
    var e = new Error((json && json.error) || fallbackMessage);
    e.envelope = json || null;
    e.code = (json && (json.document_stage || json.stage)) || '';
    return e;
}

// F1-7N-FB-3A §C — DEPLOYMENT CONTRACT. "The action is not in the deployed code" is its own failure class.
// --------------------------------------------------------------------------------------------------------
// THE LIVE DEFECT. The website reported `GAP_READ_ERROR — gap read failed` for the slim scope registry while
// the SAME handler ran successfully from the Apps Script editor. Those two facts are not in conflict, and
// together they name the cause exactly:
//   • the editor wrapper calls handleInventoryScopeRegistryGet_() DIRECTLY against the code currently SAVED,
//     so it proves the code is saved and the data is readable;
//   • the website calls the deployed /exec WEB APP, which serves whichever DEPLOYMENT VERSION was last
//     published. Saving a file does NOT republish it.
// A deployment that predates the action falls through the router to its terminal
// `{ success:false, error:'Invalid POST action. Supported: …' }`. That envelope carries NO `errors[]` array,
// so _kmGapRead_ hit its generic fallback and printed GAP_READ_ERROR — a read-failure label for what is
// actually a DEPLOYMENT IDENTITY problem. The same shape reaches _kmWeeklyCommand_ as BUSINESS_COMMAND_ERROR.
//
// Both are now classified as DEPLOYMENT_CONTRACT_MISMATCH and name the missing action, so the message says
// what to do instead of what failed. Note what this is NOT: it is not a retry, not a fallback data source,
// not a broad-loader substitute, and not a longer timeout. A stale deployment is a publish step, and the only
// honest thing the client can do is say so.
// F1-7N-FB-4E-R2 §5: 7 -> 8, RAISED, never lowered. This build requires
// system.executionPlanDuplicateLineDiagnostic, which no deployment below action contract 8 routes at all
// — R2 is the round that added the branch. Leaving the pin at 7 would let a v7 deployment pass the
// VERSION gate and then fail the per-action probe, reporting the same fact twice as two different-looking
// problems. Raising it makes the version comparison decide first, with the message that names the fix.
// F1-7N-FB-4E-R3 §C: 8 -> 9, RAISED. Overseas Inventory has been CUT OVER to overseasStock.workspace.get and
// has no fan-out left to fall back to, so a deployment below action contract 9 cannot render that page at all.
// The version gate must say so first, with the message that names the fix, rather than letting the page
// discover it as a failed read.
// F1-7N-FC-1A-R1 §L: 10 -> 11, RAISED, and this is the one raise in the series that protects stock rather
// than a read. FC-1A made Shipment Draft creation ACQUIRE a factory stock reservation. A deployment at
// contract 10 routes everything else normally but cannot route cancelShipmentDraft, so there is NO way to
// release a reservation before dispatch — units stay held by a draft nobody can cancel, availability
// drops permanently, and the only symptom is shipments refused for stock that is physically on the floor. The
// version gate must say so first, with the message that names the fix, rather than letting an operator find
// out by pressing Cancel.
var KM_EXPECTED_ACTION_CONTRACT_VERSION_ = 11;      // the minimum deployed_action_contract_version this build needs
var KM_EXPECTED_REGISTRY_PROJECTION_VERSION_ = 'FB-3.1';
// F1-7N-FB-4E §H — THE SHARED-TRANSPORT AXIS. Deliberately NOT folded into the action-contract number.
//
// `missing_actions=[]` cannot see any of the four faults §H requires to be distinguishable, and neither can the
// action contract alone. They are now four different codes with four different next actions:
//
//   API_ENDPOINT_CONFIGURATION_INVALID  the request never reached Apps Script — fix the /exec URL. Decided
//                                       LOCALLY, so it is reported without a network call at all.
//   TRANSPORT_CONTRACT_MISMATCH         it reached the deployment, but that deployment's ROUTER cannot state
//                                       which handler answered, so a method downgrade cannot be proved —
//                                       publish a deployment whose router carries the typed identity fields.
//   DEPLOYMENT_CONTRACT_MISMATCH        the deployment does not know an action this build calls — publish.
//   DEPLOYMENT_PARTIAL_SYNC             every action resolves but an owner FILE is a round behind — re-copy.
//
// Bump this when the frontend starts depending on new router response-identity fields.
var KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_ = 1;
// The router's terminal "I do not know this action" responses, on both verbs. Matching these is how a missing
// action is told apart from a genuine business rejection — a business handler never answers with them.
var KM_UNKNOWN_ACTION_PATTERNS_ = [
    /^Invalid POST action\b/i,
    /^Missing or invalid action parameter\b/i,
    /^Invalid action\b/i,
    /^Unsupported action\b/i
];
function _kmIsUnknownActionResponse_(errText) {
    var s = String(errText == null ? '' : errText).trim();
    for (var i = 0; i < KM_UNKNOWN_ACTION_PATTERNS_.length; i++) { if (KM_UNKNOWN_ACTION_PATTERNS_[i].test(s)) return true; }
    return false;
}
// The typed result. It deliberately does NOT echo the router's "Supported: …" list — that string is long,
// changes constantly and is exactly the stale artefact we are diagnosing; naming the action the caller asked
// for is the useful half.
function _kmDeploymentMismatchError_(action) {
    return {
        code: 'DEPLOYMENT_CONTRACT_MISMATCH',
        message: 'The deployed Apps Script Web App does not contain the action "' + action + '". The code may be saved ' +
            'in the editor without being published: create a NEW DEPLOYMENT VERSION, then reload. Nothing was read or written.',
        details: {
            command: action,
            missing_action: action,
            expected_action_contract_version: KM_EXPECTED_ACTION_CONTRACT_VERSION_,
            zero_write: true,
            retryable: false,          // retrying cannot publish a deployment
            next_action: 'Publish a new Apps Script deployment version containing this action, then reload the page.'
        }
    };
}
// Compare the frontend's pinned expectations against the deployment's own immutable identity block. Returns a
// verdict object; NEVER throws. This is the check that turns "the site behaves oddly" into one named fact.
// F1-7N-FB-4A ADDENDUM §H — the exact actions and symbols THIS frontend build needs. They are sent to
// system.health as an explicit probe list so the answer is computed against OUR expectation rather than against
// the deployment's own required-action list. A deployment that predates any of them reports it ABSENT; an empty
// self-referential missing_actions can never say that.
var KM_REQUIRED_DEPLOYED_ACTIONS_ = [
    'requestOrder.sendWorkset.get', 'requestOrder.send.orchestrate', 'requestOrder.send.status',
    'requestOrder.allocationDraft.ensureAndEdit', 'system.allocationDraftIdentityDiagnostic',
    'system.executionPlanConflictDiagnostic', 'system.requestOrderSendDiagnosticStatus',
    'shipment.eta.update', 'shipment.route.advance', 'upsertShippingAllocationDraft',
    // F1-7N-FC-1A SSXC/SSXJ — the Shipment Draft recovery action. Routed and handled for rounds; probed for the
    // first time now that a page depends on it.
    'createShipmentFromPlan',
    // F1-7N-FC-1A-R1 — the only routed way to release a reservation before dispatch.
    'cancelShipmentDraft',
    // F1-7N-FB-4C-R1 §D — the READ both SKU pages depend on. It was never probed, so a deployment missing it
    // could only be discovered by the pages failing, which is precisely how this round started.
    'skuDetails.workspace.get',
    // F1-7N-FB-4E-R3 §C — the Overseas Stock read. Probed from the round that introduces it: the page has been
    // cut over, so a deployment without this action cannot render Overseas Inventory at all, and that must be a
    // named deployment fact rather than a failed read the user has to interpret.
    'overseasStock.workspace.get',
    // F1-7N-FB-4D §E — the Site Inventory WRITE chain. Every step of Add Route -> save -> readback -> Submit
    // depends on these, and a deployment missing any one of them fails in a way that looks like a data problem.
    'upsertShippingAllocationDraftLines', 'getShippingAllocationDraftWorkspace',
    'submitAllocationDraftsToShippingPlans', 'system.executionPlanDuplicateLineDiagnostic',
    // F1-7N-FB-4G-A2-R3 §E.6 — the atomic writer is now the ONLY path that creates or edits a route ticket, and
    // the client fails closed rather than falling back to the two-call writer. A deployment without it cannot
    // save a route at all, so that must be a named deployment fact rather than a save that mysteriously refuses.
    'upsertShippingAllocationDraftAtomic'
];
// F1-7N-FB-4C-R1 §D — the actions each PAGE needs, so a mismatch can name the page rather than only the action.
// The probe is still one request; this is the mapping used to phrase the message.
var KM_PAGE_REQUIRED_ACTIONS_ = {
    'sku-details': ['skuDetails.workspace.get'],
    'sku-regional-details': ['skuDetails.workspace.get'],
    // F1-7N-FB-4D §E — Site Inventory is the page whose failure this round is closing, so it gets the same
    // page-scoped verdict: the four actions its Execution Plan -> Submit chain cannot work without.
    'site-inventory': ['upsertShippingAllocationDraft', 'upsertShippingAllocationDraftLines',
        'upsertShippingAllocationDraftAtomic',
        'getShippingAllocationDraftWorkspace', 'submitAllocationDraftsToShippingPlans'],
    // F1-7N-FC-1A §J.1 -- the Weekly Shipping Plan page. Approve is the transition that commits a human
    // decision AND attempts the Execution Commit, and createShipmentFromPlan is now the recovery path for the
    // half of that which can fail. A deployment that cannot serve either must disable both buttons rather than
    // let an operator approve into a state whose recovery action the deployment does not route.
    'weekly-shipping-plan': ['weeklyShipping.workspace.get', 'updateShippingPlanStatus',
        'createShipmentFromPlan', 'completeShippingPlan'],
    // F1-7N-FC-1A-R1 §L — the Shipment Draft page. It is the page that can cancel, and a cancellation
    // it cannot route would leave the reservation held while the operator believes it was released, so the
    // action is named here and the button is disabled on a mismatch rather than allowed to fail.
    'shipment-draft': ['shipment.workspace.get', 'cancelShipmentDraft', 'updateShipment',
        'confirmShipmentAndDispatch'],
    'shipment-overview': ['shipment.workspace.get', 'cancelShipmentDraft']
};
// Globals whose PRESENCE proves the file that owns them was actually copied into the deployment. This is what
// catches a half-finished, file-by-file Apps Script sync that still resolves every action.
var KM_REQUIRED_DEPLOYED_SYMBOLS_ = [
    'sadK2ReconcileDecision_',              // 16_ — the FB-4A Execution Plan identity correction
    'shipEtaDateOnly_',                     // 31_ — the FB-4A ETA date-only round-trip normalizer
    'shipWsDateOnly_',                      // 57_ — the FB-4A scoped-read date projection
    'rosResolveCurrentPlanningCycle_',      // 66_ — the addendum planning-cycle authority
    // F1-7N-FB-4G-A2-R4 §J — the diagnostic status action moved to its PERMANENT owner. Pinning the old
    // TEMP-file symbol made the browser's contract check fail the moment an operator did what a file named
    // TEMP invites: delete it. The page then refused to work at all — Search, hydrate and every save.
    'ROSEND_DIAG_OWNER_FILE_',              // 66_api_v1_request_order_send.gs — the permanent diagnostic owner
    // F1-7N-FB-4C-R1 §D — the OWNER SYMBOLS behind the two SKU read paths. An action can resolve while its
    // owning file is a round behind, which is the case a resolvable action list cannot see: these prove the
    // files themselves were copied.
    'skdWorkspaceBuild_',                   // 59_ — the SKU Details / SKU Regional read-model builder
    'skdBuildEnvelope_',                    // 59_ — the envelope that carries the echoed action + requestId
    // F1-7N-FB-4D §E — the FB-4D allocation-writer gate. The CLIENT now depends on this build: it binds line-id
    // adoption to the route_group_key that only this version of 16_ returns, and it expects a duplicate primary
    // key to be REFUSED before the write rather than reported after it. A 16_ one round behind answers every
    // action, returns no group key, and writes onto a corrupted table — which is the live failure. Probing the
    // symbol is the only way the site can tell the two apart.
    'sadScanDuplicateLinePks_',             // 16_ — the FB-4D pre-write duplicate-PK gate
    'SAD_BUILD_VERSION_',                   // 16_ — allocation handler owner build stamp
    'SP_BUILD_VERSION_',                    // 11_ — shipping plan Submit owner build stamp
    'RTR_BUILD_VERSION_',                   // 01_ — router build stamp
    'SKD_BUILD_VERSION_',                   // 59_ — SKU workspace owner build stamp
    // F1-7N-FB-4E §H — the SHARED-TRANSPORT owners. A router one round behind still answers every action; it
    // simply cannot say WHICH HANDLER answered, which is the fact the client's method-downgrade proof needs.
    // Probing the constant is the only way the site can tell "the deployment is fine" apart from "the
    // deployment cannot describe itself", and those have different fixes.
    'SYS_TRANSPORT_CONTRACT_VERSION_',      // 63_ — the transport-contract axis (separate from the action axis)
    // F1-7N-FC-1A §C/§E — OWNER SYMBOLS. An action list cannot see a file that is a round behind, and both of
    // these carry behaviour the page now BINDS to rather than merely calls:
    //   spApprovalRecoveryState_        11_ answers a failed Execution Commit with a typed recovery object.
    //                                   An 11_ one round behind still approves, still fails to create the
    //                                   shipment, and reports plain success -- the exact silence this round
    //                                   closes, and indistinguishable from a healthy deployment without this.
    //   factoryStockAcquireReservationTx_  21_ owns the persisted reservation. A 21_ one round behind makes
    //                                   every Shipment Draft creation throw on an undefined function, which
    //                                   would reach the operator as an unexplained Approve failure.
    'spApprovalRecoveryState_',
    'factoryStockAcquireReservationTx_',
    // The three OWNER BUILD STAMPS of the reservation model. The symbols above prove 11_ and 21_ carry the new
    // functions; these prove 12_ and 22_ were copied too — and 12_ and 22_ are the two that return
    // SUCCESS while behaving wrongly when they are a round behind, which is why a resolvable action list can
    // never catch them and a declared build is the only thing that can.
    'SHIPMENT_BUILD_VERSION_',
    'CSD_BUILD_VERSION_',
    'FSTX_BUILD_VERSION_',
    // F1-7N-FC-1A-R1 — the cancellation handler itself and the canonical movement vocabulary. The
    // action probe proves the ROUTER knows `cancelShipmentDraft`; these prove 12_ and 21_ actually carry the
    // handler and the seven-type set behind it, which an action list cannot see.
    'handleCancelShipmentDraft_',
    'FSTX_MOVEMENT_TYPES_',
    'PROC_BUILD_VERSION_',
    // F1-7N-FB-4E-R3 §C — the Overseas workspace OWNER FILE. The action resolving is not enough: a deployment
    // carrying the R3 router but not 70_ would route to an undefined handler, and this page has no fan-out left
    // to fall back to. Probing the owner symbol is the only way the site can tell those two apart.
    'OSW_BUILD_VERSION_',                   // 70_ — the Overseas Stock scoped read owner
    // F1-7N-FB-4E-R4B-R3 §1/§5 — THE OWNERS R4B ADDED, PROBED BY THE CALLER THAT DEPENDS ON THEM.
    // 90_ is GENERATED and self-identifies by CONTENT (KM_BUNDLE_INFO.bundleHash), so pinning a hash in 63_
    // would create a second source of truth that has to move on every rebuild. Probing the symbols instead is
    // derived rather than pinned: a deployment whose bundle predates R4B-R1 has no KMFSA, and says so.
    'KM_BUNDLE_INFO',                       // 90_ — the generated bundle's own content manifest
    'KMFSA',                                // 90_ — the canonical factory site-allocation projection (R4B-R1)
    'RECGEN_BUILD_VERSION_',                // 47_ — recommendation generation + bounded multi-scope readback
    'APL_BUILD_VERSION_'                    // 56_ — AI Plan first layer (reads KMFSA)
];
// A masked, read-only classification of the endpoint this build would actually use. It is part of the
// deployment verdict because "the site behaves oddly" has an answer that needs no network at all when the
// configured URL is a /dev URL, an editor URL, an expired redirect target or the website's own origin.
window.KM.DB.getEndpointClassification = function () {
    var tf = _kmTransportFactory_();
    var raw = (typeof window.KM.DB.getApiBaseUrl === 'function' && window.KM.DB.getApiBaseUrl()) || '';
    if (!tf || typeof tf.classifyEndpoint !== 'function') {
        return { ok: !!raw, endpointClass: raw ? 'UNCLASSIFIED' : 'BLANK', maskedEndpoint: '', reason: 'the shared transport authority is not loaded' };
    }
    var fo = '';
    try { fo = (window.location && window.location.origin) ? String(window.location.origin) : ''; } catch (e) { fo = ''; }
    var c = tf.classifyEndpoint(raw, { frontendOrigin: fo });
    return { ok: c.ok, endpointClass: c.endpointClass, maskedEndpoint: c.maskedEndpoint, reason: c.reason || null };
};
window.KM.DB.checkDeploymentContract = async function () {
    // F1-7N-FB-4E §B6/§H — REFUSE LOCALLY FIRST. A wrong endpoint is knowable without the network, and
    // reporting it as a health failure (which is what happened before) makes an unreachable URL look like an
    // unhealthy deployment. These are different faults with different fixes, so they get different answers.
    var _ep = window.KM.DB.getEndpointClassification();
    if (_ep.ok === false) {
        return { ok: false, code: 'API_ENDPOINT_CONFIGURATION_INVALID', identity: null, endpoint: _ep,
            message: 'The configured API endpoint is not the stable Apps Script Web App /exec URL, so no request was sent. '
                + (_ep.reason || '') + ' Correct the endpoint; retrying cannot change the configuration.' };
    }
    var res = await _kmGapRead_('system.health', {
        probe_actions: KM_REQUIRED_DEPLOYED_ACTIONS_, probe_symbols: KM_REQUIRED_DEPLOYED_SYMBOLS_ });
    if (!res || res.success === false) {
        return { ok: false, code: (res && res.error && res.error.code) || 'HEALTH_UNAVAILABLE',
            message: (res && res.error && res.error.message) || 'system.health did not answer.', identity: null };
    }
    // F1-7N-FB-4E-R1 §1 — READ THE IDENTITY FROM WHERE THE DEPLOYMENT ACTUALLY PUTS IT.
    //
    // THE BUG THIS REPLACES. This line read `res.data`. `handleSystemHealth_` (63_) answers through
    // `jsonResponse_(payload)`, which serializes the payload VERBATIM — so build_id, contract_version,
    // transport_contract_version, router_build, deployed_action_contract_version, required_action_list_version,
    // handler and caller_probe are all TOP-LEVEL keys and the answer has NO `data` key at all. The runner above
    // returned `json.data || { rows: [] }`, so `res.data` was `{ rows: [] }`, every field below read `undefined`
    // and normalized to null, and the function reported DEPLOYMENT_CONTRACT_MISMATCH with an ALL-NULL identity
    // and an empty missing_actions.
    //
    // That verdict was UNFALSIFIABLE. It did not depend on the deployment at all: no published version, however
    // current, could ever satisfy it, and the message it printed — "the deployed Apps Script does not report an
    // action-contract version, so it is older than this frontend build" — told the operator to publish again,
    // which could never change the answer. A gate that cannot pass is worse than no gate: it sends people to
    // fix a deployment that was already correct.
    //
    // This is a CLIENT defect end to end. Nothing in the Apps Script project had to change to fix it.
    var h = res.envelope || res.data || {};
    var identity = {
        build_id: h.build_id || h.build_version || null,
        contract_version: h.contract_version || h.api_contract_version || null,
        deployed_action_contract_version: (h.deployed_action_contract_version == null) ? null : Number(h.deployed_action_contract_version),
        // F1-7N-FB-4E §H — the transport axis and the router's own build, so a router that cannot name its own
        // handler is a NAMED fault rather than an unexplained gap in the method-downgrade proof.
        transport_contract_version: (h.transport_contract_version == null) ? null : Number(h.transport_contract_version),
        router_build: h.router_build || null,
        // R6-R6 §4 — the release and the module builds are DIFFERENT facts, and reading one string for both
        // is how a deployed R6-R5 was read as an undeployed one. Each is carried under its own name; a null
        // means the answering deployment predates the field, never that the module is absent.
        deployment_release: h.deployment_release || h.build_id || h.build_version || null,
        system_health_module_build: h.system_health_module_build || null,
        workspace_module_build: h.workspace_module_build || null,
        router_response_identity: h.router_response_identity || null,
        answered_by_handler: h.handler || null,
        inventory_registry_projection_version: h.inventory_registry_projection_version || null,
        required_action_list_version: (h.required_action_list_version == null) ? null : Number(h.required_action_list_version),
        missing_actions: h.missing_actions || [],
        // FB-4A addendum §H — the non-self-referential evidence.
        mixed_deployment: (h.mixed_deployment == null) ? null : !!h.mixed_deployment,
        deployment_uniformity_verdict: h.deployment_uniformity_verdict || null,
        module_build_stamps: (h.module_build_stamps && h.module_build_stamps.modules) || [],
        stale_modules: (h.module_build_stamps && h.module_build_stamps.stale_modules) || [],
        absent_modules: (h.module_build_stamps && h.module_build_stamps.absent_modules) || [],
        caller_probe: h.caller_probe || null,
        request_order_send_diagnostic_owner: h.request_order_send_diagnostic_owner || null
    };
    // F1-7N-FC-1B-E3-R4-A2-R1 §7 — PUBLISH THE DEPLOYMENT IDENTITY THE MOMENT IT IS KNOWN.
    // Anything cached that describes a specific backend build — the capability snapshot above all — needs
    // something to compare itself against, and until now there was nothing: a snapshot could outlive the
    // deployment it described with no way for a reader to tell. This is the one place the identity is
    // established, so it is the one place it is published.
    try { window.__kmDeploymentIdentity = { build_id: identity.build_id || null,
        deployed_action_contract_version: identity.deployed_action_contract_version == null ? null : identity.deployed_action_contract_version,
        transport_contract_version: identity.transport_contract_version == null ? null : identity.transport_contract_version,
        router_build: identity.router_build || null, at: Date.now() }; } catch (eDi) {}
    // A deployment that predates the identity block cannot report its own action contract — which is itself
    // conclusive evidence that it is older than this frontend.
    if (identity.deployed_action_contract_version == null) {
        return { ok: false, code: 'DEPLOYMENT_CONTRACT_MISMATCH', identity: identity, endpoint: _ep,
            message: 'The deployed Apps Script does not report an action-contract version, so it is older than this ' +
                'frontend build. Publish a new deployment version.' };
    }
    if (identity.deployed_action_contract_version < KM_EXPECTED_ACTION_CONTRACT_VERSION_) {
        return { ok: false, code: 'DEPLOYMENT_CONTRACT_MISMATCH', identity: identity, endpoint: _ep,
            message: 'The deployed Apps Script action contract is v' + identity.deployed_action_contract_version +
                ' but this frontend needs v' + KM_EXPECTED_ACTION_CONTRACT_VERSION_ + '. Publish a new deployment version.' };
    }
    // F1-7N-FB-4E §H — the transport axis, checked SEPARATELY and named separately. A deployment can satisfy
    // every action and still be unable to say which handler answered, which is precisely the condition that
    // leaves a method downgrade unprovable — so it must not be reported as a healthy deployment.
    if (identity.transport_contract_version == null || identity.transport_contract_version < KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_) {
        return { ok: false, code: 'TRANSPORT_CONTRACT_MISMATCH', identity: identity, endpoint: _ep,
            message: 'The deployed Apps Script reports transport contract '
                + (identity.transport_contract_version == null ? 'NONE' : ('v' + identity.transport_contract_version))
                + ' but this frontend needs v' + KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_ + '. Its router cannot state which handler '
                + 'answered a request, so a POST answered by the GET handler cannot be proved. Publish a NEW deployment '
                + 'version (router build ' + (identity.router_build || 'unknown') + ').' };
    }
    // FB-4A addendum §H — a deployment that does not answer our explicit probe is older than the probe itself,
    // which is conclusive on its own. Checked BEFORE the per-item verdict so a silent old build cannot pass.
    if (!identity.caller_probe) {
        return { ok: false, code: 'DEPLOYMENT_CONTRACT_MISMATCH', identity: identity, endpoint: _ep,
            message: 'The deployed Apps Script did not answer the explicit action/symbol probe, so it predates this ' +
                'frontend build. Re-copy the Apps Script files and publish a NEW deployment version.' };
    }
    if (identity.caller_probe.all_present === false) {
        var miss = (identity.caller_probe.missing_actions || []).concat(identity.caller_probe.missing_symbols || []);
        return { ok: false, code: 'DEPLOYMENT_CONTRACT_MISMATCH', identity: identity, endpoint: _ep,
            message: 'The deployment is missing ' + miss.length + ' item(s) this frontend needs: ' + miss.join(', ') +
                '. Re-copy the owning Apps Script files and publish a NEW deployment version.' };
    }
    // A MIXED sync still resolves every action, so it must be reported on its own evidence: each owner file's
    // compiled build constant. This is the case the live report suspected and nothing previously could name.
    if (identity.mixed_deployment === true) {
        var bad = (identity.stale_modules || []).concat(identity.absent_modules || []);
        return { ok: false, code: 'DEPLOYMENT_PARTIAL_SYNC', identity: identity, endpoint: _ep,
            message: 'The Apps Script project is only PARTIALLY synchronized: ' + bad.join(', ') +
                ' (deployment build ' + identity.build_id + '). Re-copy those files and publish a NEW deployment version.' };
    }
    return { ok: true, code: 'DEPLOYMENT_CONTRACT_OK', identity: identity, endpoint: _ep, message: '' };
};
// The read-only Request Order Send diagnostic ownership + cycle-resolution report (addendum §G), reachable from
// the website so the operator never has to open the Apps Script editor to answer "which file owns this?".
window.KM.DB.getRequestOrderSendDiagnosticStatus = function (payload) { return _kmGapRead_('system.requestOrderSendDiagnosticStatus', payload || {}); };
// F1-7N-FB-4C-R1 §D — PAGE-SCOPED DEPLOYMENT VERDICT. A page mount asks "is the deployment able to serve MY
// read?" and gets a typed answer naming the required action, the missing action or owner symbol, both builds, the
// contract version and the request id. It reuses the ONE caller-driven probe above (no second request shape) and
// deliberately does NOT auto-retry: a stale deployment is a publish step, and retrying cannot publish anything.
window.KM.DB.checkPageDeploymentContract = async function (pageKey) {
    var required = KM_PAGE_REQUIRED_ACTIONS_[String(pageKey || '')] || [];
    var v = await window.KM.DB.checkDeploymentContract();
    var id = v && v.identity;
    var probe = id && id.caller_probe;
    var missing = [];
    if (probe) {
        var miss = (probe.missing_actions || []).concat(probe.missing_symbols || []);
        missing = miss.filter(function (m) { return required.indexOf(m) !== -1 || String(m).indexOf('skd') === 0; });
    }
    if (v && v.ok && !missing.length) {
        return { ok: true, code: 'DEPLOYMENT_CONTRACT_OK', page: pageKey, required_actions: required };
    }
    return {
        ok: false,
        code: 'DEPLOYMENT_CONTRACT_MISMATCH',
        page: pageKey,
        required_actions: required,
        missing: missing.length ? missing : ((probe && (probe.missing_actions || []).concat(probe.missing_symbols || [])) || []),
        frontend_build: KM_EXPECTED_ACTION_CONTRACT_VERSION_,
        backend_build: (id && (id.build_id || null)),
        contract_version: (id && id.deployed_action_contract_version) || null,
        expected_contract_version: KM_EXPECTED_ACTION_CONTRACT_VERSION_,
        request_id: (id && id.request_id) || null,
        retryable: false,
        message: (v && v.message) || 'The deployed Apps Script cannot serve this page\u2019s read contract.',
        next_action: 'Publish a NEW Apps Script deployment version, then hard-reload this page. Retrying the read cannot publish a deployment.'
    };
};
window.KM.DB.getPageRequiredActions = function (pageKey) { return (KM_PAGE_REQUIRED_ACTIONS_[String(pageKey || '')] || []).slice(); };
// ============================================================================================================
// F1-7N-FB-4E §E — READ-ONLY PERFORMANCE + REQUEST-COUNT DIAGNOSTIC.
// ------------------------------------------------------------------------------------------------------------
// "Pages feel materially slower than before" is not actionable, and neither is a guess about why. This reports
// MEASURED numbers for the representative page reads, per phase, with the request COUNTS beside them — because
// the dominant cost in this system has repeatedly turned out to be the number of round trips rather than the
// duration of any one of them, and a count is the one thing a comment can never fake.
//
// STRICTLY READ-ONLY and non-sensitive: durations, counts, byte totals and masked endpoint identities. No row
// content, no table content, no URL beyond the mask, no id. It issues NO requests of its own — it reports what
// the session has already done, so calling the diagnostic can never change what it measures.
//
// The ACCEPTANCE TARGETS are recorded here as data so a live run is compared against a written number rather
// than an impression, and so a missed target names its own dominant phase.
// ============================================================================================================
var KM_PERF_TARGETS_ = {
    metadata_cold: { p50_ms: 1500, p95_ms: 4000, what: 'registry / capabilities / health — a session-stable read' },
    workspace_scoped: { p50_ms: 3000, p95_ms: 8000, what: 'one scoped business workspace read after Search' },
    cache_hit: { requests: 0, what: 'a shared registry that is already READY must cost ZERO requests' }
};
// The eight representative reads §E names, with the action each one actually issues. Kept as data so the
// diagnostic and the live runbook cannot describe different things.
var KM_PERF_SURFACES_ = [
    { surface: 'Site Inventory registry', action: 'inventoryScope.registry.get', klass: 'metadata_cold' },
    { surface: 'Site Inventory workspace (after Search)', action: 'inventoryReplenishment.workspace.get', klass: 'workspace_scoped' },
    { surface: 'Order Planning workspace', action: 'aiPlanFirstLayer.get', klass: 'workspace_scoped' },
    { surface: 'Factory Inventory', action: 'getTable', klass: 'workspace_scoped' },
    { surface: 'Overseas Inventory', action: 'getTable', klass: 'workspace_scoped' },
    { surface: 'FC Summary', action: 'weeklyShipping.workspace.get', klass: 'workspace_scoped' },
    { surface: 'Shipment Draft', action: 'shipment.workspace.get', klass: 'workspace_scoped' },
    { surface: 'SKU Details', action: 'skuDetails.workspace.get', klass: 'workspace_scoped' }
];
window.KM.DB.getPerformanceTargets = function () { return JSON.parse(JSON.stringify(KM_PERF_TARGETS_)); };
window.KM.DB.getPerformanceSurfaces = function () { return JSON.parse(JSON.stringify(KM_PERF_SURFACES_)); };
function _kmPercentile_(sorted, q) {
    if (!sorted.length) return null;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
}
window.__kmTransportReport = function () {
    var tp = null;
    try { tp = (window.KM && window.KM.transport) || null; } catch (e) { tp = null; }
    var m = (tp && typeof tp.metrics === 'function') ? tp.metrics() : { requests: 0, retries: 0, byAction: {}, byCode: {}, samples: [] };
    var perAction = {};
    (m.samples || []).forEach(function (sm) {
        var k = sm.action || '(unknown)';
        var a = perAction[k] || (perAction[k] = { requests: 0, failures: 0, bytes: 0, durations: [] });
        a.requests += 1;
        if (sm.code) a.failures += 1;
        a.bytes += Number(sm.bytes) || 0;
        if (typeof sm.ms === 'number') a.durations.push(sm.ms);
    });
    var rows = KM_PERF_SURFACES_.map(function (sf) {
        var a = perAction[sf.action];
        var d = a ? a.durations.slice().sort(function (x, y) { return x - y; }) : [];
        var t = KM_PERF_TARGETS_[sf.klass] || {};
        var p50 = _kmPercentile_(d, 0.5), p95 = _kmPercentile_(d, 0.95);
        return {
            surface: sf.surface, action: sf.action, target_class: sf.klass,
            requests: a ? a.requests : 0, failures: a ? a.failures : 0,
            response_bytes_total: a ? a.bytes : 0,
            p50_ms: p50, p95_ms: p95,
            target_p50_ms: t.p50_ms || null, target_p95_ms: t.p95_ms || null,
            within_p50: (p50 == null || !t.p50_ms) ? null : (p50 <= t.p50_ms),
            within_p95: (p95 == null || !t.p95_ms) ? null : (p95 <= t.p95_ms),
            measured: !!a
        };
    });
    var reg = null;
    try {
        if (window.KM && window.KM.scopeRegistry && typeof window.KM.scopeRegistry.requestCount === 'function') {
            reg = { registry_requests_this_session: window.KM.scopeRegistry.requestCount(),
                registry_status: window.KM.scopeRegistry.getState().status };
        }
    } catch (e2) { reg = null; }
    return {
        transport_build: m.transport_build || null,
        transport_contract_version: m.transport_contract_version || null,
        endpoint: window.KM.DB.getEndpointClassification(),
        totals: { requests: m.requests, retries: m.retries, by_code: m.byCode },
        scoped_read_concurrency: window.KM.DB.getScopedReadConcurrency(),
        shared_registry: reg,
        surfaces: rows,
        targets: KM_PERF_TARGETS_,
        // Named so nobody reads this as a live measurement it is not: it reports THIS SESSION only, and a
        // surface with `measured:false` has simply not been exercised yet.
        note: 'read-only; reports only what this browser session already issued; no request is made by this call'
    };
};
window.KM.DB.getExpectedContract = function () {
    return { action_contract_version: KM_EXPECTED_ACTION_CONTRACT_VERSION_,
        registry_projection_version: KM_EXPECTED_REGISTRY_PROJECTION_VERSION_,
        // F1-7N-FB-4E §H — both axes, so the website can prove its own expectation as well as the deployment's.
        transport_contract_version: KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_,
        frontend_transport_build: (function () { var tf = _kmTransportFactory_(); return (tf && tf.TRANSPORT_BUILD) || null; })() };
};

// ---- Weekly command reliability (Round C1) ----------------------------------------------------------
// ONE canonical command runner for the Weekly mutations. It fixes WRITE_SUCCEEDED_BUT_ACK_FAILED by
// DECOUPLING the acknowledgement from the readback: the command result is determined ONLY by the handler
// response, and the post-write readback is the PAGE's single responsibility (never coupled here, so a slow/
// failed reload can no longer flip a committed write into a displayed failure). Responses are read TEXT-FIRST
// and classified distinctly (HTTP_TRANSPORT_ERROR / NON_JSON_RESPONSE / BUSINESS_COMMAND_ERROR); a
// "cannot submit / already / not in state" business error maps to the idempotent-benign ALREADY_IN_TARGET_STATE.
// Returns a canonical { success, data, error } result and NEVER throws — callers check result.success.
var KM_ALREADY_IN_TARGET_PATTERNS = [
    /already/i, /cannot\s+(submit|approve|reject|cancel|complete)/i, /not\s+(a\s+)?(draft|pending|approved)/i,
    /must\s+be\s+(a\s+)?(draft|pending|approved)/i, /invalid\s+(status|transition)/i, /pending_approval/i,
    /no\s+longer/i, /current\s+status/i
];
function _kmClassifyBusinessError_(msg) {
    var s = String(msg == null ? '' : msg);
    for (var i = 0; i < KM_ALREADY_IN_TARGET_PATTERNS.length; i++) { if (KM_ALREADY_IN_TARGET_PATTERNS[i].test(s)) return 'ALREADY_IN_TARGET_STATE'; }
    return 'BUSINESS_COMMAND_ERROR';
}
// C2-D2A-UI: canonical business codes some handlers emit as the LEADING token of the error string
// (allocation-draft workflow). When present, surface the exact code so the UI maps state by code, never by
// parsing the message (§12). Weekly command errors do not start with these tokens, so C1 classification is unchanged.
// F1-7N-FB-2A §C/§E — this list was INCOMPLETE, and that is why the production Execution Plan failure showed
// as a bare `BUSINESS_COMMAND_ERROR`: any handler reason NOT listed here falls through to
// _kmClassifyBusinessError_, whose fallback IS that generic label. The allocation-draft handler emits several
// typed reasons that were missing, each of them a LEADING token of the error string exactly like the others:
//   • ROUTE_INCOMPLETE_NEW_DRAFT / LEGACY_ROUTE_RECONCILIATION_REQUIRED — sadResolveActiveDraftK2OrK3_ BLOCK
//   • K2_ROUTE_RECONCILIATION_REQUIRED — sadLegacyReconcileReason_ on a K2 identity mismatch
//   • PRODUCTION_SAFETY:<token> — thrown by the VALIDATE-ONLY prodRequireSheet_/prodRequireColumns_ gate
//     (SCHEMA_NOT_PROVISIONED / HEADER_MISSING / HEADER_ORDER_MISMATCH / MISSING_REQUIRED_HEADER /
//     WRONG_SPREADSHEET_TARGET …) and surfaced through the router's top-level catch as err.message. This one
//     is the most consequential to name: it means the write was refused BEFORE touching a cell, so it is a
//     provable zero-write, and it will never succeed on retry until the schema is reconciled.
// Naming them changes nothing about the backend contract; it stops the browser from discarding the reason.
var KM_CANONICAL_CODES = ['BLOCKED_CONFLICT', 'MULTIPLE_ROUTE_CONTEXTS_UNSUPPORTED_PHASE1', 'PLAN_HEADER_INCOMPLETE',
    'PLAN_LINE_INCOMPLETE', 'NO_ACTIVE_DRAFT', 'VERSION_CONFLICT', 'IMMUTABLE_TERMINAL_STATUS', 'SOURCE_AVAILABLE_QTY_EXCEEDED',
    'ROUTE_INCOMPLETE_NEW_DRAFT', 'LEGACY_ROUTE_RECONCILIATION_REQUIRED', 'K2_ROUTE_RECONCILIATION_REQUIRED',
    // F1-7N-FB-4B — identity/idempotency refusals the writer names. Each is a PROVEN zero-write except
    // LINE_OUTPUT_VERIFICATION_FAILED, which reports a write that WAS applied but did not verify.
    'DUPLICATE_LINE_IDENTITY_IN_BATCH', 'LINE_IDENTITY_CONFLICT', 'LINE_PRIMARY_KEY_ALREADY_EXISTS',
    'LINE_OUTPUT_VERIFICATION_FAILED',
    // F1-7N-FB-4B-ADDENDUM — multi-route group pre-flight refusals (client-side, zero-write by construction).
    'ROUTE_IDENTITY_NOT_PERSISTABLE', 'ROUTE_QUANTITY_CONFLICT', 'ROUTE_GROUP_PARTIAL_FAILURE',
    // F1-7N-FB-4G-A2-R3-R1 §D — the route-ticket refusals. These are the fallback for a handler answering with
    // a bare string; _kmTopLevelCode_ reads the handler's own `code` field first and needs no list at all.
    // Each of these is a PROVEN zero-write named by the server before it touched a cell.
    'ROUTE_INTENT_REQUIRED', 'ROUTE_INTENT_CONTRADICTORY', 'ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED',
    'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE', 'ROUTE_IDENTITY_MINT_FAILED', 'ROUTE_IDENTITY_CONTRACT_NOT_LOADED',
    'ALLOCATION_DRAFT_NOT_FOUND', 'ALLOCATION_DRAFT_SCHEMA_COLUMN_ABSENT', 'APPLIED_SCOPE_MISMATCH',
    'STALE_OPTIMISTIC_TOKEN', 'MIXED_SITE_PAYLOAD', 'LOCK_ERROR',
    'ROUTE_DESTINATION_MISSING', 'ROUTE_DESTINATION_AMBIGUOUS', 'ROUTE_DESTINATION_UNRESOLVED'];
// F1-7N-FB-4G-A2-R3-R1 §D — the handler's OWN typed code, when it published one. Accepted only in the
// canonical SCREAMING_SNAKE shape (optionally PREFIX:TOKEN) so a handler that happens to put a sentence or an
// id in `code` cannot be mistaken for a classification.
function _kmTopLevelCode_(json) {
    var c = String((json && json.code) == null ? '' : json.code).trim();
    if (!c) return '';
    return /^[A-Z][A-Z0-9_]*(:[A-Z][A-Z0-9_]*)?$/.test(c) ? c : '';
}
function _kmExtractCanonicalCode_(msg) {
    var s = String(msg == null ? '' : msg).trim();
    // A production-safety schema refusal carries its own token; return it WITH the token so the UI can tell
    // "the tab is missing" apart from "the header order drifted" without parsing prose.
    var ps = s.match(/^PRODUCTION_SAFETY:([A-Z_]+)/);
    if (ps) return 'PRODUCTION_SAFETY:' + ps[1];
    for (var i = 0; i < KM_CANONICAL_CODES.length; i++) { if (s.indexOf(KM_CANONICAL_CODES[i]) === 0) return KM_CANONICAL_CODES[i]; }
    return '';
}
// A refusal by the validate-only schema gate, a documented pre-write gate, or an unavailable lock proves that
// ZERO rows were written. Exposed so the page can state zero-write truthfully instead of guessing.
function _kmZeroWriteProven_(msg) {
    var s = String(msg == null ? '' : msg);
    return /^PRODUCTION_SAFETY:/.test(s.trim()) || /zero rows written/i.test(s) || /could not acquire lock/i.test(s);
}
function _kmCmdOk_(command, data) { return { success: true, data: Object.assign({ command: command, committed: true }, data || {}), error: null }; }
function _kmCmdErr_(command, code, message, details) {
    return { success: false, data: null, error: { code: code || 'BUSINESS_COMMAND_ERROR', message: String(message == null ? code : message), details: (details == null ? { command: command } : Object.assign({ command: command }, details)) } };
}
async function _kmWeeklyCommand_(command, payload) {
    if (!isOperationDbApiConfigured()) return _kmCmdErr_(command, 'TRANSPORT_NOT_CONFIGURED', 'Operation DB API not configured');
    var url = (window.KM && window.KM.DB && typeof window.KM.DB.getApiBaseUrl === 'function' && window.KM.DB.getApiBaseUrl()) || OP_DB_API_BASE_URL;
    var resp;
    var _tw0 = Date.now();
    // §5 — the shape and the id are computed BEFORE dispatch, so a request that never comes back is still
    // reported as a request that was SENT. That is the case the incident turned on.
    //
    // Resolved defensively, and for a reason this file has been bitten by before: this runs OUTSIDE the
    // try/catch below, so a helper that is not in scope would throw ahead of the fetch and turn a REPORTING
    // gap into a FAILED SAVE. An observation that can cancel the thing it observes is not an observation.
    var _wshape = {};
    try {
        if (typeof _kmMutationShape_ === 'function') _wshape = _kmMutationShape_(command, payload);
        if (typeof _kmNextWriteRequestId_ === 'function') _wshape.request_id = _kmNextWriteRequestId_();
    } catch (eShape) { _wshape = {}; }
    function _wOut(outcome) {
        try { return (typeof _kmWithOutcome_ === 'function') ? _kmWithOutcome_(_wshape, outcome) : null; }
        catch (eOut) { return null; }
    }
    try {
        // F1-7N-FB-3 §D — bounded. An expired WRITE is INDETERMINATE, never "nothing was written": the server
        // may have committed after we stopped listening, so it is reported as such and never auto-retried.
        resp = await _kmFetchBounded_(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(Object.assign({ action: command }, payload || {})) }, 'write');
    } catch (netErr) {
        if (netErr && netErr.kmTimeout) {
            var te = _kmTimeoutError_(command, 'write', netErr.timeoutMs);
            // §5 — A WRITE THAT TIMED OUT IS THE MOST IMPORTANT ROW IN THE TIMELINE, and it used to be the one
            // row that never got there: this path returned before the reporter was ever reached. An
            // unacknowledged write is exactly what ACK_UNKNOWN is about, so it is recorded as such.
            try { _kmReportSample_(command, 'write', _tw0, te.code, 'TIMEOUT', 0,
                _wOut('ACK_UNKNOWN')); } catch (e) {}
            return _kmCmdErr_(command, te.code, te.message, te.details);
        }
        // Network/redirect failure with NO acknowledged response → transport error (not an ack of a commit).
        // §D — how long the browser waited, and that nothing came back at all, are the two facts that separate
        // "the network dropped" from "the server was still working". Both were previously discarded.
        try { _kmReportSample_(command, 'write', _tw0, 'HTTP_TRANSPORT_ERROR', 'DISPATCH', 0,
            _wOut('ACK_UNKNOWN')); } catch (e) {}
        return _kmCmdErr_(command, 'HTTP_TRANSPORT_ERROR', 'Network error: ' + (netErr && netErr.message ? netErr.message : netErr),
            { command: command, elapsed_ms: Date.now() - _tw0, http_status: null, raw_present: false,
              response_is_json: false, timeout_ms: _kmTimeoutMs_('write') });
    }
    var text = '';
    try { text = await resp.text(); } catch (e) { text = ''; }
    // F1-7N-FB-4E §A — the same single classification for the write path. The legacy code and message shape are
    // unchanged (the write barriers and the INDETERMINATE set key on them); the typed evidence rides alongside.
    var _wcls = _kmClassifyAnswer_(command, 'write', resp, text, url);
    try { if (typeof _kmReportSample_ === 'function') _kmReportSample_(command, 'write', _tw0, _wcls.ok ? null : _wcls.typed.code, _wcls.ok ? 'SUCCESS' : _wcls.typed.phase, String(text || '').length,
        _wOut(_wcls.ok ? 'ANSWERED' : 'REFUSED')); } catch (e) {}
    if (!_wcls.ok) {
        return _kmCmdErr_(command, _wcls.legacyCode,
            _wcls.legacyCode === 'HTTP_TRANSPORT_ERROR' ? 'API HTTP ' + resp.status : 'Non-JSON response from Web App',
            Object.assign({ httpStatus: resp.status, transport: Object.assign({}, _wcls.typed, _wcls.wire) }, _wcls.wire));
    }
    var trimmed = String(text || '').trim();
    var json; try { json = JSON.parse(trimmed); } catch (pe) { return _kmCmdErr_(command, 'NON_JSON_RESPONSE', 'Malformed JSON response', { snippet: trimmed.slice(0, 80) }); }
    if (!json.success) {
        // R4J-LIVE7 §0/§3 — the gap-job family (START / CANCEL) returns a STRUCTURED envelope from gapBatchEnvelope_
        // ({ errors:[{ code, message, details }] }), while legacy handlers return a singular { error } string. Prefer
        // the structured code/message when present so a named START failure (CONTINUATION_SCHEDULE_FAILED /
        // GAP_JOB_LOCK_UNAVAILABLE / CALCULATION_CONTEXT_INVALID / GAP_JOB_START_ERROR …) is surfaced VERBATIM instead
        // of being flattened to a generic BUSINESS_COMMAND_ERROR. Falls back to the legacy path when there is no
        // errors[] (non-gap handlers), so their classification is unchanged.
        // F1-7N-FB-3A §C — classify a missing DEPLOYED action before the business classifier can flatten it
        // into BUSINESS_COMMAND_ERROR. A business handler never answers with the router's unknown-action text.
        if (!(json.errors && json.errors[0]) && _kmIsUnknownActionResponse_(json.error)) {
            var _dm = _kmDeploymentMismatchError_(command);
            return _kmCmdErr_(command, _dm.code, _dm.message, _dm.details);
        }
        var _structured = (json.errors && json.errors[0]) ? json.errors[0] : null;
        var _emsg = _structured ? (_structured.message || _structured.code) : json.error;
        // F1-7N-FB-4G-A2-R3-R1 §D/§F3 — READ THE HANDLER'S OWN CODE FIRST.
        //
        // This classified by prefix-matching the error PROSE against a hand-maintained list, and every handler
        // reason absent from that list became the generic `BUSINESS_COMMAND_ERROR`. Measured against the codes
        // 16_ actually emits: 38 of 41 were flattened — including every refusal A2-R3 introduced
        // (ROUTE_INTENT_REQUIRED, ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE, APPLIED_SCOPE_MISMATCH,
        // STALE_OPTIMISTIC_TOKEN …). That is why the production Execution Plan failure said nothing more than
        // "BUSINESS_COMMAND_ERROR" while the server had named its reason precisely. The handlers already put
        // that reason in a top-level `code` field; nothing read it. The list stays as the fallback for the
        // older handlers that still answer with a bare string.
        var _ecode = (_structured && _structured.code) || _kmTopLevelCode_(json) ||
            _kmExtractCanonicalCode_(json.error) || _kmClassifyBusinessError_(json.error);
        // Preserve the handler's structured data (e.g. conflictIds / stage detail) into error.details for the UI.
        // F1-7N-FB-2A §E — also carry the handler's own `stage` and the PROVEN zero-write fact, so the page can
        // state "nothing was written" only when the server's own reason establishes it.
        var _det = (_structured && _structured.details) || ((json.data && typeof json.data === 'object') ? json.data : null) || {};
        if (json.stage != null && _det.stage == null) _det.stage = String(json.stage);
        if (_det.zero_write == null && _kmZeroWriteProven_(_emsg)) _det.zero_write = true;
        // F1-7N-FB-4G-A2-R3-R1 §D — the evidence a failure has to be diagnosable from. None of this was kept,
        // so a production failure could be reported only as its generic label with no way to tell a business
        // refusal from a slow lock from a dead transport. It is recorded on every failing answer.
        if (_det.http_status == null) _det.http_status = resp.status;
        if (_det.elapsed_ms == null) _det.elapsed_ms = Date.now() - _tw0;
        if (_det.raw_present == null) _det.raw_present = String(text || '').length > 0;
        if (_det.response_is_json == null) _det.response_is_json = true;
        if (_det.server_code == null && _kmTopLevelCode_(json)) _det.server_code = _kmTopLevelCode_(json);
        return _kmCmdErr_(command, _ecode, _emsg || (command + ' failed'), _det);
    }
    return _kmCmdOk_(command, json.data);   // COMMITTED — the page performs the single readback via the active path
}

// Status transitions: { shipping_plan_id, transition: submit|approve|reject|cancel, rejected_reason?, actor? }.
// Returns the canonical C1 command result (never throws; no internal readback — the page reads back once).
window.KM.DB.updateShippingPlanStatus = function(payload) { return _kmWeeklyCommand_('updateShippingPlanStatus', payload); };
// Edit approved_qty (Draft only): { lines: [ { shipping_plan_line_id, approved_qty } ] }.
window.KM.DB.updateShippingPlanLineQty = function(payload) { return _kmWeeklyCommand_('updateShippingPlanLineQty', payload); };
// Append a note to shipping_plans.note (append-only history): { shipping_plan_id, note, actor? }.
window.KM.DB.appendShippingPlanNote = function(payload) { return _kmWeeklyCommand_('appendShippingPlanNote', payload); };
// Decision Layer Completion (Done): mark an Approved + transferred plan completed { shipping_plan_id, actor? }.
window.KM.DB.completeShippingPlan = function(payload) { return _kmWeeklyCommand_('completeShippingPlan', payload); };

// F1-4B-FM5 · Manual "Recalculate All Sites" batch commands. ONE browser request → ONE bounded server batch
// (enumerate scopes → reuse canonical calc per scope → UPSERT latest into the gap table). Never a per-SKU HTTP
// loop. Uses the canonical C1 command runner (text-first, transport/business classified, never throws). The
// page performs its own single readback of the materialized table; this runner never reloads the whole DB.
window.KM.DB.recalculateInventoryReplenishmentGapAll = function(payload) { return _kmWeeklyCommand_('inventoryReplenishmentGap.recalculate.all', payload || {}); };
window.KM.DB.recalculateOrderPlanningGapAll = function(payload) { return _kmWeeklyCommand_('orderPlanningGap.recalculate.all', payload || {}); };

// F1-4B-FM5-R4J · Backend-owned RESUMABLE gap job. START is a QUICK write: it enqueues ONE backend job (the server
// freezes the calc context, records Script-Property job state, and schedules the first self-re-arming continuation
// trigger) and returns immediately with { runId, status, scopesTotal }. It NEVER waits for the ~14-min calculation
// and NEVER re-POSTs the write. The backend then owns the job to terminal completion, independent of this browser
// tab (the user may refresh/close). STATUS is a strictly READ-ONLY poll of the job's Script-Property progress.
window.KM.DB.startInventoryReplenishmentGapJob = function(payload) { return _kmWeeklyCommand_('inventoryReplenishmentGap.job.start', payload || {}); };
window.KM.DB.startOrderPlanningGapJob = function(payload) { return _kmWeeklyCommand_('orderPlanningGap.job.start', payload || {}); };
// { product:'INVENTORY'|'ORDER_PLANNING', runId? } → { success, data:{ status, scopesProcessed, scopesTotal, ... } }.
window.KM.DB.getGapJobStatus = function(product, runId) { return _kmGapRead_('gapJob.status.get', { payload: { product: product, runId: runId || null } }); };
// F1-4B-FM5-R4J-LIVE4 · manual CANCEL (WRITE, exactly once per click): terminal CANCELLED for the active product job.
// Already-materialized rows are preserved (no rollback). runId optional (cancel only that run when supplied).
window.KM.DB.cancelInventoryReplenishmentGapJob = function(runId) { return _kmWeeklyCommand_('inventoryReplenishmentGap.job.cancel', { payload: { runId: runId || null } }); };
window.KM.DB.cancelOrderPlanningGapJob = function(runId) { return _kmWeeklyCommand_('orderPlanningGap.job.cancel', { payload: { runId: runId || null } }); };

// F1-4B-FM5-R1 · MATERIALIZED READ (page reads STORED gap rows; NO calculation, NO whole-DB reload). Bounded
// POST read of inventory_replenishment_gap / order_planning_gap for one scope. Text-first + fail-safe: on a
// transport/non-JSON/business failure returns { success:false, error } so the page can show a truthful state and
// NEVER silently fall back to a browser/live calculation.
//
// Returns { success, data:{ rows: [...] }, envelope, error }.
//
// F1-7N-FB-4E-R1 §1 — WHY `envelope` EXISTS, AND THE BUG THAT PROVED IT HAD TO.
//
// This runner was written for the GAP READS, whose handlers answer { success, data: { rows: [...] } }. On
// success it returned ONLY `json.data`, so every other key in the answer was discarded. That is correct for a
// gap read and silently destructive for any action whose handler answers with a FLAT envelope — and three do:
//
//   system.health                             63_  identity + contract versions + caller_probe, all top-level
//   system.requestOrderSendReconcile          65_  the whole reconciliation verdict, top-level
//   system.allocationDraftIdentityDiagnostic  67_  the whole identity report, top-level
//
// None of those handlers puts anything under `data`, so `json.data || { rows: [] }` handed the caller an EMPTY
// ROW LIST that looked like a successful read of nothing. For system.health that meant checkDeploymentContract
// read every identity field as undefined and reported the deployment as older than the frontend — while the
// deployment had in fact answered with a complete, correct identity block. See the note there.
//
// `envelope` is the parsed answer EXACTLY as the deployment sent it. It is additive: `data` keeps its meaning
// and every existing gap-read consumer is untouched. Nothing here is synthesized — a field absent from the wire
// is absent from `envelope`.
// =============================================================================================================
// F1-7N-FB-4E-R4A1 §3/§4 — THE READ ACTIONS THIS CLIENT MAY DISPATCH AS A GET.
//
// WHY THERE IS A LIST AND NOT A RULE. This function serves 16 call sites and ONE of them is a WRITE
// (automationSchedule.update). A blanket verb change here would have converted a write into a GET — which a
// browser prefetch, a crawler or a history revisit could then replay. So the verb is decided by an explicit
// allowlist of READS: an action not named here keeps the existing POST, which means a future write added to this
// path is POST by default rather than GET by accident. The default is the safe one.
//
// Membership is not a matter of naming. Every entry is asserted by the R4A1 suite to be (a) served on GET by the
// deployed router — a subset of the router's own GET read table plus the three actions that already had their
// own GET branches — and (b) zero-write when EXECUTED against an instrumented spreadsheet.
// =============================================================================================================
var _KM_GET_READ_ACTIONS_ = {
    // Already GET-routed before R4A1 (their own branches in doGet); now dispatched as GET by the client too.
    'system.health': 1,
    'getClientCapabilities': 1,
    'inventoryScope.registry.get': 1,
    // Served on GET by the R4A1 router read table.
    'inventoryReplenishmentGap.get': 1,
    'orderPlanningGap.get': 1,
    'aiPlanFirstLayer.get': 1,
    'gapJob.status.get': 1,
    'requestOrder.sendWorkset.get': 1,
    'requestOrder.send.status': 1,
    'requestOrderDraft.job.status': 1,
    'requestOrderDraft.getActive': 1,
    'system.requestOrderSendDiagnosticStatus': 1,
    'system.requestOrderSendReconcile': 1,
    'system.allocationDraftIdentityDiagnostic': 1,
    'automationSchedule.get': 1
    // automationSchedule.update is DELIBERATELY ABSENT. It is a write.
};
var _KM_READ_RID_SEQ_ = 0;
function _kmNextReadRequestId_() { _KM_READ_RID_SEQ_++; return 'REQ-G' + ('000000' + _KM_READ_RID_SEQ_).slice(-6); }
function _kmSharedTransport_() {
    try { return (typeof window !== 'undefined' && window.KM && window.KM.transport) ? window.KM.transport : null; }
    catch (e) { return null; }
}
// ONE URL shape for every read in this application. Built by the shared transport when it is present, so this
// file cannot drift into a second read-URL format; the local form is an identical fallback for the case where
// the transport module has not loaded yet.
function _kmReadUrl_(base, action, dto, rid) {
    var tp = _kmSharedTransport_();
    if (tp && typeof tp.readQuery === 'function') {
        return base + (base.indexOf('?') < 0 ? '?' : '&') + tp.readQuery(action, dto, rid);
    }
    var qp = 'action=' + encodeURIComponent(action) + '&km_via=get';
    if (rid) qp += '&km_rid=' + encodeURIComponent(rid);
    var pj = JSON.stringify(dto || {});
    if (pj !== '{}') qp += '&km_body=' + encodeURIComponent(pj);
    return base + (base.indexOf('?') < 0 ? '?' : '&') + qp;
}

async function _kmGapRead_(action, payload) {
    if (!isOperationDbApiConfigured()) return { success: false, error: { code: 'TRANSPORT_NOT_CONFIGURED', message: 'Operation DB API not configured' } };
    var base = (window.KM && window.KM.DB && typeof window.KM.DB.getApiBaseUrl === 'function' && window.KM.DB.getApiBaseUrl()) || OP_DB_API_BASE_URL;
    var isRead = _KM_GET_READ_ACTIONS_[action] === 1;
    var resp, url, _cls, text = '';
    var _t0 = Date.now();

    // F1-7N-FB-4E-R4A1 — GET FOR READS, AND ONE BOUNDED RECOVERY THAT STARTS AT THE STABLE /exec.
    //
    // An /exec answer always arrives through a 302 to script.googleusercontent.com. A POST cannot survive that
    // hop — per the Fetch spec the redirect is re-issued as a GET with the body dropped — and the two live
    // failures are its two consequences: an unreadable echo target (404) and an echo that resolves back into
    // doGet with no body. A GET has nothing to lose, which is why the reads this app already sent as GET never
    // failed this way. When the echo target itself 404s the deployment is fine and one hop simply could not be
    // read, so ONE fresh attempt from the STABLE endpoint gets a fresh target. The redirect URL is never stored,
    // never re-requested and never treated as an endpoint: every attempt is rebuilt from `base`. The recovery
    // carries its OWN request id, because it is a second physical request and R4A's rule applies to it in full.
    for (var attemptN = 1; attemptN <= 2; attemptN++) {
        var rid = isRead ? _kmNextReadRequestId_() : '';
        var dto = Object.assign({ action: action }, payload || {});
        if (rid) dto.requestId = rid;
        url = isRead ? _kmReadUrl_(base, action, dto, rid) : base;
        var init = isRead
            ? { method: 'GET', cache: 'no-store' }
            : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(dto) };
    // F1-7N-FB-3 §D — bounded: an unanswered read can no longer hold its caller's latch forever.
        try { resp = await _kmFetchBounded_(url, init, 'read'); }
        catch (netErr) {
            try { if (typeof _kmReportSample_ === 'function') _kmReportSample_(action, 'read', _t0, (netErr && netErr.kmTimeout) ? 'REQUEST_TIMEOUT' : 'HTTP_TRANSPORT_ERROR', 'DISPATCH', 0); } catch (e) {}
            if (netErr && netErr.kmTimeout) return { success: false, error: _kmTimeoutError_(action, 'read', netErr.timeoutMs) };
            return { success: false, error: { code: 'HTTP_TRANSPORT_ERROR', message: 'Network error: ' + (netErr && netErr.message ? netErr.message : netErr) } };
        }
        text = ''; try { text = await resp.text(); } catch (e) { text = ''; }
        _cls = _kmClassifyAnswer_(action, 'read', resp, text, url);
        var redirectTarget404 = !_cls.ok && _cls.typed && _cls.typed.code === 'REDIRECT_TARGET_NOT_FOUND';
        if (!(isRead && attemptN === 1 && redirectTarget404)) break;
        // Ask the shared policy rather than deciding here, so there is ONE answer to "may this be replayed?".
        var tpR = _kmSharedTransport_();
        var allowed = (tpR && typeof tpR.isAutoRetryable === 'function')
            ? tpR.isAutoRetryable({ kind: 'read', code: 'REDIRECT_TARGET_NOT_FOUND' }) : false;
        if (!allowed) break;
    }
    try { if (typeof _kmReportSample_ === 'function') _kmReportSample_(action, 'read', _t0, _cls.ok ? null : _cls.typed.code, _cls.ok ? 'SUCCESS' : _cls.typed.phase, String(text || '').length); } catch (e) {}
    if (!_cls.ok) {
        return { success: false, error: {
            code: _cls.legacyCode,                                   // preserved alias (existing page consumers)
            message: _kmTypedTransportMessage_(action, _cls),
            transport: Object.assign({}, _cls.typed, _cls.wire),     // the §C authority: code + phase + fingerprint
            details: Object.assign({ action: action }, _cls.typed, _cls.wire)
        } };
    }
    var trimmed = String(text || '').trim();
    var json; try { json = JSON.parse(trimmed); } catch (pe) { return { success: false, error: { code: 'NON_JSON_RESPONSE', message: 'Malformed JSON response',
        transport: { code: 'TRANSPORT_NON_JSON_RESPONSE', phase: 'PARSE', retryable: false, zero_write: true, action: action } } }; }
    if (!json.success) {
        // F1-7N-FB-3A §C — the router's terminal unknown-action envelope carries no errors[], which is exactly
        // how it used to become the meaningless "GAP_READ_ERROR — gap read failed". Name it for what it is.
        if (_kmIsUnknownActionResponse_(json.error)) return { success: false, error: _kmDeploymentMismatchError_(action) };
        return { success: false, error: (json.errors && json.errors[0]) || { code: 'GAP_READ_ERROR', message: 'gap read failed' } };
    }
    return { success: true, data: json.data || { rows: [] }, envelope: json };
}
// { company, country, marketplace, sku? } → { success, data:{ rows:[ inventory_replenishment_gap rows ] } }.
window.KM.DB.getInventoryReplenishmentGap = function(scope) { return _kmGapRead_('inventoryReplenishmentGap.get', { payload: { scope: scope || {} } }); };
// { company, country, marketplace, sku? } → { success, data:{ rows:[ order_planning_gap rows ] } }.
window.KM.DB.getOrderPlanningGap = function(scope) { return _kmGapRead_('orderPlanningGap.get', { payload: { scope: scope || {} } }); };
// F1-7E-PREREQ-5 · AI-Plan first-layer COMPOSER read (56_). payload { planning_cycle } → { success, data:{ planningCycle,
// windowMonths, rows:[ the SAME first-layer rows _buildRequestOrderRowsFromDb builds ] } }. READ ONLY; scoped composer
// (never getOperationDb); composes the 52_/53_/54_/55_ Layer-1 owners + identity. Layer-2 Gap/Recommendation unchanged.
window.KM.DB.getAiPlanFirstLayer = function(payload) { return _kmGapRead_('aiPlanFirstLayer.get', { payload: payload || {} }); };

// F1-7N-FA-3C-R6E1-R1 — CLIENT CAPABILITY read + SINGLE-AUTHORITY bootstrap (three-flag alignment). ---------------
// The backend 00_config.gs flags are the owner-of-record; getClientCapabilities (01_/03_) is the ONE wire channel
// that exposes their EFFECTIVE values. This replaces three independently hardcoded frontend booleans with a single
// read → single apply path (KM.api.applyClientCapabilities). READ-ONLY; never mutates the DB.
// F1-7N-FB-4E §D1 — SESSION-STABLE METADATA IS SINGLE-FLIGHTED THROUGH THE SHARED LATCH.
//
// Both of these are immutable for a session (a backend flag set, and a deployment's own identity), and both
// were called from more than one place at mount — so two concurrent consumers issued two IDENTICAL requests
// for a value that cannot differ between them. Removing a duplicate request is worth doing on its own terms:
// it is one less unit of load against a quota'd, contended backend and one less thing that can fail. It is
// NOT claimed here to be a measurable share of "pages feel slower" — that has not been measured.
// The latch lives in KM.transport with an ALLOWLIST, so a business workspace can never be coalesced by
// accident (§D4), and a REJECTED promise is evicted immediately (§D2), so one failure cannot make every later
// consumer inherit it — which is what turns a transient fault into "only a hard reload fixes it".
function _kmMetadataSingleFlight_(key, fn) {
    try {
        if (typeof window !== 'undefined' && window.KM && window.KM.transport
            && typeof window.KM.transport.singleFlight === 'function'
            && window.KM.transport.isMetadataKey(key)) {
            return window.KM.transport.singleFlight(key, fn);
        }
    } catch (e) { /* fall through — never let the optimisation break the read */ }
    return Promise.resolve().then(fn);
}
window.KM.DB.getClientCapabilities = function() {
    return _kmMetadataSingleFlight_('getClientCapabilities', function () { return _kmGapRead_('getClientCapabilities', {}); });
};

// F1-7N-FB-3 §C — SLIM SCOPE REGISTRY for the Site Inventory selectors (owner = 64_). ONE table, a six-column
// bounded projection: countries + marketplaces (+ the country -> marketplace_id index that lets a Country
// change re-scope the Marketplace selector with NO further request). It carries no inventory row, no sales
// history, no forecast, no recommendation, no factory stock, no draft, no plan and no document — so it can be
// requested at page mount WITHOUT touching the inventory workspace and WITHOUT putting the inventory table
// into a loading state. Read-only, bounded by the shared client timeout, never throws.
window.KM.DB.getInventoryScopeRegistry = function() { return _kmGapRead_('inventoryScope.registry.get', {}); };

// F1-7N-FB-3B §E/§F — SEND REQUEST: the slim workset READ and the single ORCHESTRATION write. Owner = 66_.
//
// getRequestOrderSendWorkset — READ-ONLY, include-gated, TWO tables. Send Request no longer depends on a fresh
// 495-row AI-Plan payload (aiPlanFirstLayer.get reads ELEVEN tables): the confirmation counts, the tier
// selection, the Series grouping, the persisted-quantity facts and the current-run authority all come from
// here. Bounded by the shared READ timeout, which was deliberately NOT raised.
window.KM.DB.getRequestOrderSendWorkset = function (payload) { return _kmGapRead_('requestOrder.sendWorkset.get', { payload: payload || {} }); };

// sendRequestOrderOrchestration — ONE CLICK, ONE REQUEST. The browser no longer runs a per-SKU write loop and
// no longer owns business progress: it posts the tier scope, the planning cycle and its asserted quantities,
// and the server builds the workset from the PERSISTED drafts, verifies, freezes, writes through the canonical
// writers, proves the output and advances the lifecycle.
//
// WHY THIS IS NOT ROUTED THROUGH _kmWeeklyCommand_'s generic timeout story: an expired orchestration is neither
// a zero-write nor a failure — it is RESUMABLE BY EXECUTION KEY. The key is a pure function of the body, so the
// caller resumes by re-posting the SAME body with resume=true; nothing already proven is repeated. A blind
// retry is never advised. `dry_run: true` performs zero writes and returns the frozen plan — that is what the
// confirmation dialog is built from, so the numbers the user approves are the server's, not the page's.
window.KM.DB.sendRequestOrderOrchestration = async function (payload) {
    var res = await _kmWeeklyCommand_('requestOrder.send.orchestrate', { payload: payload || {} });
    if (res && res.success === false && res.error && /REQUEST_TIMEOUT/.test(String(res.error.code || ''))) {
        res.error.details = Object.assign({}, res.error.details || {}, {
            resumable_by_execution_key: true, retryable: false,
            next_action: 'Do NOT press Send again. Re-invoke the SAME Send with resume=true, or run the interrupted-Send reconciliation first — the orchestration key is derived from the request, so a resume converges on the same Request Orders.'
        });
    }
    return res;
};
// Read-only reconciliation of an interrupted Send (FB-3A, 65_). Kept adjacent because the orchestration's own
// timeout guidance points at it: an interrupted orchestration is never assumed to be a zero-write.
window.KM.DB.reconcileRequestOrderSend = function (payload) { return _kmGapRead_('system.requestOrderSendReconcile', payload || {}); };

// F1-7N-FB-3C §D — THE 90 s / 240 s CONTRADICTION, AND WHY THIS CONSTANT IS RESTATED IN THE BACKEND.
// FB-3B's orchestration yielded voluntarily at 240 000 ms while THIS transport aborts a write at
// KM_WRITE_TIMEOUT_MS_ = 90 000 ms. So the browser declared REQUEST_TIMEOUT_WRITE_INDETERMINATE while the server
// was, by design, still writing for another 150 seconds — and AbortController closes the socket without stopping
// an Apps Script execution, so the writes continued invisibly and the PARTIAL_RESUMABLE answer could never
// arrive. 66_ now derives its slice budget FROM this value (ROS_CLIENT_WRITE_TIMEOUT_MS_ must equal it, and a
// regression test asserts the equality), stops ADMITTING work at 43 000 ms, and answers PARTIAL_RESUMABLE well
// inside the bound. THE TIMEOUT WAS NOT RAISED to make a slow Send fit; the work was sliced instead.
//
// requestOrder.send.status — READ-ONLY journal status. A page that RELOADS mid-Send has lost its in-memory state
// but not the execution; this is how it finds out what the server thinks is happening before doing anything.
window.KM.DB.getRequestOrderSendStatus = function (payload) { return _kmGapRead_('requestOrder.send.status', { payload: payload || {} }); };

// F1-7N-FB-3C §B — THE USER-AUTHORIZED DRAFT-CREATION BOUNDARY.
// A deliberate user quantity edit is now an authorized canonical draft-creation/update boundary, so a SKU the AI
// never materialized is no longer permanently unsendable. One request: find-or-create the canonical Flat-V2
// draft, persist the quantity through the canonical locked writer, READ IT BACK, and return the persisted
// internal id. It never mints a 'RAD-M-…' identity, and it never defers creation to Send Request.
//
// This uses the WRITE runner, so it inherits the bounded write timeout and the DEPLOYMENT_CONTRACT_MISMATCH
// classification. A failure here must leave the field visibly UNSAVED — the caller is responsible for that, and
// Send Request stays blocked while any edit is unsaved.
window.KM.DB.ensureAndEditAllocationDraft = function (payload) { return _kmWeeklyCommand_('requestOrder.allocationDraft.ensureAndEdit', payload || {}); };

// F1-7N-FB-3C §C — read-only reconciliation of non-canonical allocation-draft identities (the retired 'RAD-M-…'
// rows). Reports and PROPOSES; it migrates nothing. Ids come back masked.
window.KM.DB.getAllocationDraftIdentityDiagnostic = function (payload) { return _kmGapRead_('system.allocationDraftIdentityDiagnostic', { payload: payload || {} }); };

// The slice budget the SERVER is expected to respect, restated for the continuation loop so the page can report
// a nonsensical server duration instead of silently absorbing it. Kept as a derived read, never a second
// authority: the server owns the budget and reports it back on every PARTIAL_RESUMABLE answer.
window.KM.DB.getWriteTimeoutMs = function () { return _kmTimeoutMs_('write'); };
// Fetch the effective backend flags ONCE and apply them through the ONE KM.api apply path. On ANY transport/business
// failure it applies the documented FAIL-SAFE defaults (flat V2 = true / FLAT_V2, site confirm = true, inventory
// generation = false) so the posture is deterministic and never silently selects legacy against the 53-col table.
// Never throws. Returns (and caches on window.__kmCapabilitySnapshot) the resolved capability snapshot.
// F1-7N-FC-1B-E3-R4-A2-R1 §7 — CAPABILITY NEGOTIATION IS NOT A GATE, AND A LATE FAILURE IS NOT NEWS.
//
// The live first-load evidence: getClientCapabilities took 45 s, timed out, and its redirect target answered
// 404 — while checkDeploymentContract succeeded afterwards and Site Inventory read fine. The bootstrap
// already fires this WITHOUT awaiting it, so the page was never gated on it, and that part needs no change.
//
// What DID need changing is what happens when the slow one finally lands. Every call applied whatever it
// resolved to, unconditionally, so a 45-second failure resolving after a later success would overwrite real
// backend values with fail-safe defaults — silently flipping the runtime posture minutes after the page
// looked settled. A stale answer arriving late is not new information, and the sequence guard here is the same
// one the inventory read already uses for exactly the same reason.
//
// THE ASYMMETRY IS DELIBERATE. A newer SUCCESS always wins. A FAILURE only applies when nothing better has
// been applied since it was issued — because "we could not reach the backend" says nothing about a value
// we already have from the backend, and fail-safe defaults exist to fill a vacuum, not to replace evidence.
//
// THE CACHE IS BOUND TO THE DEPLOYMENT. Capabilities describe a specific backend build; a cached snapshot that
// outlives a deployment is a lie with a timestamp on it. The stored identity is compared and a mismatch throws
// the snapshot away rather than reconciling it.
var _kmCapSeq_ = 0;                 // monotonic issue order
var _kmCapAppliedSeq_ = 0;          // the sequence whose result is currently applied
var _kmCapAppliedFromBackend_ = false;
function _kmCapDeploymentIdentity_() {
    try {
        var r = (window.KM && window.KM.RELEASE) ? window.KM.RELEASE : null;
        var d = window.__kmDeploymentIdentity || null;
        // Before the contract check has run there is no identity to bind to, and that is reported as null
        // rather than as a fabricated one: an unknown identity must not compare EQUAL to a known one.
        if (!d) return null;
        return JSON.stringify({ release: r || null, build_id: d.build_id,
            action_contract: d.deployed_action_contract_version, transport_contract: d.transport_contract_version });
    } catch (e) { return null; }
}
async function _kmApplyClientCapabilities_() {
    var mySeq = ++_kmCapSeq_;
    var issuedIdentity = _kmCapDeploymentIdentity_();
    var applied = null, caps = null, err = null;
    try {
        var res = await window.KM.DB.getClientCapabilities();
        caps = (res && res.success && res.data) ? res.data : null;
        if (!caps) err = (res && res.error) || { code: 'CAPABILITY_UNAVAILABLE' };
    } catch (e) { err = { code: 'CAPABILITY_BOOTSTRAP_ERROR', message: e && e.message ? e.message : String(e) }; caps = null; }
    // §7.3 — the deployment moved while this was in flight. The answer describes a build that is no longer
    // the one being talked to, so it is discarded rather than applied to the new one.
    var nowIdentity = _kmCapDeploymentIdentity_();
    if (issuedIdentity !== null && nowIdentity !== null && issuedIdentity !== nowIdentity) {
        console.warn('[KM.capabilities] discarded: the deployment identity changed while this request was in flight');
        return (window.KM && window.KM.api && typeof window.KM.api.getClientCapabilitySnapshot === 'function')
            ? window.KM.api.getClientCapabilitySnapshot() : null;
    }
    // §7.4 — a LATE FAILURE never overwrites a LATER SUCCESS.
    if (!caps && _kmCapAppliedFromBackend_ && _kmCapAppliedSeq_ > mySeq) {
        console.warn('[KM.capabilities] a late failure (seq ' + mySeq + ') was DISCARDED — a newer backend answer (seq '
            + _kmCapAppliedSeq_ + ') is already applied', err);
        return (window.KM && window.KM.api && typeof window.KM.api.getClientCapabilitySnapshot === 'function')
            ? window.KM.api.getClientCapabilitySnapshot() : null;
    }
    // And an out-of-order SUCCESS never overwrites a newer one either.
    if (_kmCapAppliedSeq_ > mySeq && _kmCapAppliedFromBackend_) {
        return (window.KM && window.KM.api && typeof window.KM.api.getClientCapabilitySnapshot === 'function')
            ? window.KM.api.getClientCapabilitySnapshot() : null;
    }
    try {
        if (window.KM && window.KM.api && typeof window.KM.api.applyClientCapabilities === 'function') {
            applied = window.KM.api.applyClientCapabilities(caps);   // caps null → fail-safe defaults applied
        }
    } catch (e2) { /* apply never throws by contract; guard anyway */ }
    _kmCapAppliedSeq_ = mySeq;
    _kmCapAppliedFromBackend_ = !!caps;
    if (!caps) console.warn('[KM.capabilities] backend capability unavailable — applied fail-safe defaults', err);
    try {
        window.__kmCapabilitySnapshot = applied || null;
        // §7 — the cache carries WHAT IT DESCRIBES. Without the identity and the time, a snapshot cannot be
        // told from a guess, and a reader has no way to know it has outlived its backend.
        window.__kmCapabilityMeta = { seq: mySeq, fromBackend: !!caps, at: Date.now(),
            deploymentIdentity: nowIdentity, errorCode: (err && err.code) || null };
    } catch (e3) {}
    return applied;
}
window.KM.DB.applyClientCapabilities = _kmApplyClientCapabilities_;
// Read-only capability diagnostic (no secrets/ids/row data): the three EFFECTIVE values + provenance + verdict.
window.__kmCapabilities = function() {
    var snap = (window.KM && window.KM.api && typeof window.KM.api.getClientCapabilitySnapshot === 'function')
        ? window.KM.api.getClientCapabilitySnapshot() : null;
    var source = snap ? snap.source : 'unloaded';
    var verdict = source === 'backend' ? 'CAPABILITY_FROM_BACKEND'
        : source === 'failsafe-default' ? 'CAPABILITY_FAILSAFE_BACKEND_UNAVAILABLE'
        : 'CAPABILITY_NOT_LOADED';
    var release = (window.KM && window.KM.RELEASE) ? window.KM.RELEASE : null;   // agrees with __roDebug/__kmLifecycleDebug + loaded token
    return { release: release, snapshot: snap, source: source, verdict: verdict };
};
// Re-fetch and compare backend vs the applied runtime snapshot — detects source/runtime disagreement (HALT signal).
window.__kmVerifyCapabilities = async function() {
    var live = null; try { var r = await window.KM.DB.getClientCapabilities(); live = (r && r.success && r.data) ? r.data : null; } catch (e) { live = null; }
    var snap = (window.KM && window.KM.api && typeof window.KM.api.getClientCapabilitySnapshot === 'function') ? window.KM.api.getClientCapabilitySnapshot() : null;
    if (!live || !snap) return { agreement: 'INDETERMINATE', backend: live, runtime: snap };
    var agree = live.requestOrderDraftV2FlatCutover === snap.requestOrderDraftV2FlatCutover
        && live.requestOrderSiteConfirmRequired === snap.requestOrderSiteConfirmRequired
        && live.inventoryAiPlanDbGenerationEnabled === snap.inventoryAiPlanDbGenerationEnabled;
    return { agreement: agree ? 'AGREE' : 'DISAGREE_HALT', backend: live, runtime: snap };
};

// F1-4B-FM6-R4E2-B2 / R4E3-PRE — Request Order canonical draft: request-driven resumable scope job + scope
// read-back + LOCKED incremental order_qty edit. The browser drives ONE logical job (START → poll CONTINUE →
// terminal), reads the whole scope back once (getActive), and persists a single edited order_qty via the EXISTING
// locked decision writer (updateRecommendationDecisionLocked) under the optimistic-lock token — never a second writer.
window.KM.DB.startRequestOrderDraftJob = function(scope, opts) { return _kmWeeklyCommand_('requestOrderDraft.job.start', { payload: Object.assign({ scope: scope || {} }, opts || {}) }); };
window.KM.DB.continueRequestOrderDraftJob = function(runId) { return _kmWeeklyCommand_('requestOrderDraft.job.continue', { payload: { runId: runId || null } }); };
window.KM.DB.getRequestOrderDraftJobStatus = function(runId) { return _kmGapRead_('requestOrderDraft.job.status', { payload: { runId: runId || null } }); };
window.KM.DB.cancelRequestOrderDraftJob = function(runId) { return _kmWeeklyCommand_('requestOrderDraft.job.cancel', { payload: { runId: runId || null } }); };
// scope read-back (SKU omitted → { drafts, conflicts, noDraftSkus }). READ ONLY. { success, data:{...} }.
window.KM.DB.getActiveRequestOrderDrafts = function(scope) { return _kmGapRead_('requestOrderDraft.getActive', { payload: { scope: scope || {} } }); };
// F1-7N-FB-4E-R4B-R2 §3 - ONE bounded multi-scope readback. The All-level Order Planning view knows exactly which
// scopes are on screen; it used to turn that into one cold Apps Script execution per scope. The list is explicit,
// deduplicated, sorted and capped server-side, and an oversized list is REFUSED rather than truncated.
window.KM.DB.getActiveRequestOrderDraftsForScopes = function(scopes) { return _kmGapRead_('requestOrderDraft.getActive', { payload: { scopes: scopes || [] } }); };
// canonical concurrency token for a draft (25_) → { success, data:{ expectedToken:{draft_version,userEditFingerprint} } }.
window.KM.DB.getRecommendationDraftToken = function(recommendationType, draftId) { return _kmWeeklyCommand_('getRecommendationDraftToken', { recommendationType: recommendationType, draftId: draftId }); };
// canonical LOCKED user-decision edit (25_). payload: { recommendationType, draftId, edits:[{naturalKey,fields}], expectedToken, actor? }.
window.KM.DB.updateRecommendationDecisionLocked = function(payload) { return _kmWeeklyCommand_('updateRecommendationDecisionLocked', payload || {}); };

// ADMIN-AUTOMATION-R1 · Automation Schedule Settings. GET is read-only (opening the Admin page mutates nothing);
// UPDATE writes the Script-Property config + reconciles ONLY the owned time trigger, then returns the normalized
// config + trigger status. Both use the canonical text-first runners (never throw; transport/business classified).
window.KM.DB.getAutomationSchedule = function() { return _kmGapRead_('automationSchedule.get', {}); };
// UPDATE uses the same text-first POST runner as the reads so the server's structured `errors[0]` (e.g.
// WEEKLY_RECOMMENDATION_NOT_AVAILABLE / INVALID_TIME) surfaces as { success:false, error:{ code } } and the
// success path returns the server's post-reconcile readback in `data` (jobs + trigger status + warnings).
window.KM.DB.updateAutomationSchedule = function(payload) { return _kmGapRead_('automationSchedule.update', { payload: payload || {} }); };

// ---- Weekly Plan Layer-1/2 + Combined Plan + Method Recommendation adapters (2026-07-28) ----
// All matching is CODE/ID based server-side. Weekly Plan NEVER persists rate_card_id; carrier_name is
// resolved live (KM.display.carrierName). READ helpers do not force a DB reload; WRITE helpers do.
async function _kmShippingPost_(action, payload, errMsg, reloadAfter) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, ' + action + ' skipped'); return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: action }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || errMsg);
    if (reloadAfter) await _kmWriterPostWrite_();
    return json.data;
}
// READ: Execution Plan method recommendation + Weekly L1 cascade { origin_country?, destination_country|country, planning_date?, skus?, shipping_method?, last_mile_delivery? }.
window.KM.DB.getShippingMethodCandidates = function(payload) { return _kmShippingPost_('getShippingMethodCandidates', payload, 'Get method candidates failed', false); };
// READ: Weekly L2 rough rate candidates for a plan { shipping_plan_id }.
window.KM.DB.getWeeklyPlanRateCandidates = function(payload) { return _kmShippingPost_('getWeeklyPlanRateCandidates', payload, 'Get rate candidates failed', false); };
// WRITE: Weekly L1 rationale (clears carrier/cost, bumps version) { shipping_plan_id, shipping_method?, last_mile_delivery?, customs_type?, ... }.
window.KM.DB.updateShippingPlanRationale = function(payload) { return _kmShippingPost_('updateShippingPlanRationale', payload, 'Update rationale failed', true); };
// WRITE: Weekly L2 carrier select (snapshot + cost; NO rate_card_id) { shipping_plan_id, selected_rate_card_id }.
window.KM.DB.selectShippingPlanCarrier = function(payload) { return _kmShippingPost_('selectShippingPlanCarrier', payload, 'Select carrier failed', true); };
// WRITE: create a Combined Parent over eligible Draft plans { source_plan_ids: [...] }.
window.KM.DB.combineShippingPlans = function(payload) { return _kmShippingPost_('combineShippingPlans', payload, 'Combine plans failed', true); };
// WRITE: dissolve a Combined Parent { parent_shipping_plan_id }.
window.KM.DB.uncombineShippingPlans = function(payload) { return _kmShippingPost_('uncombineShippingPlans', payload, 'Uncombine plans failed', true); };

// Execution Commit (explicit / retry): Approved shipping_plan → shipments + shipment_lines (draft).
// Normally Approve auto-creates the Shipment Draft server-side; this is the idempotent retry path.
// { shipping_plan_id, actor? }
// F1-7N-FC-1A §C — MOVED ONTO THE CANONICAL COMMAND RUNNER.
//
// This adapter used to `throw new Error(json.error)` on a business rejection and return json.data on success.
// Both halves were wrong for the caller this round connects. The Weekly page's command runner classifies a
// thrown error as HTTP_TRANSPORT_ERROR, so INSUFFICIENT_FACTORY_STOCK -- a precise, actionable, retry-later
// business answer -- would have reached the operator as "the network failed", which is the exact confusion
// §J.4 forbids. And returning `data` instead of the envelope loses `success`, so the page could not tell
// CREATED from REUSED. _kmWeeklyCommand_ is the same text-first runner Approve/Submit/Done already use: it
// never throws, and it preserves the typed code end to end. FC-0A measured that this action had NO caller, so
// nothing depended on the old throwing shape.
window.KM.DB.createShipmentFromPlan = function(payload) { return _kmWeeklyCommand_('createShipmentFromPlan', payload); };

// F1-7N-FC-1A-R1 §D/§F — cancel a PRE-DISPATCH Shipment Draft and release its factory stock
// reservation, atomically. { shipment_id, actor?, reason?, expected_status?, idempotency_key? }
// Answers { outcome: 'CANCELLED' | 'REUSED' } or a typed refusal (SHIPMENT_ALREADY_DISPATCHED,
// SHIPMENT_STATUS_CHANGED, SHIPMENT_STATUS_NOT_CANCELLABLE, LOCK_UNAVAILABLE, CANCEL_ROLLED_BACK).
// On the command runner, not a throwing fetch: "this shipment already dispatched" is a precise business answer
// and must not reach the operator as a network error.
window.KM.DB.cancelShipmentDraft = function(payload) { return _kmWeeklyCommand_('cancelShipmentDraft', payload); };

// Edit EXECUTION-layer fields only (carrier/container/booking/ETD/ETA/tracking/remark/...).
// The Execution Snapshot and six-key context are immutable and rejected server-side.
// { shipment_id, carrier_id?, container_no?, booking_no?, bl_no?, invoice_no?, tracking_number?,
//   etd?, eta?, note?, status?, actor? }
window.KM.DB.updateShipment = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateShipment skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updateShipment' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update shipment failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// ========================================
// Procurement Layer (Phase 1) writers — API-ready. All POST { action, ...payload } and reload
// the DB on success (same pattern as the shipping-plan / shipment writers). The frontend never
// treats the DOM as the source of truth; sessionStorage is demo fallback / draft recovery only.
// ========================================

// Create a Request Order Draft (Procurement Planning Draft). Body:
// { company?, supplier_id?, supplier_name?, factory_id?, warehouse_id?, source?, currency?,
//   note?, created_by?, lines: [ { sku, product_name?, series?, requested_qty, units_per_carton?,
//   supplier_sku?, unit_cost?, need_reason?, related_entity_type?, related_entity_id? } ] }
window.KM.DB.createRequestOrderDraft = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, createRequestOrderDraft skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'createRequestOrderDraft' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Create request order failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// ---- Request Order second-layer allocation drafts (planning scratchpads; no stock movement) ----
// Upsert ONE draft header (CANONICAL fields). { request_allocation_draft_id?, planning_cycle?, company?,
//   country?, marketplace?, sku?, category_snapshot?, series_snapshot?, status?, generation_type?,
//   draft_purpose?, draft_version?, created_by?, note? } → { request_allocation_draft_id }.
//   (generation_type replaces the retired source_type; category/series are legacy read-only aliases.)
window.KM.DB.upsertRequestOrderAllocationDraft = async function(payload) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, upsertRequestOrderAllocationDraft skipped'); return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertRequestOrderAllocationDraft' }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert allocation draft failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Round 1H — read-only concurrency-token getter for a Recommendation Draft. Returns
// { success, data:{ expectedToken:{draft_version,userEditFingerprint}, status } }.
window.KM.DB.getRecommendationDraftToken = async function(recommendationType, draftId) {
    if (!isOperationDbApiConfigured()) { return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'getRecommendationDraftToken', recommendationType: recommendationType, draftId: draftId }) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    return await resp.json();
};

// Persist the lines of ONE draft. { request_allocation_draft_id, lines: [ ... ] } → { line_count }.
// Round 1H: this now hits the LOCKED, terminal-guarded, optimistic-concurrency write boundary. It performs a
// read-before-write: if the caller did not supply an expectedToken, the current Draft token is fetched and
// attached, so a concurrent edit that changed the Draft since it was read surfaces as a CONFLICT (never a
// silent overwrite). The recommended_qty snapshot + user decisions are preserved server-side.
window.KM.DB.upsertRequestOrderAllocationDraftLines = async function(payload) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, upsertRequestOrderAllocationDraftLines skipped'); return { success: false, error: 'API not configured' }; }
    if (payload && payload.expectedToken === undefined && payload.request_allocation_draft_id) {
        try {
            var tok = await window.KM.DB.getRecommendationDraftToken('MONTHLY_ORDER', payload.request_allocation_draft_id);
            if (tok && tok.success && tok.data && tok.data.expectedToken) payload = Object.assign({}, payload, { expectedToken: tok.data.expectedToken });
        } catch (e) { /* token fetch failed → the server fails closed with a CONFLICT (concurrency never silently disabled) */ }
    }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertRequestOrderAllocationDraftLines' }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error((json.data && json.data.reason) || json.error || 'Upsert allocation draft lines failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Mark drafts submitted. { draft_ids: [ ... ], submitted_by? } → { submitted }.
window.KM.DB.submitRequestOrderAllocationDrafts = async function(payload) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, submitRequestOrderAllocationDrafts skipped'); return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'submitRequestOrderAllocationDrafts' }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Submit allocation drafts failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// --- Inventory Replenishment second-layer Recommendation / Execution Plan drafts (16_ handlers).
// Backend handler/table = source-complete (assets/specs/active/apps-script/16_shipping_allocation_handlers.gs);
// LIVE persistence activates on an authorized redeploy. Until then these return {success:false} when the
// API is unconfigured and the UI falls back to transient sessionStorage recovery (never SSOT).
// C2-D2: Allocation-Draft Save/Cancel adapters aligned to the C1 canonical command runner (_kmWeeklyCommand_):
// ack decoupled from readback, structured error codes (HTTP_TRANSPORT_ERROR / NON_JSON_RESPONSE /
// BUSINESS_COMMAND_ERROR / ALREADY_IN_TARGET_STATE / TRANSPORT_NOT_CONFIGURED), NEVER throws, and NO internal
// whole-DB loadOperationDb — the page performs exactly one targeted readback via getShippingAllocationDraftWorkspace.
window.KM.DB.upsertShippingAllocationDraft = function(payload) { return _kmWeeklyCommand_('upsertShippingAllocationDraft', payload); };
// F1-7N-FB-4A §C — READ-ONLY Execution Plan identity conflict diagnostic (owner = 68_). Zero writes: it reports
// which persisted row blocks one exact route, why, and the safe idempotent dispositions. Never call it as part of
// a save — it is an operator/diagnostic surface, and a save must not depend on a diagnostic to decide anything.
window.KM.DB.getExecutionPlanConflictDiagnostic = function(payload) { return _kmWeeklyCommand_('system.executionPlanConflictDiagnostic', payload); };
// UPSERT lines by allocation_draft_line_id (protects recommended_qty; §D). { allocation_draft_id, lines }.
window.KM.DB.upsertShippingAllocationDraftLines = function(payload) { return _kmWeeklyCommand_('upsertShippingAllocationDraftLines', payload); };
// F1-7N-FB-4G-A2-R3 §D/§E — THE ATOMIC route-ticket writer, and the reason it needed adding here at all.
//
// The action has been routed since F1-7N-FA-3C-R6F1 and there was NO adapter for it, so the frontend could not
// call it even though it existed: the Execution Plan had only the two-call path, which cannot be atomic. A2-R3
// measured that path leaving 1 header and 0 lines when the line write was refused — an orphan zero-line header.
// Body: { header:{ ..., intent, allocation_draft_id?, expected_draft_version?, applied_scope_key? },
//         lines:[ ... ], create_idempotency_key?, expected_draft_version? }.
// One request commits the header and its line together, or writes nothing at all.
window.KM.DB.upsertShippingAllocationDraftAtomic = function(payload) { return _kmWeeklyCommand_('upsertShippingAllocationDraftAtomic', payload); };
window.KM.DB.submitShippingAllocationDrafts = function(payload) { return _kmWeeklyCommand_('submitShippingAllocationDrafts', payload); };
// F1-7N-FA-4B — THE canonical Inventory AI Plan Submit (allocation drafts → Weekly Shipping Plan). Server re-reads the
// persisted drafts (NEVER trusts frontend-authored lines). Returns the FULL typed envelope (never throws on a business
// outcome) so the page can branch on CREATED / REUSED / CONFLICT / IN_PROGRESS_SAME_EXECUTION_KEY. Payload =
// { allocation_draft_ids:[], expected_versions?:{id:draft_version}, execution_key, submitted_by? }.
window.KM.DB.submitAllocationDraftsToShippingPlans = async function(payload) {
    if (!isOperationDbApiConfigured()) { return { success: false, error: 'API not configured', code: 'TRANSPORT_NOT_CONFIGURED' }; }
    var url = (window.KM && window.KM.DB && typeof window.KM.DB.getApiBaseUrl === 'function' && window.KM.DB.getApiBaseUrl()) || OP_DB_API_BASE_URL;
    var resp;
    try { resp = await fetch(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ action: 'submitAllocationDraftsToShippingPlans' }, payload || {})) }); }
    catch (netErr) { return { success: false, error: String((netErr && netErr.message) || netErr), code: 'HTTP_TRANSPORT_ERROR' }; }
    var text = ''; try { text = await resp.text(); } catch (e) { text = ''; }
    if (!resp.ok) return { success: false, error: 'API HTTP ' + resp.status, code: 'HTTP_TRANSPORT_ERROR' };
    var json; try { json = JSON.parse(text); } catch (e) { return { success: false, error: 'NON_JSON_RESPONSE', code: 'NON_JSON_RESPONSE' }; }
    if (json && json.success) { try { await _kmWriterPostWrite_(); } catch (e) { /* readback is the page's job */ } }
    return json;   // full typed envelope: { success, data:{outcome, plans, execution_key, ...} } | { success:false, code, ... }
};
// F1-7N-FA-3C-R6D1 — Inventory AI Plan generation (canonical 61_ handleGenerateWeeklyAiPlanDraft_ via router action
// weeklyAiPlan.generate). Persists ONLY shipping_allocation_drafts / _lines. Payload = { company, country, mode?,
// planningCycle?(auto-resolved server-side when blank), confirmRegenerateOverUserEdits?, currentMarketplace?, actor? }.
// Scope is company+country ONLY (marketplace is readback context; the batch fans out per-marketplace). Deterministic
// natural-key reuse + LockService live in the backend; a blank-cycle orphan can never be matched (literal scope match).
window.KM.DB.generateWeeklyAiPlanDraft = function(payload) { return _kmWeeklyCommand_('weeklyAiPlan.generate', payload); };
// C2-D2 §13: whole-Draft Cancel (soft-cancel; idempotent — repeat returns benign already-cancelled).
window.KM.DB.cancelShippingAllocationDraft = function(payload) { return _kmWeeklyCommand_('cancelShippingAllocationDraft', payload); };
// C2-D2 §9: targeted READ-ONLY Allocation-Draft readback — reads ONLY the two draft tables server-side (never
// getOperationDb). Text-first classification; never throws. Returns { success, data:{status, draft, lines, issues}, errors }.
window.KM.DB.getShippingAllocationDraftWorkspace = async function(params) {
    if (!isOperationDbApiConfigured()) { return { success: false, data: null, error: { code: 'TRANSPORT_NOT_CONFIGURED', message: 'API not configured' } }; }
    var url = (window.KM && window.KM.DB && typeof window.KM.DB.getApiBaseUrl === 'function' && window.KM.DB.getApiBaseUrl()) || OP_DB_API_BASE_URL;
    var resp;
    try { resp = await fetch(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ action: 'getShippingAllocationDraftWorkspace' }, params || {})) }); }
    catch (netErr) { return { success: false, data: null, error: { code: 'HTTP_TRANSPORT_ERROR', message: String((netErr && netErr.message) || netErr) } }; }
    var text = ''; try { text = await resp.text(); } catch (e) { text = ''; }
    if (!resp.ok) return { success: false, data: null, error: { code: 'HTTP_TRANSPORT_ERROR', message: 'API HTTP ' + resp.status, details: { httpStatus: resp.status } } };
    var trimmed = String(text || '').trim();
    if (trimmed.charCodeAt(0) !== 123) return { success: false, data: null, error: { code: 'NON_JSON_RESPONSE', message: trimmed.slice(0, 120) } };
    var json; try { json = JSON.parse(trimmed); } catch (pe) { return { success: false, data: null, error: { code: 'NON_JSON_RESPONSE', message: 'parse error' } }; }
    return json;
};

// Batch upsert Site Confirmations. { confirmations: [ { planning_cycle, company, country,
//   marketplace, series, bucket, status?, note? } ], confirmed_by? } → { upserted, created, updated }.
// Records site-level approval only — does NOT create request_orders (Confirm Site ≠ Send Request).
window.KM.DB.upsertRequestOrderSiteConfirmations = async function(payload) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, upsertRequestOrderSiteConfirmations skipped'); return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertRequestOrderSiteConfirmations' }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert site confirmations failed');
    // Batch F: this PRIMARY surface (request-order.js _roLoadConfirmationsFromDb → getRequestOrderSiteConfirmations)
    // reads the broad-cache slice directly in EVERY mode (no scoped read-model), so keep just that ONE slice fresh
    // via a bounded targeted re-read instead of a whole-DB reload.
    await _kmRefreshCacheTables_(['request_order_site_confirmations']);
    return json.data;
};

// ---- Carrier Rate Card v1 — Template Export (client-side) + Import (append-only server write) ----

// Fixed columns the carrier must NOT edit (route/method/charge structure identity).
window.KM.DB.CARRIER_RATE_TEMPLATE_FIXED_COLS = [
    'carrier_id', 'carrier_name', 'origin_country', 'origin_city', 'destination_country', 'destination_city',
    'destination_postal_code_start', 'destination_postal_code_end', 'destination_warehouse_code',
    'marketplace', 'shipping_method', 'last_mile_delivery', 'charge_type', 'charge_unit', 'dim_divisor',
    'min_box_weight', 'min_box_weight_unit', 'weight_tier', 'weight_tier_unit', 'currency',
    'transit_type', 'battery_type', 'customs_type'
];
// Carrier-editable columns on EXISTING rows (Update Template §4C.3A). Server (17_) enforces this set;
// min_charge is LOCKED on existing rows (kept off this list on purpose).
window.KM.DB.CARRIER_RATE_TEMPLATE_EDITABLE_COLS = [
    'unit_rate', 'effective_from', 'effective_to', 'fuel_surcharge', 'customs_fee', 'doc_fee', 'status', 'note'
];
// Full template column order. `row_type` + `rate_card_id` first (helpers/identity). rate_card_id present =
// existing row (update); blank = new row (create). `row_type` is NOT persisted. NO Lead Time / transit_days.
window.KM.DB.CARRIER_RATE_TEMPLATE_COLS = ['row_type', 'rate_card_id'].concat(
    window.KM.DB.CARRIER_RATE_TEMPLATE_FIXED_COLS.slice(0, 20),   // through currency (structure; incl. last_mile_delivery)
    ['unit_rate', 'min_charge', 'fuel_surcharge', 'customs_fee', 'doc_fee'],
    ['transit_type', 'battery_type', 'customs_type', 'shipping_method_label', 'note', 'effective_from', 'effective_to', 'status']
);

// Build + download a Carrier Rate Template CSV from already-loaded rate-card rows (normalized).
// Two modes (opts.mode):
//   'update' (default) — weekly/monthly rate update: fixed route/method fields kept; the editable
//                        pricing/date fields unit_rate / effective_from / effective_to are CLEARED so the
//                        carrier only fills the new numbers.
//   'master'           — one-time full import / new-route setup: ALL columns exported WITH their current
//                        values (nothing cleared) so the user can edit any field and add new
//                        carrier / shipping_method / last_mile_delivery / warehouse / city / zip / country rows.
// Both modes include last_mile_delivery and NEVER include Lead Time / transit_days (those live in carrier_lead_times).
// Returns { rows, filename, mode }.
window.KM.DB.exportCarrierRateTemplate = function(rows, opts) {
    opts = opts || {};
    var mode = (opts.mode === 'master') ? 'master' : 'update';
    var cols = window.KM.DB.CARRIER_RATE_TEMPLATE_COLS;
    var carriers = (window.KM.DB.getCarriers && window.KM.DB.getCarriers()) || [];
    var nameById = {};
    carriers.forEach(function(c) { if (c.carrierId) nameById[c.carrierId] = c.carrierName; });
    function esc(v) {
        var s = String(v == null ? '' : v);
        return (/[",\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    // One example row (ignored on import). Master mode notes it is fully editable / new rows allowed.
    var example = {
        row_type: 'example', rate_card_id: '', carrier_id: 'CARRIER-EXAMPLE', carrier_name: 'Example Forwarder',
        origin_country: 'CN', origin_city: 'Shenzhen', destination_country: 'US', destination_city: 'Los Angeles',
        destination_postal_code_start: '', destination_postal_code_end: '', destination_warehouse_code: 'ONT8',
        marketplace: 'Amazon', shipping_method: 'Sea', last_mile_delivery: 'Parcel', charge_type: 'weight', charge_unit: 'kg',
        dim_divisor: '6000', min_box_weight: '', min_box_weight_unit: 'kg', weight_tier: '100', weight_tier_unit: 'kg',
        currency: 'USD', unit_rate: '3.50', min_charge: '150', fuel_surcharge: '', customs_fee: '', doc_fee: '',
        transit_type: 'door_to_door', battery_type: 'no_battery', customs_type: 'tax_refund_export',
        note: (mode === 'master'
            ? 'EXAMPLE ROW — ignored on import. MASTER template: every field is editable; add new carrier / shipping_method / last_mile_delivery / warehouse / city / zip / country rows below.'
            : 'EXAMPLE ROW — ignored on import'),
        effective_from: '2026-08-01', effective_to: '2026-12-31', status: 'active'
    };
    var master = (mode === 'master');
    var dataRows = (rows || []).map(function(r) {
        return {
            row_type: 'data',
            rate_card_id: r.rateCardId || '',   // present → existing row (update); blank → new row (create)
            carrier_id: r.carrierId, carrier_name: nameById[r.carrierId] || r.carrierName || '',
            origin_country: r.originCountry, origin_city: r.originCity,
            destination_country: r.destinationCountry, destination_city: r.destinationCity,
            destination_postal_code_start: r.destinationPostalCodeStart, destination_postal_code_end: r.destinationPostalCodeEnd,
            destination_warehouse_code: r.destinationWarehouseCode, marketplace: r.marketplace,
            shipping_method: r.shippingMethod, last_mile_delivery: r.lastMileDelivery, charge_type: r.chargeType, charge_unit: r.chargeUnit,
            dim_divisor: r.dimDivisor, min_box_weight: r.minBoxWeight, min_box_weight_unit: r.minBoxWeightUnit,
            weight_tier: r.weightTier, weight_tier_unit: r.weightTierUnit, currency: r.currency,
            // Update mode CLEARS the editable rate/date fields; master mode KEEPS existing values.
            unit_rate: master ? (r.unitRate != null ? r.unitRate : '') : '',
            min_charge: r.minCharge, fuel_surcharge: r.fuelSurcharge, customs_fee: r.customsFee, doc_fee: r.docFee,
            transit_type: r.transitType, battery_type: r.batteryType, customs_type: r.customsType,
            note: r.note,
            effective_from: master ? (r.effectiveFrom || '') : '',
            effective_to: master ? (r.effectiveTo || '') : '',
            status: r.status || 'active'
        };
    });
    var all = [example].concat(dataRows);
    var lines = [cols.join(',')].concat(all.map(function(row) { return cols.map(function(c) { return esc(row[c]); }).join(','); }));
    var csv = lines.join('\r\n');
    var filename = opts.filename || ('carrier_rate_' + mode + '_template_' + new Date().toISOString().slice(0, 10) + '.csv');
    try {
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e) { console.warn('[KM.DB] exportCarrierRateTemplate download failed:', e); }
    return { rows: all.length, filename: filename, mode: mode };
};

// Append-only import of parsed template rows → carrier_rate_cards (server-side validation).
// payload = { rows: [ {row_type, carrier_id, ...} ], columns?: [headers], source_file_name? }.
// Returns { imported, skipped_examples, rejected, batch_id, errors:[{row,message}] }; reloads DB.
window.KM.DB.importCarrierRateTemplate = async function(payload) {
    if (!isOperationDbApiConfigured()) { console.warn('[KM.DB] API not configured, importCarrierRateTemplate skipped'); return { success: false, error: 'API not configured' }; }
    var resp = await fetch(OP_DB_API_BASE_URL, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'importCarrierRateCards' }, payload)) });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Import carrier rate cards failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Request Order status transitions: { request_order_id, transition: submit|approve|reject|cancel|done,
//   rejected_reason?, actor? }. reject → draft (version +1 on resubmit); done sets completed_* (Approved only).
window.KM.DB.updateRequestOrderStatus = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateRequestOrderStatus skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updateRequestOrderStatus' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update request order status failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Edit request_order_lines (Draft only). Each line: { request_order_line_id, approved_qty?,
//   inspection_date?, expected_ready_date?, expected_ship_date?, note? }. Recomputes carton/est.
window.KM.DB.updateRequestOrderLineQty = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updateRequestOrderLineQty skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updateRequestOrderLineQty' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update request order line qty failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Cancel a tier/block by STATUS (soft): { request_order_line_ids: [ ... ], actor? }. Sets each line's
// line_status='cancelled'; if a parent request has no active line left, its status → cancelled.
window.KM.DB.cancelRequestOrderTier = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, cancelRequestOrderTier skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'cancelRequestOrderTier' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Cancel request order tier failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Convert an Approved Request Order into a Purchase Order (Procurement Commitment):
// { request_order_id, actor? }. Copies request → PO + lines; sets request status=converted_to_po.
window.KM.DB.createPurchaseOrderFromRequest = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, createPurchaseOrderFromRequest skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'createPurchaseOrderFromRequest' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Create purchase order failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Purchase Order status transitions: { purchase_order_id, transition: issue|confirm|start_production|
//   ready_to_ship|complete|cancel, actor?, expected_ready_date?, confirmed_ready_date?, note? }.
window.KM.DB.updatePurchaseOrderStatus = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updatePurchaseOrderStatus skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updatePurchaseOrderStatus' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    // F1-7N-FB-3A §I — throw WITH the envelope so the page can render the document-gate cause it already knows
    // how to render, instead of only the generic sentence.
    if (!json.success) throw _kmWriterError_(json, 'Update purchase order status failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Edit purchase_order_lines fields (e.g. ordered_qty / unit_cost / note): { lines: [ { purchase_order_line_id, ordered_qty?, unit_cost?, note? } ] }.
window.KM.DB.updatePurchaseOrderLine = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updatePurchaseOrderLine skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updatePurchaseOrderLine' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update purchase order line failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Edit PO Overview execution HEADER fields on purchase_orders (by purchase_order_id):
//   { purchase_order_id, inspection_date?, expected_completion_date?, expected_ship_date?, deposit_due_date?, note?,
//     deposit_amount?, balance_amount?, paid_amount?, payment_status?, actor? }.
// Writes purchase_orders only (never request_orders / lines). Dates saved date-only. supplier_*_ready_date
// are NOT touched here.
window.KM.DB.updatePurchaseOrderHeader = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, updatePurchaseOrderHeader skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'updatePurchaseOrderHeader' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Update purchase order header failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// PO Workspace Receive flow: receive produced/received qty against purchase_order_lines.
//   { purchase_order_id, lines: [ { purchase_order_line_id, receive_qty } ], actor? }.
// Per line completed_qty += receive_qty (clamped to remaining), remaining_qty = ordered − completed;
// PO order_status recomputed to completed / partial_completed. Writes purchase_orders /
// purchase_order_lines ONLY (never request orders / shipments / inventory / factory stock).
window.KM.DB.receivePurchaseOrderLines = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, receivePurchaseOrderLines skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'receivePurchaseOrderLines' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Receive purchase order lines failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// ========================================
// FC Summary write path (Phase 1) — Special Events + Target % Rules.
// upsert = create when id missing, update when id present. delete = hard delete by id.
// All reload the Operation DB on success (getFcSpecialEvents / getFcTargetRules then reflect it).
// ========================================

// { event_id?, company, country, marketplace, scope_type?, scope_id?, sku, series?, category?,
//   event_name, event_period?, event_month?, year?, fc_qty, note?, actor? }
// Campaign header upsert (Special Event Builder step 1). Idempotent by campaign_id, else by
// company|country|marketplace|campaign_name|year. Returns { campaign_id, created }.
// { campaign_id?, company, marketplace_id?, campaign_name, country, marketplace, promotion_type?,
//   event_flag?, year?, start_date?, end_date?, status?, source? }
window.KM.DB.upsertCampaign = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertCampaign skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertCampaign' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert campaign failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Campaign SKU lines batch upsert (step 2). Idempotent per line by campaign_sku_line_id, else
// campaign_id + marketplace_sku_id (or + sku). { campaign_id, lines:[...] } → { lines:[{campaign_sku_line_id,sku,created}] }.
window.KM.DB.upsertCampaignSkuLines = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertCampaignSkuLines skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertCampaignSkuLines' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert campaign_sku_lines failed');
    await _kmWriterPostWrite_();
    return json.data;
};

window.KM.DB.upsertFcSpecialEvent = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertFcSpecialEvent skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertFcSpecialEvent' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert special event failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// Batch upsert of special-event forecasts (Special-Event inline edit). One request; reloads on success.
// payload rows: [{ event_fc_id, campaign_id, event_name, sku, fc_qty }]
window.KM.DB.importFcSpecialEventsBatch = async function(rows, options) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, importFcSpecialEventsBatch skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'importFcSpecialEventsBatch', rows: rows || [], options: options || {} })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (json && json.success) { await _kmWriterPostWrite_(); }
    return json;
};

// { event_id }
window.KM.DB.deleteFcSpecialEvent = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, deleteFcSpecialEvent skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'deleteFcSpecialEvent' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Delete special event failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// { target_rule_id?, company?, country?, marketplace?, scope_type, scope_id, year?, category?,
//   series?, sku?, target_percentage?, jan_pct..dec_pct, note?, actor? }
window.KM.DB.upsertFcTargetRule = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, upsertFcTargetRule skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'upsertFcTargetRule' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Upsert target rule failed');
    await _kmWriterPostWrite_();
    return json.data;
};

// { target_rule_id }
window.KM.DB.deleteFcTargetRule = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, deleteFcTargetRule skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'deleteFcTargetRule' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (!json.success) throw new Error(json.error || 'Delete target rule failed');
    await _kmWriterPostWrite_();
    return json.data;
};

window.KM.DB.importMarketplaceSkusBatch = async function(rows, options) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, importMarketplaceSkusBatch skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            action: 'importMarketplaceSkusBatch',
            rows: rows || [],
            options: options || {}
        })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    // Reload DB only after a successful import; return the full API result either way.
    if (json && json.success) {
        await _kmWriterPostWrite_();
    }
    return json;
};

window.KM.DB.importFcRegularForecastBatch = async function(rows, options) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, importFcRegularForecastBatch skipped');
        return { success: false, error: 'API not configured' };
    }
    var opts = Object.assign({ forecastStatusDefault: 'draft', sourceDefault: 'import' }, options || {});
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            action: 'importFcRegularForecastBatch',
            rows: rows || [],
            options: opts
        })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    // Reload DB only after a successful import; return the full API result either way.
    if (json && json.success) {
        await _kmWriterPostWrite_();
    }
    return json;
};

// ========================================
// overseas_inventory_snapshot / movements Write Methods
// ========================================

window.KM.DB.importOverseasInventorySnapshotBatch = async function(rows, options) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, importOverseasInventorySnapshotBatch skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
            action: 'importOverseasInventorySnapshotBatch',
            rows: rows || [],
            options: options || {}
        })
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (json && json.success) {
        await _kmWriterPostWrite_();
    }
    return json;
};

window.KM.DB.adjustOverseasInventory = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, adjustOverseasInventory skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'adjustOverseasInventory' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (json && json.success) {
        await _kmWriterPostWrite_();
    }
    return json;
};

// Factory Inventory Adjustment (2026-07-23). Writes factory_stock (fac_current_stock only) + one
// factory_stock_movements row atomically on the backend. Frontend sends the NEW available only;
// the backend computes qty and generates all ids/timestamps. On success the DB cache is reloaded
// so the snapshot + movement log re-render from the real tables (never a front-end-only patch).
window.KM.DB.adjustFactoryInventory = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, adjustFactoryInventory skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'adjustFactoryInventory' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    var json = await resp.json();
    if (json && json.success) {
        await _kmWriterPostWrite_();
    }
    return json;
};

// ========================================
// F0-HOTFIX-FI1 — Factory Inventory Initial Stock Import (SET_CURRENT_STOCK).
// Two decoupled actions: validate (server-computed preview; ZERO writes) and commit (atomic write). Neither
// auto-reloads the whole Operation DB — the ACK is decoupled from the READBACK (§16). After a committed ack
// the page calls refreshFactoryStockTables() (a TARGETED per-table GET, never a whole-DB reload).
// ========================================
window.KM.DB.factoryInventoryImportValidate = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, factoryInventoryImportValidate skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'factoryInventory.import.validate' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    return await resp.json();   // preview only — NO cache reload (read-only validate)
};

window.KM.DB.factoryInventoryImportCommit = async function(payload) {
    if (!isOperationDbApiConfigured()) {
        console.warn('[KM.DB] API not configured, factoryInventoryImportCommit skipped');
        return { success: false, error: 'API not configured' };
    }
    var resp = await fetch(OP_DB_API_BASE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ action: 'factoryInventory.import.commit' }, payload))
    });
    if (!resp.ok) throw new Error('API returned ' + resp.status);
    // Decoupled: return the commit ACK verbatim. The caller performs a targeted readback separately, so a
    // readback failure never masks a committed write and never triggers a blind resend.
    return await resp.json();
};

// TARGETED readback (§16) — re-GET ONLY factory_stock + factory_stock_movements and patch the in-memory
// cache in place. Never loadOperationDb({force:true}) (no whole-DB reload). Throws on fetch failure so the
// caller can show "Import committed. Reconfirming Factory Inventory…" without resending the commit.
window.KM.DB.refreshFactoryStockTables = async function() {
    if (!isOperationDbApiConfigured()) return { success: false, error: 'API not configured' };
    var stockRows = await getOperationDbTableFromSheet('factory_stock');
    var movementRows = await getOperationDbTableFromSheet('factory_stock_movements');
    if (!window._opDbCache) window._opDbCache = {};
    window._opDbCache.factoryStock = (stockRows || []).map(normalizeFactoryStockRecord).filter(function(r) { return r.factoryStockId || r.sku; });
    window._opDbCache.factoryStockMovements = (movementRows || []).map(normalizeFactoryStockMovementRecord).filter(function(r) { return r.movementId || r.sku; });
    // F1-7N-FA-3C-R6C — same scoped-cache-poisoning fix: this readback fetched live sheet tables, so mark the source
    // (never leave a populated cache unmarked → the missing-marker default would strip scoped-read eligibility).
    if (window._opDbCache._sourceMode !== 'mock') window._opDbCache._sourceMode = 'google-sheet';
    return { success: true, factoryStock: window._opDbCache.factoryStock.length, factoryStockMovements: window._opDbCache.factoryStockMovements.length };
};

// ========================================
// Debug & Reload Helpers
// ========================================

window.debugOperationDb = function() {
    var mode = getOperationDbDataSourceMode();
    console.log('=== Operation DB Debug ===');
    console.log('Data Source Mode:', mode);
    console.log('Last Loaded At:', OperationDbState.lastLoadedAt || 'never');
    console.log('Last Fetch URL:', OperationDbState.lastFetchUrl || 'none');
    console.log('Last Fetch Status:', OperationDbState.lastFetchStatus || 'none');
    console.log('Last Error:', OperationDbState.lastError || 'none');
    console.log('API Configured:', isOperationDbApiConfigured());
    if (!window._opDbCache) { console.log('DB not loaded yet.'); return; }
    console.log('sku_details count:', (window._opDbCache.skuDetails || []).length);
    console.log('product_features count:', (window._opDbCache.productFeatures || []).length);
    console.log('sku_handbook_summaries count:', (window._opDbCache.skuHandbookSummaries || []).length);
    console.log('sku_knowledge_items count:', window.KM.DB.getSkuKnowledgeItems().length);
    console.log('campaigns count:', (window._opDbCache.campaigns || []).length);
    console.log('campaign_sku_lines count:', (window._opDbCache.campaignSkuLines || []).length);
    console.log('marketplaces count:', (window._opDbCache.marketplaces || []).length);
    console.log('marketplace_skus count:', (window._opDbCache.marketplaceSkus || []).length);
    console.log('pricing_list count:', (window._opDbCache.pricingList || []).length);
    console.log('pricing_change_log count:', (window._opDbCache.pricingChangeLog || []).length);
    console.log('fc_regular_forecast count:', (window._opDbCache.fcRegularForecast || []).length);
    console.log('factory_stock count:', (window._opDbCache.factoryStock || []).length);
    // Language distribution
    var langDist = {};
    (window._opDbCache.productFeatures || []).forEach(function(pf) {
        var lang = pf.language || 'unknown';
        langDist[lang] = (langDist[lang] || 0) + 1;
    });
    console.log('product_features language distribution:', langDist);
    console.log('--- sku_details (first 5) ---');
    console.table((window._opDbCache.skuDetails || []).slice(0, 5).map(function(r) { var c = Object.assign({}, r); delete c.raw; return c; }));
    console.log('--- product_features (first 5) ---');
    console.table((window._opDbCache.productFeatures || []).slice(0, 5).map(function(r) { var c = Object.assign({}, r); delete c.raw; return c; }));
    console.log('--- sku_knowledge_items (first 5) ---');
    var ki = window.KM.DB.getSkuKnowledgeItems().slice(0, 5).map(function(r) {
        return { sku: r.sku, productName: r.productName, lifecycle: r.lifecycle, pfMatch: r.pfMatchLevel, summarySource: r.summarySource, keyPointsSource: r.keyPointsSource, summary: (r.displaySummary || '').substring(0, 60) };
    });
    console.table(ki);
    console.log('=== End Debug ===');
};

window.reloadOperationDb = async function(options) {
    console.log('[OP DB] Reloading (force)...');
    window._opDbCache = null;
    await loadOperationDb({ force: true });   // explicit manual/debug whole-DB reload (NOT a writer path)
    if (window.renderSkuDetailsTable) renderSkuDetailsTable();
    if (window.renderSkuHandbook) renderSkuHandbook();
    console.log('[OP DB] Reload complete. Mode:', getOperationDbDataSourceMode(), 'SKUs:', (window._opDbCache.skuDetails || []).length, 'at', OperationDbState.lastLoadedAt);
};

window.debugSkuById = function(sku) {
    if (!sku) { console.log('Usage: debugSkuById("CO1100-R")'); return; }
    console.log('=== Debug SKU:', sku, '===');
    console.log('dataSourceMode:', getOperationDbDataSourceMode());
    var dbItems = window.KM.DB.getSkuDetails();
    var dbItem = dbItems.find(function(i) { return i.sku === sku; });
    console.log('1. Normalized SKU data:', dbItem || 'NOT FOUND');
    if (!dbItem) { console.log('=== End Debug SKU ==='); return; }
    // F1-S1: lifecycle authority = sku_details.lifecycle (no browser override).
    console.log('2. Lifecycle (sku_details authority):', dbItem.lifecycle || 'none');
    var imgOverrides = getSkuImageOverrides();
    console.log('3. Image override:', imgOverrides[sku] || 'none');
    console.log('4. Final lifecycle:', getNormalizedSkuStatus(dbItem));
    console.log('5. Final image:', getNormalizedSkuImage(dbItem));
    // Product feature match
    var pfs = window._opDbCache ? (window._opDbCache.productFeatures || []) : [];
    var pf = getProductFeatureForSku(dbItem, pfs);
    var matchLevel = 'none';
    if (pf) {
        var skuLc = dbItem.sku.trim().toLowerCase();
        var seriesLc = (dbItem.series || '').trim().toLowerCase();
        if (pf.scopeType === 'sku' && pf.scopeId.toLowerCase() === skuLc) matchLevel = 'sku';
        else if (pf.scopeType === 'series' && pf.scopeId.toLowerCase() === seriesLc) matchLevel = 'series';
        else matchLevel = 'category';
    }
    console.log('6. Product feature match:', pf ? { scopeType: pf.scopeType, scopeId: pf.scopeId, matchLevel: matchLevel, language: pf.language, title: (pf.productTitle || '').substring(0, 60) } : 'none');
    // Handbook summary
    var summaries = window._opDbCache ? (window._opDbCache.skuHandbookSummaries || []) : [];
    var allMatches = summaries.filter(function(s) { return s.sku.toLowerCase() === sku.toLowerCase(); });
    var summary = allMatches.find(function(s) { return s.reviewStatus === 'reviewed'; })
        || allMatches.find(function(s) { return s.reviewStatus === 'ai_draft'; })
        || allMatches[0] || null;
    console.log('7. Handbook summary:', summary || 'none (empty)');
    // Build knowledge item for this SKU
    var knowledgeItems = buildSkuKnowledgeItems([dbItem], pfs, summaries);
    var ki = knowledgeItems[0];
    console.log('8. displaySummary:', (ki.displaySummary || '').substring(0, 120));
    console.log('9. summarySource:', ki.summarySource);
    console.log('10. displayKeyPoints:', ki.displayKeyPoints);
    console.log('11. keyPointsSource:', ki.keyPointsSource);
    console.log('12. pfMatchLevel:', ki.pfMatchLevel);
    console.log('13. productFeature.language:', pf ? pf.language : 'n/a');
    console.log('=== End Debug SKU ===');
};

window.testUpdateSkuLifecycle = async function(sku, lifecycle) {
    console.log('[Test] Updating', sku, 'to', lifecycle);
    try {
        var result = await window.KM.DB.updateSkuLifecycle(sku, lifecycle);
        console.log('[Test] Success:', result);
        window.debugSkuById(sku);
    } catch (err) {
        console.error('[Test] Failed:', err.message);
    }
};

// ========================================
// Expose normalize functions for testing
// ========================================
window.normalizeSkuDetailsRecord = normalizeSkuDetailsRecord;
window.normalizeProductFeatureRecord = normalizeProductFeatureRecord;
window.normalizeSkuHandbookSummaryRecord = normalizeSkuHandbookSummaryRecord;
window.normalizeCampaignRecord = normalizeCampaignRecord;
window.normalizeCampaignSkuLineRecord = normalizeCampaignSkuLineRecord;
window.normalizeOperationDb = normalizeOperationDb;
window.buildSkuKnowledgeItems = buildSkuKnowledgeItems;
window.getProductFeatureForSku = getProductFeatureForSku;
window.isOperationDbApiConfigured = isOperationDbApiConfigured;


// ========================================
// SKU Handbook Data Audit Helper
// ========================================

window.auditSkuHandbookData = function() {
    console.log('=== SKU Handbook Data Audit ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Data Source Mode:', getOperationDbDataSourceMode());
    console.log('');

    if (!window._opDbCache) { console.log('DB not loaded. Run reloadOperationDb() first.'); return; }

    var skuDetails = window._opDbCache.skuDetails || [];
    var productFeatures = window._opDbCache.productFeatures || [];
    var summaries = window._opDbCache.skuHandbookSummaries || [];
    var knowledgeItems = window.KM.DB.getSkuKnowledgeItems();

    // === A. Table Counts ===
    console.log('--- 1. Table Counts ---');
    console.log('sku_details:', skuDetails.length);
    console.log('product_features:', productFeatures.length);
    console.log('sku_handbook_summaries:', summaries.length);
    console.log('sku_knowledge_items:', knowledgeItems.length);
    console.log('');

    // === B. Product Feature Match Coverage ===
    console.log('--- 2. Product Feature Coverage ---');
    var matchCounts = { sku: 0, series: 0, category: 0, none: 0 };
    var noMatchItems = [];
    knowledgeItems.forEach(function(ki) {
        var level = ki.pfMatchLevel || 'none';
        matchCounts[level] = (matchCounts[level] || 0) + 1;
        if (level === 'none') {
            noMatchItems.push({ sku: ki.sku, productName: ki.productName, category: ki.category || ki.productLine, series: ki.series, lifecycle: ki.lifecycle });
        }
    });
    console.log('Match by SKU:', matchCounts.sku);
    console.log('Match by Series:', matchCounts.series);
    console.log('Match by Category:', matchCounts.category);
    console.log('No match:', matchCounts.none);
    if (noMatchItems.length > 0) {
        console.log('SKUs without product_features (first 30):');
        console.table(noMatchItems.slice(0, 30));
    }
    console.log('');

    // === C. Unused Product Features ===
    console.log('--- 3. Unused Product Features ---');
    var usedPfIds = new Set();
    knowledgeItems.forEach(function(ki) {
        if (ki.productFeature) usedPfIds.add(ki.productFeature);
    });
    var unusedPfs = productFeatures.filter(function(pf) { return !usedPfIds.has(pf); });
    console.log('Unused product_features count:', unusedPfs.length);
    if (unusedPfs.length > 0) {
        console.table(unusedPfs.map(function(pf) {
            return { featureId: pf.featureId, scopeType: pf.scopeType, scopeId: pf.scopeId, country: pf.country, marketplace: pf.marketplace, language: pf.language, productTitle: (pf.productTitle || '').substring(0, 50) };
        }));
    }
    console.log('');

    // === D. Missing Summary / Key Points ===
    console.log('--- 4. Missing Content ---');
    var missingSummary = knowledgeItems.filter(function(ki) { return ki.summarySource === 'none'; });
    var missingKeyPoints = knowledgeItems.filter(function(ki) { return ki.keyPointsSource === 'none'; });
    console.log('SKUs with no displaySummary:', missingSummary.length);
    if (missingSummary.length > 0) {
        console.table(missingSummary.slice(0, 30).map(function(ki) {
            return { sku: ki.sku, productName: ki.productName, category: ki.category, series: ki.series, matchLevel: ki.pfMatchLevel, summarySource: ki.summarySource, keyPointsSource: ki.keyPointsSource };
        }));
    }
    console.log('SKUs with no displayKeyPoints:', missingKeyPoints.length);
    if (missingKeyPoints.length > 0 && missingKeyPoints.length !== missingSummary.length) {
        console.table(missingKeyPoints.slice(0, 30).map(function(ki) {
            return { sku: ki.sku, productName: ki.productName, category: ki.category, series: ki.series, matchLevel: ki.pfMatchLevel, summarySource: ki.summarySource, keyPointsSource: ki.keyPointsSource };
        }));
    }
    console.log('');

    // === E. Selling Material ===
    console.log('--- 5. Selling Material ---');
    var sellingMaterials = knowledgeItems.filter(function(ki) { return ki.isSellingMaterial; });
    console.log('Selling Material SKU count:', sellingMaterials.length);
    if (sellingMaterials.length > 0) {
        console.table(sellingMaterials.map(function(ki) {
            return { sku: ki.sku, productName: ki.productName, category: ki.category, series: ki.series, lifecycle: ki.lifecycle, hasProductFeature: !!ki.productFeature, summarySource: ki.summarySource };
        }));
    }
    console.log('');

    // === F. Image URL Check ===
    console.log('--- 6. Image URL Format ---');
    var imgEmpty = 0, imgRelative = 0, imgAbsolute = 0;
    skuDetails.forEach(function(s) {
        var img = s.image || '';
        if (!img) imgEmpty++;
        else if (img.startsWith('http://') || img.startsWith('https://')) imgAbsolute++;
        else imgRelative++;
    });
    console.log('Empty:', imgEmpty);
    console.log('Relative path:', imgRelative);
    console.log('Absolute URL:', imgAbsolute);
    console.log('');

    // === G. Lifecycle Distribution ===
    console.log('--- 7. Lifecycle Distribution ---');
    var lcDist = {};
    var invalidLc = [];
    var validLc = ['Upcoming SKU', 'Running in the Market', 'Phasing Out', 'Closure', 'Other'];
    skuDetails.forEach(function(s) {
        var lc = s.lifecycle || '(empty)';
        lcDist[lc] = (lcDist[lc] || 0) + 1;
        if (validLc.indexOf(lc) === -1 && lc !== '(empty)') {
            invalidLc.push({ sku: s.sku, lifecycle: lc });
        }
    });
    console.log(lcDist);
    if (invalidLc.length > 0) {
        console.log('Invalid lifecycle values:');
        console.table(invalidLc);
    }
    console.log('');

    // === H. Language Distribution ===
    console.log('--- 8. Product Features Language Distribution ---');
    var langDist = {};
    productFeatures.forEach(function(pf) {
        var lang = pf.language || '(empty)';
        langDist[lang] = (langDist[lang] || 0) + 1;
    });
    console.log(langDist);
    console.log('');

    // === I. Duplicate SKU Check ===
    console.log('--- 9. Duplicate Checks ---');
    var skuCount = {};
    skuDetails.forEach(function(s) { skuCount[s.sku] = (skuCount[s.sku] || 0) + 1; });
    var dupSkus = Object.entries(skuCount).filter(function(e) { return e[1] > 1; });
    console.log('Duplicate SKUs:', dupSkus.length);
    if (dupSkus.length > 0) {
        console.table(dupSkus.map(function(e) { return { sku: e[0], count: e[1] }; }));
    }

    // === J. Duplicate Product Feature Scope ===
    var pfScopeCount = {};
    productFeatures.forEach(function(pf) {
        var key = [pf.scopeType, pf.scopeId, pf.country, pf.marketplace, pf.language].join('|');
        pfScopeCount[key] = (pfScopeCount[key] || 0) + 1;
    });
    var dupPfScopes = Object.entries(pfScopeCount).filter(function(e) { return e[1] > 1; });
    console.log('Duplicate product_features scopes:', dupPfScopes.length);
    if (dupPfScopes.length > 0) {
        console.table(dupPfScopes.map(function(e) {
            var parts = e[0].split('|');
            return { scopeType: parts[0], scopeId: parts[1], country: parts[2], marketplace: parts[3], language: parts[4], count: e[1] };
        }));
    }
    console.log('');

    // === Summary ===
    console.log('--- 10. Recommended Fixes ---');
    if (matchCounts.none > 0) console.log('- Add product_features for ' + matchCounts.none + ' SKUs without coverage (by series or category).');
    if (missingSummary.length > 0) console.log('- ' + missingSummary.length + ' SKUs have no summary content. Add product_features or sku_handbook_summaries.');
    if (imgEmpty > 0) console.log('- ' + imgEmpty + ' SKUs have no image_url. Add image paths to Google Sheet.');
    if (dupSkus.length > 0) console.log('- ' + dupSkus.length + ' duplicate SKUs found in sku_details. Clean up Google Sheet.');
    if (dupPfScopes.length > 0) console.log('- ' + dupPfScopes.length + ' duplicate product_features scopes. May cause wrong feature matching.');
    if (invalidLc.length > 0) console.log('- ' + invalidLc.length + ' SKUs have non-standard lifecycle values. Standardize in Google Sheet.');
    if (matchCounts.none === 0 && missingSummary.length === 0 && imgEmpty === 0 && dupSkus.length === 0) {
        console.log('All checks passed. Data looks healthy!');
    }
    console.log('');
    console.log('=== End Audit ===');
};


// ========================================
// Legacy SKU Override Debug Helper
// ========================================

window.debugLegacySkuOverrides = function() {
    console.log('=== Legacy SKU Overrides Debug ===');
    var lcOverrides = {};
    var imgOverrides = {};
    var dataOverrides = {};
    try { lcOverrides = JSON.parse(localStorage.getItem('km_sku_lifecycle_overrides_v1')) || {}; } catch(e) {}
    try { imgOverrides = JSON.parse(localStorage.getItem('km_sku_image_overrides_v1')) || {}; } catch(e) {}
    try { dataOverrides = JSON.parse(localStorage.getItem('km_sku_data_overrides_v1')) || {}; } catch(e) {}

    var lcCount = Object.keys(lcOverrides).length;
    var imgCount = Object.keys(imgOverrides).length;
    var dataCount = Object.keys(dataOverrides).length;

    console.log('Lifecycle overrides:', lcCount);
    console.log('Image overrides:', imgCount);
    console.log('Imported SKU data overrides:', dataCount);

    if (lcCount > 0) {
        console.log('--- Lifecycle overrides (first 10) ---');
        console.table(Object.entries(lcOverrides).slice(0, 10).map(function(e) { return { sku: e[0], lifecycle: e[1].lifecycle, updatedAt: e[1].updatedAt }; }));
    }
    if (imgCount > 0) {
        console.log('--- Image overrides (first 10) ---');
        console.table(Object.entries(imgOverrides).slice(0, 10).map(function(e) { return { sku: e[0], image: e[1].image, updatedAt: e[1].updatedAt }; }));
    }
    if (dataCount > 0) {
        console.warn('[Warning] Legacy imported SKU records detected in localStorage. These may create phantom SKUs. Run resetSkuHandbookOverrides() to clear after confirming migration.');
        console.log('--- Imported SKU data overrides (first 10) ---');
        console.table(Object.entries(dataOverrides).slice(0, 10).map(function(e) { return { sku: e[0], productName: e[1].productName || '', lifecycle: e[1].status || e[1].lifecycle || '', updatedAt: e[1].updatedAt || '' }; }));
    }
    if (lcCount === 0 && imgCount === 0 && dataCount === 0) {
        console.log('No legacy overrides found. Clean state.');
    }
    console.log('=== End ===');
};
