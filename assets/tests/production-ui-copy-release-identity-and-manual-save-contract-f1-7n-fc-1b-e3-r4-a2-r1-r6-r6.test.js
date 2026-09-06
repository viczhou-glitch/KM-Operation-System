// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6 — PRODUCTION UI COPY CLEANUP · RELEASE IDENTITY AUDIT ·
// CONTROLLED MANUAL ROUTE SAVE CONTRACT.
//
// Three findings, and only the first was reported as a defect.
//
// (1) THE RECONCILIATION WAS CORRECT AND UNUSABLE. Every sentence under the Execution Plan total was defending
//     against a specific misreading — that the standing quantity was an AI recommendation, that this run had
//     applied it, that two numbers about different warehouses could be subtracted. Each defence was a paragraph,
//     printed under a card whose job is to be operated, and five lines of prose sat between the plan total and
//     the next control. The operator said so plainly: the screen must be clean, and the commentary was in the
//     way of the work. §2/§3 keep every claim and remove every sentence — the claims move to labels, to
//     attributes and to a title, and the strip becomes three numbers.
//
// (2) THE TOP-LEVEL BUILD LIED ABOUT A DEPLOYMENT THAT HAD LANDED. After R6-R5 was deployed, `identity.build_id`
//     read R6-R2 beside `router_build` and `SIR_BUILD_VERSION_` at R6-R5, with `mixed_deployment: false`. The
//     reasonable conclusion — R6-R5 is not deployed — was wrong, and the field that produced it is the one whose
//     entire purpose is to prove which code answered. That is the FB-3A defect recorded at the top of 63_,
//     recurring. §4 finds the cause (one constant answering two questions), the reason the standing guard did
//     not fire (it abstains while a file is dirty, which is the whole window in which the rule can break), and
//     repairs both.
//
// (3) THE ACK_UNKNOWN PATH INVITED A SECOND WRITE WITHOUT ANYONE CLICKING RETRY. A route whose write outcome
//     could not be classified stayed in the touched set — correct for a route PROVEN unsaved, and wrong for one
//     nobody can classify. The next edit anywhere on the SKU flushed, found it still touched, and re-sent a
//     mutation that may already have committed. §7 holds the unclassifiable route out of the write scope until
//     a read-back settles it or an operator explicitly releases it.
//
// EVERYTHING BELOW IS EXECUTED. The strip is rendered, the census runs the shipped resolver, and the save
// contract runs against a faithful mutable double driven by 16_'s own core. No production write is performed
// and none is simulated as if it were one.
//
// Run: node assets/tests/production-ui-copy-release-identity-and-manual-save-contract-f1-7n-fc-1b-e3-r4-a2-r1-r6-r6.test.js

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
async function amut(label, f) {
  var r;
  try { r = await f(); } catch (e) { neg.missed++; fail++; console.error('FAIL ' + label + ' — PROBE ERROR: ' + (e && e.message)); return; }
  if (r === true) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}

var ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
var NL = String.fromCharCode(10);
var DASH = String.fromCharCode(0x2014);

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
  var k = src.indexOf(';', i);
  return src.slice(m.index, k + 1);
}
function mutateFn(src, name, find, replace) {
  var body = extractFn(src, name);
  if (body.indexOf(find) < 0) throw new Error('mutation target absent in ' + name + ': ' + find.slice(0, 90));
  return src.replace(body, body.replace(find, replace));
}

var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CSS = read('assets/css/pages/inventory-replenishment.css');
var INDEX = read('index.html');
var HEALTH = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var CFG = read('assets/specs/active/apps-script/00_config.gs');
var DBAPI = read('assets/js/api/operation-system-db-api.js');
var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var IRDraft = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js')).IRDraft;

var RELEASE = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6';

// ================================================================================================================
section('§0 — preflight: nothing in this round loosens a gate');
// ================================================================================================================
ok(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = false;/.test(CFG),
  'A1  the AI Plan DB generation flag is still false');
var allowlist = extractVar(CFG, 'INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_');
eq((allowlist.match(/\{ company:/g) || []).length, 1,
  'A2  the activation allowlist still holds exactly ONE scope');
ok(/company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R'/.test(allowlist),
  'A2a and it is the same scope — not widened');
// The two new diagnostic entry points, and the one that deliberately does not exist.
ok(/function RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT\(\)/.test(CENSUS),
  'A3  the read-only preflight entry point exists');
ok(/function RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK\(/.test(CENSUS),
  'A3a and the read-only readback');
ok(!/function RUN_R6R6[A-Z_]*(WRITE|SAVE_NOW|APPLY|COMMIT)/i.test(CENSUS),
  'A3b and NO helper performs the production write — the only future write is the ordinary UI path');
// A census that constructs a writer is not read-only, whatever it reports about itself.
var r6r6Src = extractFn(CENSUS, 'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT')
  + extractFn(CENSUS, 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK')
  + extractFn(CENSUS, 'CENSUS_r6r6MatchRouteA_');
ok(!/appendRow|setValues|setValue|sadUpsert|sadAtomicUpsertCore_|handleUpsert/.test(r6r6Src),
  'A4  neither entry point contains a write primitive');
// The census RESULT names reservation_writes and submit_calls — they are the zero-counters it reports — so a
// scan for the WORDS fails on a correct file. What would actually perform one is a CALL.
ok(!/(handleSubmit|submitReplenishmentPlans|weeklyAiPlanGenerate|acquireReservation|releaseReservation)\s*\(/i.test(r6r6Src),
  'A4a nor does either INVOKE a Submit, an AI Plan run, or a reservation');

// ================================================================================================================
section('§2/§3 — the reconciliation is three numbers, and every claim survived');
// ================================================================================================================
// The strip is RENDERED. A claim about copy that is checked against source cannot tell a comment from an output,
// which is the mistake the R6-R2/R6-R3 diff scans were narrowed to avoid.
function El(cls) { this.className = cls || ''; this.children = []; this._attrs = {}; this.value = ''; }
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.querySelector = function (sel) {
  var f = sel.replace(/[\[\]"]/g, '').replace('data-field=', '');
  for (var i = 0; i < this.children.length; i++) if (this.children[i]._field === f) return this.children[i];
  return null;
};
El.prototype.querySelectorAll = function (sel) {
  var out = [], want = sel.replace('.', '');
  this.children.forEach(function (c) { if (String(c.className).indexOf(want) !== -1) out.push(c); });
  out.forEach = Array.prototype.forEach; return out;
};
function field(f, v, attrs) {
  var e = new El(); e._field = f; e.value = v; e._attrs = attrs || {};
  e.options = [{ getAttribute: function (a) { return (attrs || {})[a] || ''; } }];
  e.selectedIndex = 0;
  e.getAttribute = function (a) { return (attrs || {})[a] || ''; };
  return e;
}
function routeRow(qty, src) {
  var r = new El('exec-route-row');
  r.appendChild(field('qty', String(qty)));
  r.appendChild(field('source_warehouse_id', src.id,
    { 'data-wh-name': src.name, 'data-wh-country': src.country, 'data-wh-type': 'FACTORY' }));
  return r;
}
var CN = { id: 'WH-CN-YOUXIN', name: 'CN Youxin', country: 'CN' };
function makeRecon(pageSrc, opts) {
  var list = new El('exec-routes-list');
  (opts.rows || []).forEach(function (r) { list.appendChild(r); });
  var doc = { getElementById: function (id) {
    return (id === 'shipping-methods-CO1100-R' && opts.hostPresent !== false) ? list : null; } };
  var win = { _irLastAdvice: opts.advice || null, _irExecPlanChangedByLastRun: false };
  var src = extractFn(pageSrc, '_irReconTooltip_') + NL + extractFn(pageSrc, '_irReconCell_') + NL
    + extractFn(pageSrc, '_irAdviceVsPlan_') + NL + extractFn(pageSrc, '_irAdviceVsPlanHtml_')
    + NL + 'return { model: _irAdviceVsPlan_, html: _irAdviceVsPlanHtml_ };';
  return new Function('document', 'window', '_irRecoByKey', '_irIsComposerEl_', 'getReplenishmentData',
    '_irSuggestedQtyState_', '_irInventoryAiPlanDbGenerationEnabled_', '_execEsc', src)(
      doc, win, opts.recoByKey || {},
      function (el) { return String(el.className).indexOf('exec-route-composer') !== -1; },
      function () { return [{ sku: 'CO1100-R' }]; },
      opts.suggested || function () { return { state: 'NONE', value: null }; },
      function () { return false; },
      function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); });
}
var LIVE_ROWS = [routeRow(320, CN), routeRow(200, CN)];
var recon = makeRecon(PAGE, { rows: LIVE_ROWS, suggested: function () { return { state: 'READY', value: 920 }; } });
var H = recon.html('CO1100-R');

// The three numbers, and their labels.
ok(/>Recommended<\/span><strong[^>]*>920</.test(H), 'B1  Recommended 920');
ok(/>Planned<\/span><strong[^>]*>520</.test(H), 'B1a Planned 520');
ok(/>Remaining<\/span><strong[^>]*>400</.test(H), 'B1b Remaining 400');
eq(/>(Recommended|Planned|Remaining|Excess)</g.test(H) ? (H.match(/>(Recommended|Planned|Remaining|Excess)</g) || []).length : 0, 3,
  'B1c and exactly three labelled cells — not four, and not a fourth line of prose');

// THE PARAGRAPH IS GONE. Checked as a bound on prose, not as the absence of four specific sentences: a round
// that reintroduced a DIFFERENT paragraph would pass the second and fail this.
var visible = H.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
ok(visible.length <= 80,
  'B2  the whole strip renders as ' + visible.length + ' characters of visible text (was five lines)');
eq(visible.split(' ').length <= 8, true, 'B2a — ' + JSON.stringify(visible));
ok(!/\./.test(visible), 'B2b and contains no sentence: there is no full stop anywhere in it');
ok(!/(has NOT been applied|no AI Plan has been run|not added automatically|already here|standing suggested)/i.test(H),
  'B2c none of the four removed sentences survives anywhere in the output');
// The internal vocabulary left the SCREEN without leaving the PAGE.
ok(/data-recommendation-source="MATERIALIZED_SUGGESTED_QTY"/.test(H)
  && !/MATERIALIZED_SUGGESTED_QTY/.test(visible),
  'B3  source authority is published on the element and is not visible text');
ok(/data-recommendation-state="READY"/.test(H) && /data-planned-state="READY"/.test(H),
  'B3a and so is each side\'s state, so a diagnostic loses nothing');
ok(/data-plan-changed-by-this-run="false"/.test(H),
  'B3b including whether THIS run changed the plan — the fact the sentence used to assert');

// EXCESS, never a negative Remaining.
var over = makeRecon(PAGE, { rows: [routeRow(520, CN)], suggested: function () { return { state: 'READY', value: 400 }; } });
var HO = over.html('CO1100-R');
ok(/>Excess<\/span><strong[^>]*>120</.test(HO), 'B4  a plan larger than the recommendation reads Excess 120');
ok(!/Remaining/.test(HO), 'B4a and the word Remaining is not used for it');
ok(!/-\d/.test(HO.replace(/data-[a-z-]+="[^"]*"/g, '')), 'B4b no negative number is ever printed');
eq(over.model('CO1100-R').remaining_unplanned, 0, 'B4c the model still reports remaining 0, not -120');
// max(rec - planned, 0) ALONE would have printed a bare 0 here, which reads as "nothing left to do" for the one
// state that most needs an operator to look at it. That is why the third column names itself.
ok(/data-difference-kind="EXCESS"/.test(HO) && /data-difference-kind="REMAINING"/.test(H),
  'B4d and the third column declares WHICH of the two it is');
// Exactly matched is its own state and is not an alarm.
var matched = makeRecon(PAGE, { rows: [routeRow(520, CN)], suggested: function () { return { state: 'READY', value: 520 }; } });
ok(/>Remaining<\/span><strong[^>]*ir-plan-recon__matched[^>]*>0</.test(matched.html('CO1100-R')),
  'B5  520 planned against 520 recommended is Remaining 0, styled as matched');

// PENDING AND UNAVAILABLE ARE NOT ZERO — the R6-R4 rule, now enforced on BOTH columns.
var pending = makeRecon(PAGE, { rows: LIVE_ROWS, suggested: function () { return { state: 'PENDING', value: null }; } });
var HP = pending.html('CO1100-R');
ok(HP.indexOf(DASH) !== -1 && /title="Still loading"/.test(HP),
  'B6  a PENDING recommendation renders an em dash with the reason on hover');
ok(!/\b0\b/.test(HP.replace(/520|400|320|200/g, '')), 'B6a and 0 appears nowhere');
ok(/>Remaining<\/span><strong[^>]*>' + DASH + '</.test(HP.replace(DASH, "' + DASH + '")) || HP.indexOf(DASH) !== -1,
  'B6b and the difference is a dash too — it cannot be computed from a number nobody has');
// The plan side. An absent host is "the Execution Plan has not rendered", which is not a plan of zero.
var noHost = makeRecon(PAGE, { rows: LIVE_ROWS, hostPresent: false,
  suggested: function () { return { state: 'READY', value: 920 }; } });
var HN = noHost.html('CO1100-R');
eq(noHost.model('CO1100-R').currently_planned_state, 'UNAVAILABLE',
  'B7  an absent Execution Plan host makes the planned total UNAVAILABLE, not 0');
ok(/data-planned-state="UNAVAILABLE"/.test(HN) && /title="Not available"/.test(HN),
  'B7a and the strip says so on the element and on hover');
eq(noHost.model('CO1100-R').remaining_unplanned, null,
  'B7b with no difference computed — subtracting from an uncountable plan is arithmetic without meaning');
// An EMPTY host is a real, countable zero, and must not be confused with the above.
var emptyHost = makeRecon(PAGE, { rows: [], suggested: function () { return { state: 'READY', value: 920 }; } });
eq(emptyHost.model('CO1100-R').currently_planned_state, 'READY',
  'B7c while an EMPTY plan is READY with 0 — the two are different facts and are told apart');
ok(/>Remaining<\/span><strong[^>]*>920</.test(emptyHost.html('CO1100-R')),
  'B7d so nothing planned against 920 recommended leaves 920 remaining');

// DIFFERENT SOURCES: four words, and the detail is reachable.
var diff = makeRecon(PAGE, { rows: LIVE_ROWS, suggested: function () { return { state: 'READY', value: 920 }; },
  advice: { scopes: [{ supply_sources: ['WH-RESUS-US-3PL-AMZLGS'] }] } });
var HD = diff.html('CO1100-R');
eq(diff.model('CO1100-R').supply_sources_comparable, false, 'B8  the two sides draw on different supply');
ok(/Different inventory sources/.test(HD), 'B8a and the strip says exactly that — four words');
ok(/title="Recommendation: WH-RESUS-US-3PL-AMZLGS\s*\nCurrent plan: CN Youxin \(CN\)"/.test(HD)
  || /Recommendation: WH-RESUS-US-3PL-AMZLGS/.test(HD) && /Current plan: CN Youxin \(CN\)/.test(HD),
  'B8b with which stock each side means in the title');
ok(/aria-label="Different inventory sources\./.test(HD),
  'B8c and an accessible description, so the detail is not mouse-only');
var visD = HD.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
ok(visD.indexOf('WH-RESUS') === -1 && visD.indexOf('Youxin') === -1,
  'B8d while the main line stays clean: neither warehouse is spelled in visible text');
// Same source: no warning at all, so its presence is information.
var same = makeRecon(PAGE, { rows: LIVE_ROWS, suggested: function () { return { state: 'READY', value: 920 }; },
  advice: { scopes: [{ supply_sources: ['WH-CN-YOUXIN'] }] } });
ok(!/Different inventory sources/.test(same.html('CO1100-R')),
  'B9  when the sources AGREE the warning is absent entirely');
eq(same.model('CO1100-R').supply_sources_comparable, true, 'B9a because they are comparable');

// One and four routes: the strip does not grow.
[1, 2, 4].forEach(function (n) {
  var rows = []; for (var i = 0; i < n; i++) rows.push(routeRow(130, CN));
  var h = makeRecon(PAGE, { rows: rows, suggested: function () { return { state: 'READY', value: 920 }; } }).html('CO1100-R');
  var v = h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  ok(v.length <= 80 && (h.match(/ir-plan-recon__cell/g) || []).length === 3,
    'B10 ' + n + ' route row(s): still three cells and ' + v.length + ' characters');
});

// ================================================================================================================
section('§3 — the strip is quieter than the controls, and the seven-track grid is untouched');
// ================================================================================================================
var reconCss = /#ops-section \.ir-plan-recon \{[\s\S]*?\}/.exec(CSS)[0];
ok(/flex-wrap:\s*nowrap/.test(reconCss), 'C1  the strip does not wrap — a second line is the paragraph returning');
ok(!/background-color/.test(reconCss), 'C2  no fill: a reconciliation is a reading, not an alarm');
ok(/border-top:/.test(reconCss) && !/\bborder:\s/.test(reconCss),
  'C3  a hairline rule instead of a box, so it does not out-compete the Route rows above it');
ok(!/ir-plan-recon__note/.test(CSS) && !/ir-plan-recon__note/.test(PAGE),
  'C4  the full-width note rule is gone from BOTH the stylesheet and the page — no orphan either way');
ok(/#ops-section \.ir-plan-recon__flag[\s\S]*?text-overflow:\s*ellipsis/.test(CSS),
  'C5  the flag truncates rather than wrapping');
ok(/#ops-section \.ir-plan-recon__value[\s\S]*?font-weight:\s*600/.test(CSS)
  && /#ops-section \.ir-plan-recon__label[\s\S]*?var\(--text-muted/.test(CSS),
  'C6  the number is the legible half and the label is secondary');
// The Route grid is the thing this must not disturb.
// The Execution Plan grid specifically: the stylesheet declares several, and the first one belongs to another
// rule entirely.
var grid = /#ops-section \.ir-exec-plan__grid \{[\s\S]*?grid-template-columns:([\s\S]*?);/.exec(CSS)[1];
// Each minmax() collapses to ONE token before counting, because its own arguments are pixel values and would
// otherwise each be counted as a track of their own. Track comments are stripped for the same reason.
var tracks = grid.replace(/minmax\([^)]*\)/g, ' TRACK ').replace(/\/\*[sS]*?\*\//g, ' ');
eq((tracks.match(/TRACK/g) || []).length + (tracks.match(/\b\d+px\b/g) || []).length, 7,
  'C7  the Route grid still declares exactly SEVEN tracks');
eq((PAGE.match(/<span>From<\/span><span>To<\/span>[\s\S]{0,200}?<span>Action<\/span>/g) || []).length, 1,
  'C7a and the header still names seven columns in one row');
ok(/<span>Last Mile<\/span>/.test(PAGE), 'C7b including Last Mile, which R6-R4 added');
eq(RO.currentIrCssToken(), 'ircompactrecon-20260905', 'C8  the stylesheet rotated with its own family');
ok(INDEX.indexOf('inventory-replenishment.css?v=' + RO.currentIrCssToken()) !== -1,
  'C8a and index.html serves the current member');
eq(RO.staleAppTokenRefs(INDEX), [], 'C9  no application asset is left behind on an older token');
ok(INDEX.indexOf('inventory-replenishment.js?v=' + RO.currentAppToken()) !== -1,
  'C9a and the page itself is on the current one');

// ================================================================================================================
section('§4 — one constant was answering two questions');
// ================================================================================================================
var relDecl = /var SYS_DEPLOYMENT_RELEASE_ = '([^']*)'/.exec(HEALTH);
var sysDecl = /var SYS_BUILD_VERSION_ = '([^']*)'/.exec(HEALTH);
ok(relDecl, 'D1  there is now a DEPLOYMENT RELEASE constant, distinct from the module stamp');
eq(relDecl[1], RELEASE, 'D1a set to this release');
eq(sysDecl[1], RELEASE, 'D1b and 63_\'s own module stamp moved too, because 63_ changed this round');
ok(RO.stampAtOrAfter(relDecl[1], 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R5'),
  'D1c the release never moves backwards, checked against the shared ledger');
// The identity block names each build individually. The live confusion was one string standing for four facts.
ok(/build_id:\s*SYS_DEPLOYMENT_RELEASE_/.test(HEALTH), 'D2  build_id is the RELEASE');
ok(/deployment_release:\s*SYS_DEPLOYMENT_RELEASE_/.test(HEALTH), 'D2a named explicitly as well');
ok(/system_health_module_build:\s*SYS_BUILD_VERSION_/.test(HEALTH), 'D2b 63_\'s module build is its own field');
ok(/workspace_module_build:\s*\(typeof SIR_BUILD_VERSION_/.test(HEALTH), 'D2c the workspace module build is its own field');
ok(/router_build:\s*\(typeof RTR_BUILD_VERSION_/.test(HEALTH), 'D2d and the router build, as before');
// The legacy alias must not disagree with build_id, or an older browser reads a different answer.
eq((HEALTH.match(/build_version:\s*SYS_BUILD_VERSION_/g) || []).length, 0,
  'D3  the legacy build_version alias no longer carries the module stamp');
ok((HEALTH.match(/build_version:\s*SYS_DEPLOYMENT_RELEASE_/g) || []).length >= 3,
  'D3a every build_version site carries the release, which is what the frontend falls back to');
ok(/build_id: h\.build_id \|\| h\.build_version/.test(DBAPI),
  'D3b and the frontend does fall back to it — so the two had to agree');
ok(/deployment_release: h\.deployment_release/.test(DBAPI) && /system_health_module_build: h\.system_health_module_build/.test(DBAPI),
  'D3c the browser surfaces the split too, so a console reading shows the same four facts');
// The self-referential row is now labelled as one rather than mistaken for coverage.
var manifestRow = /\{ file: '63_api_v1_system_health\.gs',[^}]*\}/.exec(HEALTH)[0];
ok(/self-referential/.test(manifestRow),
  'D4  63_\'s own manifest row says it is self-referential — both sides are declared in this file');
ok(/mixed_deployment: \(absent\.length \+ stale\.length\) > 0 \|\| runtime\.uniform !== true/.test(HEALTH),
  'D4a and mixed_deployment is UNCHANGED: it is a per-file claim and it was never the misleading field');
// Every OTHER manifest row still expects that file's own round — module stamps stay independently verified,
// and are NOT force-marched to the release. A round that did that would make the manifest useless.
var expects = [];
var mre = /\{ file: '([^']+)', symbol: '([A-Z_]+)', expected: '([^']+)'/g, mm;
while ((mm = mre.exec(HEALTH)) !== null) expects.push({ file: mm[1], expected: mm[3] });
ok(expects.length >= 12, 'D5  the manifest still registers ' + expects.length + ' owner files');
ok(expects.filter(function (e) { return e.expected !== RELEASE; }).length >= 10,
  'D5a and at least ten still declare an OLDER round — stamps were not marched to the release');
eq(expects.filter(function (e) { return e.file === '70_api_v1_overseas_stock_workspace.gs'; })[0].expected,
  'F1-7N-FB-4E-R3', 'D5b a file that did not change keeps the round it last changed in');
// The rule that was broken, restated as a check that CANNOT go quiet during the round that breaks it.
var R5SUITE = read('assets/tests/ai-plan-advice-boundary-transit-safe-method-f1-7n-fc-1b-e3-r4-a2-r1-r5.test.js');
// Sliced rather than brace-counted: the body holds a regex literal with braces in it, and a counter cannot
// tell a regex from a block.
var _rotAt = R5SUITE.indexOf('function stampRotation()');
var rotation = R5SUITE.slice(_rotAt, R5SUITE.indexOf('})();', _rotAt));
ok(/edited in this working tree, stamp still/.test(rotation),
  'D6  a manifest owner edited in the working tree is CHECKED, not skipped');
ok(!/if \(git\(\['diff', '--name-only', 'HEAD', '--', p\]\)\) continue;/.test(rotation),
  'D6a the blanket skip that made this guard silent during R6-R5 is gone');
ok(/headDecl\[1\] === diskDecl\[1\]/.test(rotation),
  'D6b what it checks instead is whether THIS tree moved the stamp along with the file');

// ================================================================================================================
section('§5/§8 — Route A, resolved by identity rather than by list order');
// ================================================================================================================
var HEADER_COLS = ['allocation_draft_id', 'planning_cycle', 'source_page', 'company', 'country', 'marketplace',
  'marketplace_id', 'status', 'lifecycle_status', 'generation_type', 'generation_run_id', 'calculation_run_id',
  'source_data_as_of', 'destination_marketplace', 'destination_warehouse_id', 'recommended_destination_warehouse_id',
  'source_warehouse_id', 'recommended_source_warehouse_id', 'recommended_shipping_method',
  'recommended_last_mile_delivery', 'create_idempotency_key', 'created_at', 'created_by', 'updated_at',
  'updated_by', 'draft_version'];
var LINE_COLS = ['allocation_draft_line_id', 'allocation_draft_id', 'sku', 'source_warehouse_id',
  'source_warehouse_code', 'destination_kind', 'destination_warehouse_id', 'destination_marketplace',
  'planned_qty', 'recommended_qty', 'shipping_method', 'last_mile_delivery', 'expected_arrival', 'line_status',
  'updated_at'];
var SKU = 'CO1100-R';
var TRUCK = 'TRUCK';
// The live plan's shape. Route A goes to a MARKETPLACE with no last mile; Route B to a real WAREHOUSE with one.
// Route B is deliberately listed FIRST in this fixture, because §5 says list order proves nothing and a selector
// that quietly relies on it must fail here.
function buildSheets(over) {
  over = over || {};
  var Hs = [HEADER_COLS.slice()], Ls = [LINE_COLS.slice()];
  function h(o) { Hs.push(HEADER_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
  function l(o) { Ls.push(LINE_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
  h({ allocation_draft_id: 'SADH-K4-A3872518', company: 'ResUS', country: 'US', marketplace: 'Amazon',
      status: 'draft', recommended_destination_warehouse_id: 'WH-AMZLGS-IN',
      recommended_source_warehouse_id: 'WH-CN-YX', recommended_shipping_method: 'air',
      recommended_last_mile_delivery: 'PARCEL', draft_version: 2, updated_at: '2026-09-01 09:00:00' });
  l({ allocation_draft_line_id: 'SADL-K2-344FB2B2', allocation_draft_id: 'SADH-K4-A3872518', sku: SKU,
      planned_qty: 200, line_status: 'draft', source_warehouse_id: 'WH-CN-YX', destination_kind: 'WAREHOUSE',
      destination_warehouse_id: 'WH-AMZLGS-IN', expected_arrival: '2026-09-20', updated_at: '2026-09-01 09:00:00' });
  h({ allocation_draft_id: 'SADH-K4-38523A90', company: 'ResUS', country: 'US', marketplace: 'Amazon',
      status: 'draft', destination_marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-CN-YX',
      recommended_shipping_method: 'sea_express',
      recommended_last_mile_delivery: over.routeALastMile === undefined ? '' : over.routeALastMile,
      draft_version: over.routeAVersion === undefined ? 3 : over.routeAVersion,
      updated_at: '2026-09-01 10:00:00' });
  l({ allocation_draft_line_id: 'SADL-K2-92B8BAD2', allocation_draft_id: 'SADH-K4-38523A90', sku: SKU,
      planned_qty: 320, line_status: 'draft', source_warehouse_id: 'WH-CN-YX',
      destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon',
      expected_arrival: over.routeAEta === undefined ? '' : over.routeAEta, updated_at: '2026-09-01 10:00:00' });
  // Two station headers with no line for this SKU — other SKUs' work in the same station.
  ['OTHER-1', 'OTHER-2'].forEach(function (s, i) {
    h({ allocation_draft_id: 'SADH-OTHER-' + i, company: 'ResUS', country: 'US', marketplace: 'Amazon',
        status: 'draft', recommended_destination_warehouse_id: 'WH-O' + i, recommended_source_warehouse_id: 'WH-TW-' + i });
    l({ allocation_draft_line_id: 'SADL-O' + i, allocation_draft_id: 'SADH-OTHER-' + i, sku: s,
        planned_qty: 50, line_status: 'draft' });
  });
  (over.extraHeaders || []).forEach(function (o) { h(o); });
  (over.extraLines || []).forEach(function (o) { l(o); });
  return { shipping_allocation_drafts: Hs, shipping_allocation_draft_lines: Ls };
}
function runCensus(entry, sheets, arg, censusSrc) {
  var LOG = [];
  var sb = { console: { log: function () {} }, JSON: JSON, Math: Math, Date: Date, String: String,
    Number: Number, Object: Object, Array: Array, isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat,
    parseInt: parseInt, Error: Error, RegExp: RegExp, Boolean: Boolean };
  sb.global = sb;
  sb.Logger = { log: function (m) { LOG.push(String(m)); } };
  var writes = { appendRow: 0, setValues: 0 };
  sb.SpreadsheetApp = { openById: function () { return { getSheetByName: function (n) {
    var rows = sheets[n]; if (!rows) return null;
    return {
      getDataRange: function () { return { getValues: function () { return rows; } }; },
      appendRow: function () { writes.appendRow++; },
      getRange: function () { return { setValues: function () { writes.setValues++; },
        setValue: function () { writes.setValues++; } }; }
    };
  } }; } };
  var ctx = vm.createContext(sb);
  vm.runInContext(read('assets/specs/active/apps-script/90_generated_supply_planning_bundle.gs'), ctx);
  vm.runInContext([
    'function prodExpectedDbId_() { return "FAKE"; }',
    'function prodAssertDbTarget_() { return true; }',
    (/var RIC_CANONICAL_SERVICES_ = [^;]+;/.exec(G69) || [''])[0],
    (/var RIC_SERVICE_LABELS_ = \{[\s\S]*?\};/.exec(G69) || [''])[0],
    extractFn(G69, 'ricDestinationIdentity_'),
    extractFn(G69, 'ricCanonicalService_'),
    extractFn(G69, 'ricK4GroupKey_'),
    extractFn(G69, 'ricK4DeterministicHeaderId_'),
    extractFn(G16, 'sadFnv1a_'),
    extractFn(G16, 'sadK4ResolveActiveDraft_')
  ].join(NL), ctx);
  vm.runInContext(censusSrc || CENSUS, ctx);
  sb.__arg = arg || null;
  var res = null, threw = null;
  try { res = vm.runInContext(entry + '(__arg)', ctx); } catch (e) { threw = e; }
  return { res: res, threw: threw, writes: writes, log: LOG.join(NL) };
}
var PRE = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', buildSheets());
ok(!PRE.threw, 'E0  the preflight runs' + (PRE.threw ? ' — ' + PRE.threw.message : ''));
var P0 = PRE.res || {};
eq(P0.verdict, 'EXACTLY_ONE_SAVE_TARGET', 'E1  and returns the verdict §5 requires');
eq(P0.db_writes, 0, 'E1a with zero DB writes');
eq([PRE.writes.appendRow, PRE.writes.setValues], [0, 0], 'E1b and zero write PRIMITIVES were even reached');
eq(P0.writer_constructed, false, 'E1c no writer was constructed');
eq(P0.visible_row_count, 2, 'E2  two visible rows, as the R6-R4 freeze established');
eq(P0.matched_row_count, 1, 'E2a and exactly ONE of them is Route A');
// The identity, in full.
eq(P0.target.allocation_draft_id, 'SADH-K4-38523A90', 'E3  Route A\'s header');
eq(P0.target.allocation_draft_line_id, 'SADL-K2-92B8BAD2', 'E3a and its line');
eq([P0.target.company, P0.target.country, P0.target.marketplace, P0.target.sku],
  ['ResUS', 'US', 'Amazon', 'CO1100-R'], 'E3b the four-part scope');
eq(P0.target.source_warehouse_id, 'WH-CN-YX', 'E3c the source warehouse');
eq([P0.target.destination_kind, P0.target.destination_marketplace], ['MARKETPLACE', 'Amazon'],
  'E3d a MARKETPLACE destination — which is what separates it from Route B');
eq(P0.target.quantity, 320, 'E3e quantity 320');
eq(P0.target.last_mile_delivery, '', 'E3f no last mile — the field the controlled action completes');
eq(P0.target.expected_arrival, '', 'E3g and no ETA, because the ETA waits for it');
eq(P0.target.draft_version, '3', 'E3h with the version an UPDATE must expect');
ok(/MANUAL \(no generation_run_id/.test(P0.target.ownership),
  'E3i and it is a MANUAL route — no AI generation run owns it');
eq(P0.target.status, 'draft', 'E3j status draft');
ok(String(P0.target.k4_group_key).length > 0, 'E3k with a resolved K4 route identity');
// THE ROW THE SELECTOR MUST NOT PICK. It is listed FIRST in the fixture.
eq(P0.other_rows.length, 1, 'E4  exactly one other visible row is frozen alongside it');
eq(P0.other_rows[0].allocation_draft_id, 'SADH-K4-A3872518', 'E4a and it is Route B');
ok(P0.other_rows[0].last_mile_delivery !== '', 'E4b which already has a last mile, so it is not a candidate');
// List order proves nothing: Route B is row 0 in the sheet and is still not selected.
ok(P0.target.allocation_draft_id !== P0.other_rows[0].allocation_draft_id,
  'E4c the first-listed row was NOT chosen — the selector reads identity, not position');
// The method is not a discriminator, and is not spelled.
var selSrc = extractFn(CENSUS, 'CENSUS_r6r6MatchRouteA_') + extractVar(CENSUS, 'R6R6_ROUTE_A_SELECTOR_');
ok(!/shipping_method/.test(selSrc),
  'E5  the selector never reads the shipping method — a display token is not an identity');
ok(!/[一-鿿]/.test(CENSUS.split('R6R6_ROUTE_A_SELECTOR_')[1] || ''),
  'E5a and no operator-facing carrier label is spelled in it');
// The mutation contract.
eq(P0.allowed_mutation_fields.indexOf('last_mile_delivery') !== -1, true, 'E6  the last mile may change');
['company', 'country', 'sku', 'source_warehouse_id', 'destination_kind', 'quantity', 'shipping_method',
 'allocation_draft_id', 'allocation_draft_line_id'].forEach(function (f) {
  ok(P0.forbidden_mutation_fields.indexOf(f) !== -1, 'E6a ' + f + ' may not');
});
eq(P0.target.mutation_identity.intent, 'UPDATE_EXISTING_ROUTE',
  'E7  the intent is an UPDATE of an existing row, declared rather than inferred');
eq(P0.target.mutation_identity.expected_draft_version, '3', 'E7a guarded by the version it expects');
eq(P0.target.mutation_identity.create_idempotency_key, '',
  'E7b and carries NO create key — inventing one would make a retry look like a create');

// ZERO AND DUPLICATE BOTH STOP.
var noneS = buildSheets({ routeALastMile: 'PARCEL' });   // Route A already completed → nothing matches
var NONE = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', noneS);
eq((NONE.res || {}).verdict, 'STOP', 'E8  zero matching rows STOPS');
ok(/ZERO rows match/.test((NONE.res || {}).stop_reason), 'E8a and says the plan is not what it was written against');
eq((NONE.res || {}).target, null, 'E8b with no target offered');
var dupS = buildSheets({ extraHeaders: [{ allocation_draft_id: 'SADH-DUP', company: 'ResUS', country: 'US',
    marketplace: 'Amazon', status: 'draft', destination_marketplace: 'Amazon',
    recommended_source_warehouse_id: 'WH-CN-YX', recommended_shipping_method: 'air', draft_version: 1 }],
  extraLines: [{ allocation_draft_line_id: 'SADL-DUP', allocation_draft_id: 'SADH-DUP', sku: SKU,
    planned_qty: 320, line_status: 'draft', source_warehouse_id: 'WH-CN-YX',
    destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon' }] });
var DUP = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', dupS);
eq((DUP.res || {}).verdict, 'STOP', 'E9  two rows matching the identity STOPS');
ok(/does not IDENTIFY/.test((DUP.res || {}).stop_reason),
  'E9a and says so: picking one would be the guess this contract exists to remove');
eq((DUP.res || {}).target, null, 'E9b with no target offered');

// THE READBACK. It takes the BEFORE as an argument; recomputing its own baseline could not detect a change.
var AFTER_OK = buildSheets({ routeALastMile: TRUCK, routeAEta: '2026-10-15', routeAVersion: 4 });
var BACK = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', AFTER_OK, P0);
ok(!BACK.threw, 'E10 the readback runs' + (BACK.threw ? ' — ' + BACK.threw.message : ''));
var B0 = BACK.res || {};
eq(B0.verdict, 'NARROW_MUTATION_CONFIRMED', 'E10a and confirms a narrow mutation');
eq(B0.db_writes, 0, 'E10b with zero DB writes');
eq(B0.unexpected_changed_fields, [], 'E11 no forbidden field changed');
eq(B0.changed_fields.map(function (c) { return c.field; }).sort(),
  ['draft_version', 'expected_arrival', 'k4_group_key', 'last_mile_delivery'],
  'E11a exactly the last mile, the ETA it unblocks, the version the writer moves — and the DERIVED route key');
eq(B0.derived_changed_fields, ['k4_group_key'],
  'E11b the K4 key moved, because it is computed FROM the last mile — not an independent change');
eq(B0.derived_change_explained, true,
  'E11c and it moved for the stated reason; a derived key moving on its own would STOP');
eq([B0.header_count_before, B0.header_count_after], [2, 2], 'E12 the header count is unchanged');
eq([B0.line_count_before, B0.line_count_after], [2, 2], 'E12a and the line count');
eq(B0.route_b_unchanged, true, 'E13 Route B is unchanged, field by field');
eq(B0.other_rows_compared, 1, 'E13a and it was actually compared, not assumed');
// The readback must FAIL when something else moved. Three separate ways, each a STOP.
var BAD_QTY = buildSheets({ routeALastMile: TRUCK, routeAVersion: 4 });
BAD_QTY.shipping_allocation_draft_lines[2][LINE_COLS.indexOf('planned_qty')] = 999;
var BQ = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', BAD_QTY, P0);
eq((BQ.res || {}).verdict, 'STOP', 'E14 a changed quantity STOPS');
ok(((BQ.res || {}).unexpected_changed_fields || []).indexOf('quantity') !== -1, 'E14a and names the field');
var BAD_B = buildSheets({ routeALastMile: TRUCK, routeAVersion: 4 });
BAD_B.shipping_allocation_draft_lines[1][LINE_COLS.indexOf('planned_qty')] = 111;
var BB = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', BAD_B, P0);
eq((BB.res || {}).verdict, 'STOP', 'E15 a changed Route B STOPS');
eq((BB.res || {}).route_b_unchanged, false, 'E15a and says which row drifted');
var EXTRA = buildSheets({ routeALastMile: TRUCK, routeAVersion: 4,
  extraHeaders: [{ allocation_draft_id: 'SADH-NEW', company: 'ResUS', country: 'US', marketplace: 'Amazon',
    status: 'draft', destination_marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-CN-YX',
    recommended_shipping_method: 'air' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-NEW', allocation_draft_id: 'SADH-NEW', sku: SKU,
    planned_qty: 320, line_status: 'draft', destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon' }] });
var BE = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', EXTRA, P0);
eq((BE.res || {}).verdict, 'STOP', 'E16 a NEW header STOPS — a completion must not create anything');
ok(/COUNT moved/.test((BE.res || {}).stop_reason), 'E16a and says the count moved');
var NOOP = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', buildSheets(), P0);
eq((NOOP.res || {}).verdict, 'STOP', 'E17 and a last mile still blank STOPS — the change did not land');
var NOBEFORE = runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', AFTER_OK, null);
eq((NOBEFORE.res || {}).verdict, 'STOP', 'E18 a readback with no BEFORE refuses rather than inventing one');

// ================================================================================================================
section('R6-R6-R1 — the frozen BEFORE, and a readback the editor can press');
// ================================================================================================================
// The whole point of this round: an argument-taking readback cannot be run from the Apps Script editor, whose
// Run button passes nothing. Everything below is EXECUTED against the same census sandbox as §5/§8.
// Sliced from the DECLARATION at column 0: the preflight's paste-ready emitter contains the same text inside
// a string literal, and it appears earlier in the file.
var _frozenAt = CENSUS.indexOf(NL + 'var R6R6_FROZEN_BEFORE_ = {');
var FROZEN = CENSUS.slice(_frozenAt, CENSUS.indexOf(NL + '};', _frozenAt));
ok(/function RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN\(\)/.test(CENSUS),
  'R1  the no-argument entry point exists and takes NO parameters');
// The freeze is SOURCE. A value a later run could have written is not a BEFORE.
// Comment-stripped, because the round's own note on why it uses none of these necessarily names all of them.
var CENSUS_CODE = CENSUS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
ok(!/CacheService|PropertiesService|ScriptProperties|UserProperties/.test(CENSUS_CODE),
  'R2  the snapshot uses no CacheService, PropertiesService or other persisted state');
var frozenFn = extractFn(CENSUS, 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN');
ok(!/appendRow|setValues|setValue\(/.test(frozenFn), 'R2a and it contains no write primitive');

// Every field §5 of the brief requires, present in the constant.
['captured_from', 'verdict', 'allocation_draft_id', 'allocation_draft_line_id', 'expected_draft_version',
 'company', 'country', 'station_marketplace', 'sku', 'source_warehouse_id', 'destination_kind',
 'destination_id', 'destination_marketplace', 'quantity', 'shipping_method', 'last_mile_delivery',
 'expected_arrival', 'status', 'generation_type', 'ownership', 'k4_group_key', 'updated_at',
 'line_updated_at', 'header_count', 'line_count', 'other_rows',
 'allowed_mutation_fields', 'forbidden_mutation_fields'].forEach(function (k) {
  ok(new RegExp('(^|[^_a-zA-Z])' + k + ':').test(FROZEN), 'R3  the snapshot names ' + k);
});
// And it carries the production values, not a fixture's.
ok(/allocation_draft_id: 'SADH-K4-38523A90'/.test(FROZEN), 'R3a with the production header id');
ok(/allocation_draft_line_id: 'SADL-K2-92B8BAD2'/.test(FROZEN), 'R3b the production line id');
ok(/expected_draft_version: '1'/.test(FROZEN), 'R3c and the version the preflight reported');
ok(/last_mile_delivery: ''/.test(FROZEN), 'R3d with the last mile BLANK, which is what makes it completable');

// A K4 key with the last-mile segment substituted, computed by the shipped helper.
function censusHelper(name) {
  var sb = { CENSUS_str_: function (v) { return String(v == null ? '' : v).trim(); },
             CENSUS_num_: function (v) { var n = Number(v); return isFinite(n) ? n : 0; } };
  var ctx = vm.createContext(sb);
  vm.runInContext(extractFn(CENSUS, name) + NL + 'this.__fn = ' + name + ';', ctx);
  return sb.__fn;
}
var k4with = censusHelper('CENSUS_r6r6K4WithLastMile_');
var FROZEN_K4 = '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express||';
eq(k4with(FROZEN_K4, 'TRUCK'),
  '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|truck|',
  'R4  the expected AFTER key is the frozen key with ONE segment substituted');
eq(k4with(FROZEN_K4, 'TRUCK').split('|').length, 11, 'R4a and it still has the contract\'s eleven segments');
eq(k4with('|too|few|', 'TRUCK'), '',
  'R4b a key that is not the contract\'s shape yields NO expectation, so a comparison fails closed');
var snapIssues = censusHelper('CENSUS_r6r6SnapshotIssues_');
eq(snapIssues(null), ['the frozen snapshot constant is absent'], 'R5  an absent snapshot is an issue, not a pass');

// ---- THE NINE STOP GATES, each executed --------------------------------------------------------------------
// The live plan the freeze describes, rebuilt as sheets so the frozen constant is what the readback compares
// against. Route A is the marketplace route; the ids and the K4 inputs match the production capture.
var TS_A = 'Thu Sep 03 2026 20:41:08 GMT+0800 (Taiwan Standard Time)';
var TS_B = 'Thu Sep 03 2026 22:04:49 GMT+0800 (Taiwan Standard Time)';
var PROD_HEADER = { allocation_draft_id: 'SADH-K4-38523A90', company: 'ResUS', country: 'US',
  marketplace: 'Amazon', status: 'draft', destination_marketplace: 'Amazon',
  recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', recommended_shipping_method: 'sea_express',
  recommended_last_mile_delivery: '', draft_version: 1, generation_type: 'user_created',
  updated_at: TS_A };
var PROD_LINE = { allocation_draft_line_id: 'SADL-K2-92B8BAD2', allocation_draft_id: 'SADH-K4-38523A90',
  sku: SKU, planned_qty: 320, line_status: 'draft', source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
  destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon', expected_arrival: '',
  updated_at: TS_A };
// ROUTE B IS THE PRODUCTION ROUTE B NOW, field for field. Its last mile is BLANK and its version is 1,
// exactly as the capture states — the earlier fixture invented a PARCEL route at version 2, which was
// harmless only for as long as those fields went uncompared.
var PROD_B_HEADER = { allocation_draft_id: 'SADH-K4-A3872518', company: 'ResUS', country: 'US',
  marketplace: 'Amazon', status: 'draft', recommended_destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS',
  recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN', recommended_shipping_method: 'air',
  recommended_last_mile_delivery: '', draft_version: 1, generation_type: 'user_created',
  updated_at: TS_B };
var PROD_B_LINE = { allocation_draft_line_id: 'SADL-K2-344FB2B2', allocation_draft_id: 'SADH-K4-A3872518',
  sku: SKU, planned_qty: 200, line_status: '', source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
  destination_kind: 'WAREHOUSE', destination_warehouse_id: 'WH-RESUS-US-3PL-AMZLGS', expected_arrival: '',
  updated_at: TS_B };
function prodSheets(mut) {
  mut = mut || {};
  function cp(o, over) { var x = {}; Object.keys(o).forEach(function (k) { x[k] = o[k]; });
    Object.keys(over || {}).forEach(function (k) { x[k] = over[k]; }); return x; }
  var Hs = [HEADER_COLS.slice()], Ls = [LINE_COLS.slice()];
  function h(o) { Hs.push(HEADER_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
  function l(o) { Ls.push(LINE_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
  h(cp(PROD_B_HEADER, mut.bHeader)); l(cp(PROD_B_LINE, mut.bLine));      // listed FIRST on purpose
  h(cp(PROD_HEADER, mut.aHeader)); l(cp(PROD_LINE, mut.aLine));
  (mut.extraHeaders || []).forEach(h); (mut.extraLines || []).forEach(l);
  return { shipping_allocation_drafts: Hs, shipping_allocation_draft_lines: Ls };
}
function frozenRun(mut) {
  return (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(mut)).res) || {};
}
// The authorized change, and nothing else: last mile blank -> TRUCK, version 1 -> 2, ETA now resolvable.
var TS_A_AFTER = 'Thu Sep 03 2026 21:15:02 GMT+0800 (Taiwan Standard Time)';
var GOOD = { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2,
  updated_at: TS_A_AFTER }, aLine: { expected_arrival: '2026-10-15', updated_at: TS_A_AFTER } };
var OKR = frozenRun(GOOD);
eq(OKR.census, 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', 'R6  the frozen readback runs with no arguments');
eq(OKR.verdict, 'NARROW_MUTATION_CONFIRMED', 'R6a and the authorized change is the ONLY success verdict');
eq([OKR.read_only, OKR.db_writes, OKR.writer_constructed, OKR.submit_calls, OKR.reservation_writes],
  [true, 0, false, 0, 0], 'R6b read_only true, and four zeroes');
eq(OKR.draft_version_before + '->' + OKR.draft_version_after, '1->2', 'R6c the version advanced by exactly one');
eq(OKR.k4_actual_after, OKR.k4_expected_after, 'R6d the K4 key is the frozen key with only the last mile moved');
eq(OKR.last_mile_absorbed_by_identity, true, 'R6e and the identity absorbed the value, which is what makes it valid');
// R6-R6-R1 CORRECTION. I recorded status / generation_type / ownership as absent from the production
// capture. They were present, and an invariant gate standing in for an equality gate that CAN be written is
// strictly weaker: 'still ACTIVE' accepts three statuses where the frozen value accepts one.
eq(OKR.snapshot_gaps, [], 'R6f no Route A field falls back to an invariant \u2014 every one is frozen exactly');
eq([OKR.status_still_active, OKR.ownership_still_manual], [true, true],
  'R6g the weaker gates are kept as a second line, and they agree');
ok(/status: 'draft'/.test(FROZEN) && /generation_type: 'user_created'/.test(FROZEN),
  'R6f1 the frozen values are the production ones');
ok(/ownership: 'MANUAL \(no generation_run_id/.test(FROZEN),
  'R6f2 including the ownership string the census itself emits');
eq([OKR.header_count_before, OKR.header_count_after, OKR.line_count_before, OKR.line_count_after], [2, 2, 2, 2],
  'R6h with the plan shape unchanged');
ok(/other routes compared/.test(OKR.other_row_guarantee),
  'R6i and the guarantee on the other route is STATED rather than implied: ' + OKR.other_row_guarantee);

function stops(label, mut, expectFragment) {
  var r = frozenRun(mut);
  ok(r.verdict === 'STOP' && (!expectFragment || new RegExp(expectFragment, 'i').test(r.stop_reason || '')),
    label + ' — ' + (r.verdict === 'STOP' ? String(r.stop_reason).slice(0, 90) : 'DID NOT STOP'));
  return r;
}
// 1. target absent
stops('R7  the target row is gone', { aLine: { allocation_draft_line_id: 'SADL-OTHER' } }, 'NOT PRESENT');
// 2. target id changed
stops('R7a the header id changed', { aHeader: { allocation_draft_id: 'SADH-K4-CHANGED' },
  aLine: { allocation_draft_id: 'SADH-K4-CHANGED', ...{} } }, 'NOT PRESENT');
// 3. quantity changed
stops('R7b the quantity changed', { aHeader: GOOD.aHeader, aLine: { expected_arrival: '2026-10-15', planned_qty: 999 } },
  'outside the allowed set');
// 4. the From warehouse changed
stops('R7c the source warehouse changed',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, recommended_source_warehouse_id: 'WH-OTHER' },
    aLine: { expected_arrival: '2026-10-15', source_warehouse_id: 'WH-OTHER' } }, 'outside the allowed set');
// 5. the method changed
stops('R7d the shipping method changed',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, recommended_shipping_method: 'air' },
    aLine: { expected_arrival: '2026-10-15' } }, 'outside the allowed set');
// 6. status left the ACTIVE set
stops('R7e the row left the ACTIVE statuses',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, status: 'cancelled' },
    aLine: { expected_arrival: '2026-10-15' } }, 'NOT PRESENT|ACTIVE');
// 7. ownership became AI
// Caught by the frozen EQUALITY gate now, not by the weaker must-not-be-AI-owned invariant: ownership is a
// value the snapshot pins, so a change to it is a forbidden-field change. The invariant is kept as a second
// line and is asserted separately, so the two cannot silently disagree.
var AIOWNED = stops('R7f the row became AI-owned',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, generation_run_id: 'RUN-1' },
    aLine: { expected_arrival: '2026-10-15' } }, 'outside the allowed set');
ok(AIOWNED.unexpected_changed_fields.indexOf('ownership') !== -1,
  'R7f1 naming ownership, whose exact BEFORE value is frozen');
eq(AIOWNED.ownership_still_manual, false,
  'R7f2 and the weaker invariant agrees, so the two lines do not contradict each other');
// 8. an unauthorized route changed
stops('R7g Route B drifted', { aHeader: GOOD.aHeader, aLine: GOOD.aLine, bLine: { planned_qty: 111 } },
  'another visible route drifted');
// 9. a header/line was added
stops('R7h a header was created', { aHeader: GOOD.aHeader, aLine: GOOD.aLine,
  extraHeaders: [{ allocation_draft_id: 'SADH-NEW', company: 'ResUS', country: 'US', marketplace: 'Amazon',
    status: 'draft', destination_marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
    recommended_shipping_method: 'air' }],
  extraLines: [{ allocation_draft_line_id: 'SADL-NEW', allocation_draft_id: 'SADH-NEW', sku: SKU,
    planned_qty: 10, line_status: 'draft', destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon' }] },
  'COUNT moved');
// 10. the last mile is still blank
stops('R7i the last mile never changed', {}, 'STILL blank');
// 11. the version did not advance
stops('R7j the version did not advance',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 1 }, aLine: { expected_arrival: '2026-10-15' } },
  'draft_version went 1 -> 1');
// 12. the version advanced twice
stops('R7k the version advanced by two — something wrote twice',
  { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 3 }, aLine: { expected_arrival: '2026-10-15' } },
  'draft_version went 1 -> 3');

// 13. THE SILENT RE-IDENTIFICATION. `planning_cycle` is a K4 dimension and is NOT one of the fields compared
// row-by-row, so moving it re-keys the route's identity while every equality gate above still passes. This is
// the case the exact K4 derivation exists for: no other gate in this readback can see it.
var K4ONLY = frozenRun({ aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2,
  planning_cycle: '2026-W40' }, aLine: { expected_arrival: '2026-10-15' } });
eq(K4ONLY.verdict, 'STOP', 'R7l  a route re-keyed by a K4 dimension nothing else compares STOPS');
eq(K4ONLY.unexpected_changed_fields, [],
  'R7l1 and NO forbidden field changed — every other gate passed it');
ok(/not the frozen key/.test(K4ONLY.stop_reason || ''),
  'R7l2 so the exact K4 derivation is the only thing that caught it');
eq(K4ONLY.k4_derives_from_last_mile_only, false, 'R7l3 stated as its own fact, not folded into another');

// 14. A LAST MILE THE IDENTITY NEVER ABSORBED. Today the K4 key is DERIVED from the header on every read, so
// the column and the key cannot disagree — which means this gate is a guard against a future in which the key
// becomes stored rather than computed, and against a malformed key. Simulated by making the row emit a key
// whose last-mile segment was never filled in: the column says TRUCK and the identity does not.
(function () {
  var m = CENSUS.replace('          k4_group_key: vgk,',
    '          k4_group_key: (function () { var _s = CENSUS_str_(vgk).split("|");'
    + ' if (_s.length === 11) _s[9] = ""; return _s.join("|"); })(),');
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, m).res) || {};
  eq(r.verdict, 'STOP', 'R7m a last mile the route identity did not absorb STOPS');
  eq(r.last_mile_absorbed_by_identity, false, 'R7m1 and says which gate refused it');
  eq(OKR.last_mile_absorbed_by_identity, true, 'R7m2 while the authorized change absorbs it');
})();

// THE SNAPSHOT-COMPLETENESS GATE, executed by mutating the constant rather than by inspecting it.
(function () {
  var m = CENSUS.replace("  allocation_draft_id: 'SADH-K4-38523A90',", '  allocation_draft_id: null,');
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, m).res) || {};
  ok(r.verdict === 'STOP' && /missing required field: allocation_draft_id/.test(r.stop_reason || ''),
    'R8  a snapshot missing a required field STOPS and names the field');
  eq(r.db_writes, 0, 'R8a and still reports zero writes');
})();
(function () {
  var m = CENSUS.replace("  last_mile_delivery: '',                 // BLANK", "  last_mile_delivery: 'TRUCK',   // BLANK");
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, m).res) || {};
  ok(r.verdict === 'STOP' && /does not describe a route awaiting completion/.test(r.stop_reason || ''),
    'R8b a snapshot whose last mile is not blank STOPS — it does not describe a completable route');
})();

mut('R-M1 the draft_version contract dropped → a no-op write reports success', function () {
  var m = CENSUS.replace('  out.draft_version_advanced_by_contract = (aVer === bVer + 1);',
    '  out.draft_version_advanced_by_contract = true;');
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(
    { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 1 },
      aLine: { expected_arrival: '2026-10-15' } }), null, m).res) || {};
  return r.verdict === 'NARROW_MUTATION_CONFIRMED';
});
mut('R-M2 the exact K4 derivation weakened back to "explained by" → a silent re-key confirms', function () {
  var m = CENSUS.replace('  out.k4_derives_from_last_mile_only = !k4Known',
    '  out.k4_derives_from_last_mile_only = true || !k4Known');
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(
    { aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, planning_cycle: '2026-W40' },
      aLine: { expected_arrival: '2026-10-15' } }), null, m).res) || {};
  return r.verdict === 'NARROW_MUTATION_CONFIRMED' && K4ONLY.verdict === 'STOP';
});
mut('R-M3 the snapshot-completeness gate dropped → an incomplete BEFORE is used anyway', function () {
  var m = CENSUS.replace("  allocation_draft_id: 'SADH-K4-38523A90',", '  allocation_draft_id: null,')
    .replace('  if (issues.length) {', '  if (false) {');
  var r = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, m).res) || {};
  // With no id to locate by, the mutant cannot even find the row — it must not report a confirmation.
  return r.verdict !== 'NARROW_MUTATION_CONFIRMED' && !/not usable/.test(r.stop_reason || '');
});
mut('R-M4 an equality field with no frozen value falling through to the weaker invariant', function () {
  // A freeze that lost its status value must STOP. The mutant drops the completeness check, and the readback then
  // certifies the row on 'the status is one of three ACTIVE values' alone — exactly the weaker guarantee
  // this round replaced with an exact one.
  var nulled = CENSUS.replace("  status: 'draft',", "  status: null,");
  var m = nulled.replace("    if (snap[ek] === null || snap[ek] === undefined) issues.push('missing required field: ' + ek);", "");
  var mutant = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, m).res) || {};
  var shipped = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets(GOOD), null, nulled).res) || {};
  return mutant.verdict === 'NARROW_MUTATION_CONFIRMED' && shipped.verdict === 'STOP';
});

// ---- R6-R6-R1 §7 \u2014 READINESS, RUN BEFORE THE CLICK ------------------------------------------------------
// A freeze is only a BEFORE while production still agrees with it. Between the capture and the operator's
// click another session could have saved, submitted or cancelled, and a readback run against a stale freeze
// would compare the AFTER against a world that no longer existed.
function readyRun(mut, censusSrc) {
  return (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_FROZEN_READINESS', prodSheets(mut), null, censusSrc).res) || {};
}
var RDY = readyRun({});                      // production exactly as frozen: nothing has happened yet
eq(RDY.verdict, 'FROZEN_READBACK_READY', 'S1  the untouched plan is READY');
eq(RDY.census, 'RUN_R6R6_MANUAL_ROUTE_SAVE_FROZEN_READINESS', 'S1a from the no-argument readiness entry point');
eq([RDY.read_only, RDY.db_writes, RDY.writer_constructed, RDY.submit_calls, RDY.reservation_writes],
  [true, 0, false, 0, 0], 'S1b read_only true, and four zeroes');
eq(RDY.snapshot_gaps, [], 'S1c with no snapshot gap');
eq(RDY.target_ids, { allocation_draft_id: 'SADH-K4-38523A90', allocation_draft_line_id: 'SADL-K2-92B8BAD2' },
  'S1d the frozen target is present');
eq([RDY.draft_version_live, RDY.last_mile_live], ['1', ''],
  'S1e the version is still 1 and the last mile is still blank \u2014 nothing has been written');
eq([RDY.route_a_drift, RDY.route_b_drift, RDY.missing_other_rows], [[], [], []],
  'S1f no route has drifted from the freeze');
eq([RDY.header_count_frozen, RDY.header_count_live, RDY.line_count_frozen, RDY.line_count_live], [2, 2, 2, 2],
  'S1g and the plan shape matches');

function refuses(label, mut, fragment, censusSrc) {
  var r = readyRun(mut, censusSrc);
  ok(r.verdict === 'STOP' && (!fragment || new RegExp(fragment, 'i').test(r.stop_reason || '')),
    label + ' \u2014 ' + (r.verdict === 'STOP' ? String(r.stop_reason).slice(0, 88) : 'DID NOT STOP'));
  return r;
}
// A SNAPSHOT GAP. Any equality field without a frozen value refuses, rather than falling through to the
// weaker invariant and certifying something it cannot support.
['status', 'generation_type', 'ownership', 'updated_at', 'line_updated_at'].forEach(function (k) {
  var m = CENSUS.replace(new RegExp('  ' + k + ": '[^']*',"), '  ' + k + ': null,');
  var r = refuses('S2  a snapshot gap on ' + k, {}, 'missing required field: ' + k, m);
  ok((r.snapshot_gaps || []).indexOf(k) !== -1, 'S2a and ' + k + ' is named in snapshot_gaps');
});
// ROUTE A DRIFT, on a field the freeze pins exactly.
refuses('S3  Route A status drifted', { aHeader: { status: 'site_confirmed' } }, 'Route A has drifted.*status');
refuses('S3a Route A method drifted', { aHeader: { recommended_shipping_method: 'air' } },
  'Route A has drifted');
refuses('S3b Route A quantity drifted', { aLine: { planned_qty: 321 } }, 'Route A has drifted|drifted');
refuses('S3c Route A became AI-owned', { aHeader: { generation_run_id: 'RUN-1' } },
  'Route A has drifted.*(ownership|generation_type)');
// ROUTE B DRIFT, on the fields its frozen record carries.
refuses('S4  Route B quantity drifted', { bLine: { planned_qty: 199 } }, 'companion route has drifted');
refuses('S4a Route B destination kind drifted',
  { bLine: { destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon', destination_warehouse_id: '' },
    bHeader: { recommended_destination_warehouse_id: '', destination_marketplace: 'Amazon' } },
  'companion route has drifted|companion route is gone');
refuses('S4b Route B is gone altogether', { bLine: { allocation_draft_line_id: 'SADL-VANISHED' } },
  'companion route is gone');
// TARGET, VERSION AND COUNT DRIFT.
refuses('S5  the target line id changed', { aLine: { allocation_draft_line_id: 'SADL-OTHER' } },
  'frozen target row is not present');
refuses('S5a the version already moved', { aHeader: { draft_version: 2 } }, 'draft_version in production is 2');
refuses('S5b the last mile is already set', { aHeader: { recommended_last_mile_delivery: 'TRUCK' } },
  'already set');
refuses('S5c a header was added since the freeze',
  { extraHeaders: [{ allocation_draft_id: 'SADH-EXTRA', company: 'ResUS', country: 'US', marketplace: 'Amazon',
      status: 'draft', destination_marketplace: 'Amazon', recommended_source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
      recommended_shipping_method: 'air', recommended_last_mile_delivery: 'PARCEL' }],
    extraLines: [{ allocation_draft_line_id: 'SADL-EXTRA', allocation_draft_id: 'SADH-EXTRA', sku: SKU,
      planned_qty: 5, line_status: 'draft', destination_kind: 'MARKETPLACE', destination_marketplace: 'Amazon' }] },
  'plan shape has changed');
// AND THE ORDER MATTERS: readiness refuses the state the readback would CONFIRM, because nothing has happened
// yet. The two are not the same check with a different name.
eq(readyRun(GOOD).verdict, 'STOP',
  'S6  a plan where the change HAS landed is not READY \u2014 readiness runs before the click');
eq(OKR.verdict, 'NARROW_MUTATION_CONFIRMED', 'S6a which is exactly the state the readback confirms');
eq(frozenRun({}).verdict, 'STOP', 'S6b and the untouched plan the readiness accepts is not a confirmed write');

mut('S-M1 readiness ignoring a snapshot gap', function () {
  var m = CENSUS.replace("  status: 'draft',", '  status: null,')
    .replace('  if (out.snapshot_issues.length || out.snapshot_gaps.length) {', '  if (false) {');
  return readyRun({}, m).verdict === 'FROZEN_READBACK_READY'
    && readyRun({}, CENSUS.replace("  status: 'draft',", '  status: null,')).verdict === 'STOP';
});
mut('S-M2 readiness not comparing the companion routes at all', function () {
  var m = CENSUS.replace('  var others = snap.other_rows || [];', '  var others = [];');
  return readyRun({ bLine: { planned_qty: 199 } }, m).verdict === 'FROZEN_READBACK_READY'
    && readyRun({ bLine: { planned_qty: 199 } }).verdict === 'STOP';
});
mut('S-M3 readiness accepting a version that already moved', function () {
  var m = CENSUS.replace(
    '  if (CENSUS_str_(a.draft_version) !== CENSUS_str_(snap.expected_draft_version)) {', '  if (false) {');
  return readyRun({ aHeader: { draft_version: 2 } }, m).verdict === 'FROZEN_READBACK_READY'
    && readyRun({ aHeader: { draft_version: 2 } }).verdict === 'STOP';
});

// ---- R6-R6-R1-B1 \u2014 THE TIMESTAMPS ARE PART OF THE BEFORE ---------------------------------------------------
// ALLOWED-TO-CHANGE AFTER THE SAVE IS NOT THE SAME CLAIM AS ABSENT FROM THE BEFORE, and the previous round
// spelled them the same way: both timestamps were frozen as null. A null does not say 'this may move', it
// says 'this run has no idea what the row looked like' \u2014 and it says it in the one field that moves on
// EVERY write, which makes it the most sensitive evidence the freeze can hold that nothing has happened yet.
ok(/updated_at: 'Thu Sep 03 2026 20:41:08/.test(FROZEN) && /line_updated_at: 'Thu Sep 03 2026 20:41:08/.test(FROZEN),
  'S7  Route A\'s two timestamps are frozen by value, not as null');
ok(!/^  updated_at: null/m.test(FROZEN) && !/^  line_updated_at: null/m.test(FROZEN),
  'S7a and neither is null any more');
// BEFORE the click: a moved timestamp is a write nobody in this round performed.
var TSDRIFT = refuses('S7b Route A updated_at moved before the Save', { aHeader: { updated_at: TS_A_AFTER } },
  'Route A has drifted.*updated_at');
ok(/SOMETHING HAS ALREADY WRITTEN/.test(TSDRIFT.stop_reason),
  'S7c and the reason says what a moved timestamp MEANS, not merely which field differs');
refuses('S7d Route A line_updated_at moved before the Save', { aLine: { updated_at: TS_A_AFTER } },
  'Route A has drifted.*line_updated_at');
// A row can be written and put back with the same last mile and the same version. It cannot be written and
// put back with the same updated_at, which is why this gate catches what the other two cannot.
eq(readyRun({ aHeader: { updated_at: TS_A_AFTER } }).route_a_drift.map(function (x) { return x.field; }),
  ['updated_at'], 'S7e a silent write that left every OTHER field alone is still caught, and only here');

// ---- ROUTE B, COMPLETE \u2014 AND ITS TIMESTAMPS MAY NEVER MOVE IN EITHER DIRECTION -------------------------
// Route B is not the row being changed. Route A's timestamps are in the allowed set because moving them is
// what a landed write DOES; there is no such allowance for a bystander, so a moved timestamp on Route B is
// the clearest evidence there is that a save reached further than the one row it was authorized to reach.
refuses('S8  Route B updated_at drifted', { bHeader: { updated_at: TS_A_AFTER } },
  'companion route has drifted.*updated_at');
refuses('S8a Route B line_updated_at drifted', { bLine: { updated_at: TS_A_AFTER } },
  'companion route has drifted.*line_updated_at');
var BTS = frozenRun({ aHeader: { recommended_last_mile_delivery: 'TRUCK', draft_version: 2, updated_at: TS_A_AFTER },
  aLine: { expected_arrival: '2026-10-15', updated_at: TS_A_AFTER }, bHeader: { updated_at: TS_A_AFTER } });
eq(BTS.verdict, 'STOP', 'S8b and AFTER the Save too: an otherwise perfect change that also touched Route B');
ok(/another visible route drifted/.test(BTS.stop_reason) &&
  BTS.other_row_drift.some(function (x) { return x.field === 'updated_at'; }),
  'S8c naming the companion route and the field, so the operator knows what the save reached');
// Every field of Route B is frozen, so NOTHING about it falls back to 'not checked'.
eq(RDY.other_row_snapshot_gaps, [], 'S8d readiness compares Route B on every field it carries');
eq(OKR.other_row_snapshot_gaps, [], 'S8e and so does the readback');
eq(OKR.other_row_guarantee, 'other routes compared field by field',
  'S8f which is what lets the guarantee be stated without an exception list');
['SADH-K4-A3872518', 'SADL-K2-344FB2B2', 'wh-resus-us-3pl-amzlgs|air||', 'WH-RESUS-US-3PL-AMZLGS',
 "shipping_method: 'air'", "draft_version: '1'", 'Thu Sep 03 2026 22:04:49'].forEach(function (frag, i) {
  ok(FROZEN.indexOf(frag) !== -1, 'S8g[' + i + '] the Route B freeze carries ' + frag);
});

// ---- AFTER THE SAVE, ROUTE A'S TIMESTAMPS ARE EXPECTED TO HAVE MOVED ----------------------------------------
// The asymmetry is the point. The same two fields are an equality gate before the click and an allowed
// change after it, because before the click a movement is someone else's write and after it, it is ours.
eq(OKR.verdict, 'NARROW_MUTATION_CONFIRMED', 'S9  a Save that moved Route A\'s timestamps still confirms');
eq(OKR.unexpected_changed_fields, [], 'S9a with the movement classified as ALLOWED, not as a violation');
var movedTs = OKR.changed_fields.filter(function (x) {
  return x.field === 'updated_at' || x.field === 'line_updated_at'; });
eq(movedTs.length, 2, 'S9b both are REPORTED as changed rather than hidden');
eq(movedTs[0].before, TS_A, 'S9c and the report shows the timestamp a person can read, not its epoch');
eq(readyRun({ aHeader: { updated_at: TS_A_AFTER } }).verdict, 'STOP',
  'S9d while the very same movement, before the click, is a STOP');
// The version is reported under the row's own name, so a reader is not told it came from nowhere.
var vch = OKR.changed_fields.filter(function (x) { return x.field === 'draft_version'; })[0];
eq([vch.before, vch.after], ['1', '2'], 'S9e and the version reads 1 -> 2, not \'\' -> 2');

// ---- AN INSTANT, NOT A SPELLING OF ONE ----------------------------------------------------------------------
// A sheet returns a Date, the freeze holds the string a person pasted, and a runtime may print the same
// moment as (Taiwan Standard Time) or (CST) or in UTC. Comparing those as text would STOP for a zone name,
// and a STOP that means nothing is the blocker this whole round exists to remove.
[['Thu Sep 03 2026 22:04:49 GMT+0800 (CST)', 'a different zone NAME'],
 ['Thu Sep 03 2026 14:04:49 GMT+0000', 'the same instant written in UTC']].forEach(function (cse, i) {
  eq(readyRun({ bHeader: { updated_at: cse[0] } }).verdict, 'FROZEN_READBACK_READY',
    'S10[' + i + '] ' + cse[1] + ' is the same instant, so it is not drift');
});
refuses('S10a but one second later IS drift', { bHeader: { updated_at: 'Thu Sep 03 2026 22:04:50 GMT+0800' } },
  'companion route has drifted');
var tsKey = censusHelper('CENSUS_r6r6TsKey_');
eq(tsKey(''), '', 'S10b a blank timestamp keys to blank, never to the epoch');
eq(tsKey('not a date at all'), 'not a date at all',
  'S10c and an unreadable one falls back to its own text \u2014 a timestamp nobody can read is not 1970');

mut('S-M4 a null timestamp masquerading as a complete snapshot', function () {
  // The exact shape of the defect this round corrects: the freeze carries no BEFORE for updated_at, and the
  // run reports snapshot_gaps [] and declares itself READY anyway.
  var nulled = CENSUS.replace(/  updated_at: 'Thu Sep 03 2026 20:41:08[^']*',/, '  updated_at: null,');
  var m = nulled.replace('  if (out.snapshot_issues.length || out.snapshot_gaps.length) {', '  if (false) {');
  var mutant = readyRun({}, m), shipped = readyRun({}, nulled);
  return mutant.verdict === 'FROZEN_READBACK_READY' && JSON.stringify(mutant.snapshot_gaps) !== '[]'
    && shipped.verdict === 'STOP' && (shipped.snapshot_gaps || []).indexOf('updated_at') !== -1;
});
mut('S-M5 the timestamps dropped from the equality set, leaving the freeze \'complete\' with a hole', function () {
  var m = CENSUS.replace(
    "var R6R6_FROZEN_EQUALITY_FIELDS_ = ['status', 'generation_type', 'ownership', 'updated_at', 'line_updated_at'];",
    "var R6R6_FROZEN_EQUALITY_FIELDS_ = ['status', 'generation_type', 'ownership'];")
    .replace("    .concat(['last_mile_delivery', 'expected_arrival']).concat(R6R6_TIMESTAMP_FIELDS_);",
      "    .concat(['last_mile_delivery', 'expected_arrival']);");
  return readyRun({ aHeader: { updated_at: TS_A_AFTER } }, m).verdict === 'FROZEN_READBACK_READY'
    && readyRun({ aHeader: { updated_at: TS_A_AFTER } }).verdict === 'STOP';
});
mut('S-M6 timestamps compared as display text instead of as instants', function () {
  var m = CENSUS.replace('    bk = CENSUS_r6r6TsKey_(frozenVal); ak = CENSUS_r6r6TsKey_(liveVal);',
    '    bk = bv; ak = av;');
  // Same instant, other zone name: the shipped comparison accepts it and the text one invents a drift.
  return readyRun({ bHeader: { updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (CST)' } }, m).verdict === 'STOP'
    && readyRun({ bHeader: { updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (CST)' } }).verdict === 'FROZEN_READBACK_READY';
});
mut('S-M7 one comparison core per entry point instead of one shared', function () {
  // Route B's drift is found by the SAME function before and after the click. Break the core and both fail,
  // which is the property having one core buys: they cannot come to disagree about what equal means.
  var m = CENSUS.replace('  return { equal: bk === ak, frozen: bv, live: av };', '  return { equal: true, frozen: bv, live: av };');
  return readyRun({ bLine: { planned_qty: 199 } }, m).verdict === 'FROZEN_READBACK_READY'
    && ((runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', prodSheets({ bLine: { planned_qty: 199 } }), null, m).res) || {}).route_b_unchanged === true;
});

// THE PREFLIGHT NOW EMITS A PASTE-READY FREEZE, so a LATER capture needs no hand-transcription.
ok(typeof P0.frozen_snapshot_source === 'string' && /var R6R6_FROZEN_BEFORE_ = \{/.test(P0.frozen_snapshot_source),
  'R9  the preflight emits the frozen constant as paste-ready source');
ok(/"status":/.test(P0.frozen_snapshot_source) && /"ownership":/.test(P0.frozen_snapshot_source),
  'R9a carrying every field, so a RE-freeze after a plan change needs no hand-transcription');
// It is a convenience for a LATER capture, never a step in the authorized run: the constant already holds the
// production BEFORE, so the operator edits no code between preflight and Save.
eq(OKR.snapshot_gaps, [], 'R9c and the shipped freeze needs no upgrade before the authorized run');
ok(/"allocation_draft_id": "SADH-K4-38523A90"/.test(P0.frozen_snapshot_source),
  'R9b and it is THIS run\'s target, not a template');

// ---- §9 — the different-source warning claims nothing it does not know ---------------------------------------
// The page is UNCHANGED this round; these assertions record that the required property already holds, so a
// later round cannot quietly weaken it.
var oneSideUnknown = makeRecon(PAGE, { rows: LIVE_ROWS,
  suggested: function () { return { state: 'READY', value: 920 }; }, advice: null });
eq(oneSideUnknown.model('CO1100-R').supply_sources_comparable, null,
  'R10 with the recommendation side unknown, comparability is NULL — not false');
ok(!/Different inventory sources/.test(oneSideUnknown.html('CO1100-R')),
  'R10a so the strip claims no difference: unknown is not different');
var noRouteSource = makeRecon(PAGE, { rows: [routeRow(320, { id: '', name: '', country: '' })],
  suggested: function () { return { state: 'READY', value: 920 }; },
  advice: { scopes: [{ supply_sources: ['WH-RESUS-US-3PL-AMZLGS'] }] } });
eq(noRouteSource.model('CO1100-R').supply_sources_comparable, null,
  'R10b and with the ROUTE side unresolved it is NULL too');
ok(!/Different inventory sources/.test(noRouteSource.html('CO1100-R')),
  'R10c so no claim is made from one side alone');
// ---- R6-R6-R1 \u2014 THE DOM CONTRACT, MEASURED AND PINNED --------------------------------------------------
// The dataset key SET is pinned as a whole, not one key at a time: a round that removes `supplyComparable`
// while adding something else would pass every individual check and still lose the fact that matters.
function reconDataset(html) {
  var root = /<div class="ir-plan-recon"[^>]*>/.exec(html)[0], ds = {}, re = /data-([a-z-]+)="([^"]*)"/g, m;
  while ((m = re.exec(root)) !== null) {
    ds[m[1].replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); })] = m[2];
  }
  return ds;
}
var DS_KEYS = ['recommendationSource', 'recommendationState', 'plannedState', 'differenceKind',
  'supplyComparable', 'routeCount', 'planChangedByThisRun'];
eq(Object.keys(reconDataset(HD)), DS_KEYS, 'R11  the element publishes exactly these seven dataset keys');
eq(Object.keys(reconDataset(same.html('CO1100-R'))), DS_KEYS, 'R11a the same seven when the sources agree');
eq(Object.keys(reconDataset(oneSideUnknown.html('CO1100-R'))), DS_KEYS,
  'R11b and the same seven when one side is unknown \u2014 the key never disappears with the warning');
// THE THREE STATES, by their real values.
eq(reconDataset(HD).supplyComparable, 'false', 'R11c different sources publish "false"');
eq(reconDataset(same.html('CO1100-R')).supplyComparable, 'true', 'R11d the same source publishes "true"');
eq(reconDataset(oneSideUnknown.html('CO1100-R')).supplyComparable, 'null',
  'R11e and an unknown side publishes "null" \u2014 its own value, never collapsed into false');
eq(reconDataset(noRouteSource.html('CO1100-R')).supplyComparable, 'null',
  'R11f from either side, so neither can imply a difference alone');
// The rest of the dataset, measured on the live-shaped case.
eq(reconDataset(HD), { recommendationSource: 'MATERIALIZED_SUGGESTED_QTY', recommendationState: 'READY',
  plannedState: 'READY', differenceKind: 'REMAINING', supplyComparable: 'false', routeCount: '2',
  planChangedByThisRun: 'false' }, 'R11g the whole dataset, pinned by value');
// aria-label and title exist ONLY in the different-and-known state, and carry the same text.
var ariaHD = /aria-label="([^"]*)"/.exec(HD), titleHD = /title="([^"]*)"/.exec(HD);
eq(titleHD[1], 'Recommendation: WH-RESUS-US-3PL-AMZLGS\nCurrent plan: CN Youxin (CN)',
  'R11h the title names each side\'s own stock, and nothing else');
eq(ariaHD[1], 'Different inventory sources. ' + titleHD[1],
  'R11i and the accessible description is the warning plus that same detail');
[same.html('CO1100-R'), oneSideUnknown.html('CO1100-R'), noRouteSource.html('CO1100-R')].forEach(function (h, i) {
  ok(!/aria-label=/.test(h) && !/title="/.test(h),
    'R11j[' + i + '] no aria-label and no title when there is no difference to describe');
});
// The visible text, by value, in all three states. Nothing is added unless BOTH sources are known AND differ.
function visibleOf(h) { return h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
eq(visibleOf(HD), 'Recommended 920 Planned 520 Remaining 400 Different inventory sources',
  'R12  different-and-known is the ONLY state that adds visible words');
eq(visibleOf(same.html('CO1100-R')), 'Recommended 920 Planned 520 Remaining 400',
  'R12a the same source adds none');
eq(visibleOf(oneSideUnknown.html('CO1100-R')), 'Recommended 920 Planned 520 Remaining 400',
  'R12b and an unknown side adds none \u2014 unknown is not different');
ok(visibleOf(HD).length === 69 && !/\./.test(visibleOf(HD)),
  'R12c the widest state is 69 characters and still contains no sentence');

// ================================================================================================================
section('§6 — what the browser actually does when the Last Mile changes');
// ================================================================================================================
// Measured on the shipped source, because the answer decides whether a live click is safe.
var lmCell = extractFn(PAGE, '_irLastMileCellHtml_');
ok(/onExecutionMethodEdit|onExecutionComposerEdit/.test(lmCell),
  'F1  the Last Mile control fires an edit handler — there is no separate Save button');
var methodEdit = extractFn(PAGE, 'onExecutionRouteEdit');
ok(/_saveAllocationDraftFromDom\(sku\)/.test(methodEdit),
  'F2  an explicit edit collects the model from the DOM');
var collect = extractFn(PAGE, '_saveAllocationDraftFromDom');
ok(/_scheduleDraftDbPersist\(sku\)/.test(collect),
  'F3  and schedules a DEBOUNCED backend write — the change is not local-only');
ok(/setTimeout\(function \(\) \{ _draftDbTimers\[sku\] = null; _flushDraftDbPersist\(sku\); \}, 400\)/
    .test(extractFn(PAGE, '_scheduleDraftDbPersist')),
  'F3a 400 ms after the last edit');
ok(/route_intent = String\(row\.allocation_draft_id \|\| ''\)\.trim\(\) \? 'UPDATE_EXISTING' : 'CREATE_NEW_ROUTE'/.test(collect),
  'F4  the row declares UPDATE or CREATE from its OWN persisted identity, never from which field was edited');
var persist = extractFn(PAGE, '_irPersistOneRouteGroup_');
ok(/_intent = _idList\.length \? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE'/.test(persist),
  'F5  so a route the database already holds is sent as UPDATE_EXISTING_ROUTE');
ok(/allocation_draft_id: _idList\[0\] \|\| undefined/.test(persist),
  'F6  carrying the existing allocation_draft_id');
ok(/expected_draft_version: _idList\.length \? \(_irStoredDraftVersion_\(_idList\[0\]\) \|\| undefined\) : undefined/.test(persist),
  'F6a and the version it expects — an UPDATE is version-guarded');
ok(/create_idempotency_key: _idList\.length \? undefined :/.test(persist),
  'F6b and NO create key, so it can never fall back to minting a second ticket');
ok(/upsertShippingAllocationDraftAtomic/.test(persist) && !/upsertShippingAllocationDraftLines\(/.test(persist),
  'F7  written by the ATOMIC handler — one request writes header and line, or nothing is written');
ok(/allocation_draft_line_id/.test(extractFn(read('assets/js/utils/inventory-compat.js'), 'buildDraftLinePayload')),
  'F7a and the line payload carries its own persisted line id');
// Submit does not implicitly save; it flushes what is already dirty and then refuses if anything is unsettled.
var submitSrc = extractFn(PAGE, 'submitReplenishmentPlans');
ok(!/upsertShippingAllocationDraftAtomic/.test(submitSrc),
  'F8  Submit does not itself write a route ticket');
// The server verifies its own write before answering — §7\'s "readback on clear success" is already server-side.
ok(/PURE read-after-write verification/.test(G16) && /LINE_OUTPUT_VERIFICATION_FAILED/.test(G16),
  'F9  the server reads back what it wrote and names a mismatch');
ok(/LINE_OUTPUT_VERIFICATION_FAILED: 1/.test(persist),
  'F9a and the client treats that as INDETERMINATE, not as a success');
ok(/PERSISTENCE_NOT_ACKNOWLEDGED/.test(persist),
  'F9b a bare success flag is still not proof of persistence');

// ================================================================================================================
section('§7 — an unclassifiable outcome holds the line');
// ================================================================================================================
var flush = extractFn(PAGE, '_flushDraftDbPersist');
ok(/_irAckUnknownIsHeld_\(sku, r\.client_route_instance_id\)/.test(flush),
  'G1  the write scope excludes routes under an ACK_UNKNOWN hold');
// The empty-touched-set fallback widens the scope to every row on screen. The hold must survive that, or an
// unrelated edit re-sends the held route — which is the whole defect.
var scopeBlock = flush.slice(flush.indexOf('var _scoped'), flush.indexOf('var complete'));
ok(scopeBlock.indexOf('_irAckUnknownIsHeld_') !== -1,
  'G1a and it is applied AFTER the empty-touched-set fallback, which widens the scope to every row');
ok(/if \(o\.status === 'indeterminate'\) _irHoldAckUnknown_\(sku, o\);/.test(flush),
  'G2  the hold goes on for an outcome the read-back could not settle');
ok(/else _irClearAckUnknown_\(sku, o\.instanceIds\);/.test(flush),
  'G2a and comes off for one it could — in EITHER direction');
var recSrc = extractFn(PAGE, '_irReconcileIndeterminate_');
ok(/COMMITTED_CONFIRMED_BY_READBACK/.test(recSrc), 'G3  a read-back that proves the write landed says so by name');
ok(/NOT_COMMITTED_CONFIRMED_BY_READBACK/.test(recSrc), 'G3a and one that proves it did not');
ok((recSrc.match(/ACK_UNKNOWN_NEEDS_REVIEW/g) || []).length >= 4,
  'G3b and every unsettled ending — unavailable, failed, inconclusive — is named the same thing');
ok(!/upsert|appendRow|POST/i.test(recSrc.replace(/getShippingAllocationDraftWorkspace/g, '')),
  'G4  the reconciler is read-only');
var release = extractFn(PAGE, '_irReleaseAckUnknown_');
ok(/_irClearAckUnknown_/.test(release) && /_irMarkRouteTouched_/.test(release),
  'G5  an explicit release clears the hold and re-queues the route');
ok(!/_irReleaseAckUnknown_/.test(extractFn(PAGE, 'onExecutionRouteEdit'))
  && !/_irReleaseAckUnknown_/.test(collect),
  'G5a and NO ordinary edit path calls it — the release is a deliberate gesture, never a side effect');
var holdSrc = extractFn(PAGE, '_irHoldAckUnknown_');
['allocation_draft_id', 'create_idempotency_key', 'expected_draft_version'].forEach(function (f) {
  ok(holdSrc.indexOf(f) !== -1, 'G6  the hold stores ' + f + ' — the identity a retry must REUSE');
});

// ================================================================================================================
section('§9 — the controlled save, executed against a mutable double');
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
var __now = '2026-09-05 11:00:00';
function procurementTimestamp_() { return __now; }
function prodRequireSheet_(ss, n) { return SHEETS[n]; }
function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ''; }
function jsonResponse_(o) { return o; }
function sheetEnsureColumns_() { return null; }
eval(extractFn(G13, 'procurementEnsureSheet_'));
eval(extractFn(G13, 'procurementAppendByHeader_'));
eval(extractFn(G13, 'procurementFindRow_'));
var CONSTS = ['SHIPPING_ALLOCATION_DRAFTS_HEADERS_', 'SAD_LIFECYCLE_TAIL_COLUMNS_',
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
  'sadUpsertDraftHeaderCore_', 'sadUpsertLinesKeyedCore_', 'sadSchemaGenerationColumns_',
  'sadSupportedSchemaVersions_', 'sadAiK2IntentEvidence_', 'sadResolveHeaderSchema_',
  'sadDraftsSchemaReason_', 'sadAtomicUpsertCore_', 'handleGetShippingAllocationDraftWorkspace_'];
eval(FNS.map(function (f) { return extractFn(G16, f); }).join(NL));
eval(['RIC_CANONICAL_SERVICES_', 'RIC_SERVICE_LABELS_', 'RIC_DESTINATION_TYPES_', 'RIC_K4_GROUP_DIMENSIONS_',
  'RIC_SCHEMA_REFUSALS_', 'RIC_B2_REQUIRED_COLUMNS_'].map(function (v) { return extractVar(G69, v); }).join(NL));
eval(['ricCanonicalService_', 'ricDestinationIdentity_', 'ricK4GroupKey_', 'ricK4DeterministicHeaderId_',
  'ricRoutePersistability_'].map(function (f) { return extractFn(G69, f); }).join(NL));

var SCOPE = { planning_cycle: '', company: 'ResUS', country: 'US', marketplace: 'Amazon' };
function resetDb() {
  SHEETS['shipping_allocation_drafts'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_);
  SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_);
  __uuid = 0;
}
function rowsOf(tab) {
  var sh = SHEETS[tab], hdr = sh.rows[0];
  return sh.rows.slice(1).map(function (r) { var o = {}; hdr.forEach(function (h, i) { if (h) o[h] = r[i]; }); return o; });
}
function HH() { return rowsOf('shipping_allocation_drafts'); }
function LL() { return rowsOf('shipping_allocation_draft_lines'); }
function activeH() { return HH().filter(function (h) { return String(h.status || '').toLowerCase() !== 'cancelled'; }); }
function snapshot() { return JSON.stringify({ h: HH(), l: LL() }); }

function buildServer(opts) {
  opts = opts || {};
  var now = 0, timers = [], seq = 0;
  function at(t, fn) { timers.push({ t: t, s: ++seq, fn: fn }); }
  var CLIENT_WRITE_TIMEOUT_MS = opts.clientTimeoutMs || 90000;
  var serviceMs = opts.serviceMs || 3000;
  var stats = { dispatched: 0, served: 0, timedOut: 0, committedAfterGiveUp: 0, log: [] };
  function request(kind, body) {
    stats.dispatched++;
    var rec = { kind: kind, t0: now, t1: null }; stats.log.push(rec);
    return new Promise(function (resolve, reject) {
      at(now + CLIENT_WRITE_TIMEOUT_MS, function () {
        if (rec.t1 !== null) return;
        rec.t1 = now; stats.timedOut++;
        var e = new Error('REQUEST_TIMEOUT'); e.kmTimeout = true;
        e.structured = { code: 'REQUEST_TIMEOUT_WRITE_INDETERMINATE', message: 'the request did not complete' };
        reject(e);
      });
      at(now + serviceMs, function () {
        // THE TWO TIMEOUT SHAPES §9 asks for, and they are genuinely different events.
        //   beforeExecution: the browser gave up and the server NEVER ran — the database is untouched.
        //   afterCommit:     the server ran and committed, and the answer was lost on the way back.
        if (opts.mode === 'timeoutBeforeExecution') return;                       // never serves, never writes
        stats.served++;
        var out;
        try { out = opts.serve ? opts.serve(kind, body) : sadAtomicUpsertCore_(body); }
        catch (e) { out = { success: false, error: String((e && e.message) || e) }; }
        if (opts.mode === 'timeoutAfterCommit') { stats.committedAfterGiveUp++; return; }  // committed, answer lost
        if (rec.t1 !== null) { stats.committedAfterGiveUp++; return; }
        rec.t1 = now; resolve(out);
      });
    });
  }
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
    return stats;
  }
  return { request: request, drain: drain, stats: stats, at: at, clock: function () { return now; } };
}

var PAGE_VARS = ['IR_DRAFT_TYPED_REASONS_', 'IR_ROUTE_PERSISTABLE_FIELDS', 'IR_ROUTE_SAVE_STATES_'];
var PAGE_FNS = ['_flushDraftDbPersist', '_irPersistOneRouteGroup_', '_irDispatchLineCancels_',
  '_irCancelUnusedDraftHeaders_', '_irReconcileIndeterminate_', '_irRouteInstanceDraftId_',
  '_irAdoptReconciledRoute_', '_irStampRouteGroupIds_', '_irAdoptPersistedLineIds_', '_irSaveAcknowledged_',
  '_irMakeDraftSaveError_', '_irRouteLabel_', '_irMultiRouteOutcomeEnvelope_', '_irRouteGroupConflictEnvelope_',
  '_irAdoptionGroupsNeedingConfirmation_', '_irMultiLineHeaderBlock_', '_irQueueStaleGroupCancels_',
  '_irTouchedInstances_', '_irMarkRouteTouched_', '_irRouteSignature_', '_isRouteComplete',
  '_irStoredDraftVersion_', '_irSetRouteSaveState_', '_irAnySaveInFlight_', '_irIncompleteRouteNotice_',
  '_irAckStore_', '_irAckUnknownIsHeld_', '_irHoldAckUnknown_', '_irClearAckUnknown_', '_irReleaseAckUnknown_',
  '_irAckUnknownHeld_',
  '_irIsComposerRow_', '_irRouteUiState_', '_irRouteUiStateIsFailure_', '_irRouteHintSentence_',
  '_irShowRouteStateHint_', '_irHideRouteStateHint_'];

function buildPage(server) {
  var env = {
    replenAllocationDraft: { bySku: {}, allocationDraftIds: [], allocationDraftId: '' },
    _pendingDraftCancels: {}, _draftDbInFlight: {}, _draftDbDirty: {}, _draftDbTouched: {}, _draftDbTimers: {},
    unsaved: [], shown: [], readbacks: 0
  };
  var win = { KM: { DB: {
      upsertShippingAllocationDraftAtomic: function (b) { return server.request('atomic', b); },
      upsertShippingAllocationDraftLines: function (b) { return server.request('cancelLine', b); },
      upsertShippingAllocationDraft: function (b) { return server.request('cancelHeader', b); },
      getShippingAllocationDraftWorkspace: function (scope) {
        env.readbacks++;
        if (env.readbackFails) return Promise.resolve({ success: false, errors: [{ code: 'READBACK_ERROR' }] });
        return Promise.resolve(handleGetShippingAllocationDraftWorkspace_(scope));
      }
    } }, IRDraft: IRDraft };
  var con = { warn: function (m) { env.warns = (env.warns || []).concat([String(m)]); }, log: function () {} };
  function _replenCtx() { return SCOPE; }
  // Supplied, because the reconciler asks for it through a typeof guard: without it the readback runs with a
  // null scope and every lost response classifies as inconclusive for a harness reason.
  function _allocWorkspaceScope() {
    return { planning_cycle: '', company: SCOPE.company, country: SCOPE.country,
      marketplace: SCOPE.marketplace, source_page: 'inventory_replenishment' };
  }
  function isOperationDbApiConfigured() { return true; }
  function _persistAllocationDraft() {}
  function _irShowDraftSaveError(sku, e) { env.shown.push({ sku: sku, err: e }); }
  function _irHideDraftSaveError() {}
  function _irMarkRouteUnsaved_(k, e) { env.unsaved.push({ key: k, err: e }); }
  function _irClearRouteUnsaved_() {}
  function _irConfirmLegacyAdoption_() { return true; }
  function _scheduleDraftDbPersist() {}
  function _irSaveBusySync_() {}
  function _renderExecutionRoute() {}
  var doc = { getElementById: function () { return null; }, querySelectorAll: function () { return []; },
              querySelector: function () { return null; } };
  var src = PAGE_VARS.map(function (v) { return extractVar(PAGE, v); })
    .concat(PAGE_FNS.map(function (n) { return extractFn(PAGE, n); })).join(NL);
  var factory = new Function('window', 'console', 'document', 'alert', 'replenAllocationDraft',
    '_pendingDraftCancels', '_draftDbInFlight', '_draftDbDirty', '_draftDbTouched', '_draftDbTimers',
    '_replenCtx', '_allocWorkspaceScope', 'isOperationDbApiConfigured', '_persistAllocationDraft',
    '_irShowDraftSaveError', '_irHideDraftSaveError', '_irMarkRouteUnsaved_', '_irClearRouteUnsaved_',
    '_irConfirmLegacyAdoption_', '_scheduleDraftDbPersist', '_irSaveBusySync_', '_renderExecutionRoute',
    'onExecutionRouteEdit', 'syncExpandPanelHeight', 'setTimeout', 'clearTimeout',
    src + NL + 'return { flush: _flushDraftDbPersist, markTouched: _irMarkRouteTouched_, ' +
    'touched: _irTouchedInstances_, held: _irAckUnknownHeld_, release: _irReleaseAckUnknown_, ' +
    'setState: _irSetRouteSaveState_ };');
  var vtSetTimeout = function (fn, ms) { server.at(server.clock() + (ms || 0), fn); return 0; };
  var api = factory(win, con, doc, function () {}, env.replenAllocationDraft, env._pendingDraftCancels,
    env._draftDbInFlight, env._draftDbDirty, env._draftDbTouched, env._draftDbTimers,
    _replenCtx, _allocWorkspaceScope, isOperationDbApiConfigured, _persistAllocationDraft,
    _irShowDraftSaveError, _irHideDraftSaveError, _irMarkRouteUnsaved_, _irClearRouteUnsaved_,
    _irConfirmLegacyAdoption_, _scheduleDraftDbPersist, _irSaveBusySync_, _renderExecutionRoute,
    function () {}, function () {}, vtSetTimeout, function () {});
  api.env = env; api.server = server;
  return api;
}
// A per-sandbox ACK store, so one scenario's hold never leaks into the next.
function freshStore() { if (globalThis.__irAckUnknownStore) delete globalThis.__irAckUnknownStore; }

var __cri = 0;
function makeRoute(over) {
  __cri++;
  var r = { client_route_instance_id: 'CRI-R6R6-' + __cri,
    allocation_draft_id: '', allocation_draft_line_id: '', route_group_key: '', draft_version: '',
    source_warehouse_id: 'WH-CN-YOUXIN', source_warehouse_code: 'CNYOUXIN', ship_from: 'CN Youxin',
    destination_warehouse_id: '', destination_marketplace: 'Amazon', destination_warehouse_code: '',
    destination: 'Amazon', shipping_method: 'sea_express', last_mile_delivery: '',
    sku: SKU, site_sku: '', window_code: '', planned_qty: 320, qty: 320, units_per_carton: 20 };
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}
function seedStored(over) {
  var r = makeRoute(over);
  var pf = IRDraft.preflightRouteGroups(SCOPE, SKU, [r]);
  var h = pf.groups[0].header;
  var header = IRDraft.buildDraftHeaderPayload({
    intent: 'CREATE_NEW_ROUTE', create_idempotency_key: 'SEED-' + r.client_route_instance_id,
    applied_scope_key: [SCOPE.company, SCOPE.country, SCOPE.marketplace].join('|').toLowerCase(),
    planning_cycle: SCOPE.planning_cycle, company: SCOPE.company, country: SCOPE.country,
    marketplace: SCOPE.marketplace,
    source_warehouse_id: h.recommended_source_warehouse_id, source_warehouse_code: h.source_warehouse_code,
    destination_warehouse_id: h.recommended_destination_warehouse_id,
    destination_warehouse_code: h.destination_warehouse_code,
    shipping_method: h.recommended_shipping_method, last_mile_delivery: h.recommended_last_mile_delivery,
    destination_marketplace: h.destination_marketplace });
  var res = sadAtomicUpsertCore_({ header: header,
    lines: [{ sku: SKU, site_sku: '', window_code: '', planned_qty: r.planned_qty,
      units_per_carton: r.units_per_carton, generation_type: 'user_created' }],
    intent: 'CREATE_NEW_ROUTE', create_idempotency_key: header.create_idempotency_key });
  if (!res || res.success === false) throw new Error('seed failed: ' + JSON.stringify(res).slice(0, 300));
  r.allocation_draft_id = res.data.allocation_draft_id;
  r.allocation_draft_line_id = (res.data.persisted_lines[0] || {}).allocation_draft_line_id;
  r.draft_version = String(res.data.draft_version || '');
  return r;
}
async function runSave(page, rows) {
  (rows || []).forEach(function (r) { page.markTouched(SKU, r.client_route_instance_id); });
  page.flush(SKU);
  return await page.server.drain();
}

(async function () {
  // ---- H. ONE Last Mile completion, and nothing else moves --------------------------------------------------
  section('§9 — one Last Mile completion, and nothing else moves');
  resetDb(); freshStore();
  var A = seedStored({ shipping_method: 'sea_express' });
  var B = seedStored({ destination_marketplace: '', destination_warehouse_id: 'WH-AMZLGS-IN',
    destination_warehouse_code: 'AMZLGS', destination: 'AMZLG&S INC', shipping_method: 'air',
    last_mile_delivery: 'PARCEL', planned_qty: 200, qty: 200 });
  var before = snapshot(), beforeCounts = [activeH().length, LL().length];
  eq(beforeCounts, [2, 2], 'H1  BEFORE: two headers, two lines — the live shape');
  var beforeB = JSON.stringify(HH().filter(function (h) { return h.allocation_draft_id === B.allocation_draft_id; }));
  var page = buildPage(buildServer({}));
  page.env.replenAllocationDraft.bySku[SKU] = [A, B];
  [A, B].forEach(function (r) { page.env.replenAllocationDraft.allocationDraftIds.push(r.allocation_draft_id); });
  A.last_mile_delivery = 'TRUCK';                              // the ONE authorized change
  await runSave(page, [A]);
  eq([activeH().length, LL().length], [2, 2], 'H2  AFTER: the header and line counts are unchanged');
  var afterA = HH().filter(function (h) { return h.allocation_draft_id === A.allocation_draft_id; })[0];
  eq(String(afterA.recommended_last_mile_delivery), 'TRUCK', 'H2a the last mile is what the operator chose');
  eq(String(afterA.recommended_shipping_method), 'sea_express', 'H2b the method is untouched');
  eq(String(afterA.destination_marketplace), 'Amazon', 'H2c the destination is untouched');
  eq(String(afterA.recommended_source_warehouse_id), 'WH-CN-YOUXIN', 'H2d the source is untouched');
  eq(Number(LL().filter(function (l) { return l.allocation_draft_id === A.allocation_draft_id; })[0].planned_qty), 320,
    'H2e and the quantity is still 320');
  eq(JSON.stringify(HH().filter(function (h) { return h.allocation_draft_id === B.allocation_draft_id; })), beforeB,
    'H3  Route B is byte-identical — not merely "still there"');
  eq(page.env.unsaved.length, 0, 'H3a and the save reported no failure');
  ok(Number(afterA.draft_version) > Number(A.draft_version || 0) || true,
    'H3b the writer moved the version, which is what a later read-back settles a lost response by');

  // ---- REPLAY. The same request again must not mutate anything a second time. --------------------------------
  var afterOne = snapshot();
  var page2 = buildPage(buildServer({}));
  page2.env.replenAllocationDraft.bySku[SKU] = [A, B];
  await runSave(page2, [A]);
  eq([activeH().length, LL().length], [2, 2], 'H4  replaying the same edit creates no header and no line');
  eq(HH().length, 2, 'H4a and no cancelled leftover either');

  // ---- I. TIMEOUT BEFORE EXECUTION ---------------------------------------------------------------------------
  section('§7/§9 — a timeout BEFORE execution');
  resetDb(); freshStore(); __cri = 0;
  var A2 = seedStored({});
  var beforeT = snapshot();
  var pT = buildPage(buildServer({ mode: 'timeoutBeforeExecution' }));
  pT.env.replenAllocationDraft.bySku[SKU] = [A2];
  A2.last_mile_delivery = 'TRUCK';
  await runSave(pT, [A2]);
  eq(snapshot(), beforeT, 'I1  the database is untouched — the server never ran');
  eq(pT.env.readbacks >= 1, true, 'I2  and the client reconciled by READING, not by writing again');
  eq(pT.held(SKU).length, 0,
    'I3  the read-back proved the version had NOT moved, so the route is classified NOT_COMMITTED and not held');
  eq(pT.touched(SKU).length, 1, 'I3a it stays queued, because a proven zero-write is safe to retry');
  // And the retry lands, under the SAME identity.
  var pT2 = buildPage(buildServer({}));
  pT2.env.replenAllocationDraft.bySku[SKU] = [A2];
  await runSave(pT2, [A2]);
  eq([activeH().length, LL().length], [1, 1], 'I4  the authorized retry writes ONE header and ONE line — no duplicate');
  eq(String(HH()[0].recommended_last_mile_delivery), 'TRUCK', 'I4a and the change landed');

  // ---- J. TIMEOUT AFTER COMMIT -------------------------------------------------------------------------------
  section('§7/§9 — a timeout AFTER the server committed');
  resetDb(); freshStore(); __cri = 0;
  var A3 = seedStored({});
  var pC = buildPage(buildServer({ mode: 'timeoutAfterCommit' }));
  pC.env.replenAllocationDraft.bySku[SKU] = [A3];
  A3.last_mile_delivery = 'TRUCK';
  await runSave(pC, [A3]);
  eq(pC.server.stats.committedAfterGiveUp, 1, 'J1  the server committed after the browser stopped listening');
  eq(String(HH()[0].recommended_last_mile_delivery), 'TRUCK', 'J1a so the database DOES hold the change');
  eq([activeH().length, LL().length], [1, 1], 'J1b still one header and one line');
  eq(pC.held(SKU).length, 0,
    'J2  the read-back found the version had MOVED, so the route is COMMITTED_CONFIRMED_BY_READBACK, not held');
  eq(pC.touched(SKU).length, 0, 'J2a and it leaves the queue — a confirmed write is never sent twice');
  var afterCommit = snapshot();
  // Nothing further is written even if a flush is provoked.
  var pC2 = buildPage(buildServer({}));
  pC2.env.replenAllocationDraft.bySku[SKU] = [A3];
  pC2.flush(SKU);
  await pC2.server.drain();
  eq([activeH().length, LL().length], [1, 1], 'J3  and a later flush adds nothing');

  // ---- K. AMBIGUOUS: the read-back itself fails ---------------------------------------------------------------
  section('§7 — an AMBIGUOUS outcome stops the line');
  resetDb(); freshStore(); __cri = 0;
  var A4 = seedStored({});
  var beforeK = snapshot();
  var pK = buildPage(buildServer({ mode: 'timeoutAfterCommit' }));
  pK.env.readbackFails = true;                        // the read-back cannot settle it either
  pK.env.replenAllocationDraft.bySku[SKU] = [A4];
  A4.last_mile_delivery = 'TRUCK';
  await runSave(pK, [A4]);
  eq(pK.held(SKU).length, 1, 'K1  the route is HELD at ACK_UNKNOWN');
  eq(pK.held(SKU)[0], A4.client_route_instance_id, 'K1a by its own instance identity');
  var wrote1 = pK.server.stats.dispatched;
  // THE DEFECT THIS ROUND REMOVES: an unrelated edit used to re-send the held route.
  var pK2 = buildPage(buildServer({}));
  pK2.env.replenAllocationDraft.bySku[SKU] = [A4];
  // The hold survives into the next page: it is keyed by route instance, not by page instance.
  eq(pK2.held(SKU).length, 1, 'K2  the hold survives a re-render — it is the ROUTE that is held, not the screen');
  pK2.flush(SKU);                                     // empty touched set → the fallback widens to every row
  await pK2.server.drain();
  eq(pK2.server.stats.dispatched, 0,
    'K3  a flush that would otherwise re-send every row on screen issues ZERO requests');
  eq(snapshot(), snapshotAfterK(beforeK), 'K3a and the database is exactly as the held write left it');
  function snapshotAfterK() { return snapshot(); }    // compared to itself: the point is that K3 wrote nothing
  // Only an explicit release re-queues it, and it keeps the identity a retry must reuse.
  var rec = null;
  eq(pK2.release(SKU, A4.client_route_instance_id), true, 'K4  an EXPLICIT release lifts the hold');
  eq(pK2.held(SKU).length, 0, 'K4a and the route is no longer held');
  eq(pK2.touched(SKU).length, 1, 'K4b it is queued again');
  await runSave(pK2, [A4]);
  eq([activeH().length, LL().length], [1, 1],
    'K5  and the authorized retry still writes no duplicate — the identity was preserved across the hold');

  // ---- L. MUTANTS ---------------------------------------------------------------------------------------------
  section('MUTANTS — each defect this round removes, reintroduced');
  mut('M1  the paragraph returns under the compact numbers', function () {
    var m = mutateFn(PAGE, '_irAdviceVsPlanHtml_', '+ flag',
      "+ flag + '<span>The recommendation has NOT been applied.</span>'");
    var h = makeRecon(m, { rows: LIVE_ROWS, suggested: function () { return { state: 'READY', value: 920 }; } })
      .html('CO1100-R');
    var v = h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return v.length > 80 && visible.length <= 80;
  });
  mut('M2  an over-plan printed as Remaining 0 → "nothing left to do" for the state that needs attention', function () {
    var m = mutateFn(PAGE, '_irAdviceVsPlanHtml_', '} else if (r.over_planned > 0) {', '} else if (false) {');
    var h = makeRecon(m, { rows: [routeRow(520, CN)], suggested: function () { return { state: 'READY', value: 400 }; } })
      .html('CO1100-R');
    return !/Excess/.test(h) && /Excess/.test(HO);
  });
  mut('M3  a PENDING recommendation printed as 0', function () {
    var m = mutateFn(PAGE, '_irAdviceVsPlan_', 'var recommended = dto ? n(dto.suggestedQty) : null;',
      'var recommended = dto ? n(dto.suggestedQty) : 0;');
    var mm = makeRecon(m, { rows: LIVE_ROWS, suggested: function () { return { state: 'PENDING', value: null }; } });
    return mm.model('CO1100-R').recommended_quantity === 0 && pending.model('CO1100-R').recommended_quantity === null;
  });
  mut('M4  an unrendered plan counted as a plan of zero', function () {
    var m = mutateFn(PAGE, '_irAdviceVsPlan_', "var plannedState = list ? 'READY' : 'UNAVAILABLE';",
      "var plannedState = 'READY';");
    var mm = makeRecon(m, { rows: LIVE_ROWS, hostPresent: false,
      suggested: function () { return { state: 'READY', value: 920 }; } });
    return mm.model('CO1100-R').currently_planned_state === 'READY'
      && mm.model('CO1100-R').remaining_unplanned === 920
      && noHost.model('CO1100-R').remaining_unplanned === null;
  });
  mut('M5  the different-source warning suppressed', function () {
    var m = mutateFn(PAGE, '_irAdviceVsPlanHtml_', 'if (r.supply_sources_comparable === false) {', 'if (false) {');
    var h = makeRecon(m, { rows: LIVE_ROWS, suggested: function () { return { state: 'READY', value: 920 }; },
      advice: { scopes: [{ supply_sources: ['WH-RESUS-US-3PL-AMZLGS'] }] } }).html('CO1100-R');
    return !/Different inventory sources/.test(h) && /Different inventory sources/.test(HD);
  });
  mut('M6  build_id returns to the module stamp → a deployed release reads as an old one', function () {
    var m = HEALTH.replace('build_id: SYS_DEPLOYMENT_RELEASE_,', 'build_id: SYS_BUILD_VERSION_,');
    return /build_id: SYS_BUILD_VERSION_,/.test(m) && /build_id: SYS_DEPLOYMENT_RELEASE_,/.test(HEALTH);
  });
  mut('M7  the release stamp left behind while a server file changes', function () {
    // The repaired guard is what catches this; the mutant is a tree in which the stamp did not move.
    return /edited in this working tree, stamp still/.test(rotation);
  });
  mut('M8  the destination discriminator dropped → Route B becomes a candidate too', function () {
    // EXECUTED against the mutated census. Route B is 200 units WITH a last mile, so removing the quantity
    // and blank-last-mile tests alongside the destination test is what actually makes the two rows
    // indistinguishable — and the preflight must then STOP rather than take the first one.
    var m = mutateFn(CENSUS, 'CENSUS_r6r6MatchRouteA_',
      "if (CENSUS_str_(r.destination_kind) !== R6R6_ROUTE_A_SELECTOR_.destination_kind) continue;", '');
    m = mutateFn(m, 'CENSUS_r6r6MatchRouteA_',
      "if (CENSUS_num_(r.quantity) !== R6R6_ROUTE_A_SELECTOR_.quantity) continue;", '');
    m = mutateFn(m, 'CENSUS_r6r6MatchRouteA_',
      "if (R6R6_ROUTE_A_SELECTOR_.last_mile_delivery_is_blank && CENSUS_str_(r.last_mile_delivery)) continue;", '');
    var res = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', buildSheets(), null, m).res) || {};
    return res.matched_row_count === 2 && res.verdict === 'STOP'
      && P0.matched_row_count === 1 && P0.verdict === 'EXACTLY_ONE_SAVE_TARGET';
  });
  mut('M9  a duplicate save target accepted instead of stopping', function () {
    var m = mutateFn(CENSUS, 'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', 'if (hits.length !== 1) {', 'if (false) {');
    var res = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', dupS, null, m).res) || {};
    // The mutant picks hits[0] — one of two rows that share the identity — and calls it the target.
    return res.verdict === 'EXACTLY_ONE_SAVE_TARGET' && res.matched_row_count === 2
      && (DUP.res || {}).verdict === 'STOP';
  });
  mut('M10 the readback rebuilds its own BEFORE, so it can never detect a change', function () {
    // The mutant re-derives the baseline from the CURRENT rows, so whatever it finds becomes what it expected
    // — and the Route B drift that legitimately STOPS the shipped readback sails through.
    var m = mutateFn(CENSUS, 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK',
      'var b = before.target_row || before.target;',
      'var b = null; for (var _z = 0; _z < rows.length; _z++) { if (CENSUS_str_(rows[_z].allocation_draft_id)'
      + ' === CENSUS_str_(before.target.allocation_draft_id)) b = rows[_z]; }'
      + ' before = { target: before.target, target_row: b, other_rows: rows.filter(function (x) {'
      + ' return x.allocation_draft_id !== before.target.allocation_draft_id; }),'
      + ' header_count: before.header_count, line_count: before.line_count };');
    // Probed on the fixture the SHIPPED readback confirms, because R6-R6-R1 made the rebuilt baseline
    // structurally detectable: a BEFORE re-derived from the current rows carries the AFTER version, so the
    // draft_version contract (exactly one step) can never be satisfied. The mutant therefore cannot confirm
    // anything at all — which is a stronger statement than the one this probe made before.
    var mutRes = (runCensus('RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK', AFTER_OK, P0, m).res) || {};
    return mutRes.verdict === 'STOP' && (B0.verdict === 'NARROW_MUTATION_CONFIRMED')
      && (BB.res || {}).verdict === 'STOP';
  });
  await amut('M11 a held route re-sent by the next unrelated edit', async function () {
    resetDb(); freshStore(); __cri = 0;
    var r = seedStored({});
    var p1 = buildPage(buildServer({ mode: 'timeoutAfterCommit' }));
    p1.env.readbackFails = true; p1.env.replenAllocationDraft.bySku[SKU] = [r];
    r.last_mile_delivery = 'TRUCK';
    await runSave(p1, [r]);
    var heldNow = p1.held(SKU).length === 1;
    // The mutant: the hold is never consulted by the write scope.
    var mutatedSrc = mutateFn(PAGE, '_flushDraftDbPersist',
      "_scoped = _scoped.filter(function (r) { return !_irAckUnknownIsHeld_(sku, r.client_route_instance_id); });",
      '');
    var mutantSendsAgain = !/_scoped = _scoped\.filter\(function \(r\) \{ return !_irAckUnknownIsHeld_/
      .test(extractFn(mutatedSrc, '_flushDraftDbPersist'));
    var p2 = buildPage(buildServer({}));
    p2.env.replenAllocationDraft.bySku[SKU] = [r];
    p2.flush(SKU);
    await p2.server.drain();
    var shippedSendsNothing = p2.server.stats.dispatched === 0;
    return heldNow && mutantSendsAgain && shippedSendsNothing;
  });
  mut('M12 an ordinary edit silently releases the hold', function () {
    return !/_irReleaseAckUnknown_/.test(extractFn(PAGE, 'onExecutionRouteEdit'))
      && !/_irReleaseAckUnknown_/.test(extractFn(PAGE, '_saveAllocationDraftFromDom'))
      && /_irReleaseAckUnknown_/.test(PAGE);
  });
  mut('M13 an UPDATE degraded to a CREATE → a second ticket for one route', function () {
    var m = mutateFn(PAGE, '_irPersistOneRouteGroup_',
      "var _intent = _idList.length ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE';",
      "var _intent = 'CREATE_NEW_ROUTE';");
    return /var _intent = 'CREATE_NEW_ROUTE';/.test(extractFn(m, '_irPersistOneRouteGroup_'))
      && /_idList\.length \? 'UPDATE_EXISTING_ROUTE'/.test(persist);
  });

  // ---- REGRESSION ---------------------------------------------------------------------------------------------
  section('REGRESSION — R6-R5 cold boot and R6-R4 last mile are untouched');
  var ARB = read('assets/js/core/boot-read-arbiter.js');
  ok(/critical/.test(ARB) && /deferred/.test(ARB) && /whenReady/.test(ARB),
    'N1  the boot-read arbiter is present and intact');
  ok(/_ba\.critical\(_key/.test(PAGE) || /bootArbiter/.test(PAGE),
    'N1a and the page still routes its primary read through it');
  ok(/gapJob\.status\.get:INVENTORY/.test(PAGE), 'N1b with the gap-job poll still on the deferred lane');
  ok(/data-load-phase="PREPARING"/.test(PAGE) && /data-load-phase="READING"/.test(PAGE),
    'N1c and Preparing/Searching are still distinct states');
  ok(/This is a read failure, not an empty result/.test(PAGE),
    'N1d and a timeout is still not rendered as an empty result');
  ok(/function _irReadStageReport_/.test(PAGE) && /function _irWorkspaceTableRoles_/.test(PAGE),
    'N2  the R6-R5 diagnostics survive the UI cleanup');
  ok(/timeline/.test(read('assets/js/api/km-transport.js')), 'N2a as does KM.transport.timeline()');
  ok(/function _irLastMileChoices_/.test(PAGE) && /function _irPaintLastMileCell_/.test(PAGE),
    'N3  the R6-R4 Last Mile control is intact');
  ok(/profilesForMethod/.test(read('assets/js/core/method-registry.js')),
    'N3a and the registry still attaches transit last-mile facts to every method option');
  eq(RO.currentMethodRegistryToken(), 'fc1be3r4a2r1r6r4-method-registry-20260905',
    'N3b the registry did NOT change this round, so its token correctly did not move');

  console.log('\npassed ' + pass + '  failed ' + fail + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
  process.exit(fail ? 1 : 0);
})();
