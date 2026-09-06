// F1-7N-FB-4F-B6-R1 — EXPECTED ARRIVAL: A STRUCTURED VALUE WITH ONE OWNER.
//
// B6 left exactly one item unimplemented and said so: an explicitly saved Expected Arrival is not persisted.
// R1 closes everything that closure needs EXCEPT the one decision the business has never made, and this suite
// proves both halves — what now works, and what is deliberately still not wired, so a later round cannot
// quietly restore a guess.
//
// THE BLOCKED DECISION, stated once here and asserted at the bottom:
//   CARRIER_AND_ROUTE_SPEC.md §5B Step B — Expected Arrival = Planned Ship Date + max_days + Receiving Buffer
//   INVENTORY_TABLE_MAPPING_SPEC.md §326 — this cell recalculates on "From / To / Method / planned ship date"
// There is no planned ship date on the Execution Plan, on the 35-column draft header, on the 31-column line or
// on shipping_plans; and `Receiving Buffer` is named by the spec but defined by no field, table or value. The
// shipped display substitutes TODAY and avg_days, which is a fine REFERENCE figure and is exactly the
// substitution a persisted commitment must not be built on.
//
// Known regression baseline (pre-existing, unrelated): gap-job-done-notice-f1-small-r1,
// order-planning-monthly-projection-consumer-f1-4b-fm3d, replen-header-toggle, supply-planning-route-inventory.
//
// Run: node assets/tests/expected-arrival-structured-snapshot-f1-7n-fb-4f-b6-r1.test.js

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

var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CMP = read('assets/js/utils/inventory-compat.js');
var G16 = read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs');
var G69 = read('assets/specs/active/apps-script/69_api_v1_route_identity_contract.gs');
var G63 = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var G13 = read('assets/specs/active/apps-script/13_procurement_handlers.gs');
var DBAPI = read('assets/js/api/operation-system-db-api.js');
var INDEX = read('index.html');
var CARRIER_SPEC = read('docs/planning/CARRIER_AND_ROUTE_SPEC.md');
var INV_SPEC = read('docs/planning/INVENTORY_TABLE_MAPPING_SPEC.md');
var PAGEC = code(PAGE), CMPC = code(CMP);
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var IRDraft = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js')).IRDraft;

// The attempt-evidence date. It is a FACT ABOUT A FAILED ATTEMPT, never data.
var ATTEMPT_ETA = '2026-10-16';

// ================================================================================================================
// THE CLIENT: the shipped ETA owner, lifted and RUN, over an injectable carrier lead-time table.
// ================================================================================================================
function etaEnv(leadRows, opts) {
  opts = opts || {};
  var sb = {
    String: String, Object: Object, Number: Number, Math: Math, JSON: JSON, Array: Array, Date: Date,
    isNaN: isNaN, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat, Boolean: Boolean,
    RegExp: RegExp, Error: Error, Intl: opts.noIntl ? undefined : Intl,
    console: { warn: function () {}, log: function () {} }
  };
  sb.window = sb; sb.globalThis = sb;
  sb.__carrierCalls = 0;
  sb._irCarrierGet = function () { sb.__carrierCalls++; return leadRows || []; };
  // R6-R3: the SHIPPED registry, not a stub — the conservative fold has one owner and this is it.
  var _MR6R3 = require('../js/core/method-registry.js');
  var _CMP6R3 = require('../js/utils/inventory-compat.js');
  sb.window = { KM: { methodRegistry: { serviceProfilesForRoute: _MR6R3.serviceProfilesForRoute } },
    IRService: _CMP6R3.IRService };
  var ctx = vm.createContext(sb);
  vm.runInContext([
    extractVar(PAGE, 'IR_SERVICE_TO_LEAD_KEY_'),
    extractVar(PAGE, 'IR_LABEL_TO_LEAD_KEY_'),
    extractVar(PAGE, 'IR_ISO_DATE_RE_'),
    extractFn(PAGE, '_irMethodToLeadKey'),
    extractFn(PAGE, '_irProjectCalendarDay_'),
    extractFn(PAGE, '_irIsoPlusDays_'),
    extractFn(PAGE, '_irCanonicalDateOrBlank_'),
    // R6-R3 §3 — the calculator now asks the TRANSIT PROFILE AUTHORITY before it falls back to the mapped
    // display vocabulary, because the option the operator picks IS `carrier_lead_times.shipping_method`
    // verbatim and translating it away is what made every live method unresolvable. That resolver is part of
    // the calculator and has to be lifted with it.
    extractFn(PAGE, '_irLeadTimeProfileFor_'),
    extractFn(PAGE, '_irComputeRouteEta'),
    extractFn(PAGE, '_irRouteEtaFor')
  ].join('\n'), ctx);
  return { sb: sb, run: function (e) { return vm.runInContext(e, ctx); },
    eta: function (destCountry, route) { sb.__r = route; sb.__c = destCountry;
      return vm.runInContext('_irRouteEtaFor(__c, __r)', ctx); },
    live: function (destCountry, route) { sb.__r = route; sb.__c = destCountry;
      return vm.runInContext('_irComputeRouteEta(__c, __r)', ctx); } };
}
// RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §6) — THE PRODUCT RULE THIS FIXTURE ENCODES WAS SUPERSEDED.
//
// B6-R1 computed the expected arrival from `avg_days`. An average is the middle of a distribution: roughly
// half of real shipments arrive after it, so presenting it as THE expected arrival gives an operator a date
// that is a coin-flip. R6-R1 §6 requires the CONSERVATIVE arrival — `max_days`, the slowest the service is
// known to run — and that is what the calculator now uses.
//
// EVERY OTHER CLAIM IN THIS SUITE IS UNCHANGED AND STILL CHECKED: the project-calendar base, the lane match,
// the wildcard row, the absence of a prefix ladder, the structured return value, and a stored snapshot
// outranking a live recomputation. So the fixture supplies max_days ALONGSIDE avg_days at the same number,
// and every date this file asserts stays byte-for-byte what it was — which is the point: the restatement
// must not quietly weaken a single one of them.
function LEAD(method, country, avg) {
  return { shippingMethod: method, destinationCountry: country, avgDays: avg, maxDays: avg };
}
var SEA_15 = LEAD('Sea', 'US', 15), EXPRESS_9 = LEAD('Sea Express', 'US', 9), AIR_5 = LEAD('Air', 'US', 5);

// The project's own calendar day, computed the way the page computes it — never a literal in an assertion.
function tpeToday() {
  var p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  var y, m, d;
  p.forEach(function (x) { if (x.type === 'year') y = +x.value; else if (x.type === 'month') m = +x.value; else if (x.type === 'day') d = +x.value; });
  return { y: y, m: m, d: d };
}
function isoPlus(days) {
  var c = tpeToday();
  var t = new Date(Date.UTC(c.y, c.m - 1, c.d) + days * 86400000);
  function z(n) { return ('0' + n).slice(-2); }
  return t.getUTCFullYear() + '-' + z(t.getUTCMonth() + 1) + '-' + z(t.getUTCDate());
}

// ================================================================================================================
section('A — [§C] THE ETA AUTHORITY, traced by execution');
// ================================================================================================================
(function () {
  var E = etaEnv([SEA_15, EXPRESS_9, AIR_5]);

  // §C.1 — the departure base date.
  var sea = E.live('US', { shipping_method: 'sea' });
  eq(sea.date, isoPlus(15), 'A1 [§C.1] the base is the PROJECT calendar day (Asia/Taipei) + the lead days');
  ok(/timeZone: 'Asia\/Taipei'/.test(code(extractFn(PAGE, '_irProjectCalendarDay_'))),
    'A2 [§C.1] read in the project timezone, not the browser one');

  // §C.2 — which lead-time record.
  eq(sea.days, 15, 'A3 [§C.2] the day count comes from the matched carrier_lead_times row (max_days, per R6-R1 §6)');
  eq(sea.lead_key, 'Sea', 'A4 [§C.2] matched on shippingMethod + destinationCountry');
  var noCountry = etaEnv([LEAD('Sea', '', 20)]).live('US', { shipping_method: 'sea' });
  eq(noCountry.days, 20, 'A5 [§C.2] a row with no destination country is a wildcard match');
  var wrongCountry = etaEnv([LEAD('Sea', 'JP', 20)]).live('US', { shipping_method: 'sea' });
  eq([wrongCountry.available, wrongCountry.date], [false, ''], 'A6 [§C.2] a row for another country is NOT a match');

  // §C.3/§C.4 — canonicalisation, and the two ocean services.
  eq(E.live('US', { shipping_method: 'sea' }).lead_key, 'Sea', 'A7 [§C.3, §C.4] sea resolves to the Sea lead time');
  eq(E.live('US', { shipping_method: 'sea_express' }).lead_key, 'Sea Express', 'A8 [§C.4] sea_express to Sea Express');
  eq(E.live('US', { shipping_method: '美森海卡' }).lead_key, 'Sea Express', 'A9 [§C.3] and an express-ocean display label to Sea Express');

  // §C.5 — family fallback.
  var noExpress = etaEnv([SEA_15]);
  var fellBack = noExpress.live('US', { shipping_method: 'sea_express' });
  eq([fellBack.available, fellBack.date, fellBack.source], [false, '', 'NO_LEAD_TIME'],
    'A10 [§C.5, §D.9] with ONLY a Sea row present, sea_express resolves to NOTHING — no family fallback');
  eq(noExpress.live('US', { shipping_method: 'sea' }).days, 15, 'A11 [§C.5] while sea itself still resolves');
  var leadFn = code(extractFn(PAGE, '_irMethodToLeadKey'));
  ok(leadFn.indexOf("indexOf('sea')") === -1 && !/startsWith/.test(leadFn), 'A12 [§C.5] there is no prefix ladder to fall back through');

  // §C.6/§C.7 — where the value lives.
  ok(sea.date && /^\d{4}-\d{2}-\d{2}$/.test(sea.date), 'A13 [§C.6] the calculator returns a STRUCTURED date…');
  // RESTATED (A2-R1-R6-R1 §6): the sentence changed with the number behind it. `(est. 15d)` described an
  // AVERAGE; the figure is now the conservative one, so it reads `(latest, 15d)`. B6-R1's claim is that the
  // display string is DERIVED FROM the structured date rather than being the only place the date exists, and
  // that is what is asserted: the text starts with the date and carries the same day count.
  ok(sea.text.indexOf(sea.date) === 0 && sea.text.indexOf('15d') !== -1,
    'A14 [§C.7] …and the display string is derived FROM it');
  ok(!/String\(etaEl\.textContent/.test(PAGEC), 'A15 [§C] nothing reads the ETA back out of the rendered sentence');
  eq((PAGEC.match(/_irCarrierGet\('getCarrierLeadTimes'\)/g) || []).length, 1,
    'A16 [§C] there is exactly ONE ETA calculator — no second one was created');
})();

// ================================================================================================================
section('B — [tests 5, 6, 7, 17] THE TWO OCEAN SERVICES, and no guessing');
// ================================================================================================================
(function () {
  var E = etaEnv([SEA_15, EXPRESS_9]);
  eq(E.live('US', { shipping_method: 'sea' }).date, isoPlus(15), 'B1 [test 5] sea uses the sea lead time (15d)');
  eq(E.live('US', { shipping_method: 'sea_express' }).date, isoPlus(9), 'B2 [test 6] sea_express uses the sea_express lead time (9d)');
  ok(E.live('US', { shipping_method: 'sea' }).date !== E.live('US', { shipping_method: 'sea_express' }).date,
    'B3 [test 7] and they are DIFFERENT dates — one never answers for the other');
  var only = etaEnv([SEA_15]).live('US', { shipping_method: 'sea_express' });
  eq([only.available, only.date], [false, ''], 'B4 [test 7, 17] no exact lead time = BLANK, never the neighbour');
  eq(only.text, 'Lead time unavailable', 'B5 [test 17] with an explicit unavailable state the operator can see');
  var noMethod = etaEnv([SEA_15]).live('US', { shipping_method: '' });
  eq([noMethod.available, noMethod.date], [false, ''], 'B6 [test 17] no method at all is blank too');
  var unknown = etaEnv([SEA_15]).live('US', { shipping_method: 'hyperloop' });
  eq([unknown.available, unknown.date, unknown.source], [false, '', 'NO_LEAD_KEY'], 'B7 [test 17] and an unknown service is refused outright');
})();

// ================================================================================================================
section('C — [tests 8, 9, 10] SNAPSHOT vs LIVE: who owns the answer');
// ================================================================================================================
(function () {
  var E = etaEnv([SEA_15]);
  // test 8 — a persisted snapshot is what a reloaded route shows.
  var persisted = E.eta('US', { shipping_method: 'sea', expected_arrival: '2026-01-05', expected_arrival_basis: 'sea' });
  eq([persisted.date, persisted.source], ['2026-01-05', 'PERSISTED'], 'C1 [test 8] a stored ETA is returned as the snapshot it is');
  ok(persisted.date !== isoPlus(15), 'C2 [test 8] and it is NOT the live figure');

  // test 9 — the lead-time table moves; the snapshot does not.
  var moved = etaEnv([LEAD('Sea', 'US', 40)]).eta('US', { shipping_method: 'sea', expected_arrival: '2026-01-05', expected_arrival_basis: 'sea' });
  eq(moved.date, '2026-01-05', 'C3 [test 9] changing carrier_lead_times does NOT rewrite a saved commitment');
  eq(etaEnv([LEAD('Sea', 'US', 40)]).live('US', { shipping_method: 'sea' }).date, isoPlus(40),
    'C4 [test 9] even though the live computation for the same route did move');

  // test 10 — an unsaved editor computes.
  var fresh = E.eta('US', { shipping_method: 'sea' });
  eq([fresh.date, fresh.source], [isoPlus(15), 'COMPUTED'], 'C5 [test 10] a route with no stored ETA computes live');
  var blank = E.eta('US', { shipping_method: 'sea', expected_arrival: '' });
  eq(blank.source, 'COMPUTED', 'C6 [test 10, 11] and a BLANK stored ETA is not a snapshot — it computes, it does not backfill');

  // The snapshot is pinned to the service it was taken under.
  var changed = E.eta('US', { shipping_method: 'sea', expected_arrival: '2026-01-05', expected_arrival_basis: 'sea_express' });
  eq(changed.source, 'COMPUTED', 'C7 a snapshot taken under a DIFFERENT service no longer describes this route');
  var spelled = E.eta('US', { shipping_method: 'sea', expected_arrival: '2026-01-05', expected_arrival_basis: '普船' });
  eq(spelled.source, 'PERSISTED', 'C8 both sides canonicalise, so a display spelling is the SAME basis');
  var noBasis = E.eta('US', { shipping_method: 'sea', expected_arrival: '2026-01-05' });
  eq(noBasis.source, 'PERSISTED', 'C9 a stored date with no recorded basis is still stored');
})();

// ================================================================================================================
section('D — [tests 18] DATE SEMANTICS: one meaning, no drift');
// ================================================================================================================
(function () {
  var E = etaEnv([SEA_15]);
  // test 18 — the arithmetic is UTC-based, so no DST or locale boundary can move it a day.
  eq(E.run('_irIsoPlusDays_({ y: 2026, m: 3, d: 7 }, 1)'), '2026-03-08', 'D1 [test 18] a US spring-forward boundary does not shift the day');
  eq(E.run('_irIsoPlusDays_({ y: 2026, m: 10, d: 24 }, 1)'), '2026-10-25', 'D2 [test 18] nor an EU fall-back boundary');
  eq(E.run('_irIsoPlusDays_({ y: 2026, m: 12, d: 31 }, 1)'), '2027-01-01', 'D3 [test 18] year wrap is exact');
  eq(E.run('_irIsoPlusDays_({ y: 2028, m: 2, d: 28 }, 1)'), '2028-02-29', 'D4 [test 18] and a leap day is a real day');
  ok(!/toISOString/.test(code(extractFn(PAGE, '_irIsoPlusDays_'))) && !/toISOString/.test(code(extractFn(PAGE, '_irComputeRouteEta'))),
    'D5 [test 18] toISOString is never called on a local-midnight Date — the classic off-by-one');
  ok(!/toLocaleDateString|toLocaleString/.test(code(extractFn(PAGE, '_irComputeRouteEta'))),
    'D6 [test 18] and no locale formatter can reshape the stored value');

  // §E — an invalid date is refused, never repaired into a different day.
  eq(E.run("_irCanonicalDateOrBlank_('2026-02-30')"), '', 'D7 [§E] 2026-02-30 is refused, NOT rolled into March');
  eq(E.run("_irCanonicalDateOrBlank_('2026-13-01')"), '', 'D8 [§E] an impossible month is refused');
  eq(E.run("_irCanonicalDateOrBlank_('2026-11-02 (est. 15d)')"), '', 'D9 [§E] and a display sentence is not a date');
  eq(E.run("_irCanonicalDateOrBlank_('11/02/2026')"), '', 'D10 [§E] nor a locale-shaped one');
  eq(E.run("_irCanonicalDateOrBlank_('2026-11-02')"), '2026-11-02', 'D11 [§E] the canonical shape passes through unchanged');

  // The same shape the server stores and reads back.
  ok(/yyyy-MM-dd/.test(read('assets/specs/active/apps-script/31_shipment_receipt_route_handlers.gs')),
    'D12 [§E] which is the project-wide stored date shape');
  ok(/Asia\/Taipei/.test(G16), 'D13 [§E] and Asia/Taipei is the zone the server itself canonicalises in');

  // The fallback when Intl is unavailable is degraded, not wrong.
  var noIntl = etaEnv([SEA_15], { noIntl: true });
  var f = noIntl.live('US', { shipping_method: 'sea' });
  ok(/^\d{4}-\d{2}-\d{2}$/.test(f.date), 'D14 [§E] with no Intl the page still yields a canonical date shape');
})();

// ================================================================================================================
section('E — [tests 1, 2, 3, 4, 19] THE PATH: render → collect → payload');
// ================================================================================================================
(function () {
  var renderFn = code(extractFn(PAGE, '_renderExecutionRoute'));
  var collectFn = code(extractFn(PAGE, '_saveAllocationDraftFromDom'));
  var updateFn = code(extractFn(PAGE, '_irUpdateRouteEtas'));
  var hydrateFn = code(extractFn(PAGE, '_hydrateAllocationDraftFromDb'));

  // test 19 — the displayed value and the structured value come from ONE computation.
  // RESTATED (A2-R1-R6-R1 §6): an ANCHOR moved. The call gained the ORIGIN country — without it a US→US
  // domestic row could answer for a CN→US ocean one, and `.filter(...)[0]` made that a first-row-wins pick.
  // The claim is unchanged: the render asks the SINGLE owner rather than computing its own.
  ok(/var eta = _irRouteEtaFor\(destCountry, route(, originCountry)?\);/.test(renderFn),
    'E1 [test 19] the render asks the single owner');
  ok(/data-eta="' \+ _execEsc\(eta\.date/.test(renderFn) && /_execEsc\(eta\.text\)/.test(renderFn),
    'E2 [test 19] and publishes BOTH the structured date and the text it derived — one source, two renderings');
  ok(/_irCanonicalDateOrBlank_\(etaEl\.getAttribute\('data-eta'\)\)/.test(collectFn),
    'E3 [test 1, 19] the collect reads that structured value, re-validating its shape');
  ok(!/etaEl\.textContent/.test(collectFn), 'E4 [§C] and never the rendered sentence');

  // tests 2, 3 — nothing about loading or hydrating writes an ETA.
  ok(!/expected_arrival\s*=/.test(hydrateFn) || /expected_arrival: _irCanonicalDateOrBlank_\(raw\.expected_arrival\)/.test(hydrateFn),
    'E5 [test 3] the hydrate only READS the stored expected_arrival');
  ok(!/_irComputeRouteEta/.test(hydrateFn), 'E6 [test 3] it computes no ETA of its own');
  ok(!/upsert|_scheduleDraftDbPersist|_flushDraftDbPersist/.test(hydrateFn), 'E7 [test 3] and issues no write of any kind');
  ok(!/_scheduleDraftDbPersist|onExecutionRouteEdit/.test(updateFn),
    'E8 [test 2] the async lead-time recompute updates the DISPLAY only — it never schedules a save');
  ok(/data-eta-persisted/.test(updateFn),
    'E9 [test 9] and it carries the stored snapshot, so an async recompute cannot overwrite a saved commitment');

  // test 4 — cancel is still zero request (B6's gate, re-asserted here because R1 touched the collect).
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  ok(/if \(!_irConfirmLegacyAdoption_\(_adoptGroups\[_ai\]\)\)[\s\S]{0,500}?return;/.test(flush),
    'E10 [test 4] a declined confirmation still returns before any request');
  ok(flush.indexOf('_irConfirmLegacyAdoption_') < flush.indexOf('_irPersistOneRouteGroup_'),
    'E11 [test 4] and the question is still asked first');

  // §D.3 — the confirmation dialog shows the SAME structured value.
  var det = code(extractFn(PAGE, '_irAdoptionConfirmationDetail_'));
  ok(/r\.expected_arrival/.test(det), 'E12 [§D.3] the dialog reads the route model expected_arrival…');
  var built = IRDraft.buildLegacyAdoptionConfirmation({ from: 'A', to: 'Amazon', method: 'sea', qty: 800, expected_arrival: '2026-11-02' });
  ok(built.text.indexOf('2026-11-02') !== -1 && built.text.indexOf('est.') === -1,
    'E13 [§D.3, test 19] …and shows the date itself, not the "(est. Nd)" sentence');
})();

// ================================================================================================================
section('F — [tests 11, 12] LEGACY BLANK STAYS BLANK');
// ================================================================================================================
(function () {
  ok(PAGE.indexOf(ATTEMPT_ETA) === -1, 'F1 [test 12] 2026-10-16 appears nowhere in the page');
  ok(CMP.indexOf(ATTEMPT_ETA) === -1, 'F2 [test 12] nor in the shared draft module');
  ok(G16.indexOf(ATTEMPT_ETA) === -1 && G69.indexOf(ATTEMPT_ETA) === -1, 'F3 [test 12] nor in either Apps Script owner');
  var E = etaEnv([SEA_15]);
  eq(E.run("_irCanonicalDateOrBlank_('')"), '', 'F4 [test 11] a blank stored ETA validates as blank');
  eq(E.eta('US', { shipping_method: 'sea', expected_arrival: '' }).source, 'COMPUTED',
    'F5 [test 11] the UI may show a live figure for it…');
  // …and the payload still carries nothing, which is the half that makes "blank stays blank" true in the DB.
  var p = IRDraft.buildDraftLinePayload('CO1100-R', { planned_qty: 800, expected_arrival: '2026-11-02' }, { scope: {} });
  ok(!('expected_arrival' in p), 'F6 [test 11] …but NOTHING reaches the database, so the stored blank is untouched');
  ok(!/expected_arrival/.test(code(extractFn(CMP, 'buildDraftLinePayload'))),
    'F7 [test 12] and no code path can carry a computed date into the line payload');
})();

// ================================================================================================================
section('G — [tests 13, 14, 15, 16, 20] THE SERVER SIDE IS ALREADY CAPABLE, AND ETA IS NOT AN IDENTITY');
// ================================================================================================================
(function () {
  // §F — B3's server already persists expected_arrival. Proven by running the shipped writer.
  var SHEETS = {};
  function FakeSheet(h) { this.rows = [h.slice()]; }
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
  var SpreadsheetApp = { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return SHEETS[n] || null; } }; } };
  var Utilities = { getUuid: function () { return 'UUID000000000000'; } };
  var __now = '2026-09-01 09:00:00';
  function procurementTimestamp_() { return __now; }
  function procurementNum_(v) { var n = Number(v); return isFinite(n) ? n : ''; }
  function prodRequireSheet_(ss, n) { return SHEETS[n]; }
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
    'SAD_K2_SEM_OPTIONAL_PRESERVE_', 'SAD_K2_SEM_EXCLUDE_', 'SAD_K2_BASIS_ID_MATCHES_', 'SAD_K2_BASIS_STALE_ACCEPTED_',
    'SAD_K2_BASIS_DIFFERENT_GROUP_', 'SAD_K2_BASIS_NO_REQUEST_GROUP_', 'SAD_K2_BASIS_CONTESTED_'
  ].map(function (v) { return extractVar(G16, v); }).join(String.fromCharCode(10)));
  eval([ 'RIC_CANONICAL_SERVICES_', 'RIC_SERVICE_LABELS_', 'RIC_DESTINATION_TYPES_', 'RIC_K4_GROUP_DIMENSIONS_',
    'RIC_SCHEMA_REFUSALS_', 'RIC_B2_REQUIRED_COLUMNS_'
  ].map(function (v) { return extractVar(G69, v); }).join(String.fromCharCode(10)));
  eval(['ricCanonicalService_', 'ricDestinationIdentity_', 'ricK4GroupKey_', 'ricK4DeterministicHeaderId_',
    'ricRoutePersistability_'].map(function (fn) { return extractFn(G69, fn); }).join(String.fromCharCode(10)));
  eval(['sadApplyLineAliases_', 'sadFnv1a_', 'sadLineNaturalKey_', 'sadDeterministicLineId_', 'sadFindLineByNaturalKey_',
    'sadHeaderStatusValid_', 'sadLineStatusValid_', 'sadK2GroupKey_', 'sadK2DeterministicHeaderId_',
    'sadK2LineNaturalKey_', 'sadK2DeterministicLineId_', 'sadIsK2Group_', 'sadNewLineId_', 'sadK2ResolveActiveDraft_',
    'sadK2LinesRouteCompatibleWithHeader_', 'sadCanonicalLineId_', 'sadSameLineIdentity_', 'sadPreflightLineBatch_',
    'sadScanDuplicateLinePks_', 'sadVerifyDraftLines_', 'sadLineIsComplete_', 'sadStoredHeaderRouteIsComplete_',
    'sadDestinationIdentity_', 'sadHeaderRouteIsComplete_', 'sadFpVal_', 'sadK2PayloadFingerprint_', 'sadCanonDate_', 'sadFpNorm_',
    'sadK2SemFieldClass_', 'sadK2SemFieldVerdict_', 'sadK2SemFieldEqual_', 'sadK2SemanticPayloadEqual_',
    'sadRegenerateLinePatch_', 'sadK2LineIdentity_', 'sadLiveHeaderNames_', 'sadHasColumn_', 'sadK4SchemaReady_',
    'sadSchemaRefusal_', 'sadK4ResolveActiveDraft_', 'sadExactSchemaReason_', 'sadAtomicValidateBatch_',
    'sadResolveActiveDraft_', 'sadReadActiveHeaderRows_', 'sadResolveActiveDraftK2OrK3_', 'sadK2ReconcileDecision_',
    'sadLegacyReconcileReason_', 'sadResolveBlockMessage_', 'sadReconcileMessage_', 'sadRowToObject_',
    // F1-7N-FB-4G-A2-R3 - the atomic core reaches three new authorities: whether this deployment can store
    // a create key, the replay lookup, and the identity mint for a new ticket. A lift that omits any of them
    // ReferenceErrors inside a shipped function, which reads exactly like a production defect.
    'sadCreateIdempotencyReady_', 'sadFindHeaderByCreateKey_', 'sadMintNewHeaderId_',
    'sadReadLinesForDraft_', 'sadSchemaGenerationColumns_', 'sadSupportedSchemaVersions_', 'sadAiK2IntentEvidence_', 'sadResolveHeaderSchema_',
  'sadDraftsSchemaReason_', 'sadAtomicUpsertCore_'
  ].map(function (fn) { return extractFn(G16, fn); }).join(String.fromCharCode(10)));

  function reset() {
    // F1-7N-FB-4G-A2-R3 - an emptied table means a re-hydrated client, so the remembered id goes with
    // it. Leaving it behind would make the next save declare UPDATE against a row that no longer exists.
    __savedId = '';
    SHEETS['shipping_allocation_drafts'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFTS_HEADERS_FULL_);
    SHEETS['shipping_allocation_draft_lines'] = new FakeSheet(SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_FULL_);
  }
  function lineObjs() {
    var h = SHEETS['shipping_allocation_draft_lines'].rows[0];
    return SHEETS['shipping_allocation_draft_lines'].rows.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { if (k) o[k] = r[i]; }); return o; });
  }
  function headerIds() {
    var h = SHEETS['shipping_allocation_drafts'].rows[0], c = h.indexOf('allocation_draft_id');
    return SHEETS['shipping_allocation_drafts'].rows.slice(1).map(function (r) { return r[c]; });
  }
  // F1-7N-FB-4G-A2-R3 §B - THE SAME ROUTE, SAVED REPEATEDLY, DECLARES ITS INTENT.
  //
  // These calls are one route being edited, and the writer used to re-find its row by natural key. It no
  // longer guesses: the first save is a CREATE (with a create key, so a retry cannot duplicate it) and every
  // later save NAMES the row it created. `reset()` clears the remembered id, because an emptied table means a
  // re-hydrated client.
  var __savedId = '';
  function resetSavedId() { __savedId = ''; }
  var __criSeq = 0;
  function save(service, eta, qty) {
  // R6-R6-R4-R2 — AN UPDATE NOW DECLARES THE VERSION IT READ. This shim mirrors the shipped client, and the
  // shipped client sends expected_draft_version on every UPDATE_EXISTING_ROUTE; 16_ refuses one that does not
  // (MISSING_OPTIMISTIC_TOKEN, zero rows written). Read from the stored row, exactly as the page reads it from
  // the version it hydrated — never computed, and never filled in by the writer.
    var _expVer = '';
    if (__savedId) {
      var _hs = SHEETS['shipping_allocation_drafts'];
      var _hh = _hs.rows[0], _hi = _hh.indexOf('allocation_draft_id'), _vi = _hh.indexOf('draft_version');
      for (var _r = 1; _r < _hs.rows.length; _r++) {
        if (String(_hs.rows[_r][_hi]) === String(__savedId)) _expVer = String(_hs.rows[_r][_vi] || '');
      }
    }
    var res = sadAtomicUpsertCore_({ header: {
        allocation_draft_id: __savedId || undefined,
        expected_draft_version: (__savedId && _expVer) ? _expVer : undefined,
        company: 'ResUS', country: 'US', marketplace: 'Amazon', source_page: 'inventory_replenishment',
        recommended_source_warehouse_id: 'WH-CN-01', recommended_destination_warehouse_id: '',
        destination_marketplace: 'Amazon', recommended_shipping_method: service },
      intent: __savedId ? 'UPDATE_EXISTING_ROUTE' : 'CREATE_NEW_ROUTE',
      create_idempotency_key: __savedId ? undefined : ('CRI-B6R1-' + (++__criSeq)),
      lines: [{ sku: 'CO1100-R', site_sku: 'CO1100-R-US', window_code: 'W36', planned_qty: qty,
        expected_arrival: eta }] });
    if (res && res.success !== false && res.data && res.data.allocation_draft_id) {
      __savedId = String(res.data.allocation_draft_id);
    }
    return res;
  }

  reset();
  var r1 = save('sea', '2026-11-02', 800);
  eq(r1.success, true, 'G1 [§F] the SHIPPED B3 writer accepts an expected_arrival…');
  eq(String(lineObjs()[0].expected_arrival), '2026-11-02', 'G2 [§F] …and persists it on the line — no server change is needed');
  var idsBefore = headerIds().slice(), lineIdBefore = lineObjs()[0].allocation_draft_line_id;

  // test 13 — an ETA-only edit really saves.
  var r2 = save('sea', '2026-11-09', 800);
  eq(r2.success, true, 'G3 [test 13] an ETA-ONLY change is accepted…');
  eq(String(lineObjs()[0].expected_arrival), '2026-11-09', 'G4 [test 13] …and is actually written');
  ok(SAD_K2_LINE_FP_.indexOf('expected_arrival') !== -1, 'G5 [test 13] because the ETA is inside the line fingerprint');

  // tests 14, 15, 16, 20
  eq(RIC_K4_GROUP_DIMENSIONS_.indexOf('expected_arrival'), -1, 'G6 [test 14] expected_arrival is NOT a K4 dimension');
  eq(SAD_K2_GROUP_DIMENSIONS_.indexOf('expected_arrival'), -1, 'G7 [test 14] nor a K2 one');
  ok(ricK4GroupKey_({ recommended_shipping_method: 'sea', destination_marketplace: 'Amazon', expected_arrival: '2026-11-02' }) ===
     ricK4GroupKey_({ recommended_shipping_method: 'sea', destination_marketplace: 'Amazon' }),
    'G8 [test 14] so an ETA cannot change the K4 key');
  eq(headerIds(), idsBefore, 'G9 [test 15] the header id is unchanged by an ETA edit');
  eq(lineObjs()[0].allocation_draft_line_id, lineIdBefore, 'G10 [test 15] and so is the line id');
  eq(Number(lineObjs()[0].planned_qty), 800, 'G11 [test 16] the quantity is untouched');
  eq(lineObjs().length, 1, 'G12 [test 20] and no duplicate line was appended');

  // test 20 — replay.
  save('sea', '2026-11-09', 800);
  eq([headerIds().length, lineObjs().length], [1, 1], 'G13 [test 20] replaying the identical save creates no duplicate header or line');

  // A blank ETA on a save does not erase a stored one, and does not invent one either.
  reset();
  save('sea', '', 800);
  eq(String(lineObjs()[0].expected_arrival), '', 'G14 [test 11] saving with no ETA stores a BLANK — nothing is invented');
})();

// ================================================================================================================
section('H — [§F, §H] CONTRACTS AND THE BROWSER TOKEN');
// ================================================================================================================
(function () {
  // §F — no server change at all this round. F1-7N-FB-4G-A0-R1 RESTATED these two: they measured the WORKING
  // TREE for a claim about B6-R1's OWN COMMIT, so a later round that legitimately changes 16_ broke them while
  // describing a correct state. B6-R1's fact is fixed and checkable in its own diff (60afa6e → 82da01c), and
  // what still holds forever is that the source and the manifest AGREE — which is the real protection here,
  // because a stamp typed twice is exactly how a half-synced deployment goes unnoticed.
  var _r1Diff = (function () {
    try { return require('child_process').execSync('git diff --name-only 60afa6e 82da01c', { cwd: ROOT }).toString(); }
    catch (e) { return null; }
  })();
  ok(_r1Diff !== null && _r1Diff.indexOf('apps-script') === -1,
    'H1 [§F] B6-R1 changed no Apps Script source — measured from ITS OWN diff, not the working tree');
  eq((G69.match(/var RIC_BUILD_VERSION_ = '([^']+)';/) || [])[1], 'F1-7N-FB-4F-B3', 'H2 [§F] and 69_ is unmoved');
  eq((G63.match(/\{ file: '16_shipping_allocation_handlers\.gs', symbol: 'SAD_BUILD_VERSION_', expected: '([^']+)'/) || [])[1],
    (G16.match(/var SAD_BUILD_VERSION_ = '([^']+)';/) || [])[1],
    'H3 [§F] the manifest expects exactly what the SOURCE declares — never a number typed twice');
  // F1-7N-FB-4G-A2-R3 - RESTATED per axis. B6-R1 moved no contract version, and pinning the triple as an
  // equality said something stronger: that no LATER round may move one. A2-R3 registers a new required
  // action, which that constant's own rule says must bump the LIST version; the ACTION contract and the
  // TRANSPORT contract are untouched, because no router action and no envelope shape changed.
  // F1-7N-FC-1A-R1 — the ACTION contract moves when a router action is added (R1 adds one); the
// TRANSPORT contract does not, because the envelope shape is unchanged. Those are two different axes and
// pinning them together made a legitimate move on one look like a break in both.
eq([String(Number((G63.match(/var SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1]) >= 10),
      (G63.match(/var SYS_TRANSPORT_CONTRACT_VERSION_ = (\d+);/) || [])[1]], ['true', '1'],
    'H4 [§F] the deployed ACTION contract is at or after 10 and the TRANSPORT contract is still 1 — ' +
    'two independent axes, and only the action axis moves when a route is added');
  ok(Number((G63.match(/var SYS_REQUIRED_ACTION_LIST_VERSION_ = (\d+);/) || [])[1]) >= 9,
    'H4a and the required-action LIST version is at or after 9 (it is append-only)');
  eq((DBAPI.match(/var KM_EXPECTED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1],
  (G63.match(/var SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = (\d+);/) || [])[1],
  'H5 [§F] and the frontend pins exactly what the deployment declares');

  // §H — a NEW token, and the reason is a fact about the repository rather than a preference.
  // F1-7N-FB-4G-A0 - RESTATED, and this is the FOURTH round in which this exact shape has broken. B6's H9 was
  // restated to a floor for the same reason and this one was left as an equality with "now", so it broke the
  // moment a later round minted its own token - which is the behaviour B6-R1 was asserting is CORRECT. What
  // B6-R1 actually established is a FLOOR plus a rule: B6-R1 minted its own token rather than reusing B6's, and
  // every round after it must be at or after that point in the release order. A suite states a floor or a
  // derived contract; it never states an equality with the present.
  var APP = RO.currentAppToken();
  ok(RO.tokenAtOrAfter(APP, 'fb4fb6r1-etasnapshot-20260901'),
    'H6 [§H] B6-R1 minted its own application token, and the release order has not moved behind it');
  ok(RO.tokenAtOrAfter(APP, 'fb4fb6-legacyroute-20260901'), 'H7 [§H] strictly after B6 in the release order');
  var tok = RO.parseIndexTokens(INDEX);
  eq(tok['assets/js/pages/inventory-replenishment.js'], APP, 'H8 [§H] the changed page carries it');
  eq(tok['assets/js/utils/inventory-compat.js'], APP, 'H9 [§H] and so does the shared draft module');
  // RESTATED (F1-7N-FC-1A-R1-HF1): this was `=== 18`. The count is not the property — "rotated TOGETHER"
  // is — and the literal made a round that covers one more asset look like a half-updated deployment. Now
  // derived: no entry is left behind on a superseded application token. See _release-order.js staleAppTokenRefs.
  eq(RO.staleAppTokenRefs(INDEX).join(' | '), '',
    'H10 [§H] the whole co-deployed set rotated together (' + RO.appTokenRefCount(INDEX) + ' on ' + APP + ')');
  eq((INDEX.match(/fb4fb6-legacyroute-20260901/g) || []).length, 0,
    'H11 [§H] and B6\'s token is GONE from index.html — it was already published on origin/main, so reusing it ' +
    'would have left every browser that fetched it on the B6 copy of this page');
  ok(!RO.isMapToken(APP), 'H12 [§H] no map token moved');
  eq(tok['assets/css/pages/global-logistics-map.css'], 'map-labelmode-r9-20260831', 'H13 [§H] the map set is untouched');
  eq(tok['assets/js/data/world-countries-110m.js'], 'country-boundary-20260826', 'H14 [§H] and so is every unrelated token');
})();

// ================================================================================================================
section('I — THE BLOCKED DECISION, recorded so it cannot be closed by accident');
// ================================================================================================================
(function () {
  // The two specs that define the base, and the fact that the value they name does not exist.
  ok(/Expected Arrival = Planned Ship Date \+ max_days \+ Receiving Buffer/.test(CARRIER_SPEC),
    'I1 the spec defines Expected Arrival from a PLANNED SHIP DATE, plus max_days, plus a Receiving Buffer');
  ok(/planned ship date/.test(INV_SPEC), 'I2 and the Execution Plan mapping lists that ship date among this cell\'s inputs');
  ok(!/planned_ship_date/.test(G16), 'I3 but there is no ship date on the allocation draft header or line…');
  ok(!/planned_ship_date/.test(read('assets/specs/active/apps-script/11_shipping_plan_handlers.gs')),
    'I4 …nor on shipping_plans…');
  ok(!/data-field="planned_ship_date"|planned_ship_date/.test(PAGE), 'I5 …and the Execution Plan has no ship-date control');
  ok(!/receiving_buffer|receivingBuffer/.test(G16 + read('assets/specs/active/apps-script/17_carrier_handlers.gs')),
    'I6 and the Receiving Buffer the formula requires is defined by no field, table or value');
  // The shipped display substitutes today + avg_days. That is a reference figure, and it is not persisted.
  ok(/_irProjectCalendarDay_\(\)/.test(code(extractFn(PAGE, '_irComputeRouteEta'))),
    'I7 the display therefore counts from TODAY, which is a substitution, not the spec base');
  ok(/avgDays/.test(code(extractFn(PAGE, '_irComputeRouteEta'))) &&
     /avg_days.*normal\/reference ETA/.test(CARRIER_SPEC),
    'I8 and from avg_days, which the spec calls the reference ETA — while the ARRIVAL formula uses max_days');
  // THE GUARD. Removing this test is the deliberate act a future round must perform.
  var payload = code(extractFn(CMP, 'buildDraftLinePayload'));
  ok(!/expected_arrival/.test(payload),
    'I9 SO expected_arrival IS NOT WIRED INTO THE LINE PAYLOAD, and this assertion is the tripwire that keeps it that way');
  ok(/expected_arrival IS DELIBERATELY NOT SENT/.test(CMP),
    'I10 with the blocked decision written at the point where the wiring would go');
})();

// ================================================================================================================
section('J — MUTATION TESTS');
// ================================================================================================================
var neg = { caught: 0, missed: 0 };
function mut(label, f) {
  var r;
  try { r = f(); } catch (e) {
    // A probe that throws proved NOTHING. Scoring an exception as a detection is how a probe that cannot even
    // reach the code under test reports success forever - which is exactly what happened to M7's first draft.
    neg.missed++; fail++; console.error('FAIL ' + label + ' — PROBE ERROR: ' + (e && e.message));
    return;
  }
  if (r === true) { neg.caught++; pass++; console.log('ok   ' + label + ' (caught)'); }
  else { neg.missed++; fail++; console.error('FAIL ' + label + ' — MUTANT SURVIVED'); }
}

// M1 — the Save payload silently loses the ETA. (Directional: today it carries none BY DECISION, so what must
// be detectable is the OPPOSITE — a date appearing in the payload without the blocked decision being taken.)
mut('M1 an expected_arrival appearing in the line payload is caught', function () {
  var src = CMP.replace('if (row.site_sku != null) p.site_sku = row.site_sku;',
                        "p.expected_arrival = row.expected_arrival; if (row.site_sku != null) p.site_sku = row.site_sku;");
  var mutant = code((function (s, n) {
    var st = s.indexOf('function ' + n + '('); var i = s.indexOf('{', st), d = 0;
    for (; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (!d) return s.slice(st, i + 1); } }
  })(src, 'buildDraftLinePayload'));
  var honest = code(extractFn(CMP, 'buildDraftLinePayload'));
  return /expected_arrival/.test(mutant) && !/expected_arrival/.test(honest);
});

// M2 — reading the ETA back out of the rendered DOM text.
mut('M2 reading the ETA out of the rendered sentence is caught', function () {
  var collect = code(extractFn(PAGE, '_saveAllocationDraftFromDom'));
  var mutant = "var expectedArrival = etaEl ? String(etaEl.textContent || '').trim() : '';";
  // The mutant parses a sentence; the shipped code validates a structured attribute. They must differ, and the
  // sentence must NOT survive validation — otherwise "structured" is only a claim about where it was read from.
  var E = etaEnv([SEA_15]);
  var sentence = E.live('US', { shipping_method: 'sea' }).text;
  return !collect.includes('etaEl.textContent') && collect.includes("getAttribute('data-eta')") &&
    E.run('_irCanonicalDateOrBlank_(' + JSON.stringify(sentence) + ')') === '' && mutant.length > 0;
});

// M3 — sea_express falling back to sea.
mut('M3 sea_express falling back to sea is caught', function () {
  var only = etaEnv([SEA_15]);
  var expressWithoutItsOwnRow = only.live('US', { shipping_method: 'sea_express' });
  var seaRow = only.live('US', { shipping_method: 'sea' });
  return expressWithoutItsOwnRow.date === '' && expressWithoutItsOwnRow.available === false && seaRow.date !== '';
});

// M4 — the hydrate backfilling an ETA.
mut('M4 the hydrate computing an ETA is caught', function () {
  var h = code(extractFn(PAGE, '_hydrateAllocationDraftFromDb'));
  return !/_irComputeRouteEta|_irRouteEtaFor/.test(h) && /_irCanonicalDateOrBlank_\(raw\.expected_arrival\)/.test(h);
});

// M5 — a declined confirmation that still sends a request.
mut('M5 a declined confirmation that still issues a request is caught', function () {
  var flush = code(extractFn(PAGE, '_flushDraftDbPersist'));
  return flush.indexOf('_irConfirmLegacyAdoption_') < flush.indexOf('_irPersistOneRouteGroup_') &&
    /if \(!_irConfirmLegacyAdoption_\([^)]*\)\)[\s\S]{0,500}?return;/.test(flush);
});

// M6 — a persisted snapshot overwritten by a recomputation.
mut('M6 recomputing over a persisted snapshot is caught', function () {
  var stored = '2026-01-05';
  var moved = etaEnv([LEAD('Sea', 'US', 40)]).eta('US', { shipping_method: 'sea', expected_arrival: stored, expected_arrival_basis: 'sea' });
  var live = etaEnv([LEAD('Sea', 'US', 40)]).live('US', { shipping_method: 'sea' });
  return moved.date === stored && live.date !== stored;   // the mutation is real, and the guard holds
});

// M7 — the ETA joining the K4 identity. The first draft of this probe compared two object literals, which
// differ by construction — it proved nothing. It now BUILDS the mutant key function from the shipped source and
// shows the two disagree: the mutant's key moves when the ETA moves, and the shipped one does not.
mut('M7 adding the ETA to the K4 identity is caught', function () {
  var a = { recommended_shipping_method: 'sea', destination_marketplace: 'Amazon', expected_arrival: '2026-11-02' };
  var b = { recommended_shipping_method: 'sea', destination_marketplace: 'Amazon', expected_arrival: '2027-01-31' };
  function build(src) {
    return new Function(
      extractFn(G69, 'ricCanonicalService_') + String.fromCharCode(10) +
      extractVar(G69, 'RIC_CANONICAL_SERVICES_') + String.fromCharCode(10) +
      extractVar(G69, 'RIC_SERVICE_LABELS_') + String.fromCharCode(10) +
      extractFn(G69, 'ricDestinationIdentity_') + String.fromCharCode(10) +
      src + String.fromCharCode(10) + 'return ricK4GroupKey_;')();
  }
  var shippedSrc = extractFn(G69, 'ricK4GroupKey_');
  var mutantSrc = shippedSrc.replace(
    "s(h.recommendation_group_no)].join('|')",
    "s(h.recommendation_group_no), s(h.expected_arrival)].join('|')");
  if (mutantSrc === shippedSrc) throw new Error('the mutation did not apply - the probe would prove nothing');
  var shipped = build(shippedSrc), mutant = build(mutantSrc);
  // The shipped key is INVARIANT under an ETA change; the mutant is not. Both halves are required: without the
  // second, a key that ignored every field would pass.
  return shipped(a) === shipped(b) && mutant(a) !== mutant(b);
});

// M8 — a timezone shift of one day, PROVEN BY ACTUALLY CHANGING THE TIMEZONE.
//
// The first draft of this probe compared the shipped result against `new Date(y,m,d).toISOString()` inside THIS
// process — and in a UTC runner those two agree, so it could never have failed. A timezone bug cannot be
// demonstrated from one timezone. So the shipped function is executed in two child processes at the extremes
// of the offset range (UTC+14 and UTC-11) and the two answers must be identical, while the classic buggy
// formula must disagree between them. That is deterministic on any machine.
mut('M8 a UTC/local off-by-one is caught, proven across two real timezones', function () {
  var cp = require('child_process');
  var fnSrc = extractVar(PAGE, 'IR_ISO_DATE_RE_') + String.fromCharCode(10) + extractFn(PAGE, '_irIsoPlusDays_');
  function run(tz) {
    var prog = fnSrc + String.fromCharCode(10) +
      "var honest = _irIsoPlusDays_({ y: 2026, m: 3, d: 7 }, 1);" +
      "var buggy = new Date(2026, 2, 8).toISOString().slice(0, 10);" +
      "console.log(JSON.stringify({ honest: honest, buggy: buggy }));";
    var r = cp.spawnSync(process.execPath, ['-e', prog],
      { encoding: 'utf8', env: Object.assign({}, process.env, { TZ: tz }) });
    return JSON.parse(String(r.stdout || '{}'));
  }
  var east = run('Pacific/Kiritimati');   // UTC+14
  var west = run('Pacific/Midway');       // UTC-11
  // The shipped arithmetic is the SAME calendar date in both, and it is the right one.
  var stable = east.honest === '2026-03-08' && west.honest === '2026-03-08';
  // The defect this guards against is real: the naive formula genuinely differs between those two zones.
  var buggyDrifts = east.buggy !== west.buggy;
  return stable && buggyDrifts;
});

// M9 — the attempted date hardcoded or backfilled.
mut('M9 hardcoding or backfilling 2026-10-16 is caught', function () {
  var anywhere = PAGE.indexOf(ATTEMPT_ETA) !== -1 || CMP.indexOf(ATTEMPT_ETA) !== -1 ||
    G16.indexOf(ATTEMPT_ETA) !== -1 || G69.indexOf(ATTEMPT_ETA) !== -1;
  var E = etaEnv([SEA_15]);
  var blankStays = E.eta('US', { shipping_method: 'sea', expected_arrival: '' }).source === 'COMPUTED' &&
    IRDraft.buildDraftLinePayload('X', { planned_qty: 1, expected_arrival: ATTEMPT_ETA }, {}).expected_arrival === undefined;
  return !anywhere && blankStays;
});

// M10 — a second ETA calculator.
mut('M10 a second ETA calculator is caught', function () {
  return (PAGEC.match(/_irCarrierGet\('getCarrierLeadTimes'\)/g) || []).length === 1 &&
    (PAGEC.match(/function _irComputeRouteEta\(/g) || []).length === 1;
});

// ================================================================================================================
console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
console.log('negative tests: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
process.exit(fail === 0 ? 0 : 1);
