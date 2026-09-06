// F1-7N-FB-4F-B6 — LEGACY ROUTE EXPLICIT CONFIRMATION + HYDRATION REPAIR.
//
// The live state this round acts on (B5 SUMMARY, production run — frozen facts, never a fixture):
//   drafts 35 cols / 4 rows / sf:870364de ACCEPTED · lines 31 cols / 6 rows / sf:122f48c3 ACCEPTED
//   raw quantity 1020 · matched lines 6 · orphans 0 · downstream stored FK 0 · checksum fb4b5-1:4e40c4f3
//   H1 ResUS/US/Amazon sea_express  destination BLANK  0 lines / 0
//   H2 ResUS/US/Amazon air          destination BLANK  0 lines / 0
//   H3 ResTW/JP/Amazon air          destination BLANK  5 lines / 220
//   H4 ResUS/US/Amazon sea          destination BLANK  1 line  / 800
//   attempt evidence ONLY: sea_express / Amazon / 400 / ETA 2026-10-16 — persisted nowhere.
//
// Nothing below describes the code. The CLIENT half lifts the shipped page functions out of
// assets/js/pages/inventory-replenishment.js and RUNS them; the SERVER half runs the shipped 16_/69_ cores
// against an in-memory sheet seeded with the four frozen headers. Structural claims are made against
// comment-stripped source, because B5 already learned that a file's own prose can satisfy a substring search.
//
// Known regression baseline (pre-existing, unrelated to this round): gap-job-done-notice-f1-small-r1,
// order-planning-monthly-projection-consumer-f1-4b-fm3d, replen-header-toggle, supply-planning-route-inventory.
//
// Run: node assets/tests/legacy-route-confirmation-and-hydration-repair-f1-7n-fb-4f-b6.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var fail = 0, pass = 0;
function ok(c, l) { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.error('FAIL ' + l); } }
function eq(a, e, l) { var A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) { pass++; console.log('ok   ' + l); } else { fail++; console.error('FAIL ' + l + '\n  exp ' + E + '\n  got ' + A); } }
function section(t) { console.log('\n== ' + t + ' =='); }

var ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); }

var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CMP = read('assets/js/utils/inventory-compat.js');
var INDEX = read('index.html');
var G16C = code(G16), PAGEC = code(PAGE), CMPC = code(CMP);

var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var COMPAT = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js'));
var IRDraft = COMPAT.IRDraft, IRWarehouse = COMPAT.IRWarehouse;

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '('); if (start < 0) throw new Error('not found: ' + name);
  var i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
function extractVar(src, name) {
  var m = new RegExp('var ' + name + '\\s*=').exec(src); if (!m) throw new Error('not found: ' + name);
  var i = src.indexOf('=', m.index) + 1;
  while (' \t\r\n'.indexOf(src[i]) >= 0) i++;
  if (src[i] === '{' || src[i] === '[') {
    var open = src[i], close = open === '{' ? '}' : ']', d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (d === 0) break; } }
    return src.slice(m.index, j + 1) + ';';
  }
  return src.slice(m.index, src.indexOf(';', i) + 1);
}

// ================================================================================================================
// THE FROZEN LIVE FACTS. Declared once, used by both halves. No test may restate a value that is not here.
// ================================================================================================================
var LIVE = {
  schema: { draftCols: 35, lineCols: 31, draftRows: 4, lineRows: 6, rawQty: 1020, matched: 6, orphans: 0, downstreamFk: 0 },
  headers: [
    { key: 'H1', company: 'ResUS', country: 'US', marketplace: 'Amazon', service: 'sea_express', lines: 0, qty: 0 },
    { key: 'H2', company: 'ResUS', country: 'US', marketplace: 'Amazon', service: 'air', lines: 0, qty: 0 },
    { key: 'H3', company: 'ResTW', country: 'JP', marketplace: 'Amazon', service: 'air', lines: 5, qty: 220 },
    { key: 'H4', company: 'ResUS', country: 'US', marketplace: 'Amazon', service: 'sea', lines: 1, qty: 800 }
  ],
  // ATTEMPT EVIDENCE ONLY — persisted nowhere, and no test may treat it as stored state.
  attempt: { service: 'sea_express', destination: 'Amazon', qty: 400, eta: '2026-10-16' }
};
var US_SCOPE = { company: 'ResUS', country: 'US', marketplace: 'Amazon' };
var TW_SCOPE = { company: 'ResTW', country: 'JP', marketplace: 'Amazon' };
var FROM_WH = 'WH-CN-01';
var SKU_800 = 'CO1100-R';

// ================================================================================================================
// THE SERVER: the shipped 16_ + 69_ cores over an in-memory sheet. Only the spreadsheet is simulated.
// ================================================================================================================
function FakeSheet(headers) { this.rows = [headers.slice()]; }
FakeSheet.prototype.getLastColumn = function () { return this.rows[0].length; };
FakeSheet.prototype.getDataRange = function () { var s = this; return { getValues: function () { return s.rows.map(function (r) { return r.slice(); }); } }; };
FakeSheet.prototype.appendRow = function (r) { this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (row, col, nr, nc) {
  var s = this;
  return {
    getValues: function () {
      var out = [];
      for (var i = 0; i < (nr || 1); i++) { var line = [];
        for (var j = 0; j < (nc || 1); j++) line.push(s.rows[row - 1 + i][col - 1 + j]);
        out.push(line); }
      return out;
    },
    getValue: function () { return s.rows[row - 1][col - 1]; },
    setValue: function (v) { s.rows[row - 1][col - 1] = v; }
  };
};
var SHEETS = {};
var SpreadsheetApp = { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return SHEETS[n] || null; } }; } };
var LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
var Utilities = { getUuid: function () { return 'UUID000000000000'; } };
var __now = '2026-09-01 09:00:00';
function procurementTimestamp_() { return __now; }
function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ''; }
function prodRequireSheet_(ss, name) { return SHEETS[name]; }
function jsonResponse_(o) { return o; }

eval(extractFn(G13, 'procurementEnsureSheet_'));
eval(extractFn(G13, 'procurementAppendByHeader_'));
eval(extractFn(G13, 'procurementFindRow_'));
eval([ 'SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_',
  'SAD_LIFECYCLE_TAIL_COLUMNS_', 'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_',
    // F1-7N-FB-4G-A2-R3 - the optional tail gained a third append; a lift that stops at two
    // ReferenceErrors inside a shipped constant.
    'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
  'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SAD_SCHEMA_GENERATIONS_', 'SAD_AI_K2_INTENT_', 'SAD_ROUTE_INTENTS_', 'SAD_CLIENT_GRANTABLE_INTENTS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_',
  'SAD_LINE_ETA_TAIL_COLUMNS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_',
  'SAD_STATUSES_', 'SAD_LINE_STATUSES_', 'SAD_TERMINAL_STATUSES_', 'SAD_TERMINAL_LINE_STATUSES_',
  'SAD_GENERATION_TYPES_', 'SAD_RECOMMENDATION_FIELDS_', 'SAD_LINE_LEGACY_ALIASES_',
  'SAD_K2_GROUP_DIMENSIONS_', 'SAD_LINE_IDENTITY_FIELDS_', 'SAD_K2_HEADER_FP_', 'SAD_K2_LINE_FP_',
  'SAD_K2_FP_DATE_FIELDS_', 'SAD_K2_FP_NUMERIC_FIELDS_', 'SAD_K2_SEM_CONTRACT_', 'SAD_K2_SEM_EXCLUDED_LIFECYCLE_',
  'SAD_K2_SEM_OPTIONAL_PRESERVE_', 'SAD_K2_SEM_EXCLUDE_',
  'SAD_K2_BASIS_ID_MATCHES_', 'SAD_K2_BASIS_STALE_ACCEPTED_', 'SAD_K2_BASIS_DIFFERENT_GROUP_',
  'SAD_K2_BASIS_NO_REQUEST_GROUP_', 'SAD_K2_BASIS_CONTESTED_', 'SAD_BUILD_VERSION_'
].map(function (v) { return extractVar(G16, v); }).join(String.fromCharCode(10)));
eval([ 'RIC_CANONICAL_SERVICES_', 'RIC_SERVICE_LABELS_', 'RIC_DESTINATION_TYPES_', 'RIC_K4_GROUP_DIMENSIONS_',
  'RIC_SCHEMA_REFUSALS_', 'RIC_B2_REQUIRED_COLUMNS_', 'RIC_BUILD_VERSION_'
].map(function (v) { return extractVar(G69, v); }).join(String.fromCharCode(10)));
eval(['ricCanonicalService_', 'ricDestinationIdentity_', 'ricK4GroupKey_', 'ricK4DeterministicHeaderId_',
  'ricRoutePersistability_'].map(function (fn) { return extractFn(G69, fn); }).join('\n'));
eval(['sadApplyLineAliases_', 'sadFnv1a_', 'sadLineNaturalKey_', 'sadDeterministicLineId_', 'sadFindLineByNaturalKey_',
  'sadHeaderStatusValid_', 'sadLineStatusValid_',
  'sadK2GroupKey_', 'sadK2DeterministicHeaderId_', 'sadK2LineNaturalKey_', 'sadK2DeterministicLineId_',
  'sadIsK2Group_', 'sadNewLineId_', 'sadK2ResolveActiveDraft_', 'sadK2LinesRouteCompatibleWithHeader_',
  'sadCanonicalLineId_', 'sadSameLineIdentity_', 'sadPreflightLineBatch_', 'sadScanDuplicateLinePks_',
  'sadVerifyDraftLines_', 'sadLineIsComplete_', 'sadDestinationIdentity_', 'sadStoredHeaderRouteIsComplete_', 'sadHeaderRouteIsComplete_',
  'sadFpVal_', 'sadK2PayloadFingerprint_', 'sadCanonDate_', 'sadFpNorm_', 'sadK2SemFieldClass_',
  'sadK2SemFieldVerdict_', 'sadK2SemFieldEqual_', 'sadK2SemanticPayloadEqual_', 'sadRegenerateLinePatch_',
  'sadK2LineIdentity_',
  'sadLiveHeaderNames_', 'sadHasColumn_', 'sadK4SchemaReady_', 'sadSchemaRefusal_', 'sadK4ResolveActiveDraft_',
  'sadExactSchemaReason_', 'sadAtomicValidateBatch_', 'sadResolveActiveDraft_', 'sadReadActiveHeaderRows_',
  'sadResolveActiveDraftK2OrK3_', 'sadK2ReconcileDecision_', 'sadLegacyReconcileReason_',
  'sadResolveBlockMessage_', 'sadReconcileMessage_', 'sadRowToObject_', 'sadReadLinesForDraft_',
  // F1-7N-FB-4G-A2-R3 - the atomic core reaches three new authorities: whether this deployment can store
  // a create key, the replay lookup, and the identity mint for a new ticket. A lift that omits any of them
  // ReferenceErrors inside a shipped function, which reads exactly like a production defect.
  'sadCreateIdempotencyReady_', 'sadFindHeaderByCreateKey_', 'sadMintNewHeaderId_',
  'sadSchemaGenerationColumns_', 'sadSupportedSchemaVersions_', 'sadAiK2IntentEvidence_', 'sadResolveHeaderSchema_',
  'sadDraftsSchemaReason_', 'sadAtomicUpsertCore_', 'sadSubmitToShippingPlansCore_'
].map(function (fn) { return extractFn(G16, fn); }).join('\n'));

function resetDb() {
  SHEETS['shipping_allocation_drafts'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_);
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_);
}
function headerObjs() {
  var h = SHEETS['shipping_allocation_drafts'].rows[0];
  return SHEETS['shipping_allocation_drafts'].rows.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { if (k) o[k] = r[i]; }); return o; });
}
function lineObjs() {
  var h = SHEETS['shipping_allocation_draft_lines'].rows[0];
  return SHEETS['shipping_allocation_draft_lines'].rows.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { if (k) o[k] = r[i]; }); return o; });
}
// Seed the four frozen live headers. Ids are DERIVED from each row's own K2 group key, which is what the live
// generation minted — never invented here, and never read back as though the live id were known.
function seedLive(opts) {
  opts = opts || {};
  resetDb();
  LIVE.headers.forEach(function (H) {
    var dims = { planning_cycle: '', company: H.company, country: H.country, marketplace: H.marketplace,
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', recommended_shipping_method: H.service,
      recommended_last_mile_delivery: '', recommendation_group_no: '' };
    var id = sadK2DeterministicHeaderId_(dims);
    H.id = id;
    procurementAppendByHeader_(SHEETS['shipping_allocation_drafts'], {
      allocation_draft_id: id, planning_cycle: '', source_page: 'inventory_replenishment',
      company: H.company, country: H.country, marketplace: H.marketplace,
      status: (opts.terminal === H.key) ? 'submitted' : 'draft',
      recommended_source_warehouse_id: FROM_WH, recommended_destination_warehouse_id: '',
      recommended_source_warehouse_code_snapshot: '', recommended_destination_warehouse_code_snapshot: '',
      recommendation_group_no: '', recommended_shipping_method: H.service, recommended_last_mile_delivery: '',
      generation_type: 'user_created', calculation_run_id: '', formula_version: '', calculated_at: '',
      source_data_as_of: '', draft_version: '1',
      generation_run_id: '', expired_at: '', expired_by_run_id: '', expiration_reason: '',
      destination_marketplace: '',
      created_by: 'inventory-replenishment', created_at: __now, updated_by: 'inventory-replenishment', updated_at: __now,
      submitted_by: '', submitted_at: '', cancelled_by: '', cancelled_at: '', cancel_reason: '', note: ''
    });
    for (var i = 0; i < H.lines; i++) {
      var sku = (H.key === 'H4') ? SKU_800 : ('TW-SKU-' + (i + 1));
      var qty = (H.key === 'H4') ? 800 : [50, 50, 40, 40, 40][i];
      var l = { sku: sku, site_sku: sku + '-' + H.country, window_code: 'W36' };
      procurementAppendByHeader_(SHEETS['shipping_allocation_draft_lines'], {
        allocation_draft_line_id: sadK2DeterministicLineId_(id, l), allocation_draft_id: id,
        sku: l.sku, site_sku: l.site_sku, window_code: l.window_code,
        source_warehouse_id: FROM_WH, planned_qty: qty, units_per_carton: 10, line_status: 'draft',
        expected_arrival: '', created_at: __now, updated_at: __now
      });
    }
  });
}
// One save through the REAL atomic core, shaped exactly as _irPersistOneRouteGroup_ shapes it.
// F1-7N-FB-4G-A2-R3 - a distinct create key per CREATE, so no two of them look like one retried click.
var __criSeq = 0;

function saveRoute(scope, opts) {
  var header = IRDraft.buildDraftHeaderPayload({
    // F1-7N-FB-4G-A2-R3 - an explicit id makes this an UPDATE of that exact row (§B.1). Without one the save
    // is a CREATE and gets its own ticket; it can no longer resolve onto someone else's header by natural key.
    allocation_draft_id: opts.id || undefined,
    company: scope.company, country: scope.country, marketplace: scope.marketplace,
    source_warehouse_id: opts.from == null ? FROM_WH : opts.from,
    destination_warehouse_id: opts.destination_warehouse_id || '',
    shipping_method: opts.service,
    destination_marketplace: opts.destination_marketplace || undefined,
    allow_legacy_reconcile: opts.allow === true ? true : undefined
  });
  // F1-7N-FB-4G-A2-R3 §B/§D - THE ATOMIC WRITER NOW REQUIRES A DECLARED INTENT.
  //
  // A route write says whether it is UPDATE_EXISTING_ROUTE or CREATE_NEW_ROUTE; it is never inferred from
  // whether a natural key happens to match, because that inference is what turned one edited route into
  // three headers. A CREATE also carries a create_idempotency_key so a retried click cannot mint a second
  // ticket. This helper derives both the way the shipped client derives them: from whether the row it is
  // saving already holds an allocation_draft_id.
  // An ADOPTION (opts.allow) is its own explicitly-authorised operation and declares no route intent - it
  // resolves the legacy header by natural key on purpose. Everything else declares one, as the client does.
  var _hasId = !!String(header.allocation_draft_id || '').trim();
  var _adopting = opts.allow === true;
  var _intent = _adopting ? undefined : (_hasId ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE');
  // R6-R6-R4-R2 — AN UPDATE NOW DECLARES THE VERSION IT READ. This shim mirrors the shipped client, and the
  // shipped client sends expected_draft_version on every UPDATE_EXISTING_ROUTE; 16_ refuses one that does not
  // (MISSING_OPTIMISTIC_TOKEN, zero rows written). Read from the stored row, exactly as the page reads it from
  // the version it hydrated — never computed, and never filled in by the writer.
  if (_intent === 'UPDATE_EXISTING_ROUTE' && header.expected_draft_version == null) {
    headerObjs().forEach(function (o) {
      if (String(o.allocation_draft_id || '') === String(header.allocation_draft_id || '')
          && String(o.draft_version || '') !== '') header.expected_draft_version = String(o.draft_version);
    });
  }
  return sadAtomicUpsertCore_({ header: header, lines: opts.lines || [],
    intent: _intent,
    create_idempotency_key: (_adopting || _hasId) ? undefined : ('CRI-B6-' + (++__criSeq)),
    allow_legacy_reconcile: _adopting ? true : undefined });
}
function totalQty() { return lineObjs().reduce(function (n, l) { return n + (Number(l.planned_qty) || 0); }, 0); }
function ids() { return headerObjs().map(function (h) { return h.allocation_draft_id; }); }

// ================================================================================================================
// THE CLIENT: the shipped page functions, lifted and RUN.
// ================================================================================================================
function clientEnv() {
  var sb = {
    String: String, Object: Object, Number: Number, Math: Math, JSON: JSON, Array: Array, Date: Date,
    isNaN: isNaN, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat, Boolean: Boolean,
    RegExp: RegExp, Error: Error, Promise: Promise,
    console: { warn: function () {}, log: function () {}, error: function () {} }
  };
  sb.window = sb; sb.globalThis = sb;
  // R6-R2: the hydrate's scope predicate now belongs to KMARC. A harness that lifts the hydrate has to
  // supply it, or the shipped code correctly refuses to hydrate anything at all.
  sb.KMARC = require('../js/core/supply-planning-active-route-classification.js');
  sb.replenAllocationDraft = { context: null, bySku: {}, targetDays: '' };
  sb._persistAllocationDraft = function () {};
  sb._irRenderDuplicateCorruptionBanner_ = function () {};
  sb._irRenderUnsavedBanner_ = function () {};
  sb._irUnsavedRoutes = {};
  sb.renderReplenishment = function () { sb.__renders = (sb.__renders || 0) + 1; };
  sb.KM = { DB: {} };
  sb.IRWarehouse = IRWarehouse;
  sb.IRDraft = IRDraft;
  var ctx = vm.createContext(sb);
  vm.runInContext([
    'var _replenHydrateToken = 0;',
    // F1-7N-FB-4F-B6-R1 - the hydrate validates the persisted expected_arrival's SHAPE, so the lift has to
    // carry that helper too. Without it the hydrate's own try/catch swallows the ReferenceError and returns
    // false, which reads exactly like "the live row was dropped" - a defect the runtime does not have.
    extractVar(PAGE, 'IR_ISO_DATE_RE_'),
    extractFn(PAGE, '_irCanonicalDateOrBlank_'),
    // F1-7N-FB-4G-A0 - and the hydrate now obtains its ROWS through the page's read-model-first accessor
    // (_irWsGet) rather than the broad-cache getter directly, because the broad cache has no writer the server
    // will honour. With no _irReadModel defined, _irWsGet falls through to exactly the window.KM.DB getter this
    // lift already stubs, so what this suite measures is unchanged.
    (PAGE.match(/var _irReadModel = null;/) || [''])[0],
    extractFn(PAGE, '_irWsGet'),
    extractFn(PAGE, '_hydrateAllocationDraftFromDb'),
    extractFn(PAGE, '_isRouteComplete'),
    extractFn(PAGE, '_execToOptionsHtml'),
    extractFn(PAGE, '_execWhOption'),
    extractFn(PAGE, '_execEsc'),
    extractFn(PAGE, '_execNameCounts'),
    extractFn(PAGE, '_execNameKey'),
    extractFn(PAGE, '_execEq'),
    extractFn(PAGE, '_execResolveIdByName'),
    extractFn(PAGE, '_irAdoptionGroupsNeedingConfirmation_'),
    extractFn(PAGE, '_irAdoptionConfirmationDetail_'),
    extractFn(PAGE, '_irConfirmLegacyAdoption_'),
    extractFn(PAGE, '_irRoutesMissingDestination_')
  ].join('\n'), ctx);
  return { ctx: ctx, sb: sb, run: function (e) { return vm.runInContext(e, ctx); } };
}
// The four frozen headers, in the shape the shipped adapter normalizer emits.
function dbHeaders(scopeFilterAll) {
  return LIVE.headers.map(function (H) {
    return { allocationDraftId: H.key, company: H.company, country: H.country, marketplace: H.marketplace,
      status: 'draft',
      raw: { allocation_draft_id: H.key, company: H.company, country: H.country, marketplace: H.marketplace,
        status: 'draft', recommended_source_warehouse_id: FROM_WH,
        recommended_destination_warehouse_id: '', destination_marketplace: '',
        recommended_shipping_method: H.service, recommended_last_mile_delivery: '',
        generation_type: 'user_created' } };
  });
}
function dbLines() {
  var out = [];
  LIVE.headers.forEach(function (H) {
    for (var i = 0; i < H.lines; i++) {
      var sku = (H.key === 'H4') ? SKU_800 : ('TW-SKU-' + (i + 1));
      var qty = (H.key === 'H4') ? 800 : [50, 50, 40, 40, 40][i];
      out.push({ allocationDraftId: H.key, lineStatus: 'draft',
        raw: { allocation_draft_line_id: 'LN-' + H.key + '-' + i, allocation_draft_id: H.key, sku: sku,
          site_sku: sku + '-' + H.country, window_code: 'W36', planned_qty: qty, expected_arrival: '' } });
    }
  });
  return out;
}
function hydrated(scope, mutate) {
  var C = clientEnv();
  var H = dbHeaders(), L = dbLines();
  if (mutate) mutate(H, L, C);
  C.sb.KM.DB.getShippingAllocationDrafts = function () { return H; };
  C.sb.KM.DB.getShippingAllocationDraftLines = function () { return L; };
  C.sb.__hydrated = C.run('_hydrateAllocationDraftFromDb(' + JSON.stringify(scope) + ')');
  return C;
}
// The To option list the shipped picker builds for an Amazon scope.
function toCandidates(scope) {
  return [
    { warehouseId: 'WH-US-3PL-7', warehouseName: 'US 3PL', warehouseCode: 'US-3PL-ONT', country: scope.country },
    IRWarehouse.amazonLogicalDestination(scope)
  ];
}

// ================================================================================================================
section('A — [§C] THE SEVEN DIAGNOSTIC ANSWERS, each demonstrated rather than asserted');
// ================================================================================================================
(function () {
  // ---- C1: why the hydrate synthesised destination_marketplace = ctx.marketplace ---------------------------
  // The ANSWER is structural and it is now history: the three destination fields were derived from `hTo` alone,
  // so a blank stored warehouse was read as "therefore a marketplace destination", and the only marketplace in
  // scope was the page filter. B5 measured that. B6 removed it, and the removal is what is asserted.
  ok(!/destination_marketplace:\s*hTo\s*\?/.test(PAGEC),
    'A1 [§C.1] the hydrate no longer derives a marketplace destination from the ABSENCE of a warehouse');
  ok(!/destination_marketplace:[^\n]*ctx\.marketplace/.test(PAGEC),
    'A2 [§C.1] and no destination field is answered by the page scope any more');
  ok(/resolvePersistedDestination/.test(PAGEC),
    'A3 [§C.1] the destination comes from one resolver over the PERSISTED row');

  // ---- C2: why the To selector rendered its placeholder ----------------------------------------------------
  // Measured: the option list DOES offer Amazon; the selection id the render computes is what was empty. The
  // hydrate emitted destination_type/destination_marketplace, and the render selects on the option VALUE — a
  // token neither field is. That asymmetry, not a missing option, is why the cell was blank.
  var C2 = hydrated(US_SCOPE);
  var row800 = C2.sb.replenAllocationDraft.bySku[SKU_800][0];
  var cand = toCandidates(US_SCOPE);
  C2.sb.__cand = cand;
  var htmlNoSel = C2.run('_execToOptionsHtml(__cand, "", true)');
  ok(htmlNoSel.indexOf('>Amazon</option>') !== -1, 'A4 [§C.2] the Amazon option IS offered by the picker');
  ok(htmlNoSel.indexOf('selected>Amazon</option>') === -1 && /<option value="">To…<\/option>/.test(htmlNoSel),
    'A5 [§C.2] with no matching option VALUE the cell renders the "To…" placeholder');
  var htmlTok = C2.run('_execToOptionsHtml(__cand, ' + JSON.stringify(IRWarehouse.amazonLogicalToken('US')) + ', true)');
  ok(htmlTok.indexOf('selected>Amazon</option>') !== -1,
    'A6 [§C.2] supplying the TOKEN selects it — the gap was the token, never the option list');
  ok(/var toSelId = route\.destination_token \|\|/.test(PAGEC),
    'A7 [§C.2] and the render now reads that token first');

  // ---- C3: why H4's persisted 800 shows as Qty 0 -----------------------------------------------------------
  // Two facts, both measured. FIRST: the hydrate does NOT lose the quantity — run it and 800 is there. SECOND:
  // the hydrate never ran, because the only call site on the normal path is inside a mount-time function whose
  // very first act reads the two scope <select> elements, which are still EMPTY at mount. With an empty scope
  // the guard `(ctx.country || ctx.marketplace)` is false, so nothing hydrates, _allocationDraftRowsFor returns
  // null, and initializeShippingAllocation seeds the DEFAULT Add Route editor with `suggestedQty`. THAT is the 0.
  eq(row800.planned_qty, 800, 'A8 [§C.3] the hydrate itself carries the persisted 800 — no quantity is lost');
  eq(row800.qty, 800, 'A9 [§C.3] and the render field the Qty box reads carries it too');
  var emptyScope = hydrated({ company: '', country: '', marketplace: '' });
  eq(emptyScope.sb.__hydrated, false, 'A10 [§C.3] with an EMPTY scope the hydrate returns false and stores nothing');
  eq(Object.keys(emptyScope.sb.replenAllocationDraft.bySku).length, 0,
    'A11 [§C.3] so bySku is empty, _allocationDraftRowsFor returns null, and the DEFAULT editor renders');
  var restore = extractFn(PAGE, '_restoreAllocationDraftFromSession');
  ok(/var ctx = _replenCtx\(\)/.test(restore) && /ctx\.country \|\| ctx\.marketplace/.test(restore),
    'A12 [§C.3] the mount-time restore gates the hydrate on a scope it reads BEFORE the selectors are populated');
  var mountBlock = PAGE.slice(PAGE.indexOf("console.log('[Replenishment] mount')"));
  mountBlock = mountBlock.slice(0, mountBlock.indexOf('_irMountAfterLoad()') + 40);
  ok(mountBlock.indexOf('_restoreAllocationDraftFromSession();') !== -1 &&
     mountBlock.indexOf('_restoreAllocationDraftFromSession();') < mountBlock.indexOf('_irBootstrapScope_'),
    'A13 [§C.3] and the mount CALLS it before the bootstrap that populates those selectors');
  ok(/_irHydrateDraftForAppliedScope_/.test(code(extractFn(PAGE, '_irApplySearch_'))),
    'A14 [§C.3] THE FIX: the hydrate now runs where the scope actually exists — a confirmed Search');

  // ---- C4/C5: why both simulations return K4_IDENTITY_RECONCILIATION_REQUIRED, and which row is the rival --
  seedLive();
  var rows = sadReadActiveHeaderRows_(SHEETS['shipping_allocation_drafts']);
  eq(rows.filter(function (r) { return ricDestinationIdentity_(r).ok; }).length, 0,
    'A15 [§C.4] NOT ONE live header has a resolvable destination, so K4 can classify none of them');
  function wantHeader(scope, service) {
    return { planning_cycle: '', company: scope.company, country: scope.country, marketplace: scope.marketplace,
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', destination_marketplace: 'Amazon',
      recommended_shipping_method: service, recommended_last_mile_delivery: '', recommendation_group_no: '' };
  }
  var r4sea = sadK4ResolveActiveDraft_(rows, wantHeader(US_SCOPE, 'sea'));
  eq(r4sea.status, 'CREATE', 'A16 [§C.4] K4 therefore finds no match and would CREATE…');
  var resSea = sadResolveActiveDraftK2OrK3_(SHEETS['shipping_allocation_drafts'], wantHeader(US_SCOPE, 'sea'), { k4Ready: true });
  eq([resSea.status, resSea.reason], ['BLOCK', 'K4_IDENTITY_RECONCILIATION_REQUIRED'],
    'A17 [§C.4] …but a K2 rival exists that K4 cannot tell apart, so it BLOCKS instead of creating beside it');
  var resExp = sadResolveActiveDraftK2OrK3_(SHEETS['shipping_allocation_drafts'], wantHeader(US_SCOPE, 'sea_express'), { k4Ready: true });
  eq([resExp.status, resExp.reason], ['BLOCK', 'K4_IDENTITY_RECONCILIATION_REQUIRED'],
    'A18 [§C.4] and the sea_express simulation blocks for the same reason');
  var H1 = LIVE.headers[0], H4 = LIVE.headers[3];
  eq(resExp.id, H1.id, 'A19 [§C.5] the rival for sea_express + Amazon is H1 (the sea_express header)');
  eq(resSea.id, H4.id, 'A20 [§C.5] the rival for sea + Amazon is H4 (the sea header, the one holding 800)');
  ok(H1.id !== H4.id && sadK2GroupKey_({ company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_shipping_method: 'sea' }) !== sadK2GroupKey_({ company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_shipping_method: 'sea_express' }),
    'A21 [§C.5] the two are DIFFERENT rivals because service is a K2 dimension — sea never answers for sea_express');

  // ---- C6: do the zero-line headers participate in rendering, identity, or both? ----------------------------
  var C6 = hydrated(US_SCOPE);
  eq(C6.sb.replenAllocationDraft.allocationDraftIds, ['H1', 'H2', 'H4'],
    'A22 [§C.6] H1/H2 ARE hydrated as active headers of the station…');
  eq(Object.keys(C6.sb.replenAllocationDraft.bySku), [SKU_800],
    'A23 [§C.6] …but contribute NO route row, because a header with no lines renders nothing');
  ok(sadReadActiveHeaderRows_(SHEETS['shipping_allocation_drafts']).filter(function (r) {
      return r.allocation_draft_id === H1.id; }).length === 1,
    'A24 [§C.6] and on the server they ARE candidates for identity matching — H1 is the sea_express rival above');

  // ---- C7: can an existing action do this, or is a contract change required? --------------------------------
  ok(/allow_legacy_reconcile/.test(G16C),
    'A25 [§C.7] the atomic writer ALREADY accepts a user-owned reconcile authority — no new action is needed');
  var reg = (INDEX, read('assets/js/api/operation-system-db-api.js'));
  // F1-7N-FC-1A-R1 — at-or-after.
ok(Number((reg.match(/var KM_EXPECTED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1]) >= 10,
    'A26 [§C.7] the action contract stays at 10');
  eq((reg.match(/var KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_ = (\d+);/) || [])[1], '1',
    'A27 [§C.7] and the transport contract stays at 1 — B6 adds no action and no route');
  // The deployment's own side of the same three axes: action 10 / required-action-list 9 / transport 1.
  // F1-7N-FB-4G-A2-R3 — RESTATED. B6 moved no contract version, and asserting the triple as an equality said
  // something stronger: that no LATER round may move one either. A2-R3 registers a new required action, which
  // that constant's own rule says must bump the LIST version (9 -> 10); the ACTION contract and the TRANSPORT
  // contract are untouched, because no router action and no envelope shape changed. Each axis is asserted for
  // what it actually governs.
  eq([String(Number((G63.match(/var SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1]) >= 10),
      (G63.match(/var SYS_TRANSPORT_CONTRACT_VERSION_ = (\d+);/) || [])[1]], ['true', '1'],
    'A28 [§C.7, §K] the deployed ACTION contract is at or after 10 and the TRANSPORT contract is still 1 ' +
    '— two independent axes, and only the action axis moves when a route is added');
  ok(Number((G63.match(/var SYS_REQUIRED_ACTION_LIST_VERSION_ = (\d+);/) || [])[1]) >= 9,
    'A28a and the required-action LIST version is at or after 9 (it is append-only)');
})();

// ================================================================================================================
section('B — [§D, tests 2-6] ONE DESTINATION AUTHORITY');
// ================================================================================================================
(function () {
  // test 2 — no ctx.marketplace synthesis, measured on the live-shaped row.
  var C = hydrated(US_SCOPE);
  var r = C.sb.replenAllocationDraft.bySku[SKU_800][0];
  eq(r.destination_marketplace, '', 'B1 [test 2] a blank persisted destination hydrates as BLANK, not as the scope');
  eq(r.destination_warehouse_id, '', 'B2 [test 2] and no warehouse is invented either');
  eq(r.destination_type, '', 'B3 [test 2] nor a MARKETPLACE_DESTINATION type');
  // test 3 — the typed state.
  eq(r.destination_state, 'DESTINATION_CONFIRMATION_REQUIRED', 'B4 [test 3] it carries the typed confirmation state');
  eq(C.run('_isRouteComplete(replenAllocationDraft.bySku["' + SKU_800 + '"][0])'), false,
    'B5 [test 3] so the completeness gate refuses it and no write can be scheduled for it');
  // test 1 — the row still renders as a PERSISTED route: real From, real Method, real 800.
  eq([r.source_warehouse_id, r.shipping_method, r.qty], [FROM_WH, 'sea', 800],
    'B6 [test 1] H4 hydrates as Sea / 800 from WH-CN-01 — From, Method and Qty all persisted');

  // test 4 — a persisted marketplace emits the exact selector token.
  var CM = hydrated(US_SCOPE, function (H) { H[3].raw.destination_marketplace = 'Amazon'; });
  var rm = CM.sb.replenAllocationDraft.bySku[SKU_800][0];
  eq(rm.destination_marketplace, 'Amazon', 'B7 [test 4] a PERSISTED marketplace hydrates as itself');
  eq(rm.destination_type, 'MARKETPLACE_DESTINATION', 'B8 [test 4] with the marketplace destination type');
  eq(rm.destination_token, IRWarehouse.amazonLogicalToken('US'), 'B9 [test 4] and the EXACT token the selector expects');
  eq(rm.destination_state, 'PERSISTED_MARKETPLACE', 'B10 [test 4] no confirmation is required for a stored destination');
  CM.sb.__cand = toCandidates(US_SCOPE);
  var html = CM.run('_execToOptionsHtml(__cand, replenAllocationDraft.bySku["' + SKU_800 + '"][0].destination_token, true)');
  ok(html.indexOf('selected>Amazon</option>') !== -1, 'B11 [test 4] which SELECTS Amazon in the rendered To cell');
  eq(CM.run('_isRouteComplete(replenAllocationDraft.bySku["' + SKU_800 + '"][0])'), true,
    'B12 [test 4] and the route is complete again');

  // test 5 — a persisted warehouse still hydrates through its existing token.
  var CW = hydrated(US_SCOPE, function (H) { H[3].raw.recommended_destination_warehouse_id = 'WH-US-3PL-7'; });
  var rw = CW.sb.replenAllocationDraft.bySku[SKU_800][0];
  eq([rw.destination_warehouse_id, rw.destination_marketplace, rw.destination_type, rw.destination_token, rw.destination_state],
    ['WH-US-3PL-7', '', '', 'WH-US-3PL-7', 'PERSISTED_WAREHOUSE'],
    'B13 [test 5] a persisted warehouse keeps its id AS its token — no marketplace, no confirmation');
  CW.sb.__cand = toCandidates(US_SCOPE);
  ok(CW.run('_execToOptionsHtml(__cand, "WH-US-3PL-7", true)').indexOf('selected>') !== -1,
    'B14 [test 5] and it selects in the picker');

  // test 6 — both at once is REFUSED, not resolved by preferring one.
  var CB = hydrated(US_SCOPE, function (H) {
    H[3].raw.recommended_destination_warehouse_id = 'WH-US-3PL-7';
    H[3].raw.destination_marketplace = 'Amazon';
  });
  var rb = CB.sb.replenAllocationDraft.bySku[SKU_800][0];
  eq(rb.destination_state, 'DESTINATION_AMBIGUOUS', 'B15 [test 6] warehouse AND marketplace is a typed refusal');
  eq([rb.destination_warehouse_id, rb.destination_marketplace, rb.destination_token], ['', '', ''],
    'B16 [test 6] neither identity is adopted — the contradiction is not resolved by picking one');
  eq(CB.run('_isRouteComplete(replenAllocationDraft.bySku["' + SKU_800 + '"][0])'), false,
    'B17 [test 6] and nothing can be written for it');
  eq(IRWarehouse.resolvePersistedDestination({ destination_warehouse_id: 'W', destination_marketplace: 'Amazon' }).state,
    'DESTINATION_AMBIGUOUS', 'B18 [test 6] the shared resolver says the same, independently of the page');

  // §D.8 — ONE dictionary. The token format is written down exactly once.
  eq((CMPC.match(/'MARKETPLACE_DESTINATION:' \+/g) || []).length, 1,
    'B19 [§D.8] the token is CONSTRUCTED in exactly one place (parsing it elsewhere is not a second dictionary)');
  eq(IRWarehouse.amazonLogicalToken('us'), IRWarehouse.marketplaceDestinationToken('Amazon', 'us'),
    'B20 [§D.8] and the Amazon builder is that one builder, not a second spelling of it');

  // §D.2 — the WRITE-side synthesis is gone too.
  var hf = IRDraft.partitionRoutesIntoGroups(US_SCOPE, [{ source_warehouse_id: FROM_WH,
    destination_type: 'MARKETPLACE_DESTINATION', destination_marketplace: '', destination_country: 'US',
    shipping_method: 'sea', planned_qty: 800 }]);
  // F1-7N-FB-4G-A0-R2 — RESTATED, and the outcome got STRONGER. B6 measured that such a route was written with
  // a BLANK marketplace rather than the page's filter, which was the fix B6 shipped. A0-R2 made
  // destination_type display metadata: a route whose marketplace COLUMN is blank has no canonical destination
  // at all, so it is not merely written blank — it never becomes a persistable group in the first place. What
  // §D.1 protects is unchanged and is asserted first: the page scope never becomes a destination.
  eq(hf.length, 0, 'B21 [§D.1] a route with no destination of its own forms NO group — it is not persistable');
  eq(hf.map(function (g) { return g.header.destination_marketplace; }), [],
    'B21b [§D.1] so the page scope cannot be written as its destination by any path');
})();

// ================================================================================================================
section('C — [§E, §F, tests 7] THE PERSISTED ROW RENDERS, AND THE CONFIRMATION IS EXPLICIT');
// ================================================================================================================
(function () {
  var renderFn = code(extractFn(PAGE, '_renderExecutionRoute'));
  ok(/route\.destination_state === 'DESTINATION_CONFIRMATION_REQUIRED'/.test(renderFn),
    'C1 [§E.3] the render knows the confirmation-required state');
  ok(/Destination confirmation required/.test(renderFn),
    'C2 [§F.1] and states it beside the To cell in words the operator can act on');
  ok(/data-dest-state/.test(renderFn) && /data-dest-state/.test(code(extractFn(PAGE, '_saveAllocationDraftFromDom'))),
    'C3 [§F] the persisted state survives the DOM round trip, so a later save knows this was an adoption');
  // RESTATED (F1-7N-FC-1B-E2): the line now reads `_isComposer ? '' : (parseInt(route.qty) || 0)`. The
  // invariant C4 protects — Qty comes from the PERSISTED ROUTE ROW and is never re-derived from a
  // suggestion — is unchanged, and the composer branch makes it stronger: a row that is not a route gets
  // no quantity at all rather than a suggested one, which is the E1 defect made unrepresentable.
  ok(/parseInt\(route\.qty\) \|\| 0/.test(renderFn),
    'C4 [§E.4] Qty is read from the persisted route row...');
  ok(!/_irSuggestedQtyNumber_|suggestedQty/.test(renderFn),
    'C4a [§E.4] ...and the renderer consults no suggestion authority at all');
  ok(/_isComposer \? '' :/.test(renderFn),
    'C4b [§E.4] while a non-route row gets a BLANK Qty rather than a re-derived one');
  // RESTATED (F1-7N-FC-1B-E1): this pinned the exact seeded-route literal, and E1 DELETED that branch —
  // it was the phantom. The INVARIANT C5 protects is that an editor row the operator has not saved never
  // inherits a persisted header's identity, and it now holds more strongly than a literal could express:
  // there is no such row at all unless the operator presses + Add Route, and the row that press produces
  // carries no header id, no line id and its own explicit provenance. Asserted on the surviving creator.
  var _addFn = code(extractFn(PAGE, 'addExecutionRoute'));
  ok(/USER_EXPLICIT_ADD_ROUTE/.test(_addFn),
    'C5 [§E.5] the Add Route editor exists only by explicit user intent...');
  ok(!/allocation_draft_id|allocation_draft_line_id|data-draft-id|data-line-id/.test(_addFn),
    'C5a [§E.5] ...and the row it creates carries NO header or line identity, so it can adopt nothing');
  ok(!/qty:\s*suggested/.test(PAGEC) && /_execRenderEmptyState_/.test(PAGEC),
    'C5b [§E.5] and the id-less row is no longer conjured from a suggestion at all — the plan shows empty');

  // §F.3 — the question names every fact the operator needs, and says what will happen.
  var det = { from: 'CN Youxin', to: 'Amazon', method: 'sea', qty: 800, expected_arrival: '', allocation_draft_id: 'SADH-K2-ABC' };
  var built = IRDraft.buildLegacyAdoptionConfirmation(det);
  ok(built.text.indexOf('CN Youxin') !== -1 && built.text.indexOf('Amazon') !== -1 &&
     built.text.indexOf('sea') !== -1 && built.text.indexOf('800') !== -1,
    'C6 [§F.3] the dialog states From, To, Method and Qty');
  ok(built.text.indexOf('SADH-K2-ABC') !== -1 && /will be UPDATED/.test(built.text),
    'C7 [§F.3] and says the EXISTING record will be updated, naming it');
  ok(built.text.indexOf('Expected Arrival') === -1,
    'C8 [§H.1] a blank ETA is not presented as a value being confirmed');
  ok(IRDraft.buildLegacyAdoptionConfirmation({ from: 'A', to: 'B', method: 'sea', qty: 1, expected_arrival: '2026-11-02' })
      .text.indexOf('2026-11-02') !== -1,
    'C9 [§F.3] an ETA that IS explicitly present is shown');

  // test 7 — cancel performs zero request and zero write.
  var C = clientEnv();
  var g = { groupKey: 'k', header: { recommended_shipping_method: 'sea' },
    routes: [{ ship_from: 'CN', destination: 'Amazon', planned_qty: 800, allocation_draft_id: 'H4',
      destination_state: 'DESTINATION_CONFIRMATION_REQUIRED' }] };
  C.sb.__g = g;
  eq(C.run('_irAdoptionGroupsNeedingConfirmation_([__g]).length'), 1,
    'C10 [§F] a group carrying a destination-less persisted route needs confirmation');
  var asked = 0;
  C.sb.confirm = function (t) { asked++; C.sb.__askedText = t; return false; };
  eq(C.run('_irConfirmLegacyAdoption_(__g)'), false, 'C11 [test 7] a declined dialog returns false');
  eq(asked, 1, 'C12 [test 7] and the operator was actually asked exactly once');
  ok(String(C.sb.__askedText).indexOf('800') !== -1, 'C13 [test 7] with the real quantity in the question');
  C.sb.confirm = function () { return true; };
  eq(C.run('_irConfirmLegacyAdoption_(__g)'), true, 'C14 [§F.4] an explicit yes returns true');
  delete C.sb.confirm;
  eq(C.run('_irConfirmLegacyAdoption_(__g)'), false,
    'C15 [§F.4] and NO reachable confirm is not consent — it refuses rather than assuming yes');

  // The gate sits ahead of every write, including the soft-cancels, and RETURNS.
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  ok(flush.indexOf('_irConfirmLegacyAdoption_') < flush.indexOf('_irDispatchLineCancels_(sku, cancels, complete);\n' ) ||
     flush.indexOf('_irConfirmLegacyAdoption_') < flush.lastIndexOf('_irDispatchLineCancels_'),
    'C16 [test 7] the confirmation is asked BEFORE the line-cancel dispatch, which is itself a write');
  ok(flush.indexOf('_irConfirmLegacyAdoption_') < flush.indexOf('_irPersistOneRouteGroup_'),
    'C17 [test 7] and before the group writer that issues the requests');
  ok(/if \(!_irConfirmLegacyAdoption_\(_adoptGroups\[_ai\]\)\)[\s\S]{0,500}?return;/.test(flush),
    'C18 [test 7] a decline RETURNS out of the flush — zero request, zero write');
  ok(/_pendingDraftCancels\[sku\] = \(_pendingDraftCancels\[sku\] \|\| \[\]\)\.concat\(cancels\)[\s\S]{0,200}?return;/.test(flush),
    'C19 [test 7] and the queued cancels are PUT BACK, so nothing at all happened');

  // §F.5/§F.7/§F.8
  ok(!/selectedId\s*=\s*[^;]*ctx\.marketplace/.test(PAGEC) && !/toSelId\s*=\s*[^;]*marketplace \|\|/.test(PAGEC),
    'C20 [§F.5] nothing preselects the scope marketplace in the To cell');
  ok(!/confirmAll|bulkConfirm|confirm_all/i.test(PAGEC), 'C21 [§F.7] no bulk-confirm action was added');
  ok(!/autoCleanup|auto_cancel|purgeEmptyDraft|deleteDraftHeader/i.test(PAGEC),
    'C22 [§F.8, §J] and no automatic cleanup or deletion was added');
})();

// ================================================================================================================
section('D — [§G, tests 8-17, 22-25] SAFE LEGACY ADOPTION, against the four frozen headers');
// ================================================================================================================
(function () {
  var H1 = LIVE.headers[0], H2 = LIVE.headers[1], H3 = LIVE.headers[2], H4 = LIVE.headers[3];

  // ---- the required outcome for H4: sea + Amazon, explicitly confirmed --------------------------------------
  seedLive();
  var before = { ids: ids(), qty: totalQty(), lines: lineObjs().length };
  eq([before.ids.length, before.lines, before.qty], [4, 6, 1020],
    'D1 the seeded state matches the frozen live census: 4 headers, 6 lines, 1020 units');

  // F1-7N-FB-4G-A2-R3 §B.2 — RESTATED, and the outcome is now STRICTLY SAFER than the refusal it replaces.
  //
  // B6 measured that a save whose natural key collided with a legacy header was REFUSED
  // (K4_IDENTITY_RECONCILIATION_REQUIRED) unless the operator explicitly authorised the adoption. What that
  // refusal protected is that a save must never silently adopt someone else's header — and A2-R3 makes that
  // structurally impossible instead of conditionally refused: a declared CREATE_NEW_ROUTE never consults the
  // natural-key resolver at all, so there is nothing to adopt and nothing to refuse. The operator gets the
  // new ticket they asked for, and the legacy header is not touched, not adopted and not refused-around.
  //
  // The ADOPTION path below is unchanged: it is still explicitly authorised, and still lands on H4's own id.
  var unauth = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon',
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(unauth.success, true, 'D2 [§G] WITHOUT the authority the save neither adopts nor is refused…');
  ok(String(unauth.data.allocation_draft_id) !== H4.id,
    'D3 …it creates its OWN ticket, so H4 is never silently adopted');
  ok(!/K4_IDENTITY_RECONCILIATION_REQUIRED|LEGACY_ROUTE_RECONCILIATION_REQUIRED/.test(JSON.stringify(unauth)),
    'D3a and no reconciliation verdict is produced — there is nothing to reconcile');
  var h4untouched = headerObjs().filter(function (h) { return h.allocation_draft_id === H4.id; })[0];
  eq(String(h4untouched.destination_marketplace || ''), '',
    'D4 H4 itself is UNTOUCHED — the unauthorised save wrote nothing to it');
  eq(totalQty(), 1020 + 800, 'D5 and the station gained exactly the new ticket 800, nothing else');

  // Re-seed so the ADOPTION assertions below run against the frozen live census, not the state above.
  seedLive();

  var adopt = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(adopt.success, true, 'D6 [test 8] WITH the explicit authority the adoption succeeds');
  eq(adopt.data.allocation_draft_id, H4.id, 'D7 [test 8, 23] under H4\'s OWN stored id — never re-keyed');
  eq(ids().length, 4, 'D8 [test 8] and NO new header is created');
  var h4after = headerObjs().filter(function (h) { return h.allocation_draft_id === H4.id; })[0];
  eq(String(h4after.destination_marketplace), 'Amazon', 'D9 [test 8] the destination is PERSISTED on that same header');
  eq(String(h4after.recommended_shipping_method), 'sea', 'D10 [test 10] and the service is still sea — never rewritten to sea_express');
  eq(String(h4after.recommended_destination_warehouse_id), '', 'D11 Amazon was not written into a warehouse column');
  var l800 = lineObjs().filter(function (l) { return l.allocation_draft_id === H4.id; });
  eq(l800.length, 1, 'D12 [test 24, 25] exactly one line still hangs off H4 — no orphan, no duplicate');
  eq(Number(l800[0].planned_qty), 800, 'D13 [test 9, 22] and its quantity is still 800');
  eq(totalQty(), 1020, 'D14 [test 22] station-wide quantity is conserved exactly');
  eq(ids().sort(), before.ids.sort(), 'D15 [test 23] every stored header id is unchanged');

  // test 25 — replay.
  var again = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(again.success, true, 'D16 [test 25] replaying the same save succeeds…');
  eq([ids().length, lineObjs().length, totalQty()], [4, 6, 1020], 'D17 [test 25] …and creates no duplicate header or line');

  // ---- the required outcome for the sea_express attempt: H1 only, and H4 untouched ---------------------------
  seedLive();
  var exp = saveRoute(US_SCOPE, { service: LIVE.attempt.service, destination_marketplace: LIVE.attempt.destination, allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: LIVE.attempt.qty }] });
  eq(exp.success, true, 'D18 [test 11] sea_express + Amazon adopts…');
  eq(exp.data.allocation_draft_id, H1.id, 'D19 [test 11] …H1, the ONLY eligible candidate on every K2 dimension');
  eq(ids().length, 4, 'D20 [test 12] no second header is created');
  var h1a = headerObjs().filter(function (h) { return h.allocation_draft_id === H1.id; })[0];
  eq([String(h1a.destination_marketplace), String(h1a.recommended_shipping_method)], ['Amazon', 'sea_express'],
    'D21 [test 11, 18] H1 keeps sea_express and gains the destination');
  var h4b = headerObjs().filter(function (h) { return h.allocation_draft_id === H4.id; })[0];
  eq([String(h4b.destination_marketplace), String(h4b.recommended_shipping_method)], ['', 'sea'],
    'D22 [test 12, 10] H4 (sea / 800) is NOT touched — no destination written, no service change');
  var h4lines = lineObjs().filter(function (l) { return l.allocation_draft_id === H4.id; });
  eq([h4lines.length, Number(h4lines[0].planned_qty)], [1, 800], 'D23 [test 12] and H4 still holds its single 800 line');
  var h1lines = lineObjs().filter(function (l) { return l.allocation_draft_id === H1.id; });
  eq([h1lines.length, Number(h1lines[0].planned_qty)], [1, 400], 'D24 [test 11] the 400 line is created UNDER H1');
  var h2a = headerObjs().filter(function (h) { return h.allocation_draft_id === H2.id; })[0];
  eq([String(h2a.destination_marketplace), lineObjs().filter(function (l) { return l.allocation_draft_id === H2.id; }).length],
    ['', 0], 'D25 [test 13] H2 (air) is untouched — existing is not the same as adopted');
  eq(totalQty(), 1020 + 400, 'D26 [test 22] the only quantity change is the one the user explicitly entered');

  // test 13 — air adopts only on a matching explicit save.
  var air = saveRoute(US_SCOPE, { service: 'air', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: 'AIR-1', site_sku: 'AIR-1-US', window_code: 'W36', planned_qty: 10 }] });
  eq([air.success, air.data && air.data.allocation_draft_id], [true, H2.id],
    'D27 [test 13] an explicit air + Amazon save DOES adopt H2, under its own id');

  // test 14 — H3 cannot be adopted from the US scope.
  seedLive();
  var wrongScope = saveRoute(US_SCOPE, { service: 'air', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: 'TW-SKU-1', site_sku: 'TW-SKU-1-JP', window_code: 'W36', planned_qty: 220 }] });
  eq(wrongScope.data && wrongScope.data.allocation_draft_id, H2.id,
    'D28 [test 14] a US/ResUS air save reaches H2, NEVER the ResTW/JP header');
  var h3 = headerObjs().filter(function (h) { return h.allocation_draft_id === H3.id; })[0];
  eq(String(h3.destination_marketplace), '', 'D29 [test 14] H3 gains no destination from another station\'s save');
  var h3l = lineObjs().filter(function (l) { return l.allocation_draft_id === H3.id; });
  eq([h3l.length, h3l.reduce(function (n, l) { return n + Number(l.planned_qty); }, 0)], [5, 220],
    'D30 [test 14] and its 5 lines / 220 units are preserved exactly');
  seedLive();
  var tw = saveRoute(TW_SCOPE, { service: 'air', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: 'TW-SKU-1', site_sku: 'TW-SKU-1-JP', window_code: 'W36', planned_qty: 50 }] });
  eq([tw.success, tw.data && tw.data.allocation_draft_id], [true, H3.id],
    'D31 [test 14] from its OWN ResTW / JP context H3 adopts correctly');
  eq(lineObjs().filter(function (l) { return l.allocation_draft_id === H3.id; })
      .reduce(function (n, l) { return n + Number(l.planned_qty); }, 0), 220,
    'D32 [test 14, 22] with its 220 units conserved');

  // test 15 — more than one eligible candidate blocks with zero write.
  seedLive();
  // A second ACTIVE header identical to H4 on every K2 dimension makes the candidate set ambiguous.
  procurementAppendByHeader_(SHEETS['shipping_allocation_drafts'], {
    allocation_draft_id: 'SADH-LEGACY-TWIN', planning_cycle: '', source_page: 'inventory_replenishment',
    company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
    recommended_source_warehouse_id: FROM_WH, recommended_destination_warehouse_id: '',
    recommended_shipping_method: 'sea', recommended_last_mile_delivery: '', recommendation_group_no: '',
    generation_type: 'user_created', draft_version: '1', destination_marketplace: '',
    created_by: 'x', created_at: __now, updated_by: 'x', updated_at: __now
  });
  var qtyBefore = totalQty(), idsBefore = ids().length;
  var multi = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(multi.success, false, 'D33 [test 15] two eligible legacy candidates BLOCK…');
  ok(String(multi.error).indexOf('K4_IDENTITY_RECONCILIATION_REQUIRED') === 0, 'D34 [test 15] with the typed reason');
  eq(multi.zero_write, true, 'D35 [test 15] and the server says zero_write');
  eq([ids().length, totalQty()], [idsBefore, qtyBefore], 'D36 [test 15] the database is byte-for-byte unchanged');

  // test 16 — a terminal candidate cannot be adopted.
  seedLive({ terminal: 'H4' });
  var term = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  var directTerm = sadAtomicUpsertCore_({ allow_legacy_reconcile: true, header: {
      allocation_draft_id: H4.id, company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea' },
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  ok(String(directTerm.error).indexOf('IMMUTABLE_TERMINAL_STATUS') === 0 && directTerm.zero_write === true,
    'D36b [test 16] naming the terminal header EXPLICITLY is refused with its own typed reason, zero write');
  eq(term.success, true, 'D37 [test 16] and resolving by route, a submitted H4 is not a candidate at all…');
  ok(term.data.allocation_draft_id !== H4.id && String(term.data.allocation_draft_id).indexOf('SADH-K4-') === 0,
    'D38 [test 16] …under a NEW K4 id — a terminal row is never adopted and never edited');
  var h4term = headerObjs().filter(function (h) { return h.allocation_draft_id === H4.id; })[0];
  eq([String(h4term.status), String(h4term.destination_marketplace)], ['submitted', ''],
    'D39 [test 16] and the terminal row is left exactly as it was');

  // test 17 — a service mismatch cannot be adopted.
  seedLive();
  var mismatch = saveRoute(US_SCOPE, { service: 'rail', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(mismatch.success, true, 'D40 [test 17] a service no legacy header carries adopts nothing…');
  ok(String(mismatch.data.allocation_draft_id).indexOf('SADH-K4-') === 0, 'D41 [test 17] …it creates its own distinct route');
  eq(headerObjs().filter(function (h) { return String(h.destination_marketplace) === 'Amazon' && h.allocation_draft_id !== mismatch.data.allocation_draft_id; }).length, 0,
    'D42 [test 17] and no existing header was given a destination it did not ask for');

  // §G.4 — a CLASSIFIABLE different K4 route stays distinct.
  seedLive();
  saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  var other = saveRoute(US_SCOPE, { service: 'sea', destination_warehouse_id: 'WH-US-3PL-7',
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 100 }] });
  eq(other.success, true, 'D43 [§G.4] a route to a DIFFERENT destination is a different route…');
  ok(other.data.allocation_draft_id !== H4.id, 'D44 [§G.4] …and gets its own header rather than merging');
  eq(ids().length, 5, 'D45 [§G.4] exactly one header was added');
})();

// ================================================================================================================
section('E — [§H, tests 18-21] EXPECTED ARRIVAL AND THE TWO OCEAN SERVICES');
// ================================================================================================================
(function () {
  // test 18 — sea is not sea_express, in identity and in the lead-time lookup.
  eq(ricCanonicalService_('sea'), 'sea', 'E1 [test 18] sea canonicalises to sea');
  eq(ricCanonicalService_('sea_express'), 'sea_express', 'E2 [test 18] and sea_express to sea_express');
  ok(ricK4GroupKey_({ recommended_shipping_method: 'sea', destination_marketplace: 'Amazon' }) !==
     ricK4GroupKey_({ recommended_shipping_method: 'sea_express', destination_marketplace: 'Amazon' }),
    'E3 [test 18] so they are two identities for two services in the K4 key');
  var lead = {};
  var m = /var IR_SERVICE_TO_LEAD_KEY_ = \{[\s\S]*?\};/.exec(PAGE);
  eval(m[0].replace('var IR_SERVICE_TO_LEAD_KEY_', 'lead.map'));
  eq(lead.map['sea'], 'Sea', 'E4 [test 18] the lead-time lookup maps sea to Sea…');
  eq(lead.map['sea_express'], 'Sea Express', 'E5 [test 18] …and sea_express to Sea Express, a different rate card');
  var leadFn = code(extractFn(PAGE, '_irMethodToLeadKey'));
  ok(leadFn.indexOf("indexOf('sea')") === -1 && !/startsWith\(\s*'sea'/.test(leadFn),
    'E6 [test 19] there is no prefix ladder — nothing can make sea answer for sea_express');
  ok(/return '';/.test(leadFn), 'E7 [test 19] an unmapped service returns NOTHING rather than a neighbour\'s number');
  eq(ricCanonicalService_('sea express boat'), '', 'E8 [test 19] and the canonicaliser refuses an unknown spelling outright');

  // test 20 — an ETA-only edit is not lost to fingerprint reuse.
  ok(SAD_K2_LINE_FP_.indexOf('expected_arrival') !== -1,
    'E9 [test 20] expected_arrival is inside the payload fingerprint…');
  var base = { sku: 'S', site_sku: 'S-US', window_code: 'W36', planned_qty: 800 };
  var withEta = { sku: 'S', site_sku: 'S-US', window_code: 'W36', planned_qty: 800, expected_arrival: '2026-11-02' };
  ok(sadK2PayloadFingerprint_({}, [base]) !== sadK2PayloadFingerprint_({}, [withEta]),
    'E10 [test 20] …so changing ONLY the ETA changes the fingerprint and forces a real write');
  ok(!sadK2SemanticPayloadEqual_({}, [base], {}, [withEta]),
    'E11 [test 20] and the semantic comparison agrees it is a genuine content change');
  seedLive();
  saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  // F1-7N-FB-4G-A2-R3 - this is the SAME route being edited, so it NAMES H4 (§B.1). Before the intent
  // contract it found H4 by natural key; a save that does not name a row is now a create of a new ticket.
  var etaSave = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', id: LIVE.headers[3].id,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800, expected_arrival: '2026-11-02' }] });
  eq(etaSave.success, true, 'E12 [test 20] an ETA-only save is accepted');
  eq(String(lineObjs().filter(function (l) { return l.sku === SKU_800; })[0].expected_arrival), '2026-11-02',
    'E13 [test 20] and the ETA is PERSISTED on the line');
  eq(Number(lineObjs().filter(function (l) { return l.sku === SKU_800; })[0].planned_qty), 800,
    'E14 [test 22] with the quantity untouched');

  // §H.2 — the ETA is not an identity dimension, so an ETA edit updates the SAME route.
  ok(RIC_K4_GROUP_DIMENSIONS_.indexOf('expected_arrival') === -1 && SAD_K2_GROUP_DIMENSIONS_.indexOf('expected_arrival') === -1,
    'E15 [§H.2] expected_arrival is in NEITHER group key — a line attribute cannot reach a header identity');
  eq(ids().length, 4, 'E16 [§H.2] so the ETA save created no new header');

  // test 21 — the attempted date is never backfilled anywhere.
  ok(PAGE.indexOf(LIVE.attempt.eta) === -1 && CMP.indexOf(LIVE.attempt.eta) === -1 && G16.indexOf(LIVE.attempt.eta) === -1,
    'E17 [test 21] 2026-10-16 appears in NO shipped source — it is attempt evidence, not data');
  seedLive();
  var noEta = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  eq(String(lineObjs().filter(function (l) { return l.sku === SKU_800; })[0].expected_arrival), '',
    'E18 [test 21, §H.1] adopting a route with no ETA leaves the ETA BLANK — nothing is backfilled');
  // §H.5 — the shipped UI has no explicit ETA entry, so the computed display date is never persisted as one.
  ok(!/expected_arrival/.test(code(extractFn(CMP, 'buildDraftLinePayload'))),
    'E19 [§H.1] the line payload never carries the DISPLAY-computed arrival date — that would be a backfill');
})();

// ================================================================================================================
section('F — [§I, tests 26-28] THE SUBMIT GATE');
// ================================================================================================================
(function () {
  // test 26 — a quantity-bearing route with no destination blocks submit, before any request.
  var C = hydrated(US_SCOPE);
  var missing = C.run('_irRoutesMissingDestination_()');
  eq(missing.length, 1, 'F1 [test 26] the destination-less 800 route is named as a submit blocker');
  var m0 = missing[0] || {};   // indexed defensively: a blinded gate must REPORT, not crash the suite
  eq([m0.sku, m0.qty, m0.destination_state],
    [SKU_800, 800, 'DESTINATION_CONFIRMATION_REQUIRED'], 'F2 [test 26] with its SKU, quantity and state');
  var submitFn = code(extractFn(PAGE, 'submitReplenishmentPlans'));
  ok(submitFn.indexOf('_irRoutesMissingDestination_') < submitFn.indexOf('_replenCanonicalSubmit'),
    'F3 [test 26] and the gate is evaluated BEFORE the submit request is built');
  // F1-7N-FB-4G-A2 — RESTATED for the SHAPE. A2 consolidated the three Submit gate blocks into ONE preflight,
  // so `if (_noDest.length) { ... return; }` no longer exists as a block of its own. What §I requires — that a
  // blocked submit RETURNS before any request is built — is unchanged and is asserted on the one gate.
  ok(/if \(!_pf\.ok[\s\S]{0,400}?return;/.test(submitFn),
    'F4 [test 26] a blocked submit RETURNS — nothing is submitted and nothing is written');
  ok(submitFn.indexOf('_irSubmitPreflight_') < submitFn.indexOf('_replenCanonicalSubmit'),
    'F4a and that one gate is evaluated BEFORE the submit request is built');

  // test 27 — after adoption the route carries a destination and the gate passes.
  var CA = hydrated(US_SCOPE, function (H) { H[3].raw.destination_marketplace = 'Amazon'; });
  eq(CA.run('_irRoutesMissingDestination_().length'), 0, 'F5 [test 27] once the destination is persisted the gate passes');
  eq(CA.run('_isRouteComplete(replenAllocationDraft.bySku["' + SKU_800 + '"][0])'), true,
    'F6 [test 27] and the route is submittable again');

  // test 28 — THE ZERO-LINE DECISION, taken from the shipped lifecycle contract rather than guessed.
  //
  // sadSubmitToShippingPlansCore_ validates EVERY requested draft id. A header with no lines fails gate (3)
  // NO_LINES, and ANY error fails the WHOLE batch with SUBMIT_VALIDATION_FAILED and zero writes. So a zero-line
  // active header sent to Submit does not merely contribute nothing — it makes Submit impossible for every real
  // route beside it. §J forbids deleting those headers, so the CLIENT must not send them. That is the decision,
  // and it is recorded by executing both halves of it.
  seedLive();
  var H1 = LIVE.headers[0], H4 = LIVE.headers[3];
  var withEmpty = sadSubmitToShippingPlansCore_(SpreadsheetApp.getActiveSpreadsheet(),
    { submitted_by: 'test', execution_key: 'EK1' }, [H4.id, H1.id]);
  eq(withEmpty.success, false, 'F7 [test 28] a zero-line active header in the submit set FAILS the whole batch…');
  eq(withEmpty.code, 'SUBMIT_VALIDATION_FAILED', 'F8 [test 28] with SUBMIT_VALIDATION_FAILED');
  eq(withEmpty.zero_write, true, 'F9 [test 28] and zero writes — so it blocks every real route beside it');
  ok(withEmpty.data.errors.some(function (e) { return e.allocation_draft_id === H1.id; }),
    'F10 [test 28] the empty header is the one named');
  var idFn = code(extractFn(PAGE, '_replenActiveAllocationDraftIds'));
  ok(/fromRoutes\[/.test(idFn),
    'F11 [test 28] THE DECISION: the client sends only headers a complete route is actually bound to');
  var CZ = clientEnv();
  CZ.sb.replenAllocationDraft = { context: US_SCOPE, allocationDraftId: 'H1',
    allocationDraftIds: ['H1', 'H2', 'H4'],
    bySku: { 'X': [{ allocation_draft_id: 'H4', source_warehouse_id: FROM_WH, destination_marketplace: 'Amazon',
      destination_type: 'MARKETPLACE_DESTINATION', shipping_method: 'sea', planned_qty: 800, qty: 800 }] } };
  vm.runInContext(extractFn(PAGE, '_replenActiveAllocationDraftIds'), CZ.ctx);
  eq(CZ.run('_replenActiveAllocationDraftIds()'), ['H4'],
    'F12 [test 28] so the empty H1/H2 are NOT sent, and the real H4 still is');

  // §I — no other submit validation was weakened.
  ['MIXED_SITE_PAYLOAD', 'APPLIED_SCOPE_MISMATCH', 'NO_LINES', 'ROUTE_INCOMPLETE',
   'NO_POSITIVE_PLANNED_QTY_LINES', 'OPERATOR_PROVENANCE_INCOMPLETE'].forEach(function (t, i) {
    ok(G16C.indexOf(t) !== -1, 'F13.' + i + ' [§I] submit validation ' + t + ' is intact');
  });
  // F1-7N-FB-4G-A2 — RESTATED for the wording only: the duplicate gate's sentence now lives in the preflight's
  // renderer. Both gates are still present and both still fail closed.
  ok(/Cannot Submit Plan — the saved quantities do not match/.test(PAGE) &&
     /duplicate rows exist in the database/.test(PAGE),
    'F14 [§I] and the pre-existing drift and duplicate gates are untouched');
})();

// ================================================================================================================
section('G — [§J] THE TWO EMPTY HEADERS ARE RECORDED, NOT REMOVED');
// ================================================================================================================
(function () {
  seedLive();
  saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  var H1 = LIVE.headers[0], H2 = LIVE.headers[1];
  var still = headerObjs().filter(function (h) { return h.allocation_draft_id === H1.id || h.allocation_draft_id === H2.id; });
  eq(still.length, 2, 'G1 [§J] both empty headers still exist after an adoption elsewhere');
  eq(still.map(function (h) { return String(h.status); }), ['draft', 'draft'],
    'G2 [§J] still active — not cancelled, not expired, not deleted');
  eq(lineObjs().filter(function (l) { return l.allocation_draft_id === H1.id || l.allocation_draft_id === H2.id; }).length, 0,
    'G3 [§J] and they created no phantom line or quantity');
  ok(G16C.indexOf('deleteRow') === -1, 'G4 [§J] the handler still contains no row deletion at all');
  ok(!/expiry|autoExpire|purge/i.test(code(extractFn(PAGE, '_flushDraftDbPersist'))),
    'G5 [§J] and the save path added no expiry or purge');
})();

// ================================================================================================================
section('H — [§K, tests 29-30] DEPLOYMENT IDENTITY AND PAGE WIRING');
// ================================================================================================================
(function () {
  // F1-7N-FB-4G-A0-R1 — RESTATED. "This round's owner build" is an equality with the present, so the first
  // later round that legitimately moved the stamp failed it while describing a correct state. What B6
  // established is a FLOOR: 16_ carries B6's changes or something later. The order is owned by
  // _release-order.js OWNER_STAMPS.
  var stamp = (G16.match(/var SAD_BUILD_VERSION_ = '([^']+)';/) || [])[1];
  ok(RO.stampAtOrAfter(stamp, 'F1-7N-FB-4F-B6'),
    'H1 16_ is at or after the B6 owner build (' + stamp + ')');
  eq((G63.match(/\{ file: '16_shipping_allocation_handlers\.gs', symbol: 'SAD_BUILD_VERSION_', expected: '([^']+)'/) || [])[1],
    stamp, 'H2 and the deployment manifest expects exactly what the source declares');
  eq((G69.match(/var RIC_BUILD_VERSION_ = '([^']+)';/) || [])[1], 'F1-7N-FB-4F-B3',
    'H3 69_ is UNCHANGED this round, so its stamp does not move');
  // The shared BUILD_STAMP_RE admits only `-R<n>` revision segments; this series has used `-B<n>` since B1, so
  // it has never described these stamps and is deliberately not asserted here. What matters is that the stamp
  // MOVED, because 16_ changed: a deployment carrying B3's writer must be distinguishable from one carrying B6's.
  ok(stamp !== 'F1-7N-FB-4F-B3', 'H4 the owner stamp MOVED, because 16_ changed this round');

  // Contracts unchanged — B6 adds no action and no route.
  var DBAPI = read('assets/js/api/operation-system-db-api.js');
  eq((DBAPI.match(/var KM_EXPECTED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1],
  (G63.match(/var SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1],
  'H5 the frontend pin AGREES with the deployed action contract');
  eq((DBAPI.match(/var KM_EXPECTED_TRANSPORT_CONTRACT_VERSION_ = (\d+);/) || [])[1], '1', 'H6 transport contract still 1');
  var reqList = /var KM_REQUIRED_DEPLOYED_ACTIONS_ = \[([\s\S]*?)\];/.exec(DBAPI)[1];
  // F1-7N-FB-4G-A2-R3 - RESTATED to a floor. B6's point was that IT added no action; an equality on the size
  // also forbade every later round from adding one. A2-R3 adds upsertShippingAllocationDraftAtomic to the
  // probe list, because the Execution Plan cannot write a route without it.
  ok((reqList.match(/'[^']+'/g) || []).length >= 16,
    'H7 the probed action list is at or above the B6 size (it is append-only)');
  ok(!/upsertShippingAllocationDraftAdopt|adoptLegacy|legacyAdopt/.test(read('assets/specs/active/apps-script/01_router.gs')),
    'H8 [§K] and the router registers no new action for adoption');

  // Cache tokens — the changed browser files carry the current application token.
  var tok = RO.parseIndexTokens(INDEX);
  var APP = RO.currentAppToken();
  // F1-7N-FB-4F-B6-R1 - RESTATED, and this is the THIRD round this exact shape has broken. A round
  // asserting that the current token IS its own token is true for exactly one round. The durable
  // statement is a FLOOR: the files this round changed must never be served from an OLDER token.
  ok(RO.tokenAtOrAfter(APP, 'fb4fb6-legacyroute-20260901'),
    'H9 the application token is at or after the round that changed these files (' + APP + ')');
  eq(tok['assets/js/pages/inventory-replenishment.js'], APP, 'H10 [test 29] the page carries it');
  eq(tok['assets/js/utils/inventory-compat.js'], APP, 'H11 [test 29] and so does the shared draft module');
  // RESTATED (F1-7N-FC-1A-R1-HF1): this was `=== 18`. The count is not the property — "rotated
  // TOGETHER" is — and the literal made a round covering one more asset look like a half-updated
  // deployment. Derived now: nothing is left behind on a superseded application token.
  eq(RO.staleAppTokenRefs(INDEX).join(' | '), '',
    'H12 the whole co-deployed application set rotated together — never a half-updated deployment (' +
    RO.appTokenRefCount(INDEX) + ' refs on ' + APP + ')');
  ok(!RO.isMapToken(APP), 'H13 and no map round moved it onto a map token');
  ok(RO.tokenAtOrAfter(APP, 'skudisplayinit-20260901'), 'H14 the release order only ever moves forward');
  ok(tok['assets/css/pages/inventory-replenishment.css'] !== 'ffcols-20260820',
    'H15 the changed stylesheet is bumped off its prior token');
  var seen = {};
  (INDEX.match(/<script[^>]*\ssrc="([^"?]+)/g) || []).forEach(function (m) { seen[m] = (seen[m] || 0) + 1; });
  ok(Object.keys(seen).every(function (k) { return seen[k] === 1; }), 'H16 [§K] no duplicate index reference was introduced');

  // test 30 / test 29 — no automatic request on load, and no duplicate handlers on remount.
  var hyd = code(extractFn(PAGE, '_irHydrateDraftForAppliedScope_'));
  ok(/_irDraftHydrateInFlight/.test(hyd), 'H17 [test 29] the hydrate is single-flight — a remount cannot stack it');
  ok(/_irDraftHydrateScopeKey !== key/.test(hyd), 'H18 [test 29] and a superseded scope discards its own result');
  var mount = PAGE.slice(PAGE.indexOf("console.log('[Replenishment] mount')"), PAGE.indexOf("console.log('[Replenishment] mount')") + 4000);
  ok(mount.indexOf('_irHydrateDraftForAppliedScope_') === -1,
    'H19 [test 30] the MOUNT issues no draft read of its own — the hydrate hangs off a confirmed Search');
  ok(/if \(typeof _irHydrateDraftForAppliedScope_ === 'function'\)/.test(code(extractFn(PAGE, '_irApplySearch_'))),
    'H20 [test 30] which is a user action, not page load');
  ok(/addEventListener/.test(PAGE) === true && !/addEventListener/.test(hyd),
    'H21 [test 29] and the new code binds no listener at all, so a remount cannot duplicate one');
})();

// ================================================================================================================
section('I — MUTATION TESTS: every one of these SHOULD break something');
// ================================================================================================================
var neg = { caught: 0, missed: 0 };
// ONE CONVENTION: the body returns TRUE when the mutation is DETECTED or the guard holds. A body that throws
// counts as detected (the mutant broke something loudly), and anything else is a surviving mutant.
function mut(label, f) {
  var caught = false;
  try { caught = (f() === true); } catch (e) { caught = true; }
  if (caught) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}

// M1 — restoring the ctx.marketplace synthesis.
mut('M1 restoring the ctx.marketplace synthesis in the hydrate is caught', function () {
  var src = PAGE.replace('destination_marketplace: hDest.marketplace,',
                         "destination_marketplace: hDest.marketplace || (ctx.marketplace || ''),");
  var C = clientEnv();
  vm.runInContext(extractFn(src, '_hydrateAllocationDraftFromDb'), C.ctx);
  C.sb.KM.DB.getShippingAllocationDrafts = function () { return dbHeaders(); };
  C.sb.KM.DB.getShippingAllocationDraftLines = function () { return dbLines(); };
  C.run('_hydrateAllocationDraftFromDb(' + JSON.stringify(US_SCOPE) + ')');
  var mutant = C.sb.replenAllocationDraft.bySku[SKU_800][0].destination_marketplace;
  var honest = hydrated(US_SCOPE).sb.replenAllocationDraft.bySku[SKU_800][0].destination_marketplace;
  return mutant === 'Amazon' && honest === '';   // the mutation is real AND the shipped code does not have it
});

// M2 — preselecting Amazon in the To cell.
mut('M2 preselecting the scope marketplace in the To cell is caught', function () {
  var C = hydrated(US_SCOPE);
  C.sb.__cand = toCandidates(US_SCOPE);
  var r = C.sb.replenAllocationDraft.bySku[SKU_800][0];
  // The mutant: select on the SCOPE instead of on the persisted token.
  var mutantSel = IRWarehouse.amazonLogicalToken(US_SCOPE.country);
  var html = C.run('_execToOptionsHtml(__cand, ' + JSON.stringify(mutantSel) + ', true)');
  var honest = C.run('_execToOptionsHtml(__cand, ' + JSON.stringify(r.destination_token || '') + ', true)');
  // The mutant (selecting from SCOPE) DOES preselect Amazon; the honest render (selecting from the PERSISTED
  // token, which is empty) does not. They must differ, or the To cell is being filled in by the page filter.
  return html.indexOf('selected>Amazon') !== -1 && honest.indexOf('selected>Amazon') === -1;
});

// M3 — showing H4's quantity as 0.
mut('M3 dropping the persisted quantity in the hydrate is caught', function () {
  var src = PAGE.replace('planned_qty: Number(raw.planned_qty) || 0,', 'planned_qty: 0,');
  var C = clientEnv();
  vm.runInContext(extractFn(src, '_hydrateAllocationDraftFromDb'), C.ctx);
  C.sb.KM.DB.getShippingAllocationDrafts = function () { return dbHeaders(); };
  C.sb.KM.DB.getShippingAllocationDraftLines = function () { return dbLines(); };
  C.run('_hydrateAllocationDraftFromDb(' + JSON.stringify(US_SCOPE) + ')');
  var mutant = C.sb.replenAllocationDraft.bySku[SKU_800][0].planned_qty;
  var honest = hydrated(US_SCOPE).sb.replenAllocationDraft.bySku[SKU_800][0].planned_qty;
  return mutant === 0 && honest === 800;
});

// M4 — treating sea_express as sea.
mut('M4 collapsing sea_express onto sea is caught', function () {
  var mutant = function (v) { var t = String(v || '').trim().toLowerCase(); return t.indexOf('sea') === 0 ? 'sea' : t; };
  return mutant('sea_express') === mutant('sea') &&                       // the prefix ladder DOES collapse them
    ricCanonicalService_('sea_express') !== ricCanonicalService_('sea');  // and the shipped resolver does not
});

// M5 — creating a new header instead of adopting.
mut('M5 creating a new header instead of adopting is caught', function () {
  seedLive();
  var H4 = LIVE.headers[3];
  var before = ids().length;
  var r = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  return r.data.allocation_draft_id === H4.id && ids().length === before;
});

// M6 — changing the stored legacy id (a re-key).
mut('M6 re-keying the adopted header is caught', function () {
  seedLive();
  var H4 = LIVE.headers[3], before = ids().slice().sort();
  saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  var after = ids().slice().sort();
  var lineFk = lineObjs().filter(function (l) { return l.sku === SKU_800; })[0].allocation_draft_id;
  return JSON.stringify(before) === JSON.stringify(after) && lineFk === H4.id;
});

// M7 — adopting across company / country / marketplace scope.
mut('M7 adopting across a scope boundary is caught', function () {
  seedLive();
  var H3 = LIVE.headers[2];
  saveRoute(US_SCOPE, { service: 'air', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: 'TW-SKU-1', site_sku: 'TW-SKU-1-JP', window_code: 'W36', planned_qty: 220 }] });
  var h3 = headerObjs().filter(function (h) { return h.allocation_draft_id === H3.id; })[0];
  return String(h3.destination_marketplace) === '' && String(h3.country) === 'JP';
});

// M8 — adopting a terminal header. TWO POINTS OF DETECTION, and the probe attacks BOTH, because attacking
// only the outer one lets the inner one answer and the mutant survive.
//
// The first attempt at this probe flipped `submitted` into ACTIVE inside sadK2ResolveActiveDraft_ and the whole
// suite still passed — an EQUIVALENT MUTANT: the candidate list handed to that function comes from
// sadReadActiveHeaderRows_, which had already dropped the row, so the mutated line was unreachable. So the
// candidate filter is asserted where it actually lives, and the writer's own terminal guard is asserted by
// reaching it directly with an explicit id.
mut('M8 adopting a terminal header is caught, at BOTH points of detection', function () {
  seedLive({ terminal: 'H4' });
  var H4 = LIVE.headers[3];
  // (a) the CANDIDATE FILTER: a terminal row is not an active header at all.
  var actives = sadReadActiveHeaderRows_(SHEETS['shipping_allocation_drafts']);
  var filtered = actives.filter(function (r) { return r.allocation_draft_id === H4.id; }).length === 0;
  // (b) the WRITER'S OWN GUARD: reached directly by naming the terminal row, bypassing (a) entirely.
  var direct = sadAtomicUpsertCore_({ allow_legacy_reconcile: true, header: {
      allocation_draft_id: H4.id, company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea' },
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  var typed = direct.success === false && String(direct.error).indexOf('IMMUTABLE_TERMINAL_STATUS') === 0 &&
    direct.zero_write === true;
  var h4 = headerObjs().filter(function (h) { return h.allocation_draft_id === H4.id; })[0];
  return filtered && typed && String(h4.destination_marketplace) === '';
});

// M9 — allowing multiple candidates.
mut('M9 adopting when more than one candidate is eligible is caught', function () {
  seedLive();
  procurementAppendByHeader_(SHEETS['shipping_allocation_drafts'], {
    allocation_draft_id: 'SADH-LEGACY-TWIN', planning_cycle: '', source_page: 'inventory_replenishment',
    company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
    recommended_source_warehouse_id: FROM_WH, recommended_destination_warehouse_id: '',
    recommended_shipping_method: 'sea', recommended_last_mile_delivery: '', recommendation_group_no: '',
    generation_type: 'user_created', draft_version: '1', destination_marketplace: '',
    created_by: 'x', created_at: __now, updated_by: 'x', updated_at: __now });
  var qty = totalQty(), n = ids().length;
  var r = saveRoute(US_SCOPE, { service: 'sea', destination_marketplace: 'Amazon', allow: true,
    lines: [{ sku: SKU_800, site_sku: SKU_800 + '-US', window_code: 'W36', planned_qty: 800 }] });
  return r.success === false && r.zero_write === true && totalQty() === qty && ids().length === n;
});

// M10 — writing an ETA during hydration.
mut('M10 writing an ETA during hydration is caught', function () {
  var C = hydrated(US_SCOPE);
  var r = C.sb.replenAllocationDraft.bySku[SKU_800][0];
  return !('expected_arrival' in r) || String(r.expected_arrival || '') === '';
});

// M11 — submitting with a missing destination.
mut('M11 submitting a quantity-bearing route with no destination is caught', function () {
  var C = hydrated(US_SCOPE);
  return C.run('_irRoutesMissingDestination_().length') === 1;
});

// M12 — a cancelled confirmation still sending a request.
mut('M12 a declined confirmation that still issues a request is caught', function () {
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  var declineIdx = flush.indexOf('_irConfirmLegacyAdoption_');
  var writeIdx = flush.indexOf('_irPersistOneRouteGroup_');
  var dispatchIdx = flush.lastIndexOf('_irDispatchLineCancels_');
  return declineIdx !== -1 && declineIdx < writeIdx && declineIdx < dispatchIdx &&
    /if \(!_irConfirmLegacyAdoption_\([^)]*\)\)[\s\S]{0,500}?return;/.test(flush);
});

// M13 — the fingerprint blindness that would make the whole adoption a silent no-op.
mut('M13 leaving destination_marketplace out of the payload fingerprint is caught', function () {
  var prior = { recommended_shipping_method: 'sea', destination_marketplace: '' };
  var inc = { recommended_shipping_method: 'sea', destination_marketplace: 'Amazon' };
  return sadK2PayloadFingerprint_(prior, []) !== sadK2PayloadFingerprint_(inc, []) &&
    !sadK2SemanticPayloadEqual_(prior, [], inc, []);
});

// M14 — adopting without the explicit authority.
mut('M14 adopting without the explicit user authority is caught', function () {
  seedLive();
  var r = sadResolveActiveDraftK2OrK3_(SHEETS['shipping_allocation_drafts'],
    { planning_cycle: '', company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', destination_marketplace: 'Amazon',
      recommended_shipping_method: 'sea', recommended_last_mile_delivery: '', recommendation_group_no: '' },
    { k4Ready: true, allowLegacyReconcile: false });
  return r.status === 'BLOCK' && r.reason === 'K4_IDENTITY_RECONCILIATION_REQUIRED';
});

// M15 — adopting while supplying no destination at all (a pointless migration).
mut('M15 adopting a legacy row without supplying a destination is caught', function () {
  seedLive();
  var r = sadResolveActiveDraftK2OrK3_(SHEETS['shipping_allocation_drafts'],
    { planning_cycle: '', company: 'ResUS', country: 'US', marketplace: 'Amazon',
      source_page: 'inventory_replenishment', recommended_source_warehouse_id: FROM_WH,
      recommended_destination_warehouse_id: '', destination_marketplace: '',
      recommended_shipping_method: 'sea', recommended_last_mile_delivery: '', recommendation_group_no: '' },
    { k4Ready: true, allowLegacyReconcile: true });
  return r.status !== 'REUSE';
});

// M16 — sending an empty header to Submit.
mut('M16 sending a zero-line header to Submit is caught', function () {
  seedLive();
  var H1 = LIVE.headers[0], H4 = LIVE.headers[3];
  var r = sadSubmitToShippingPlansCore_(SpreadsheetApp.getActiveSpreadsheet(),
    { submitted_by: 't', execution_key: 'EK-M16' }, [H4.id, H1.id]);
  return r.success === false && r.zero_write === true;
});

// ================================================================================================================
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
console.log('negative tests: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
process.exit(fail === 0 ? 0 : 1);
