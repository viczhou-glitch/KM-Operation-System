// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R5 — AI PLAN ADVICE BOUNDARY, TRANSIT-SAFE METHOD, RUNTIME AUTHORITY
// ----------------------------------------------------------------------------------------------------------------
// R4 ended by reporting STOP for an entire AI Plan because one lane had no Carrier Rate Card. The quantity was
// right, the source was right, the required-by date was right, and all of it was discarded with the verdict.
// That is the wrong product boundary: the AI Plan is decision support, and a decision-support tool that refuses
// to advise because someone else's price list is incomplete has stopped doing its job in order to police data
// it does not own.
//
// TWO COUPLINGS WERE MEASURED BEFORE ANY CODE WAS WRITTEN, AND ONLY ONE OF THEM EXISTED.
//
//   * "marketplace is a required join key for international lead times" — IT IS NOT, and never was. The
//     lead-time DTO has no marketplace field at all and KMRA.leadDays joins on method + origin + destination +
//     last-mile. CN->US Amazon and CN->US Shopify already shared their transit authority. Reporting this as a
//     defect and "fixing" it would have been inventing work; the round's job here is to prove the property and
//     to keep it by construction.
//
//   * "a Rate Card is required to obtain a method" — IT WAS, and this is the real coupling. Measured:
//     KMRA.eligibleMethods over zero rate cards returns [], and route derivation refused before it ever
//     consulted a lead time. So the marketplace axis that RATE CARDS carry was transitively gating a transit
//     fact that has no marketplace axis at all. That is how a marketplace-independent property came to look
//     marketplace-specific.
//
// AND THE SAFETY RULE IS DELIBERATELY PESSIMISTIC. A method is SAFE only when `max_days + buffer <
// days_until_stockout`. Using min_days, or avg alone, calls a 28-day service safe against 30 days of supply —
// a stockout dressed as a plan. There was no existing buffer authority anywhere in the repository, so one is
// declared, and it is PROVISIONAL: every recommendation it produces carries that fact, and activation must not
// proceed on it.
//
// Run: node assets/tests/ai-plan-advice-boundary-transit-safe-method-f1-7n-fc-1b-e3-r4-a2-r1-r5.test.js
// ================================================================================================================
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
var neg = { caught: 0, missed: 0 };
function ok(c, l) { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.error('FAIL ' + l); } }
function eq(a, e, l) {
  var A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('ok   ' + l); }
  else { fail++; console.error('FAIL ' + l + '\n  exp ' + E + '\n  got ' + A); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function mut(label, f) {
  var r;
  try { r = f(); } catch (e) { neg.missed++; fail++; console.error('FAIL ' + label + ' — PROBE ERROR: ' + (e && e.message)); return; }
  if (r === true) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}
var ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
var GS = 'assets/specs/active/apps-script/';
function extractFn(src, name) {
  var re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  var m = re.exec(src); if (!m) throw new Error('not found: ' + name);
  var start = m.index, i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
function swap(src, find, repl) {
  var CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  var eol = src.indexOf(CR + LF) >= 0 ? (CR + LF) : LF;
  function fxe(t) { return String(t).split(CR + LF).join(LF).split(LF).join(eol); }
  find = fxe(find); repl = fxe(repl);
  if (src.indexOf(find) < 0) throw new Error('mutation target absent: ' + find.slice(0, 90));
  return src.replace(find, repl);
}

var G16 = read(GS + '16_shipping_allocation_handlers.gs');
var G61 = read(GS + '61_api_v1_weekly_ai_plan.gs');
var G63 = read(GS + '63_api_v1_system_health.gs');
var G43 = read(GS + '43_api_v1_gap_materialization.gs');
var G46 = read(GS + '46_api_v1_gap_materialization_job.gs');
var G47 = read(GS + '47_api_v1_recommendation_generation.gs');
var G13 = read(GS + '13_procurement_handlers.gs');
var G17 = read(GS + '17_carrier_handlers.gs');
var G02 = read(GS + '02_core_sheet_db.gs');
var CFG = read(GS + '00_config.gs');
var TEMP = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var RO = require('./_release-order.js');

// ================================================================================================================
// THE HARNESS. Only the spreadsheet and the recommendation-workspace TRANSPORT are simulated. Everything under
// test is shipped source: the real harvest, the real KMAF/KMWRB/KMWRR core, the real allocated-line adapter, the
// real K2 plan builder, the real atomic writer and the real census.
//
// 42_api_v1_recommendation_workspace.gs owns the workspace and pulls the whole KMPS/KMPA stack behind it. This
// round changes nothing in it, so its RESPONSE is supplied in the exact documented line shape 61_ reads
// (sku, siteSku, marketplaceId, destinationType, fulfillmentModel, horizons[], sourceDataAsOf) and nothing else.
// That is a transport double, and it is labelled as one: no claim in this file rests on it being production.
// ================================================================================================================
function FakeSheet(headers) { this.rows = [headers.slice()]; }
FakeSheet.prototype.getLastColumn = function () { return this.rows[0].length; };
FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
FakeSheet.prototype.getDataRange = function () { var s = this; return { getValues: function () { return s.rows.map(function (r) { return r.slice(); }); } }; };
FakeSheet.prototype.appendRow = function (r) { this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (row, col, nr, nc) {
  var s = this;
  return {
    getValues: function () { var o = []; for (var i = 0; i < (nr || 1); i++) { var l = []; for (var j = 0; j < (nc || 1); j++) l.push(s.rows[row - 1 + i][col - 1 + j]); o.push(l); } return o; },
    setValues: function (v) { for (var i = 0; i < v.length; i++) for (var j = 0; j < v[i].length; j++) s.rows[row - 1 + i][col - 1 + j] = v[i][j]; },
    getValue: function () { return s.rows[row - 1][col - 1]; },
    setValue: function (v) { s.rows[row - 1][col - 1] = v; }
  };
};

// The live scope under controlled activation, and the live numbers.
var TARGET = { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' };
var SUGGESTED = 760, UPC = 20, D30 = 200, D90 = 560;   // 200 + 560 = 760, both whole-carton at UPC 20
var THREE_PL = 'WH-RESUS-US-3PL-AMZLGS', FACTORY_CN = 'WH-TW-CN-FACTORY-YOUXIN';
// §1 — the live facts, verbatim. Nothing in this file may restate them.
var REQUIRED_BY = '2026-12-03';       // live: required by
var THREE_PL_LIVE = 3120;             // live: WH-RESUS-US-3PL-AMZLGS available quantity
// Every carrier row this file creates is labelled, in the data itself, as fixture material. §6.B and §8.11
// both turn on the label being present and readable — a fixture card must never be mistakable for the
// production master data the round is asking a person to supply.
var FIXTURE_NOTE = 'FIXTURE_ONLY_NOT_PRODUCTION_MASTER_DATA';
var TAIPEI_MIDNIGHT = new Date(Date.UTC(2026, 8, 3, 16, 0, 0));   // 2026-09-04 00:00 Asia/Taipei
var RUN_ID = 'GAP-INV-20260904T132342-0001';
// Every table an AI generation must NOT touch, present and empty so "nothing was written here" is measured.
var UNRELATED = ['shipping_plans', 'shipping_plan_lines', 'shipments', 'shipment_lines',
  'factory_stock_movements', 'reservations', 'purchase_orders', 'purchase_order_lines'];

function build(opts) {
  opts = opts || {};
  // §3/§12 — the tranche's urgency is the variable the safety rule turns on, so it is settable per build.
  var REQ = opts.requiredBy || REQUIRED_BY;
  var FOREIGN = [];
  var nForeign = (opts.foreignSkus === undefined) ? 45 : opts.foreignSkus;
  for (var fi = 1; fi <= nForeign; fi++) FOREIGN.push('FS-' + (1000 + fi));
  var ALLSKUS = [TARGET.sku].concat(FOREIGN);

  var SHEETS = {};
  var SS = { getSheetByName: function (n) { return SHEETS[n] || null; }, getId: function () { return 'FAKE_DB'; } };
  var sb = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number, Object: Object,
    Array: Array, isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt, Error: Error,
    RegExp: RegExp, Boolean: Boolean, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent
  };
  sb.global = sb;
  sb.SpreadsheetApp = { openById: function () { return SS; }, getActiveSpreadsheet: function () { return SS; } };
  sb.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
  var uuid = 0;
  sb.Utilities = { getUuid: function () { uuid++; return ('UUID' + uuid + 'ABCDEF0123456789').substring(0, 16); },
    formatDate: function (d) { return String(d); } };
  sb.Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };
  var PROPS = {};
  sb.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { return PROPS[k] === undefined ? null : PROPS[k]; },
    setProperty: function (k, v) { PROPS[k] = v; return this; },
    deleteProperty: function (k) { delete PROPS[k]; return this; } }; } };
  var LOG = [];
  sb.Logger = { log: function (m) { LOG.push(String(m)); } };
  sb.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (t) {
      var _t = String(t), _m = null;
      var o = { getContent: function () { return _t; }, getMimeType: function () { return _m; },
        setMimeType: function (m) { _m = m; return o; } };
      return o;
    }
  };
  var ctx = vm.createContext(sb);
  var SRC = { bundle: read(GS + '90_generated_supply_planning_bundle.gs'), cfg: CFG,
    ric: read(GS + '69_api_v1_route_identity_contract.gs'), aipl: read(GS + '69_api_v1_ai_plan_lifecycle.gs'),
    sad: G16, wap: G61, sys: G63, carrier: G17, census: TEMP };
  if (opts.mutate) opts.mutate(SRC);
  [SRC.bundle, SRC.cfg, SRC.ric, SRC.aipl, SRC.sad, SRC.wap, SRC.sys, SRC.carrier].forEach(function (src, i) {
    vm.runInContext(src, ctx, { filename: 'src' + i });
  });
  vm.runInContext([
    'function procurementTimestamp_() { return "2026-09-04 14:00:00"; }',
    'function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ""; }',
    'function prodExpectedDbId_() { return "FAKE_DB"; }',
    'function prodAssertDbTarget_() { return true; }',
    'function sheetEnsureColumns_() { return null; }',
    'function prodRequireSheet_(ss, n) { var s = ss.getSheetByName(n); if (!s) throw new Error("missing sheet " + n); return s; }'
  ].join('\n'), ctx);
  ['gapStr_', 'gapNum_', 'gapTruthy_', 'gapCanonCountry_', 'gapReadObjects_', 'gapOpReadSupplyPoolFacts_', 'gapEnumerateScopes_']
    .forEach(function (f) { vm.runInContext(extractFn(G43, f), ctx, { filename: '43:' + f }); });
  ['procurementEnsureSheet_', 'procurementAppendByHeader_', 'procurementFindRow_']
    .forEach(function (f) { vm.runInContext(extractFn(G13, f), ctx, { filename: '13:' + f }); });
  vm.runInContext(extractFn(G02, 'jsonResponse_'), ctx, { filename: '02:jsonResponse_' });
  vm.runInContext(extractFn(G47, 'recGenUpcBySku_'), ctx, { filename: '47:recGenUpcBySku_' });
  vm.runInContext('var GAP_CALC_UTC_OFFSET_MIN_ = ' + /var GAP_CALC_UTC_OFFSET_MIN_\s*=\s*(-?\d+)/.exec(G43)[1] + ';', ctx);
  vm.runInContext(/var GAP_JOB_PROP_KEYS_\s*=\s*\{[^}]*\};/.exec(G46)[0], ctx);
  // The controlled activation, simulated in the VM ONLY. The repository flag is untouched and asserted below.
  if (opts.flag !== false) vm.runInContext('inventoryAiPlanDbGenerationEnabled_ = function () { return true; };', ctx);

  SHEETS['shipping_allocation_drafts'] = new FakeSheet(vm.runInContext('SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', ctx));
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(vm.runInContext('SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_)', ctx));
  UNRELATED.forEach(function (t) { SHEETS[t] = new FakeSheet(['id', 'company', 'country', 'sku', 'qty', 'status']); });

  SHEETS['inventory_replenishment_gap'] = new FakeSheet(
    ['company', 'country', 'marketplace', 'sku', 'calculation_status', 'calculation_date',
     'd18_suggested_qty', 'd30_suggested_qty', 'd45_suggested_qty', 'd90_suggested_qty', 'calculation_run_id']);
  ALLSKUS.forEach(function (sk) {
    var isT = (sk === TARGET.sku);
    SHEETS['inventory_replenishment_gap'].appendRow(['ResUS', 'US', 'Amazon', sk, 'READY', TAIPEI_MIDNIGHT,
      0, isT ? (opts.singleWindow ? 0 : D30) : 40, 0, isT ? SUGGESTED : 200, RUN_ID]);
  });

  SHEETS['warehouses'] = new FakeSheet(['warehouse_id', 'warehouse_code', 'warehouse_type', 'company', 'country', 'is_active', 'is_factory_warehouse']);
  SHEETS['warehouses'].appendRow([FACTORY_CN, 'YOUXIN', 'FACTORY', 'ResUS', 'CN', true, true]);
  SHEETS['warehouses'].appendRow(['WH-TW-TW-FACTORY-RES', 'SHENGYI', 'FACTORY', 'ResUS', 'TW', true, true]);
  SHEETS['warehouses'].appendRow([THREE_PL, 'AMZLGS', '3PL', 'ResUS', 'US', true, false]);
  SHEETS['sku_details'] = new FakeSheet(['sku', 'units_per_carton']);
  ALLSKUS.forEach(function (sk) { SHEETS['sku_details'].appendRow([sk, UPC]); });
  SHEETS['marketplace_skus'] = new FakeSheet(['company', 'country', 'marketplace', 'sku']);
  ALLSKUS.forEach(function (sk) { SHEETS['marketplace_skus'].appendRow(['ResUS', 'US', 'Amazon', sk]); });
  SHEETS['marketplaces'] = new FakeSheet(['company', 'country', 'marketplace', 'allocation_priority']);
  SHEETS['marketplaces'].appendRow(['ResUS', 'US', 'Amazon', 1]);
  // The in-country 3PL holds real stock for the target SKU: the frozen allocator's PASS 1 pool.
  SHEETS['overseas_inventory_snapshot'] = new FakeSheet(['warehouse_id', 'company', 'country', 'sku', 'wh_available_stock']);
  SHEETS['overseas_inventory_snapshot'].appendRow([THREE_PL, 'ResUS', 'US', TARGET.sku,
    (opts.threePlStock === undefined ? 300 : opts.threePlStock)]);
  SHEETS['factory_stock'] = new FakeSheet(['warehouse_id', 'sku', 'fac_current_stock', 'reserved_qty']);
  ALLSKUS.forEach(function (sk) { SHEETS['factory_stock'].appendRow([FACTORY_CN, sk, 5000, 0]); });
  SHEETS['fc_regular_forecast'] = new FakeSheet(
    ['year', 'company', 'country', 'marketplace', 'sku', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  // Deliberately ONLY 2026: the M+1..M+4 window crosses into 2027, so the 2027 months have NO ROW and must
  // normalize to zero without blocking (E3-R3-R1). That is the exact live shape the census used to misreport.
  ALLSKUS.forEach(function (sk) {
    if (opts.noForecastRow && sk === TARGET.sku) return;
    SHEETS['fc_regular_forecast'].appendRow([2026, 'ResUS', 'US', 'Amazon', sk,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 400, (opts.blankDecForecast && sk === TARGET.sku) ? '' : 500]);
  });
  SHEETS['carrier_rate_cards'] = new FakeSheet(
    ['rate_card_id', 'carrier_id', 'origin_country', 'destination_country', 'marketplace', 'shipping_method',
     'shipping_method_label', 'last_mile_delivery', 'currency', 'unit_rate', 'min_charge', 'charge_type',
     'charge_unit', 'status', 'effective_from', 'effective_to', 'note']);
  SHEETS['carrier_rate_cards'].appendRow(['RC-SEA', 'CAR-1', 'CN', 'US', '', 'SEA', 'Sea Freight', 'UPS', 'USD', 1.2, 100, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31', FIXTURE_NOTE]);
  SHEETS['carrier_rate_cards'].appendRow(['RC-AIR', 'CAR-1', 'CN', 'US', '', 'AIR', 'Air Freight', 'UPS', 'USD', 4.5, 200, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31', FIXTURE_NOTE]);
  // An EXPIRED card on the very lane under test, so "no card for the lane" and "the card expired" can never
  // be reported as the same finding.
  SHEETS['carrier_rate_cards'].appendRow(['RC-SEA-OLD', 'CAR-1', 'CN', 'US', 'Amazon', 'SEA', 'Sea Freight', 'UPS', 'USD', 0.9, 90, 'per_unit', 'unit', 'ACTIVE', '2024-01-01', '2025-12-31', FIXTURE_NOTE]);
  SHEETS['carrier_lead_times'] = new FakeSheet(
    ['lead_time_id', 'carrier_id', 'origin_country', 'destination_country', 'shipping_method', 'last_mile_delivery', 'min_days', 'max_days', 'avg_days']);
  SHEETS['carrier_lead_times'].appendRow(['LT-SEA', 'CAR-1', 'CN', 'US', 'SEA', 'UPS', 30, 45, 38]);
  SHEETS['carrier_lead_times'].appendRow(['LT-AIR', 'CAR-1', 'CN', 'US', 'AIR', 'UPS', 7, 12, 9]);
  // §4 — a SECOND carrier on one of those profiles, so the conservative fold across carriers is exercised
  // rather than merely described. Its days are FASTER; the fold must ignore that for the safety verdict.
  if (opts.secondSeaCarrier) {
    SHEETS['carrier_lead_times'].appendRow(['LT-SEA-2', 'CAR-9', 'CN', 'US', 'SEA', 'UPS', 20, 25, 22]);
  }
  // §2/§12 — a DOMESTIC transit authority with NO rate card: the state that proves a method no longer
  // depends on a price list.
  if (opts.domesticLeadTimeOnly) {
    SHEETS['carrier_lead_times'].appendRow(['LT-DOM-ONLY', 'CAR-FIXTURE', 'US', 'US',
      opts.domesticLeadTimeMethod || 'TRUCK', 'UPS', 2, 4, 3]);
    // A SECOND domestic service profile, so a tranche actually has alternatives to offer — without one there
    // is nothing for the "every alternative is counted" mutation to get wrong.
    if (opts.secondDomesticProfile) {
      SHEETS['carrier_lead_times'].appendRow(['LT-DOM-AIR', 'CAR-FIXTURE', 'US', 'US', 'AIR', 'Parcel', 1, 2, 2]);
    }
  }
  var dom = opts.domesticCard;
  if (dom) {
    SHEETS['carrier_rate_cards'].appendRow(['RC-DOM-FIXTURE', 'CAR-FIXTURE',
      dom.origin === undefined ? 'US' : dom.origin,
      dom.destination === undefined ? 'US' : dom.destination,
      dom.marketplace === undefined ? '' : dom.marketplace,
      dom.method === undefined ? 'TRUCK' : dom.method,
      'Domestic Truck (FIXTURE)', dom.lastMile === undefined ? 'UPS' : dom.lastMile,
      'USD', 0.4, 50, 'per_unit', 'unit',
      dom.status === undefined ? 'ACTIVE' : dom.status,
      dom.effectiveFrom === undefined ? '2026-01-01' : dom.effectiveFrom,
      dom.effectiveTo === undefined ? '2027-12-31' : dom.effectiveTo, FIXTURE_NOTE]);
    if (dom.leadTime !== false) {
      SHEETS['carrier_lead_times'].appendRow(['LT-DOM-FIXTURE', 'CAR-FIXTURE', 'US', 'US',
        dom.leadTimeMethod === undefined ? 'TRUCK' : dom.leadTimeMethod,
        dom.lastMile === undefined ? 'UPS' : dom.lastMile, 3, 6, 4]);
    }
  }
  PROPS['GAP_JOB_INVENTORY'] = JSON.stringify(opts.jobState || {
    product: 'INVENTORY', runId: RUN_ID, status: 'DONE', planningCycle: 'RECO-2026-09',
    calculationDate: '2026-09-04', startedAt: '2026-09-04 13:23:42', finishedAt: '2026-09-04 13:39:10' });

  function run(e) { return vm.runInContext(e, ctx); }
  function parse(e) { var r = run(e); return (r && typeof r.getContent === 'function') ? JSON.parse(r.getContent()) : r; }
  run('var SS = SpreadsheetApp.openById("FAKE_DB");');
  run('var __NOW = ' + (Date.UTC(2026, 8, 4, 18, 8) - 480 * 60000) + ';');   // 2026-09-04 18:08 Asia/Taipei
  run('gapCalcNowMs_ = function () { return __NOW; };');
  run('gapCalcResolveContext_ = function () { return { ok: true, calculationDate: "2026-09-04", planningCycle: "RECO-2026-09" }; };');
  // ---- the recommendation-workspace TRANSPORT DOUBLE (see the harness note) ----------------------------------
  run([
    'var __ALLSKUS = ' + JSON.stringify(ALLSKUS) + ';',
    'var __TWO_SITE_SKUS = ' + (opts.oneSiteSku ? 'false' : 'true') + ';',
    'var __SINGLE_WINDOW = ' + (opts.singleWindow ? 'true' : 'false') + ';',
    'handleRecommendationWorkspaceGet_ = function (body) {',
    '  var sc = body.payload.scope, lines = [];',
    '  __ALLSKUS.forEach(function (sk) {',
    '    var isT = (sk === "' + TARGET.sku + '");',
    '    var siteSkus = (isT && __TWO_SITE_SKUS) ? ["B0CO1100R-FBA", "B0CO1100R"] : [isT ? "B0CO1100R" : ("B0" + sk)];',
    '    siteSkus.forEach(function (ss2) {',
    '      lines.push({ sku: sk, siteSku: ss2, marketplaceId: sc.marketplace, destinationType: "MARKETPLACE",',
    '        fulfillmentModel: "platform_fulfilled", sourceDataAsOf: "",',
    '        horizons: (isT && __SINGLE_WINDOW)',
    '          ? [{ windowCode: "D90", gapQty: 999, requiredByDate: "' + REQ + '" }]',
    '          : [{ windowCode: "D30", gapQty: 111, requiredByDate: "2026-10-05" },',
    '             { windowCode: "D90", gapQty: 999, requiredByDate: "' + REQ + '" }] });',
    '    });',
    '  });',
    '  return { success: true, data: { lines: lines, pagination: { page: 1, totalPages: 1 } } };',
    '};'
  ].join('\n'));
  // The census is loaded LAST so it sees the same globals a deployed project gives it.
  vm.runInContext(SRC.census, ctx, { filename: 'census' });
  return { ctx: ctx, SHEETS: SHEETS, PROPS: PROPS, LOG: LOG, run: run, parse: parse, allSkus: ALLSKUS };
}

// ---- the production HARVEST → MAP → SOURCE → ALLOCATE chain, exactly as PASS 1 of the generation runs it ------
function pass1(h, marketplace) {
  return h.run([
    'var HARVEST = weeklyAiPlanHarvest_(SS, { company: "ResUS", country: "US", planningCycle: "RECO-2026-09",',
    '  marketplace: ' + JSON.stringify(marketplace === undefined ? 'Amazon' : marketplace) + ' }, null);',
    'if (!HARVEST.ok) ({ ok: false, errors: HARVEST.errors }); else (function () {',
    '  MAPPED = KMWHA.mapWeeklyHarvestToBatchRequest({ planningCycle: "RECO-2026-09",',
    '    businessScope: { company: "ResUS", country: "US", marketplace: ' + JSON.stringify(marketplace === undefined ? 'Amazon' : marketplace) + ', source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },',
    '    mode: "MANUAL_REGENERATE", confirmRegenerateOverUserEdits: false, actor: "user", now: procurementTimestamp_(),',
    '    sourceDataAsOf: HARVEST.sourceDataAsOf, formulaVersion: "WEEKLY_AI_PLAN_V1", errors: HARVEST.errors,',
    '    factoryIdentityConfig: WEEKLY_AI_PLAN_FACTORY_IDENTITY_, warehousesById: HARVEST.warehousesById,',
    '    kmaf: HARVEST.kmaf, horizonsByDemandRef: HARVEST.horizonsByDemandRef, poolsBySku: HARVEST.poolsBySku });',
    '  if (!MAPPED.ready) return { ok: false, not_ready: true, reason: MAPPED.reason, issues: MAPPED.issues };',
    '  SRC = KMWRB.buildWeeklySourceLines(MAPPED.request);',
    '  if (!SRC.ok) return { ok: false, src_blocked: SRC.reason };',
    '  ALLOC = weeklyAiPlanK2AllocatedLines_(SRC.lines, HARVEST);',
    '  CARR = weeklyAiPlanReadCarrierAuthorities_(SS);',
    '  SHIPDATE = weeklyAiPlanShipDate_(HARVEST);',
    '  MINE = ALLOC.filter(function (a) { return a.marketplace === "Amazon"; });',
    '  PLAN = KMWRR.buildK2GenerationPlan({',
    '    scope: { planning_cycle: "RECO-2026-09", company: "ResUS", country: "US", marketplace: "Amazon", source_page: "inventory_replenishment" },',
    '    allocatedLines: MINE, warehousesById: HARVEST.warehousesById,',
    '    rateCards: CARR.rateCards, leadTimes: CARR.leadTimes, shipDate: SHIPDATE,',
    '    authorizedBySkuWindow: (function () { var a = {}; MINE.forEach(function (x) {',
    '      var k = String(x.sku).toLowerCase() + "|" + String(x.window_code).toLowerCase();',
    '      a[k] = (a[k] || 0) + (Number(x.planned_qty) || 0); }); return a; })(),',
    '    sourceCeilingById: {} });',
    '  return { ok: true,',
    '    site_count: HARVEST.site_count, receiver_count: HARVEST.receiver_count,',
    '    isolation: HARVEST.isolation, source_data_as_of: HARVEST.sourceDataAsOf,',
    '    source_data_as_of_authority: HARVEST.sourceDataAsOfAuthority,',
    '    workspace_source_data_as_of: HARVEST.workspaceSourceDataAsOf,',
    '    ship_date: SHIPDATE, mapped_sku_count: MAPPED.request.skus.length,',
    '    source_lines: SRC.lines.length, source_issues: SRC.issues,',
    '    allocated_lines: ALLOC.length, alloc_diagnostics: ALLOC.diagnostics,',
    '    target_lines: MINE.filter(function (a) { return a.sku === "' + TARGET.sku + '"; }).map(function (a) {',
    '      return { site_sku: a.site_sku, window_code: a.window_code, required_by_date: a.required_by_date,',
    '        source: a.source_warehouse_id, source_code: a.source_warehouse_code_snapshot, role: a.source_role,',
    '        multi_pool: a.source_multi_pool === true, refused: a.source_split_refused_reason || null,',
    '        qty: a.recommended_qty, dest: a.destination };  }),',
    '    group_count: PLAN.groups.length, blocked_count: PLAN.blocked.length,',
    '    conserved: PLAN.conservation.conserved,',
    '    duplicates: PLAN.conservation.duplicate_sku_window_in_group,',
    '    allocated_by_source: PLAN.conservation.allocated_by_source,',
    '    block_tokens: (function () { var o = {}; PLAN.blocked.forEach(function (b) { o[b.block] = (o[b.block] || 0) + 1; }); return o; })(),',
    '    blocked_detail: PLAN.blocked.map(function (b) { return { sku: b.line.sku, window: b.line.window_code,',
    '      source: b.line.source_warehouse_id, qty: b.line.recommended_qty, block: b.block,',
    '      ranking_reason: b.auto_ranking_insufficient_reason || null, method_reason: b.method_unresolved_reason || null }; }),',
    '    blocked_lanes: PLAN.blocked.map(function (b) { return b.lane_query || null; }),',
    '    routes: PLAN.groups.map(function (g) { return { group_no: g.header.recommendation_group_no,',
    '      from: g.header.recommended_source_warehouse_id,',
    '      to_marketplace: g.header.destination_marketplace, to_warehouse: g.header.recommended_destination_warehouse_id,',
    '      method: g.header.recommended_shipping_method, last_mile: g.header.recommended_last_mile_delivery,',
    '      qty: g.lines.reduce(function (t, l) { return t + Number(l.recommended_qty || 0); }, 0),',
    '      line_count: g.lines.length,',
    '      windows: g.lines.map(function (l) { return l.window_code; }),',
    '      required_by: g.lines.map(function (l) { return l.required_by_date; }) }; }) };',
    '})()'
  ].join('\n'));
}
function census(h) {
  return h.run('TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3(' + JSON.stringify({
    company: TARGET.company, country: TARGET.country, marketplace: TARGET.marketplace, sku: TARGET.sku }) + ')');
}
function drafts(h) {
  var d = h.SHEETS['shipping_allocation_drafts'].rows, l = h.SHEETS['shipping_allocation_draft_lines'].rows;
  function obj(hd, r) { var o = {}; for (var i = 0; i < hd.length; i++) o[hd[i]] = r[i]; return o; }
  return { headers: d.slice(1).map(function (r) { return obj(d[0], r); }),
           lines: l.slice(1).map(function (r) { return obj(l[0], r); }) };
}
function activeHeaders(c) {
  return c.headers.filter(function (r) {
    var s = String(r.status || '').trim().toLowerCase();
    return s !== 'submitted' && s !== 'cancelled' && s !== 'expired';
  });
}
function storedTotal(c) { return c.lines.reduce(function (a, l) { return a + (Number(l.recommended_qty) || 0); }, 0); }
function census(h) {
  return h.run('TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3(' + JSON.stringify({
    company: TARGET.company, country: TARGET.country, marketplace: TARGET.marketplace, sku: TARGET.sku }) + ')');
}
function drafts(h) {
  var d = h.SHEETS['shipping_allocation_drafts'].rows, l = h.SHEETS['shipping_allocation_draft_lines'].rows;
  function obj(hd, r) { var o = {}; for (var i = 0; i < hd.length; i++) o[hd[i]] = r[i]; return o; }
  return { headers: d.slice(1).map(function (r) { return obj(d[0], r); }),
           lines: l.slice(1).map(function (r) { return obj(l[0], r); }) };
}
function activeHeaders(c) {
  return c.headers.filter(function (r) {
    var s = String(r.status || '').trim().toLowerCase();
    return s !== 'submitted' && s !== 'cancelled' && s !== 'expired';
  });
}
function storedTotal(c) { return c.lines.reduce(function (a, l) { return a + (Number(l.recommended_qty) || 0); }, 0); }
function generate(h, execKey) {
  h.run('var BODY = { company: "ResUS", country: "US", currentMarketplace: "Amazon", actor: "user"'
    + (execKey ? ', execution_key: "' + execKey + '"' : '') + ' };');
  return h.parse('weeklyAiPlanGenerateK2_(SS, MAPPED.request, HARVEST, null, BODY)');
}
function untouched(h) {
  return UNRELATED.every(function (t) { return h.SHEETS[t].rows.length === 1; });
}

// §1 — the live scope, one window, the live 3PL depth. Every fixture in this file starts from exactly this.
function census(h) {
  return h.run('TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3(' + JSON.stringify({
    company: TARGET.company, country: TARGET.country, marketplace: TARGET.marketplace, sku: TARGET.sku }) + ')');
}
function drafts(h) {
  var d = h.SHEETS['shipping_allocation_drafts'].rows, l = h.SHEETS['shipping_allocation_draft_lines'].rows;
  function obj(hd, r) { var o = {}; for (var i = 0; i < hd.length; i++) o[hd[i]] = r[i]; return o; }
  return { headers: d.slice(1).map(function (r) { return obj(d[0], r); }),
           lines: l.slice(1).map(function (r) { return obj(l[0], r); }) };
}
function generate(h, execKey) {
  h.run('var BODY = { company: "ResUS", country: "US", currentMarketplace: "Amazon", actor: "user"'
    + (execKey ? ', execution_key: "' + execKey + '"' : '') + ' };');
  return h.parse('weeklyAiPlanGenerateK2_(SS, MAPPED.request, HARVEST, null, BODY)');
}
var LIVE = { singleWindow: true, threePlStock: THREE_PL_LIVE, foreignSkus: 0, oneSiteSku: true };
function A(extra) {
  var o = {}; for (var k in LIVE) o[k] = LIVE[k];
  for (var k2 in (extra || {})) o[k2] = extra[k2];
  return o;
}
var KMMR = require('../js/core/supply-planning-method-recommendation.js');
var CFG_BUF = { provisional: true, default_days: 7, by_method: {} };
function lt(carrier, o, d, m, lm, mn, mx, av) {
  return { lead_time_id: 'CLT-' + carrier + m, carrier_id: carrier, origin_country: o, destination_country: d,
    shipping_method: m, last_mile_delivery: lm, min_days: mn, max_days: mx, avg_days: av };
}
function rec(leadTimes, lane, dus) {
  return KMMR.recommend({ leadTimes: leadTimes, lane: lane, daysUntilStockout: dus,
    buffer: KMMR.bufferFor(CFG_BUF, '') });
}

// ================================================================================================================
section('A. \u00a72 \u2014 the two couplings, measured');
// ================================================================================================================
var KMRA = require('../js/core/supply-planning-route-authority.js');
var CNUS = [lt('CAR-A', 'CN', 'US', 'Sea', 'Truck', 30, 45, 38), lt('CAR-C', 'CN', 'US', 'Air', 'Parcel', 5, 10, 7)];

// \u00a72 \u2014 the coupling that DOES NOT exist, proven rather than assumed.
eq(Object.keys(KMRA.normalizeLeadTime(CNUS[0])).indexOf('marketplace'), -1,
  'A1  the lead-time DTO has NO marketplace field \u2014 the international transit authority never had that axis');
eq(KMRA.leadDays({ originCountry: 'CN', destinationCountry: 'US', lastMile: 'Truck' }, CNUS, 'Sea', { fallback: true }),
   { days: 38, source: 'avg' },
  'A1a and a CN\u2192US transit question is answered with no marketplace anywhere in it');
// \u00a712.1/\u00a712.2 \u2014 the SAME profiles serve Amazon, Shopify and Walmart, because a marketplace cannot be
// supplied to this function at all. That is stronger than "they happen to agree".
var pAmz = KMMR.serviceProfiles(CNUS, { originCountry: 'CN', destinationCountry: 'US', marketplace: 'Amazon' });
var pShop = KMMR.serviceProfiles(CNUS, { originCountry: 'CN', destinationCountry: 'US', marketplace: 'Shopify' });
var pWal = KMMR.serviceProfiles(CNUS, { originCountry: 'CN', destinationCountry: 'US', marketplace: 'Walmart' });
eq(JSON.stringify(pAmz), JSON.stringify(pShop), 'A2  CN\u2192US Amazon and CN\u2192US Shopify share one transit authority');
eq(JSON.stringify(pAmz), JSON.stringify(pWal), 'A2a and Walmart shares it too');
eq(pAmz.map(function (p) { return p.profile_key; }), ['Air|parcel', 'Sea|truck'],
  'A2b two service profiles, keyed by method + last-mile and by nothing else');
eq(rec(CNUS, { originCountry: 'CN', destinationCountry: 'US' }, 90).marketplace_used_in_lead_time_join, false,
  'A2c and the recommendation states that no marketplace took part');

// \u00a72 \u2014 the coupling that DID exist.
eq(KMRA.eligibleMethods({ originCountry: 'US', destinationCountry: 'US', marketplace: 'Amazon' }, [], {}), [],
  'A3  a method could NOT be obtained from rate cards alone when there are none \u2014 the coupling R5 breaks');

// ================================================================================================================
section('B. \u00a73/\u00a74 \u2014 the safety rule, and the optimistic number that is never consulted');
// ================================================================================================================
var CFG = read(GS + '00_config.gs');
ok(/var WEEKLY_AI_PLAN_TRANSIT_BUFFER_ = \{/.test(CFG),
  'B1  the transit buffer is a NAMED config authority \u2014 there was none before this round');
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R6 §1) — A PRODUCT RULE WAS SUPERSEDED, AND THE CHECK HAD A SECOND DEFECT.
//
// R5 declared the buffer PROVISIONAL so that activation could not proceed on a number nobody had agreed to.
// The business has confirmed 7 calendar days as the Phase 1 default, so `provisional` is now false and the
// R5 assertion is asserting the opposite of the intended state. That is a supersession, not a regression.
//
// SEPARATELY, this check was defective in the way R5's own stamp audit was: `/provisional: true/` matched the
// file ANYWHERE, so the sentence in the R6 comment block explaining that R5 used to set it kept the assertion
// GREEN after the declaration had flipped. A check that a comment can satisfy is not a check. Both sides now
// match the DECLARATION — the key at the start of a line inside the object — which prose cannot imitate.
ok(/^\s*provisional: false,\s*$/m.test(CFG), 'B1a declared CONFIRMED (not provisional) in the data itself');
ok(!/^\s*provisional: true,\s*$/m.test(CFG), 'B1a1 and nothing in the file still declares it provisional');
ok(/^\s*calendar: 'calendar_days',\s*$/m.test(CFG),
  'B1a2 with the UNIT stated — days_until_stockout is a calendar difference, so the buffer must be too');
ok(/^\s*default_days: 7,\s*$/m.test(CFG) && /^\s*by_method: \{\},\s*$/m.test(CFG),
  'B1b with a default and a per-method override map, so it never becomes a scattered magic number');
ok(/overrides_supported:/.test(CFG),
  'B1b1 and the overrides a later round will add are NAMED here, so the next one lands in this object');
eq(KMMR.bufferFor(CFG_BUF, '').provisional, true, 'B1c the flag still travels with every lookup');
eq(KMMR.bufferFor({ provisional: false, default_days: 7, by_method: {} }, '').provisional, false,
  'B1c1 and a CONFIRMED config reports itself as confirmed');
// RESTATED (A2-R1-R6 §1): an ANCHOR moved — the buffer DTO gained `calendar`, which these two assertions are
// not about. Comparing the whole object made every future field a failure of a claim about method matching, so
// each now states the two fields it actually owns: WHICH source won, and WHAT number came back.
var _bfMiss = KMMR.bufferFor({ provisional: false, default_days: 5, by_method: { 'Sea Freight': 12 } }, 'sea express intl');
eq([_bfMiss.days, _bfMiss.source], [5, 'default_days'],
  'B1d a per-method override is matched on the CANONICAL key, so "Sea Freight" does not capture Sea Express');
var _bfHit = KMMR.bufferFor({ provisional: false, default_days: 5, by_method: { 'Sea Freight': 12 } }, 'sea');
eq([_bfHit.days, _bfHit.source], [12, 'by_method:Sea Freight'],
  'B1e and it DOES capture Sea, however the config spells it');
eq(_bfHit.calendar, 'calendar_days', 'B1e1 and the unit travels with the number in every lookup');

// \u00a73's exact case: 30 days of supply, a 28-day service. It must not be called safe.
var SLOW28 = [lt('CAR-S', 'CN', 'US', 'Sea', 'Truck', 24, 28, 26)];
var r28 = rec(SLOW28, { originCountry: 'CN', destinationCountry: 'US' }, 30);
eq(r28.options[0].conservative_transit_days, 35, 'B2  28 max + 7 buffer = 35 conservative days');
eq(r28.options[0].risk, 'UNSAFE', 'B2a against 30 days of supply that is UNSAFE');
eq(r28.status, 'MANUAL_REVIEW_REQUIRED', 'B2b so nothing is auto-recommended');
eq(r28.review_reason, 'NO_SAFE_METHOD_WITHIN_BUFFER', 'B2c with the reason named');
eq(r28.recommended, null, 'B2d and NO least-bad option is dressed up as a recommendation');
// The strictness of `<` is load-bearing at the boundary, so it is asserted at the boundary.
var rExact = KMMR.recommend({ leadTimes: SLOW28, lane: { originCountry: 'CN', destinationCountry: 'US' },
  daysUntilStockout: 35, buffer: { days: 7 } });
// The conservative estimate lands EXACTLY on the stockout day, so it is not SAFE — strict `<`, not `<=`.
// It is classified TIGHT rather than UNSAFE because the AVERAGE still lands in time, which is a materially
// different thing to tell an operator; what matters for the rule is that TIGHT is never auto-recommended.
eq(rExact.options[0].risk, 'TIGHT',
  'B3  arriving EXACTLY on the stockout day is NOT safe — the rule is strict `<`, not `<=`');
eq(rExact.status, 'MANUAL_REVIEW_REQUIRED', 'B3a and a TIGHT option is never auto-recommended');
eq(rExact.recommended, null, 'B3b nothing is selected on its behalf');
var rOne = KMMR.recommend({ leadTimes: SLOW28, lane: { originCountry: 'CN', destinationCountry: 'US' },
  daysUntilStockout: 36, buffer: { days: 7 } });
eq(rOne.options[0].risk, 'SAFE', 'B3a and one day earlier is');

// \u00a73/\u00a74 \u2014 min_days must never decide.
ok(r28.options[0].min_days === 24 && r28.options[0].transit_basis === 'max_days',
  'B4  min_days is carried for display and the basis is max_days \u2014 the optimistic figure never decides');

// \u00a74 \u2014 the conservative fold across carriers.
var MIXED = [lt('SLOW', 'CN', 'US', 'Sea', 'Truck', 30, 60, 50), lt('FAST', 'CN', 'US', 'Sea', 'Truck', 20, 25, 22)];
var rMix = rec(MIXED, { originCountry: 'CN', destinationCountry: 'US' }, 40);
eq(rMix.options.length, 1, 'B5  two carriers on one service profile produce ONE profile, not two');
eq(rMix.options[0].max_days, 60, 'B5a folded to the SLOWEST max \u2014 a fast carrier cannot make the profile look safe');
eq(rMix.options[0].risk, 'UNSAFE', 'B5b so 40 days of supply is correctly UNSAFE');
eq(rMix.options[0].carrier_ids, ['FAST', 'SLOW'], 'B5c both carriers are reported as PROVENANCE');
eq(rMix.options[0].carrier_selection, 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN',
  'B5d and the selection is explicitly deferred \u2014 a lead-time carrier_id is not a chosen carrier');
eq(rMix.options[0].estimated_cost, null, 'B5e no cost is claimed');
eq(rMix.options[0].cost_basis, 'NOT_EVALUATED_IN_AI_PLAN', 'B5f and the absence is typed, not blank');

// \u00a74 \u2014 the default is the SLOWEST safe option, never the fastest and never "the cheapest".
var r90 = rec(CNUS, { originCountry: 'CN', destinationCountry: 'US' }, 90);
eq(r90.status, 'AUTO_RECOMMENDED', 'B6  with ample time a method IS auto-recommended');
eq(r90.recommended.profile_key, 'Sea|truck',
  'B6a and it is the SLOWEST option that still preserves the buffer \u2014 not air, which would burn money the plan ' +
  'was never asked to spend');
eq(r90.recommended.risk, 'SAFE', 'B6b it is safe');
eq(r90.alternatives.map(function (o) { return o.profile_key + ':' + o.risk; }), ['Air|parcel:SAFE'],
  'B6c and the faster option is offered as a ranked alternative');
// \u00a712.5 \u2014 slow unsafe, fast safe.
var r40 = rec(CNUS, { originCountry: 'CN', destinationCountry: 'US' }, 40);
eq([r40.recommended.profile_key, r40.recommended.risk], ['Air|parcel', 'SAFE'],
  'B7  when the slow method is unsafe and the fast one is safe, the fast one is recommended');
eq(r40.alternatives.map(function (o) { return o.profile_key + ':' + o.risk; }), ['Sea|truck:UNSAFE'],
  'B7a with the unsafe option still shown, ranked below, and never silently dropped');

// \u00a78 \u2014 no transit authority: nothing is guessed.
var rNone = rec([], { originCountry: 'US', destinationCountry: 'US' }, 90);
eq([rNone.status, rNone.review_reason, rNone.recommended, rNone.options.length],
   ['MANUAL_REVIEW_REQUIRED', 'NO_LEAD_TIME_AUTHORITY_FOR_LANE', null, 0],
  'B8  no lead time \u2192 manual review, no invented method, no invented ETA');
var rNoDate = KMMR.recommend({ leadTimes: CNUS, lane: { originCountry: 'CN', destinationCountry: 'US' },
  daysUntilStockout: null, buffer: { days: 7 } });
eq([rNoDate.review_reason, rNoDate.recommended], ['NO_REQUIRED_ARRIVAL_DATE', null],
  'B8a and with no required-arrival date nothing is called safe, though the options are still listed');
eq(rNoDate.options.length, 2, 'B8b \u2014 listed, so a person can still choose');

// ================================================================================================================
section('C. \u00a71/\u00a76/\u00a78/\u00a711 \u2014 the advice boundary on the live scope');
// ================================================================================================================
var hA = build(A({}));
var rA = pass1(hA);
var cA = census(hA);
eq(cA.verdict, 'RECOMMENDATION_READY_WITH_WARNINGS',
  'C1  THE ROUND\u2019S POINT: the live scope with NO carrier data is no longer a STOP');
eq(cA.recommendation_ready, true, 'C1a recommendation_ready');
eq([cA.authorized_quantity, cA.supply_allocated_quantity, cA.unresolved_supply_quantity], [760, 760, 0],
  'C1b authorized 760, supply allocated 760, unresolved SUPPLY 0');
eq(cA.method_status, 'MANUAL_REVIEW_REQUIRED', 'C1c method_status \u2014 a person chooses');
eq(cA.carrier_pricing_ready, false, 'C1d carrier_pricing_ready false');
eq(cA.execution_route_materialized, false, 'C1e execution_route_materialized false');
eq(cA.submit_ready, false, 'C1f submit_ready false');
eq(cA.shared_blockers, [], 'C1g and NO shared blocker \u2014 carrier coverage is not one');
eq(cA.blockers, [], 'C1h so the census reports no blockers at all');
eq(cA.production_parity.writer_constructed, false, 'C1i writer not constructed');
eq(drafts(hA).headers.length, 0, 'C1j and zero DB writes');

// \u00a78 \u2014 the advice that survives a total absence of carrier data.
var tA = cA.method_advice.tranches[0];
eq([tA.window_code, tA.quantity, tA.required_by_date], ['D90', 760, REQUIRED_BY],
  'C2  source, quantity and required-by all still advised');
eq(tA.days_until_stockout, 90, 'C2a with days-until-stockout computed from the tranche\u2019s own window');
eq(rA.target_lines[0].source, THREE_PL, 'C2b and the source is still the in-country 3PL');
eq(tA.recommended_method, null, 'C2c no method is guessed');
eq(tA.method_status, 'MANUAL_REVIEW_REQUIRED', 'C2d it is marked for manual review');
ok(cA.warnings.some(function (w) { return /CARRIER_MASTER_DATA_INCOMPLETE \(warning, not a blocker\)/.test(w); }),
  'C3  the carrier gap is reported as a WARNING and says so in its own text');
// RESTATED (A2-R1-R6 §1) — THE PRODUCT RULE THIS ASSERTION PROTECTED HAS BEEN SATISFIED, NOT WEAKENED.
//
// R5 required every recommendation to carry TRANSIT_BUFFER_PROVISIONAL so nobody could activate on an
// unconfirmed number. The business confirmed it, so the warning must now be ABSENT — and the claim inverts
// with it: the census must not report a provisional buffer when the config declares a confirmed one.
//
// The WARNING ITSELF STAYS IN THE CODE. It is not dead: it fires if a deployment is ever running a config
// that is behind this one, which is the only situation left in which it would be true.
ok(!cA.warnings.some(function (w) { return /TRANSIT_BUFFER_PROVISIONAL/.test(w); }),
  'C3a the buffer is CONFIRMED, so no recommendation warns that it is provisional');
ok(/TRANSIT_BUFFER_PROVISIONAL/.test(G61),
  'C3a1 and the warning still exists, for a deployment running a config that is behind');
ok(!/USER_MASTER_DATA_REQUIRED/.test(JSON.stringify(cA.verdict)),
  'C3b USER_MASTER_DATA_REQUIRED is no longer the verdict');

// \u00a72/\u00a77/\u00a712.7 \u2014 a lane with TRANSIT authority and NO rate card now yields a method.
var hL = build(A({ domesticLeadTimeOnly: true }));
var rL = pass1(hL);
var cL = census(hL);
eq(cL.method_status, 'AUTO_RECOMMENDED',
  'C4  a lane with a lead time and NO rate card now produces a method \u2014 the coupling is broken');
eq(cL.carrier_pricing_ready, false, 'C4a while carrier pricing is still, correctly, not ready');
eq(cL.method_advice.tranches[0].recommended_method.shipping_method, 'TRUCK', 'C4b the method comes from the transit row');
eq(cL.method_advice.tranches[0].recommended_method.estimated_cost, null, 'C4c priced at null');
eq(cL.method_advice.tranches[0].recommended_method.cost_basis, 'NOT_EVALUATED_IN_AI_PLAN',
  'C4d and the absence of a price is typed, never a zero');
eq(rL.group_count, 1, 'C5  and a schema-COMPLETE execution route is derivable from it');
eq(rL.routes[0].method, 'TRUCK', 'C5a with the method from the transit authority');
eq(hL.run('PLAN.groups[0].route_evidence.method_source'), 'LEAD_TIME_AUTHORITY',
  'C5b and the route records WHICH authority named its method');
eq(hL.run('PLAN.groups[0].route_evidence.cost_basis'), 'NOT_PRICED_NO_RATE_CARD_FOR_LANE',
  'C5c so a null cost can never be read as "free"');

// \u00a76 \u2014 the 3PL policy is untouched by any of this.
eq(rL.target_lines[0].source, THREE_PL, 'C6  3PL first: 760 from the in-country pool');
ok(rL.target_lines.every(function (l) { return l.source !== FACTORY_CN; }), 'C6a factory allocation 0');
eq(rA.target_lines[0].source, THREE_PL,
  'C6b and with NO carrier data at all the source is STILL the 3PL \u2014 never quietly swapped to the factory');

// ================================================================================================================
section('D. \u00a75 \u2014 quantity is not multiplied by the number of options');
// ================================================================================================================
var hM = build(A({ domesticLeadTimeOnly: true, secondSeaCarrier: true }));
pass1(hM);
var cM = census(hM);
var adv = cM.method_advice;
eq(adv.counted_quantity, 760, 'D1  exactly the authorized quantity is COUNTED across all tranches');
eq(adv.tranches.reduce(function (n, t) { return n + (t.recommended_method ? t.recommended_method.quantity : 0); }, 0), 760,
  'D1a and the counted quantities sum to 760, not 760 per option');
ok(adv.tranches.every(function (t) {
  return t.alternative_scenarios.every(function (a) { return a.counted_in_shipment_total === false; });
}), 'D2  every alternative is flagged as NOT part of any shipment total');
ok(adv.tranches.every(function (t) { return !t.recommended_method || t.recommended_method.counted_in_shipment_total === true; }),
  'D2a and exactly the recommended one is');
ok(adv.tranches.every(function (t) {
  return t.alternative_scenarios.every(function (a) { return a.quantity_if_chosen !== undefined && a.quantity === undefined; });
}), 'D2b an alternative carries `quantity_if_chosen`, never a bare `quantity` a reader could sum');

// ================================================================================================================
section('E. \u00a710 \u2014 a label compared with a label could not see a stale body');
// ================================================================================================================
var RT = hA.run('sysRuntimeAuthorityChecks_()');
eq(RT.uniform, true, 'E1  writer and lifecycle resolve identically at every known schema generation');
ok(RT.checks.length >= 4, 'E1a and EVERY generation is probed, not just one');
ok(RT.checks.some(function (c) { return c.column_count === 36; }), 'E1b including the live 36-column shape');
eq(RT.checks.filter(function (c) { return c.column_count === 36; })[0].agree, true, 'E1c which agrees');
var DC = hA.run('sysModuleBuildStamps_()');
ok(DC && DC.runtime_authority, 'E2  the deployment contract now carries the EXECUTED invariant');
eq(DC.runtime_authority.uniform, true, 'E2a whose runtime half is uniform here');
// This harness compiles seven owner files, not the whole project, so the LABEL half legitimately reports the
// rest as absent. What matters is that a runtime divergence can force MIXED even when every label agrees, and
// that is asserted by mutation (H13) rather than by a verdict string this fixture cannot produce.
ok(/MIXED_OR_PARTIAL_SYNC/.test(DC.verdict) && DC.absent_modules.length > 0,
  'E2b and the label half still reports the owner files this fixture does not compile');

// The three stamps that were never rotated. Each is set to the round its file ACTUALLY last changed.
var G69L = read(GS + '69_api_v1_ai_plan_lifecycle.gs');
eq(/var AIPL_BUILD_VERSION_ = '([^']*)'/.exec(G69L)[1], 'F1-7N-FC-1B-E3-R4-A2-R1-R1',
  'E3  69_ lifecycle declares the round it last changed in \u2014 it had been three rounds stale, which is exactly ' +
  'why a label comparison called a mixed deployment UNIFORM');
// R6-R6-R4-R2 — DERIVED. This pinned the round 16_ had last changed in, which is an equality with now:
// the next round to touch the writer breaks it, and E4 below already enforces the durable property (no
// stamp older than its file's last change). What this line owns is that the stamp is not STALE.
var _sadStamp = /var SAD_BUILD_VERSION_ = '([^']*)'/.exec(read(GS + '16_shipping_allocation_handlers.gs'))[1];
ok(RO.OWNER_STAMPS.indexOf(_sadStamp) >= RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R2'),
  'E3a 16_ likewise, at or after the round it had gone stale in (' + _sadStamp + ')');
ok(RO.BUILD_STAMP_RE.test(_sadStamp), 'E3a1 and it is a well-formed stamp');
// RESTATED (A2-R1-R6): a pinned stamp literal. R6 changes 00_config again (§1), so the durable claim is a
// FLOOR against the shared ledger — the stamp is at or after the round that last rotated it.
ok(RO.stampAtOrAfter(/var CONFIG_BUILD_VERSION_ = '([^']*)'/.exec(CFG)[1], 'F1-7N-FC-1B-E3-R4-A2-R1-R5'),
  'E3b and 00_config, which this round changes');

// A STANDING check on the METHOD, not just on these three instances: a manifest owner whose file changed after
// its stamp was last set is a stamp that was not rotated, and that is the defect that hid the mixed deployment.
(function stampRotation() {
  var cp = require('child_process');
  var G63S = read(GS + '63_api_v1_system_health.gs');
  var re = /\{ file: '([^']+)', symbol: '([A-Z_]+)', expected: '([^']+)'/g, m, bad = [];
    // ONE STAMP PER FILE ONLY, and the limitation is deliberate rather than an oversight. 66_ carries TWO
    // manifest stamps for two separate concerns (send orchestration, send diagnostic), and this check works
    // at FILE granularity, so it cannot tell which concern a commit touched. Applying it there would demand
    // that BOTH stamps move whenever EITHER does — exactly the churn the manifest warns against, because a
    // stamp bumped to look current makes the whole contract useless. A check that creates pressure to lie is
    // worse than a narrower one that does not, so those files are EXCLUDED and NAMED.
    var entryCountByFile = {}, multiStamp = {}, c;
    var cre = /\{ file: '([^']+)', symbol: '([A-Z_]+)', expected: '([^']+)'/g;
    while ((c = cre.exec(G63S)) !== null) { entryCountByFile[c[1]] = (entryCountByFile[c[1]] || 0) + 1; }
  while ((m = re.exec(G63S)) !== null) {
    var file = m[1], symbol = m[2], stamp = m[3], p = GS + file;
    if (entryCountByFile[file] !== 1) { multiStamp[file] = 1; continue; }
    if (!fs.existsSync(path.join(ROOT, p))) continue;
    function git(a) { try { return cp.execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return ''; } }
    var fileLast = git(['log', '-1', '--format=%H', '--', p]);
    // Match the DECLARATION, not the bare stamp string. R5's own commit rotated 66_ while also naming the
    // new stamp in a comment, so a bare -S search found the older commit that first mentioned it in prose
    // and reported a correctly-rotated file as stale. The declaration text is unambiguous.
    var stampLast = git(['log', '-1', '--format=%H', '-S', 'var ' + symbol + " = '" + stamp + "'", '--', p]);
    // R6-R6 §4 RESTATEMENT — THIS CHECK WENT SILENT DURING EXACTLY THE ROUND THAT BROKE THE RULE.
    //
    // It used to `continue` on any file with uncommitted changes, reasoning that a dirty file is the round's
    // own edit in progress. That is true and it is also the whole window in which the rule can be violated:
    // R6-R5 edited 63_ without moving SYS_BUILD_VERSION_, this check skipped 63_ for being dirty, the sweep
    // passed, the round shipped, and the failure only appeared afterwards — against a clean tree, where the
    // round that could still have fixed it was over. A guard that abstains while the edit is happening is not
    // a guard on the edit.
    //
    // A dirty file is now CHECKED, by the only question that makes sense mid-round: did this working tree move
    // the stamp along with the file? The stamp declared on disk is compared against the one HEAD declares, so
    // an in-progress edit that also rotates its stamp passes, and one that forgets is named while there is
    // still a round in which to name it.
    if (git(['diff', '--name-only', 'HEAD', '--', p])) {
      var headSrc = git(['show', 'HEAD:' + p]);
      var declRe = new RegExp('var ' + symbol + " = '([^']*)'");
      var headDecl = declRe.exec(headSrc), diskDecl = declRe.exec(read(p));
      // A file that declares no stamp at HEAD is a NEW owner: its first stamp is by definition current.
      if (headDecl && diskDecl && headDecl[1] === diskDecl[1]) {
        bad.push(file + ' (edited in this working tree, stamp still ' + diskDecl[1] + ')');
      }
      continue;
    }
    if (fileLast && stampLast && fileLast !== stampLast) bad.push(file + ' (stamp ' + stamp + ')');
  }
  eq(bad, [],
    'E4  NO single-stamp manifest owner carries a stamp older than its own last change — the METHOD is ' +
    'checked, not just the instances this round repaired');
  ok(Object.keys(multiStamp).length > 0,
    'E4a and the files this check cannot cover (two stamps, one file) are NAMED rather than silently skipped: '
    + Object.keys(multiStamp).join(', '));
})();

// ================================================================================================================
section('F. \u00a77 \u2014 the Layer 2 boundary, frozen');
// ================================================================================================================
var CC = hA.run('weeklyShippingPlanCarrierComparisonContract_()');
eq(CC.layer, 'WEEKLY_SHIPPING_PLAN', 'F1  the carrier comparison belongs to the Weekly Shipping Plan');
eq(CC.selects, 'CARRIER', 'F1a it selects a CARRIER');
eq(CC.method_is_an_input_not_an_output, true, 'F1b and takes the METHOD as an input, never deriving one');
ok(CC.match_axes.indexOf('shipping_method') !== -1 && CC.match_axes.indexOf('last_mile_delivery') !== -1
   && CC.match_axes.indexOf('destination_country') !== -1 && CC.match_axes.indexOf('effective_date') !== -1,
  'F2  matching on route, method, last-mile and effective date');
eq(CC.initial_ranking, ['comparable_total_cost'], 'F2a ranked initially on comparable total cost');
ok(/one currency AND one charge_type\+charge_unit/.test(CC.comparability_rule),
  'F2b and only within one currency and one charge basis');
eq(CC.reserved_ranking_signals, ['trust_score', 'on_time_rate', 'damage_or_claim_rate', 'historical_reliability'],
  'F3  with the future weights reserved by name, so a later round adds a weight rather than a second surface');
ok(CC.must_not.some(function (x) { return /block the AI Plan recommendation/.test(x); }),
  'F4  and it may NOT block the AI Plan recommendation');
ok(CC.must_not.some(function (x) { return /carrier_lead_times\.carrier_id is not a carrier selection|treat carrier_lead_times/.test(x); }),
  'F4a nor treat a lead-time carrier_id as a selection');
eq(CC.ui_delivered_in_this_round, false, 'F5  and the UI is explicitly NOT claimed as delivered this round');

// ================================================================================================================
section('G. \u00a79 \u2014 one scope\u2019s carrier gap must not fail the batch');
// ================================================================================================================
var hB2 = build(A({ domesticLeadTimeOnly: true }));
pass1(hB2);
var gB = generate(hB2);
ok(gB.success, 'G0  a generation on a lane with transit authority and NO rate card SUCCEEDS');
var batch = gB.data.batch;
ok(batch, 'G1  the generation reports a BATCH verdict');
eq(batch.verdict, 'SUCCESS_WITH_WARNINGS',
  'G1a a scope that is advisable but unpriced lands in the WARNINGS band, not STOP');
eq(batch.scopes_recommendation_ready, 1, 'G1b with the scope counted as recommendation-ready');
ok(batch.never_stops_a_batch.indexOf('NO_CARRIER_CARD_FOR_LANE') !== -1
   && batch.never_stops_a_batch.indexOf('NO_TRANSIT_AUTHORITY_FOR_LANE') !== -1,
  'G2  and the rule is stated: carrier coverage NEVER stops a batch');
ok(batch.may_stop_a_batch.indexOf('QUANTITY_CONSERVATION_FAILED') !== -1
   && batch.may_stop_a_batch.indexOf('SCHEMA_OR_RUNTIME_AUTHORITY_DIVERGENCE') !== -1,
  'G2a while a shared/system fault does');
eq(batch.stop_reasons, [], 'G2b none of which applies here');

// \u00a712.12 \u2014 an un-materializable route still writes nothing partial.
var hNo = build(A({}));
pass1(hNo);
generate(hNo);
eq(drafts(hNo).headers.length, 0,
  'G3  a scope with no route identity writes NO header \u2014 advice is given, nothing schema-invalid is stored');
eq(drafts(hNo).lines.length, 0, 'G3a and no line');

// \u00a712.15 \u2014 Submit is still the layer that refuses.
eq(census(hNo).submit_ready, false, 'G4  submit_ready is FALSE while the route is not materialized');
eq(census(build(A({ domesticCard: {} }))).submit_ready, true,
  'G4a and TRUE only when the route is complete AND priced');
eq(cL.submit_ready, false,
  'G4b a method without a price is advisable but NOT submittable \u2014 the two layers stay distinct');

// \u00a710 release discipline.
ok(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;/.test(CFG), 'G5  the generation flag is still false');
eq(hA.run('inventoryAiPlanActivationAllowlist_()'),
   [{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' }],
  'G5a and the allowlist is still the single authorized scope');
// RESTATED (A2-R1-R6): pinned stamp literal → floor. R6 changes the census (§2/§3/§5/§6).
// RESTATED (A2-R1-R6-R1): a pinned census build stamp. R6-R1 changes the census (§2 — it now reports the
// PAGE's draft scope beside its own, with the reason each row falls on each side). The durable claim is a
// FLOOR against the shared ledger.
ok(RO.stampAtOrAfter(hA.run('TEMP_E3_CENSUS_BUILD_'), 'F1-7N-FC-1B-E3-R4-A2-R1-R5'), 'G5b census build stamp');
ok(RO.stampAtOrAfter(hA.run('WAP_BUILD_VERSION_'), 'F1-7N-FC-1B-E3-R4-A2-R1-R5'), 'G5c workspace build stamp');

// ================================================================================================================
section('H. \u00a713 \u2014 mutation coverage');
// ================================================================================================================
// KMMR is exercised directly for the pure-safety mutations: it is a module with no I/O, so mutating its source
// and re-evaluating it is both cheaper and more precise than routing every case through a whole census.
var KMMR_SRC = read('assets/js/core/supply-planning-method-recommendation.js');
function kmmrWith(mutate) {
  var src = mutate(KMMR_SRC);
  // The module resolves KMRA by a path relative to ITSELF, so a bare `require` handed to the sandbox looks in
  // assets/tests and fails. The shim resolves that one dependency for it and refuses anything else, so a
  // mutant cannot quietly pull in something the real module never asks for.
  var shimRequire = function (id) {
    if (/supply-planning-route-authority/.test(id)) return require(path.join(ROOT, 'assets/js/core/supply-planning-route-authority.js'));
    throw new Error('kmmr mutant asked for an unexpected dependency: ' + id);
  };
  var sandbox = { module: { exports: {} }, require: shimRequire, console: console, Math: Math, JSON: JSON,
    String: String, Number: Number, Object: Object, Array: Array, isNaN: isNaN, isFinite: isFinite,
    parseFloat: parseFloat, parseInt: parseInt, Error: Error, RegExp: RegExp, Boolean: Boolean };
  sandbox.global = sandbox;
  var ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'kmmr-mutant' });
  return vm.runInContext('module.exports', ctx);
}

// 1. Marketplace re-introduced as a required key for INTERNATIONAL lead times.
mut('H1  marketplace made a required axis on the lead-time join \u2192 CN\u2192US Amazon and CN\u2192US Shopify stop ' +
    'sharing one transit authority', function () {
  var M = kmmrWith(function (src) {
    return swap(src, "      if (!KMRA.axisOk(lt.destinationCountry, lane.destinationCountry)) return;",
      "      if (!KMRA.axisOk(lt.destinationCountry, lane.destinationCountry)) return;\n" +
      "      if (KMRA.axisOk(lt.marketplace, lane.marketplace) === false || lane.marketplace) return;");
  });
  var a = M.serviceProfiles(CNUS, { originCountry: 'CN', destinationCountry: 'US', marketplace: 'Amazon' });
  var b = M.serviceProfiles(CNUS, { originCountry: 'CN', destinationCountry: 'US' });
  return JSON.stringify(a) !== JSON.stringify(b);
});

// 2. The Rate Card becomes a required gate for the AI Plan again.
mut('H2  the lead-time fallback removed from route derivation \u2192 a lane with transit authority and no rate ' +
    'card produces no method again', function () {
  var m = build(A({ domesticLeadTimeOnly: true, mutate: function (S) {
    S.bundle = swap(S.bundle, '      if (profiles.length) {', '      if (false) {');
  } }));
  var r = pass1(m);
  // The ADVICE is deliberately independent of route derivation, so it correctly stays AUTO_RECOMMENDED here;
  // what the mutation removes is the ability to MATERIALIZE a route from transit authority alone (C5).
  return r.group_count === 0;
});

// 3. min_days used to decide safety.
mut('H3  conservativeBasis switched to min_days \u2192 a 45-day service is called safe on its 30-day best case',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, "    if (p.max_days != null && isFinite(p.max_days)) return { days: p.max_days, basis: 'max_days' };",
        "    if (p.min_days != null && isFinite(p.min_days)) return { days: p.min_days, basis: 'min_days' };");
    });
    var r = M.recommend({ leadTimes: CNUS, lane: { originCountry: 'CN', destinationCountry: 'US' },
      daysUntilStockout: 40, buffer: { days: 7 } });
    var sea = r.options.filter(function (o) { return o.profile_key === 'Sea|truck'; })[0];
    return sea.risk === 'SAFE';       // truth: max 45 + 7 = 52 against 40 is UNSAFE
  });

// 4. The buffer ignored entirely.
mut('H4  the buffer dropped from the conservative estimate \u2192 a 45-day service clears 46 days with no slack',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, '    var cons = (cb.days == null) ? null : (cb.days + bufferDays);',
        '    var cons = (cb.days == null) ? null : cb.days;');
    });
    var r = M.recommend({ leadTimes: CNUS, lane: { originCountry: 'CN', destinationCountry: 'US' },
      daysUntilStockout: 46, buffer: { days: 7 } });
    var sea = r.options.filter(function (o) { return o.profile_key === 'Sea|truck'; })[0];
    return sea.risk === 'SAFE' && sea.conservative_transit_days === 45;
  });

// 5. \u00a73's named case: 30 days of supply accepting a 28-day method.
mut('H5  the safety comparison relaxed to `<=` on the raw transit \u2192 DOS 30 accepts a 28-day method',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, '    else if (cons < dus) risk = RISK.SAFE;', '    else if (cb0(p) <= dus) risk = RISK.SAFE;')
        .replace('function option(p, cb, bufferDays, dus) {',
          'function cb0(p) { return p.max_days; }\n  function option(p, cb, bufferDays, dus) {');
    });
    var r = M.recommend({ leadTimes: SLOW28, lane: { originCountry: 'CN', destinationCountry: 'US' },
      daysUntilStockout: 30, buffer: { days: 7 } });
    return r.options[0].risk === 'SAFE' && r.status === 'AUTO_RECOMMENDED';
  });

// 6. Every alternative allocated the full quantity.
mut('H6  alternatives marked as counted \u2192 the shipment total multiplies by the number of options', function () {
  var m = build(A({ domesticLeadTimeOnly: true, secondDomesticProfile: true, mutate: function (S) {
    S.wap = swap(S.wap, '          quantity_if_chosen: qty, counted_in_shipment_total: false,',
      '          quantity: qty, counted_in_shipment_total: true,');
    S.wap = swap(S.wap, "    if (t.recommended_method) { out.counted_quantity += qty; out.tranches_with_method++; }",
      "    if (t.recommended_method) { out.counted_quantity += qty * (1 + t.alternative_scenarios.length); out.tranches_with_method++; }");
  } }));
  pass1(m);
  var adv = census(m).method_advice;
  return adv.counted_quantity !== 760
    || adv.tranches.some(function (t) {
         return t.alternative_scenarios.some(function (a) { return a.counted_in_shipment_total === true; });
       });
});

// 7. The factory used before the in-country 3PL.
mut('H7  PASS 1 (overseas/3PL) skipped \u2192 the 760 sources from the CN factory instead', function () {
  var m = build(A({ domesticLeadTimeOnly: true, mutate: function (S) {
    S.bundle = swap(S.bundle, '    if (input.overseasInput != null) {', '    if (false) {');
  } }));
  var r = pass1(m);
  return r.target_lines.length > 0 && r.target_lines.every(function (l) { return l.source !== THREE_PL; });
});

// 8. A method guessed when the lane has no transit authority.
mut('H8  a fallback method invented when no profile exists \u2192 the AI Plan names a method it has no evidence for',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, "      out.review_reason = METHOD_REVIEW_REASONS.NO_LEAD_TIME_AUTHORITY_FOR_LANE;\n      return out;",
        "      out.recommended = { profile_key: 'Sea|truck', shipping_method: 'Sea', last_mile_delivery: 'Truck',\n" +
        "        conservative_transit_days: 30, arrival_headroom_days: 1, risk: 'SAFE', carrier_ids: [],\n" +
        "        carrier_selection: 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN', estimated_cost: null, cost_basis: 'x' };\n" +
        "      out.status = METHOD_STATUS.AUTO_RECOMMENDED;\n      return out;");
    });
    var r = M.recommend({ leadTimes: [], lane: { originCountry: 'US', destinationCountry: 'US' },
      daysUntilStockout: 90, buffer: { days: 7 } });
    return r.recommended !== null;
  });

// 9. An ETA guessed when there is no lead time.
mut('H9  a default transit substituted for a missing one \u2192 an arrival date is produced from nothing',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, "    return { days: null, basis: 'NONE' };", "    return { days: 30, basis: 'ASSUMED' };");
    });
    var LT_NO_DAYS = [{ lead_time_id: 'X', carrier_id: 'C', origin_country: 'CN', destination_country: 'US',
      shipping_method: 'Sea', last_mile_delivery: 'Truck', min_days: 12, max_days: '', avg_days: '' }];
    var r = M.recommend({ leadTimes: LT_NO_DAYS, lane: { originCountry: 'CN', destinationCountry: 'US' },
      daysUntilStockout: 90, buffer: { days: 7 } });
    return r.options.length > 0 && r.options[0].transit_basis === 'ASSUMED';
  });

// 10. A warning scope stopping the whole batch.
mut('H10 carrier coverage promoted to a batch STOP reason \u2192 an advisable scope fails the batch', function () {
  var m = build(A({ mutate: function (S) {
    S.wap = swap(S.wap, "  var batchVerdict = batchStopReasons.length ? 'STOP'\n    : (scopeWarnings.length ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS');",
      "  var batchVerdict = (batchStopReasons.length || scopeWarnings.length) ? 'STOP' : 'SUCCESS';");
  } }));
  pass1(m);
  var g = generate(m);
  return g.data && g.data.batch && g.data.batch.verdict === 'STOP';
});

// 11. A schema-invalid execution route written.
mut('H11 the completeness gate on materialization removed \u2192 a header is written for a route with no method',
  function () {
    var m = build(A({ mutate: function (S) {
      S.bundle = swap(S.bundle, "      if (!rl || !rl.route || rl.block) { if (rl && rl.block) blocked.push(",
        "      if (false) { if (rl && rl.block) blocked.push(");
    } }));
    var threw = false;
    try { pass1(m); generate(m); } catch (e) { threw = true; }
    // Either a header appears for a route with no method, or the write path throws. Both are detections; a
    // silent pass is what must not happen.
    var d = drafts(m);
    return threw || d.headers.some(function (r) { return String(r.recommended_shipping_method || '') === ''; });
  });

// 12. The Submit gate relaxed.
mut('H12 submit_ready no longer requires a materialized route \u2192 an unroutable scope reports submittable',
  function () {
    var m = build(A({ mutate: function (S) {
      S.wap = swap(S.wap, "  out.submit_ready = out.execution_route_materialized === true && out.carrier_pricing_ready === true;",
        "  out.submit_ready = out.recommendation_ready === true;");
    } }));
    pass1(m);
    return census(m).submit_ready === true;      // truth: no route, no pricing -> false
  });

// 13. A stale lifecycle resolver, with every LABEL still agreeing.
mut('H13 the lifecycle resolver reverted to its pre-delegation body \u2192 the RUNTIME check reports divergence ' +
    'even though every build stamp still matches', function () {
  var m = build(A({ mutate: function (S) {
    S.aipl = swap(S.aipl, "  return (r && r.ok && r.lifecycle_complete) ? aiplStr_(r.version) : '';",
      "  return (r && r.ok && r.column_count === 34) ? aiplStr_(r.version) : '';");
  } }));
  var rt = m.run('sysRuntimeAuthorityChecks_()');
  var stampsStillAgree = m.run("AIPL_BUILD_VERSION_") === 'F1-7N-FC-1B-E3-R4-A2-R1-R1';
  return rt.uniform === false && rt.divergent.length > 0 && stampsStillAgree;
});

// 14. The contract ignoring the runtime result.
mut('H14 the runtime result dropped from the contract verdict \u2192 a divergent deployment reports UNIFORM',
  function () {
    var m = build(A({ mutate: function (S) {
      S.aipl = swap(S.aipl, "  return (r && r.ok && r.lifecycle_complete) ? aiplStr_(r.version) : '';",
        "  return (r && r.ok && r.column_count === 34) ? aiplStr_(r.version) : '';");
      S.sys = swap(S.sys, '    mixed_deployment: (absent.length + stale.length) > 0 || runtime.uniform !== true,',
        '    mixed_deployment: (absent.length + stale.length) > 0,');
      S.sys = swap(S.sys, '    verdict: ((absent.length + stale.length) === 0 && runtime.uniform === true)',
        '    verdict: ((absent.length + stale.length) === 0)');
      // The verdict consults the runtime TWICE — once to decide UNIFORM, once to name the fault. A contract
      // that ignores the runtime stops doing both, and it is the NAMING that an operator acts on.
      S.sys = swap(S.sys, '      : (runtime.uniform !== true', '      : (false');
    } }));
    var dc = m.run('sysModuleBuildStamps_()');
    // `mixed_deployment` is already true in this fixture for an unrelated reason (it compiles a subset of the
    // owner files), so it cannot show this mutation. What the mutation removes is the verdict NAMING the
    // runtime fault, which is the half an operator acts on.
    return dc.runtime_authority.uniform === false && !/RUNTIME/.test(dc.verdict);
  });

// 15. The AI Plan locking a carrier from a lead-time row.
mut('H15 the lead-time carrier_id promoted to a selection \u2192 the AI Plan pre-empts the Weekly Shipping Plan',
  function () {
    var M = kmmrWith(function (src) {
      return swap(src, "      carrier_selection: 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN',\n      // This module reads no rate card",
        "      carrier_selection: 'SELECTED', selected_carrier_id: p.carrier_ids[0] || null,\n      // This module reads no rate card");
    });
    var r = M.recommend({ leadTimes: MIXED, lane: { originCountry: 'CN', destinationCountry: 'US' },
      daysUntilStockout: 200, buffer: { days: 7 } });
    return r.recommended.carrier_selection !== 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN'
      || r.recommended.selected_carrier_id != null;
  });

console.log('\n' + '='.repeat(112));
console.log('passed ' + pass + '  failed ' + fail + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
console.log('='.repeat(112));
if (fail) process.exit(1);
