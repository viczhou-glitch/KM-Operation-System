// F1-7N-FB-4G-A2-R2 — ROUTE INSTANCE UPDATE VS ADD-ROUTE CREATE CONTRACT, plus the A2-R1 write separation.
//
// THE ROOT CAUSE, MEASURED ON THE SHIPPED FUNCTIONS.
//
// The client deliberately sent NO allocation_draft_id, and said so in its own comment: "the server resolves a
// route-complete header by the canonical K2 group key — same route REUSEs, different route CREATEs — which is
// idempotent by construction". It is idempotent. It also makes the NATURAL KEY the ENTITY IDENTITY, and that
// has two consequences the operator sees:
//
//   (1) EDITING A ROUTE DIMENSION MEANT "A DIFFERENT ENTITY". _irQueueStaleGroupCancels_ compared the route's
//       stored group key with the recomputed one and, when they differed, ERASED allocation_draft_id and
//       allocation_draft_line_id and soft-cancelled the stored line. Executed over the live route:
//
//         edit                                   K2 key changed   ids after
//         To: marketplace -> warehouse           true             ERASED  -> CREATE
//         To: Amazon -> Walmart                  false            kept    -> UPDATE
//         Method: sea -> air                     true             ERASED  -> CREATE
//         Method: sea -> sea_express             true             ERASED  -> CREATE
//         From: changed                          true             ERASED  -> CREATE
//         Last Mile: added                       true             ERASED  -> CREATE
//         Qty: 800 -> 500                        false            kept    -> UPDATE
//
//       One UI route edited across three dimensions is three headers. That is the live
//       SADH-K2-E7AF9242 / -179FBB0E / -C3E2031A shape.
//
//   (2) A KEY THAT MATCHED NOTHING MEANT "CREATE ONE", AND A KEY THAT MATCHED A LEGACY HEADER MEANT "ADOPT IT".
//       sadLegacyReconcileReason_ returns LEGACY_ROUTE_RECONCILIATION_REQUIRED for a route-incomplete header,
//       which is exactly what the operator's + Add Route came back with: the new route's natural key resolved
//       onto a zero-line legacy header of the same station instead of creating the shipment they asked for.
//
//   (3) AND THE SAME FUNCTION TREATED A LEGAL EDIT AS CORRUPTION. sadLegacyReconcileReason_ also refuses an
//       SADH-K2- row whose id no longer hashes to its own current fields — which is the NORMAL state of any
//       header that has ever been legitimately updated.
//
//   (4) ONE UI EVENT SAVED EVERY ROUTE ON SCREEN. _saveAllocationDraftFromDom rebuilt all rows and handed the
//       whole SKU to the writer, which partitioned all of them and wrote each group. That is where
//       "3 route(s) for CO1100-R: 2 saved, 1 not saved" came from — adding a third route re-saved the two
//       already stored. And a failure was reported against a GROUP, labelled from that group's first route,
//       so which DOM row failed was not recoverable from the message at all.
//
// Run: node assets/tests/route-instance-update-vs-create-f1-7n-fb-4g-a2-r2.test.js

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

var ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); }

var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CMPSRC = read('assets/js/utils/inventory-compat.js');
var TEMP = read('assets/tools/apps-script-diagnostics/TEMP_route_identity_census_a2_r2.gs');
var INDEX = read('index.html');
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var CMP = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js'));
var IRDraft = CMP.IRDraft;
var PF = CMP.IRSubmitPreflight;

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
  while (' \t\r\n'.indexOf(src[i]) >= 0) i++;
  if (src[i] === '{' || src[i] === '[') {
    var open = src[i], close = open === '{' ? '}' : ']', d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (d === 0) break; } }
    return src.slice(m.index, j + 1) + ';';
  }
  return src.slice(m.index, src.indexOf(';', i) + 1);
}
// Line endings differ per file; a multi-line find string in the wrong ending fails while naming a target that
// IS present. Both sides are normalised to the source's own ending.
function mutateFn(src, name, find, replace) {
  var CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  var eol = src.indexOf(CR + LF) >= 0 ? (CR + LF) : LF;
  function fix(t) { return String(t).split(CR + LF).join(LF).split(LF).join(eol); }
  find = fix(find); replace = fix(replace);
  var body = extractFn(src, name);
  if (body.indexOf(find) < 0) throw new Error('mutation target absent in ' + name + ': ' + find.slice(0, 90));
  return src.replace(body, body.replace(find, replace));
}
function moduleFrom(src) { return new Function('var module = { exports: {} }; var window; ' + src + ' return module.exports;')(); }

// ================================================================================================================
// The in-memory spreadsheet. It is the ONLY thing simulated: every rule under test runs from shipped source.
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
var __uuidSeq = 0;
var Utilities = { getUuid: function () { __uuidSeq++; return ('UUID' + __uuidSeq + '000000000000').substring(0, 16); } };
var Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };
var __now = '2026-09-02 09:00:00';
function procurementTimestamp_() { return __now; }
function prodRequireSheet_(ss, name) { return SHEETS[name]; }
function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ''; }
function jsonResponse_(o) { return o; }

eval(extractFn(G13, 'procurementEnsureSheet_'));
eval(extractFn(G13, 'procurementAppendByHeader_'));
eval(extractFn(G13, 'procurementFindRow_'));
eval(extractVar(G16, 'SHIPPING_ALLOCATION_DRAFTS_HEADERS_'));
eval(extractVar(G16, 'SAD_LIFECYCLE_TAIL_COLUMNS_'));
// F1-7N-FB-4G-A2-R3 - the header's optional tail gained a THIRD append (create_idempotency_key at 35),
// so a lift that stops at two now hits a ReferenceError inside a shipped constant.
eval(extractVar(G16, 'SAD_ROUTE_IDENTITY_TAIL_COLUMNS_'));
eval(extractVar(G16, 'SAD_CREATE_IDEMPOTENCY_TAIL_COLUMNS_'));
eval(extractVar(G16, 'SAD_HEADER_OPTIONAL_TAIL_COLUMNS_'));
eval(extractVar(G16, 'SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_'));
eval(extractVar(G16, 'SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_'));
eval(extractVar(G16, 'SAD_LINE_ETA_TAIL_COLUMNS_'));
var SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_ =
  SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_.concat(SAD_LINE_ETA_TAIL_COLUMNS_);
eval(extractVar(G16, 'SAD_STATUSES_'));
eval(extractVar(G16, 'SAD_TERMINAL_STATUSES_'));
eval(extractVar(G16, 'SAD_TERMINAL_LINE_STATUSES_'));
eval(extractVar(G16, 'SAD_GENERATION_TYPES_'));
eval(extractVar(G16, 'SAD_RECOMMENDATION_FIELDS_'));
eval(extractVar(G16, 'SAD_LINE_LEGACY_ALIASES_'));
eval(extractVar(G16, 'SAD_K2_GROUP_DIMENSIONS_'));
eval(extractVar(G16, 'SAD_LINE_IDENTITY_FIELDS_'));
eval(extractVar(G16, 'SAD_K2_BASIS_ID_MATCHES_'));
eval(extractVar(G16, 'SAD_K2_BASIS_STALE_ACCEPTED_'));
eval(extractVar(G16, 'SAD_K2_BASIS_DIFFERENT_GROUP_'));
eval(extractVar(G16, 'SAD_K2_BASIS_NO_REQUEST_GROUP_'));
eval(extractVar(G16, 'SAD_K2_BASIS_CONTESTED_'));
eval(['sadApplyLineAliases_', 'sadFnv1a_', 'sadFpVal_', 'sadLineNaturalKey_', 'sadDeterministicLineId_',
  'sadFindLineByNaturalKey_', 'sadK2GroupKey_', 'sadK2DeterministicHeaderId_', 'sadK2LineNaturalKey_',
  'sadK2DeterministicLineId_', 'sadIsK2Group_', 'sadNewLineId_', 'sadK2ResolveActiveDraft_', 'sadCanonicalLineId_',
  'sadSameLineIdentity_', 'sadPreflightLineBatch_', 'sadScanDuplicateLinePks_', 'sadVerifyDraftLines_',
  'sadLineIsComplete_', 'sadLiveHeaderNames_', 'sadHasColumn_', 'sadDestinationIdentity_',
  'sadHeaderRouteIsComplete_', 'sadResolveActiveDraft_', 'sadReadActiveHeaderRows_',
  'sadResolveActiveDraftK2OrK3_', 'sadK2ReconcileDecision_', 'sadLegacyReconcileReason_', 'sadReconcileMessage_',
  'sadRowToObject_', 'sadReadLinesForDraft_',
  // F1-7N-FB-4G-A2-R3 - the CREATE path mints its identity through a named authority now (an identical
  // route is a legitimate second ticket, so a taken deterministic id is minted around, never refused).
  'sadMintNewHeaderId_',
  'sadUpsertDraftHeaderCore_', 'sadUpsertLinesKeyedCore_'
].map(function (fn) { return extractFn(G16, fn); }).join('\n'));

var SKU = 'CO1100-R';
var SCOPE = { planning_cycle: '', company: 'ResUS', country: 'US', marketplace: 'Amazon' };
var SCOPE_KEY = [SCOPE.company, SCOPE.country, SCOPE.marketplace].join('|').toLowerCase();

function resetDb() {
  SHEETS['shipping_allocation_drafts'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_);
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_);
  __uuidSeq = 0;
}
function rowsOf(tab) {
  var sh = SHEETS[tab], hdr = sh.rows[0];
  return sh.rows.slice(1).map(function (r) { var o = {}; hdr.forEach(function (h, i) { if (h) o[h] = r[i]; }); return o; });
}
function headers() { return rowsOf('shipping_allocation_drafts'); }
function lines() { return rowsOf('shipping_allocation_draft_lines'); }

// A route instance as the page's model holds it. `persisted` fields are absent until a save adopts them.
var __cri = 0;
function route(over) {
  __cri++;
  var r = {
    client_route_instance_id: 'CRI-TEST-' + __cri,
    allocation_draft_id: '', allocation_draft_line_id: '', route_group_key: '', draft_version: '',
    source_warehouse_id: 'WH-CN-YOUXIN', source_warehouse_code: 'CNYOUXIN', ship_from: 'CN Youxin',
    destination_warehouse_id: '', destination_marketplace: 'Amazon', destination_warehouse_code: '',
    destination: 'Amazon', shipping_method: 'sea', last_mile_delivery: '', recommendation_group_no: '',
    sku: SKU, site_sku: '', window_code: '', planned_qty: 800, qty: 800, units_per_carton: 20
  };
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}

// ONE ROUTE INTENT, exactly as the shipped writer now issues it: intent declared from whether the route holds
// a persisted identity, the id and expected version carried on an UPDATE, the instance id on a CREATE.
function saveOne(r) {
  var pf = IRDraft.preflightRouteGroups(SCOPE, SKU, [r]);
  if (!pf.ok) return { ok: false, stage: 'preflight', conflicts: pf.conflicts };
  var g = pf.groups[0];
  if (!g) return { ok: false, stage: 'incomplete' };
  var h = g.header;
  var hasId = !!String(r.allocation_draft_id || '').trim();
  var payload = IRDraft.buildDraftHeaderPayload({
    intent: hasId ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE',
    allocation_draft_id: hasId ? r.allocation_draft_id : undefined,
    expected_draft_version: hasId ? (String(r.draft_version || '') || undefined) : undefined,
    create_idempotency_key: hasId ? undefined : r.client_route_instance_id,
    applied_scope_key: SCOPE_KEY,
    planning_cycle: SCOPE.planning_cycle, company: SCOPE.company, country: SCOPE.country, marketplace: SCOPE.marketplace,
    source_warehouse_id: h.recommended_source_warehouse_id,
    source_warehouse_code: h.source_warehouse_code,
    destination_warehouse_id: h.recommended_destination_warehouse_id,
    destination_warehouse_code: h.destination_warehouse_code,
    shipping_method: h.recommended_shipping_method,
    last_mile_delivery: h.recommended_last_mile_delivery,
    destination_marketplace: h.destination_marketplace
  });
  var hres = sadUpsertDraftHeaderCore_(payload);
  if (!hres || hres.success === false) return { ok: false, stage: 'header', res: hres, intent: payload.intent, instance: r.client_route_instance_id };
  var draftId = hres.data.allocation_draft_id;
  var lres = sadUpsertLinesKeyedCore_({
    allocation_draft_id: draftId,
    lines: [{ allocation_draft_line_id: r.allocation_draft_line_id || undefined, sku: SKU, site_sku: r.site_sku || '',
      window_code: r.window_code || '', planned_qty: r.planned_qty, units_per_carton: r.units_per_carton,
      generation_type: 'user_created' }]
  });
  if (!lres || lres.success === false) return { ok: false, stage: 'lines', res: lres, intent: payload.intent, instance: r.client_route_instance_id };
  // Adopt the persisted identities back into THIS instance, as the page does.
  var pl = (lres.data.persisted_lines || [])[0];
  r.allocation_draft_id = draftId;
  if (pl) r.allocation_draft_line_id = pl.allocation_draft_line_id;
  r.route_group_key = g.groupKey;
  r.draft_version = String(hres.data.draft_version || (headers().filter(function (x) { return String(x.allocation_draft_id) === draftId; })[0] || {}).draft_version || '');
  return { ok: true, intent: payload.intent, instance: r.client_route_instance_id, draftId: draftId,
    lineId: r.allocation_draft_line_id, hres: hres, lres: lres, payload: payload };
}

// ================================================================================================================
section('§3 — THE MEASURED ROOT CAUSE');
// ================================================================================================================
(function () {
  // Q1 — the model DOES hold the persisted identities, and the LINE payload carries the line id.
  var r = route({ allocation_draft_id: 'SADH-X', allocation_draft_line_id: 'SADL-X' });
  var line = IRDraft.buildDraftLinePayload(SKU, r, { scope: SCOPE, system: false });
  eq(line.allocation_draft_line_id, 'SADL-X', 'R1  §3.1 the route model holds its persisted line id, and the line payload carries it');

  // Q2 — the HEADER payload dropped the draft id. Now it carries it, under a declared intent.
  var hdrNoIntent = IRDraft.buildDraftHeaderPayload({ company: 'ResUS', source_warehouse_id: 'W', shipping_method: 'sea' });
  eq(hdrNoIntent.intent, undefined, 'R2  §3.2 a payload built without an intent carries none (it is never invented)');
  var hdrUpd = IRDraft.buildDraftHeaderPayload({ intent: 'UPDATE_EXISTING_ROUTE', allocation_draft_id: 'SADH-X',
    expected_draft_version: '3', applied_scope_key: SCOPE_KEY, source_warehouse_id: 'W', shipping_method: 'sea' });
  eq([hdrUpd.intent, hdrUpd.allocation_draft_id, hdrUpd.expected_draft_version], ['UPDATE_EXISTING_ROUTE', 'SADH-X', '3'],
    'R2a §5 an UPDATE payload carries the entity id AND the version it expects');
  var hdrCre = IRDraft.buildDraftHeaderPayload({ intent: 'CREATE_NEW_ROUTE', create_idempotency_key: 'CRI-9',
    source_warehouse_id: 'W', shipping_method: 'sea' });
  eq([hdrCre.intent, hdrCre.allocation_draft_id, hdrCre.create_idempotency_key], ['CREATE_NEW_ROUTE', undefined, 'CRI-9'],
    'R2b §9 a CREATE payload names no existing entity and carries the create idempotency key');
  eq(IRDraft.buildDraftHeaderPayload({ intent: 'update_existing_route' }).intent, undefined,
    'R2c an intent is taken only from an EXACT string, so a truthy accident cannot select an operation');

  // Q3/Q4 — the K2 key is a GROUPING key, and editing a dimension changes it. That is expected; what is no
  // longer allowed is treating the change as a change of entity.
  var base = route({});
  var k0 = IRDraft.canonicalRouteGroupKey(SCOPE, base);
  var moved = route({ shipping_method: 'air' });
  ok(IRDraft.canonicalRouteGroupKey(SCOPE, moved) !== k0,
    'R3  §3.4 changing Method changes the 10-dimension K2 key (it is a grouping signature)');
  var toMkt = route({ destination_marketplace: 'Walmart' });
  eq(IRDraft.canonicalRouteGroupKey(SCOPE, toMkt), k0,
    'R3a and marketplace-to-marketplace does NOT, because destination_marketplace is not one of the ten');

  // Q3 — the identity eraser is gone.
  var stale = extractFn(PAGE, '_irQueueStaleGroupCancels_');
  var _pendingDraftCancels = {};
  eval(stale);
  var mv = { allocation_draft_id: 'SADH-OLD', allocation_draft_line_id: 'SADL-OLD', route_group_key: 'OLD|KEY' };
  _irQueueStaleGroupCancels_(SKU, [{ groupKey: 'NEW|KEY', routes: [mv] }]);
  eq([mv.allocation_draft_id, mv.allocation_draft_line_id], ['SADH-OLD', 'SADL-OLD'],
    'R4  §2/§4 a dimension change no longer ERASES the route\'s immutable entity identities');
  eq(_pendingDraftCancels[SKU], undefined, 'R4a and no soft-cancel is queued — there is no "header it left"');
  eq(mv.route_group_key, 'NEW|KEY', 'R4b only the collision signature is refreshed');

  // Q4 — where the natural key was the entity identity, in the server's own guard.
  var legacy = code(extractFn(G16, 'sadLegacyReconcileReason_'));
  ok(/sadK2DeterministicHeaderId_\(o\) === storedId/.test(legacy),
    'R5  §3.4 the server guard still COMPARES the stored id with the hash of its own fields');
  var upd = code(extractFn(G16, 'sadUpsertDraftHeaderCore_'));
  var iUpdBranch = upd.indexOf("sadIntent === 'UPDATE_EXISTING_ROUTE'");
  var iLegacyCall = upd.indexOf('sadLegacyReconcileReason_');
  ok(iUpdBranch > -1 && iUpdBranch < iLegacyCall,
    'R5a §4 but a declared UPDATE is decided BEFORE that guard, so a legal edit is never called corruption');

  // Q8 — DEPLOYMENT_CONTRACT_MISMATCH is a TRANSPORT verdict, not a route one.
  var tr = read('assets/js/api/km-transport.js');
  ok(/DEPLOYMENT_CONTRACT_MISMATCH/.test(tr) && /the deployment does not know this action/.test(read('assets/js/api/km-api-foundation.js')),
    'R6  §3.8 DEPLOYMENT_CONTRACT_MISMATCH means the DEPLOYMENT lacks the action — it is never a route verdict');
})();

// ================================================================================================================
section('§12.1–§12.7 / §8 — UPDATE AN EXISTING ROUTE: SAME IDS, ZERO NEW ROWS');
// ================================================================================================================
(function () {
  resetDb();
  var r = route({});
  var s1 = saveOne(r);
  ok(s1.ok, 'U0  the first save of a + Add Route instance succeeds');
  eq(s1.intent, 'CREATE_NEW_ROUTE', 'U0a and it is declared a CREATE');
  eq([headers().length, lines().length], [1, 1], 'U0b creating exactly ONE header and ONE line (§12.8)');
  var idH = r.allocation_draft_id, idL = r.allocation_draft_line_id;
  ok(/^SADH-K2-/.test(idH) && /^SADL-K2-/.test(idL), 'U0c under canonical persisted identities');

  var EDITS = [
    ['U1  §12.1 change To (marketplace -> marketplace)', { destination_marketplace: 'Walmart' }],
    ['U2  §12.2 marketplace -> warehouse (the XOR flips in place)', { destination_marketplace: '', destination_warehouse_id: 'WH-US-3PL-01', destination_warehouse_code: 'US3PL01' }],
    ['U3  §12.3 warehouse -> marketplace (the XOR flips back)', { destination_warehouse_id: '', destination_warehouse_code: '', destination_marketplace: 'Amazon' }],
    ['U4  §12.4 sea -> air', { shipping_method: 'air' }],
    ['U5  §12.5 air -> sea_express', { shipping_method: 'sea_express' }],
    ['U6  §12.6 change From', { source_warehouse_id: 'WH-CN-OTHER', source_warehouse_code: 'CNOTHER' }],
    ['U7  §12.7 change Qty only', { planned_qty: 650, qty: 650 }]
  ];
  EDITS.forEach(function (e) {
    Object.keys(e[1]).forEach(function (k) { r[k] = e[1][k]; });
    var res = saveOne(r);
    ok(res.ok, e[0] + ' — saves');
    eq(res.intent, 'UPDATE_EXISTING_ROUTE', e[0] + ' — declared an UPDATE of the same route');
    eq([headers().length, lines().length], [1, 1], e[0] + ' — row counts UNCHANGED (§12.18)');
    eq([r.allocation_draft_id, r.allocation_draft_line_id], [idH, idL], e[0] + ' — the SAME entity identities (§12.19)');
  });
  var ln = lines()[0];
  eq(Number(ln.planned_qty), 650, 'U7a the quantity edit landed on that one line');
  eq(String(ln.allocation_draft_id), idH, 'U7b and its FK still names the same header (§12.19)');
  var hd = headers()[0];
  eq([String(hd.recommended_source_warehouse_id), String(hd.recommended_shipping_method), String(hd.destination_marketplace)],
    ['WH-CN-OTHER', 'sea_express', 'Amazon'], 'U8  every edited dimension is stored on the SAME header row');
  ok(Number(hd.draft_version) > 1, 'U9  §5 draft_version advanced with the updates (' + hd.draft_version + ')');
  ok(String(hd.allocation_draft_id) !== sadK2DeterministicHeaderId_(hd),
    'U10 §4 the entity id no longer hashes to its own fields — EXPECTED, and not corruption');
})();

// ================================================================================================================
section('§12.8–§12.9 / ADDENDUM §3 — ADD ROUTE CREATES ITS OWN INSTANCE, AND ONLY THAT');
// ================================================================================================================
(function () {
  resetDb();
  var a = route({ shipping_method: 'sea', planned_qty: 800, qty: 800 });
  var b = route({ shipping_method: 'air', destination_marketplace: '', destination_warehouse_id: 'WH-WINIT-US',
    destination_warehouse_code: 'WINITUS', planned_qty: 800, qty: 800 });
  saveOne(a); saveOne(b);
  eq([headers().length, lines().length], [2, 2], 'A1  two routes are two headers and two lines');
  var before = { h: headers().length, l: lines().length, q: lines().map(function (l) { return Number(l.planned_qty); }).sort() };

  // The live event: + Add Route, third row, CN Youxin -> Amazon / air / 120.
  var c = route({ shipping_method: 'air', planned_qty: 120, qty: 120 });
  var s = saveOne(c);
  ok(s.ok, 'A2  ADDENDUM §1 the third route saves on its own');
  eq(s.intent, 'CREATE_NEW_ROUTE', 'A2a as a CREATE of the instance that was added');
  eq([headers().length, lines().length], [3, 3], 'A3  §12.8 exactly ONE new header and ONE new line');
  eq(lines().map(function (l) { return Number(l.planned_qty); }).sort(function (x, y) { return x - y; }), [120, 800, 800],
    'A4  ADDENDUM §8 the new 120 exists and NEITHER existing 800 was rewritten');
  eq(before.q, [800, 800], 'A4a (the two 800s were the state before the Add Route)');

  // §12.9 — editing that same row again is an UPDATE, forever.
  c.planned_qty = 150; c.qty = 150;
  var s2 = saveOne(c);
  eq(s2.intent, 'UPDATE_EXISTING_ROUTE', 'A5  §12.9 the second edit of a newly-created row is an UPDATE');
  eq([headers().length, lines().length], [3, 3], 'A5a and creates nothing');
  eq(lines().map(function (l) { return Number(l.planned_qty); }).sort(function (x, y) { return x - y; }), [150, 800, 800],
    'A5b only its own quantity moved');
})();

// ================================================================================================================
section('§12.10–§12.11 / §6 / ADDENDUM §4 — REPLAY, AND THE COLLISION THAT MAKES IT SAFE');
// ================================================================================================================
(function () {
  resetDb();
  var a = route({});
  saveOne(a);
  eq([headers().length, lines().length], [1, 1], 'C0  one route stored');

  // F1-7N-FB-4G-A2-R3 §B.2 — REVERSED, and this reversal is why A2-R3 exists.
  //
  // A2-R2 relied on a K2/K4 collision refusal to stop a retried CREATE from duplicating: the shipment group
  // was already owned, so the retry was refused with zero writes. A2-R3 §B.2 settles that an explicit
  // + Add Route is ALWAYS a new ticket even with identical From / To / Method, so that refusal was BLOCKING A
  // LEGITIMATE SECOND CLICK and had to go. Measured with it gone: the same create key sent twice produced two
  // headers. The collision refusal was never real idempotency - it could not tell a retry from a second click,
  // because nothing about the key was stored.
  //
  // So this writer now creates a second ticket, and that is CORRECT for a second click and WRONG for a retry -
  // which is exactly why the route path moved to the atomic writer, where the create key is persisted and a
  // retry returns the original ids with zero writes. That is asserted in the A2-R3 suite (F2/F2d).
  var lost = route({});                     // same natural route, no adopted ids
  var r = saveOne(lost);
  ok(r.ok, 'C1  §B.2 an identical route sent as a CREATE is no longer refused');
  eq([headers().length, lines().length], [2, 2], 'C1a it becomes a SECOND ticket, which a second click must be');
  ok(r.draftId !== a.allocation_draft_id, 'C1b with its own identity, never a reuse of the first');
  ok(!/ROUTE_IDENTITY_CONFLICT/.test(JSON.stringify(r)),
    'C1c and no natural-key collision verdict survives anywhere in the response');

  // §12.11 — an UPDATE replayed is idempotent by identity: same id, same values, same row.
  var v1 = String(headers()[0].draft_version);
  var u1 = saveOne(a); var afterFirst = { h: headers().length, l: lines().length };
  var u2 = saveOne(a);
  ok(u1.ok && u2.ok, 'C2  §12.11 an UPDATE can be replayed');
  eq([headers().length, lines().length], [afterFirst.h, afterFirst.l], 'C2a adding no row');
  eq(lines()[0].allocation_draft_line_id, a.allocation_draft_line_id, 'C2b and keeping the same line identity');

  // F1-7N-FB-4G-A2-R3 §B.2 / §I.3 — REVERSED for the same reason. A state an explicit Add Route may create
  // cannot be one an edit is forbidden to reach, and a ticket's identity is its immutable allocation_draft_id,
  // never its K4 shape. The contender is REPORTED (shares_route_shape_with) rather than refused, and no ticket
  // is merged or moved either way.
  var hBefore = headers().length;
  var b = route({ shipping_method: 'air' });
  saveOne(b);
  var bId = b.allocation_draft_id;
  b.shipping_method = 'sea';                                     // now shares route a's shape
  var col = saveOne(b);
  ok(col.ok, 'C3  §B.2 an UPDATE onto a shape another ticket already holds is allowed');
  eq(b.allocation_draft_id, bId, 'C3a and it is still the SAME ticket - no re-key, no new票');
  eq(headers().length, hBefore + 1, 'C3b nothing was created and nothing was merged');
  ok(!/ROUTE_IDENTITY_CONFLICT/.test(JSON.stringify(col)), 'C3c no collision verdict is returned');
})();

// ================================================================================================================
section('§12.12–§12.16 — EVERY REFUSAL IS A ZERO WRITE');
// ================================================================================================================
(function () {
  resetDb();
  var a = route({});
  saveOne(a);
  function counts() { return [headers().length, lines().length]; }

  // §12.13 stale version
  var stale = JSON.parse(JSON.stringify(a)); stale.draft_version = '99';
  var s = saveOne(stale);
  eq([s.ok, s.res.code, s.res.zero_write], [false, 'STALE_OPTIMISTIC_TOKEN', true], 'Z1  §12.13 a stale draft_version is a zero write');
  eq(counts(), [1, 1], 'Z1a the table is untouched');

  // §12.15 wrong-scope id
  var wrong = JSON.parse(JSON.stringify(a));
  var res = sadUpsertDraftHeaderCore_({ intent: 'UPDATE_EXISTING_ROUTE', allocation_draft_id: a.allocation_draft_id,
    applied_scope_key: 'restw|jp|amazon', company: 'ResTW', country: 'JP', marketplace: 'Amazon',
    recommended_source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon', recommended_shipping_method: 'sea' });
  eq([res.success, res.code, res.zero_write], [false, 'APPLIED_SCOPE_MISMATCH', true], 'Z2  §12.15 a wrong-scope id is a zero write');
  eq(counts(), [1, 1], 'Z2a the table is untouched');

  // §12.14 terminal header
  var sh = SHEETS['shipping_allocation_drafts'];
  var cStatus = sh.rows[0].indexOf('status');
  sh.rows[1][cStatus] = 'submitted';
  var t = saveOne(a);
  eq([t.ok, t.res.code, t.res.zero_write], [false, 'IMMUTABLE_TERMINAL_STATUS', true], 'Z3  §12.14 a terminal header is a zero write');
  sh.rows[1][cStatus] = 'draft';

  // §12.12 an UPDATE naming a row that does not exist NEVER falls back to CREATE
  var ghost = route({ allocation_draft_id: 'SADH-K2-DOESNOTEXIST', allocation_draft_line_id: 'SADL-K2-GHOST' });
  var g = saveOne(ghost);
  eq([g.ok, g.res.code, g.res.zero_write], [false, 'ALLOCATION_DRAFT_NOT_FOUND', true],
    'Z4  §12.18 an UPDATE whose row is missing is REFUSED — it never falls back to CREATE');
  eq(counts(), [1, 1], 'Z4a and creates nothing');

  // §2 a missing or contradictory intent
  var noIntent = sadUpsertDraftHeaderCore_({ company: 'ResUS', country: 'US', marketplace: 'Amazon',
    recommended_source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon', recommended_shipping_method: 'sea' });
  eq([noIntent.success, noIntent.code, noIntent.zero_write], [false, 'ROUTE_INTENT_REQUIRED', true],
    'Z5  §2 a route write with NO declared intent is refused, zero write');
  var badUpd = sadUpsertDraftHeaderCore_({ intent: 'UPDATE_EXISTING_ROUTE', company: 'ResUS', country: 'US',
    marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon',
    recommended_shipping_method: 'sea' });
  eq([badUpd.success, badUpd.code], [false, 'ROUTE_INTENT_CONTRADICTORY'], 'Z6  §2 UPDATE with no id is contradictory');
  var badCre = sadUpsertDraftHeaderCore_({ intent: 'CREATE_NEW_ROUTE', allocation_draft_id: a.allocation_draft_id,
    company: 'ResUS', country: 'US', marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-CN-YOUXIN',
    destination_marketplace: 'Amazon', recommended_shipping_method: 'sea' });
  eq([badCre.success, badCre.code], [false, 'ROUTE_INTENT_CONTRADICTORY'], 'Z7  §2 CREATE naming an existing id is contradictory');
  var adopt = sadUpsertDraftHeaderCore_({ intent: 'CREATE_NEW_ROUTE', allow_legacy_reconcile: true,
    company: 'ResUS', country: 'US', marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-CN-NEW',
    destination_marketplace: 'Amazon', recommended_shipping_method: 'air' });
  eq([adopt.success, adopt.code], [false, 'ROUTE_INTENT_CONTRADICTORY'],
    'Z8  §4/ADDENDUM §4 an explicit Add Route may NEVER carry adoption authority');
  eq(counts(), [1, 1], 'Z9  §12 every refusal above left the tables exactly as they were');
})();

// ================================================================================================================
section('ADDENDUM §4 — AN ADD ROUTE NEVER ADOPTS A ZERO-LINE LEGACY HEADER');
// ================================================================================================================
(function () {
  resetDb();
  // The live H1/H2 shape: an ACTIVE header of this station with a legacy id and no complete route.
  procurementAppendByHeader_(SHEETS['shipping_allocation_drafts'], {
    allocation_draft_id: 'SAD-C787D1B1-D', planning_cycle: '', source_page: 'inventory_replenishment',
    company: 'ResUS', country: 'US', marketplace: 'Amazon', status: 'draft',
    recommended_source_warehouse_id: '', recommended_destination_warehouse_id: '',
    recommended_shipping_method: 'sea_express', destination_marketplace: '',
    generation_type: 'user_created', draft_version: '1',
    created_by: 'x', created_at: __now, updated_by: 'x', updated_at: __now
  });
  eq(headers().length, 1, 'G0  the zero-line legacy header is in place');
  var legacyReason = sadLegacyReconcileReason_(SHEETS['shipping_allocation_drafts'],
    procurementFindRow_(SHEETS['shipping_allocation_drafts'], 'allocation_draft_id', 'SAD-C787D1B1-D'), false, null);
  eq(legacyReason, 'LEGACY_ROUTE_RECONCILIATION_REQUIRED',
    'G1  ADDENDUM §1 this is exactly the header shape whose adoption produced LEGACY_ROUTE_RECONCILIATION_REQUIRED');

  var c = route({ shipping_method: 'sea_express', planned_qty: 120, qty: 120 });
  var s = saveOne(c);
  ok(s.ok, 'G2  ADDENDUM §4 the Add Route now SUCCEEDS instead of trying to adopt it');
  eq(headers().length, 2, 'G2a creating its OWN new header beside the legacy one');
  ok(String(c.allocation_draft_id) !== 'SAD-C787D1B1-D', 'G2b and it is NOT the legacy header (' + c.allocation_draft_id + ')');
  var legacyAfter = headers().filter(function (h) { return String(h.allocation_draft_id) === 'SAD-C787D1B1-D'; })[0];
  eq([String(legacyAfter.status), String(legacyAfter.recommended_shipping_method), String(legacyAfter.draft_version)],
    ['draft', 'sea_express', '1'], 'G3  ADDENDUM §8 the legacy header was NOT adopted and NOT modified');
  eq(lines().filter(function (l) { return String(l.allocation_draft_id) === 'SAD-C787D1B1-D'; }).length, 0,
    'G4  ADDENDUM §5 and no line was placed under it');
})();

// ================================================================================================================
section('ADDENDUM §3/§7 — EVENT SCOPE: ONE UI EVENT SENDS ONE ROUTE');
// ================================================================================================================
(function () {
  var save = code(extractFn(PAGE, '_saveAllocationDraftFromDom'));
  ok(/_irMarkRouteTouched_/.test(save) && /_irRouteSignature_/.test(save),
    'E1  ADDENDUM §3 the collect marks only the instances whose persistable signature actually changed');
  ok(/data-route-instance/.test(save) && /_newRouteInstanceId\(\)/.test(save),
    'E2  §6 every DOM row carries a stable route instance id, minted once');
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  ok(/_irTouchedInstances_\(sku\)/.test(flush) && /_touchedSet\[String\(r\.client_route_instance_id/.test(flush),
    'E3  ADDENDUM §3 the writer sends only the touched instances, never the whole SKU');
  ok(/_irMultiLineHeaderBlock_/.test(flush), 'E4  §7 and a multi-line header edit is blocked before any request');

  // The diff is what makes it true. An unchanged route has an identical signature.
  var sigFn = new Function('IR_ROUTE_PERSISTABLE_FIELDS',
    extractFn(PAGE, '_irRouteSignature_') + ' return _irRouteSignature_;')(
      JSON.parse('["source_warehouse_id","destination_warehouse_id","destination_marketplace","shipping_method","last_mile_delivery","qty","units_per_carton","recommendation_group_no","override_reason","note","window_code","site_sku"]'));
  var p = route({}), q = route({});
  eq(sigFn(p), sigFn(q), 'E5  ADDENDUM §3 two routes with identical persistable fields have the same signature (not re-sent)');
  q.qty = 500;
  ok(sigFn(p) !== sigFn(q), 'E5a and a real edit changes it');
  var disp = route({}); disp.ship_from = 'A DIFFERENT LABEL'; disp.destination = 'RELABELLED';
  eq(sigFn(route({})), sigFn(disp), 'E5b while a display-only relabel does NOT — a re-render is not an edit');

  // §6 — correlation by instance, never by array position.
  var env = code(extractFn(PAGE, '_irMultiRouteOutcomeEnvelope_'));
  ok(/o\.instanceIds/.test(env) && /o\.intent/.test(env),
    'E6  §6 every reported outcome names the route INSTANCE and the intent it was issued under');
  var persist = code(extractFn(PAGE, '_irPersistOneRouteGroup_'));
  ok(/instanceIds: _instanceIds/.test(persist),
    'E6a and the writer attaches those instance ids to the persisted AND the failed outcome');
  ok(/ROUTE_IDENTITY_AMBIGUOUS/.test(persist),
    'E7  a group carrying two different stored ids is refused rather than resolved by picking one');
})();

// ================================================================================================================
section('§7 / §12.17 — A MULTI-LINE HEADER IS DISCLOSED OR BLOCKED, NEVER SILENTLY RE-ROUTED');
// ================================================================================================================
(function () {
  var blockFn = code(extractFn(PAGE, '_irMultiLineHeaderBlock_'));
  ok(/affected_skus/.test(blockFn) && /affected_lines/.test(blockFn),
    'M1  §7 the block DISCLOSES how many SKUs and which lines a header-level edit would move');
  ok(/MULTI_LINE_HEADER_EDIT_BLOCKED/.test(blockFn), 'M1a under a named code');
  ok(/MOVE_LINE|SPLIT_ROUTE|separate operation/.test(blockFn),
    'M1b and says the intended operation is a separate one, rather than improvising a split (§7)');

  // Executed: a header shared by two SKUs, edited on a header-level dimension.
  var replenAllocationDraft = { context: SCOPE, bySku: {
    'CO1100-R': [{ client_route_instance_id: 'CRI-1', allocation_draft_id: 'SADH-SHARED', allocation_draft_line_id: 'L1',
      route_group_key: 'STORED|KEY', source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon',
      shipping_method: 'air', qty: 100 }],
    'CO1150-N': [{ client_route_instance_id: 'CRI-2', allocation_draft_id: 'SADH-SHARED', allocation_draft_line_id: 'L2',
      source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon', shipping_method: 'air', qty: 120 }]
  } };
  var _replenCtx = function () { return SCOPE; };
  var windowStub = { IRDraft: IRDraft };
  var fn = new Function('replenAllocationDraft', '_replenCtx', 'window',
    extractFn(PAGE, '_irMultiLineHeaderBlock_') + ' return _irMultiLineHeaderBlock_;')(
      replenAllocationDraft, _replenCtx, windowStub);
  var target = replenAllocationDraft['CO1100-R'] ? null : replenAllocationDraft.bySku['CO1100-R'][0];
  var got = fn('CO1100-R', [target]);
  ok(!!got && got.structured.code === 'MULTI_LINE_HEADER_EDIT_BLOCKED',
    'M2  §7 a header-level edit on a header ANOTHER SKU shares is BLOCKED');
  eq(got.structured.affected_skus, ['CO1150-N'], 'M2a naming the SKU the operator cannot see');
  eq(got.structured.affected_lines.length, 1, 'M2b and the line it would have moved');
  // The sole-line case must NOT block: there is nothing hidden to disclose.
  delete replenAllocationDraft.bySku['CO1150-N'];
  eq(fn('CO1100-R', [target]), null, 'M3  §7 a header with only this line is edited normally — no false block');
})();

// ================================================================================================================
section('§11 — THE A2 / A2-R1 SUBMIT PREFLIGHT RESTS ON THE CORRECTED RULES');
// ================================================================================================================
(function () {
  var sub = code(extractFn(PAGE, 'submitReplenishmentPlans'));
  ok(!/_irFlushPendingRouteWritesForSubmit_\(|_flushDraftDbPersist\(|_scheduleDraftDbPersist\(/.test(sub),
    'S1  §11 Submit does not trigger a Save (A2-R1 §3), and reaches no writer at all');
  ok(/_irSubmitPreflight_\(\)/.test(sub) && sub.indexOf('_irSubmitPreflight_()') < sub.indexOf('_replenCanonicalSubmit('),
    'S2  §11 one preflight decides before any request');
  ok(/_pf\.candidate\.draftIds/.test(sub), 'S3  §11 the submitted selection is the preflight candidate set');
  ok(/buildConfirmation\(_pf, _qv\)/.test(sub) && /if \(!_conf\) \{/.test(sub),
    'S4  §11 the confirmation is built from the persisted candidate and is REQUIRED, never skipped');
  ok(sub.indexOf('buildConfirmation') < sub.indexOf('_replenSubmitExecutionKey()'),
    'S5  §11 and the execution key is minted only after it');

  // A dirty or unpersisted route blocks the whole Submit; the clean route beside it is NOT sent alone.
  var base = { scope: SCOPE, appliedScopeKey: SCOPE_KEY, pendingWrites: [], inFlightWrites: [], dirtyAfterWrite: [],
    pendingCancels: [], saveFailed: [], panels: [{ sku: SKU, execState: 'READY' }], routesMissingDestination: [],
    duplicateCorruption: [], zeroLineHeaderCount: 0,
    routes: [{ sku: SKU, scopeKey: SCOPE_KEY, allocation_draft_id: 'SADH-1', allocation_draft_line_id: 'SADL-1',
      qty: 800, complete: true, shipping_method: 'sea', destination_type: 'MARKETPLACE', destination_code: 'Amazon' }] };
  var clean = PF.evaluate(base);
  eq([clean.ok, clean.candidate.totalQty], [true, 800], 'S6  §11 a persisted, updated route IS a candidate');
  var withUnsaved = JSON.parse(JSON.stringify(base));
  // F1-7N-FC-1B-E1 — the operator's own + Add Route row, declared as such because the live snapshot
  // declares it. The invariant is unchanged (it blocks the WHOLE Submit); what the declaration buys is the
  // USEFUL refusal — "finish it or wait for the save" rather than "this row should not exist", which is
  // reserved for a row nobody created.
  withUnsaved.routes.push({ sku: SKU, scopeKey: SCOPE_KEY, allocation_draft_id: '', allocation_draft_line_id: '',
    qty: 120, complete: true, shipping_method: 'air', destination_type: 'MARKETPLACE', destination_code: 'Amazon',
    route_provenance: 'USER_EXPLICIT_ADD_ROUTE' });
  var dirty = PF.evaluate(withUnsaved);
  eq([dirty.ok, dirty.code], [false, 'UNSAVED_EXECUTION_PLAN_CHANGES'], 'S7  §11 an unsaved route blocks the WHOLE Submit');
  eq(dirty.candidate.draftIds, [], 'S7a and the clean 800 beside it is not submitted alone');
  eq(PF.buildConfirmation(dirty, {}), null, 'S7b no confirmation can be built from it');

  // §11 — accidental duplicate headers must not be submitted together. Two persisted routes that are the SAME
  // shipment group are a contested identity, and the client refuses rather than sending both.
  var dup = JSON.parse(JSON.stringify(base));
  dup.duplicateCorruption = [{ sku: SKU, allocation_draft_line_id: 'SADL-1', physical_rows: 2 }];
  eq(PF.evaluate(dup).code, 'DUPLICATE_LINE_IDENTITY', 'S8  §11 a contested stored identity yields zero request');
})();

// ================================================================================================================
section('§10 / ADDENDUM §5 — THE READ-ONLY CENSUS');
// ================================================================================================================
(function () {
  eq((TEMP.match(/^function TEMP_[A-Z0-9_]+\(/gm) || []).length, 1, 'T1  §10 exactly ONE entry point');
  ok(/function TEMP_ROUTE_IDENTITY_CENSUS_A2_R2\(\)/.test(TEMP), 'T1a taking no parameters');
  ['SADH-K2-E7AF9242', 'SADH-K2-179FBB0E', 'SADH-K2-C3E2031A', 'SAD-C787D1B1-D', 'SAD-27976058-2'].forEach(function (id) {
    ok(TEMP.indexOf(id) !== -1, 'T2  ADDENDUM §5 it censuses ' + id);
  });
  ok(/CO1100-R/.test(TEMP), 'T2a and every CO1100-R line');
  var t = code(TEMP);
  ['setValue', 'appendRow', 'deleteRow', 'setValues', 'getScriptLock', 'PropertiesService', 'DriveApp',
    'MailApp', 'GmailApp', 'clearContent', 'insertSheet', 'getUuid'].forEach(function (bad) {
    ok(t.indexOf(bad) === -1, 'T3  §10 the census cannot ' + bad + ' — the symbol is absent');
  });
  ok(/getDataRange: function \(\) \{ return \{ getValues/.test(TEMP),
    'T4  §10 every sheet is wrapped in a façade exposing ONLY getDataRange().getValues()');
  ok(/AUTHORITY_NOT_LOADED/.test(TEMP) && /BLOCKED/.test(TEMP),
    'T5  §10 a missing production authority prints AUTHORITY_NOT_LOADED / BLOCKED rather than guessing');
  ok(/UNKNOWN/.test(TEMP), 'T6  §10 and what it cannot determine is printed UNKNOWN');
  ok(/DB_WRITES=0/.test(TEMP) && /ROWS_INSERTED=0/.test(TEMP) && /CELLS_WRITTEN=0/.test(TEMP),
    'T7  §12.21 it declares DB_WRITES=0');
  ok(/planned_qty of 120/.test(TEMP) && /Were the two 800s rewritten/.test(TEMP),
    'T8  ADDENDUM §5 it answers the 120 and 800 questions from cells');
  ok(/zero-line legacy header/.test(TEMP), 'T8a and whether a line sits under a zero-line legacy header');
  ok(/NOT evidence of corruption/.test(TEMP),
    'T9  §4 it REPORTS an id that no longer hashes to its fields without calling it corruption');
  ok(/NO REPAIR WAS PERFORMED AND NONE IS AUTHORISED/.test(TEMP), 'T10 §10 and authorises no repair');
})();

// ================================================================================================================
section('§13 — DEPLOYMENT');
// ================================================================================================================
(function () {
  var stamp = (G16.match(/var SAD_BUILD_VERSION_ = '([^']+)'/) || [])[1];
  // F1-7N-FB-4G-A2-R3 - RESTATED. A round pinning its OWN stamp as an equality is the tenth appearance
  // of that shape here, and it is false the moment a later round legitimately moves the server (A2-R3
  // does). The durable claim is a FLOOR: 16_ carries A2-R2's change or something after it.
  ok(RO.stampAtOrAfter(stamp, 'F1-7N-FB-4G-A2-R2'),
    'D1  §13 the 16_ owner stamp is at or after A2-R2');
  var expects = G63.match(/symbol: 'SAD_BUILD_VERSION_', expected: '([^']+)'/);
  eq(expects && expects[1], stamp, 'D2  §13 and the health manifest expects exactly what the source declares');
  // The durable form: whatever the source declares, the manifest expects it in EXACTLY ONE place.
  // RESTATED (A2-R1-R5): this counted the STAMP STRING, and after R5 rotated the stamps that had never been
  // rotated, two owner files that legitimately last changed in the same round now share one expectation
  // string. What must appear exactly once is the entry for this SYMBOL.
  eq((G63.match(/symbol: 'SAD_BUILD_VERSION_'/g) || []).length, 1,
    'D2a and the manifest carries exactly ONE entry for this symbol');
  ok(RO.stampAtOrAfter(stamp, 'F1-7N-FB-4G-A2'), 'D3  §13 and it is at or after A2');
  var APP = RO.currentAppToken();
  // Same shape, same restatement: the token series is append-only, so at-or-after is the durable claim.
  ok(RO.tokenAtOrAfter(APP, 'fb4ga2r2-routeintent-20260902'),
    'D4  §13 the application cache token is at or after this round');
  // RESTATED (F1-7N-FC-1A-R1-HF1): this was `=== 18`. The count is not the property — "rotated TOGETHER"
  // is — and the literal made a round that covers one more asset look like a half-updated deployment. Now
  // derived: no entry is left behind on a superseded application token. See _release-order.js staleAppTokenRefs.
  eq(RO.staleAppTokenRefs(INDEX).join(' | '), '',
    'D4a and the co-deployed set rotated TOGETHER (' + RO.appTokenRefCount(INDEX) + ' refs on ' + APP + ')');
  eq(INDEX.indexOf('fb4ga2-submitpreflight-20260902'), -1, 'D4b and the previous token is fully retired');
  ok(RO.tokenAtOrAfter(APP, 'fb4ga2-submitpreflight-20260902'), 'D4c ordered after it in the append-only series');
  // The bundle ports only assets/js/core modules; neither file this round changes is one.
  var order = read('assets/tools/build-apps-script-bundle.js');
  ok(!/inventory-compat|inventory-replenishment/.test(order),
    'D5  §13 no bundled module changed, so BUNDLE_REBUILD_REQUIRED stays NO');
})();

// ================================================================================================================
section('MUTATIONS — each applied for real, each caught');
// ================================================================================================================

mut('X1  §12 the intent is dropped from the payload builder', function () {
  var m = mutateFn(CMPSRC, 'buildDraftHeaderPayload',
    "if (ctx.intent === 'UPDATE_EXISTING_ROUTE' || ctx.intent === 'CREATE_NEW_ROUTE') p.intent = ctx.intent;", '');
  var M = moduleFrom(m).IRDraft;
  // A COMPLETE route, or the completeness gate refuses first and the probe never reaches the intent gate.
  var full = { source_warehouse_id: 'WH-CN-YOUXIN', destination_marketplace: 'Amazon', shipping_method: 'sea',
    company: 'ResUS', country: 'US', marketplace: 'Amazon' };
  var withIntent = JSON.parse(JSON.stringify(full)); withIntent.intent = 'CREATE_NEW_ROUTE';
  var h = IRDraft.buildDraftHeaderPayload(withIntent);
  var x = M.buildDraftHeaderPayload(withIntent);
  // And the server must refuse the intentless payload with zero writes.
  resetDb();
  var res = sadUpsertDraftHeaderCore_(x);
  return h.intent === 'CREATE_NEW_ROUTE' && x.intent === undefined &&
         res.success === false && res.code === 'ROUTE_INTENT_REQUIRED' && headers().length === 0;
});

mut('X2  §2 an UPDATE that finds no row falls back to CREATE', function () {
  var m = mutateFn(G16, 'sadUpsertDraftHeaderCore_',
    "      return { success: false, error: 'ALLOCATION_DRAFT_NOT_FOUND', code: 'ALLOCATION_DRAFT_NOT_FOUND', stage: 'validation',\n        zero_write: true, data: { allocation_draft_id: id } };",
    "      id = ''; found = null;");
  var honest = code(extractFn(G16, 'sadUpsertDraftHeaderCore_'));
  var mutated = code(extractFn(m, 'sadUpsertDraftHeaderCore_'));
  return /ALLOCATION_DRAFT_NOT_FOUND/.test(honest) && !/ALLOCATION_DRAFT_NOT_FOUND/.test(mutated);
});

mut('X3  §4 an UPDATE re-mints the header id from the natural key', function () {
  resetDb();
  var a = route({});
  saveOne(a);
  var idBefore = a.allocation_draft_id;
  a.shipping_method = 'air';
  saveOne(a);
  var idAfter = a.allocation_draft_id;
  var stored = headers()[0];
  // The honest writer keeps the entity id; a re-minting one would move it to the new key's hash.
  return idAfter === idBefore && String(stored.allocation_draft_id) === idBefore &&
         sadK2DeterministicHeaderId_(stored) !== idBefore;
});

mut('X4  §4 an UPDATE re-mints the line id', function () {
  resetDb();
  var a = route({});
  saveOne(a);
  var lineBefore = a.allocation_draft_line_id;
  a.planned_qty = 400; a.qty = 400;
  saveOne(a);
  return a.allocation_draft_line_id === lineBefore && lines().length === 1 &&
         String(lines()[0].allocation_draft_line_id) === lineBefore;
});

// F1-7N-FB-4G-A2-R3 §B.2 - RE-ANCHORED, because the rule it probed was WITHDRAWN. A2-R2 REFUSED an UPDATE that
// moved a ticket onto a shape another active header held; §B.2 makes two identical tickets legal, so a refusal
// there contradicted the frozen premise and blocked a legal edit. What survives is that the contender is still
// detected and REPORTED - silently dropping it would hide a real fact - so that is what this mutation removes.
mut('X5  §B.2 a shared route shape is detected but never reported', function () {
  var m = mutateFn(G16, 'sadUpsertDraftHeaderCore_',
    "      shares_route_shape_with: uContender || '',", "");
  var honest = code(extractFn(G16, 'sadUpsertDraftHeaderCore_'));
  var mutated = code(extractFn(m, 'sadUpsertDraftHeaderCore_'));
  return /shares_route_shape_with: uContender/.test(honest) &&
         !/shares_route_shape_with: uContender/.test(mutated) &&
         !/ROUTE_IDENTITY_CONFLICT/.test(honest) &&
         /if \(uContender\) return;/.test(honest);
});

mut('X6  §5 a stale draft_version is written anyway', function () {
  var m = mutateFn(G16, 'sadUpsertDraftHeaderCore_',
    "        sadFpVal_(body.expected_draft_version) !== uPriorVersion) {",
    "        false) {");
  var honest = code(extractFn(G16, 'sadUpsertDraftHeaderCore_'));
  var mutated = code(extractFn(m, 'sadUpsertDraftHeaderCore_'));
  return /STALE_OPTIMISTIC_TOKEN/.test(honest) &&
         /sadFpVal_\(body\.expected_draft_version\) !== uPriorVersion/.test(honest) &&
         !/sadFpVal_\(body\.expected_draft_version\) !== uPriorVersion/.test(mutated);
});

mut('X7  §7 a multi-line header is updated silently', function () {
  var m = mutateFn(PAGE, '_flushDraftDbPersist',
    "        if (_mlBlock) {", "        if (false) {");
  var honest = code(extractFn(PAGE, '_flushDraftDbPersist'));
  var mutated = code(extractFn(m, '_flushDraftDbPersist'));
  return /if \(_mlBlock\)/.test(honest) && !/if \(_mlBlock\)/.test(mutated);
});

mut('X8  ADDENDUM §4 an Add Route adopts a zero-line legacy header', function () {
  var m = mutateFn(G16, 'sadUpsertDraftHeaderCore_',
  // RE-ANCHORED on ONE line: the two-line span this used included `var cKey = sadK2GroupKey_(body);`, which
  // the §B.2 rewrite removed along with the collision refusal.
    "  if (sadIntent === 'CREATE_NEW_ROUTE' && hasRouteIntent && status !== 'cancelled') {",
    "  if (false) {");
  var honest = code(extractFn(G16, 'sadUpsertDraftHeaderCore_'));
  var mutated = code(extractFn(m, 'sadUpsertDraftHeaderCore_'));
  // With the CREATE branch disabled the natural-key resolver runs again, which is the adoption path.
  return /sadIntent === 'CREATE_NEW_ROUTE' && hasRouteIntent/.test(honest) &&
         !/sadIntent === 'CREATE_NEW_ROUTE' && hasRouteIntent/.test(mutated) &&
         /sadResolveActiveDraftK2OrK3_/.test(mutated);
});

mut('X9  ADDENDUM §3 a single-row event re-sends the whole route group', function () {
  var m = mutateFn(PAGE, '_flushDraftDbPersist',
    // RESTATED AGAIN (R6-R6-R2): the anchor tracked a TWO-BRANCH expression whose second branch — an empty
    // touched set widening to every row on screen — is gone. There is one branch now, which is what makes
    // ADDENDUM SECTN3's property unconditional rather than true-unless-nobody-marked-anything. The mutation
    // is the same one it always was: take the scope back to every row.
    "        var _scoped = rows\n            .filter(function (r) { return _touchedSet[String(r.client_route_instance_id || '')]; })",
    "        var _scoped = rows\n            .filter(function (r) { return true; })");
  var honest = code(extractFn(PAGE, '_flushDraftDbPersist'));
  var mutated = code(extractFn(m, '_flushDraftDbPersist'));
  return /_touchedSet\[String\(r\.client_route_instance_id/.test(honest) &&
         !/_touchedSet\[String\(r\.client_route_instance_id/.test(mutated);
});

mut('X10 ADDENDUM §3 the touched set is marked for every row, not only the changed ones', function () {
  var m = mutateFn(PAGE, '_saveAllocationDraftFromDom',
    "        if (changed || (unpersisted && _isRouteComplete(r))) _irMarkRouteTouched_(sku, r.client_route_instance_id);",
    "        _irMarkRouteTouched_(sku, r.client_route_instance_id);");
  var honest = code(extractFn(PAGE, '_saveAllocationDraftFromDom'));
  var mutated = code(extractFn(m, '_saveAllocationDraftFromDom'));
  return /if \(changed \|\| \(unpersisted && _isRouteComplete\(r\)\)\)/.test(honest) &&
         !/if \(changed \|\| \(unpersisted && _isRouteComplete\(r\)\)\)/.test(mutated);
});

mut('X11 §6 outcomes are correlated by array position instead of route instance', function () {
  var m = mutateFn(PAGE, '_irPersistOneRouteGroup_',
  // RE-ANCHORED on ONE line, and the count is READ from the source rather than remembered: A2-R3 added a
  // THIRD outcome (the fail-closed ROUTE_ATOMIC_WRITER_UNAVAILABLE refusal), and every outcome must name the
  // instance or some result reaches the operator with no way back to the row that caused it.
    "            intent: _intent, instanceIds: _instanceIds,",
    "            intent: _intent,");
  var honest = code(extractFn(PAGE, '_irPersistOneRouteGroup_'));
  var mutated = code(extractFn(m, '_irPersistOneRouteGroup_'));
  var hN = (honest.match(/instanceIds: _instanceIds/g) || []).length;
  return hN >= 2 && (mutated.match(/instanceIds: _instanceIds/g) || []).length === hN - 1;
});

mut('X12 §2/§4 a route edit ERASES the route\'s entity identity again', function () {
  var m = mutateFn(PAGE, '_irQueueStaleGroupCancels_',
    "            r.route_group_key = g.groupKey;",
    "            r.allocation_draft_line_id = ''; r.allocation_draft_id = ''; r.route_group_key = '';");
  function run(src) {
    var pend = {};
    var fn = new Function('_pendingDraftCancels', extractFn(src, '_irQueueStaleGroupCancels_') + ' return _irQueueStaleGroupCancels_;')(pend);
    var r = { allocation_draft_id: 'H', allocation_draft_line_id: 'L', route_group_key: 'OLD' };
    fn('S', [{ groupKey: 'NEW', routes: [r] }]);
    return r.allocation_draft_id;
  }
  return run(PAGE) === 'H' && run(m) === '';
});

mut('X13 §12.18 an UPDATE appends a line instead of updating it', function () {
  resetDb();
  var a = route({});
  saveOne(a);
  var n1 = lines().length;
  a.planned_qty = 111; a.qty = 111;
  saveOne(a);
  // An appending writer would leave two physical rows for one route instance.
  return n1 === 1 && lines().length === 1 && Number(lines()[0].planned_qty) === 111;
});

mut('X14 §12.9 a second edit of a newly-created row CREATEs again', function () {
  resetDb();
  var a = route({});
  var s1 = saveOne(a);
  a.planned_qty = 222; a.qty = 222;
  var s2 = saveOne(a);
  return s1.intent === 'CREATE_NEW_ROUTE' && s2.intent === 'UPDATE_EXISTING_ROUTE' &&
         headers().length === 1 && lines().length === 1;
});

// §12.16 - NOT a mutation. The first form of this applied no change at all and then asserted honest
// behaviour, so its "MUTANT SURVIVED" verdict measured nothing. It is a plain executed test.
(function () {
  resetDb();
  var a = route({});
  saveOne(a);
  // MEASURED, not assumed. The line writer resolves in three steps - explicit primary key, canonical id, then
  // (R6F) the natural key SCOPED TO THIS HEADER. So an id that names no row does not create a duplicate and
  // cannot reach another header's line; it reconciles this header's own line by natural key.
  var ownLine = a.allocation_draft_line_id;
  sadUpsertLinesKeyedCore_({ allocation_draft_id: a.allocation_draft_id,
    lines: [{ allocation_draft_line_id: 'SADL-K2-FOREIGN', sku: SKU, planned_qty: 5, generation_type: 'user_created' }] });
  eq(lines().length, 1, 'X15 §12.16 an unknown line id appends NO second physical row');
  eq(String(lines()[0].allocation_draft_line_id), ownLine,
    'X15a the header keeps its own line identity - the unknown id is not adopted as a new one');
  ok(!/^SADL-K2-FOREIGN$/.test(String(lines()[0].allocation_draft_line_id)),
    'X15b and the foreign id is nowhere in the table');
  var natFallback = code(extractFn(G16, 'sadUpsertLinesKeyedCore_'));
  ok(/sadFindLineByNaturalKey_\(sh, draftId, l\)/.test(natFallback),
    'X15c because the natural-key fallback is SCOPED BY draftId - it can never reach the line of another header');

  // The real §12.16 rule: a supplied line id that names a stored row whose natural key differs is a REFUSAL.
  resetDb();
  var b = route({});
  saveOne(b);
  var before = JSON.stringify(lines());
  var conflict = sadUpsertLinesKeyedCore_({ allocation_draft_id: b.allocation_draft_id,
    lines: [{ allocation_draft_line_id: b.allocation_draft_line_id, sku: SKU, site_sku: 'A-DIFFERENT-SITE-SKU',
      planned_qty: 7, generation_type: 'user_created' }] });
  eq(conflict.success, false, 'X15d §12.16 a line id naming a row of a DIFFERENT natural key is refused');
  ok(/LINE_IDENTITY_CONFLICT/.test(String(conflict.error)), 'X15e with LINE_IDENTITY_CONFLICT');
  eq(JSON.stringify(lines()), before, 'X15f and the table is byte-identical - zero write');
})();

mut('X16 §11 Submit is allowed to save a dirty route again', function () {
  var m = mutateFn(PAGE, 'submitReplenishmentPlans',
    "    var _pf = (typeof _irSubmitPreflight_ === 'function') ? _irSubmitPreflight_()",
    "    try { await _irFlushPendingRouteWritesForSubmit_(); } catch (_e) {}\n    var _pf = (typeof _irSubmitPreflight_ === 'function') ? _irSubmitPreflight_()");
  var honest = code(extractFn(PAGE, 'submitReplenishmentPlans'));
  var mutated = code(extractFn(m, 'submitReplenishmentPlans'));
  return !/_irFlushPendingRouteWritesForSubmit_/.test(honest) && /_irFlushPendingRouteWritesForSubmit_/.test(mutated);
});

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' passed, ' + fail + ' failed, mutations ' +
  neg.caught + ' caught / ' + neg.missed + ' missed');
process.exit(fail ? 1 : 0);
