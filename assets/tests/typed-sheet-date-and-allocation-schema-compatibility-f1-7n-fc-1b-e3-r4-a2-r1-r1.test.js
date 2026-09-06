// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R1 — TYPED SHEET DATE + ALLOCATION SCHEMA COMPATIBILITY
// ----------------------------------------------------------------------------------------------------------------
// TWO DEFECTS, BOTH REPRODUCED FIRST, BOTH IN CODE THAT WAS CONFIDENTLY WRONG ABOUT SOMETHING IT COULD SEE.
//
// (A) A Google Sheets cell formatted as a date does not return the text in the cell. It returns a Date OBJECT.
//     The snapshot reader put that value through a generic String().trim(), so a healthy row reached the
//     freshness authority as "Thu Sep 03 2026 00:00:00 GMT+0800 (Taiwan Standard Time)", failed the YYYY-MM-DD
//     test, and was reported as LINEAGE_MISMATCH — the code reserved for corrupt provenance. Nothing was
//     corrupt. The reader could not read its own column, and the refusal accused the database of the fault.
//
//     The obvious repair is the second bug: toISOString().slice(0, 10) on Taipei midnight yields the PREVIOUS
//     day, because 2026-09-03 00:00 +08:00 is 2026-09-02T16:00Z. That version reads, accepts, and is silently
//     wrong by one business day — strictly worse than the refusal it replaces. The conversion goes through the
//     planning zone's own fixed-offset arithmetic, and a UTC-shift mutation is pinned below.
//
// (B) The allocation writer accepted a live `shipping_allocation_drafts` header at 34, 35 or 36 columns,
//     because two append-only migrations legitimately widened it. The AI Plan lifecycle asked a DIFFERENT
//     question — byte-equality with a 34-column constant that is deliberately frozen there, because the
//     lifecycle migration appends against it. So on a correctly migrated production table the lifecycle
//     reported no schema version, the activation gate refused with MIGRATION_VERSION_MISMATCH and zero writes,
//     and it told the operator to re-sync a project that was already current. Two authorities, one table,
//     opposite answers. There is now one authority and two policies over it.
//
// A THIRD BLOCKER IS PINNED HERE AND DELIBERATELY NOT FIXED (§F). The atomic writer began requiring a declared
// route intent in F1-7N-FB-4G-A2-R3; the AI Plan's call site never declared one, so every generation refuses
// with ROUTE_INTENT_REQUIRED. Neither existing intent fits a deterministic K2 upsert, so the fix is a design
// decision and not a call-site edit. These tests hold the reproduction and the measured consequence of both
// candidate intents so the next round starts from evidence.
//
// Run: node assets/tests/typed-sheet-date-and-allocation-schema-compatibility-f1-7n-fc-1b-e3-r4-a2-r1-r1.test.js
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
// Line endings differ per file; an LF find string against a CRLF file matches nothing while naming a target
// that IS present. Both sides are normalised to the source's own ending.
function swap(src, find, repl) {
  var CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  var eol = src.indexOf(CR + LF) >= 0 ? (CR + LF) : LF;
  function fx(t) { return String(t).split(CR + LF).join(LF).split(LF).join(eol); }
  find = fx(find); repl = fx(repl);
  if (src.indexOf(find) < 0) throw new Error('mutation target absent: ' + find.slice(0, 90));
  return src.replace(find, repl);
}

var G61 = read(GS + '61_api_v1_weekly_ai_plan.gs');
var G16 = read(GS + '16_shipping_allocation_handlers.gs');
var G69L = read(GS + '69_api_v1_ai_plan_lifecycle.gs');
var G43 = read(GS + '43_api_v1_gap_materialization.gs');
var G46 = read(GS + '46_api_v1_gap_materialization_job.gs');
var G13 = read(GS + '13_procurement_handlers.gs');
var G02 = read(GS + '02_core_sheet_db.gs');
var CFG = read(GS + '00_config.gs');
var SNF = read('assets/js/core/supply-planning-snapshot-freshness.js');
var TEMP = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));

// ================================================================================================================
// THE HARNESS. The ONLY thing simulated is the spreadsheet, and it is MUTABLE — the real atomic writer really
// writes into it, so a readback is a readback and a replay is a replay. Every rule under test is shipped source.
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

var UPC = 20;                                                     // units per carton; divides 520 evenly
var TAIPEI_MIDNIGHT = new Date(Date.UTC(2026, 8, 2, 16, 0, 0));   // 2026-09-03 00:00 Asia/Taipei

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
  // A FAITHFUL ContentService. Returning the bare object made weeklyAiPlanParseResp_ (which reads getContent())
  // see '{}' for every atomic response, so a successful write reported as BLOCKED — a harness that mis-models
  // the transport invents defects, and this one did until it was corrected.
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
  // Apps Script has ONE global scope. The route-identity contract is a SEPARATE 69_ file that 16_'s write gate
  // reaches directly; omitting it yields ROUTE_IDENTITY_CONTRACT_NOT_LOADED — a refusal the runtime does not
  // have — and would report a harness gap as a production defect.
  var SRC = { bundle: read(GS + '90_generated_supply_planning_bundle.gs'), cfg: CFG,
    ric: read(GS + '69_api_v1_route_identity_contract.gs'), aipl: G69L, sad: G16, wap: G61 };
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
  // The planning zone's own constant, lifted from its owner rather than restated: a harness declaring its own
  // 480 would pass while a deployment missing the authority silently did something else.
  var mOff = /var GAP_CALC_UTC_OFFSET_MIN_\s*=\s*(-?\d+)/.exec(G43);
  if (!mOff) throw new Error('GAP_CALC_UTC_OFFSET_MIN_ not found in 43_');
  if (!opts.noTimezoneAuthority) vm.runInContext('var GAP_CALC_UTC_OFFSET_MIN_ = ' + mOff[1] + ';', ctx);
  var mKeys = /var GAP_JOB_PROP_KEYS_\s*=\s*\{[^}]*\};/.exec(G46);
  if (!mKeys) throw new Error('GAP_JOB_PROP_KEYS_ not found in 46_');
  vm.runInContext(mKeys[0], ctx);

  // The controlled activation, simulated in the VM ONLY. The repository's flag is untouched; this proves what
  // turning it on WOULD do without arming anything.
  if (opts.flag !== false) vm.runInContext('inventoryAiPlanDbGenerationEnabled_ = function () { return true; };', ctx);

  SHEETS['shipping_allocation_drafts'] = new FakeSheet(
    opts.draftHeaders || vm.runInContext('SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', ctx));
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(
    vm.runInContext('SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_)', ctx));
  // Present and EMPTY, so "nothing was written here" is an observation rather than an absence.
  ['shipping_plans', 'shipments', 'factory_stock_movements'].forEach(function (t) {
    SHEETS[t] = new FakeSheet(['id', 'company', 'country', 'sku', 'qty', 'status']);
  });

  SHEETS['inventory_replenishment_gap'] = new FakeSheet(
    ['company', 'country', 'marketplace', 'sku', 'calculation_status', 'calculation_date',
     'd18_suggested_qty', 'd30_suggested_qty', 'd45_suggested_qty', 'd90_suggested_qty', 'calculation_run_id']);
  (opts.gapRows || [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520,
                     'GAP-INV-20260903T170257-0001']])
    .forEach(function (r) { SHEETS['inventory_replenishment_gap'].appendRow(r); });

  SHEETS['warehouses'] = new FakeSheet(['warehouse_id', 'warehouse_code', 'warehouse_type', 'company', 'country', 'is_active', 'is_factory_warehouse']);
  // The REAL factory identities from WEEKLY_AI_PLAN_FACTORY_IDENTITY_. The source-line builder validates both
  // by name, so inventing ids would only prove the validator rejects invented ones.
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
  // THE LIVE SHAPE: 2026 exists, 2027 does not. Three real months and one DEFAULT_ZERO_MISSING_YEAR — the
  // year-boundary case that used to drop every site.
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

  PROPS['GAP_JOB_INVENTORY'] = JSON.stringify(opts.jobState || {
    product: 'INVENTORY', runId: 'GAP-INV-20260903T170257-0001', status: 'DONE',
    planningCycle: 'RECO-2026-09', calculationDate: '2026-09-03',
    startedAt: '2026-09-03 17:02:57', finishedAt: '2026-09-03 17:06:11'
  });

  function run(e) { return vm.runInContext(e, ctx); }
  function parse(e) { var r = run(e); return (r && typeof r.getContent === 'function') ? JSON.parse(r.getContent()) : r; }
  run('var SS = SpreadsheetApp.openById("FAKE_DB");');
  run('var SCOPE = { company: "ResUS", country: "US", planningCycle: "' + (opts.cycle || 'RECO-2026-09') + '" };');
  // The business clock is the one thing a test must pin. Default: 2026-09-04 11:36 Asia/Taipei — the live instant.
  var nowMs = (opts.nowMs != null) ? opts.nowMs : (Date.UTC(2026, 8, 4, 11, 36) - 480 * 60000);
  run('var __NOW = ' + nowMs + ';');
  run('gapCalcNowMs_ = function () { return __NOW; };');
  run('gapCalcResolveContext_ = function () { return { ok: true, calculationDate: "2026-09-04", planningCycle: "RECO-2026-09" }; };');
  return { ctx: ctx, SHEETS: SHEETS, PROPS: PROPS, run: run, parse: parse };
}

function census(h) {
  var d = h.SHEETS['shipping_allocation_drafts'].rows, l = h.SHEETS['shipping_allocation_draft_lines'].rows;
  function obj(hd, r) { var o = {}; for (var i = 0; i < hd.length; i++) o[hd[i]] = r[i]; return o; }
  return { headers: d.slice(1).map(function (r) { return obj(d[0], r); }),
           lines: l.slice(1).map(function (r) { return obj(l[0], r); }) };
}
// Everything from the accepted snapshot through the mapper, exactly as 61_ assembles it.
function plan(h, intent) {
  h.run([
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
    '  kmaf: HARVEST.kmaf, horizonsByDemandRef: HARVEST.horizonsByDemandRef, poolsBySku: HARVEST.poolsBySku });',
    'var BODY = { company: "ResUS", country: "US", currentMarketplace: "Amazon", actor: "user" };'
  ].join('\n'));
  if (intent) {
    // SIMULATION-ONLY SHIM for §F. 61_ is untouched; this stands in for the call-site change a fix would have
    // to make, so the consequence of each intent is measured rather than argued about.
    h.run([
      'var __realAtomic = handleUpsertShippingAllocationDraftAtomic_;',
      'var __INTENT = "' + intent + '";',
      'handleUpsertShippingAllocationDraftAtomic_ = function (b) { b = b || {}; b.intent = __INTENT;',
      '  if (__INTENT === "CREATE_NEW_ROUTE") b.create_idempotency_key = "AIPLAN-FIXED-KEY-1";',
      '  return __realAtomic(b); };'
    ].join('\n'));
  }
  return h;
}
function generate(h) { return h.parse('weeklyAiPlanGenerateK2_(SS, MAPPED.request, HARVEST, null, BODY)'); }

// ================================================================================================================
section('A. THE TYPED SHEET DATE — reproduced, then canonicalized');
// ================================================================================================================
// The value Sheets actually returns, and the two conversions that look right and are not.
ok(String(TAIPEI_MIDNIGHT).indexOf('Sep 03 2026') !== -1,
  'A0  the live cell is a Date object rendering as "Thu Sep 03 2026 …" under String()');
eq(TAIPEI_MIDNIGHT.toISOString().slice(0, 10), '2026-09-02',
  'A0a and toISOString().slice(0,10) yields the PREVIOUS day — the silent one-day shift');

var K = build({}).run('KMSNF');
eq(typeof K.canonicalDate, 'function', 'A1  KMSNF exposes canonicalDate as the one conversion authority');
eq(K.canonicalDate(TAIPEI_MIDNIGHT, 480).date, '2026-09-03', 'A2  a real Date at Taipei midnight → 2026-09-03');
eq(K.canonicalDate(TAIPEI_MIDNIGHT, 480).kind, 'DATE', 'A2a and it is reported as having ARRIVED as a Date');
eq(K.canonicalDate('2026-09-03', 480), { ok: true, date: '2026-09-03', kind: 'STRING', reason: null },
  'A3  a canonical YYYY-MM-DD string passes through unchanged');
// §2 — the UTC boundary. Both ends of the business day must stay on the business day.
eq(K.canonicalDate(new Date(Date.UTC(2026, 8, 2, 16, 0, 0)), 480).date, '2026-09-03',
  'A4  00:00 Taipei stays 2026-09-03 (never 09-02)');
eq(K.canonicalDate(new Date(Date.UTC(2026, 8, 3, 15, 59, 0)), 480).date, '2026-09-03',
  'A4a 23:59 Taipei stays 2026-09-03 (never 09-04)');
eq(K.canonicalDate(new Date(Date.UTC(2026, 8, 3, 16, 0, 0)), 480).date, '2026-09-04',
  'A4b and one minute later IS the next business day');
eq(K.canonicalDate(new Date('nonsense'), 480).reason, 'CALCULATION_DATE_INVALID_DATE', 'A5  an Invalid Date is refused');
eq(K.canonicalDate('Thu Sep 03 2026 00:00:00 GMT+0800 (Taiwan Standard Time)', 480).reason,
  'CALCULATION_DATE_UNREADABLE', 'A6  a locale date STRING is refused, never re-parsed');
eq(K.canonicalDate('2026-09-03 00:00:00', 480).reason, 'CALCULATION_DATE_UNREADABLE',
  'A6a so is a datetime string — two legal inputs and no others');
eq(K.canonicalDate('', 480).reason, 'CALCULATION_DATE_MISSING', 'A7  a blank is MISSING, distinct from unreadable');
eq(K.canonicalDate(null, 480).reason, 'CALCULATION_DATE_MISSING', 'A7a and so is null');
eq(K.canonicalDate(46266, 480).reason, 'CALCULATION_DATE_UNREADABLE', 'A8  a numeric serial is refused, never decoded');
eq(K.canonicalDate('2026-02-31', 480).reason, 'CALCULATION_DATE_NOT_A_CALENDAR_DAY',
  'A9  a well-shaped non-day is refused — shape is not existence');
eq(K.canonicalDate(TAIPEI_MIDNIGHT, null).reason, 'TIMEZONE_AUTHORITY_UNAVAILABLE',
  'A10 with no zone authority there is no business day, and it refuses rather than guessing');
eq(K.canonicalDate(TAIPEI_MIDNIGHT, undefined).reason, 'TIMEZONE_AUTHORITY_UNAVAILABLE', 'A10a same for undefined');

// ---- through the READER, which is where the defect actually lived ----------------------------------------------
var hA = build({});
var cA = hA.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
ok(cA.ok === true, 'A11 the reader now ACCEPTS the live typed-date row (it refused before)');
eq(cA.distinctDates, ['2026-09-03'], 'A11a distinctDates holds a canonical date, not a locale rendering');
eq(cA.freshness.state, 'CURRENT_PRE_SCHEDULE', 'A11b freshness_state = CURRENT_PRE_SCHEDULE at 11:36');
eq(cA.acceptedDate, '2026-09-03', 'A11c accepted_snapshot_date = 2026-09-03');
eq(cA.dateNormalization.by_kind, { DATE: 1 }, 'A11d and the audit records that it ARRIVED as a Date object');
eq(cA.dateNormalization.unreadable, 0, 'A11e with nothing unreadable');

// A Date and a canonical string for the SAME day must collapse to ONE date, or a healthy scope looks mixed.
var hMix = build({ gapRows: [
  ['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520, 'GAP-INV-1'],
  ['ResUS', 'US', 'Amazon', 'CO1150-R', 'READY', '2026-09-03', 10, 20, 30, 40, 'GAP-INV-1']] });
var cMix = hMix.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
eq(cMix.distinctDates, ['2026-09-03'], 'A12 a Date object and a canonical string for one day collapse to ONE date');
ok(cMix.ok === true, 'A12a so the scope is not falsely reported as a partial snapshot');

// A GENUINE mix still blocks — the protection is not weakened by the fix.
var hReal = build({ gapRows: [
  ['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520, 'GAP-INV-1'],
  ['ResUS', 'US', 'Amazon', 'CO1150-R', 'READY', new Date(Date.UTC(2026, 8, 1, 16, 0, 0)), 10, 20, 30, 40, 'GAP-INV-0']] });
var cReal = hReal.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
eq(cReal.reason, 'PARTIAL_SNAPSHOT_BLOCKED', 'A13 two GENUINELY different days still block as a partial snapshot');
eq(cReal.distinctDates, ['2026-09-02', '2026-09-03'], 'A13a and both canonical dates are named');

// An unreadable value STILL fails closed, and still names itself.
var hBad = build({ gapRows: [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', 'not-a-date', 40, 120, 260, 520, 'G']] });
var cBad = hBad.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
eq(cBad.reason, 'LINEAGE_MISMATCH', 'A14 a genuinely unreadable date still fails closed');
eq(cBad.dateNormalization.unreadable, 1, 'A14a and the audit counts it');
eq(cBad.dateNormalization.unreadable_sample[0].reason, 'CALCULATION_DATE_UNREADABLE', 'A14b naming why');

// No zone authority in the deployment → refuse, never assume.
var hNoTz = build({ noTimezoneAuthority: true });
var cNoTz = hNoTz.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
ok(cNoTz.ok !== true, 'A15 with no timezone authority the read refuses rather than assuming +08:00');

// ================================================================================================================
section('B. SCHEDULE-AWARE FRESHNESS, over typed dates');
// ================================================================================================================
function at(h, m, rows) {
  return build({ nowMs: Date.UTC(2026, 8, 4, h, m) - 480 * 60000, gapRows: rows })
    .run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
}
var YDAY = [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520, 'G']];
var TODAY = [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', new Date(Date.UTC(2026, 8, 3, 16, 0, 0)), 40, 120, 260, 520, 'G']];
eq(at(11, 36, YDAY).freshness.state, 'CURRENT_PRE_SCHEDULE', 'B1  11:36, run due 13:30 → yesterday is CURRENT');
ok(at(11, 36, YDAY).ok === true, 'B1a and it is accepted');
eq(at(13, 29, YDAY).freshness.state, 'CURRENT_PRE_SCHEDULE', 'B2  13:29, one minute before due → still CURRENT');
eq(at(14, 0, YDAY).freshness.state, 'CURRENT_DURING_REFRESH', 'B3  14:00, run in flight → yesterday still current');
ok(at(14, 0, YDAY).ok === true, 'B3a and still accepted (a half-written today is not a better answer)');
eq(at(17, 46, YDAY).freshness.state, 'REFRESH_OVERDUE', 'B4  17:46, past drift+budget → the SAME snapshot is refused');
ok(at(17, 46, YDAY).ok !== true, 'B4a which is what no fixed age tolerance could express');
eq(at(14, 0, TODAY).freshness.state, 'CURRENT_AFTER_REFRESH', 'B5  today complete → accepted');
eq(at(11, 36, [['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', new Date(Date.UTC(2026, 8, 9, 16, 0, 0)), 1, 1, 1, 1, 'G']]).freshness.state,
  'LINEAGE_MISMATCH', 'B6  a FUTURE snapshot blocks');
eq(build({ cycle: 'RECO-2026-08' }).run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")').reason,
  'LINEAGE_MISMATCH', 'B7  a snapshot from a FOREIGN planning cycle blocks');
// The suggested quantity is the SNAPSHOT's, never the live recomputation.
var hQ = plan(build({}));
eq(hQ.run('SITES[0].cumulativeGapByWindow.D90'), 520, 'B8  the accepted quantity is the snapshot 520, not the live 999');
eq(hQ.run('SITES[0].liveGapByWindow.D90'), 999, 'B8a the live number is kept beside it for diagnosis only');
eq(hQ.run('SITES[0].demandLineage.freshness_state'), 'CURRENT_PRE_SCHEDULE',
  'B8b and the lineage carries the state that admitted it');

// ================================================================================================================
section('C. ALLOCATION SCHEMA GENERATIONS — one authority, enumerated shapes');
// ================================================================================================================
var hS = build({});
var FULL = hS.run('SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_');
var GENS = hS.run('sadSupportedSchemaVersions_()');
eq(GENS.map(function (g) { return g.column_count; }), [30, 34, 35, 36],
  'C0  the known lineage is 30 → 34 → 35 → 36, enumerated and named');
eq(GENS.map(function (g) { return g.lifecycle_complete; }), [false, true, true, true],
  'C0a only the post-lifecycle generations are lifecycle-complete');
ok(GENS.every(function (g) { return typeof g.version === 'string' && g.version.length > 0; }),
  'C0b every generation has a stable comparable version string');
ok(/destination_marketplace/.test(JSON.stringify(hS.run('SAD_ROUTE_IDENTITY_TAIL_COLUMNS_'))) &&
   /create_idempotency_key/.test(JSON.stringify(hS.run('SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_'))),
  'C0c the two legally appended columns are named by their own owners, in append order');
eq(FULL[34], 'destination_marketplace', 'C0d destination_marketplace sits at index 34');
eq(FULL[35], 'create_idempotency_key', 'C0e create_idempotency_key at 35');

function res(hdrs) { hS.ctx.__H = hdrs; return hS.run('sadResolveHeaderSchema_(__H)'); }
function wr(hdrs) { hS.SHEETS['__p'] = new FakeSheet(hdrs); hS.ctx.__P = hS.SHEETS['__p']; return hS.run('sadDraftsSchemaReason_(__P)'); }
function lc(hdrs) {
  hS.ctx.__H = hdrs;
  return hS.run([
    '(function () { var have = {}; __H.forEach(function (x) { have[x] = 1; });',
    '  var t = { missing: AIPL_AUDIT_COLUMNS_.filter(function (c) { return !have[c]; }), misplaced: [], present: [] };',
    '  t.complete = t.missing.length === 0;',
    '  return aiplActivationGate_({ header_table: { name: "shipping_allocation_drafts", exists: true, headers: __H },',
    '    line_table: { name: "shipping_allocation_draft_lines", exists: true, headers: [] }, tail: t,',
    '    header_status_accepts_expired: true, line_status_accepts_expired: true,',
    '    migration_version: aiplSchemaVersionOf_(__H), schema_resolution: aiplResolveSchema_(__H),',
    '    expected_migration_version: AIPL_MIGRATION_VERSION_, generation_run_id: "AIRUN-T", identity_collisions: [] });',
    '})()'
  ].join('\n'));
}
eq(res(FULL.slice(0, 30)).version, 'SAD-HEADERS-30-BASE', 'C1  legal base 30 resolves');
eq(res(FULL.slice(0, 34)).version, 'FB4C-AI-LIFECYCLE-1', 'C2  legal migrated 34 resolves');
eq(res(FULL.slice(0, 35)).version, 'FB4F-B4-ROUTE-IDENTITY-1', 'C3  legal migrated 35 resolves');
eq(res(FULL.slice(0, 36)).version, 'FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'C4  legal migrated 36 resolves');
eq(wr(FULL.slice(0, 30)), '', 'C5  the writer accepts 30');
eq(wr(FULL.slice(0, 36)), '', 'C5a and 36');
ok(lc(FULL.slice(0, 34)).ready === true && lc(FULL.slice(0, 35)).ready === true && lc(FULL.slice(0, 36)).ready === true,
  'C6  the lifecycle accepts all three lifecycle-complete generations');
ok(lc(FULL.slice(0, 30)).ready !== true,
  'C6a but NOT the pre-migration base — the four lifecycle columns are what it needs');

// The refusals §5 requires, each for its own reason.
ok(res(FULL.slice(0, 33)).ok === false && /COL_COUNT_33_UNSUPPORTED/.test(res(FULL.slice(0, 33)).reason),
  'C7  33 columns (a half-applied append) is refused — it is not a generation');
ok(res(FULL.slice(0, 5).concat(FULL.slice(6, 36))).ok === false, 'C8  a missing base header is refused');
var reorder = FULL.slice(0, 36); var t0 = reorder[3]; reorder[3] = reorder[4]; reorder[4] = t0;
ok(res(reorder).ok === false && res(reorder).first_mismatch.index === 3, 'C9  a reordered base header is refused, at its index');
eq(res(FULL.slice(0, 35).concat(['status'])).duplicate_headers, ['status'], 'C10 a duplicate header is named as a duplicate');
ok(res(FULL.slice(0, 35).concat(['status'])).ok === false, 'C10a and refused');
ok(res(FULL.slice(0, 35).concat(['create_idempotency_key_v2'])).ok === false,
  'C11 an unknown 36th header is refused — count alone would have passed it');
var tailSwap = FULL.slice(0, 36); var t1 = tailSwap[34]; tailSwap[34] = tailSwap[35]; tailSwap[35] = t1;
ok(res(tailSwap).ok === false, 'C12 the two appended columns in the WRONG order are refused');
ok(res(FULL.slice(0, 36).concat(['something_new'])).ok === false, 'C13 a 37th column is beyond the known lineage and refused');

// ================================================================================================================
section('D. §6 VERSION SEMANTICS — and the advice that used to be wrong');
// ================================================================================================================
var g36 = lc(FULL.slice(0, 36));
eq(g36.migration_version, 'FB4G-A2R3-CREATE-IDEMPOTENCY-1', 'D1  a legal 36 reports a definite version, never a blank');
eq(hS.run('aiplSchemaVersionOf_(' + JSON.stringify(FULL.slice(0, 36)) + ')'), 'FB4G-A2R3-CREATE-IDEMPOTENCY-1',
  'D1a the resolver itself no longer returns "" for a legal 36');
ok(g36.supported_migration_versions.length === 3, 'D1b and the accepted set is reported, not implied');
var gBad = lc(FULL.slice(0, 35).concat(['create_idempotency_key_v2']));
var E = gBad.error;
eq(E.observed_header_count, 36, 'D2  the refusal states the observed header count');
eq(E.observed_schema_version, null, 'D2a and that no version resolved');
eq(E.first_mismatch, { index: 35, actual: 'create_idempotency_key_v2', expected: 'create_idempotency_key' },
  'D2b with the exact first difference');
eq(E.unexpected_headers, ['create_idempotency_key_v2'], 'D2c and the unexpected header named');
ok(E.supported_migration_versions.length === 3, 'D2d beside the versions that WOULD be accepted');
ok(!/re-?sync the Apps Script project/i.test(E.next_action),
  'D3  and it no longer tells the operator to re-sync a project that is already current');
ok(/Do NOT re-sync code/.test(E.next_action), 'D3a it says so explicitly');
ok(/MIGRATION_VERSION_MISMATCH/.test(JSON.stringify(gBad.error.blocking_reasons)),
  'D4  MIGRATION_VERSION_MISMATCH survives, for a genuinely unknown schema only');

// ================================================================================================================
section('E. §9 PARITY — the writer and the lifecycle read ONE authority');
// ================================================================================================================
var SHAPES = [FULL.slice(0, 30), FULL.slice(0, 34), FULL.slice(0, 35), FULL.slice(0, 36), FULL.slice(0, 33),
  reorder, FULL.slice(0, 35).concat(['status']), FULL.slice(0, 35).concat(['zzz']), tailSwap,
  FULL.slice(0, 36).concat(['x'])];
var diverged = SHAPES.filter(function (s) { return (wr(s) === '') !== res(s).ok; });
eq(diverged.length, 0, 'E1  the writer verdict equals the resolver verdict for every shape');
var lcDiverged = SHAPES.filter(function (s) {
  var r = res(s);
  return (lc(s).ready === true) !== (r.ok === true && r.lifecycle_complete === true);
});
eq(lcDiverged.length, 0, 'E2  and the lifecycle verdict is exactly "recognized AND lifecycle-complete"');
ok(/sadDraftsSchemaReason_\(hSh\)/.test(G16), 'E3  the atomic writer calls the shared authority by name');
ok(/aiplResolveSchema_/.test(G69L) && /sadResolveHeaderSchema_/.test(G69L),
  'E4  and the lifecycle delegates to it rather than keeping its own copy');
ok(!/SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_;[\s\S]{0,400}a\.length !== canon\.length/.test(G69L),
  'E5  the old byte-equality-with-34 rule is gone');

// ================================================================================================================
section('F. THE THIRD BLOCKER — reproduced, pinned, NOT fixed');
// ================================================================================================================
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R2): THIS BLOCKER IS FIXED. Everything below was TRUE and REPRODUCED
// when it was written, and A2-R1-R2 added the third canonical intent it concluded was needed:
// UPSERT_AI_GENERATED_K2_ROUTE, server-owned, resolving the deterministic identity rather than minting or
// naming one. The assertions that recorded "61_ still calls with no intent" and "61_ is deliberately
// unchanged" describe a state that no longer exists and would now fail for the right reason.
//
// What SURVIVES from the original section is the part that is still true and still load-bearing: the writer
// really does require a declared intent, and NEITHER manual intent is a correct substitute for the AI path.
// That is the whole argument for the third intent, so it is kept and re-measured rather than deleted.
var rShipped = generate(plan(build({})));
eq(rShipped.success, true, 'F1  as 61_ calls it TODAY, generation succeeds (the blocker is fixed)');
eq((rShipped.data.groups[0] || {}).outcome, 'CREATED', 'F1a creating the plan');
ok(/ROUTE_INTENT_REQUIRED/.test(G16), 'F2  the intent requirement is still real, and still lives in 16_');
ok(/intent: 'UPSERT_AI_GENERATED_K2_ROUTE'/.test(G61),
  'F2a and 61_ now DECLARES the server-owned generation intent at its call site');
// The refusal itself still stands for anything that declares nothing.
var hNo = plan(build({}));
hNo.run('var __ra = handleUpsertShippingAllocationDraftAtomic_;' +
  'handleUpsertShippingAllocationDraftAtomic_ = function (b) { b = b || {}; delete b.intent; return __ra(b); };');
eq((generate(hNo).data.groups[0] || {}).error, 'ROUTE_INTENT_REQUIRED',
  'F2b strip the declaration and the writer refuses exactly as before');
eq(census(hNo).headers.length, 0, 'F2c with zero rows written');
// What each candidate intent would actually do. This is evidence for the NEXT round, not a fix.
var hC = plan(build({}), 'CREATE_NEW_ROUTE');
var rC1 = generate(hC);
eq(rC1.success, true, 'F3  with CREATE_NEW_ROUTE injected the write succeeds …');
eq(census(hC).headers.length, 1, 'F3a one header');
eq(census(hC).lines.reduce(function (a, l) { return a + Number(l.recommended_qty || 0); }, 0), 520, 'F3b holding 520');
ok(/^SADH-K4-/.test(rC1.data.groups[0].allocation_draft_id),
  'F3c … but it mints a K4 CREATE identity, bypassing the deterministic K2 identity entirely');
// A2-R1-R2 measured the sharper case: a second generation whose EXECUTION KEY has moved (a new daily gap
// run) against the same route. CREATE's only replay guard is that key, so it mints a fresh random id and
// leaves TWO active headers holding 1040 units. That is the duplicate the third intent exists to prevent.
hC.run('__INTENT = "CREATE_NEW_ROUTE";');
hC.run('var __ra2 = __realAtomic;' +
  'handleUpsertShippingAllocationDraftAtomic_ = function (b) { b = b || {}; b.intent = "CREATE_NEW_ROUTE";' +
  '  b.create_idempotency_key = "AIPLAN-KEY-DAY2"; return __ra2(b); };');
var rC2 = generate(hC);
eq(rC2.success, true, 'F4  a second CREATE under a MOVED create key succeeds …');
eq(census(hC).headers.filter(function (r) {
  var st = String(r.status || '').trim().toLowerCase();
  return st !== 'submitted' && st !== 'cancelled' && st !== 'expired';
}).length, 2, 'F4a … and leaves TWO active headers — the duplicate plan');
eq(census(hC).lines.reduce(function (a, l) { return a + Number(l.recommended_qty || 0); }, 0), 1040,
  'F4b holding 1040 units for a scope whose demand is 520');
var hU = plan(build({}), 'UPDATE_EXISTING_ROUTE');
eq((generate(hU).data.groups[0] || {}).error, 'ROUTE_INTENT_CONTRADICTORY',
  'F5  and UPDATE_EXISTING_ROUTE cannot be used: it requires an id the first run does not have');
// F6 RESTATED: 61_ IS changed now, and the conclusion that drove the change is what gets asserted instead.
ok(/UPSERT_AI_GENERATED_K2_ROUTE/.test(extractFn(G61, 'weeklyAiPlanGenerateK2_')),
  'F6  61_ declares the third intent — neither manual intent fits a deterministic upsert');
ok(typeof hS.run('SAD_CLIENT_GRANTABLE_INTENTS_')['UPSERT_AI_GENERATED_K2_ROUTE'] === 'undefined',
  'F6a and it is NOT client-grantable: a request can never declare it');

// ================================================================================================================
section('G. THE REST OF THE PATH IS SOUND — measured on that same state');
// ================================================================================================================
var hE = plan(build({}), 'CREATE_NEW_ROUTE'); generate(hE);
var cE = census(hE), hdr = cE.headers[0];
eq(hE.run('BUILT.forecastNormalization').default_zero_missing_year, 1,
  'G1  the absent 2027 forecast month is ONE accounted default-zero …');
eq(hE.run('ERRS').length, 0, 'G1a … and blocks nothing');
eq(hE.run('BUILT.forecastNormalization').actual, 3, 'G1b three months were real');
eq(hE.run('KMWRB.buildWeeklySourceLines(MAPPED.request).lines[0].recommendedQty'), 520,
  'G2  the allocator carries 520 through whole-carton allocation (upc ' + UPC + ' divides it)');
ok(hdr.recommended_source_warehouse_id && (hdr.destination_marketplace || hdr.recommended_destination_warehouse_id) &&
   hdr.recommended_shipping_method, 'G3  the stored route is complete: From, To and Method');
eq(hdr.recommended_shipping_method, 'SEA', 'G3a the method came from the real carrier authority');
eq(hdr.calculation_run_id, 'GAP-INV-20260903T170257-0001', 'G4  the header carries the accepted gap run lineage');
eq(cE.lines.length, 1, 'G5  line count matches the one generated route');
var hyd = hE.parse('handleGetShippingAllocationDraftWorkspace_({ company: "ResUS", country: "US", marketplace: "Amazon", planningCycle: "RECO-2026-09" })');
eq(hyd.data.status, 'ACTIVE_DRAFT_FOUND', 'G6  hydration finds the draft');
eq(hyd.data.draft.allocation_draft_id, hdr.allocation_draft_id, 'G6a the same identity that was stored');
eq((hyd.data.lines || []).reduce(function (a, l) { return a + Number(l.recommended_qty || 0); }, 0), 520,
  'G6b hydrated total = stored total = 520');
eq(hyd.data.duplicate_line_identities, [], 'G6c with no duplicate line identity');
eq(hE.run('HARVEST.scope_guard').excluded_lines, 0, 'G7  the scope guard kept the allowlisted scope');
eq(hE.run('HARVEST.scope_guard').enforced, true, 'G7a and was enforced');
['shipping_plans', 'shipments', 'factory_stock_movements'].forEach(function (t) {
  eq(hE.SHEETS[t].rows.length - 1, 0, 'G8  ' + t + ' — present and still empty (no downstream mutation)');
});
eq(hE.SHEETS['factory_stock'].rows.length - 1, 1, 'G8a factory_stock untouched (still its single fixture row)');

// ================================================================================================================
section('H. SAFETY — nothing was armed');
// ================================================================================================================
ok(/INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false/.test(CFG),
  'H1  the repository flag is still false — activation was simulated in a VM, never committed');
eq((CFG.match(/company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R'/g) || []).length, 1,
  'H2  the allowlist is unchanged and holds exactly one scope');
ok(/TEMP_FCROLL_DRY_RUN = true/.test(read('assets/tools/apps-script-diagnostics/TEMP_FC_REGULAR_FORECAST_YEAR_ROLLOVER_2027.gs')),
  'H3  the 2027 rollover migration is still unrun');
ok(/CENSUS_log_\('db_writes', 0\)/.test(TEMP) && /CENSUS_log_\('writer_constructed', false\)/.test(TEMP),
  'H4  the census still declares zero writes and no writer');
// R6-R6-R3 — THIS GUARANTEE WAS ABSOLUTE AND IS NOW BOUNDED, DELIBERATELY. The file gained a writer:
// RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE compensates the route the 2026-09-06 incident wrote without
// authorization. 'The census never calls the writer' is therefore false, and an assertion that keeps saying
// it would have to be deleted rather than corrected. What still holds, and is checked instead: there is
// EXACTLY ONE such call, it lives in EXACTLY ONE named function, and no entry point writes a cell directly.
var _h5Stripped = TEMP.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
eq((_h5Stripped.match(/handleUpsertShippingAllocationDraftAtomic_\s*\(/g) || []).length, 1,
  'H5  the census contains EXACTLY ONE call to the atomic writer');
var _h5From = TEMP.indexOf('function RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE(');
var _h5To = TEMP.indexOf('function CENSUS_r6r6r3FinishExec_(');
ok(_h5From > 0 && _h5To > _h5From
  && /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(TEMP.slice(_h5From, _h5To)),
  'H5a and it is inside RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE, the only function allowed to have it');
ok(!/\.setValue\(|\.appendRow\(|\.deleteRow\(|\.clearContent\(/.test(_h5Stripped),
  'H5b and no entry point writes a cell directly — every mutation goes through 16_ under its own lock');
ok(/CENSUS_log_\('allocation_schema'/.test(TEMP), 'H6  the census reports the live allocation schema (§10)');
ok(/CENSUS_log_\('freshness_reason'/.test(TEMP) && /hErr && hErr\.freshness/.test(TEMP),
  'H7  and reads the freshness out of a REFUSAL, not only a success');
eq(RO.OWNER_STAMPS.filter(function (s) { return !RO.BUILD_STAMP_RE.test(s); }), [],
  'H8  every recorded owner stamp is well-formed under the stamp vocabulary');
ok(RO.BUILD_STAMP_RE.test('F1-7N-FC-1B-E3-R4-A2-R1-R1'), 'H8a including this round\'s');
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R2): the TWELFTH round to pin its own stamp literal as "the current one",
// and mine again — one round after writing the same restatement for KMSNF's version string. What is durable is
// that 61_ carries a stamp on this line and that its deployment manifest AGREES with it; which round is newest
// changes by design, and a test that forbids the change is a test that has to be edited to ship anything.
var _wapStamp = (G61.match(/WAP_BUILD_VERSION_ = '([^']+)'/) || [])[1];
var _wapExpected = ((read(GS + '63_api_v1_system_health.gs')
  .match(/symbol: 'WAP_BUILD_VERSION_', expected: '([^']+)'/) || [])[1]);
ok(RO.stampAtOrAfter(_wapStamp, 'F1-7N-FC-1B-E3-R4-A2-R1-R1'),
  'H9  61_ carries a stamp at or after this round\'s (' + _wapStamp + ')');
eq(_wapStamp, _wapExpected, 'H9a and its deployment manifest expects exactly that stamp');
ok(RO.staleAppTokenRefs(read('index.html')).length === 0,
  'H10 no stale frontend token (no browser asset changed this round)');

// ================================================================================================================
section('N. MUTATIONS — each defect, reintroduced, must be caught');
// ================================================================================================================
function K2(mutSnf) {
  var h = build({ mutate: function (SRC) { SRC.bundle = mutSnf(SRC.bundle); } });
  return h;
}
mut('N1  String(date) returns at the reader boundary', function () {
  var h = build({ mutate: function (SRC) {
    SRC.wap = swap(SRC.wap, 'rec.calculation_date = _cd.ok ? _cd.date : weeklyAiPlanStr_(r.calculation_date);',
      'rec.calculation_date = weeklyAiPlanStr_(r.calculation_date);');
  } });
  var c = h.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")');
  return c.ok !== true && c.reason === 'LINEAGE_MISMATCH';
});
mut('N2  the UTC ISO conversion returns (the silent one-day shift)', function () {
  var h = K2(function (b) {
    return swap(b, '      var b = businessNow(t, offsetMinutes);\n      return { ok: true, date: b.ymd, kind: \'DATE\', reason: null };',
      '      return { ok: true, date: new Date(t).toISOString().slice(0, 10), kind: \'DATE\', reason: null };');
  });
  return h.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")').acceptedDate === '2026-09-02';
});
mut('N3  an Invalid Date is accepted', function () {
  var h = K2(function (b) {
    return swap(b, "        return { ok: false, date: null, kind: 'DATE', reason: 'CALCULATION_DATE_INVALID_DATE' };",
      "        return { ok: true, date: '2026-09-03', kind: 'DATE', reason: null };");
  });
  return h.run('KMSNF').canonicalDate(new Date('nonsense'), 480).ok === true;
});
mut('N4  a locale date string is parsed instead of refused', function () {
  var h = K2(function (b) {
    return swap(b, "        return { ok: false, date: null, kind: 'STRING', reason: 'CALCULATION_DATE_UNREADABLE' };",
      "        return { ok: true, date: new Date(sv).toISOString().slice(0, 10), kind: 'STRING', reason: null };");
  });
  return h.run('KMSNF').canonicalDate('Thu Sep 03 2026 00:00:00 GMT+0800', 480).ok === true;
});
mut('N5  the timezone authority becomes an assumed default', function () {
  var h = K2(function (b) {
    return swap(b, "      return { ok: false, date: null, kind: 'UNKNOWN', reason: 'TIMEZONE_AUTHORITY_UNAVAILABLE' };",
      '      offsetMinutes = 480;');
  });
  return h.run('KMSNF').canonicalDate(TAIPEI_MIDNIGHT, null).ok === true;
});
mut('N6  mixed-date protection is removed', function () {
  var h = build({ mutate: function (SRC) {
    SRC.bundle = swap(SRC.bundle, 'if (out.detail.distinctDates.length > 1) {', 'if (false) {');
  }, gapRows: [
    ['ResUS', 'US', 'Amazon', 'CO1100-R', 'READY', TAIPEI_MIDNIGHT, 40, 120, 260, 520, 'G'],
    ['ResUS', 'US', 'Amazon', 'CO1150-R', 'READY', new Date(Date.UTC(2026, 8, 1, 16, 0, 0)), 1, 1, 1, 1, 'G']] });
  return h.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")').reason !== 'PARTIAL_SNAPSHOT_BLOCKED';
});
mut('N7  the schedule comparison is removed (overdue never arrives)', function () {
  var h = build({ mutate: function (SRC) {
    SRC.bundle = swap(SRC.bundle, 'if (now.minuteOfDay < overdueMin) {', 'if (true) {');
  }, nowMs: Date.UTC(2026, 8, 4, 23, 59) - 480 * 60000 });
  return h.run('weeklyAiPlanCanonicalDemand_(SS, SCOPE, "2026-09-04")').ok === true;
});
mut('N8  the known lineage shrinks back to the single frozen 34-column shape', function () {
  // The ACTUAL regression: drop the later append generations from the authority and a correctly migrated
  // 36-column production table reports no version again — which is precisely the outage this round fixed.
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '    appended: SAD_HEADER_OPTIONAL_TAIL_COLUMNS_, lifecycle_complete: true,',
      '    appended: SAD_LIFECYCLE_TAIL_COLUMNS_, lifecycle_complete: true,');
  } });
  h.ctx.__H = FULL.slice(0, 36);
  return h.run('aiplSchemaVersionOf_(__H)') === '' && h.run('sadResolveHeaderSchema_(__H)').ok === false;
});
mut('N9  count-only 30..36 acceptance replaces positional comparison', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '    if (a[j] !== want[j]) {', '    if (false) {');
  } });
  h.ctx.__H = FULL.slice(0, 35).concat(['create_idempotency_key_v2']);
  return h.run('sadResolveHeaderSchema_(__H)').ok === true;
});
mut('N10 an unknown appended header is accepted', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '      out.reason = \'COL\' + j + \'_IS_\' + (a[j] || \'(blank)\') + \'_EXPECTED_\' + want[j];',
      '      out.ok = true; out.version = cand.version; out.lifecycle_complete = cand.lifecycle_complete === true; return out;');
  } });
  h.ctx.__H = FULL.slice(0, 35).concat(['create_idempotency_key_v2']);
  return h.run('sadResolveHeaderSchema_(__H)').ok === true;
});
mut('N11 a duplicate header stops being detected', function () {
  var h = build({ mutate: function (SRC) {
    SRC.sad = swap(SRC.sad, '    if (seen[a[i]]) { if (out.duplicate_headers.indexOf(a[i]) === -1) out.duplicate_headers.push(a[i]); }', '');
  } });
  h.ctx.__H = FULL.slice(0, 35).concat(['status']);
  return h.run('sadResolveHeaderSchema_(__H)').duplicate_headers.length === 0;
});
mut('N12 the writer stops reading the shared authority (divergence returns)', function () {
  var m = swap(G16, 'var hR = sadDraftsSchemaReason_(hSh);',
    'var hR = sadExactSchemaReason_(hSh, SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_, SAD_HEADER_OPTIONAL_TAIL_COLUMNS_);');
  return /sadDraftsSchemaReason_\(hSh\)/.test(G16) && !/sadDraftsSchemaReason_\(hSh\)/.test(m);
});
mut('N13 the census constructs a writer', function () {
  var m = swap(TEMP, "CENSUS_log_('writer_constructed', false);", "CENSUS_log_('writer_constructed', true);");
  return /'writer_constructed', false/.test(TEMP) && /'writer_constructed', true/.test(m);
});
mut('N14 the census stops reporting the allocation schema', function () {
  var m = swap(TEMP, "    CENSUS_log_('allocation_schema', _ds ? {", "    if (false) CENSUS_log_('allocation_schema', _ds ? {");
  return /CENSUS_log_\('allocation_schema'/.test(TEMP) && /if \(false\) CENSUS_log_\('allocation_schema'/.test(m);
});
mut('N15 the feature flag is enabled in the repository', function () {
  var m = swap(CFG, 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false', 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true');
  return /ENABLED_ = false/.test(CFG) && /ENABLED_ = true/.test(m);
});
mut('N16 the allowlist is widened', function () {
  var m = swap(CFG, "{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' }",
    "{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },\n  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1150-R' }");
  return (CFG.match(/marketplace: 'Amazon'/g) || []).length === 1 && (m.match(/marketplace: 'Amazon'/g) || []).length === 2;
});
mut('N17 the rollover migration is armed', function () {
  var R = read('assets/tools/apps-script-diagnostics/TEMP_FC_REGULAR_FORECAST_YEAR_ROLLOVER_2027.gs');
  var m = swap(R, 'TEMP_FCROLL_DRY_RUN = true', 'TEMP_FCROLL_DRY_RUN = false');
  return /DRY_RUN = true/.test(R) && /DRY_RUN = false/.test(m);
});
mut('N18 the stamp vocabulary loses the B-series again', function () {
  var src = read('assets/tests/_release-order.js');
  var m = swap(src, '|A\\d+|B\\d+))*$/', '|A\\d+))*$/');
  var re = /var BUILD_STAMP_RE = (\/[^\n]+\/);/.exec(m);
  var mutated = eval(re[1]);
  return RO.OWNER_STAMPS.every(function (s) { return RO.BUILD_STAMP_RE.test(s); }) &&
    !RO.OWNER_STAMPS.every(function (s) { return mutated.test(s); });
});

console.log('\n----------------------------------------');
console.log('TYPED SHEET DATE + ALLOCATION SCHEMA COMPATIBILITY (F1-7N-FC-1B-E3-R4-A2-R1-R1): '
  + pass + ' passed, ' + fail + ' failed');
console.log('mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
process.exit(fail ? 1 : 0);
