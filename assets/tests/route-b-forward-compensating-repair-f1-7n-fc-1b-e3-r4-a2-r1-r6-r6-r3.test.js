// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R3 — THE ROUTE B FORWARD COMPENSATING REPAIR TOOL.
//
// R6-R6-R2 stopped the page from writing a route nobody touched, and live hydration confirmed it: zero
// mutation requests, an empty mutations list. It did not undo the write that had already happened. Route B
// still holds `parcel` in a column no operator filled, at draft_version 2, with a K4 identity derived to match.
//
// This suite exercises the tool that puts it back — FORWARD, as a third version, never by rewinding a second.
// Every case below runs the REAL writer (16_'s handleUpsertShippingAllocationDraftAtomic_) against a mutable
// sheet double, and the REAL census entry points against the same rows. Nothing is asserted from source text
// where it can be measured from a row instead.
//
// THREE PROPERTIES THIS SUITE EXISTS TO PIN.
//
// (1) THE WRITER WRITES TO getActiveSpreadsheet(); THE CENSUS READS THROUGH openById(prodExpectedDbId_()).
//     If those are not the same book, the preflight validates one database and the write lands in another.
//     That is predicate zero, and it fails closed.
//
// (2) K4 IS NOT A COLUMN. ricK4GroupKey_ derives it, and recommended_last_mile_delivery is dimension 9 of 11.
//     'Restore the K4 key' therefore requires writing nothing — the key follows the last mile. The repair
//     moves exactly ONE stored column, and that is measured here, column by column.
//
// (3) ALREADY_COMPENSATED IS NOT A FAILURE. A repaired row fails 'the last mile is parcel' by construction,
//     and an operator who reads that as 'not ready' is one step from running the writer twice. It is checked
//     BEFORE the readiness verdict and reported as its own verdict.
//
// Run: node assets/tests/route-b-forward-compensating-repair-f1-7n-fc-1b-e3-r4-a2-r1-r6-r6-r3.test.js

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
function code(src) { return String(src).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var BUNDLE = read('assets/specs/active/apps-script/90_generated_supply_planning_bundle.gs');
var RO = require('./_release-order.js');

var SKU = 'CO1100-R';
var B_HEADER = 'SADH-K4-A3872518', B_LINE = 'SADL-K2-344FB2B2';
var A_HEADER = 'SADH-K4-38523A90', A_LINE = 'SADL-K2-92B8BAD2';
var TS_A = 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)';
var TS_B = 'Sun Sep 06 2026 08:28:04 GMT+0800 (Taiwan Standard Time)';
var TS_REPAIR = 'Sun Sep 06 2026 09:15:00 GMT+0800 (Taiwan Standard Time)';
var K4_B_PARCEL = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air|parcel|';
var K4_B_BLANK = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air||';

// ================================================================================================================
// THE MUTABLE DOUBLE. One book, reachable both ways: openById (how the census reads) and getActiveSpreadsheet
// (how the writer writes). They return the SAME sheets, because in production they are the same book — and the
// tool's first predicate is precisely that this is so.
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

var HDR_FULL, LINE_FULL;
(function () {
  var names = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
    'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_', 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
    'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_', 'SAD_LINE_ETA_TAIL_COLUMNS_'];
  var s = {};
  vm.runInNewContext(names.map(function (n) { return extractVar(G16, n); }).join(NL), s);
  HDR_FULL = s.SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_;
  LINE_FULL = s.SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(s.SAD_LINE_ETA_TAIL_COLUMNS_);
})();

var SAD_CONSTS = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
  'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_', 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
  'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SAD_SCHEMA_GENERATIONS_', 'SAD_AI_K2_INTENT_', 'SAD_ROUTE_INTENTS_',
  'SAD_CLIENT_GRANTABLE_INTENTS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_',
  'SAD_LINE_ETA_TAIL_COLUMNS_', 'SAD_STATUSES_', 'SAD_TERMINAL_STATUSES_', 'SAD_TERMINAL_LINE_STATUSES_',
  'SAD_GENERATION_TYPES_', 'SAD_RECOMMENDATION_FIELDS_', 'SAD_LINE_LEGACY_ALIASES_', 'SAD_K2_GROUP_DIMENSIONS_',
  'SAD_LINE_IDENTITY_FIELDS_', 'SAD_K2_BASIS_ID_MATCHES_', 'SAD_K2_BASIS_STALE_ACCEPTED_',
  'SAD_K2_BASIS_DIFFERENT_GROUP_', 'SAD_K2_BASIS_NO_REQUEST_GROUP_', 'SAD_K2_BASIS_CONTESTED_',
  'SAD_K2_HEADER_FP_', 'SAD_K2_LINE_FP_', 'SAD_K2_SEM_CONTRACT_',
  'SAD_K2_FP_DATE_FIELDS_', 'SAD_K2_FP_NUMERIC_FIELDS_', 'SAD_K2_SEM_EXCLUDED_LIFECYCLE_',
  'SAD_K2_SEM_OPTIONAL_PRESERVE_'];
var SAD_FNS = ['sadApplyLineAliases_', 'sadFnv1a_', 'sadFpVal_', 'sadLineNaturalKey_', 'sadDeterministicLineId_',
  'sadFindLineByNaturalKey_', 'sadK2GroupKey_', 'sadK2DeterministicHeaderId_', 'sadK2LineNaturalKey_',
  'sadK2DeterministicLineId_', 'sadIsK2Group_', 'sadNewLineId_', 'sadK2ResolveActiveDraft_', 'sadCanonicalLineId_',
  'sadSameLineIdentity_', 'sadLineIsComplete_', 'sadLiveHeaderNames_', 'sadHasColumn_', 'sadDestinationIdentity_',
  'sadHeaderRouteIsComplete_', 'sadResolveActiveDraft_', 'sadReadActiveHeaderRows_',
  'sadResolveActiveDraftK2OrK3_', 'sadK2ReconcileDecision_', 'sadLegacyReconcileReason_', 'sadReconcileMessage_',
  'sadResolveBlockMessage_', 'sadRowToObject_', 'sadReadLinesForDraft_', 'sadExactSchemaReason_',
  'sadSchemaRefusal_', 'sadK4SchemaReady_', 'sadCreateIdempotencyReady_', 'sadFindHeaderByCreateKey_',
  'sadMintNewHeaderId_', 'sadK2PayloadFingerprint_', 'sadK2SemanticPayloadEqual_',
  'sadK2LinesRouteCompatibleWithHeader_', 'sadRegenerateLinePatch_', 'sadAtomicValidateBatch_',
  'sadCanonDate_', 'sadFpNorm_', 'sadK2LineIdentity_', 'sadK2SemFieldClass_', 'sadK2SemFieldEqual_',
  'sadK2SemFieldVerdict_', 'sadK4ResolveActiveDraft_', 'sadAiK2IntentEvidence_', 'sadResolveHeaderSchema_',
  'sadDraftsSchemaReason_', 'sadSchemaGenerationColumns_', 'sadSupportedSchemaVersions_',
  'sadPreflightLineBatch_', 'sadScanDuplicateLinePks_', 'sadVerifyDraftLines_',
  'sadAtomicUpsertCore_', 'handleUpsertShippingAllocationDraftAtomic_'];

// ---- the production plan, as R6-R6-R3's frozen evidence describes it -------------------------------------------
function headerRow(o) { var d = {
  allocation_draft_id: '', planning_cycle: '', source_page: 'inventory_replenishment',
  company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
  recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', recommended_destination_warehouse_id: '',
  recommended_source_warehouse_code_snapshot: 'CNYOUXIN', recommended_destination_warehouse_code_snapshot: '',
  recommendation_group_no: '', recommended_shipping_method: '', recommended_last_mile_delivery: '',
  generation_type: 'user_created', draft_version: '', created_by: 'inventory-replenishment',
  created_at: TS_A, updated_by: 'inventory-replenishment', updated_at: '', destination_marketplace: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
function lineRow(o) { var d = {
  allocation_draft_line_id: '', allocation_draft_id: '', sku: SKU, planned_qty: '',
  source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', source_warehouse_code_snapshot: 'CNYOUXIN',
  line_status: '', created_at: TS_A, updated_at: '', expected_arrival: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }

var PROD_A_H = headerRow({ allocation_draft_id: A_HEADER, destination_marketplace: 'Amazon',
  recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'truck',
  draft_version: '2', updated_at: TS_A });
var PROD_A_L = lineRow({ allocation_draft_line_id: A_LINE, allocation_draft_id: A_HEADER,
  planned_qty: '320', updated_at: TS_A });
var PROD_B_H = headerRow({ allocation_draft_id: B_HEADER,
  recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
  recommended_destination_warehouse_code_snapshot: 'AMZLGS',
  recommended_shipping_method: 'air', recommended_last_mile_delivery: 'parcel',
  draft_version: '2', updated_at: TS_B });
var PROD_B_L = lineRow({ allocation_draft_line_id: B_LINE, allocation_draft_id: B_HEADER,
  planned_qty: '200', updated_at: TS_B });

// ================================================================================================================
// THE WORLD: one sandbox holding 16_'s real writer, 69_'s real identity contract and the real census.
// ================================================================================================================
function World(over, censusSrc) {
  over = over || {};
  var sheets = {};
  var H = new FakeSheet(HDR_FULL), L = new FakeSheet(LINE_FULL);
  sheets['shipping_allocation_drafts'] = H;
  sheets['shipping_allocation_draft_lines'] = L;
  function put(sheet, headers, obj) { sheet.rows.push(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })); }
  function merge(base, o) { var d = {}; Object.keys(base).forEach(function (k) { d[k] = base[k]; });
    Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
  // Route B is written FIRST on purpose: list order must prove nothing.
  if (!over.dropB) put(L, LINE_FULL, merge(PROD_B_L, over.bLine));
  if (!over.dropB) put(H, HDR_FULL, merge(PROD_B_H, over.bHeader));
  put(L, LINE_FULL, merge(PROD_A_L, over.aLine));
  put(H, HDR_FULL, merge(PROD_A_H, over.aHeader));
  (over.extraHeaders || []).forEach(function (o) { put(H, HDR_FULL, headerRow(o)); });
  (over.extraLines || []).forEach(function (o) { put(L, LINE_FULL, lineRow(o)); });
  H.writes = 0; L.writes = 0;              // the fixture is not a write

  var LOG = [];
  var calls = { writer: 0, lastPayload: null };
  var sb = { console: { log: function () {} }, JSON: JSON, Math: Math, Date: Date, String: String,
    Number: Number, Object: Object, Array: Array, isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat,
    parseInt: parseInt, Error: Error, RegExp: RegExp, Boolean: Boolean };
  sb.global = sb;
  sb.Logger = { log: function (m) { LOG.push(String(m)); } };
  var book = { getSheetByName: function (n) { return sheets[n] || null; }, getId: function () { return 'PROD-BOOK'; } };
  sb.SpreadsheetApp = {
    openById: function () { return book; },
    // THE WRITER'S DOOR. Overridable, so the 'wrong book' predicate can be exercised for real.
    getActiveSpreadsheet: function () { return over.activeBook === undefined ? book : over.activeBook; }
  };
  sb.LockService = { getScriptLock: function () { return {
    tryLock: function () { return over.lockUnavailable !== true; }, releaseLock: function () {} }; } };
  var uu = 0;
  sb.Utilities = { getUuid: function () { uu++; return ('UUID' + uu + 'ABCDEF0123456789').substring(0, 16); } };
  sb.Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };

  var ctx = vm.createContext(sb);
  vm.runInContext(BUNDLE, ctx);
  vm.runInContext([
    'function prodExpectedDbId_() { return "PROD-BOOK"; }',
    // The real adapter's job, in one line: the book handed in must BE the production book.
    'function prodAssertDbTarget_(ss) {',
    '  if (!ss || (typeof ss.getId === "function" && ss.getId() !== prodExpectedDbId_())) {',
    '    throw new Error("PRODUCTION_SAFETY:WRONG_SPREADSHEET_TARGET"); }',
    '  return true; }',
    'function procurementTimestamp_() { return __NOW; }',
    'function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ""; }',
    'function prodRequireSheet_(ss, n) { return ss.getSheetByName(n); }',
    'function sheetEnsureColumns_() { return null; }',
    // The real jsonResponse_ returns a ContentService TextOutput, so the double must too — the census parses
    // through getContent(), and a plain object would silently exercise a path production does not have.
    'function jsonResponse_(o) { var s = JSON.stringify(o); return { getContent: function () { return s; } }; }'
  ].join(NL), ctx);
  sb.__NOW = over.now || TS_REPAIR;
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
  vm.runInContext([extractFn(G13, 'procurementEnsureSheet_'), extractFn(G13, 'procurementAppendByHeader_'),
    extractFn(G13, 'procurementFindRow_')].join(NL), ctx);
  vm.runInContext(SAD_CONSTS.map(function (v) { return extractVar(G16, v); }).join(NL), ctx);
  vm.runInContext('var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ = '
    + 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);', ctx);
  vm.runInContext(SAD_FNS.map(function (f) { return extractFn(G16, f); }).join(NL), ctx);
  // Count the writer calls from the outside, so 'at most one' is measured rather than declared.
  sb.__tally = function (payload) { calls.writer++; calls.lastPayload = payload; };
  sb.__throwOnWrite = over.throwOnWrite === true;
  sb.__loseAckAfterCommit = over.loseAckAfterCommit === true;
  vm.runInContext([
    'var __realAtomic = handleUpsertShippingAllocationDraftAtomic_;',
    'handleUpsertShippingAllocationDraftAtomic_ = function (body) {',
    '  __tally(JSON.parse(JSON.stringify(body || {})));',
    '  if (__throwOnWrite) { throw new Error("SIMULATED_WRITER_EXCEPTION_BEFORE_COMMIT"); }',
    '  var r = __realAtomic(body);',
    // A lost acknowledgement: the commit HAPPENED and the answer did not come back.
    '  if (__loseAckAfterCommit) { throw new Error("SIMULATED_LOST_ACK_AFTER_COMMIT"); }',
    '  return r; };'
  ].join(NL), ctx);
  vm.runInContext(censusSrc || CENSUS, ctx);

  this.ctx = ctx; this.sheets = sheets; this.calls = calls; this.log = LOG;
  this.H = H; this.L = L;
}
World.prototype.run = function (entry) {
  var res = null, threw = null;
  try { res = vm.runInContext(entry + '()', this.ctx); } catch (e) { threw = e; }
  return { res: res || {}, threw: threw };
};
World.prototype.dbWrites = function () { return this.H.writes + this.L.writes; };
World.prototype.rowsOf = function (tab) {
  var sh = this.sheets[tab], hdr = sh.rows[0];
  return sh.rows.slice(1).map(function (r) { var o = {}; hdr.forEach(function (h, i) { if (h) o[h] = r[i]; }); return o; });
};
World.prototype.header = function (id) {
  return this.rowsOf('shipping_allocation_drafts').filter(function (h) { return h.allocation_draft_id === id; })[0] || null;
};
World.prototype.line = function (id) {
  return this.rowsOf('shipping_allocation_draft_lines').filter(function (l) { return l.allocation_draft_line_id === id; })[0] || null;
};
World.prototype.snapshot = function () { return JSON.stringify({ h: this.rowsOf('shipping_allocation_drafts'), l: this.rowsOf('shipping_allocation_draft_lines') }); };
function failedNames(r) { return (r.predicates || []).filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }); }

(function () {

// ================================================================================================================
section('§0 — THE HARNESS IS THE REAL THING');
// ================================================================================================================
var w0 = new World();
var pre0 = w0.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT');
ok(!pre0.threw, 'H1  the preflight runs against the real census' + (pre0.threw ? ' — ' + pre0.threw.message : ''));
eq(w0.dbWrites(), 0, 'H2  and the fixture plus a preflight touched no cell');
// The identity contract is 69_'s own, so the K4 keys below are derived and not asserted into existence.
eq(vm.runInContext('ricK4GroupKey_(' + JSON.stringify(PROD_B_H) + ')', w0.ctx), K4_B_PARCEL,
  'H3  69_ derives Route B\'s CURRENT key as the parcel key');
var bBlank = JSON.parse(JSON.stringify(PROD_B_H)); bBlank.recommended_last_mile_delivery = '';
eq(vm.runInContext('ricK4GroupKey_(' + JSON.stringify(bBlank) + ')', w0.ctx), K4_B_BLANK,
  'H3a and blanking the last mile ALONE produces the repaired key — K4 is derived, so the repair writes no key');
ok(!/k4_group_key/.test(G16), 'H3b there is no k4_group_key column in 16_ at all, which is why that is true');

// ================================================================================================================
section('§1 — PREFLIGHT: THE EXACT SUCCESS, AND ITS SCHEMA');
// ================================================================================================================
var PF = pre0.res;
eq(PF.verdict, 'ROUTE_B_REPAIR_READY', 'P1  the production state returns the ONLY success verdict');
eq(PF.predicates_failed, 0, 'P1a with zero failed predicates');
ok(PF.predicates_passed >= 30, 'P1b and ' + PF.predicates_passed + ' passed — a count, not an empty list');
eq(PF.predicates_passed, PF.predicates.length, 'P1c the counts and the list agree');
eq([PF.read_only, PF.db_writes, PF.writer_constructed, PF.writer_calls], [true, 0, false, 0],
  'P1d read_only, and three zeroes');
eq(PF.preflight, undefined, 'P1e there is no ambiguous `preflight: []` field — every check is a named predicate');
// THE SCHEMA, on every row.
var shapeOk = PF.predicates.every(function (p) {
  return typeof p.predicate === 'string' && p.predicate.length > 0
    && Object.prototype.hasOwnProperty.call(p, 'expected')
    && Object.prototype.hasOwnProperty.call(p, 'observed')
    && typeof p.pass === 'boolean';
});
ok(shapeOk, 'P2  every predicate carries { predicate, expected, observed, pass }');
eq(Object.keys(PF.predicates[0]), ['predicate', 'expected', 'observed', 'pass'],
  'P2a in that order, and with no other keys');
// EVERY REQUIRED PREDICATE IS PRESENT, by name.
var names = PF.predicates.map(function (p) { return p.predicate; });
['active_spreadsheet_is_production_db', 'target_header_exists_exactly_once', 'target_line_exists_exactly_once',
 'header_and_line_ids_match_one_row', 'route_b_draft_version_is_2', 'route_b_last_mile_is_parcel',
 'route_b_k4_is_the_parcel_key', 'route_b_updated_at_matches_incident_after',
 'route_b_line_updated_at_matches_incident_after', 'route_b_quantity_unchanged',
 'route_b_shipping_method_unchanged', 'route_b_source_warehouse_id_unchanged',
 'route_b_destination_kind_unchanged', 'route_b_destination_id_unchanged',
 'route_b_destination_marketplace_unchanged', 'route_b_status_unchanged',
 'route_b_generation_type_unchanged', 'route_b_ownership_unchanged', 'route_b_expected_arrival_blank',
 'route_a_present_exactly_once', 'route_a_last_mile_delivery_matches_authorized_after',
 'route_a_draft_version_matches_authorized_after', 'route_a_k4_group_key_matches_authorized_after',
 'route_a_expected_arrival_matches_authorized_after', 'route_a_updated_at_matches_authorized_after',
 'route_a_line_updated_at_matches_authorized_after', 'header_count_is_2', 'line_count_is_2',
 'no_conflicting_target_for_the_repaired_identity', 'writer_not_constructed', 'db_writes_is_zero',
 'writer_calls_is_zero'].forEach(function (n) {
  ok(names.indexOf(n) !== -1, 'P3  predicate present: ' + n);
});
eq(PF.already_compensated, false, 'P4  and the row is NOT already compensated');

// ================================================================================================================
section('§2 — EVERY PREDICATE FAILS INDEPENDENTLY');
// ================================================================================================================
function refuses(label, over, predicate) {
  var w = new World(over);
  var r = w.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res;
  var f = failedNames(r);
  ok(r.verdict === 'STOP' && f.indexOf(predicate) !== -1,
    label + ' — ' + (r.verdict === 'STOP' ? 'STOP on [' + f.join(', ') + ']' : 'DID NOT STOP'));
  eq(w.dbWrites(), 0, label + ' :: and zero cells were touched');
  return { w: w, r: r };
}
refuses('F1  the active book is not production', { activeBook: { getId: function () { return 'SOME-OTHER-BOOK'; },
  getSheetByName: function () { return null; } } }, 'active_spreadsheet_is_production_db');
refuses('F2  Route B version already moved', { bHeader: { draft_version: '3' } }, 'route_b_draft_version_is_2');
refuses('F3  Route B last mile is not parcel', { bHeader: { recommended_last_mile_delivery: 'truck' } },
  'route_b_last_mile_is_parcel');
refuses('F4  Route B K4 is not the parcel key', { bHeader: { recommended_shipping_method: 'sea' } },
  'route_b_k4_is_the_parcel_key');
refuses('F5  Route B updated_at moved since the incident', { bHeader: { updated_at: TS_REPAIR } },
  'route_b_updated_at_matches_incident_after');
refuses('F6  Route B line_updated_at moved since the incident', { bLine: { updated_at: TS_REPAIR } },
  'route_b_line_updated_at_matches_incident_after');
refuses('F7  Route B quantity drifted', { bLine: { planned_qty: '199' } }, 'route_b_quantity_unchanged');
refuses('F8  Route B method drifted', { bHeader: { recommended_shipping_method: 'sea_express' } },
  'route_b_shipping_method_unchanged');
refuses('F9  Route B source drifted', { bLine: { source_warehouse_id: 'WH-OTHER' },
  bHeader: { recommended_source_warehouse_id: 'WH-OTHER' } }, 'route_b_source_warehouse_id_unchanged');
refuses('F10 Route B destination drifted', { bHeader: { recommended_destination_warehouse_id: 'WH-ELSEWHERE' } },
  'route_b_destination_id_unchanged');
refuses('F11 Route B became a marketplace route', { bHeader: { destination_marketplace: 'Amazon' } },
  'route_b_destination_kind_unchanged');
refuses('F12 Route B status drifted', { bHeader: { status: 'site_confirmed' } }, 'route_b_status_unchanged');
refuses('F13 Route B generation_type drifted', { bHeader: { generation_type: 'system_generated' } },
  'route_b_generation_type_unchanged');
refuses('F14 Route B became AI-owned', { bHeader: { generation_run_id: 'RUN-9' } }, 'route_b_ownership_unchanged');
refuses('F15 Route B gained an ETA', { bLine: { expected_arrival: '2026-10-01' } }, 'route_b_expected_arrival_blank');
refuses('F16 Route A last mile drifted', { aHeader: { recommended_last_mile_delivery: 'parcel' } },
  'route_a_last_mile_delivery_matches_authorized_after');
refuses('F17 Route A version drifted', { aHeader: { draft_version: '3' } },
  'route_a_draft_version_matches_authorized_after');
refuses('F18 Route A timestamp drifted', { aHeader: { updated_at: TS_REPAIR } },
  'route_a_updated_at_matches_authorized_after');
refuses('F19 Route A line timestamp drifted', { aLine: { updated_at: TS_REPAIR } },
  'route_a_line_updated_at_matches_authorized_after');
refuses('F20 the target is missing', { dropB: true }, 'target_header_exists_exactly_once');
refuses('F21 a duplicate target header',
  { extraHeaders: [{ allocation_draft_id: B_HEADER, recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
      recommended_shipping_method: 'air', recommended_last_mile_delivery: 'parcel', draft_version: '2' }],
    extraLines: [{ allocation_draft_line_id: B_LINE, allocation_draft_id: B_HEADER, planned_qty: '200' }] },
  'target_header_exists_exactly_once');
refuses('F22 the plan gained a row', {
  extraHeaders: [{ allocation_draft_id: 'SADH-EXTRA', recommended_destination_warehouse_id: 'WH-X',
    recommended_shipping_method: 'air', recommended_last_mile_delivery: 'parcel', draft_version: '1' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-EXTRA', allocation_draft_id: 'SADH-EXTRA', planned_qty: '5' }] },
  'header_count_is_2');
// A CONFLICTING TARGET: another ACTIVE header already wearing the identity the repair would produce.
refuses('F23 another header already holds the repaired identity', {
  extraHeaders: [{ allocation_draft_id: 'SADH-CONFLICT', recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
    recommended_destination_warehouse_code_snapshot: 'AMZLGS', recommended_shipping_method: 'air',
    recommended_last_mile_delivery: '', draft_version: '1' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-CONFLICT', allocation_draft_id: 'SADH-CONFLICT', planned_qty: '10' }] },
  'no_conflicting_target_for_the_repaired_identity');

// ================================================================================================================
section('§3 — THE COMPENSATION: ONE WRITE, ONE ROW, ONE COLUMN');
// ================================================================================================================
var w = new World();
var before = w.rowsOf('shipping_allocation_drafts').concat();
var beforeA = JSON.stringify(w.header(A_HEADER)), beforeAL = JSON.stringify(w.line(A_LINE));
var beforeB = w.header(B_HEADER), beforeBL = w.line(B_LINE);
var EX = w.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
ok(!EX.threw, 'X1  the writer entry point runs' + (EX.threw ? ' — ' + EX.threw.message : ''));
var X = EX.res;
eq(X.verdict, 'ROUTE_B_COMPENSATION_WRITTEN', 'X1a and reports the compensation written');
eq(X.preflight_verdict, 'ROUTE_B_REPAIR_READY', 'X1b having re-run the preflight itself first');
eq(X.writer_calls, 1, 'X2  EXACTLY ONE writer call');
eq(w.calls.writer, 1, 'X2a counted from outside the census, not from its own report');
eq(X.executed, true, 'X2b and it says it executed');

// THE PAYLOAD MANIFEST.
var pl = w.calls.lastPayload;
eq(pl.intent, 'UPDATE_EXISTING_ROUTE', 'X3  intent UPDATE_EXISTING_ROUTE');
eq(pl.header.allocation_draft_id, B_HEADER, 'X3a addressed at Route B\'s header');
eq(pl.lines.length, 1, 'X3b exactly ONE line');
eq(pl.lines[0].allocation_draft_line_id, B_LINE, 'X3c which is Route B\'s line');
eq(pl.header.expected_draft_version, '2', 'X3d guarded by expected_draft_version 2');
eq(pl.expected_draft_version, '2', 'X3e carried at the body level too, as the client does');
eq(pl.header.recommended_last_mile_delivery, '', 'X3f the last mile is sent BLANK');
eq(pl.create_idempotency_key, undefined, 'X3g NO create_idempotency_key — an UPDATE mints nothing');
eq(pl.header.create_idempotency_key, undefined, 'X3h nor on the header');
ok(!('draft_version' in pl.header), 'X4  draft_version is NOT set by hand');
ok(!('k4_group_key' in pl.header), 'X4a nor is any K4 key — it is derived');
ok(!('updated_at' in pl.header) && !('updated_at' in pl.lines[0]),
  'X4b nor a timestamp — the writer owns those');
ok(!('expected_arrival' in pl.lines[0]),
  'X4c and expected_arrival is ABSENT, which is what keeps "do not change the ETA" true rather than intended');
eq(Object.keys(pl.lines[0]).sort(), ['allocation_draft_line_id', 'planned_qty', 'sku'],
  'X4d the line carries the three fields a manual line must have, and nothing else');
// The header is an ECHO: every route field equals what was stored, except the one.
['company', 'country', 'marketplace', 'status', 'recommended_source_warehouse_id',
 'recommended_destination_warehouse_id', 'recommended_shipping_method', 'destination_marketplace'
].forEach(function (f) {
  eq(String(pl.header[f]), String(beforeB[f] || ''), 'X5  echoed unchanged: ' + f);
});

// THE RESULT, IN THE ROWS.
var afterB = w.header(B_HEADER), afterBL = w.line(B_LINE);
eq(String(afterB.recommended_last_mile_delivery), '', 'X6  Route B\'s last mile is BLANK in the sheet');
eq(String(afterB.draft_version), '3', 'X6a the version advanced 2 -> 3, by the writer\'s own +1');
eq(vm.runInContext('ricK4GroupKey_(' + JSON.stringify(afterB) + ')', w.ctx), K4_B_BLANK,
  'X6b and the derived K4 is the blank-last-mile key');
eq(String(afterBL.expected_arrival), '', 'X6c expected_arrival is still blank');
eq(String(afterBL.planned_qty), '200', 'X6d the quantity is untouched');
// EXACTLY WHICH COLUMNS MOVED.
var movedH = Object.keys(afterB).filter(function (k) { return String(afterB[k]) !== String(beforeB[k]); }).sort();
eq(movedH, ['draft_version', 'recommended_last_mile_delivery', 'updated_at', 'updated_by'],
  'X7  the header moved on exactly four columns: the one restored, the version, and the two audit fields');
var movedL = Object.keys(afterBL).filter(function (k) { return String(afterBL[k]) !== String(beforeBL[k]); }).sort();
eq(movedL, ['updated_at'], 'X7a and the LINE moved only its updated_at — no business field was rewritten');
eq(String(afterB.updated_by), 'r6r6r3-compensating-repair',
  'X7b updated_by names the REPAIR, so the row says who did this rather than blaming the page');
// ROUTE A IS BYTE-IDENTICAL.
eq(JSON.stringify(w.header(A_HEADER)), beforeA, 'X8  Route A\'s header is byte-identical, timestamps included');
eq(JSON.stringify(w.line(A_LINE)), beforeAL, 'X8a and so is Route A\'s line');
// NO ROW WAS ADDED OR REPLACED.
eq(w.rowsOf('shipping_allocation_drafts').length, 2, 'X9  still two headers');
eq(w.rowsOf('shipping_allocation_draft_lines').length, 2, 'X9a still two lines');
eq(w.rowsOf('shipping_allocation_drafts').map(function (h) { return h.allocation_draft_id; }).sort(),
  [A_HEADER, B_HEADER].sort(), 'X9b with the same two header ids');
eq(w.rowsOf('shipping_allocation_draft_lines').map(function (l) { return l.allocation_draft_line_id; }).sort(),
  [A_LINE, B_LINE].sort(), 'X9c and the same two line ids — nothing was recreated');
eq(w.H.rows.filter(function (r) { return r[0] === B_HEADER; }).length, 1, 'X9d no duplicate header row');
eq(w.L.rows.filter(function (r) { return r[0] === B_LINE; }).length, 1, 'X9e no duplicate line row');

// THE READBACK CONFIRMS IT.
var RB = w.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res;
eq(RB.verdict, 'ROUTE_B_COMPENSATION_CONFIRMED', 'X10 the readback confirms the compensation');
eq(RB.predicates_failed, 0, 'X10a with zero failed predicates');
ok(RB.predicates_passed >= 25, 'X10b and ' + RB.predicates_passed + ' passed');
eq([RB.read_only, RB.db_writes, RB.writer_constructed, RB.writer_calls], [true, 0, false, 0],
  'X10c and the readback itself is read-only');
ok(/still DISPLAY parcel/.test(RB.ui_note) && /not evidence about the stored column/.test(RB.ui_note),
  'X10d and it warns that the SCREEN may still show parcel, because the lane still has one eligible last mile');
var wDb = w.dbWrites();
w.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK');
eq(w.dbWrites(), wDb, 'X10e running it again changes no cell');

// ================================================================================================================
section('§4 — IDEMPOTENCY: A SECOND EXECUTION WRITES NOTHING');
// ================================================================================================================
var afterFirst = w.snapshot();
var writesAfterFirst = w.dbWrites();
var X2 = w.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(X2.verdict, 'ALREADY_COMPENSATED', 'I1  a second execution returns ALREADY_COMPENSATED');
eq(X2.writer_calls, 0, 'I1a with ZERO writer calls');
eq(X2.executed, false, 'I1b and it did not execute');
eq(w.calls.writer, 1, 'I1c the writer has still been called exactly once in this world\'s whole life');
eq(w.dbWrites(), writesAfterFirst, 'I2  and not one further cell was touched');
eq(w.snapshot(), afterFirst, 'I2a the rows are byte-identical to after the first repair');
ok(/Do NOT run this writer again/.test(X2.next_action) && /READBACK/.test(X2.next_action),
  'I3  and it sends the operator to the readback, never back to the writer');
ok(X2.verdict !== 'ROUTE_B_COMPENSATION_WRITTEN' && X2.verdict !== 'STOP',
  'I4  ALREADY_COMPENSATED is SEPARATELY RECOGNISABLE — not a success and not a refusal');
// And the preflight says the same thing without being asked to write.
var pf2 = w.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res;
eq(pf2.already_compensated, true, 'I5  the preflight flags it too');
eq(pf2.verdict, 'STOP', 'I5a while still refusing, because the row is not the one the repair was designed for');
ok(/ALREADY in the repaired state/.test(pf2.stop_reason),
  'I5b and its reason says so in words, so a STOP here is not mistaken for damage');
// A THIRD state — half-repaired — is neither, and must STOP.
var wHalf = new World({ bHeader: { recommended_last_mile_delivery: '', draft_version: '2' } });
var xHalf = wHalf.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(xHalf.verdict, 'STOP', 'I6  a blank last mile at version 2 is NEITHER state, and it STOPS');
eq(xHalf.writer_calls, 0, 'I6a with zero writer calls');
eq(wHalf.dbWrites(), 0, 'I6b and zero cells touched');

// ================================================================================================================
section('§5 — THE WRITER FAILS, AND THE TOOL DOES NOT RETRY');
// ================================================================================================================
// EXCEPTION BEFORE COMMIT.
var wThrow = new World({ throwOnWrite: true });
var xThrow = wThrow.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(xThrow.verdict, 'ACK_UNKNOWN', 'E1  an exception from the writer is ACK_UNKNOWN, never "failed"');
eq(xThrow.writer_calls, 1, 'E1a the call happened once');
eq(wThrow.calls.writer, 1, 'E1b and was NOT retried');
eq(wThrow.dbWrites(), 0, 'E1c this particular exception committed nothing, which the tool cannot know');
eq(xThrow.executed, false, 'E1d so it does not claim to have executed');
ok(/Do NOT run this writer again/.test(xThrow.next_action) && /READBACK/.test(xThrow.next_action),
  'E1e and the operator is sent to the readback');
// UNKNOWN RESULT AFTER COMMIT — the write landed and the answer was lost.
var wLost = new World({ loseAckAfterCommit: true });
var xLost = wLost.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(xLost.verdict, 'ACK_UNKNOWN', 'E2  a lost acknowledgement is ACK_UNKNOWN');
eq(wLost.calls.writer, 1, 'E2a one call, not retried');
eq(String(wLost.header(B_HEADER).recommended_last_mile_delivery), '',
  'E2b and the commit DID land — which is exactly why a retry would have been a second write');
eq(String(wLost.header(B_HEADER).draft_version), '3', 'E2c at version 3');
// The readback is what settles it, and it settles it correctly.
var rbLost = wLost.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res;
eq(rbLost.verdict, 'ROUTE_B_COMPENSATION_CONFIRMED', 'E3  the readback proves the lost write committed');
// And the writer, run again after a lost ack, recognises the world instead of writing.
var xLost2 = wLost.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(xLost2.verdict, 'ALREADY_COMPENSATED', 'E3a and a second attempt after a lost ack writes nothing');
eq(wLost.calls.writer, 1, 'E3b still one call in total');
// A VERSION CONFLICT AT THE WRITER. The preflight passes and the row moves underneath it: 16_ refuses.
var wRace = new World();
vm.runInContext('(function(){ var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("shipping_allocation_drafts");'
  + ' var hdr = sh.getDataRange().getValues()[0]; var vc = hdr.indexOf("draft_version");'
  + ' var ic = hdr.indexOf("allocation_draft_id");'
  + ' var rows = sh.getDataRange().getValues();'
  + ' for (var i=1;i<rows.length;i++){ if (rows[i][ic] === "' + B_HEADER + '") { __race = i + 1; } } })()', wRace.ctx);
// Re-run the preflight FIRST (it passes), then move the version, then execute — the internal re-run catches it.
eq(wRace.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res.verdict, 'ROUTE_B_REPAIR_READY',
  'E4  a world that is ready reports ready');
var raceRow = wRace.H.rows.filter(function (r) { return r[0] === B_HEADER; })[0];
raceRow[HDR_FULL.indexOf('draft_version')] = '5';
wRace.H.writes = 0;
var xRace = wRace.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(xRace.verdict, 'STOP', 'E4a and once the version moves underneath it, the INTERNAL re-run stops it');
eq(xRace.writer_calls, 0, 'E4b before any writer call');
eq(wRace.dbWrites(), 0, 'E4c with zero cells touched');
ok((xRace.failed_predicates || []).some(function (p) { return p.predicate === 'route_b_draft_version_is_2'; }),
  'E4e naming the version predicate that failed');
// A LOCK THAT CANNOT BE TAKEN is a refusal, not a retry.
var wLock = new World({ lockUnavailable: true });
var xLock = wLock.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res;
eq(wLock.calls.writer, 1, 'E5  a lock failure still counts as one call');
eq(wLock.dbWrites(), 0, 'E5a and wrote nothing');
ok(xLock.verdict === 'ACK_UNKNOWN' || xLock.verdict === 'REFUSED_ZERO_WRITE',
  'E5b classified as ' + xLock.verdict + ' — never as success');

// ================================================================================================================
section('§6 — THE READBACK REFUSES WHAT IT SHOULD');
// ================================================================================================================
function rbRefuses(label, over, predicate) {
  var ww = new World(over);
  var r = ww.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res;
  var f = failedNames(r);
  ok(r.verdict === 'STOP' && f.indexOf(predicate) !== -1,
    label + ' — ' + (r.verdict === 'STOP' ? 'STOP on [' + f.slice(0, 3).join(', ') + ']' : 'DID NOT STOP'));
  eq(ww.dbWrites(), 0, label + ' :: and the readback wrote nothing');
}
rbRefuses('B1  the repair has not happened yet', {}, 'route_b_last_mile_is_blank');
rbRefuses('B2  blank but still at version 2', { bHeader: { recommended_last_mile_delivery: '' } },
  'route_b_draft_version_is_exactly_3');
rbRefuses('B3  version 3 but the timestamp never moved',
  { bHeader: { recommended_last_mile_delivery: '', draft_version: '3' },
    bLine: { updated_at: TS_REPAIR } }, 'route_b_updated_at_advanced_past_the_incident');
rbRefuses('B4  Route A moved during the repair',
  { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR }, aHeader: { updated_at: TS_REPAIR } },
  'route_a_updated_at_unchanged');
rbRefuses('B5  Route B lost a business field',
  { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR, planned_qty: '150' } }, 'route_b_quantity_unchanged');
rbRefuses('B6  an ETA appeared',
  { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR, expected_arrival: '2026-11-01' } }, 'route_b_expected_arrival_still_blank');
rbRefuses('B7  a third row joined the plan',
  { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR },
    extraHeaders: [{ allocation_draft_id: 'SADH-NEW', recommended_destination_warehouse_id: 'WH-N',
      recommended_shipping_method: 'air', recommended_last_mile_delivery: 'parcel', draft_version: '1' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-NEW', allocation_draft_id: 'SADH-NEW', planned_qty: '7' }] },
  'header_count_still_2');

// ================================================================================================================
section('§7 — NOTHING ELSE IN THE BOOK IS TOUCHED');
// ================================================================================================================
var wOther = new World();
wOther.sheets['carrier_rate_cards'] = new FakeSheet(['carrier_rate_card_id', 'shipping_method']);
wOther.sheets['carrier_rate_cards'].rows.push(['CRC-1', 'air']);
wOther.sheets['shipping_plans'] = new FakeSheet(['shipping_plan_id']);
wOther.sheets['shipping_plans'].rows.push(['SP-1']);
var otherBefore = JSON.stringify({ c: wOther.sheets['carrier_rate_cards'].rows, s: wOther.sheets['shipping_plans'].rows });
eq(wOther.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.verdict, 'ROUTE_B_COMPENSATION_WRITTEN',
  'O1  the repair runs');
eq(JSON.stringify({ c: wOther.sheets['carrier_rate_cards'].rows, s: wOther.sheets['shipping_plans'].rows }), otherBefore,
  'O2  and carrier_rate_cards and shipping_plans are byte-identical');
eq(wOther.sheets['carrier_rate_cards'].writes + wOther.sheets['shipping_plans'].writes, 0,
  'O2a not one write primitive reached another table');

// ================================================================================================================
section('§8 — THE SOURCE CONTRACT');
// ================================================================================================================
var PFSRC = extractFn(CENSUS, 'RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT');
var EXSRC = extractFn(CENSUS, 'RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
var RBSRC = extractFn(CENSUS, 'RUN_R6R6R3_ROUTE_B_REPAIR_READBACK');
['setValue', 'appendRow', 'deleteRow', 'clearContent', 'handleUpsert', 'sadAtomicUpsertCore_'].forEach(function (bad) {
  ok(code(PFSRC).indexOf(bad) === -1, 'S1  the PREFLIGHT cannot ' + bad);
  ok(code(RBSRC).indexOf(bad) === -1, 'S1a the READBACK cannot ' + bad);
});
eq((code(CENSUS).match(/handleUpsertShippingAllocationDraftAtomic_\(/g) || []).length, 1,
  'S2  the whole file contains exactly ONE call to the atomic writer');
ok(code(EXSRC).indexOf('handleUpsertShippingAllocationDraftAtomic_(') !== -1,
  'S2a and it is inside EXECUTE_ONCE');
['deleteRow', 'clearContent', 'setValue('].forEach(function (bad) {
  ok(code(EXSRC).indexOf(bad) === -1, 'S3  even the writer entry point cannot ' + bad + ' directly');
});
ok(!/for\s*\(|while\s*\(/.test(code(EXSRC).slice(code(EXSRC).indexOf('handleUpsertShippingAllocationDraftAtomic_('))),
  'S4  there is no loop after the writer call — a retry cannot be reached by construction');
ok(/RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT\(\)/.test(EXSRC),
  'S5  and it re-runs the PREFLIGHT ITSELF, not a copy of its rules');
ok(/out\.writer_calls = 1;/.test(EXSRC) && EXSRC.indexOf('out.writer_calls = 1;') < EXSRC.indexOf('handleUpsertShippingAllocationDraftAtomic_('),
  'S6  the call counter is set BEFORE the call, so a throw cannot leave it reading zero');

// ================================================================================================================
section('§9 — MUTANTS');
// ================================================================================================================
function worldWith(src, over) { return new World(over || {}, src); }
mut('N1  the internal preflight re-run removed, so a stale verdict authorises the write', function () {
  var m = swap(CENSUS, '  try { pf = RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT(); }',
    '  try { pf = { verdict: "ROUTE_B_REPAIR_READY", predicates: [], predicates_passed: 0, predicates_failed: 0, already_compensated: false }; }');
  var bad = worldWith(m, { bHeader: { draft_version: '5' } });
  var good = worldWith(CENSUS, { bHeader: { draft_version: '5' } });
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.writer_calls === 1
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.writer_calls === 0;
});
mut('N2  the readiness gate inverted, so a STOP still writes', function () {
  var m = swap(CENSUS, "  if (pf.verdict !== 'ROUTE_B_REPAIR_READY') {", '  if (false) {');
  var bad = worldWith(m, { aHeader: { updated_at: TS_REPAIR } });
  var good = worldWith(CENSUS, { aHeader: { updated_at: TS_REPAIR } });
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.writer_calls === 1
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.writer_calls === 0;
});
mut('N3  the ALREADY_COMPENSATED check removed, so a repaired row is written a second time', function () {
  var m = swap(CENSUS, '  if (pf.already_compensated === true) {', '  if (false) {');
  // Start from an ALREADY repaired world.
  var over = { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR } };
  var bad = worldWith(m, over), good = worldWith(CENSUS, over);
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.verdict !== 'ALREADY_COMPENSATED'
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE').res.verdict === 'ALREADY_COMPENSATED';
});
mut('N4  the version guard dropped from the payload, so a raced row is overwritten', function () {
  // CRLF: a multi-line anchor in this repository must carry the carriage returns.
  var CR = String.fromCharCode(13, 10);
  var m = swap(CENSUS, '    expected_draft_version: R6R6R3_B_UNAUTHORIZED_.draft_version,' + CR
    + '    created_by: R6R6R3_ACTOR_', '    created_by: R6R6R3_ACTOR_');
  var bad = worldWith(m), good = worldWith(CENSUS);
  bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  return bad.calls.lastPayload.header.expected_draft_version === undefined
    && good.calls.lastPayload.header.expected_draft_version === '2';
});
mut('N5  a create_idempotency_key added, turning an UPDATE into something that could mint', function () {
  var CR = String.fromCharCode(13, 10);
  var m = swap(CENSUS, '    expected_draft_version: R6R6R3_B_UNAUTHORIZED_.draft_version' + CR,
    "    expected_draft_version: R6R6R3_B_UNAUTHORIZED_.draft_version," + CR
    + "    create_idempotency_key: 'CK-1'" + CR);
  var bad = worldWith(m), good = worldWith(CENSUS);
  bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  return bad.calls.lastPayload.create_idempotency_key === 'CK-1'
    && good.calls.lastPayload.create_idempotency_key === undefined;
});
mut('N6  the ETA sent along, so a repair rewrites a field it was told not to touch', function () {
  var CR = String.fromCharCode(13, 10);
  var m = swap(CENSUS, '    planned_qty: CENSUS_str_(lRow.planned_qty)' + CR + '  };',
    "    planned_qty: CENSUS_str_(lRow.planned_qty)," + CR + "    expected_arrival: '2026-12-01'" + CR + '  };');
  var bad = worldWith(m), good = worldWith(CENSUS);
  bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  good.run('RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE');
  return String(bad.line(B_LINE).expected_arrival) === '2026-12-01'
    && String(good.line(B_LINE).expected_arrival) === '';
});
mut('N7  the active-book predicate removed, so the preflight validates one database and the write lands in another', function () {
  var m = swap(CENSUS, "  CENSUS_r6r6r3P_(out, 'active_spreadsheet_is_production_db',", "  (function(){})(");
  var over = { activeBook: { getId: function () { return 'WRONG'; }, getSheetByName: function () { return null; } } };
  var bad = worldWith(m, over), good = worldWith(CENSUS, over);
  var b = bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res;
  var g = good.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res;
  return b.verdict === 'ROUTE_B_REPAIR_READY' && g.verdict === 'STOP';
});
mut('N8  the readback accepting a timestamp that never moved', function () {
  var m = swap(CENSUS, '      now !== null && before !== null && now > before);', '      true);');
  var over = { bHeader: { recommended_last_mile_delivery: '', draft_version: '3' } };
  var bad = worldWith(m, over), good = worldWith(CENSUS, over);
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res.verdict === 'ROUTE_B_COMPENSATION_CONFIRMED'
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res.verdict === 'STOP';
});
mut('N9  the readback no longer checking Route A', function () {
  var m = swap(CENSUS, "    CENSUS_r6r6r3P_(out, 'route_a_' + f + '_unchanged'", "    (function(){})(0");
  var over = { bHeader: { recommended_last_mile_delivery: '', draft_version: '3', updated_at: TS_REPAIR },
    bLine: { updated_at: TS_REPAIR }, aHeader: { recommended_last_mile_delivery: 'parcel' } };
  var bad = worldWith(m, over), good = worldWith(CENSUS, over);
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res.verdict === 'ROUTE_B_COMPENSATION_CONFIRMED'
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_READBACK').res.verdict === 'STOP';
});
mut('N10 a predicate that reports pass without being counted', function () {
  var m = swap(CENSUS, '  if (pass) out.predicates_passed++; else out.predicates_failed++;', '  out.predicates_passed++;');
  var over = { bHeader: { draft_version: '3' } };
  var bad = worldWith(m, over), good = worldWith(CENSUS, over);
  return bad.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res.verdict === 'ROUTE_B_REPAIR_READY'
    && good.run('RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT').res.verdict === 'STOP';
});

// ================================================================================================================
section('DEPLOYMENT');
// ================================================================================================================
// R6-R6-R4 — ANOTHER EQUALITY WITH NOW, of exactly the kind R6-R6-R3 removed from the R6-R6-R2 suite and
// then reintroduced here. A stamp records the round a file last CHANGED; every later round that touches
// the census moves it, and this suite's own claim is only that the census changed in R6-R6-R3 OR LATER.
var _d1Declared = (CENSUS.match(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/) || [])[1];
ok(RO.OWNER_STAMPS.indexOf(_d1Declared) >= RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R3'),
  'D1  the diagnostic declares R6-R6-R3 or a later round (' + _d1Declared + ')');
ok(RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R3') !== -1,
  'D1a and the ledger still records the round this suite belongs to');
ok(RO.BUILD_STAMP_RE.test(_d1Declared), 'D1b and whatever it declares is a well-formed stamp');
// R6-R6-R4 — THIS PINNED currentAppToken(), WHICH IS AN EQUALITY WITH NOW. The claim this suite owns is
// that R6-R6-R3 changed no frontend file and therefore introduced NO token of its own; pinning whatever
// happened to be current said that only while R6-R6-R3 was the last round, and R6-R6-R4 does move a
// frontend file. Stated directly instead, so it stays true for every round that follows.
eq(RO.ROUND_TOKENS.filter(function (t) { return /r6r6r3/i.test(t); }), [],
  'D2  R6-R6-R3 introduced NO cache token — it changed no frontend file, and reused the one R6-R6-R2 published');
ok(RO.ROUND_TOKENS.indexOf('fc1be3r4a2r1r6r6r2-rowisolation-20260906') !== -1,
  'D2a and the token it reused is still in the ledger');
eq(G16.indexOf('R6-R6-R3'), -1, 'D3  16_ is untouched: the repair uses the shipped writer exactly as it is');
eq(read('assets/specs/active/apps-script/01_router.gs').indexOf('R6-R6-R3'), -1,
  'D3a and so is the router — nothing new is reachable over HTTP');
ok(/captured_for_build: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1-B1'/.test(CENSUS),
  'D4  the frozen capture still names the build it was captured for');

console.log('\npassed ' + pass + '  failed ' + fail + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);
})();
