// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R3 — THE FIRST CONTROLLED NO-ACTION ACTIVATION.
//
// Every round so far proved what a generation WOULD do. This one is about the sentence a person has to be able
// to sign: press it once, and here is exactly what must be true before, and exactly what must be identical
// after. Three things make that sentence checkable rather than hopeful.
//
// (1) A BASELINE A READBACK RECOMPUTES CANNOT DETECT A CHANGE. Whatever it finds becomes what it expected. So
//     the BEFORE is frozen into a constant BY A PERSON, from the manifest's own printed block, and the readback
//     REFUSES to run against an unfrozen one. That refusal is the feature: a readback that cheerfully compared
//     nothing to nothing would report CONFIRMED after a write.
//
// (2) A MUTATION REQUEST IS NOT A DATABASE WRITE. The transport records one mutation request because the
//     operator asked the server to consider generating; the server's answer is that nothing needed writing.
//     mutation_requests 1 beside db_writes 0 is the CORRECT shape of a no-action, and reading the first number
//     as the second is how a correct finish gets rolled back.
//
// (3) THE TWO HALVES ARE MEASURED IN DIFFERENT PLACES AND MUST STAY THERE. Apps Script cannot see the browser
//     and the browser cannot see the database. The readback states the rows; the snippet states the requests;
//     neither invents the other's number.
//
// Nothing here flips a flag, deploys, or calls a generation. This suite proves the design and the diagnostics.
//
// Run: node assets/tests/controlled-no-action-activation-manifest-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7-r3.test.js

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
// THE WORLD IS LOADED FROM THE R6-R7-R2 SUITE, NOT COPIED. Same reason as every round since: a second copy of
// the fixtures would let two suites disagree about what production looks like.
// ================================================================================================================
var R2_OF = 'assets/tests/controlled-ai-plan-production-parity-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7-r2.test.js';
var R2_SRC = read(R2_OF).replace(/\r\n/g, '\n');
var CUT = R2_SRC.indexOf("\nsection('A ");
if (CUT < 0) throw new Error('the R6-R7-R2 suite no longer opens its assertions with section()');
var RUNCENSUS = R2_SRC.slice(R2_SRC.indexOf('function runCensus('), R2_SRC.indexOf('var BLOCKED ='));
var SHARED = (new Function('require', '__dirname', '__filename', 'module', 'exports', 'console',
  R2_SRC.slice(0, CUT) + '\n' + RUNCENSUS
  + '\nreturn { World: World, failed: failed, swap: swap, extractFn: extractFn, extractVar: extractVar,'
  + ' CENSUS: CENSUS, G61: G61, live: live, projection: projection, NLF: NLF, SQ: SQ };'
))(require, __dirname, __filename, module, exports, console);
var World = SHARED.World, failed = SHARED.failed, swap = SHARED.swap;
var extractFn = SHARED.extractFn, extractVar = SHARED.extractVar;
var CENSUS = SHARED.CENSUS, G61 = SHARED.G61, live = SHARED.live, projection = SHARED.projection;
var NLF = SHARED.NLF;
var DEPLOYMENT_BUILD = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';

// The deployment contract is 63_'s to report and 63_ is not in this world. A DOUBLE stands in for it, and it
// is a double of the SHAPE 63_ returns — the manifest reads exactly those fields and nothing else. A healthy
// double is not a claim that production is healthy; the manifest re-reads the real one there.
function deployment(over) {
  var d = { deployment_build: DEPLOYMENT_BUILD, modules: [], runtime_authority: { uniform: true },
    absent_modules: [], absent_optional_modules: [], stale_modules: [], mixed_deployment: false,
    verdict: 'UNIFORM' };
  Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
  return d;
}

function W(over, opts) {
  opts = opts || {};
  var w = new World(over || live());
  vm.runInContext(opts.census || CENSUS, w.ctx);
  projection(w.ctx, opts.projection);
  vm.runInContext('sysModuleBuildStamps_ = function () { return '
    + JSON.stringify(deployment(opts.deployment)) + '; };', w.ctx);
  if (opts.flagTrue) {
    vm.runInContext('inventoryAiPlanDbGenerationEnabled_ = function () { return true; };', w.ctx);
  }
  if (opts.allowlist) {
    vm.runInContext('INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ = ' + JSON.stringify(opts.allowlist) + ';', w.ctx);
  }
  if (opts.after) vm.runInContext(opts.after, w.ctx);
  return w;
}
function runIt(entry, over, opts) {
  var w = W(over, opts);
  var r = w.run(entry);
  r.world = w;
  return r;
}
function manifest(over, opts) { return runIt('RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST', over, opts); }

function lineOf(w, label) {
  var pre = '[E3-CENSUS] ' + label + ': ', hit = null;
  (w.log || []).forEach(function (l) { if (String(l).indexOf(pre) === 0) hit = String(l).slice(pre.length); });
  return hit;
}
function labels(w) {
  var out = [];
  (w.log || []).forEach(function (l) {
    var m = /^\[E3-CENSUS\] ([A-Za-z0-9_]+):/.exec(String(l));
    if (m) out.push(m[1]);
  });
  return out;
}
function proofOf(r) { var s = lineOf(r.world, 'r6r7_proof'); return s === null ? null : JSON.parse(s); }

// FREEZING, THE WAY A PERSON DOES IT: run the manifest, take its frozen_before, paste it into the constant.
// Modelled exactly — the readback is then run in a world whose constant carries those values.
function freezeFrom(over, opts) {
  var m = manifest(over, opts);
  var b = m.res.frozen_before;
  if (!b) throw new Error('the manifest froze nothing to paste');
  return { before: b, source: '(function(){ var B = R6R7_NO_ACTION_BEFORE_; var F = ' + JSON.stringify(b)
    + "; Object.keys(F).forEach(function(k){ if (k !== 'route_a' && k !== 'route_b') B[k] = F[k]; }); })();" };
}
function readback(frozen, over, opts) {
  opts = opts || {};
  var o = { deployment: opts.deployment, projection: opts.projection, flagTrue: opts.flagTrue,
    allowlist: opts.allowlist, census: opts.census, after: frozen.source + (opts.after || '') };
  return runIt('RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', over, o);
}

var NONZERO = { gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
  d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } };
var BLOCKED = { gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } };

// ================================================================================================================
section('A — the manifest a person authorizes from');
// ================================================================================================================

var M = manifest();
eq(M.res.verdict, 'READY_TO_AUTHORIZE', 'A1  a valid zero over an untouched plan is READY_TO_AUTHORIZE');
eq(failed(M.res), [], 'A1a with no condition unmet');
eq([M.res.db_writes, M.res.writer_constructed, M.res.writer_calls, M.res.submit_calls,
  M.res.route_save_calls, M.res.reservation_writes], [0, false, 0, 0, 0, 0],
  'A2  and it wrote nothing, by six counters');
eq(M.world.dbWrites(), 0, 'A2a measured on the sheets, not reported');
eq([M.res.flag_flipped_this_round, M.res.generation_called_this_round], [false, false],
  'A3  it did not flip the flag and did not call a generation');
eq(M.res.scope, { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },
  'A4  the scope is the one frozen SKU');
eq(M.res.flag.value, false, 'A5  the flag is still false at manifest time');
eq(M.res.allowlist.is_exactly_the_frozen_scope, true, 'A6  and the allowlist is exactly that scope');
eq(M.res.production_path.outcome, 'AI_PLAN_NO_ACTION', 'A7  production would answer AI_PLAN_NO_ACTION');
eq(M.res.parity.agree, true, 'A7a and the wrapper agrees with it');

// THE FROZEN BEFORE, which is the whole point of the manifest.
var B = M.res.frozen_before;
eq(B.calculation_status, 'READY', 'A8  the recommendation is READY');
eq(B.freshness_state, 'CURRENT_AFTER_REFRESH', 'A8a on a current snapshot');
eq(B.windows, { D18: 0, D30: 0, D45: 0, D90: 0 }, 'A8b with a stored finite 0 in every window');
eq([B.recommended_qty, B.qualifying_active_planned_qty, B.residual_qty], [0, 520, 0],
  'A9  recommended 0 / manual planned 520 / residual 0');
eq(B.manual_planned_total, 520, 'A9a and the plan total is 520');
eq([B.active_ai_headers, B.active_ai_lines], [0, 0], 'A10 no AI row exists yet');
eq(B.manual_header_ids, ['SADH-K4-38523A90', 'SADH-K4-A3872518'], 'A11 the two manual headers, sorted');
eq(B.manual_line_ids, ['SADL-K2-344FB2B2', 'SADL-K2-92B8BAD2'], 'A11a and the two manual lines');
ok(typeof B.route_a_fingerprint === 'string' && B.route_a_fingerprint.length === 8,
  'A12 Route A has a byte-stable fingerprint');
ok(typeof B.route_b_fingerprint === 'string' && B.route_b_fingerprint.length === 8,
  'A12a so does Route B');
ok(B.route_a_fingerprint !== B.route_b_fingerprint, 'A12b and they are different rows');
ok(!!B.route_a_updated_at && !!B.route_a_line_updated_at && !!B.route_b_updated_at && !!B.route_b_line_updated_at,
  'A13 both timestamps are frozen for both routes');

// The fingerprint is a FUNCTION OF THE FIELDS, in a fixed order, and it moves when any of them does.
var FPF = vm.runInNewContext(extractVar(CENSUS, 'R6R7_FP_FIELDS_') + ' R6R7_FP_FIELDS_');
ok(FPF.indexOf('draft_version') >= 0 && FPF.indexOf('updated_at') >= 0 && FPF.indexOf('line_updated_at') >= 0
  && FPF.indexOf('quantity') >= 0 && FPF.indexOf('last_mile_delivery') >= 0
  && FPF.indexOf('generation_run_id') >= 0,
  'A14 the fingerprint covers version, both timestamps, quantity, last mile and provenance');
var FP = vm.runInNewContext(extractFn(CENSUS, 'CENSUS_fp_') + NLF
  + 'function CENSUS_str_(v) { return String(v == null ? "" : v).trim(); }' + NLF
  + extractVar(CENSUS, 'R6R7_FP_FIELDS_') + NLF
  + extractFn(CENSUS, 'CENSUS_r6r7RouteFingerprint_') + NLF
  + '({ fp: CENSUS_r6r7RouteFingerprint_ })');
var baseRow = { allocation_draft_id: 'X', draft_version: '4', quantity: 320, last_mile_delivery: 'truck' };
function bump(f, v) { var r = {}; Object.keys(baseRow).forEach(function (k) { r[k] = baseRow[k]; }); r[f] = v; return r; }
eq(FP.fp(baseRow), FP.fp(baseRow), 'A15 the fingerprint is deterministic');
ok(FP.fp(baseRow) !== FP.fp(bump('draft_version', '5')), 'A15a a version bump changes it');
ok(FP.fp(baseRow) !== FP.fp(bump('quantity', 321)), 'A15b so does a quantity');
ok(FP.fp(baseRow) !== FP.fp(bump('last_mile_delivery', 'parcel')), 'A15c so does a last mile');
eq(FP.fp(null), null, 'A15d and a missing row has no fingerprint, rather than a fingerprint of nothing');

// THE PASTE BLOCK. A readback that recomputed this would compare the state with itself.
ok(String(M.res.freeze_paste_block).indexOf('R6R7_NO_ACTION_BEFORE_') > 0,
  'A16 the manifest prints the block a person pastes, and says where');
var pasted = JSON.parse(String(M.res.freeze_paste_block).slice(String(M.res.freeze_paste_block).indexOf('{')));
eq(pasted.route_a_fingerprint, B.route_a_fingerprint, 'A16a carrying the fingerprints it just measured');
eq(pasted.calculation_run_id, B.calculation_run_id, 'A16b and the run it measured them against');

// ================================================================================================================
section('B — every condition that must hold, and what happens when it does not');
// ================================================================================================================

function stops(label, r, predicate) {
  eq(r.res.verdict, 'STOP', label);
  ok(failed(r.res).indexOf(predicate) >= 0, label + ' — because ' + predicate);
}

stops('B1  a non-zero recommendation', manifest(NONZERO), 'production_outcome_is_no_action');
ok(failed(manifest(NONZERO).res).indexOf('residual_qty_is_zero') >= 0,
  'B1a and the residual it would generate is named');
stops('B2  a recommendation that cannot be read at all', manifest(BLOCKED), 'production_outcome_is_no_action');
stops('B3  a stale snapshot', manifest({ gap: { calculation_date: '2020-01-01' } }),
  'production_outcome_is_no_action');
stops('B4  a NOT-READY row', manifest({ gap: { calculation_status: 'PENDING' },
  extraGap: [{ sku: 'OTHER-SKU', d90_suggested_qty: 0 }] }), 'recommendation_is_ready');

// Route A and Route B: version, quantity, last mile, provenance.
stops('B5  Route A at a moved version', manifest({ aHeader: { draft_version: '5' } }),
  'route_A_version_is_frozen');
stops('B6  Route B at a moved version', manifest({ bHeader: { draft_version: '4' } }),
  'route_B_version_is_frozen');
stops('B7  Route B with a persisted last mile',
  manifest({ bHeader: { recommended_last_mile_delivery: 'parcel' } }),
  'route_B_last_mile_is_frozen');
stops('B8  Route A at a different quantity', manifest({ aLine: { planned_qty: '321' } }),
  'route_A_quantity_is_frozen');
stops('B9  a manual route adopted by a run',
  manifest({ aHeader: { generation_type: 'system_generated', generation_run_id: 'AIRUN-X' } }),
  'route_A_is_manual');

// The plan total.
var B10 = manifest({ aLine: { planned_qty: '300' } });
eq(B10.res.verdict, 'STOP', 'B10 a manual total that is not 520');
ok(failed(B10.res).indexOf('manual_planned_total_is_520') >= 0, 'B10a and the total is named');

// An AI row that already exists.
stops('B11 an AI row that already exists for this scope',
  manifest({ extraHeaders: [{ allocation_draft_id: 'SADH-AI9', generation_type: 'system_generated',
      generation_run_id: 'AIRUN-9' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-AI9', allocation_draft_id: 'SADH-AI9', planned_qty: '10' }] }),
  'no_active_ai_row_exists_yet');

// The two gates.
stops('B12 a flag that is already true', manifest(live(), { flagTrue: true }), 'flag_is_still_false');
stops('B13 an allowlist with a second scope', manifest(live(), { allowlist: [
  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' },
  { company: 'ResUS', country: 'US', marketplace: 'Walmart', sku: 'CO1100-R' }] }),
  'allowlist_is_exactly_the_one_frozen_scope');
stops('B14 a marketplace-only allowlist entry', manifest(live(), { allowlist: [
  { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: '' }] }),
  'no_wildcard_or_partial_allowlist_entry');
stops('B15 an ALL_SITES allowlist entry', manifest(live(), { allowlist: [
  { company: 'ResUS', country: 'US', marketplace: 'ALL_SITES', sku: 'CO1100-R' }] }),
  'no_wildcard_or_partial_allowlist_entry');

// The deployment.
stops('B16 a mixed deployment', manifest(live(), { deployment: { mixed_deployment: true } }),
  'deployment_is_not_mixed');
stops('B17 a stale module', manifest(live(), { deployment: { stale_modules: ['61_ declares X, expected Y'] } }),
  'no_stale_modules');
stops('B18 a build that is not the one every preflight measured',
  manifest(live(), { deployment: { deployment_build: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R1' } }),
  'deployment_build_is_the_measured_one');
var B19 = manifest(live(), { after: 'sysModuleBuildStamps_ = undefined;' });
eq(B19.res.verdict, 'STOP', 'B19 a deployment contract that cannot be read at all');
ok(failed(B19.res).indexOf('deployment_contract_is_readable') >= 0,
  'B19a "we could not ask" is not "the answer was yes"');

// A production path that would write.
var B20 = manifest(live(), { census: swap(CENSUS, '    production_would_write: wouldWrite,',
  '    production_would_write: true,') });
eq(B20.res.verdict, 'STOP', 'B20 a parity saying production would write');
ok(failed(B20.res).indexOf('parity_says_production_would_not_write') >= 0, 'B20a and it is named');
var B21 = manifest(NONZERO);
eq(B21.res.production_path.would_write, true, 'B21 a residual really does set would_write');
ok(failed(B21.res).indexOf('production_would_not_write') >= 0, 'B21a which the manifest refuses');

// ================================================================================================================
section('C — the readback refuses to prove stillness against a baseline nobody froze');
// ================================================================================================================

var C0 = runIt('RUN_R6R7_CONTROLLED_NO_ACTION_READBACK');
eq(C0.res.verdict, 'STOP', 'C1  an unfrozen baseline STOPS');
eq(C0.res.baseline_frozen, false, 'C1a baseline_frozen false');
ok(C0.res.baseline_missing.length > 0, 'C1b with every missing field named');
ok(String(C0.res.stop_reason).indexOf('BASELINE_NOT_FROZEN') === 0, 'C1c under its own code');
ok(String(C0.res.stop_reason).indexOf('compare the state with itself') > 0,
  'C1d and it says WHY a recomputed baseline would be worthless');

var FZ = freezeFrom();
var C = readback(FZ);
eq(C.res.verdict, 'CONTROLLED_NO_ACTION_CONFIRMED', 'C2  a frozen baseline over an untouched plan CONFIRMS');
eq(failed(C.res), [], 'C2a with no predicate failed');
eq(C.res.baseline_frozen, true, 'C2b baseline_frozen true');
eq([C.res.db_writes, C.res.writer_constructed, C.res.writer_calls, C.res.submit_calls,
  C.res.route_save_calls, C.res.reservation_writes], [0, false, 0, 0, 0, 0],
  'C3  and the readback itself wrote nothing');
eq(C.world.dbWrites(), 0, 'C3a measured on the sheets');
eq(C.res.new_rows, [], 'C4  no header and no line was created');
eq(C.res.changed_fields, [], 'C4a and no field moved');
eq(C.res.counts.manual_planned_total, 520, 'C5  the manual total is still 520');
eq(C.res.counts.manual_planned_total_before, 520, 'C5a against the frozen 520');
eq(C.res.routes_observed.length, 2, 'C6  both routes were compared');
ok(C.res.routes_observed.every(function (r) { return r.fingerprint_now === r.fingerprint_was; }),
  'C6a and both are byte-identical to BEFORE');
eq(C.res.routes_observed.map(function (r) { return r.draft_version; }), ['4', '3'],
  'C6b at versions 4 and 3');

// WHAT THE SERVER SAID, AND WHAT THE BROWSER SAW, KEPT APART.
eq(C.res.server_response.required_shape.outcome, 'AI_PLAN_NO_ACTION', 'C7  the required response outcome');
eq(C.res.server_response.required_shape.code, 'NO_REPLENISHMENT_REQUIRED', 'C7a and its code');
eq([C.res.server_response.required_shape.recommended_qty,
  C.res.server_response.required_shape.qualifying_planned_qty,
  C.res.server_response.required_shape.residual_qty], [0, 520, 0], 'C7b 0 / 520 / 0');
eq([C.res.server_response.required_shape.created_headers, C.res.server_response.required_shape.created_lines,
  C.res.server_response.required_shape.updated_headers, C.res.server_response.required_shape.updated_lines,
  C.res.server_response.required_shape.cancelled_headers, C.res.server_response.required_shape.cancelled_lines,
  C.res.server_response.required_shape.db_writes], [0, 0, 0, 0, 0, 0, 0],
  'C7c every mutation counter zero');
eq(C.res.browser_transport.measured_here, false,
  'C8  the readback does NOT claim to have measured the browser');
ok(String(C.res.browser_transport.why).indexOf('fabricating it here') > 0,
  'C8a and says so rather than inventing a request count');
eq(C.res.browser_transport.required_delta,
  { mutation_requests: 1, action: 'weeklyAiPlan.generate', route_save_requests: 0, submit_requests: 0,
    reservation_requests: 0, second_generation_requests: 0 },
  'C8b stating the delta the browser half must show');

// ================================================================================================================
section('D — anything that moved is a STOP, by name');
// ================================================================================================================

function afterFreeze(label, over, predicate) {
  var f = freezeFrom();
  var r = readback(f, over);
  eq(r.res.verdict, 'STOP', label);
  ok(failed(r.res).indexOf(predicate) >= 0, label + ' — because ' + predicate);
  return r;
}

var D1 = afterFreeze('D1  a new AI header', { extraHeaders: [{ allocation_draft_id: 'SADH-NEW',
    generation_type: 'system_generated', generation_run_id: 'AIRUN-N' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-NEW', allocation_draft_id: 'SADH-NEW', planned_qty: '90' }] },
  'no_header_or_line_was_created');
eq(D1.res.new_rows.map(function (r) { return r.allocation_draft_id; }), ['SADH-NEW'],
  'D1a and the new id is frozen for the repair manifest');
ok(failed(D1.res).indexOf('active_ai_rows_did_not_increase') >= 0, 'D1b the AI row count is named too');

afterFreeze('D2  Route A at a moved version', { aHeader: { draft_version: '5' } },
  'route_A_is_byte_identical');
afterFreeze('D3  Route B at a moved version', { bHeader: { draft_version: '4' } },
  'route_B_is_byte_identical');
afterFreeze('D4  Route A with a moved updated_at',
  { aHeader: { updated_at: 'Mon Sep 07 2026 09:00:00 GMT+0800 (Taiwan Standard Time)' } },
  'route_A_updated_at_did_not_move');
afterFreeze('D5  Route B with a moved line timestamp',
  { bLine: { updated_at: 'Mon Sep 07 2026 09:00:00 GMT+0800 (Taiwan Standard Time)' } },
  'route_B_line_updated_at_did_not_move');
afterFreeze('D6  Route B with a persisted last mile',
  { bHeader: { recommended_last_mile_delivery: 'parcel' } }, 'route_B_is_byte_identical');
afterFreeze('D7  a manual route re-owned by a run',
  { aHeader: { generation_type: 'system_generated', generation_run_id: 'AIRUN-Z' } },
  'route_A_was_not_re_owned_by_a_run');
afterFreeze('D8  a manual total that moved', { aLine: { planned_qty: '300' } },
  'manual_planned_total_did_not_move');
afterFreeze('D9  a manual route that disappeared', { dropA: true }, 'route_A_present_exactly_once');

// AND THE FIELDS THAT MOVED ARE NAMED, so a repair manifest has something to be built from.
var D10 = readback(freezeFrom(), { aHeader: { draft_version: '5' } });
ok(D10.res.changed_fields.length > 0, 'D10 a moved route lists its fields rather than only failing');
ok(D10.res.changed_fields.some(function (c) { return c.route === 'A' && c.field === 'draft_version'; }),
  'D10a including the one that actually moved');

// ================================================================================================================
section('E — the browser half, run against a real timeline shape');
// ================================================================================================================

// extractVar stops at the closing bracket, so it hands back the array literal without the .join() that
// follows it. Joined here the same way the census does, which is also a check that it IS a line array.
function snippet(name) {
  var v = vm.runInNewContext(extractVar(CENSUS, name) + ' ' + name);
  if (!Array.isArray(v)) throw new Error(name + ' is no longer a line array');
  return v.join(NLF);
}
var BASE_SNIP = snippet('R6R7_BROWSER_BASELINE_SNIPPET_');
var DELTA_SNIP = snippet('R6R7_BROWSER_DELTA_SNIPPET_');

function req(seq, action, kind, over) {
  var r = { seq: seq, action: action, kind: kind || 'read', request_id: 'REQ-' + seq, phase: 'SETTLED',
    outcome: 'OK', code: null, http_status: 200, attempts: 1, overlapped_with: [], routes_in_payload: null,
    allocation_draft_id: null, allocation_draft_line_ids: null, intent: null, mints_new_row: null,
    marks_source: 'OBSERVED', elapsed_ms: 120 };
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}
// A browser world: the page has already made some requests before the test begins, which is the whole reason
// a DELTA is required.
function browser(before, after) {
  var ctx = { console: { log: function () {} } };
  ctx.window = ctx;
  var rows = before.slice();
  ctx.KM = { transport: { timeline: function () {
    return { request_timeline: rows.slice(), requests: rows.length,
      mutations: rows.filter(function (r) { return r.kind === 'write'; }),
      mutation_requests: rows.filter(function (r) { return r.kind === 'write'; }).length };
  } } };
  vm.createContext(ctx);
  vm.runInContext(BASE_SNIP, ctx);
  rows.push.apply(rows, after);
  return vm.runInContext(DELTA_SNIP, ctx);
}
var PRIOR = [req(1, 'inventory.read'), req(2, 'inventory.read'),
  req(3, 'shippingAllocationDraft.upsertAtomic', 'write')];

var E1 = browser(PRIOR, [req(4, 'weeklyAiPlan.generate', 'write',
  { request_id: 'REQ-GEN-1', outcome: 'AI_PLAN_NO_ACTION' })]);
eq(E1.verdict, 'ONE_GENERATION_REQUEST', 'E1  exactly one generation request after the baseline');
eq([E1.new_requests, E1.new_mutation_requests, E1.generation_requests], [1, 1, 1], 'E1a one, one, one');
eq(E1.baseline_max_seq, 3, 'E1b measured against the baseline, not from zero');
eq(E1.unexpected_mutations, [], 'E1c and nothing else mutated');
eq(E1.generation[0].request_id, 'REQ-GEN-1', 'E1d the request id is captured for correlation');
eq(E1.generation[0].attempts, 1, 'E1e with its attempt count');
eq(E1.scope_reported_by_transport, null, 'E1f the scope is NOT invented from the transport');
ok(String(E1.scope_note).indexOf('would be a guess') > 0, 'E1g and the reason is stated');

// THE DELTA IS NOT THE TOTAL. The prior write must not be counted as this test's.
ok(E1.new_mutation_requests === 1, 'E2  a mutation that predates the baseline is not counted');

var E3 = browser(PRIOR, [req(4, 'weeklyAiPlan.generate', 'write'), req(5, 'weeklyAiPlan.generate', 'write')]);
eq(E3.verdict, 'STOP', 'E3  two generation requests STOP');
eq(E3.generation_requests, 2, 'E3a and both are counted');

var E4 = browser(PRIOR, [req(4, 'weeklyAiPlan.generate', 'write'),
  req(5, 'shippingAllocationDraft.upsertAtomic', 'write')]);
eq(E4.verdict, 'STOP', 'E4  an unexpected route save alongside it STOPS');
eq(E4.unexpected_mutations, ['shippingAllocationDraft.upsertAtomic'], 'E4a named');
eq(E4.route_save_requests, 1, 'E4b and counted as a route save');

var E5 = browser(PRIOR, [req(4, 'shippingPlan.submit', 'write')]);
eq(E5.verdict, 'STOP', 'E5  a Submit STOPS');
eq(E5.submit_requests, 1, 'E5a and is counted');

var E6 = browser(PRIOR, []);
eq(E6.verdict, 'STOP', 'E6  no generation request at all STOPS');
eq(E6.generation_requests, 0, 'E6a rather than reporting success on an empty delta');

// NO BASELINE AT ALL. The snippet must refuse rather than compute a delta from nothing.
var noBase = (function () {
  var ctx = { console: { log: function () {} } };
  ctx.window = ctx;
  ctx.KM = { transport: { timeline: function () { return { request_timeline: [], requests: 0, mutations: [],
    mutation_requests: 0 }; } } };
  vm.createContext(ctx);
  return vm.runInContext(DELTA_SNIP, ctx);
})();
eq(noBase.verdict, 'STOP', 'E7  a delta with no baseline STOPS');
ok(String(noBase.reason).indexOf('NO_BASELINE') === 0, 'E7a under its own code');
ok(String(noBase.reason).indexOf('Do not press Generate again') > 0,
  'E7b and it forbids the retry rather than inviting one');

// ================================================================================================================
section('F — the twelve steps, the two rollbacks, and the number that is not a write');
// ================================================================================================================

var STEPS = M.res.activation_steps;
eq(STEPS.length, 12, 'F1  twelve steps, written down');
eq(STEPS.map(function (s) { return s.n; }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'F1a numbered in order');
ok(String(STEPS[0].do).indexOf('INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_') > 0
  && String(STEPS[0].do).indexOf('true') > 0, 'F2  step 1 flips the one constant');
ok(String(STEPS[1].do).indexOf('00_config.gs') > 0, 'F3  step 2 syncs only what changed');
ok(String(STEPS[2].do).indexOf('deployment version') > 0, 'F4  step 3 publishes a deployment version');
ok(String(STEPS[4].do).indexOf('EFFECTIVE flag') > 0, 'F5  step 5 verifies the EFFECTIVE flag, not the file');
ok(String(STEPS[6].do).indexOf('ONCE') > 0 && String(STEPS[6].do).indexOf('BASELINE') > 0,
  'F6  step 7 takes the baseline and presses once');
ok(String(STEPS[7].do).indexOf('second time') > 0, 'F7  step 8 forbids the second press');
ok(String(STEPS[8].do).indexOf('Submit') > 0, 'F8  step 9 forbids Submit');
ok(String(STEPS[9].do).indexOf('READBACK') > 0, 'F9  step 10 reads back immediately');
ok(String(STEPS[10].do).indexOf('false') > 0, 'F10 step 11 restores the flag');
ok(String(STEPS[11].do).indexOf('false') > 0, 'F11 and step 12 verifies it is false again');
// And the manifest itself IS the step-12 check: re-run with the flag left on and it refuses.
eq(manifest(live(), { flagTrue: true }).res.verdict, 'STOP',
  'F12 a flag left true after step 11 makes the manifest STOP — it is the post-restore check too');
eq(M.res.flag.must_be_after_step_11, false, 'F12a which the flag contract states');

var AUD = M.res.browser_audit;
eq(AUD.expected_shape.browser_mutation_requests_delta, 1, 'F13 one mutation REQUEST is expected');
eq(AUD.expected_shape.server_db_writes, 0, 'F13a beside zero database writes');
ok(String(AUD.the_misreading_to_avoid).indexOf('roll back a correct finish') > 0,
  'F13b and the misreading is named: a request count is not a write count');
ok(String(AUD.delta_not_total).indexOf('delta') > 0, 'F14 the delta rule is stated');

var RB = M.res.rollback;
eq(RB.A_no_action_as_expected.data_rollback_required, false, 'F15 a clean no-action needs no data rollback');
ok(RB.A_no_action_as_expected.still_required.length === 3, 'F15a but the flag still comes back off');
ok(String(RB.B_any_write_or_unknown_outcome.first_rule).indexOf('do NOT press Generate again') === 0,
  'F16 any write or unknown outcome forbids the retry FIRST');
ok(String(RB.B_any_write_or_unknown_outcome.order[0]).indexOf('READBACK') > 0,
  'F16a and reads before deciding');
ok(String(RB.B_any_write_or_unknown_outcome.order[1]).indexOf('freeze') === 0,
  'F16b then freezes the ids');
ok(String(RB.B_any_write_or_unknown_outcome.order[2]).indexOf('repair manifest') > 0,
  'F16c then produces a repair manifest');
ok(String(RB.B_any_write_or_unknown_outcome.order[4]).indexOf('separate, explicit authorization') > 0,
  'F16d and changes no data without another authorization');
ok(String(RB.B_any_write_or_unknown_outcome.ack_unknown).indexOf('case B until the readback says otherwise') > 0,
  'F17 a timeout is case B until the database says otherwise');

// ================================================================================================================
section('G — bounded proofs, complete, and before the detailed output');
// ================================================================================================================

var MAX = vm.runInNewContext(extractVar(CENSUS, 'R6R7_PROOF_MAX_BYTES_') + ' R6R7_PROOF_MAX_BYTES_');
[['the manifest', M], ['the readback', C]].forEach(function (c, i) {
  var raw = lineOf(c[1].world, 'r6r7_proof');
  var lab = labels(c[1].world);
  ok(raw !== null, 'G' + (i + 1) + '  ' + c[0] + ' emits a compact proof');
  ok(raw !== null && raw.length <= MAX,
    'G' + (i + 1) + 'a within the cap (' + (raw ? raw.length : -1) + ' bytes)');
  eq(JSON.parse(raw).census, c[1].res.census, 'G' + (i + 1) + 'b that parses whole');
  ok(lab.indexOf('r6r7_proof') < lab.indexOf('r6r7_export'),
    'G' + (i + 1) + 'c and comes before the detailed export');
  eq(JSON.parse(raw).proof_complete, true, 'G' + (i + 1) + 'd marked complete');
});

var MP = proofOf(M), CP = proofOf(C);
eq(MP.frozen_before.route_a_fingerprint, B.route_a_fingerprint,
  'G3  the manifest proof carries the fingerprints it froze');
eq([MP.flag_now, MP.flag_flipped_this_round, MP.generation_called_this_round], [false, false, false],
  'G3a and that nothing was flipped or called');
eq([CP.route_a.identical, CP.route_b.identical], [true, true],
  'G4  the readback proof carries both fingerprint comparisons');
eq([CP.new_rows, CP.changed_field_count], [0, 0], 'G4a and the two counts that decide it');
eq(CP.browser_transport_measured_here, false, 'G4b and it does not claim the browser half');

// The proof guards.
var G5 = manifest(live(), { flagTrue: true });
ok(G5.res.proof_missing.indexOf('flag_already_true_cannot_be_ready_to_authorize') >= 0
  || G5.res.verdict === 'STOP', 'G5  a manifest cannot say READY while the flag is on');
var G6 = readback(freezeFrom(), { extraHeaders: [{ allocation_draft_id: 'SADH-G6',
    generation_type: 'system_generated', generation_run_id: 'AIRUN-G6' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-G6', allocation_draft_id: 'SADH-G6', planned_qty: '5' }] });
eq(G6.res.verdict, 'STOP', 'G6  a readback cannot CONFIRM beside a new row');

// ================================================================================================================
section('H — a design round: nothing was flipped, deployed, generated or written');
// ================================================================================================================

eq(/var WAP_BUILD_VERSION_ = '([^']+)'/.exec(G61)[1], DEPLOYMENT_BUILD, 'H1  61_ is untouched');
eq(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/.exec(CENSUS)[1], DEPLOYMENT_BUILD,
  'H2  and the census still reports the build it diagnoses');
eq(['RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST', 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK',
  'CENSUS_r6r7RouteFingerprint_', 'CENSUS_r6r7RowCount_', 'CENSUS_r6r7Deployment_',
  'CENSUS_r6r7ActivationSteps_', 'CENSUS_r6r7ActivationRollback_', 'CENSUS_r6r7BrowserAudit_'
].filter(function (f) {
  var s = extractFn(CENSUS, f);
  return /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(s) || /appendRow|setValues|setValue\s*\(/.test(s)
    || /INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_\s*=/.test(s)
    || /handleGenerateWeeklyAiPlanDraft_\s*\(/.test(s);
}), [], 'H3  nothing added this round writes, flips the flag, or calls a generation');
ok(extractFn(CENSUS, 'RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST').indexOf('flag_flipped_this_round: false') > 0,
  'H4  and the manifest says so on its own record');

// ================================================================================================================
section('N — mutants');
// ================================================================================================================

function withCensus(src, entry, over, opts) {
  var o = {};
  Object.keys(opts || {}).forEach(function (k) { o[k] = opts[k]; });
  o.census = src;
  return runIt(entry, over, o);
}

mut('N1 the fingerprint blind to a field, so a moved row still matches', function () {
  var m = swap(CENSUS, "  'draft_version', 'quantity', 'shipping_method', 'last_mile_delivery', 'source_warehouse_id',",
    "  'quantity', 'shipping_method', 'last_mile_delivery', 'source_warehouse_id',");
  var clean = readback(freezeFrom(), { aHeader: { draft_version: '5' } });
  var badF = freezeFrom(live(), { census: m });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', { aHeader: { draft_version: '5' } },
    { after: badF.source });
  return failed(clean.res).indexOf('route_A_is_byte_identical') >= 0
    && failed(bad.res).indexOf('route_A_is_byte_identical') < 0;
});

mut('N2 the readback recomputing its own baseline instead of refusing', function () {
  // The refusal is held by TWO locks — the early return and the proof guard — so the mutant removes both.
  // Either alone still STOPS, which is the point of having two.
  var m = swap(CENSUS, '  out.baseline_frozen = missing.length === 0;', '  out.baseline_frozen = true;');
  m = swap(m, "  if (out.baseline_frozen !== true) missing.push('baseline_frozen');",
    "  if (false) { missing.push('baseline_frozen'); }");
  var clean = runIt('RUN_R6R7_CONTROLLED_NO_ACTION_READBACK');
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK');
  return clean.res.verdict === 'STOP'
    && String(clean.res.stop_reason).indexOf('BASELINE_NOT_FROZEN') === 0
    && String(bad.res.stop_reason).indexOf('BASELINE_NOT_FROZEN') < 0;
});

mut('N3 the manifest reporting READY while the flag is already on', function () {
  var m = swap(CENSUS, "  P('flag_is_still_false', false, flagVal, flagVal === false);",
    "  P('flag_is_still_false', false, flagVal, true);");
  m = swap(m, "    if (out.flag && out.flag.value === true) missing.push('flag_already_true_cannot_be_ready_to_authorize');",
    "    if (false) { missing.push('x'); }");
  // A flag that is already on trips this predicate AND the preflight's own, so the claim is aimed at the
  // one this manifest owns rather than at the shared verdict.
  var clean = manifest(live(), { flagTrue: true });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST', live(), { flagTrue: true });
  return clean.res.verdict === 'STOP' && failed(clean.res).indexOf('flag_is_still_false') >= 0
    && clean.res.proof_missing.indexOf('flag_already_true_cannot_be_ready_to_authorize') < 0
    && failed(bad.res).indexOf('flag_is_still_false') < 0;
});

mut('N4 the allowlist checked for length but not for content', function () {
  var m = swap(CENSUS, "  P('allowlist_is_exactly_the_one_frozen_scope', 1, allow ? allow.length : null, exact);",
    "  P('allowlist_is_exactly_the_one_frozen_scope', 1, allow ? allow.length : null, !!allow && allow.length === 1);");
  var opts = { allowlist: [{ company: 'ResUS', country: 'US', marketplace: 'Walmart', sku: 'CO1100-R' }] };
  var clean = manifest(live(), opts);
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST', live(), opts);
  return failed(clean.res).indexOf('allowlist_is_exactly_the_one_frozen_scope') >= 0
    && failed(bad.res).indexOf('allowlist_is_exactly_the_one_frozen_scope') < 0;
});

mut('N5 an unreadable deployment contract treated as a healthy one', function () {
  var m = swap(CENSUS, "  P('deployment_contract_is_readable', true, out.deployment.available, out.deployment.available === true);",
    "  P('deployment_contract_is_readable', true, out.deployment.available, true);");
  var opts = { after: 'sysModuleBuildStamps_ = undefined;' };
  var clean = manifest(live(), opts);
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST', live(), opts);
  return failed(clean.res).indexOf('deployment_contract_is_readable') >= 0
    && failed(bad.res).indexOf('deployment_contract_is_readable') < 0;
});

mut('N6 a new row counted as a confirmation', function () {
  var m = swap(CENSUS, "    out.new_rows.length === 0);", "    true);");
  m = swap(m, "    if ((out.new_rows || []).length !== 0) missing.push('new_rows_contradict_NO_ACTION_CONFIRMED');",
    "    if (false) { missing.push('x'); }");
  var over = { extraHeaders: [{ allocation_draft_id: 'SADH-M6', generation_type: 'system_generated',
      generation_run_id: 'AIRUN-M6' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-M6', allocation_draft_id: 'SADH-M6', planned_qty: '7' }] };
  // A new row trips this predicate AND the AI-row count AND the proof guard. Aimed at the one it owns.
  var clean = readback(freezeFrom(), over);
  var badF = freezeFrom(live(), { census: m });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', over, { after: badF.source });
  return clean.res.verdict === 'STOP'
    && failed(clean.res).indexOf('no_header_or_line_was_created') >= 0
    && failed(bad.res).indexOf('no_header_or_line_was_created') < 0
    && bad.res.new_rows.length === 1;
});

function browserWith(rows, baselineSeq, snippet) {
  var ctx = { console: { log: function () {} } };
  ctx.window = ctx;
  ctx.KM = { transport: { timeline: function () {
    return { request_timeline: rows.slice(), requests: rows.length,
      mutations: rows.filter(function (r) { return r.kind === 'write'; }),
      mutation_requests: rows.filter(function (r) { return r.kind === 'write'; }).length }; } } };
  ctx.__R6R7_BASELINE = { max_seq: baselineSeq };
  vm.createContext(ctx);
  return vm.runInContext(snippet, ctx);
}

mut('N7 the browser delta reading the TOTAL instead of the delta', function () {
  var m = DELTA_SNIP.replace('return r.seq > b.max_seq;', 'return true;');
  var rows = PRIOR.concat([req(4, 'weeklyAiPlan.generate', 'write')]);
  var clean = browserWith(rows, 3, DELTA_SNIP), bad = browserWith(rows, 3, m);
  return clean.new_mutation_requests === 1 && clean.verdict === 'ONE_GENERATION_REQUEST'
    && bad.new_mutation_requests === 2 && bad.verdict === 'STOP';
});

mut('N8 a second generation request accepted as one', function () {
  var m = DELTA_SNIP.replace('exactly_one_generation_request: gen.length === 1,',
    'exactly_one_generation_request: gen.length >= 1,');
  var rows = PRIOR.concat([req(4, 'weeklyAiPlan.generate', 'write'), req(5, 'weeklyAiPlan.generate', 'write')]);
  return browserWith(rows, 3, DELTA_SNIP).exactly_one_generation_request === false
    && browserWith(rows, 3, m).exactly_one_generation_request === true;
});

mut('N9 the manual total compared against itself rather than against BEFORE', function () {
  var m = swap(CENSUS, "  P('manual_planned_total_did_not_move', B.manual_planned_total, total, total === B.manual_planned_total);",
    "  P('manual_planned_total_did_not_move', total, total, true);");
  var over = { aLine: { planned_qty: '300' } };
  var clean = readback(freezeFrom(), over);
  var badF = freezeFrom(live(), { census: m });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', over, { after: badF.source });
  return failed(clean.res).indexOf('manual_planned_total_did_not_move') >= 0
    && failed(bad.res).indexOf('manual_planned_total_did_not_move') < 0;
});

mut('N10 the readback claiming to have measured the browser', function () {
  var m = swap(CENSUS, "    measured_here: false,", "    measured_here: true,");
  var badF = freezeFrom(live(), { census: m });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', live(), { after: badF.source });
  return readback(freezeFrom()).res.browser_transport.measured_here === false
    && bad.res.browser_transport.measured_here === true;
});

mut('N11 an unreadable reservation count read as zero', function () {
  // A world where the server manifest cannot be asked either, so null === null is the ONLY thing left.
  var noManifest = swap(CENSUS,
    "    var man = (typeof weeklyAiPlanActivationManifest_ === 'function') ? weeklyAiPlanActivationManifest_() : null;",
    "    var man = null;");
  var m = swap(noManifest, "    resvComparable ? (resv.row_count === B.reservation_row_count) : resvDeclaredZero);",
    "    resv.row_count === B.reservation_row_count);");
  var cf = freezeFrom(live(), { census: noManifest });
  var clean = withCensus(noManifest, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', live(), { after: cf.source });
  var bf = freezeFrom(live(), { census: m });
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_READBACK', live(), { after: bf.source });
  return failed(clean.res).indexOf('no_reservation_appeared') >= 0
    && failed(bad.res).indexOf('no_reservation_appeared') < 0;
});

mut('N12 the manifest proof dropping the frozen fingerprints', function () {
  var m = swap(CENSUS, "    if (!b.route_a_fingerprint || !b.route_b_fingerprint) missing.push('frozen_before.route_fingerprints');",
    "    if (false) { missing.push('x'); }");
  m = swap(m, "      route_a_fingerprint: b.route_a_fingerprint || null,",
    "      route_a_fingerprint: null,");
  var bad = withCensus(m, 'RUN_R6R7_CONTROLLED_NO_ACTION_ACTIVATION_MANIFEST');
  return !!proofOf(manifest()).frozen_before.route_a_fingerprint
    && proofOf(bad).frozen_before.route_a_fingerprint === null
    && proofOf(bad).proof_complete === true;
});


console.log('\npassed ' + pass + '  failed ' + fail
  + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);
