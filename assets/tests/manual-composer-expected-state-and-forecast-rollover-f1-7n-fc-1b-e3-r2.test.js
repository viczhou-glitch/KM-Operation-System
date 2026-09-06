// ================================================================================================================
// F1-7N-FC-1B-E3-R2 — MANUAL COMPOSER EXPECTED-STATE UX + FORECAST YEAR-ROLLOVER READINESS
// ----------------------------------------------------------------------------------------------------------------
// TWO SUBJECTS, AND THE FIRST ONE WAS NOT WHERE IT LOOKED.
//
// §A/§B/§D — AN UNFINISHED EDIT WAS RENDERED AS A DATABASE FAILURE, AND THE RENDERER WAS THE DEFECT. Measured by
//   driving the shipped `_flushDraftDbPersist`: a composer holding only From and To issues ZERO requests and
//   performs ZERO writes, and produces the full red panel — "Unsaved — database update failed. This route was NOT
//   saved to the database.", plus Reason, Technical details and "Retryable: yes". Every word of it is false
//   except "not saved", and "not saved" is not the operator's question, because nothing was attempted.
//
//   The chain, all of it shipped code: onExecutionRouteEdit → _saveAllocationDraftFromDom (which deliberately
//   does NOT mark a composer touched, since a composer has nothing to update and nothing to create) →
//   _scheduleDraftDbPersist → _flushDraftDbPersist, where `_touched` is therefore EMPTY, the empty-set fallback
//   widens the write scope to EVERY row on screen, and the row excluded upstream comes back downstream and lands
//   in `_incomplete`. The layer that misclassified it is `_irShowDraftSaveError`: ONE renderer for the row-local
//   surface, with no state dimension, opening with a fixed failure lede for whatever envelope it is handed.
//   The information needed to render it correctly was already IN the envelope (`zeroWrite: 'true'`).
//
//   THE OPPOSITE ERROR WAS ALSO LIVE, in the same function: the very same composer, sitting beside a route the
//   operator HAD edited, was filtered out of scope and then said NOTHING AT ALL. One row, two contradictory
//   answers, decided by an unrelated row.
//
// §C — SUBMIT IS NOT RELAXED, and this is checked by executing the shipped preflight rather than by reading it.
//
// §E — the first inventory read's 60s timeout is classified, NOT guessed at, over samples the transport already
//   records. No bound changed, no retry count changed, nothing cached presented as fresh.
//
// §F/§G/§H — THE FORECAST YEAR-ROLLOVER GAP. §G is answered by the production writers: one row per
//   scope+SKU+year IS the business key, and Jan–Dec = 0 IS the base-row initialisation (04_
//   handleImportMarketplaceSkusBatch_ writes it). So the migration is authorised — and it writes nothing itself,
//   delegating to the router-registered `importFcRegularForecastBatch` action for identity and validation.
//
// Run: node assets/tests/manual-composer-expected-state-and-forecast-rollover-f1-7n-fc-1b-e3-r2.test.js
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
// Comments AND string literals removed. A keyword sweep that cannot tell a CALL from a SENTENCE has produced a
// false answer four times in this feature's history — most recently a census whose header enumerated the write
// calls it does not make.
function ops(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
function code(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); }

var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CSS = read('assets/css/pages/inventory-replenishment.css');
var CMPSRC = read('assets/js/utils/inventory-compat.js');
var CMP = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js'));
var UI = CMP.IRRouteUiState;
var PF = CMP.IRSubmitPreflight;
var TD = CMP.IRReadTimeoutDiagnostic;
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var INDEX = read('index.html');
var CFG = read('assets/specs/active/apps-script/00_config.gs');
var HLTH = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var IMPORT04 = read('assets/specs/active/apps-script/04_marketplace_forecast_import.gs');
var ROUTER = read('assets/specs/active/apps-script/01_router.gs');
var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_FC_FORECAST_YEAR_ROLLOVER_CENSUS_FC1B_E3_R2.gs');
var ROLL = read('assets/tools/apps-script-diagnostics/TEMP_FC_REGULAR_FORECAST_YEAR_ROLLOVER_2027.gs');
// The module exports the frozen window function at its TOP LEVEL, not under a KMPCX key. The census reads it
// as `KMPCX._forecastWeightMonths`, which is how it is named inside Apps Script, so the sandbox binds the
// module's own export under that name rather than inventing a second window implementation.
var KMPCX = require(path.join(ROOT, 'assets/js/core/supply-planning-planning-context.js'));

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  var i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
function extractVar(src, name) {
  var s = src.indexOf('var ' + name + ' =');
  if (s < 0) throw new Error('var not found: ' + name);
  var d = 0;
  for (var i = s; i < src.length; i++) {
    var c = src[i];
    if (c === '{' || c === '[' || c === '(') d++;
    else if (c === '}' || c === ']' || c === ')') d--;
    else if (c === ';' && d === 0) return src.slice(s, i + 1);
  }
  throw new Error('unterminated var: ' + name);
}
// The page is CRLF and this file is LF, so a literal multi-line anchor never matches without this. A missing
// anchor THROWS, so a mutation that has silently stopped applying is a loud PROBE ERROR, never a survivor.
function swap(src, find, repl) {
  var re = new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'));
  if (!re.test(src)) throw new Error('swap anchor not found: ' + String(find).slice(0, 90));
  return String(src).replace(re, repl);
}

var SKU = 'CO1100-R';
var CYCLE = 'RECO-2026-09';

// ================================================================================================================
// THE HARNESS — the SHIPPED flush, run for real, with the DB calls counted.
// ----------------------------------------------------------------------------------------------------------------
// Everything under test is the page's own source, extracted and executed: the flush, the completeness gate, the
// missing-field owner, the incomplete notice, BOTH renderers and the state classifier. The stubs are the things
// this round does not claim anything about (the atomic writer, the group pre-flight's callers, the cancel
// dispatch) and each one RECORDS its call, which is how "zero writes" is a measurement and not a belief.
// ================================================================================================================
function mkEl(tag) {
  var el = { tagName: tag || 'div', attributes: {}, children: [], style: {}, innerHTML: '', parentNode: null, className: '' };
  el.getAttribute = function (k) { return this.attributes[k] == null ? null : this.attributes[k]; };
  el.setAttribute = function (k, v) { this.attributes[k] = String(v); };
  el.removeAttribute = function (k) { delete this.attributes[k]; };
  el.hasAttribute = function (k) { return this.attributes[k] != null; };
  el.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  el.removeChild = function (c) { var i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; };
  el.querySelectorAll = function (sel) {
    var out = [];
    (function walk(n) { n.children.forEach(function (c) { if (elMatch(c, sel)) out.push(c); walk(c); }); })(this);
    return out;
  };
  return el;
}
function elMatch(el, sel) {
  sel = String(sel).trim();
  if (sel.charAt(0) === '[') { var k = sel.slice(1, -1).split('=')[0]; return el.attributes[k] != null; }
  if (sel.charAt(0) === '.') { return (' ' + (el.className || '') + ' ').indexOf(' ' + sel.slice(1) + ' ') !== -1; }
  return false;
}
function harness(opts) {
  opts = opts || {};
  var byId = {};
  var sb = { console: { warn: function () {}, log: function () {}, error: function () {} },
    Promise: Promise, Date: Date, Number: Number, String: String, Object: Object, Array: Array,
    JSON: JSON, Math: Math, isFinite: isFinite, setTimeout: setTimeout, clearTimeout: clearTimeout, Error: Error };
  sb.window = sb; sb.globalThis = sb;
  sb.document = { getElementById: function (id) { return byId[id] || null; } };
  sb.__calls = []; sb.__unsaved = {};
  sb.KM = { shippingAllocationDraft: null, DB: {
    upsertShippingAllocationDraftAtomic: function (p) { sb.__calls.push({ fn: 'atomic', p: p });
      return Promise.resolve({ success: true, data: { allocation_draft_id: 'SADH-X', version: 2, lines: [] } }); },
    upsertShippingAllocationDraftLines: function (p) { sb.__calls.push({ fn: 'lines', p: p }); return Promise.resolve({ success: true, data: {} }); },
    getShippingAllocationDraftWorkspace: function (p) { sb.__calls.push({ fn: 'workspace', p: p }); return Promise.resolve({ success: true, data: { drafts: [] } }); } } };
  sb.IRDraft = CMP.IRDraft; sb.IRWarehouse = CMP.IRWarehouse; sb.IRRouteProvenance = CMP.IRRouteProvenance;
  sb.IRRouteComposer = CMP.IRRouteComposer; sb.IRRouteUiState = CMP.IRRouteUiState;
  sb.isOperationDbApiConfigured = function () { return true; };
  sb._replenCtx = function () { return { company: 'ResUS', country: 'US', marketplace: 'Amazon' }; };
  sb._persistAllocationDraft = function () {};
  sb._allocWorkspaceScope = function () { return {}; };
  sb._irRouteLabel_ = function (g) { var r = (g && g.routes && g.routes[0]) || {}; return String(r.source_warehouse_id || '?') + ' -> ' + String(r.destination_warehouse_id || r.destination_marketplace || '?'); };
  sb._irConfirmLegacyAdoption_ = function () { return true; };
  sb._irAdoptionGroupsNeedingConfirmation_ = function () { return []; };
  sb._irQueueStaleGroupCancels_ = function () {};
  sb._irDispatchLineCancels_ = function (sku, c) { if (c && c.length) sb.__calls.push({ fn: 'lineCancels', n: c.length }); };
  sb._irCancelUnusedDraftHeaders_ = function () { sb.__calls.push({ fn: 'cancelUnusedHeaders' }); };
  sb._irSaveBusySync_ = function () {};
  sb._irRouteGroupConflictEnvelope_ = function () { var e = new Error('ROUTE_GROUP'); e.structured = { code: 'ROUTE_GROUP_CONFLICT', reasonCode: 'ROUTE_GROUP_CONFLICT', message: 'conflict' }; return e; };
  sb._irMultiRouteOutcomeEnvelope_ = function () { var e = new Error('OUT'); e.structured = { code: 'SAVE_FAILED', reasonCode: 'SAVE_FAILED', message: 'one or more routes did not persist' }; return e; };
  sb._irMultiLineHeaderBlock_ = function () { return null; };
  sb._irMarkRouteUnsaved_ = function (sku, err) { sb.__unsaved[sku] = (err && err.structured) || {}; };
  sb._irClearRouteUnsaved_ = function (sku) { delete sb.__unsaved[sku]; };
  sb._irPersistOneRouteGroup_ = function (sku, ctx, g) {
    return sb.KM.DB.upsertShippingAllocationDraftAtomic({ sku: sku, group: g.groupKey }).then(function () {
      return { status: (opts.groupStatus || function () { return 'persisted'; })(),
        instanceIds: (g.routes || []).map(function (r) { return String(r.client_route_instance_id || ''); }),
        groupKey: g.groupKey };
    });
  };
  var ctx = vm.createContext(sb);
  vm.runInContext([
    'var _pendingDraftCancels={},_draftDbInFlight={},_draftDbDirty={},_draftDbTimers={},_draftDbTouched={};',
    'var replenAllocationDraft={bySku:{}};',
    'function _scheduleDraftDbPersist(s){}',
    'function _irReconcileIndeterminate_(sku,o){return Promise.resolve(o);}',
    extractVar(PAGE, 'IR_ROUTE_SAVE_STATES_'),
    extractFn(PAGE, '_irSetRouteSaveState_'),
    extractFn(PAGE, '_isRouteComplete'),
    extractFn(PAGE, '_irMissingRouteFields_'),
    extractFn(PAGE, '_irIncompleteRouteNotice_'),
    extractVar(PAGE, 'IR_DRAFT_TYPED_REASONS_'),
    extractFn(PAGE, '_irTypedReasonCode_'),
    extractFn(PAGE, '_irReasonIsPreWrite_'),
    extractFn(PAGE, '_irReasonRetryable_'),
    extractFn(PAGE, '_irReasonNextAction_'),
    extractFn(PAGE, '_irShowDraftSaveError'),
    extractFn(PAGE, '_irHideDraftSaveError'),
    extractFn(PAGE, '_irComposerKind_'),
    extractFn(PAGE, '_irIsComposerRow_'),
    extractFn(PAGE, '_irRouteUiState_'),
    extractFn(PAGE, '_irRouteUiStateIsFailure_'),
    extractFn(PAGE, '_irRouteHintSentence_'),
    extractFn(PAGE, '_irShowRouteStateHint_'),
    extractFn(PAGE, '_irHideRouteStateHint_'),
    extractFn(PAGE, '_irTouchedInstances_'),
    // R6-R6 §7 — the ACK_UNKNOWN hold is part of the write scope this suite executes.
    extractFn(PAGE, '_irAckStore_'),
    extractFn(PAGE, '_irAckUnknownIsHeld_'),
    extractFn(PAGE, '_irHoldAckUnknown_'),
    extractFn(PAGE, '_irClearAckUnknown_'),
    extractFn(PAGE, '_irReleaseAckUnknown_'),
    extractFn(PAGE, '_flushDraftDbPersist')
  ].join('\n'), ctx);
  var errEl = mkEl('div'), hintEl = mkEl('div');
  byId['allocation-carton-error-' + SKU] = errEl;
  byId['allocation-route-hint-' + SKU] = hintEl;
  byId['shipping-methods-' + SKU] = mkEl('div');
  // Whether the panel was EVER red matters as much as its final text: a flash is what the operator sees.
  var everRed = { v: false }, held = '';
  Object.defineProperty(errEl, 'innerHTML', {
    get: function () { return held; },
    set: function (x) { held = x; if (String(x).indexOf('database update failed') !== -1) everRed.v = true; }
  });
  return { sb: sb, err: errEl, hint: hintEl, everRed: everRed,
    run: function (e) { return vm.runInContext(e, ctx); } };
}
function route(o) {
  var r = { client_route_instance_id: o.id, sku: SKU, source_warehouse_id: o.from || '',
    destination_warehouse_id: o.to || '', destination_marketplace: o.mkt || '',
    planned_qty: o.qty == null ? '' : o.qty, qty: o.qty == null ? '' : o.qty,
    shipping_method: o.method || '', allocation_draft_id: o.draft || '', allocation_draft_line_id: o.line || '',
    route_intent: o.draft ? 'UPDATE_EXISTING' : 'CREATE_NEW_ROUTE', window_code: 'W1', site_sku: SKU };
  if (o.composer) { r.route_kind = 'MANUAL_COMPOSER'; r.composer_touched = o.touched !== false; r.route_incomplete = true; }
  return r;
}
// Drive the SHIPPED flush and report what the operator would see and what the database would receive.
function flush(rows, touched, opts) {
  var h = harness(opts || {});
  h.sb.__rows = rows; h.sb.__touched = touched || [];
  h.run('replenAllocationDraft.bySku["' + SKU + '"] = __rows;');
  h.run('_draftDbTouched["' + SKU + '"] = {}; __touched.forEach(function(k){ _draftDbTouched["' + SKU + '"][k]=1; });');
  return Promise.resolve(h.run('_flushDraftDbPersist("' + SKU + '")')).then(function () {
    var errHtml = h.err.innerHTML || '';
    return {
      requests: h.sb.__calls.filter(function (c) { return c.fn === 'atomic' || c.fn === 'lines'; }).length,
      writes: h.sb.__calls.filter(function (c) { return c.fn === 'atomic' || c.fn === 'lines' || c.fn === 'lineCancels'; }).length,
      calls: h.sb.__calls.map(function (c) { return c.fn; }),
      redEver: h.everRed.v, redNow: errHtml.indexOf('database update failed') !== -1,
      technicalDetails: errHtml.indexOf('Technical details') !== -1,
      serverMessage: errHtml.indexOf('Server message') !== -1,
      retryableLine: errHtml.indexOf('Retryable') !== -1,
      errColor: h.err.style.color || '',
      hint: h.hint.innerHTML || '', hintShown: h.hint.style.display === 'block',
      unsavedBanner: Object.keys(h.sb.__unsaved),
      states: rows.map(function (r) { return String(r.route_save_state || '-'); })
    };
  });
}

// ================================================================================================================
// §B — THE SEVEN STATES, and only two of them are failures.
// ================================================================================================================
section('§B — the row UI state is derived from the lifecycle, never from a message');

eq(Object.keys(UI.STATES).sort(),
  ['PERSISTED_ROUTE_EDIT_INCOMPLETE', 'PRISTINE_COMPOSER', 'SAVED', 'SAVE_FAILED', 'SAVE_OUTCOME_UNKNOWN',
   'SAVE_PENDING', 'TOUCHED_INCOMPLETE_COMPOSER'],
  'B1  §B the vocabulary is exactly the seven states the spec names');
eq(UI.FAILURE_STATES.slice().sort(), ['SAVE_FAILED', 'SAVE_OUTCOME_UNKNOWN'],
  'B2  §B.4 and ONLY those two may use the red failure surface');
eq(UI.NO_WRITE_STATES.slice().sort(),
  ['PERSISTED_ROUTE_EDIT_INCOMPLETE', 'PRISTINE_COMPOSER', 'TOUCHED_INCOMPLETE_COMPOSER'],
  'B2a and three states are never write candidates');

eq(UI.of({ route_kind: 'MANUAL_COMPOSER' }), 'PRISTINE_COMPOSER', 'B3  an untouched composer is PRISTINE');
eq(UI.of({ route_kind: 'MANUAL_COMPOSER', composer_touched: true, source_warehouse_id: 'TW1', destination_warehouse_id: 'US1' }),
  'TOUCHED_INCOMPLETE_COMPOSER', 'B4  §B.2 one edited field makes it TOUCHED_INCOMPLETE');
eq(UI.of({ source_warehouse_id: 'TW2', destination_warehouse_id: 'US1', qty: 520, shipping_method: '',
  allocation_draft_id: 'SADH-A', allocation_draft_line_id: 'SADL-1' }),
  'PERSISTED_ROUTE_EDIT_INCOMPLETE', 'B5  §B.3 a STORED route mid-edit is its own state, by its stored identity');
eq(UI.of({ source_warehouse_id: 'TW2', destination_warehouse_id: 'US1', qty: 520, shipping_method: '' }),
  'TOUCHED_INCOMPLETE_COMPOSER', 'B5a while a half-typed route the database never held is not');
var DONE = { source_warehouse_id: 'TW1', destination_warehouse_id: 'US1', qty: 5, shipping_method: 'Sea' };
function withState(s, extra) {
  var o = { source_warehouse_id: 'TW1', destination_warehouse_id: 'US1', qty: 5, shipping_method: 'Sea', route_save_state: s };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  return o;
}
eq(UI.of(withState('SAVING')), 'SAVE_PENDING', 'B6  SAVING is SAVE_PENDING');
eq(UI.of(withState('RECONCILING')), 'SAVE_PENDING', 'B6a and so is RECONCILING — the answer is still being fetched');
eq(UI.of(withState('SAVED', { allocation_draft_id: 'A', allocation_draft_line_id: 'L' })), 'SAVED', 'B7  SAVED is SAVED');
eq(UI.of(withState('NOT_SAVED')), 'SAVE_FAILED', 'B8  §B.4 a REFUSED write on a complete route is SAVE_FAILED');
eq(UI.of(withState('OUTCOME_UNKNOWN')), 'SAVE_OUTCOME_UNKNOWN', 'B8a and a lost response is its own state, never SAVED');
// A settled OUTCOME outranks any re-derivation. Otherwise an editor state could hide a real failure.
eq(UI.of({ route_kind: 'MANUAL_COMPOSER', composer_touched: true, source_warehouse_id: 'TW1',
  destination_warehouse_id: 'US1', qty: 5, shipping_method: 'Sea', route_save_state: 'OUTCOME_UNKNOWN' }),
  'SAVE_OUTCOME_UNKNOWN', 'B9  a COMPLETE row with a lost response is a failure state, not a composer state');
// The first version of this probe searched the body for the substrings `failed` and `reason` and tripped on
// `SAVE_FAILED`, which is a STATE NAME. What it means to assert is WHICH ROW FIELDS are read: the classifier
// must decide from the lifecycle alone, because the state is what SELECTS the sentence, so deriving it from a
// sentence would be circular and would break the moment a word changed.
var _b10Fields = {};
code(extractFn(CMPSRC, 'routeUiStateOf')).replace(/row\.([A-Za-z_$][\w$]*)/g, function (_m, f) { _b10Fields[f] = 1; return _m; });
eq(Object.keys(_b10Fields).sort(),
  ['allocation_draft_id', 'allocation_draft_line_id', 'composer_touched', 'route_save_state'],
  'B10 §B the classifier reads ONLY lifecycle fields off the row — no message, no error, no reason text');

// The page carries an INLINE FALLBACK for a failed module load, and a fallback copy of a rule is exactly how
// the completeness gate once shipped two versions of itself with the same defect in both (FB-4G-A0-R2). So the
// fallback is EXECUTED with the module absent and compared against the module, shape by shape. It is allowed
// to be COARSER — it collapses the settled outcomes into SAVE_PENDING — but it must never disagree about
// which rows are composers, which are mid-edit on a stored route, and it must never answer with a FAILURE
// state, because rendering a red database-failure from a guessed state is the defect this round removes.
(function fallbackAgrees() {
  var sbF = { window: {}, console: console, String: String, Number: Number, Object: Object, Array: Array,
    isFinite: isFinite, Boolean: Boolean };
  sbF.window = sbF; sbF.globalThis = sbF;
  var ctxF = vm.createContext(sbF);
  vm.runInContext([
    extractFn(PAGE, '_isRouteComplete'),
    extractFn(PAGE, '_irIsComposerRow_'),
    extractFn(PAGE, '_irRouteUiState_'),
    extractFn(PAGE, '_irRouteUiStateIsFailure_')
  ].join('\n'), ctxF);
  ok(vm.runInContext('typeof window.IRRouteUiState', ctxF) === 'undefined',
    'B11 the fallback is measured with the shared module genuinely ABSENT');
  var shapes = [
    ['pristine composer', { route_kind: 'MANUAL_COMPOSER' }],
    ['touched composer', { route_kind: 'MANUAL_COMPOSER', composer_touched: true, source_warehouse_id: 'TW1' }],
    ['persisted mid-edit', { source_warehouse_id: 'TW2', destination_warehouse_id: 'US1', qty: 520,
      shipping_method: '', allocation_draft_id: 'SADH-A', allocation_draft_line_id: 'SADL-1' }],
    ['half-typed new route', { source_warehouse_id: 'TW2', destination_warehouse_id: 'US1', qty: 520, shipping_method: '' }]
  ];
  shapes.forEach(function (sh, i) {
    sbF.__row = sh[1];
    var got = vm.runInContext('_irRouteUiState_(__row)', ctxF);
    eq(got, UI.of(sh[1]), 'B12.' + (i + 1) + ' the fallback agrees with the module on: ' + sh[0]);
  });
  // The coarser answers, stated rather than left to be discovered.
  sbF.__row = { source_warehouse_id: 'TW1', destination_warehouse_id: 'US1', qty: 5, shipping_method: 'Sea', route_save_state: 'NOT_SAVED' };
  var coarse = vm.runInContext('_irRouteUiState_(__row)', ctxF);
  eq(coarse, 'SAVE_PENDING', 'B13 on a COMPLETE row the fallback answers SAVE_PENDING — deliberately coarser');
  ok(!vm.runInContext('_irRouteUiStateIsFailure_(_irRouteUiState_(__row))', ctxF),
    'B13a and never a FAILURE state: a guessed state must not be able to paint a red database failure');
})();

// ================================================================================================================
// §A — THE SIX STATES DRIVEN THROUGH THE SHIPPED FLUSH.
// ================================================================================================================
section('§A — executed: request count, write count and what the operator is shown');

var A = {};
Promise.resolve()
  .then(function () { return flush([], []); })
  .then(function (r) { A.pristine = r; return flush([route({ id: 'C1', composer: true, from: 'TW1', to: 'US1' })], []); })
  .then(function (r) { A.touched = r; return flush([route({ id: 'R1', from: 'TW1', to: 'US1', qty: 520, method: 'Sea' })], ['R1']); })
  .then(function (r) { A.complete = r; return flush([route({ id: 'E1', from: 'TW2', to: 'US1', qty: 520, method: '', draft: 'SADH-K4-BBB', line: 'SADL-1' })], ['E1']); })
  .then(function (r) {
    A.persistedEdit = r;
    return flush([route({ id: 'S1', from: 'TW1', to: 'US1', qty: 300, method: 'Sea', draft: 'SADH-A', line: 'SADL-A' }),
                  route({ id: 'C2', composer: true, from: 'TW1', to: 'US1' })], ['S1']);
  })
  .then(function (r) { A.beside = r; return flush([route({ id: 'R2', from: 'TW1', to: 'US1', qty: 520, method: 'Sea' })], ['R2'], { groupStatus: function () { return 'failed'; } }); })
  .then(function (r) { A.failed = r; return flush([route({ id: 'R3', from: 'TW1', to: 'US1', qty: 520, method: 'Sea' })], ['R3'], { groupStatus: function () { return 'indeterminate'; } }); })
  .then(function (r) { A.unknown = r; return flush([route({ id: 'C3', composer: true, from: 'TW1', to: 'US1' }),
                  route({ id: 'C4', composer: true, touched: false })], []); })
  .then(function (r) { A.twoComposers = r; return flush([route({ id: 'C5', composer: true })], []); })
  .then(function (r) { A.barelyTyped = r; return flush([route({ id: 'C6', composer: true, mkt: 'Amazon' })], []); })
  .then(function (r) { A.threeMissing = r; })
  .then(function () { runAssertions(); })
  ['catch'](function (e) { fail++; console.error('FAIL harness threw: ' + (e && e.stack || e)); summary(); });

function runAssertions() {
  // ---- §A.1 PRISTINE ---------------------------------------------------------------------------------------
  eq(A.pristine.requests, 0, 'A1  §A.1 pristine composer: ZERO requests');
  eq(A.pristine.writes, 0, 'A1a and ZERO writes');
  eq(A.pristine.redEver, false, 'A1b and no error at any point');
  eq(A.pristine.hint, '', 'A1c and §B.1 it is furniture: it says nothing at all');

  // ---- §A.2 TOUCHED INCOMPLETE — the reported defect --------------------------------------------------------
  eq(A.touched.requests, 0, 'A2  §A.2 touched incomplete composer: ZERO requests');
  eq(A.touched.writes, 0, 'A2a and ZERO writes');
  eq(A.touched.redEver, false, 'A2b and NEVER "Unsaved — database update failed", not even as a flash');
  eq(A.touched.technicalDetails, false, 'A2c no technical details');
  eq(A.touched.serverMessage, false, 'A2d no "Server message" — no server was asked');
  eq(A.touched.retryableLine, false, 'A2e no "Retryable" row');
  eq(A.touched.errColor, '', 'A2f and the failure surface is not even coloured');
  eq(A.touched.hint, 'Complete Qty and Method to save.', 'A2g §B.2/§D.2 ONE neutral row-local line, naming the fields');
  eq(A.touched.hintShown, true, 'A2h and it is visible');
  eq(A.touched.states, ['INCOMPLETE'], 'A2i §B the row is badged INCOMPLETE, not "Not saved"');

  // ---- §A.3 COMPLETE ---------------------------------------------------------------------------------------
  eq(A.complete.requests, 1, 'A3  §A.3 complete composer: exactly ONE create request');
  eq(A.complete.redEver, false, 'A3a with no error');
  eq(A.complete.hint, '', 'A3b and no hint — there is nothing left to complete');
  eq(A.complete.states, ['SAVED'], 'A3c and the row settles as SAVED');

  // ---- §A.4 PERSISTED ROUTE MOMENTARILY INCOMPLETE ---------------------------------------------------------
  eq(A.persistedEdit.requests, 0, 'A4  §A.4 persisted route mid-edit: ZERO requests (§F.4 — never an incomplete UPDATE)');
  eq(A.persistedEdit.writes, 0, 'A4a and ZERO writes, so the DB keeps its last complete version');
  eq(A.persistedEdit.redEver, false, 'A4b and it is NOT called a database failure');
  eq(A.persistedEdit.hint, 'Complete Method to save. The saved version is unchanged.',
    'A4c §B.3 the neutral line, and it says the stored version is intact');
  eq(A.persistedEdit.calls.indexOf('lineCancels'), -1, 'A4d nothing is cancelled');
  eq(A.persistedEdit.states, ['INCOMPLETE'], 'A4e badged INCOMPLETE');

  // ---- the OPPOSITE error, which was equally live -----------------------------------------------------------
  eq(A.beside.requests, 1, 'A6  a touched composer beside a real edit does not stop that route saving (§B.1)');
  eq(A.beside.hint, 'Complete Qty and Method to save.',
    'A6a and the composer SPEAKS — before R2 the same row was silent when another row was touched');
  eq(A.beside.states, ['SAVED', 'INCOMPLETE'], 'A6b one row\'s outcome never describes the other\'s');

  // ---- §A.5 A REAL FAILURE KEEPS EVERYTHING ---------------------------------------------------------------
  eq(A.failed.redEver, true, 'A5  §A.5/§D.5 a REFUSED write still shows the red panel');
  eq(A.failed.technicalDetails, true, 'A5a with its technical details');
  eq(A.failed.retryableLine, true, 'A5b and its retryability');
  eq(A.failed.errColor, '#dc2626', 'A5c in red');
  eq(A.failed.unsavedBanner, [SKU], 'A5d and it reaches the cross-SKU unsaved banner');
  eq(A.failed.hint, '', 'A5e while the neutral surface stays silent: this is not an unfinished edit');
  eq(A.failed.states, ['NOT_SAVED'], 'A5f the row is badged with the OUTCOME it actually got');
  eq(A.unknown.redEver, true, 'A5g §B.4 a LOST response also keeps the red surface');
  eq(A.unknown.states, ['OUTCOME_UNKNOWN'], 'A5h and is distinguished from a refusal, never reported as SAVED');

  // ---- two composers, one pristine -------------------------------------------------------------------------
  eq(A.twoComposers.requests, 0, 'A7  two composers, neither complete: ZERO requests');
  eq(A.twoComposers.states, ['INCOMPLETE', '-'],
    'A7a only the TOUCHED one is badged — a pristine composer is left entirely alone');
  eq(A.barelyTyped.hint, 'Complete From, To, Qty and Method to save.',
    'A7b an empty touched composer lists all four readably — "From and To and Qty and Method" is not English');
  eq(A.barelyTyped.requests, 0, 'A7c and still issues nothing');
  // A marketplace destination SATISFIES the To (the destination is an exclusive-or of warehouse and
  // marketplace), so this row is missing three, not four. My first draft of A7b asserted four here and the
  // code was right.
  eq(A.threeMissing.hint, 'Complete From, Qty and Method to save.',
    'A7d and a logical Amazon destination counts as a To — three missing, listed the same way');

  // ==============================================================================================================
  section('§D — the two surfaces, and the door on the red one');
  // ==============================================================================================================
  ok(/allocation-route-hint-/.test(PAGE), 'D1  §D the neutral state has its OWN element, not a shared one');
  ok(/class="ir-route-hint"/.test(PAGE), 'D1a carrying the class the stylesheet declares');
  var showErr = code(extractFn(PAGE, '_irShowDraftSaveError'));
  ok(/severity \|\| ''\) === 'NEUTRAL'/.test(showErr),
    'D2  §D.1 the failure renderer REFUSES a non-failure envelope at the door');
  var gate = showErr.indexOf("=== 'NEUTRAL'");
  var lede = showErr.indexOf('database update failed');
  ok(gate > -1 && lede > -1 && gate < lede,
    'D2a and it refuses BEFORE the failure lede is composed — a guard after the fact is not a guard');
  ok(/_irShowRouteStateHint_\(sku, err\)/.test(showErr),
    'D2b redirecting it to the surface that owns it rather than dropping it (§G.8: never silence)');
  var hintFn = code(extractFn(PAGE, '_irShowRouteStateHint_'));
  ok(!/Technical details|<details|Retryable|Server message|Transport code|Affected table|Request:/.test(hintFn),
    'D3  §D.2 the neutral renderer offers NO technical disclosure of any kind');
  ok(!/#dc2626|#EF4444|color/.test(hintFn),
    'D3a and sets no colour: the stylesheet owns it, so it cannot be quietly turned red inline');
  ok(/style\.color = ''/.test(code(extractFn(PAGE, '_irHideDraftSaveError'))),
    'D4  clearing the failure surface clears its COLOUR too — emptying innerHTML left it red');
  // §D.3 — the hint sits outside the six-column grid, so it cannot disturb the layout E3 §B closed.
  ok(/\.ir-route-hint\s*\{/.test(CSS), 'D5  §D.2 the stylesheet declares .ir-route-hint');
  var hintRule = /\.ir-route-hint\s*\{([^}]*)\}/.exec(CSS)[1];
  ok(/background:\s*#FFFBEB/i.test(hintRule) && /color:\s*#92400E/i.test(hintRule),
    'D5a amber, NOT the error red this page reserves for a refused or lost write');
  ok(!/#dc2626|#EF4444|#B91C1C/i.test(hintRule), 'D5b and it borrows no red at all');
  ok((CSS.match(/#92400E/g) || []).length >= 2 && (CSS.match(/#FFFBEB/g) || []).length >= 2,
    'D5e and the amber is the page\'s EXISTING blocked/config pair, not a fourth colour invented for one line');
  ok(/white-space:\s*nowrap/.test(hintRule) && /overflow:\s*hidden/.test(hintRule),
    'D5c ONE line, bounded, so a longer sentence can never reopen the row-height work');
  ok(!/ir-exec-plan__grid/.test(/\.ir-route-hint[\s\S]{0,400}/.exec(CSS)[0]),
    'D5d §D.3 and it is not scoped into the six-column grid');
  // §D.4 — the long helper prose E3 removed is not creeping back in through the hint.
  ok(!/Nothing is saved until all four are set|use AI Plan \/ \+ Add Route/.test(PAGE),
    'D6  §D.4 the helper essay E3 removed is still gone, and the hint did not become its replacement');
  ok((/Complete Qty and Method to save\./.test(PAGE) || /Complete this route to save\./.test(PAGE)),
    'D6a the neutral sentence is the short one the spec wrote');

  // ==============================================================================================================
  section('§A — the mechanism, named where it lives');
  // ==============================================================================================================
  var flushFn = code(extractFn(PAGE, '_flushDraftDbPersist'));
  ok(/\.filter\(function \(r\) \{ return !\(_irIsComposerRow_\(r\) && !_isRouteComplete\(r\)\); \}\)/.test(flushFn),
    'A8  a composer is filtered out of the write scope');
  // R6-R6-R2 §3 — A8a ASSERTED THE FALLBACK IS KEPT, AND IT IS NOT. An empty touched set used to widen the
  // scope to every row on screen, which is how one gesture on Route A wrote Route B on 2026-09-06. The
  // composer guarantee this section is about did not weaken when it went; it got SHORTER. There is one
  // branch, so 'a composer never enters the write scope' no longer needs the words 'in both branches'.
  ok(!/\?\s*rows\)\.filter/.test(flushFn) && !/: rows\)/.test(flushFn),
    'A8a and the empty-touched-set fallback is GONE — no dirty intent means zero mutation requests');
  ok(/var _scoped = rows\s*\.filter\(function \(r\) \{ return _touchedSet\[/.test(flushFn),
    'A8b the scope is the touched set and nothing else');
  // The legacy caller still writes what it always wrote, by SAYING so rather than by leaving a set empty.
  var legacyFn = code(extractFn(PAGE, '_persistAllocationDraftToDb'));
  ok(/_irMarkRouteTouched_/.test(legacyFn) && /_isRouteComplete/.test(legacyFn),
    'A8c and _persistAllocationDraftToDb DECLARES its scope instead of relying on the absence of one');
  ok(/_hintRows/.test(flushFn) && /composer_touched === true/.test(flushFn),
    'A9  §B.2 a touched composer is hinted from the WHOLE row set, not from the write scope');
  ok(flushFn.indexOf('_irShowDraftSaveError(sku, _irIncompleteRouteNotice_') === -1,
    'A10 and the incomplete notice no longer reaches the failure renderer from here');
  eq((code(PAGE).match(/severity: 'NEUTRAL'/g) || []).length, 1,
    'A11 exactly ONE envelope declares itself non-failing — the incomplete-route notice');

  // ==============================================================================================================
  section('§C — Submit is not relaxed (the SHIPPED preflight, executed)');
  // ==============================================================================================================
  function snap(rows, extra) {
    var o = { scope: { company: 'ResUS', country: 'US', marketplace: 'Amazon' }, appliedScopeKey: 'resus|us|amazon',
      pendingWrites: [], inFlightWrites: [], dirtyAfterWrite: [], pendingCancels: [], saveFailed: [],
      panels: [{ sku: SKU, execState: 'READY' }], routesMissingDestination: [], duplicateCorruption: [],
      aiPlanUnreconciled: '', zeroLineHeaderCount: 0,
      routes: rows.map(function (r) {
        var c = CMP.IRDraft.isRouteComplete(r);
        return { sku: SKU, scopeKey: 'resus|us|amazon',
          route_provenance: r.route_kind ? '' : 'USER_EXPLICIT_ADD_ROUTE',
          route_kind: String(r.route_kind || ''), composer_touched: r.composer_touched === true,
          allocation_draft_id: String(r.allocation_draft_id || ''), allocation_draft_line_id: String(r.allocation_draft_line_id || ''),
          qty: r.qty, complete: c, missingFields: c ? [] : ['Method'], methodConfigurationMissing: false,
          routeLabel: 'TW1 -> US1', shipping_method: String(r.shipping_method || ''),
          destination_type: 'WAREHOUSE', destination_code: String(r.destination_warehouse_id || ''),
          company: 'ResUS', country: 'US', ship_from: String(r.source_warehouse_id || ''),
          source_warehouse_id: String(r.source_warehouse_id || ''),
          destination_warehouse_id: String(r.destination_warehouse_id || ''), destination: String(r.destination_warehouse_id || ''),
          last_mile_delivery: '', planning_cycle: CYCLE, lineCancelled: false, terminal: false };
      }) };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  var SAVED_ROUTE = route({ id: 'S1', from: 'TW1', to: 'US1', qty: 300, method: 'Sea', draft: 'SADH-A', line: 'SADL-A' });
  var c1 = PF.evaluate(snap([route({ id: 'C1', composer: true, from: 'TW1', to: 'US1' })]));
  eq(c1.ok, false, 'C1  §C a touched incomplete composer BLOCKS Submit');
  eq(c1.code, 'EXECUTION_PLAN_COMPOSER_INCOMPLETE', 'C1a with the composer\'s own code, not a route\'s');
  eq(c1.blocking.reasons.map(function (r) { return r.reason; }), ['COMPOSER_INCOMPLETE_MISSING:Method'],
    'C1b naming the route and the missing field');
  var c2 = PF.evaluate(snap([route({ id: 'E1', from: 'TW2', to: 'US1', qty: 520, method: '', draft: 'SADH-A', line: 'SADL-1' })]));
  eq(c2.ok, false, 'C2  §C a persisted route left incomplete BLOCKS Submit');
  eq(c2.code, 'EXECUTION_PLAN_ROUTE_INCOMPLETE', 'C2a and is a ROUTE refusal, distinct from a composer\'s');
  var c3 = PF.evaluate(snap([SAVED_ROUTE, route({ id: 'P1', composer: true, touched: false })]));
  eq(c3.ok, true, 'C3  §C a pristine composer beside a saved route is IGNORED — Submit proceeds');
  var c4 = PF.evaluate(snap([route({ id: 'N1', from: 'TW1', to: 'US1', qty: 300, method: 'Sea' })]));
  eq(c4.ok, false, 'C4  §C a COMPLETE but unsaved route still blocks — R2 did not weaken this');
  eq(c4.code, 'UNSAVED_EXECUTION_PLAN_CHANGES', 'C4a with the unsaved-changes code it always had');
  eq(PF.evaluate(snap([SAVED_ROUTE])).ok, true, 'C5  and a saved complete route alone submits');
  // §C — the DB's older complete version is never substituted for what is on screen.
  ok(/routes:\s*routes/.test(code(PAGE)) || /routes: routes/.test(code(PAGE)),
    'C6  §C the preflight snapshot is built from the ON-SCREEN model, so a stored version cannot be submitted for it');
  eq(PF.FORBIDDEN_CONFIRMATION_EXCLUSIONS.indexOf('ROUTE_INCOMPLETE') !== -1, true,
    'C7  §C an incomplete route can never be EXCLUDED past the block by a confirmation');

  // ==============================================================================================================
  section('§E — the read timeout is classified, not guessed');
  // ==============================================================================================================
  function S(code, ms) { return { kind: 'read', action: 'getInventoryReplenishmentWorkspace', code: code || null, ms: ms || 0 }; }
  eq(TD.classify([S('REQUEST_TIMEOUT', 60000), S(null, 9000)], 'getInventoryReplenishmentWorkspace').classification,
    'SUCCESS_AFTER_RETRY', 'E1  §E the LIVE shape — one timeout then a successful retry');
  eq(TD.classify([S('REQUEST_TIMEOUT', 60000)], 'getInventoryReplenishmentWorkspace').classification,
    'COLD_START_OR_TRANSIENT_TIMEOUT', 'E2  §E one timeout with no recovery yet');
  eq(TD.classify([S('REQUEST_TIMEOUT', 60000), S('REQUEST_TIMEOUT', 60000)], 'getInventoryReplenishmentWorkspace').classification,
    'REPEATED_READ_TIMEOUT', 'E3  §E two timeouts is a different problem with a different owner');
  eq(TD.classify([S('AUTH_OR_ACCESS_HTML', 400)], 'getInventoryReplenishmentWorkspace').classification,
    'SERVER_TYPED_FAILURE', 'E4  §E a typed refusal is NOT slowness, and is reported first');
  eq(TD.classify([S('AUTH_OR_ACCESS_HTML', 400), S('REQUEST_TIMEOUT', 60000)], 'getInventoryReplenishmentWorkspace').classification,
    'SERVER_TYPED_FAILURE', 'E4a even alongside a timeout — waiting out a real fault is the failure to avoid');
  eq(TD.classify([S(null, 5000)], 'getInventoryReplenishmentWorkspace').classification, 'NO_TIMEOUT_OBSERVED',
    'E5  and a clean read is not a diagnosis looking for a cause');
  eq(TD.classify([S('REQUEST_TIMEOUT', 60000), { kind: 'write', action: 'x', code: 'REQUEST_TIMEOUT' }], null).timeouts, 1,
    'E6  §E only READ samples are counted — a write timeout is a different question');
  // §E — nothing about the request path moved.
  var API = read('assets/js/api/operation-system-db-api.js');
  ok(/KM_READ_TIMEOUT_MS_\s*=\s*60000/.test(API) || /KM_READ_TIMEOUT_MS_/.test(API),
    'E7  §E the read bound is untouched (no timeout value was raised)');
  ok(!/IRReadTimeoutDiagnostic/.test(API), 'E7a and the diagnostic is not wired into the request path at all');
  ok(/metrics\(\)|recordExternal/.test(read('assets/js/api/km-transport.js')),
    'E8  §E it reads samples the transport ALREADY records — no new collection was added');
  ok(!/cache|stale|fallback/i.test(code(extractFn(CMPSRC, 'classifyReadTimeouts'))),
    'E9  §E and it never presents anything cached as a fresh answer');
  // A diagnostic with no caller is debt, not a diagnostic — this repository already carries two such entries
  // on its STOP list, so the reporter exists and is reachable.
  var diagFn = code(extractFn(PAGE, '_irReadTimeoutDiagnosis_'));
  ok(/window\._irReadTimeoutDiagnosis_ = _irReadTimeoutDiagnosis_;/.test(PAGE),
    'E10 §E the classifier HAS a caller on the page and is reachable by name');
  ok(/KM\.transport\.metrics\(\)/.test(diagFn) && /IRReadTimeoutDiagnostic\.classify/.test(diagFn),
    'E10a which hands the transport\'s OWN bounded samples to the pure classifier');
  ok(/TRANSPORT_METRICS_UNAVAILABLE/.test(diagFn) && /CLASSIFIER_UNAVAILABLE/.test(diagFn),
    'E10b and names the two ways it can have no answer rather than returning a misleading one');
  ok(!/setTimeout|fetch|KM\.DB|retry/i.test(diagFn),
    'E10c it issues no request and touches no retry — it is an observation, nothing more');

  // ==============================================================================================================
  section('§G — the year-row contract, proven from the PRODUCTION writers');
  // ==============================================================================================================
  // The Add-SKU BATCH IMPORT is the writer that creates a forecast base row (router action
  // `importMarketplaceSkusBatch`). Naming it correctly matters: the whole §G argument is "this is what the
  // production writer does", so a probe pointed at a function that does not exist would prove nothing while
  // looking like it proved everything. My first draft cited a name that is not in the file.
  var addSku = code(extractFn(IMPORT04, 'handleImportMarketplaceSkusBatch_'));
  ok(/\[currentYear, company, country, marketplace, sku\]\.join\('\|'\)/.test(addSku),
    'G1  §G.1 one row per scope + SKU + YEAR is the business key the Add-SKU writer guards on');
  ok(/action === 'importMarketplaceSkusBatch'/.test(code(ROUTER)),
    'G1a and that writer is router-registered too, so the base-row contract is a contract');
  ok(/for \(var m = 0; m < months\.length; m\+\+\) \{[\s\S]{0,120}= 0;/.test(addSku),
    'G2  §G.2 Jan–Dec = 0 IS the base-row initialisation, written by the production writer');
  ok(/total_fc'\)\] = 0/.test(addSku), 'G2a and total_fc = 0 with it');
  ok(/fc_share'\)\] = ''/.test(addSku), 'G2b while fc_share is deliberately left BLANK, not zero');
  ok(/'FC-' \+ currentYear \+ '-' \+ Utilities\.getUuid\(\)/.test(addSku),
    'G3  §G.3 identity is FC-{year}-{uuid8}, minted by the writer');
  ok(/if \(!fcKeys\[fk\]\)/.test(addSku), 'G4  §G.4 a duplicate guard on that same key already exists');
  ok(/source'\)\] = 'system_auto'/.test(addSku) && /created_at/.test(addSku) && /updated_at/.test(addSku),
    'G5  §G.5 source and both timestamps are columns of record');
  // The OFFICIAL any-year writer, which is why §H needs no new one.
  var batch = code(extractFn(IMPORT04, 'handleImportFcRegularForecastBatch_'));
  ok(/var year = String\(row\.year \|\| ''\)\.trim\(\) \|\| currentYear;/.test(batch),
    'G6  §G an OFFICIAL writer for ANY year already exists — it takes row.year');
  ok(/bk\(year, company, country, marketplace, sku\)/.test(batch), 'G6a keyed on the identical business key');
  ok(/if \(missingHeaders\.length\)/.test(batch), 'G6b header-validated BEFORE any write');
  ok(/action === 'importFcRegularForecastBatch'/.test(code(ROUTER)),
    'G6c and it is router-registered, so it is a contract rather than an internal helper');
  // §G.6 — the harvest reads the forecast LIVE, so no re-materialisation is required.
  var G61 = read('assets/specs/active/apps-script/61_api_v1_weekly_ai_plan.gs');
  ok(/gapReadObjects_\(ss, 'fc_regular_forecast'\)/.test(code(extractFn(G61, 'weeklyAiPlanBuildKmafReceivers_'))),
    'G7  §G.6 the harvest reads fc_regular_forecast LIVE at run time...');
  // RESTATED (F1-7N-FC-1B-E3-R3-R1): named the reader by its identifier, and R3-R1 replaces it with KMFCN —
  // deliberately, because `recoWsRegularForecastByMonth_` discards a CONFLICTING duplicate exactly as it
  // discards a missing row, so the harvest could not tell a year boundary from a data conflict. The property
  // §G.6 protects is that the harvest reads the table LIVE through a SHARED canonical reader (so a new base
  // row takes effect on the next run and no second reading of the table exists), which is still true.
  ok(/KMFCN\.normalizeWindow/.test(code(extractFn(G61, 'weeklyAiPlanBuildKmafReceivers_'))),
    'G7a ...through the SHARED canonical reader, so a new base row takes effect on the next run');

  // ==============================================================================================================
  section('§F — the census: read-only, and the four causes stay four');
  // ==============================================================================================================
  var C = ops(CENSUS);
  var writeCalls = ['appendRow', 'setValue', 'setValues', 'deleteRow', 'deleteRows', 'insertRow', 'clearContent',
    'clear(', 'setNumberFormat', 'SpreadsheetApp.flush', 'DriveApp', 'MailApp', 'ScriptApp.newTrigger',
    'PropertiesService', 'setFormula', 'copyTo', 'insertSheet', 'getRange('];
  eq(writeCalls.filter(function (w) { return C.indexOf(w) !== -1; }), [],
    'F1  §F the census contains NO write call of any kind (swept over code, not prose)');
  ok(!/handleImportFcRegularForecastBatch_/.test(C), 'F1a and never reaches the writer');
  ok(!/KMWRR|KMWRB|weeklyAiPlanGenerateK2_|weeklyAiPlanPersistenceDeps_/.test(C),
    'F1b nor the allocator, the generator or the persistence deps');
  ok(/db_writes: 0/.test(CENSUS), 'F1c and declares db_writes: 0');
  ok(!/new Date\(\)/.test(C), 'F2  §F/§0 NO CLOCK is read — the planning cycle is a required parameter');
  ok(/PLANNING_CYCLE_MALFORMED/.test(CENSUS) && !/planningCycle \|\| .RECO-/.test(C),
    'F2a and there is no "current cycle" default that would make the answer depend on WHEN it ran');
  ok(/KMPCX\._forecastWeightMonths/.test(C),
    'F3  §F the required window comes from the FROZEN owner, so the census cannot disagree with the harvest');
  ok(/FORECAST_WINDOW_OWNER_UNAVAILABLE/.test(CENSUS),
    'F3a and it refuses rather than inventing a window when that owner is absent');
  // EXECUTED — the classification, over a synthetic table that contains all four causes at once.
  (function censusExecuted() {
    var reads = [], writes = 0;
    function sheet(rows) {
      return { getDataRange: function () { reads.push(1); return { getValues: function () { return rows.map(function (r) { return r.slice(); }); } }; },
        appendRow: function () { writes++; throw new Error('WRITE ATTEMPTED'); },
        getRange: function () { writes++; throw new Error('WRITE ATTEMPTED'); },
        setValue: function () { writes++; throw new Error('WRITE ATTEMPTED'); } };
    }
    var MPS = [
      ['marketplace_sku_id', 'company', 'country', 'marketplace', 'sku', 'marketplace_sku_status'],
      ['MS-1', 'ResUS', 'US', 'Amazon', 'CO1100-R', 'active'],   // missing 2027 row entirely
      ['MS-2', 'ResUS', 'US', 'Amazon', 'CO2200-R', 'active'],   // 2027 exists, all months zero -> COMPLETE
      ['MS-3', 'ResUS', 'US', 'Amazon', 'CO3300-R', 'active'],   // 2027 exists, jan blank
      ['MS-4', 'ResUS', 'US', 'Amazon', 'CO4400-R', 'active'],   // 2027 duplicated with DISAGREEING jan
      ['MS-5', 'ResUS', 'US', 'Amazon', 'CO5500-R', 'inactive'], // not counted at all
      ['MS-6', 'ResUS', 'US', 'Amazon', 'CO6600-R', 'active']    // every required month a real number
    ];
    var H = ['forecast_id', 'year', 'company', 'country', 'marketplace', 'sku',
      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    function fc(id, year, sku, oct, nov, dec, jan) {
      var r = new Array(H.length).fill('');
      r[0] = id; r[1] = year; r[2] = 'ResUS'; r[3] = 'US'; r[4] = 'Amazon'; r[5] = sku;
      r[H.indexOf('oct')] = oct; r[H.indexOf('nov')] = nov; r[H.indexOf('dec')] = dec; r[H.indexOf('jan')] = jan;
      return r;
    }
    var FC = [H,
      fc('FC-1', 2026, 'CO1100-R', 300, 300, 300, ''),           // 2026 fine; no 2027 row at all
      fc('FC-2', 2026, 'CO2200-R', 0, 0, 0, ''), fc('FC-2b', 2027, 'CO2200-R', '', '', '', 0),
      fc('FC-3', 2026, 'CO3300-R', 300, 300, 300, ''), fc('FC-3b', 2027, 'CO3300-R', '', '', '', ''),
      fc('FC-4', 2026, 'CO4400-R', 300, 300, 300, ''),
      fc('FC-4b', 2027, 'CO4400-R', '', '', '', 10), fc('FC-4c', 2027, 'CO4400-R', '', '', '', 99),
      fc('FC-5', 2026, 'CO5500-R', 300, 300, 300, ''),
      fc('FC-6', 2026, 'CO6600-R', 100, 100, 100, ''), fc('FC-6b', 2027, 'CO6600-R', '', '', '', 100)
    ];
    var SHEETS = { marketplace_skus: sheet(MPS), fc_regular_forecast: sheet(FC) };
    var logs = [];
    var sandbox = { console: console, Date: Date, Math: Math, JSON: JSON, RegExp: RegExp, String: String,
      Number: Number, Boolean: Boolean, Array: Array, Object: Object, Error: Error, isFinite: isFinite,
      isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
      Logger: { log: function (m) { logs.push(String(m)); } },
      SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return SHEETS[n] || null; } }; } },
      KMPCX: KMPCX };
    sandbox.global = sandbox;
    var ctx = vm.createContext(sandbox);
    vm.runInContext(CENSUS, ctx, { filename: 'TEMP_fc_census.gs' });
    var res = vm.runInContext('RUN_FC_FORECAST_YEAR_ROLLOVER_CENSUS({ planningCycle: "' + CYCLE + '" })', ctx);

    eq(writes, 0, 'F4  EXECUTED: the census performed ZERO writes');
    eq(res.db_writes, 0, 'F4a and reports it');
    ok(reads.length >= 2, 'F4b having actually read both tables (' + reads.length + ' reads)');
    eq(res.required_month, ['2026-10', '2026-11', '2026-12', '2027-01'],
      'F5  §F the required window for ' + CYCLE + ' is M+1..M+4');
    eq(res.required_year, ['2026', '2027'], 'F5a spanning TWO years — which is the whole mechanism of the gap');
    eq(res.total_active_scopes, 5, 'F6  §F five ACTIVE scopes; the inactive one is not counted');
    eq(res.inactive_marketplace_sku_rows, 1, 'F6a and the inactive row is reported separately');
    eq(res.forecast_basis_complete, 2, 'F7  two scopes have a complete basis');
    eq(res.forecast_basis_blocked, 3, 'F7a and three are blocked');
    // The four causes, each counted on its own. §F forbids merging any of them.
    eq(res.missing_year_row_count, 1, 'F8  §F NO_ROW_FOR_YEAR is counted on its own');
    eq(res.blank_month_count, 1, 'F8a CELL_BLANK_OR_NON_NUMERIC on its own');
    eq(res.conflicting_row_count, 1, 'F8b CONFLICTING_VALUES on its own');
    eq(res.explicit_zero_month_count, 4, 'F8c and EXPLICIT_ZERO is never folded into any of them');
    eq(res.per_month_code_totals.OK, 13, 'F8d with the resolved non-zero months counted apart again');
    // The explicit zero SURVIVES — the shipped reader accepts 0 as a truthful forecast.
    ok(res.affected_company_country_marketplace_sku.indexOf('ResUS|US|Amazon|CO2200-R') === -1,
      'F9  §F a scope whose required months are explicit ZEROS is COMPLETE, not blocked');
    ok(res.affected_company_country_marketplace_sku.indexOf('ResUS|US|Amazon|CO1100-R') !== -1,
      'F9a while the scope with no 2027 row at all IS blocked');
    eq(res.affected_company_country_marketplace_sku.length, 3, 'F9b three affected scopes, listed by key');
    var co11 = res.blocked_scopes.filter(function (s) { return s.sku === 'CO1100-R'; })[0];
    eq(co11.per_month.map(function (m) { return m.code; }), ['OK', 'OK', 'OK', 'NO_ROW_FOR_YEAR'],
      'F10 §F per-month codes name WHICH month failed and why — the live evidence\'s exact shape');
    eq(co11.per_month[3].year, '2027', 'F10a and the year the missing row needs');
    ok(/year-rollover gap/.test(co11.suggested_action), 'F10b with a suggested action matched to that cause');
    var co44 = res.blocked_scopes.filter(function (s) { return s.sku === 'CO4400-R'; })[0];
    eq(co44.per_month[3].code, 'CONFLICTING_VALUES', 'F11 two disagreeing rows are a CONFLICT...');
    eq(co44.per_month[3].row_count, 2, 'F11a with both rows counted');
    ok(/STOP/.test(co44.suggested_action), 'F11b ...and its action is STOP: no tool may pick a winner');
    eq(res.verdict, 'STOP', 'F12 §F the census verdict is STOP while any conflict stands');
    eq(res.suggested_action, 'STOP_CONFLICT_MUST_BE_RESOLVED_BY_OWNER', 'F12a and says so');
    ok(logs.filter(function (l) { return /FULL: /.test(l); }).length === 1,
      'F13 §F every exit reports through ONE writer that serialises the whole result');

    // A CLEAN table reaches the complete verdict — the census can actually pass, not only refuse.
    var CLEAN = [H, fc('FC-A', 2026, 'CO6600-R', 100, 100, 100, ''), fc('FC-B', 2027, 'CO6600-R', '', '', '', 100)];
    var ctx2 = vm.createContext((function () {
      var s2 = {}; Object.keys(sandbox).forEach(function (k) { s2[k] = sandbox[k]; });
      s2.SpreadsheetApp = { getActiveSpreadsheet: function () { return { getSheetByName: function (n) {
        return n === 'marketplace_skus' ? sheet([MPS[0], MPS[6]]) : sheet(CLEAN); } }; } };
      s2.global = s2; return s2;
    })());
    vm.runInContext(CENSUS, ctx2, { filename: 'TEMP_fc_census_clean.gs' });
    var clean = vm.runInContext('RUN_FC_FORECAST_YEAR_ROLLOVER_CENSUS({ planningCycle: "' + CYCLE + '" })', ctx2);
    eq(clean.verdict, 'FORECAST_BASIS_COMPLETE', 'F14 §F a covered table reaches FORECAST_BASIS_COMPLETE');
    eq(clean.forecast_basis_blocked, 0, 'F14a with nothing blocked');
    eq(clean.suggested_action, 'NONE', 'F14b and no action to suggest');
    // A missing cycle is refused, and refused with a diagnosis rather than a default.
    var noCycle = vm.runInContext('RUN_FC_FORECAST_YEAR_ROLLOVER_CENSUS({})', ctx2);
    eq(noCycle.verdict, 'STOP', 'F15 §F no planning cycle -> STOP');
    eq(noCycle.blocker, 'PLANNING_CYCLE_MALFORMED', 'F15a named, not silently defaulted to "now"');

    // ============================================================================================================
    section('§H — the migration: DRY RUN by default, official writer, replay-safe');
    // ============================================================================================================
    var R = ops(ROLL);
    eq(writeCalls.filter(function (w) { return R.indexOf(w) !== -1 && w !== 'getRange(' ; }), [],
      'H1  §H the migration performs no direct write of its own');
    ok(/handleImportFcRegularForecastBatch_\(/.test(R),
      'H1a §H every creation goes through the OFFICIAL router-registered writer (identity + validation)');
    ok(!/Utilities\.getUuid|'FC-' \+/.test(R),
      'H1b and it never mints a forecast_id itself — a second identity authority is what put three rows under one key');
    ok(/var TEMP_FCROLL_DRY_RUN = true;/.test(ROLL), 'H2  §H DRY_RUN ships TRUE');
    ok(/TEMP_FCROLL_DRY_RUN === true/.test(R) && /DRY_RUN_MODE_ACTIVE/.test(ROLL),
      'H2a and COMMIT READS it and refuses — the flag is load-bearing, not decorative');
    ok(/function COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW/.test(ROLL),
      'H3  §H COMMIT is a separate, explicitly named entry point');
    ok(/function RUN_FC_2027_ROLLOVER_DRY_RUN\(\)/.test(ROLL),
      'H3a and the zero-argument default entry is the DRY RUN');
    ok(/COMMIT_TOKEN_MISMATCH/.test(ROLL) && /TEMP_FCROLL_planToken_/.test(R),
      'H4  §H COMMIT requires the content token of the exact plan reviewed');
    ok(!/Date\.now|new Date\(\)/.test(code(extractFn(ROLL, 'TEMP_FCROLL_planToken_'))),
      'H4a and the token is derived from the plan CONTENT, never from a clock that would authorise any plan');
    // On the RAW source: `ops()` blanks string literals, so a probe for a literal run against it can only
    // ever fail. This is the check that the tool addresses ONE cause and leaves the other three alone.
    ok(/m\.code !== 'NO_ROW_FOR_YEAR'/.test(ROLL),
      'H5  §H only a COMPLETELY MISSING year row is ever created — a blank month in an existing row is not touched');
    ok(/UNEXPECTED_UPDATE_EXISTING_ROW_MAY_HAVE_BEEN_OVERWRITTEN/.test(ROLL),
      'H6  §H an `updated` result is a HARD failure: the writer is an upsert, so that is data loss');
    ok(/DUPLICATE_BUSINESS_KEY/.test(ROLL) && /CONFLICTS_PRESENT/.test(ROLL),
      'H7  §H a duplicate or conflict STOPS the run');
    ok(/TEMP_FCROLL_verify_/.test(R) && /non_zero_months/.test(ROLL),
      'H8  §H a readback verifies each planned key exists once with all twelve months at zero');
    ok(/sourceDefault: TEMP_FCROLL_SOURCE_/.test(R) && /year_rollover_2027/.test(ROLL),
      'H9  §H every created row is stamped, so an interrupted batch is identifiable');
    ok(/would_create/.test(ROLL) && /skipped_existing/.test(ROLL) && /conflicts/.test(ROLL) && /writes/.test(ROLL),
      'H10 §H the four required output fields are reported');

    // EXECUTED — the DRY RUN over the same synthetic table, and its replay.
    (function rollExecuted() {
      var writerCalls = [];
      function ctxFor(mps, fcRows) {
        var s = {}; Object.keys(sandbox).forEach(function (k) { s[k] = sandbox[k]; });
        s.SpreadsheetApp = { getActiveSpreadsheet: function () { return { getSheetByName: function (n) {
          return n === 'marketplace_skus' ? sheet(mps) : sheet(fcRows); } }; } };
        s.handleImportFcRegularForecastBatch_ = function (b) { writerCalls.push(b); throw new Error('WRITER CALLED IN DRY RUN'); };
        s.global = s;
        var c = vm.createContext(s);
        vm.runInContext(CENSUS, c, { filename: 'census_for_roll.gs' });
        vm.runInContext(ROLL, c, { filename: 'TEMP_roll.gs' });
        return c;
      }
      // A table WITHOUT the conflicting scope, so the plan is reachable; the conflict case is checked after.
      var NO_CONFLICT_MPS = [MPS[0], MPS[1], MPS[2], MPS[3], MPS[6]];
      var NO_CONFLICT_FC = [H,
        fc('FC-1', 2026, 'CO1100-R', 300, 300, 300, ''),
        fc('FC-2', 2026, 'CO2200-R', 0, 0, 0, ''), fc('FC-2b', 2027, 'CO2200-R', '', '', '', 0),
        fc('FC-3', 2026, 'CO3300-R', 300, 300, 300, ''), fc('FC-3b', 2027, 'CO3300-R', '', '', '', ''),
        fc('FC-6', 2026, 'CO6600-R', 100, 100, 100, ''), fc('FC-6b', 2027, 'CO6600-R', '', '', '', 100)];
      var c1 = ctxFor(NO_CONFLICT_MPS, NO_CONFLICT_FC);
      var plan = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', c1);
      eq(writerCalls.length, 0, 'H11 EXECUTED: the DRY RUN called the writer ZERO times');
      eq(plan.writes, 0, 'H11a and reports zero writes');
      eq(plan.dry_run, true, 'H11b as a dry run');
      eq(plan.verdict, 'READY_TO_COMMIT', 'H12 with a committable plan');
      eq(plan.would_create.length, 1, 'H12a would_create holds exactly the ONE missing year row');
      eq(plan.would_create[0].business_key, '2027|ResUS|US|Amazon|CO1100-R', 'H12b named by its business key');
      eq(plan.would_create[0].year, '2027', 'H12c for the required year');
      // The BLANK-month scope is deliberately NOT in the plan: writing a 0 there would invent a forecast.
      eq(plan.would_create.filter(function (w) { return /CO3300-R/.test(w.business_key); }).length, 0,
        'H13 §H a scope whose 2027 row EXISTS with a blank month is NOT in the plan — that value is the owner\'s');
      ok(plan.skipped_existing.length >= 3, 'H13a existing rows are counted as skipped, not rewritten');
      ok(/^FCROLL-1-/.test(plan.commit_token), 'H14 and a content token is printed for review');

      // COMMIT is refused twice over: by the flag, and by a wrong token.
      var refusedFlag = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW("' + plan.commit_token + '", { planningCycle: "' + CYCLE + '" })', c1);
      eq(refusedFlag.verdict, 'STOP', 'H15 §H COMMIT with the CORRECT token is still refused...');
      eq(refusedFlag.blocker, 'DRY_RUN_MODE_ACTIVE', 'H15a ...because DRY_RUN is true, which is how it ships');
      eq(refusedFlag.writes, 0, 'H15b zero writes');
      eq(writerCalls.length, 0, 'H15c and the official writer was never reached');

      // REPLAY: the same plan against a table that already HAS the row -> nothing to do, zero writes.
      var REPLAYED = NO_CONFLICT_FC.concat([fc('FC-NEW', 2027, 'CO1100-R', '', '', '', 0)]);
      var c2 = ctxFor(NO_CONFLICT_MPS, REPLAYED);
      var replay = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', c2);
      eq(replay.verdict, 'NOTHING_TO_DO', 'H16 §H REPLAY: the plan is empty once the row exists');
      eq(replay.would_create.length, 0, 'H16a would_create is empty');
      eq(replay.writes, 0, 'H16b and a replay is ZERO writes — idempotency lives in the re-read');

      // A CONFLICT anywhere in the required scope stops the whole run, before any plan is offered.
      var c3 = ctxFor(MPS, FC);
      var conflicted = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', c3);
      eq(conflicted.verdict, 'STOP', 'H17 §H a conflict in the required scope STOPS the run');
      eq(conflicted.blocker, 'CONFLICTING_FORECAST_ROWS_PRESENT', 'H17a naming the conflict');
      eq(conflicted.would_create.length, 0, 'H17b and offers NO plan at all while it stands');
      eq(conflicted.writes, 0, 'H17c zero writes');
      eq(writerCalls.length, 0, 'H18 across every executed path the official writer was called zero times');
    })();

    // ==========================================================================================================
    section('§C (F1-7N-FC-1B-E3-R2-R3) — 495 ROWS: the writer is NOT atomic, so the RUNNER is what is safe');
    // ==========================================================================================================
    // AUDITED FROM THE PRODUCTION SOURCE. The live plan is 495 rows and the official writer creates them with
    // ONE appendRow PER ROW in a plain loop: no LockService, no try/catch, no flush, and the response is built
    // only after the last row. So it can partially succeed, and a run killed by the Apps Script execution limit
    // returns NOTHING — not a partial answer. The runner has to be the thing that is safe.
    var writerFn = code(extractFn(IMPORT04, 'handleImportFcRegularForecastBatch_'));
    eq((writerFn.match(/appendRow/g) || []).length, 1,
      'C1  §C.3 the official writer appends ONE ROW AT A TIME inside its loop');
    eq(/LockService|getScriptLock/.test(writerFn), false,
      'C1a §C.3 it takes no lock, so it is not serialised against any other writer');
    eq(/try \{/.test(writerFn), false,
      'C1b and has no try/catch: the first throw leaves every earlier row already written');
    // The writer has EARLY error returns (missing headers, missing sheets) that sit before the loop, so the
    // first `return jsonResponse_` is one of those. The claim is about the SUCCESS response, which is the one a
    // killed execution never reaches.
    ok(/var summary = \{ total: rows\.length[\s\S]*?return jsonResponse_\(\{ success: true/.test(writerFn),
      'C1c §C.4 the SUCCESS response is assembled only after the loop — a killed execution reports nothing at all');
    ok(writerFn.lastIndexOf('return jsonResponse_') > writerFn.lastIndexOf('appendRow'),
      'C1d and it is the last statement, after every append');

    // The runner's answer to all of that, read from its own source before it is executed below.
    ok(/var TEMP_FCROLL_BATCH_SIZE_ = \d+;/.test(ROLL), 'C2  §C.11 the batch boundary is a FIXED COUNT');
    ok(/TEMP_FCROLL_TIME_BUDGET_MS_/.test(R) && /stopped = 'TIME_BUDGET_REACHED'/.test(ROLL),
      'C2a and the clock can only stop the run STARTING another batch');
    ok(/o\.remaining_after = \(tail\.would_create \|\| \[\]\)\.length;/.test(ROLL),
      'C2b §C.11 what is LEFT is re-read from the table, never derived from a cursor or from elapsed time');
    ok(/function TEMP_FCROLL_runOneBatch_/.test(ROLL) && /TEMP_FCROLL_buildPlan_\(params\)/.test(code(extractFn(ROLL, 'TEMP_FCROLL_runOneBatch_'))),
      'C3  §C.11 every batch RE-PLANS from a fresh read, so its payload is computed moments before it is sent');
    ok(/BATCH_ACCOUNTING_MISMATCH/.test(ROLL),
      'C4  §C.7 a response that does not account for every row it was given is refused');
    ok(/outcome_unknown = true/.test(R) && /out\.readback = TEMP_FCROLL_verify_\(slice\)/.test(ROLL),
      'C5  §C.4 an unknown outcome is settled by READING the keys back, never by assuming either way');
    ok(!/handleImportFcRegularForecastBatch_/.test(ops(ROLL).replace(/handleImportFcRegularForecastBatch_ !== .function./, '')) === false,
      'C6  §C.11 and it still delegates: no second production writer was created');

    // EXECUTED, against a MUTABLE sheet with the real official writer loaded. `appendRow` really appends, so a
    // kill mid-loop leaves exactly the rows it had written — which is the only way to test this honestly.
    (function fourNinetyFive() {
      var MONTHS12 = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      var FCH = ['forecast_id','year','company','country','marketplace','sku','category','series']
        .concat(MONTHS12).concat(['total_fc','fc_share','forecast_status','source','created_at','updated_at']);
      function build(n) {
        var mps = [['marketplace_sku_id','company','country','marketplace','sku','marketplace_sku_status']];
        var fcr = [FCH.slice()], sk = [['sku','category','series']];
        for (var i = 0; i < n; i++) {
          var sku = 'CO' + (1000 + i) + '-R';
          mps.push(['MS-' + i, 'ResUS', 'US', 'Amazon', sku, 'active']);
          sk.push([sku, 'cat', 'ser']);
          var r = new Array(FCH.length).fill('');
          r[0] = 'FC-2026-' + i; r[1] = 2026; r[2] = 'ResUS'; r[3] = 'US'; r[4] = 'Amazon'; r[5] = sku;
          r[FCH.indexOf('oct')] = 100; r[FCH.indexOf('nov')] = 100; r[FCH.indexOf('dec')] = 100;
          fcr.push(r);
        }
        return { mps: mps, fc: fcr, sk: sk };
      }
      function liveSheet(rows, kill) {
        return { _rows: rows,
          getDataRange: function () { var self = this; return { getValues: function () { return self._rows.map(function (r) { return r.slice(); }); } }; },
          getLastRow: function () { return this._rows.length; },
          getLastColumn: function () { return (this._rows[0] || []).length; },
          appendRow: function (r) {
            if (kill && kill.remaining !== undefined) {
              if (kill.remaining <= 0) throw new Error('Exceeded maximum execution time');
              kill.remaining--;
            }
            this._rows.push(r.slice()); if (kill) kill.appends = (kill.appends || 0) + 1;
          },
          getRange: function (row, col) { var self = this;
            return { setValue: function (v) { self._rows[row - 1][col - 1] = v; if (kill) kill.sets = (kill.sets || 0) + 1; },
              getValues: function () { return []; } }; } };
      }
      function ctxFor(data, kill) {
        var SH = { marketplace_skus: liveSheet(data.mps, null), fc_regular_forecast: liveSheet(data.fc, kill),
          sku_details: liveSheet(data.sk, null) };
        var uid = 0;
        var sbx = { console: { log: function () {} }, Date: Date, Math: Math, JSON: JSON, RegExp: RegExp,
          String: String, Number: Number, Boolean: Boolean, Array: Array, Object: Object, Error: Error,
          isFinite: isFinite, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
          Logger: { log: function () {} },
          Utilities: { getUuid: function () { uid++; return ('0000000' + uid).slice(-8) + '-z'; }, formatDate: function () { return '2026-09-04'; } },
          Session: { getScriptTimeZone: function () { return 'Asia/Taipei'; } },
          SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return SH[n] || null; } }; } },
          ContentService: { createTextOutput: function (t) { return { setMimeType: function () { return this; }, getContent: function () { return t; } }; },
            MimeType: { JSON: 'application/json' } },
          KMPCX: KMPCX };
        sbx.global = sbx;
        var cc = vm.createContext(sbx);
        vm.runInContext('function jsonResponse_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }', cc);
        vm.runInContext(IMPORT04, cc, { filename: '04.gs' });
        vm.runInContext(CENSUS, cc, { filename: 'census.gs' });
        vm.runInContext(ROLL, cc, { filename: 'roll.gs' });
        return cc;
      }
      function dups(data) {
        var k = {}, n = 0;
        for (var i = 1; i < data.fc.length; i++) {
          var r = data.fc[i], key = [r[1], r[2], r[3], r[4], r[5]].join('|');
          k[key] = (k[key] || 0) + 1;
        }
        Object.keys(k).forEach(function (x) { if (k[x] > 1) n++; });
        return n;
      }
      function count(data, year) { var n = 0; for (var i = 1; i < data.fc.length; i++) if (String(data.fc[i][1]) === year) n++; return n; }
      var CY = '{ planningCycle: "RECO-2026-09" }';

      // --- the DRY RUN at the LIVE scale, and it writes nothing --------------------------------------------
      var dA = build(495), kA = { appends: 0, sets: 0 };
      var cA = ctxFor(dA, kA);
      var planA = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cA);
      eq(planA.would_create.length, 495, 'C7  EXECUTED at the live scale: would_create = 495');
      eq(planA.conflicts.length, 0, 'C7a conflicts = 0');
      eq(planA.writes, 0, 'C7b writes = 0');
      eq(kA.appends, 0, 'C7c and the sheet received ZERO appendRow calls');
      eq(count(dA, '2027'), 0, 'C7d with no 2027 row created');
      var refusedA = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(planA.commit_token) + ', ' + CY + ')', cA);
      eq(refusedA.blocker, 'DRY_RUN_MODE_ACTIVE', 'C8  COMMIT with the CORRECT token is still refused by the shipped flag');
      eq(kA.appends, 0, 'C8a zero appendRow');

      // --- THE CRITICAL CASE: killed mid-run, then replayed ------------------------------------------------
      var dB = build(495), kB = { appends: 0, sets: 0, remaining: 137 };
      var cB = ctxFor(dB, kB);
      vm.runInContext('TEMP_FCROLL_DRY_RUN = false;', cB);     // sandbox only; the FILE still ships true
      var pB = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cB);
      var rB = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(pB.commit_token) + ', ' + CY + ')', cB);
      eq(rB.verdict, 'STOP', 'C9  §C.4 killed mid-run: the runner STOPS');
      eq(rB.stopped_because, 'OFFICIAL_WRITER_THREW', 'C9a naming the writer, not guessing a cause');
      eq(kB.appends, 137, 'C9b the sheet really did receive 137 rows before the kill');
      eq(rB.created, 125, 'C9c 125 are ACCOUNTED FOR as created (five whole batches)');
      var lastB = rB.batches[rB.batches.length - 1];
      eq(lastB.outcome_unknown, true, 'C9d the dying batch is marked OUTCOME UNKNOWN, never "failed"');
      eq(lastB.readback.verified + lastB.readback.missing.length, 25,
        'C9e and it is settled by READING those 25 keys back: ' + lastB.readback.verified + ' present, ' +
        lastB.readback.missing.length + ' absent');
      eq(rB.created + rB.errored + rB.skipped_in_batch + rB.unknown + rB.remaining_after, rB.planned_total,
        'C10 §C.7 created + errored + skipped + unknown + not-attempted = 495, exactly');
      eq(dups(dB), 0, 'C10a and no business key is duplicated');

      // --- REPLAY is the recovery, and nothing is remembered between runs ----------------------------------
      kB.remaining = undefined;
      var pB2 = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cB);
      eq(pB2.would_create.length, 495 - 137,
        'C11 §C.4 the REPLAY re-derives exactly the remainder from the table (' + (495 - 137) + ')');
      var rB2 = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(pB2.commit_token) + ', ' + CY + ')', cB);
      eq(rB2.verdict, 'COMMITTED_AND_VERIFIED', 'C11a and completes');
      eq(rB2.updated, 0, 'C11b with ZERO updates — nothing already present was resent to the upsert');
      eq(kB.appends, 495, 'C11c total appends across BOTH runs is exactly 495 — no row written twice');
      eq(count(dB, '2027'), 495, 'C11d 495 rows for 2027');
      eq(dups(dB), 0, 'C11e zero duplicate business keys');
      eq(rB2.readback.ok, true, 'C11f and the per-key readback passes');
      eq(kB.sets || 0, 0, 'C12 §C across the whole thing ZERO setValue calls — no existing month was overwritten');
      eq(count(dB, '2026'), 495, 'C12a and all 495 pre-existing 2026 rows are still there');

      // --- a third run writes nothing ---------------------------------------------------------------------
      var before = kB.appends;
      var pB3 = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cB);
      var rB3 = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(pB3.commit_token) + ', ' + CY + ')', cB);
      eq(pB3.would_create.length, 0, 'C13 §C replay: a third run plans nothing');
      eq(rB3.verdict, 'NOTHING_TO_DO', 'C13a and commits nothing');
      eq(kB.appends - before, 0, 'C13b zero additional appendRow calls');

      // --- an `updated` reply is a hard stop on the FIRST batch --------------------------------------------
      var dC = build(60), kC = { appends: 0 };
      var cC = ctxFor(dC, kC);
      vm.runInContext('TEMP_FCROLL_DRY_RUN = false;', cC);
      var pC = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cC);
      vm.runInContext('handleImportFcRegularForecastBatch_ = function (b) { return ContentService.createTextOutput(' +
        'JSON.stringify({ success: true, data: { results: (b.rows||[]).map(function (r) { return { status: "updated", ' +
        'year: r.year, company: r.company, country: r.country, marketplace: r.marketplace, sku: r.sku }; }) } })' +
        ').setMimeType(ContentService.MimeType.JSON); };', cC);
      var rC = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(pC.commit_token) + ', ' + CY + ')', cC);
      eq(rC.verdict, 'STOP', 'C14 §C.8 a writer reporting `updated` is a HARD STOP');
      eq(rC.batches.length, 1, 'C14a on the FIRST batch, not after all of them');
      eq(rC.stopped_because, 'UNEXPECTED_UPDATE_EXISTING_ROW_MAY_HAVE_BEEN_OVERWRITTEN', 'C14b named as possible data loss');

      // --- a response that does not account for every row ---------------------------------------------------
      var dD = build(60), kD = { appends: 0 };
      var cD = ctxFor(dD, kD);
      vm.runInContext('TEMP_FCROLL_DRY_RUN = false;', cD);
      var pD = vm.runInContext('RUN_FC_2027_ROLLOVER_DRY_RUN()', cD);
      vm.runInContext('handleImportFcRegularForecastBatch_ = function (b) { return ContentService.createTextOutput(' +
        'JSON.stringify({ success: true, data: { results: (b.rows||[]).slice(0,3).map(function (r) { return { status: "created", ' +
        'year: r.year, company: r.company, country: r.country, marketplace: r.marketplace, sku: r.sku }; }) } })' +
        ').setMimeType(ContentService.MimeType.JSON); };', cD);
      var rD = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW(' + JSON.stringify(pD.commit_token) + ', ' + CY + ')', cD);
      eq(rD.batches[0].blocker, 'BATCH_ACCOUNTING_MISMATCH',
        'C15 §C.7 a reply accounting for 3 of 25 rows is refused rather than believed');
      eq(rD.batches[0].outcome_unknown, true, 'C15a and treated as an UNKNOWN outcome, settled by readback');

      // --- a conflict still stops before the first write ---------------------------------------------------
      var dE = build(20), kE = { appends: 0 };
      var dupRow = dE.fc[1].slice(); dupRow[0] = 'FC-DUP'; dupRow[FCH.indexOf('oct')] = 999;
      dE.fc.push(dupRow);
      var cE = ctxFor(dE, kE);
      vm.runInContext('TEMP_FCROLL_DRY_RUN = false;', cE);
      var rE = vm.runInContext('COMMIT_FC_2027_ROLLOVER_AFTER_REVIEW("whatever", ' + CY + ')', cE);
      eq(rE.blocker, 'CONFLICTING_FORECAST_ROWS_PRESENT', 'C16 §C.9 a conflict STOPS before the first write');
      eq(kE.appends, 0, 'C16a with zero appendRow calls');
    })();
  })();

  // ==============================================================================================================
  section('§I — the AI Plan flag stays FALSE');
  // ==============================================================================================================
  eq(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = (\w+);/.exec(CFG)[1], 'false',
    'I1  §I the flag is false at the end of this round');
  ok(/INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_/.test(CFG),
    'I1a and the rollback switch is PRESERVED, never deleted');
  ok(/HARVEST_NOT_READY/.test(CFG) || /harvest/i.test(CFG),
    'I2  §I.H the file records WHY it is false — the canonical harvest is not ready');
  ok(/FORECAST_BASIS_COMPLETE|forecast/i.test(CFG),
    'I2a and names the forecast census as a re-activation condition');
  ok(/PROCEED/.test(CFG), 'I2b together with the activation census verdict it requires');
  // RESTATED (A2-R1-R5): R2's claim is that R2 did not churn 00_config — true of R2, and silent about
  // later rounds. R5 both rotated this stamp (it had never moved when the file changed) and changed the
  // file again, adding the transit-buffer authority. The durable form is a floor.
  ok(RO.stampAtOrAfter(/var CONFIG_BUILD_VERSION_ = '([^']+)'/.exec(CFG)[1], 'F1-7N-FC-1B-E3-R1'),
    'I3  §K 00_config.gs carries a stamp at or after R1 — R2 itself churned nothing');
  // changes 61_ and the manifest — so the stamp moves by design. What must ALWAYS hold, in every round, is
  // that 63_ declares exactly what its own manifest entry expects; a half-synced 63_ is the named
  // mixed_deployment fault this manifest exists to produce.
  var _sysExpect = (HLTH.match(/\{ file: '63_api_v1_system_health\.gs',[^}]*expected: '([^']+)'/) || [])[1];
  ok(_sysExpect, 'I3a 63_ has a manifest entry for itself');
  eq(/var SYS_BUILD_VERSION_ = '([^']+)'/.exec(HLTH)[1], _sysExpect,
    'I3b and declares exactly the build that entry expects (' + _sysExpect + ')');
  ok(/inventory_ai_plan_db_generation_enabled/.test(HLTH),
    'I4  §I health still reports the flag, so flag_effective is readable after a deploy');
  // §K — the TEMP tools are NOT production files.
  ok(!/TEMP_FC_FORECAST_YEAR_ROLLOVER_CENSUS|TEMP_FC_REGULAR_FORECAST_YEAR_ROLLOVER/.test(HLTH),
    'I5  §K neither TEMP tool is in the deployment manifest');
  ok(!/TEMP_FC_/.test(read('assets/specs/active/apps-script/01_router.gs')),
    'I5a and neither is routed as an action');

  // ==============================================================================================================
  section('§K — release identity');
  // ==============================================================================================================
  // RESTATED (F1-7N-FC-1B-E3-R3-R1): the SEVENTH consecutive round to pin its own token as "the current
  // one", and it breaks the same way every time - the next round rotates the series and an assertion about
  // the PRESENT silently becomes one about the past. R2's token is a FLOOR: it was minted, it came after
  // R1's, and the series has never moved behind it. All three still fail if R2's rotation is undone.
  ok(RO.tokenIndex('fc1b-e3r2-composerstate-20260903') !== -1, 'K1  this round minted its own application token');
  ok(RO.tokenIndex(RO.currentAppToken()) >= RO.tokenIndex('fc1b-e3r2-composerstate-20260903'),
    'K1b and the series has not moved behind it (current: ' + RO.currentAppToken() + ')');
  ok(RO.tokenIndex('fc1b-e3r2-composerstate-20260903') > RO.tokenIndex('fc1b-e3r1-readiness-20260903'),
    'K1a strictly after R1\'s, which was PUBLISHED (origin/main carries 951d58c)');
  eq((INDEX.match(/\?v=fc1b-e3r1-readiness-20260903/g) || []).length, 0, 'K2  zero production refs remain on it');
  eq(RO.staleAppTokenRefs(INDEX).join(' | '), '', 'K2a and nothing is left behind on any superseded token');
  var IX = RO.parseIndexTokens(INDEX);
  eq(IX['assets/js/pages/inventory-replenishment.js'], RO.currentAppToken(), 'K3  the page carries it');
  eq(IX['assets/js/utils/inventory-compat.js'], RO.currentAppToken(),
    'K3a and so does inventory-compat.js — it is where IRRouteUiState lives');
  // RESTATED (A2-R1-R6-R1): R2's claim is that ITS round rotated the family — a fact about R2, and silent
  // about later rounds. R6-R1 rotates it again for three rules that did not exist. The durable form is a
  // floor; K4b below already states the strictly-after relation R2 actually owns.
  ok(RO.irCssTokenAtOrAfter(RO.currentIrCssToken(), 'irroutehint-20260903'),
    'K4  the stylesheet family rotates when the file changes: .ir-route-hint was new in R2');
  eq(IX[RO.IR_CSS_FILE], RO.currentIrCssToken(), 'K4a and index.html carries the stylesheet\'s own token');
  ok(RO.irCssTokenAtOrAfter('irroutehint-20260903', 'irexecrow-20260903'), 'K4b strictly after E3\'s');
  ok(RO.stampAtOrAfter('F1-7N-FC-1B-E3-R2', 'F1-7N-FC-1B-E3-R1'), 'K5  the owner stamp is recorded, after R1\'s');
  ok(RO.BUILD_STAMP_RE.test('F1-7N-FC-1B-E3-R2'), 'K5a and the shared stamp validator accepts it');
  // The bundle must NOT have changed: no bundle source was touched.
  ok(!/IRRouteUiState/.test(read('assets/specs/active/apps-script/90_generated_supply_planning_bundle.gs')),
    'K6  §K no bundle source changed — the new module is frontend-only, so no rebuild is required');

  // ==============================================================================================================
  section('MUTATIONS — each one is a way this could regress');
  // ==============================================================================================================
  var FLUSH_SRC = extractFn(PAGE, '_flushDraftDbPersist');

  // 1. the composer readmitted to the write scope: the whole mechanism of the false red error
  mut('N1  a composer is readmitted to the write scope', function () {
    // The composer predicate appears TWICE in this function - once excluding composers from the WRITE SCOPE
    // and once selecting the touched ones to HINT - so "does this expression appear" cannot tell the mutant
    // from the original. The probe names the scope filter exactly.
    // R6-R6-R2: the scope expression lost its parenthesised two-branch head, so the filter now begins a line.
    var anchor = '            .filter(function (r) { return !(_irIsComposerRow_(r) && !_isRouteComplete(r)); });';
    var m = swap(FLUSH_SRC, anchor, ';');
    return FLUSH_SRC.indexOf(anchor) !== -1 && m.indexOf(anchor) === -1;
  });
  // 2. the incomplete notice sent back to the failure renderer
  mut('N2  the incomplete notice goes back to the red panel', function () {
    var m = swap(FLUSH_SRC, '_irShowRouteStateHint_(sku, _irIncompleteRouteNotice_(sku, _hintRows));',
      '_irShowDraftSaveError(sku, _irIncompleteRouteNotice_(sku, _hintRows));');
    return /_irShowDraftSaveError\(sku, _irIncompleteRouteNotice_/.test(m) &&
      !/_irShowRouteStateHint_\(sku, _irIncompleteRouteNotice_/.test(m);
  });
  // 3. the door on the failure renderer removed
  mut('N3  the failure renderer stops refusing a NEUTRAL envelope', function () {
    var m = swap(extractFn(PAGE, '_irShowDraftSaveError'), "if (String(s.severity || '') === 'NEUTRAL') {", 'if (false) {');
    return !/=== 'NEUTRAL'/.test(m);
  });
  // 4. the envelope stops declaring itself non-failing, which defeats the door from the other side
  mut('N4  the incomplete notice drops its severity', function () {
    var m = swap(extractFn(PAGE, '_irIncompleteRouteNotice_'), "        severity: 'NEUTRAL',\n", '');
    return !/severity: 'NEUTRAL'/.test(m);
  });
  // 5. the neutral surface grows a technical disclosure
  mut('N5  the neutral hint grows a <details> disclosure', function () {
    var m = swap(extractFn(PAGE, '_irShowRouteStateHint_'), 'el.innerHTML = esc(line);',
      "el.innerHTML = esc(line) + '<details><summary>Technical details</summary>' + esc(line) + '</details>';");
    return /<details/.test(m);
  });
  // 6. the badge goes back to claiming an outcome nothing produced
  mut('N6  an unfinished row is badged with a save OUTCOME again', function () {
    var m = swap(FLUSH_SRC, "'INCOMPLETE');", "'NOT_SAVED');");
    return /_irSetRouteSaveState_\(sku, \[String\(r\.client_route_instance_id \|\| ''\)\], 'NOT_SAVED'\)/.test(m);
  });
  // 7. a pristine composer starts speaking
  mut('N7  a PRISTINE composer is hinted too', function () {
    var m = swap(FLUSH_SRC, "&& r.composer_touched === true;", ';');
    return !/composer_touched === true/.test(m);
  });
  // 8. the classifier calls a failure a non-failure
  mut('N8  a failure state is reclassified as a non-failure', function () {
    var src = extractVar(CMPSRC, 'IR_ROUTE_UI_FAILURE_STATES');
    var m = swap(src, 'IR_ROUTE_UI_STATES.SAVE_FAILED, IR_ROUTE_UI_STATES.SAVE_OUTCOME_UNKNOWN',
      'IR_ROUTE_UI_STATES.SAVE_FAILED');
    return !/SAVE_OUTCOME_UNKNOWN/.test(m);
  });
  // 9. a settled outcome overridden by an editor state — this is how a real failure gets hidden
  mut('N9  an editor state overrides a settled save outcome', function () {
    var src = extractFn(CMPSRC, 'routeUiStateOf');
    var stateRead = src.indexOf('row.route_save_state');
    var incompleteBranch = src.indexOf('if (!complete) {');
    return stateRead > -1 && incompleteBranch > -1 && stateRead < incompleteBranch;
  });
  // 10. the timeout classifier reads a typed server failure as slowness
  mut('N10 a typed server failure is classified as a timeout', function () {
    var t = TD.classify([{ kind: 'read', action: 'a', code: 'AUTH_OR_ACCESS_HTML', ms: 1 }], 'a');
    return t.classification === 'SERVER_TYPED_FAILURE';
  });
  // 11. the census merges explicit zero with missing
  mut('N11 the census treats an explicit ZERO as a missing month', function () {
    var m = swap(CENSUS, "else { value = distinct[keys[0]]; code = (value === 0) ? 'EXPLICIT_ZERO' : 'OK'; }",
      "else { value = distinct[keys[0]]; code = (value === 0) ? 'CELL_BLANK_OR_NON_NUMERIC' : 'OK'; }");
    return /value === 0\) \? 'CELL_BLANK_OR_NON_NUMERIC'/.test(m);
  });
  // 12. the census gains a clock default for the planning cycle
  mut('N12 the census defaults the planning cycle from the clock', function () {
    var m = swap(CENSUS, 'var pc = TEMP_FCR_str_(planningCycle);',
      "var pc = TEMP_FCR_str_(planningCycle) || ('RECO-' + new Date().toISOString().slice(0, 7));");
    return /new Date\(\)/.test(ops(m));
  });
  // 13. the migration writes directly instead of delegating
  mut('N13 the migration appends a row itself', function () {
    var m = swap(ROLL, 'var envelope = handleImportFcRegularForecastBatch_({',
      'sh.appendRow([]); var envelope = handleImportFcRegularForecastBatch_({');
    return /appendRow/.test(ops(m));
  });
  // 14. DRY RUN stops gating COMMIT
  mut('N14 the DRY_RUN flag stops gating COMMIT', function () {
    var m = swap(ROLL, 'if (TEMP_FCROLL_DRY_RUN === true) {', 'if (false) {');
    return !/TEMP_FCROLL_DRY_RUN === true/.test(m);
  });
  // 15. DRY_RUN ships false
  mut('N15 DRY_RUN ships false', function () {
    var m = swap(ROLL, 'var TEMP_FCROLL_DRY_RUN = true;', 'var TEMP_FCROLL_DRY_RUN = false;');
    return /var TEMP_FCROLL_DRY_RUN = false;/.test(m);
  });
  // 16. an `updated` result stops being a hard failure — the data-loss shape
  // RESTATED (F1-7N-FC-1B-E3-R3): the guard moved into the per-BATCH function when the runner was batched,
  // so it now reads `out.updated`. The defect it catches is the same and is now caught per batch, which is
  // strictly better: the run stops on the FIRST batch that reports an update rather than after all 495.
  mut('N16 an unexpected UPDATE is tolerated instead of stopping', function () {
    var m = swap(ROLL, 'if (out.updated > 0) {', 'if (false) {');
    return !/if \(out\.updated > 0\) \{/.test(m);
  });
  // 17. the migration starts creating rows for a blank month
  mut('N17 the migration writes over a blank month in an existing row', function () {
    var m = swap(ROLL, "if (m.code !== 'NO_ROW_FOR_YEAR') return;", "if (m.code === 'OK') return;");
    return /if \(m\.code === 'OK'\) return;/.test(m) && !/m\.code !== 'NO_ROW_FOR_YEAR'/.test(m);
  });
  // 18. the flag set true — §I
  mut('N18 the AI Plan flag is set true while the harvest is not ready', function () {
    var m = swap(CFG, 'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;',
      'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true;');
    return /var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true;/.test(m);
  });
  // 19. the stylesheet's amber turned into the failure red
  mut('N19 the neutral hint is repainted in the failure red', function () {
    // Anchored on the RULE BLOCK, not on the first textual occurrence of the class name - that one is inside
    // the comment above the rule, and a window measured from there never reaches the declaration. And the
    // MUTATION itself has to be anchored: `color: #92400E` appears three times earlier in this stylesheet,
    // because the amber pair the hint uses is the page's EXISTING blocked/config amber rather than a new
    // colour, so a bare first-occurrence replace mutated an unrelated rule and left this one intact.
    var m = swap(CSS, '  border: 1px solid #FDE68A;\n  color: #92400E;', '  border: 1px solid #FDE68A;\n  color: #dc2626;');
    var block = /\.ir-route-hint\s*\{([^}]*)\}/.exec(m);
    return !!block && /#dc2626/.test(block[1]);
  });
  // 20. a token not rotated while the module that must be refetched did change
  // RESTATED (F1-7N-FC-1B-E3-R3-R1): the anchor named R2's literal token, so the mutation stopped applying
  // the moment the series moved. The defect it catches - one asset left behind on a superseded token - is
  // unchanged; the anchor is now derived from whatever the CURRENT token is.
  mut('N20 one asset is left behind on a superseded token', function () {
    var cur = RO.currentAppToken(), prev = 'fc1b-e3r1-readiness-20260903';
    var m = swap(INDEX, 'inventory-compat.js?v=' + cur, 'inventory-compat.js?v=' + prev);
    return RO.staleAppTokenRefs(INDEX).length === 0 && RO.staleAppTokenRefs(m).length > 0;
  });

  summary();
}

function summary() {
  console.log('\n----------------------------------------');
  console.log('MANUAL COMPOSER EXPECTED STATE + FORECAST ROLLOVER (F1-7N-FC-1B-E3-R2): ' +
    pass + ' passed, ' + fail + ' failed');
  console.log('mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
  if (fail) process.exitCode = 1;
}
