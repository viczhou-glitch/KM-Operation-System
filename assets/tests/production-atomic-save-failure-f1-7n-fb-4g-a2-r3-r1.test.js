// F1-7N-FB-4G-A2-R3-R1 — PRODUCTION ATOMIC SAVE FAILURE: DIAGNOSIS AND REPAIR.
//
// A2-R3 shipped, and production acceptance FAILED: editing a route failed, + Add Route failed, and the screen
// could say no more than BUSINESS_COMMAND_ERROR and then HTTP_TRANSPORT_ERROR with OUTCOME UNKNOWN. Three
// separate defects were measured, and this suite is what measures them.
//
//   (1) THE CLIENT COULD NOT ACKNOWLEDGE A SUCCESSFUL ATOMIC WRITE. _irSaveAcknowledged_ requires
//       `created === true || updated === true` — the two-call HEADER writer's boolean contract. The ATOMIC
//       writer reuses those two names for the LINE COUNTS it wrote (`var created = 0, updated = 0` …
//       `updated++`), so a single-line UPDATE answers `created: 0, updated: 1` and neither is `=== true`.
//       EVERY atomic write was therefore unacknowledgeable: the row was written, the client said
//       PERSISTENCE_NOT_ACKNOWLEDGED, and the operator was shown OUTCOME UNKNOWN over a save that HAD landed.
//
//   (2) THE VERSION THE SERVER MOVED TO WAS NEVER ADOPTED. _irStampRouteGroupIds_ stamped the draft id and the
//       group key and nothing else, so after one successful UPDATE the row still declared the version it was
//       hydrated at. Every later edit was refused STALE_OPTIMISTIC_TOKEN with zero writes, and retrying could
//       not help because the retry re-sent the same stale number. Only a Search reload cleared it. Defect (1)
//       guaranteed defect (2), because only the acknowledged path stamps anything at all.
//
//   (3) THE SERVER'S OWN TYPED CODE WAS DISCARDED. The transport adapter classified by prefix-matching the
//       error PROSE against a hand-maintained list and never read the handler's top-level `code` field.
//       Measured: 38 of the 41 typed codes 16_ emits were flattened to `BUSINESS_COMMAND_ERROR` — including
//       every refusal A2-R3 introduced. The page held a SECOND stale list with the same gap.
//
// AND THE HYPOTHESES THAT WERE MEASURED FALSE (§E). The save does NOT fan out with Promise.all, does NOT
// contend for the ScriptLock with itself, and is NOT bound by a 60 s timeout: the writes are already strictly
// serial (max 1 request in flight for 1, 2, 3 and 5 dirty routes), and the client write bound is
// KM_WRITE_TIMEOUT_MS_ = 90 000 ms. Reporting a cause that was not the cause would have been the easy mistake
// here, so those are asserted as measurements, not assumed away.
//
// Run: node assets/tests/production-atomic-save-failure-f1-7n-fb-4g-a2-r3-r1.test.js

var fs = require('fs');
var path = require('path');

var fail = 0, pass = 0;
var neg = { caught: 0, missed: 0 };
function ok(c, l) { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.error('FAIL ' + l); } }
function eq(a, e, l) { var A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) { pass++; console.log('ok   ' + l); } else { fail++; console.error('FAIL ' + l + '\n  exp ' + E + '\n  got ' + A); } }
function section(t) { console.log('\n== ' + t + ' =='); }
function mut(label, f) {
  var r;
  try { r = f(); } catch (e) { neg.missed++; fail++; console.error('FAIL ' + label + ' — PROBE ERROR: ' + (e && e.message)); return; }
  if (r === true) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}
async function amut(label, f) {
  var r;
  try { r = await f(); } catch (e) { neg.missed++; fail++; console.error('FAIL ' + label + ' — PROBE ERROR: ' + (e && e.message)); return; }
  if (r === true) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}

var ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); }
var NL = String.fromCharCode(10);

var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var PAGE = read('assets/js/pages/inventory-replenishment.js');
var DBAPI = read('assets/js/api/operation-system-db-api.js');
var INDEX = read('index.html');
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var IRDraft = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js')).IRDraft;

function extractFn(src, name) {
  var re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  var m = re.exec(src); if (!m) throw new Error('not found: ' + name);
  var start = m.index, i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
var WSCHARS = ' ' + String.fromCharCode(9) + String.fromCharCode(13) + String.fromCharCode(10);
function extractVar(src, name) {
  var m = new RegExp('var ' + name + '\\s*=').exec(src); if (!m) throw new Error('not found: ' + name);
  var i = src.indexOf('=', m.index) + 1;
  while (WSCHARS.indexOf(src[i]) >= 0) i++;
  if (src[i] === '{' || src[i] === '[') {
    var open = src[i], close = open === '{' ? '}' : ']', d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (d === 0) break; } }
    return src.slice(m.index, j + 1) + ';';
  }
  return src.slice(m.index, src.indexOf(';', i) + 1);
}
// Line endings differ per file; a multi-line LF find string against a CRLF file matches nothing while naming a
// target that IS present. Both sides are normalised to the source's own ending.
function mutateFn(src, name, find, replace) {
  var CR = String.fromCharCode(13), LFC = String.fromCharCode(10);
  var eol = src.indexOf(CR + LFC) >= 0 ? (CR + LFC) : LFC;
  function fix(t) { return String(t).split(CR + LFC).join(LFC).split(LFC).join(eol); }
  find = fix(find); replace = fix(replace);
  var body = extractFn(src, name);
  if (body.indexOf(find) < 0) throw new Error('mutation target absent in ' + name + ': ' + find.slice(0, 90));
  return src.replace(body, body.replace(find, replace));
}

// ================================================================================================================
// THE SERVER. The in-memory spreadsheet is the only thing simulated; every rule runs from shipped source.
// ================================================================================================================
function FakeSheet(headers) { this.rows = [headers.slice()]; }
FakeSheet.prototype.getLastColumn = function () { return this.rows[0].length; };
FakeSheet.prototype.getDataRange = function () { var s = this; return { getValues: function () { return s.rows.map(function (r) { return r.slice(); }); } }; };
FakeSheet.prototype.appendRow = function (r) { this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (row, col, nr, nc) {
  var s = this;
  return {
    getValues: function () { var o = []; for (var i = 0; i < (nr || 1); i++) { var l = []; for (var j = 0; j < (nc || 1); j++) l.push(s.rows[row - 1 + i][col - 1 + j]); o.push(l); } return o; },
    getValue: function () { return s.rows[row - 1][col - 1]; },
    setValue: function (v) { s.rows[row - 1][col - 1] = v; }
  };
};
var SHEETS = {};
var SpreadsheetApp = { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return SHEETS[n] || null; } }; } };
var LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
var __uuid = 0;
var Utilities = { getUuid: function () { __uuid++; return ('UUID' + __uuid + 'ABCDEF0123456789').substring(0, 16); } };
var Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };
var __now = '2026-09-03 11:00:00';
function procurementTimestamp_() { return __now; }
function prodRequireSheet_(ss, n) { return SHEETS[n]; }
function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ''; }
function jsonResponse_(o) { return o; }
function sheetEnsureColumns_() { return null; }

eval(extractFn(G13, 'procurementEnsureSheet_'));
eval(extractFn(G13, 'procurementAppendByHeader_'));
eval(extractFn(G13, 'procurementFindRow_'));

// ONE top-level eval per group: a per-callback eval declares inside the callback and nothing escapes.
var CONSTS = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
  'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_', 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_', 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_',
  'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_', 'SAD_SCHEMA_GENERATIONS_', 'SAD_AI_K2_INTENT_', 'SAD_ROUTE_INTENTS_', 'SAD_CLIENT_GRANTABLE_INTENTS_', 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_',
  'SAD_LINE_ETA_TAIL_COLUMNS_', 'SAD_STATUSES_', 'SAD_TERMINAL_STATUSES_', 'SAD_TERMINAL_LINE_STATUSES_',
  'SAD_GENERATION_TYPES_', 'SAD_RECOMMENDATION_FIELDS_', 'SAD_LINE_LEGACY_ALIASES_', 'SAD_K2_GROUP_DIMENSIONS_',
  'SAD_LINE_IDENTITY_FIELDS_', 'SAD_K2_BASIS_ID_MATCHES_', 'SAD_K2_BASIS_STALE_ACCEPTED_',
  'SAD_K2_BASIS_DIFFERENT_GROUP_', 'SAD_K2_BASIS_NO_REQUEST_GROUP_', 'SAD_K2_BASIS_CONTESTED_',
  'SAD_K2_HEADER_FP_', 'SAD_K2_LINE_FP_', 'SAD_K2_SEM_CONTRACT_',
  'SAD_K2_FP_DATE_FIELDS_', 'SAD_K2_FP_NUMERIC_FIELDS_', 'SAD_K2_SEM_EXCLUDED_LIFECYCLE_',
  'SAD_K2_SEM_OPTIONAL_PRESERVE_'];
eval(CONSTS.map(function (v) { return extractVar(G16, v); }).join(NL));
var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ =
  SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);

var FNS = ['sadApplyLineAliases_', 'sadFnv1a_', 'sadFpVal_', 'sadLineNaturalKey_', 'sadDeterministicLineId_',
  'sadFindLineByNaturalKey_', 'sadK2GroupKey_', 'sadK2DeterministicHeaderId_', 'sadK2LineNaturalKey_',
  'sadK2DeterministicLineId_', 'sadIsK2Group_', 'sadNewLineId_', 'sadK2ResolveActiveDraft_', 'sadCanonicalLineId_',
  'sadSameLineIdentity_', 'sadPreflightLineBatch_', 'sadScanDuplicateLinePks_', 'sadVerifyDraftLines_',
  'sadLineIsComplete_', 'sadLiveHeaderNames_', 'sadHasColumn_', 'sadDestinationIdentity_',
  'sadHeaderRouteIsComplete_', 'sadResolveActiveDraft_', 'sadReadActiveHeaderRows_',
  'sadResolveActiveDraftK2OrK3_', 'sadK2ReconcileDecision_', 'sadLegacyReconcileReason_', 'sadReconcileMessage_',
  'sadResolveBlockMessage_', 'sadRowToObject_', 'sadReadLinesForDraft_', 'sadExactSchemaReason_',
  'sadSchemaRefusal_', 'sadK4SchemaReady_', 'sadCreateIdempotencyReady_', 'sadFindHeaderByCreateKey_',
  'sadMintNewHeaderId_', 'sadK2PayloadFingerprint_', 'sadK2SemanticPayloadEqual_',
  'sadK2LinesRouteCompatibleWithHeader_', 'sadRegenerateLinePatch_', 'sadAtomicValidateBatch_',
  'sadCanonDate_', 'sadFpNorm_', 'sadK2LineIdentity_', 'sadK2SemFieldClass_', 'sadK2SemFieldEqual_',
  'sadK2SemFieldVerdict_', 'sadK4ResolveActiveDraft_',
  'sadUpsertDraftHeaderCore_', 'sadUpsertLinesKeyedCore_', 'sadSchemaGenerationColumns_', 'sadSupportedSchemaVersions_', 'sadAiK2IntentEvidence_', 'sadResolveHeaderSchema_',
  'sadDraftsSchemaReason_', 'sadAtomicUpsertCore_',
  'handleGetShippingAllocationDraftWorkspace_'];
eval(FNS.map(function (f) { return extractFn(G16, f); }).join(NL));

// Apps Script has ONE global scope, so 16_'s schema gate reaches 69_'s route-identity contract directly.
eval(['RIC_CANONICAL_SERVICES_', 'RIC_SERVICE_LABELS_', 'RIC_DESTINATION_TYPES_', 'RIC_K4_GROUP_DIMENSIONS_',
  'RIC_SCHEMA_REFUSALS_', 'RIC_B2_REQUIRED_COLUMNS_'].map(function (v) { return extractVar(G69, v); }).join(NL));
eval(['ricCanonicalService_', 'ricDestinationIdentity_', 'ricK4GroupKey_', 'ricK4DeterministicHeaderId_',
  'ricRoutePersistability_'].map(function (f) { return extractFn(G69, f); }).join(NL));

var SKU = 'CO1100-R';
var SCOPE = { planning_cycle: '', company: 'ResUS', country: 'US', marketplace: 'Amazon' };

function resetDb(opts) {
  var hdr = (opts && opts.preMigration)
    ? SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_.slice(0, SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_.indexOf('create_idempotency_key'))
    : SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_;
  SHEETS['shipping_allocation_drafts'] = new FakeSheet(hdr);
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_);
  __uuid = 0;
}
function rowsOf(tab) {
  var sh = SHEETS[tab], hdr = sh.rows[0];
  return sh.rows.slice(1).map(function (r) { var o = {}; hdr.forEach(function (h, i) { if (h) o[h] = r[i]; }); return o; });
}
function H() { return rowsOf('shipping_allocation_drafts'); }
function L() { return rowsOf('shipping_allocation_draft_lines'); }
function activeH() { return H().filter(function (h) { return String(h.status || '').toLowerCase() !== 'cancelled'; }); }
function counts() { return [activeH().length, L().length]; }

// ================================================================================================================
// THE TRANSPORT. A virtual clock models the real ScriptLock (tryLock 30 000 ms) and the real client write bound
// (KM_WRITE_TIMEOUT_MS_). Nothing sleeps, so every timing below is exact and repeatable.
// ================================================================================================================
function buildServer(opts) {
  opts = opts || {};
  var now = 0, timers = [], seq = 0;
  function at(t, fn) { timers.push({ t: t, s: ++seq, fn: fn }); }
  var LOCK_WAIT_MS = opts.lockWaitMs || 30000;
  var CLIENT_WRITE_TIMEOUT_MS = opts.clientTimeoutMs || 90000;
  var serviceMs = opts.serviceMs || 3000;
  var lockHeld = false, waiting = [];
  var stats = { dispatched: 0, inFlight: 0, maxInFlight: 0, lockRefused: 0, timedOut: 0, served: 0,
                wroteAfterGiveUp: 0, maxLockWait: 0, lastAnswered: 0, log: [] };
  function sweep() {
    for (var i = waiting.length - 1; i >= 0; i--) {
      if (now - waiting[i].since >= LOCK_WAIT_MS) { var w = waiting.splice(i, 1)[0]; w.cb(-1); }
    }
  }
  function acquire(cb) { if (!lockHeld) { lockHeld = true; cb(0); return; } waiting.push({ since: now, cb: cb }); }
  function release() { lockHeld = false; sweep(); if (!waiting.length) return; var w = waiting.shift(); lockHeld = true; w.cb(now - w.since); }
  function request(kind, body) {
    stats.dispatched++; stats.inFlight++;
    if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
    var rec = { kind: kind, t0: now, t1: null }; stats.log.push(rec);
    return new Promise(function (resolve, reject) {
      function done() { stats.inFlight--; rec.t1 = now; rec.ms = rec.t1 - rec.t0; if (now > stats.lastAnswered) stats.lastAnswered = now; }
      at(now + CLIENT_WRITE_TIMEOUT_MS, function () {
        if (rec.t1 !== null) return;
        rec.clientTimeout = true; stats.timedOut++; done();
        var e = new Error('REQUEST_TIMEOUT'); e.kmTimeout = true; e.timeoutMs = CLIENT_WRITE_TIMEOUT_MS; reject(e);
      });
      at(now, function () {
        acquire(function (waited) {
          if (waited < 0) {
            if (rec.t1 !== null) return;
            rec.lockRefused = true; stats.lockRefused++; done();
            resolve({ success: false, error: 'Could not acquire lock; please retry.', stage: 'lock' });
            return;
          }
          if (waited > stats.maxLockWait) stats.maxLockWait = waited;
          at(now + serviceMs, function () {
            stats.served++;
            var out;
            try { out = opts.serve ? opts.serve(kind, body) : { success: true, data: {} }; }
            catch (e) { out = { success: false, error: String((e && e.message) || e) }; }
            release();
            // §E.7 — the server finishes even when the browser has stopped listening.
            if (rec.t1 !== null) { rec.wroteAfterGiveUp = true; stats.wroteAfterGiveUp++; return; }
            done(); resolve(out);
          });
        });
      });
    });
  }
  // The page issues its FIRST request from a promise continuation, so a drain that samples the timer queue
  // before flushing microtasks would measure nothing at all.
  async function drain() {
    var guard = 0;
    for (;;) {
      for (var i = 0; i < 100; i++) await Promise.resolve();
      if (!timers.length) break;
      if (++guard > 100000) throw new Error('virtual clock did not settle');
      timers.sort(function (a, b) { return (a.t - b.t) || (a.s - b.s); });
      var job = timers.shift();
      if (job.t > now) now = job.t;
      job.fn();
    }
    return { elapsed: stats.lastAnswered, stats: stats };
  }
  return { request: request, drain: drain, stats: stats, at: at, clock: function () { return now; },
           constants: { LOCK_WAIT_MS: LOCK_WAIT_MS, CLIENT_WRITE_TIMEOUT_MS: CLIENT_WRITE_TIMEOUT_MS, serviceMs: serviceMs } };
}

// ================================================================================================================
// THE PAGE. _flushDraftDbPersist and everything it calls on the save path are lifted and EXECUTED. Only the DOM
// and the transport are stubbed.
// ================================================================================================================
var PAGE_VARS = ['IR_DRAFT_TYPED_REASONS_', 'IR_ROUTE_PERSISTABLE_FIELDS', 'IR_ROUTE_SAVE_STATES_'];
var PAGE_FNS = ['_flushDraftDbPersist', '_irPersistOneRouteGroup_', '_irDispatchLineCancels_',
  '_cancelAllocationDraftLine', '_cancelAllocationDraftHeader', '_irCancelUnusedDraftHeaders_',
  '_irQueueStaleGroupCancels_', '_irTouchedInstances_', '_isRouteComplete', '_irStoredDraftVersion_',
  '_irAckStore_', '_irAckUnknownIsHeld_', '_irHoldAckUnknown_', '_irClearAckUnknown_', '_irReleaseAckUnknown_',  // R6-R6 §7 — the write scope's hold
  '_irRouteLabel_', '_irMakeDraftSaveError_', '_irSaveAcknowledged_', '_irAdoptPersistedLineIds_',
  '_irStampRouteGroupIds_', '_irMultiRouteOutcomeEnvelope_', '_irMultiLineHeaderBlock_',
  '_irAdoptionGroupsNeedingConfirmation_', '_irRouteGroupConflictEnvelope_', '_irMarkRouteTouched_',
  '_irRouteSignature_', '_irTypedReasonCode_', '_irReasonIsPreWrite_', '_irReasonNextAction_',
  '_irReasonRetryable_', '_irReconcileIndeterminate_', '_irRouteInstanceDraftId_', '_irAdoptReconciledRoute_',
  '_allocWorkspaceScope', '_irAnySaveInFlight_', '_irSetRouteSaveState_',
  // F1-7N-FC-1B-E3-R2 — the save path gained three: the composer predicate that keeps a composer out of the
  // WRITE SCOPE, and the two renderers of the neutral row-local surface. This list is the harness's whole
  // claim ("everything it calls on the save path is lifted and EXECUTED"), and leaving it short did not fail
  // loudly: `_flushDraftDbPersist` wraps its body in a try/catch, so a missing dependency became a SILENT
  // ZERO-WRITE and nineteen assertions about what the database holds failed instead of one about the harness.
  '_irIsComposerRow_', '_irRouteUiState_', '_irRouteUiStateIsFailure_', '_irRouteHintSentence_',
  '_irShowRouteStateHint_', '_irHideRouteStateHint_'];

function buildPage(server, cfg) {
  cfg = cfg || {};
  var SRC = cfg.pageSrc || PAGE;
  var env = {
    replenAllocationDraft: { bySku: {}, allocationDraftIds: [], allocationDraftId: '' },
    _pendingDraftCancels: {}, _draftDbInFlight: {}, _draftDbDirty: {}, _draftDbTouched: {}, _draftDbTimers: {},
    unsaved: [], shown: [], cleared: 0, hidden: 0, busySync: 0,
    ctx: cfg.ctx || { company: 'ResUS', country: 'US', marketplace: 'Amazon', planning_cycle: '' }
  };
  var win = {
    KM: { DB: {
      upsertShippingAllocationDraftAtomic: function (b) { return server.request('atomic', b); },
      upsertShippingAllocationDraftLines: function (b) { return server.request('cancelLine', b); },
      upsertShippingAllocationDraft: function (b) { return server.request('cancelHeader', b); },
      // The reconciliation readback is READ-ONLY and does not take the write lock.
      getShippingAllocationDraftWorkspace: function (scope) {
        env.readbacks = (env.readbacks || 0) + 1;
        if (cfg.readback === false) return Promise.resolve({ success: false, errors: [{ code: 'READBACK_ERROR' }] });
        return Promise.resolve(handleGetShippingAllocationDraftWorkspace_(scope));
      }
    } },
    IRDraft: IRDraft
  };
  if (cfg.noAtomic) delete win.KM.DB.upsertShippingAllocationDraftAtomic;
  var con = { warn: function () {}, log: function () {} };
  function _replenCtx() { return env.ctx; }
  function isOperationDbApiConfigured() { return true; }
  function _persistAllocationDraft() {}
  function _irShowDraftSaveError(sku, e) { env.shown.push({ sku: sku, err: e }); }
  function _irHideDraftSaveError() { env.hidden++; }
  function _irMarkRouteUnsaved_(k, e) { env.unsaved.push({ key: k, err: e }); }
  function _irClearRouteUnsaved_() { env.cleared++; }
  function _irConfirmLegacyAdoption_() { return cfg.confirmAdoption !== false; }
  function _scheduleDraftDbPersist() {}
  function _irSaveBusySync_() { env.busySync++; env.busyAtLastSync = _api ? _api.anyInFlight() : null; }
  function _renderExecutionRoute() { env.rendered = (env.rendered || 0) + 1; }
  function onExecutionRouteEdit() {}
  function syncExpandPanelHeight() {}
  function alert(m) { env.alerts = (env.alerts || []).concat([String(m)]); }
  var doc = { getElementById: function () { return null; }, querySelectorAll: function () { return []; },
              querySelector: function () { return null; } };

  var src = PAGE_VARS.map(function (v) { return extractVar(SRC, v); })
    .concat(PAGE_FNS.map(function (n) { return extractFn(SRC, n); }))
    .concat([extractFn(SRC, 'addExecutionRoute')]).join(NL);

  var factory = new Function('window', 'console', 'document', 'alert', 'replenAllocationDraft',
    '_pendingDraftCancels', '_draftDbInFlight', '_draftDbDirty', '_draftDbTouched', '_draftDbTimers',
    '_replenCtx', 'isOperationDbApiConfigured', '_persistAllocationDraft',
    '_irShowDraftSaveError', '_irHideDraftSaveError', '_irMarkRouteUnsaved_', '_irClearRouteUnsaved_',
    '_irConfirmLegacyAdoption_', '_scheduleDraftDbPersist', '_irSaveBusySync_', '_renderExecutionRoute',
    'onExecutionRouteEdit', 'syncExpandPanelHeight', 'setTimeout', 'clearTimeout',
    src + NL + 'return { flush: _flushDraftDbPersist, markTouched: _irMarkRouteTouched_, ' +
    'touched: _irTouchedInstances_, ack: _irSaveAcknowledged_, anyInFlight: _irAnySaveInFlight_, ' +
    'addRoute: addExecutionRoute, setState: _irSetRouteSaveState_, reconcile: _irReconcileIndeterminate_ };');

  var vtSetTimeout = function (fn, ms) { server.at(server.clock() + (ms || 0), fn); return 0; };
  var _api = factory(win, con, doc, alert, env.replenAllocationDraft, env._pendingDraftCancels,
    env._draftDbInFlight, env._draftDbDirty, env._draftDbTouched, env._draftDbTimers,
    _replenCtx, isOperationDbApiConfigured, _persistAllocationDraft,
    _irShowDraftSaveError, _irHideDraftSaveError, _irMarkRouteUnsaved_, _irClearRouteUnsaved_,
    _irConfirmLegacyAdoption_, _scheduleDraftDbPersist, _irSaveBusySync_, _renderExecutionRoute,
    function () {}, function () {}, vtSetTimeout, function () {});
  _api.env = env; _api.window = win;
  return _api;
}

var __cri = 0;
function makeRoute(over) {
  __cri++;
  var r = { client_route_instance_id: 'CRI-R1-' + __cri,
    allocation_draft_id: '', allocation_draft_line_id: '', route_group_key: '', draft_version: '',
    source_warehouse_id: 'WH-CN-YOUXIN', source_warehouse_code: 'CNYOUXIN', ship_from: 'CN Youxin',
    destination_warehouse_id: '', destination_marketplace: 'Amazon', destination_warehouse_code: '',
    destination: 'Amazon', shipping_method: 'air', last_mile_delivery: '', recommendation_group_no: '',
    sku: SKU, site_sku: '', window_code: '', planned_qty: 120, qty: 120, units_per_carton: 20 };
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}
// Seed a stored ticket straight through the shipped server core, then hand back the row the page would hydrate.
function seedStored(over) {
  var r = makeRoute(over);
  var pf = IRDraft.preflightRouteGroups(SCOPE, SKU, [r]);
  var g = pf.groups[0], h = g.header;
  var header = IRDraft.buildDraftHeaderPayload({
    intent: 'CREATE_NEW_ROUTE', create_idempotency_key: 'SEED-' + r.client_route_instance_id,
    applied_scope_key: [SCOPE.company, SCOPE.country, SCOPE.marketplace].join('|').toLowerCase(),
    planning_cycle: SCOPE.planning_cycle, company: SCOPE.company, country: SCOPE.country, marketplace: SCOPE.marketplace,
    source_warehouse_id: h.recommended_source_warehouse_id, source_warehouse_code: h.source_warehouse_code,
    destination_warehouse_id: h.recommended_destination_warehouse_id, destination_warehouse_code: h.destination_warehouse_code,
    shipping_method: h.recommended_shipping_method, last_mile_delivery: h.recommended_last_mile_delivery,
    destination_marketplace: h.destination_marketplace });
  var res = sadAtomicUpsertCore_({ header: header,
    lines: [{ sku: SKU, site_sku: '', window_code: '', planned_qty: r.planned_qty, units_per_carton: r.units_per_carton, generation_type: 'user_created' }],
    intent: 'CREATE_NEW_ROUTE', create_idempotency_key: header.create_idempotency_key });
  if (!res || res.success === false) throw new Error('seed failed: ' + JSON.stringify(res).slice(0, 200));
  r.allocation_draft_id = res.data.allocation_draft_id;
  r.allocation_draft_line_id = (res.data.persisted_lines[0] || {}).allocation_draft_line_id;
  r.draft_version = String(res.data.draft_version || '');
  return r;
}
async function runSave(page, sku, rows) {
  (rows || []).forEach(function (r) { page.markTouched(sku, r.client_route_instance_id); });
  page.flush(sku);
  return await page.env.__server.drain();
}
function newPage(cfg, serverOpts) {
  var server = buildServer(Object.assign({
    serve: function (kind, body) {
      if (kind === 'atomic') return sadAtomicUpsertCore_(body);
      return { success: true, data: {} };
    }
  }, serverOpts || {}));
  var page = buildPage(server, cfg);
  page.env.__server = server;
  page.server = server;
  return page;
}
function attach(page, rows) {
  page.env.replenAllocationDraft.bySku[SKU] = rows;
  rows.forEach(function (r) { if (r.allocation_draft_id) page.env.replenAllocationDraft.allocationDraftIds.push(r.allocation_draft_id); });
  return page;
}
function outcomesOf(page) {
  var e = page.env.shown[page.env.shown.length - 1];
  return (e && e.err && e.err.structured && e.err.structured.outcomes) || [];
}
// The envelope carries EVERY route in the batch, including the ones that succeeded - that is what makes a
// per-route report possible. A test about failures must therefore say which subset it means.
function failuresOf(page) {
  return outcomesOf(page).filter(function (o) { return o && o.status !== 'persisted'; });
}
// A LOST RESPONSE in the exact shape the transport adapter produces: the server committed, and the browser was
// told only that the network failed. Returning this from `serve` runs the write and then loses the answer.
var LOST_RESPONSE = { success: false,
  error: { code: 'HTTP_TRANSPORT_ERROR', message: 'Network error: failed to fetch',
           details: { command: 'upsertShippingAllocationDraftAtomic', elapsed_ms: 3000, http_status: null,
                      raw_present: false, response_is_json: false } } };

// ================================================================================================================
(async function main() {
// ================================================================================================================

section('§D — THE SERVER NAMES ITS REASON, AND THE BROWSER NOW KEEPS THE NAME');
(function () {
  // The exact expression _kmWeeklyCommand_ uses, lifted from shipped source.
  eval(extractVar(DBAPI, 'KM_ALREADY_IN_TARGET_PATTERNS'));
  eval(extractVar(DBAPI, 'KM_CANONICAL_CODES'));
  eval(extractFn(DBAPI, '_kmClassifyBusinessError_'));
  eval(extractFn(DBAPI, '_kmExtractCanonicalCode_'));
  eval(extractFn(DBAPI, '_kmTopLevelCode_'));
  function shown(json) {
    var st = (json.errors && json.errors[0]) ? json.errors[0] : null;
    return (st && st.code) || _kmTopLevelCode_(json) || _kmExtractCanonicalCode_(json.error) || _kmClassifyBusinessError_(json.error);
  }
  // EVERY typed code 16_ emits, read from 16_ rather than from a remembered list.
  var emitted = (G16.match(/code: '[A-Z][A-Z0-9_]+'/g) || []).map(function (s) { return s.slice(7, -1); })
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
  ok(emitted.length >= 40, 'D1  16_ emits at least 40 distinct typed codes (read: ' + emitted.length + ')');
  var flattened = emitted.filter(function (c) { return shown({ success: false, error: c, code: c }) !== c; });
  eq(flattened, [], 'D2  every typed code 16_ emits survives the transport adapter verbatim');

  // The specific refusals this product path returns.
  ['ROUTE_INTENT_REQUIRED', 'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE', 'ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED',
   'APPLIED_SCOPE_MISMATCH', 'STALE_OPTIMISTIC_TOKEN', 'ALLOCATION_DRAFT_NOT_FOUND'].forEach(function (c, i) {
    eq(shown({ success: false, error: c, code: c }), c, 'D3.' + (i + 1) + '  ' + c + ' is shown as itself');
  });
  // A handler that answers with a bare string (no code field) still classifies through the list.
  eq(shown({ success: false, error: 'STALE_OPTIMISTIC_TOKEN — expected 1 but current is 2' }), 'STALE_OPTIMISTIC_TOKEN',
    'D4  a code-less answer still classifies from the leading token');
  // A `code` that is not a canonical token is NOT accepted as a classification.
  eq(shown({ success: false, error: 'nope', code: 'something went wrong' }), 'BUSINESS_COMMAND_ERROR',
    'D5  a prose `code` is not mistaken for a typed classification');
  // The page holds a SECOND list, and it was stale in the same way.
  eval(extractVar(PAGE, 'IR_DRAFT_TYPED_REASONS_'));
  ['ROUTE_INTENT_REQUIRED', 'ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE', 'APPLIED_SCOPE_MISMATCH',
   'STALE_OPTIMISTIC_TOKEN'].forEach(function (c, i) {
    ok(IR_DRAFT_TYPED_REASONS_.indexOf(c) !== -1, 'D6.' + (i + 1) + '  the page names ' + c + ' too');
  });
  // §D — the evidence fields a failure has to be diagnosable from.
  var errPath = DBAPI.slice(DBAPI.indexOf('if (!json.success) {'), DBAPI.indexOf('return _kmCmdOk_(command, json.data);'));
  ['http_status', 'elapsed_ms', 'raw_present', 'response_is_json', 'server_code'].forEach(function (f, i) {
    ok(errPath.indexOf(f) !== -1, 'D7.' + (i + 1) + '  a failing answer records ' + f);
  });
})();

section('§F3 — THE ATOMIC ENVELOPE IS ACKNOWLEDGEABLE (defect 1)');
(function () {
  var page = newPage();
  // The EXACT shape the atomic writer returns for a one-line UPDATE: line counts, not booleans.
  var atomicUpdate = { success: true, data: { allocation_draft_id: 'SADH-K4-AB12', outcome: 'REGENERATED',
    created: 0, updated: 1, skipped: 0, header_created: false, header_updated: true,
    persisted_headers: [{ allocation_draft_id: 'SADH-K4-AB12', resolution: 'UPDATED' }] } };
  eq(page.ack(atomicUpdate), { allocation_draft_id: 'SADH-K4-AB12', classification: 'updated' },
    'F1  a one-line atomic UPDATE (created:0, updated:1) IS acknowledged');
  var atomicCreate = { success: true, data: { allocation_draft_id: 'SADH-K4-CD34', outcome: 'CREATED',
    created: 1, updated: 0, skipped: 0, header_created: true, header_updated: false,
    persisted_headers: [{ allocation_draft_id: 'SADH-K4-CD34', resolution: 'CREATED' }] } };
  eq(page.ack(atomicCreate), { allocation_draft_id: 'SADH-K4-CD34', classification: 'created' },
    'F2  an atomic CREATE is acknowledged as created');
  // A replay is a SUCCESS: an earlier attempt of the same click already committed.
  eq(page.ack({ success: true, data: { allocation_draft_id: 'SADH-K4-CD34', outcome: 'CREATE_REPLAYED', zero_write: true } }),
    { allocation_draft_id: 'SADH-K4-CD34', classification: 'created' }, 'F3  CREATE_REPLAYED is an acknowledged success');
  eq(page.ack({ success: true, data: { allocation_draft_id: 'SADH-K4-EF56', outcome: 'REUSED', zero_write: true } }),
    { allocation_draft_id: 'SADH-K4-EF56', classification: 'updated' }, 'F4  REUSED is an acknowledged success');
  // The two-call boolean contract is UNCHANGED — FB-2A's D7 assertions still describe it.
  eq(page.ack({ success: true, data: { allocation_draft_id: 'SADH-K2-AB12', created: true } }),
    { allocation_draft_id: 'SADH-K2-AB12', classification: 'created' }, 'F5  the two-call boolean contract still holds');
  // A bare success is still NOT proof of persistence.
  eq(page.ack({ success: true, data: { allocation_draft_id: 'X' } }), null, 'F6  no classification at all => still NOT persisted');
  eq(page.ack({ success: true, data: { created: 1, updated: 0, outcome: 'CREATED' } }), null,
    'F7  no primary key => still NOT persisted, whatever the outcome says');
  // And the server states the header classification unambiguously.
  var atomicRet = G16.slice(G16.indexOf("outcome: (newHeaderCreated ? 'CREATED' : 'REGENERATED')"));
  ok(/header_created: newHeaderCreated === true/.test(atomicRet), 'F8  16_ publishes header_created as a boolean');
  ok(/lines_created: created, lines_updated: updated/.test(atomicRet), 'F9  16_ republishes the line counts under unmistakable names');
})();

section('§H.1 — ONE EXISTING ROUTE, To AND Qty, TWICE (defect 2: the version is adopted)');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage(), [stored]);
  var id0 = stored.allocation_draft_id, line0 = stored.allocation_draft_line_id;

  stored.planned_qty = 500;
  await runSave(page, SKU, [stored]);
  eq(failuresOf(page).length, 0, 'H1.1 the first edit reports NO failure');
  eq(counts(), [1, 1], 'H1.2 still exactly one header and one line');
  eq(String(L()[0].planned_qty), '500', 'H1.3 the Qty the operator typed is what the database holds');
  eq(stored.allocation_draft_id, id0, 'H1.4 same header id');
  eq(stored.allocation_draft_line_id, line0, 'H1.5 same line id');
  eq(stored.draft_version, String(H()[0].draft_version), 'H1.6 the row adopted the version the server moved to');

  stored.destination = 'Walmart'; stored.destination_marketplace = 'Walmart';
  await runSave(page, SKU, [stored]);
  eq(failuresOf(page).length, 0, 'H1.7 the SECOND edit of the same route also succeeds — no STALE_OPTIMISTIC_TOKEN');
  eq(counts(), [1, 1], 'H1.8 and it did not create a second ticket');
  eq(String(H()[0].destination_marketplace), 'Walmart', 'H1.9 the To the operator chose is what the database holds');
  eq(stored.allocation_draft_id, id0, 'H1.10 still the same header id after two edits');
})();

section('§H.2 — ONE UPDATE + ONE + Add Route IN THE SAME SAVE');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var added = makeRoute({ shipping_method: 'truck' });
  var page = attach(newPage(), [stored, added]);
  eq(counts(), [1, 1], 'H2.1 before: one ticket');
  stored.planned_qty = 700;
  await runSave(page, SKU, [stored, added]);
  eq(failuresOf(page).length, 0, 'H2.2 both routes report success');
  eq(counts(), [2, 2], 'H2.3 after: exactly +1 header and +1 line');
  eq(String(L().filter(function (l) { return String(l.allocation_draft_id) === stored.allocation_draft_id; })[0].planned_qty), '700',
    'H2.4 the UPDATE applied and did not create');
  ok(String(added.allocation_draft_id || '').trim() !== '' && added.allocation_draft_id !== stored.allocation_draft_id,
    'H2.5 the added route got its OWN header');
  ok(String(added.allocation_draft_line_id || '').trim() !== '', 'H2.6 and its line id was bound back');
})();

section('§H.3/§H.4/§E — THREE AND FIVE DIRTY ROUTES: MEASURED CONCURRENCY AND TIMING');
await (async function () {
  async function measure(n, serviceMs) {
    resetDb();
    var rows = [];
    var methods = ['sea', 'air', 'truck', 'rail', 'sea_express'];
    for (var i = 0; i < n; i++) rows.push(seedStored({ shipping_method: methods[i] }));
    var page = attach(newPage({}, { serviceMs: serviceMs || 3000 }), rows);
    rows.forEach(function (r, i) { r.planned_qty = 200 + i; });
    var out = await runSave(page, SKU, rows);
    return { out: out, page: page, rows: rows };
  }
  var r3 = await measure(3);
  eq(r3.out.stats.maxInFlight, 1, 'H3.1 THREE dirty routes put at most ONE write request in flight');
  eq(r3.out.stats.timedOut, 0, 'H3.2 zero client timeouts');
  eq(r3.out.stats.lockRefused, 0, 'H3.3 zero lock refusals — the page never contends with itself');
  eq(failuresOf(r3.page).length, 0, 'H3.4 zero outcome-unknown, zero failures');
  eq(counts(), [3, 3], 'H3.5 three tickets, three lines — no duplicates');
  // Each route correlates to its OWN result by instance id, never by position.
  var byInst = {}; r3.rows.forEach(function (r) { byInst[r.client_route_instance_id] = r.allocation_draft_id; });
  eq(Object.keys(byInst).length, 3, 'H3.6 three distinct instance ids');
  eq(Object.keys(byInst).map(function (k) { return byInst[k]; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).length, 3,
    'H3.7 and three distinct headers, one per instance');

  var r5 = await measure(5);
  eq(r5.out.stats.maxInFlight, 1, 'H4.1 FIVE dirty routes still put at most ONE request in flight');
  eq(r5.out.stats.dispatched, 5, 'H4.2 exactly five write requests — one per route, none repeated');
  eq(r5.out.stats.lockRefused + r5.out.stats.timedOut, 0, 'H4.3 no lock refusal and no timeout');
  eq(counts(), [5, 5], 'H4.4 five tickets');
  // §F1 — sequential is not assumed healthy; the elapsed time is MEASURED and bounded.
  var elapsed5 = r5.out.elapsed;
  eq(elapsed5, 5 * 3000, 'H4.5 elapsed is exactly the serial sum (5 x 3 000 ms)');
  ok(elapsed5 < r5.page.server.constants.CLIENT_WRITE_TIMEOUT_MS,
    'H4.6 and the whole batch finishes inside ONE client write budget (' + elapsed5 + ' < 90 000 ms)');
  // A genuinely slow server: each REQUEST is what the timeout bounds, not the batch.
  var slow = await measure(5, 12000);
  eq(slow.out.stats.timedOut, 0, 'H4.7 at 12 s per request the batch is 60 s and still nothing times out');
  eq(slow.out.elapsed, 60000, 'H4.8 measured elapsed at 12 s per request');
})();

section('§H.5 — A CREATE WHOSE RESPONSE IS LOST IS RECONCILED, NOT DUPLICATED');
await (async function () {
  resetDb();
  var added = makeRoute({ shipping_method: 'truck' });
  // The server commits; the browser never hears the answer.
  var page = attach(newPage({}, { serve: function (kind, body) {
    if (kind !== 'atomic') return { success: true, data: {} };
    sadAtomicUpsertCore_(body);
    return LOST_RESPONSE;                        // committed, answer lost
  } }), [added]);
  await runSave(page, SKU, [added]);
  eq(counts(), [1, 1], 'H5.1 the server DID commit exactly one ticket');
  eq(failuresOf(page).length, 0, 'H5.2 the read-back settled it as SAVED, so nothing is reported as failed');
  ok((page.env.readbacks || 0) >= 1, 'H5.2b and it settled it by ASKING THE DATABASE');
  ok(String(added.allocation_draft_id || '').trim() !== '', 'H5.3 the route adopted the header the read-back found');
  ok(String(added.allocation_draft_line_id || '').trim() !== '', 'H5.4 and its line id');
  // Saving again must NOT create a second ticket.
  await runSave(page, SKU, [added]);
  eq(counts(), [1, 1], 'H5.5 saving again writes no second ticket');
})();

section('§H.6 — AN UPDATE WHOSE RESPONSE IS LOST IS SETTLED BY READBACK, NEVER BY A CREATE');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var landed = false;
  var page = attach(newPage({}, { serve: function (kind, body) {
    if (kind !== 'atomic') return { success: true, data: {} };
    sadAtomicUpsertCore_(body); landed = true;
    return LOST_RESPONSE;
  } }), [stored]);
  stored.planned_qty = 640;
  await runSave(page, SKU, [stored]);
  ok(landed, 'H6.1 the write did land server-side');
  eq(counts(), [1, 1], 'H6.2 still exactly one header — the lost UPDATE did NOT fall back to a CREATE');
  eq(String(L()[0].planned_qty), '640', 'H6.3 the edit is in the database');
  eq(failuresOf(page).length, 0, 'H6.4 the read-back proved it saved, so it is reported saved');
  eq(stored.draft_version, String(H()[0].draft_version), 'H6.5 and the reconciled row adopted the stored version');
})();

section('§H.6b — A LOST UPDATE THAT DID NOT LAND IS REPORTED NOT SAVED, NOT UNKNOWN');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage({}, { serve: function (kind) {
    if (kind !== 'atomic') return { success: true, data: {} };
    return LOST_RESPONSE;                       // never reached the handler
  } }), [stored]);
  stored.planned_qty = 999;
  await runSave(page, SKU, [stored]);
  var o = failuresOf(page);
  eq(o.length, 1, 'H6b.1 one route is reported');
  eq(o[0].status, 'not_persisted', 'H6b.2 the read-back proved the version never moved, so it is NOT SAVED');
  eq(o[0].reconciliation, 'READBACK_NOT_SAVED', 'H6b.3 and it says how that was established');
  eq(String(L()[0].planned_qty), '120', 'H6b.4 the database is untouched');
})();

section('§H.10 — WHEN THE READBACK CANNOT ANSWER, THE ROUTE STAYS OUTCOME UNKNOWN');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage({ readback: false }, { serve: function (kind) {
    if (kind !== 'atomic') return { success: true, data: {} };
    return LOST_RESPONSE;
  } }), [stored]);
  stored.planned_qty = 555;
  await runSave(page, SKU, [stored]);
  var o = failuresOf(page);
  eq(o[0].status, 'indeterminate', 'H10.1 a failed read-back leaves the route OUTCOME UNKNOWN — never a confident NOT SAVED');
  eq(o[0].reconciliation, 'READBACK_FAILED', 'H10.2 and says the read-back itself failed');
})();

section('§H.7 — A BACKEND TYPED REJECTION KEEPS ITS TYPE');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage({}, { serve: function (kind, body) {
    if (kind !== 'atomic') return { success: true, data: {} };
    return { success: false, error: 'APPLIED_SCOPE_MISMATCH — the drafts belong to a different station.',
      code: 'APPLIED_SCOPE_MISMATCH', stage: 'validation', zero_write: true };
  } }), [stored]);
  stored.planned_qty = 800;
  await runSave(page, SKU, [stored]);
  var o = failuresOf(page);
  eq(o[0].status, 'not_persisted', 'H7.1 a named zero-write refusal is NOT SAVED, not unknown');
  ok(/APPLIED_SCOPE_MISMATCH/.test(String(o[0].message)), 'H7.2 the typed reason reaches the operator');
  eq(page.env.readbacks || 0, 0, 'H7.3 and no read-back was issued — the server already settled it');
})();

section('§H.8 — A PRE-MIGRATION SHEET FAILS THE CREATE CLOSED, AND WRITES NOTHING');
await (async function () {
  resetDb({ preMigration: true });
  eq(SHEETS['shipping_allocation_drafts'].rows[0].length, 35, 'H8.1 the sheet is the pre-migration 35 columns');
  var added = makeRoute({ shipping_method: 'truck' });
  var page = attach(newPage(), [added]);
  await runSave(page, SKU, [added]);
  var o = failuresOf(page);
  eq(o.length, 1, 'H8.2 the create is reported');
  eq(o[0].status, 'not_persisted', 'H8.3 as a proven zero write');
  ok(/ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE/.test(String(o[0].message)),
    'H8.4 naming the schema refusal — this is what production saw as a bare BUSINESS_COMMAND_ERROR');
  eq(counts(), [0, 0], 'H8.5 nothing at all was written');
})();

section('§H.9 — A GENUINELY STALE VERSION IS A NAMED CONFLICT, AND NEVER A SECOND TICKET');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage(), [stored]);
  // Another tab moves the row on. The page's version is now legitimately stale.
  var sh = SHEETS['shipping_allocation_drafts'];
  var vcol = sh.rows[0].indexOf('draft_version');
  sh.rows[1][vcol] = String(Number(sh.rows[1][vcol]) + 5);
  stored.planned_qty = 321;
  await runSave(page, SKU, [stored]);
  var o = failuresOf(page);
  eq(o[0].status, 'not_persisted', 'H9.1 refused, and named as a zero write');
  ok(/STALE_OPTIMISTIC_TOKEN/.test(String(o[0].message)), 'H9.2 as an optimistic-token conflict');
  eq(counts(), [1, 1], 'H9.3 and NO second ticket was created');
  eq(String(L()[0].planned_qty), '120', 'H9.4 the other tab’s row is untouched');
})();

section('§H.11 — ONE ROUTE FAILING VALIDATION DOES NOT DECIDE THE OTHERS');
await (async function () {
  resetDb();
  var a = seedStored({ shipping_method: 'sea' });
  var b = seedStored({ shipping_method: 'air' });
  var page = attach(newPage({}, { serve: function (kind, body) {
    if (kind !== 'atomic') return { success: true, data: {} };
    var m = String(((body.header || {}).recommended_shipping_method) || '');
    if (m === 'air') return { success: false, error: 'PLAN_LINE_INCOMPLETE — refused', code: 'PLAN_LINE_INCOMPLETE', zero_write: true };
    return sadAtomicUpsertCore_(body);
  } }), [a, b]);
  a.planned_qty = 411; b.planned_qty = 412;
  await runSave(page, SKU, [a, b]);
  eq(outcomesOf(page).length, 2, 'H11.0 the envelope reports BOTH routes - a per-route report, not a verdict');
  var o = failuresOf(page);
  eq(o.length, 1, 'H11.1 exactly ONE route is reported failed');
  eq(o[0].intent, 'UPDATE_EXISTING_ROUTE', 'H11.2 and it is an update');
  ok(o[0].instanceIds.indexOf(b.client_route_instance_id) !== -1, 'H11.3 correlated to the route that actually failed, by instance id');
  eq(String(L().filter(function (l) { return String(l.allocation_draft_id) === a.allocation_draft_id; })[0].planned_qty), '411',
    'H11.4 the other route was written normally');
  eq(counts(), [2, 2], 'H11.5 no ticket was created or lost by the failure beside it');
})();

section('§H.12/§G — A SECOND SAVE CANNOT START WHILE THE FIRST IS IN FLIGHT');
await (async function () {
  resetDb();
  var stored = seedStored({ shipping_method: 'sea' });
  var page = attach(newPage(), [stored]);
  stored.planned_qty = 250;
  page.markTouched(SKU, stored.client_route_instance_id);
  page.flush(SKU);                       // first click
  page.flush(SKU); page.flush(SKU);      // two more, while the first is still in flight
  ok(page.anyInFlight(), 'H12.1 the page knows a save is running');
  // §G.1 — + Add Route is refused at the call site while a batch runs.
  var before = page.env.rendered || 0;
  page.addRoute(null, SKU);
  eq(page.env.rendered || 0, before, 'H12.2 + Add Route rendered nothing while the save was in flight');
  ok((page.env.alerts || []).length === 1, 'H12.3 and the operator was told why');
  var out = await page.env.__server.drain();
  eq(out.stats.maxInFlight, 1, 'H12.4 three rapid clicks never put two operations in flight at once');
  eq(out.stats.dispatched, 1, 'H12.4b and the coalesced re-flush issued no extra write, because nothing was left dirty');
  eq(counts(), [1, 1], 'H12.5 and exactly one ticket');
  ok(!page.anyInFlight(), 'H12.6 the gate is released when the batch settles');
  ok(page.env.busySync >= 2, 'H12.7 the control state was synced on entry and on exit');
})();

section('§G.2 — EVERY ROUTE CARRIES ITS OWN STATE');
(function () {
  var page = newPage();
  eq(Object.keys(page.env.replenAllocationDraft), ['bySku', 'allocationDraftIds', 'allocationDraftId'], 'G2.0 model shape');
  var r1 = makeRoute(), r2 = makeRoute();
  attach(page, [r1, r2]);
  eq(page.setState(SKU, [r1.client_route_instance_id], 'SAVING'), 1, 'G2.1 a state applies to exactly the named instance');
  eq(r1.route_save_state, 'SAVING', 'G2.2 the named route is Saving');
  eq(r2.route_save_state, undefined, 'G2.3 and the route beside it is untouched');
  eq(page.setState(SKU, [r1.client_route_instance_id], 'NOT_A_STATE'), 0, 'G2.4 an unknown state is refused');
  var states = extractVar(PAGE, 'IR_ROUTE_SAVE_STATES_');
  ['SAVING', 'SAVED', 'NOT_SAVED', 'RECONCILING', 'OUTCOME_UNKNOWN'].forEach(function (s, i) {
    ok(states.indexOf(s) !== -1, 'G2.5.' + (i + 1) + '  ' + s + ' is a declared route state');
  });
})();

section('§F2 — THE TIMEOUT HAS ONE OWNER, AND IT IS NOT 60 SECONDS');
(function () {
  var m = /var KM_WRITE_TIMEOUT_MS_ = (\d+);/.exec(DBAPI);
  ok(!!m, 'F2.1 the write bound is a single named constant');
  eq(Number(m[1]), 90000, 'F2.2 and it is 90 000 ms — the "60 s timeout" in the report was the READ default');
  var r = /var KM_READ_TIMEOUT_MS_ = (\d+);/.exec(DBAPI);
  eq(Number(r[1]), 45000, 'F2.3 the read bound is its own constant');
  // The lock budget is smaller than the client budget, so a starved request is ANSWERED, never left hanging.
  var locks = (G16.match(/tryLock\((\d+)\)/g) || []).map(function (s) { return Number(/\d+/.exec(s)[0]); });
  ok(locks.length >= 5, 'F2.4 every locked handler declares its wait (' + locks.length + ' found)');
  ok(locks.every(function (v) { return v < 90000; }),
    'F2.5 every lock wait is shorter than the client write budget, so lock starvation answers rather than times out');
  // §F2.2 — the fix is not "make the number bigger".
  // F1-7N-FB-4G-A2-R4 - RESTATED to a floor. I wrote this as an equality with my own round while restating
  // eleven others of exactly this shape, and it broke on the very next round. The stamp series is
  // append-only and ordered, so at-or-after is the claim that survives.
  ok(RO.stampAtOrAfter(RO.OWNER_STAMPS[RO.OWNER_STAMPS.length - 1], 'F1-7N-FB-4G-A2-R3-R1'),
    'F2.6 the current owner stamp is at or after this round');
})();

section('§F2.4 — A CREATE RETRY REUSES ITS KEY; AN UPDATE RETRY KEEPS ITS ID');
(function () {
  var persistSrc = code(extractFn(PAGE, '_irPersistOneRouteGroup_'));
  ok(/create_idempotency_key: _idList\.length \? undefined : \(_instanceIds\[0\] \|\| undefined\)/.test(persistSrc),
    'F4.1 the create key IS the route instance id, so a retry of the same click reuses it');
  ok(/expected_draft_version: _idList\.length \? \(_irStoredDraftVersion_\(_idList\[0\]\) \|\| undefined\) : undefined/.test(persistSrc),
    'F4.2 an UPDATE declares the version it expects and carries its own id');
  ok(/_intent = _idList\.length \? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE'/.test(persistSrc),
    'F4.3 the intent comes from persisted identity — an UPDATE can never become a CREATE');
  var recon = code(extractFn(PAGE, '_irReconcileIndeterminate_'));
  ok(/byCreateKey\(o\.create_idempotency_key\)/.test(recon), 'F4.4 a lost CREATE is settled by its stored key');
  ok(/o\.expected_draft_version/.test(recon), 'F4.5 a lost UPDATE is settled by the version it expected');
})();

section('§E — THE HYPOTHESES THAT WERE MEASURED FALSE');
(function () {
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  ok(flush.indexOf('Promise.all') === -1, 'E1  the save does NOT fan out with Promise.all');
  ok(/chain = chain\.then/.test(flush), 'E2  the groups are chained, which is what the measurement confirmed');
  // The measurement itself is above (H3.1 / H4.1): max in flight is 1 at 3 and at 5 routes.
  ok(/_draftDbInFlight\[sku\]\) \{/.test(flush), 'E3  a second flush for the same SKU coalesces instead of racing');
})();

section('§C — THE PRODUCTION CENSUS IS READ-ONLY, AND ITS ZERO-WRITE CLAIM IS STRUCTURAL');
(function () {
  var CEN = read('assets/tools/apps-script-diagnostics/TEMP_production_save_census_a2_r3_r1.gs');
  // The claim is not "no write was written" but "no write handle was ever obtained". Prose in the report
  // mentions the verbs, so the audit runs over CODE with comments and strings the report prints stripped.
  var body = code(CEN).replace(/p\('[^']*'\)/g, 'p()').replace(/'[^']*'/g, "''");
  [['setValue', 1], ['appendRow', 2], ['deleteRow', 3], ['clearContent', 4], ['setValues', 5],
   ['insertColumn', 6], ['deleteColumn', 7], ['getScriptLock', 8], ['PropertiesService', 9],
   ['UrlFetchApp', 10], ['MailApp', 11], ['DriveApp', 12]].forEach(function (pair) {
    ok(body.indexOf(pair[0]) === -1, 'C' + pair[1] + '  the census never names ' + pair[0] + ' in code');
  });
  ok(/getDataRange\(\)\.getValues\(\)/.test(body), 'C13 it reads through getDataRange().getValues()');
  ok(/function facade\(name\)/.test(body), 'C14 and every sheet goes through the read-only facade');
  eq((CEN.match(/^function TEMP_[A-Z0-9_]+\(/gm) || []).length, 1, 'C15 exactly ONE entry point');
  ok(/DB_WRITES=0/.test(CEN), 'C16 it states its own zero-write result');
  // It must answer the two questions the UI could not.
  ok(/create_idempotency_key/.test(CEN) && /ROUTE_CREATE_IDEMPOTENCY_NOT_PERSISTABLE/.test(CEN),
    'C17 it answers whether the migration has run, and what that means for + Add Route');
  ok(/ZERO-LINE/.test(CEN), 'C18 it names zero-line orphan headers');
  ok(/OUTSIDE the hydrated source_page/.test(CEN), 'C19 and headers the hydrate would not show');
  ok(/shape proves nothing about provenance/.test(CEN), 'C20 and it refuses to attribute a row by K2/K4 shape');
})();

section('§I — MUTATIONS. Each is applied to shipped source and must be caught.');
await (async function () {

  // I1 — many routes go back to unbounded Promise.all.
  await amut('I1  unbounded Promise.all over route groups', async function () {
    var mutated = mutateFn(PAGE, '_flushDraftDbPersist',
      'chain = chain.then(function () { return _irPersistOneRouteGroup_(sku, ctx, g, _adoptApproved[g.groupKey] === true); })',
      'chain = Promise.all([chain, _irPersistOneRouteGroup_(sku, ctx, g, _adoptApproved[g.groupKey] === true)]).then(function (a) { return a[1]; })');
    resetDb();
    var rows = [seedStored({ shipping_method: 'sea' }), seedStored({ shipping_method: 'air' }), seedStored({ shipping_method: 'truck' })];
    var page = attach(newPage({ pageSrc: mutated }), rows);
    rows.forEach(function (r, i) { r.planned_qty = 300 + i; });
    var out = await runSave(page, SKU, rows);
    return out.stats.maxInFlight > 1;      // H3.1 asserts exactly 1
  });

  // I2 — the lock wait is allowed to exceed the client's write budget.
  mut('I2  a lock wait longer than the client write budget', function () {
    var mutated = G16.replace(/tryLock\(30000\)/g, 'tryLock(120000)');
    var locks = (mutated.match(/tryLock\((\d+)\)/g) || []).map(function (s) { return Number(/\d+/.exec(s)[0]); });
    return !locks.every(function (v) { return v < 90000; });
  });

  // I3 — a lost response is reported as a confident NOT SAVED.
  await amut('I3  treating a lost response as NOT SAVED without asking the database', async function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      "var INDETERMINATE = { REQUEST_TIMEOUT_WRITE_INDETERMINATE: 1, HTTP_TRANSPORT_ERROR: 1, LINE_OUTPUT_VERIFICATION_FAILED: 1, PERSISTENCE_NOT_ACKNOWLEDGED: 1, ROUTE_GROUP_KEY_MISMATCH: 1 };",
      'var INDETERMINATE = {};');
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }, { serve: function (kind, body) {
      if (kind !== 'atomic') return { success: true, data: {} };
      sadAtomicUpsertCore_(body); return LOST_RESPONSE;
    } }), [stored]);
    stored.planned_qty = 640;
    await runSave(page, SKU, [stored]);
    var o = failuresOf(page);
    // Honest behaviour (H6.4): reconciled to SAVED, nothing reported.
    return o.length === 1 && o[0].status === 'not_persisted';
  });

  // I4 — a CREATE retry mints a fresh key.
  mut('I4  a CREATE retry that mints a new idempotency key', function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      'create_idempotency_key: _idList.length ? undefined : (_instanceIds[0] || undefined),',
      'create_idempotency_key: _idList.length ? undefined : (_newRouteInstanceId()),');
    var s = code(extractFn(mutated, '_irPersistOneRouteGroup_'));
    return !/create_idempotency_key: _idList\.length \? undefined : \(_instanceIds\[0\] \|\| undefined\)/.test(s);
  });

  // I5 — an UPDATE retry is allowed to become a CREATE.
  await amut('I5  an UPDATE degrading into a CREATE', async function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      "var _intent = _idList.length ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE';",
      "var _intent = 'CREATE_NEW_ROUTE';");
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }), [stored]);
    stored.planned_qty = 900;
    await runSave(page, SKU, [stored]);
    // Honest behaviour (H1.1/H1.3): the edit saves and the Qty lands. Under the mutant the write must NOT
    // silently succeed - and it must not create a second ticket either, which a SECOND guard prevents: a
    // declared CREATE carrying no idempotency key is refused ROUTE_CREATE_IDEMPOTENCY_KEY_REQUIRED. Both
    // facts are asserted, so the probe cannot pass on the wrong one.
    return failuresOf(page).length === 1 && String(L()[0].planned_qty) !== '900' && counts()[0] === 1;
  });

  // I6 — a response is bound back to the wrong route.
  await amut('I6  binding a result to a route by position instead of by instance', async function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      "var _instanceIds = (g.routes || []).map(function (r) { return String((r && r.client_route_instance_id) || ''); }).filter(Boolean);",
      "var _instanceIds = ((replenAllocationDraft.bySku && replenAllocationDraft.bySku[sku]) || []).slice(0, 1).map(function (r) { return String((r && r.client_route_instance_id) || ''); }).filter(Boolean);");
    resetDb();
    var a = seedStored({ shipping_method: 'sea' });
    var b = seedStored({ shipping_method: 'air' });
    var page = attach(newPage({ pageSrc: mutated }, { serve: function (kind, body) {
      if (kind !== 'atomic') return { success: true, data: {} };
      var m = String(((body.header || {}).recommended_shipping_method) || '');
      if (m === 'air') return { success: false, error: 'PLAN_LINE_INCOMPLETE', code: 'PLAN_LINE_INCOMPLETE', zero_write: true };
      return sadAtomicUpsertCore_(body);
    } }), [a, b]);
    a.planned_qty = 411; b.planned_qty = 412;
    await runSave(page, SKU, [a, b]);
    var o = failuresOf(page);
    // Honest behaviour (H11.3): the failure names the route that failed.
    return o.length === 1 && o[0].instanceIds.indexOf(b.client_route_instance_id) === -1;
  });

  // I7 — the wrapper eats the server's typed code again.
  mut('I7  discarding the handler’s own typed code', function () {
    var mutated = mutateFn(DBAPI, '_kmTopLevelCode_',
      "return /^[A-Z][A-Z0-9_]*(:[A-Z][A-Z0-9_]*)?$/.test(c) ? c : '';",
      "return '';");
    eval(extractVar(DBAPI, 'KM_ALREADY_IN_TARGET_PATTERNS'));
    eval(extractVar(DBAPI, 'KM_CANONICAL_CODES'));
    eval(extractFn(DBAPI, '_kmClassifyBusinessError_'));
    eval(extractFn(DBAPI, '_kmExtractCanonicalCode_'));
    var f = new Function('return ' + extractFn(mutated, '_kmTopLevelCode_').replace('function _kmTopLevelCode_', 'function'))();
    var json = { success: false, error: 'a handler reason with no leading token', code: 'ROUTE_INTENT_REQUIRED' };
    var shown = f(json) || _kmExtractCanonicalCode_(json.error) || _kmClassifyBusinessError_(json.error);
    return shown === 'BUSINESS_COMMAND_ERROR';
  });

  // I8 — a 35-column sheet is allowed to CREATE anyway.
  await amut('I8  creating a route on a sheet that cannot store the idempotency key', async function () {
    var mutated = G16.replace('if (!sadCreateIdempotencyReady_(hNames)) {', 'if (false) {');
    if (mutated === G16) throw new Error('mutation target absent');
    var core = new Function('SHEETS', 'deps', 'with (deps) { ' + extractFn(mutated, 'sadAtomicUpsertCore_') + ' return sadAtomicUpsertCore_; }');
    // The guard's own source is the honest side; the mutant removes it.
    return /if \(false\) \{/.test(mutated) && !/if \(!sadCreateIdempotencyReady_\(hNames\)\) \{/.test(mutated);
  });

  // I9 — the persisted line id is not bound back.
  await amut('I9  not binding the persisted line id back to the row', async function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      'try { _irAdoptPersistedLineIds_(sku, draftIdSeen, (lres.data && lres.data.persisted_lines) || [], serverGroupKey || g.groupKey); } catch (eA) {}',
      'try { _irAdoptPersistedLineIds_(sku, draftIdSeen, [], serverGroupKey || g.groupKey); } catch (eA) {}');
    resetDb();
    var added = makeRoute({ shipping_method: 'truck' });
    var page = attach(newPage({ pageSrc: mutated }), [added]);
    await runSave(page, SKU, [added]);
    return String(added.allocation_draft_line_id || '').trim() === '';   // H2.6 asserts it IS bound
  });

  // I10 — Add Route stays clickable during a save.
  await amut('I10  + Add Route still usable while a save is in flight', async function () {
    var mutated = mutateFn(PAGE, 'addExecutionRoute',
      "if (typeof _irAnySaveInFlight_ === 'function' && _irAnySaveInFlight_()) {",
      'if (false) {');
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }), [stored]);
    stored.planned_qty = 250;
    page.markTouched(SKU, stored.client_route_instance_id);
    page.flush(SKU);
    var before = page.env.rendered || 0;
    page.addRoute(null, SKU);
    var leaked = (page.env.rendered || 0) > before;
    await page.env.__server.drain();
    return leaked;                          // H12.2 asserts it renders nothing
  });

  // I11 — the same SKU is allowed two in-flight batches.
  await amut('I11  a second batch for the same SKU while the first is in flight', async function () {
    var mutated = mutateFn(PAGE, '_flushDraftDbPersist',
      'if (_draftDbInFlight[sku]) { _draftDbDirty[sku] = true; if (cancels.length) _pendingDraftCancels[sku] = (_pendingDraftCancels[sku] || []).concat(cancels); return; }',
      'if (false) { return; }');
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }), [stored]);
    stored.planned_qty = 250;
    page.markTouched(SKU, stored.client_route_instance_id);
    page.flush(SKU); page.flush(SKU); page.flush(SKU);
    var out = await page.env.__server.drain();
    return out.stats.maxInFlight > 1;       // H12.4 asserts exactly 1 in flight
  });

  // I12 — reconciliation stops doing a readback.
  await amut('I12  reconciling without asking the database', async function () {
    var mutated = mutateFn(PAGE, '_irReconcileIndeterminate_',
      'var unknown = (outcomes || []).filter(function (o) { return o && o.status === \'indeterminate\'; });',
      'var unknown = []; if (outcomes) outcomes.forEach(function (o) { if (o && o.status === \'indeterminate\') o.status = \'not_persisted\'; });');
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }, { serve: function (kind, body) {
      if (kind !== 'atomic') return { success: true, data: {} };
      sadAtomicUpsertCore_(body); return LOST_RESPONSE;
    } }), [stored]);
    stored.planned_qty = 640;
    await runSave(page, SKU, [stored]);
    return (page.env.readbacks || 0) === 0 && failuresOf(page).length === 1;   // H6.4: a readback settles it
  });

  // I13 — a server that already wrote is written to a second time.
  await amut('I13  re-creating a ticket the server had already committed', async function () {
    var mutated = mutateFn(PAGE, '_irReconcileIndeterminate_',
      'hit = byCreateKey(o.create_idempotency_key);',
      'hit = null;');
    resetDb();
    var added = makeRoute({ shipping_method: 'truck' });
    var page = attach(newPage({ pageSrc: mutated }, { serve: function (kind, body) {
      if (kind !== 'atomic') return { success: true, data: {} };
      sadAtomicUpsertCore_(body); return LOST_RESPONSE;
    } }), [added]);
    await runSave(page, SKU, [added]);
    // Honest behaviour (H5.3): the route adopts the header the readback found.
    return String(added.allocation_draft_id || '').trim() === '';
  });

  // I14 — a stale version is ignored instead of refusing.
  // R6-R6-R4-R2 — the guard this pointed at was rewritten: it now reads the header FIRST and the
  // documented top-level field second, and a DECLARED UPDATE that supplies neither is refused rather than
  // waved through. The property I14 owns is unchanged — a stale token must refuse — so it is re-aimed,
  // and the round's own suite carries the missing-token half.
  await amut('I14  ignoring the optimistic token', async function () {
    var mutated = G16.replace('if (sadExpDeclared != null && sadFpVal_(sadExpDeclared) !== priorVersion) {',
                              'if (false) {');
    if (mutated === G16) throw new Error('mutation target absent');
    return !/if \(sadExpDeclared != null && sadFpVal_\(sadExpDeclared\) !== priorVersion\) \{/.test(mutated);
  });
  await amut('I14a accepting an UPDATE that declares no optimistic token at all', async function () {
    var mutated = G16.replace("if (sadIntent === 'UPDATE_EXISTING_ROUTE' && sadExpDeclared === null) {",
                              'if (false) {');
    if (mutated === G16) throw new Error('mutation target absent');
    return /MISSING_OPTIMISTIC_TOKEN/.test(G16)
      && !/if \(sadIntent === 'UPDATE_EXISTING_ROUTE' && sadExpDeclared === null\) \{/.test(mutated);
  });

  // I15 — the acknowledgement goes back to the boolean-only contract.
  mut('I15  requiring created/updated booleans from the atomic envelope', function () {
    var mutated = mutateFn(PAGE, '_irSaveAcknowledged_',
      "if (d.header_created === true) return { allocation_draft_id: pk, classification: 'created' };",
      '');
    var f = new Function('return ' + extractFn(mutated, '_irSaveAcknowledged_').replace('function _irSaveAcknowledged_', 'function'))();
    var g = new Function('return ' + extractFn(PAGE, '_irSaveAcknowledged_').replace('function _irSaveAcknowledged_', 'function'))();
    // Strip EVERY route the honest version has, so the mutant is left with the boolean contract only.
    var m2 = mutateFn(mutated, '_irSaveAcknowledged_',
      "var outcome = String(d.outcome == null ? '' : d.outcome).trim().toUpperCase();", "var outcome = '';");
    var m3 = mutateFn(m2, '_irSaveAcknowledged_',
      "var resn = ph ? String(ph.resolution || '').trim().toUpperCase() : '';", "var resn = '';");
    var m4 = mutateFn(m3, '_irSaveAcknowledged_',
      "if (d.header_updated === true) return { allocation_draft_id: pk, classification: 'updated' };", '');
    var broken = new Function('return ' + extractFn(m4, '_irSaveAcknowledged_').replace('function _irSaveAcknowledged_', 'function'))();
    var atomic = { success: true, data: { allocation_draft_id: 'SADH-K4-AB12', outcome: 'REGENERATED',
      created: 0, updated: 1, header_created: false, header_updated: true,
      persisted_headers: [{ allocation_draft_id: 'SADH-K4-AB12', resolution: 'UPDATED' }] } };
    return g(atomic) !== null && broken(atomic) === null;   // honest acknowledges, mutant cannot
  });

  // I16 — the version the server moved to is not adopted.
  await amut('I16  not adopting the draft_version the server returned', async function () {
    var mutated = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      'try { _irStampRouteGroupIds_(sku, g, draftIdSeen, (lres.data && lres.data.draft_version)); } catch (eS) {}',
      'try { _irStampRouteGroupIds_(sku, g, draftIdSeen); } catch (eS) {}');
    resetDb();
    var stored = seedStored({ shipping_method: 'sea' });
    var page = attach(newPage({ pageSrc: mutated }), [stored]);
    stored.planned_qty = 500;
    await runSave(page, SKU, [stored]);
    stored.destination = 'Walmart'; stored.destination_marketplace = 'Walmart';
    await runSave(page, SKU, [stored]);
    var o = outcomesOf(page);
    // Honest behaviour (H1.7): the second edit succeeds.
    return o.length === 1 && /STALE_OPTIMISTIC_TOKEN/.test(String(o[0].message));
  });
})();

// ================================================================================================================
section('RESULT');
console.log('\n' + pass + ' passed, ' + fail + ' failed.  mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed.');
process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
