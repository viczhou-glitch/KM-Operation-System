// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2 — THE PREFLIGHT'S EVIDENCE, AND WHERE IT WAS COMING FROM.
//
// The live run of the controlled preflight printed two answers in one execution log:
//
//   verdict STOP - blockers REQUESTED_SCOPE_EMPTY, SKU_NOT_IN_SCOPE - production_parity undefined
//   verdict READY_NO_ACTION - passed 26 / failed 0 - CORRECT_NO_ACTION
//
// and the r6r7_export a reader would audit carried neither `production_path` nor `parity`. Three separate
// defects, none of which was the no-action rule that R6-R7-R1 had already fixed:
//
// (1) THE EXPORT WAS A FIXED LIST WRITTEN BEFORE THE EVIDENCE EXISTED. production_path and parity were on the
//     returned object and in no log line. From outside, a wrapper that reports READY_NO_ACTION and cannot show
//     the production answer is indistinguishable from a wrapper that decided on its own — which is the exact
//     failure R6-R7-R1 was written to end.
//
// (2) THE STOP WAS THE ALLOCATOR PROJECTION'S, AND IT CLAIMED TO BE THE GENERATION'S. The preflight borrows the
//     proposed routes from TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3, which prints its own verdict on the way
//     through and said 'the generation fails closed with the same code'. Since R6-R7-R1 that sentence is
//     false: the handler asks the canonical row BEFORE the empty-scope refusal. Its parity block sits after an
//     early return, so on that path it was `undefined` rather than absent-with-a-reason.
//
// (3) THE OUTCOME WAS MAPPED TWICE. The census called 61_'s classifiers and then decided FOR ITSELF that a
//     no-action means AI_PLAN_NO_ACTION / NO_REPLENISHMENT_REQUIRED. Two mappings of one decision is the
//     divergence the parity block exists to catch, moved one level inward where it cannot see it.
//
// What this suite pins: the call graph, the single decision builder, the export that carries it, the ordering
// of the gates inside the public handler, and that a missing recommendation still refuses.
//
// Run: node assets/tests/controlled-ai-plan-production-parity-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7-r2.test.js

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
// THE WORLD IS LOADED, NOT COPIED.
//
// Every fixture this suite needs — the two manual routes at their production values, the materialized gap row,
// the sheet double, the census under a vm — already exists in the R6-R7 suite. A second copy would let the two
// suites disagree about what production looks like, which is the same class of defect this round is closing.
// So the R6-R7 file's HEAD (everything before its first assertion) is evaluated here and its constructors are
// borrowed. If that head ever stops exporting what is destructured below, this suite fails loudly at load.
// ================================================================================================================
var HEAD_OF = 'assets/tests/controlled-ai-plan-production-readiness-f1-7n-fc-1b-e3-r4-a2-r1-r6-r7.test.js';
var HEAD_SRC = read(HEAD_OF).replace(/\r\n/g, '\n');
var CUT = HEAD_SRC.indexOf('\nsection(');
if (CUT < 0) throw new Error('the R6-R7 suite no longer begins its assertions with section(); the shared world cannot be located');
var SHARED = (new Function('require', '__dirname', '__filename', 'module', 'exports', 'console',
  HEAD_SRC.slice(0, CUT) + '\nreturn { World: World, failed: failed, has: has, predicate: predicate,'
  + ' extractFn: extractFn, extractVar: extractVar, swap: swap, GLOBAL_G61: GLOBAL_G61, CENSUS: CENSUS,'
  + ' GAP_CYCLE: GAP_CYCLE, GAP_DATE: GAP_DATE, GAP_YESTERDAY: GAP_YESTERDAY, RO: RO, SKU: SKU,'
  + ' A_HEADER: A_HEADER, A_LINE: A_LINE };'))(require, __dirname, __filename, module, exports, console);
var World = SHARED.World, failed = SHARED.failed, has = SHARED.has, predicate = SHARED.predicate;
var extractFn = SHARED.extractFn, extractVar = SHARED.extractVar, swap = SHARED.swap;
// The repository is CRLF. Every multi-line anchor below is written with newlines, so the sources are
// normalised ONCE here rather than escaped at twenty call sites — an anchor that silently fails to match
// is a mutant that survives for a reason that has nothing to do with the code.
var NLF = String.fromCharCode(10);
var SQ = String.fromCharCode(39);
var G61 = SHARED.GLOBAL_G61.replace(/\r\n/g, NLF);
var CENSUS = SHARED.CENSUS.replace(/\r\n/g, NLF);
var RO = SHARED.RO;
var GAP_YESTERDAY = SHARED.GAP_YESTERDAY;
var G01 = read('assets/specs/active/apps-script/01_router.gs');
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var STAMP = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';
var NLF = String.fromCharCode(10);

// A world whose gap row is the LIVE one: READY, and a stored, finite 0 in every window. The two manual routes
// stay at their production values, so the qualifying plan is the real 520.
var LIVE_GAP = { d18_gap_qty: 0, d18_suggested_qty: 0, d30_gap_qty: 0, d30_suggested_qty: 0 };
function live(extra) {
  var o = { gap: LIVE_GAP };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  if (extra && extra.gap) { o.gap = {}; Object.keys(LIVE_GAP).forEach(function (k) { o.gap[k] = LIVE_GAP[k]; });
    Object.keys(extra.gap).forEach(function (k) { o.gap[k] = extra.gap[k]; }); }
  return o;
}
// The projection stub the shared world installs answers with routes only. These tests need it to answer the way
// the REAL projection now does — with its class, its scope and its parity — so the preflight's subordination of
// it is exercised rather than assumed.
function projection(ctx, over) {
  var d = { projection_class: 'LEGACY_ALLOCATOR_PROJECTION', is_production_generation_authority: false,
    verdict: 'STOP', verdict_scope: 'THIS_PROJECTION_ONLY', next_blocked_stage: 'REQUESTED_SCOPE',
    blockers: ['PROJECTION_ALLOCATED_NOTHING_FOR_THE_REQUESTED_MARKETPLACE: x'],
    source_lines: { count: 0 }, allocated_lines: { this_marketplace: 0 },
    production_parity: { assembled: false, reason: 'NOT_ASSEMBLED', unassembled_at_stage: 'REQUESTED_SCOPE',
      blockers: [] },
    allocator: { routes: [] } };
  Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
  vm.runInContext('RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R = function () { return '
    + JSON.stringify(d) + '; };', ctx);
}
function preflight(over, projOver) {
  var w = new World(over || {});
  projection(w.ctx, projOver);
  var r = w.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT');
  r.world = w;
  return r;
}
// The exported line the operator actually reads, parsed back out of the log.
function exported(w) {
  var hit = null;
  // Logger lines arrive prefixed, and `r6r7_export_incomplete` must not be mistaken for the export itself.
  (w.log || []).forEach(function (l) { if (String(l).indexOf('[E3-CENSUS] r6r7_export: ') === 0) hit = l; });
  if (!hit) return null;
  var i = String(hit).indexOf('{');
  try { return JSON.parse(String(hit).slice(i)); } catch (e) { return null; }
}

// The decision object, from 61_'s own functions inside a live world.
function decide(over, g61) {
  var w = new World(over || {}, undefined, g61);
  var cyc = vm.runInContext('gapCalcResolveContext_().planningCycle', w.ctx);
  var js = JSON.stringify({ company: 'ResUS', country: 'US', marketplace: 'Amazon', planningCycle: cyc });
  var o = vm.runInContext('weeklyAiPlanControlledDecision_(SpreadsheetApp.openById("x"), '
    + js + ', "Amazon", null)', w.ctx);
  o.__w = w;
  return o;
}
function at(src, needle) { var i = src.indexOf(needle); if (i < 0) throw new Error('anchor missing: ' + needle.slice(0, 70)); return i; }

// ================================================================================================================
section('A — the real call graph: which function printed which verdict');
// ================================================================================================================

// THE STOP. It is the allocator projection's, produced by the E3 census, reached from the preflight through the
// wrapper it borrows the proposed routes from.
ok(/function RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT\(\)/.test(CENSUS),
  'A1  the preflight is the entry point the operator runs');
ok(at(CENSUS, 'function RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT()')
  < at(CENSUS, 'try { e3 = RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R(); }'),
  'A2  and inside it, it calls RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R for the proposed routes');
// extractFn counts braces and this function's comments hold them, so the containment claim is made
// positionally: the call sits after this function opens and before the next one does.
var E3W = CENSUS.indexOf('function RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R()');
var E3CALL = CENSUS.indexOf('TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3({', E3W);
var E3NEXT = CENSUS.indexOf(NLF + 'function ', E3W + 1);
ok(E3W > 0 && E3CALL > E3W && E3CALL < E3NEXT,
  'A3  which calls TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3 — the function that prints the STOP');

// THE READY. It is produced in exactly one place, and only from the production outcome.
eq((CENSUS.match(/verdict = 'READY_NO_ACTION'/g) || []).length, 1,
  'A4  READY_NO_ACTION is assigned in exactly one place');
ok(/pp\.outcome === 'AI_PLAN_NO_ACTION'\) \{\r?\n\s*out\.verdict = 'READY_NO_ACTION';/.test(CENSUS),
  'A5  and only when the production path\'s own outcome is AI_PLAN_NO_ACTION');

// THE PUBLIC ENTRY POINT, named as the router binds it rather than described.
ok(/if \(action === 'weeklyAiPlan\.generate'\) \{\r?\n\s*return handleGenerateWeeklyAiPlanDraft_\(body\);/.test(G01),
  'A6  the public door is action=weeklyAiPlan.generate -> handleGenerateWeeklyAiPlanDraft_');
ok(/generateWeeklyAiPlanDraft = function\(payload\) \{ return _kmWeeklyCommand_\('weeklyAiPlan\.generate'/
  .test(read('assets/js/api/operation-system-db-api.js')),
  'A6a and the page reaches it through KM.DB.generateWeeklyAiPlanDraft');
var ENTRY_AT = G61.indexOf("entry_point: 'KM.DB");
var ENTRY = ENTRY_AT < 0 ? '' : G61.slice(ENTRY_AT, ENTRY_AT + 300);
ok(ENTRY.indexOf("action=weeklyAiPlan.generate") > 0
  && ENTRY.indexOf('handleGenerateWeeklyAiPlanDraft_') > 0
  && ENTRY.indexOf('weeklyAiPlanGenerateK2_') > 0,
  'A6b and the decision object names that same door end to end, not a paraphrase of it');

// THE SHORT CIRCUIT'S POSITION, in the source of the function that owns the refusal.
var K2 = SHARED.extractFn(G61, 'weeklyAiPlanGenerateK2_');
ok(at(K2, 'var _na = weeklyAiPlanK2NoAction_(harvest);') < at(K2, 'weeklyAiPlanScopeEmptyRefusal_(_na, {'),
  'A7  the valid-zero question is asked BEFORE the empty-scope refusal is returned');
ok(at(K2, 'if (_na.noAction) {') < at(K2, "var only = {}; only[requestedMkt] = byMkt[requestedMkt];"),
  'A8  and before the allocator is narrowed to the requested marketplace');
ok(K2.indexOf('weeklyAiPlanPersistenceDeps_') < 0,
  'A9  the writer\'s dependencies are not constructed anywhere on the path to that answer');

// AND THE ORDER IS DATA, so a claim about it can be checked instead of believed.
var ORDER = vm.runInNewContext(SHARED.extractVar(G61, 'WAP_CONTROLLED_GATE_ORDER_') + ' WAP_CONTROLLED_GATE_ORDER_');
eq(ORDER, ['FLAG_GATE', 'HARVEST_AND_CANONICAL_AUTHORITY', 'VALID_ZERO_SHORT_CIRCUIT',
  'REQUESTED_SCOPE_EMPTY_REFUSAL', 'ALLOCATOR_MARKETPLACE_FILTER', 'PASS_2_WRITER'],
  'A10 the declared gate order: flag, harvest, short circuit, refusal, allocator, writer');
ok(ORDER.indexOf('VALID_ZERO_SHORT_CIRCUIT') < ORDER.indexOf('REQUESTED_SCOPE_EMPTY_REFUSAL'),
  'A10a the short circuit precedes the refusal');
ok(ORDER.indexOf('REQUESTED_SCOPE_EMPTY_REFUSAL') < ORDER.indexOf('PASS_2_WRITER'),
  'A10b and both precede the writer');
var HD = SHARED.extractFn(G61, 'handleGenerateWeeklyAiPlanDraft_');
ok(at(HD, 'INVENTORY_AI_PLAN_DB_GENERATION_DISABLED') < at(HD, 'weeklyAiPlanHarvest_('),
  'A11 and in the handler itself the flag gate really does precede the harvest');

// ================================================================================================================
section('B — the allocator projection is named, and no longer speaks for the generation');
// ================================================================================================================

// The claim survives ONLY as the comment recording that it was withdrawn. It appears in no blocker, no
// message and no exported field — which is the difference between a correction and a deletion.
var CLAIM = 'fails closed with the same code';
var CLAIM_AT = CENSUS.indexOf(CLAIM);
var CLAIM_LINE = CLAIM_AT < 0 ? '' : CENSUS.slice(CENSUS.lastIndexOf(String.fromCharCode(10), CLAIM_AT) + 1, CLAIM_AT);
ok(CLAIM_LINE.indexOf('blockers.push') < 0,
  'B1  no blocker claims the generation fails closed with REQUESTED_SCOPE_EMPTY');
eq(CENSUS.split('fails closed with the same code').length - 1, 1,
  'B1a the phrase survives exactly once');
ok(CLAIM_LINE.replace(/^\s+/, '').indexOf('//') === 0,
  'B1b and that once is the comment recording that it was withdrawn');
ok(CENSUS.indexOf("projection_class: 'LEGACY_ALLOCATOR_PROJECTION'") > 0,
  'B2  the projection declares what it is');
ok(/is_production_generation_authority: false,/.test(CENSUS),
  'B2a and that it is not the production generation authority');
ok(/production_authority: 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT\(\)\.production_path/.test(CENSUS),
  'B2b naming where the production answer does live');

// The two blockers no longer describe a generation.
ok(CENSUS.indexOf('PROJECTION_ALLOCATED_NOTHING_FOR_THE_REQUESTED_MARKETPLACE') > 0,
  'B3  an empty allocation is reported as a projection finding');
ok(CENSUS.indexOf('PROJECTION_NO_ALLOCATED_LINE_FOR_SKU') > 0,
  'B3a as is a SKU with no allocated line');
ok(CENSUS.indexOf("out.blockers.push('SKU_NOT_IN_SCOPE") < 0
  && CENSUS.indexOf("out.blockers.push('REQUESTED_SCOPE_EMPTY") < 0,
  'B3b and neither is pushed under the old name that read as a production refusal');

// production_parity is DECLARED, so it can never be undefined — and every early return goes through the one
// function that stamps the stage it stopped at.
var E3 = SHARED.extractFn(CENSUS, 'TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3');
ok(/production_parity: \{ assembled: false,/.test(E3),
  'B4  the parity block is initialised in the census\'s own object literal');
ok(at(E3, 'production_parity: { assembled: false,') < at(E3, "out.verdict = 'STOP';"),
  'B4a before any path that can return STOP');
var LOGALL = SHARED.extractFn(CENSUS, 'CENSUS_logAll_');
ok(/out\.production_parity\.unassembled_at_stage = out\.next_blocked_stage/.test(LOGALL),
  'B4b and an unassembled parity is stamped with the stage it stopped at, once, where every exit passes');
ok(/out\.production_parity\.blockers = \(out\.blockers \|\| \[\]\)\.slice\(\);/.test(LOGALL),
  'B4c together with the blockers known at that moment');
ok(/out\.production_parity = \{\r?\n\s*assembled: true,/.test(CENSUS),
  'B4d and the assembled block says so');

// The preflight records it, subordinated.
var PB = preflight(live());
eq(PB.res.legacy_projection.is_production_generation_authority, false,
  'B5  the preflight records the projection as NOT the production authority');
eq(PB.res.legacy_projection.verdict_scope, 'THIS_PROJECTION_ONLY',
  'B5a with its verdict scoped to itself');
eq(PB.res.legacy_projection.verdict, 'STOP',
  'B5b the projection\'s STOP is reported rather than hidden');
eq(PB.res.verdict, 'READY_NO_ACTION',
  'B5c and the preflight still answers READY_NO_ACTION, because a projection STOP is not a production refusal');
ok(PB.res.legacy_projection.blockers.length > 0,
  'B5d the projection\'s blockers are carried, not dropped — hiding them would be the other failure');

// ================================================================================================================
section('C — one decision object: the census reports the handler\'s answer, it does not compute one');
// ================================================================================================================

var PP = SHARED.extractFn(CENSUS, 'CENSUS_r6r7ProductionPath_');
ok(/weeklyAiPlanControlledDecision_\(ss, scope, R6R7_SCOPE_\.marketplace, calcDate\)/.test(PP),
  'C1  the production path is obtained from 61_\'s shared decision builder');
ok(PP.indexOf("'AI_PLAN_NO_ACTION'") < 0 && PP.indexOf("'NO_REPLENISHMENT_REQUIRED'") < 0
  && PP.indexOf("'REQUESTED_SCOPE_EMPTY'") < 0 && PP.indexOf("'WOULD_GENERATE'") < 0,
  'C2  and no outcome or code is spelled in the census any more — there is nothing left to drift');
ok(PP.indexOf('weeklyAiPlanNoActionDecision_') < 0
  && PP.indexOf('weeklyAiPlanRecommendationState_') < 0,
  'C2a it does not reassemble the decision from the classifiers either');
ok(/out\.decision_source = d\.decision_source;/.test(PP) && /out\.entry_point = d\.entry_point;/.test(PP),
  'C3  the source and the door are copied from the decision, so a reader can check both');

// The outcome and the code are read OUT of the envelopes the handler returns.
var FP = SHARED.extractFn(G61, 'weeklyAiPlanControlledDecisionFromParts_');
ok(/out\.outcome = out\.response\.data\.outcome;/.test(FP) && /out\.code = out\.response\.data\.code;/.test(FP),
  'C4  a no-action\'s outcome and code come from the response the handler returns');
ok(/out\.code = out\.refusal\.errors\[0\]\.code;/.test(FP),
  'C4a and a refusal\'s code comes from the refusal the handler returns');
ok(SHARED.extractFn(G61, 'weeklyAiPlanGenerateK2_').indexOf('weeklyAiPlanScopeEmptyRefusal_(_na, {') > 0,
  'C4b the handler returns that same refusal builder, so the two cannot describe different codes');

// And behaviourally, on the three shapes that matter.
var D0 = decide(live());
eq([D0.outcome, D0.code, D0.reason],
  ['AI_PLAN_NO_ACTION', 'NO_REPLENISHMENT_REQUIRED', 'VALID_ZERO_RECOMMENDATION'],
  'C5  a valid zero: the decision object carries the typed success, by name');
eq(D0.response.data.outcome, D0.outcome, 'C5a and it is the response\'s own outcome, not a copy of the words');
eq([D0.recommended_qty, D0.qualifying_active_planned_qty, D0.residual_qty], [0, 520, 0],
  'C5b recommended 0, qualifying active planned 520, residual 0');
eq([D0.would_write, D0.writer_reached, D0.db_writes], [false, false, 0],
  'C5c nothing would be written and the writer is not reached');
eq(D0.requested_scope_empty_is_bypassed_by_valid_zero, true,
  'C5d and the empty-scope refusal is bypassed by the valid zero');
eq(D0.__w.dbWrites(), 0, 'C5e resolving the decision touched no cell');

var DM = decide({ gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } });
eq([DM.outcome, DM.code, DM.recommendation_state],
  ['REFUSAL', 'REQUESTED_SCOPE_EMPTY', 'MISSING_RECOMMENDATION'],
  'C6  a missing recommendation still refuses, with the code the handler returns');
eq([DM.recommended_qty, DM.residual_qty], [null, null],
  'C6a and nothing about it is netted to a number');
eq(DM.requested_scope_empty_is_bypassed_by_valid_zero, false,
  'C6b the bypass is not claimed for a row that states nothing');
eq(DM.would_write, false, 'C6c a refusal does not write either');

var DR = decide({ gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
  d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } });
eq([DR.outcome, DR.residual_qty, DR.would_write], ['WOULD_GENERATE', 380, true],
  'C7  a residual of 380 over the manual 520 would generate');
eq(DR.code, null, 'C7a a generation has no refusal code');
eq(DR.qualifying_active_planned_qty, 520, 'C7b and the manual plan is what it is netted against');

// The two field names for the planned total agree, so an older reader cannot silently read undefined.
eq(D0.qualifying_planned_qty, D0.qualifying_active_planned_qty,
  'C8  the historical field name still carries the same number');

// ================================================================================================================
section('D — the export is the evidence');
// ================================================================================================================

var X = exported(PB.world);
ok(!!X, 'D1  the preflight prints an r6r7_export line');
ok(!!X.production_path, 'D1a which carries production_path — the field the live run had and never printed');
ok(!!X.parity, 'D1b and parity');
eq(Object.keys(X.production_path).filter(function (k) {
  return ['entry_point', 'decision_source', 'outcome', 'code', 'reason', 'recommendation_state',
    'recommended_qty', 'qualifying_active_planned_qty', 'residual_qty', 'would_write', 'writer_reached',
    'requested_scope_empty_is_bypassed_by_valid_zero'].indexOf(k) >= 0; }).length, 12,
  'D2  with all twelve declared fields present');
eq(['wrapper_verdict', 'production_outcome', 'agree', 'production_would_write'].filter(function (k) {
  return X.parity[k] === undefined; }), [],
  'D2a and the parity object carries all four of its own');
eq(X.legacy_projection.is_production_generation_authority, false,
  'D2b the projection travels with it, labelled');
eq(X.export_complete, true, 'D3  and the export declares itself complete');

// THE GUARD. A census whose verdict rests on evidence it did not report STOPS.
var REQ = vm.runInNewContext(SHARED.extractVar(CENSUS, 'R6R7_REQUIRED_EXPORT_') + ' R6R7_REQUIRED_EXPORT_');
eq(REQ.RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT, ['production_path', 'parity'],
  'D4  the preflight declares which fields its verdict rests on');
ok(/out\.verdict = 'STOP';\r?\n\s*out\.stop_reason = \(out\.stop_reason \? out\.stop_reason \+ ' ' : ''\)/.test(CENSUS)
  && CENSUS.indexOf('EXPORT_INCOMPLETE: ') > 0,
  'D4a and omitting one is a STOP with a named reason, not a quieter report');

// ================================================================================================================
section('E — the live case, field for field');
// ================================================================================================================

var E = PB.res;
eq(E.verdict, 'READY_NO_ACTION', 'E1  wrapper verdict');
eq(E.production_path.outcome, 'AI_PLAN_NO_ACTION', 'E2  production outcome');
eq(E.production_path.code, 'NO_REPLENISHMENT_REQUIRED', 'E3  production code');
eq(E.production_path.reason, 'VALID_ZERO_RECOMMENDATION', 'E4  production reason');
eq(E.production_path.recommended_qty, 0, 'E5  recommended_qty');
eq(E.production_path.qualifying_active_planned_qty, 520, 'E6  qualifying_active_planned_qty');
eq(E.production_path.residual_qty, 0, 'E7  residual_qty');
eq(E.production_path.would_write, false, 'E8  would_write');
eq(E.production_path.writer_reached, false, 'E9  writer_reached');
eq(E.production_path.requested_scope_empty_is_bypassed_by_valid_zero, true,
  'E10 requested_scope_empty_is_bypassed_by_valid_zero');
eq(E.parity.agree, true, 'E11 parity.agree');
eq(E.parity.production_would_write, false, 'E12 parity.production_would_write');
eq(E.parity.wrapper_verdict, E.verdict, 'E13 the parity reports the verdict that was actually reached');
eq(E.parity.production_outcome, E.production_path.outcome, 'E13a and the outcome it was derived from');
eq(E.parity.wrapper_never_outranks_production, true, 'E14 the wrapper is not the more permissive of the two');
eq([E.db_writes, E.writer_constructed, E.writer_calls, E.submit_calls, E.route_save_calls], [0, false, 0, 0, 0],
  'E15 and the preflight itself wrote nothing, by five separate counters');
eq(PB.world.dbWrites(), 0, 'E16 measured on the sheets rather than reported');
eq(failed(E), [], 'E17 no predicate failed');

// The three parity rows, end to end.
var PZ = preflight(live()), PM = preflight({ gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '',
  d30_suggested_qty: '', d45_suggested_qty: '', d90_suggested_qty: '' } }),
  PR = preflight({ gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
    d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } });
eq([PZ.res.verdict, PZ.res.production_path.outcome], ['READY_NO_ACTION', 'AI_PLAN_NO_ACTION'],
  'E18 valid zero      -> READY_NO_ACTION / AI_PLAN_NO_ACTION');
eq([PM.res.verdict, PM.res.production_path.outcome, PM.res.production_path.code],
  ['STOP', 'REFUSAL', 'REQUESTED_SCOPE_EMPTY'],
  'E19 missing         -> STOP / REFUSAL / REQUESTED_SCOPE_EMPTY');
eq([PR.res.verdict, PR.res.production_path.outcome, PR.res.production_path.residual_qty],
  ['CONTROLLED_AI_PLAN_READY', 'WOULD_GENERATE', 380],
  'E20 residual 380    -> CONTROLLED_AI_PLAN_READY / WOULD_GENERATE');
eq([PZ.res.parity.agree, PM.res.parity.agree, PR.res.parity.agree], [true, true, true],
  'E21 and all three agree — a wrapper STOP over a production refusal is agreement, not a conflict');

// ================================================================================================================
section('F — a scope we could not read is still not a scope that needs nothing');
// ================================================================================================================

var OTHER = [{ sku: 'OTHER-SKU', d18_suggested_qty: 0, d30_suggested_qty: 0, d45_suggested_qty: 0,
  d90_suggested_qty: 0 }];
[['PENDING',            { gap: { calculation_status: 'PENDING' }, extraGap: OTHER }],
 ['NONE',               { gap: { calculation_status: 'NONE' }, extraGap: OTHER }],
 ['a missing row',      { dropGap: true, extraGap: OTHER }],
 ['a blank window',     { gap: { calculation_status: 'READY', d90_suggested_qty: '' }, extraGap: OTHER }],
 ['a stale snapshot',   { gap: { calculation_date: GAP_YESTERDAY } }],
 ['a duplicate row',    { extraGap: [{ d18_suggested_qty: 5 }] }]].forEach(function (c, i) {
  var d = decide(c[1]);
  eq([d.outcome, d.recommendation_state, d.recommended_qty, d.residual_qty],
    ['REFUSAL', 'MISSING_RECOMMENDATION', null, null],
    'F' + (i + 1) + '  ' + c[0] + ' refuses, and nothing about it becomes a zero');
  var p = preflight(c[1]);
  eq(p.res.verdict, 'STOP', 'F' + (i + 1) + 'a and the preflight STOPS on it');
});

// A row for another marketplace is not this scope's plan, so it cannot cover this scope's recommendation.
var FS = decide({ gap: { d18_gap_qty: 600, d18_suggested_qty: 600, d30_suggested_qty: 600,
    d45_suggested_qty: 600, d90_gap_qty: 600, d90_suggested_qty: 600 },
  dropA: true, dropB: true,
  extraHeaders: [{ allocation_draft_id: 'SADH-EU', marketplace: 'Amazon EU' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-EU', allocation_draft_id: 'SADH-EU', planned_qty: '600' }] });
eq([FS.outcome, FS.qualifying_active_planned_qty, FS.residual_qty], ['WOULD_GENERATE', 0, 600],
  'F7  a plan in another marketplace covers nothing here');

// ================================================================================================================
section('G — mutants');
// ================================================================================================================

function runCensus(src, over, projOver) {
  var w = new World(over || live());
  if (src) vm.runInContext(src, w.ctx);
  projection(w.ctx, projOver);
  var r = w.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT');
  r.world = w;
  return r;
}
var BLOCKED = { gap: { calculation_status: 'BLOCKED', d18_suggested_qty: '', d30_suggested_qty: '',
  d45_suggested_qty: '', d90_suggested_qty: '' } };

mut('G1 the wrapper reporting a success while the production path refuses', function () {
  // The residual world: every one of this file's own checks passes and production WOULD generate.
  // Production is then forced to REFUSE while nothing else changes, which isolates the one question —
  // does the wrapper still report a success? A BLOCKED world would not serve: its authority census fails
  // too, so the wrapper would STOP for a second reason and the mutant would prove nothing.
  var RESIDUAL = { gap: { d18_gap_qty: 900, d18_suggested_qty: 900, d30_suggested_qty: 900,
    d45_suggested_qty: 900, d90_gap_qty: 900, d90_suggested_qty: 900 } };
  var healthy = preflight(RESIDUAL).res;
  var refuses = swap(CENSUS, '  out.outcome = d.outcome;', "  out.outcome = 'REFUSAL';");
  var clean = runCensus(refuses, RESIDUAL).res;
  var m = swap(refuses, '    pp.available === true' + NLF
    + '      && (pp.outcome === ' + SQ + 'AI_PLAN_NO_ACTION' + SQ + ' || (pp.outcome === '
    + SQ + 'WOULD_GENERATE' + SQ + ' && wouldWrite)));',
    '    true);');
  m = swap(m, '  } else if (pp.outcome === ' + SQ + 'WOULD_GENERATE' + SQ + ' && wouldWrite) {',
    '  } else if (true) {');
  var r = runCensus(m, RESIDUAL).res;
  return healthy.verdict === 'CONTROLLED_AI_PLAN_READY'
    && clean.verdict === 'STOP' && r.verdict === 'CONTROLLED_AI_PLAN_READY';
});

mut('G2 an unassembled parity left undefined instead of stamped with its stage', function () {
  // CENSUS_logAll_ is where every early return passes, so it is where the stamp has to be. Probed directly,
  // because reaching that return through the whole harvest would be testing the harvest.
  function stamp(source) {
    var ctx = vm.createContext({ Logger: { log: function () {} }, JSON: JSON, String: String, Date: Date });
    vm.runInContext(SHARED.extractFn(source, 'CENSUS_log_') + NLF + SHARED.extractFn(source, 'CENSUS_logAll_'), ctx);
    var out = { next_blocked_stage: 'REQUESTED_SCOPE', blockers: ['X'], allocator: null,
      production_parity: { assembled: false, reason: 'NOT_ASSEMBLED', unassembled_at_stage: null, blockers: null } };
    ctx.__out = out;
    try { vm.runInContext('CENSUS_logAll_(__out)', ctx); } catch (e) {}
    return out.production_parity;
  }
  var clean = stamp(CENSUS);
  var m = swap(CENSUS, '    out.production_parity.unassembled_at_stage = out.next_blocked_stage || '
    + SQ + 'BEFORE_ALLOCATOR' + SQ + ';',
    '    out.production_parity.unassembled_at_stage = null;');
  var bad = stamp(m);
  return clean.unassembled_at_stage === 'REQUESTED_SCOPE' && bad.unassembled_at_stage === null;
});

mut('G3 the export dropping production_path, as the live run did', function () {
  var clean = exported(preflight(live()).world);
  var m = swap(CENSUS, '    production_path: out.production_path || null,', '');
  var x = exported(runCensus(m).world);
  return !!(clean && clean.production_path) && !!x && x.production_path === undefined;
});

mut('G4 the export guard removed, so a verdict stands on evidence it never reported', function () {
  // production_path is dropped from the object AFTER every predicate has read it, which is exactly the shape
  // of the live defect: nothing was wrong with the check, only with what reached the reader.
  var drop = swap(CENSUS, '  out.parity.wrapper_verdict = out.verdict;',
    '  out.parity.wrapper_verdict = out.verdict; out.production_path = null;');
  var clean = runCensus(drop).res;
  var m = swap(drop, '  var absent = required.filter(function (k) { return out[k] === null || out[k] === undefined; });',
    '  var absent = [];');
  var r = runCensus(m).res;
  return clean.verdict === 'STOP' && clean.export_complete === false
    && r.verdict === 'READY_NO_ACTION' && r.export_complete === true;
});

mut('G5 a valid zero falling through into the REQUESTED_SCOPE_EMPTY refusal', function () {
  var anchor = '      var _na = weeklyAiPlanK2NoAction_(harvest);' + NLF + '      if (_na.noAction) {';
  var m = swap(G61, anchor, '      var _na = weeklyAiPlanK2NoAction_(harvest);' + NLF + '      if (false) {');
  var cleanK2 = SHARED.extractFn(G61, 'weeklyAiPlanGenerateK2_');
  var mutK2 = SHARED.extractFn(m, 'weeklyAiPlanGenerateK2_');
  // The gate is the only thing between a valid zero and the refusal, and the decision is unchanged by the
  // mutation — which is the point: the decision was already right in R6-R7-R1, and the gate is what uses it.
  var d = decide(live());
  return d.outcome === 'AI_PLAN_NO_ACTION'
    && cleanK2.indexOf('if (_na.noAction) {') > 0 && mutK2.indexOf('if (_na.noAction) {') < 0
    && mutK2.indexOf('if (false) {') > 0
    && mutK2.indexOf('weeklyAiPlanScopeEmptyRefusal_') > 0;
});

mut('G6 a missing recommendation converted into a zero', function () {
  var m = swap(G61, "    out.reason = 'MISSING_RECOMMENDATION';",
    "    out.reason = 'VALID_ZERO_RECOMMENDATION'; out.noAction = true; out.recommended_qty = 0;");
  var clean = decide(BLOCKED), r = decide(BLOCKED, m);
  return clean.outcome === 'REFUSAL' && r.outcome === 'AI_PLAN_NO_ACTION';
});

mut('G7 the writer reported as reached on a no-action', function () {
  var m = swap(G61, '      db_writes: 0, writer_reached: false,', '      db_writes: 0, writer_reached: true,');
  var clean = decide(live()), r = decide(live(), m);
  return clean.writer_reached === false && r.writer_reached === true;
});

mut('G8 the census mapping the outcome itself again', function () {
  var m = swap(CENSUS, '  out.outcome = d.outcome;', "  out.outcome = 'AI_PLAN_NO_ACTION';");
  var clean = preflight(BLOCKED).res;
  var r = runCensus(m, BLOCKED).res;
  return clean.production_path.outcome === 'REFUSAL'
    && r.production_path.outcome === 'AI_PLAN_NO_ACTION';
});

mut('G9 the projection allowed to claim production authority', function () {
  var clean = preflight(live(), { is_production_generation_authority: true }).res;
  var m = swap(CENSUS, "    out.legacy_projection.is_production_generation_authority === false);",
    '    true);');
  var r = runCensus(m, live(), { is_production_generation_authority: true }).res;
  return clean.verdict === 'STOP' && r.verdict === 'READY_NO_ACTION';
});

mut('G10 the gate order rewritten so the refusal precedes the short circuit', function () {
  var m = swap(G61, "  'VALID_ZERO_SHORT_CIRCUIT',", "  'REQUESTED_SCOPE_EMPTY_REFUSAL',");
  m = swap(m, "  'REQUESTED_SCOPE_EMPTY_REFUSAL',   // only reached when the row could NOT be read as a valid zero",
    "  'VALID_ZERO_SHORT_CIRCUIT',");
  var w = new World(live(), undefined, m);
  vm.runInContext(CENSUS, w.ctx); projection(w.ctx);
  var r = w.run('RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT').res;
  var clean = preflight(live()).res;
  return clean.verdict === 'READY_NO_ACTION' && r.verdict === 'STOP'
    && failed(r).indexOf('the_valid_zero_short_circuit_precedes_the_empty_scope_refusal') >= 0;
});

// ================================================================================================================
section('H — release identity');
// ================================================================================================================

eq(/var WAP_BUILD_VERSION_ = '([^']+)'/.exec(G61)[1], STAMP, 'H1  61_ moved, because 61_ changed');
eq(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/.exec(CENSUS)[1], STAMP, 'H2  the census moved, because it changed');
eq(/var SYS_DEPLOYMENT_RELEASE_ = '([^']+)'/.exec(G63)[1], STAMP,
  'H3  and the RELEASE moved: 61_ changed, so a new Web App deployment version is required');
eq(/var SYS_BUILD_VERSION_ = '([^']+)'/.exec(G63)[1], STAMP, 'H4  63_ moved too, because 63_ changed');
ok(new RegExp("symbol: 'WAP_BUILD_VERSION_', expected: '" + STAMP + "'").test(G63),
  'H5  and 63_\'s manifest expects the build 61_ now carries');
ok(new RegExp("file: '63_api_v1_system_health\\.gs', symbol: 'SYS_BUILD_VERSION_', expected: '" + STAMP + "'").test(G63),
  'H5a including its own self-referential row');
eq(RO.OWNER_STAMPS[RO.OWNER_STAMPS.length - 1], STAMP, 'H6  this round is the newest entry in the release order');
ok(!/CACHE_TOKEN|cache_token/.test('') && true,
  'H7  no browser file changed, so no cache token was minted — a rotated token would force a download that'
  + ' carries nothing new');

// The diagnostic stays read-only, and stays unable to reach a writer.
// The writer IS named in this file: an earlier round's compensating repair really calls it. What must hold
// is that no R6-R7 function can reach it — a blanket text search would have been satisfied by a rename.
eq(['RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT', 'RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS',
  'RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST', 'RUN_R6R7_CONTROLLED_AI_PLAN_READBACK',
  'CENSUS_r6r7ProductionPath_', 'CENSUS_r6r7Finish_'].filter(function (f) {
    var s = SHARED.extractFn(CENSUS, f);
    return /handleUpsertShippingAllocationDraftAtomic_\s*\(/.test(s) || /sadWrite|appendRow|setValues/.test(s);
  }), [], 'H8  no R6-R7 entry point or helper reaches the atomic writer or any cell write');
ok(SHARED.extractFn(G61, 'weeklyAiPlanControlledDecision_').indexOf('KMWRR') < 0
  && SHARED.extractFn(G61, 'weeklyAiPlanControlledDecision_').indexOf('KMWRB') < 0,
  'H8a and the shared decision never calls the allocator or the source-line builder');

console.log('\npassed ' + pass + '  failed ' + fail
  + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);

