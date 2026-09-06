// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2-P1 — THE PROOF AN OPERATOR CAN KEEP.
//
// Everything passed. The operator still could not hold on to the evidence:
//
//   Logging output too large. Truncating output.
//
// and r6r7_export was cut in the middle of the parity object, so the three facts an acceptance actually rests
// on — the parity, the legacy authority label and the export completeness — were exactly the ones that fell
// off the end. A verdict a reader cannot keep is not evidence, which is the same principle R6-R7-R2 applied to
// a verdict a reader cannot check.
//
// Apps Script truncates the TAIL, so this round does two things and needs both:
//
//   (1) A BOUNDED PROOF, emitted BEFORE the detailed export. It carries no envelope, no per-scope array, no
//       planned rows, no route snapshots, no harvest, no warehouses, no carrier cards and no blocker prose
//       — every one of those is unbounded, and one of them growing is what puts the line back over the cap.
//
//   (2) THE NESTED DIAGNOSTICS STOP PRINTING THEIR OWN FULL LOGS INTO THIS ONE. That is a suppression, so it
//       is announced and counted, and each nested census still returns all of it when run directly. Solving
//       truncation by quietly dropping evidence would BE the defect.
//
// This is a diagnostic evidence patch. No production logic, no public API, no router, no flag, no allowlist,
// no writer, no data, and no change to the deployment build.
//
// Run: node assets/tests/controlled-ai-plan-compact-proof-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7-r2-p1.test.js

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

// ================================================================================================================
// THE WORLD AND THE PREFLIGHT HELPERS ARE LOADED FROM THE R6-R7-R2 SUITE, NOT COPIED.
//
// Its head builds the world and its projection stub; its body is where the parity contract is proved. A second
// copy of either would let the two suites disagree about what production looks like, which is the class of
// defect both rounds are closing.
// ================================================================================================================
var R2_OF = 'assets/tests/controlled-ai-plan-production-parity-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7-r2.test.js';
var R2_SRC = read(R2_OF).replace(/\r\n/g, '\n');
var CUT = R2_SRC.indexOf('\nsection(\'A ');
if (CUT < 0) throw new Error('the R6-R7-R2 suite no longer opens its assertions with section(); the shared world cannot be located');
var RUNCENSUS = R2_SRC.slice(R2_SRC.indexOf('function runCensus('), R2_SRC.indexOf('var BLOCKED ='));
if (RUNCENSUS.indexOf('function runCensus(') !== 0) throw new Error('runCensus() could not be located in the R6-R7-R2 suite');
var SHARED = (new Function('require', '__dirname', '__filename', 'module', 'exports', 'console',
  R2_SRC.slice(0, CUT) + '\n' + RUNCENSUS
  + '\nreturn { World: World, failed: failed, swap: swap, extractFn: extractFn, extractVar: extractVar,'
  + ' CENSUS: CENSUS, G61: G61, live: live, preflight: preflight, projection: projection,'
  + ' runCensus: runCensus, exported: exported, NLF: NLF, SQ: SQ };'
))(require, __dirname, __filename, module, exports, console);
var World = SHARED.World, failed = SHARED.failed, swap = SHARED.swap;
var extractVar = SHARED.extractVar, extractFn = SHARED.extractFn;
var CENSUS = SHARED.CENSUS, G61 = SHARED.G61;
var live = SHARED.live, preflight = SHARED.preflight, projection = SHARED.projection;
var runCensus = SHARED.runCensus, exported = SHARED.exported;
var NLF = SHARED.NLF, SQ = SHARED.SQ;
// the em dash the census writes into its own log line, so an anchor can quote it exactly
var EM = String.fromCharCode(8212);
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var DEPLOYMENT_BUILD = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';

// The declared shape, in the declared order. A proof that grows a key nobody agreed to is a proof on its way
// back over the cap.
var PROOF_KEYS = ['census', 'build', 'verdict', 'predicates_passed', 'predicates_failed',
  'export_complete', 'export_missing', 'proof_complete', 'proof_missing',
  'db_writes', 'writer_calls', 'writer_constructed', 'submit_calls', 'route_save_calls', 'reservation_writes',
  'current_run', 'recommendation', 'production_path', 'parity', 'legacy_projection', 'manual_routes',
  'stop_reason'];
var MAX_BYTES = vm.runInNewContext(extractVar(CENSUS, 'R6R7_PROOF_MAX_BYTES_') + ' R6R7_PROOF_MAX_BYTES_');

// The log, as the Apps Script editor would show it: labels in the order they were written.
function labels(w) {
  var out = [];
  (w.log || []).forEach(function (l) {
    var m = /^\[E3-CENSUS\] ([A-Za-z0-9_]+):/.exec(String(l));
    if (m) out.push(m[1]);
  });
  return out;
}
function lineOf(w, label) {
  var pre = '[E3-CENSUS] ' + label + ': ', hit = null;
  (w.log || []).forEach(function (l) { if (String(l).indexOf(pre) === 0) hit = String(l).slice(pre.length); });
  return hit;
}
function proofOf(r) { var s = lineOf(r.world, 'r6r7_proof'); return s === null ? null : JSON.parse(s); }
function proofRaw(r) { return lineOf(r.world, 'r6r7_proof'); }

var PF = preflight(live());
var PROOF = proofOf(PF);
var RAW = proofRaw(PF);

// ================================================================================================================
section('A — the line exists, parses, and is the shape that was agreed');
// ================================================================================================================

ok(RAW !== null, 'A1  the preflight emits [E3-CENSUS] r6r7_proof');
ok(PROOF !== null && typeof PROOF === 'object', 'A2  and it parses as one complete JSON object');
eq(JSON.parse(RAW), PROOF, 'A2a a full round trip, so nothing in it was cut');
eq(Object.keys(PROOF), PROOF_KEYS, 'A3  with exactly the declared keys, in the declared order');
eq(Object.keys(PROOF.current_run),
  ['calculation_run_id', 'calculation_date', 'calculation_status', 'freshness_state'],
  'A4  current_run: the four fields that say WHICH evaluation this is');
eq(Object.keys(PROOF.recommendation),
  ['state', 'recommended_qty', 'qualifying_active_planned_qty', 'residual_qty'],
  'A5  recommendation: the state and the three quantities');
eq(Object.keys(PROOF.production_path),
  ['available', 'entry_point', 'decision_source', 'outcome', 'code', 'reason', 'recommendation_state',
    'would_write', 'writer_reached', 'requested_scope_empty_is_bypassed_by_valid_zero'],
  'A6  production_path: ten fields, and no envelope');
eq(Object.keys(PROOF.parity),
  ['wrapper_verdict', 'production_outcome', 'agree', 'production_would_write',
    'wrapper_never_outranks_production'],
  'A7  parity: the five the acceptance is read from');
eq(Object.keys(PROOF.legacy_projection),
  ['projection_class', 'verdict', 'verdict_scope', 'is_production_generation_authority'],
  'A8  legacy_projection: what it is and that it does not speak for production');
eq(Object.keys(PROOF.manual_routes),
  ['row_count', 'planned_total', 'route_a_id', 'route_a_version', 'route_b_id', 'route_b_version'],
  'A9  manual_routes: six scalars, never the snapshots');

// WHAT MUST NOT BE IN IT. Each of these is unbounded, and one of them growing is how the line goes back over
// the cap without anybody changing the proof.
['production_response', 'production_refusal', 'per_scope', 'planned_rows', 'planned_excluded',
 'manual_route_snapshots', 'expected_ai_identities', 'harvest', 'warehousesById', 'rate_cards',
 'carrier_authorities', 'blockers', 'authority', 'predicates', 'disputed_value_provenance'].forEach(function (k, i) {
  ok(RAW.indexOf('"' + k + '"') < 0, 'A10.' + (i + 1) + ' the proof carries no ' + k);
});

// ================================================================================================================
section('B — bounded, on every shape the preflight can answer with');
// ================================================================================================================

eq(MAX_BYTES, 4096, 'B1  the declared cap');
ok(RAW.length <= MAX_BYTES, 'B2  the live proof is within it (' + RAW.length + ' bytes)');
var META = JSON.parse(lineOf(PF.world, 'r6r7_proof_meta'));
eq(META.bytes, RAW.length, 'B3  and the meta line reports the real size');
eq([META.contract, META.within_bounds, META.max_bytes], ['R6R7-PROOF-V1', true, MAX_BYTES],
  'B3a naming the contract, so a stale census is visible from one line');

var BLOCKED = { gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } };
var RESIDUAL = { gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
  d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } };
[['a refusal', BLOCKED], ['a residual', RESIDUAL],
 ['a stale snapshot', { gap: { calculation_date: '2020-01-01' } }]].forEach(function (c, i) {
  var r = preflight(c[1]), raw = proofRaw(r);
  ok(raw !== null && raw.length <= MAX_BYTES,
    'B4.' + (i + 1) + ' ' + c[0] + ' still fits (' + (raw ? raw.length : -1) + ' bytes)');
  ok(raw !== null && JSON.parse(raw).census === 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT',
    'B4.' + (i + 1) + 'a and still parses');
});

// ================================================================================================================
section('C — it is printed before the detailed export, with nothing unbounded between');
// ================================================================================================================

var LAB = labels(PF.world);
ok(LAB.indexOf('r6r7_proof') >= 0 && LAB.indexOf('r6r7_export') >= 0,
  'C1  both lines are present — the detailed export is kept, not replaced');
ok(LAB.indexOf('r6r7_proof') < LAB.indexOf('r6r7_export'),
  'C2  and the proof comes first, because Apps Script truncates the tail');
eq(LAB.slice(LAB.indexOf('r6r7_proof') + 1, LAB.indexOf('r6r7_export')), ['r6r7_proof_meta'],
  'C3  with only the bounded meta line between them');
ok(LAB.slice(0, LAB.indexOf('r6r7_proof')).every(function (l) {
  return l === 'nested_log_muted' || l === 'r6r7'; }),
  'C4  and nothing unbounded before it');
eq(extractFn(CENSUS, 'CENSUS_r6r7Finish_').indexOf("CENSUS_log_('r6r7_proof', proofLine)")
  < extractFn(CENSUS, 'CENSUS_r6r7Finish_').indexOf("CENSUS_log_('r6r7_export'"), true,
  'C5  which is a source-level ordering, not an accident of this fixture');

// THE GUARDS RUN BEFORE ANY VERDICT IS PRINTED. A success announced one line above a STOP is the ordering
// mistake this file has already made twice.
var FIN = extractFn(CENSUS, 'CENSUS_r6r7Finish_');
ok(FIN.indexOf('CENSUS_r6r7ProofGuard_(out)') < FIN.indexOf("CENSUS_log_('r6r7',"),
  'C6  the proof guard runs before the summary line');
ok(FIN.indexOf('out.export_complete = absent.length === 0;') < FIN.indexOf("CENSUS_log_('r6r7',"),
  'C6a and so does the export guard');

// ================================================================================================================
section('D — the live case, in the line that survives');
// ================================================================================================================

eq(PROOF.verdict, 'READY_NO_ACTION', 'D1  verdict');
eq([PROOF.predicates_passed, PROOF.predicates_failed], [30, 0], 'D2  30 predicates, none failed');
eq([PROOF.export_complete, PROOF.export_missing], [true, []], 'D3  export complete');
eq([PROOF.proof_complete, PROOF.proof_missing], [true, []], 'D4  proof complete');
eq(PROOF.production_path.outcome, 'AI_PLAN_NO_ACTION', 'D5  production outcome');
eq(PROOF.production_path.code, 'NO_REPLENISHMENT_REQUIRED', 'D6  production code');
eq(PROOF.production_path.reason, 'VALID_ZERO_RECOMMENDATION', 'D7  production reason');
eq([PROOF.recommendation.recommended_qty, PROOF.recommendation.qualifying_active_planned_qty,
  PROOF.recommendation.residual_qty], [0, 520, 0], 'D8  recommended 0 / planned 520 / residual 0');
eq([PROOF.production_path.would_write, PROOF.production_path.writer_reached], [false, false],
  'D9  would_write false, writer_reached false');
eq(PROOF.production_path.requested_scope_empty_is_bypassed_by_valid_zero, true,
  'D10 the empty-scope refusal is bypassed by the valid zero');
eq([PROOF.parity.agree, PROOF.parity.production_would_write,
  PROOF.parity.wrapper_never_outranks_production], [true, false, true], 'D11 parity');
eq(PROOF.legacy_projection.is_production_generation_authority, false,
  'D12 the projection does not speak for production');
eq([PROOF.manual_routes.row_count, PROOF.manual_routes.planned_total], [2, 520],
  'D13 two manual rows totalling 520');
eq([PROOF.manual_routes.route_a_version, PROOF.manual_routes.route_b_version], ['4', '3'],
  'D14 at the versions section 0 records');
eq(PROOF.current_run.calculation_status, 'READY', 'D15 the run this was measured against');
eq(PROOF.build, DEPLOYMENT_BUILD, 'D16 and the build it was measured on');

// EVERY MUTATION COUNTER IS ZERO, in the line an operator keeps.
eq([PROOF.db_writes, PROOF.writer_calls, PROOF.writer_constructed, PROOF.submit_calls,
  PROOF.route_save_calls, PROOF.reservation_writes], [0, 0, false, 0, 0, 0],
  'D17 six counters, all zero');
eq(PF.world.dbWrites(), 0, 'D18 measured on the sheets, not reported');

// ================================================================================================================
section('E — the proof\'s own completeness guard');
// ================================================================================================================

// parity dropped after every predicate has read it — the exact shape of the truncation defect: nothing was
// wrong with the check, only with what reached the reader.
var DROP_PARITY = swap(CENSUS,
  "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');",
  "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');" + NLF
  + '  out.parity = null;');
var E1 = runCensus(DROP_PARITY, live()).res;
eq(E1.verdict, 'STOP', 'E1  a missing parity STOPS');
eq(E1.proof_complete, false, 'E1a proof_complete false');
ok(E1.proof_missing.indexOf('parity') >= 0, 'E1b and proof_missing names it');
var E1p = JSON.parse(lineOf(runCensus(DROP_PARITY, live()).world, 'r6r7_proof'));
eq([E1p.verdict, E1p.proof_complete], ['STOP', false],
  'E1c and the proof itself says so — an incomplete proof must be legible in the line that survives');

// production_path with no outcome
var NO_OUTCOME = swap(CENSUS, '  out.outcome = d.outcome;', '  out.outcome = null;');
var E2 = runCensus(NO_OUTCOME, live()).res;
eq(E2.verdict, 'STOP', 'E2  a production path with no outcome STOPS');
ok(E2.proof_missing.indexOf('production_path.outcome') >= 0, 'E2a and proof_missing names it');

// the legacy projection claiming production authority
var E3r = preflight(live(), { is_production_generation_authority: true }).res;
eq(E3r.verdict, 'STOP', 'E3  a projection claiming production authority STOPS');
ok(E3r.proof_missing.indexOf('legacy_projection.is_production_generation_authority') >= 0,
  'E3a and proof_missing names it');

// AND THE ONE THAT IS NOT ABOUT PRESENCE. A run that would write is not a no-action, and a proof asserting
// both at once is the single shape an operator must never be handed as an acceptance.
var CONTRA = swap(CENSUS, '    production_would_write: wouldWrite,', '    production_would_write: true,');
var E4 = runCensus(CONTRA, live()).res;
eq(E4.verdict, 'STOP', 'E4  READY_NO_ACTION beside production_would_write true STOPS');
ok(E4.proof_missing.indexOf('production_would_write_contradicts_READY_NO_ACTION') >= 0,
  'E4a naming the contradiction rather than a missing field');
var E4p = JSON.parse(lineOf(runCensus(CONTRA, live()).world, 'r6r7_proof'));
eq(E4p.verdict, 'STOP', 'E4b and the kept line does not read as an acceptance');

// A healthy run leaves the guard silent.
eq(PF.res.proof_missing, [], 'E5  and none of that fires on the clean world');

// ================================================================================================================
section('F — the suppression is announced, counted, and reversible');
// ================================================================================================================

var MUTED = (PF.world.log || []).filter(function (l) {
  return String(l).indexOf('[E3-CENSUS] nested_log_muted: ') === 0; });
eq(MUTED.length, 3, 'F1  three nested diagnostics ran quietly');
['RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS', 'RUN_R6R2_ROUTE_PROVENANCE',
 'RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R'].forEach(function (name, i) {
  ok(MUTED.some(function (l) { return l.indexOf(name) >= 0; }),
    'F2.' + (i + 1) + ' ' + name + ' is named, so the log says WHAT was held back');
});
ok(MUTED.every(function (l) { return /\d+ line\(s\) held back/.test(l); }),
  'F3  each says how many lines, so the suppression is a measured fact and not a claim');
ok(MUTED.every(function (l) { return l.indexOf('run ') >= 0 && l.indexOf('directly for its own full log') >= 0; }),
  'F4  and how to get every one of them back');
ok(CENSUS.indexOf('function CENSUS_quiet_(') > 0
  && extractFn(CENSUS, 'CENSUS_quiet_').indexOf('CENSUS_LOG_MUTED_ = wasMuted;') > 0,
  'F5  the mute is restored on the way out, so it cannot leak into the next call');
ok(extractFn(CENSUS, 'CENSUS_quiet_').indexOf('if (err) throw err;') > 0,
  'F5a and an error inside a quiet block is re-thrown, never swallowed with the log');
// The detailed export is UNCHANGED: nothing was solved by deleting it.
var X = exported(PF.world);
ok(!!X && !!X.production_path && !!X.parity && !!X.legacy_projection,
  'F6  the detailed export still carries everything R6-R7-R2 put in it');
ok(!!X.manual_route_snapshots && !!X.expected_ai_identities,
  'F6a including the unbounded data the proof deliberately leaves out');
eq([X.proof_complete, X.proof_missing], [true, []],
  'F6b and it repeats the proof\'s own completeness, for a reader who has both');

// ================================================================================================================
section('G — a diagnostic patch, and nothing else');
// ================================================================================================================

eq(/var WAP_BUILD_VERSION_ = '([^']+)'/.exec(G61)[1], DEPLOYMENT_BUILD,
  'G1  61_ is untouched — its build has not moved');
eq(/var SYS_DEPLOYMENT_RELEASE_ = '([^']+)'/.exec(G63)[1], DEPLOYMENT_BUILD,
  'G2  the deployment release has not moved, so no new Web App version is required');
eq(/var SYS_BUILD_VERSION_ = '([^']+)'/.exec(G63)[1], DEPLOYMENT_BUILD, 'G3  nor has 63_');
eq(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/.exec(CENSUS)[1], DEPLOYMENT_BUILD,
  'G4  the census still reports the build it is diagnosing, not a build of its own');
ok(G61.indexOf('r6r7_proof') < 0 && G61.indexOf('CENSUS_quiet_') < 0,
  'G5  and no part of this patch reached the production module');
eq(['RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT', 'CENSUS_r6r7ProofObject_', 'CENSUS_r6r7ProofGuard_',
  'CENSUS_r6r7Finish_', 'CENSUS_quiet_'].filter(function (f) {
    var s = extractFn(CENSUS, f);
    return /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(s) || /appendRow|setValues/.test(s);
  }), [], 'G6  nothing added here can reach a writer or a cell write');

// ================================================================================================================
section('N — mutants');
// ================================================================================================================

mut('N1 the proof emitted AFTER the detailed export, where truncation reaches it', function () {
  var clean = labels(PF.world);
  var m = swap(CENSUS, "      CENSUS_log_('r6r7_proof', proofLine);", '      __deferred = proofLine;');
  m = swap(m, "  try { CENSUS_log_('r6r7_export', JSON.stringify(payload)); }",
    "  try { CENSUS_log_('r6r7_export', JSON.stringify(payload)); if (__deferred) CENSUS_log_('r6r7_proof', __deferred); }");
  m = swap(m, 'function CENSUS_r6r7Finish_(out) {', 'var __deferred = null;' + NLF + 'function CENSUS_r6r7Finish_(out) {');
  var r = runCensus(m, live());
  var l = labels(r.world);
  return clean.indexOf('r6r7_proof') < clean.indexOf('r6r7_export')
    && l.indexOf('r6r7_proof') > l.indexOf('r6r7_export');
});

mut('N2 an unbounded field admitted into the proof', function () {
  // The proof is bounded BY WHAT IT CARRIES, not by a length check — there is no trimming step to defeat.
  // Admitting one unbounded object is therefore the whole failure mode, and it must be visible as size.
  var m = swap(CENSUS, '      route_b_version: (B && B.observed) ? CENSUS_str_(B.observed.draft_version) : null',
    '      route_b_version: (B && B.observed) ? CENSUS_str_(B.observed.draft_version) : null,' + NLF
    + '      authority: pp.authority || null');
  var bad = runCensus(m, live());
  var raw = lineOf(bad.world, 'r6r7_proof');
  return RAW.length <= MAX_BYTES && raw !== null && raw.length > RAW.length * 1.5;
});

mut('N3 the byte cap raised past what a Logger line survives', function () {
  var m = swap(CENSUS, 'var R6R7_PROOF_MAX_BYTES_ = 4096;', 'var R6R7_PROOF_MAX_BYTES_ = 4096000;');
  var cap = vm.runInNewContext(extractVar(m, 'R6R7_PROOF_MAX_BYTES_') + ' R6R7_PROOF_MAX_BYTES_');
  return MAX_BYTES === 4096 && cap === 4096000;
});

mut('N4 the parity check dropped from the proof guard', function () {
  var m = swap(CENSUS,
    "  if (!out.parity || !pa.production_outcome || typeof pa.agree !== 'boolean') missing.push('parity');",
    '  if (false) missing.push(\'parity\');');
  var base = swap(CENSUS, "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');",
    "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');" + NLF + '  out.parity = null;');
  var mm = swap(m, "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');",
    "    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');" + NLF + '  out.parity = null;');
  var clean = runCensus(base, live()).res, bad = runCensus(mm, live()).res;
  return clean.verdict === 'STOP' && clean.proof_missing.indexOf('parity') >= 0
    && bad.proof_missing.indexOf('parity') < 0;
});

mut('N5 the production-outcome check dropped from the proof guard', function () {
  var base = swap(CENSUS, '  out.outcome = d.outcome;', '  out.outcome = null;');
  var m = swap(base,
    "  if (!out.production_path || pp.available !== true || !pp.outcome) missing.push('production_path.outcome');",
    "  if (false) missing.push('production_path.outcome');");
  var clean = runCensus(base, live()).res, bad = runCensus(m, live()).res;
  return clean.proof_missing.indexOf('production_path.outcome') >= 0
    && bad.proof_missing.indexOf('production_path.outcome') < 0;
});

mut('N6 the legacy-authority check dropped from the proof guard', function () {
  var m = swap(CENSUS,
    '  if (!out.legacy_projection || lp.is_production_generation_authority !== false) {',
    '  if (false) {');
  var clean = preflight(live(), { is_production_generation_authority: true }).res;
  var bad = runCensus(m, live(), { is_production_generation_authority: true }).res;
  return clean.proof_missing.indexOf('legacy_projection.is_production_generation_authority') >= 0
    && bad.proof_missing.indexOf('legacy_projection.is_production_generation_authority') < 0;
});

mut('N7 a would-write run reported as READY_NO_ACTION', function () {
  var base = swap(CENSUS, '    production_would_write: wouldWrite,', '    production_would_write: true,');
  var m = swap(base,
    "  if (out.verdict === 'READY_NO_ACTION' && pa.production_would_write === true) {",
    '  if (false) {');
  var clean = runCensus(base, live()).res, bad = runCensus(m, live()).res;
  return clean.verdict === 'STOP' && bad.verdict === 'READY_NO_ACTION';
});

mut('N8 a mutation counter reported as zero without being zero', function () {
  var m = swap(CENSUS, '    db_writes: CENSUS_num_(out.db_writes) || 0,' + NLF
    + '    writer_calls: CENSUS_num_(out.writer_calls) || 0,',
    '    db_writes: 0,' + NLF + '    writer_calls: 0,');
  var w = new World(live());
  vm.runInContext(m, w.ctx); projection(w.ctx);
  vm.runInContext('var __origFinish = CENSUS_r6r7Finish_;' + NLF
    + 'CENSUS_r6r7Finish_ = function (o) { o.db_writes = 7; return __origFinish(o); };', w.ctx);
  var r = w.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT');
  var p = JSON.parse(lineOf(w, 'r6r7_proof'));
  var w2 = new World(live());
  vm.runInContext(CENSUS, w2.ctx); projection(w2.ctx);
  vm.runInContext('var __origFinish2 = CENSUS_r6r7Finish_;' + NLF
    + 'CENSUS_r6r7Finish_ = function (o) { o.db_writes = 7; return __origFinish2(o); };', w2.ctx);
  w2.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT');
  var pClean = JSON.parse(lineOf(w2, 'r6r7_proof'));
  return pClean.db_writes === 7 && p.db_writes === 0;
});

mut('N9 the nested suppression made silent', function () {
  // Renamed rather than deleted, so the mutant stays syntactically whole and the ONLY thing that changes
  // is whether a reader can see that something was held back.
  var m = swap(CENSUS, "  CENSUS_log_('nested_log_muted', label",
    "  CENSUS_log_('_quiet', label");
  var bad = runCensus(m, live());
  return labels(PF.world).indexOf('nested_log_muted') >= 0
    && labels(bad.world).indexOf('nested_log_muted') < 0;
});

mut('N10 the mute left on, so the proof itself is swallowed', function () {
  var m = swap(CENSUS, '  CENSUS_LOG_MUTED_ = wasMuted;', '  CENSUS_LOG_MUTED_ = true;');
  var bad = runCensus(m, live());
  return proofRaw(PF) !== null && lineOf(bad.world, 'r6r7_proof') === null;
});

console.log('\npassed ' + pass + '  failed ' + fail
  + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);

