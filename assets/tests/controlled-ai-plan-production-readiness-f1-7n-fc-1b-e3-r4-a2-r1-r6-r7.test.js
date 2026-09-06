// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7 — CONTROLLED AI PLAN PRODUCTION READINESS.
//
// The manual Route Save is finished: both stages ran in production, one row moved each time, the second
// request carried its optimistic token, and Route B never moved. What is left is the write nobody has ever
// let this system perform — a Generate AI Plan that reaches the database.
//
// FOUR PROPERTIES THIS SUITE EXISTS TO PIN.
//
// (1) THE NUMBER ON THE SCREEN HAS ONE OWNER, AND THE CENSUS FINDS IT RATHER THAN PICKING IT. 920 and 0 were
//     both labelled "Recommended". Neither is adopted here: the census applies BOTH shipped reading rules to
//     the authoritative row and reports which rule reproduces which number. A value neither rule reproduces
//     is a third source, and it STOPS the round.
//
// (2) A GENERATION CANNOT REACH A MANUAL ROUTE, AND THE REASON IS AN IDENTITY, NOT A PROMISE. The
//     deterministic header id's last dimension is recommendation_group_no. A manual save never sends one;
//     every generated group carries an ordinal. Two keys that differ in their last segment hash to different
//     ids, so an AI upsert resolves to a row that does not exist and creates it.
//
// (3) NOTHING WRITTEN IS A SUCCESS VERDICT, NOT A MISSING ONE. A canonical zero recommendation must produce
//     no header and no line — not an empty shell — and the readback must say so in its own words.
//
// (4) NO PRODUCTION WRITE, AND NO PATH TO ONE. Every R6-R7 entry point is read-only, takes no arguments and
//     inherits one hard-coded scope; none constructs a writer.
//
// Run: node assets/tests/controlled-ai-plan-production-readiness-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var fail = 0, pass = 0;
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
var NL = String.fromCharCode(10);
var CR = String.fromCharCode(13) + String.fromCharCode(10);
var WS = ' ' + String.fromCharCode(9) + String.fromCharCode(13) + String.fromCharCode(10);

function extractFn(src, name) {
  var re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  var m = re.exec(src); if (!m) throw new Error('not found: ' + name);
  var start = m.index, i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
function extractVar(src, name) {
  var m = new RegExp('var ' + name + '\\s*=').exec(src); if (!m) throw new Error('not found: ' + name);
  var i = src.indexOf('=', m.index) + 1;
  while (WS.indexOf(src[i]) >= 0) i++;
  if (src[i] === '{' || src[i] === '[') {
    var open = src[i], close = open === '{' ? '}' : ']', d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (d === 0) break; } }
    return src.slice(m.index, j + 1) + ';';
  }
  var k = src.indexOf(';', i);
  return src.slice(m.index, k + 1);
}
function swap(src, find, repl) {
  if (src.indexOf(find) < 0) throw new Error('swap anchor not found: ' + find.slice(0, 90));
  return src.replace(find, repl);
}

var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var G00 = read('assets/specs/active/apps-script/00_config.gs');
var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G43 = read('assets/specs/active/apps-script/43_api_v1_gap_materialization.gs');
// R3-P1 — the full-row snapshot normalizes an INSTANT column through the project's existing cell
// normalizer rather than a second timestamp parser of its own. That normalizer lives in 41_.
var G41 = read('assets/specs/active/apps-script/41_shipping_allocation_schema_audit.gs');
var GLOBAL_G61 = read('assets/specs/active/apps-script/61_api_v1_weekly_ai_plan.gs');
var G61 = GLOBAL_G61;
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var G69L = read('assets/specs/active/apps-script/69_api_v1_ai_plan_lifecycle.gs');
var BUNDLE = read('assets/specs/active/apps-script/90_generated_supply_planning_bundle.gs');
var PAGE = read('assets/js/pages/inventory-replenishment.js');
var KMREC = read('assets/js/core/supply-recommendation.js');
var E3SUITE = read('assets/tests/ai-plan-activation-and-execution-row-layout-f1-7n-fc-1b-e3.test.js');
var RO = require('./_release-order.js');

var STAMP = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';
var SKU = 'CO1100-R';
var A_HEADER = 'SADH-K4-38523A90', A_LINE = 'SADL-K2-92B8BAD2';
var B_HEADER = 'SADH-K4-A3872518', B_LINE = 'SADL-K2-344FB2B2';
var PAGE_ACTOR = 'inventory-replenishment';
var REPAIR_ACTOR = 'r6r6r3-compensating-repair';
var TS_A = 'Sun Sep 06 2026 14:31:12 GMT+0800 (Taiwan Standard Time)';
var TS_B = 'Sun Sep 06 2026 09:56:04 GMT+0800 (Taiwan Standard Time)';
var TS_GAP = 'Sat Sep 05 2026 03:00:00 GMT+0800 (Taiwan Standard Time)';
// The snapshot date the freshness authority will accept, DERIVED from the same clock it reads (Taipei,
// UTC+8). A literal here would pass today and fail tomorrow — an equality with now, in a fixture.
var GAP_DATE = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
// And the cycle the snapshot belongs to, in the shape the authority compares against (RECO-YYYY-MM).
var GAP_CYCLE = 'RECO-' + GAP_DATE.slice(0, 7);
var GAP_YESTERDAY = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);

// ================================================================================================================
// THE DOUBLE. Same shape as the R6-R6 family's, plus the materialized gap table the recommendation authority
// lives in and the two config authorities (the flag and the allowlist) the activation is gated by.
// ================================================================================================================
function FakeSheet(headers) { this.rows = [headers.slice()]; this.writes = 0; }
FakeSheet.prototype.getLastColumn = function () { return this.rows[0].length; };
FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
FakeSheet.prototype.getDataRange = function () { var s = this; return { getValues: function () { return s.rows.map(function (r) { return r.slice(); }); } }; };
FakeSheet.prototype.appendRow = function (r) { this.writes++; this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (row, col, nr, nc) {
  var s = this;
  return {
    getValues: function () { var o = []; for (var i = 0; i < (nr || 1); i++) { var l = []; for (var j = 0; j < (nc || 1); j++) l.push(s.rows[row - 1 + i][col - 1 + j]); o.push(l); } return o; },
    getValue: function () { return s.rows[row - 1][col - 1]; },
    setValue: function (v) { s.writes++; s.rows[row - 1][col - 1] = v; },
    setValues: function (v) { s.writes++; for (var i = 0; i < v.length; i++) for (var j = 0; j < v[i].length; j++) s.rows[row - 1 + i][col - 1 + j] = v[i][j]; }
  };
};

var HDR_FULL, LINE_FULL, GAP_HDR;
(function () {
  var names = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
    'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_', 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
    'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_', 'SAD_LINE_ETA_TAIL_COLUMNS_'];
  var s = {};
  vm.runInNewContext(names.map(function (n) { return extractVar(G16, n); }).join(NL), s);
  HDR_FULL = s.SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_;
  LINE_FULL = s.SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(s.SAD_LINE_ETA_TAIL_COLUMNS_);
  var g = {};
  vm.runInNewContext(extractVar(G43, 'INV_GAP_HEADERS_'), g);
  GAP_HDR = g.INV_GAP_HEADERS_;
})();

var SAD_CONSTS = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
  'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_', 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
  'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SAD_SCHEMA_GENERATIONS_', 'SAD_AI_K2_INTENT_', 'SAD_ROUTE_INTENTS_',
  'SAD_CLIENT_GRANTABLE_INTENTS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_',
  'SAD_LINE_ETA_TAIL_COLUMNS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_',
  // R3-P1 — the two field-class authorities the full-row normalizer reads to decide DAY / NUMERIC / text.
  'SAD_K2_FP_DATE_FIELDS_', 'SAD_K2_FP_NUMERIC_FIELDS_',
  'SAD_STATUSES_', 'SAD_TERMINAL_STATUSES_', 'SAD_TERMINAL_LINE_STATUSES_',
  'SAD_GENERATION_TYPES_', 'SAD_RECOMMENDATION_FIELDS_', 'SAD_LINE_LEGACY_ALIASES_', 'SAD_K2_GROUP_DIMENSIONS_',
  'SAD_LINE_IDENTITY_FIELDS_'];
var SAD_FNS = ['sadApplyLineAliases_', 'sadFnv1a_', 'sadFpVal_', 'sadLineNaturalKey_', 'sadDeterministicLineId_',
  'sadK2GroupKey_', 'sadK2DeterministicHeaderId_', 'sadK2LineNaturalKey_', 'sadK2DeterministicLineId_',
  'sadLiveHeaderNames_', 'sadHasColumn_', 'sadDestinationIdentity_', 'sadHeaderRouteIsComplete_',
  'sadReadActiveHeaderRows_', 'sadRowToObject_', 'sadReadLinesForDraft_', 'sadK4SchemaReady_',
  'sadK4ResolveActiveDraft_', 'sadResolveHeaderSchema_', 'sadDraftsSchemaReason_',
  'sadSchemaGenerationColumns_', 'sadSupportedSchemaVersions_',
  // R3-P1 — the line-side schema gate and the day/numeric normalizers. No second parser is written
  // anywhere; the census reaches these.
  'sadExactSchemaReason_', 'sadCanonDate_', 'sadFpNorm_'];
// 41_ owns the INSTANT normalizer: a Date becomes its epoch, so a timezone display string cannot read as
// a change. It is a separate file, so it is injected separately and its absence is a testable state.
var SAD41_FNS = ['sadAuditNormCell_'];
var AIPL_CONSTS = ['AIPL_CONTRACT_VERSION_', 'AIPL_SOURCE_PAGE_', 'AIPL_EXPIRATION_REASON_',
  'AIPL_AUDIT_COLUMNS_', 'AIPL_MIGRATION_VERSION_', 'AIPL_SCHEMA_NOT_READY_', 'AIPL_COLLISION_CODE_',
  'AIPL_SUPPRESSED_CODE_', 'AIPL_AI_GENERATION_TYPES_', 'AIPL_PROTECTED_STATUSES_'];
var AIPL_FNS = ['aiplStr_', 'aiplLo_', 'aiplErr_', 'aiplSchemaReady_', 'aiplIsAiGenerated_', 'aiplSameScope_',
  'aiplManualPrecedence_', 'aiplExpirationCandidates_', 'aiplActiveIdentityConflicts_'];

function headerRow(o) { var d = {
  allocation_draft_id: '', planning_cycle: '', source_page: 'inventory_replenishment',
  company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
  recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', recommended_destination_warehouse_id: '',
  recommended_source_warehouse_code_snapshot: 'CNYOUXIN', recommended_destination_warehouse_code_snapshot: '',
  recommendation_group_no: '', recommended_shipping_method: '', recommended_last_mile_delivery: '',
  generation_type: 'user_created', generation_run_id: '', draft_version: '', created_by: PAGE_ACTOR,
  created_at: TS_A, updated_by: PAGE_ACTOR, updated_at: '', destination_marketplace: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
function lineRow(o) { var d = {
  allocation_draft_line_id: '', allocation_draft_id: '', sku: SKU, planned_qty: '',
  source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', source_warehouse_code_snapshot: 'CNYOUXIN',
  line_status: '', created_at: TS_A, updated_at: '', expected_arrival: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }

// Production as §0 records it: Route A truck at version 4, Route B blank at version 3, 520 planned.
var PROD_A_H = headerRow({ allocation_draft_id: A_HEADER, destination_marketplace: 'Amazon',
  recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
  draft_version: '4', updated_at: TS_A, updated_by: PAGE_ACTOR });
var PROD_A_L = lineRow({ allocation_draft_line_id: A_LINE, allocation_draft_id: A_HEADER,
  planned_qty: '320', updated_at: TS_A });
var PROD_B_H = headerRow({ allocation_draft_id: B_HEADER,
  recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
  recommended_destination_warehouse_code_snapshot: 'AMZLGS',
  recommended_shipping_method: 'air', recommended_last_mile_delivery: '',
  draft_version: '3', updated_at: TS_B, updated_by: REPAIR_ACTOR });
var PROD_B_L = lineRow({ allocation_draft_line_id: B_LINE, allocation_draft_id: B_HEADER,
  planned_qty: '200', updated_at: TS_B });

// The materialized gap row. THE DEFAULT REPRODUCES THE DISPUTED SCREENS: 920 short at D18, closed by D90.
function gapRow(o) { var d = {
  company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: SKU,
  calculation_status: 'READY', calculation_date: GAP_DATE,
  d18_gap_qty: 920, d18_suggested_qty: 920, d30_gap_qty: 400, d30_suggested_qty: 400,
  d45_gap_qty: 0, d45_suggested_qty: 0, d90_gap_qty: 0, d90_suggested_qty: 0,
  note: '', calculated_at: TS_GAP, updated_at: TS_GAP };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }

// ================================================================================================================
// THE WORLD.
// ================================================================================================================
function World(over, censusSrc, g61Src) {
  over = over || {};
  var G61 = g61Src || GLOBAL_G61;
  var sheets = {};
  var H = new FakeSheet(HDR_FULL), L = new FakeSheet(LINE_FULL), G = new FakeSheet(GAP_HDR);
  sheets['shipping_allocation_drafts'] = H;
  sheets['shipping_allocation_draft_lines'] = L;
  sheets['inventory_replenishment_gap'] = G;
  function put(sheet, headers, obj) { sheet.rows.push(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })); }
  function merge(base, o) { var d = {}; Object.keys(base).forEach(function (k) { d[k] = base[k]; });
    Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
  if (!over.dropB) put(L, LINE_FULL, merge(PROD_B_L, over.bLine));
  if (!over.dropB) put(H, HDR_FULL, merge(PROD_B_H, over.bHeader));
  if (!over.dropA) put(L, LINE_FULL, merge(PROD_A_L, over.aLine));
  if (!over.dropA) put(H, HDR_FULL, merge(PROD_A_H, over.aHeader));
  (over.extraHeaders || []).forEach(function (o) { put(H, HDR_FULL, headerRow(o)); });
  (over.extraLines || []).forEach(function (o) { put(L, LINE_FULL, lineRow(o)); });
  if (!over.dropGap) put(G, GAP_HDR, gapRow(over.gap));
  (over.extraGap || []).forEach(function (o) { put(G, GAP_HDR, gapRow(o)); });
  H.writes = 0; L.writes = 0; G.writes = 0;

  var LOG = [];
  var sb = { console: { log: function () {} }, JSON: JSON, Math: Math, Date: Date, String: String,
    Number: Number, Object: Object, Array: Array, isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat,
    parseInt: parseInt, Error: Error, RegExp: RegExp, Boolean: Boolean };
  sb.global = sb;
  sb.Logger = { log: function (m) { LOG.push(String(m)); } };
  var book = { getSheetByName: function (n) { return sheets[n] || null; }, getId: function () { return 'PROD-BOOK'; } };
  sb.SpreadsheetApp = {
    openById: function () { return book; },
    getActiveSpreadsheet: function () { return over.activeBook === undefined ? book : over.activeBook; }
  };
  sb.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
  var uu = 0;
  sb.Utilities = { getUuid: function () { uu++; return ('UUID' + uu + 'ABCDEF0123456789').substring(0, 16); } };
  sb.Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };
  var props = over.gapJob === null ? null : JSON.stringify(over.gapJob || {
    product: 'INVENTORY', runId: 'GAP-INV-20260905-0300', status: 'DONE',
    planningCycle: GAP_CYCLE, calculationDate: GAP_DATE, finishedAt: TS_GAP });
  sb.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { return k === 'GAP_JOB_INVENTORY' ? props : null; } }; } };

  var ctx = vm.createContext(sb);
  vm.runInContext(BUNDLE, ctx);
  vm.runInContext([
    'function prodExpectedDbId_() { return "PROD-BOOK"; }',
    'function prodAssertDbTarget_(ss) {',
    '  if (!ss || (typeof ss.getId === "function" && ss.getId() !== prodExpectedDbId_())) {',
    '    throw new Error("PRODUCTION_SAFETY:WRONG_SPREADSHEET_TARGET"); }',
    '  return true; }',
    'function procurementTimestamp_() { return "' + TS_A + '"; }',
    'function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ""; }',
    'function prodRequireSheet_(ss, n) { return ss.getSheetByName(n); }',
    'function jsonResponse_(o) { var s = JSON.stringify(o); return { getContent: function () { return s; } }; }',
    'function gapCalcResolveContext_() { return { ok: true, planningCycle: "'
      + (over.cycle === undefined ? GAP_CYCLE : over.cycle) + '" }; }'
  ].join(NL), ctx);
  // 69_ route identity + 69_ lifecycle + 43_ table identity + 00_ the two gates + 61_'s own declarations.
  vm.runInContext([
    (/var RIC_CANONICAL_SERVICES_ = [^;]+;/.exec(G69) || [''])[0],
    (/var RIC_SERVICE_LABELS_ = \{[\s\S]*?\};/.exec(G69) || [''])[0],
    extractVar(G69, 'RIC_DESTINATION_TYPES_'),
    extractVar(G69, 'RIC_K4_GROUP_DIMENSIONS_'),
    extractFn(G69, 'ricDestinationIdentity_'),
    extractFn(G69, 'ricCanonicalService_'),
    extractFn(G69, 'ricK4GroupKey_'),
    extractFn(G69, 'ricK4DeterministicHeaderId_')
  ].join(NL), ctx);
  vm.runInContext(AIPL_CONSTS.map(function (v) { return extractVar(G69L, v); })
    .concat(AIPL_FNS.map(function (f) { return extractFn(G69L, f); }))
    .concat(['function aiplExpireSupersededDrafts_() { return null; }',
      'function aiplActivationGate_() { return { ready: true }; }',
      'function aiplReadActivationFacts_() { return {}; }']).join(NL), ctx);
  if (over.dropLifecycle) {
    vm.runInContext('aiplExpireSupersededDrafts_ = null; aiplActivationGate_ = null; aiplReadActivationFacts_ = null;', ctx);
  }
  vm.runInContext([extractVar(G43, 'INV_GAP_TABLE_'), extractVar(G43, 'INV_GAP_HEADERS_'),
    extractVar(G43, 'GAP_INV_WINDOWS_')].join(NL), ctx);
  vm.runInContext([
    over.allowlist === undefined ? extractVar(G00, 'INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_')
      : ('var INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ = ' + JSON.stringify(over.allowlist) + ';'),
    extractFn(G00, 'inventoryAiPlanScopeEnabled_'),
    'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = ' + (over.flag === true ? 'true' : 'false') + ';',
    extractFn(G00, 'inventoryAiPlanDbGenerationEnabled_')
  ].join(NL), ctx);
  vm.runInContext([
    extractFn(G61, 'weeklyAiPlanActivationManifest_'),
    extractFn(G61, 'weeklyAiPlanStr_'),
    extractFn(G61, 'weeklyAiPlanResolveGapRunLineage_')
  ].join(NL), ctx);
  // R6-R7-R1 — THE REAL PRODUCTION AUTHORITY, not a second copy of its rules. The canonical-demand reader
  // comes with it (and the freshness authority it calls, from the bundle) because the state classifier reads
  // that reader's OUTPUT SHAPE — so a field renamed on one side and not the other fails here rather than in
  // production.
  vm.runInContext([
    extractVar(G43, 'GAP_CALC_UTC_OFFSET_MIN_'),
    extractFn(G43, 'gapCalcNowMs_'),
    extractVar(G61, 'WAP_GAP_TABLE_'),
    extractVar(G61, 'WAP_GAP_REQUIRED_COLS_'),
    extractVar(G61, 'WAP_GAP_WINDOW_COL_'),
    extractVar(G61, 'WAP_RECOMMENDATION_STATES_'),
    extractVar(G61, 'WAP_NO_ACTION_CODE_'),
    extractFn(G61, 'weeklyAiPlanNum_'),
    extractFn(G61, 'weeklyAiPlanErr_'),
    extractFn(G61, 'weeklyAiPlanCanonicalDate_'),
    extractFn(G61, 'weeklyAiPlanGapSchedule_'),
    extractFn(G61, 'weeklyAiPlanGapJobState_'),
    extractFn(G61, 'weeklyAiPlanCanonicalDemand_'),
    extractFn(G61, 'weeklyAiPlanTargetScopes_'),
    extractFn(G61, 'weeklyAiPlanQty_'),
    extractFn(G61, 'weeklyAiPlanRecommendationState_'),
    extractFn(G61, 'weeklyAiPlanIsAiRow_'),
    extractFn(G61, 'weeklyAiPlanQualifyingPlannedQty_'),
    extractFn(G61, 'weeklyAiPlanResidualQty_'),
    extractFn(G61, 'weeklyAiPlanNetSitesByResidual_'),
    extractFn(G61, 'weeklyAiPlanNoActionDecision_'),
    extractFn(G61, 'weeklyAiPlanNoActionResponse_'),
    // R6-R7-R2 — the shared decision builder the handler returns its envelope from, and the ONE thing the
    // census is now allowed to ask. Without it in this world the preflight reports UNAVAILABLE, which is
    // the correct answer to 'we could not ask' and the wrong world to test parity in.
    extractFn(G61, 'weeklyAiPlanScopeEmptyRefusal_'),
    extractVar(G61, 'WAP_CONTROLLED_GATE_ORDER_'),
    extractFn(G61, 'weeklyAiPlanControlledDecisionFromParts_'),
    extractFn(G61, 'weeklyAiPlanControlledDecision_'),
    extractVar(G16, 'SAD_TERMINAL_STATUSES_'),
    extractVar(G16, 'SAD_TERMINAL_LINE_STATUSES_'),
    'function inventoryAiPlanActivationAllowlist_() { return INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_; }',
    'function gapReadObjects_(ss, name) { var sh = ss.getSheetByName(name); if (!sh || sh.getLastRow() < 2) return [];'
      + ' var v = sh.getDataRange().getValues(); var hd = v[0]; var o = [];'
      + ' for (var r = 1; r < v.length; r++) { var x = {}; for (var c = 0; c < hd.length; c++) if (hd[c]) x[hd[c]] = v[r][c]; o.push(x); } return o; }'
  ].join(NL), ctx);
  vm.runInContext([extractFn(G13, 'procurementEnsureSheet_'), extractFn(G13, 'procurementAppendByHeader_'),
    extractFn(G13, 'procurementFindRow_')].join(NL), ctx);
  vm.runInContext(SAD_CONSTS.map(function (v) { return extractVar(G16, v); }).join(NL), ctx);
  vm.runInContext('var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ = '
    + 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);', ctx);
  vm.runInContext(SAD_FNS.map(function (f) { return extractFn(G16, f); }).join(NL), ctx);
  if (!over.drop41) vm.runInContext(SAD41_FNS.map(function (f) { return extractFn(G41, f); }).join(NL), ctx);
  vm.runInContext(censusSrc || CENSUS, ctx);
  // The E3 activation census reaches the whole harvest, which is a different suite's subject. What R6-R7
  // consumes from it is the ALLOCATOR RESULT, so that is what is supplied — the proposed groups, in the
  // shape the real census emits. Substituting it here tests R6-R7's identity arithmetic rather than
  // re-testing E3's harvest.
  var proposed = over.proposed === undefined
    ? [{ group_no: '1', source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', destination_type: 'MARKETPLACE',
        destination: 'Amazon', method: 'sea_express', last_mile: 'truck', line_count: 1, total_qty: 920 }]
    : over.proposed;
  vm.runInContext('RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R = function () { return { planning_cycle: "'
    + (over.cycle === undefined ? GAP_CYCLE : over.cycle) + '", allocator: { routes: '
    + JSON.stringify(proposed) + ' } }; };', ctx);

  this.ctx = ctx; this.sheets = sheets; this.log = LOG;
  this.H = H; this.L = L; this.G = G;
}
World.prototype.run = function (entry) {
  var res = null, threw = null;
  try { res = vm.runInContext(entry + '()', this.ctx); } catch (e) { threw = e; }
  return { res: res || {}, threw: threw };
};
World.prototype.dbWrites = function () { return this.H.writes + this.L.writes + this.G.writes; };
function failed(r) { return (r.predicates || []).filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }); }
function has(r, name) { return (r.predicates || []).some(function (p) { return p.predicate === name; }); }
function predicate(r, name) { return (r.predicates || []).filter(function (p) { return p.predicate === name; })[0] || null; }

// ================================================================================================================
section('A — §2 the recommendation authority census');
// ================================================================================================================
var wA = new World();
var A = wA.run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A.verdict, 'RECOMMENDATION_AUTHORITY_ESTABLISHED', 'A1 one row, two rules, both numbers accounted for');
eq(A.predicates_failed, 0, 'A1a with zero failed predicates');
eq(wA.dbWrites(), 0, 'A1b and it wrote nothing at all');
eq(A.db_writes, 0, 'A1c which it also reports about itself');
eq(A.writer_constructed, false, 'A1d no writer was constructed');
eq(A.row_count, 1, 'A2 exactly one authoritative row for the exact four-part key');

// THE WHOLE POINT OF §2: the two numbers are one row read by two rules, and the census SAYS which is which.
eq(A.suggested_qty.standing_authority_value, 0, 'A3 the standing authority reads d90 — and it is 0');
eq(A.suggested_qty.ai_plan_dto_value, 920, 'A3a the AI Plan DTO reads the earliest actionable window — 920');
// R6-R7-R1 §D — each reading is normalised to an ACTION STATE before anything is compared, because a
// stored 0 and an AI NO_ACTION are the same state and were being compared as numbers.
eq(A.suggested_qty.standing_authority_state, 'NO_ACTION', 'A3b0 the standing 0 is the NO_ACTION state');
eq(A.suggested_qty.ai_plan_dto_state, 'ACTION:920', 'A3b1 and the DTO reading is a genuine action');
eq(A.suggested_qty.readings_agree, false, 'A3b and on THIS row they genuinely do not agree');
eq(A.suggested_qty.divergence.kind, 'TWO_RULES_ONE_CELL',
  'A3b2 which is RECORDED as the page-level divergence it is, not refused');
eq(A.suggested_qty.ai_plan_dto_in_session_state, 'NOT_EVALUATED',
  'A3b3 while the IN-SESSION DTO is NOT_EVALUATED — a server census cannot see a browser\'s page state');
eq(A.current_run.calculation_status, 'READY', 'A3b4 and the run is named: status,');
eq(A.current_run.calculated_at, TS_GAP, 'A3b5 calculated_at,');
eq(A.current_run.calculation_run_id, 'GAP-INV-20260905-0300', 'A3b6 run id,');
ok(/FURTHEST cumulative window/.test(A.current_run.authority_rule), 'A3b7 and the rule itself');

// THE ACTUAL PRODUCTION SHAPE: every window a stored, finite 0. The two rules must now AGREE, and the
// defect this round closes is that they did not — because `0 === null` is false.
var A_LIVE = new World({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 } })
  .run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_LIVE.suggested_qty.standing_authority_state, 'NO_ACTION', 'A3c the live row reads NO_ACTION standing,');
eq(A_LIVE.suggested_qty.ai_plan_dto_state, 'NO_ACTION', 'A3c1 NO_ACTION on the DTO rule,');
eq(A_LIVE.suggested_qty.ai_plan_dto_value, null, 'A3c2 whose VALUE is null — a state, not a quantity');
eq(A_LIVE.suggested_qty.readings_agree, true, 'A3c3 and they AGREE, which is the §D fix');
eq(A_LIVE.suggested_qty.divergence, null, 'A3c4 with no divergence to record');
eq(A_LIVE.verdict, 'RECOMMENDATION_AUTHORITY_ESTABLISHED', 'A3c5 and the authority is established');
eq(A.recommendation_window.ai_plan_dto_window, 'D18', 'A3c naming the window the DTO chose');
var prov = A.disputed_value_provenance;
eq(prov.length, 2, 'A4 both disputed screen values are accounted for');
ok(prov[0].resolved && /AI_PLAN_RECOMMENDATION/.test(prov[0].reproduced_by.join('|')),
  'A4a 920 is reproduced by the AI Plan reading, by name');
ok(prov[1].resolved && /MATERIALIZED_SUGGESTED_QTY/.test(prov[1].reproduced_by.join('|')),
  'A4b 0 is reproduced by the materialized reading, by name');
// NEITHER number is adopted. The census reports the rules; it never publishes a single "the recommendation is".
ok(!Object.prototype.hasOwnProperty.call(A, 'recommendation'),
  'A5 the census publishes no single adopted "recommendation" field — that would be the guess §2 forbids');

// §2 items 2 and 3: the columns do not exist, and saying so is the answer.
eq(A.schema_absent_columns, ['calculation_run_id', 'formula_version'],
  'A6 the gap row carries NEITHER a run id NOR a formula version, reported as absent rather than null');
eq(A.calculation_run.stored_on_the_gap_row, false, 'A6a stated explicitly for the run id');
eq(A.calculation_run.job_run.run_id, 'GAP-INV-20260905-0300',
  'A6b and the run identity is read from the GAP job record, which is where it actually lives');
eq(A.formula_version.value_a_generation_would_stamp, 'WEEKLY_AI_PLAN_V1',
  'A6c the formula version a generation would stamp comes from the request constant');
eq(A.source_warehouse.stored_on_the_gap_row, false,
  'A7 and the gap row carries no source warehouse either — routing is Execution Plan authority');
eq(A.generation_state.calculation_status, 'READY', 'A8 the readiness state is reported verbatim');
eq(A.calculated_at, TS_GAP, 'A9 with the stamps the row actually holds');
ok(/d90_suggested_qty/.test(A.ui_authority.top_table_cell), 'A10 the UI authority names the exact field');
ok(/data-recommendation-source/.test(A.ui_authority.how_to_tell_them_apart_on_a_live_screen),
  'A10a and tells an operator how to read which authority a live screen used');
eq(A.integrity.duplicate_business_keys_in_table, 0, 'A12 no duplicate business keys');
eq(A.integrity.mixed_run_rows, false, 'A12a and no mixed-run rows');

// ---- the conflict cases that must STOP -------------------------------------------------------------------
var A_DUP = new World({ extraGap: [{ d18_suggested_qty: 555, calculated_at: 'Fri Sep 04 2026 03:00:00 GMT+0800 (Taiwan Standard Time)' }] })
  .run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_DUP.verdict, 'STOP_RECOMMENDATION_CONFLICT', 'A13 a duplicate row for the same key STOPS the round');
ok(failed(A_DUP).indexOf('no_duplicate_rows_for_this_business_key') !== -1, 'A13a naming the duplicate');
ok(failed(A_DUP).indexOf('no_mixed_run_rows_for_this_business_key') !== -1,
  'A13b and naming the mixed run separately, because two rows from ONE run is a different fault');

var A_STALE = new World({ gap: { calculation_status: 'BLOCKED', note: 'RECOMMENDATION_LINE_NOT_FOUND',
  d18_suggested_qty: '', d30_suggested_qty: '', d45_suggested_qty: '', d90_suggested_qty: '' } })
  .run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_STALE.verdict, 'STOP_RECOMMENDATION_CONFLICT', 'A14 a BLOCKED row cannot settle the authority');
eq(A_STALE.suggested_qty.standing_authority_value, null,
  'A14a and a BLOCKED row yields NULL, never 0 — missing is not zero');
eq(A_STALE.suggested_qty.ai_plan_dto_value, null, 'A14b on both readings');

var A_MISSING = new World({ dropGap: true }).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_MISSING.verdict, 'STOP_RECOMMENDATION_CONFLICT', 'A15 no row at all STOPS');
eq(A_MISSING.row_count, 0, 'A15a and says so');

// R6-R7-R1 §G — A PAST OBSERVATION THAT NO LONGER REPRODUCES IS HISTORY, NOT A BLOCKER.
//
// The first version STOPPED here, reasoning that a third source must be feeding the cell. A row recalculated
// since the screenshot explains it just as well, nothing readable can separate the two, and blocking on an
// unfalsifiable claim would make an old screenshot a permanent veto over an activation.
var A_THIRD = new World({ gap: { d18_gap_qty: 111, d18_suggested_qty: 111, d30_suggested_qty: 111,
  d45_suggested_qty: 111, d90_suggested_qty: 111 } }).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_THIRD.verdict, 'RECOMMENDATION_AUTHORITY_ESTABLISHED',
  'A16 today\'s row settles the authority even when neither past display value reproduces');
eq(A_THIRD.disputed_value_provenance.map(function (p) { return p.status; }),
  ['HISTORICAL_OR_SUPERSEDED_UNRESOLVED', 'HISTORICAL_OR_SUPERSEDED_UNRESOLVED'],
  'A16a and both are LABELLED historical rather than guessed at');
ok(A_THIRD.disputed_value_provenance.every(function (p) { return p.is_write_authority === false; }),
  'A16b neither is a write authority, which is the property that actually matters');
ok(A_THIRD.disputed_value_provenance.every(function (p) { return p.lineage_evidence.length === 0; }),
  'A16c and no lineage evidence is invented when none exists');
ok(!/third source/.test(A_THIRD.disputed_value_provenance[0].note.replace(/NOT treated as evidence[\s\S]*/, '')),
  'A16d the note does not assert a third source it cannot see');
// When a stored row DOES still carry the value, that is read-only lineage and it is reported.
var A_HIST = new World({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_suggested_qty: 0 },
  extraGap: [{ marketplace: 'Other', d18_suggested_qty: 920 }] })
  .run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_HIST.verdict, 'RECOMMENDATION_AUTHORITY_ESTABLISHED',
  'A16e a row for ANOTHER marketplace does not disturb this key\'s authority');
eq(A_HIST.row_count, 1, 'A16f because the key match is exact on all four axes');

// A CANONICAL ZERO. Every window a stored, finite 0 — both rules agree, and the round proceeds.
var A_ZERO = new World({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 } })
  .run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
eq(A_ZERO.suggested_qty.standing_authority_value, 0, 'A17 a canonical zero reads 0 on the standing authority');
eq(A_ZERO.suggested_qty.ai_plan_dto_value, null,
  'A17a and NO_ACTION on the DTO — no window is actionable, which is not the same as a zero quantity');

// ================================================================================================================
section('B — §4 the controlled AI Plan preflight');
// ================================================================================================================
var wB = new World();
var B = wB.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(failed(B), [], 'B1 the preflight passes every predicate');
// R6-R7-R1 §F — READY_NO_ACTION, because that is what the PRODUCTION path answers for this scope. The
// first version returned CONTROLLED_AI_PLAN_READY while the real handler returned STOP for the same rows,
// which is the worst failure mode a preflight has: certifying a run that cannot happen.
eq(B.verdict, 'READY_NO_ACTION', 'B1a and returns the verdict the production path proves');
eq(B.production_path.outcome, 'AI_PLAN_NO_ACTION', 'B1a1 the production outcome, by name');
eq(B.production_path.code, 'NO_REPLENISHMENT_REQUIRED', 'B1a2 with its formal code');
eq(B.production_path.reason, 'FULLY_COVERED_BY_ACTIVE_PLAN',
  'B1a3 and the reason: 520 already planned covers a recommendation of 0');
eq([B.production_path.recommended_qty, B.production_path.qualifying_planned_qty, B.production_path.residual_qty],
  [0, 520, 0], 'B1a4 recommended 0, qualifying planned 520, residual 0');
eq(B.parity.production_would_write, false, 'B1a5 so production would write nothing');
eq(wB.dbWrites(), 0, 'B1b having written nothing');
eq([B.db_writes, B.writer_calls, B.submit_calls, B.route_save_calls, B.writer_constructed],
  [0, 0, 0, 0, false], 'B1c and reporting the five zeroes §4 asks for');

eq(B.flag.value, false, 'B2 the flag is still false, which is what this round requires');
eq(B.allowlist.entries.length, 1, 'B2a the allowlist holds exactly one scope');
eq(B.allowlist.scope_is_listed, true, 'B2b and it is this one');
eq(B.current_manual_planned_total, 520, 'B3 the manual planned total is 520');
eq(B.before_counts, { visible_route_rows: 2, headers: 2, lines: 2, manual_planned_total: 520 },
  'B3a and the before shape is two headers, two lines, two rows');

// THE IDENTITY ARITHMETIC — the mechanism the whole isolation argument rests on.
eq(B.manual_route_snapshots.length, 2, 'B4 both manual routes are frozen');
eq(B.manual_route_snapshots.map(function (s) { return s.observed.recommendation_group_no; }), ['', ''],
  'B4a each carrying a BLANK recommendation_group_no');
eq(B.expected_ai_identities.length, 1, 'B5 one AI group would be proposed');
eq(B.expected_ai_identities[0].recommendation_group_no, '1', 'B5a carrying the ordinal 1');
ok(/\|1$/.test(B.expected_ai_identities[0].k4_group_key),
  'B5b so its identity key ENDS in that ordinal, which is the last dimension');
ok(B.expected_ai_identities[0].id_the_writer_would_mint !== A_HEADER
  && B.expected_ai_identities[0].id_the_writer_would_mint !== B_HEADER,
  'B5c and hashes to an id neither manual route holds');
eq(B.manual_route_snapshots.filter(function (s) {
  return s.observed.k4_group_key === B.expected_ai_identities[0].k4_group_key; }).length, 0,
  'B5c1 and to a GROUP KEY neither manual route holds, which is the comparison the resolver actually makes');
ok(/^SADH-K4-/.test(B.expected_ai_identities[0].id_the_writer_would_mint),
  'B5d in the K4 family, because production can store a canonical destination');
ok(has(B, 'no_proposed_ai_identity_equals_a_manual_route_identity'),
  'B5e and the preflight asserts the non-collision as its own predicate');

// The SAME route as Route A, differing ONLY in the ordinal. This is the case that would collide if the last
// dimension were dropped — and it must still not collide.
var wB2 = new World({ proposed: [{ group_no: '1', source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
  destination_type: 'MARKETPLACE', destination: 'Amazon', method: 'sea_express', last_mile: 'truck',
  line_count: 1, total_qty: 320 }] });
var B2 = wB2.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
ok(B2.expected_ai_identities[0].id_the_writer_would_mint !== A_HEADER,
  'B6 an AI group with Route A\'s EXACT route still resolves to a different id — the ordinal is the difference');
eq(failed(B2), [], 'B6a and the preflight still passes');
ok(B2.verdict === 'READY_NO_ACTION' || B2.verdict === 'CONTROLLED_AI_PLAN_READY',
  'B6a1 with a success verdict either way');

// The reconciliation gap, disclosed rather than smoothed over.
eq(B.expected_remaining_or_excess.server_side_reconciliation, 'NONE for these rows.',
  'B7 the preflight states plainly that no server-side reconciliation will happen');
ok(/aiplManualPrecedence_/.test(B.expected_remaining_or_excess.why),
  'B7a naming the rule that exists and explaining why it cannot fire');
ok(/PLUS/.test(B.expected_remaining_or_excess.why),
  'B7b and that the station total becomes the manual total plus the AI total');
eq(B.expected_after_counts.manual_planned_total_unchanged, 520,
  'B7c while the manual 520 itself is expected to be untouched');
eq(B.expected_after_counts.headers, 3, 'B7d three headers after, not two replaced by one');

// The zero-recommendation classification, and the three shapes it must tell apart.
eq(B.zero_recommendation_classification.kind, 'NOT_ZERO_AT_EVERY_HORIZON',
  'B8 d90 zero with an actionable D18 is NOT a zero recommendation');
var B_ZERO = new World({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 },
  proposed: [] }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_ZERO.zero_recommendation_classification.kind, 'CORRECT_NO_ACTION',
  'B8a every window a stored finite 0 IS a correct no-action');
eq(B_ZERO.verdict, 'READY_NO_ACTION', 'B8b which is a READY, not a failure');
eq(B_ZERO.production_path.reason, 'VALID_ZERO_RECOMMENDATION',
  'B8b1 and the reason is the valid zero itself, not the manual plan');
eq(B_ZERO.expected_after_counts.headers, 2, 'B8c expecting no new header at all');
ok(/NO_ACTION must produce no empty header/.test(B_ZERO.expected_after_counts.note),
  'B8d and saying that no empty shell may be created to represent it');
var B_STALE = new World({ gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_STALE.zero_recommendation_classification.kind, 'STALE_OR_MISSING',
  'B8e a BLOCKED row is stale-or-missing, never a zero');
eq(B_STALE.verdict, 'STOP', 'B8f and it STOPS');
var B_NOROW = new World({ dropGap: true }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_NOROW.zero_recommendation_classification.kind, 'STALE_OR_MISSING', 'B8g as does no row at all');

// manual 520 GREATER, LESS and EQUAL to the recommendation — the strip's third column must name itself.
function reconOf(d90) {
  return new World({ gap: { d18_gap_qty: d90, d18_suggested_qty: d90, d30_suggested_qty: d90,
    d45_suggested_qty: d90, d90_gap_qty: d90, d90_suggested_qty: d90 } })
    .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res.expected_remaining_or_excess.strip_would_show;
}
eq(reconOf(920), 'Remaining 400', 'B9 recommendation above the plan is REMAINING');
eq(reconOf(300), 'Excess 220', 'B9a recommendation below the plan is EXCESS, never a negative remaining');
eq(reconOf(520), 'Remaining 0', 'B9b and an exact match is a remaining of zero, which is a real number');

// ---- the refusals ----------------------------------------------------------------------------------------
var B_FLAG = new World({ flag: true }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_FLAG.verdict, 'STOP', 'B10 a flag that is already TRUE stops this round — activation is a later decision');
var B_ALLOW = new World({ allowlist: [{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },
  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'OTHER-SKU' }] })
  .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_ALLOW.verdict, 'STOP', 'B11 a widened allowlist stops it — "controlled" means one scope');
var B_OUT = new World({ allowlist: [{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'OTHER-SKU' }] })
  .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
ok(failed(B_OUT).indexOf('allowlist_entry_is_this_scope') !== -1,
  'B11a and a list that names a DIFFERENT scope fails by name, not by count');
var B_MIX = new World({ dropLifecycle: true }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_MIX.verdict, 'STOP', 'B12 a project missing the lifecycle module is a MIXED DEPLOYMENT and stops');
ok(failed(B_MIX).indexOf('ai_plan_lifecycle_module_is_present') !== -1, 'B12a naming the missing module');

// A manual route that has been re-owned by a run is not a manual route any more.
var B_OWNED = new World({ aHeader: { generation_type: 'system_generated', generation_run_id: 'AIPLAN-DEADBEEF' } })
  .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_OWNED.verdict, 'STOP', 'B13 a manual route carrying a generation run id stops the preflight');
ok(failed(B_OWNED).indexOf('route_A_is_classified_MANUAL_by_the_lifecycle_authority') !== -1,
  'B13a because the lifecycle would EXPIRE it rather than preserve it');
// And the classifier is the real one: a blank generation_type with a run id is still AI.
var aipl = new World().ctx;
ok(vm.runInContext('aiplIsAiGenerated_({ generation_type: "", generation_run_id: "R1" })', aipl) === true,
  'B13b the real classifier reads a bare run id as AI, which is why the preflight checks both fields');
ok(vm.runInContext('aiplIsAiGenerated_({ generation_type: "user_created", generation_run_id: "R1" })', aipl) === false,
  'B13c and an explicit user_created marker wins over one');

var B_MOVED = new World({ aHeader: { draft_version: '5' } }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
eq(B_MOVED.verdict, 'STOP', 'B14 a Route A that has moved since §0 stops the preflight');
var B_TOTAL = new World({ aLine: { planned_qty: '999' } }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
ok(failed(B_TOTAL).indexOf('current_manual_planned_total_is_520') !== -1,
  'B14a and a plan total that is not 520 fails by name');

// The exact surface comes from the SERVER's own manifest, not from a second copy here.
ok(/SERVER/.test(B.allowed_tables.source), 'B15 the write surface is read from 61_\'s own manifest');
eq(B.allowed_tables.written, ['shipping_allocation_drafts', 'shipping_allocation_draft_lines'],
  'B15a which names exactly two writable tables');
ok(B.allowed_tables.guaranteed_zero_mutation.indexOf('reservations') !== -1
  && B.allowed_tables.guaranteed_zero_mutation.indexOf('shipping_plans') !== -1,
  'B15b and lists reservations and shipping_plans among the guaranteed-zero tables');
ok(/no UPDATE, no expiry, no cancellation, no re-ownership/.test(B.forbidden_mutations.manual_rows),
  'B16 the forbidden list spells out all four ways a manual row could be lost');
ok(B.forbidden_mutations.manual_rows.indexOf(A_HEADER) !== -1
  && B.forbidden_mutations.manual_rows.indexOf(B_HEADER) !== -1, 'B16a naming both rows');
ok(/no Submit/.test(B.forbidden_mutations.lifecycle), 'B16b and that Submit is not part of a generation');
ok(/DO NOT press Generate a second time/.test(B.idempotency_contract.second_click),
  'B17 the idempotency contract forbids testing a replay by pressing again');
ok(/NEVER auto-resent/.test(B.ack_unknown_contract.rule), 'B18 ACK_UNKNOWN is never auto-resent');
ok(/do NOT press Generate again/.test(B.ack_unknown_contract.on_ack_unknown), 'B18a and says so operationally');
ok(/MISSING_OPTIMISTIC_TOKEN/.test(B.optimistic_concurrency_contract.manual_save),
  'B19 the optimistic contract carries R6-R6-R4-R2\'s refusal forward');
ok(/DONE GAP-INV run/.test(B.lineage_policy.calculation_run_id),
  'B20 and the lineage policy names the only acceptable run');
eq(B.lineage_policy.resolved_now.run_id, 'GAP-INV-20260905-0300', 'B20a resolved through 61_\'s own resolver');

// ================================================================================================================
section('C — §6 the readback contract');
// ================================================================================================================
// Nothing written, and nothing should have been: the NO_ACTION verdict.
var C_NONE = new World().run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_NONE.verdict, 'CONTROLLED_AI_PLAN_NO_ACTION_CONFIRMED',
  'C1 no AI rows and no failed predicate is a CONFIRMED no-action, not a missing result');
eq(failed(C_NONE), [], 'C1a with every manual-row predicate passing');
eq(C_NONE.counts.manual_rows, 2, 'C1b two manual rows');
eq(C_NONE.counts.ai_rows, 0, 'C1c and zero AI rows');

// One AI header written, correctly owned.
var AI_H = 'SADH-K4-AAAA1111', AI_L = 'SADL-K2-BBBB2222';
function withAi(over) {
  var o = { extraHeaders: [Object.assign({ allocation_draft_id: AI_H, destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
      recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }, (over || {}).aiHeader || {})],
    extraLines: [Object.assign({ allocation_draft_line_id: AI_L, allocation_draft_id: AI_H,
      planned_qty: '920', updated_at: TS_A }, (over || {}).aiLine || {})] };
  Object.keys(over || {}).forEach(function (k) { if (k !== 'aiHeader' && k !== 'aiLine') o[k] = over[k]; });
  return new World(o);
}
var C_OK = withAi().run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(failed(C_OK), [], 'C2 an AI header alongside the two manual rows passes every predicate');
eq(C_OK.verdict, 'CONTROLLED_AI_PLAN_WRITE_CONFIRMED', 'C2a and confirms the write');
eq(C_OK.counts, { visible_route_rows: 3, manual_rows: 2, ai_rows: 1, headers: 3, lines: 3,
  station_plan_total: 1440, manual_planned_total: 520, ai_units: 920 },
  'C2b with exact counts on both sides of the boundary');
eq(C_OK.ai_rows_observed[0].generation_run_id, 'AIPLAN-1234ABCD', 'C2c and the run that owns the new row');

// ---- every way a manual row could be lost, one at a time --------------------------------------------------
function rb(over) { return withAi(over).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res; }
var C_VER = rb({ aHeader: { draft_version: '5' } });
eq(C_VER.verdict, 'STOP', 'C3 Route A at a moved version STOPS');
ok(failed(C_VER).indexOf('route_A_draft_version_did_not_move') !== -1,
  'C3a and the version is the proof, because the writer increments it on every UPDATE');
var C_LM = rb({ bHeader: { recommended_last_mile_delivery: 'parcel' } });
eq(C_LM.verdict, 'STOP', 'C4 Route B\'s last mile changing STOPS — the 2026-09-06 incident, in the other round');
var C_QTY = rb({ aLine: { planned_qty: '1' } });
ok(failed(C_QTY).indexOf('route_A_quantity_unchanged') !== -1, 'C5 a rewritten quantity fails by name');
var C_EXP = rb({ bHeader: { status: 'expired' } });
eq(C_EXP.verdict, 'STOP', 'C6 a manual row expired by the run STOPS');
ok(failed(C_EXP).indexOf('route_B_was_not_expired_or_cancelled') !== -1, 'C6a naming the lifecycle change');
var C_OWN = rb({ aHeader: { generation_type: 'system_generated', generation_run_id: 'AIPLAN-1234ABCD' } });
eq(C_OWN.verdict, 'STOP', 'C7 a manual row ADOPTED by the run STOPS');
ok(failed(C_OWN).indexOf('route_A_was_not_re_owned_by_a_run') !== -1,
  'C7a which no value comparison would have caught — every field it holds is still correct');
var C_GONE = rb({ dropB: true });
eq(C_GONE.verdict, 'STOP', 'C8 a manual row that disappeared STOPS');

// ---- every way the AI side could be wrong ------------------------------------------------------------------
var C_UNOWNED = rb({ aiHeader: { generation_type: 'user_created', generation_run_id: '' } });
eq(C_UNOWNED.verdict, 'STOP', 'C9 a NEW row with no run id is an unexplained write, not an AI plan output');
ok(failed(C_UNOWNED).indexOf('every_new_row_is_ai_owned') !== -1, 'C9a named as such');
var C_TWICE = withAi({ extraHeaders: null }).ctx ? null : null;
var C_TWO_RUNS = new World({
  extraHeaders: [
    { allocation_draft_id: AI_H, destination_marketplace: 'Amazon', recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: 'truck', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A },
    { allocation_draft_id: 'SADH-K4-CCCC3333', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'air', recommended_last_mile_delivery: 'truck', recommendation_group_no: '2',
      generation_type: 'system_generated', generation_run_id: 'AIPLAN-99999999', draft_version: '1', updated_at: TS_A }],
  extraLines: [
    { allocation_draft_line_id: AI_L, allocation_draft_id: AI_H, planned_qty: '920', updated_at: TS_A },
    { allocation_draft_line_id: 'SADL-K2-DDDD4444', allocation_draft_id: 'SADH-K4-CCCC3333', planned_qty: '920', updated_at: TS_A }]
}).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_TWO_RUNS.verdict, 'STOP', 'C10 two generation run ids among the new rows means the button was pressed twice');
ok(failed(C_TWO_RUNS).indexOf('new_rows_belong_to_at_most_one_generation_run') !== -1, 'C10a named exactly that way');
var C_EMPTY = rb({ aiLine: { planned_qty: '0' } });
eq(C_EMPTY.verdict, 'STOP', 'C11 a zero-quantity AI row is an empty shell and must not exist');
ok(failed(C_EMPTY).indexOf('no_zero_quantity_ai_row_was_created') !== -1, 'C11a named as such');
// A partial write: the header landed and its line did not. The station total then disagrees with the row set.
var C_PARTIAL = new World({ extraHeaders: [{ allocation_draft_id: AI_H, destination_marketplace: 'Amazon',
  recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
  recommendation_group_no: '1', generation_type: 'system_generated', generation_run_id: 'AIPLAN-1234ABCD',
  draft_version: '1', updated_at: TS_A }] }).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_PARTIAL.counts.ai_rows, 0, 'C12 a header with no line contributes no visible row');
eq(C_PARTIAL.counts.headers, 2, 'C12a and no SKU-contributing header either — the partial write is visible as a gap');

// A REPLAY. The same run pressing twice would land two rows on ONE deterministic identity, which is the
// thing the idempotency contract exists to prevent — and it is a DIFFERENT fault from two run ids.
var C_DUP_ID = withAi({ extraHeaders: [
    { allocation_draft_id: AI_H, destination_marketplace: 'Amazon', recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: 'truck', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A },
    { allocation_draft_id: 'SADH-K4-DUPE0001', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
      recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }],
  extraLines: [
    { allocation_draft_line_id: AI_L, allocation_draft_id: AI_H, planned_qty: '920', updated_at: TS_A },
    { allocation_draft_line_id: 'SADL-K2-DUPE0002', allocation_draft_id: 'SADH-K4-DUPE0001', planned_qty: '920', updated_at: TS_A }]
}).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_DUP_ID.verdict, 'STOP', 'C17 two rows on ONE deterministic identity STOPS — a replay was not idempotent');
ok(failed(C_DUP_ID).indexOf('no_duplicate_ai_identities') !== -1,
  'C17a named as a duplicate identity, which is a different fault from two run ids');
ok(failed(C_DUP_ID).indexOf('new_rows_belong_to_at_most_one_generation_run') === -1,
  'C17b and the run-count gate does NOT fire, because one run wrote both');

// THE FIELDS THAT MOVED, NAMED. An empty list means nothing moved; it is filled on every run, so it can
// never be read as 'nothing was checked'.
eq(C_OK.changed_fields, [], 'C18 a clean readback names no changed field');
eq(rb({ aHeader: { draft_version: '5' } }).changed_fields,
  [{ route: 'A', field: 'draft_version', was: '4', now: '5' }],
  'C18a and a moved version is reported as the COLUMN it is, not only as a failed claim');
eq(rb({ bHeader: { recommended_last_mile_delivery: 'parcel' } }).changed_fields,
  [{ route: 'B', field: 'last_mile_delivery', was: '', now: 'parcel' }],
  'C18b naming the exact column the 2026-09-06 incident wrote');
eq(rb({ aHeader: { generation_type: 'system_generated', generation_run_id: 'AIPLAN-1234ABCD' } }).changed_fields,
  [{ route: 'A', field: 'generation_run_id', was: '', now: 'AIPLAN-1234ABCD' }],
  'C18c and an adoption is a changed field too, even though every business value is still correct');

// SCOPE ISOLATION. A row for a different SKU, and one for a different company, must not enter these counts.
var C_SCOPE = withAi({ extraHeaders: [
    { allocation_draft_id: AI_H, destination_marketplace: 'Amazon', recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: 'truck', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A },
    { allocation_draft_id: 'SADH-K4-EEEE5555', company: 'OtherCo', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'air', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }],
  extraLines: [
    { allocation_draft_line_id: AI_L, allocation_draft_id: AI_H, planned_qty: '920', updated_at: TS_A },
    { allocation_draft_line_id: 'SADL-K2-FFFF6666', allocation_draft_id: 'SADH-K4-EEEE5555', planned_qty: '77', updated_at: TS_A }]
}).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_SCOPE.counts.ai_rows, 1, 'C13 another company\'s row is not counted as this activation\'s output');
eq(C_SCOPE.verdict, 'CONTROLLED_AI_PLAN_WRITE_CONFIRMED', 'C13a and does not fail the readback');
var C_SKU = withAi({ extraHeaders: [
    { allocation_draft_id: AI_H, destination_marketplace: 'Amazon', recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: 'truck', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }],
  extraLines: [
    { allocation_draft_line_id: AI_L, allocation_draft_id: AI_H, planned_qty: '920', updated_at: TS_A },
    { allocation_draft_line_id: 'SADL-K2-99997777', allocation_draft_id: AI_H, sku: 'OTHER-SKU', planned_qty: '50', updated_at: TS_A }]
}).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
eq(C_SKU.counts.ai_units, 920, 'C14 another SKU\'s line under the same header does not enter this SKU\'s units');

// The total is checked as arithmetic, not as a row-by-row scan — a rewritten quantity that kept the row count
// intact is exactly what a per-row comparison would miss on its own.
ok(has(C_OK, 'station_total_is_the_manual_total_plus_the_ai_units'),
  'C15 the readback asserts the total as manual + AI, as its own predicate');
eq(C_OK.db_writes, 0, 'C16 and the readback itself wrote nothing');
eq(C_OK.writer_constructed, false, 'C16a constructing no writer');

// ================================================================================================================
section('D — §3 the trace, pinned to the code that makes each claim true');
// ================================================================================================================
// The lifecycle NEVER expires a manual row, and it says so in its own reason code.
ok(/MANUAL_SOURCE/.test(G69L) && /a manual route is never replaced by a generation run/.test(G69L),
  'D1 aiplExpirationCandidates_ preserves a manual row by name');
var d1 = new World().ctx;
var D1 = vm.runInContext('JSON.stringify(aiplExpirationCandidates_(['
  + JSON.stringify(headerRow({ allocation_draft_id: A_HEADER, status: 'draft' })) + '], '
  + '{ company: "ResUS", country: "US", marketplace: "Amazon", planning_cycle: "", '
  + 'source_page: "inventory_replenishment", generation_run_id: "AIPLAN-1", committed_ids: [] }))', d1);
var D1o = JSON.parse(D1);
eq(D1o.expire_count, 0, 'D1a the REAL rule expires zero manual rows');
eq(D1o.preserved[0].reason, 'MANUAL_SOURCE', 'D1b preserving it for the stated reason');
// And it DOES expire a superseded AI row, so the rule above is a distinction and not a no-op.
var D1b = JSON.parse(vm.runInContext('JSON.stringify(aiplExpirationCandidates_(['
  + JSON.stringify(headerRow({ allocation_draft_id: 'SADH-K4-OLD', status: 'draft',
      generation_type: 'system_generated', generation_run_id: 'AIPLAN-0' })) + '], '
  + '{ company: "ResUS", country: "US", marketplace: "Amazon", planning_cycle: "", '
  + 'source_page: "inventory_replenishment", generation_run_id: "AIPLAN-1", committed_ids: [] }))', d1));
eq(D1b.expire_count, 1, 'D1c while a superseded AI draft IS expired — the rule discriminates');

// The suppression that exists but cannot fire here, demonstrated rather than asserted.
var D2 = JSON.parse(vm.runInContext('JSON.stringify(aiplManualPrecedence_(['
  + JSON.stringify(PROD_A_H) + '], [{ identity_key: ricK4GroupKey_(' + JSON.stringify(PROD_A_H) + ') }], '
  + 'ricK4GroupKey_))', d1));
eq(D2[0].decision, 'SUPPRESSED_BY_ACTIVE_MANUAL_DRAFT',
  'D2 when the identities DO meet, the manual decision suppresses the AI draft');
var A_WITH_ORDINAL = JSON.parse(JSON.stringify(PROD_A_H)); A_WITH_ORDINAL.recommendation_group_no = '1';
var D2b = JSON.parse(vm.runInContext('JSON.stringify(aiplManualPrecedence_(['
  + JSON.stringify(PROD_A_H) + '], [{ identity_key: ricK4GroupKey_(' + JSON.stringify(A_WITH_ORDINAL) + ') }], '
  + 'ricK4GroupKey_))', d1));
eq(D2b[0].decision, 'PROCEED',
  'D2a and with the ordinal set — which is what every generated group carries — it does NOT, so the AI writes'
  + ' alongside the manual 520 rather than reconciling with it');

// The last dimension of both identity keys is the ordinal.
ok(/s\(h\.recommendation_group_no\)\]\.join\('\|'\)/.test(G69), 'D3 recommendation_group_no is K4\'s last dimension');
ok(/s\(h\.recommendation_group_no\)\]\.join\('\|'\)/.test(G16), 'D3a and K2\'s');
// The page never sends one, which is why a manual row's is blank.
ok(!/recommendation_group_no\s*:/.test(PAGE),
  'D4 the Execution Plan page never sets recommendation_group_no on a payload');
ok(/recommendation_group_no: String\(\(body && body\.recommendation_group_no\) \|\| ''\)/.test(G16),
  'D4a and 16_ defaults it to blank');
// KMWRR assigns it. One authority, and it is an ordinal.
ok(/recommendation_group_no: String\(groupNo\)/.test(read('assets/js/core/supply-planning-weekly-route-derivation.js')),
  'D5 the route deriver assigns every generated group a deterministic ordinal');

// The tables an AI generation writes, and the ones it never touches.
ok(/tables_written: \['shipping_allocation_drafts', 'shipping_allocation_draft_lines'\]/.test(G61),
  'D6 61_ declares exactly two writable tables');
ok(/reservation_expected: false/.test(G61) && /submit_expected: false/.test(G61),
  'D6a no reservation and no submit');
ok(/An AI Plan draft reserves NOTHING/.test(G61), 'D6b stated in the manifest, not only in a test');
// The only path from a plan to a write, and the gate that sits before it.
ok(/handleUpsertShippingAllocationDraftAtomic_ \(16_shipping_allocation_handlers\.gs\) — the ONLY /.test(G61)
  || /the ONLY '\s*\+ 'path to a write/.test(G61),
  'D7 the atomic writer is named as the only path to a write');
ok(/PASS 1: compute every group\. ZERO WRITES\./.test(G61) && /PASS 2: write\./.test(G61),
  'D7a and generation is split into a compute pass and a write pass, so a gate refusal has no path to a write');
ok(/AI_PLAN_LIFECYCLE_SCHEMA_NOT_READY/.test(G61) && /zero_write: true/.test(G61),
  'D8 a missing lifecycle module is a typed zero-write refusal');
// A PARTIAL WRITE IS REFUSED, not merely visible afterwards. C12 shows what a half-landed write looks like
// from the outside; this is the rule that stops one being produced.
ok(/one lock, one header \+ its lines, all or nothing/.test(G61),
  'D8a the write handler is declared all-or-nothing under one lock');
ok(/sadVerifyDraftLines_/.test(G16) && /sadPreflightLineBatch_/.test(G16),
  'D8b and the writer preflights its line batch and verifies it after, rather than trusting the loop');
// The AI intent resolves its identity and may never name one.
ok(/UPSERT_AI_GENERATED_K2_ROUTE resolves its own deterministic K2 identity and must not name an allocation_draft_id/.test(G16),
  'D9 an AI upsert may not point itself at an arbitrary row');
ok(/AI_ROUTE_INTENT_EVIDENCE_INSUFFICIENT/.test(G16), 'D9a and arrives with complete generation evidence or not at all');
// The AI intent is server-owned: a browser cannot ask for it.
var d9 = new World().ctx;
ok(vm.runInContext('SAD_CLIENT_GRANTABLE_INTENTS_[SAD_AI_K2_INTENT_] !== 1', d9),
  'D10 the AI intent is NOT client-grantable — a browser cannot request it');
// Generate does not imply Submit, and Submit does not imply Generate.
ok(/renderReplenishment\(\);\s*\/\/ re-render surfaces the Recommended Action block \(does NOT run Submit Plan\)/.test(PAGE),
  'D11 the AI Plan click states in the code that it does not run Submit');
ok(!/handleReplenAiPlan|generateWeeklyAiPlanDraft/.test(
  (function () { var i = PAGE.indexOf('function handleSubmitPlan'); return i < 0 ? '' : PAGE.slice(i, i + 6000); })()),
  'D12 and Submit never calls the generator, so neither implies the other');

// ================================================================================================================
section('E — §0 the historical record, and what it must not claim');
// ================================================================================================================
var E = new World().run('RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST').res;
eq(E.verdict, 'STAGE_TWO_EXECUTED_AND_CONFIRMED', 'E1 stage two is recorded as executed, not as awaiting permission');
eq([E.authorized, E.executed, E.readback_confirmed], [true, true, true], 'E1a all three facts recorded');
eq(E.self_authorizing, false, 'E1b while the file still says it authorized nothing itself');
eq(E.outcome.proven, ['MANUAL_ROUTE_SAVE_ROW_ISOLATION', 'OPTIMISTIC_CONCURRENCY_TOKEN',
  'ROUTE_B_COLLATERAL_WRITE_RESOLVED', 'ROUTE_A_RESTORED'], 'E1c and names the four proven properties');
eq(E.outcome.stage_one.expected_draft_version_sent, null,
  'E1d recording that stage one carried NO optimistic token — the defect, not a footnote');
eq(E.outcome.stage_two.expected_draft_version_sent, '3', 'E1e and that stage two carried one');
eq(E.db_writes, 0, 'E2 recording it wrote nothing');
ok(!/authorized: false/.test(extractFn(CENSUS, 'RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST')),
  'E2a and the literal false is gone from the manifest');
// The readiness that is now closed says so instead of silently failing.
var E_OLD = new World().run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
ok(/HAS BEEN EXECUTED/.test(E_OLD.stage_two),
  'E3 the R6-R6-R4 readiness now says stage two has happened rather than offering to gate it');
eq(E_OLD.stage_two_authorized, true, 'E3a its stage_two_authorized is no longer a constant false');
eq(E_OLD.stage_two_authorized_by_this_file, false, 'E3b while the file\'s own authority stays false');
eq(E_OLD.verdict, 'STOP',
  'E3c and it STOPS against today\'s database, because its frozen BEFORE describes a moment that has passed');

// ================================================================================================================
section('F — read-only, un-aimable, and released');
// ================================================================================================================
var R7_ENTRIES = ['RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS', 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT',
  'RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST', 'RUN_R6R7_CONTROLLED_AI_PLAN_READBACK'];
R7_ENTRIES.forEach(function (name) {
  var src = extractFn(CENSUS, name);
  eq(new RegExp('function ' + name + '\\s*\\(\\s*\\)').test(src), true, 'F1 ' + name + ' takes no arguments');
  ok(!/setValue|setValues|appendRow|deleteRow|insertRow|\.clear\(|SpreadsheetApp\.flush|DriveApp|MailApp/.test(src),
    'F1a ' + name + ' contains no write call of any kind');
  // A CALL, not a mention. The preflight NAMES the atomic writer when it reports which handler owns the
  // write surface — which is the opposite of reaching for one — so the check is for an invocation.
  ok(!/(weeklyAiPlanPersistenceDeps_|weeklyAiPlanGenerateK2_|handleUpsertShippingAllocationDraftAtomic_)\s*\(/.test(src),
    'F1b ' + name + ' never CALLS a writer or the generation write pass');
  ok(!/'ResUS'|"ResUS"|'CO1100-R'|"CO1100-R"/.test(src),
    'F1c ' + name + ' hard-codes no scope of its own — it inherits the one constant');
});
// Every R6-R7 run really does write nothing, measured on the double rather than read off its own report.
var wF = new World();
R7_ENTRIES.forEach(function (n) { wF.run(n); });
eq(wF.dbWrites(), 0, 'F2 four entry points, zero cells touched');

// The entry-point allowlist is the one authority on what the editor can run.
ok(R7_ENTRIES.every(function (n) { return E3SUITE.indexOf("'" + n + "'") !== -1; }),
  'F3 all four are declared in the entry-point allowlist');
// And that list is compared SORTED, so their placement has to be right.
var listed = (function () {
  var i = E3SUITE.indexOf('var ALLOWED_ENTRY_POINTS = ');
  var j = E3SUITE.indexOf('];', i);
  // Entry-point names only. The looser pattern also matched a lone R out of an apostrophe in the comments
  // between the entries, which sorts before everything and made the list look unsorted.
  return (E3SUITE.slice(i, j).match(/'((?:RUN|TEMP)_[A-Z0-9_]+)'/g) || []).map(function (s) { return s.slice(1, -1); });
})();
eq(listed.slice().sort(), listed, 'F3a and the list is in sorted order, which is how it is compared');

eq(vm.runInContext('TEMP_E3_CENSUS_BUILD_', new World().ctx), STAMP, 'F4 the census build stamp moved with the file');
ok(RO.OWNER_STAMPS.indexOf(STAMP) === RO.OWNER_STAMPS.length - 1,
  'F4a and this round is the newest entry in the release order');
// No frontend file changed this round, so no cache token may have been rotated for it.
ok(RO.ROUND_TOKENS.indexOf('fc1be3r4a2r1r6r7') === -1,
  'F5 no cache token was minted — this round changes no browser file, and a rotated token would force a'
  + ' download that carries nothing new');

// ================================================================================================================
section('H — §B/§C/§E the production state contract and the residual rule');
// ================================================================================================================
// Everything below calls 61_'s OWN functions, loaded into the world beside the census. A second copy of the
// rules in this file would agree with itself and prove nothing about what production does.
function P61(over) {
  var w = new World(over || {});
  var cyc = vm.runInContext('gapCalcResolveContext_().planningCycle', w.ctx);
  var scope = { company: 'ResUS', country: 'US', marketplace: 'Amazon', planningCycle: cyc };
  var js = JSON.stringify(scope);
  var can = vm.runInContext('weeklyAiPlanCanonicalDemand_(SpreadsheetApp.openById("x"), ' + js + ', null)', w.ctx);
  vm.runInContext('var __scope = ' + js + '; var __can = ' + JSON.stringify(can) + ';', w.ctx);
  var out = vm.runInContext('(function () {'
    + ' var t = weeklyAiPlanTargetScopes_(__scope, __scope.marketplace);'
    + ' var rs = weeklyAiPlanRecommendationState_(__can, t);'
    + ' var pl = weeklyAiPlanQualifyingPlannedQty_(SpreadsheetApp.openById("x"), __scope);'
    + ' var d = weeklyAiPlanNoActionDecision_(rs, pl);'
    + ' return { canonical_ok: __can.ok, target: t, state: rs, planned: pl, decision: d,'
    + '   response: d.noAction ? weeklyAiPlanNoActionResponse_(d, { planning_cycle: __scope.planningCycle,'
    + '     scope: __scope, site_count: 0 }) : null }; })()', w.ctx);
  out.__world = w;
  return out;
}

// ---- H1. READY + all-zero -> AI_PLAN_NO_ACTION, zero writes --------------------------------------------
var H1 = P61({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 } });
eq(H1.state.state, 'VALID_ZERO_RECOMMENDATION', 'H1  READY with every window a stored finite 0 is a VALID ZERO');
eq(H1.decision.noAction, true, 'H1a which is a no-action');
eq(H1.decision.reason, 'VALID_ZERO_RECOMMENDATION', 'H1b for that reason, not because of the manual plan');
eq(H1.response.success, true, 'H1c the production response is a typed SUCCESS');
eq(H1.response.data.outcome, 'AI_PLAN_NO_ACTION', 'H1d carrying the formal outcome name');
eq(H1.response.data.code, 'NO_REPLENISHMENT_REQUIRED', 'H1e and the existing equivalent code');
eq([H1.response.data.recommended_qty, H1.response.data.residual_qty], [0, 0], 'H1f recommended 0, residual 0');
eq([H1.response.data.created_headers, H1.response.data.updated_headers, H1.response.data.created_lines,
    H1.response.data.updated_lines, H1.response.data.cancelled_headers, H1.response.data.cancelled_lines],
  [0, 0, 0, 0, 0, 0], 'H1g every mutation counter explicitly zero');
eq([H1.response.data.db_writes, H1.response.data.writer_reached, H1.response.data.route_count],
  [0, false, 0], 'H1h zero writes, the writer not reached, no route');
eq(H1.response.data.routes, [], 'H1i and no empty route was created to represent nothing');
// The page's existing zero-result classifier must still recognise it, or a correct finish is presented as
// a generic failure — which is the whole defect in a new place.
eq([H1.response.data.zero_result, H1.response.data.job_status, H1.response.data.status],
  [true, 'NO_DEMAND', 'COMPLETED'], 'H1j and the three keys the shipped page classifies a zero result from');
ok(/zero_result === true|job_status \|\| ''\) === 'NO_DEMAND'/.test(PAGE)
  || /d.zero_result === true/.test(PAGE), 'H1k which the page really does read');
ok(H1.__world.dbWrites() === 0, 'H1l and nothing was written to reach any of it');

// ---- H2. PENDING / NONE / missing / stale -> STOP, never a zero ----------------------------------------
var H2a = P61({ gap: { calculation_status: 'BLOCKED', note: 'RECOMMENDATION_LINE_NOT_FOUND',
  d18_suggested_qty: '', d30_suggested_qty: '', d45_suggested_qty: '', d90_suggested_qty: '' } });
eq(H2a.state.state, 'MISSING_RECOMMENDATION', 'H2  a BLOCKED row is MISSING, never a zero');
eq(H2a.decision.noAction, false, 'H2a and never a no-action');
eq(H2a.decision.reason, 'MISSING_RECOMMENDATION', 'H2b reported as such');
eq(H2a.state.per_scope, [], 'H2c a date with nothing READY on it is refused before any scope is read,');
ok((H2a.state.missing_reasons[0] || {}).reason === 'CANONICAL_DEMAND_UNAVAILABLE',
  'H2c1 and the reason names the snapshot rather than the scope');
// The per-scope classifier itself, on a date the freshness authority accepts because ANOTHER row on it is
// READY. This is the shape where one SKU is blocked and the rest of the run is fine.
var H2aa = P61({ gap: { calculation_status: 'BLOCKED', note: 'RECOMMENDATION_LINE_NOT_FOUND',
    d18_suggested_qty: '', d30_suggested_qty: '', d45_suggested_qty: '', d90_suggested_qty: '' },
  extraGap: [{ sku: 'OTHER-SKU', d18_suggested_qty: 0, d30_suggested_qty: 0, d45_suggested_qty: 0,
    d90_suggested_qty: 0 }] });
eq(H2aa.canonical_ok, true, 'H2c2 one READY row makes the date usable,');
eq(H2aa.state.state, 'MISSING_RECOMMENDATION', 'H2c3 and THIS key is still MISSING,');
ok(/^NOT_READY:/.test(H2aa.state.per_scope[0].reason), 'H2c4 naming the status it found');
eq(H2aa.decision.noAction, false, 'H2c5 so one blocked SKU is never answered as a no-action');
var H2b = P61({ gap: { calculation_status: 'READY', d90_suggested_qty: '' } });
eq(H2b.state.state, 'MISSING_RECOMMENDATION', 'H2d a READY row with a BLANK window is still MISSING');
eq(H2b.state.per_scope[0].reason, 'WINDOW_VALUE_MISSING:D90', 'H2e naming the exact window');
eq(H2b.state.per_scope[0].windows.D90, null, 'H2f whose value stayed null and was never coerced to 0');
var H2c = P61({ dropGap: true });
eq(H2c.state.state, 'MISSING_RECOMMENDATION', 'H2g an EMPTY table is MISSING');
eq(H2c.decision.noAction, false, 'H2g1 and never a no-action');
// THIS key absent while the snapshot itself is usable — the shape where a SKU has simply not been
// materialized, which is exactly what must not be read as 'it needs nothing'.
var H2cc = P61({ dropGap: true, extraGap: [{ sku: 'OTHER-SKU', d18_suggested_qty: 0, d30_suggested_qty: 0,
  d45_suggested_qty: 0, d90_suggested_qty: 0 }] });
eq(H2cc.canonical_ok, true, 'H2h the snapshot is usable,');
eq(H2cc.state.per_scope[0].reason, 'NO_ROW_AT_THE_ACCEPTED_DATE', 'H2h1 and the missing key is named');
eq(H2cc.decision.noAction, false, 'H2h2 a SKU nobody materialized is not a SKU that needs nothing');
var H2d = P61({ gap: { calculation_date: GAP_YESTERDAY } });
eq(H2d.state.state, 'MISSING_RECOMMENDATION', 'H2i a STALE snapshot is MISSING, not a zero');
eq(H2d.decision.noAction, false, 'H2i1 and never a no-action');
var H2e = P61({ extraGap: [{ d18_suggested_qty: 5 }] });
eq(H2e.state.state, 'MISSING_RECOMMENDATION', 'H2j and a duplicate row for one key settles nothing');

// ---- H3. nonzero recommendation, manual < recommendation -> only the residual --------------------------
var H3 = P61({ gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
  d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } });
eq(H3.state.state, 'NONZERO_RECOMMENDATION', 'H3  900 recommended against 520 planned is NONZERO');
eq(H3.decision.noAction, false, 'H3a so it is NOT a no-action');
eq(H3.decision.reason, 'RESIDUAL_REMAINS', 'H3b the residual remains');
eq([H3.decision.recommended_qty, H3.decision.qualifying_planned_qty, H3.decision.residual_qty],
  [900, 520, 380], 'H3c and it is 900 - 520 = 380, not 900');
// The rule itself, exercised as the pure function production uses.
var resid = function (r, p) { return vm.runInContext('weeklyAiPlanResidualQty_(' + JSON.stringify(r) + ', '
  + JSON.stringify(p) + ')', H3.__world.ctx); };
eq(resid(900, 520), 380, 'H3d residual(900, 520) = 380');
eq(resid(520, 520), 0, 'H3e residual(520, 520) = 0');
eq(resid(300, 520), 0, 'H3f residual(300, 520) = 0, CLAMPED — never negative');
eq(resid(900, null), 900, 'H3g nothing planned means the whole recommendation is residual');
eq(resid(null, 520), null, 'H3h and a MISSING recommendation stays null, never 0');
eq(resid('', 520), null, 'H3i as does a blank');

// ---- H4. manual = recommendation -> NO_ACTION ----------------------------------------------------------
var H4 = P61({ gap: { d18_gap_qty: 520, d18_suggested_qty: 520, d30_suggested_qty: 520,
  d45_suggested_qty: 520, d90_gap_qty: 520, d90_suggested_qty: 520 } });
eq(H4.decision.noAction, true, 'H4  an exact match is a no-action');
eq(H4.decision.reason, 'FULLY_COVERED_BY_ACTIVE_PLAN', 'H4a covered by the active plan, not a zero need');
eq(H4.decision.residual_qty, 0, 'H4b residual 0');
eq(H4.response.data.outcome, 'AI_PLAN_NO_ACTION', 'H4c and the same typed success');
ok(/already covered by the active Execution Plan/.test(H4.response.data.message),
  'H4d whose message says WHY, because a bare zero would read as "nothing is needed"');

// ---- H5. manual > recommendation -> NO_ACTION, and NOTHING is reduced ----------------------------------
var H5 = P61({ gap: { d18_gap_qty: 300, d18_suggested_qty: 300, d30_suggested_qty: 300,
  d45_suggested_qty: 300, d90_gap_qty: 300, d90_suggested_qty: 300 } });
eq(H5.decision.noAction, true, 'H5  an over-planned scope is a no-action');
eq(H5.decision.residual_qty, 0, 'H5a residual 0, clamped rather than negative');
eq(H5.decision.per_scope[0].over_planned_qty, 220, 'H5b and the excess is REPORTED as its own number');
eq([H5.response.data.cancelled_headers, H5.response.data.cancelled_lines], [0, 0],
  'H5c nothing is cancelled to bring the plan back down');
eq(H5.response.data.updated_headers, 0, 'H5d and nothing is reduced');
eq(H5.__world.dbWrites(), 0, 'H5e the manual routes are untouched, measured on the sheet');

// ---- H6. scope mismatch rows do not enter the planned total -------------------------------------------
function planned(over) { return P61(over).planned; }
var H6base = planned({});
eq(H6base.byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6  the two manual routes total 520');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X1', company: 'OtherCo', marketplace: 'Amazon' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X1', allocation_draft_id: 'SADH-X1', planned_qty: '999' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6a another COMPANY does not enter it');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X2', marketplace: 'Walmart' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X2', allocation_draft_id: 'SADH-X2', planned_qty: '999' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6b nor another MARKETPLACE');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X3' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X3', allocation_draft_id: 'SADH-X3', sku: 'OTHER-SKU', planned_qty: '999' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6c nor another SKU');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X4', status: 'cancelled' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X4', allocation_draft_id: 'SADH-X4', planned_qty: '999' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6d nor a CANCELLED header');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X5', status: 'submitted' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X5', allocation_draft_id: 'SADH-X5', planned_qty: '999' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6e nor a SUBMITTED one');
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X6' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X6', allocation_draft_id: 'SADH-X6', planned_qty: '999', line_status: 'expired' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6f nor an EXPIRED line under a live header');
// And an ACTIVE row for this exact scope DOES enter it, so the filter is a distinction and not a wall.
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-X7' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-X7', allocation_draft_id: 'SADH-X7', planned_qty: '80' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 600, 'H6g while a third ACTIVE route for this scope does');

// AN AI DRAFT THIS RUN WOULD SUPERSEDE IS NOT AN EXISTING COMMITMENT.
//
// Found by the R4 carrier-authority suite, which seeds a previous run's own draft covering the whole
// recommendation: counting it netted the residual to zero and produced no route — and would have done so on
// every replay, for ever, because a generation would net itself against its own last output.
var H6ai = planned({ extraHeaders: [{ allocation_draft_id: 'SADH-AI1', generation_type: 'system_generated',
    generation_run_id: 'AIRUN-1' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-AI1', allocation_draft_id: 'SADH-AI1', planned_qty: '900' }] });
eq(H6ai.byKey['ResUS|US|Amazon|CO1100-R'], 520,
  'H6h an AI draft this run would supersede is NOT counted as already planned');
eq(H6ai.excluded.ai_generated_header, 1, 'H6h1 and its exclusion is counted, not silent');
// A blank generation_type with a run id is still AI — the classifier's second rule, and the shape older
// rows actually have.
eq(planned({ extraHeaders: [{ allocation_draft_id: 'SADH-AI2', generation_type: '', generation_run_id: 'AIRUN-2' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-AI2', allocation_draft_id: 'SADH-AI2', planned_qty: '900' }]
}).byKey['ResUS|US|Amazon|CO1100-R'], 520, 'H6i as is a bare run id with no generation_type');
// And the provenance question has ONE owner.
eq(H6base.provenance_authority, 'aiplIsAiGenerated_ (69_)',
  'H6j provenance is asked of 69_\'s classifier, not re-derived in 61_');
// THE REGENERATION CASE, end to end: a scope whose only active plan is the previous run's own output must
// still produce a residual equal to the whole recommendation.
var H6re = P61({ gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
    d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 },
  dropA: true, dropB: true,
  extraHeaders: [{ allocation_draft_id: 'SADH-AI3', generation_type: 'system_generated',
    generation_run_id: 'AIRUN-3' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-AI3', allocation_draft_id: 'SADH-AI3', planned_qty: '900' }] });
eq(H6re.decision.qualifying_planned_qty, 0, 'H6k a run\'s own previous draft counts for nothing,');
eq(H6re.decision.residual_qty, 900, 'H6l so a replay can still regenerate the whole recommendation');
eq(H6re.decision.noAction, false, 'H6m and does not answer NO_ACTION against itself');

// ---- H7. the residual netting is idempotent -------------------------------------------------------------
var H7w = new World();
var H7 = vm.runInContext('(function () {'
  + ' var sites = [{ marketplace: "Amazon", sku: "CO1100-R", cumulativeGapByWindow: { D18: 900, D90: 900 } }];'
  + ' var pk = { "ResUS|US|Amazon|CO1100-R": 520 };'
  + ' var a = weeklyAiPlanNetSitesByResidual_(sites, pk, { company: "ResUS", country: "US" });'
  + ' var first = JSON.parse(JSON.stringify(sites[0].cumulativeGapByWindow));'
  + ' var b = weeklyAiPlanNetSitesByResidual_(sites, {}, { company: "ResUS", country: "US" });'
  + ' return { first: first, second: sites[0].cumulativeGapByWindow, report: a, replay: b }; })()', H7w.ctx);
eq(H7.first, { D18: 380, D90: 380 }, 'H7  netting 900 by 520 leaves 380 at every cumulative checkpoint');
eq(H7.second, { D18: 380, D90: 380 },
  'H7a and a second pass with nothing planned does not restore the gross — the netting is not re-derived');
eq(H7.report.netted_site_count, 1, 'H7b the netting is reported rather than silent');
var H7z = vm.runInContext('(function () {'
  + ' var sites = [{ marketplace: "Amazon", sku: "CO1100-R", cumulativeGapByWindow: { D18: 300, D90: 300 } }];'
  + ' var r = weeklyAiPlanNetSitesByResidual_(sites, { "ResUS|US|Amazon|CO1100-R": 520 }, { company: "ResUS", country: "US" });'
  + ' return { net: sites[0].cumulativeGapByWindow, covered: r.fully_covered_site_count }; })()', H7w.ctx);
eq(H7z.net, { D18: 0, D90: 0 }, 'H7c an over-planned site nets to zero, never below it');
eq(H7z.covered, 1, 'H7d and is counted as fully covered');
var H7n = vm.runInContext('(function () {'
  + ' var sites = [{ marketplace: "Amazon", sku: "CO1100-R", cumulativeGapByWindow: { D18: "", D90: 900 } }];'
  + ' weeklyAiPlanNetSitesByResidual_(sites, { "ResUS|US|Amazon|CO1100-R": 520 }, { company: "ResUS", country: "US" });'
  + ' return sites[0].cumulativeGapByWindow; })()', H7w.ctx);
eq(H7n.D18, '', 'H7e an UNREADABLE gap is never netted into a number');

// ---- H8. no zero-quantity route, and no empty shell ----------------------------------------------------
eq(H1.response.data.groups, [], 'H8  a no-action produces no group');
eq(H1.response.data.header_created, false, 'H8a no header');
eq(H1.response.data.line_created, false, 'H8b and no line');

// ---- H9. wrapper / production-handler parity ------------------------------------------------------------
function parity(over) {
  var w = new World(over || {});
  var pre = w.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return { verdict: pre.verdict, outcome: pre.production_path.outcome, parity: pre.parity, pre: pre };
}
var H9a = parity({ gap: { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 } });
eq([H9a.verdict, H9a.outcome], ['READY_NO_ACTION', 'AI_PLAN_NO_ACTION'],
  'H9  a valid zero: the wrapper says READY_NO_ACTION because production says AI_PLAN_NO_ACTION');
var H9b = parity({ gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } });
eq([H9b.verdict, H9b.outcome], ['STOP', 'REFUSAL'],
  'H9a a missing recommendation: the wrapper STOPS because production would refuse');
var H9c = parity({ gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
  d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } });
eq(H9c.outcome, 'WOULD_GENERATE', 'H9b a residual: production would generate,');
eq(H9c.parity.production_would_write, true, 'H9b1 and the wrapper says so');
// THE DEFECT ITSELF: the wrapper must not out-rank the path it wraps. With production refusing, no amount
// of this file's own checks passing may produce a success.
ok(H9b.parity.wrapper_own_checks_passed === false || H9b.verdict === 'STOP',
  'H9c and a wrapper success is unreachable while production would refuse');
ok(/worse than no preflight/.test(H9a.parity.rule), 'H9d stated as the rule it is');

// ---- H10. flag false -> production writes 0 ------------------------------------------------------------
eq(H9a.pre.flag.value, false, 'H10 the flag is false in every world above');
var H10w = new World();
['RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS', 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT',
 'RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST', 'RUN_R6R7_CONTROLLED_AI_PLAN_READBACK'].forEach(function (n) { H10w.run(n); });
eq(H10w.dbWrites(), 0, 'H10a and every entry point together touched zero cells');
eq(H1.__world.dbWrites() + H3.__world.dbWrites() + H4.__world.dbWrites() + H5.__world.dbWrites(), 0,
  'H10b as did every production-authority evaluation above');

// ---- the production handler's own gates, at the source -------------------------------------------------
ok(/BEFORE THIS IS REPORTED AS A FAILURE, ASK WHETHER IT IS ONE/.test(G61),
  'H11 the REQUESTED_SCOPE_EMPTY gate asks the canonical row first');
ok(/weeklyAiPlanNoActionResponse_\(_na, \{/.test(G61), 'H11a and returns the typed success when it is one');
ok(/the canonical recommendation could not be read as a valid zero/.test(G61),
  'H11b while a genuine refusal now SAYS why it could not be read as a zero');
ok(/`if \(!receivers.length\) return NO_RECEIVERS_BUILT`/.test(G61)
  || /if \(!receivers.length\) return NO_RECEIVERS_BUILT/.test(G61),
  'H12 and the older verdict\'s blind spot is named where it is worked around');
ok(G61.indexOf('weeklyAiPlanK2NoAction_(h)') < G61.indexOf('weeklyAiPlanNoDemandVerdict_(h, mapped)'),
  'H12a the canonical question is asked BEFORE the verdict that could not answer it');

// ================================================================================================================
section('N — mutants');
// ================================================================================================================
function W(src) { return new World({}, src); }
mut('N1  the census adopting one of the two numbers instead of reporting both rules', function () {
  var m = swap(CENSUS, 'standing_authority_value: standing,', 'standing_authority_value: (earliest !== null ? earliest : standing),');
  var r = W(m).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
  return r.suggested_qty.standing_authority_value !== 0;
});
mut('N2  the earliest-window rule taking the LARGEST instead of the earliest', function () {
  var m = swap(CENSUS, 'if (typeof s === \'number\' && isFinite(s) && s > 0) { earliest = s; earliestWindow = view.windows[i].window; break; }',
    'if (typeof s === \'number\' && isFinite(s) && s > 0) { if (earliest === null || s > earliest) { earliest = s; earliestWindow = view.windows[i].window; } }');
  // D18 is not the largest here, which is what makes the two rules distinguishable at all.
  var g = { d18_gap_qty: 100, d18_suggested_qty: 100, d30_gap_qty: 920, d30_suggested_qty: 920 };
  var r = new World({ gap: g }, m).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
  var clean = new World({ gap: g }).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
  return clean.recommendation_window.ai_plan_dto_window === 'D18'
    && r.recommendation_window.ai_plan_dto_window !== 'D18';
});
mut('N3  a BLOCKED row being read as a zero recommendation', function () {
  var m = swap(CENSUS, "} else if (st !== 'READY') {", '} else if (false) {');
  // A row that is BLOCKED and happens to hold stored zeros. Its zeros mean nothing, and without the
  // status branch it is indistinguishable from a canonical no-action.
  var g = { calculation_status: 'BLOCKED', note: 'RECOMMENDATION_LINE_NOT_FOUND',
    d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0,
    d45_gap_qty: 0, d45_suggested_qty: 0, d90_gap_qty: 0, d90_suggested_qty: 0 };
  var clean = new World({ gap: g }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  var r = new World({ gap: g }, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return clean.zero_recommendation_classification.kind === 'STALE_OR_MISSING'
    && r.zero_recommendation_classification.kind === 'CORRECT_NO_ACTION';
});
mut('N4  a missing gap cell being coerced to 0', function () {
  var m = swap(CENSUS, 'function CENSUS_r6r7Num_(v) {' + CR + '  if (v === \'\' || v === null || v === undefined) return null;',
    'function CENSUS_r6r7Num_(v) {' + CR + '  if (v === \'\' || v === null || v === undefined) return 0;');
  var r = new World({ gap: { calculation_status: 'READY', d18_gap_qty: '', d18_suggested_qty: '',
    d30_suggested_qty: '', d45_suggested_qty: '', d90_suggested_qty: '' } }, m)
    .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return r.zero_recommendation_classification.kind === 'CORRECT_NO_ACTION';
});
mut('N5  the duplicate-row gate counting rows in the whole table instead of this key', function () {
  var m = swap(CENSUS, 'P(\'no_duplicate_rows_for_this_business_key\', 0, Math.max(0, mine.length - 1), mine.length <= 1);',
    'P(\'no_duplicate_rows_for_this_business_key\', 0, 0, true);');
  // The verdict cannot isolate this: a second row also empties the single-row view, which fails the
  // provenance gate for its own reason. So the claim is checked where it is made.
  var o = { extraGap: [{ d18_suggested_qty: 555 }] };
  var clean = new World(o).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
  var r = new World(o, m).run('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS').res;
  return failed(clean).indexOf('no_duplicate_rows_for_this_business_key') !== -1
    && failed(r).indexOf('no_duplicate_rows_for_this_business_key') === -1;
});
mut('N6  the preflight accepting an identity collision with a manual route', function () {
  var m = swap(CENSUS, 'P(\'no_proposed_ai_identity_equals_a_manual_route_identity\', [], clashes, clashes.length === 0);',
    'P(\'no_proposed_ai_identity_equals_a_manual_route_identity\', [], [], true);');
  // A proposed group identical to Route A in every dimension INCLUDING the cycle and the ordinal. That is
  // the one shape that collides, and the gate must catch it.
  var o = { cycle: '', proposed: [{ group_no: '', source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
    destination_type: 'MARKETPLACE', destination: 'Amazon', method: 'sea_express', last_mile: 'truck',
    line_count: 1, total_qty: 320 }] };
  var clean = new World(o).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  var r = new World(o, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  // The mutant is only interesting if the un-mutated code would have caught it, so both halves are asserted.
  return clean.verdict === 'STOP'
    && failed(clean).indexOf('no_proposed_ai_identity_equals_a_manual_route_identity') !== -1
    && predicate(clean, 'no_proposed_ai_identity_equals_a_manual_route_identity').observed[0].by === 'GROUP_KEY'
    && failed(r).indexOf('no_proposed_ai_identity_equals_a_manual_route_identity') === -1;
});
mut('N7  the preflight reading provenance from generation_type alone', function () {
  var m = swap(CENSUS, "!!r && CENSUS_low_(r.generation_type) !== 'system_generated' && CENSUS_str_(r.generation_run_id) === '');" + CR + "    if (r) groupNos.push(",
    "!!r && CENSUS_low_(r.generation_type) !== 'system_generated');" + CR + "    if (r) groupNos.push(");
  var r = new World({ aHeader: { generation_type: '', generation_run_id: 'AIPLAN-DEADBEEF' } }, m)
    .run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return failed(r).indexOf('route_A_is_classified_MANUAL_by_the_lifecycle_authority') === -1;
});
mut('N8  the readback proving stillness by value instead of by version', function () {
  var m = swap(CENSUS, "P('route_' + m.label + '_draft_version_did_not_move', m.draft_version,",
    "P('route_' + m.label + '_draft_version_did_not_move_SKIPPED', m.draft_version,");
  var r = withAiSrc(m, { aHeader: { draft_version: '5' } });
  return failed(r).indexOf('route_A_draft_version_did_not_move') === -1;
});
mut('N9  the readback accepting a new row that carries no run id', function () {
  var m = swap(CENSUS, 'P(\'every_new_row_is_ai_owned\', [], unowned, unowned.length === 0);',
    'P(\'every_new_row_is_ai_owned\', [], [], true);');
  var r = withAiSrc(m, { aiHeader: { generation_type: 'user_created', generation_run_id: '' } });
  return r.verdict !== 'STOP';
});
mut('N10 the readback calling an empty result a write rather than a no-action', function () {
  var m = swap(CENSUS, "} else if (out.ai_rows_observed.length === 0) {", "} else if (false) {");
  var r = W(m).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
  return r.verdict !== 'CONTROLLED_AI_PLAN_NO_ACTION_CONFIRMED';
});
mut('N11 the readback tolerating a zero-quantity AI row', function () {
  var m = swap(CENSUS, 'P(\'no_zero_quantity_ai_row_was_created\', [], empties, empties.length === 0);',
    'P(\'no_zero_quantity_ai_row_was_created\', [], [], true);');
  var r = withAiSrc(m, { aiLine: { planned_qty: '0' } });
  return r.verdict === 'CONTROLLED_AI_PLAN_WRITE_CONFIRMED';
});
mut('N12 the readback checking row counts but not the arithmetic of the total', function () {
  var m = swap(CENSUS, "P('station_total_is_the_manual_total_plus_the_ai_units',",
    "P('station_total_is_the_manual_total_plus_the_ai_units_SKIPPED',");
  var r = withAiSrc(m, { aLine: { planned_qty: '1' } });
  return failed(r).indexOf('station_total_is_the_manual_total_plus_the_ai_units') === -1;
});
mut('N13 the preflight passing while the flag is already on', function () {
  var m = swap(CENSUS, "P('flag_is_still_false_this_round', false, flagVal, flagVal === false);",
    "P('flag_is_still_false_this_round', false, flagVal, true);");
  var r = new World({ flag: true }, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return r.verdict !== 'STOP';
});
mut('N14 the preflight ignoring a widened allowlist', function () {
  var m = swap(CENSUS, "P('allowlist_holds_exactly_this_one_scope', 1, allow ? allow.length : null, !!allow && allow.length === 1);",
    "P('allowlist_holds_exactly_this_one_scope', 1, allow ? allow.length : null, true);");
  // The verdict cannot isolate this claim: a widened allowlist also gives the production path a scope with
  // no canonical row, so the preflight stops for a second, independent reason. Asked where it is made.
  var o = { allowlist: [{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },
    { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'OTHER-SKU' }] };
  var clean = new World(o).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  var r = new World(o, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  return failed(clean).indexOf('allowlist_holds_exactly_this_one_scope') !== -1
    && failed(r).indexOf('allowlist_holds_exactly_this_one_scope') === -1;
});
mut('N15 the activation manifest authorizing itself', function () {
  var src = extractFn(CENSUS, 'RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST');
  var r = new World().run('RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST').res;
  return r.authorized === false && r.executed === false && r.flag_flipped_this_round === false
    && !/INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_\s*=\s*true/.test(src);
});
mut('N16 the §0 record claiming this file authorized the restore', function () {
  var r = new World().run('RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST').res;
  return r.self_authorizing === false && r.outcome.self_authorizing === false
    && /the operator/.test(r.outcome.authorized_by);
});
mut('N17 changed_fields declared but never filled, so an empty list means nothing was checked', function () {
  var m = swap(CENSUS, "if (was !== now) out.changed_fields.push({ route: m.label, field: pair[0], was: was, now: now });",
    'if (false) { void was; void now; }');
  var r = withAiSrc(m, { aHeader: { draft_version: '5' } });
  var clean = withAiSrc(CENSUS, { aHeader: { draft_version: '5' } });
  return clean.changed_fields.length === 1 && r.changed_fields.length === 0;
});
mut('N18 the duplicate-identity gate keyed on the row id rather than the group key', function () {
  var m = swap(CENSUS, 'var k = CENSUS_str_(r.k4_group_key);' + String.fromCharCode(13) + String.fromCharCode(10)
    + '    if (!k) return;', 'var k = CENSUS_str_(r.allocation_draft_id);'
    + String.fromCharCode(13) + String.fromCharCode(10) + '    if (!k) return;');
  var o = { extraHeaders: [
    { allocation_draft_id: AI_H, destination_marketplace: 'Amazon', recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: 'truck', recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A },
    { allocation_draft_id: 'SADH-K4-DUPE0001', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
      recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }],
    extraLines: [
    { allocation_draft_line_id: AI_L, allocation_draft_id: AI_H, planned_qty: '920', updated_at: TS_A },
    { allocation_draft_line_id: 'SADL-K2-DUPE0002', allocation_draft_id: 'SADH-K4-DUPE0001', planned_qty: '920', updated_at: TS_A }] };
  var clean = new World(o).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
  var r = new World(o, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
  // Two rows with DIFFERENT ids and the SAME identity is exactly the duplicate that matters, and a gate
  // keyed on the id can never see it.
  return failed(clean).indexOf('no_duplicate_ai_identities') !== -1
    && failed(r).indexOf('no_duplicate_ai_identities') === -1;
});
// ---- R6-R7-R1: the production no-action authority. These mutate 61_ itself, because that is where the
//      rules live; mutating a copy in the census would prove nothing about what a generation does. -------
function W61(m, over) { return new World(over || {}, null, m); }
function decide(m, over) {
  var w = W61(m, over);
  var cyc = vm.runInContext('gapCalcResolveContext_().planningCycle', w.ctx);
  var js = JSON.stringify({ company: 'ResUS', country: 'US', marketplace: 'Amazon', planningCycle: cyc });
  return vm.runInContext('(function () { var s = ' + js + ';'
    + ' var c = weeklyAiPlanCanonicalDemand_(SpreadsheetApp.openById("x"), s, null);'
    + ' var t = weeklyAiPlanTargetScopes_(s, s.marketplace);'
    + ' var rs = weeklyAiPlanRecommendationState_(c, t);'
    + ' var pl = weeklyAiPlanQualifyingPlannedQty_(SpreadsheetApp.openById("x"), s);'
    + ' return { state: rs, planned: pl, decision: weeklyAiPlanNoActionDecision_(rs, pl) }; })()', w.ctx);
}
var ZERO_GAP = { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 };

mut('N19 a blank window read as a stored zero, so an unmaterialized SKU answers NO_ACTION', function () {
  var m = swap(GLOBAL_G61, 'function weeklyAiPlanQty_(v) {' + cr() + "  if (v === '' || v === null || v === undefined) return null;",
    'function weeklyAiPlanQty_(v) {' + cr() + "  if (v === '' || v === null || v === undefined) return 0;");
  var g = { calculation_status: 'READY', d18_suggested_qty: '', d30_suggested_qty: '',
    d45_suggested_qty: '', d90_suggested_qty: '' };
  var clean = decide(null, { gap: g, extraGap: [{ sku: 'OTHER-SKU', d90_suggested_qty: 0 }] });
  var r = decide(m, { gap: g, extraGap: [{ sku: 'OTHER-SKU', d90_suggested_qty: 0 }] });
  return clean.decision.noAction === false && r.decision.noAction === true;
});
mut('N20 a MISSING recommendation residualising to 0 instead of staying null', function () {
  var m = swap(GLOBAL_G61, '  var r = weeklyAiPlanQty_(recommendedQty);' + cr() + '  if (r === null) return null;',
    '  var r = weeklyAiPlanQty_(recommendedQty);' + cr() + '  if (r === null) return 0;');
  var w = W61(m);
  var clean = vm.runInContext('weeklyAiPlanResidualQty_(null, 520)', new World().ctx);
  return clean === null && vm.runInContext('weeklyAiPlanResidualQty_(null, 520)', w.ctx) === 0;
});
mut('N21 the residual not clamped, so an over-planned scope reports a negative', function () {
  var m = swap(GLOBAL_G61, '  var d = r - p;' + cr() + '  return d > 0 ? d : 0;',
    '  var d = r - p;' + cr() + '  return d;');
  var w = W61(m);
  return vm.runInContext('weeklyAiPlanResidualQty_(300, 520)', new World().ctx) === 0
    && vm.runInContext('weeklyAiPlanResidualQty_(300, 520)', w.ctx) === -220;
});
mut('N22 the qualifying plan keyed without the marketplace', function () {
  var m = swap(GLOBAL_G61,
    "      + weeklyAiPlanStr_(h.marketplace) + '|' + weeklyAiPlanStr_(l.sku);",
    "      + 'Amazon' + '|' + weeklyAiPlanStr_(l.sku);");
  var o = { extraHeaders: [{ allocation_draft_id: 'SADH-M1', marketplace: 'Walmart' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-M1', allocation_draft_id: 'SADH-M1', planned_qty: '999' }] };
  var clean = decide(null, o), r = decide(m, o);
  return clean.planned.byKey['ResUS|US|Amazon|CO1100-R'] === 520
    && r.planned.byKey['ResUS|US|Amazon|CO1100-R'] === 1519;
});
mut('N22a the AI exclusion removed, so a run nets itself against its own previous draft', function () {
  var m = swap(GLOBAL_G61, '    if (weeklyAiPlanIsAiRow_(h)) { out.excluded.ai_generated_header++; return; }',
    '    if (false) { out.excluded.ai_generated_header++; return; }');
  var o = { dropA: true, dropB: true,
    gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900, d45_suggested_qty: 900,
      d90_gap_qty: 900, d90_suggested_qty: 900 },
    extraHeaders: [{ allocation_draft_id: 'SADH-AIM', generation_type: 'system_generated', generation_run_id: 'AIRUN-M' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-AIM', allocation_draft_id: 'SADH-AIM', planned_qty: '900' }] };
  var clean = decide(null, o), r = decide(m, o);
  return clean.decision.residual_qty === 900 && r.decision.residual_qty === 0;
});
mut('N23 a terminal header counted as an active plan', function () {
  var m = swap(GLOBAL_G61, '    if (termH[st]) { out.excluded.terminal_header++; return; }',
    '    if (false) { out.excluded.terminal_header++; return; }');
  var o = { extraHeaders: [{ allocation_draft_id: 'SADH-M2', status: 'cancelled' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-M2', allocation_draft_id: 'SADH-M2', planned_qty: '999' }] };
  var clean = decide(null, o), r = decide(m, o);
  return clean.planned.byKey['ResUS|US|Amazon|CO1100-R'] === 520
    && r.planned.byKey['ResUS|US|Amazon|CO1100-R'] === 1519;
});
mut('N24 a NOT_READY row classified as a valid zero', function () {
  var m = swap(GLOBAL_G61, "    if (weeklyAiPlanStr_(row.calculation_status) !== 'READY') {", '    if (false) {');
  var g = { calculation_status: 'BLOCKED', d18_suggested_qty: 0, d30_suggested_qty: 0,
    d45_suggested_qty: 0, d90_suggested_qty: 0 };
  var o = { gap: g, extraGap: [{ sku: 'OTHER-SKU', d90_suggested_qty: 0 }] };
  var clean = decide(null, o), r = decide(m, o);
  return clean.decision.noAction === false && r.decision.noAction === true;
});
mut('N25 a residual that remains still answered as a no-action', function () {
  var m = swap(GLOBAL_G61, "  if (anyResidual) { out.reason = 'RESIDUAL_REMAINS'; return out; }",
    "  if (false) { out.reason = 'RESIDUAL_REMAINS'; return out; }");
  var g = { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900, d45_suggested_qty: 900,
    d90_gap_qty: 900, d90_suggested_qty: 900 };
  var clean = decide(null, { gap: g }), r = decide(m, { gap: g });
  return clean.decision.noAction === false && r.decision.noAction === true;
});
mut('N26 the K2 empty-scope gate skipping the canonical question', function () {
  var m = swap(GLOBAL_G61, '      var _na = weeklyAiPlanK2NoAction_(harvest);' + cr() + '      if (_na.noAction) {',
    '      var _na = weeklyAiPlanK2NoAction_(harvest);' + cr() + '      if (false) {');
  // Source-level: the gate must not be reachable-only-on-paper. Both halves asserted so a renamed anchor
  // cannot pass as a caught mutant.
  return /if \(_na\.noAction\) \{/.test(GLOBAL_G61) && !/if \(_na\.noAction\) \{/.test(m)
    && /weeklyAiPlanNoActionResponse_\(_na,/.test(GLOBAL_G61);
});
mut('N27 the wrapper naming a success while the production path refuses', function () {
  var m = swap(CENSUS, "  } else if (pp.outcome === 'AI_PLAN_NO_ACTION') {", '  } else if (true) {');
  var g = { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
    d45_suggested_qty: '', d90_suggested_qty: '' };
  var clean = new World({ gap: g }).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  var r = new World({ gap: g }, m).run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  // The predicate is what stops it even with the branch mutated, and that is the point: the verdict is
  // derived from the production answer in TWO places, so removing one is still caught.
  return clean.verdict === 'STOP' && failed(r).indexOf('production_path_would_not_refuse') !== -1;
});
function cr() { return String.fromCharCode(13) + String.fromCharCode(10); }

function withAiSrc(src, over) {
  var o = { extraHeaders: [Object.assign({ allocation_draft_id: AI_H, destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
      recommendation_group_no: '1', generation_type: 'system_generated',
      generation_run_id: 'AIPLAN-1234ABCD', draft_version: '1', updated_at: TS_A }, (over || {}).aiHeader || {})],
    extraLines: [Object.assign({ allocation_draft_line_id: AI_L, allocation_draft_id: AI_H,
      planned_qty: '920', updated_at: TS_A }, (over || {}).aiLine || {})] };
  Object.keys(over || {}).forEach(function (k) { if (k !== 'aiHeader' && k !== 'aiLine') o[k] = over[k]; });
  return new World(o, src).run('RUN_R6R7_CONTROLLED_AI_PLAN_READBACK').res;
}

console.log('\npassed ' + pass + '  failed ' + fail
  + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);
