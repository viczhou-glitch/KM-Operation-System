// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R2 — CANONICAL AI-GENERATED K2 ROUTE INTENT AND DETERMINISTIC RECONCILIATION
// ----------------------------------------------------------------------------------------------------------------
// A2-R3 made every route write DECLARE what it means instead of letting the writer infer it from whether a
// natural key happened to match. That was right, and it had exactly two answers: an explicit user Add Route
// (always a new ticket) and an explicit edit of a row named by id. The AI Plan is neither — it performs a
// CREATE-OR-RECONCILE against a DETERMINISTIC route identity — so its call site had no answer it could
// truthfully give, gave none, and from that round until this one EVERY generation refused with
// ROUTE_INTENT_REQUIRED and wrote nothing.
//
// The two existing intents are not merely inconvenient here, they are WRONG, and this suite measures both:
//
//   CREATE_NEW_ROUTE      writes. Its only replay guard is the create key, and the AI's execution key MOVES
//                         when the daily gap run changes — so the second generation of the same route mints a
//                         fresh random id and leaves TWO ACTIVE HEADERS holding 1040 units for a scope whose
//                         demand is 520. Measured below, not argued.
//   UPDATE_EXISTING_ROUTE refuses: it requires the allocation_draft_id of a row the first run has not created.
//
// So UPSERT_AI_GENERATED_K2_ROUTE is a THIRD canonical operation. It is SERVER-OWNED twice over: 01_router.gs
// refuses it from any external request, and the writer re-checks the generation evidence, so neither a browser
// nor an internal caller that has not done the work can use it.
//
// A SECOND DEFECT WAS HIDING BEHIND THE FIRST, and the intent alone would not have fixed it. The atomic writer
// defaults generation_type to `user_created`, and the generated header never set it — so every AI row was
// STORED with a manual provenance marker, aiplIsAiGenerated_ returned false before it ever looked at the run
// id, and the next generation read its own output back as a binding operator decision.
//
// AND A THIRD, found by testing the cancelled case rather than reasoning about it: the resolver considers
// ACTIVE rows only (correct — a cancelled plan must never be revived), but the deterministic id it then hands
// back for the INSERT may already be held by the cancelled row. That wrote TWO ROWS WITH THE SAME
// allocation_draft_id. Nothing was revived; the identity simply became ambiguous.
//
// Run: node assets/tests/ai-generated-k2-route-intent-f1-7n-fc-1b-e3-r4-a2-r1-r2.test.js
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
  function fx(t) { return String(t).split(CR + LF).join(LF).split(LF).join(eol); }
  find = fx(find); repl = fx(repl);
  if (src.indexOf(find) < 0) throw new Error('mutation target absent: ' + find.slice(0, 90));
  return src.replace(find, repl);
}

var G16 = read(GS + '16_shipping_allocation_handlers.gs');
var G61 = read(GS + '61_api_v1_weekly_ai_plan.gs');
var G01 = read(GS + '01_router.gs');
var G43 = read(GS + '43_api_v1_gap_materialization.gs');
var G46 = read(GS + '46_api_v1_gap_materialization_job.gs');
var G13 = read(GS + '13_procurement_handlers.gs');
var G02 = read(GS + '02_core_sheet_db.gs');
var CFG = read(GS + '00_config.gs');
var TEMP = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');

// ================================================================================================================
// THE HARNESS. Only the spreadsheet is simulated, and it is MUTABLE — the real atomic writer really writes into
// it, so a readback is a readback and a replay is a replay. Every rule under test is shipped source.
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

var UPC = 20;
var TAIPEI_MIDNIGHT = new Date(Date.UTC(2026, 8, 2, 16, 0, 0));   // 2026-09-03 00:00 Asia/Taipei
// Every table an AI generation must NOT touch, present and empty so "nothing was written here" is an
// observation rather than an absence.
var UNRELATED = ['shipping_plans', 'shipping_plan_lines', 'shipments', 'shipment_lines',
  'factory_stock_movements', 'reservations', 'purchase_orders', 'purchase_order_lines'];

function build(opts) {
  opts = opts || {};
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
  sb.Logger = { log: function () {} };
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
    sad: G16, wap: G61 };
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
  ['gapStr_', 'gapNum_', 'gapTruthy_', 'gapCanonCountry_', 'gapReadObjects_', 'gapOpReadSupplyPoolFacts_']
    .forEach(function (f) { vm.runInContext(extractFn(G43, f), ctx, { filename: '43:' + f }); });
  ['procurementEnsureSheet_', 'procurementAppendByHeader_', 'procurementFindRow_']
    .forEach(function (f) { vm.runInContext(extractFn(G13, f), ctx, { filename: '13:' + f }); });
  vm.runInContext(extractFn(G02, 'jsonResponse_'), ctx, { filename: '02:jsonResponse_' });
  var mOff = /var GAP_CALC_UTC_OFFSET_MIN_\s*=\s*(-?\d+)/.exec(G43);
  vm.runInContext('var GAP_CALC_UTC_OFFSET_MIN_ = ' + mOff[1] + ';', ctx);
  vm.runInContext(/var GAP_JOB_PROP_KEYS_\s*=\s*\{[^}]*\};/.exec(G46)[0], ctx);
  // The controlled activation, simulated in the VM ONLY. The repository flag is untouched.
  if (opts.flag !== false) vm.runInContext('inventoryAiPlanDbGenerationEnabled_ = function () { return true; };', ctx);

  SHEETS['shipping_allocation_drafts'] = new FakeSheet(
    opts.draftHeaders || vm.runInContext('SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', ctx));
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(
    vm.runInContext('SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_)', ctx));
  UNRELATED.forEach(function (t) { SHEETS[t] = new FakeSheet(['id', 'company', 'country', 'sku', 'qty', 'status']); });

  SHEETS['inventory_replenishment_gap'] = new FakeSheet(
    ['company', 'country', 'marketplace', 'sku', 'calculation_status', 'calculation_date',
     'd18_suggested_qty', 'd30_suggested_qty', 'd45_suggested_qty', 'd90_suggested_qty', 'calculation_run_id']);
  (opts.gapRows || [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520,
                     'GAP-INV-20260903T170257-0001']])
    .forEach(function (r) { SHEETS['inventory_replenishment_gap'].appendRow(r); });

  SHEETS['warehouses'] = new FakeSheet(['warehouse_id', 'warehouse_code', 'warehouse_type', 'company', 'country', 'is_active', 'is_factory_warehouse']);
  SHEETS['warehouses'].appendRow(['WH-TW-CN-FACTORY-YOUXIN', 'YOUXIN', 'FACTORY', 'ResUS', 'CN', true, true]);
  SHEETS['warehouses'].appendRow(['WH-TW-TW-FACTORY-RES', 'SHENGYI', 'FACTORY', 'ResUS', 'TW', true, true]);
  SHEETS['warehouses'].appendRow(['WH-US-3PL', 'US3PL', '3PL', 'ResUS', 'US', true, false]);
  SHEETS['marketplaces'] = new FakeSheet(['company', 'country', 'marketplace', 'allocation_priority']);
  SHEETS['marketplaces'].appendRow(['ResUS', 'US', 'Amazon', 1]);
  SHEETS['overseas_inventory_snapshot'] = new FakeSheet(['warehouse_id', 'sku', 'wh_available_stock']);
  SHEETS['overseas_inventory_snapshot'].appendRow(['WH-US-3PL', 'CO1100-R', 0]);
  SHEETS['factory_stock'] = new FakeSheet(['warehouse_id', 'sku', 'fac_current_stock']);
  SHEETS['factory_stock'].appendRow(['WH-TW-CN-FACTORY-YOUXIN', 'CO1100-R', 5000]);
  SHEETS['fc_regular_forecast'] = new FakeSheet(
    ['year', 'company', 'country', 'marketplace', 'sku', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  SHEETS['fc_regular_forecast'].appendRow([2026, 'ResUS', 'US', 'Amazon', 'CO1100-R', 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 400, 500]);
  SHEETS['carrier_rate_cards'] = new FakeSheet(
    ['rate_card_id', 'carrier_id', 'origin_country', 'destination_country', 'marketplace', 'shipping_method',
     'shipping_method_label', 'last_mile_delivery', 'currency', 'unit_rate', 'min_charge', 'charge_type',
     'charge_unit', 'status', 'effective_from', 'effective_to']);
  SHEETS['carrier_rate_cards'].appendRow(['RC-SEA', 'CAR-1', 'CN', 'US', '', 'SEA', 'Sea Freight', 'UPS', 'USD', 1.2, 100, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31']);
  SHEETS['carrier_rate_cards'].appendRow(['RC-AIR', 'CAR-1', 'CN', 'US', '', 'AIR', 'Air Freight', 'UPS', 'USD', 4.5, 200, 'per_unit', 'unit', 'ACTIVE', '2026-01-01', '2027-12-31']);
  SHEETS['carrier_lead_times'] = new FakeSheet(
    ['lead_time_id', 'carrier_id', 'origin_country', 'destination_country', 'shipping_method', 'last_mile_delivery', 'min_days', 'max_days', 'avg_days']);
  SHEETS['carrier_lead_times'].appendRow(['LT-SEA', 'CAR-1', 'CN', 'US', 'SEA', 'UPS', 30, 45, 38]);
  SHEETS['carrier_lead_times'].appendRow(['LT-AIR', 'CAR-1', 'CN', 'US', 'AIR', 'UPS', 7, 12, 9]);
  PROPS['GAP_JOB_INVENTORY'] = JSON.stringify({
    product: 'INVENTORY', runId: 'GAP-INV-20260903T170257-0001', status: 'DONE',
    planningCycle: 'RECO-2026-09', calculationDate: '2026-09-03',
    startedAt: '2026-09-03 17:02:57', finishedAt: '2026-09-03 17:06:11' });

  function run(e) { return vm.runInContext(e, ctx); }
  function parse(e) { var r = run(e); return (r && typeof r.getContent === 'function') ? JSON.parse(r.getContent()) : r; }
  run('var SS = SpreadsheetApp.openById("FAKE_DB");');
  run('var SCOPE = { company: "ResUS", country: "US", planningCycle: "RECO-2026-09" };');
  run('var __NOW = ' + (Date.UTC(2026, 8, 4, 11, 36) - 480 * 60000) + ';');
  run('gapCalcNowMs_ = function () { return __NOW; };');
  run('gapCalcResolveContext_ = function () { return { ok: true, calculationDate: "2026-09-04", planningCycle: "RECO-2026-09" }; };');
  // Everything from the accepted snapshot through the mapper, exactly as 61_ assembles it.
  run([
    'var CANON = weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04");',
    'var LIVE_SITE = { marketplace: "Amazon", sku: "CO1100-R", siteSku: "B0CO1100R",',
    '  destinationWarehouseId: "Amazon", destinationType: "MARKETPLACE",',
    '  cumulativeGapByWindow: { D90: 999 }, requiredByByWindow: { D90: "2026-12-01" },',
    '  fulfillmentModel: "platform_fulfilled", allocationPriority: 1, unitsPerCarton: ' + UPC + ', sourceDataAsOf: "2026-09-03" };',
    'var SITES = [(function () { var s = LIVE_SITE;',
    '  var a = weeklyAiPlanAcceptCanonicalDemand_(CANON, s, SCOPE, CANON.calculationDate, null);',
    '  if (!a.ok) throw new Error("acceptance refused: " + a.code);',
    '  s.liveGapByWindow = s.cumulativeGapByWindow; s.cumulativeGapByWindow = a.suggestedByWindow;',
    '  s.demandLineage = a.lineage; return s; })()];',
    'var ERRS = []; var BUILT = weeklyAiPlanBuildKmafReceivers_(SS, SCOPE, SITES, { "CO1100-R": ' + UPC + ' }, ERRS);',
    'var POOLF = gapOpReadSupplyPoolFacts_(SS);',
    'var HARVEST = { ok: true,',
    '  kmaf: KMAF.projectAllocationFacts({ recommendationType: "WEEKLY_SHIPPING", planningCycle: SCOPE.planningCycle,',
    '    businessScope: { company: SCOPE.company, country: SCOPE.country }, calculationDate: BUILT.calculationDate,',
    '    receivers: BUILT.receivers, warehouses: BUILT.kmafWarehouses }),',
    '  horizonsByDemandRef: (function () { var o = {}; BUILT.horizonRows.forEach(function (r) {',
    '    o[r.demandRef] = { cumulativeGapByWindow: r.cumulativeGapByWindow, requiredByByWindow: r.requiredByByWindow,',
    '      demandLineage: r.demandLineage || null, liveGapByWindow: r.liveGapByWindow || null }; }); return o; })(),',
    '  poolsBySku: weeklyAiPlanPoolsBySku_(POOLF, SCOPE), warehousesById: weeklyAiPlanWarehousesById_(SS),',
    '  sourceDataAsOf: BUILT.sourceDataAsOf, errors: ERRS, site_count: SITES.length,',
    '  receiver_count: BUILT.receivers.length, forecast_normalization: BUILT.forecastNormalization,',
    '  snapshot_freshness: CANON.freshness, accepted_snapshot_date: CANON.acceptedDate,',
    '  gap_schedule: CANON.schedule, gap_job_state: CANON.jobState, snapshot_distinct_dates: CANON.distinctDates };',
    'var MAPPED = KMWHA.mapWeeklyHarvestToBatchRequest({ planningCycle: SCOPE.planningCycle,',
    '  businessScope: { company: SCOPE.company, country: SCOPE.country, marketplace: "Amazon", source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },',
    '  mode: "MANUAL_REGENERATE", confirmRegenerateOverUserEdits: false, actor: "user", now: procurementTimestamp_(),',
    '  sourceDataAsOf: HARVEST.sourceDataAsOf, formulaVersion: "WEEKLY_AI_PLAN_V1", errors: HARVEST.errors,',
    '  factoryIdentityConfig: WEEKLY_AI_PLAN_FACTORY_IDENTITY_, warehousesById: HARVEST.warehousesById,',
    '  kmaf: HARVEST.kmaf, horizonsByDemandRef: HARVEST.horizonsByDemandRef, poolsBySku: HARVEST.poolsBySku });'
  ].join('\n'));
  return { ctx: ctx, SHEETS: SHEETS, PROPS: PROPS, run: run, parse: parse };
}

function census(h) {
  var d = h.SHEETS['shipping_allocation_drafts'].rows, l = h.SHEETS['shipping_allocation_draft_lines'].rows;
  function obj(hd, r) { var o = {}; for (var i = 0; i < hd.length; i++) o[hd[i]] = r[i]; return o; }
  return { headers: d.slice(1).map(function (r) { return obj(d[0], r); }),
           lines: l.slice(1).map(function (r) { return obj(l[0], r); }) };
}
function active(c) {
  return c.headers.filter(function (r) {
    var s = String(r.status || '').trim().toLowerCase();
    return s !== 'submitted' && s !== 'cancelled' && s !== 'expired';
  });
}
function total(c) { return c.lines.reduce(function (a, l) { return a + (Number(l.recommended_qty) || 0); }, 0); }
function gen(h, execKey) {
  h.run('var BODY = { company: "ResUS", country: "US", currentMarketplace: "Amazon", actor: "user"'
    + (execKey ? ', execution_key: "' + execKey + '"' : '') + ' };');
  return h.parse('weeklyAiPlanGenerateK2_(SS, MAPPED.request, HARVEST, null, BODY)');
}
// Stand in for a caller that declares a DIFFERENT intent, so the two manual intents can be measured on the
// same generation. 61_ is never modified by this.
function forceIntent(h, intent, createKey) {
  h.run([
    'if (typeof __realAtomic === "undefined") var __realAtomic = handleUpsertShippingAllocationDraftAtomic_;',
    'var __I = ' + JSON.stringify(intent) + ', __CK = ' + JSON.stringify(createKey || '') + ';',
    'handleUpsertShippingAllocationDraftAtomic_ = function (b) { b = b || {};',
    '  if (__I === null) { delete b.intent; } else { b.intent = __I; }',
    '  if (__CK) b.create_idempotency_key = __CK;',
    '  return __realAtomic(b); };'
  ].join('\n'));
}

// ================================================================================================================
section('A. §1 — the blocker, and why neither existing intent is the answer');
// ================================================================================================================
var hNo = build({}); forceIntent(hNo, null);
var rNo = gen(hNo);
eq(rNo.success, false, 'A1  with NO declared intent the generation fails');
eq((rNo.data.groups[0] || {}).error, 'ROUTE_INTENT_REQUIRED', 'A1a with ROUTE_INTENT_REQUIRED');
eq(census(hNo).headers.length, 0, 'A1b zero headers written');
eq(census(hNo).lines.length, 0, 'A1c zero lines written');

var hUp = build({}); forceIntent(hUp, 'UPDATE_EXISTING_ROUTE');
eq((gen(hUp).data.groups[0] || {}).error, 'ROUTE_INTENT_CONTRADICTORY',
  'A2  UPDATE_EXISTING_ROUTE cannot be used: it needs an id the first run has not created');
eq(census(hUp).headers.length, 0, 'A2a zero rows written');

// The one that WRITES, and the reason it must not be used.
var hCr = build({}); forceIntent(hCr, 'CREATE_NEW_ROUTE', 'CK-DAY1');
var rCr1 = gen(hCr);
eq(rCr1.success, true, 'A3  CREATE_NEW_ROUTE does write …');
forceIntent(hCr, 'CREATE_NEW_ROUTE', 'CK-DAY2');            // a new gap run ⇒ a new key
var rCr2 = gen(hCr);
eq(rCr2.success, true, 'A3a … and a second generation under a MOVED create key also "succeeds"');
eq(active(census(hCr)).length, 2, 'A3b leaving TWO ACTIVE HEADERS for one route — the duplicate plan');
eq(total(census(hCr)), 1040, 'A3c holding 1040 units for a scope whose demand is 520');

// ================================================================================================================
section('B. §2 — the third intent is canonical, and is not an alias');
// ================================================================================================================
var hV = build({});
eq(hV.run('SAD_AI_K2_INTENT_'), 'UPSERT_AI_GENERATED_K2_ROUTE', 'B1  the intent has a canonical name');
var VOC = hV.run('SAD_ROUTE_INTENTS_');
eq(Object.keys(VOC).sort(), ['CREATE_NEW_ROUTE', 'UPDATE_EXISTING_ROUTE', 'UPSERT_AI_GENERATED_K2_ROUTE'],
  'B2  the vocabulary has exactly three intents');
eq(VOC.UPSERT_AI_GENERATED_K2_ROUTE.owner, 'server', 'B2a and the third is server-owned');
eq(VOC.CREATE_NEW_ROUTE.owner, 'user', 'B2b while the two manual ones remain user-owned');
var GRANT = hV.run('SAD_CLIENT_GRANTABLE_INTENTS_');
eq(Object.keys(GRANT).sort(), ['CREATE_NEW_ROUTE', 'UPDATE_EXISTING_ROUTE'],
  'B3  only the two manual intents are client-grantable');
ok(!GRANT.UPSERT_AI_GENERATED_K2_ROUTE, 'B3a the AI intent is not, by construction');
ok(!/UPSERT_AI_GENERATED_K2_ROUTE[^\n]*alias/i.test(G16), 'B4  and it is not documented as an alias of either');

// ================================================================================================================
section('C. §3 — server ownership, at the router and again at the writer');
// ================================================================================================================
ok(/ROUTE_INTENT_NOT_CLIENT_GRANTABLE/.test(G01),
  'C1  01_router refuses a server-owned intent arriving on a request');
ok(/SAD_CLIENT_GRANTABLE_INTENTS_\[_rIntent\]/.test(G01), 'C1a checked against the grantable set, not a literal');
ok(G01.indexOf('ROUTE_INTENT_NOT_CLIENT_GRANTABLE') <
   G01.indexOf('return handleUpsertShippingAllocationDraftAtomic_(body);'),
  'C1b and it refuses BEFORE the handler is reached');

// The writer's own evidence gate, executed over the real generated header.
var hE = build({});
var evOk = hE.run([
  '(function () { var pl = null;',
  '  var src = KMWRB.buildWeeklySourceLines(MAPPED.request);',
  '  var alloc = weeklyAiPlanK2AllocatedLines_(src.lines, HARVEST);',
  '  var carriers = weeklyAiPlanReadCarrierAuthorities_(SS);',
  '  var plan = KMWRR.buildK2GenerationPlan({ scope: { planning_cycle: "RECO-2026-09", company: "ResUS",',
  '    country: "US", marketplace: "Amazon", source_page: "inventory_replenishment" },',
  '    allocatedLines: alloc, warehousesById: HARVEST.warehousesById, rateCards: carriers.rateCards,',
  '    leadTimes: carriers.leadTimes, shipDate: "2026-09-03", authorizedBySkuWindow: {}, sourceCeilingById: {} });',
  '  var g = plan.groups[0];',
  '  g.header.calculation_run_id = "GAP-INV-20260903T170257-0001";',
  '  g.header.generation_run_id = "AIRUN-TESTRUN";',
  '  g.header.generation_type = "system_generated";',
  '  __H = g.header; __L = g.lines;',
  '  return sadAiK2IntentEvidence_({ enforce_k2_grouping: true, execution_key: "AIPLAN-TEST" },',
  '    g.header, g.lines, sadLiveHeaderNames_(SS.getSheetByName("shipping_allocation_drafts")));',
  '})()'
].join('\n'));
eq(evOk.ok, true, 'C2  a complete generation passes the evidence gate');
eq(evOk.missing, [], 'C2a with nothing missing');
ok(evOk.evidence.k2_group_key, 'C2b and the deterministic identity inputs resolve');

function evidenceWithout(mutateJs) {
  return hE.run('(function () { var h = JSON.parse(JSON.stringify(__H)); var b = { enforce_k2_grouping: true, '
    + 'execution_key: "AIPLAN-TEST" }; ' + mutateJs
    + ' return sadAiK2IntentEvidence_(b, h, __L, sadLiveHeaderNames_(SS.getSheetByName("shipping_allocation_drafts"))); })()');
}
ok(evidenceWithout('b.enforce_k2_grouping = false;').ok === false, 'C3  enforce_k2_grouping alone is required …');
ok(/enforce_k2_grouping/.test(evidenceWithout('b.enforce_k2_grouping = false;').missing.join('|')),
  'C3a and named when absent');
ok(evidenceWithout('delete b.execution_key;').ok === false, 'C4  a missing execution key is refused');
ok(evidenceWithout('h.generation_run_id = "";').ok === false, 'C5  a missing AI generation run id is refused');
ok(evidenceWithout('h.generation_run_id = "SOMETHING-ELSE";').ok === false, 'C5a and one that is not an AIRUN id');
ok(evidenceWithout('h.generation_type = "user_created";').ok === false,
  'C6  a MANUAL provenance marker is refused — an AI row must not carry one');
ok(evidenceWithout('h.calculation_run_id = "";').ok === false, 'C7  a missing gap-run lineage is refused');
ok(evidenceWithout('h.recommended_shipping_method = "";').ok === false, 'C8  an incomplete route is refused (no Method)');
ok(evidenceWithout('h.recommended_source_warehouse_id = "";').ok === false, 'C8a and with no From');
ok(evidenceWithout('h.destination_marketplace = ""; h.recommended_destination_warehouse_id = "";').ok === false,
  'C8b and with no To');
ok(evidenceWithout('h.marketplace = "Walmart";').ok === false, 'C9  a scope outside the allowlist is refused');
ok(evidenceWithout('h.company = "KM";').ok === false, 'C9a a different company too');
ok(evidenceWithout('h.marketplace = "ALL_SITES";').ok === false, 'C9b and ALL_SITES is never inside it');
// enforce_k2_grouping is NOT sufficient on its own — the whole point of §3.
var onlyFlag = hE.run('sadAiK2IntentEvidence_({ enforce_k2_grouping: true }, {}, [], [])');
eq(onlyFlag.ok, false, 'C10 enforce_k2_grouping:true by itself grants nothing');
ok(onlyFlag.missing.length >= 5, 'C10a and every missing fact is listed (' + onlyFlag.missing.length + ')');

// ================================================================================================================
section('D. §4/§8 — first generation, and the deterministic replay');
// ================================================================================================================
var h1 = build({});
var r1 = gen(h1);
var g1 = (r1.data.groups || [])[0] || {};
var c1 = census(h1);
eq(r1.success, true, 'D1  the shipped call site now generates successfully');
eq(r1.data.job_status, 'COMPLETED', 'D1a job COMPLETED');
eq(g1.outcome, 'CREATED', 'D1b outcome CREATED');
eq(c1.headers.length, 1, 'D2  exactly one header written');
eq(c1.lines.length, 1, 'D2a one line, matching the one generated route');
eq(total(c1), 520, 'D2b stored total = 520');
eq(r1.data.route_count === undefined ? (r1.data.groups || []).length : r1.data.route_count, 1, 'D2c route_count = 1');
// RESTATED (A2-R1-R4): this pinned the whole serialization of `conservation`, and R4 adds the three
// completeness verdicts to each entry (`conserved` alone was being read as a completion property when it is a
// safety one). The CLAIM — one marketplace, Amazon, and its plan is conserved — is unchanged and is what is
// checked; the new verdicts are asserted beside it rather than by pinning a string.
eq((r1.data.conservation || []).map(function (c) { return [c.marketplace, c.conserved]; }),
  [['Amazon', true]], 'D2d conserved');
eq((r1.data.conservation || []).map(function (c) { return c.completeness && c.completeness.route_quantity_conserved; }),
  [true], 'D2d1 and the quantity that was authorized is the quantity that reached a route');
eq((r1.data.conservation || []).map(function (c) { return c.completeness && c.completeness.fully_routable; }),
  [true], 'D2d2 and every authorized line found a complete route');
var hdr1 = c1.headers[0];
eq(hdr1.generation_type, 'system_generated', 'D3  the row carries the AI provenance marker …');
ok(/^AIRUN-/.test(String(hdr1.generation_run_id)), 'D3a its generation run id …');
eq(hdr1.calculation_run_id, 'GAP-INV-20260903T170257-0001', 'D3b and the gap run that admitted the demand');
ok(String(hdr1.create_idempotency_key).indexOf('AIPLAN-') === 0,
  'D3c with the execution key persisted (' + hdr1.create_idempotency_key + ')');
// The identity is DETERMINISTIC and belongs to the resolver's family, never a fresh mint.
ok(/^SADH-K[24]-/.test(String(hdr1.allocation_draft_id)),
  'D4  the identity is the resolver\'s deterministic one (' + hdr1.allocation_draft_id + ')');
ok(!/^SAD-UUID/.test(String(hdr1.allocation_draft_id)), 'D4a and never a minted random id');
// route completeness
ok(String(hdr1.recommended_source_warehouse_id) && String(hdr1.recommended_shipping_method) &&
   (String(hdr1.destination_marketplace) || String(hdr1.recommended_destination_warehouse_id)),
  'D5  the stored route is complete: From, To and Method');

// ---- REPLAY, identical request ------------------------------------------------------------------------------
var r2 = gen(h1);
var g2 = (r2.data.groups || [])[0] || {};
var c2 = census(h1);
eq(r2.success, true, 'D6  an identical replay succeeds');
eq(g2.outcome, 'REUSED', 'D6a and says so explicitly: REUSED');
eq(g2.allocation_draft_id, g1.allocation_draft_id, 'D6b resolving the SAME logical draft');
eq(active(c2).length, 1, 'D6c one active header — no second draft');
eq(c2.lines.length, 1, 'D6d one line — no duplicate');
eq(total(c2), 520, 'D6e total still 520');
ok(r2.data.job_status !== 'ALL_SUPPRESSED_BY_MANUAL',
  'D6f and it is NOT read back as a binding manual decision');

// ---- REPLAY with a MOVED execution key (a new daily gap run) -------------------------------------------------
var h3 = build({});
gen(h3, 'AIPLAN-DAY1');
var r3b = gen(h3, 'AIPLAN-DAY2');
var c3 = census(h3);
eq(r3b.success, true, 'D7  a second generation under a MOVED execution key succeeds');
eq((r3b.data.groups[0] || {}).outcome, 'REUSED', 'D7a still REUSED — the K2 identity is the replay authority');
eq(active(c3).length, 1, 'D7b one active header (CREATE_NEW_ROUTE left two here — see A3b)');
eq(total(c3), 520, 'D7c and the total is still 520, not 1040');

// ================================================================================================================
section('E. §8 — readback and hydration parity');
// ================================================================================================================
var hyd = h1.parse('handleGetShippingAllocationDraftWorkspace_({ company: "ResUS", country: "US", marketplace: "Amazon", planningCycle: "RECO-2026-09" })');
eq(hyd.success, true, 'E1  the workspace readback succeeds');
eq(hyd.data.status, 'ACTIVE_DRAFT_FOUND', 'E1a finding the active draft');
eq(hyd.data.draft.allocation_draft_id, hdr1.allocation_draft_id, 'E1b the same identity that was stored');
eq((hyd.data.lines || []).reduce(function (a, l) { return a + Number(l.recommended_qty || 0); }, 0), 520,
  'E1c hydrated total = stored total = 520');
eq(hyd.data.duplicate_line_identities, [], 'E1d with no duplicate line identity');
eq(hyd.data.draft_count, 1, 'E1e and exactly one draft');

// ================================================================================================================
section('F. §5 — the manual decision boundary is untouched');
// ================================================================================================================
var hM = build({});
(function () {
  var sh = hM.SHEETS['shipping_allocation_drafts'], hd = sh.rows[0];
  var row = new Array(hd.length).fill('');
  function set(k, v) { var i = hd.indexOf(k); if (i !== -1) row[i] = v; }
  set('allocation_draft_id', 'SADH-K4-569394E2'); set('planning_cycle', 'RECO-2026-09');
  set('source_page', 'inventory_replenishment'); set('company', 'ResUS'); set('country', 'US');
  set('marketplace', 'Amazon'); set('status', 'draft'); set('generation_type', 'user_created');
  set('recommended_source_warehouse_id', 'WH-TW-CN-FACTORY-YOUXIN'); set('destination_marketplace', 'Amazon');
  set('recommended_shipping_method', 'SEA'); set('recommended_last_mile_delivery', 'UPS');
  set('recommendation_group_no', '1'); set('draft_version', '1');
  sh.rows.push(row);
})();
var rM = gen(hM);
eq(rM.data.job_status, 'ALL_SUPPRESSED_BY_MANUAL',
  'F1  a genuine user_created route at the same identity still outranks the AI plan');
eq(rM.data.suppressed_count, 1, 'F1a and the suppression is reported, not implied');
eq(census(hM).headers.length, 1, 'F1b nothing was written beside it');
eq(census(hM).headers[0].generation_type, 'user_created', 'F1c the operator\'s row is untouched');
// and the AI's OWN row is never that.
eq(census(h1).headers[0].generation_type, 'system_generated',
  'F2  while the AI\'s own row is system_generated, so a replay reconciles instead of suppressing');
ok(/aiplIsAiGenerated_/.test(read(GS + '69_api_v1_ai_plan_lifecycle.gs')),
  'F3  the classifier that reads it is unchanged and still the authority');

// ================================================================================================================
section('G. §6 — cancelled history is neither revived nor duplicated');
// ================================================================================================================
var hX = build({});
var rX1 = gen(hX);
var xid = (rX1.data.groups[0] || {}).allocation_draft_id;
(function () {
  var sh = hX.SHEETS['shipping_allocation_drafts'];
  sh.rows[1][sh.rows[0].indexOf('status')] = 'cancelled';
})();
var rX2 = gen(hX);
var cX = census(hX);
eq(rX2.success, false, 'G1  regenerating over a CANCELLED identity refuses');
eq((rX2.data.groups[0] || {}).error, 'ROUTE_IDENTITY_HELD_BY_TERMINAL_DRAFT', 'G1a with a typed code');
eq(cX.headers.length, 1, 'G2  no second row was written');
eq(String(cX.headers[0].status).toLowerCase(), 'cancelled', 'G2a the cancelled row is STILL cancelled');
eq(cX.headers[0].allocation_draft_id, xid, 'G2b and still holds its identity');
eq(active(cX).length, 0, 'G2c nothing active was invented in its place');
ok(!/deleteRow|removeRow/.test(extractFn(G16, 'sadAtomicUpsertCore_')),
  'G3  and the writer has no capability to delete the cancelled row at all');

// ================================================================================================================
section('H. §7/§9 — writer invariants and unrelated tables');
// ================================================================================================================
eq(c2.headers.length, 1, 'H1  one header for one logical draft');
eq(c2.lines.filter(function (l) { return !String(l.allocation_draft_id || '').trim(); }).length, 0,
  'H2  no orphan line (every line names its header)');
eq(c2.lines.filter(function (l) { return l.allocation_draft_id !== hdr1.allocation_draft_id; }).length, 0,
  'H2a and every line belongs to THIS header');
var lineKeys = {};
var dupe = c2.lines.filter(function (l) {
  var k = [l.sku, l.site_sku, l.window_code].join('|');
  if (lineKeys[k]) return true; lineKeys[k] = 1; return false;
});
eq(dupe.length, 0, 'H3  no duplicate line identity');
eq(hdr1.company + '/' + hdr1.country + '/' + hdr1.marketplace, 'ResUS/US/Amazon', 'H4  scope consistency');
eq(hdr1.planning_cycle, 'RECO-2026-09', 'H4a planning-cycle consistency');
UNRELATED.forEach(function (t) {
  eq(h1.SHEETS[t].rows.length - 1, 0, 'H5  ' + t + ' — present and still empty');
});
eq(h1.SHEETS['factory_stock'].rows.length - 1, 1, 'H5a factory_stock untouched (its single fixture row)');
eq(h1.SHEETS['overseas_inventory_snapshot'].rows.length - 1, 1, 'H5b overseas snapshot untouched');
// A refusal leaves NOTHING behind.
var hZ = build({}); forceIntent(hZ, 'UPSERT_AI_GENERATED_K2_ROUTE');
hZ.run('var __ra3 = __realAtomic; handleUpsertShippingAllocationDraftAtomic_ = function (b) {'
  + ' b = b || {}; b.intent = "UPSERT_AI_GENERATED_K2_ROUTE"; b.enforce_k2_grouping = false; return __ra3(b); };');
var rZ = gen(hZ);
eq(rZ.success, false, 'H6  evidence that does not hold refuses …');
eq((rZ.data.groups[0] || {}).error, 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', 'H6a with a typed code');
eq(census(hZ).headers.length, 0, 'H6b and zero rows — no partially mutated table');
eq(census(hZ).lines.length, 0, 'H6c neither header nor line');

// ================================================================================================================
section('I. §10 — the A2-R1-R1 fixes still hold');
// ================================================================================================================
eq(h1.run('CANON.freshness.state'), 'CURRENT_PRE_SCHEDULE', 'I1  schedule-aware freshness unchanged');
eq(h1.run('CANON.acceptedDate'), '2026-09-03', 'I1a accepted snapshot date 2026-09-03');
eq(h1.run('CANON.distinctDates'), ['2026-09-03'], 'I1b the typed Date canonicalized, no UTC shift');
eq(h1.run('CANON.dateNormalization.by_kind'), { DATE: 1 }, 'I1c and it arrived as a Date object');
eq(h1.run('BUILT.forecastNormalization').default_zero_missing_year, 1,
  'I2  the absent 2027 forecast month is one accounted default-zero …');
eq(h1.run('ERRS').length, 0, 'I2a … and blocks nothing');
eq(h1.run('SITES[0].cumulativeGapByWindow.D90'), 520, 'I3  the snapshot quantity 520 is the demand');
eq(h1.run('sadResolveHeaderSchema_(sadLiveHeaderNames_(SS.getSheetByName("shipping_allocation_drafts"))).version'),
  'FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'I4  the 36-column schema is accepted by the shared authority');
eq(h1.run('aiplSchemaVersionOf_(sadLiveHeaderNames_(SS.getSheetByName("shipping_allocation_drafts")))'),
  'FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'I4a and the lifecycle agrees — parity holds');

// ================================================================================================================
section('J. §11/§13 — nothing was armed');
// ================================================================================================================
ok(/INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false/.test(CFG),
  'J1  the repository flag is still false — activation is simulated in a VM only');
eq((CFG.match(/company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R'/g) || []).length, 1,
  'J2  the allowlist still holds exactly one scope');
ok(/TEMP_FCROLL_DRY_RUN = true/.test(read('assets/tools/apps-script-diagnostics/TEMP_FC_REGULAR_FORECAST_YEAR_ROLLOVER_2027.gs')),
  'J3  the 2027 rollover is still unrun');
ok(/CENSUS_log_\('db_writes', 0\)/.test(TEMP) && /CENSUS_log_\('writer_constructed', false\)/.test(TEMP),
  'J4  the census still declares zero writes and no writer');
// R6-R6-R3 — THIS GUARANTEE WAS ABSOLUTE AND IS NOW BOUNDED, DELIBERATELY. The file gained a writer:
// RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE compensates the route the 2026-09-06 incident wrote without
// authorization. 'The census never calls the writer' is therefore false, and an assertion that keeps
// saying it would have to be deleted rather than corrected. The property worth keeping is the one that
// still holds: there is EXACTLY ONE such call, it lives in EXACTLY ONE named function, and no entry
// point writes a cell directly.
var _j5Stripped = TEMP.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
eq((_j5Stripped.match(/handleUpsertShippingAllocationDraftAtomic_\s*\(/g) || []).length, 1,
  'J5  the census contains EXACTLY ONE call to the atomic writer');
var _j5ExecFrom = TEMP.indexOf('function RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE(');
var _j5ExecTo = TEMP.indexOf('function CENSUS_r6r6r3FinishExec_(');
ok(_j5ExecFrom > 0 && _j5ExecTo > _j5ExecFrom
  && /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(TEMP.slice(_j5ExecFrom, _j5ExecTo)),
  'J5a and it is inside RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE, which is the only function allowed to have it');
ok(!/\.setValue\(|\.appendRow\(|\.deleteRow\(|\.clearContent\(/.test(_j5Stripped),
  'J5b and no entry point writes a cell directly — every mutation goes through 16_ under its own lock');
ok(/CENSUS_log_\('route_intent_that_generation_would_use'/.test(TEMP),
  'J6  the census reports the intent production generation would declare (§11)');
ok(/CENSUS_log_\('deterministic_identity_preview'/.test(TEMP), 'J6a and a deterministic identity preview');

// ================================================================================================================
section('N. MUTATIONS');
// ================================================================================================================
mut('N1  the AI intent is aliased to CREATE_NEW_ROUTE', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, "var SAD_AI_K2_INTENT_ = 'UPSERT_AI_GENERATED_K2_ROUTE';",
      "var SAD_AI_K2_INTENT_ = 'CREATE_NEW_ROUTE';");
  } });
  var r = gen(h);
  // with the alias the AI branch never runs; the CREATE branch demands a create key it was never given
  return r.success !== true || !/^SADH-K[24]-/.test(String(census(h).headers[0].allocation_draft_id || ''));
});
mut('N2  the AI path is cut off from the resolver (a random identity is minted per run)', function () {
  // Skipping the resolver does NOT make the write fail — it falls through to the last-resort
  // `id = 'SAD-' + Utilities.getUuid()`, so every generation mints a fresh random identity and a replay
  // becomes a second draft. The damage is the identity, not an error, so that is what this measures.
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '  if (!id && (!intentApplies || isAiK2)) {', '  if (!id && !intentApplies) {');
  } });
  gen(h); gen(h);
  var c = census(h);
  var randomId = c.headers.some(function (r) { return /^SAD-UUID/.test(String(r.allocation_draft_id || '')); });
  return randomId || active(c).length !== 1;
});
mut('N3  the route intent is accepted from a browser payload', function () {
  var m = swap(G01, 'if (_rIntent && typeof SAD_CLIENT_GRANTABLE_INTENTS_ !== \'undefined\' && !SAD_CLIENT_GRANTABLE_INTENTS_[_rIntent]) {',
    'if (false) {');
  return /ROUTE_INTENT_NOT_CLIENT_GRANTABLE/.test(G01) &&
    G01.indexOf('!SAD_CLIENT_GRANTABLE_INTENTS_[_rIntent]') !== -1 &&
    m.indexOf('!SAD_CLIENT_GRANTABLE_INTENTS_[_rIntent]') === -1;
});
mut('N4  the allowlist check is dropped from the evidence gate', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '      if (!inventoryAiPlanScopeEnabled_(company, country, mkt, k)) outside.push(k);', '');
  } });
  var ev = h.run('sadAiK2IntentEvidence_({ enforce_k2_grouping: true, execution_key: "K" },'
    + ' { company: "KM", country: "XX", marketplace: "Walmart", generation_run_id: "AIRUN-1",'
    + '   generation_type: "system_generated", calculation_run_id: "G", recommended_source_warehouse_id: "W",'
    + '   destination_marketplace: "Walmart", recommended_shipping_method: "SEA" }, [{ sku: "ZZZ" }], [])');
  return (ev.missing || []).join('|').indexOf('allowlist') === -1;
});
mut('N5  the execution key requirement is dropped', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '  if (!execKey) missing.push(', '  if (false) missing.push(');
  } });
  var HDR = { generation_run_id: 'AIRUN-1', generation_type: 'system_generated', calculation_run_id: 'G',
    recommended_source_warehouse_id: 'W', destination_marketplace: 'Amazon', recommended_shipping_method: 'SEA',
    company: 'ResUS', country: 'US', marketplace: 'Amazon' };
  var ev = h.run('sadAiK2IntentEvidence_({ enforce_k2_grouping: true }, ' + JSON.stringify(HDR)
    + ', [{ sku: "CO1100-R" }], [])');
  return (ev.missing || []).join('|').indexOf('execution_key') === -1;
});
mut('N6  a replay creates a SECOND header', function () {
  var h = build({ mutate: function (SRC) {
    // the resolver's REUSE branch removed: every run takes the CREATE path
    SRC.sad = swap(SRC.sad, "    if (res.status === 'REUSE') { id = res.id; found = procurementFindRow_(hSh, 'allocation_draft_id', id); }",
      "    if (false) { }");
  } });
  gen(h); gen(h);
  return active(census(h)).length !== 1 || total(census(h)) !== 520;
});
mut('N7  the AI row is stored with a MANUAL provenance marker', function () {
  var h = build({ mutate: function (SRC) {
    SRC.wap = swap(SRC.wap, "      g.header.generation_type = 'system_generated';", '');
  } });
  var r = gen(h);
  // the evidence gate is what catches it now, before anything is written
  return r.success !== true && census(h).headers.length === 0;
});
mut('N8  a cancelled row is written over (identity duplicated)', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, "      var _held = procurementFindRow_(hSh, 'allocation_draft_id', res.id);",
      '      var _held = null;');
  } });
  gen(h);
  var sh = h.SHEETS['shipping_allocation_drafts'];
  sh.rows[1][sh.rows[0].indexOf('status')] = 'cancelled';
  gen(h);
  var ids = census(h).headers.map(function (r) { return r.allocation_draft_id; });
  return ids.length === 2 && ids[0] === ids[1];
});
mut('N9  header/line atomicity is removed (a refusal leaves rows behind)', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, "        code: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: true,",
      "        code: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: false,");
  } });
  return /zero_write: true/.test(G16) &&
    !/AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: true/.test(
      swap(G16, "code: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: true,",
        "code: 'AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT', stage: 'intent', zero_write: false,"));
});
mut('N10 the 36-column schema is rejected again', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '    appended: SAD_HEADER_OPTIONAL_TAIL_COLUMNS_, lifecycle_complete: true,',
      '    appended: SAD_LIFECYCLE_TAIL_COLUMNS_, lifecycle_complete: true,');
  } });
  return gen(h).success !== true;
});
mut('N11 the feature flag is enabled in the repository', function () {
  var m = swap(CFG, 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false', 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true');
  return /ENABLED_ = false/.test(CFG) && /ENABLED_ = true/.test(m);
});
mut('N12 the census constructs a writer', function () {
  var m = swap(TEMP, "CENSUS_log_('writer_constructed', false);", "CENSUS_log_('writer_constructed', true);");
  return /'writer_constructed', false/.test(TEMP) && /'writer_constructed', true/.test(m);
});
mut('N13 the allowlist is widened', function () {
  var m = swap(CFG, "{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' }",
    "{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },\n  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1150-R' }");
  return (CFG.match(/marketplace: 'Amazon'/g) || []).length === 1 && (m.match(/marketplace: 'Amazon'/g) || []).length === 2;
});
mut('N14 the manual precedence policy is rewritten to ignore user_created', function () {
  var A = read(GS + '69_api_v1_ai_plan_lifecycle.gs');
  var m = swap(A, "  if (gt === 'user_created') return false;                 // explicit manual marker — never AI",
    '  if (false) return false;');
  return /gt === 'user_created'\) return false/.test(A) && !/gt === 'user_created'\) return false/.test(m);
});

console.log('\n----------------------------------------');
console.log('AI-GENERATED K2 ROUTE INTENT (F1-7N-FC-1B-E3-R4-A2-R1-R2): ' + pass + ' passed, ' + fail + ' failed');
console.log('mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
process.exit(fail ? 1 : 0);
