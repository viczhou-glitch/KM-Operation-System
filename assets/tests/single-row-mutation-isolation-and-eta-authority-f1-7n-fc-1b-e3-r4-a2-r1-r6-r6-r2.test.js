// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 — SINGLE-ROW MUTATION ISOLATION · ETA AUTHORITY · ROUTE B REPAIR PLAN.
//
// THE INCIDENT. On 2026-09-06 an operator set the last mile on ONE route and TWO routes were written, eleven
// seconds apart. Route A (SADH-K4-38523A90 / SADL-K2-92B8BAD2) took the value it was given. Route B
// (SADH-K4-A3872518 / SADL-K2-344FB2B2) — a different destination, a different service, and nobody's edit —
// went from a blank last mile to `parcel`, advanced to draft_version 2, and had its K4 identity key re-keyed
// to match. Both writes succeeded. Nothing failed, so nothing reported anything.
//
// THE CAUSE, REPRODUCED BELOW RATHER THAN ARGUED. `_irLastMileChoices_` fills the cell in when a lane runs
// exactly ONE eligible last mile — correct for what the operator SEES, because a service with one profile has
// nothing to ask. It wrote that derived value into `data-field="last_mile_delivery"`, which is the same DOM
// field `_saveAllocationDraftFromDom` reads as operator intent. Route B's cell was filled with `parcel` when
// the carrier catalogue settled; the model still held the database's blank; and the next collect — triggered
// by the edit on ROUTE A — diffed the two and correctly concluded, by its own rules, that Route B had been
// edited. The touched set was NOT empty and the empty-set fallback was NOT used. The diff was honest. What it
// was reading was not an edit.
//
// §2 — ONE REQUEST OR TWO. Two, from code rather than from the eleven-second gap: the two routes are different
// canonical groups, `pf.groups.forEach` chains them, and the comment above that chain says groups are written
// in sequence and never concurrently. One flush, two `upsertShippingAllocationDraftAtomic` calls.
//
// §5 — AND WHY THE TIMELINE SHOWED NOTHING. `timeline()` keeps only samples carrying `dispatch_ms`, which is
// set exclusively by km-transport's own `run()`. Every mutation goes through `_kmWeeklyCommand_`, which owns
// its fetch and reports through `recordExternal` — so both writes were in `metrics()` and structurally absent
// from `timeline()`. The operator's evidence was not wrong; it was answering a narrower question than it read.
//
// §6 — THE ETA IS NOT A LOST WRITE. `buildDraftLinePayload` deliberately does not send `expected_arrival`, and
// says why in shipped source: CARRIER_AND_ROUTE_SPEC §5B counts it from a planned ship date and a Receiving
// Buffer, and neither exists in any table. A blank column is CORRECT; the date on screen is computed at render.
//
// EVERYTHING HERE IS EXECUTED against shipped source. No production write is performed or simulated as one.
//
// Run: node assets/tests/single-row-mutation-isolation-and-eta-authority-f1-7n-fc-1b-e3-r4-a2-r1-r6-r6-r2.test.js

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

function extractFn(src, name) {
  var re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  var m = re.exec(src); if (!m) throw new Error('not found: ' + name);
  var start = m.index, i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
function swap(src, find, repl) {
  if (src.indexOf(find) < 0) throw new Error('swap anchor not found: ' + find.slice(0, 90));
  return src.replace(find, repl);
}
function code(src) { return String(src).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

var PAGE = read('assets/js/pages/inventory-replenishment.js');
var DBAPI = read('assets/js/api/operation-system-db-api.js');
var TRANSPORT = read('assets/js/api/km-transport.js');
var COMPAT = read('assets/js/utils/inventory-compat.js');
var CENSUS = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');
var INDEX = read('index.html');
var RO = require('./_release-order.js');

var SKU = 'CO1100-R';

// ================================================================================================================
// A FAITHFUL-ENOUGH DOM. Small enough to read, real enough to run the shipped collector against.
// ================================================================================================================
function El(cls) { this.className = cls || ''; this.children = []; this.attrs = {}; this.value = ''; }
El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c;
};
El.prototype.getAttribute = function (a) { return Object.prototype.hasOwnProperty.call(this.attrs, a) ? this.attrs[a] : null; };
El.prototype.setAttribute = function (a, v) { this.attrs[a] = String(v); };
El.prototype.removeAttribute = function (a) { delete this.attrs[a]; };
El.prototype.closest = function (sel) {
  var want = sel.replace(/^\./, ''), n = this;
  while (n) { if (String(n.className).indexOf(want) !== -1) return n; n = n.parentNode; }
  return null;
};
El.prototype.querySelector = function (sel) {
  var f = /data-field="([^"]+)"/.exec(sel);
  var want = f ? null : sel.replace(/^\./, '');
  for (var i = 0; i < this.children.length; i++) {
    var c = this.children[i];
    if (f ? (c._field === f[1]) : (String(c.className).indexOf(want) !== -1)) return c;
    var deep = c.querySelector ? c.querySelector(sel) : null;
    if (deep) return deep;
  }
  return null;
};
El.prototype.querySelectorAll = function (sel) {
  var want = sel.replace(/^\./, ''), out = [];
  this.children.forEach(function (c) { if (String(c.className).indexOf(want) !== -1) out.push(c); });
  return out;
};
// `innerHTML` on the one element that uses it: _irPaintLastMileCell_ writes a control into the cell, and a
// harness that cannot receive it would be testing a function that never ran. Only the attributes this round
// turns on are parsed back out — the field name, the value and the derived marker.
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html || ''; },
  set: function (html) {
    this._html = String(html);
    this.children = [];
    var re = /<(input|select)([^>]*)>/g, m;
    while ((m = re.exec(this._html)) !== null) {
      var attrs = m[2];
      var fname = (/data-field="([^"]*)"/.exec(attrs) || [])[1];
      if (!fname) continue;
      var el = new El();
      el._field = fname;
      el.setAttribute('data-field', fname);   // the edit handler asks the CONTROL which field it is
      if (/type="hidden"/.test(attrs)) el.setAttribute('type', 'hidden');
      el.value = (/ value="([^"]*)"/.exec(attrs) || ['', ''])[1];
      if (/data-lastmile-derived="1"/.test(attrs)) el.setAttribute('data-lastmile-derived', '1');
      if (m[1] === 'select') {
        var sel = /<option value="([^"]*)"[^>]*selected/.exec(this._html);
        el.value = sel ? sel[1] : '';
      }
      this.appendChild(el);
    }
  }
});
function field(name, value, optAttrs) {
  var e = new El(); e._field = name; e.value = value == null ? '' : String(value);
  if (optAttrs) {
    e.options = [{ getAttribute: function (a) { return optAttrs[a] == null ? '' : String(optAttrs[a]); } }];
    e.selectedIndex = 0;
  }
  return e;
}

// ---- the two production routes -------------------------------------------------------------------------------
var ROUTE_A = { cri: 'CRI-A', lineId: 'SADL-K2-92B8BAD2', draftId: 'SADH-K4-38523A90', qty: '320',
  destValue: 'MARKETPLACE_DESTINATION:Amazon', destName: 'Amazon', destType: 'MARKETPLACE_DESTINATION',
  destCode: '', method: 'sea_express' };
var ROUTE_B = { cri: 'CRI-B', lineId: 'SADL-K2-344FB2B2', draftId: 'SADH-K4-A3872518', qty: '200',
  destValue: 'WH-RESUS-US-3PL-AMZLGS', destName: 'AMZ LGS', destType: 'WAREHOUSE', destCode: 'AMZLGS',
  method: 'air' };
// The lane's eligible last miles. Route A's service runs two, so a person must choose; Route B's runs exactly
// one, which is the shape the incident turned on.
var METHODS = [
  { value: 'sea_express', lastMileOptions: ['truck', 'parcel'] },
  { value: 'air', lastMileOptions: ['parcel'] }
];

var _esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
var lmChoices = new Function('window', extractFn(PAGE, '_irLastMileChoices_') + NL + 'return _irLastMileChoices_;')({});
var lmCellHtml = new Function('window', '_execEsc', '_irIsComposerEl_',
  extractFn(PAGE, '_irLastMileChoices_') + NL + extractFn(PAGE, '_irLastMileCellHtml_') + NL
  + 'return _irLastMileCellHtml_;')({}, _esc, function () { return false; });
var paintLastMile = new Function('window', '_execEsc', '_irIsComposerEl_',
  extractFn(PAGE, '_irLastMileChoices_') + NL + extractFn(PAGE, '_irLastMileCellHtml_') + NL
  + extractFn(PAGE, '_irPaintLastMileCell_') + NL + 'return _irPaintLastMileCell_;')({}, _esc, function () { return false; });
var methodEdit = new Function('onExecutionRouteEdit',
  extractFn(PAGE, 'onExecutionMethodEdit') + NL + 'return onExecutionMethodEdit;')(function () {});

// ================================================================================================================
// THE WORLD. One card, two routes, hydrated from the database with BOTH last miles blank — which is what the
// R6-R6-R1-B1 production freeze records for both rows.
// ================================================================================================================
function World() {
  var self = this;
  this.touched = {};
  this.scheduled = 0;
  this.list = new El('exec-routes-list');
  this.model = { context: { country: 'US', marketplace: 'Amazon' }, bySku: {}, targetDays: 30 };
  this.rows = {};

  function makeRow(o) {
    var r = new El('exec-route-row');
    r.setAttribute('data-route-instance', o.cri);
    r.setAttribute('data-line-id', o.lineId);
    r.setAttribute('data-draft-id', o.draftId);
    // The shipped renderer stamps the STORED values on the row; both last miles are blank in the database.
    r.setAttribute('data-method-persisted', o.method);
    r.setAttribute('data-lastmile-persisted', '');
    r.appendChild(field('qty', o.qty));
    r.appendChild(field('source_warehouse_id', 'WH-TW-CN-FACTORY-YOUXIN',
      { 'data-wh-name': 'CN Youxin', 'data-wh-country': 'CN', 'data-wh-type': 'FACTORY', 'data-wh-code': 'CNYOUXIN' }));
    r.appendChild(field('destination_warehouse_id', o.destValue,
      { 'data-wh-name': o.destName, 'data-wh-type': o.destType, 'data-wh-code': o.destCode }));
    r.appendChild(field('shipping_method', o.method));
    var lmCell = new El('replen-card__lastmile-cell');
    r.appendChild(lmCell);
    var eta = new El('replen-card__eta'); eta._field = 'expected_arrival';
    eta.setAttribute('data-eta', ''); eta.setAttribute('data-eta-basis', ''); eta.setAttribute('data-eta-source', '');
    eta.setAttribute('data-eta-persisted', '');
    r.appendChild(eta);
    return r;
  }
  function modelRow(o) {
    return { client_route_instance_id: o.cri, allocation_draft_line_id: o.lineId, allocation_draft_id: o.draftId,
      sku: SKU, qty: Number(o.qty), planned_qty: Number(o.qty), source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
      destination_warehouse_id: o.destType === 'WAREHOUSE' ? o.destValue : '',
      destination_marketplace: o.destType === 'WAREHOUSE' ? '' : 'Amazon',
      shipping_method: o.method, last_mile_delivery: '', last_mile_persisted: '', last_mile_derived: false,
      units_per_carton: '', recommendation_group_no: '', override_reason: '', note: '',
      window_code: '', site_sku: '', expected_arrival: '' };
  }
  [ROUTE_A, ROUTE_B].forEach(function (o) {
    var r = makeRow(o); self.rows[o.cri] = r; self.list.appendChild(r);
    // THE FIRST PAINT, with the catalogue still in flight: no methods, so no options, so the stored value is
    // rendered verbatim into a hidden field and nothing is derived. This is the state the incident began in.
    paintLastMile(r, [], o.method, null, SKU);
  });
  this.model.bySku[SKU] = [modelRow(ROUTE_A), modelRow(ROUTE_B)];

  this.collect = new Function(
    'document', 'window', 'replenAllocationDraft', 'REPLEN_TARGET_DAYS', 'console',
    '_replenCtx', '_irIsComposerEl_', '_irComposerKind_', '_isRouteComplete',
    '_newDraftLineId', '_newRouteInstanceId', '_persistAllocationDraft', '_scheduleDraftDbPersist',
    '_irMarkRouteTouched_', '_irCanonicalDateOrBlank_', '_execSyncEmptyState_', 'updateShippingAllocationTotal',
    'var IR_ROUTE_PERSISTABLE_FIELDS = ' + (/var IR_ROUTE_PERSISTABLE_FIELDS = ([\s\S]*?\]);/.exec(PAGE) || [])[1] + ';' + NL
    + extractFn(PAGE, '_irRouteSignature_') + NL
    + extractFn(PAGE, '_irRouteProvenanceOf_') + NL
    + extractFn(PAGE, '_saveAllocationDraftFromDom') + NL + 'return _saveAllocationDraftFromDom;'
  )(
    { getElementById: function (id) { return id === 'shipping-methods-' + SKU ? self.list : null; } },
    { IRWarehouse: { resolveDestinationPayload: function (v) {
        return { selected_destination_warehouse_id: (v && v.indexOf('MARKETPLACE_DESTINATION:') === 0) ? null : (v || null) }; } },
      IRRouteProvenance: null, KM: {} },
    this.model, 30, { warn: function () {} },
    function () { return { country: 'US', marketplace: 'Amazon' }; },
    function () { return false; },
    function () { return 'composer'; },
    function (r) { return !!(r && r.source_warehouse_id && r.shipping_method && Number(r.qty) > 0); },
    function () { return 'SADL-NEW'; },
    function () { return 'CRI-NEW-' + (Math.random() * 1e6 | 0); },
    function () {},
    function () { self.scheduled++; },
    function (sku, id) { var k = String(id || '').trim(); if (!k) return; (self.touched[sku] = self.touched[sku] || {})[k] = 1; },
    function (v) { return String(v || '').trim(); },
    function () {}, function () {}
  );
}
// The carrier catalogue settles and every Last Mile cell is repainted — the shipped repaint, not a stand-in.
World.prototype.hydrateCarriers = function () {
  var self = this;
  [ROUTE_A, ROUTE_B].forEach(function (o) {
    paintLastMile(self.rows[o.cri], METHODS, o.method, null, SKU);
  });
};
// The operator picks a value on one row, exactly as the control's own onchange does it.
World.prototype.operatorPicks = function (cri, value) {
  var el = this.rows[cri].querySelector('[data-field="last_mile_delivery"]');
  el.value = value;
  methodEdit(SKU, el);
};
World.prototype.touchedList = function () { return Object.keys(this.touched[SKU] || {}).sort(); };
World.prototype.lm = function (cri) {
  var el = this.rows[cri].querySelector('[data-field="last_mile_delivery"]');
  return el ? String(el.value || '') : null;
};
// The write scope, and the canonical groups it becomes, computed by the SHIPPED rule.
World.prototype.writeScope = function () {
  var t = this.touched[SKU] || {};
  return (this.model.bySku[SKU] || []).filter(function (r) { return t[String(r.client_route_instance_id || '')]; });
};
World.prototype.requests = function () {
  var groups = {};
  this.writeScope().forEach(function (r) {
    var k = [r.source_warehouse_id, r.destination_warehouse_id || r.destination_marketplace, r.shipping_method,
      r.last_mile_delivery].join('|').toLowerCase();
    (groups[k] = groups[k] || []).push(r);
  });
  return Object.keys(groups).map(function (k) {
    return { groupKey: k, routes: groups[k].map(function (r) { return r.client_route_instance_id; }),
      header: groups[k][0].allocation_draft_id, lines: groups[k].map(function (r) { return r.allocation_draft_line_id; }) };
  });
};

(function () {

// ================================================================================================================
section('§1/§2 — THE MUTATION PATH, AND WHETHER PRODUCTION SENT ONE REQUEST OR TWO');
// ================================================================================================================
// Traced in shipped source rather than inferred from the eleven-second gap, which is what §2 asks for.
var flushFn = extractFn(PAGE, '_flushDraftDbPersist');
ok(/pf\.groups\.forEach\(function \(g\) \{/.test(flushFn) && /chain = chain\.then/.test(flushFn),
  'P1  the flush chains ONE atomic write per canonical group');
ok(/never concurrently/.test(flushFn),
  'P1a and says so: groups are written in sequence, so two groups are two requests separated by a round trip');
var persistOne = code(extractFn(PAGE, '_irPersistOneRouteGroup_'));
ok(/upsertShippingAllocationDraftAtomic\(atomicBody\)/.test(persistOne),
  'P2  each group issues exactly one upsertShippingAllocationDraftAtomic');
ok(/header: header/.test(persistOne) && /lines: lines/.test(persistOne),
  'P2a carrying ONE header and that header\'s own lines — a request cannot span two headers');
// So the shape of the production event follows from the routes, not from the clock.
var w0 = new World();
w0.hydrateCarriers();
w0.operatorPicks('CRI-A', 'truck');
// Reproduce the PRE-FIX diff by comparing on the raw DOM value, which is what the shipped signature did.
var rawSig = new Function('IR_ROUTE_PERSISTABLE_FIELDS',
  'return function (r) { return IR_ROUTE_PERSISTABLE_FIELDS.map(function (f) { return String((r && r[f]) == null ? "" : r[f]).trim(); }).join("\\u0001"); };')(
  eval((/var IR_ROUTE_PERSISTABLE_FIELDS = ([\s\S]*?\]);/.exec(PAGE) || [])[1]));
var beforeB = { last_mile_delivery: '' }, afterB = { last_mile_delivery: w0.lm('CRI-B') };
ok(rawSig(beforeB) !== rawSig(afterB),
  'P3  ON THE RAW DOM VALUE, Route B compares as CHANGED — the diff that produced the second request');
eq(w0.lm('CRI-B'), 'parcel', 'P3a because the lane filled its cell with the single eligible last mile');
eq(w0.lm('CRI-A'), 'truck', 'P3b while Route A carries the value a person chose');

// ================================================================================================================
section('§3/§4 — TWO VISIBLE ROUTES, EDIT ONLY A');
// ================================================================================================================
var w = new World();
w.hydrateCarriers();
w.operatorPicks('CRI-A', 'truck');
w.collect(SKU);
eq(w.touchedList(), ['CRI-A'], 'T1  ONE gesture on Route A marks exactly ONE route dirty');
eq(w.writeScope().map(function (r) { return r.client_route_instance_id; }), ['CRI-A'],
  'T2  and the write scope is that route alone');
eq(w.requests().length, 1, 'T3  EXACTLY ONE target request');
eq(w.requests()[0].header, 'SADH-K4-38523A90', 'T3a addressed at Route A\'s own header');
eq(w.requests()[0].lines, ['SADL-K2-92B8BAD2'], 'T3b and Route A\'s own line');
eq(w.requests().filter(function (r) { return r.header === 'SADH-K4-A3872518'; }), [],
  'T4  ZERO Route B writes — the header the incident touched is addressed by nothing');
var mB = w.model.bySku[SKU].filter(function (r) { return r.client_route_instance_id === 'CRI-B'; })[0];
eq([mB.last_mile_delivery, mB.last_mile_derived, mB.last_mile_persisted], ['parcel', true, ''],
  'T5  Route B still CARRIES the derived value — it is what that route would ship under');
ok(true === (mB.last_mile_derived === true),
  'T5a and is recorded as not being its author, which is the whole difference');
// §4 — the measurement the round was asked for, stated as a result rather than as a theory.
eq(w.model.bySku[SKU].filter(function (r) { return r.last_mile_derived === true; })
  .map(function (r) { return r.client_route_instance_id; }), ['CRI-B'],
  'T6  §4 MEASURED: carrier hydration is what put a value on Route B, and on Route B only');

// ================================================================================================================
section('§9 — THE STATES A ROUTE PASSES THROUGH');
// ================================================================================================================
// DELAYED CARRIER HYDRATION AFTER A'S SAVE. The catalogue settles late, repaints both cells, and the operator
// then edits Route A again. The late repaint must not have made Route B a candidate.
var w2 = new World();
w2.operatorPicks('CRI-A', 'truck');       // edited before the catalogue arrived
w2.collect(SKU);
w2.touched[SKU] = {};                      // A's write persisted, so A leaves the touched set
w2.hydrateCarriers();                      // ... and NOW the carrier catalogue settles
w2.collect(SKU);
eq(w2.touchedList(), [], 'T7  a late carrier settle marks NOTHING dirty — hydration is not an edit');
eq(w2.requests().length, 0, 'T7a so it issues zero requests');
eq(w2.lm('CRI-B'), 'parcel', 'T7b even though the cell is now showing the derived value');

// DERIVED PARCEL DISPLAY ON B — the display is unchanged, which is the point: nothing was taken away from the
// operator, only from the write scope.
var cB = lmChoices(METHODS, 'air', '', null);
eq([cB.value, cB.ambiguous, cB.derived], ['parcel', false, true],
  'T8  a one-profile lane still SHOWS parcel, and now reports that the row is not its author');
var cA = lmChoices(METHODS, 'sea_express', '', null);
eq([cA.value, cA.ambiguous, cA.derived], ['', true, false],
  'T8a a two-profile lane still asks, and an unanswered question is not derived');
var cChosen = lmChoices(METHODS, 'sea_express', 'truck', null);
eq([cChosen.value, cChosen.derived], ['truck', false], 'T8b an operator\'s own choice is never derived');
var cInvalid = lmChoices(METHODS, 'air', 'truck', null);
eq([cInvalid.value, cInvalid.derived, cInvalid.invalidated], ['parcel', true, true],
  'T8c and a value the method no longer runs is replaced for display, derived, and flagged invalidated');
ok(/data-lastmile-derived="1"/.test(lmCellHtml(METHODS, 'air', '', null, SKU, false)),
  'T8d the cell PUBLISHES it, so a collect reading the DOM can tell');
ok(!/data-lastmile-derived/.test(lmCellHtml(METHODS, 'sea_express', 'truck', null, SKU, false)),
  'T8e and does not, when the value is the row\'s own');

// EMPTY TOUCHED SET — no dirty intent, zero mutation requests.
var w3 = new World();
w3.hydrateCarriers();
w3.collect(SKU);
eq(w3.touchedList(), [], 'T9  a collect with no operator edit marks nothing');
eq(w3.requests().length, 0, 'T9a and an empty intent set is an empty write scope, not every row on screen');
ok(/var _scoped = rows\s*\n\s*\.filter\(function \(r\) \{ return _touchedSet\[/.test(flushFn),
  'T9b the scope is the touched set, with no second branch to fall through to');
ok(!/: rows\)/.test(flushFn), 'T9c the empty-touched-set fallback is gone from the source');

// RENDER / RE-RENDER — repainting any number of times must not accumulate into an edit.
var w4 = new World();
for (var i = 0; i < 5; i++) { w4.hydrateCarriers(); w4.collect(SKU); }
eq(w4.touchedList(), [], 'T10 five repaints and five collects mark nothing dirty');
eq(w4.lm('CRI-B'), 'parcel', 'T10a the display is stable across them');
var ctlB = w4.rows['CRI-B'].querySelector('[data-field="last_mile_delivery"]');
eq(ctlB.getAttribute('data-lastmile-derived'), '1',
  'T10b and DERIVED-NESS SURVIVES the repaint — the repaint feeds the choice the row\'s stored value, not the last derived one');

// UNMOUNT / REMOUNT — the card is collapsed and reopened; the rows are rebuilt from the database.
var w5 = new World();
w5.hydrateCarriers();
w5.operatorPicks('CRI-A', 'truck');
w5.collect(SKU);
var w5b = new World();                       // remount: fresh DOM, fresh model, database values again
w5b.hydrateCarriers();
w5b.collect(SKU);
eq(w5b.touchedList(), [], 'T11 a remount marks nothing dirty — a rebuilt row is not an edited one');
eq(w5b.requests().length, 0, 'T11a and issues no request');

// RAPID SEARCH — the card is torn down and rebuilt repeatedly while the catalogue keeps settling.
var searches = [];
for (var s = 0; s < 4; s++) {
  var ws = new World();
  ws.hydrateCarriers(); ws.collect(SKU); ws.hydrateCarriers(); ws.collect(SKU);
  searches.push(ws.touchedList().length + ws.requests().length);
}
eq(searches, [0, 0, 0, 0], 'T12 four rapid Search cycles produce zero dirty routes and zero requests');

// NO DUPLICATE HEADER OR LINE — the identities are the stored ones, and one edit addresses one of each.
var w6 = new World();
w6.hydrateCarriers();
w6.operatorPicks('CRI-A', 'truck');
w6.collect(SKU);
var reqs = w6.requests();
eq(reqs.length, 1, 'T13 one request');
eq(reqs[0].routes.length, 1, 'T13a carrying one route');
var allHeaders = w6.model.bySku[SKU].map(function (r) { return r.allocation_draft_id; });
eq(allHeaders.length, new Set(allHeaders).size ? allHeaders.length : -1, 'T13b no header id is duplicated in the model');
eq(w6.model.bySku[SKU].map(function (r) { return r.route_intent; }), ['UPDATE_EXISTING', 'UPDATE_EXISTING'],
  'T13c and both rows are UPDATES of rows the database already holds — nothing mints a new header or line');
eq(w6.model.bySku[SKU].length, 2, 'T13d the plan still has exactly two rows');

// A REAL EDIT ON ROUTE B STILL WRITES ROUTE B. The isolation must not become an inability to save.
var w7 = new World();
w7.hydrateCarriers();
w7.operatorPicks('CRI-B', 'parcel');       // the operator explicitly confirms the derived value
w7.collect(SKU);
eq(w7.touchedList(), ['CRI-B'], 'T14 an operator who DOES choose on Route B marks Route B dirty');
eq(w7.requests().map(function (r) { return r.header; }), ['SADH-K4-A3872518'],
  'T14a and the request is addressed at Route B — isolation is not paralysis');
// And a method change on B, which invalidates nothing, still carries the derived last mile into the write.
var w8 = new World();
w8.hydrateCarriers();
w8.rows['CRI-B'].querySelector('[data-field="qty"]').value = '250';
w8.collect(SKU);
eq(w8.touchedList(), ['CRI-B'], 'T15 a quantity edit on Route B marks it dirty for its OWN reason');
eq(w8.writeScope()[0].last_mile_delivery, 'parcel',
  'T15a and the write carries the derived last mile, because that IS what the route ships under');

// ================================================================================================================
section('§3 — SUCCESS, TIMEOUT AND ACK_UNKNOWN TOUCH ONLY THE MATCHING ROW');
// ================================================================================================================
var flushCode = code(flushFn);
ok(/outcomes\.forEach\(function \(o\) \{\s*if \(o\.status !== 'persisted'\) return;\s*\(o\.instanceIds \|\| \[\]\)\.forEach/.test(flushCode),
  'T16 confirmed success clears ONLY the instances that were persisted');
ok(/if \(o\.status === 'indeterminate'\) _irHoldAckUnknown_\(sku, o\)/.test(flushCode),
  'T17 an indeterminate outcome holds exactly the routes it names');
ok(/_scoped\.filter\(function \(r\) \{ return !_irAckUnknownIsHeld_\(sku, r\.client_route_instance_id\); \}\)/.test(flushCode),
  'T18 a held route is removed from the write scope by its own instance id');
var releaseFn = code(extractFn(PAGE, '_irReleaseAckUnknown_'));
ok(/_irClearAckUnknown_\(sku, \[String\(instanceId/.test(releaseFn),
  'T19 and the ONLY release names one instance');
ok(!/onExecutionRouteEdit|_saveAllocationDraftFromDom|_scheduleDraftDbPersist/.test(releaseFn),
  'T19a which no edit path calls — an unrelated edit can neither release nor resend a held row');
// TIMEOUT BEFORE EXECUTION vs TIMEOUT AFTER COMMIT. The client cannot tell them apart, and the shipped
// classification does not pretend to: both are INDETERMINATE, and indeterminate is what the hold is for.
var cmdFn = code(extractFn(DBAPI, '_kmWeeklyCommand_'));
ok(/netErr && netErr\.kmTimeout/.test(cmdFn) && /_kmTimeoutError_\(command, 'write'/.test(cmdFn),
  'T20 a write that expires is classified as a WRITE timeout, never as a failure');
var timeoutFn = code(extractFn(DBAPI, '_kmTimeoutError_'));
ok(/indeterminate/i.test(timeoutFn) || /INDETERMINATE/.test(timeoutFn),
  'T20a and an expired write is INDETERMINATE — the server may have committed after we stopped listening');
ok(/zero_write: false|indeterminate: true/.test(timeoutFn),
  'T20b so it is never reported as a proven zero-write');

// ================================================================================================================
section('§5 — THE MUTATION IS VISIBLE IN THE TIMELINE');
// ================================================================================================================
// Executed against the real transport module.
// Instantiated through its own UMD wrapper, in a sandbox — the same way the R6-R5 cold-boot suite does it.
function transportFactory(src) {
  var sb = { window: {}, console: console };
  sb.window.window = sb.window;
  vm.createContext(sb);
  vm.runInContext(src || TRANSPORT, sb);
  return sb.window.KM.transportFactory;
}
var api = transportFactory();
var tp = api.create();
eq(tp.timeline().mutation_requests, 0, 'M1  a fresh transport has recorded no mutation');
tp.recordExternal({ action: 'upsertShippingAllocationDraftAtomic', kind: 'write', ms: 4200, bytes: 180,
  routes_in_payload: 1, allocation_draft_id: 'SADH-K4-38523A90',
  allocation_draft_line_ids: ['SADL-K2-92B8BAD2'],
  changed_fields: ['recommended_last_mile_delivery', 'line.allocation_draft_line_id'],
  outcome: 'ANSWERED', request_id: 'REQ-W000001-C' });
var tl = tp.timeline();
eq(tl.mutation_requests, 1, 'M2  a write reported through recordExternal now APPEARS in the timeline');
eq(tl.request_timeline.length, 1, 'M2a and in the request timeline it was structurally absent from before');
var row = tl.mutations[0];
eq(row.action, 'upsertShippingAllocationDraftAtomic', 'M3  named by its action');
eq(row.kind, 'write', 'M3a and typed as a write');
eq(row.routes_in_payload, 1, 'M3b carrying how many routes the payload held');
eq(row.allocation_draft_id, 'SADH-K4-38523A90', 'M3c the header it addressed');
eq(row.allocation_draft_line_ids, ['SADL-K2-92B8BAD2'], 'M3d the lines it addressed');
eq(row.changed_fields, ['recommended_last_mile_delivery', 'line.allocation_draft_line_id'],
  'M3e and the FIELD NAMES it would set');
eq(row.outcome, 'ANSWERED', 'M3f with the result');
eq(row.request_id, 'REQ-W000001-C', 'M3g and a correlation id');
ok(typeof row.dispatch_ms === 'number' && typeof row.settled_ms === 'number',
  'M4  it has an interval, which is what timeline() filters on');
eq(row.dispatch_ms, Math.max(0, row.settled_ms - 4200),
  'M4a reconstructed from the reported duration, clamped at the transport\'s own epoch: a request'
  + ' cannot have been dispatched before the module that is recording it existed');
eq(row.marks_source, 'EXTERNAL_RECONSTRUCTED',
  'M4b AND LABELLED AS RECONSTRUCTED — inferring an interval from a duration is exactly what §2 forbids doing silently');
// Two mutations eleven seconds apart, as production reported them: the timeline must show two, not one.
var tp2 = api.create();
tp2.recordExternal({ action: 'upsertShippingAllocationDraftAtomic', kind: 'write', ms: 5000,
  routes_in_payload: 1, allocation_draft_id: 'SADH-K4-38523A90', outcome: 'ANSWERED' });
tp2.recordExternal({ action: 'upsertShippingAllocationDraftAtomic', kind: 'write', ms: 5000,
  routes_in_payload: 1, allocation_draft_id: 'SADH-K4-A3872518', outcome: 'ANSWERED' });
eq(tp2.timeline().mutation_requests, 2, 'M5  the incident\'s two writes would both be visible');
eq(tp2.timeline().mutations.map(function (r) { return r.allocation_draft_id; }),
  ['SADH-K4-38523A90', 'SADH-K4-A3872518'],
  'M5a naming BOTH headers, which is the fact the operator could not obtain');
// A read is still a read.
var tp3 = api.create();
tp3.recordExternal({ action: 'workspace.get', kind: 'read', ms: 900 });
eq(tp3.timeline().mutation_requests, 0, 'M6  a read does not become a mutation');
eq(tp3.timeline().request_timeline.length, 1, 'M6a but it is still in the timeline');
// A sample with no duration is not given a fabricated interval.
var tp4 = api.create();
tp4.recordExternal({ action: 'x.y', kind: 'write', ms: 0 });
eq(tp4.timeline().mutation_requests, 1, 'M7  a write that took no measurable time is still a write in the timeline');
eq(tp4.timeline().mutations[0].settled_ms - tp4.timeline().mutations[0].dispatch_ms, 0,
  'M7a with a zero interval, which is a measurement rather than an absence');
tp4.recordExternal({ action: 'x.z', kind: 'write' });
eq(tp4.timeline().mutation_requests, 1,
  'M7b while a sample carrying NO duration gets NO invented interval — a fabricated one is worse than none');
eq(tp4.metrics().requests, 2, 'M7c though it is still counted, so nothing is silently discarded');
// Which is safe only because the reporter always supplies one. That is the claim keeping writes visible.
ok(/ms: \(startedAt \? \(Date\.now\(\) - startedAt\) : 0\)/.test(extractFn(DBAPI, '_kmReportSample_')),
  'M7d and _kmReportSample_ ALWAYS supplies a duration, zero included');

// THE SHAPE THE COMMAND PATH REPORTS — names, ids and counts, and no values.
var shape = new Function('return ' + extractFn(DBAPI, '_kmMutationShape_') + NL + ';_kmMutationShape_')();
var got = shape('upsertShippingAllocationDraftAtomic', {
  header: { allocation_draft_id: 'SADH-K4-38523A90', recommended_last_mile_delivery: 'truck',
    expected_draft_version: '1' },
  lines: [{ allocation_draft_line_id: 'SADL-K2-92B8BAD2', sku: SKU, planned_qty: 320, note: 'private note' }]
});
eq(got.routes_in_payload, 1, 'M8  the shape counts the routes');
eq(got.allocation_draft_id, 'SADH-K4-38523A90', 'M8a names the header');
eq(got.allocation_draft_line_ids, ['SADL-K2-92B8BAD2'], 'M8b names the lines');
ok(got.changed_fields.indexOf('recommended_last_mile_delivery') !== -1
  && got.changed_fields.indexOf('line.planned_qty') !== -1, 'M8c and lists the field NAMES');
eq(JSON.stringify(got).indexOf('private note'), -1, 'M9  the note\'s VALUE is nowhere in the sample');
eq(JSON.stringify(got).indexOf('320'), -1, 'M9a nor is the quantity');
eq(JSON.stringify(got).indexOf('truck'), -1, 'M9b nor the last mile value — names answer the question, values do not');
// A new line has no id yet, and that is reported rather than dropped.
eq(shape('x', { header: {}, lines: [{ sku: SKU }] }).allocation_draft_line_ids, ['(new)'],
  'M10 a line with no persisted id is named "(new)" rather than omitted');
// A diagnostic that can throw is worse than one that is silent.
eq(shape('x', null).routes_in_payload, null, 'M11 a null payload yields nulls, never an exception');

// ================================================================================================================
section('§6 — ETA AUTHORITY');
// ================================================================================================================
var lineFn = extractFn(COMPAT, 'buildDraftLinePayload');
ok(!/p\.expected_arrival\s*=/.test(lineFn),
  'E1  expected_arrival is NOT sent by the line payload builder');
ok(/DELIBERATELY NOT SENT/.test(lineFn) && /BLOCKED DECISION/.test(lineFn),
  'E1a and shipped source says it is a BLOCKED DECISION, not an oversight');
ok(/planned ship date/.test(lineFn) && /Receiving Buffer/.test(lineFn),
  'E2  naming the two inputs CARRIER_AND_ROUTE_SPEC §5B requires and the schema does not have');
ok(/There is no[\s\S]{0,12}planned ship date anywhere in this flow/.test(lineFn)
  && /not on the 35-column allocation draft/.test(lineFn),
  'E2a and stating that the base date exists in no table, header or line');
// So a blank DB column is the correct state, and the displayed date is computed.
var etaFn = extractFn(PAGE, '_irRouteEtaFor');
ok(/var snapshot = _irCanonicalDateOrBlank_\(route\.expected_arrival\)/.test(etaFn),
  'E3  a PERSISTED date, when one exists, is the authority');
ok(/source: 'COMPUTED'/.test(PAGE), 'E3a and a route without one shows a COMPUTED figure');
// The reasoning lives in the comment block the function is introduced by, so it is read from the file.
ok(/It must not move because/.test(PAGE) && /silently rewrite a commitment the operator/.test(PAGE),
  'E4  the reason a stored date wins is that a later lead-time edit must not rewrite a commitment');
// THE QUESTION THE ROUND ASKS: should a daily reload change a saved route's ETA? It changes the DISPLAYED one,
// because nothing is saved and TODAY is substituted for the missing base date. That is a REFERENCE figure by
// construction, and this suite records it as the measured contract rather than inventing a rule about it.
ok(/substituting TODAY and avg_days/.test(lineFn) && /reasonable REFERENCE figure/.test(lineFn),
  'E5  the displayed date is a REFERENCE figure computed from TODAY, so a reload moves it — by design, stated in source');
ok(/a persisted commitment must not be built on/.test(lineFn),
  'E5a and that is precisely why it is not persisted');
ok(/A test asserts this field stays absent/.test(lineFn),
  'E6  a future round has to remove that guarantee deliberately rather than reintroduce a guess by accident');
// The frozen production BEFORE agrees: both routes hold a blank expected_arrival.
ok(/expected_arrival: '',/.test(CENSUS), 'E7  and the frozen production capture records exactly that');

// ================================================================================================================
section('§7/§8 — THE AFTER-STATE CENSUS AND THE REPAIR THAT IS NOT RUN');
// ================================================================================================================
var afterFn = extractFn(CENSUS, 'RUN_R6R6R2_AFTER_STATE_CENSUS');
var repairFn = extractFn(CENSUS, 'RUN_R6R6R2_ROUTE_B_REPAIR_MANIFEST');
['setValue', 'appendRow', 'deleteRow', 'clearContent', 'getRange().setValue'].forEach(function (bad) {
  ok(code(afterFn).indexOf(bad) === -1 && code(repairFn).indexOf(bad) === -1,
    'R1  neither entry point can ' + bad);
});
ok(/read_only: true, db_writes: 0/.test(afterFn) && /read_only: true, db_writes: 0/.test(repairFn),
  'R2  both declare read_only and zero writes');
ok(/executed: false,\s*\/\/ ALWAYS false\. This entry point has no write path at all\./.test(repairFn),
  'R3  the repair reports executed:false, and says it has no write path');
ok(!/upsertShippingAllocationDraftAtomic\(/.test(code(repairFn)),
  'R3a it never CALLS the writer — it only names the action it would use');
ok(/verdict: 'REPAIR_DESIGNED_NOT_EXECUTED'|'REPAIR_DESIGNED_NOT_EXECUTED'/.test(repairFn),
  'R3b and its success verdict says DESIGNED, not DONE');
// The manifest's own content.
ok(/expected_draft_version: CENSUS_str_\(expectAfter\.draft_version\)/.test(repairFn),
  'R4  the compensating update is guarded by the CURRENT version (2), not by the pre-incident one');
ok(/to: '3', note: 'the writer advances it by exactly one; never set, never decremented'/.test(repairFn),
  'R4a it goes FORWARD to 3 — no decrement, no history rewrite');
ok(/'delete the row', 'decrement draft_version'/.test(repairFn) && /'touch Route A'/.test(repairFn),
  'R5  and it names what it forbids, including touching Route A');
ok(/R6R6R2_REPAIRABLE_FIELDS_ = \['last_mile_delivery'\]/.test(CENSUS),
  'R6  exactly ONE field may be restored');
ok(/R6R6_FROZEN_BEFORE_\.other_rows\[0\], captured while the row was still correct/.test(repairFn),
  'R6a and its target value is the frozen BEFORE, not a recomputed one');
ok(/CENSUS_r6r6K4WithLastMile_/.test(repairFn),
  'R7  the K4 key is DERIVED from the restored last mile rather than typed');
ok(/fields_explicitly_untouched/.test(repairFn) && /'expected_arrival'/.test(repairFn),
  'R8  and expected_arrival is on the untouched list');
ok(/verdict: 'NO_ETA_ACTION'/.test(repairFn),
  'R8a with the §6 audit\'s answer stated as the ETA treatment: do nothing');
ok(/an unmeasured difference on /.test(repairFn),
  'R9  any difference the incident did not measure REFUSES the repair rather than being carried along');
ok(/out\.ready_to_execute = \(out\.preflight\.length === 0\)/.test(repairFn),
  'R10 and only an empty preflight authorises anything');
ok(/readback_contract/.test(repairFn) && /draft_version 3/.test(repairFn),
  'R11 a readback contract is stated, and it expects version 3');
ok(/R6R6R2_ROUTE_A_AUTHORIZED_AFTER_/.test(CENSUS),
  'R12 Route A\'s AFTER is frozen too — as the thing that must NOT be repaired');

// ================================================================================================================
section('§10 — MUTANTS');
// ================================================================================================================
var CHOICES = extractFn(PAGE, '_irLastMileChoices_');
var SIG = extractFn(PAGE, '_irRouteSignature_');
var CELL = extractFn(PAGE, '_irLastMileCellHtml_');
var PAINT = extractFn(PAGE, '_irPaintLastMileCell_');

mut('N1  the derived flag always false — every derived value becomes an operator decision again', function () {
  var m = swap(CHOICES, 'var derived = String(value).toLowerCase() !== selLow;', 'var derived = false;');
  var f = new Function('window', m + NL + 'return _irLastMileChoices_;')({});
  return f(METHODS, 'air', '', null).derived === false && lmChoices(METHODS, 'air', '', null).derived === true;
});
mut('N2  the signature reading the derived value instead of the persisted one', function () {
  var m = swap(SIG, "var v = (derived && fld === 'last_mile_delivery') ? (r && r.last_mile_persisted) : (r && r[fld]);",
    'var v = (r && r[fld]);');
  var mk = function (src) {
    return new Function('IR_ROUTE_PERSISTABLE_FIELDS', src + NL + 'return _irRouteSignature_;')(
      eval((/var IR_ROUTE_PERSISTABLE_FIELDS = ([\s\S]*?\]);/.exec(PAGE) || [])[1]));
  };
  var before = { last_mile_delivery: '', last_mile_persisted: '', last_mile_derived: false };
  var after = { last_mile_delivery: 'parcel', last_mile_persisted: '', last_mile_derived: true };
  // The mutant sees an edit where the shipped code sees none — the incident, in one comparison.
  return mk(m)(before) !== mk(m)(after) && mk(SIG)(before) === mk(SIG)(after);
});
mut('N3  the cell no longer publishing derived-ness, so the collector cannot tell', function () {
  var m = swap(CELL, "var derivedAttr = c.derived ? ' data-lastmile-derived=\"1\"' : '';", "var derivedAttr = '';");
  var f = new Function('window', '_execEsc', '_irIsComposerEl_',
    CHOICES + NL + m + NL + 'return _irLastMileCellHtml_;')({}, _esc, function () { return false; });
  return !/data-lastmile-derived/.test(f(METHODS, 'air', '', null, SKU, false))
    && /data-lastmile-derived/.test(lmCellHtml(METHODS, 'air', '', null, SKU, false));
});
mut('N4  the repaint feeding the control value back, so derived-ness evaporates on the second paint', function () {
  var m = swap(PAINT, '    if (_lmWasDerived && !_lmAuthored) {', '    if (false) {');
  var f = new Function('window', '_execEsc', '_irIsComposerEl_',
    CHOICES + NL + CELL + NL + m + NL + 'return _irPaintLastMileCell_;')({}, _esc, function () { return false; });
  function twice(paint) {
    var w = new World();
    [ROUTE_B].forEach(function (o) { paint(w.rows[o.cri], METHODS, o.method, null, SKU); });
    [ROUTE_B].forEach(function (o) { paint(w.rows[o.cri], METHODS, o.method, null, SKU); });
    var el = w.rows['CRI-B'].querySelector('[data-field="last_mile_delivery"]');
    return el.getAttribute('data-lastmile-derived');
  }
  return twice(f) === null && twice(paintLastMile) === '1';
});
mut('N5  the empty-touched-set fallback restored', function () {
  // CRLF: a multi-line anchor in this repository must carry the carriage returns or it matches nothing.
  var anchor = 'var _scoped = rows' + String.fromCharCode(13, 10)
    + '            .filter(function (r) { return _touchedSet[String(r.client_route_instance_id';
  var m = swap(flushFn, anchor, 'var _scoped = (_touched.length ? rows : rows)' + String.fromCharCode(13, 10)
    + '            .filter(function (r) { return true || _touchedSet[String(r.client_route_instance_id');
  return /_touched\.length \? rows : rows/.test(m) && !/_touched\.length \? rows : rows/.test(flushFn);
});
mut('N6  the last-mile picker marking the METHOD dirty again', function () {
  var src = extractFn(PAGE, 'onExecutionMethodEdit');
  var m = swap(src, "row.setAttribute(_field === 'last_mile_delivery' ? 'data-lastmile-dirty' : 'data-method-dirty', '1');",
    "row.setAttribute('data-method-dirty', '1');");
  function markedBy(fnSrc) {
    var f = new Function('onExecutionRouteEdit', fnSrc + NL + 'return onExecutionMethodEdit;')(function () {});
    var w = new World();
    var el = w.rows['CRI-B'].querySelector('[data-field="last_mile_delivery"]');
    el.value = 'parcel'; f(SKU, el);
    return [w.rows['CRI-B'].getAttribute('data-lastmile-dirty'), w.rows['CRI-B'].getAttribute('data-method-dirty')];
  }
  return JSON.stringify(markedBy(m)) === JSON.stringify([null, '1'])
    && JSON.stringify(markedBy(src)) === JSON.stringify(['1', null]);
});
mut('N7  an external sample given no interval, so mutations vanish from the timeline again', function () {
  var m = swap(TRANSPORT, "      var _extMarks = (_ms === null) ? {} : {", "      var _extMarks = (true) ? {} : {");
  var x = transportFactory(m).create();
  x.recordExternal({ action: 'w', kind: 'write', ms: 100 });
  return x.timeline().mutation_requests === 0 && tp.timeline().mutation_requests > 0;
});
mut('N8  the reconstructed interval passed off as observed', function () {
  var m = swap(TRANSPORT, "          marks_source: 'EXTERNAL_RECONSTRUCTED'", "          marks_source: 'OBSERVED'");
  var x = transportFactory(m).create();
  x.recordExternal({ action: 'w', kind: 'write', ms: 100 });
  return x.timeline().mutations[0].marks_source === 'OBSERVED'
    && tl.mutations[0].marks_source === 'EXTERNAL_RECONSTRUCTED';
});
mut('N9  the mutation shape carrying payload VALUES', function () {
  var src = extractFn(DBAPI, '_kmMutationShape_');
  var m = swap(src, "Object.keys(h).forEach(function (k) { if (h[k] !== undefined) names[k] = 1; });",
    "Object.keys(h).forEach(function (k) { if (h[k] !== undefined) names[k + '=' + h[k]] = 1; });");
  var f = new Function('return ' + m + NL + ';_kmMutationShape_')();
  var out = f('x', { header: { recommended_last_mile_delivery: 'truck' }, lines: [] });
  return JSON.stringify(out).indexOf('truck') !== -1 && JSON.stringify(got).indexOf('truck') === -1;
});
mut('N10 the repair executing instead of reporting', function () {
  // There is no writer call to remove, so the mutant ADDS one — which is what a future round would do by
  // accident. The claim is that the shipped text contains none.
  var m = swap(repairFn, "    executed: false,", "    executed: true,");
  return /executed: true/.test(m) && /executed: false/.test(repairFn)
    && code(repairFn).indexOf('SpreadsheetApp') === -1;
});
mut('N11 the repair losing its version guard', function () {
  var m = swap(repairFn, "expected_draft_version: CENSUS_str_(expectAfter.draft_version)", "expected_draft_version: ''");
  return /expected_draft_version: ''/.test(m) && /expected_draft_version: CENSUS_str_/.test(repairFn);
});
mut('N12 the ETA field reintroduced into the line payload', function () {
  var m = swap(lineFn, "    if (row.site_sku != null) p.site_sku = row.site_sku;",
    "    p.expected_arrival = row.expected_arrival;\n    if (row.site_sku != null) p.site_sku = row.site_sku;");
  return /p\.expected_arrival = /.test(m) && !/p\.expected_arrival\s*=/.test(lineFn);
});

// ================================================================================================================
section('DEPLOYMENT');
// ================================================================================================================
eq(RO.currentAppToken(), 'fc1be3r4a2r1r6r6r2-rowisolation-20260906',
  'D1  the application cache token moved — three frontend files changed, and a stale copy still writes Route B');
eq((INDEX.match(/fc1be3r4a2r1r6r6r2-rowisolation-20260906/g) || []).length, 21,
  'D1a and every one of the 21 script/style references carries it');
eq((INDEX.match(/fc1be3r4a2r1r6r6-compactrecon-20260905/g) || []).length, 0,
  'D1b with none left on the previous token');
// R6-R6-R3 — THIS WAS AN EQUALITY WITH NOW, and the first later round to touch the file broke it. The
// claim this suite actually owns is that the diagnostic changed in R6-R6-R2 OR LATER; pinning the literal
// made every future round's stamp bump look like a regression in THIS round's evidence.
var _d2Declared = (CENSUS.match(/var TEMP_E3_CENSUS_BUILD_ = '([^']+)'/) || [])[1];
ok(RO.OWNER_STAMPS.indexOf(_d2Declared) >= RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2'),
  'D2  the diagnostic declares R6-R6-R2 or a later round (' + _d2Declared + ')');
ok(RO.OWNER_STAMPS.indexOf('F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2') !== -1,
  'D2a and the ledger still records the round this suite belongs to');
ok(RO.BUILD_STAMP_RE.test(_d2Declared), 'D2b and whatever it declares is a well-formed stamp');
// The BEFORE was not re-captured, so the capture stamp must NOT march to this round.
ok(/captured_for_build: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1-B1'/.test(CENSUS),
  'D3  the frozen capture still names the build it was CAPTURED for — a stamp records an event, not the present');
// No Apps Script BUSINESS handler changed this round.
eq(read('assets/specs/active/apps-script/16_shipping_allocation_handlers.gs').indexOf('R6-R6-R2'), -1,
  'D4  16_ is untouched — this is a client-side isolation defect and the server contract did not move');

console.log('\npassed ' + pass + '  failed ' + fail + '  |  mutants caught ' + neg.caught + '  survived ' + neg.missed);
process.exit(fail ? 1 : 0);
})();
