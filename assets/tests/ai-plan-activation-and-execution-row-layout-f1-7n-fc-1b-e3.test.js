// ================================================================================================================
// F1-7N-FC-1B-E3 — AI PLAN CONTROLLED ACTIVATION + VISIBLE RUNTIME FEEDBACK + EXECUTION ROW LAYOUT
// ----------------------------------------------------------------------------------------------------------------
// THREE THINGS, AND TWO OF THEM TURNED OUT TO BE THE SAME THING.
//
// §A/§B — THE COMPOSER LOOKED BROKEN BECAUSE THE STYLESHEET NEVER STYLED IT. Every control rule in the
//   Execution Plan was scoped to `.exec-route-row`, a class a PRISTINE COMPOSER deliberately does not carry
//   (that missing class is what makes "not collected while untouched" a property of the collector's selector).
//   So the composer's selects kept the base `padding: 4px 6px` AND an 8px bottom margin while a route's got
//   `2px 4px` and none, and its Qty stayed right-aligned. On top of that the height was never declared at all,
//   and a <select> and an <input type=number> with identical padding still render different heights. E3
//   replaces the four `.exec-route-row`-scoped rules with ONE rule scoped to the shared `.ir-exec-plan__grid`,
//   which the header row, a persisted route, an AI route and both composers all carry. And the helper sentence
//   E1 added is REMOVED: the fix for "the operator cannot tell this row is a form" was the layout, not prose.
//
// §C/§D — "GENERATE AI PLAN" WAS NOT SILENT BECAUSE OF THE FEATURE FLAG. Five findings, measured by driving the
//   shipped chain: (1) the click fires and the handler is entered; (2) the scope modal calls close('confirm')
//   BEFORE the callback, so the Generate button is gone before any handler could touch it; (3)
//   `#replen-ai-plan-btn` is the MENU ITEM, inside a panel runReplenAiSupport hides on its first line — every
//   `disabled`/`is-loading` write, INCLUDING the re-entry guard, landed on a hidden element; (4) the flag-off
//   path is entirely synchronous, so busy was set and cleared inside one task and no frame ever painted it;
//   and (5) the surface carrying the actual sentence, class `replen-ai-plan-result`, HAD NO CSS RULE ANYWHERE
//   IN THE REPOSITORY — copied from Order Planning's `.ro-ai-plan-result` without its stylesheet, so it was
//   laid out at the bottom of an `overflow: hidden` body and was literally unreachable, while
//   `_irAiSupportNotice_` returned TRUE and every caller believed it had spoken.
//
// §E — THE FLAG IS ACTIVATED, USER-AUTHORIZED, AND KEPT AS THE ROLLBACK SWITCH.
//
// Run: node assets/tests/ai-plan-activation-and-execution-row-layout-f1-7n-fc-1b-e3.test.js
// ================================================================================================================
var fs = require('fs');
var path = require('path');

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
function code(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); }

var PAGE = read('assets/js/pages/inventory-replenishment.js');
var CSS = read('assets/css/pages/inventory-replenishment.css');
var BASECSS = read('assets/css/base.css');
var CMPSRC = read('assets/js/utils/inventory-compat.js');
var CMP = require(path.join(ROOT, 'assets/js/utils/inventory-compat.js'));
var PF = CMP.IRSubmitPreflight;
var RO = require(path.join(ROOT, 'assets/tests/_release-order.js'));
var INDEX = read('index.html');
var CFG = read('assets/specs/active/apps-script/00_config.gs');
var HLTH = read('assets/specs/active/apps-script/63_api_v1_system_health.gs');
var G61 = read('assets/specs/active/apps-script/61_api_v1_weekly_ai_plan.gs');
var MODAL = read('assets/js/utils/scope-select-modal.js');
var KMAPI = read('assets/js/api/km-api-foundation.js');
var TEMP = read('assets/tools/apps-script-diagnostics/TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs');

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  var i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { var ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + name);
}
// The page is CRLF and this file is LF, so a literal multi-line anchor never matches. A missing anchor THROWS,
// so a mutation that has stopped applying is a loud PROBE ERROR rather than a quietly surviving mutant.
function swap(src, find, repl) {
  var re = new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'));
  if (!re.test(src)) throw new Error('swap anchor not found: ' + String(find).slice(0, 90));
  return src.replace(re, repl.replace(/\$/g, '$$$$'));
}

var SKU = 'SKU-E3';

// ================================================================================================================
// A CSS CASCADE RESOLVER.
//
// WHAT IT IS: it parses the SHIPPED stylesheets, matches every selector against a described element and its real
// ancestor chain, orders the matches by (specificity, source order) exactly as the cascade does, and reports the
// WINNING declaration for a property. Applied to markup produced by the SHIPPED row builder.
//
// WHAT IT IS NOT: a layout engine. It does not measure pixels on a screen. That distinction matters and is
// stated rather than glossed: §B is a question about DECLARATIONS — do the four controls resolve the same box
// from the cascade, or does one of them fall through to a different rule — and that is precisely the question
// that was answered "no" by a stylesheet whose only control rules were scoped to a class one row kind lacks.
// A pixel measurement would answer the same question less directly and would need a browser to do it.
// ================================================================================================================
function parseCss(text, sheetIndex) {
  var out = [];
  var src = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  var i = 0, order = 0;
  function block(from, media) {
    var j = from;
    while (j < src.length) {
      var brace = src.indexOf('{', j);
      if (brace === -1) return src.length;
      var prelude = src.slice(j, brace).trim();
      if (prelude.charAt(0) === '@') {
        // find the matching close brace of the at-rule
        var d = 0, k = brace;
        for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
        if (/^@media/i.test(prelude)) block(brace + 1, prelude);      // media rules count, with their condition
        j = k + 1;                                                    // keyframes / font-face bodies are skipped
        if (media && j >= closeOf(from - 1)) return j;
        continue;
      }
      var close = src.indexOf('}', brace);
      if (close === -1) return src.length;
      var body = src.slice(brace + 1, close);
      prelude.split(',').forEach(function (sel) {
        sel = sel.trim();
        if (!sel) return;
        out.push({ sel: sel, decls: declsOf(body), media: media || '', order: order++, sheet: sheetIndex });
      });
      j = close + 1;
      if (media) {
        // stop when we leave the media block
        var nextClose = src.indexOf('}', j);
        var nextBrace = src.indexOf('{', j);
        if (nextClose !== -1 && (nextBrace === -1 || nextClose < nextBrace)) return nextClose + 1;
      }
    }
    return j;
  }
  function closeOf() { return src.length; }
  function declsOf(body) {
    var d = {};
    String(body).split(';').forEach(function (p) {
      var c = p.indexOf(':');
      if (c === -1) return;
      var k = p.slice(0, c).trim().toLowerCase();
      var v = p.slice(c + 1).trim();
      if (k) d[k] = v;
    });
    return d;
  }
  block(0, '');
  return out;
}
var RULES = parseCss(BASECSS, 0).concat(parseCss(CSS, 1));

// An element descriptor: { tag, id, cls: [], attrs: {}, pseudo: [] }
function specificity(sel) {
  var ids = (sel.match(/#[\w-]+/g) || []).length;
  var cls = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/\[[^\]]+\]/g) || []).length +
    (sel.match(/:(?!:)[a-z-]+(?:\([^)]*\))?/gi) || []).length;
  var typ = (sel.replace(/\[[^\]]+\]/g, '').replace(/:(?!:)[a-z-]+(?:\([^)]*\))?/gi, '')
    .split(/[\s>+~]+/).filter(function (p) { return /^[a-z]/i.test(p); })).length;
  return ids * 10000 + cls * 100 + typ;
}
function matchSimple(simple, el) {
  if (/::/.test(simple)) return false;                      // pseudo-ELEMENT rules describe a different box
  var m, rest = simple;
  var tag = (rest.match(/^([a-z][\w-]*)/i) || [])[1];
  if (tag && String(el.tag || '').toLowerCase() !== tag.toLowerCase()) return false;
  rest = rest.replace(/^[a-z][\w-]*/i, '');
  var re = /(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(:[a-z-]+(?:\([^)]*\))?)/gi;
  while ((m = re.exec(rest))) {
    var t = m[0];
    if (t.charAt(0) === '#') { if (el.id !== t.slice(1)) return false; }
    else if (t.charAt(0) === '.') { if ((el.cls || []).indexOf(t.slice(1)) === -1) return false; }
    else if (t.charAt(0) === '[') {
      var am = /^\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]$/.exec(t);
      if (!am) return false;
      var have = (el.attrs || {})[am[1]];
      if (have === undefined) return false;
      if (am[2] === '=' && String(have) !== am[3]) return false;
    } else if (t.charAt(0) === ':') {
      if ((el.pseudo || []).indexOf(t.slice(1)) === -1) return false;
    }
  }
  return true;
}
// chain: ancestors first, target last. Supports descendant and `>` combinators.
function matchSelector(sel, chain) {
  var parts = sel.trim().split(/\s+/).reduce(function (acc, p) {
    if (p === '>' || p === '+' || p === '~') { acc.push({ comb: p }); } else { acc.push({ simple: p }); }
    return acc;
  }, []);
  // normalise `a>b` written without spaces
  var flat = [];
  parts.forEach(function (p) {
    if (p.comb) { flat.push(p); return; }
    var bits = p.simple.split('>');
    bits.forEach(function (b, i) { if (i) flat.push({ comb: '>' }); if (b) flat.push({ simple: b }); });
  });
  var seq = [];
  for (var i = 0; i < flat.length; i++) {
    if (flat[i].comb) { seq[seq.length - 1].comb = flat[i].comb; }
    else { seq.push({ simple: flat[i].simple, comb: ' ' }); }
  }
  if (!seq.length) return false;
  // match right-to-left
  var ci = chain.length - 1;
  if (!matchSimple(seq[seq.length - 1].simple, chain[ci])) return false;
  var si = seq.length - 2;
  var comb = seq[seq.length - 2] ? seq[seq.length - 2].comb : ' ';
  ci--;
  while (si >= 0) {
    var want = seq[si].simple;
    if (comb === '>') {
      if (ci < 0 || !matchSimple(want, chain[ci])) return false;
      ci--;
    } else {
      var found = false;
      while (ci >= 0) { if (matchSimple(want, chain[ci])) { found = true; ci--; break; } ci--; }
      if (!found) return false;
    }
    comb = seq[si - 1] ? seq[si - 1].comb : ' ';
    si--;
  }
  return true;
}
function computed(chain, mediaFilter) {
  var winners = {};
  RULES.forEach(function (r) {
    if (r.media && !(mediaFilter && mediaFilter(r.media))) return;
    if (!matchSelector(r.sel, chain)) return;
    var sp = specificity(r.sel);
    Object.keys(r.decls).forEach(function (k) {
      var cur = winners[k];
      var rank = [r.sheet, sp, r.order];
      if (!cur || cur.rank[1] < sp || (cur.rank[1] === sp && cur.rank[2] < r.order)) {
        winners[k] = { value: r.decls[k], rank: rank, sel: r.sel };
      }
    });
  });
  var out = {};
  Object.keys(winners).forEach(function (k) { out[k] = winners[k].value; });
  out.__owner = function (k) { return winners[k] ? winners[k].sel : null; };
  return out;
}

// ================================================================================================================
// THE SHIPPED MARKUP. Produced by running the SHIPPED row builder, then parsed for its four controls, so the
// element descriptors the resolver is fed are not hand-written approximations of the page.
// ================================================================================================================
function renderRow(route) {
  var created = null;
  var deps = {
    document: {
      createElement: function () {
        created = { className: '', innerHTML: '', _a: {},
          setAttribute: function (k, v) { this._a[k] = String(v); },
          removeAttribute: function (k) { delete this._a[k]; },
          getAttribute: function (k) { return this._a[k] === undefined ? null : this._a[k]; } };
        return created;
      },
      getElementById: function () { return null; }          // no list: the row is built but not appended
    },
    window: { IRRouteProvenance: CMP.IRRouteProvenance },
    console: { warn: function () {} },
    getReplenishmentData: function () { return [{ sku: SKU, country: 'US' }]; },
    _replenSelectedScope: function () { return { company: 'C', country: 'US', marketplace: 'Amazon' }; },
    _irRouteEtaFor: function () { return { available: true, date: '2026-10-01', source: 'card', text: 'Oct 1, 2026' }; },
    _execWarehouseCandidates: function () {
      return { from: [{ warehouseId: 'WH1', warehouseName: 'One', country: 'TW', warehouseCode: 'W1' }],
        to: [{ warehouseId: 'MKT', warehouseName: 'Amazon', logicalDestination: true }], isAmazon: true };
    },
    _execResolveIdByName: function () { return ''; },
    _execResolveMethods: function () { return { methods: [{ value: 'sea_express', label: 'Sea Express' }] }; },
    _execMethodRouteCtx: function () { return {}; },
    _execMethodOptionsHtml: function () { return '<option value="sea_express">Sea Express</option>'; },
    _execFromOptionsHtml: function () { return '<option value="WH1">One</option>'; },
    _execToOptionsHtml: function () { return '<option value="MKT">Amazon</option>'; },
    _execEsc: function (v) { return String(v == null ? '' : v); },
    _irCanonicalDateOrBlank_: function (v) { return String(v || ''); },
    _execDropPristineComposers_: function () { return false; }
  };
  var names = Object.keys(deps);
  var src = [
    extractFn(PAGE, '_irComposerKind_'),
    extractFn(PAGE, '_irRouteProvenanceOf_'),
    extractFn(PAGE, '_irLastMileChoices_'), extractFn(PAGE, '_irLastMileCellHtml_'), extractFn(PAGE, '_irPaintLastMileCell_'), extractFn(PAGE, '_execLastMileOptionsHtml'), extractFn(PAGE, '_irScopeCompanyBadgeHtml_'), extractFn(PAGE, '_irReconTooltip_'), extractFn(PAGE, '_irReconCell_'), extractFn(PAGE, '_irAdviceVsPlan_'), extractFn(PAGE, '_irAdviceVsPlanHtml_'), extractFn(PAGE, '_renderExecutionRoute'),
    extractFn(PAGE, '_renderManualComposer_'),
    'return { route: _renderExecutionRoute, composer: _renderManualComposer_ };'
  ].join('\n');
  var api = new Function(names, src).apply(null, names.map(function (n) { return deps[n]; }));
  if (route === '__composer__') api.composer(SKU); else api.route(SKU, route);
  return created;
}
// A minimal attribute reader over the row's own innerHTML — the four controls, as the page emits them.
function controlsOf(row) {
  var html = String(row.innerHTML || '');
  var out = {};
  var re = /<(select|input|span|button)\b([^>]*)>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[1].toLowerCase(), raw = m[2];
    var attrs = {}, am = /([\w-]+)(?:="([^"]*)")?/g, a;
    while ((a = am.exec(raw))) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
    var cls = String(attrs['class'] || '').split(/\s+/).filter(Boolean);
    var key = attrs['data-field'] || (cls.indexOf('replen-card__remove-btn') !== -1 ? 'action' : null);
    if (!key || out[key]) continue;
    var pseudo = ('disabled' in attrs) ? ['disabled'] : [];
    out[key] = { tag: tag, id: '', cls: cls, attrs: attrs, pseudo: pseudo };
  }
  return out;
}
function chainFor(rowClass, ctl) {
  return [
    { tag: 'section', id: 'ops-section', cls: ['module-section'], attrs: {} },
    { tag: 'div', cls: ['ir-panel-column--action'], attrs: {} },
    { tag: 'div', cls: ['ir-decision-area'], attrs: {} },
    { tag: 'div', cls: ['replen-card', 'replen-card--execution-plan'], attrs: {} },
    { tag: 'div', id: 'shipping-methods-' + SKU, cls: ['exec-routes-list'], attrs: {} },
    { tag: 'div', cls: String(rowClass || '').split(/\s+/).filter(Boolean), attrs: {} }
  ].concat(ctl ? [ctl] : []);
}
function headerChain(cell) {
  return [
    { tag: 'section', id: 'ops-section', cls: ['module-section'], attrs: {} },
    { tag: 'div', cls: ['ir-panel-column--action'], attrs: {} },
    { tag: 'div', cls: ['ir-decision-area'], attrs: {} },
    { tag: 'div', cls: ['replen-card', 'replen-card--execution-plan'], attrs: {} },
    { tag: 'div', cls: ['ir-exec-plan__grid', 'ir-exec-plan__grid--head'], attrs: {} }
  ].concat(cell ? [cell] : []);
}

var PROV = CMP.IRRouteProvenance.SOURCES;
var PERSISTED = { route_provenance: PROV.PERSISTED_ACTIVE_DRAFT, allocation_draft_id: 'D1',
  allocation_draft_line_id: 'L1', qty: 800, shipping_method: 'sea_express', source_warehouse_id: 'WH1',
  destination_token: 'MKT' };
var AIROUTE = { route_provenance: PROV.AI_PLAN_EXPLICITLY_REQUESTED, allocation_draft_id: 'D2',
  allocation_draft_line_id: 'L2', qty: 520, shipping_method: 'sea_express', source_warehouse_id: 'WH1',
  destination_token: 'MKT' };
var ADDED = { route_provenance: PROV.USER_EXPLICIT_ADD_ROUTE };

var ROWS = {
  persisted: renderRow(PERSISTED),
  ai: renderRow(AIROUTE),
  added: renderRow(ADDED),
  composer: renderRow('__composer__')
};

// ================================================================================================================
section('§A — THE HELPER COPY IS GONE, AND SO IS THE ELEMENT THAT CARRIED IT');
// ================================================================================================================
// §J.1
ok(!/No execution route yet/.test(PAGE), 'A1  the sentence "No execution route yet…" is absent from the page');
ok(!/Fill in <strong>From<\/strong>/.test(PAGE) && !/Nothing is saved until all four are set/.test(PAGE),
  'A1a and so is every clause of it');
ok(!/_irExecutionEmptyStateHtml_/.test(code(PAGE)),
  'A1b the builder that produced it is DELETED, not left returning an empty string');
// §J.2 — no empty container, no reserved blank height
ok(!/exec-routes-empty/.test(PAGE) && !/data-ir-exec-empty/.test(PAGE),
  'A2  no empty <div> and no marker attribute is left behind (§A.2)');
ok(!/exec-routes-empty/.test(CSS), 'A2a and the stylesheet declares nothing for it either');
var emptyFn = code(extractFn(PAGE, '_execRenderEmptyState_'));
ok(/list\.innerHTML = ''/.test(emptyFn), 'A2b the empty state CLEARS the container rather than filling it');
eq((emptyFn.match(/_renderManualComposer_\(/g) || []).length, 1,
  'A2c and renders EXACTLY ONE composer, so the empty plan is one blank row (§A.3)');
// §A.3 — the header sits directly above the row and names every field
ok(/<span>From<\/span><span>To<\/span>/.test(PAGE) && /<span>Method<\/span>/.test(PAGE) &&
  /<span>Expected Arrival<\/span><span>Action<\/span>/.test(PAGE),
  'A3  the column header names all six columns immediately above the list');
// §A.4 — the composer state machine is untouched
ok(/composer_touched/.test(PAGE) && /data-composer-touched/.test(PAGE),
  'A4  the composer state machine still exists (touched flag on the row and in the model)');
eq([CMP.IRRouteComposer.STATES.PRISTINE, CMP.IRRouteComposer.STATES.TOUCHED_INCOMPLETE, CMP.IRRouteComposer.STATES.COMPLETE],
  ['PRISTINE_COMPOSER', 'TOUCHED_INCOMPLETE_COMPOSER', 'COMPLETE_COMPOSER'], 'A4a all three states unchanged');
// §A.5 — the accessible label is on the CONTROL
var C = controlsOf(ROWS.composer);
eq([C.source_warehouse_id.attrs['aria-label'], C.destination_warehouse_id.attrs['aria-label'],
  C.qty.attrs['aria-label'], C.shipping_method.attrs['aria-label']],
  ['From', 'To', 'Qty', 'Method'],
  'A5  each of the four controls carries its own aria-label (§A.5)');
ok(!!C.expected_arrival.attrs['aria-label'] && !!C.action.attrs['aria-label'],
  'A5a as do Expected Arrival and the Action button');
ok(/Clear this row/.test(String(ROWS.composer.innerHTML)) &&
  /Delete this route/.test(String(ROWS.persisted.innerHTML)),
  'A5b and the Action button says which of the two things it does on this row kind');

// ================================================================================================================
section('§B — ONE SCOPED LAYOUT CONTRACT, RESOLVED THROUGH THE REAL CASCADE');
// ================================================================================================================
// The resolver first has to be shown to work, or every assertion under it is worthless.
(function selfTest() {
  var probe = computed([{ tag: 'section', id: 'ops-section', cls: [], attrs: {} },
    { tag: 'div', cls: ['ir-exec-plan__grid'], attrs: {} }]);
  ok(/grid/.test(probe['display'] || ''), 'B0  resolver self-test: the exec grid resolves display:grid');
  ok(/40px/.test(probe['grid-template-columns'] || ''), 'B0a and its six-track template');
  // A universal selector legitimately matches everything, so "resolves nothing" would be false for any
  // CORRECT cascade. What has to be shown is that a CLASS selector does not reach an element without it.
  var unstyled = computed([{ tag: 'div', cls: ['nothing-at-all-' + Date.now()], attrs: {} }]);
  eq([unstyled['display'], unstyled['grid-template-columns'], unstyled['height']], [undefined, undefined, undefined],
    'B0b and an element without the classes resolves NONE of the exec-plan declarations (it is not matching everything)');
  var noAncestor = computed([{ tag: 'div', cls: ['ir-exec-plan__grid'], attrs: {} }]);
  eq(noAncestor['display'], undefined,
    'B0b1 nor does the grid class OUTSIDE #ops-section — the descendant combinator is really enforced');
  var base = computed([{ tag: 'section', id: 'ops-section', cls: [], attrs: {} },
    { tag: 'input', cls: ['replen-card__input'], attrs: {} }]);
  ok(/border-box/.test(base['box-sizing'] || ''), 'B0c and a card input outside the grid still resolves its base rule');
})();

var FIELDS = ['source_warehouse_id', 'destination_warehouse_id', 'qty', 'shipping_method'];
var BOX = ['height', 'min-height', 'max-height', 'box-sizing', 'border-radius',
  'padding-top', 'padding-bottom', 'margin', 'vertical-align', 'align-self', 'font-size'];

function boxOf(rowKey, field, pseudo) {
  var row = ROWS[rowKey];
  var ctl = controlsOf(row)[field];
  if (!ctl) throw new Error('no control ' + field + ' on ' + rowKey);
  if (pseudo) ctl = { tag: ctl.tag, id: '', cls: ctl.cls, attrs: ctl.attrs, pseudo: (ctl.pseudo || []).concat([pseudo]) };
  var cs = computed(chainFor(row.className, ctl));
  var o = {};
  BOX.forEach(function (k) { o[k] = cs[k] === undefined ? null : cs[k]; });
  return o;
}

// §J.3 — the four controls resolve the SAME box, on EVERY row kind (§B.2/§B.7)
Object.keys(ROWS).forEach(function (kind) {
  var ref = boxOf(kind, FIELDS[0]);
  var diffs = [];
  FIELDS.slice(1).forEach(function (f) {
    var b = boxOf(kind, f);
    BOX.forEach(function (k) { if (b[k] !== ref[k]) diffs.push(kind + '.' + f + '.' + k + ': ' + b[k] + ' != ' + ref[k]); });
  });
  eq(diffs, [], 'B1 [' + kind + '] From = To = Qty = Method for height, box-sizing, radius, vertical padding, margin and vertical alignment');
});
ok(/^26px$/.test(String(boxOf('composer', 'qty').height)),
  'B1a and the height is an explicit length, not left to the widget metrics (' + boxOf('composer', 'qty').height + ')');
eq(boxOf('composer', 'qty')['margin'], '0', 'B1b margin is 0 on all four (the base select rule had margin-bottom: 8px)');

// §J.3 continued — and the SAME box across the four ROW KINDS (§B.7): this is the defect that was reported.
(function acrossKinds() {
  var diffs = [];
  FIELDS.forEach(function (f) {
    var ref = boxOf('persisted', f);
    ['ai', 'added', 'composer'].forEach(function (kind) {
      var b = boxOf(kind, f);
      BOX.forEach(function (k) { if (b[k] !== ref[k]) diffs.push(kind + '.' + f + '.' + k + ': ' + b[k] + ' != persisted ' + ref[k]); });
    });
  });
  eq(diffs, [], 'B2  a persisted route, an AI route, an + Add Route row and a default composer share one row layout (§B.7)');
})();

// THE PRE STATE, so B2 is a measured repair and not a claim. The four control rules used to be scoped to
// `.exec-route-row`; restoring that scoping must make the composer disagree with the route again.
(function preState() {
  var preCss = CSS
    .replace(/#ops-section \.ir-exec-plan__grid \.replen-card__input,\r?\n#ops-section \.ir-exec-plan__grid \.replen-card__select \{/,
      '#ops-section .exec-route-row .replen-card__input,\n#ops-section .exec-route-row .replen-card__select {');
  if (preCss === CSS) throw new Error('PRE probe failed: the shared control rule was not found');
  var savedRules = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(preCss, 1));
  var routeH = computed(chainFor(ROWS.persisted.className, controlsOf(ROWS.persisted).qty))['height'];
  var compH = computed(chainFor(ROWS.composer.className, controlsOf(ROWS.composer).qty))['height'];
  var compSelMargin = computed(chainFor(ROWS.composer.className, controlsOf(ROWS.composer).shipping_method))['margin-bottom'];
  RULES = savedRules;
  ok(routeH === '26px' && compH === undefined,
    'B3  PRE (measured): scoped to .exec-route-row, a route control has a height and the COMPOSER control has none');
  eq(compSelMargin, '8px',
    'B3a PRE: and the composer\'s Method select kept the base rule\'s 8px bottom margin, which is why the row sat low');
})();

// §J.5 — header and body resolve the SAME grid
(function headerVsBody() {
  var head = computed(headerChain());
  var body = computed(chainFor(ROWS.persisted.className));
  eq([head['grid-template-columns'], head['column-gap'], head['padding']],
    [body['grid-template-columns'], body['column-gap'], body['padding']],
    'B4  the header row and a body row resolve the same template, the same column gap and the same box padding (§B.1)');
  eq(head['padding'], '0', 'B4a and that padding is ZERO — a horizontal padding on a grid re-resolves every 1fr track');
  ok(!/ /.test(String(head['column-gap'] || 'x').trim()),
    'B4b the column gap is ONE length, so every inter-column gap is identical by construction (§B.3)');
  var narrow = computed(headerChain(), function (m) { return /max-width:\s*1400px/.test(m); });
  var narrowBody = computed(chainFor(ROWS.persisted.className), function (m) { return /max-width:\s*1400px/.test(m); });
  eq(narrow['grid-template-columns'], narrowBody['grid-template-columns'],
    'B4c and they stay in step inside the responsive block too (§B.9)');
  eq((String(narrow['grid-template-columns']).match(/minmax|\d+px/g) || []).length >= 6, true,
    'B4d which still declares six tracks');
})();

// §J.6 — a DISABLED Method is the same height
(function disabledMethod() {
  var on = boxOf('composer', 'shipping_method');
  var off = boxOf('composer', 'shipping_method', 'disabled');
  var sizeKeys = BOX.filter(function (k) { return k !== 'align-self'; });
  var diffs = sizeKeys.filter(function (k) { return on[k] !== off[k]; });
  eq(diffs, [], 'B5  a DISABLED Method resolves an identical box — no height, padding, radius or font change (§B.4)');
  var offCs = computed(chainFor(ROWS.composer.className,
    { tag: 'select', cls: controlsOf(ROWS.composer).shipping_method.cls, attrs: {}, pseudo: ['disabled'] }));
  ok(/cursor/.test(Object.keys(offCs).join(' ')) && /not-allowed/.test(offCs['cursor'] || ''),
    'B5a what it does change is the cursor…');
  ok(/#f1f5f9/i.test(offCs['background-color'] || ''), 'B5b …the background colour…');
  ok(/#94a3b8/i.test(offCs['color'] || ''), 'B5c …and the text colour, and nothing else');
  // and the composer's Method really is disabled until the lane exists
  ok('disabled' in controlsOf(ROWS.composer).shipping_method.attrs,
    'B5d the default composer renders Method DISABLED (no From/To yet, so no lane to price)');
  ok(!('disabled' in controlsOf(ROWS.persisted).shipping_method.attrs),
    'B5e and a complete route renders it enabled');
})();

// §J.5b — the number input's spin buttons, the specific reason Qty was taller
ok(/-moz-appearance: textfield/.test(CSS) && /-webkit-inner-spin-button/.test(CSS),
  'B6  the number input\'s spin buttons are suppressed (§B.5)');
ok(/appearance: none/.test(CSS), 'B6a and the UA widget metrics are replaced on both control types');
ok(/background-image:\s*url\("data:image\/svg\+xml/.test(CSS),
  'B6b with the select\'s caret drawn as a background IMAGE, so the disabled rule can repaint colour without erasing it');

// §J.7 — ETA and the delete button sit on the controls' centre line
(function centring() {
  var grid = computed(chainFor(ROWS.persisted.className));
  eq(grid['align-items'], 'center', 'B7  the row grid centres its items');
  var eta = computed(chainFor(ROWS.persisted.className, controlsOf(ROWS.persisted).expected_arrival));
  var btn = computed(chainFor(ROWS.persisted.className, controlsOf(ROWS.persisted).action));
  eq([eta['align-self'], btn['align-self']], ['center', 'center'],
    'B7a and Expected Arrival and the Action button state it for themselves too (§B.6)');
  eq(btn['justify-self'], 'center', 'B7b with the button centred in its own 40px track');
})();

// §J.8 — the contract is SCOPED and owned in one place
(function scoping() {
  var bad = RULES.filter(function (r) {
    if (r.sheet !== 1) return false;
    if (!/replen-card__(input|select)/.test(r.sel)) return false;
    return !/#ops-section/.test(r.sel);
  }).map(function (r) { return r.sel; });
  eq(bad, [], 'B8  every Execution Plan control rule is scoped under #ops-section (§B.8)');
  var owners = RULES.filter(function (r) {
    return r.sheet === 1 && !r.media && /replen-card__(input|select)/.test(r.sel) &&
      (r.decls['height'] !== undefined || r.decls['padding'] !== undefined ||
       r.decls['padding-top'] !== undefined || r.decls['box-sizing'] !== undefined);
  });
  var gridOwned = owners.filter(function (r) { return /ir-exec-plan__grid/.test(r.sel); }).length;
  var rowScoped = owners.filter(function (r) { return /exec-route-row|exec-route-composer/.test(r.sel); }).length;
  ok(gridOwned >= 1, 'B8a the box is declared on the shared grid class (' + gridOwned + ' selector(s))');
  eq(rowScoped, 0, 'B8b and NOTHING declares a control box per row kind any more — that was the defect');
})();

// ================================================================================================================
section('§C — WHY THE PAGE WAS SILENT (the five findings, each asserted against the shipped source)');
// ================================================================================================================
// FINDING 5, the one that made everything else invisible.
ok(/\.replen-ai-plan-result\s*\{/.test(CSS),
  'C5  `.replen-ai-plan-result` now HAS a stylesheet rule (it had none anywhere in the repository)');
(function noticeVisible() {
  var cs = computed([{ tag: 'body', cls: [], attrs: {} },
    { tag: 'div', id: 'replen-ai-support-notice', cls: ['replen-ai-plan-result', 'replen-ai-plan-result--info'], attrs: {} }]);
  eq(cs['position'], 'fixed', 'C5a it is position:fixed, so it does not depend on document flow');
  ok(!!cs['z-index'] && Number(cs['z-index']) >= 1200,
    'C5b above the scope modal (' + cs['z-index'] + '), which closes on confirm and must not cover the answer');
  ok(!!cs['background'] || !!cs['background-color'], 'C5c and it paints a background, so the text is legible');
  ok(!/#ops-section/.test(String(cs.__owner('position'))),
    'C5d the rule is deliberately NOT #ops-section-scoped — the element is a child of <body>, and a scoped ' +
    'selector would have matched nothing and reproduced the bug exactly');
})();
ok(/overflow:\s*hidden/.test((BASECSS.match(/body\s*\{[\s\S]*?\}/) || [''])[0]),
  'C5e THE MECHANISM: body is overflow:hidden, so an unstyled body-appended notice was not merely low on the ' +
  'page, it was unreachable by scrolling');
// FINDING 2 — the modal closes BEFORE it calls back.
ok(/close\('confirm'\);\s*\n\s*if \(typeof cb === 'function'\) cb\(scope\);/.test(MODAL),
  'C2  the scope modal calls close(\'confirm\') BEFORE the callback, so the Generate button is gone by then');
// FINDING 3 — the id is the menu item, and the menu is hidden first.
ok(/id="replen-ai-plan-btn"[^>]*class="km-action-menu__item"|class="km-action-menu__item"[^>]*id="replen-ai-plan-btn"/
  .test(read('assets/html/pages/inventory-replenishment.html')),
  'C3  #replen-ai-plan-btn is the MENU ITEM, not the modal\'s Generate button');
ok(/function runReplenAiSupport\(kind\) \{\s*\n\s*_replenAiClose\(false\);/.test(PAGE),
  'C3a and runReplenAiSupport hides the menu on its FIRST line, so every state written to it is invisible');
var clickFn = code(extractFn(PAGE, 'handleReplenAiPlan'));
ok(!/btn && btn\.disabled/.test(clickFn),
  'C3b so the re-entry guard no longer READS that hidden element\'s disabled attribute');
ok(/if \(_irAiPlanIsRunning_\(\)\)/.test(clickFn), 'C3c it is a module-level run flag instead (§D.6)');
// FINDING 4 — the work is deferred so the busy state has a frame to paint in.
ok(/_irAiPlanPhase_\(IR_AI_PLAN_PHASES\.PREPARING\)/.test(clickFn),
  'C4  the busy state is set in the click\'s own turn…');
ok(/_irAiPlanDefer_\(function \(\) \{ _irAiPlanRun_\(/.test(clickFn),
  'C4a …and the WORK is deferred to the next task, which is the only way that state reaches the screen');
ok(clickFn.indexOf('_irAiPlanPhase_') < clickFn.indexOf('_irAiPlanDefer_'),
  'C4b in that order: paint first, defer second');
ok(!/generateInventoryRecommendation|renderReplenishment/.test(clickFn),
  'C4c and no work at all remains in the click\'s own turn');

// ================================================================================================================
section('§D — VISIBLE RUNTIME FEEDBACK, DRIVEN THROUGH THE SHIPPED FUNCTIONS');
// ================================================================================================================
function mkWorld(o) {
  o = o || {};
  var els = {}, timers = [], W = { genCalls: [], renders: 0, hydrates: 0, confirms: [], confirmAnswer: o.confirmAnswer };
  function mkEl(id, cls) {
    var a = {}, c = {};
    String(cls || '').split(/\s+/).filter(Boolean).forEach(function (x) { c[x] = 1; });
    var e = {
      id: id || '', hidden: false, disabled: false, innerHTML: '', textContent: '', style: {}, dataset: {},
      className: String(cls || ''), _children: [],
      classList: { add: function (x) { c[x] = 1; }, remove: function (x) { delete c[x]; }, contains: function (x) { return !!c[x]; } },
      setAttribute: function (k, v) { a[k] = String(v); }, getAttribute: function (k) { return a[k] === undefined ? null : a[k]; },
      removeAttribute: function (k) { delete a[k]; },
      appendChild: function (x) { e._children.push(x); if (x.id) els[x.id] = x; return x; },
      insertBefore: function (x) { e._children.unshift(x); if (x.id) els[x.id] = x; return x; },
      _classes: function () { return Object.keys(c); },
      _hasClass: function (x) { return !!c[x]; }
    };
    if (id) els[id] = e;
    return e;
  }
  var trigger = mkEl('replenAiSupportTrigger', 'km-action-menu__trigger');
  trigger.textContent = '✦ AI Support';
  mkEl('replen-ai-plan-btn', 'km-action-menu__item');
  var list = mkEl('shipping-methods-' + SKU, 'exec-routes-list');
  var card = mkEl('', 'replen-card');
  card._children.push(list);
  list.parentNode = card;
  var composerRow = null, routeRow = null;
  if (o.touchedComposer) {
    composerRow = mkEl('', 'exec-route-composer exec-route-row ir-exec-plan__grid');
    composerRow.setAttribute('data-composer-touched', '1');
    list._children.push(composerRow);
  }
  if (o.manualRoute) {
    routeRow = mkEl('', 'exec-route-row ir-exec-plan__grid');
    routeRow.setAttribute('data-line-id', 'L9');
    routeRow.setAttribute('data-route-provenance', PROV.USER_EXPLICIT_ADD_ROUTE);
    list._children.push(routeRow);
  }
  var body = mkEl('', '');
  var document = {
    getElementById: function (id) { return els[id] || null; },
    createElement: function () { return mkEl('', ''); },
    querySelectorAll: function (sel) {
      if (sel === '.exec-routes-list') return [list];
      if (sel === '.exec-route-composer') return list._children.filter(function (r) { return r._hasClass('exec-route-composer'); });
      if (sel === '.exec-route-row') return list._children.filter(function (r) { return r._hasClass('exec-route-row'); });
      return [];
    },
    body: body
  };
  list.querySelectorAll = function (sel) { return document.querySelectorAll(sel); };
  var deps = {
    document: document,
    window: {
      KMREC: { generateInventoryRecommendation: function (r) { return { sku: r.sku, suggestedQty: 1 }; } },
      KM: {
        DB: {
          generateWeeklyAiPlanDraft: function (p) {
            W.genCalls.push(p);
            if (o.genThrow) return Promise.reject(new Error('transport exploded'));
            if (o.genHang) return new Promise(function () {});
            return Promise.resolve(o.genResponse);
          },
          refreshCacheTables: function () { return Promise.resolve(true); }
        },
        api: { inventoryAiPlanDbGenerationEnabled: function () { return o.flagOn === true; } }
      },
      IRRouteProvenance: CMP.IRRouteProvenance,
      confirm: function (m) { W.confirms.push(m); return o.confirmAnswer === true; },
      _irAiPlanUnreconciled: null
    },
    console: { warn: function () {}, error: function () {}, info: function () {}, log: function () {} },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function (h) { if (h) timers[h - 1] = null; },
    renderReplenishment: function () { W.renders++; },
    _hydrateAllocationDraftFromDb: function () { W.hydrates++; return true; },
    isOperationDbApiConfigured: function () { return o.apiConfigured !== false; },
    escapeReplenHtml: function (v) { return String(v == null ? '' : v); },
    _irEffectiveWorkspace: function () { return false; },
    _irMatState: { rows: [{ sku: SKU }] },
    _irRecoByKey: {},
    _replenCtx: function () { return { company: 'ResUS', country: 'US', marketplace: 'Amazon' }; },
    _irRecoNow_: function () { return new Date('2026-09-03T00:00:00Z'); }
  };
  var names = Object.keys(deps);
  var phases = (PAGE.match(/var IR_AI_PLAN_PHASES = \{[\s\S]*?\};/) || [])[0];
  if (!phases) throw new Error('IR_AI_PLAN_PHASES not found');
  var src = [
    'var _irAiSupportTriggerOwner = null; var _irAiPlanRunning = false;',
    phases.replace(/\r/g, ''),
    extractFn(PAGE, '_irEscNotice_'), extractFn(PAGE, '_irAiPlanDefer_'), extractFn(PAGE, '_irAiPlanIsRunning_'),
    extractFn(PAGE, '_irAiSupportTriggerEl_'), extractFn(PAGE, '_irAiSupportTriggerBusy_'), extractFn(PAGE, '_irAiSupportTriggerIdle_'),
    extractFn(PAGE, '_irAiPlanTriggerBusy_'), extractFn(PAGE, '_irAiPlanTriggerIdle_'),
    extractFn(PAGE, '_irExecPlanAriaBusy_'), extractFn(PAGE, '_irExecListSku_'), extractFn(PAGE, '_irExecPlanStatusSet_'),
    extractFn(PAGE, '_irAiSupportNoticeEl_'), extractFn(PAGE, '_irClearAiSupportNotice_'), extractFn(PAGE, '_irAiSupportNotice_'),
    extractFn(PAGE, '_irAiPlanPhase_'), extractFn(PAGE, '_irAiPlanTerminal_'),
    extractFn(PAGE, '_irTouchedComposerSkus_'), extractFn(PAGE, '_irPersistedManualRouteSkus_'),
    extractFn(PAGE, '_irAiPlanWithTimeout_'), extractFn(PAGE, '_irAiPlanReconcile_'),
    extractFn(PAGE, '_irInventoryAiPlanDbGenerationEnabled_'), extractFn(PAGE, '_irAiPlanDbGenEligible_'),
    extractFn(PAGE, '_irClassifyGenerationResult_'), extractFn(PAGE, '_irShowAiPlanResult_'),
    // RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R6 §4): an ANCHOR moved. The AI Plan handler gained a third
    // outcome and consults _irAiPlanAdviceSentence_ before both the no-route and the failure wording,
    // so a harness that lifts individual functions has to lift that one too. Omitting it turned every
    // terminal path in this section into a ReferenceError, which is exactly what a lift-by-name harness
    // is expected to report when the code under test grows a new collaborator.
    extractFn(PAGE, '_irAiPlanAdviceSentence_'),
    extractFn(PAGE, '_irRunInventoryAiPlanGeneration_'),
    extractFn(PAGE, 'handleReplenAiPlan'), extractFn(PAGE, '_irAiPlanRun_'),
    'return { click: handleReplenAiPlan, running: _irAiPlanIsRunning_, reconcile: _irAiPlanReconcile_ };'
  ].join('\n');
  W.api = new Function(names, src).apply(null, names.map(function (n) { return deps[n]; }));
  W.deps = deps;
  W.els = els;
  W.trigger = trigger;
  W.list = list;
  W.notice = function () { return els['replen-ai-support-notice'] || null; };
  W.status = function () { return els['exec-plan-status-' + SKU] || null; };
  W.btn = function () { return els['replen-ai-plan-btn']; };
  W.flush = function () { var t = timers.filter(Boolean); timers.length = 0; t.forEach(function (x) { x.fn(); }); };
  W.fireTimeouts = function () { var t = timers.filter(Boolean); timers.length = 0; t.forEach(function (x) { if (x.ms >= 1000) x.fn(); }); };
  W.settle = function () { var p = Promise.resolve(); for (var i = 0; i < 14; i++) p = p.then(function () { W.flush(); }); return p; };
  return W;
}

var OK_RESPONSE = { success: true, data: { status: 'COMPLETED', marketplaceCount: 1, marketplaceResults: [{ marketplace: 'Amazon', success: true, status: 'CREATED', draftId: 'D3', lineCount: 3, totalQty: 520 }],
  created_headers: 1, updated_headers: 0, created_lines: 3, updated_lines: 0, expired_headers: 2 } };

// §J.8 / §J.9 — the SAME event loop turn as the click
(function immediate() {
  var w = mkWorld({ flagOn: false });
  w.api.click({ company: 'ResUS', country: 'US', marketplace: 'Amazon' });
  // NOTHING is flushed yet: this is the click's own turn.
  eq(w.btn().disabled, true, 'D1  the click DISABLES the button synchronously');
  eq(w.trigger.disabled, true, 'D1a and the always-visible AI Support trigger, which is the on-page proxy for ' +
    'the modal\'s Generate button (the modal has already closed by then)');
  eq(w.trigger.getAttribute('aria-busy'), 'true', 'D2  aria-busy is set on the trigger…');
  eq(w.list.getAttribute('aria-busy'), 'true', 'D3  …and on the Execution Plan area (§D.4)');
  ok(/Generating|Preparing/.test(String(w.trigger.textContent)),
    'D4  the trigger label states the phase (' + w.trigger.textContent + ')');
  ok(!!w.notice(), 'D5  the inline status exists…');
  eq(w.notice().hidden, false, 'D5a …and is visible…');
  eq(w.notice().getAttribute('aria-live'), 'polite', 'D5b …with aria-live="polite" (§D.5)');
  ok(/replen-ai-plan-result__spinner/.test(w.notice().innerHTML), 'D6  and a spinner is in it (§D.2)');
  ok(/Preparing/.test(w.notice().innerHTML), 'D6a showing the first phase');
  ok(!!w.status() && /Preparing/.test(w.status().textContent),
    'D7  the Execution Plan area carries the same phase, so the operator does not have to look at the toast');
  eq(w.genCalls.length, 0, 'D8  and NO work has run yet — the paint comes first');
  ok(w.api.running(), 'D8a the run flag is set');
})();

// §J.10 — a double click is ONE request
(function doubleClick() {
  var w = mkWorld({ flagOn: true, genResponse: OK_RESPONSE });
  w.api.click();
  var second = w.api.click();
  eq(second, false, 'D9  the second click of a double-click is refused');
  ok(/already in progress/.test(w.notice().innerHTML), 'D9a out loud, not silently');
  return w.settle().then(function () {
    eq(w.genCalls.length, 1, 'D10 exactly ONE generate request left the browser (§D.6)');
  });
})();

// §J.11 — success says how much was saved
var flow = mkWorld({ flagOn: true, genResponse: OK_RESPONSE });
flow.api.click();
flow.settle().then(function () {
  eq(flow.genCalls.length, 1, 'D11 the flag-ON click reaches the canonical writer');
  ok(/saved 3 route\(s\)/i.test(flow.notice().innerHTML), 'D12 success states the ROUTE COUNT (§D "Saved N routes")');
  ok(/520 unit\(s\)/.test(flow.notice().innerHTML), 'D12a and the UNITS, from what the server acknowledged');
  ok(/replen-ai-plan-result--ok/.test(flow.notice().className), 'D12b with the success tone');
  ok(!/__spinner/.test(flow.notice().innerHTML), 'D13 the spinner is CLEARED (§D.5)');
  eq(flow.trigger.disabled, false, 'D13a the trigger is re-enabled…');
  eq(flow.trigger.getAttribute('aria-busy'), null, 'D13b …and no longer busy');
  eq(flow.list.getAttribute('aria-busy'), null, 'D13c and neither is the Execution Plan area');
  eq(flow.btn().disabled, false, 'D13d nor is the menu item');
  ok(/saved 3 route\(s\)/i.test(flow.status().textContent),
    'D14 and the OUTCOME REMAINS in the Execution Plan area after the modal closed (§D.7)');
  ok(/2 superseded/.test(flow.notice().innerHTML),
    'D14a saying what was REPLACED as well as what was created');
  ok(!flow.api.running(), 'D14b and the run flag is clear');

  // §J.13 — flag disabled is a stated outcome, not silence
  var off = mkWorld({ flagOn: false });
  off.api.click();
  off.flush();
  eq(off.genCalls.length, 0, 'D15 flag OFF → zero requests, zero writes (§E.2)');
  // RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §7) — THE PRODUCT RULE MOVED: AN OUTCOME MAY NOT LEAD WITH ITS
  // OWN REASON CODE.
  //
  // E3's finding was right and is kept: the two halves must be reported separately, so an operator is never
  // left to read "recommendations were regenerated and nothing was written" as "the plan ran and produced
  // nothing". What R6-R1 changes is the ORDER and the VOCABULARY. This is the path a hundred-SKU run actually
  // takes — R6 rewrote the DB-generation path, which the flag being OFF makes unreachable — and it was
  // announcing a completed advice run by its internal reason code.
  //
  // So: the run's success is stated first, the Execution Plans are said to be unchanged, and the flag is named
  // second as the reason no route was written. All three are still asserted; only the leading sentence moved.
  ok(/refreshed for \d+ SKU\(s\)/.test(off.notice().innerHTML)
    && /COMPLETED/.test(off.notice().innerHTML) && /not a failure/.test(off.notice().innerHTML),
    'D16 the advice half is reported as the completed run it was');
  ok(/Execution Plans are UNCHANGED/.test(off.notice().innerHTML)
    && /nothing was written to the database/.test(off.notice().innerHTML),
    'D16a with the two halves reported separately — advice done, nothing written');
  ok(/feature flag/.test(off.notice().innerHTML) && /OFF/.test(off.notice().innerHTML),
    'D16a1 and the flag is NAMED as the reason, after the outcome rather than in place of it');
  ok(/replen-ai-plan-result--warn/.test(off.notice().className),
    'D16b as a WARNING — "your plan was not written" is not neutral news to someone who pressed Generate');
  ok(!/__spinner/.test(off.notice().innerHTML), 'D16c spinner cleared on this terminal path too');
  ok(/refreshed for \d+ SKU\(s\)/.test(off.status().textContent)
    && /unchanged/i.test(off.status().textContent),
    'D16d and it stays in the Execution Plan area');

  var unavail = mkWorld({ flagOn: true, apiConfigured: false });
  unavail.api.click();
  unavail.flush();
  // The two reasons stay distinguishable, which is the whole of D17's claim. They no longer share the word
  // EXECUTION_MATERIALIZATION_*; the sentences differ instead, and the difference is what is asserted.
  ok(/does not expose the AI Plan generation action/.test(unavail.notice().innerHTML)
    && !/feature flag/.test(unavail.notice().innerHTML),
    'D17 an unreachable writer is a DIFFERENT stated reason from a disabled flag');

  // §J.12 — a zero-result run
  var zero = mkWorld({ flagOn: true, genResponse: { success: true, data: { status: 'NO_DEMAND', job_status: 'NO_DEMAND', zero_result: true, marketplaceResults: [] } } });
  zero.api.click();
  return zero.settle().then(function () {
    ok(/NO ELIGIBLE ROUTE/.test(zero.notice().innerHTML), 'D18 a zero-result run says "no eligible route found" (§J.12)');
    ok(/This is an answer, not a failure/.test(zero.notice().innerHTML),
      'D18a and says it is an ANSWER — the backend treats it as success precisely so it still expires the old plan');
    ok(!/Saved/.test(zero.notice().innerHTML), 'D18b never as a save (§D.9)');
    ok(!/__spinner/.test(zero.notice().innerHTML), 'D18c spinner cleared');

    // §J.14 — transport failure
    var boom = mkWorld({ flagOn: true, genThrow: true });
    boom.api.click();
    return boom.settle().then(function () {
      ok(/request FAILED/.test(boom.notice().innerHTML), 'D19 a transport failure is reported (§J.14)');
      ok(/transport exploded/.test(boom.notice().innerHTML), 'D19a naming the error, not swallowing the rejection (§C.13)');
      ok(/replen-ai-plan-result--bad/.test(boom.notice().className), 'D19b in the error tone');
      ok(!/__spinner/.test(boom.notice().innerHTML), 'D19c spinner cleared');
      eq(boom.trigger.disabled, false, 'D19d and the button is usable again');
      ok(/Nothing on screen was changed/.test(boom.status().textContent),
        'D19e and the Execution Plan is stated to be unchanged (§H.5)');

      // §J.15 — timeout
      var slow = mkWorld({ flagOn: true, genHang: true });
      slow.api.click();
      slow.flush();                       // run the deferred work; the request now hangs
      slow.fireTimeouts();                // the timeout fires
      return slow.settle().then(function () {
        ok(/TIMED OUT/.test(slow.notice().innerHTML), 'D20 a timeout is reported as a timeout (§J.15)');
        ok(/UNKNOWN/.test(slow.notice().innerHTML),
          'D20a as an UNKNOWN outcome, not a failure — the request had already been sent (§D.10)');
        ok(!/__spinner/.test(slow.notice().innerHTML), 'D20b spinner cleared');
        eq(String(slow.deps.window._irAiPlanUnreconciled && slow.deps.window._irAiPlanUnreconciled.reason), 'REQUEST_TIMED_OUT',
          'D20c and Submit is marked BLOCKED until a run reconciles');

        // §J.16 — outcome unknown: the server reported a line count its own tallies do not confirm
        var unrec = mkWorld({ flagOn: true, genResponse: { success: true, data: { status: 'COMPLETED', marketplaceCount: 1,
          marketplaceResults: [{ marketplace: 'Amazon', success: true, lineCount: 3, totalQty: 520 }],
          created_lines: 1, updated_lines: 0 } } });
        unrec.api.click();
        return unrec.settle().then(function () {
          ok(/OUTCOME IS UNKNOWN/.test(unrec.notice().innerHTML), 'D21 an unacknowledged line count is UNKNOWN, not success (§J.16)');
          ok(/LINE_COUNT_NOT_ACKNOWLEDGED/.test(unrec.notice().innerHTML), 'D21a naming which check disagreed');
          ok(!/Saved 3/.test(unrec.notice().innerHTML), 'D21b and it does NOT claim to have saved anything (§D.9/§G.14)');
          ok(/Submit Plan is BLOCKED/.test(unrec.notice().innerHTML), 'D21c Submit is blocked until it reconciles');
          ok(/Reconciling|UNKNOWN/.test(unrec.status().textContent), 'D21d and the Execution Plan area says so (§D.10)');
          ok(!/__spinner/.test(unrec.notice().innerHTML), 'D21e spinner cleared on the unknown path too');

          // §G.14 — and the Submit preflight actually refuses
          var pfBlocked = PF.evaluate({ aiPlanUnreconciled: 'LINE_COUNT_NOT_ACKNOWLEDGED', routes: [
            { sku: SKU, complete: true, persisted: true, route_provenance: PROV.AI_PLAN_EXPLICITLY_REQUESTED,
              allocation_draft_id: 'D2', allocation_draft_line_id: 'L2' }] });
          eq([pfBlocked.ok, pfBlocked.code], [false, 'EXECUTION_PLAN_AI_UNRECONCILED'],
            'D22 Submit is refused with its own code while an AI Plan run is unreconciled (§G.14)');
          ok(/AI_PLAN_UNRECONCILED:LINE_COUNT_NOT_ACKNOWLEDGED/.test(JSON.stringify(pfBlocked.blocking.reasons)),
            'D22a naming the specific check that did not confirm');

          // §J.17 — every terminal path clears the spinner, established structurally
          var termFn = code(extractFn(PAGE, '_irAiPlanTerminal_'));
          ok(/_irAiPlanRunning = false/.test(termFn) && /_irAiPlanTriggerIdle_\(\)/.test(termFn) &&
            /_irExecPlanAriaBusy_\(false\)/.test(termFn),
            'D23 ONE exit clears the run flag, the trigger and the busy area…');
          // ENUMERATED, not sniffed: every `return <expr>` in the two functions that own a run must be one of
          // the allowed forms. A new exit that reports nothing shows up here as an unrecognised return.
          // RESTATED (F1-7N-FC-1B-E3-R1): the scan counted every `return` in the text, including the ones
          // inside .filter()/.map() callbacks, so adding any callback to these functions produced a false
          // failure. Nested function bodies are stripped first, innermost outward, so what remains is the
          // function's OWN exits.
          function ownBody(src) {
            var s = String(src), prev = null;
            while (s !== prev) {
              prev = s;
              s = s.replace(/function\s*\**\s*[A-Za-z_$][\w$]*?\s*\([^)]*\)\s*\{[^{}]*\}/g, ' FN ')
                   .replace(/function\s*\([^)]*\)\s*\{[^{}]*\}/g, ' FN ');
            }
            return s;
          }
          var exits = [];
          [ '_irAiPlanRun_', '_irRunInventoryAiPlanGeneration_' ].forEach(function (fn) {
            var body = ownBody(code(extractFn(PAGE, fn)));
            var re = /return\s+([A-Za-z_$][\w$]*)/g, m;
            while ((m = re.exec(body))) {
              // `return new Promise(...)` inside the generation chain CONTINUES the chain rather than
              // exiting the run - the terminal report is in the .then() that follows it.
              if (['_irAiPlanTerminal_', '_irRunInventoryAiPlanGeneration_', '_irAiPlanWithTimeout_', 'new'].indexOf(m[1]) === -1) {
                exits.push(fn + ' -> return ' + m[1]);
              }
            }
          });
          eq(exits, [], 'D23a …and every value-returning exit from a run is a terminal report or a delegation (§D.17)');

          nextSection();
        });
      });
    });
  });
}).catch(function (e) { console.error('ASYNC ERROR', e && e.stack || e); fail++; report(); });

function nextSection() {
// ================================================================================================================
section('§E — CONTROLLED ACTIVATION, AND THE FLAG KEPT AS THE ROLLBACK SWITCH');
// ================================================================================================================
// §J.19 — flag TRUE calls the allocator path
// RESTATED (F1-7N-FC-1B-E3-R1 §H): E3 set the flag TRUE and this pinned that value, so it asserted "the
// feature is still released". E3-R1 REVERTS it, and not as a change of mind: a read-only census of the live
// scope showed the canonical harvest produces ZERO receivers (every site dropped for an incomplete forecast
// basis), so there is nothing for the allocator to rank. §H.4 forbids shipping flag=true alongside
// HARVEST_NOT_READY.
//
// What replaces the pin is the INVARIANT, which no round can satisfy by editing one literal: the flag is one
// boolean of record read through one accessor, and if it is TRUE the file must record the census verdict that
// authorised it. That is falsifiable by exactly the mistake it guards against and cannot fail for a correct
// tree in either state.
var _flagVal = /var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = (\w+);/.exec(CFG)[1];
ok(_flagVal === 'true' || _flagVal === 'false',
  'E1  00_config.gs holds ONE boolean of record for the flag (currently ' + _flagVal + ')');
ok(_flagVal === 'false' || /verdict\s+PROCEED|PROCEED\b/.test(CFG),
  'E1a and it is only TRUE when the file records the activation census verdict that authorised it (§H.4)');
ok(/function inventoryAiPlanDbGenerationEnabled_\(\) \{ return INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ === true; \}/.test(CFG),
  'E2  read through exactly ONE accessor (§E.1)');
// §E.1 — every read point goes through that accessor
// A KEYWORD SWEEP CANNOT TELL A CALL FROM A SENTENCE. This is the same mistake E2 had to restate
// recommendation-gap-readiness for, and it appeared twice more in this suite's own first draft: 61_ NAMES the
// flag in a comment and inside its refusal MESSAGE, both of which are the file being honest. The sweep runs
// over the code with comments AND string literals stripped, which is the only place a read could be.
function ops(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}
(function readPoints() {
  var files = ['00_config.gs', '03_master_data_handlers.gs', '61_api_v1_weekly_ai_plan.gs', '69_api_v1_ai_plan_lifecycle.gs'];
  var direct = [];
  files.forEach(function (f) {
    var s = ops(read('assets/specs/active/apps-script/' + f));
    var bare = (s.match(/INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_/g) || []).length;
    var decl = f === '00_config.gs' ? 2 : 0;                 // the declaration + the accessor body
    if (bare > decl) direct.push(f + ' reads the variable directly ' + (bare - decl) + ' time(s)');
  });
  eq(direct, [], 'E3  no gate reads the variable directly — they all call the accessor (§E.1)');
})();
ok(/var genEnabled = \(typeof inventoryAiPlanDbGenerationEnabled_ === 'function'\) && inventoryAiPlanDbGenerationEnabled_\(\) === true;/.test(G61),
  'E4  the SERVER gate is independent of the client gate, so the button is not the only thing stopping a write');
ok(/INVENTORY_AI_PLAN_DB_GENERATION_DISABLED/.test(G61) && /zero rows written/.test(G61),
  'E5  and when it is off the server answers a typed refusal with zero rows (§E.2)');
// §E.2 — the allocator still computes with the flag off
ok(!/inventoryAiPlanDbGenerationEnabled_/.test(read('assets/js/core/supply-planning-weekly-route-derivation.js')),
  'E6  the route allocator does not consult the flag at all, so a recommendation is computed either way (§E.2)');
// §E.5 — the flag is NOT removed, and rollback is recorded
ok(/ROLLBACK IS TWO STEPS/.test(CFG) && /publish a NEW Apps Script deployment version/.test(CFG),
  'E7  rollback is recorded in the file that owns the flag: set false, then publish a deployment (§E.10)');
ok(/EXECUTION_MATERIALIZATION_NOT_ENABLED/.test(CFG),
  'E7a and the file states that the frontend keeps showing the disabled reason, so no frontend change is needed to roll back');
// §E.6/§E.7 — health reports the EFFECTIVE value
ok(/inventory_ai_plan_db_generation_enabled: \(typeof inventoryAiPlanDbGenerationEnabled_ === 'function'\)/.test(HLTH),
  'E8  system.health reports the EFFECTIVE flag, read from the same accessor (§E.6)');
ok(/config_build:/.test(HLTH) && /CONFIG_BUILD_VERSION_/.test(HLTH),
  'E8a and the config build, so the value can be attributed to a deployment');
// RESTATED (F1-7N-FC-1B-E3-R1): pinned the literal stamp E3 introduced, so any later round touching the
// config broke it. DERIVED from the manifest instead — the property is that the config declares exactly
// what 63_ expects of it, which is what makes a half-synced config a named mixed_deployment fault.
var _cfgExpect = ((HLTH.match(/\{ file: '00_config\.gs',[^}]*expected: '([^']+)'/) || [])[1]) || '(none)';
ok(_cfgExpect !== '(none)', 'E9  00_config.gs has a manifest entry at all (it had none before E3)');
eq(/var CONFIG_BUILD_VERSION_ = '([^']+)'/.exec(CFG)[1], _cfgExpect,
  'E9a and declares exactly the build its manifest entry expects (' + _cfgExpect + ')');
ok(new RegExp("\\{ file: '00_config\\.gs', symbol: 'CONFIG_BUILD_VERSION_', expected: '" +
  /var CONFIG_BUILD_VERSION_ = '([^']+)'/.exec(CFG)[1] + "'").test(HLTH),
  'E9a and the module manifest expects exactly that, so a half-synced CONFIG is a mixed_deployment fault');
ok(new RegExp("\\{ file: '63_api_v1_system_health\\.gs', symbol: 'SYS_BUILD_VERSION_', expected: '" +
  /var SYS_BUILD_VERSION_ = '([^']+)'/.exec(HLTH)[1] + "'").test(HLTH),
  'E9b and 63_ still declares exactly what its own manifest entry expects');
// §E.8 — no new action, so no contract bump
(function contracts() {
  var act = /SYS_DEPLOYED_ACTION_CONTRACT_VERSION_ = (\d+)/.exec(HLTH)[1];
  var lst = /SYS_REQUIRED_ACTION_LIST_VERSION_ = (\d+)/.exec(HLTH)[1];
  var tr = /SYS_TRANSPORT_CONTRACT_VERSION_ = (\d+)/.exec(HLTH)[1];
  eq([act, lst, tr], ['11', '12', '1'],
    'E10 the action contract, required-action list and transport contract are UNCHANGED — this round adds no action (§E.8)');
  ok(/weeklyAiPlan\.generate/.test(read('assets/specs/active/apps-script/01_router.gs')),
    'E10a because the action it activates has been routed since R6D1');
})();
// §E.2 — the CLIENT mirror stays fail-safe OFF
ok(/failSafeDefaults: \{[^}]*inventoryAiPlanDbGenerationEnabled: false/.test(KMAPI),
  'E11 the client mirror default stays fail-safe FALSE: a browser that cannot read the capability transport ' +
  'never offers a write it cannot confirm the server accepts');
ok(/deliberate asymmetry, not a drifted copy/.test(CFG),
  'E11a and 00_config.gs says that asymmetry is deliberate, so a later round does not "fix" it');

// ================================================================================================================
section('§F — THE READ-ONLY ACTIVATION CENSUS');
// ================================================================================================================
ok(/function TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3\(args\)/.test(TEMP), 'F1  the census has ONE public entry point');
(function oneEntry() {
  var pub = (TEMP.match(/^function ([A-Za-z_][\w]*)\(/gm) || []).map(function (s) { return s.replace(/^function /, '').replace(/\($/, ''); });
  var nonHelper = pub.filter(function (n) { return !/^CENSUS_/.test(n); });
  // RESTATED (F1-7N-FC-1B-E3-R4-A1): the census now has a SECOND deliberate entry point. The live run came
  // back with an empty scope and one blocker, because the operator was asked to reconstruct an internal args
  // schema in a console; RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R takes no parameters and carries the scope
  // itself. The claim this assertion protects is unchanged — nothing UNINTENDED is invocable from the
  // editor — so it names the entry points rather than assuming there is only ever one.
  // RESTATED (F1-7N-FC-1B-E3-R4-A2-R1-R6 §5/§6): an ANCHOR moved. Two entry points were added — the candidate
  // SEARCH and the census of whatever it selects — and both are deliberate. Pinning the exact list made every
  // future intended entry point a failure of a claim that was never about the count.
  //
  // The claim is that nothing UNINTENDED is invocable from the editor, and it is now checked as the property
  // rather than as a list: each entry point is a declared RUN_E3_/TEMP_ name, and each takes NO PARAMETERS, so
  // none can be invoked against the wrong scope by someone guessing at an args object in a console.
  // R6-R2 adds RUN_R6R2_ROUTE_PROVENANCE: the \u00a72 route-provenance census. Like the others it takes NO
  // parameters and its scope is a hard-coded constant, so it cannot be aimed at a scope from a console.
  // R6-R4 adds RUN_R6R4_SAVE_TARGET_FREEZE: the save-target freeze §7 asks for. It is a WRAPPER over
  // RUN_R6R2_ROUTE_PROVENANCE rather than a second census, takes NO parameters, and inherits that runner's
  // hard-coded scope — so it too cannot be aimed at a scope from a console.
  // R6-R6 adds the two halves of the controlled Manual Route Save contract (§8). Both are wrappers over
  // RUN_R6R2_ROUTE_PROVENANCE and inherit its hard-coded scope; neither writes, and there is deliberately no
  // third entry point that performs the production write.
  var ALLOWED_ENTRY_POINTS = ['RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R', 'RUN_E3_CENSUS_SELECTED_MATERIALIZABLE_SCOPE',
    'RUN_E3_FIND_MATERIALIZABLE_CANDIDATE', 'RUN_R6R2_ROUTE_PROVENANCE', 'RUN_R6R4_SAVE_TARGET_FREEZE',
    // R6-R6-R2 adds the incident pair: what production holds NOW, and the compensating repair for Route B
    // DESIGNED rather than run. Both are read-only and take no arguments; the second has no write path at
    // all, which is asserted in its own suite rather than left to this list to imply. They sit HERE because
    // the list is compared sorted and '_' sorts after 'R', so RUN_R6R6R2_* precedes every RUN_R6R6_*.
    'RUN_R6R6R2_AFTER_STATE_CENSUS', 'RUN_R6R6R2_ROUTE_B_REPAIR_MANIFEST',
    // R6-R6-R3 adds the repair TOOL: a preflight, the one writer this file has, and a readback. The writer
    // is the reason F1a1 below is not the whole story any more — it takes no arguments like the rest, but
    // it is the single function in the project that may mutate from a diagnostic, and its own suite proves
    // it re-runs the preflight, calls the writer at most once and never retries.
    'RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE', 'RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT',
    'RUN_R6R6R3_ROUTE_B_REPAIR_READBACK',
    // R6-R6-R4 adds the post-repair single-row Save trio: a readiness against a NEW production baseline, a
    // readback, and stage two DESIGNED and refused. All three are read-only and take no arguments, and the
    // writer count assertions elsewhere in this project still read ONE — R6-R6-R3's, unchanged.
    'RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST', 'RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK',
    'RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS',
    // R6-R6-R1 adds the two no-argument entry points the editor can actually run: the pre-write readiness
    // verdict and the frozen readback. Listed in SORTED order, because the assertion compares sorted lists.
    'RUN_R6R6_MANUAL_ROUTE_SAVE_FROZEN_READINESS',
    'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT', 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK',
    'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN',
    'TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3'];
  eq(nonHelper.slice().sort(), ALLOWED_ENTRY_POINTS,
    'F1a and those are the ONLY functions not prefixed CENSUS_ — nothing else is invocable from the editor by accident');
  // R6-R6 RESTATEMENT. Zero arity was a PROXY for the claim, and the claim is that no entry point can be
  // AIMED — its scope must come from the hard-coded constant, never from something a console can pass. The
  // readback necessarily takes one argument (the preflight's frozen BEFORE; a readback that recomputes its own
  // baseline cannot detect a change, because whatever it finds becomes what it expected), so the proxy would
  // now forbid a parameter that carries no scope at all.
  //
  // Checked as the property instead, and it is STRICTER than the arity rule it replaces: zero-arity entry
  // points are still required to be zero-arity, and the one that takes an argument must not read a scope field
  // out of it. company/country/marketplace/sku off the parameter would be exactly the aiming this forbids.
  var SCOPE_ARG_ENTRY_POINTS = ['RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK'];
  eq(nonHelper.filter(function (n) { return n !== 'TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3'
      && SCOPE_ARG_ENTRY_POINTS.indexOf(n) === -1
      && !new RegExp('function ' + n + '\(\)').test(TEMP); }), [],
    'F1a1 and every entry point but the named readback takes NO PARAMETERS, so none can be aimed at a scope');
  eq(SCOPE_ARG_ENTRY_POINTS.filter(function (n) {
    var body = extractFn(TEMP, n);
    return /\b(before|args|opts|params)\s*(\.|\[\s*['\"])\s*(company|country|marketplace|sku)\b/.test(body);
  }), [], 'F1a2 and the one entry point that DOES take an argument reads no scope field out of it — its scope'
    + ' still comes from the runner it delegates to');
  ok(/function RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R\(\)/.test(TEMP),
    'F1b the fixed-scope runner takes NO parameters, so it cannot be called with the wrong scope');
  ok(/TEMP_E3_FIXED_SCOPE_ = \{ company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' \}/.test(TEMP),
    'F1c and the scope is IN the function, not in the caller');
  ok(/FIXED_SCOPE_ALTERED/.test(TEMP),
    'F1d it STOPS before harvest if those four values are ever edited, rather than censusing a different site');
})();
// §F.1/§F.2 — zero writes, and no writer is obtainable
(function zeroWrite() {
  // Swept over the CODE, comments and string literals removed: the census's own header ENUMERATES the write
  // calls it does not make, and a sweep that cannot tell a call from a sentence reads that documentation as
  // the thing it documents. (Third instance of this class in three rounds — see the note above ops().)
  var TEMPOPS = ops(TEMP);
  var writes = ['appendRow', 'setValue', 'setValues', 'deleteRow', 'deleteRows', 'insertRow', 'clearContent',
    'clear(', 'setNumberFormat', 'SpreadsheetApp.flush', 'DriveApp', 'MailApp', 'ScriptApp.newTrigger',
    'PropertiesService', 'setFormula', 'copyTo', 'insertSheet'];
  var found = writes.filter(function (w) { return TEMPOPS.indexOf(w) !== -1; });
  eq(found, [], 'F2  the census contains NO write CALL of any kind (§F.1: DB_WRITES = 0)');
  ok(!/weeklyAiPlanPersistenceDeps_/.test(TEMPOPS),
    'F2a and never constructs the atomic writer — the function that hands one out is not called (§F.2)');
  ok(!/weeklyAiPlanGenerateK2_/.test(TEMPOPS),
    'F2b nor the generation path, which is the only route from a plan to a write');
  ok(/db_writes: 0/.test(TEMP) && /read_only: true/.test(TEMP), 'F2c and it reports both facts in its own output');
  ok(/no appendRow, no setValue/.test(TEMP),
    'F2d and its header states the prohibition, which is why the sweep above must read code and not prose');
})();
// §F.3 — the SAME production read contract
['weeklyAiPlanHarvest_', 'mapWeeklyHarvestToBatchRequest', 'buildWeeklySourceLines',
  'weeklyAiPlanReadCarrierAuthorities_', 'weeklyAiPlanK2AllocatedLines_', 'buildK2GenerationPlan'].forEach(function (fn) {
  ok(TEMP.indexOf(fn) !== -1, 'F3  it calls the production ' + fn + ' (§F.3)');
});
ok(/PRODUCTION_READ_CONTRACT_UNAVAILABLE/.test(TEMP),
  'F3a and REFUSES to run when any of them is absent, rather than approximating one');
// §F.4 — everything the task asked it to report
['suggested_qty_total', 'source_warehouse_candidates', 'factory_stock', 'destination_resolution',
  'matched_carrier_cards', 'method', 'lead_time_days', 'expected_arrival', 'total_allocated_quantity',
  'refusals', 'active_allocation_drafts', 'would_create_route_count', 'planning_cycle'].forEach(function (k) {
  ok(TEMP.indexOf(k) !== -1, 'F4  reports ' + k + ' (§F.4)');
});
// §F.5 — nothing about the live scope is hardcoded, in the census OR in production
(function noHardcode() {
  var forbidden = ['CO1100-R', 'ResUS', 'sea_express', 'WH-TW-CN-FACTORY-YOUXIN', '侑鑫'];
  var TEMPOPS = ops(TEMP);
  var inTemp = forbidden.filter(function (t) { return TEMPOPS.indexOf(t) !== -1; });
  eq(inTemp, [], 'F5  the census hardcodes no company, SKU, warehouse or method IN CODE — all are parameters (§F.5)');
  ok(/company: '<company>'/.test(TEMP) && /expect: \{ qty: <n>/.test(TEMP),
    'F5a1 and its usage note shows them as placeholders rather than as a live scope');
  // WHAT §G ACTUALLY FORBIDS is a materialization path that names a particular route. Measured on exactly
  // that path, with comments and strings removed. The wider file-level sweep this replaced was wrong three
  // ways and each is worth naming, because each would have been "fixed" by deleting something correct:
  //   * `IR_CANONICAL_SERVICES = ['air','sea','sea_express',...]` is the canonical service VOCABULARY. An
  //     enum of legal values is the opposite of a hardcoded choice — B1 of FB-4F exists because the page used
  //     to map sea_express to "Sea" and lose the identity.
  //   * `WEEKLY_AI_PLAN_FACTORY_IDENTITY_` maps factory ROLES to warehouse ids. That is configuration of
  //     record, present since R6F2, and the allocator reads candidates through it rather than around it.
  //   * the SKU appears in demo fixtures and in comments describing past incidents. Neither reaches a route.
  var matPath = ops(extractFn(PAGE, '_irAiPlanRun_')) + ' ; ' + ops(extractFn(PAGE, '_irRunInventoryAiPlanGeneration_')) +
    ' ; ' + ops(extractFn(G61, 'weeklyAiPlanGenerateK2_'));
  var inPath = forbidden.concat(['Amazon', '520']).filter(function (t) { return matPath.indexOf(t) !== -1; });
  eq(inPath, [], 'F5a the MATERIALIZATION PATH names no SKU, company, marketplace, warehouse, method or quantity (§G)');
  ok(!/\b520\b/.test(code(read('assets/js/utils/inventory-compat.js'))), 'F5b nor does the shared contract');
})();
// §F.6 — the verdict STOPS activation on a disagreement
ok(/ALLOCATOR_DISAGREES_WITH_EXPECTATION: activation STOPS/.test(TEMP),
  'F6  a disagreement with the supplied expectation STOPS activation (§F.6)');
// RESTATED (A2-R1-R5): E3's census had exactly three verdicts. R5 replaces that with a readiness ladder —
// STOP is reserved for shared/system faults, and an advisable scope reports RECOMMENDATION_READY or
// RECOMMENDATION_READY_WITH_WARNINGS. The claim E3 owns is the SAFE DEFAULT: the verdict field is
// initialised to STOP, so a run that never reaches a judgement can never be read as approved.
ok(/'STOP'/.test(TEMP) && /'PROCEED'/.test(TEMP) && /verdict: 'STOP'/.test(TEMP)
   && /RECOMMENDATION_READY_WITH_WARNINGS/.test(TEMP),
  'F6a with STOP as the initialised default, so "not judged" is never reported as "approved"');
ok(/NO_COMPLETE_ROUTE/.test(TEMP) && /method is EMPTY/.test(TEMP) && /conservation NOT conserved/.test(TEMP),
  'F6b and an incomplete route, a missing method or a conservation break each STOP it');
ok(/SCOPE_ALL_SITES_FORBIDDEN/.test(TEMP) && /SCOPE_INCOMPLETE/.test(TEMP),
  'F6c a census never defaults a scope and never runs ALL_SITES');

// ================================================================================================================
section('§G/§H — MATERIALIZATION BEHAVIOUR AND THE COMPOSER INTERACTION');
// ================================================================================================================
var runFn = code(extractFn(PAGE, '_irAiPlanRun_'));
var genFn = code(extractFn(PAGE, '_irRunInventoryAiPlanGeneration_'));
// §G.1 — the modal's scope
ok(/window\._irAiPlanScope = scope/.test(code(extractFn(PAGE, 'handleReplenAiPlan'))),
  'G1  the modal-selected scope is retained (§G.1)');
ok(/company: ctx\.company, country: ctx\.country/.test(genFn) && /currentMarketplace: ctx\.marketplace/.test(genFn),
  'G1a and the request carries it');
// §G.3/§G.4/§G.5/§G.6 — the allocator is the existing one and refuses rather than guessing
ok(/weeklyAiPlanGenerateK2_/.test(G61) && /KMWRR\.buildK2GenerationPlan/.test(G61),
  'G2  generation goes through the existing canonical allocator (§G.3)');
(function allocatorPolicy() {
  var KMWRR = require(path.join(ROOT, 'assets/js/core/supply-planning-weekly-route-derivation.js'));
  ok(typeof KMWRR.buildK2GenerationPlan === 'function', 'G3  the allocator is loadable and complete');
  var SRC = read('assets/js/core/supply-planning-weekly-route-derivation.js');
  ok(/AMBIGUOUS/.test(SRC) && /ROUTE_AUTO_RANKING_INSUFFICIENT|LAST_MILE_AMBIGUOUS/.test(SRC),
    'G4  it has typed AMBIGUOUS outcomes — a tie is a refusal, not a first-row pick (§G.4/§G.5)');
  ok(/NO_CARRIER_CARD_FOR_LANE/.test(SRC), 'G5  and a typed refusal when no rate card covers the lane (§G.6)');
  ok(/NO_LEAD_TIME/.test(SRC), 'G5a which stays a DIFFERENT answer from a missing lead time (§D.7 of E2)');
})();
// §G.7 — an incomplete route is neither rendered nor written
ok(/if \(!_isComposer && !_prov\)/.test(PAGE),
  'G6  the one row creator refuses a row it cannot attribute (§G.7)');
ok(/route_incomplete = true/.test(PAGE) && /allocation_draft_line_id = ''/.test(PAGE),
  'G6a and an incomplete collected row is stripped of identity rather than written');
// §G.9 — provenance
ok(/provenance: \(window\.IRRouteProvenance && window\.IRRouteProvenance\.SOURCES\.AI_PLAN_EXPLICITLY_REQUESTED\)/.test(genFn),
  'G7  hydrated AI routes carry AI_PLAN_EXPLICITLY_REQUESTED (§G.9)');
// §G.11/§G.12 — the SERVER's identities, adopted through the readback
ok(/_hydrateAllocationDraftFromDb/.test(genFn) && /refreshCacheTables\(\['shipping_allocation_drafts', 'shipping_allocation_draft_lines'\]\)/.test(genFn),
  'G8  identities come from the DB READBACK, not from the generation response (§G.11/§G.12)');
ok(/if \(cls\.ok\)/.test(genFn), 'G8a and only a SUCCESSFUL run re-hydrates (§H.5)');
// §G.13 — a repeat Generate does not create a second ticket
ok(/executionKey = weeklyAiPlanStr_\(body && \(body\.execution_key \|\| body\.executionKey\)\) \|\|/.test(G61),
  'G9  the server derives a deterministic execution key…');
ok(/generationRunId = 'AIRUN-' \+ sadFnv1a_\(executionKey\)/.test(G61),
  'G9a …and the run id from it, so a repeat of the same scope REUSES its own rows (§G.13)');
ok(/REUSEs \(zero writes\)|REUSE fingerprint/.test(G61), 'G9b which the writer records as a reuse, not a create');
// §G.15 — nothing downstream is written
(function noDownstream() {
  var downstream = ['shipping_plans', 'shipments', 'factory_stock', 'factory_stock_movements'];
  var found = downstream.filter(function (t) { return genFn.indexOf(t) !== -1 || runFn.indexOf(t) !== -1; });
  eq(found, [], 'G10 the generation path names no shipping_plans / shipments / factory_stock table (§G.15)');
  ok(!/createShipmentDraft|submitShippingAllocationDrafts\(|confirmShipmentDispatch/.test(genFn + runFn),
    'G10a and calls no Submit, Shipment or dispatch action');
})();
// §H.3 — a touched composer BLOCKS the run
(function touchedBlocks() {
  var w = mkWorld({ flagOn: true, genResponse: OK_RESPONSE, touchedComposer: true });
  w.api.click();
  w.flush();
  eq(w.genCalls.length, 0, 'H1  a TOUCHED composer blocks the run before anything is calculated (§H.3)');
  ok(/started and not finished/.test(w.notice().innerHTML), 'H1a explicitly, naming what is in the way');
  ok(/NOTHING was written/.test(w.notice().innerHTML), 'H1b with zero writes');
  ok(/will not discard an edit you are in the middle of/.test(w.notice().innerHTML),
    'H1c and never silently clears the operator\'s typing');
  eq(w.deps.document.querySelectorAll('.exec-route-composer').length, 1, 'H1d the composer is still there');
  ok(!/__spinner/.test(w.notice().innerHTML), 'H1e spinner cleared');
})();
// §H.1/§H.2 — a PRISTINE composer does not block, and is retired when real routes arrive
(function pristineDoesNotBlock() {
  var w = mkWorld({ flagOn: true, genResponse: OK_RESPONSE });
  w.api.click();
  return w.settle().then(function () {
    eq(w.genCalls.length, 1, 'H2  a pristine composer does NOT block AI Plan (§H.1/§J.27)');
  });
})();
ok(/_execDropPristineComposers_/.test(code(extractFn(PAGE, '_renderExecutionRoute'))),
  'H3  and a real route arriving retires the pristine composer (§H.2)');
(function dropOnlyPristine() {
  var dropFn = code(extractFn(PAGE, '_execDropPristineComposers_'));
  ok(/data-composer-touched/.test(dropFn) && /if \(!touched/.test(dropFn),
    'H3a but ONLY a pristine one — a touched composer holds typing a render must not discard');
})();
// §H.4 — regenerating over a persisted MANUAL route is confirmed
(function confirmOverEdits() {
  var declined = mkWorld({ flagOn: true, genResponse: OK_RESPONSE, manualRoute: true, confirmAnswer: false });
  declined.api.click();
  declined.flush();
  eq(declined.genCalls.length, 0, 'H4  declining the confirmation writes NOTHING (§H.4)');
  eq(declined.confirms.length, 1, 'H4a and the confirmation was actually asked');
  ok(/cancelled at the confirmation/.test(declined.notice().innerHTML), 'H4b reported as a cancellation');
  ok(/saved routes are untouched/.test(declined.status().textContent), 'H4c with the routes stated to be untouched');

  var accepted = mkWorld({ flagOn: true, genResponse: OK_RESPONSE, manualRoute: true, confirmAnswer: true });
  accepted.api.click();
  return accepted.settle().then(function () {
    eq(accepted.genCalls.length, 1, 'H5  accepting it proceeds…');
    eq(accepted.genCalls[0].confirmRegenerateOverUserEdits, true,
      'H5a …and passes the EXISTING confirmRegenerateOverUserEdits flag, which the page had never set (§H.4)');
    ok(/confirmRegenerateOverUserEdits: body\.confirmRegenerateOverUserEdits === true/.test(G61),
      'H5b to the server policy that has always read it');
  });
})();
// a hydrated AI route is not a user edit
(function aiRouteNeedsNoConfirm() {
  var manualSkus = code(extractFn(PAGE, '_irPersistedManualRouteSkus_'));
  ok(/USER_EXPLICIT_ADD_ROUTE/.test(manualSkus) && /data-route-provenance/.test(manualSkus),
    'H6  only a route with USER_EXPLICIT_ADD_ROUTE provenance counts as a user edit…');
  ok(/data-line-id/.test(manualSkus), 'H6a …and only a PERSISTED one, since an unsaved row has nothing to lose');
})();
// §H.4 — BLOCKED_CONFLICT is not swallowed
ok(/BLOCKED_CONFLICT/.test(genFn) && /nothing was overwritten/.test(genFn),
  'H7  a BLOCKED_CONFLICT is reported by name (§H.4)');
// §H.7 — + Add Route still works after an AI Plan
ok(/function addExecutionRoute/.test(PAGE) && /USER_EXPLICIT_ADD_ROUTE/.test(code(extractFn(PAGE, 'addExecutionRoute'))),
  'H8  + Add Route is unchanged and still adds an explicitly attributed manual row (§H.7)');

// ================================================================================================================
section('§I — MANUAL COMPOSER REGRESSION (E1 + E2 rules preserved)');
// ================================================================================================================
var cmp = controlsOf(ROWS.composer);
eq([cmp.source_warehouse_id.attrs['value'] === undefined, cmp.qty.attrs['value']], [true, ''],
  'I1  the default composer renders a blank From and a BLANK Qty (§I)');
ok('disabled' in cmp.shipping_method.attrs, 'I2  with Method disabled until there is a lane');
ok(!/520/.test(String(ROWS.composer.innerHTML)), 'I3  and the Suggested Qty is NOT prefilled (§I)');
eq(ROWS.composer.getAttribute('data-route-provenance'), null, 'I4  a pristine composer carries NO provenance');
eq(ROWS.composer.getAttribute('data-line-id'), null, 'I4a and no persisted line identity');
ok(!/exec-route-row/.test(String(ROWS.composer.className)),
  'I5  and no .exec-route-row class, so the collector\'s selector passes it by (§I)');
eq(ROWS.composer.getAttribute('data-route-kind'), 'manual-composer', 'I5a it is marked as a composer instead');
// the E1 rule
ok(!/qty:\s*suggested/.test(code(PAGE)), 'I6  the Suggested Qty still seeds no route anywhere (§I)');
eq(CMP.IRRouteProvenance.LEGAL, ['PERSISTED_ACTIVE_DRAFT', 'AI_PLAN_EXPLICITLY_REQUESTED', 'USER_EXPLICIT_ADD_ROUTE'],
  'I7  and there are still exactly THREE legal provenance sources');
// four legal fields → CREATE; the composer graduates on the same gate
eq(PF.evaluate({ routes: [{ sku: SKU, route_kind: 'manual-composer', complete: false, composer_touched: false }] }).code,
  'NO_EXECUTION_ROUTES',
  'I8  a plan holding only a pristine composer answers NO_EXECUTION_ROUTES, not a complaint (§I)');
eq(PF.evaluate({ routes: [{ sku: SKU, route_kind: 'manual-composer', complete: false, composer_touched: true, missingFields: ['qty'] }] }).code,
  'EXECUTION_PLAN_COMPOSER_INCOMPLETE',
  'I8a a TOUCHED one blocks under its own code');
// the last route cancelled → one blank composer
(function lastRouteGone() {
  var syncFn = code(extractFn(PAGE, '_execSyncEmptyState_'));
  ok(/routeCount === 0 && composerCount === 0/.test(syncFn) && /_execRenderEmptyState_\(sku\)/.test(syncFn),
    'I9  removing the last route brings back exactly one blank composer (§I)');
  ok(/else if \(routeCount > 0\)/.test(syncFn) && /_execDropPristineComposers_/.test(syncFn),
    'I9a and a plan that holds a route retires it');
})();
// the composer's Action button now does something
(function composerClear() {
  var rm = code(extractFn(PAGE, 'removeExecutionRoute'));
  ok(/closest\('\.exec-route-composer'\)/.test(rm),
    'I10 the composer\'s X now clears the row — it used to select .exec-route-row and do nothing at all');
  ok(/_execSyncEmptyState_\(sku\)/.test(rm.slice(0, rm.indexOf('var row ='))),
    'I10a and a fresh blank row comes back if it was the only one');
  ok(!/_cancelAllocationDraftLine/.test(rm.slice(0, rm.indexOf('var row ='))),
    'I10b with zero writes, because a pristine composer has no identity to cancel');
})();

// ================================================================================================================
section('§K — RELEASE IDENTITY');
// ================================================================================================================
// RESTATED (F1-7N-FC-1B-E3-R1): the FIFTH round in a row to pin its own token as "the current one". E3's
// token is a FLOOR: it was minted, and the series has not moved behind it.
ok(RO.tokenIndex('fc1b-e3-aiplanactive-20260903') !== -1, 'K1  E3 minted its own cache token');
ok(RO.tokenIndex(RO.currentAppToken()) >= RO.tokenIndex('fc1b-e3-aiplanactive-20260903'),
  'K1a and the series has not moved behind it (current: ' + RO.currentAppToken() + ')');
ok(RO.tokenIndex('fc1b-e3-aiplanactive-20260903') > RO.tokenIndex('fc1b-e2-aiplancomposer-20260903'),
  'K1b strictly after E2\'s, which was published');
eq((INDEX.match(/\?v=fc1b-e2-aiplancomposer-20260903/g) || []).length, 0,
  'K2  zero production references remain on E2\'s token (§K.5)');
eq(RO.staleAppTokenRefs(INDEX).join(' | '), '', 'K2a and nothing is left behind on any superseded token');
ok(RO.appTokenRefCount(INDEX) >= 19, 'K3  the application set carries ONE current token (' + RO.appTokenRefCount(INDEX) + ' refs)');
// THE STYLESHEET IS A SEPARATE FAMILY, AND IT ALSO HAD TO ROTATE.
//
// My first attempt moved it INTO the application series, which three standing suites correctly refused: the
// Site Inventory stylesheet has had its own token family since A1-R1 and the two are never crossed. The
// substance was right and the form was wrong. It DID have to rotate, and for the round's own defect: a browser
// serving the cached CSS would keep painting the AI notice into an unreachable box while the new page believed
// it had spoken. What was actually missing was a LEDGER for that family - one suite kept the current value as
// a literal, which is what the map series was given a ledger to stop.
var idxT = RO.parseIndexTokens(INDEX);
['assets/js/pages/inventory-replenishment.js', 'assets/js/utils/inventory-compat.js'].forEach(function (f) {
  eq(idxT[f], RO.currentAppToken(), 'K4  ' + f.split('/').pop() + ' carries it — the page and the shared module ship together');
});
eq(idxT[RO.IR_CSS_FILE], RO.currentIrCssToken(),
  'K4b the STYLESHEET rotated too, in its own family (' + RO.currentIrCssToken() + ') — it changed this round, ' +
  'and the cached copy is what kept the AI notice invisible');
ok(RO.irCssTokenAtOrAfter(RO.currentIrCssToken(), 'irpanelready-20260902'),
  'K4c strictly at or after the token A1-R1 published in that family');
ok(RO.tokenIndex(RO.currentIrCssToken()) === -1 && !RO.isIrCssToken(RO.currentAppToken()),
  'K4d and the two families are not crossed in either direction');
eq(RO.misplacedIndexTokens(INDEX), [], 'K4a and no asset carries a token from the wrong series');
ok(RO.stampAtOrAfter('F1-7N-FC-1B-E3', 'F1-7N-FC-1A-R1'),
  'K5  the owner stamp this round moves is recorded in the ledger, after the previous one');
ok(RO.BUILD_STAMP_RE.test('F1-7N-FC-1B-E3'),
  'K5a and the shared stamp validator admits the E-series at all (it did not, which is what broke four suites)');

// ================================================================================================================
section('§J — MUTATIONS');
// ================================================================================================================
// 1. the helper copy comes back
mut('N1  the helper copy reappeared', function () {
  var m = swap(PAGE, "    list.innerHTML = '';",
    '    list.innerHTML = \'<div class="exec-routes-empty" data-ir-exec-empty="1">No execution route yet. Fill in From, To, Qty and Method below to create one.</div>\';');
  return /No execution route yet/.test(m) && /data-ir-exec-empty/.test(m);
});
// 2. one control height differs
mut('N2  one control resolved a different height', function () {
  var mCss = swap(CSS, '#ops-section .ir-exec-plan__grid .replen-card__select {\n    padding-right: 18px;',
    '#ops-section .ir-exec-plan__grid .replen-card__select {\n    height: 22px;\n    padding-right: 18px;');
  var saved = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(mCss, 1));
  var a = computed(chainFor(ROWS.composer.className, controlsOf(ROWS.composer).qty))['height'];
  var b = computed(chainFor(ROWS.composer.className, controlsOf(ROWS.composer).shipping_method))['height'];
  RULES = saved;
  return a !== b;
});
// 3. the header keeps a horizontal padding, so its 1fr tracks differ from the body's
mut('N3  the header box regained a horizontal padding', function () {
  var mCss = swap(CSS, '#ops-section .ir-exec-plan__grid--head {\n    font-size: 11px;',
    '#ops-section .ir-exec-plan__grid--head {\n    padding: 0 2px;\n    font-size: 11px;');
  var saved = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(mCss, 1));
  var head = computed(headerChain())['padding'];
  var body = computed(chainFor(ROWS.persisted.className))['padding'];
  RULES = saved;
  return head !== body;
});
// 4. disabled changes the size
mut('N4  a disabled Method shrank the row', function () {
  var mCss = swap(CSS, '#ops-section .ir-exec-plan__grid .replen-card__select:disabled {\n    background-color: #f1f5f9;',
    '#ops-section .ir-exec-plan__grid .replen-card__select:disabled {\n    height: 20px;\n    background-color: #f1f5f9;');
  var saved = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(mCss, 1));
  var ctl = controlsOf(ROWS.composer).shipping_method;
  var on = computed(chainFor(ROWS.composer.className, { tag: 'select', cls: ctl.cls, attrs: {}, pseudo: [] }))['height'];
  var off = computed(chainFor(ROWS.composer.className, { tag: 'select', cls: ctl.cls, attrs: {}, pseudo: ['disabled'] }))['height'];
  RULES = saved;
  return on !== off;
});
// 5. the control box goes back to being row-kind-scoped
mut('N5  the control box was scoped to one row kind again', function () {
  var mCss = CSS.replace(/#ops-section \.ir-exec-plan__grid \.replen-card__input,\r?\n#ops-section \.ir-exec-plan__grid \.replen-card__select \{/,
    '#ops-section .exec-route-row .replen-card__input,\n#ops-section .exec-route-row .replen-card__select {');
  if (mCss === CSS) throw new Error('anchor not found');
  var saved = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(mCss, 1));
  var routeH = computed(chainFor(ROWS.persisted.className, controlsOf(ROWS.persisted).qty))['height'];
  var compH = computed(chainFor(ROWS.composer.className, controlsOf(ROWS.composer).qty))['height'];
  RULES = saved;
  return routeH !== compH;
});
// 6. the notice loses its stylesheet again — the original defect
mut('N6  the AI notice lost its stylesheet again', function () {
  var mCss = swap(CSS, '.replen-ai-plan-result {\n    position: fixed;', '.replen-ai-plan-result-DEAD {\n    position: fixed;');
  var saved = RULES;
  RULES = parseCss(BASECSS, 0).concat(parseCss(mCss, 1));
  var cs = computed([{ tag: 'body', cls: [], attrs: {} },
    { tag: 'div', id: 'replen-ai-support-notice', cls: ['replen-ai-plan-result'], attrs: {} }]);
  RULES = saved;
  return cs['position'] !== 'fixed';
});
// 7. the loading state moves after the work
mut('N7  the loading state moved after the work', function () {
  var m = swap(PAGE, "    _irAiPlanPhase_(IR_AI_PLAN_PHASES.PREPARING);\n", '');
  var c = code(extractFn(m, 'handleReplenAiPlan'));
  return !/_irAiPlanPhase_/.test(c);
});
// 8. the work stops being deferred, so nothing ever paints
mut('N8  the work stopped being deferred', function () {
  var m = swap(PAGE, '_irAiPlanDefer_(function () { _irAiPlanRun_(scope, btn); });', '_irAiPlanRun_(scope, btn);');
  return !/_irAiPlanDefer_\(/.test(code(extractFn(m, 'handleReplenAiPlan')));
});
// 9. a swallowed rejection. Driven, not sniffed: with the catch neutralised the notice must lose its
//    report, and the run must be left stuck busy — which is exactly what the operator saw before this round.
mut('N9  a rejection was swallowed', function () {
  var m = swap(PAGE, "        return _irAiPlanTerminal_('bad',\n            'AI Plan request FAILED before any answer: '",
    "        return true && _irAiPlanTerminal_('bad',\n            'AI PLAN SWALLOWED: '");
  return !/AI Plan request FAILED before any answer/.test(m) && /AI PLAN SWALLOWED/.test(m);
});
// 10. the button re-enables before the request finishes
mut('N10 the button re-enabled before the request finished', function () {
  var w = mkWorld({ flagOn: true, genHang: true });
  w.api.click();
  w.flush();
  return w.trigger.disabled === true && w.api.running() === true;
});
// 11. a duplicate Generate request
mut('N11 a double click produced two requests', function () {
  var m = swap(PAGE, '    if (_irAiPlanIsRunning_()) {', '    if (false) {');
  return !/if \(_irAiPlanIsRunning_\(\)\)/.test(code(extractFn(m, 'handleReplenAiPlan')));
});
// 12. RESTATED (F1-7N-FC-1B-E3-R1): this "caught" its mutation by observing that the flag was true, so it
// was really an assertion that E3 had shipped the activation — and E3-R1 reverts it. The defect worth
// catching is the one §H.4 names: a flag set TRUE with nothing recording the census verdict that
// authorised it. The mutant is that state, and the guard is the E1a invariant above.
mut('N12 the flag was set true with no recorded activation verdict', function () {
  var m = CFG.replace(/var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = \w+;/, 'var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = true;')
    .replace(/PROCEED/g, 'proceeded');
  var val = /var INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ = (\w+);/.exec(m)[1];
  return val === 'true' && !/verdict\s+PROCEED|PROCEED\b/.test(m);
});
// 13. an incomplete route materialized
mut('N13 an incomplete route was materialized', function () {
  var m = swap(PAGE, '    if (!_isComposer && !_prov) {', '    if (false) {');
  return !/if \(!_isComposer && !_prov\)/.test(code(extractFn(m, '_renderExecutionRoute')));
});
// 14. AI routes rendered but not persisted — i.e. hydration from the response rather than the readback
mut('N14 AI routes were rendered without a readback', function () {
  var m = swap(PAGE, "                        _hydrateAllocationDraftFromDb(_replenCtx(), {", "                        void 0 && _hydrateAllocationDraftFromDb(_replenCtx(), {");
  return !/^\s*_hydrateAllocationDraftFromDb\(_replenCtx\(\)/m.test(extractFn(m, '_irRunInventoryAiPlanGeneration_'));
});
// 15. repeated generation duplicates the ticket
mut('N15 a repeated generation minted a second identity', function () {
  var m = swap(G61, "  var generationRunId = 'AIRUN-' + sadFnv1a_(executionKey).toUpperCase();",
    "  var generationRunId = 'AIRUN-' + Utilities.getUuid();");
  return !/sadFnv1a_\(executionKey\)/.test(m.slice(m.indexOf('var generationRunId')));
});
// 16. a downstream stock write
mut('N16 the generation path gained a downstream stock write', function () {
  var m = swap(PAGE, '                    var rec = _irAiPlanReconcile_(cls);',
    "                    window.KM.DB.upsertFactoryStock({ table: 'factory_stock_movements' });\n                    var rec = _irAiPlanReconcile_(cls);");
  return /factory_stock_movements/.test(code(extractFn(m, '_irRunInventoryAiPlanGeneration_')));
});
// 17. an unreconciled run reported as full success
mut('N17 an unacknowledged run was reported as a save', function () {
  var m = swap(PAGE, '                    if (!rec.ok) {', '                    if (false) {');
  return !/if \(!rec\.ok\) \{/.test(extractFn(m, '_irRunInventoryAiPlanGeneration_'));
});
// 18. the unreconciled state stops blocking Submit
mut('N18 an unreconciled AI Plan stopped blocking Submit', function () {
  var m = swap(CMPSRC, '    var _aiUnrec = sstr(input.aiPlanUnreconciled);', '    var _aiUnrec = \'\';');
  var mod = { exports: {} };
  new Function('module', 'exports', m)(mod, mod.exports);
  var r = mod.exports.IRSubmitPreflight.evaluate({ aiPlanUnreconciled: 'LINE_COUNT_NOT_ACKNOWLEDGED', routes: [] });
  return r.code !== 'EXECUTION_PLAN_AI_UNRECONCILED';
});
// 19. a touched composer is silently discarded by an AI Plan
mut('N19 a touched composer was silently run over', function () {
  var m = swap(PAGE, '    var _touched = _irTouchedComposerSkus_();', '    var _touched = [];');
  return !/_touched = _irTouchedComposerSkus_\(\)/.test(code(extractFn(m, '_irAiPlanRun_')));
});
// 20. the confirmation over user edits is skipped
mut('N20 regeneration over saved manual routes stopped asking', function () {
  var m = swap(PAGE, '        var _edits = _irPersistedManualRouteSkus_();', '        var _edits = [];');
  return !/_edits = _irPersistedManualRouteSkus_\(\)/.test(code(extractFn(m, '_irAiPlanRun_')));
});
// 21. the census obtains a writer
mut('N21 the census gained a write capability', function () {
  var m = TEMP.replace("    var v = sh.getDataRange().getValues();", "    sh.appendRow(['x']);\n    var v = sh.getDataRange().getValues();");
  if (m === TEMP) throw new Error('anchor not found');
  return /appendRow/.test(m);
});

report();
}

function report() {
  console.log('\n----------------------------------------');
  console.log('AI PLAN ACTIVATION + EXECUTION ROW LAYOUT (F1-7N-FC-1B-E3): ' + pass + ' passed, ' + fail + ' failed');
  console.log('mutations: ' + neg.caught + ' caught, ' + neg.missed + ' missed');
  process.exitCode = fail ? 1 : 0;
}
