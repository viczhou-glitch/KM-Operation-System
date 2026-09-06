// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4 — THE POST-REPAIR SINGLE-ROW SAVE, VERIFIED AGAINST ITS OWN BASELINE.
//
// R6-R6-R2 stopped the page writing a route nobody touched. R6-R6-R3 put the one it had already written back.
// What is left is the question neither round could answer: does a single-row Save, performed today through the
// ordinary UI, move exactly one row?
//
// THREE PROPERTIES THIS SUITE EXISTS TO PIN.
//
// (1) THE BASELINE IS NEW, AND THE OLD ONES ARE REFUSED. R6-R6-R1's freeze describes a plan where Route A had
//     no last mile and Route B was at version 1; R6-R6-R3's describes the moment Route B still held `parcel`.
//     Both are correct records of moments that have passed. A readiness that accepted either would be
//     checking today's database against last week's, so both are exercised here and both must STOP.
//
// (2) ROUTE B IS PROVEN NOT TO HAVE MOVED WITHOUT ITS TIMESTAMP. Nobody supplied the two instants the
//     compensation stamped, and this round does not invent them. What replaces the equality gate is three
//     independent facts — the version is still 3, the recorded actor is still the repair, and Route B's
//     stamps PREDATE Route A's new one — and each is exercised on its own.
//
// (3) A DISPLAYED LAST MILE IS NOT A STORED ONE. Every verdict below is read from the database through the
//     real census, never from a rendered cell.
//
// Every write in this suite goes through 16_'s REAL handleUpsertShippingAllocationDraftAtomic_ against a
// mutable sheet double, and every verdict through the REAL census entry points reading the same rows.
//
// Run: node assets/tests/post-repair-single-row-save-verification-f1-7n-fc-1b-e3-r4-a2-r1-r6-r6-r4.test.js

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

var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var G01 = read('assets/specs/active/apps-script/01_router.gs');
var BUNDLE = read('assets/specs/active/apps-script/90_generated_supply_planning_bundle.gs');
var DBAPI = read('assets/js/api/operation-system-db-api.js');
var TRANSPORT = read('assets/js/api/km-transport.js');
var PAGE = read('assets/js/pages/inventory-replenishment.js');
var INDEX = read('index.html');
var RO = require('./_release-order.js');

var SKU = 'CO1100-R';
var A_HEADER = 'SADH-K4-38523A90', A_LINE = 'SADL-K2-92B8BAD2';
var B_HEADER = 'SADH-K4-A3872518', B_LINE = 'SADL-K2-344FB2B2';
// The audit trail as production left it after the two rounds. Route A has not been written since the
// incident; Route B was last written by the compensation, at an instant nobody reported.
// R6-R6-R4-R2 — STAGE ONE HAS HAPPENED. TS_A is the stamp the INCIDENT left and TS_A_NOW is the stamp
// stage one wrote; Route A is at parcel / version 3, and the authorized change is now the way back.
var TS_A = 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)';
var TS_A_NOW = 'Sun Sep 06 2026 13:05:49 GMT+0800 (Taiwan Standard Time)';
var TS_INCIDENT_B = 'Sun Sep 06 2026 08:28:04 GMT+0800 (Taiwan Standard Time)';
// R6-R6-R4-R1 — the instant the compensation actually stamped, read off production. R6-R6-R4 used a
// plausible placeholder here because the real one had not been reported and the freeze carried null; both
// are the same literal now, which is what turns a derived gate into an equality gate.
var TS_COMPENSATED = 'Sun Sep 06 2026 09:56:04 GMT+0800 (Taiwan Standard Time)';
// The SAME INSTANT written three ways. A zone-name spelling is not a difference, and a comparison that
// thought it was would STOP a correct row over the way a clock printed itself.
var TS_SAME_OTHER_ZONE_NAME = 'Sun Sep 06 2026 09:56:04 GMT+0800 (CST)';
var TS_SAME_AS_UTC = '2026-09-06T01:56:04.000Z';
var TS_ONE_SECOND_LATER = 'Sun Sep 06 2026 09:56:05 GMT+0800 (Taiwan Standard Time)';
var TS_SAVE = 'Sun Sep 06 2026 14:30:00 GMT+0800 (Taiwan Standard Time)';
var PAGE_ACTOR = 'inventory-replenishment';
var REPAIR_ACTOR = 'r6r6r3-compensating-repair';
var K4_A_TRUCK = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|truck|';
var K4_A_PARCEL = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|parcel|';
var K4_B_BLANK = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air||';
var K4_B_PARCEL = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air|parcel|';

// ================================================================================================================
// THE MUTABLE DOUBLE. One book reachable both ways — openById (how the census reads) and getActiveSpreadsheet
// (how the writer writes) — because in production they are the same book.
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

// ---- production AS IT STANDS AFTER THE COMPENSATION ------------------------------------------------------------
function headerRow(o) { var d = {
  allocation_draft_id: '', planning_cycle: '', source_page: 'inventory_replenishment',
  company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
  recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', recommended_destination_warehouse_id: '',
  recommended_source_warehouse_code_snapshot: 'CNYOUXIN', recommended_destination_warehouse_code_snapshot: '',
  recommendation_group_no: '', recommended_shipping_method: '', recommended_last_mile_delivery: '',
  generation_type: 'user_created', draft_version: '', created_by: PAGE_ACTOR,
  created_at: TS_A, updated_by: PAGE_ACTOR, updated_at: '', destination_marketplace: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
function lineRow(o) { var d = {
  allocation_draft_line_id: '', allocation_draft_id: '', sku: SKU, planned_qty: '',
  source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', source_warehouse_code_snapshot: 'CNYOUXIN',
  line_status: '', created_at: TS_A, updated_at: '', expected_arrival: '' };
  Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }

var PROD_A_H = headerRow({ allocation_draft_id: A_HEADER, destination_marketplace: 'Amazon',
  recommended_shipping_method: 'sea_express', recommended_last_mile_delivery: 'parcel',
  draft_version: '3', updated_at: TS_A_NOW, updated_by: PAGE_ACTOR });
var PROD_A_L = lineRow({ allocation_draft_line_id: A_LINE, allocation_draft_id: A_HEADER,
  planned_qty: '320', updated_at: TS_A_NOW });
// Route B AFTER the compensation: blank last mile, version 3, and the repair as the recorded actor.
var PROD_B_H = headerRow({ allocation_draft_id: B_HEADER,
  recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
  recommended_destination_warehouse_code_snapshot: 'AMZLGS',
  recommended_shipping_method: 'air', recommended_last_mile_delivery: '',
  draft_version: '3', updated_at: TS_COMPENSATED, updated_by: REPAIR_ACTOR });
var PROD_B_L = lineRow({ allocation_draft_line_id: B_LINE, allocation_draft_id: B_HEADER,
  planned_qty: '200', updated_at: TS_COMPENSATED });

// ================================================================================================================
// THE WORLD.
// ================================================================================================================
function World(over, censusSrc, g16Src) {
  over = over || {};
  var sheets = {};
  var H = new FakeSheet(HDR_FULL), L = new FakeSheet(LINE_FULL);
  sheets['shipping_allocation_drafts'] = H;
  sheets['shipping_allocation_draft_lines'] = L;
  function put(sheet, headers, obj) { sheet.rows.push(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })); }
  function merge(base, o) { var d = {}; Object.keys(base).forEach(function (k) { d[k] = base[k]; });
    Object.keys(o || {}).forEach(function (k) { d[k] = o[k]; }); return d; }
  // Route B first on purpose: list order must prove nothing.
  if (!over.dropB) put(L, LINE_FULL, merge(PROD_B_L, over.bLine));
  if (!over.dropB) put(H, HDR_FULL, merge(PROD_B_H, over.bHeader));
  if (!over.dropA) put(L, LINE_FULL, merge(PROD_A_L, over.aLine));
  if (!over.dropA) put(H, HDR_FULL, merge(PROD_A_H, over.aHeader));
  (over.extraHeaders || []).forEach(function (o) { put(H, HDR_FULL, headerRow(o)); });
  (over.extraLines || []).forEach(function (o) { put(L, LINE_FULL, lineRow(o)); });
  H.writes = 0; L.writes = 0;

  var LOG = [];
  var calls = { writer: 0, payloads: [] };
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
  sb.LockService = { getScriptLock: function () { return {
    tryLock: function () { return over.lockUnavailable !== true; }, releaseLock: function () {} }; } };
  var uu = 0;
  sb.Utilities = { getUuid: function () { uu++; return ('UUID' + uu + 'ABCDEF0123456789').substring(0, 16); } };
  sb.Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };

  var ctx = vm.createContext(sb);
  vm.runInContext(BUNDLE, ctx);
  vm.runInContext([
    'function prodExpectedDbId_() { return "PROD-BOOK"; }',
    'function prodAssertDbTarget_(ss) {',
    '  if (!ss || (typeof ss.getId === "function" && ss.getId() !== prodExpectedDbId_())) {',
    '    throw new Error("PRODUCTION_SAFETY:WRONG_SPREADSHEET_TARGET"); }',
    '  return true; }',
    'function procurementTimestamp_() { return __NOW; }',
    'function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ""; }',
    'function prodRequireSheet_(ss, n) { return ss.getSheetByName(n); }',
    'function sheetEnsureColumns_() { return null; }',
    'function jsonResponse_(o) { var s = JSON.stringify(o); return { getContent: function () { return s; } }; }'
  ].join(NL), ctx);
  sb.__NOW = over.now || TS_SAVE;
  vm.runInContext([
    (/var RIC_CANONICAL_SERVICES_ = [^;]+;/.exec(G69) || [''])[0],
    (/var RIC_SERVICE_LABELS_ = \{[\s\S]*?\};/.exec(G69) || [''])[0],
    extractVar(G69, 'RIC_DESTINATION_TYPES_'),
    extractVar(G69, 'RIC_K4_GROUP_DIMENSIONS_'),
    extractFn(G69, 'ricDestinationIdentity_'),
    extractFn(G69, 'ricCanonicalService_'),
    extractFn(G69, 'ricK4GroupKey_'),
    extractFn(G69, 'ricK4DeterministicHeaderId_'),
    extractVar(G69, 'RIC_SCHEMA_REFUSALS_'),
    extractFn(G69, 'ricRoutePersistability_')
  ].join(NL), ctx);
  vm.runInContext([extractFn(G13, 'procurementEnsureSheet_'), extractFn(G13, 'procurementAppendByHeader_'),
    extractFn(G13, 'procurementFindRow_')].join(NL), ctx);
  vm.runInContext(SAD_CONSTS.map(function (v) { return extractVar(g16Src || G16, v); }).join(NL), ctx);
  vm.runInContext('var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ = '
    + 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);', ctx);
  var _G16 = g16Src || G16;
  vm.runInContext(SAD_FNS.map(function (f) { return extractFn(_G16, f); }).join(NL), ctx);
  sb.__tally = function (payload) { calls.writer++; calls.payloads.push(payload); };
  vm.runInContext([
    'var __realAtomic = handleUpsertShippingAllocationDraftAtomic_;',
    'handleUpsertShippingAllocationDraftAtomic_ = function (body) {',
    '  __tally(JSON.parse(JSON.stringify(body || {})));',
    '  return __realAtomic(body); };'
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
// A raw call into the writer, for the cases where the payload IS the thing under test.
World.prototype.write = function (body) {
  var out = null, threw = null;
  try { out = vm.runInContext('handleUpsertShippingAllocationDraftAtomic_(' + JSON.stringify(body) + ')', this.ctx); }
  catch (e) { threw = e; }
  var parsed = null;
  try { parsed = JSON.parse(out && out.getContent ? out.getContent() : JSON.stringify(out || {})); } catch (e2) {}
  return { parsed: parsed, threw: threw };
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
World.prototype.k4 = function (id) { return vm.runInContext('ricK4GroupKey_(' + JSON.stringify(this.header(id)) + ')', this.ctx); };

// THE SAVE. The payload is echoed from the live row with one field replaced — the shape 16_'s UPDATE branch
// consumes, and the shape a single-route Execution Plan Save produces. `expected_arrival` is deliberately
// absent from the line: sadRegenerateLinePatch_ adopts an incoming ETA only when non-blank, so omitting it is
// what keeps 'the Save does not touch the ETA' true rather than merely intended.
// R6-R6-R4-R2 — THE PAYLOAD DECLARES WHAT IT READ. `expected` defaults to the row's CURRENT version,
// which is what a correctly-hydrated page sends; pass null to reproduce the defect this round found, or a
// wrong number to reproduce a genuinely stale page.
World.prototype.save = function (headerId, lineId, lastMile, actor, expected) {
  var h = this.header(headerId), l = this.line(lineId);
  var payload = {
    intent: 'UPDATE_EXISTING_ROUTE',
    header: {
      allocation_draft_id: headerId,
      company: h.company, country: h.country, marketplace: h.marketplace, status: h.status || 'draft',
      recommended_source_warehouse_id: h.recommended_source_warehouse_id,
      recommended_destination_warehouse_id: h.recommended_destination_warehouse_id,
      recommended_source_warehouse_code_snapshot: h.recommended_source_warehouse_code_snapshot,
      recommended_destination_warehouse_code_snapshot: h.recommended_destination_warehouse_code_snapshot,
      recommendation_group_no: h.recommendation_group_no,
      recommended_shipping_method: h.recommended_shipping_method,
      destination_marketplace: h.destination_marketplace,
      recommended_last_mile_delivery: lastMile,
      created_by: actor || PAGE_ACTOR
    },
    lines: [{ allocation_draft_line_id: lineId, sku: l.sku, planned_qty: String(l.planned_qty) }]
  };
  var _exp = (expected === undefined) ? String(h.draft_version) : expected;
  if (_exp !== null) { payload.header.expected_draft_version = _exp; payload.expected_draft_version = _exp; }
  var out = null, threw = null;
  try { out = vm.runInContext('handleUpsertShippingAllocationDraftAtomic_(' + JSON.stringify(payload) + ')', this.ctx); }
  catch (e) { threw = e; }
  var parsed = null;
  try { parsed = JSON.parse(out && out.getContent ? out.getContent() : JSON.stringify(out || {})); } catch (e2) { parsed = null; }
  return { payload: payload, parsed: parsed, threw: threw };
};
function failedNames(r) { return (r.predicates || []).filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }); }
function has(r, name) { return failedNames(r).indexOf(name) !== -1; }

(function () {

// ================================================================================================================
section('§0 — THE HARNESS IS THE REAL THING');
// ================================================================================================================
var w0 = new World();
var rd0 = w0.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS');
ok(!rd0.threw, 'H1  the readiness runs against the real census' + (rd0.threw ? ' — ' + rd0.threw.message : ''));
eq(w0.dbWrites(), 0, 'H2  and the fixture plus a readiness touched no cell');
eq(w0.k4(A_HEADER), K4_A_PARCEL, 'H3  69_ derives Route A\'s CURRENT key from the row — parcel, after stage one');
eq(w0.k4(B_HEADER), K4_B_BLANK, 'H3a and Route B\'s as the blank-last-mile key the compensation restored');
ok(!/k4_group_key/.test(G16), 'H3b there is still no k4_group_key column: the key is derived, never stored');
// The line table has no updated_by, which is why §6's actor gate is a HEADER gate and says so.
ok(!/'line_status', 'override_reason', 'note', 'created_at', 'updated_at', 'updated_by'/.test(G16),
  'H4  the LINE schema carries no updated_by — a route has exactly one recorded actor, on its header');
ok(/var actor = String\(\(body && body\.created_by\) \|\| 'inventory-replenishment'\)/.test(G16),
  'H4a and 16_ resolves that actor as body.created_by or the page default, which is what makes it evidence');
ok(!/created_by/.test(PAGE), 'H4b the page sends NO created_by, so its writes carry the default');

// ================================================================================================================
section('§3 — READINESS: THE EXACT SUCCESS AGAINST THE NEW BASELINE');
// ================================================================================================================
var RD = rd0.res;
eq(RD.verdict, 'SINGLE_ROW_SAVE_READY', 'R1  the post-repair state returns the ONLY success verdict');
eq(RD.predicates_failed, 0, 'R1a with zero failed predicates');
ok(RD.predicates_passed >= 40, 'R1b and ' + RD.predicates_passed + ' passed — a count, not an empty list');
eq(RD.predicates_passed, RD.predicates.length, 'R1c the counts and the list agree');
eq([RD.read_only, RD.db_writes, RD.writer_constructed, RD.writer_calls, RD.submit_calls, RD.reservation_writes],
  [true, 0, false, 0, 0, 0], 'R1d read_only, and five zeroes');
eq(Object.keys(RD.predicates[0]), ['predicate', 'expected', 'observed', 'pass'],
  'R2  every predicate row is { predicate, expected, observed, pass } and nothing else');
ok(RD.predicates.every(function (p) { return typeof p.predicate === 'string' && typeof p.pass === 'boolean'; }),
  'R2a on every row');
// R6-R6-R4-R1 — THE GAP IS CLOSED. Production reported the two instants, they are frozen, and NOTHING
// falls back to 'not checked' — which is the answer that once let an unrelated route move unnoticed.
eq(RD.snapshot_gaps, [], 'R3  snapshot_gaps is EMPTY: every frozen field of both rows is compared');
ok(RD.predicates.some(function (p) { return p.predicate === 'route_b_updated_at_unchanged' && p.pass
  && p.expected === TS_COMPENSATED; }),
  'R3a route_b.updated_at is an EQUALITY gate against the production literal');
ok(RD.predicates.some(function (p) { return p.predicate === 'route_b_line_updated_at_unchanged' && p.pass
  && p.expected === TS_COMPENSATED; }),
  'R3b and so is route_b.line_updated_at');
// The three derived facts are KEPT. They answer a different question — 'could anything have written this
// since?' rather than 'is this the row we froze?' — and they cost no read, so they are not retired.
eq(RD.derived_gates, ['route_b_updated_at_is_after_the_compensation_write',
  'route_b_line_updated_at_is_after_the_compensation_write', 'route_b_header_and_line_instants_agree'],
  'R3c the three derived gates still run, ALONGSIDE the equality gates rather than instead of them');
RD.derived_gates.forEach(function (n) {
  ok(RD.predicates.some(function (p) { return p.predicate === n && p.pass; }), 'R3c-' + n);
});
ok(RD.frozen_snapshot_source.indexOf(TS_COMPENSATED) !== -1,
  'R3d and the paste-ready literal agrees with what is frozen');
// The three self-checks are predicates, not prose.
['writer_not_constructed', 'db_writes_is_zero', 'writer_calls_is_zero'].forEach(function (n, i) {
  ok(RD.predicates.some(function (p) { return p.predicate === n && p.pass; }), 'R4' + '.abc'[i] + ' ' + n);
});
eq(RD.already_saved, false, 'R5  and the authorized edit has not already been performed');
eq(RD.stage_two_authorized, false, 'R5a stage two is not authorized by a readiness that succeeded');

// The plan-shape and write-path predicates, each present and passing.
['current_plan_total_is_520', 'visible_route_rows_is_2', 'header_count_is_2', 'line_count_is_2',
 'no_ambiguous_save_target', 'route_a_save_target_is_its_own_header_reuse',
 'route_b_save_target_would_not_be_minted'].forEach(function (n, i) {
  ok(RD.predicates.some(function (p) { return p.predicate === n && p.pass; }), 'R6' + '.abcdefg'[i] + ' ' + n);
});

// ================================================================================================================
section('§2/§5 — THE TWO FROZEN INSTANTS, AS EQUALITY GATES');
// ================================================================================================================
// ONE SECOND IS A DIFFERENCE. Each field on its own, because a gate that only fires when both move is not
// two gates.
[['bHeader', 'updated_at', 'route_b_updated_at_unchanged'],
 ['bLine', 'updated_at', 'route_b_line_updated_at_unchanged']].forEach(function (c, i) {
  var over = {}; over[c[0]] = {}; over[c[0]][c[1]] = TS_ONE_SECOND_LATER;
  var w = new World(over);
  var r = w.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  eq([r.verdict, has(r, c[2]), w.dbWrites()], ['STOP', true, 0],
    'G' + (i + 1) + '  one second on ' + c[2] + ' STOPs the readiness, and writes nothing');
});
// AND ONE SECOND EARLIER, which the derived floor alone would also have caught — but only on this side of
// the compensation. The equality gate catches it on both.
var wEarly = new World({ bHeader: { updated_at: 'Sun Sep 06 2026 09:56:03 GMT+0800 (Taiwan Standard Time)' } });
var rEarly = wEarly.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rEarly.verdict, has(rEarly, 'route_b_updated_at_unchanged'),
    has(rEarly, 'route_b_updated_at_is_after_the_compensation_write')], ['STOP', true, false],
  'G3  one second EARLIER STOPs on the equality gate while the derived floor still passes');
// THE SAME INSTANT, SPELLED DIFFERENTLY, IS THE SAME INSTANT.
var wZone = new World({ bHeader: { updated_at: TS_SAME_OTHER_ZONE_NAME },
  bLine: { updated_at: TS_SAME_OTHER_ZONE_NAME } });
var rZone = wZone.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rZone.verdict, rZone.predicates_failed], ['SINGLE_ROW_SAVE_READY', 0],
  'G4  a different ZONE NAME for the same moment is not a difference');
var wUtc = new World({ bHeader: { updated_at: TS_SAME_AS_UTC }, bLine: { updated_at: TS_SAME_AS_UTC } });
var rUtc = wUtc.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rUtc.verdict, rUtc.predicates_failed], ['SINGLE_ROW_SAVE_READY', 0],
  'G4a and neither is the same moment expressed as UTC — instants are compared, never display text');
// The normalisation is the family's own, not a second copy written for this round.
eq(vm.runInContext('CENSUS_r6r6TsKey_(' + JSON.stringify(TS_COMPENSATED) + ')', w0.ctx),
  vm.runInContext('CENSUS_r6r6TsKey_(' + JSON.stringify(TS_SAME_AS_UTC) + ')', w0.ctx),
  'G4b through CENSUS_r6r6TsKey_, the one instant normaliser the whole R6-R6 family shares');

// ================================================================================================================
section('§4 — THE COMPLETE EXPORT, SO NO UNVERSIONED WRAPPER IS EVER NEEDED AGAIN');
// ================================================================================================================
var FIELDS = vm.runInContext('CENSUS_r6r6r4Fields_()', w0.ctx);
eq(Object.keys(RD.route_b_observed), FIELDS,
  'F1  the readiness reports the OBSERVED Route B row over every frozen field');
eq(Object.keys(RD.route_a_observed), FIELDS, 'F1a and the observed Route A row over the same list');
eq(RD.route_b_frozen.updated_at, TS_COMPENSATED, 'F1b beside the FROZEN record it was compared against');
eq(RD.route_b_observed.updated_at, TS_COMPENSATED, 'F1c so a future gap can be closed from this output alone');
eq(RD.route_a_frozen.draft_version, '3', 'F1d Route A frozen at the version the Save will guard against');
['verdict', 'predicates_passed', 'predicates_failed', 'snapshot_gaps', 'db_writes', 'writer_calls',
 'route_a_frozen', 'route_a_observed', 'route_b_frozen', 'route_b_observed'].forEach(function (k) {
  ok(Object.prototype.hasOwnProperty.call(RD, k), 'F2-' + k + ' is in the readiness output');
});
// THE EDITOR SHOWS THE LOG, NOT THE RETURN VALUE. That is the only reason a wrapper was ever typed in by
// hand, so the export is a log line as well as a returned field.
var expLine = w0.log.filter(function (m) { return m.indexOf('r6r6r4_export') !== -1; });
eq(expLine.length, 1, 'F3  the readiness logs exactly ONE complete export line');
var exp = JSON.parse(expLine[0].slice(expLine[0].indexOf('{')));
eq([exp.verdict, exp.predicates_failed, exp.snapshot_gaps, exp.db_writes, exp.writer_calls],
  ['SINGLE_ROW_SAVE_READY', 0, [], 0, 0], 'F3a carrying the verdict, the counts, the gaps and the zeroes');
eq(exp.route_b_observed.updated_at, TS_COMPENSATED, 'F3b and both rows, field by field');
eq(exp.route_a_observed.last_mile_delivery, 'parcel', 'F3c including Route A');
ok(exp.predicates === undefined, 'F3d and NOT the sixty predicate rows — failures are logged one by one');
// The wrapper this replaces took no arguments and read nothing a console could aim; neither does this.
ok(!/RUN_R6R6R4_READINESS_FULL_EXPORT/.test(CENSUS),
  'F4  and there is no separate FULL_EXPORT entry point to drift out of version control');

// ================================================================================================================
section('§3 — THE OPERATION, SPELLED AS THE PAGE ACTUALLY BEHAVES');
// ================================================================================================================
// THERE IS NO SAVE BUTTON. _scheduleDraftDbPersist debounces for 400 ms and the row's own state cell is the
// acknowledgement; an operator hunting for a control that does not exist clicks something else, and
// clicking something else is how this incident started.
ok(/_draftDbTimers\[sku\] = setTimeout\(function \(\) \{ _draftDbTimers\[sku\] = null; _flushDraftDbPersist\(sku\); \}, 400\);/.test(PAGE),
  'W1  the page schedules the write on a 400 ms debounce, with no explicit Save control');
ok(/SAVED: 'Saved'/.test(PAGE), 'W1a and the row state cell reports Saved, which is the acknowledgement');
// Counted in the CODE, not the commentary: the one surviving mention is the sentence explaining why the
// wording changed, and deleting the record of a correction is not the same as making it.
var _opText = CENSUS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
eq((_opText.match(/ordinary Execution Plan Save/g) || []).length, 0,
  'W2  no operator-facing string tells anyone to press a Save button that does not exist');
ok(/R6-R6-R4 said 'through the ordinary Execution Plan Save', and there is no/.test(CENSUS),
  'W2a while the comment recording WHY it changed is kept');
ok(/debounced auto-save/.test(RD.save_mechanic) && /Saved/.test(RD.save_mechanic),
  'W3  the readiness states the real mechanic: edit once, wait for the debounced auto-save to report Saved');
ok(/no Save button/i.test(RD.save_mechanic), 'W3a in so many words');
ok(/ONCE/.test(RD.save_mechanic) && /Submit Plan/.test(RD.save_mechanic),
  'W3b once, and not Submit Plan');

// ================================================================================================================
section('§8a — THE OLD BASELINES ARE REFUSED');
// ================================================================================================================
// R6-R6-R1's world: Route A had no last mile, Route B was at version 1 and nothing had been repaired.
var wOld1 = new World({
  aHeader: { recommended_last_mile_delivery: '', draft_version: '1',
    updated_at: 'Thu Sep 03 2026 20:41:08 GMT+0800 (Taiwan Standard Time)' },
  aLine: { updated_at: 'Thu Sep 03 2026 20:41:08 GMT+0800 (Taiwan Standard Time)' },
  bHeader: { draft_version: '1', updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (Taiwan Standard Time)' },
  bLine: { updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (Taiwan Standard Time)' }
});
var o1 = wOld1.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq(o1.verdict, 'STOP', 'O1  the R6-R6-R1 baseline is REFUSED — that plan is two rounds gone');
ok(has(o1, 'route_a_last_mile_delivery_unchanged'), 'O1a naming Route A\'s last mile');
ok(has(o1, 'route_a_draft_version_unchanged'), 'O1b and its version');
ok(has(o1, 'route_b_draft_version_unchanged'), 'O1c and Route B\'s');
eq(wOld1.dbWrites(), 0, 'O1d and a refusal wrote nothing');

// R6-R6-R3's pre-repair world: Route B still holds parcel at version 2.
var wOld3 = new World({ bHeader: { recommended_last_mile_delivery: 'parcel', draft_version: '2',
  updated_at: TS_INCIDENT_B, updated_by: PAGE_ACTOR }, bLine: { updated_at: TS_INCIDENT_B } });
var o3 = wOld3.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq(o3.verdict, 'STOP', 'O2  the R6-R6-R3 PRE-repair baseline is REFUSED — the compensation has happened');
ok(has(o3, 'route_b_last_mile_delivery_unchanged'), 'O2a naming the unauthorized parcel');
ok(has(o3, 'route_b_draft_version_unchanged'), 'O2b the version that never advanced');
ok(has(o3, 'route_b_k4_group_key_unchanged'), 'O2c and the identity derived to match it');
ok(has(o3, 'route_b_updated_by_unchanged'), 'O2d and the actor, which is still the page rather than the repair');
eq(wOld3.dbWrites(), 0, 'O2e and this refusal wrote nothing either');

// ================================================================================================================
section('§8b — ROUTE B DRIFT, FIELD BY FIELD');
// ================================================================================================================
[['bHeader', { recommended_last_mile_delivery: 'parcel' }, 'route_b_last_mile_delivery_unchanged', 'the last mile'],
 ['bHeader', { draft_version: '4' }, 'route_b_draft_version_unchanged', 'the version'],
 ['bHeader', { updated_by: 'someone-else' }, 'route_b_updated_by_unchanged', 'the recorded actor'],
 ['bHeader', { recommended_shipping_method: 'sea' }, 'route_b_shipping_method_unchanged', 'the method'],
 ['bHeader', { status: 'cancelled' }, 'route_b_status_unchanged', 'the status'],
 ['bHeader', { generation_type: 'ai_generated' }, 'route_b_generation_type_unchanged', 'the generation type'],
 ['bHeader', { recommended_destination_warehouse_id: 'WH-OTHER' }, 'route_b_destination_id_unchanged', 'the destination'],
 ['bLine', { source_warehouse_id: 'WH-OTHER' }, 'route_b_source_warehouse_id_unchanged', 'the source'],
 ['bLine', { planned_qty: '201' }, 'route_b_quantity_unchanged', 'the quantity'],
 ['bLine', { line_status: 'cancelled' }, 'route_b_line_status_unchanged', 'the line status'],
 ['bLine', { expected_arrival: '2026-10-01' }, 'route_b_expected_arrival_unchanged', 'the ETA']
].forEach(function (c, i) {
  var over = {}; over[c[0]] = c[1];
  var w = new World(over);
  var r = w.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  eq([r.verdict, has(r, c[2]), w.dbWrites()], ['STOP', true, 0],
    'B' + (i + 1) + '  drift in ' + c[3] + ' STOPs, names ' + c[2] + ', writes nothing');
});
// The instants nobody supplied are still gated: earlier than the compensation is impossible.
var wStale = new World({ bHeader: { updated_at: TS_INCIDENT_B }, bLine: { updated_at: TS_INCIDENT_B } });
var rStale = wStale.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rStale.verdict, has(rStale, 'route_b_updated_at_is_after_the_compensation_write')], ['STOP', true],
  'B12 an instant that predates the compensation STOPs — the repair could not have left it there');
var wSplit = new World({ bLine: { updated_at: 'Sun Sep 06 2026 09:15:01 GMT+0800 (Taiwan Standard Time)' } });
var rSplit = wSplit.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rSplit.verdict, has(rSplit, 'route_b_header_and_line_instants_agree')], ['STOP', true],
  'B13 header and line instants that disagree STOP — one transaction stamped both');

// ================================================================================================================
section('§8c — ROUTE A DRIFT AND THE ALREADY-SAVED CASE');
// ================================================================================================================
[['aHeader', { recommended_last_mile_delivery: 'truck' }, 'route_a_last_mile_delivery_unchanged'],
 ['aHeader', { draft_version: '4' }, 'route_a_draft_version_unchanged'],
 ['aHeader', { updated_by: REPAIR_ACTOR }, 'route_a_updated_by_unchanged'],
 ['aHeader', { recommended_shipping_method: 'air' }, 'route_a_shipping_method_unchanged'],
 ['aLine', { planned_qty: '321' }, 'route_a_quantity_unchanged'],
 ['aLine', { expected_arrival: '2026-10-01' }, 'route_a_expected_arrival_unchanged']
].forEach(function (c, i) {
  var over = {}; over[c[0]] = c[1];
  var w = new World(over);
  var r = w.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  eq([r.verdict, has(r, c[2]), w.dbWrites()], ['STOP', true, 0],
    'A' + (i + 1) + '  Route A drift in ' + c[2] + ' STOPs and writes nothing');
});
// ALREADY SAVED is recognisable on its own, so nobody performs the edit a second time.
var wDone = new World({ aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '4',
  updated_at: TS_SAVE }, aLine: { updated_at: TS_SAVE } });
var rDone = wDone.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq(rDone.already_saved, true, 'A7  a row already at truck/version 4 is reported as ALREADY SAVED');
eq(rDone.verdict, 'STOP', 'A7a it is not a success — the readiness has nothing left to authorize');
ok(rDone.stop_reason.indexOf('ALREADY') !== -1 && rDone.stop_reason.indexOf('READBACK') !== -1,
  'A7b and the reason says so in words, and sends the operator to the readback rather than the edit');
eq(wDone.dbWrites(), 0, 'A7c writing nothing, as every entry point in this family does');

// ================================================================================================================
section('§8d — MISSING, DUPLICATED AND AMBIGUOUS TARGETS');
// ================================================================================================================
var wNoA = new World({ dropA: true });
var rNoA = wNoA.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rNoA.verdict, has(rNoA, 'route_a_present_exactly_once')], ['STOP', true], 'D1  a missing Route A STOPs');
var wNoB = new World({ dropB: true });
var rNoB = wNoB.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq([rNoB.verdict, has(rNoB, 'route_b_present_exactly_once')], ['STOP', true], 'D2  a missing Route B STOPs too');
// A third route in the same plan changes the SET, and a single-row Save must be measured against a known set.
var wThird = new World({
  extraHeaders: [{ allocation_draft_id: 'SADH-K4-THIRD', recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-OTHER',
    recommended_destination_warehouse_code_snapshot: 'OTHER', recommended_shipping_method: 'sea',
    recommended_last_mile_delivery: 'truck', draft_version: '1', updated_at: TS_A }],
  extraLines: [{ allocation_draft_line_id: 'SADL-K2-THIRD', allocation_draft_id: 'SADH-K4-THIRD',
    planned_qty: '50', updated_at: TS_A }]
});
var rThird = wThird.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
eq(rThird.verdict, 'STOP', 'D3  a third visible route STOPs — the set is part of the baseline');
ok(has(rThird, 'visible_route_rows_is_2') || has(rThird, 'header_count_is_2')
  || has(rThird, 'current_plan_total_is_520'), 'D3a naming the invariant it broke');

// ================================================================================================================
section('§4/§6 — THE REAL SAVE, AND THE READBACK THAT MEASURES IT');
// ================================================================================================================
var w = new World();
var before = w.snapshot();
var beforeA = w.header(A_HEADER), beforeAL = w.line(A_LINE);
var frozenB = JSON.stringify(w.header(B_HEADER)), frozenBL = JSON.stringify(w.line(B_LINE));
var sv = w.save(A_HEADER, A_LINE, 'truck');
ok(!sv.threw, 'S1  the real 16_ writer accepts the single-route UPDATE' + (sv.threw ? ' — ' + sv.threw.message : ''));
eq(sv.parsed && sv.parsed.success, true, 'S1a and answers success');
eq(w.calls.writer, 1, 'S1b exactly ONE mutation request — the page chains one per canonical group');
eq(sv.payload.lines.length, 1, 'S1c carrying exactly one line');
eq(sv.payload.lines[0].allocation_draft_line_id, A_LINE, 'S1d which is Route A\'s');
eq(sv.payload.header.expected_draft_version, '3', 'S1e guarded by the version that was read');
eq(sv.payload.create_idempotency_key, undefined, 'S1f and with NO create_idempotency_key — an UPDATE mints nothing');
ok(JSON.stringify(sv.payload).indexOf(B_HEADER) === -1 && JSON.stringify(sv.payload).indexOf(B_LINE) === -1,
  'S1g Route B\'s identifiers appear nowhere in the payload');
ok(sv.payload.lines[0].expected_arrival === undefined,
  'S1h and expected_arrival is ABSENT rather than blank, which is what makes the ETA untouched by construction');

// WHICH COLUMNS ACTUALLY MOVED.
var afterA = w.header(A_HEADER), afterAL = w.line(A_LINE);
var movedH = Object.keys(afterA).filter(function (k) { return String(afterA[k]) !== String(beforeA[k]); }).sort();
var movedL = Object.keys(afterAL).filter(function (k) { return String(afterAL[k]) !== String(beforeAL[k]); }).sort();
eq(movedH, ['draft_version', 'recommended_last_mile_delivery', 'updated_at'],
  'S2  on Route A\'s header exactly three columns moved: the one edited, the version, the stamp');
eq(movedL, ['updated_at'], 'S2a and on its line, only the stamp');
eq(w.k4(A_HEADER), K4_A_TRUCK, 'S2b the derived K4 followed the last mile, having been written nowhere');
eq(JSON.stringify(w.header(B_HEADER)), frozenB, 'S3  Route B\'s header is BYTE-IDENTICAL');
eq(JSON.stringify(w.line(B_LINE)), frozenBL, 'S3a and so is its line');
eq(w.rowsOf('shipping_allocation_drafts').length, 2, 'S3b two headers, as before');
eq(w.rowsOf('shipping_allocation_draft_lines').length, 2, 'S3c and two lines — nothing was minted');

var RB = w.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq(RB.verdict, 'SINGLE_ROW_MUTATION_CONFIRMED', 'S4  the readback returns the ONLY success verdict');
eq(RB.predicates_failed, 0, 'S4a with zero failed predicates');
ok(RB.predicates_passed >= 35, 'S4b and ' + RB.predicates_passed + ' passed');
eq([RB.read_only, RB.db_writes, RB.writer_constructed], [true, 0, false], 'S4c and it wrote nothing itself');
eq(RB.k4_expected_after, K4_A_TRUCK, 'S5  the expected key was DERIVED by substituting one segment');
eq(RB.k4_actual_after, K4_A_TRUCK, 'S5a and production agrees');
ok(RB.ui_note.indexOf('displayed') !== -1 || RB.ui_note.indexOf('DISPLAY') !== -1,
  'S6  and the verdict states that a displayed last mile is not a stored one');
eq(RB.stage_two_authorized, false, 'S6a stage two is still not authorized by a confirmed stage one');

// ================================================================================================================
section('§8e — THE READBACK CATCHES EVERY WAY THE SAVE COULD GO WRONG');
// ================================================================================================================
// The version did not move: the write never landed.
var wNo = new World();
wNo.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS');
var wNoH = new World({ aHeader: { recommended_last_mile_delivery: 'truck', updated_at: TS_SAVE },
  aLine: { updated_at: TS_SAVE } });
var rNoV = wNoH.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq([rNoV.verdict, has(rNoV, 'route_a_draft_version_advanced_by_exactly_one')], ['STOP', true],
  'E1  a last mile that changed with NO version step STOPs — nothing was persisted through the writer');
// The version jumped two: something wrote twice.
var wTwo = new World({ aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '5', updated_at: TS_SAVE },
  aLine: { updated_at: TS_SAVE } });
var rTwo = wTwo.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq([rTwo.verdict, has(rTwo, 'route_a_draft_version_advanced_by_exactly_one')], ['STOP', true],
  'E2  and a version that jumped TWO STOPs — one edit is one step');
// The K4 moved on more than the last-mile segment.
var wK4 = new World({ aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '4',
  recommended_shipping_method: 'air', updated_at: TS_SAVE }, aLine: { updated_at: TS_SAVE } });
var rK4 = wK4.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq([rK4.verdict, has(rK4, 'route_a_k4_is_the_frozen_key_with_only_the_last_mile_segment_replaced')], ['STOP', true],
  'E3  a key that moved on a SECOND dimension STOPs — the substitution is exact or it is not one');
ok(has(rK4, 'route_a_shipping_method_unchanged'), 'E3a and the dimension that moved is named too');
// The stamps did not advance.
var wStamp = new World({ aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '4' } });
var rStamp = wStamp.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq([rStamp.verdict, has(rStamp, 'route_a_updated_at_advanced')], ['STOP', true],
  'E4  a version that moved without a stamp STOPs — a landed write leaves both');
// The actor is wrong: something other than the page wrote it.
var wActor = new World({ aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '4',
  updated_at: TS_SAVE, updated_by: REPAIR_ACTOR }, aLine: { updated_at: TS_SAVE } });
var rActor = wActor.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq([rActor.verdict, has(rActor, 'route_a_updated_by_is_the_page')], ['STOP', true],
  'E5  and a write recorded against a DIFFERENT actor STOPs — the Save was not what moved it');
// R6-R6-R4-R1 — ROUTE B'S INSTANTS ARE NOW A READBACK GATE TOO. A bystander whose stamp moved at all is a
// bystander something wrote, whatever else still looks right. Each field on its own.
[['bHeader', 'updated_at', 'route_b_updated_at_unchanged'],
 ['bLine', 'updated_at', 'route_b_line_updated_at_unchanged']].forEach(function (c, i) {
  var over = { aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '4', updated_at: TS_SAVE },
    aLine: { updated_at: TS_SAVE } };
  over[c[0]] = over[c[0]] || {}; over[c[0]][c[1]] = TS_ONE_SECOND_LATER;
  var w2 = new World(over);
  var r2 = w2.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
  eq([r2.verdict, has(r2, c[2]), w2.dbWrites()], ['STOP', true, 0],
    'E6' + '.ab'[i + 1] + ' the bystander ' + c[1] + ' moving by ONE SECOND after the Save STOPs the readback');
});
// And a clean Save leaves them exactly where they were, so the gate discriminates rather than always firing.
eq([w.header(B_HEADER).updated_at, w.line(B_LINE).updated_at], [TS_COMPENSATED, TS_COMPENSATED],
  'E6c after the authorized Save, Route B still holds the two instants that were frozen');
ok(!has(RB, 'route_b_updated_at_unchanged') && !has(RB, 'route_b_line_updated_at_unchanged'),
  'E6d and the readback agrees — both equality gates pass on the clean single-row Save');
// ROUTE A's are ALLOWED to advance, and did. The asymmetry is the whole point: one row is being changed.
ok(!has(RB, 'route_a_updated_at_advanced') && !has(RB, 'route_a_line_updated_at_advanced'),
  'E7  the two Route A stamps ADVANCED, and that is what a landed write looks like');
ok(String(w.header(A_HEADER).updated_at) !== TS_A_NOW && String(w.line(A_LINE).updated_at) !== TS_A_NOW,
  'E7a measured on the rows, not inferred from the verdict');

// ================================================================================================================
section('§5/§8 — A PAYLOAD THAT MIXES IN ROUTE B, AND A FALLBACK THAT EXPANDS TO EVERY ROW');
// ================================================================================================================
// The incident, reproduced exactly: two sequential atomic requests, one per canonical group.
var wMix = new World();
wMix.save(A_HEADER, A_LINE, 'truck');
wMix.save(B_HEADER, B_LINE, 'parcel');
eq(wMix.calls.writer, 2, 'X1  the incident shape is TWO writer calls, one per group — never one payload of two');
eq(String(wMix.header(B_HEADER).recommended_last_mile_delivery), 'parcel', 'X1a and Route B was written');
eq(String(wMix.header(B_HEADER).draft_version), '4', 'X1b its version advanced');
var rMix = wMix.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq(rMix.verdict, 'STOP', 'X2  the readback REFUSES — this is the 2026-09-06 incident happening again');
ok(has(rMix, 'route_b_last_mile_delivery_unchanged'), 'X2a naming the column nobody edited');
ok(has(rMix, 'route_b_draft_version_unchanged'), 'X2b the version that should not have moved');
ok(has(rMix, 'route_b_k4_group_key_unchanged'), 'X2c and the identity that followed it');
ok(has(rMix, 'route_b_updated_by_unchanged'), 'X2d and the actor, which is now the page and was the repair');
// AND THE TIMESTAMP PROOF, WITHOUT THE TIMESTAMP. Both rows were stamped by the same clock in the same Save.
ok(has(rMix, 'route_b_updated_at_predates_the_route_a_save'),
  'X3  the predates-the-save gate fires — which is how Route B is proven untouched WITHOUT its frozen instant');
ok(has(rMix, 'route_b_line_updated_at_predates_the_route_a_save'), 'X3a on the line as well');
// That gate is not vacuous: it PASSES on the clean save.
ok(!has(RB, 'route_b_updated_at_predates_the_route_a_save'),
  'X3b and it passes on the clean single-row Save, so it discriminates rather than always failing');

// A fallback that expanded to every visible row is the same two writes with a different cause, and the
// readback cannot and must not tell them apart: it reports what moved.
var wAll = new World();
[[A_HEADER, A_LINE, 'truck'], [B_HEADER, B_LINE, 'parcel']].forEach(function (p) { wAll.save(p[0], p[1], p[2]); });
eq(wAll.calls.writer, 2, 'X4  an expanded fallback produces the same two calls');
eq(wAll.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res.verdict, 'STOP', 'X4a and the same refusal');
// A payload that MINTS instead of updating.
var wMint = new World();
var mintPayload = {
  intent: 'CREATE_NEW_ROUTE',
  header: { company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
    recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', destination_marketplace: 'Amazon',
    recommended_source_warehouse_code_snapshot: 'CNYOUXIN', recommended_shipping_method: 'sea_express',
    recommended_last_mile_delivery: 'parcel', created_by: PAGE_ACTOR },
  lines: [{ sku: SKU, planned_qty: '320' }]
};
try { vm.runInContext('handleUpsertShippingAllocationDraftAtomic_(' + JSON.stringify(mintPayload) + ')', wMint.ctx); }
catch (eM) { /* whether the writer accepts it is not this assertion's claim */ }
var rMint = wMint.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
eq(rMint.verdict, 'STOP', 'X5  a mint is refused by the readback whatever the writer thought of it');

// ================================================================================================================
section('§5 — THE BROWSER MUTATION AUDIT');
// ================================================================================================================
var shape = new Function('return ' + extractFn(DBAPI, '_kmMutationShape_') + NL + ';_kmMutationShape_')();
var one = shape('upsertShippingAllocationDraftAtomic', {
  intent: 'UPDATE_EXISTING_ROUTE',
  header: { allocation_draft_id: A_HEADER, recommended_last_mile_delivery: 'truck',
    expected_draft_version: '3', note: 'a private operator note' },
  lines: [{ allocation_draft_line_id: A_LINE, sku: SKU, planned_qty: 320 }]
});
eq(one.intent, 'UPDATE_EXISTING_ROUTE', 'M1  the audit reports the INTENT, which it could not before');
eq(one.expected_draft_version, '3', 'M1a and the version the request is guarded by');
eq(one.has_create_idempotency_key, false, 'M1b and that no idempotency key is present');
eq(one.mints_new_row, false, 'M1c and that nothing would be minted');
eq(one.routes_in_payload, 1, 'M1d one route');
eq(one.allocation_draft_line_ids, [A_LINE], 'M1e named by id');
eq(one.allocation_draft_id, A_HEADER, 'M1f under one header');
ok(JSON.stringify(one).indexOf('a private operator note') === -1,
  'M2  and NO payload VALUE is carried — names, ids and counts only');
ok(JSON.stringify(one).indexOf('320') === -1, 'M2a the quantity included');
// The two shapes the audit exists to distinguish.
var mixed = shape('upsertShippingAllocationDraftAtomic', {
  intent: 'UPDATE_EXISTING_ROUTE', header: { allocation_draft_id: A_HEADER },
  lines: [{ allocation_draft_line_id: A_LINE }, { allocation_draft_line_id: B_LINE }]
});
eq(mixed.routes_in_payload, 2, 'M3  a payload carrying two lines reports two');
ok(mixed.allocation_draft_line_ids.indexOf(B_LINE) !== -1, 'M3a and names the bystander it should not contain');
var minting = shape('x', { intent: 'CREATE_NEW_ROUTE', header: {}, lines: [{ sku: SKU }] });
eq([minting.mints_new_row, minting.allocation_draft_line_ids], [true, ['(new)']],
  'M4  a line with no id is reported as MINTING, which is the difference between an edit and a twin');
var keyed = shape('x', { intent: 'CREATE_NEW_ROUTE', header: { create_idempotency_key: 'CIK-1' }, lines: [] });
eq(keyed.has_create_idempotency_key, true, 'M4a and an idempotency key is reported when present');

function transportFactory(src) {
  var sb = { window: {}, console: { log: function () {} }, JSON: JSON, Math: Math, Date: Date,
    String: String, Number: Number, Object: Object, Array: Array, isNaN: isNaN, isFinite: isFinite,
    parseFloat: parseFloat, parseInt: parseInt, Error: Error, RegExp: RegExp, Boolean: Boolean,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.globalThis = sb; sb.self = sb; sb.global = sb;
  vm.createContext(sb);
  vm.runInContext(src || TRANSPORT, sb);
  return sb.window.KM.transportFactory;
}
var tp = transportFactory().create();
tp.recordExternal({ action: 'upsertShippingAllocationDraftAtomic', kind: 'write', ms: 3100,
  routes_in_payload: 1, allocation_draft_id: A_HEADER, allocation_draft_line_ids: [A_LINE],
  changed_fields: ['recommended_last_mile_delivery'], intent: 'UPDATE_EXISTING_ROUTE',
  expected_draft_version: '3', has_create_idempotency_key: false, mints_new_row: false,
  outcome: 'ANSWERED', request_id: 'REQ-W000001-C' });
var tl = tp.timeline();
eq(tl.mutation_requests, 1, 'M5  the transport records ONE mutation request');
eq([tl.mutations[0].intent, tl.mutations[0].expected_draft_version], ['UPDATE_EXISTING_ROUTE', '3'],
  'M5a carrying the intent and the guarded version out to the timeline');
eq([tl.mutations[0].has_create_idempotency_key, tl.mutations[0].mints_new_row], [false, false],
  'M5b and both booleans');
eq(tl.mutations[0].allocation_draft_line_ids, [A_LINE], 'M5c naming exactly one line');
// NOT TOLD is not NO. A recorder that supplies nothing must leave the fields null, not false.
var tp2 = transportFactory().create();
tp2.recordExternal({ action: 'x', kind: 'write', ms: 10 });
eq([tp2.timeline().mutations[0].intent, tp2.timeline().mutations[0].has_create_idempotency_key,
    tp2.timeline().mutations[0].mints_new_row], [null, null, null],
  'M6  a recorder that supplied nothing leaves them NULL — "not told" never reads as "no"');
// §10 — page hydration must produce no mutation at all.
var tp3 = transportFactory().create();
['workspace.get', 'methodRegistry.get', 'inventoryScope.registry.get'].forEach(function (a) {
  tp3.recordExternal({ action: a, kind: 'read', ms: 900 });
});
eq([tp3.timeline().mutation_requests, tp3.timeline().mutations], [0, []],
  'M7  hydration reads produce mutation_requests 0 and an empty mutations list');
eq(tp3.timeline().request_timeline.length, 3, 'M7a while the reads themselves are still visible');
// §5 — an unclear acknowledgement is reported, never resent.
ok(/INDETERMINATE|never auto-retried/.test(DBAPI), 'M8  an expired WRITE is INDETERMINATE, not "nothing written"');
var writeFn = extractFn(DBAPI, '_kmWeeklyCommand_');
eq((writeFn.match(/_kmFetchBounded_\(/g) || []).length, 1,
  'M8a and the command path dispatches EXACTLY ONCE — a timeout cannot become a second write');
ok(!/\bfor\s*\(|\bwhile\s*\(|\bdo\s*{/.test(writeFn),
  'M8b with no loop anywhere in it, so there is no retry to reach');

// ================================================================================================================
section('§7 — STAGE TWO IS DESIGNED AND NOT AUTHORIZED');
// ================================================================================================================
var wS = new World();
var ST = wS.run('RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST').res;
eq(ST.verdict, 'STAGE_TWO_DESIGNED_NOT_AUTHORIZED', 'T1  the manifest says exactly what it is');
eq([ST.authorized, ST.executed], [false, false], 'T1a authorized false, executed false');
eq(wS.dbWrites(), 0, 'T1b and running it wrote nothing');
eq([ST.expected.route_a_last_mile_before, ST.expected.route_a_last_mile_after], ['parcel', 'truck'],
  'T2  the restore is parcel -> truck');
eq([ST.expected.route_a_draft_version_before, ST.expected.route_a_draft_version_after], ['3', '4'],
  'T2a and version 3 -> 4, forward like everything else in this family');
eq(ST.expected.route_a_k4_after, K4_A_TRUCK, 'T2b landing back on the truck key');
ok(ST.readiness_design.success_verdict === 'SINGLE_ROW_SAVE_READY'
  && ST.readback_design.success_verdict === 'SINGLE_ROW_MUTATION_CONFIRMED',
  'T3  the two designs reuse this round\'s verdicts rather than inventing a second vocabulary');
ok(ST.precondition.indexOf('SINGLE_ROW_SAVE_READY') !== -1
  && ST.precondition.indexOf('R6-R6-R4-R2 fix is DEPLOYED') !== -1
  && ST.precondition.indexOf('expected_draft_version') !== -1,
  'T3a and stage two needs all three: the readiness, the deployed fix, and an audit showing the token');
eq(ST.requires_optimistic_token, '3', 'T3b the token stage two must declare is the version stage one left');
eq(ST.expected.route_a_expected_draft_version_sent, '3', 'T3c stated in the expected block as well');
ok(/MUTATION_CONTRACT_DEFECT/.test(ST.root_cause_fix),
  'T3d and the manifest records the classification, so nobody re-derives it from the version alone');
// The manifest cannot write, and neither can the two verdicts.
var R4SEC = CENSUS.slice(CENSUS.indexOf('R6-R6-R4 — THE POST-REPAIR SINGLE-ROW SAVE'));
ok(!/handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(R4SEC),
  'T4  the whole R6-R6-R4 section contains NO call to the atomic writer');
ok(!/\.setValue\(|\.appendRow\(|\.deleteRow\(|\.clearContent\(/.test(R4SEC),
  'T4a and no direct cell write of any kind');
eq((CENSUS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .match(/handleUpsertShippingAllocationDraftAtomic_\s*\(/g) || []).length, 1,
  'T4b the census still contains EXACTLY ONE writer call, and it is R6-R6-R3\'s');

// ================================================================================================================
section('R4-R2 — THE OPTIMISTIC TOKEN: WHY IT WAS null, AND THE TWO SIDES THAT LET IT BE');
// ================================================================================================================
// CLASSIFICATION: MUTATION_CONTRACT_DEFECT, not a telemetry one. The audit reported null because the field was
// genuinely absent, and that is provable from the audit itself: `intent` came back UPDATE_EXISTING_ROUTE, and
// intent lives ONLY on payload.header (buildDraftHeaderPayload sets it there; the atomic body has no
// top-level intent). So the extractor resolved `header` correctly and found no version on it.
var COMPAT = read('assets/js/utils/inventory-compat.js');
var buildHeader = new Function('return ' + extractFn(COMPAT, 'buildDraftHeaderPayload') + NL + ';buildDraftHeaderPayload')();
function storedVersion(model, id) {
  return new Function('replenAllocationDraft',
    'return ' + extractFn(PAGE, '_irStoredDraftVersion_') + NL + ';_irStoredDraftVersion_')(model)(id);
}
// The atomic body the page builds, assembled here exactly as _flushDraftDbPersist assembles it.
function uiBody(model) {
  var ids = [A_HEADER];
  var header = buildHeader({ intent: 'UPDATE_EXISTING_ROUTE', allocation_draft_id: ids[0],
    expected_draft_version: storedVersion(model, ids[0]) || undefined,
    company: 'ResUS', country: 'US', marketplace: 'Amazon',
    source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', destination_marketplace: 'Amazon',
    shipping_method: 'sea_express', last_mile_delivery: 'truck' });
  return { header: header, lines: [{ allocation_draft_line_id: A_LINE, sku: SKU, planned_qty: '320' }],
    create_idempotency_key: header.create_idempotency_key || undefined,
    expected_draft_version: header.expected_draft_version || undefined };
}
var MODEL_OK = { bySku: {} }; MODEL_OK.bySku[SKU] = [{ allocation_draft_id: A_HEADER, draft_version: '3' }];
var MODEL_LOST = { bySku: {} }; MODEL_LOST.bySku[SKU] = [{ allocation_draft_id: A_HEADER }];

// ---- the intent proves the extractor found the header, which is what rules out A ------------------------------
var shapeLost = shape('upsertShippingAllocationDraftAtomic', uiBody(MODEL_LOST));
eq([shapeLost.intent, shapeLost.expected_draft_version], ['UPDATE_EXISTING_ROUTE', null],
  'V1  the production audit is REPRODUCED: intent present, expected_draft_version null');
eq(storedVersion(MODEL_LOST, A_HEADER), '',
  'V1a because the model row carried no draft_version, so _irStoredDraftVersion_ returned blank');
eq(uiBody(MODEL_LOST).header.expected_draft_version, undefined,
  'V1b and buildDraftHeaderPayload omits a blank rather than sending an empty string');
eq(uiBody(MODEL_LOST).expected_draft_version, undefined, 'V1c so the top-level copy is absent too');
ok(/intent/.test(String(buildHeader)) && !/p.intent = ctx.expected/.test(String(buildHeader)),
  'V1d intent is set on the HEADER, which is the field path that proves the extractor was not at fault');

// ---- with the version present, the exact UI payload declares it ----------------------------------------------
eq(storedVersion(MODEL_OK, A_HEADER), '3', 'V2  a model row that carries draft_version yields it');
var bodyOk = uiBody(MODEL_OK);
eq(bodyOk.header.expected_draft_version, '3', 'V2a the header declares the version that was read');
eq(bodyOk.expected_draft_version, '3', 'V2b and so does the documented top-level field');
eq(bodyOk.header.intent, 'UPDATE_EXISTING_ROUTE', 'V2c beside the intent it belongs to');
var shapeOk = shape('upsertShippingAllocationDraftAtomic', bodyOk);
eq([shapeOk.intent, shapeOk.expected_draft_version, shapeOk.mints_new_row, shapeOk.has_create_idempotency_key],
  ['UPDATE_EXISTING_ROUTE', '3', false, false],
  'V2d and the audit reports "3" — read from the request, never reconstructed from the AFTER version');

// ---- THE PAGE-SIDE FIX: the version survives the DOM round trip ------------------------------------------------
// The collector REPLACES replenAllocationDraft.bySku[sku] with rows it rebuilds from the DOM, so a field the
// rebuilt literal does not carry is destroyed by the first edit — which is the event that schedules the write.
ok(/replenAllocationDraft\.bySku\[sku\] = rows;/.test(PAGE),
  'V3  the collector still REPLACES the model with what it rebuilds, which is why the row must carry it');
ok(/var boundDraftVersion = rowEl\.getAttribute\('data-draft-version'\) \|\|/.test(PAGE),
  'V3a it reads the version from the DOM, like every other identity field');
ok(/String\(\(_priorRow && _priorRow\.draft_version\) \|\| ''\);/.test(PAGE),
  'V3b falling back to the row the model already had');
ok(/draft_version: boundDraftVersion,/.test(PAGE), 'V3c and the rebuilt row CARRIES it');
ok(/if \(boundDraftVersion\) rowEl\.setAttribute\('data-draft-version', boundDraftVersion\);/.test(PAGE),
  'V3d re-published to the DOM, so model and DOM cannot disagree');
ok(/if \(route && route\.draft_version\) row\.setAttribute\('data-draft-version', String\(route\.draft_version\)\);/.test(PAGE),
  'V3e the render stamps it beside the identity it belongs to');
ok(/if \(ver\) els\[i\]\.setAttribute\('data-draft-version', ver\);/.test(PAGE),
  'V3f and the post-save re-stamp adopts the version the server just wrote');
// The hydrate has always read it; that was never the broken half.
ok(/draft_version: hstr\('draft_version', 'draftVersion'\),/.test(PAGE),
  'V3g the hydrate reads it from the stored header, as it always did');

// ---- THE WRITER-SIDE FIX: a declared UPDATE must declare what it expects ----------------------------------------
function attempt(over, body) {
  var w2 = new World(over || {});
  var out = null, threw = null;
  try { out = vm.runInContext('handleUpsertShippingAllocationDraftAtomic_(' + JSON.stringify(body) + ')', w2.ctx); }
  catch (e) { threw = e; }
  var parsed = null;
  try { parsed = JSON.parse(out && out.getContent ? out.getContent() : JSON.stringify(out || {})); } catch (e2) {}
  return { w: w2, parsed: parsed, threw: threw };
}
function updateBody(expectedHeader, expectedTop, lastMile) {
  var b = { intent: 'UPDATE_EXISTING_ROUTE',
    header: { allocation_draft_id: A_HEADER, company: 'ResUS', country: 'US', marketplace: 'Amazon',
      status: 'draft', recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
      recommended_source_warehouse_code_snapshot: 'CNYOUXIN', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: (lastMile === undefined ? 'truck' : lastMile),
      created_by: PAGE_ACTOR },
    lines: [{ allocation_draft_line_id: A_LINE, sku: SKU, planned_qty: '320' }] };
  if (expectedHeader !== null) b.header.expected_draft_version = expectedHeader;
  if (expectedTop !== null) b.expected_draft_version = expectedTop;
  return b;
}
var noTok = attempt({}, updateBody(null, null));
eq(noTok.parsed && noTok.parsed.code, 'MISSING_OPTIMISTIC_TOKEN',
  'V4  an UPDATE_EXISTING_ROUTE with NO expected_draft_version is REFUSED');
eq([noTok.parsed.success, noTok.parsed.zero_write], [false, true], 'V4a as a proven zero write');
eq(noTok.w.dbWrites(), 0, 'V4b measured on the sheet: not one cell');
eq([String(noTok.w.header(A_HEADER).recommended_last_mile_delivery), String(noTok.w.header(A_HEADER).draft_version)],
  ['parcel', '3'], 'V4c the row is exactly where it was — this is the write that used to commit anyway');
eq(String(noTok.parsed.data.current_draft_version), '3',
  'V4d and the refusal publishes the CURRENT version, so the client can adopt it instead of guessing');
ok(/Reload the Execution Plan/.test(String(noTok.parsed.error)),
  'V4e with an operator sentence, because the only way to reach this is an out-of-date page');
ok(/zero rows written/.test(String(noTok.parsed.error)),
  'V4f and the phrase _kmZeroWriteProven_ reads, so the client states zero-write rather than guessing');
// NOT REPAIRED BY FILLING IT IN. The refusal must not adopt the row's own version and proceed.
var blank = attempt({}, updateBody('', ''));
eq(blank.parsed && blank.parsed.code, 'MISSING_OPTIMISTIC_TOKEN',
  'V5  a BLANK expected version is absent, not the number zero, and is refused the same way');
eq(blank.w.dbWrites(), 0, 'V5a writing nothing');
var stale = attempt({}, updateBody('2', '2'));
eq(stale.parsed && stale.parsed.code, 'STALE_OPTIMISTIC_TOKEN',
  'V6  a STALE expected version is refused, as it always was');
eq([stale.parsed.zero_write, stale.w.dbWrites()], [true, 0], 'V6a zero write, measured');
eq([String(stale.parsed.data.expected), String(stale.parsed.data.current)], ['2', '3'], 'V6b naming both numbers');
// THE DOCUMENTED TOP-LEVEL FIELD IS NOW READ. §1611 documents it and the guard used to ignore it.
var topOnly = attempt({}, updateBody(null, '3'));
eq(topOnly.parsed && topOnly.parsed.success, true,
  'V7  a body-level expected_draft_version alone is HONOURED — the documented shape now works');
eq(String(topOnly.w.header(A_HEADER).draft_version), '4', 'V7a and the write lands, exactly one step');
var topStale = attempt({}, updateBody(null, '2'));
eq(topStale.parsed && topStale.parsed.code, 'STALE_OPTIMISTIC_TOKEN',
  'V7b and a stale one there is refused, which it was not before');
eq(topStale.w.dbWrites(), 0, 'V7c zero write');
// A CREATE has no prior version, and a cancel carries no route intent. Neither is caught by the new gate.
var created = attempt({}, { intent: 'CREATE_NEW_ROUTE',
  header: { company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
    recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
    recommended_source_warehouse_code_snapshot: 'CNYOUXIN', destination_marketplace: 'Amazon',
    recommended_shipping_method: 'air', recommended_last_mile_delivery: 'truck', created_by: PAGE_ACTOR },
  lines: [{ sku: SKU, planned_qty: '10' }] });
ok(!(created.parsed && created.parsed.code === 'MISSING_OPTIMISTIC_TOKEN'),
  'V8  a CREATE_NEW_ROUTE is NOT caught by the new gate — it has no prior version to declare');
ok(!/sadIntent === 'CREATE_NEW_ROUTE'/.test(G16.slice(G16.indexOf('MISSING_OPTIMISTIC_TOKEN') - 700,
  G16.indexOf('MISSING_OPTIMISTIC_TOKEN'))),
  'V8a the gate is keyed on UPDATE_EXISTING_ROUTE alone');
ok(/sadIntent === 'UPDATE_EXISTING_ROUTE' && sadExpDeclared === null/.test(G16),
  'V8b exactly that condition, and nothing wider');
// AND THE ROW ISOLATION CONTRACT IS UNCHANGED: one route, one line, no mint, no idempotency key.
var svR = w.calls.payloads[0];
eq([svR.lines.length, svR.intent, svR.create_idempotency_key === undefined],
  [1, 'UPDATE_EXISTING_ROUTE', true],
  'V9  the authorized Save still carries one line, one intent and no create key');

// ================================================================================================================
section('§9 — RELEASE');
// ================================================================================================================
// R6-R6-R4-R1 — DERIVED, not pinned. R6-R6-R4 wrote this as an equality with now after removing three of
// them from neighbouring suites, and the very next round broke it. The claim is that the diagnostic
// changed in R6-R6-R4 OR LATER.
var declared = (CENSUS.match(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/) || [])[1];
ok(RO.OWNER_STAMPS.indexOf(declared) >= RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4'),
  'Y1  the diagnostic declares R6-R6-R4 or a later round (' + declared + ')');
ok(RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4') !== -1,
  'Y1a and the ledger still records the round this suite belongs to');
ok(RO.BUILD_STAMP_RE.test(declared), 'Y1b and whatever it declares is a well-formed stamp');
// AND THIS ROUND MOVED NO FRONTEND FILE, so it introduced no token of its own.
eq(RO.ROUND_TOKENS.filter(function (t) { return /r6r6r4r1/i.test(t); }), [],
  'Y1c R6-R6-R4-R1 introduced NO cache token — it changed the diagnostic and its tests, nothing else');
// A FRONTEND FILE CHANGED, so the shared token MUST have moved — the opposite of R6-R6-R3's claim.
// R6-R6-R4-R2 — DERIVED. Pinning the literal made this an equality with now for the fourth time in this
// family. The two claims are that the token this round introduced comes after the one it supersedes, and
// that index.html carries ONE token throughout.
ok(RO.ROUND_TOKENS.indexOf(RO.currentAppToken())
   > RO.ROUND_TOKENS.indexOf('fc1be3r4a2r1r6r6r2-rowisolation-20260906'),
  'Y2  the cache token MOVED past R6-R6-R2 — a frontend file changed and a published token is never reused');
eq(RO.staleAppTokenRefs(INDEX), [], 'Y2-stale index.html carries no superseded token');
ok(RO.ROUND_TOKENS.indexOf('fc1be3r4a2r1r6r6r2-rowisolation-20260906')
   < RO.ROUND_TOKENS.indexOf('fc1be3r4a2r1r6r6r4-mutationaudit-20260906'),
  'Y2a after the published one it may not reuse');
ok(RO.appTokenRefCount(INDEX) >= 20,
  'Y2c every asset in the co-deployed set rotated together (' + RO.appTokenRefCount(INDEX) + ')');
ok(INDEX.indexOf('inventory-replenishment.js?v=' + RO.currentAppToken()) !== -1,
  'Y2d including inventory-replenishment.js, the file that actually changed this round');
// NO SERVER CHANGE. The Save uses the shipped writer and the shipped router exactly as they are.
// R6-R6-R4-R2 — 16_ IS TOUCHED THIS ROUND, and saying otherwise would be the comfortable lie. The writer
// now refuses an UPDATE that declares no expected version, so a NEW WEB APP DEPLOYMENT VERSION IS REQUIRED,
// and the order matters: frontend first, Apps Script second, or a browser holding the old page is refused.
ok(G16.indexOf('R6-R6-R4-R2') !== -1, 'Y3  16_ IS changed this round — a new deployment version is required');
ok(G01.indexOf('R6-R6-R4') === -1, 'Y3a the router is not: nothing new is reachable over HTTP');
ok(/MISSING_OPTIMISTIC_TOKEN/.test(G16), 'Y3b and the new refusal is typed');
// THE FLAG AND THE ALLOWLIST.
var CFG = read('assets/specs/active/apps-script/00_config.gs');
ok(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;/.test(CFG), 'Y4  the AI Plan flag is still false');
var nonHelper = (CENSUS.match(/^function ([A-Za-z0-9_]+)\s*\(/gm) || [])
  .map(function (m) { return m.replace(/^function /, '').replace(/\s*\($/, ''); })
  .filter(function (n) { return n.indexOf('CENSUS_') !== 0; });
['RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS', 'RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK',
 'RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST'].forEach(function (n, i) {
  ok(nonHelper.indexOf(n) !== -1, 'Y5' + '.abc'[i] + ' ' + n + ' is an entry point');
  ok(new RegExp('function ' + n + '\\(\\)').test(CENSUS),
    'Y5' + '.abc'[i] + '1 and takes no arguments, so it cannot be aimed');
});

// ================================================================================================================
section('§8 — MUTANTS');
// ================================================================================================================
function withCensus(src, over) { return new World(over || {}, src); }
// The census file is CRLF. A multi-line anchor written with bare newlines matches nothing, swap() throws,
// and the probe reports a PROBE ERROR rather than silently passing — but it still has to be right.
var CR = String.fromCharCode(13) + String.fromCharCode(10);
function cr() { return Array.prototype.slice.call(arguments).join(CR); }
mut('N1  the readiness reusing R6-R6-R3\'s pre-repair Route B baseline', function () {
  var m = swap(CENSUS, cr("  draft_version: '3',", "  updated_by: 'r6r6r3-compensating-repair',"),
                       cr("  draft_version: '2',", "  updated_by: 'inventory-replenishment',"));
  var r = withCensus(m).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return r.verdict === 'STOP' && RD.verdict === 'SINGLE_ROW_SAVE_READY';
});
mut('N2  the freeze put back to null, reopening the gap this round closed', function () {
  // The gap machinery is not exercised by the happy path any more, so it is exercised HERE: unfreeze the
  // two instants and the readiness must name them again rather than quietly stop comparing them.
  var m = swap(CENSUS, cr("  updated_at: '" + TS_COMPENSATED + "',",
    "  line_updated_at: '" + TS_COMPENSATED + "'"),
    cr("  updated_at: null,", "  line_updated_at: null"));
  var r = withCensus(m).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return JSON.stringify(r.snapshot_gaps) === JSON.stringify(['route_b.updated_at', 'route_b.line_updated_at'])
    && JSON.stringify(RD.snapshot_gaps) === '[]';
});
mut('N3  a frozen null silently COMPARED instead of reported as a gap', function () {
  // Both mutations at once: unfreeze the instants AND remove the null guard. A null that reaches the
  // comparator stringifies to '' and fails against a real timestamp, so the row would be refused for a
  // reason nobody could act on — which is worse than the gap, not better.
  var m = swap(CENSUS, cr("  updated_at: '" + TS_COMPENSATED + "',",
    "  line_updated_at: '" + TS_COMPENSATED + "'"),
    cr("  updated_at: null,", "  line_updated_at: null"));
  m = swap(m, cr("    if (frozen[k] === null || frozen[k] === undefined) {",
    "      if (gaps.indexOf(prefix + '.' + k) === -1) gaps.push(prefix + '.' + k);"),
    cr("    if (false) {",
    "      if (gaps.indexOf(prefix + '.' + k) === -1) gaps.push(prefix + '.' + k);"));
  var r = withCensus(m).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return r.verdict === 'STOP' && JSON.stringify(r.snapshot_gaps) === '[]'
    && has(r, 'route_b_updated_at_unchanged') && RD.verdict === 'SINGLE_ROW_SAVE_READY';
});
mut('N13 the two instants left to the DERIVED gates alone, with no equality gate', function () {
  // The derived floor accepts anything after the compensation, so a bystander stamped one second later
  // would pass. That is exactly the drift the equality gate exists to catch.
  var m = swap(CENSUS, cr("  updated_at: '" + TS_COMPENSATED + "',",
    "  line_updated_at: '" + TS_COMPENSATED + "'"),
    cr("  updated_at: null,", "  line_updated_at: null"));
  var over = { bHeader: { updated_at: TS_ONE_SECOND_LATER }, bLine: { updated_at: TS_ONE_SECOND_LATER } };
  var r = withCensus(m, over).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  var real = new World(over).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return r.verdict === 'SINGLE_ROW_SAVE_READY' && real.verdict === 'STOP';
});
mut('N4  the K4 expectation derived from the row being checked instead of from the frozen key', function () {
  var m = swap(CENSUS,
    cr("  out.k4_expected_after = CENSUS_r6r6r4K4Swap_(R6R6R4_A_BEFORE_.k4_group_key,",
       "    R6R6R4_A_BEFORE_.last_mile_delivery, R6R6R4_A_AFTER_LAST_MILE_);"),
    "  out.k4_expected_after = a ? CENSUS_str_(a.k4_group_key) : null;");
  var over = { aHeader: { recommended_last_mile_delivery: 'parcel', draft_version: '3',
    recommended_shipping_method: 'air', updated_at: TS_SAVE }, aLine: { updated_at: TS_SAVE } };
  var r = withCensus(m, over).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
  // The mutant accepts a route whose identity moved on a second dimension; the real gate names it.
  return !has(r, 'route_a_k4_is_the_frozen_key_with_only_the_last_mile_segment_replaced')
    && has(rK4, 'route_a_k4_is_the_frozen_key_with_only_the_last_mile_segment_replaced');
});
mut('N5  the version gate accepting any advance instead of exactly one', function () {
  var m = swap(CENSUS, cr("    a ? CENSUS_str_(a.draft_version) : null,",
    "    !!a && CENSUS_str_(a.draft_version) === R6R6R4_A_AFTER_DRAFT_VERSION_);"),
    cr("    a ? CENSUS_str_(a.draft_version) : null,",
    "    !!a && CENSUS_num_(a.draft_version) > CENSUS_num_(R6R6R4_A_BEFORE_.draft_version));"));
  var r = withCensus(m, { aHeader: { recommended_last_mile_delivery: 'truck', draft_version: '5', updated_at: TS_SAVE },
    aLine: { updated_at: TS_SAVE } }).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
  return !has(r, 'route_a_draft_version_advanced_by_exactly_one') && has(rTwo, 'route_a_draft_version_advanced_by_exactly_one');
});
mut('N6  the predates-the-save comparison inverted so a written Route B passes', function () {
  var m = swap(CENSUS, "      b ? CENSUS_str_(b[fld]) : null, bNow !== null && aNow !== null && bNow < aNow);",
                       "      b ? CENSUS_str_(b[fld]) : null, bNow !== null && aNow !== null);");
  var wm = withCensus(m);
  wm.save(A_HEADER, A_LINE, 'truck');
  wm.save(B_HEADER, B_LINE, 'parcel');
  var r = wm.run('RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK').res;
  return !has(r, 'route_b_updated_at_predates_the_route_a_save')
    && has(rMix, 'route_b_updated_at_predates_the_route_a_save');
});
mut('N7  ALREADY_SAVED folded into an ordinary STOP', function () {
  var m = swap(CENSUS, "  out.already_saved = !!a && CENSUS_str_(a.last_mile_delivery).toLowerCase() === R6R6R4_A_AFTER_LAST_MILE_",
                       "  out.already_saved = false && CENSUS_str_(a.last_mile_delivery).toLowerCase() === R6R6R4_A_AFTER_LAST_MILE_");
  var r = withCensus(m, { aHeader: { recommended_last_mile_delivery: 'parcel', draft_version: '3', updated_at: TS_SAVE },
    aLine: { updated_at: TS_SAVE } }).run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return r.already_saved === false && rDone.already_saved === true;
});
mut('N8  the readiness declaring READY while a predicate failed', function () {
  var m = swap(CENSUS, cr("  if (out.predicates_failed === 0) {", "    out.verdict = 'SINGLE_ROW_SAVE_READY';"),
                       cr("  if (true) {", "    out.verdict = 'SINGLE_ROW_SAVE_READY';"));
  var r = withCensus(m, { bHeader: { recommended_last_mile_delivery: 'parcel' } })
    .run('RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS').res;
  return r.verdict === 'SINGLE_ROW_SAVE_READY' && r.predicates_failed > 0;
});
mut('N9  the stage-two manifest reporting itself as authorized', function () {
  var m = swap(CENSUS, "    authorized: false,          // ALWAYS false in this round.",
                       "    authorized: true,           // ALWAYS false in this round.");
  var r = withCensus(m).run('RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST').res;
  return r.authorized === true && ST.authorized === false;
});
mut('N10 the mutation audit dropping the intent it was added to report', function () {
  var src = extractFn(DBAPI, '_kmMutationShape_');
  var m = swap(src, "        out.intent = String((h && h.intent) || p.intent || '') || null;",
                    "        out.intent = null;");
  var f = new Function('return ' + m + NL + ';_kmMutationShape_')();
  var o = f('x', { intent: 'UPDATE_EXISTING_ROUTE', header: {}, lines: [] });
  return o.intent === null && one.intent === 'UPDATE_EXISTING_ROUTE';
});
mut('N11 a minting payload reported as an ordinary update', function () {
  var src = extractFn(DBAPI, '_kmMutationShape_');
  var m = swap(src, "        out.mints_new_row = (String(out.intent || '').toUpperCase().indexOf('CREATE') !== -1)",
                    "        out.mints_new_row = (false)");
  var f = new Function('return ' + m + NL + ';_kmMutationShape_')();
  var o = f('x', { intent: 'CREATE_NEW_ROUTE', header: {}, lines: [{ allocation_draft_line_id: 'SADL-X' }] });
  var real = shape('x', { intent: 'CREATE_NEW_ROUTE', header: {}, lines: [{ allocation_draft_line_id: 'SADL-X' }] });
  return o.mints_new_row === false && real.mints_new_row === true;
});
mut('N12 the transport reading "not told" as "no"', function () {
  var m = swap(TRANSPORT,
    "            has_create_idempotency_key: (typeof sample.has_create_idempotency_key === 'boolean') ? sample.has_create_idempotency_key : null,",
    "            has_create_idempotency_key: sample.has_create_idempotency_key === true,");
  var x = transportFactory(m).create();
  x.recordExternal({ action: 'w', kind: 'write', ms: 10 });
  return x.timeline().mutations[0].has_create_idempotency_key === false
    && tp2.timeline().mutations[0].has_create_idempotency_key === null;
});

mut('N14 the writer gate removed, so an UPDATE with no token commits again', function () {
  // The exact defect this round found: the guard runs only when the field is PRESENT, and the version
  // advances anyway — which is why a row at 3 was never evidence that the request had declared 2.
  var m = swap(G16, "    if (sadIntent === 'UPDATE_EXISTING_ROUTE' && sadExpDeclared === null) {",
    "    if (false) {");
  var w2 = new World({}, null, m);
  var r = w2.write(updateBody(null, null));
  return r.parsed && r.parsed.success === true && String(w2.header(A_HEADER).draft_version) === '4'
    && noTok.parsed.code === 'MISSING_OPTIMISTIC_TOKEN';
});
mut('N15 the missing token FILLED IN from the row instead of refused', function () {
  // The repair that deletes the protection while appearing to add it: adopt the current version as the
  // expectation and the check passes by construction, for every caller, for ever.
  var m = swap(G16, "      : ((body && body.expected_draft_version != null",
    "      : ((true");
  m = swap(m, "        && String(body.expected_draft_version).trim() !== '') ? body.expected_draft_version : null);",
    "        && true) ? priorVersion : null);");
  var w2 = new World({}, null, m);
  var r = w2.write(updateBody(null, null));
  return r.parsed && r.parsed.success === true && noTok.parsed.code === 'MISSING_OPTIMISTIC_TOKEN';
});
mut('N16 the documented top-level expected_draft_version ignored again', function () {
  var m = swap(G16, "      : ((body && body.expected_draft_version != null", "      : ((false");
  var w2 = new World({}, null, m);
  var r = w2.write(updateBody(null, '3'));
  return r.parsed && r.parsed.code === 'MISSING_OPTIMISTIC_TOKEN' && topOnly.parsed.success === true;
});
mut('N17 the collected row dropping draft_version, exactly as it did in production', function () {
  // Source-shaped, because the collector needs a whole page to run — but the CONSEQUENCE is measured: with
  // the field gone the model has no version, the header omits the token, and the writer now refuses.
  var m = swap(PAGE, '            draft_version: boundDraftVersion,', '');
  return !/draft_version: boundDraftVersion,/.test(m) && /draft_version: boundDraftVersion,/.test(PAGE)
    && attempt({}, uiBody(MODEL_LOST)).parsed.code === 'MISSING_OPTIMISTIC_TOKEN';
});
mut('N18 the audit reading the token from the body only, so a header-only request reports null', function () {
  var src = extractFn(DBAPI, '_kmMutationShape_');
  var m = swap(src, "        out.expected_draft_version = ((h && h.expected_draft_version) != null)",
    "        out.expected_draft_version = (false)");
  var fn = new Function('return ' + m + NL + ';_kmMutationShape_')();
  var o = fn('x', { header: { expected_draft_version: '3' }, lines: [] });
  return o.expected_draft_version === null && shapeOk.expected_draft_version === '3';
});
mut('N19 the audit reconstructing the token from the AFTER version instead of reading the request', function () {
  var src = extractFn(DBAPI, '_kmMutationShape_');
  var m = swap(src, "            : ((p.expected_draft_version != null) ? String(p.expected_draft_version) : null);",
    "            : '3';");
  var fn = new Function('return ' + m + NL + ';_kmMutationShape_')();
  var o = fn('x', { header: {}, lines: [] });
  return o.expected_draft_version === '3' && shapeLost.expected_draft_version === null;
});
console.log('\npassed ' + pass + '  failed ' + fail
  + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);
})();
