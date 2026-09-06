// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R4 — LIVE CARRIER AUTHORITY, LIFECYCLE SCHEMA PARITY, ALLOCATION COMPLETENESS
// ----------------------------------------------------------------------------------------------------------------
// The live census reached the end of the AI path with every code gate satisfied and still refused, and the
// report it printed could not be read. Three findings, each reproduced by execution here before it was touched:
//
//   1. A REPORT THAT SAID `conserved: true` ABOUT 760 UNROUTED UNITS. Suggested 760 · supply allocated 760 ·
//      emitted route quantity 0 · route count 0 · conserved TRUE · production_parity.blockers [] · verdict
//      STOP. Every field correct, the set unreadable: `conserved` answers a SAFETY question (did any group
//      take more than it was authorized?) and was being read as a COMPLETENESS one. And the parity block's
//      blockers were a snapshot taken forty lines BEFORE the route verdict pushed anything into them, so the
//      one place a reader consults to compare the census with a real generation said nothing was wrong.
//
//   2. "NO CARRIER CARD" WAS A TRUE ANSWER TO HALF THE QUESTION. carrier_rate_cards stores no transit days at
//      all — 17_ REJECTS transit columns from the rate template by design, because lead time is maintained
//      separately in carrier_lead_times. Measured here: add the card, withhold the lead time, and the lane
//      still yields zero routes, now refusing with a DIFFERENT token (ROUTE_AUTO_RANKING_INSUFFICIENT /
//      NO_LEAD_TIME) against a DIFFERENT table. An operator acting on the shorter answer books a second STOP.
//
//   3. THE CENSUS COULD NEVER HAVE RETURNED PROCEED. It read the arrival date, transit days and cost off the
//      group HEADER, which carries none of them — correctly, since `expected_arrival` is a LINE field in the
//      canonical model that 16_ adopts only from a user-supplied save. The plan resolved all three and had
//      nowhere to hand them over. The PROCEED gate refuses on a blank arrival date, so a fully routed,
//      conserved plan was going to be STOPPED for a field read off the wrong object.
//
// AND ONE THING THAT IS NOT A DEFECT IN THIS REPOSITORY, established by measurement rather than assumed. The
// live pair `writer FB4G / lifecycle null` is not a source defect: offline, over the real header constants, at
// 34, 35 and 36 columns the writer and the lifecycle both resolve and both name the SAME version. Both live
// readings came from one sheet through one header reader, so the only variable was which module body ran —
// and the pre-R1 resolver, comparing byte-for-byte against a constant frozen at 34, returns '' for any
// 36-column header, reproducing the live output exactly. That is a MIXED DEPLOYMENT, and §3's requirement is
// therefore that the diagnostic be able to NAME it, because it is the dangerous state: the writer accepts and
// the lifecycle expires nothing, so a generation writes rows no later run can supersede. The old code instead
// printed LIFECYCLE_COLUMNS_INCOMPLETE beside `lifecycle_complete: true` — contradicting itself in adjacent
// fields and sending the reader to look for columns that were all present.
//
// TWO FIXTURES, DELIBERATELY SEPARATE (§6). A = the exact live data with NO carrier authority, which must
// fail closed with zero writes. B = the same data plus ONE card and ONE lead-time row, both labelled in the
// data as fixture-only, which must close the loop deterministically. Neither is production master data and
// nothing here writes any.
//
// Run: node assets/tests/live-carrier-authority-lifecycle-parity-completeness-f1-7n-fc-1b-e3-r4-a2-r1-r4.test.js
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
    '          ? [{ windowCode: "D90", gapQty: 999, requiredByDate: "' + REQUIRED_BY + '" }]',
    '          : [{ windowCode: "D30", gapQty: 111, requiredByDate: "2026-10-05" },',
    '             { windowCode: "D90", gapQty: 999, requiredByDate: "' + REQUIRED_BY + '" }] });',
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
var LIVE = { singleWindow: true, threePlStock: THREE_PL_LIVE, foreignSkus: 0, oneSiteSku: true };
function A(extra) {
  var o = {}; for (var k in LIVE) o[k] = LIVE[k];
  for (var k2 in (extra || {})) o[k2] = extra[k2];
  return o;
}

// ================================================================================================================
section('A. \u00a71/\u00a76.A — the exact live fixture: no carrier authority, and it must fail closed');
// ================================================================================================================
var hA = build(A({}));
var rA = pass1(hA);
ok(rA.ok, 'A0  the production harvest \u2192 map \u2192 source \u2192 allocate chain completes');
eq(rA.receiver_count, 1, 'A1  one receiver fact \u2014 the target scope only');
eq(rA.source_lines, 1, 'A1a one source line');
eq(rA.allocated_lines, 1, 'A1b one allocated line');
eq(rA.ship_date, '2026-09-04', 'A2  ship date = the live source snapshot');
eq(rA.target_lines.length, 1, 'A3  exactly one line for the target SKU');
eq(rA.target_lines[0].window_code, 'D90', 'A3a window D90, as live');
eq(rA.target_lines[0].required_by_date, REQUIRED_BY, 'A3b required by 2026-12-03, as live');
eq(rA.target_lines[0].qty, SUGGESTED, 'A3c 760 units');

// \u00a71 — THE SUPPLY SPLIT. The frozen policy runs the overseas/3PL pool FIRST and the factory over its
// residual. With 3120 available against a demand of 760, the residual is nil, so the factories are asked for
// nothing. The old 300 + 460 fixture is NOT this scope and is not reasserted here.
eq(rA.target_lines[0].source, THREE_PL, 'A4  the whole 760 sources from the in-country 3PL');
eq(rA.target_lines[0].role, 'NON_FACTORY', 'A4a and it is typed NON_FACTORY \u2014 never a factory');
ok(rA.target_lines.every(function (l) { return l.source !== FACTORY_CN; }),
  'A4b CN factory allocation = 0, because 3120 covers 760 with no residual');
eq(rA.target_lines[0].multi_pool, false, 'A4c one pool, so no multi-pool refusal');

// \u00a71 — and the refusal, sub-typed and carrying its lane.
eq(rA.group_count, 0, 'A5  zero routes');
eq(rA.routes, [], 'A5a routes = []');
eq(rA.block_tokens, { ROUTE_METHOD_UNRESOLVED: 1 }, 'A5b one ROUTE_METHOD_UNRESOLVED');
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): the sub-type moved because the RULE moved. A rate card no longer
// decides whether a method exists — carrier_lead_times does — so the cause on a lane with neither is now
// NO_TRANSIT_AUTHORITY_FOR_LANE. R4's claim, that the cause is typed rather than left as a bare token, is
// unchanged, and it now points at the table an operator must actually populate first.
eq(rA.blocked_detail[0].method_reason, 'NO_TRANSIT_AUTHORITY_FOR_LANE',
  'A5c sub-typed NO_TRANSIT_AUTHORITY_FOR_LANE — not a bare token');
eq(rA.blocked_lanes[0], { originCountry: 'US', destinationCountry: 'US', marketplace: 'Amazon', shipDate: '2026-09-04' },
  'A5d THE LANE QUERY REACHES THE CONSUMER \u2014 R3 attached it to the refusal and the routed-line hand-off ' +
  'silently dropped it; measured as [null] before this round');

// \u00a76.A — nothing written, nothing reserved, nothing submitted.
var cA0 = drafts(hA);
eq(cA0.headers.length, 0, 'A6  no header written');
eq(cA0.lines.length, 0, 'A6a no line written');
ok(untouched(hA), 'A6b and every unrelated table \u2014 shipping_plans, shipments, reservations, POs \u2014 is untouched');

// ================================================================================================================
section('B. \u00a74 — three verdicts, because one word was answering two questions');
// ================================================================================================================
var compA = hA.run('PLAN.completeness');
eq(compA.authorized_quantity, 760, 'B1  authorized quantity 760');
eq(compA.supply_allocated_quantity, 760, 'B1a supply allocated 760');
eq(compA.emitted_route_quantity, 0, 'B1b emitted route quantity 0');
eq(compA.unresolved_quantity, 760, 'B1c unresolved quantity 760 \u2014 stated as a number, not left to be derived');
eq(compA.supply_allocation_conserved, true,
  'B2  supply_allocation_conserved TRUE \u2014 the SAFETY property, unchanged in meaning');
eq(compA.route_quantity_conserved, false,
  'B2a route_quantity_conserved FALSE \u2014 760 authorized, 0 routed. This is the reading the single word hid');
eq(compA.fully_routable, false, 'B2b fully_routable FALSE');
ok(compA.blocker_tokens.indexOf('NO_TRANSIT_AUTHORITY_FOR_LANE') !== -1
   && compA.blocker_tokens.indexOf('ROUTE_METHOD_UNRESOLVED') !== -1,
  'B3  both tokens present — the symptom AND the actionable cause');
eq(compA.blockers[0].quantity, 760, 'B3a and the blocker carries the quantity it is blocking');
eq(compA.blockers[0].lane_query.originCountry + '|' + compA.blockers[0].lane_query.destinationCountry, 'US|US',
  'B3b and the lane it is blocking on');
ok(!compA.route_quantity_conserved && compA.supply_allocation_conserved,
  'B4  THE PAIR THAT WAS UNREADABLE: safe and incomplete are now separately sayable');

// A run that authorizes nothing and routes nothing is conserved on BOTH counts \u2014 the predicate must not be
// a disguised "route_count > 0", which would make an empty scope report a failure.
var compEmpty = hA.run('KMWRR.buildK2GenerationPlan({ scope: { planning_cycle: "RECO-2026-09", company: "ResUS",'
  + ' country: "US", marketplace: "Amazon", source_page: "inventory_replenishment" }, allocatedLines: [],'
  + ' warehousesById: HARVEST.warehousesById, rateCards: CARR.rateCards, leadTimes: CARR.leadTimes,'
  + ' shipDate: SHIPDATE, authorizedBySkuWindow: {}, sourceCeilingById: {} }).completeness');
eq([compEmpty.authorized_quantity, compEmpty.route_quantity_conserved, compEmpty.fully_routable],
   [0, true, true], 'B5  nothing authorized and nothing routed is conserved and routable \u2014 not a failure');

// ================================================================================================================
section('C. \u00a76.B — the authorized-card fixture closes the loop deterministically');
// ================================================================================================================
var hB = build(A({ domesticCard: {} }));
var rB = pass1(hB);
eq(rB.group_count, 1, 'C1  ONE deterministic K4 route');
eq(rB.blocked_count, 0, 'C1a nothing blocked');
eq(rB.routes[0].from, THREE_PL, 'C2  source warehouse = the in-country 3PL');
eq(rB.routes[0].qty, SUGGESTED, 'C2a quantity 760');
eq(rB.routes[0].to_marketplace, 'Amazon', 'C2b destination marketplace Amazon');
eq(rB.routes[0].to_warehouse, '',
  'C2c and NO fabricated destination warehouse \u2014 an FBA destination is a logical node');
eq(rB.routes[0].method, 'TRUCK', 'C3  the canonical method comes from the fixture card, not from anywhere else');
eq(rB.routes[0].windows, ['D90'], 'C3a window D90');
eq(rB.routes[0].required_by, [REQUIRED_BY], 'C3b required by 2026-12-03');
ok(rB.target_lines.every(function (l) { return l.source !== FACTORY_CN; }),
  'C4  factory quantity STILL 0 \u2014 adding a carrier card changes the ROUTE, never the supply policy');

var compB = hB.run('PLAN.completeness');
eq([compB.emitted_route_quantity, compB.unresolved_quantity, compB.route_quantity_conserved, compB.fully_routable],
   [760, 0, true, true], 'C5  all three verdicts true, unresolved 0');

// \u00a74/\u00a73 — the ETA the plan resolved is now readable. ship 2026-09-04 + avg 4 days = 2026-09-08.
var evB = hB.run('PLAN.groups[0].route_evidence');
eq(evB.expected_arrival, '2026-09-08',
  'C6  the group carries the resolved arrival date \u2014 blank on every run before this round');
eq([evB.currency, evB.route_candidate_status], ['USD', 'AI_RANKED'], 'C6a with its currency and ranking status');
eq(evB.transit_days, 4,
  'C6a1 and the TRANSIT DAYS the ranking used — §F.4 has asked the census for `lead_time_days` since E3 ' +
  'and it read `head.transit_days`, which no K2 header carries, so the number the plan ranked on was never ' +
  'obtainable by any consumer');
eq(evB.evidence_uniform, true, 'C6b uniform across the group\u2019s lines, and reported rather than assumed');
ok(!hB.run('JSON.stringify(PLAN.groups[0].lines[0])').match(/expected_arrival/),
  'C6c and it is NOT in the line payload \u2014 `expected_arrival` is documented as user-supplied in 16_, so an ' +
  'AI-computed date must not change what the writer stores');

// ---- the write, the readback, and the replay ------------------------------------------------------------------
var gen1 = generate(hB);
ok(gen1.success, 'C7  the generation succeeds');
var d1 = drafts(hB);
eq(activeHeaders(d1).length, 1, 'C7a exactly ONE header created');
eq(d1.lines.length, 1, 'C7b exactly ONE line created');
eq(storedTotal(d1), SUGGESTED, 'C7c and the stored quantity reconciles to 760');
eq(String(d1.headers[0].recommended_source_warehouse_id), THREE_PL, 'C7d stored source = the 3PL');
eq(String(d1.headers[0].destination_marketplace), 'Amazon', 'C7e stored destination marketplace = Amazon');
eq(String(d1.headers[0].recommended_shipping_method), 'TRUCK', 'C7f stored method = TRUCK');
ok(String(d1.headers[0].generation_type) !== 'user_created',
  'C7g system-generated provenance \u2014 never stored with a manual marker');
ok(String(d1.headers[0].generation_run_id) !== '', 'C7h and stamped with the generation run id');
ok(untouched(hB), 'C7i no unrelated table touched, and Submit was never executed');

var idBefore = String(d1.headers[0].allocation_draft_id || '');
ok(idBefore !== '',
  'C7j the stored row HAS an identity — stated before it is compared, so C8d cannot pass by comparing two blanks');
var gen2 = generate(hB);
ok(gen2.success, 'C8  a REPLAY of the same generation succeeds');
var d2 = drafts(hB);
eq(activeHeaders(d2).length, 1, 'C8a and still exactly ONE header \u2014 the deterministic identity is reused');
eq(d2.lines.length, 1, 'C8b and one line');
eq(storedTotal(d2), SUGGESTED, 'C8c quantity unchanged at 760');
eq(String(d2.headers[0].allocation_draft_id || ''), idBefore,
  'C8d the SAME row identity, not a second ticket');

var hMoved = build(A({ domesticCard: {} }));
pass1(hMoved);
generate(hMoved, 'EXEC-KEY-ONE');
generate(hMoved, 'EXEC-KEY-TWO');
var dM = drafts(hMoved);
eq(activeHeaders(dM).length, 1,
  'C9  a MOVED execution key does not duplicate the plan \u2014 one active header survives');
eq(storedTotal(dM), SUGGESTED, 'C9a and the quantity is still 760, not 1520');

// ================================================================================================================
section('D. \u00a72 — the carrier authority census, over BOTH tables');
// ================================================================================================================
var G17 = read(GS + '17_carrier_handlers.gs');
ok(/var CARRIER_RATE_CARDS_HEADERS_ = \[/.test(G17),
  'D1  the rate-card authority is `carrier_rate_cards`, owned by 17_carrier_handlers.gs');
ok(/carrier_rate_cards NEVER stores Lead Time/.test(G17),
  'D2  and it stores NO lead time \u2014 stated in the file itself');
ok(/var CRC_FORBIDDEN_COLS_ = \['transit_days'/.test(G17),
  'D2a transit columns are REJECTED from the rate template, by design');
ok(/var CARRIER_LEAD_TIMES_HEADERS_ = \[/.test(G17),
  'D3  lead time is a SECOND authority: `carrier_lead_times`');
ok(/'lead_time_id', 'carrier_id', 'origin_country', 'destination_country',/.test(G17),
  'D3a keyed by carrier + origin + destination + method + last mile');

// \u00a72.7 — what can legally create each one. This is the answer the round has to hand back.
ok(/if \(mode !== 'master'\) \{/.test(G17) && /Update Template requires rate_card_id \(update-only\)/.test(G17),
  'D4  a rate card is created ONLY by the Master Template import; the Update Template cannot create');
ok(/action === 'importCarrierRateCards'/.test(read(GS + '01_router.gs')),
  'D4a and that path is a real, routed production action');
var ROUTER = read(GS + '01_router.gs');
ok(!/action === '(upsertCarrierLeadTime|saveCarrierLeadTime|importCarrierLeadTimes)'/.test(ROUTER),
  'D5  THERE IS NO GENERIC LEAD-TIME WRITE ACTION \u2014 so a new lane\u2019s lead time cannot be created by any ' +
  'existing UI, and the report must say so rather than imply the Master Template covers it');
ok(/handleSeedSinotransCarrier_/.test(G17) && /CN.*JP/.test(G17),
  'D5a the only lead-time writer in the project is the hard-coded CN\u2192JP Sinotrans seed');

// \u00a72.5 — the funnel, computed by the router\u2019s own predicates, on the live lane.
var cA = census(hA);
var funA = cA.carrier_lane_funnels[0];
eq(funA.lane_query, { origin_country: 'US', destination_country: 'US', marketplace: 'Amazon' },
  'D6  the lane key under census is US \u2192 US / Amazon');
eq(funA.authority, 'KMRA', 'D6a measured by KMRA\u2019s own normalize/axisOk/rateCardUsable \u2014 not a private copy');
eq([funA.source_matched, funA.route_matched, funA.final_eligible], [0, 0, 0],
  'D6b origin matched 0 \u2192 route matched 0 \u2192 eligible 0, layer by layer');
eq(funA.missing_canonical_key.cause, 'NO_CARRIER_CARD_FOR_LANE', 'D6c cause typed');
ok(funA.nearest_candidates.length > 0 && funA.nearest_candidates.every(function (n) { return n.failed_axis; }),
  'D6d and the nearest misses name WHICH axis differed, so the answer is never only a zero');

// \u00a72.8 — the question the round was asked: is it one missing card, or is more missing?
eq(cA.carrier_master_data_ready, false, 'D7  carrier master data NOT ready');
eq(cA.carrier_lane_key, ['US|US|Amazon'], 'D7a on this lane key');
eq(cA.carrier_readiness[0].missing, ['CARRIER_RATE_CARD', 'CARRIER_LEAD_TIME'],
  'D7b BOTH are missing \u2014 a rate card ALONE would not have produced a route');
eq((cA.carrier_missing_fields || []).map(function (m) { return m.table; }),
   ['carrier_rate_cards', 'carrier_lead_times'],
  'D7c and the field list covers both tables');
ok(cA.carrier_missing_fields[0].fields.some(function (f) { return f.field === 'unit_rate' && f.required; })
   && cA.carrier_missing_fields[0].fields.some(function (f) { return f.field === 'currency' && f.required; })
   && cA.carrier_missing_fields[0].fields.some(function (f) { return f.field === 'effective_from' && f.required; }),
  'D7d naming the required rate fields');
ok(cA.carrier_missing_fields[1].fields.some(function (f) { return f.field === 'avg_days' && f.required; }),
  'D7e and the required transit field');
ok(/no generic write handler|NO GENERIC HANDLER/i.test(JSON.stringify(cA.carrier_missing_fields)),
  'D7f and it warns that the lead-time row has no handler to create it');
ok(!/CAR-FIXTURE|RC-DOM-FIXTURE|\b0\.4\b/.test(JSON.stringify(cA.carrier_missing_fields)),
  'D8  the field list DESCRIBES what is needed and invents no carrier, rate or transit time');

// The \u00a72.8 case, proven by execution rather than by argument: card present, lead time withheld.
var hC = build(A({ domesticCard: { leadTime: false } }));
var rC = pass1(hC);
eq(rC.group_count, 0, 'D9  a card WITHOUT a lead-time row still produces zero routes');
eq(Object.keys(rC.block_tokens), ['ROUTE_AUTO_RANKING_INSUFFICIENT'],
  'D9a and refuses with a DIFFERENT token \u2014 not the one the operator was told to fix');
eq(rC.blocked_detail[0].ranking_reason, 'NO_LEAD_TIME', 'D9b sub-typed NO_LEAD_TIME');
var cC = census(hC);
eq(cC.carrier_readiness[0].missing, ['CARRIER_LEAD_TIME'],
  'D9c and readiness had PREDICTED exactly that, before the route ran');
eq(cC.carrier_readiness[0].blocking_token, 'NO_LEAD_TIME', 'D9d with the token the route would produce');
eq((cC.carrier_missing_fields || []).map(function (m) { return m.table; }), ['carrier_lead_times'],
  'D9e and asks only for the table that is actually missing');

// Readiness is the INTERSECTION, never either side alone.
var hLtOther = build(A({ domesticCard: { leadTimeMethod: 'AIR' } }));
pass1(hLtOther);
var cLt = census(hLtOther);
eq(cLt.carrier_readiness[0].missing, ['LEAD_TIME_FOR_A_METHOD_THE_CARD_OFFERS'],
  'D10 a lead time for a method the card does NOT offer is not authority for this lane');
eq(cLt.carrier_master_data_ready, false, 'D10a so the lane is still not ready');

// ================================================================================================================
section('E. \u00a73 — one schema authority, and a disagreement that names only what it measured');
// ================================================================================================================
var SCH = hA.run('(function () {'
  + ' var o = [];'
  + ' [30, 34, 35, 36].forEach(function (n) {'
  + '   var hdr = SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(SAD_HEADER_OPTIONAL_TAIL_COLUMNS_).slice(0, n);'
  + '   var r = sadResolveHeaderSchema_(hdr);'
  + '   o.push({ n: n, writer_ok: r.ok, writer_version: r.version, lifecycle_complete: r.lifecycle_complete,'
  + '     lifecycle_version: aiplSchemaVersionOf_(hdr) || null });'
  + ' });'
  + ' return o; })()');
eq(SCH[1], { n: 34, writer_ok: true, writer_version: 'FB4C-AI-LIFECYCLE-1', lifecycle_complete: true,
             lifecycle_version: 'FB4C-AI-LIFECYCLE-1' },
  'E1  34 columns: both authorities resolve, and to the SAME version');
eq(SCH[2], { n: 35, writer_ok: true, writer_version: 'FB4F-B4-ROUTE-IDENTITY-1', lifecycle_complete: true,
             lifecycle_version: 'FB4F-B4-ROUTE-IDENTITY-1' }, 'E1a 35 columns: the same');
eq(SCH[3], { n: 36, writer_ok: true, writer_version: 'FB4G-A2R3-CREATE-IDEMPOTENCY-1', lifecycle_complete: true,
             lifecycle_version: 'FB4G-A2R3-CREATE-IDEMPOTENCY-1' },
  'E1b 36 columns \u2014 THE LIVE SHAPE: a non-empty version, equal on both sides. \u00a73.4 holds in source');
eq(SCH[0].lifecycle_version, null,
  'E2  the pre-migration 30-column base is WRITABLE but has no lifecycle version \u2014 and says so');

// \u00a73.5 — every illegal shape still fails closed.
var BAD = hA.run('(function () {'
  + ' var base = SHIPPING_ALLOCATION_DRAFTS_HEADERS_.concat(SAD_HEADER_OPTIONAL_TAIL_COLUMNS_);'
  + ' function r(h) { var x = sadResolveHeaderSchema_(h); return { ok: x.ok, reason: x.reason }; }'
  + ' var reordered = base.slice(); var t = reordered[34]; reordered[34] = reordered[35]; reordered[35] = t;'
  + ' var dup = base.slice(); dup[35] = dup[34];'
  + ' return { half: r(base.slice(0, 32)), reordered: r(reordered), dup: r(dup),'
  + '   unknown: r(base.concat(["some_new_column"])), blank: r(base.slice(0, 20).concat([""], base.slice(21))) };'
  + ' })()');
ok(BAD.half.ok === false && /COL_COUNT_32/.test(BAD.half.reason),
  'E3  a HALF-APPLIED migration (32) is refused \u2014 an interrupted append is a state to finish');
ok(BAD.reordered.ok === false, 'E3a a reordered tail is refused');
ok(BAD.dup.ok === false && /DUPLICATE_HEADER/.test(BAD.dup.reason),
  'E3b a duplicate is refused, and reported AS a duplicate, not as "column 35 is wrong"');
ok(BAD.unknown.ok === false, 'E3c an unknown 37th column is refused');
ok(BAD.blank.ok === false, 'E3d and a blank intervening header is refused');

// \u00a73.6 — the writer\u2019s acceptance is not a hard-coded truth.
var SAD_SRC = read(GS + '16_shipping_allocation_handlers.gs');
ok(!/function sadResolveHeaderSchema_[\s\S]{0,400}return\s+\{\s*ok:\s*true/.test(SAD_SRC),
  'E4  the resolver never opens by returning ok:true');
ok(/function aiplSchemaVersionOf_[\s\S]{0,600}aiplResolveSchema_/.test(read(GS + '69_api_v1_ai_plan_lifecycle.gs')),
  'E4a and the lifecycle DELEGATES rather than keeping a second opinion');

// The census reports the whole set \u00a73 asks for, at the live shape.
var pB = census(hB).schema_parity;
eq(pB.live_header_count, 36, 'E5  live header count reported');
eq([pB.writer_version, pB.lifecycle_version], ['FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'FB4G-A2R3-CREATE-IDEMPOTENCY-1'],
  'E5a writer version and lifecycle version, both named');
eq(pB.recognized_generation, 'FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'E5b recognized generation');
eq(pB.lifecycle_required_columns,
   ['generation_run_id', 'expired_at', 'expired_by_run_id', 'expiration_reason'],
  'E5c lifecycle required columns');
eq(pB.missing_lifecycle_columns, [], 'E5d missing lifecycle columns \u2014 none');
eq([pB.agree, pB.disagreement], [true, null], 'E5e parity verdict: agree');
eq(pB.shares_authority, true,
  'E5f and ONE AUTHORITY is verified at RUNTIME \u2014 the lifecycle resolver is asked the same header and its ' +
  'verdict compared, which is the only way to tell one authority from one that used to be shared');

// \u00a73.7 — a live 36-column schema must not stop a production Generate.
ok(generate(hB).success, 'E6  and a generation on the live 36-column schema is NOT refused');
ok(!/MIGRATION_VERSION_MISMATCH/.test(JSON.stringify(generate(hB))),
  'E6a with no MIGRATION_VERSION_MISMATCH anywhere in the response');
var sg = generate(hB).data.schema_gate;
eq(sg.migration_version, 'FB4G-A2R3-CREATE-IDEMPOTENCY-1',
  'E7  and the response names the version it RESOLVED \u2014 found by probe reporting FB4C-AI-LIFECYCLE-1 on a ' +
  '36-column sheet, because it printed the frozen EXPECTED constant instead');
eq(sg.expected_migration_version, 'FB4C-AI-LIFECYCLE-1',
  'E7a with the expected constant reported separately, named for what it is');
eq(sg.resolved_from, 'LIVE_HEADER', 'E7b and it says where the resolution came from');

// ================================================================================================================
section('F. \u00a75 — the 3PL policy is not quietly changed by any of this');
// ================================================================================================================
var KMWSA = read('assets/js/core/supply-planning-weekly-source-allocation.js');
ok(/PASS 1/.test(KMWSA) && /THREE_PL|overseas/i.test(KMWSA),
  'F1  the frozen allocator still runs the overseas/3PL pool first');
eq(rB.target_lines[0].source, THREE_PL, 'F2  with a carrier card present, the source is STILL the 3PL');
ok(rC.target_lines.every(function (l) { return l.source === THREE_PL; }),
  'F3  and when the lane has no lead time, the source does NOT silently become the factory');
eq(hC.run('PLAN.completeness.unresolved_quantity'), 760,
  'F3a the 760 fails closed as unresolved \u2014 never routed without method authority, never silently dropped');
var KMWRR_SRC = read('assets/js/core/supply-planning-weekly-route-derivation.js');
ok(!/fallback[\s\S]{0,120}factory/i.test(KMWRR_SRC),
  'F4  and no factory fallback was introduced \u2014 that is a product decision, not this round\u2019s work');

// ================================================================================================================
section('G. \u00a77 — the census output an operator can act on');
// ================================================================================================================
var TEMPSRC = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
ok(/function RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R\(\)/.test(TEMPSRC),
  'G1  the operator entry point still takes NO parameters');
ok(/company: 'ResUS'[\s\S]{0,200}sku: 'CO1100-R'/.test(TEMPSRC), 'G1a with the scope hard-coded');
// R6-R6-R3 — THIS GUARANTEE WAS ABSOLUTE AND IS NOW BOUNDED, DELIBERATELY. The file gained a writer:
// RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE compensates the route the 2026-09-06 incident wrote without
// authorization. 'The census never calls the writer' is therefore false, and an assertion that keeps
// saying it would have to be deleted rather than corrected. The property worth keeping is the one that
// still holds: there is EXACTLY ONE such call, it lives in EXACTLY ONE named function, and no entry
// point writes a cell directly.
var _g2Stripped = TEMPSRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
eq((_g2Stripped.match(/handleUpsertShippingAllocationDraftAtomic_\s*\(/g) || []).length, 1,
  'G2  the census contains EXACTLY ONE call to the atomic writer');
var _g2ExecFrom = TEMPSRC.indexOf('function RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE(');
var _g2ExecTo = TEMPSRC.indexOf('function CENSUS_r6r6r3FinishExec_(');
ok(_g2ExecFrom > 0 && _g2ExecTo > _g2ExecFrom
  && /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(TEMPSRC.slice(_g2ExecFrom, _g2ExecTo)),
  'G2a and it is inside RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE, which is the only function allowed to have it');
ok(!/\.setValue\(|\.appendRow\(|\.deleteRow\(|\.clearContent\(/.test(_g2Stripped),
  'G2b and no entry point writes a cell directly — every mutation goes through 16_ under its own lock');
eq(census(hA).production_parity.writer_constructed, false, 'G2a and reports that it did not');
eq(hA.SHEETS['shipping_allocation_drafts'].rows.length, 1, 'G2b zero DB writes from a census run');

var cA2 = census(hA);
eq(cA2.authorized_quantity, 760, 'G3  authorized_quantity');
eq(cA2.supply_allocated_quantity, 760, 'G3a supply_allocated_quantity');
eq(cA2.emitted_route_quantity, 0, 'G3b emitted_route_quantity');
eq(cA2.unresolved_quantity, 760, 'G3c unresolved_quantity');
eq(cA2.supply_allocation_conserved, true, 'G3d supply_allocation_conserved');
eq(cA2.route_quantity_conserved, false, 'G3e route_quantity_conserved');
eq(cA2.fully_routable, false, 'G3f fully_routable');
eq(cA2.carrier_master_data_ready, false, 'G3g carrier_master_data_ready');
ok((cA2.carrier_missing_fields || []).length > 0, 'G3h carrier_missing_fields');
eq(cA2.carrier_lane_key, ['US|US|Amazon'], 'G3i carrier_lane_key');

// \u00a74 — the parity blockers are no longer a snapshot taken before the verdict.
// RESTATED (A2-R1-R5): R4's defect was that `production_parity.blockers` was SNAPSHOTTED before the route
// verdict, so it read `[]` beside a STOP. R5 changes the verdict itself — a carrier gap is now a WARNING
// and this scope is no longer a STOP at all — so `blockers` is legitimately empty. The property R4 was
// protecting is that the parity block is assembled AFTER the verdict and carries the route findings, and
// that is what is asserted, on the field those findings now occupy.
eq(cA2.production_parity.blockers, cA2.blockers,
  "G4  production_parity.blockers is assembled AFTER the verdict — it equals the census's own list, " +
  'never a snapshot taken before the route was judged');
ok((cA2.production_parity.route_blockers || []).length > 0,
  'G4a and the route findings reach it');
ok(cA2.production_parity.route_blockers.indexOf('NO_TRANSIT_AUTHORITY_FOR_LANE') !== -1,
  'G4b carrying the typed route cause');
eq([cA2.production_parity.route_quantity_conserved, cA2.production_parity.fully_routable], [false, false],
  'G4c and the parity block states the completeness verdicts beside the historical `conserved`');
eq(cA2.production_parity.conserved, true,
  'G4d the historical key keeps its historical meaning \u2014 an operator comparing rounds still finds it');

// \u00a77 — a master-data STOP is named, and the gates it rests on are shown.
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5) — THIS IS THE RULE R5 EXISTS TO REVERSE.
//
// R4 made a missing Carrier Rate Card the verdict of the whole AI Plan, and discarded a correct quantity,
// a correct source and a correct required-by date along with it. The AI Plan is decision support; the
// carrier gap belongs to the Weekly Shipping Plan (comparison) and to Submit (completeness). So the
// verdict is no longer STOP, and USER_MASTER_DATA_REQUIRED is no longer a blocker.
//
// What R4 got right and R5 keeps is the ACTIONABLE half: the exact fields, the exact tables, and the fact
// that carrier_lead_times has no handler to create its row. That is still asserted, as a WARNING.
eq(cA2.verdict, 'RECOMMENDATION_READY_WITH_WARNINGS',
  "G5  a carrier gap is no longer the AI Plan's verdict");
eq(cA2.blockers, [], 'G5a and it is not a blocker at all');
ok(cA2.warnings.some(function (w) { return /CARRIER_MASTER_DATA_INCOMPLETE/.test(w); }),
  'G5a1 it is a WARNING, named');
ok(cA2.warnings.some(function (w) { return /entered directly in the tab|no[\s\S]{0,20}generic write handler/i.test(w); }),
  'G5b and the caveat that carrier_lead_times has no handler to create the row is preserved');
ok((cA2.carrier_missing_fields || []).length > 0,
  'G5b1 together with the exact field list R4 introduced');
eq(cA2.first_failing_predicate, 'carrier_master_data_ready',
  'G5c and the FIRST failing predicate is named \u2014 not a vague "not ready"');
eq([cA2.gates_passed.scope_isolated, cA2.gates_passed.harvest_ready, cA2.gates_passed.forecast_not_blocking,
    cA2.gates_passed.snapshot_accepted, cA2.gates_passed.gap_lineage_resolved,
    cA2.gates_passed.source_lines_built, cA2.gates_passed.allocated_lines_present,
    cA2.gates_passed.destination_resolved, cA2.gates_passed.supply_allocation_conserved,
    cA2.gates_passed.schema_parity],
   [true, true, true, true, true, true, true, true, true, true],
  'G5d PROVING every other gate passed, so the remaining action is identifiable master data');
var cB2 = census(hB);
eq(cB2.first_failing_predicate, null, 'G6  and with the authorized card, no predicate fails');
eq(cB2.allocator.routes[0].expected_arrival, '2026-09-08',
  'G7  the census now prints the arrival date the plan resolved \u2014 blank on every run before this round');
eq(cB2.allocator.routes[0].currency, 'USD', 'G7a and its currency');
eq(cB2.allocator.routes[0].lead_time_days, 4, 'G7b and lead_time_days, which was null on every run before this');

// \u00a710 — release discipline, asserted rather than described.
eq(hA.run('inventoryAiPlanActivationAllowlist_()'),
   [{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' }],
  'G8  the activation allowlist is still exactly the one authorized scope');
ok(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;/.test(CFG),
  'G9  and the repository generation flag is STILL false \u2014 this round enables nothing');
// RESTATED (A2-R1-R5): pinned stamp literals. The durable claim is a floor against the shared ledger.
// RESTATED (A2-R1-R6-R1): a pinned census build stamp. R6-R1 changes the census (§2 — it now reports the
// PAGE's draft scope beside its own, with the reason each row falls on each side). The durable claim is a
// FLOOR against the shared ledger.
ok(RO.stampAtOrAfter(hA.run('TEMP_E3_CENSUS_BUILD_'), 'F1-7N-FC-1B-E3-R4-A2-R1-R4'), 'G10 census build stamp');
ok(RO.tokenIndex(RO.currentAppToken()) >= 0, 'G11 and the shared release ledger still resolves a current token');

// ---- two more standing invariants, so \u00a78.11 and \u00a78.12 have something to mutate -----------------------
ok(!/RC-DOM-FIXTURE|CAR-FIXTURE/.test(JSON.stringify(census(hC).carrier_missing_fields)),
  'G13 the master-data field list never quotes a card that is already in the table \u2014 a fixture row must not ' +
  'come back to the operator dressed as the production authority they were asked to supply');
eq(hA.run('SAD_CLIENT_GRANTABLE_INTENTS_[SAD_AI_K2_INTENT_] === 1'), false,
  'G14 and the AI route intent is NOT client-grantable \u2014 no external caller can authorize itself into it');

// \u00a76.B — a MANUAL route already on the sheet keeps precedence over an AI regeneration.
var hMan = build(A({ domesticCard: {} }));
pass1(hMan);
(function seedManual() {
  var sh = hMan.SHEETS['shipping_allocation_drafts'];
  var hdr = sh.rows[0], row = [];
  for (var i = 0; i < hdr.length; i++) row.push('');
  function set(n, v) { var i = hdr.indexOf(n); if (i !== -1) row[i] = v; }
  set('allocation_draft_id', 'SADH-MANUAL-KEEP');
  set('planning_cycle', 'RECO-2026-09'); set('company', 'ResUS'); set('country', 'US');
  set('marketplace', 'Amazon'); set('source_page', 'inventory_replenishment');
  set('recommended_source_warehouse_id', THREE_PL); set('destination_marketplace', 'Amazon');
  set('recommended_shipping_method', 'AIR'); set('recommended_last_mile_delivery', 'UPS');
  set('recommendation_group_no', '99');
  // site_confirmed = a person has acted on this row. It is NOT a draft, so the lifecycle must preserve it.
  // status `draft` ON PURPOSE. A site_confirmed row is preserved by the PROTECTED_STATUS guard, which would
  // make this assertion pass without MANUAL_SOURCE ever being consulted. A user_created DRAFT is preserved by
  // the manual-source rule ALONE, so this is the fixture that actually tests manual precedence.
  set('status', 'draft'); set('generation_type', 'user_created');
  sh.appendRow(row);
})();
generate(hMan);
var manRows = drafts(hMan).headers.filter(function (r) {
  return String(r.allocation_draft_id || '') === 'SADH-MANUAL-KEEP';
});
eq(manRows.length, 1, 'G15 the operator\u2019s own route row still exists after an AI generation');
eq(String(manRows[0].status), 'draft',
  'G15a and is NOT expired \u2014 a user_created DRAFT is preserved by the manual-source rule alone');
// Measured while building H14: precedence rests on TWO independent guards, and MANUAL_SOURCE is the one that
// carries it. A user_created row is excluded before its status is ever examined, so the status guard is a
// second line of defence rather than the mechanism.
ok(/keep\('MANUAL_SOURCE'/.test(read(GS + '69_api_v1_ai_plan_lifecycle.gs'))
   && /keep\('NOT_DRAFT'/.test(read(GS + '69_api_v1_ai_plan_lifecycle.gs')),
  'G15b and it rests on TWO independent guards \u2014 manual source, then non-draft status');

// ================================================================================================================
section('H. \u00a78 — mutation coverage: every claim above must be shown to bite');
// ================================================================================================================
function parityOf(h) { return census(h).schema_parity; }

// 1. The 36-column lifecycle version forced back to null \u2014 the exact live symptom.
mut('H1  36-column lifecycle version forced to null \u2192 parity DISAGREES, and names the DEPLOYMENT skew ' +
    '(never "columns incomplete", which the same block can see is false)', function () {
  var m = build(A({ mutate: function (S) {
    S.aipl = swap(S.aipl, 'return (r && r.ok && r.lifecycle_complete) ? aiplStr_(r.version) : \'\';',
                          'return \'\';');
  } }));
  pass1(m);
  var p = parityOf(m);
  return p.agree === false
    && /LIFECYCLE_RESOLVER_STALE_IN_DEPLOYED_PROJECT/.test(String(p.disagreement))
    && !/LIFECYCLE_COLUMNS_INCOMPLETE/.test(String(p.disagreement))
    && census(m).gates_passed.schema_parity === false;
});

// 2. The writer and the lifecycle stop sharing one authority.
mut('H2  lifecycle given its own private 34-column resolver \u2192 shares_authority FALSE', function () {
  var m = build(A({ mutate: function (S) {
    S.aipl = swap(S.aipl, '  return sadResolveHeaderSchema_(liveHeaders);',
      '  var a = (liveHeaders || []).slice(); ' +
      'var ok34 = a.length === SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_.length; ' +
      'return { ok: ok34, version: ok34 ? \'LOCAL-34\' : null, column_count: a.length, ' +
      'lifecycle_complete: ok34, reason: null, first_mismatch: null, missing_headers: [], ' +
      'unexpected_headers: [], reordered_headers: [], duplicate_headers: [], supported_versions: [] };');
  } }));
  pass1(m);
  return parityOf(m).shares_authority === false;
});

// 3. A lifecycle column missing, yet the generation is called lifecycle-complete.
mut('H3  lifecycle_complete forced true for every generation \u2192 the pre-migration 30-column base wrongly ' +
    'reports a lifecycle version', function () {
  var m = build(A({ mutate: function (S) {
    S.sad = swap(S.sad, '  out.lifecycle_complete = cand.lifecycle_complete === true;',
                        '  out.lifecycle_complete = true;');
  } }));
  var v = m.run('aiplSchemaVersionOf_(SHIPPING_ALLOCATION_DRAFTS_HEADERS_.slice(0, 30)) || null');
  return v !== null;
});

// 4. 760 authorized, 0 routed, and the plan says the quantity is conserved.
mut('H4  route_quantity_conserved hard-coded true \u2192 760 unrouted units report as conserved', function () {
  var m = build(A({ mutate: function (S) {
    S.bundle = swap(S.bundle, '      route_quantity_conserved: Math.abs((authorized - emitted)) <= 1e-9,',
                              '      route_quantity_conserved: true,');
  } }));
  var r = pass1(m);
  var c = m.run('PLAN.completeness');
  return r.group_count === 0 && c.emitted_route_quantity === 0 && c.route_quantity_conserved === true;
});

// 5. The route blockers never reach the parity block \u2014 the live `blockers: []` beside verdict STOP.
// RESTATED (A2-R1-R5): the detection rested on the verdict being STOP, which R5 no longer produces for
// this scope. The PROPERTY is unchanged — the parity block's blocker list must be ASSEMBLED after the
// verdict rather than left at its pre-assembly value — and the mutation now removes the assembly, which
// is what the defect actually was.
mut('H5  the parity blocker list never assembled → it stays at its pre-verdict null', function () {
  var m = build(A({ mutate: function (S) {
    S.census = swap(S.census, '  out.production_parity.blockers = out.blockers.slice();',
                              '  /* never assembled */');
  } }));
  pass1(m);
  return census(m).production_parity.blockers === null;
});

// 6. A route produced from a card that does not cover the lane.
// My first prediction here was wrong and the correction is worth keeping. Removing the lane predicate does NOT
// produce a route: the CN cards then match, but the lead-time join still uses originCountry US, so LT-SEA and
// LT-AIR (origin CN) miss, no pair is on-time, and the refusal changes from ROUTE_METHOD_UNRESOLVED to
// ROUTE_AUTO_RANKING_INSUFFICIENT. So the lane guard is protected by a SECOND independent axis, and what the
// mutation is caught by is the assertion on the typed refusal (A5b/A5c) rather than on the route count. That
// is a real finding about the code, and asserting "a route appears" would have been asserting the wrong thing.
mut('H6  the lane predicate removed from laneCards \u2192 the typed refusal A5b/A5c assert on CHANGES ' +
    '(a CN\u2192US card enters the US\u2192US lane; the lead-time axis then refuses it differently)', function () {
  var m = build(A({ mutate: function (S) {
    S.bundle = swap(S.bundle, '      if (!cardMatchesRoute(dto, query)) return;', '      ');
  } }));
  var r = pass1(m);
  var sameTokens = JSON.stringify(r.block_tokens) === JSON.stringify({ ROUTE_METHOD_UNRESOLVED: 1 });
  var sameReason = r.blocked_detail[0] && r.blocked_detail[0].method_reason === 'NO_CARRIER_CARD_FOR_LANE';
  return r.group_count > 0 || !sameTokens || !sameReason;
});

// 7. A non-canonical method token accepted as a lead-time key.
mut('H7  canonicalMethodKey returns the raw token when unmapped \u2192 a GROUND card is treated as canonical',
  function () {
    var base = build(A({ domesticCard: { method: 'GROUND', leadTimeMethod: 'GROUND' } }));
    pass1(base);
    var before = census(base).carrier_master_data_ready;
    var m = build(A({ domesticCard: { method: 'GROUND', leadTimeMethod: 'GROUND' }, mutate: function (S) {
      S.bundle = swap(S.bundle,
        '    for (var i = 0; i < METHOD_ALIAS_RULES.length; i++) {\n      var toks = METHOD_ALIAS_RULES[i].leadingTokens;\n      for (var j = 0; j < toks.length; j++) { if (m.indexOf(toks[j]) === 0) return METHOD_ALIAS_RULES[i].canonical; }\n    }\n    return \'\';',
        '    for (var i = 0; i < METHOD_ALIAS_RULES.length; i++) {\n      var toks = METHOD_ALIAS_RULES[i].leadingTokens;\n      for (var j = 0; j < toks.length; j++) { if (m.indexOf(toks[j]) === 0) return METHOD_ALIAS_RULES[i].canonical; }\n    }\n    return m;');
    } }));
    pass1(m);
    return before === false && census(m).carrier_master_data_ready === true;
  });

// 8. An inactive card adopted.
mut('H8  statusActive forced true \u2192 an INACTIVE card produces a route', function () {
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): these fixtures also supplied a LEAD TIME, and under R5 a lead time
// alone resolves a method — so the lane routed regardless of the card and the mutation had nothing to
// change. The CLAIM is about the CARD being unusable, so the transit fallback is withheld and the card
// is once again the only candidate source.
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): under R5 a route needs a TRANSIT row to be ranked, so an unusable
// card can no longer be detected by a route appearing or not appearing. The claim is that an inactive or
// expired card is not a CANDIDATE, and that is now read where it is visible: with a valid lead time present
// the lane routes either way, and `method_source` says WHICH authority named the method. If the unusable
// card were adopted it would read RATE_CARD.
  var base = build(A({ domesticCard: { status: 'inactive' } }));
  var rb = pass1(base);
  var m = build(A({ domesticCard: { status: 'inactive' }, mutate: function (S) {
    S.bundle = swap(S.bundle, "  function statusActive(status) { var st = low(status); return st === '' ? true : !INACTIVE_STATUS[st]; }",
                              '  function statusActive(status) { return true; }');
  } }));
  var rm = pass1(m);
  return rb.group_count === 1 && base.run('PLAN.groups[0].route_evidence.method_source') === 'LEAD_TIME_AUTHORITY'
    && rm.group_count === 1 && m.run('PLAN.groups[0].route_evidence.method_source') === 'RATE_CARD';
});

// 9. An expired card adopted.
mut('H9  inEffectiveWindow forced true \u2192 a card that expired in 2025 produces a 2026 route', function () {
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): these fixtures also supplied a LEAD TIME, and under R5 a lead time
// alone resolves a method — so the lane routed regardless of the card and the mutation had nothing to
// change. The CLAIM is about the CARD being unusable, so the transit fallback is withheld and the card
// is once again the only candidate source.
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R5): under R5 a route needs a TRANSIT row to be ranked, so an unusable
// card can no longer be detected by a route appearing or not appearing. The claim is that an inactive or
// expired card is not a CANDIDATE, and that is now read where it is visible: with a valid lead time present
// the lane routes either way, and `method_source` says WHICH authority named the method. If the unusable
// card were adopted it would read RATE_CARD.
  var opt = { domesticCard: { effectiveFrom: '2024-01-01', effectiveTo: '2025-12-31' } };
  var rb = pass1(build(A(opt)));
  var m = build(A({ domesticCard: opt.domesticCard, mutate: function (S) {
    S.bundle = swap(S.bundle, '    if (asOfOrdinal == null) return true;                 // no as-of supplied \u2192 do not date-gate',
                              '    return true;');
  } }));
  var rm = pass1(m);
  return rb.group_count === 1 && rm.group_count === 1
    && m.run('PLAN.groups[0].route_evidence.method_source') === 'RATE_CARD';
});

// 10. The 3PL-first policy quietly replaced by a factory-first one.
mut('H10 PASS 1 (overseas/3PL) skipped \u2192 the 760 sources from the CN factory instead', function () {
  var m = build(A({ mutate: function (S) {
    S.bundle = swap(S.bundle, '    if (input.overseasInput != null) {', '    if (false) {');
  } }));
  var r = pass1(m);
  return r.target_lines.length > 0 && r.target_lines.every(function (l) { return l.source !== THREE_PL; });
});

// 11. A card already in the table echoed back as the master data to supply.
mut('H11 the missing-field list made to quote the lane\u2019s existing cards \u2192 a FIXTURE row is returned to ' +
    'the operator as production authority', function () {
  var m = build(A({ domesticCard: { leadTime: false }, mutate: function (S) {
    S.census = swap(S.census,
      "    rs.forEach(function (r) { (r.missing_fields || []).forEach(function (m) { o.push({ lane_key: r.lane_key, table: m.table, created_by: m.created_by, fields: m.fields }); }); });",
      "    rs.forEach(function (r) { (r.missing_fields || []).forEach(function (m) { o.push({ lane_key: r.lane_key, table: m.table, created_by: m.created_by, fields: m.fields, existing: carriers.rateCards }); }); });");
  } }));
  pass1(m);
  return /RC-DOM-FIXTURE|CAR-FIXTURE/.test(JSON.stringify(census(m).carrier_missing_fields));
});

// 12. An external client permitted to grant the AI-only route intent.
mut('H12 the AI route intent added to the client-grantable set \u2192 an external caller could authorize it',
  function () {
    var m = build(A({ mutate: function (S) {
      S.sad = swap(S.sad, 'var SAD_CLIENT_GRANTABLE_INTENTS_ = { CREATE_NEW_ROUTE: 1, UPDATE_EXISTING_ROUTE: 1 };',
                          'var SAD_CLIENT_GRANTABLE_INTENTS_ = { CREATE_NEW_ROUTE: 1, UPDATE_EXISTING_ROUTE: 1, ' +
                          'UPSERT_AI_GENERATED_K2_ROUTE: 1 };');
    } }));
    return m.run('SAD_CLIENT_GRANTABLE_INTENTS_[SAD_AI_K2_INTENT_] === 1') === true;
  });

// 13. A replay producing a second deterministic route.
//
// TWO WRONG GUESSES BEFORE THIS ONE, and both are worth recording because they say where the property lives.
// Mutating sadK2DeterministicHeaderId_ survived: the deterministic id is used only on the CREATE branch, so
// reuse does not depend on it. Mutating sadK2GroupKey_ ALSO survived, and the probe showed why — the stored
// header id is SADH-K4-, so this generation resolves identity through the K4 ROUTE-IDENTITY contract
// (ricK4GroupKey_), not through K2 at all. That is the key a replay actually matches on.
mut('H13 the K4 route-identity group key made non-deterministic \u2192 the resolver stops matching and a ' +
    'replay creates a SECOND ticket', function () {
  var m = build(A({ domesticCard: {}, mutate: function (S) {
    S.ric = swap(S.ric, "  return [s(h.planning_cycle), s(h.company), s(h.country), s(h.marketplace),\n    s(h.source_page || 'inventory_replenishment'),",
                        "  return [Utilities.getUuid(), s(h.planning_cycle), s(h.company), s(h.country), s(h.marketplace),\n    s(h.source_page || 'inventory_replenishment'),");
  } }));
  pass1(m);
  generate(m);
  generate(m);
  return activeHeaders(drafts(m)).length > 1;
});

// 14. Manual route precedence broken.
//
// Measured, after two mutants survived: precedence rests on THREE independent guards, checked in order —
// OUT_OF_SCOPE, then MANUAL_SOURCE, then PROTECTED_STATUS, then NOT_DRAFT. A site_confirmed row never reaches
// the manual rule at all, so a fixture in that status cannot test it. This mutation removes MANUAL_SOURCE and
// the fixture is a user_created DRAFT, which is the one shape that guard alone protects.
mut('H14 the MANUAL_SOURCE preservation removed \u2192 the operator\u2019s own route is expired by a generation',
  function () {
  var m = build(A({ domesticCard: {}, mutate: function (S) {
    S.aipl = swap(S.aipl, "    if (!aiplIsAiGenerated_(r)) { keep('MANUAL_SOURCE', 'not an AI-generated row \u2014 a manual route is never replaced by a generation run'); return; }",
                          '    if (false) { return; }');
  } }));
  pass1(m);
  var sh = m.SHEETS['shipping_allocation_drafts'];
  var hdr = sh.rows[0], row = [];
  for (var i = 0; i < hdr.length; i++) row.push('');
  function set(n, v) { var k = hdr.indexOf(n); if (k !== -1) row[k] = v; }
  set('allocation_draft_id', 'SADH-MANUAL-KEEP');
  set('planning_cycle', 'RECO-2026-09'); set('company', 'ResUS'); set('country', 'US');
  set('marketplace', 'Amazon'); set('source_page', 'inventory_replenishment');
  set('recommended_source_warehouse_id', THREE_PL); set('destination_marketplace', 'Amazon');
  set('recommended_shipping_method', 'AIR'); set('recommended_last_mile_delivery', 'UPS');
  set('recommendation_group_no', '99'); set('status', 'draft'); set('generation_type', 'user_created');
  sh.appendRow(row);
  generate(m);
  var r = drafts(m).headers.filter(function (x) { return String(x.allocation_draft_id || '') === 'SADH-MANUAL-KEEP'; })[0];
  return !!r && String(r.status).toLowerCase() === 'expired';
});

console.log('\n' + '='.repeat(112));
console.log('passed ' + pass + '  failed ' + fail + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
console.log('='.repeat(112));
if (fail) process.exit(1);
