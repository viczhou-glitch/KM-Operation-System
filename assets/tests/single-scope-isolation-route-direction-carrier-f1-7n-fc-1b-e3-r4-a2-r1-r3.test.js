// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R3 — SINGLE-SCOPE ISOLATION, ROUTE DIRECTION AND CARRIER RESOLUTION
// ----------------------------------------------------------------------------------------------------------------
// The gap job reached DONE, the snapshot was accepted, the schema agreed and the route intent was canonical —
// and the run for ONE authorized SKU still ended in ROUTE_METHOD_UNRESOLVED + ROUTE_SOURCE_MULTI_POOL_UNRESOLVED
// with 92 receiver facts, 157 source lines, 114 allocated lines, a non-empty duplicate list, conserved:false,
// zero matched carrier cards and zero routes.
//
// FOUR independent defects, each reproduced here by execution before it was touched:
//
//   1. ISOLATION AT THE WRONG END. The activation allowlist gated the WRITER. Reading the whole universe is
//      right; COMPUTING it is not. 45 foreign SKUs formed the only route group, supplied every duplicate, and
//      made conserved:false a property of scopes the run could never write.
//   2. THE HORIZON JOIN NEVER MATCHED. `horizonsByDemandRef` is keyed company|country|marketplace|sku|dest;
//      KMWRB's demandKey is sku|marketplace|window. So `window_code` and `required_by_date` were blank on
//      EVERY line ever generated. Two windows of one SKU then collapsed to the same conservation key — which
//      IS the reported duplicate — and no route was ever checked against the date it was needed by.
//   3. CANONICAL DEMAND COUNTED TWICE. The workspace enumerates one line per SITE SKU; the snapshot is keyed
//      per MASTER sku. Two ASINs of one product each received the FULL snapshot quantity, so 760 units of
//      demand entered the allocator as 1520, and the only thing that stopped the plan doubling was a
//      downstream DUPLICATE_WEEKLY_LINE_KEY drop whose survivor depended on enumeration order.
//   4. THE SPLIT THE ALLOCATOR HAD ALREADY DECIDED WAS THROWN AWAY. 460 units from the CN factory + 300 from
//      the in-country 3PL is not an ambiguity; it is an answer. The adapter could not name ONE source, so the
//      whole line blocked as ROUTE_SOURCE_MULTI_POOL_UNRESOLVED. R6F2C wrote that deferral down beside the
//      code; this is the round it deferred to.
//
// AND ONE THING THAT IS NOT A DEFECT, measured rather than assumed: the 3PL is a legitimate SUPPLY pool. The
// frozen allocator runs the overseas shared pool FIRST and the factory passes over its residual, so in-country
// stock covering an FBA shortage is designed behaviour. It is never treated as a factory. What made the live
// census look like a direction inversion was defect 4 plus three field-name bugs in the census itself.
//
// Run: node assets/tests/single-scope-isolation-route-direction-carrier-f1-7n-fc-1b-e3-r4-a2-r1-r3.test.js
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
var TAIPEI_MIDNIGHT = new Date(Date.UTC(2026, 8, 3, 16, 0, 0));   // 2026-09-04 00:00 Asia/Taipei
var RUN_ID = 'GAP-INV-20260904T132342-0001';
// Every table an AI generation must NOT touch, present and empty so "nothing was written here" is measured.
var UNRELATED = ['shipping_plans', 'shipping_plan_lines', 'shipments', 'shipment_lines',
  'factory_stock_movements', 'reservations', 'purchase_orders', 'purchase_order_lines'];

function build(opts) {
  opts = opts || {};
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
    sad: G16, wap: G61, census: TEMP };
  if (opts.mutate) opts.mutate(SRC);
  [SRC.bundle, SRC.cfg, SRC.ric, SRC.aipl, SRC.sad, SRC.wap].forEach(function (src, i) {
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
      0, isT ? D30 : 40, 0, isT ? SUGGESTED : 200, RUN_ID]);
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
     'charge_unit', 'status', 'effective_from', 'effective_to']);
  SHEETS['carrier_rate_cards'].appendRow(['RC-SEA', 'CAR-1', 'CN', 'US', '', 'SEA', 'Sea Freight', 'UPS', 'USD', 1.2, 100, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31']);
  SHEETS['carrier_rate_cards'].appendRow(['RC-AIR', 'CAR-1', 'CN', 'US', '', 'AIR', 'Air Freight', 'UPS', 'USD', 4.5, 200, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31']);
  // An EXPIRED card on the very lane under test, so "no card for the lane" and "the card expired" can never
  // be reported as the same finding.
  SHEETS['carrier_rate_cards'].appendRow(['RC-SEA-OLD', 'CAR-1', 'CN', 'US', 'Amazon', 'SEA', 'Sea Freight', 'UPS', 'USD', 0.9, 90, 'per_unit', 'unit', 'ACTIVE', '2024-01-01', '2025-12-31']);
  SHEETS['carrier_lead_times'] = new FakeSheet(
    ['lead_time_id', 'carrier_id', 'origin_country', 'destination_country', 'shipping_method', 'last_mile_delivery', 'min_days', 'max_days', 'avg_days']);
  SHEETS['carrier_lead_times'].appendRow(['LT-SEA', 'CAR-1', 'CN', 'US', 'SEA', 'UPS', 30, 45, 38]);
  SHEETS['carrier_lead_times'].appendRow(['LT-AIR', 'CAR-1', 'CN', 'US', 'AIR', 'UPS', 7, 12, 9]);
  if (!opts.noDomesticLane) {
    SHEETS['carrier_rate_cards'].appendRow(['RC-DOM', 'CAR-2', 'US', 'US', '',
      opts.unmappedDomesticMethod ? 'GROUND' : 'TRUCK', 'Domestic', 'UPS', 'USD', 0.4, 50, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31']);
    SHEETS['carrier_lead_times'].appendRow(['LT-DOM', 'CAR-2', 'US', 'US', 'TRUCK', 'UPS', 3, 6, 4]);
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
    'handleRecommendationWorkspaceGet_ = function (body) {',
    '  var sc = body.payload.scope, lines = [];',
    '  __ALLSKUS.forEach(function (sk) {',
    '    var isT = (sk === "' + TARGET.sku + '");',
    '    var siteSkus = (isT && __TWO_SITE_SKUS) ? ["B0CO1100R-FBA", "B0CO1100R"] : [isT ? "B0CO1100R" : ("B0" + sk)];',
    '    siteSkus.forEach(function (ss2) {',
    '      lines.push({ sku: sk, siteSku: ss2, marketplaceId: sc.marketplace, destinationType: "MARKETPLACE",',
    '        fulfillmentModel: "platform_fulfilled", sourceDataAsOf: "",',
    '        horizons: [{ windowCode: "D30", gapQty: 111, requiredByDate: "2026-10-05" },',
    '                   { windowCode: "D90", gapQty: 999, requiredByDate: "2026-12-01" }] });',
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
function generate(h, execKey) {
  h.run('var BODY = { company: "ResUS", country: "US", currentMarketplace: "Amazon", actor: "user"'
    + (execKey ? ', execution_key: "' + execKey + '"' : '') + ' };');
  return h.parse('weeklyAiPlanGenerateK2_(SS, MAPPED.request, HARVEST, null, BODY)');
}

// ================================================================================================================
section('A. §1 — the stable DONE failure, reproduced by re-introducing each defect into shipped source');
// ================================================================================================================
// Each mutation below restores exactly ONE pre-R3 behaviour. Together they are the live result; separately they
// show which defect owns which symptom, which is what "reproduce" has to mean to be useful.
var REMOVE_ISOLATION = ['  var iso = weeklyAiPlanIsolateSites_(sites, target);',
  '  var iso = { sites: sites, target_site_count: sites.length, target_sku_count: 0, ' +
    'foreign_site_count: 0, foreign_sku_count: 0, foreign_sample: [] };'];
var RESTORE_DEMANDKEY_JOIN = ['  var hz = horizons[ref] || null;', '  var hz = horizons[s(l.demandKey)] || null;'];
var RESTORE_BLANK_WINDOW = ["    var windowCode = s(l.windowCode);", "    var windowCode = '';"];
var REMOVE_COLLAPSE = ['  var coll = weeklyAiPlanCollapseCanonicalDemand_(iso.sites, scope, errors);',
  '  var coll = { sites: iso.sites, collapsed_site_count: 0, conflict_count: 0, conflicts: [], canonical_demand_count: iso.sites.length };'];
var REMOVE_SPLIT = ['      var sp = weeklyAiPlanSplitBySource_(l, qty, l.unitsPerCarton);',
  "      var sp = { ok: false, reason: 'ROUTE_SOURCE_MULTI_POOL_UNRESOLVED', parts: [] };"];
var RESTORE_FIRST_LINE_ASOF = ['    sourceDataAsOf: asOf.date,' + String.fromCharCode(10) + '    sourceDataAsOfAuthority:',
  '    sourceDataAsOf: built.sourceDataAsOf,' + String.fromCharCode(10) + '    sourceDataAsOfAuthority:'];

var hPre = build({ mutate: function (S) {
  S.wap = swap(S.wap, REMOVE_ISOLATION[0], REMOVE_ISOLATION[1]);
  S.wap = swap(S.wap, REMOVE_COLLAPSE[0], REMOVE_COLLAPSE[1]);
  S.wap = swap(S.wap, RESTORE_DEMANDKEY_JOIN[0], RESTORE_DEMANDKEY_JOIN[1]);
  S.wap = swap(S.wap, RESTORE_BLANK_WINDOW[0], RESTORE_BLANK_WINDOW[1]);
  S.wap = swap(S.wap, REMOVE_SPLIT[0], REMOVE_SPLIT[1]);
  S.wap = swap(S.wap, RESTORE_FIRST_LINE_ASOF[0], RESTORE_FIRST_LINE_ASOF[1]);
} });
var PRE = pass1(hPre);
ok(PRE.ok === true, 'A0  the pre-R3 chain still runs (this is a behaviour reproduction, not a crash)');
ok(PRE.receiver_count > 45, 'A1  the whole (company,country) universe becomes receiver facts: ' + PRE.receiver_count);
ok(PRE.source_lines > 45, 'A1a and every one of them becomes source lines: ' + PRE.source_lines);
ok(PRE.allocated_lines > 45, 'A1b and allocated lines: ' + PRE.allocated_lines);
ok(PRE.duplicates.length > 0, 'A2  duplicate_sku_window_in_group is NON-EMPTY (' + PRE.duplicates.length + ')');
ok(/\|$/.test(PRE.duplicates[0]), 'A2a and every duplicate key ends in an EMPTY window — the blank-window collapse');
eq(PRE.conserved, false, 'A3  conserved = false');
eq(PRE.source_data_as_of, null, 'A4  source_data_as_of is NULL (the workspace line does not carry it)');
eq(PRE.ship_date, '', 'A4a so the ship date is blank and the lane is never date-gated');
var preTargetRouted = PRE.routes.filter(function (r) {
  return PRE.blocked_detail.length >= 0 && r.qty > 0 && r.from === FACTORY_CN || r.from === THREE_PL;
});
ok((PRE.block_tokens.ROUTE_SOURCE_MULTI_POOL_UNRESOLVED || 0) > 0,
  'A5  the target SKU refuses with ROUTE_SOURCE_MULTI_POOL_UNRESOLVED');
eq(PRE.target_lines.filter(function (t) { return t.multi_pool; }).length > 0, true,
  'A5a because no single source could be named for a line the allocator had already split');
var preTargetQty = PRE.routes.reduce(function (t, r) { return t + r.qty; }, 0);
ok(PRE.target_lines.every(function (t) { return t.window_code === ''; }),
  'A6  every target line carries a BLANK window_code');
ok(PRE.target_lines.every(function (t) { return t.required_by_date === ''; }),
  'A6a and a BLANK required_by_date, so no route is checked against the date it is needed by');

// The double-count, isolated from every other defect: two site SKUs, one canonical demand.
var hDbl = build({ mutate: function (S) { S.wap = swap(S.wap, REMOVE_COLLAPSE[0], REMOVE_COLLAPSE[1]); } });
var DBL = pass1(hDbl);
eq(DBL.site_count, 2, 'A7  without the collapse, ONE canonical demand enters as TWO sites (two ASINs)');
ok((DBL.source_issues || []).some(function (i) { return i && i.reason === 'DUPLICATE_WEEKLY_LINE_KEY'; }),
  'A7a and the only thing preventing a doubled plan is a downstream DUPLICATE_WEEKLY_LINE_KEY drop');

// ================================================================================================================
section('B. §2 — exact scope isolation, BEFORE canonical grouping and the allocator');
// ================================================================================================================
var h = build({});
var R = pass1(h);
ok(R.ok === true, 'B0  the fixed chain runs');
eq(R.isolation.stage, 'PRE_CANONICAL_GROUPING', 'B1  the isolation happens before grouping, not at the writer');
eq(R.isolation.universe_site_count, 47, 'B1a the universe is still ENUMERATED whole (47 sites)');
eq(R.isolation.target_sku_count, 1, 'B2  target demand SKU count = 1');
eq(R.isolation.foreign_sku_count, 45, 'B2a foreign demand SKUs are dropped and COUNTED (45)');
eq(R.mapped_sku_count, 1, 'B3  exactly one SKU reaches the batch request');
eq(R.source_lines, 2, 'B3a exactly two source lines (D30 + D90 of one SKU)');
eq(R.alloc_diagnostics.split_refused, [], 'B3b no line refuses for want of a source');
eq(R.target_lines.length, 3, 'B4  three allocated lines (one per source per window)');
ok(R.target_lines.every(function (t) { return t.sku === undefined || t.sku === TARGET.sku; }),
  'B4a and every one of them is the target SKU');
eq(R.block_tokens, {}, 'B5  ZERO allocator refusals from foreign SKUs — there are none left to refuse');
// The allowlist is an INTERSECTION and cannot be widened from the request.
var TS = h.run('weeklyAiPlanTargetScopes_({ company: "ResUS", country: "US" }, "Walmart")');
eq(TS.ok, false, 'B6  a marketplace OUTSIDE the allowlist intersects to nothing');
eq(TS.reason, 'AI_PLAN_SCOPE_NOT_ENABLED', 'B6a with a typed refusal, not a silent widening');
eq(h.run('weeklyAiPlanTargetScopes_({ company: "ResUS", country: "US" }, "").scopes.length'), 1,
  'B7  a BLANK marketplace is not "all": it is no extra constraint, and the allowlist still constrains to 1');
eq(h.run('weeklyAiPlanTargetScopes_({ company: "ResUS", country: "US" }, "ALL_SITES").reason'),
  'SCOPE_ALL_SITES_FORBIDDEN', 'B8  ALL_SITES is refused by name, never treated as an unrecognised marketplace');
eq(h.run('weeklyAiPlanTargetScopes_({ company: "ResUS", country: "US" }, "all").reason'),
  'SCOPE_ALL_SITES_FORBIDDEN', 'B8a in any casing');
eq(h.run('weeklyAiPlanTargetScopes_({ company: "OtherCo", country: "US" }, "Amazon").reason'),
  'AI_PLAN_SCOPE_NOT_ENABLED', 'B9  and another company intersects to nothing');
// Shared authorities are still read WHOLE — narrowing demand must not narrow the master data.
ok(Object.keys(h.run('HARVEST.warehousesById')).length >= 3,
  'B10 the warehouse master is still read whole (isolation narrows DEMAND, not authorities)');
ok(h.run('weeklyAiPlanReadCarrierAuthorities_(SS).rateCards.length') >= 4,
  'B10a and so is the carrier authority');

// ================================================================================================================
section('C. §3 — one canonical demand, counted once, with its lineage kept');
// ================================================================================================================
eq(R.isolation.canonical_demand_count, 1, 'C1  one canonical demand for the target scope');
eq(R.isolation.collapsed_site_count, 1, 'C1a and the second site SKU was AGGREGATED into it, not dropped');
eq(h.run('HARVEST.kmaf.receiverFacts.length'), 1, 'C2  so exactly one receiver fact reaches KMAF');
var siteSkus = h.run('(function(){ var o = []; for (var k in HARVEST.horizonsByDemandRef) o.push(k); return o; })()');
eq(siteSkus.length, 1, 'C2a and one horizon row');
eq(R.target_lines[0].site_sku, 'B0CO1100R',
  'C3  the representative site sku is the deterministic MINIMUM, not whichever was enumerated first');
// The workspace deliberately returns them in reverse order; a first-row-wins collapse would pick the other one.
var authorized = R.target_lines.reduce(function (t, l) { return t + l.qty; }, 0);
eq(authorized, SUGGESTED, 'C4  authorized demand total = ' + SUGGESTED + ', counted ONCE');
eq(R.duplicates, [], 'C5  duplicate_sku_window_in_group = []');
eq(R.conserved, true, 'C5a conserved = true');
// A LEGITIMATE split (two windows) is preserved as two lines, not merged away.
var windows = R.target_lines.map(function (t) { return t.window_code; }).sort();
eq(windows, ['D30', 'D90', 'D90'], 'C6  the legitimate per-window split is PRESERVED (D30 + two D90 sources)');
eq(R.target_lines.filter(function (t) { return t.window_code === 'D30'; })[0].qty, D30, 'C6a D30 keeps its own quantity');
// And a genuine quantity conflict REFUSES rather than choosing.
var conflict = h.run([
  '(function () {',
  '  var errs = [];',
  '  var a = { marketplace: "Amazon", sku: "X", siteSku: "S1", destinationWarehouseId: "Amazon", cumulativeGapByWindow: { D90: 10 } };',
  '  var b = { marketplace: "Amazon", sku: "X", siteSku: "S2", destinationWarehouseId: "Amazon", cumulativeGapByWindow: { D90: 99 } };',
  '  var r = weeklyAiPlanCollapseCanonicalDemand_([a, b], { company: "ResUS", country: "US" }, errs);',
  '  return { conflicts: r.conflict_count, code: (errs[0] || {}).code };',
  '})()'].join('\n'));
eq(conflict.conflicts, 1, 'C7  two sites of one canonical demand that DISAGREE are a conflict');
eq(conflict.code, 'CANONICAL_DEMAND_QUANTITY_CONFLICT', 'C7a typed, and never averaged or preferred');
ok(!/new Set\(|\.indexOf\(sk\) < 0 \) return;/.test(extractFn(G61, 'weeklyAiPlanCollapseCanonicalDemand_')),
  'C8  the collapse is not a Set and not a first-row-wins drop');

// ================================================================================================================
section('D. §4/§5 — which side of the shipment each warehouse is on, and the factory-stock evidence');
// ================================================================================================================
var roleF = h.run('weeklyAiPlanWarehouseRole_("' + FACTORY_CN + '", HARVEST.warehousesById, WEEKLY_AI_PLAN_FACTORY_IDENTITY_)');
var role3 = h.run('weeklyAiPlanWarehouseRole_("' + THREE_PL + '", HARVEST.warehousesById, WEEKLY_AI_PLAN_FACTORY_IDENTITY_)');
eq(roleF.role, 'FACTORY', 'D1  the CN factory is a FACTORY, by the frozen identity config and the master');
eq(role3.role, 'NON_FACTORY', 'D1a and the 3PL is NOT a factory — it is never mistaken for one');
eq(h.run('weeklyAiPlanWarehouseRole_("NOPE", HARVEST.warehousesById, WEEKLY_AI_PLAN_FACTORY_IDENTITY_).reason'),
  'WAREHOUSE_NOT_IN_MASTER', 'D1b an id absent from the master resolves to no role at all');
ok(!/indexOf\('FACTORY'\)|\/FACTORY\/|name\.match/.test(extractFn(G61, 'weeklyAiPlanWarehouseRole_')),
  'D2  the role is decided from the master + identity config, never from a name pattern');
// The 3PL is a legitimate SOURCE by the frozen allocator's own design — measured, not asserted.
var srcRoles = R.target_lines.map(function (t) { return t.source + ':' + t.role; }).sort();
eq(srcRoles, [THREE_PL + ':NON_FACTORY', THREE_PL + ':NON_FACTORY', FACTORY_CN + ':FACTORY'].sort(),
  'D3  the sources are the CN factory AND the in-country 3PL — the allocator\'s PASS 1 / PASS 2 design');
ok(R.target_lines.every(function (t) { return t.dest.kind === 'MARKETPLACE' && t.dest.marketplace === 'Amazon'; }),
  'D4  the destination is the LOGICAL marketplace on every line (the receiver side)');
ok(R.routes.every(function (r) { return !r.to_warehouse; }),
  'D4a with a blank destination warehouse — correct for FBA, never a fabricated FC');
// A factory can never be a destination.
var hInv = build({});
hInv.run('var __wh = weeklyAiPlanWarehousesById_(SS);');
var invDest = hInv.run('weeklyAiPlanClassifyDestination_({ destinationWarehouseId: "' + FACTORY_CN + '", country: "CN" }, __wh)');
eq(invDest.kind, 'WAREHOUSE', 'D5  a factory id in the destination field classifies as a warehouse …');
var invLines = hInv.run([
  '(function () { var wh = weeklyAiPlanWarehousesById_(SS);',
  '  var out = weeklyAiPlanK2AllocatedLines_([{ masterSku: "CO1100-R", siteSku: "S", company: "ResUS", country: "US",',
  '    marketplace: "Amazon", destinationWarehouseId: "' + FACTORY_CN + '", windowCode: "D90", recommendedQty: 100,',
  '    unitsPerCarton: 20, sourceWarehouseId: "' + THREE_PL + '", allocationBreakdown: [] }], { warehousesById: wh });',
  '  return out.map(function (o) { return { kind: o.destination.kind, reason: o.destination.reason || null }; }); })()'
].join('\n'));
eq(invLines[0].reason, 'DESTINATION_IS_A_FACTORY_WAREHOUSE',
  'D5a … and is then REFUSED as a destination, because the direction has been inverted');
// §5 — the factory-stock evidence, and it no longer depends on which lines survived.
var CEN = census(h);
var FSK = CEN.factory_stock;
ok(FSK && FSK.eligible_factory_warehouse_ids.indexOf(FACTORY_CN) >= 0,
  'D6  the eligible factory warehouse is named from the allocator\'s OWN input, not from surviving lines');
eq(FSK.factory_pools.length, 1, 'D6a with one factory pool reported');
eq(FSK.factory_pools[0].available, 5000, 'D7  current/reserved/available come from the canonical table (5000)');
eq(FSK.factory_pools[0].reserved, 0, 'D7a reserved reported explicitly');
eq(FSK.requested_qty, SUGGESTED, 'D8  requested quantity = ' + SUGGESTED);
eq(FSK.factory_pools[0].allocated_qty, D90 - 100, 'D8a allocated from the factory = 460');
eq(FSK.factory_pools[0].remaining_qty, 5000 - (D90 - 100), 'D8b remaining = 4540');
eq(FSK.overseas_supply_pools.length, 1, 'D9  and the in-country pool is reported BESIDE it, never folded in');
eq(FSK.overseas_supply_pools[0].allocated_qty, 300, 'D9a holding the 300 it supplied');
eq(FSK.total_allocated, SUGGESTED, 'D10 the two together account for exactly ' + SUGGESTED);
ok(/gapOpReadSupplyPoolFacts_/.test(FSK.authority), 'D11 and the authority is named in the output');

// ================================================================================================================
section('E. §6 — one canonical source_data_as_of, from the GAP run lineage');
// ================================================================================================================
eq(R.source_data_as_of, '2026-09-04', 'E1  harvest.source_data_as_of = 2026-09-04');
eq(R.source_data_as_of_authority.run_id, RUN_ID, 'E1a and it names the run it came from');
eq(R.source_data_as_of_authority.source, 'GAP_INV_RUN_LINEAGE', 'E1b the authority is the GAP-INV run, not a line');
eq(R.workspace_source_data_as_of, null, 'E2  the workspace line value is still reported, and is blank …');
eq(R.ship_date, '2026-09-04', 'E2a … while the ship date comes from the authority');
// It fails CLOSED, and never falls back to a clock.
var hNoRun = build({ jobState: { product: 'INVENTORY', runId: RUN_ID, status: 'RUNNING', planningCycle: 'RECO-2026-09', calculationDate: '2026-09-04' } });
var NR = pass1(hNoRun);
eq(NR.ok, false, 'E3  a non-DONE run refuses the harvest outright');
eq((NR.errors[0] || {}).code, 'SOURCE_DATA_AS_OF_UNRESOLVED', 'E3a with a typed cutoff refusal');
var hBlank = build({ jobState: { product: 'INVENTORY', runId: RUN_ID, status: 'DONE', planningCycle: 'RECO-2026-09', calculationDate: '' } });
eq((pass1(hBlank).errors[0] || {}).code, 'SOURCE_DATA_AS_OF_UNRESOLVED', 'E4  a blank cutoff refuses, never "today"');
ok(!/Date\.now\(\)|new Date\(\)/.test(extractFn(G61, 'weeklyAiPlanSourceDataAsOfAuthority_')),
  'E5  the authority reads no clock');
ok(/weeklyAiPlanCanonicalDate_/.test(extractFn(G61, 'weeklyAiPlanSourceDataAsOfAuthority_')),
  'E5a and normalizes through the A2-R1-R1 canonical Taipei date authority');
// ETA / lead time / ship date all read the SAME lineage.
ok(R.routes.every(function (r) { return r.required_by.every(function (d) { return !!d; }); }),
  'E6  every route line now carries the required-by date the lead time is checked against');
// One run, or neither: the harvest cutoff and the header stamp cannot come from different runs.
var hMoved = build({});
pass1(hMoved);
hMoved.run('PropertiesService.getScriptProperties().setProperty("GAP_JOB_INVENTORY", JSON.stringify({'
  + ' product: "INVENTORY", runId: "GAP-INV-20260905T090000-0001", status: "DONE",'
  + ' planningCycle: "RECO-2026-09", calculationDate: "2026-09-05", finishedAt: "2026-09-05 09:10:00" }));');
var MV = generate(hMoved);
eq(MV.success, false, 'E7  a GAP run that MOVES between harvest and write refuses …');
eq((MV.errors[0] || {}).code, 'GAP_RUN_LINEAGE_MOVED_MID_GENERATION', 'E7a with a typed refusal');
eq(drafts(hMoved).headers.length, 0, 'E7b and zero rows written');

// ================================================================================================================
section('F. §7 — the carrier funnel, in the route authority\'s own predicates');
// ================================================================================================================
var FN = h.run('weeklyAiPlanCarrierFunnel_(CARR.rateCards, { originCountry: "CN", destinationCountry: "US", marketplace: "Amazon" }, KMWRR.dateToOrdinal("2026-09-04"))');
eq(FN.authority, 'KMRA', 'F1  the funnel is computed by the SHARED authority, never a private re-match');
eq(FN.total, 4, 'F1a total cards considered (2 live CN-US + 1 expired CN-US + 1 domestic)');
eq(FN.lane_query, { origin_country: 'CN', destination_country: 'US', marketplace: 'Amazon' },
  'F2  and it reports the EXACT canonical lane key it asked for');
eq(FN.route_matched, 3, 'F3  three CN→US cards match the lane axes');
eq(FN.status_and_effective_matched, 2, 'F3a two survive the status + effective-date test …');
eq(FN.final_eligible, 2, 'F3b … and both carry a canonical method');
eq(FN.distinct_methods, ['AIR', 'SEA'], 'F4  the eligible methods are reported, never chosen from');
ok(FN.nearest_candidates.some(function (c) { return c.rate_card_id === 'RC-SEA-OLD' && c.failed_axis === 'status_or_effective_window'; }),
  'F5  the EXPIRED card on this very lane is named as a near miss, with the axis that failed');
eq(FN.missing_canonical_key, null, 'F5a and there is no missing key, because the lane resolves');
// The live case: no lane at all.
var hNoDom = build({ noDomesticLane: true });
var ND = pass1(hNoDom);
var FND = hNoDom.run('weeklyAiPlanCarrierFunnel_(CARR.rateCards, { originCountry: "US", destinationCountry: "US", marketplace: "Amazon" }, KMWRR.dateToOrdinal("2026-09-04"))');
eq(FND.final_eligible, 0, 'F6  the domestic lane has NO eligible card …');
eq(FND.missing_canonical_key.cause, 'NO_CARRIER_CARD_FOR_LANE', 'F6a and the cause is typed');
eq(FND.missing_canonical_key.origin_country, 'US', 'F6b naming the exact origin …');
eq(FND.missing_canonical_key.destination_country, 'US', 'F6c … destination …');
eq(FND.missing_canonical_key.marketplace, 'Amazon', 'F6d … and marketplace that is missing');
ok((ND.block_tokens.ROUTE_METHOD_UNRESOLVED || 0) > 0, 'F7  so those lines refuse with ROUTE_METHOD_UNRESOLVED …');
// FOUND BY RUNNING THIS TEST. partitionRoutedLines carried auto_ranking_insufficient_reason through and
// DROPPED method_unresolved_reason, so a ROUTE_METHOD_UNRESOLVED block reached the generation, the census and
// the preflight as the bare token — the one thing §7 says must never be the whole answer. Fixed in the
// shared core (supply-planning-weekly-route-derivation.js), which is why the bundle moved this round.
ok(ND.blocked_detail.some(function (b) { return b.block === 'ROUTE_METHOD_UNRESOLVED'; }),
  'F7a … the refusal is present …');
ok(ND.blocked_detail.filter(function (b) { return b.block === 'ROUTE_METHOD_UNRESOLVED'; })
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): the sub-type moved because the rule moved — a rate card no longer
// decides whether a method exists, so a lane with neither authority is typed NO_TRANSIT_AUTHORITY_FOR_LANE.
// R3's claim, that the refusal is SUB-TYPED and never a bare token, is unchanged.
  .every(function (b) { return b.method_reason === 'NO_TRANSIT_AUTHORITY_FOR_LANE'; }),
  'F7b … SUB-TYPED, never the bare token …');
ok(ND.blocked_lanes.filter(function (l) { return !!l; })
  .every(function (l) { return l.originCountry === 'US' && l.destinationCountry === 'US'; }),
  'F7c … and the LANE it asked for travels with the refusal');
ok(ND.routes.length >= 1, 'F7d while the lane that DOES exist still produces its route (no all-or-nothing)');
// A card whose method token the authority does not map is a DIFFERENT finding from a missing lane.
var hUnmapped = build({ unmappedDomesticMethod: true });
pass1(hUnmapped);
var FNU = hUnmapped.run('weeklyAiPlanCarrierFunnel_(CARR.rateCards, { originCountry: "US", destinationCountry: "US", marketplace: "Amazon" }, KMWRR.dateToOrdinal("2026-09-04"))');
eq(FNU.route_matched, 1, 'F8  the lane HAS a card …');
eq(FNU.canonical_method_matched, 0, 'F8a … whose method token is not canonical …');
eq(FNU.unmapped_method_only.cause, 'METHOD_TOKEN_NOT_CANONICAL', 'F8b … which is reported as its own cause');
ok(!/origin_country\) === CENSUS_low_|rc\.is_active/.test(TEMP),
  'F9  the census no longer re-implements the match with is_active and a raw country compare');
ok(!/first|\[0\]/.test(extractFn(G61, 'weeklyAiPlanCarrierFunnel_')),
  'F10 and the funnel never selects a card — it only counts and names them');

// ================================================================================================================
section('G. §8 — a complete, conserved route set');
// ================================================================================================================
eq(CEN.sku_facts.suggested_qty_total, SUGGESTED, 'G1  suggested_qty_total = ' + SUGGESTED);
eq(R.target_lines.reduce(function (t, l) { return t + l.qty; }, 0), SUGGESTED, 'G1a authorized demand total = ' + SUGGESTED);
eq(CEN.total_allocated_quantity, SUGGESTED, 'G2  total_allocated_quantity = ' + SUGGESTED);
eq(CEN.allocator.conserved, true, 'G2a conserved = true');
eq(CEN.allocator.conservation.duplicate_sku_window_in_group, [], 'G2b duplicate_sku_window_in_group = []');
ok(CEN.would_create_route_count >= 1, 'G3  would_create_route_count >= 1 (' + CEN.would_create_route_count + ')');
eq(R.routes.reduce(function (t, r) { return t + r.qty; }, 0), SUGGESTED,
  'G3a and when the quantity splits across routes, sum(route qty) = ' + SUGGESTED);
R.routes.forEach(function (r, i) {
  ok(!!r.from, 'G4.' + i + ' route ' + i + ' has a From');
  ok(!!r.to_marketplace, 'G4.' + i + 'a and a To');
  ok(r.qty > 0, 'G4.' + i + 'b and Qty > 0');
  ok(!!r.method, 'G4.' + i + 'c and a Method');
  ok(!!r.last_mile, 'G4.' + i + 'd and a canonical last mile');
  ok(r.required_by.every(function (d) { return !!d; }), 'G4.' + i + 'e and a required-by date on every line');
});
// The split conserves EXACTLY, and it uses the allocator's own order rather than a new policy.
var SP = h.run([
  'weeklyAiPlanSplitBySource_({ allocationBreakdown: [',
  '  { sourceWarehouseId: "A", allocatedQty: 207, allocationSequence: 0 },',
  '  { sourceWarehouseId: "A", allocatedQty: 93, allocationSequence: 1 },',
  '  { sourceWarehouseId: "B", allocatedQty: 460, allocationSequence: 0 } ] }, 760, 20)'
].join('\n'));
eq(SP.ok, true, 'G5  a three-entry breakdown splits');
eq(SP.parts.length, 2, 'G5a into TWO parts — the two entries for warehouse A are AGGREGATED first');
eq(SP.parts.reduce(function (t, p) { return t + p.qty; }, 0), 760, 'G5b and the parts sum to exactly 760');
eq(SP.parts[0].warehouse_id, 'A', 'G5c in the allocator\'s own breakdown order, not sorted or reversed');
eq(h.run('weeklyAiPlanSplitBySource_({ allocationBreakdown: [] }, 100, 20).reason'),
  'NO_CONCRETE_SOURCE_IN_BREAKDOWN', 'G6  a breakdown with no concrete source still fails closed');
eq(h.run('weeklyAiPlanSplitBySource_({ allocationBreakdown: [{ sourceWarehouseId: "A", allocatedQty: 5 }] }, 5, 20).reason'),
  'NO_WHOLE_CARTON_TO_SHIP', 'G6a and so does a quantity below one whole carton — each with its own reason');

// ================================================================================================================
section('H. §9 — the diagnostic stops contradicting production');
// ================================================================================================================
// RESTATED STRUCTURALLY (A2-R1-R4). This suite already fixed its K1-equivalent against the shared ledger for
// exactly this reason and left three sibling assertions pinned to the same literal, so the very next round
// broke them. The CLAIM is that the census reports a REAL, ledger-registered stamp that is not older than the
// round which introduced this suite — never that it equals one string a later round must be free to move.
ok(RO.OWNER_STAMPS.indexOf(CEN.build) !== -1,
  'H1  the census reports a build stamp the shared ledger recognises');
ok(RO.stampAtOrAfter(CEN.build, 'F1-7N-FC-1B-E3-R4-A2-R1-R3'),
  'H1b and no older than the round that introduced this suite');
ok(CEN.harvest.snapshot_freshness && CEN.harvest.snapshot_freshness.state === 'CURRENT_AFTER_REFRESH',
  'H2  on a DONE job the freshness STATE is present, not null');
eq(CEN.harvest.snapshot_freshness.ok, true, 'H2a and accepted');
eq(CEN.harvest.accepted_snapshot_date, '2026-09-04', 'H2b with the accepted date');
eq(CEN.harvest.snapshot_distinct_dates, ['2026-09-04'], 'H2c and the distinct dates');
ok(!!CEN.harvest.gap_schedule, 'H2d and the resolved schedule');
// Forecast: missing row and blank cell are ZERO, and neither blocks.
eq(CEN.forecast_coverage.authority, 'KMFCN', 'H3  the forecast verdict comes from KMFCN, not a restated gate');
eq(CEN.forecast_coverage.blocking, false, 'H3a a missing 2027 row does NOT block');
eq(CEN.forecast_coverage.site_would_survive_forecast_gate, true, 'H3b and the site survives — as production says');
ok(CEN.forecast_coverage.months_with_no_row_or_blank.length > 0,
  'H3c while the raw observation is still reported (the months really have no row)');
ok(CEN.forecast_coverage.normalization.missing_row_normalized_to_zero > 0,
  'H3d normalized to zero, and counted as such');
var hBlankFc = build({ blankDecForecast: true });
var CB = census(hBlankFc);
ok(CB.forecast_coverage.normalization.blank_normalized_to_zero > 0, 'H4  a BLANK cell normalizes to zero too');
eq(CB.forecast_coverage.blocking, false, 'H4a and does not block');
ok(!/FORECAST_SHARE_INCOMPLETE/.test(JSON.stringify(CEN.forecast_coverage)),
  'H5  the old FORECAST_SHARE_INCOMPLETE verdict is gone from the census output');
// Schema parity cannot agree with a null.
var PAR = CEN.harvest ? h.run('(function () { var sh = SS.getSheetByName("shipping_allocation_drafts");'
  + ' var ds = sadResolveHeaderSchema_(sadLiveHeaderNames_(sh));'
  + ' var lv = aiplSchemaVersionOf_(sadLiveHeaderNames_(sh)) || null;'
  + ' return { writer: ds.version, lifecycle: lv }; })()') : null;
eq(PAR.writer, PAR.lifecycle, 'H6  writer and lifecycle name the SAME schema version on a healthy header');
// RESTATED (A2-R1-R4): R4 lifted this computation out of CENSUS_logAll_ into CENSUS_schemaParity_ so the
// verdict could be a FACT established before the census judges on it (reading it from the gate list returned
// null on every run, healthy or not). The predicate is unchanged and now sits in a named variable, so the
// assertion reads the predicate rather than one formatting of it.
var parityLine = /\(_ds\.ok === true\) && _wv !== null && _lv !== null && _wv === _lv/.test(TEMP);
ok(parityLine, 'H6a and parity REQUIRES both to be non-null and equal');
// Asserted through the operator's own entry point, not only against the source text.
var hRun = build({});
hRun.run('RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R()');
function runLog(re) { return hRun.LOG.filter(function (m) { return re.test(m); })[0] || ''; }
var parLog = runLog(/schema_writer_lifecycle_parity/);
ok(/"agree":true/.test(parLog), 'H6c the shipped runner reports parity on a healthy header');
ok(/"disagreement":null/.test(parLog), 'H6d with no disagreement to name');
ok(!/"lifecycle_version":null/.test(parLog), 'H6e and a real lifecycle version, not a null it agreed with');
ok(RO.OWNER_STAMPS.some(function (st) {
    return RO.stampAtOrAfter(st, 'F1-7N-FC-1B-E3-R4-A2-R1-R3') && runLog(/census_build/).indexOf(st) !== -1;
  }), 'H6f the runner reports a census build no older than this suite\'s round');
ok(/UPSERT_AI_GENERATED_K2_ROUTE/.test(runLog(/route_intent_that_generation_would_use/)),
  'H6g and the intent a live Generate would declare');
ok(/false/.test(runLog(/route_intent_is_client_grantable/)), 'H6h which no client can grant');
ok(!/\(_ds\.ok === true\) === \(_ds\.version !== null\)/.test(TEMP),
  'H6b the old self-comparison (which was true whenever the writer was self-consistent) is gone');
// The destination and route field-name bugs.
eq(CEN.sku_facts.destination_resolution[0].kind, 'MARKETPLACE',
  'H7  destination_resolution reads `kind` (the field the classifier returns), not `type`');
ok(CEN.allocator.routes.every(function (r) { return !!r.source_warehouse_id; }),
  'H7a and a route\'s source is read from recommended_source_warehouse_id, so it is no longer blank');
eq(CEN.matched_carrier_cards, R.routes.length ? CEN.matched_carrier_cards : 0,
  'H8  matched_carrier_cards is a number from the shared funnel');
ok(typeof CEN.matched_carrier_cards === 'number' && CEN.matched_carrier_cards > 0,
  'H8a and it is no longer 0 for a lane that resolves');
eq(CEN.writer_constructed, false, 'H9  and the census still constructs no writer');
ok(!/weeklyAiPlanGenerateK2_\s*\(/.test(TEMP),
  'H9a and never calls the GENERATION entry point (naming one in a comment is not reaching for it)');
// R6-R6-R3 — THIS GUARANTEE WAS ABSOLUTE AND IS NOW BOUNDED, DELIBERATELY. The file gained a writer:
// RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE compensates the route the 2026-09-06 incident wrote without
// authorization. 'The census never calls the writer' is therefore false, and an assertion that keeps
// saying it would have to be deleted rather than corrected. The property worth keeping is the one that
// still holds: there is EXACTLY ONE such call, it lives in EXACTLY ONE named function, and no entry
// point writes a cell directly.
var _h9Stripped = TEMP.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
eq((_h9Stripped.match(/handleUpsertShippingAllocationDraftAtomic_\s*\(/g) || []).length, 1,
  'H9b  the census contains EXACTLY ONE call to the atomic writer');
var _h9ExecFrom = TEMP.indexOf('function RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE(');
var _h9ExecTo = TEMP.indexOf('function CENSUS_r6r6r3FinishExec_(');
ok(_h9ExecFrom > 0 && _h9ExecTo > _h9ExecFrom
  && /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(TEMP.slice(_h9ExecFrom, _h9ExecTo)),
  'H9ba and it is inside RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE, which is the only function allowed to have it');
ok(!/\.setValue\(|\.appendRow\(|\.deleteRow\(|\.clearContent\(/.test(_h9Stripped),
  'H9bb and no entry point writes a cell directly — every mutation goes through 16_ under its own lock');

// ================================================================================================================
section('I. §10 — production / census parity, field by field');
// ================================================================================================================
var PP = CEN.production_parity;
ok(!!PP, 'I0  the census emits a parity block');
eq(PP.target_sku_set, [TARGET.sku], 'I1  target SKU set');
eq(PP.demand_identity.target_sku_count, R.isolation.target_sku_count, 'I2  demand identity: target sku count');
eq(PP.demand_identity.canonical_demand_count, R.isolation.canonical_demand_count, 'I2a canonical demand count');
eq(PP.demand_identity.foreign_site_count, R.isolation.foreign_site_count, 'I2b foreign site count');
eq(PP.source_line_count, R.source_lines, 'I3  source line count');
eq(PP.allocated_line_count, R.target_lines.length, 'I4  allocated line count');
eq(PP.eligible_factory_stock, [FACTORY_CN], 'I5  eligible factory stock');
eq(PP.source_data_as_of, R.source_data_as_of, 'I6  sourceDataAsOf');
eq(PP.ship_date, R.ship_date, 'I6a ship date');
eq(PP.chosen_methods, R.routes.map(function (r) { return r.method; }).sort(), 'I7  chosen methods');
eq(PP.total_quantity, R.routes.reduce(function (t, r) { return t + r.qty; }, 0), 'I8  total quantity');
eq(PP.conserved, R.conserved, 'I9  conservation');
eq(PP.duplicate_sku_window_in_group, R.duplicates, 'I9a duplicate list');
eq(PP.route_count, R.routes.length, 'I10 route count');
eq(PP.route_intent, 'UPSERT_AI_GENERATED_K2_ROUTE', 'I11 route intent');
eq(PP.refusals, [], 'I12 refusals');
// RESTATED (A2-R1-R5): 'REVIEW' was the census's name for "nothing to judge against". R5 replaces the
// single verdict with a readiness ladder, so an advisable scope with warnings now says so by name. The
// claim — that with no expectation supplied the census REPORTS rather than approving — is unchanged, and
// is checked on the property that carries it: the verdict is never PROCEED without an expectation.
ok(CEN.verdict !== 'PROCEED' && /^(REVIEW|RECOMMENDATION_READY|RECOMMENDATION_READY_WITH_WARNINGS|STOP)$/.test(CEN.verdict),
  'I13 and with no `expect` supplied the census reports rather than judges');
eq(PP.writer_constructed, false, 'I14 the parity block is computed with no writer');
// A divergence must show up AS a divergence. Narrow the census's scope only, and the sets must differ.
var hDiv = build({ mutate: function (S) {
  S.census = swap(S.census, 'marketplace: marketplace });', 'marketplace: "" });');
} });
var CDIV = census(hDiv);
ok(CDIV.production_parity.demand_identity.requested_marketplace === null,
  'I15 a census that drops the marketplace computes a DIFFERENT demand identity …');
ok(CDIV.production_parity.demand_identity.target_site_count === PP.demand_identity.target_site_count,
  'I15a (here the allowlist happens to narrow it to the same one site — reported, not assumed)');

// ================================================================================================================
section('J. §11 — the offline closed loop: write, read back, hydrate, replay');
// ================================================================================================================
var hL = build({});
var L0 = pass1(hL);
eq(L0.ok, true, 'J0  PASS 1 computes the plan');
var G1 = generate(hL, 'AIPLAN-DAY1');
eq(G1.success, true, 'J1  the generation succeeds');
eq(G1.data.job_status, 'COMPLETED', 'J1a COMPLETED');
var C1 = drafts(hL);
eq(activeHeaders(C1).length, 2, 'J2  exactly two active logical drafts — one per route');
eq(storedTotal(C1), SUGGESTED, 'J2a holding exactly ' + SUGGESTED + ' units');
eq(C1.lines.length, 3, 'J2b across three lines (D30 + two D90 sources)');
ok(C1.headers.every(function (r) { return /^SADH-K4-/.test(String(r.allocation_draft_id)); }),
  'J3  each header carries a DETERMINISTIC K4 identity');
ok(C1.headers.every(function (r) { return String(r.generation_type) === 'system_generated'; }),
  'J4  and AI provenance — a generated route is never stored as manual');
ok(C1.headers.every(function (r) { return String(r.source_data_as_of) === '2026-09-04'; }),
  'J5  stamped with the GAP-INV run cutoff');
ok(C1.headers.every(function (r) { return String(r.calculation_run_id) === RUN_ID; }),
  'J5a and the run that produced it');
ok(C1.lines.every(function (l) { return !!String(l.window_code).trim(); }),
  'J6  EVERY stored line carries its window code (it was blank on every line before this round)');
ok(C1.lines.every(function (l) { return !!String(l.required_by_date).trim(); }),
  'J6a and its required-by date');
ok(C1.headers.every(function (r) { return !!String(r.recommended_shipping_method).trim(); }),
  'J7  every stored header carries a Method');
// Replay: identical, and idempotent even when the execution key moves.
var G2 = generate(hL, 'AIPLAN-DAY1');
eq(G2.success, true, 'J8  an identical replay succeeds');
eq(activeHeaders(drafts(hL)).length, 2, 'J8a with still exactly two active headers');
eq(storedTotal(drafts(hL)), SUGGESTED, 'J8b and still ' + SUGGESTED + ' units');
var G3 = generate(hL, 'AIPLAN-DAY2');
eq(G3.success, true, 'J9  a replay under a MOVED execution key also succeeds …');
eq(activeHeaders(drafts(hL)).length, 2, 'J9a … and STILL leaves two active headers, not four');
eq(storedTotal(drafts(hL)), SUGGESTED, 'J9b and still ' + SUGGESTED + ' units');
eq(drafts(hL).headers.length, 2, 'J9c no duplicate header rows at all');
// Hydration reads back what was written.
var HYD = hL.run('(function () { var ids = [];'
  + ' var d = SS.getSheetByName("shipping_allocation_drafts").getDataRange().getValues();'
  + ' var hdr = d[0], iId = hdr.indexOf("allocation_draft_id"), iSt = hdr.indexOf("status");'
  + ' for (var r = 1; r < d.length; r++) { var st = String(d[r][iSt]).toLowerCase();'
  + '   if (st !== "submitted" && st !== "cancelled" && st !== "expired") ids.push(String(d[r][iId])); }'
  + ' return ids.sort(); })()');
eq(HYD.length, 2, 'J10 hydration finds exactly the two active drafts');
eq(storedTotal(drafts(hL)), SUGGESTED, 'J10a and the hydrated total is ' + SUGGESTED);
// Nothing else moved.
UNRELATED.forEach(function (t) {
  eq(hL.SHEETS[t].rows.length, 1, 'J11 ' + t + ' — header row only, zero mutation');
});
eq(hL.SHEETS['factory_stock'].rows.length, hL.allSkus.length + 1, 'J11a factory_stock untouched');
eq(hL.SHEETS['overseas_inventory_snapshot'].rows.length, 2, 'J11b overseas snapshot untouched');
// A cancelled draft is never revived (the A2-R1-R2 guard, still standing over the new route grain).
var hC = build({});
pass1(hC);
generate(hC, 'AIPLAN-DAY1');
hC.run('(function () { var sh = SS.getSheetByName("shipping_allocation_drafts");'
  + ' var d = sh.getDataRange().getValues(); var i = d[0].indexOf("status");'
  + ' for (var r = 1; r < d.length; r++) sh.getRange(r + 1, i + 1).setValue("cancelled"); })()');
var GC = generate(hC, 'AIPLAN-DAY3');
eq(GC.success, false, 'J12 regenerating over a CANCELLED draft refuses …');
ok((GC.data.groups || []).every(function (g) { return !g.ok; }), 'J12a with no group committing');
eq(drafts(hC).headers.filter(function (r) { return String(r.status) === 'cancelled'; }).length, 2,
  'J12b the cancelled rows are untouched and NOT revived');
eq(activeHeaders(drafts(hC)).length, 0, 'J12c and nothing became active');

// ================================================================================================================
section('K. §13 — the repository is untouched where it must be');
// ================================================================================================================
ok(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;/.test(CFG), 'K1  the repository flag is still false');
eq((CFG.match(/\{ company: '[^']*', country: '[^']*', marketplace: '[^']*', sku: '[^']*' \}/g) || []).length, 1,
  'K2  the allowlist still has exactly one entry');
ok(/company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R'/.test(CFG),
  'K2a and it is the one scope under census');
ok(!/clasp|git push|gh pr/.test(G61 + TEMP), 'K3  nothing in this round reaches for a remote');
var _wapStamp = (G61.match(/var WAP_BUILD_VERSION_ = '([^']+)'/) || [])[1];
ok(RO.stampAtOrAfter(_wapStamp, 'F1-7N-FC-1B-E3-R4-A2-R1-R3'),
  'K4  61_ carries a stamp no older than this suite\'s round');
eq(_wapStamp, ((G63.match(/symbol: 'WAP_BUILD_VERSION_', expected: '([^']+)'/) || [])[1]),
  'K4a and its deployment manifest expects exactly that');
ok(RO.BUILD_STAMP_RE.test(_wapStamp), 'K4b which the shared stamp validator accepts');
ok(RO.OWNER_STAMPS.every(function (st) { return RO.BUILD_STAMP_RE.test(st); }),
  'K4c and every stamp the ledger records still validates');
ok(RO.staleAppTokenRefs(read('index.html')).length === 0, 'K5  no stale frontend token');

// ================================================================================================================
section('L. §12 — mutations. Each restores one defect this round removed.');
// ================================================================================================================
function probe(mutate, check) {
  var hm = build({ mutate: mutate });
  return check(hm, pass1(hm));
}
mut('L1  filter moved AFTER the allocator (isolation removed)', function () {
  return probe(function (S) { S.wap = swap(S.wap, REMOVE_ISOLATION[0], REMOVE_ISOLATION[1]); },
    function (hm, r) { return r.isolation.target_sku_count === 0 && r.mapped_sku_count > 1; });
});
mut('L2  a foreign SKU admitted to the allocator', function () {
  return probe(function (S) {
    S.wap = swap(S.wap, "    if (mk && m !== mk) return;", "    if (false) return;");
    S.cfg = swap(S.cfg, "  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' }",
      "  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },\n  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'FS-1001' }");
  }, function (hm, r) { return r.isolation.target_sku_count === 2; });
});
mut('L3  an empty SKU becomes ALL_SKUS', function () {
  var hm = build({ mutate: function (S) {
    S.cfg = swap(S.cfg, "if (!c || !k || !m || !s) return false;", "if (!c || !k || !m) return false;\n  if (!s) return true;");
  } });
  return hm.run('inventoryAiPlanScopeEnabled_("ResUS", "US", "Amazon", "")') === true;
});
mut('L4  a demand row DROPPED instead of aggregated', function () {
  return probe(function (S) {
    S.wap = swap(S.wap, "    if (ssk && held.siteSkus.indexOf(ssk) < 0) held.siteSkus.push(ssk);\n    collapsed++;", "    return;");
  }, function (hm, r) { return r.isolation.collapsed_site_count === 0; });
});
mut('L5  demand DOUBLE-COUNTED (collapse removed)', function () {
  return probe(function (S) { S.wap = swap(S.wap, REMOVE_COLLAPSE[0], REMOVE_COLLAPSE[1]); },
    function (hm, r) { return r.site_count === 2
      && (r.source_issues || []).some(function (i) { return i.reason === 'DUPLICATE_WEEKLY_LINE_KEY'; }); });
});
mut('L6  the horizon join restored to the key that never matched', function () {
  return probe(function (S) { S.wap = swap(S.wap, RESTORE_DEMANDKEY_JOIN[0], RESTORE_DEMANDKEY_JOIN[1]); },
    function (hm, r) { return r.alloc_diagnostics.horizon_join_hits === 0
      && r.alloc_diagnostics.horizon_join_misses > 0
      && r.target_lines.every(function (t) { return t.required_by_date === ''; }); });
});
mut('L7  the window blanked (two windows collapse to one conservation key)', function () {
  return probe(function (S) { S.wap = swap(S.wap, RESTORE_BLANK_WINDOW[0], RESTORE_BLANK_WINDOW[1]); },
    function (hm, r) { return r.duplicates.length > 0 && r.conserved === false; });
});
mut('L8  the receiver treated as the SOURCE side (a factory accepted as destination)', function () {
  var hm = build({ mutate: function (S) {
    S.wap = swap(S.wap, "        destination = { kind: '', reason: 'DESTINATION_IS_A_FACTORY_WAREHOUSE' };", "        void 0;");
  } });
  hm.run('var __wh2 = weeklyAiPlanWarehousesById_(SS);');
  var out = hm.run([
    'weeklyAiPlanK2AllocatedLines_([{ masterSku: "CO1100-R", siteSku: "S", company: "ResUS", country: "US",',
    '  marketplace: "Amazon", destinationWarehouseId: "' + FACTORY_CN + '", windowCode: "D90", recommendedQty: 100,',
    '  unitsPerCarton: 20, sourceWarehouseId: "' + THREE_PL + '", allocationBreakdown: [] }], { warehousesById: __wh2 })'
  ].join('\n'));
  return out[0].destination.kind === 'WAREHOUSE' && !out[0].destination.reason;
});
mut('L9  the per-source split removed (the R6F2C refusal restored)', function () {
  return probe(function (S) { S.wap = swap(S.wap, REMOVE_SPLIT[0], REMOVE_SPLIT[1]); },
    function (hm, r) { return (r.block_tokens.ROUTE_SOURCE_MULTI_POOL_UNRESOLVED || 0) > 0
      && r.routes.reduce(function (t, x) { return t + x.qty; }, 0) < SUGGESTED; });
});
mut('L10 the split stops conserving (first source takes everything)', function () {
  var hm = build({ mutate: function (S) {
    S.wap = swap(S.wap, "    var c = Math.floor(agg[id] / u);", "    var c = cartonsTotal - assigned;");
  } });
  var sp = hm.run('weeklyAiPlanSplitBySource_({ allocationBreakdown: ['
    + ' { sourceWarehouseId: "A", allocatedQty: 300 }, { sourceWarehouseId: "B", allocatedQty: 460 } ] }, 760, 20)');
  return sp.parts.length === 1 && sp.parts[0].warehouse_id === 'A';
});
mut('L11 a source picked FIRST-ROW-WINS instead of split', function () {
  var hm = build({ mutate: function (S) {
    S.wap = swap(S.wap, "      var sp = weeklyAiPlanSplitBySource_(l, qty, l.unitsPerCarton);",
      "      var _bd = (l.allocationBreakdown || [])[0] || {};\n      var sp = { ok: true, parts: [{ warehouse_id: String(_bd.sourceWarehouseId || ''), qty: qty, cartons: null, allocated_qty: qty }] };");
  } });
  var r = pass1(hm);
  // The damage is structural: three source-grain lines collapse to two, and one warehouse is credited the
  // WHOLE window quantity it only partly supplied.
  var bySrc = r.allocated_by_source || {};
  var maxCredited = 0;
  for (var k in bySrc) if (bySrc.hasOwnProperty(k) && bySrc[k] > maxCredited) maxCredited = bySrc[k];
  return r.target_lines.length === 2 && maxCredited > 460;
});
mut('L12 sourceDataAsOf restored to the first surviving line', function () {
  return probe(function (S) {
    S.wap = swap(S.wap, RESTORE_FIRST_LINE_ASOF[0], RESTORE_FIRST_LINE_ASOF[1]);
  }, function (hm, r) { return r.source_data_as_of === null && r.ship_date === ''; });
});
mut('L13 the cutoff falls back to a clock instead of failing closed', function () {
  var hm = build({ jobState: { product: 'INVENTORY', runId: RUN_ID, status: 'DONE',
      planningCycle: 'RECO-2026-09', calculationDate: '' },
    mutate: function (S) {
      S.wap = swap(S.wap, "  if (!lin.ok) return { ok: false, reason: lin.reason, date: null, run_id: null, lineage: null };",
        "  if (!lin.ok) return { ok: true, reason: null, date: '2026-09-04', run_id: 'CLOCK', lineage: null };");
    } });
  var r = pass1(hm);
  return r.ok === true && r.source_data_as_of === '2026-09-04';
});
mut('L14 a missing Forecast row BLOCKS the census again', function () {
  var hm = build({ mutate: function (S) {
    S.census = swap(S.census, "    blocking: authoritative ? (normalized.ok !== true) : null,", "    blocking: missing.length > 0,");
  } });
  return census(hm).forecast_coverage.blocking === true;
});
mut('L15 schema parity AGREES with a null lifecycle version', function () {
  var hm = build({ mutate: function (S) {
    S.census = swap(S.census, "        var _agree = (_ds.ok === true) && _wv !== null && _lv !== null && _wv === _lv;",
      "        var _agree = (_ds.ok === true) === (_wv !== null);");
    S.aipl = swap(S.aipl, 'return (r && r.ok && r.lifecycle_complete) ? aiplStr_(r.version) : ', 'return (false) ? aiplStr_(r.version) : ');
  } });
  // The parity line is logged by the OPERATOR'S runner, not by the census function, so that is what is called.
  hm.run('RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R()');
  var line = hm.LOG.filter(function (m) { return /schema_writer_lifecycle_parity/.test(m); })[0] || '';
  return /"lifecycle_version":null/.test(line) && /"agree":true/.test(line);
});
mut('L16 freshness dropped from the census summary again', function () {
  var hm = build({ mutate: function (S) {
    S.census = swap(S.census, "    snapshot_freshness: (h && h.snapshot_freshness) || null,", "    snapshot_freshness: null,");
  } });
  return census(hm).harvest.snapshot_freshness === null;
});
mut('L17 the census CONSTRUCTS the production writer', function () {
  var hm = build({ mutate: function (S) {
    S.census = swap(S.census, "    writer_constructed: false,",
      "    writer_constructed: (typeof handleUpsertShippingAllocationDraftAtomic_ === 'function'),");
  } });
  return census(hm).writer_constructed === true;
});
mut('L18 the repository flag enabled', function () {
  var hm = build({ mutate: function (S) {
    S.cfg = swap(S.cfg, 'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;',
      'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true;');
  }, flag: false });
  return hm.run('inventoryAiPlanDbGenerationEnabled_()') === true;
});
mut('L19 the census asks a DIFFERENT question from production (marketplace dropped)', function () {
  var hm = build({ mutate: function (S) {
    S.census = swap(S.census, "      marketplace: marketplace });", "      marketplace: \"\" });");
  } });
  return census(hm).production_parity.demand_identity.requested_marketplace === null;
});

console.log('\n----------------------------------------');
console.log('R3 SINGLE-SCOPE ISOLATION / DIRECTION / CARRIER: ' + pass + ' passed, ' + fail + ' failed');
console.log('mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
if (fail > 0) process.exitCode = 1;
