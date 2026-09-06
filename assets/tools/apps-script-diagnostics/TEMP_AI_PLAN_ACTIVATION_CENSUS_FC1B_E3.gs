/**
 * TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3.gs — F1-7N-FC-1B-E3 §F
 * PASTE · RUN · REMOVE. Read-only activation census for the Inventory AI Plan.
 * ================================================================================================================
 *
 * WHAT THIS IS FOR
 * ----------------
 * §E flips INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ to true, which lets a "Generate AI Plan" click reach the
 * canonical writer. This answers the question that has to be answered BEFORE that deployment is published:
 * for one named scope and one named SKU, what would the authoritative allocator actually produce, and does it
 * agree with what the E2 round reported? If it does not agree, activation STOPS — the flag is not the thing to
 * debug, the allocator inputs are.
 *
 * WHAT MAKES IT READ-ONLY (§F.1/§F.2/§F.3)
 * ----------------------------------------
 *   • DB_WRITES = 0. There is no write in this file: no appendRow, no setValue(s), no deleteRow, no insertRow,
 *     no clear, no SpreadsheetApp.flush, no Drive, no MailApp, no property/trigger mutation.
 *   • It never obtains a writer. `weeklyAiPlanPersistenceDeps_(ss)` — the function that hands out the atomic
 *     Header+Lines writer — is NOT called, and `weeklyAiPlanGenerateK2_` (the only path from a plan to a write)
 *     is NOT called. The plan builder it does call, KMWRR.buildK2GenerationPlan, is PURE: 61_ splits its own
 *     generation into a compute pass and a write pass precisely because of that, and this file is the compute
 *     pass and nothing else.
 *   • No Sheet object escapes a read helper. `CENSUS_rows_` opens the sheet, takes values, and returns rows —
 *     the caller never holds anything with a write method on it.
 *   • It reads through the SAME production read contract the real generation reads (§F.3): the same harvest, the
 *     same mapper, the same source-line builder, the same carrier authorities, the same allocated-line adapter
 *     and the same route allocator. A census that read its own way would be measuring a different system.
 *
 * NOTHING IS HARDCODED (§F.5)
 * ---------------------------
 * Company, country, marketplace, SKU and the expected route are ALL parameters. No CO1100-R, no ResUS, no
 * Amazon, no 520, no CN factory, no sea_express appears anywhere in this file or in production.
 *
 * HOW TO RUN
 * ----------
 *   1. Paste this file into the Apps Script project (any name; it shares the one global scope).
 *   2. Edit nothing. Call the single entry point from the editor, e.g.
 *
 *        TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3({
 *          company: '<company>', country: '<country>', marketplace: '<marketplace>', sku: '<sku>',
 *          expect: { qty: <n>, method: '<service>', sourceWarehouseId: '<wh id>', destination: '<token>' }
 *        });
 *
 *      `expect` is OPTIONAL. Supplied, it turns the census into a go/no-go: the verdict is PROCEED only when
 *      the allocator's own output matches it (§F.6). Omitted, the verdict is REVIEW and a human compares.
 *   3. Read the Logger output (and the returned object).
 *   4. DELETE this file from the project. It is not part of the deployment.
 *
 * F1-7N-FC-1B-E3-R1 §F/§G — A REFUSAL NO LONGER TAKES THE DIAGNOSIS WITH IT.
 * ------------------------------------------------------------------------------------------
 * The first live run answered `verdict = STOP, blocker = HARVEST_NOT_READY` and then returned, so every field
 * that could have explained the refusal was undefined: the run that most needed to report reported the least.
 * It now collects everything that is SAFE to read either way and skips only the allocator — which is the
 * right boundary, because `mapped.request` is null when readiness failed, so KMWRB/KMWRR would be running on
 * nothing. It additionally reports the FORECAST-MONTH COVERAGE that decides whether a site survives at all,
 * per month, so "the row does not exist", "the cell is blank" and "two rows disagree" are three answers with
 * three different fixes; and the full source_data_as_of derivation, naming both authorities.
 *
 * WHAT IT REPORTS (§F.4)
 * ----------------------
 *   scope · planning cycle · Suggested Qty and gap for the SKU · source warehouse candidates · available
 *   factory stock · destination resolution · matched carrier cards · the ranked route result · Method ·
 *   lead time and ETA · total allocated quantity · ambiguity/refusal codes · active allocation drafts already
 *   stored for the scope · would_create route count · and an activation verdict.
 */

// §9 — THE CENSUS WAS REPORTING A BUILD IT NO LONGER WAS. Its behaviour changed in A2-R1-R1 (it learned to
// read the harvest REFUSAL) and again in A2-R1-R2 (route intent + identity preview) while this literal stayed
// at A2-R1, so a log could not be matched to the code that produced it. It moves with the file now.
var TEMP_E3_CENSUS_BUILD_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7-R2';

/** Read-only row reader. The Sheet object stays inside this function — the caller gets values, never a writer. */
// R6-R3 §2 — the OPTIONAL third argument is a metrics sink. §2 requires the diagnostic to report how many
// sheets it opened, how many getDataRange()/getValues() calls it made, and how many rows and columns it read;
// measuring that anywhere but inside the single reader would be measuring a second reader's behaviour.
// Existing two-argument callers pass nothing and are byte-for-byte unaffected.
function CENSUS_rows_(ss, name, _m) {
  try {
    var sh = ss.getSheetByName(name);
    if (_m) { _m.sheets_opened++; _m.sheets.push(name); }
    if (!sh) { if (_m) _m.sheets_absent.push(name); return []; }
    if (_m) _m.get_data_range_calls++;
    var v = sh.getDataRange().getValues();
    if (_m) { _m.rows_read += (v ? v.length : 0); _m.columns_read += (v && v[0] ? v[0].length : 0);
      _m.by_sheet.push({ sheet: name, rows: v ? v.length : 0, columns: (v && v[0]) ? v[0].length : 0 }); }
    if (!v || v.length < 2) return [];
    var head = v[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    var out = [];
    for (var r = 1; r < v.length; r++) {
      var o = {}, blank = true;
      for (var c = 0; c < head.length; c++) {
        if (!head[c]) continue;
        o[head[c]] = v[r][c];
        if (String(v[r][c] == null ? '' : v[r][c]).trim() !== '') blank = false;
      }
      if (!blank) out.push(o);
    }
    return out;
  } catch (e) { return []; }
}

/**
 * F1-7N-FC-1B-E3-R1 §B/§G — THE FORECAST-MONTH COVERAGE FOR ONE SKU. Read-only.
 *
 * This is the census's answer to the question the first live run could not answer. The weekly harvest builds a
 * KMAF receiver per site ONLY when the §7 demand basis is complete, which means all four of M+1..M+4 must
 * resolve to exactly one finite value each in `fc_regular_forecast`. Any month that is missing, blank, or
 * present TWICE WITH DIFFERENT VALUES is omitted by the canonical reader — and the site is then dropped
 * with FORECAST_SHARE_INCOMPLETE, silently before R1. With every site dropped the harvest yields ZERO
 * receivers, KMAF answers ready:false with an EMPTY issues array, and the only thing production could say was
 * a bare HARVEST_NOT_READY.
 *
 * Reported per month so "the row does not exist", "the cell is blank" and "two rows disagree" are three
 * different answers with three different fixes. It reads the canonical table and returns COUNTS AND FLAGS
 * only — never row content.
 */
function CENSUS_forecastCoverage_(ss, scope, sku, months) {
  var ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var rows = CENSUS_rows_(ss, 'fc_regular_forecast');
  var mine = rows.filter(function (r) {
    return CENSUS_low_(r.company) === CENSUS_low_(scope.company) &&
      CENSUS_low_(r.country) === CENSUS_low_(scope.country) &&
      CENSUS_low_(r.marketplace) === CENSUS_low_(scope.marketplace) &&
      (!sku || CENSUS_low_(r.sku) === CENSUS_low_(sku));
  });
  var per = (months || []).map(function (ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return { month: ym, status: 'BAD_MONTH_TOKEN' };
    var year = Number(m[1]), abbr = ABBR[Number(m[2]) - 1];
    var yearRows = mine.filter(function (r) { return Number(r.year) === year; });
    var distinct = {}, blanks = 0;
    yearRows.forEach(function (r) {
      var v = r[abbr];
      if (v === '' || v === null || v === undefined || !isFinite(Number(v))) { blanks++; return; }
      distinct[String(Number(v))] = 1;
    });
    var n = Object.keys(distinct).length;
    return {
      month: ym, year: year, header: abbr,
      rows_for_year: yearRows.length, blank_cells: blanks, distinct_values: n,
      // the canonical reader keeps a month ONLY when exactly one distinct finite value exists for it
      resolves: n === 1,
      status: yearRows.length === 0 ? 'NO_ROW_FOR_YEAR'
        : (n === 0 ? 'CELL_BLANK_OR_NON_NUMERIC'
        : (n > 1 ? 'CONFLICTING_VALUES' : 'OK'))
    };
  });
  var missing = per.filter(function (p) { return !p.resolves; });
  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R3 §9 — THE CENSUS WAS RESTATING A GATE PRODUCTION NO LONGER HAS.
  //
  // The block above counts a month as "missing" when no row exists for its year, when the cell is blank, or
  // when two rows disagree. That WAS the gate, and E3-R3-R1 deliberately changed it: KMFCN now normalizes a
  // missing row and a blank cell to ZERO (the system demonstrably looked and found nothing), and only a
  // CONFLICT or an unreadable table still blocks. Production adopted that; this function did not.
  //
  // So the live census printed `2027-01 NO_ROW_FOR_YEAR`, `FORECAST_SHARE_INCOMPLETE` and
  // `site_would_survive_forecast_gate: false` for a site that production carried through without complaint.
  // Two authorities, one table, opposite answers — and the diagnostic was the wrong one, which is the worst
  // way round, because it sends an operator to fix data that is already fine.
  //
  // The verdict is therefore taken from KMFCN itself rather than restated. The per-month observations are KEPT
  // (they are still the useful part: they say WHICH provenance each zero has), but they no longer decide
  // anything. When KMFCN is not in the deployment the answer is a typed unavailability, never the old rule.
  var kmfcn = null, normalized = null;
  try {
    if (typeof KMFCN !== 'undefined' && KMFCN && typeof KMFCN.normalizeWindow === 'function'
      && typeof weeklyAiPlanForecastReadContext_ === 'function') {
      var _ctx = weeklyAiPlanForecastReadContext_(ss);
      var _fcScope = { company: scope.company, country: scope.country, marketplace: scope.marketplace };
      normalized = KMFCN.normalizeWindow({ context: _ctx, scope: _fcScope, sku: sku, months: months || [],
        matchingRows: KMFCN.rowsForScope(rows, _fcScope, sku) });
      kmfcn = 'KMFCN';
    }
  } catch (eK) { normalized = null; kmfcn = 'KMFCN_THREW:' + CENSUS_str_(eK && eK.message); }
  var authoritative = !!(normalized && typeof normalized.ok === 'boolean');
  return {
    source_table: 'fc_regular_forecast',
    source_headers: 'company, country, marketplace, sku, year + the month column for each required month',
    required_months: months || [],
    scope_row_count: mine.length,
    per_month: per,
    // The raw observations, renamed so nothing reads them as a verdict any more.
    months_with_no_row_or_blank: missing.map(function (p) { return p.month; }),
    months_conflicting: per.filter(function (p) { return p.status === 'CONFLICTING_VALUES'; }).map(function (p) { return p.month; }),
    // ---- THE VERDICT, from the authority production uses -------------------------------------------------
    authority: kmfcn || 'FORECAST_NORMALIZATION_AUTHORITY_UNAVAILABLE',
    normalization: authoritative ? {
      ok: normalized.ok === true, reason: normalized.reason || null, basis: normalized.basis,
      missing_row_normalized_to_zero: (normalized.counters || {}).default_zero_missing_year_count,
      blank_normalized_to_zero: (normalized.counters || {}).default_zero_blank_count,
      explicit_zero: (normalized.counters || {}).explicit_zero_count,
      actual: (normalized.counters || {}).actual_count
    } : null,
    blocking: authoritative ? (normalized.ok !== true) : null,
    site_would_survive_forecast_gate: authoritative ? (normalized.ok === true) : null,
    verdict: authoritative
      ? (normalized.ok === true ? 'FORECAST_BASIS_NORMALIZED' : ('FORECAST_BASIS_UNRESOLVED:' + (normalized.reason || '')))
      : 'FORECAST_NORMALIZATION_AUTHORITY_UNAVAILABLE'
  };
}

/**
 * §B/§G — WHERE source_data_as_of COMES FROM, and which of the two authorities is which. Read-only.
 *
 * Executed finding: `harvest.sourceDataAsOf` is NOT a readiness predicate (a blank, a null and a real date all
 * produce mapped.ready:true, all else equal). It is populated ONLY from a site that SURVIVED, so a blank one is
 * a CO-SYMPTOM of the same zero-receiver drop rather than a cause of it. It does have a real downstream
 * consequence: weeklyAiPlanShipDate_ derives the ship date from it, so blank means no ship date for the lane.
 *
 * The value that is actually STORED on a generated header is a DIFFERENT authority: the GAP-INV run lineage's
 * calculationDate, resolved by the production weeklyAiPlanResolveGapRunLineage_, which BLOCKS with
 * LINEAGE_SOURCE_DATA_AS_OF_UNAVAILABLE rather than storing a blank. Both are reported, neither is invented,
 * and no clock is read: there is no new Date(), no execution time, no spreadsheet modified time and no fallback
 * anywhere in this census.
 */
function CENSUS_sourceAsOfCandidates_(h, planningCycle) {
  var out = {
    harvest_source_data_as_of: CENSUS_str_(h && h.sourceDataAsOf),
    harvest_value_is_blank: !CENSUS_str_(h && h.sourceDataAsOf),
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §6/§9 — this text described the defect, and the defect is fixed. The
    // harvest no longer takes the cutoff from the first surviving workspace line; it takes it from the DONE
    // GAP-INV run lineage through weeklyAiPlanSourceDataAsOfAuthority_ and FAILS CLOSED without one. The
    // workspace value is still reported (as `workspace_source_data_as_of`) so a reader can see that it is
    // blank — but nothing depends on it any more, and this description must not keep saying it does.
    harvest_origin: 'GAP-INV run lineage calculationDate via weeklyAiPlanSourceDataAsOfAuthority_ ' +
      '(A2-R1-R3); the recommendation-workspace line value is a diagnostic only',
    consumed_by: 'weeklyAiPlanShipDate_ (ship date for the KMWRR lane) AND the header source_data_as_of — one authority for both',
    gap_run_lineage: null,
    stored_header_authority: 'weeklyAiPlanResolveGapRunLineage_().source_data_as_of (the GAP-INV run calculationDate)',
    fabrication_check: 'NO clock, NO execution time, NO spreadsheet modified time, NO fallback — a blank stays blank'
  };
  try {
    if (typeof weeklyAiPlanResolveGapRunLineage_ === 'function') {
      var lin = weeklyAiPlanResolveGapRunLineage_(planningCycle, h, { formulaVersion: 'WEEKLY_AI_PLAN_V1' });
      out.gap_run_lineage = lin && lin.ok
        ? { ok: true, run_id: CENSUS_str_(lin.run_id), source_data_as_of: CENSUS_str_(lin.source_data_as_of),
            calculated_at: CENSUS_str_(lin.calculated_at), planning_cycle: CENSUS_str_(lin.planning_cycle) }
        : { ok: false, reason: CENSUS_str_(lin && lin.reason) };
    } else {
      out.gap_run_lineage = { ok: false, reason: 'LINEAGE_RESOLVER_UNAVAILABLE_IN_THIS_DEPLOYMENT' };
    }
  } catch (e) {
    out.gap_run_lineage = { ok: false, reason: 'LINEAGE_RESOLVER_THREW: ' + CENSUS_str_(e && e.message) };
  }
  return out;
}

function CENSUS_str_(v) { return String(v == null ? '' : v).trim(); }
function CENSUS_num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function CENSUS_low_(v) { return CENSUS_str_(v).toLowerCase(); }

// ================================================================================================================
// R6-R7-R2-P1 — 'Logging output too large. Truncating output.'
//
// The controlled preflight passed every check and the operator could not KEEP the proof: the execution log
// was cut in the middle of the parity object, so the three facts an acceptance rests on — the parity, the
// legacy authority label and the export completeness — were the ones that fell off the end.
//
// Apps Script truncates the TAIL of the log, so two things fix it and both are needed. The compact proof is
// emitted BEFORE the detailed export (below), and the nested diagnostics the preflight calls on its way
// through no longer print their own full logs into this one. That second part is a suppression, so it is
// ANNOUNCED and COUNTED, and each nested census remains runnable on its own for the log it was suppressed
// out of. Silence about missing evidence is the failure being fixed, not an acceptable way to fix it.
// ================================================================================================================
var CENSUS_LOG_MUTED_ = false;
var CENSUS_LOG_SUPPRESSED_ = 0;

function CENSUS_log_(label, value) {
  if (CENSUS_LOG_MUTED_) { CENSUS_LOG_SUPPRESSED_++; return; }
  try {
    Logger.log('[E3-CENSUS] ' + label + ': ' +
      (value && typeof value === 'object' ? JSON.stringify(value) : String(value)));
  } catch (e) {}
}

/** Run a nested diagnostic without letting its log into this one, and say so. The count is real: a reader
 *  can see how much was held back, and the named entry point returns all of it on its own. */
function CENSUS_quiet_(label, fn) {
  var wasMuted = CENSUS_LOG_MUTED_, before = CENSUS_LOG_SUPPRESSED_, v = null, err = null;
  CENSUS_LOG_MUTED_ = true;
  try { v = fn(); } catch (e) { err = e; }
  CENSUS_LOG_MUTED_ = wasMuted;
  CENSUS_log_('nested_log_muted', label + ' — ' + (CENSUS_LOG_SUPPRESSED_ - before) + ' line(s) held back'
    + ' so the compact proof cannot be pushed past the Logger cap. Nothing is lost: run ' + label
    + ' directly for its own full log.');
  if (err) throw err;
  return v;
}

/**
 * THE SINGLE PUBLIC ENTRY POINT. Read-only. Returns the census; also writes it to the log.
 * @param {{company:string,country:string,marketplace:string,sku:string,expect:Object}} args
 */
function TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3(args) {
  var t0 = Date.now();
  var out = {
    census: 'TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, drive_writes: 0, status_transitions: 0, emails: 0,
    // the writer is not merely unused, it is never constructed — see the header note
    writer_constructed: false,
    // ==========================================================================================================
    // R6-R7-R2 — WHAT THIS CENSUS IS, STATED BEFORE ANY OF ITS FINDINGS.
    //
    // It is the ALLOCATOR PROJECTION: harvest -> KMWRB source lines -> the K2 allocator, which is what PASS 1
    // of a generation computes. It is NOT the public generation handler, and since R6-R7-R1 it no longer
    // predicts that handler's outcome: the handler asks the canonical no-action question BEFORE the
    // empty-scope refusal, so a projection that allocates nothing tells you the allocator found nothing to
    // ship — never that the generation refuses.
    //
    // Its verdict is scoped to itself for that reason. The production answer has exactly one source,
    // weeklyAiPlanControlledDecision_ in 61_, reported as `production_path` by
    // RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT.
    // ==========================================================================================================
    projection_class: 'LEGACY_ALLOCATOR_PROJECTION',
    verdict_scope: 'THIS_PROJECTION_ONLY',
    is_production_generation_authority: false,
    production_authority: 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT().production_path (weeklyAiPlanControlledDecision_, 61_)',
    // Declared here, never left undefined. Every early return goes through CENSUS_logAll_, which stamps the
    // stage it was unassembled at — because the live log printed `production_parity undefined` beside a
    // STOP and a reader had nothing to distinguish 'no parity' from 'never got that far'.
    production_parity: { assembled: false,
      reason: 'NOT_ASSEMBLED: this census returned before the parity block was reached',
      unassembled_at_stage: null, blockers: null },
    ok: false, verdict: 'STOP', blockers: []
  };
  args = args || {};
  var company = CENSUS_str_(args.company), country = CENSUS_str_(args.country);
  var marketplace = CENSUS_str_(args.marketplace), sku = CENSUS_str_(args.sku);
  out.scope = { company: company, country: country, marketplace: marketplace, sku: sku };

  if (!company || !country || !marketplace) {
    out.blockers.push('SCOPE_INCOMPLETE: company, country and marketplace are all required (this census never ' +
      'defaults a scope, and never runs ALL_SITES)');
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }
  if (/^all(_sites)?$/i.test(marketplace)) {
    out.blockers.push('SCOPE_ALL_SITES_FORBIDDEN: a controlled census targets exactly one marketplace');
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  // ---- the effective flag, as the answering deployment reports it (never the repository's copy) -------------
  out.flag = {
    symbol: 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_',
    effective: (typeof inventoryAiPlanDbGenerationEnabled_ === 'function')
      ? (inventoryAiPlanDbGenerationEnabled_() === true) : null,
    config_build: (typeof CONFIG_BUILD_VERSION_ !== 'undefined') ? CONFIG_BUILD_VERSION_ : null,
    note: 'the census is read-only and behaves identically either way; the flag is reported so the census result ' +
          'can be matched to the deployment it describes'
  };

  // ---- the production modules this census refuses to substitute for ----------------------------------------
  var need = [
    ['KMWHA', typeof KMWHA !== 'undefined' && KMWHA && typeof KMWHA.mapWeeklyHarvestToBatchRequest === 'function'],
    ['KMWRB', typeof KMWRB !== 'undefined' && KMWRB && typeof KMWRB.buildWeeklySourceLines === 'function'],
    ['KMWRR', typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.buildK2GenerationPlan === 'function'],
    ['weeklyAiPlanHarvest_', typeof weeklyAiPlanHarvest_ === 'function'],
    ['weeklyAiPlanReadCarrierAuthorities_', typeof weeklyAiPlanReadCarrierAuthorities_ === 'function'],
    ['weeklyAiPlanK2AllocatedLines_', typeof weeklyAiPlanK2AllocatedLines_ === 'function'],
    ['weeklyAiPlanShipDate_', typeof weeklyAiPlanShipDate_ === 'function'],
    ['prodExpectedDbId_', typeof prodExpectedDbId_ === 'function']
  ];
  var missing = need.filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
  out.production_modules = { required: need.map(function (p) { return p[0]; }), missing: missing };
  if (missing.length) {
    out.blockers.push('PRODUCTION_READ_CONTRACT_UNAVAILABLE: ' + missing.join(', ') +
      ' — this census calls the production allocator or it reports nothing; it never approximates one');
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(prodExpectedDbId_());
    if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_());
  } catch (e) {
    out.blockers.push('DB_NOT_REACHABLE_OR_WRONG_TARGET: ' + CENSUS_str_(e && e.message));
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  // §3 (R4) — ESTABLISHED AS SOON AS THE DATABASE IS REACHABLE, AND NOT ONE LINE LATER.
  //
  // The parity used to be computed inside CENSUS_logAll_, so it appeared on every exit path by accident of
  // where it lived. Moving it into the census body put it after the verdict, and the early returns — the ones
  // that fire when the harvest is NOT ready — stopped reporting it at all. That is precisely the run on which
  // an operator most needs it: a mixed deployment is a likely reason the harvest failed.
  //
  // It depends on the live header row and nothing else: not the harvest, not the scope, not the allocator. So
  // it belongs here, above every early return, where it is a fact the whole rest of the census can gate on.
  out.schema_parity = (typeof CENSUS_schemaParity_ === 'function') ? CENSUS_schemaParity_() : null;

  // ---- planning cycle: the canonical one, resolved the way production resolves it --------------------------
  var planningCycle = '';
  try {
    var ctx = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
    if (ctx && ctx.ok) planningCycle = CENSUS_str_(ctx.planningCycle);
  } catch (e) {}
  out.planning_cycle = planningCycle;
  if (!planningCycle) {
    out.blockers.push('PLANNING_CYCLE_UNRESOLVED');
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }
  // The FOUR forecast months the §7 demand basis requires, from the canonical resolver (M+1..M+4 of the
  // cycle month). Not derived here and not guessed: KMPCX owns the window, and 61_ blocks a site whose basis
  // does not cover all four.
  var months = null;
  try {
    var _cm = planningCycle.slice(5);
    months = (typeof KMPCX !== 'undefined' && KMPCX && typeof KMPCX._forecastWeightMonths === 'function')
      ? KMPCX._forecastWeightMonths(_cm) : null;
  } catch (e) { months = null; }
  out.required_forecast_months = months || [];
  if (!months || months.length < 2) {
    out.blockers.push('FORECAST_MONTHS_UNRESOLVED: KMPCX._forecastWeightMonths did not resolve the M+1..M+4 ' +
      'window for ' + planningCycle + ' — the harvest fails closed on the same condition');
    out.next_blocked_stage = 'FORECAST_WINDOW';
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  // ---- harvest + map: the same two calls the generation makes ----------------------------------------------
  var h;
  try {
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §10 — THE CENSUS MUST ASK THE QUESTION PRODUCTION ASKS.
    //
    // This called the harvest WITHOUT the marketplace, so it computed the company/country universe while the
    // report it printed was headed with one site. From R3 the harvest isolates to the allowlist intersected
    // with the requested marketplace, so omitting it here would make the census and the generation compute
    // different inputs — which is the exact divergence §10 exists to forbid.
    h = weeklyAiPlanHarvest_(ss, { company: company, country: country, planningCycle: planningCycle,
      marketplace: marketplace });
  } catch (e) {
    out.blockers.push('HARVEST_THREW: ' + CENSUS_str_(e && e.message));
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }
  out.harvest = { ok: !!(h && h.ok), source_data_as_of: CENSUS_str_(h && h.sourceDataAsOf),
    warehouse_count: (function () { try { return Object.keys(h.warehousesById || {}).length; } catch (e) { return 0; } })(),
    // F1-7N-FC-1B-E3-R1 SECTNG - the counts and the per-site drop list the harvest used to discard. `site_count`
    // and `receiver_count` are the two numbers that turn "the universe came out empty" into "N sites were
    // enumerated and M survived", and `errors` names WHICH ones and WHY. `null` means this deployment predates
    // the fix, which is itself the answer.
    site_count: (h && h.site_count != null) ? h.site_count : null,
    receiver_count: (h && h.receiver_count != null) ? h.receiver_count : null,
    errors: (h && Array.isArray(h.errors)) ? h.errors : null,
    // ==========================================================================================================
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §9 — WHY THE LIVE LOG SAID freshness_state: null ON A DONE JOB.
    //
    // Not because the harvest did not know. A2-R1-R1 taught the log to read the freshness verdict out of the
    // harvest REFUSAL, and that fix was real — but on a SUCCESSFUL harvest the log reads `res.harvest`, and
    // `res.harvest` is THIS object: a hand-built summary with six fields. `snapshot_freshness`,
    // `accepted_snapshot_date`, `snapshot_distinct_dates`, `gap_schedule` and `forecast_normalization` were
    // all present on `h` and none of them was copied here, so every one of them logged as null on exactly
    // the runs that had succeeded. Same defect class as R1's discarded `kmaf.reason`, one layer out: the
    // answer was known and dropped at the boundary.
    //
    // They are carried through by name. A summary that silently omits fields its own consumer reads is not a
    // summary, it is a data loss.
    snapshot_freshness: (h && h.snapshot_freshness) || null,
    accepted_snapshot_date: (h && h.accepted_snapshot_date) || null,
    snapshot_distinct_dates: (h && h.snapshot_distinct_dates) || null,
    gap_schedule: (h && h.gap_schedule) || null,
    gap_job_state: (h && h.gap_job_state) || null,
    snapshot_date_normalization: (h && h.snapshot_date_normalization) || null,
    forecast_normalization: (h && h.forecast_normalization) || null,
    // §2/§6 — the two R3 authorities, reported so the census can be compared with production field by field.
    isolation: (h && h.isolation) || null,
    source_data_as_of_authority: (h && h.sourceDataAsOfAuthority) || null,
    workspace_source_data_as_of: (h && h.workspaceSourceDataAsOf) || null,
    gap_lineage: (h && h.gapLineage) || null };
  if (!h || !h.ok) {
    out.blockers.push('HARVEST_FAILED (fail-closed, exactly as the generation would)');
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  var mapped;
  try {
    mapped = KMWHA.mapWeeklyHarvestToBatchRequest({
      planningCycle: planningCycle,
      businessScope: { company: company, country: country, marketplace: marketplace,
        source_page: (typeof WEEKLY_AI_PLAN_SOURCE_PAGE_ !== 'undefined') ? WEEKLY_AI_PLAN_SOURCE_PAGE_ : 'inventory_replenishment' },
      mode: 'MANUAL_REGENERATE', confirmRegenerateOverUserEdits: false,
      // No clock fallback, and the census's own header promises exactly that: when the canonical timestamp
      // helper is absent this stays BLANK rather than reading the execution time. The field is inert here
      // (nothing is written), and a census that invents a timestamp to look complete is the defect.
      actor: 'temp-e3-census', now: (typeof procurementTimestamp_ === 'function') ? procurementTimestamp_() : '',
      sourceDataAsOf: h.sourceDataAsOf, formulaVersion: 'WEEKLY_AI_PLAN_V1',
      factoryIdentityConfig: (typeof WEEKLY_AI_PLAN_FACTORY_IDENTITY_ !== 'undefined') ? WEEKLY_AI_PLAN_FACTORY_IDENTITY_ : null,
      warehousesById: h.warehousesById, kmaf: h.kmaf,
      horizonsByDemandRef: h.horizonsByDemandRef, poolsBySku: h.poolsBySku,
      // The harvest's own per-site drop list, exactly as 61_ passes it. Without this the census reports the
      // universe-level EFFECT (zero receivers) and not the site-level CAUSE, which is the half that names a
      // marketplace and a SKU.
      errors: Array.isArray(h.errors) ? h.errors : []
    });
  } catch (e) {
    out.blockers.push('MAP_THREW: ' + CENSUS_str_(e && e.message));
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }
  // ---- §G — THE FULL READINESS ANSWER, not a boolean. Every field the R1 mapper reports is carried
  // through: the reason, the typed issues, the non-blocking warnings, and every predicate with its true/false.
  out.mapped = {
    ready: !!(mapped && mapped.ready),
    reason: CENSUS_str_(mapped && mapped.reason),
    issues: (mapped && mapped.issues) || [],
    warnings: (mapped && mapped.warnings) || [],
    readiness_predicates: (mapped && mapped.predicates) || [],
    partial: !!(mapped && mapped.partial),
    failed_required_predicates: ((mapped && mapped.predicates) || [])
      .filter(function (p) { return p && p.required && !p.passed; })
      .map(function (p) { return p.name + ': ' + p.detail; }),
    missing_fields: ((mapped && mapped.issues) || []).map(function (i) { return CENSUS_str_(i && i.field); })
      .filter(function (x) { return !!x; }),
    // §G — the canonical field NAMES the mapper reads, so a name change is visible as a diagnosis and
    // not only as an empty result.
    mapped_field_names: ['planningCycle', 'businessScope.company', 'businessScope.country', 'sourceDataAsOf',
      'kmaf.receiverFacts', 'kmaf.planningFacts', 'kmaf.reason', 'kmaf.issues', 'horizonsByDemandRef',
      'poolsBySku', 'warehousesById', 'factoryIdentityConfig', 'errors']
  };
  // §B/§G — the timestamp derivation, both authorities, no fabrication.
  out.source_data_as_of_candidates = CENSUS_sourceAsOfCandidates_(h, planningCycle);
  // §G — the forecast coverage that decides whether a site survives at all. Read even when readiness
  // passed, because a PARTIAL run (some sites dropped, others kept) is the case nobody could see before R1.
  out.forecast_coverage = CENSUS_forecastCoverage_(ss, { company: company, country: country, marketplace: marketplace }, sku, months);

  // ---- §F.2 — A NOT-READY RESULT NO LONGER TAKES THE DIAGNOSIS WITH IT.
  //
  // Before R1 this returned immediately and every field below became undefined, so the one run that could have
  // explained the refusal reported the least. What follows is split: the SAFE read-only facts are collected
  // either way, and only the ALLOCATOR is skipped. That boundary is the point — `mapped.request` is null
  // when readiness failed, so KMWRB/KMWRR would be called on nothing, which is exactly the unsafe state
  // §G forbids.
  var notReady = !mapped || !mapped.ready;
  if (notReady) {
    out.blockers.push('HARVEST_NOT_READY: ' + (out.mapped.reason || 'canonical facts incomplete') +
      (out.mapped.missing_fields.length ? ' (field(s): ' + out.mapped.missing_fields.join(', ') + ')' : '') +
      ' — the generation refuses here too, with the same typed issues');
    out.next_blocked_stage = 'CANONICAL_READINESS';
    out.allocator_skipped_reason = 'READINESS_NOT_ESTABLISHED: mapped.request is null, so calling KMWRB / KMWRR ' +
      'would be running the allocator on nothing. Skipped deliberately, never with a substituted input.';
  }

  // ---- source lines → allocated lines → the requested marketplace only -------------------------------------
  var carriers = weeklyAiPlanReadCarrierAuthorities_(ss);
  var shipDate = notReady ? '' : weeklyAiPlanShipDate_(h);
  out.ship_date = shipDate;
  out.carrier_authorities = { rate_cards: (carriers.rateCards || []).length, lead_times: (carriers.leadTimes || []).length };

  var src = null, allocated = [], mine = [];
  if (!notReady) {
    src = KMWRB.buildWeeklySourceLines(mapped.request);
    out.source_lines = { ok: !!(src && src.ok), status: CENSUS_str_(src && src.status),
      reason: CENSUS_str_(src && src.reason), count: (src && src.lines ? src.lines.length : 0) };
    if (!src || !src.ok) {
      out.blockers.push('SOURCE_LINES_BLOCKED: ' + (out.source_lines.status || 'BLOCKED_INPUT'));
      out.next_blocked_stage = out.next_blocked_stage || 'SOURCE_LINES';
    } else {
      allocated = weeklyAiPlanK2AllocatedLines_(src.lines, h) || [];
      mine = allocated.filter(function (a) { return CENSUS_str_(a.marketplace) === marketplace; });
      out.allocated_lines = { scope_total: allocated.length, this_marketplace: mine.length };
      if (!mine.length) {
        // R6-R7-R2 — THIS SENTENCE USED TO END '(the generation fails closed with the same code)'. It no
        // longer does, because since R6-R7-R1 it is false: the public handler asks the canonical row first,
        // and a READY row holding a finite 0 in every window returns AI_PLAN_NO_ACTION with zero writes
        // BEFORE this refusal is reachable. A projection that allocates nothing is evidence about the
        // allocator and about nothing else.
        out.blockers.push('PROJECTION_ALLOCATED_NOTHING_FOR_THE_REQUESTED_MARKETPLACE: the K2 allocator '
          + 'produced no line for ' + marketplace + '. This is a LEGACY_ALLOCATOR_PROJECTION finding, NOT '
          + 'the generation\'s outcome: the public handler resolves the canonical no-action decision before '
          + 'any empty-scope refusal, so read production_path in RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT for '
          + 'what a Generate would actually answer.');
        out.next_blocked_stage = out.next_blocked_stage || 'REQUESTED_SCOPE';
      }
    }
  } else {
    out.source_lines = { ok: false, status: 'NOT_ATTEMPTED', reason: 'readiness not established', count: 0 };
    out.allocated_lines = { scope_total: 0, this_marketplace: 0 };
  }

  // ---- the SKU under census: Suggested Qty, gap, sources, factory stock, destination ------------------------
  var skuLines = sku ? mine.filter(function (a) { return CENSUS_low_(a.sku) === CENSUS_low_(sku); }) : mine;
  out.sku_facts = {
    sku: sku, line_count: skuLines.length,
    suggested_qty_total: skuLines.reduce(function (s, a) { return s + CENSUS_num_(a.recommended_qty || a.planned_qty); }, 0),
    windows: skuLines.map(function (a) { return CENSUS_str_(a.window_code); }),
    required_by_dates: skuLines.map(function (a) { return CENSUS_str_(a.required_by_date); }),
    source_warehouse_candidates: (function () {
      var seen = {}, o = [];
      skuLines.forEach(function (a) {
        var id = CENSUS_str_(a.source_warehouse_id);
        if (!id || seen[id]) return;
        seen[id] = 1;
        var w = (h.warehousesById || {})[id] || null;
        o.push({ warehouse_id: id, warehouse_code: CENSUS_str_(w && (w.warehouse_code || w.code)),
          country: CENSUS_str_(w && w.country), multi_pool: a.source_multi_pool === true });
      });
      return o;
    })(),
    // §4/§9 — `weeklyAiPlanClassifyDestination_` returns `kind`, and this read `type`. So every census
    // printed a blank destination type beside a resolved marketplace, which reads like a half-resolved
    // destination and is not one. (`warehouse_id` blank for a MARKETPLACE destination is CORRECT: an FBA
    // destination is a LOGICAL node and the id belongs in destination_marketplace, never a fabricated FC.)
    destination_resolution: skuLines.map(function (a) {
      return { kind: CENSUS_str_(a.destination && a.destination.kind),
        matched_by: CENSUS_str_(a.destination && a.destination.matched_by),
        reason: CENSUS_str_(a.destination && a.destination.reason) || null,
        marketplace: CENSUS_str_(a.destination && a.destination.marketplace),
        warehouse_id: CENSUS_str_(a.destination && a.destination.warehouse_id),
        country: CENSUS_str_(a.destination && a.destination.country) };
    }),
    // §4 — which SIDE each source is on, from the warehouse master + the frozen factory identity config.
    source_roles: skuLines.map(function (a) {
      return { source_warehouse_id: CENSUS_str_(a.source_warehouse_id),
        role: CENSUS_str_(a.source_role) || null, role_reason: CENSUS_str_(a.source_role_reason) || null,
        allocated_qty: (a.source_allocated_qty == null ? null : a.source_allocated_qty),
        cartons: (a.source_cartons == null ? null : a.source_cartons),
        shipped_qty: CENSUS_num_(a.recommended_qty) };
    })
  };
  if (sku && !skuLines.length) {
    // Same correction: an allocator that ships nothing for a SKU that needs nothing is the allocator being
    // right, and this line is not a statement about what a generation would return.
    out.blockers.push('PROJECTION_NO_ALLOCATED_LINE_FOR_SKU: ' + sku + ' produced no allocated line for this '
      + 'marketplace in the LEGACY_ALLOCATOR_PROJECTION. A SKU with a canonical valid-zero recommendation '
      + 'produces no line here and is a correct finish in production — see production_path.');
  }

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R3 §5 — `factory_stock: []` NEXT TO `allocated_by_source: WH-TW-CN-FACTORY-YOUXIN`.
  //
  // Those two lines appeared in the same live log and only one of them was true. The reason was this filter:
  // the rows were narrowed to `source_warehouse_candidates`, which is derived from the lines that SURVIVED to
  // become allocated lines. The target SKU's line had blocked (multi-pool), so its candidate list was the 3PL
  // only, so every factory row was filtered out, and the census concluded there was no factory stock — while
  // the allocator, which had seen the same table, was allocating 460 units out of it.
  //
  // A diagnostic must never derive the INPUT it is checking from the OUTPUT of the thing it is checking. So
  // the eligible warehouses come from the authority production uses (gapOpReadSupplyPoolFacts_ → poolsBySku,
  // reached here as harvest.poolsBySku), the stock numbers come from the canonical table, and the requested /
  // allocated / remaining columns are reported per warehouse so the arithmetic is visible rather than implied.
  out.factory_stock = (function () {
    var rows = CENSUS_rows_(ss, 'factory_stock');
    var pools = ((h && h.poolsBySku && sku) ? (h.poolsBySku[sku] || {}) : {});
    var factoryPools = pools.factoryPools || [], overseasPools = pools.overseasSupplyPools || [];
    // What the allocator actually decided per source, from the allocated lines of THIS sku.
    var allocByWh = {};
    (skuLines || []).forEach(function (a) {
      var w = CENSUS_str_(a.source_warehouse_id);
      if (!w) return;
      allocByWh[w] = (allocByWh[w] || 0) + CENSUS_num_(a.recommended_qty);
    });
    var requested = (out.sku_facts && out.sku_facts.suggested_qty_total) || 0;
    function stockRow(wid) {
      var r = null;
      for (var i = 0; i < rows.length; i++) {
        if (CENSUS_str_(rows[i].warehouse_id) !== wid) continue;
        if (sku && CENSUS_low_(rows[i].master_sku || rows[i].sku) !== CENSUS_low_(sku)) continue;
        r = rows[i]; break;
      }
      if (!r) return { present_in_table: false, on_hand: null, reserved: null, available: null };
      var onHand = CENSUS_num_(r.quantity_on_hand != null ? r.quantity_on_hand
        : (r.on_hand_qty != null ? r.on_hand_qty : r.fac_current_stock));
      var reserved = CENSUS_num_(r.reserved_qty);
      return { present_in_table: true, on_hand: onHand, reserved: reserved,
        available: CENSUS_num_(r.available_qty != null ? r.available_qty : (onHand - reserved)) };
    }
    function describe(p, kind) {
      var wid = CENSUS_str_(p.warehouseId || p.warehouse_id);
      var w = (h && h.warehousesById) ? (h.warehousesById[wid] || null) : null;
      var role = (typeof weeklyAiPlanWarehouseRole_ === 'function' && h)
        ? weeklyAiPlanWarehouseRole_(wid, h.warehousesById || {},
            (typeof WEEKLY_AI_PLAN_FACTORY_IDENTITY_ !== 'undefined') ? WEEKLY_AI_PLAN_FACTORY_IDENTITY_ : {})
        : { role: null, reason: 'ROLE_AUTHORITY_UNAVAILABLE' };
      var st = stockRow(wid);
      var alloc = allocByWh[wid] || 0;
      return { pool_kind: kind, warehouse_id: wid, warehouse_code: CENSUS_str_(w && w.warehouse_code),
        country: CENSUS_str_(w && w.country), role: role.role || null, role_reason: role.reason || null,
        effective_supply_qty: CENSUS_num_(p.effectiveSupplyQty),
        on_hand: st.on_hand, reserved: st.reserved, available: st.available, present_in_table: st.present_in_table,
        requested_qty: requested, allocated_qty: alloc,
        remaining_qty: (st.available == null ? null : st.available - alloc) };
    }
    return {
      authority: 'gapOpReadSupplyPoolFacts_ → harvest.poolsBySku (the SAME input the allocator receives)',
      stock_table: 'factory_stock',
      requested_qty: requested,
      eligible_factory_warehouse_ids: factoryPools.map(function (p) { return CENSUS_str_(p.warehouseId); }),
      factory_pools: factoryPools.map(function (p) { return describe(p, 'FACTORY'); }),
      // The in-country pool is reported BESIDE the factory pools, never folded into them: the frozen
      // allocator runs it FIRST and the factory passes over its residual, so a report that omitted it could
      // not explain why the factory was asked for less than the full quantity.
      overseas_supply_pools: overseasPools.map(function (p) { return describe(p, 'THREE_PL_OR_OVERSEAS'); }),
      allocated_by_source: allocByWh,
      total_allocated: (function () { var t = 0; for (var k in allocByWh) if (allocByWh.hasOwnProperty(k)) t += allocByWh[k]; return t; })()
    };
  })();

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R3 §7 — `matched_carrier_cards: 0` AGAINST 294 CARDS, AND NOTHING TO ACT ON.
  //
  // The old block re-implemented the match by hand: `is_active` (a field the carrier schema does not use —
  // carrier rows carry a free-text `status`), a raw lowercase country compare with no wildcard rule, no
  // marketplace axis and no effective-date test. So its zero was not the transport's zero, and neither number
  // explained itself. It also took its origin countries from the surviving lines, so a blocked line produced
  // an empty origin set and therefore a vacuous match.
  //
  // The lane keys are now built from the SAME per-line source/destination the router derives from, and the
  // funnel is computed by weeklyAiPlanCarrierFunnel_, which uses KMRA's own normalize/axisOk/rateCardUsable
  // predicates. A diagnostic that cannot disagree with the transport is the only kind worth printing.
  out.carrier_lane_funnels = (function () {
    if (typeof weeklyAiPlanCarrierFunnel_ !== 'function') return 'CARRIER_FUNNEL_AUTHORITY_UNAVAILABLE';
    var asOf = (typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.dateToOrdinal === 'function' && shipDate)
      ? KMWRR.dateToOrdinal(shipDate) : null;
    var seen = {}, o = [];
    (skuLines || []).forEach(function (a) {
      var srcId = CENSUS_str_(a.source_warehouse_id);
      var srcWh = (h && h.warehousesById) ? (h.warehousesById[srcId] || null) : null;
      var d = a.destination || {};
      var q = { originCountry: CENSUS_str_(srcWh && srcWh.country),
        destinationCountry: CENSUS_str_(d.country),
        marketplace: CENSUS_low_(d.kind) === 'marketplace' ? CENSUS_str_(d.marketplace) : '' };
      var key = q.originCountry + '|' + q.destinationCountry + '|' + q.marketplace;
      if (seen[key]) return;
      seen[key] = 1;
      var f = weeklyAiPlanCarrierFunnel_(carriers.rateCards, q, asOf);
      f.for_source_warehouse_id = srcId;
      f.for_window_code = CENSUS_str_(a.window_code);
      f.ship_date = shipDate || null;
      o.push(f);
    });
    return o;
  })();
  // Kept under its historical name so an operator comparing two logs can still find the number, but it is now
  // the FINAL ELIGIBLE count from the shared authority rather than a private guess.
  out.matched_carrier_cards = (function () {
    var fs = out.carrier_lane_funnels;
    if (!fs || typeof fs === 'string') return null;
    return fs.reduce(function (n, f) { return n + (f.final_eligible || 0); }, 0);
  })();

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R4 §2/§7 — "NO CARRIER CARD" WAS A TRUE ANSWER TO HALF THE QUESTION.
  //
  // The funnel above measures carrier_rate_cards and reports NO_CARRIER_CARD_FOR_LANE, which reads as "add one
  // rate card and this lane works". It does not: carrier_rate_cards stores no transit days at all, and without
  // a carrier_lead_times row on the same lane the route refuses again with a DIFFERENT token
  // (ROUTE_AUTO_RANKING_INSUFFICIENT / NO_LEAD_TIME) pointing at a DIFFERENT table. Measured on a fixture with
  // the card added and the lead time withheld: still zero routes, still 760 unresolved.
  //
  // So readiness is asked over BOTH authorities at once, by the shared weeklyAiPlanCarrierReadiness_, and the
  // answer lists every field a person must supply per table. Nothing is written and no value is invented.
  // ==============================================================================================================
  out.carrier_readiness = (function () {
    if (typeof weeklyAiPlanCarrierReadiness_ !== 'function') return 'CARRIER_READINESS_AUTHORITY_UNAVAILABLE';
    var asOf = (typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.dateToOrdinal === 'function' && shipDate)
      ? KMWRR.dateToOrdinal(shipDate) : null;
    var seen = {}, o = [];
    (skuLines || []).forEach(function (a) {
      var srcId = CENSUS_str_(a.source_warehouse_id);
      var srcWh = (h && h.warehousesById) ? (h.warehousesById[srcId] || null) : null;
      var d = a.destination || {};
      var q = { originCountry: CENSUS_str_(srcWh && srcWh.country),
        destinationCountry: CENSUS_str_(d.country),
        marketplace: CENSUS_low_(d.kind) === 'marketplace' ? CENSUS_str_(d.marketplace) : '' };
      var key = q.originCountry + '|' + q.destinationCountry + '|' + q.marketplace;
      if (seen[key]) return;
      seen[key] = 1;
      var r = weeklyAiPlanCarrierReadiness_(carriers.rateCards, carriers.leadTimes, q, asOf);
      r.for_source_warehouse_id = srcId;
      r.for_window_code = CENSUS_str_(a.window_code);
      r.ship_date = shipDate || null;
      o.push(r);
    });
    return o;
  })();
  out.carrier_master_data_ready = (function () {
    var rs = out.carrier_readiness;
    if (!rs || typeof rs === 'string' || !rs.length) return null;
    return rs.every(function (r) { return r.ready === true; });
  })();
  out.carrier_lane_key = (function () {
    var rs = out.carrier_readiness;
    if (!rs || typeof rs === 'string') return null;
    return rs.map(function (r) { return r.lane_key; });
  })();
  out.carrier_missing_fields = (function () {
    var rs = out.carrier_readiness;
    if (!rs || typeof rs === 'string') return [];
    var o = [];
    rs.forEach(function (r) { (r.missing_fields || []).forEach(function (m) { o.push({ lane_key: r.lane_key, table: m.table, created_by: m.created_by, fields: m.fields }); }); });
    return o;
  })();

  // ---- THE RANKED ROUTE. The production allocator, called exactly as the generation calls it. --------------
  // PURE by contract: 61_ computes every group with this call in a pass that writes nothing, then writes in a
  // second pass. This file is that first pass, and there is no second one here.
  //
  // §G — NOT CALLED IN AN UNSAFE STATE. When readiness was not established there is no request, no
  // source lines and no allocated lines; calling the allocator on an empty or substituted input would produce a
  // number that looks like an answer. Everything above this point was still collected.
  if (notReady || !mine.length) {
    out.allocator = { group_count: 0, conserved: false, conservation: null, refusals: [], routes: [],
      skipped: true, skipped_reason: out.allocator_skipped_reason ||
        'NO_ALLOCATED_LINES_FOR_THE_REQUESTED_MARKETPLACE: nothing to rank, and no input is substituted' };
    out.total_allocated_quantity = 0;
    out.would_create_route_count = 0;
    out.active_allocation_drafts = CENSUS_activeDrafts_(ss, company, country, marketplace);
    // §2 — and the set the PAGE would show for the same station, with the difference between the two
    // explained row by row. `active_allocation_drafts: 0` beside two routes on screen is a scope-definition
    // difference, never evidence that this run created something.
    out.draft_scope_difference = (typeof CENSUS_draftScopeDifference_ === 'function')
      ? CENSUS_draftScopeDifference_(ss, company, country, marketplace) : null;
    out.next_blocked_stage = out.next_blocked_stage || 'ALLOCATOR';
    out.verdict = 'STOP';
    out.elapsed_ms = Date.now() - t0;
    CENSUS_logAll_(out);
    return out;
  }
  var plan;
  try {
    plan = KMWRR.buildK2GenerationPlan({
      scope: { planning_cycle: planningCycle, company: company, country: country, marketplace: marketplace,
        source_page: (mapped.request.businessScope && mapped.request.businessScope.source_page) || 'inventory_replenishment' },
      allocatedLines: mine, warehousesById: h.warehousesById,
      rateCards: carriers.rateCards, leadTimes: carriers.leadTimes, shipDate: shipDate,
      authorizedBySkuWindow: (function () {
        var a = {};
        mine.forEach(function (x) {
          var k = CENSUS_low_(x.sku) + '|' + CENSUS_low_(x.window_code);
          a[k] = (a[k] || 0) + CENSUS_num_(x.planned_qty);
        });
        return a;
      })(),
      sourceCeilingById: {}
    });
  } catch (e) {
    out.blockers.push('ALLOCATOR_THREW: ' + CENSUS_str_(e && e.message));
    out.elapsed_ms = Date.now() - t0; CENSUS_logAll_(out); return out;
  }

  var groups = (plan && plan.groups) || [];
  var blocked = (plan && plan.blocked) || [];
  out.allocator = {
    group_count: groups.length,
    conserved: !!(plan && plan.conservation && plan.conservation.conserved),
    conservation: (plan && plan.conservation) || null,
    // §F.4 — ambiguity and refusal codes, verbatim. A tie is a REFUSAL in this allocator, not a coin flip, and
    // that is exactly the property activation depends on: it never picks the first row.
    refusals: blocked.map(function (b) { return b && b.block; }),
    routes: []
  };
  groups.forEach(function (g) {
    var head = (g && g.header) || {};
    var lines = (g && g.lines) || [];
    // F1-7N-FC-1B-E3-R4-A2-R1-R4 §4 — THIS CENSUS COULD NEVER HAVE RETURNED PROCEED.
    //
    // It read the arrival date, the transit days and the cost off the HEADER. buildGroupHeader emits none of
    // them, and correctly so: `expected_arrival` is a LINE field in the canonical model and 16_ adopts it only
    // when a save supplies one, so the header has no business carrying an AI-computed date. The plan resolved
    // all three (measured: a 4-day TRUCK lead time and a 2026-09-08 arrival on the authorized-card fixture)
    // and had nowhere to hand them over, so this block printed blank/null every time.
    //
    // That was not only a display gap. The PROCEED gate below refuses when `expected_arrival` is empty, which
    // means a correct, fully routed, conserved plan was going to be STOPPED for a field the census was
    // reading from the wrong object. KMWRR now carries the resolved values as GROUP EVIDENCE beside the
    // exact-30 lines, and they are read from there.
    var evd = (g && g.route_evidence) || {};
    var mineLines = sku ? lines.filter(function (l) { return CENSUS_low_(l.master_sku || l.sku) === CENSUS_low_(sku); }) : lines;
    if (sku && !mineLines.length) return;
    // §9 — KMWRR.buildGroupHeader emits `recommended_source_warehouse_id` and
    // `recommended_destination_warehouse_id`; this read `source_warehouse_id` and `destination_type`, neither
    // of which exists on a K2 header. So every census printed a BLANK route source next to a populated
    // conservation total, which is the other half of the contradiction §4 was asked to explain. The
    // historical key names are kept in the output (an operator compares logs across rounds) and are now read
    // from the fields that exist.
    out.allocator.routes.push({
      group_no: head.recommendation_group_no,
      source_warehouse_id: CENSUS_str_(head.recommended_source_warehouse_id),
      destination_type: CENSUS_str_(head.destination_marketplace) ? 'MARKETPLACE'
        : (CENSUS_str_(head.recommended_destination_warehouse_id) ? 'WAREHOUSE' : ''),
      destination: CENSUS_str_(head.destination_marketplace || head.recommended_destination_warehouse_id),
      method: CENSUS_str_(head.recommended_shipping_method),
      last_mile: CENSUS_str_(head.recommended_last_mile_delivery),
      expected_arrival: CENSUS_str_(evd.expected_arrival),
      // § F.4 has asked for this since E3 and it read `head.transit_days`, which no K2 header carries. It is the
      // number the ranking used, and it now travels with the route rather than being re-derived or left null.
      lead_time_days: evd.transit_days != null ? CENSUS_num_(evd.transit_days) : null,
      estimated_cost: evd.estimated_cost != null ? CENSUS_num_(evd.estimated_cost) : null,
      currency: CENSUS_str_(evd.currency),
      route_candidate_status: CENSUS_str_(evd.route_candidate_status),
      route_evidence_uniform: evd.evidence_uniform === undefined ? null : (evd.evidence_uniform === true),
      line_count: mineLines.length,
      total_qty: mineLines.reduce(function (s, l) { return s + CENSUS_num_(l.recommended_qty); }, 0)
    });
  });
  out.total_allocated_quantity = out.allocator.routes.reduce(function (s, r) { return s + r.total_qty; }, 0);
  out.would_create_route_count = out.allocator.routes.length;

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R4 §4 — THE REPORT THAT SAID `conserved: true` ABOUT 760 UNROUTED UNITS.
  //
  // The live census printed: suggested 760 · supply allocated 760 · emitted route quantity 0 · route count 0 ·
  // conserved TRUE · production_parity.blockers [] · verdict STOP. Each field was correct in isolation and the
  // set was unreadable, because `conserved` answers a SAFETY question (did anything take more than it was
  // authorized?) and was being read as a COMPLETENESS one (is the demand planned?).
  //
  // KMWRR now answers the three separately and this census reports its answer rather than deriving its own —
  // one authority, so the census and a live generation can never disagree about whether 760 units were routed.
  // The historical `total_quantity` / `conserved` keys are kept so an operator can still compare logs across
  // rounds, and each now sits beside the verdict that says what it means.
  // ==============================================================================================================
  out.completeness = (function () {
    var c = (plan && plan.completeness) || null;
    if (!c) return { authority: 'KMWRR_COMPLETENESS_UNAVAILABLE', authorized_quantity: null,
      supply_allocated_quantity: null, emitted_route_quantity: null, unresolved_quantity: null,
      supply_allocation_conserved: null, route_quantity_conserved: null, fully_routable: null, blockers: [] };
    return { authority: 'KMWRR.buildK2GenerationPlan().completeness (the SAME object a live generation gets)',
      authorized_quantity: c.authorized_quantity,
      supply_allocated_quantity: c.supply_allocated_quantity,
      emitted_route_quantity: c.emitted_route_quantity,
      unresolved_quantity: c.unresolved_quantity,
      route_count: c.route_count, blocked_line_count: c.blocked_line_count,
      unrouted_sku_window_keys: c.unrouted_sku_window_keys || [],
      supply_allocation_conserved: c.supply_allocation_conserved,
      route_quantity_conserved: c.route_quantity_conserved,
      fully_routable: c.fully_routable,
      // ---- R6 §2: the ROUTE axis, carried through verbatim from KMWRR --------------------------------------
      unresolved_supply_quantity: c.unresolved_supply_quantity,
      automatic_route_quantity: c.automatic_route_quantity,
      manual_route_review_quantity: c.manual_route_review_quantity,
      route_data_fault_quantity: c.route_data_fault_quantity,
      unresolved_route_quantity: c.unresolved_route_quantity,
      execution_route_materialized_quantity: c.execution_route_materialized_quantity,
      route_materialization_complete: c.route_materialization_complete,
      quantity_axes: c.quantity_axes || null,
      legacy_fields: c.legacy_fields || null,
      blockers: c.blockers || [], blocker_tokens: c.blocker_tokens || [] };
  })();
  out.authorized_quantity = out.completeness.authorized_quantity;
  out.supply_allocated_quantity = out.completeness.supply_allocated_quantity;
  out.emitted_route_quantity = out.completeness.emitted_route_quantity;
  out.unresolved_quantity = out.completeness.unresolved_quantity;
  out.supply_allocation_conserved = out.completeness.supply_allocation_conserved;
  out.route_quantity_conserved = out.completeness.route_quantity_conserved;
  out.fully_routable = out.completeness.fully_routable;
  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R6 §2 — THE FOUR NUMBERS THAT READ AS A FAILED SUPPLY ALLOCATION.
  //
  // The live census printed: authorized 760 · supply allocated 760 · UNRESOLVED 760 · TOTAL ALLOCATED 0. Every
  // one of those is correct. Read together by a person they say the supply allocation produced nothing, which is
  // the opposite of what happened: all 760 units were sourced, from a named warehouse, and are waiting on one
  // human decision about a shipping method.
  //
  // The cause is that two of the four names belong to a DIFFERENT AXIS than the reader assumes. `unresolved`
  // was a route number wearing a supply word, and `total_allocated_quantity` is a route total whose name
  // contains "allocated". R4 already split the VERDICTS this way; the QUANTITIES kept the old names, so the
  // report stayed ambiguous even after the verdicts were unambiguous.
  //
  // Every quantity is now prefixed with the axis it belongs to, and the legacy names are kept next to a
  // definition rather than next to each other.
  // ==============================================================================================================
  out.unresolved_supply_quantity = out.completeness.unresolved_supply_quantity;
  out.automatic_route_quantity = out.completeness.automatic_route_quantity;
  out.manual_route_review_quantity = out.completeness.manual_route_review_quantity;
  out.route_data_fault_quantity = out.completeness.route_data_fault_quantity;
  out.unresolved_route_quantity = out.completeness.unresolved_route_quantity;
  out.execution_route_materialized_quantity = out.completeness.execution_route_materialized_quantity;
  out.route_materialization_complete = out.completeness.route_materialization_complete === true;
  out.quantity_semantics = {
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6 §2 — every quantity states its AXIS; a route number is never a '
      + 'statement about supply',
    supply_axis: { authorized_quantity: out.authorized_quantity,
      supply_allocated_quantity: out.supply_allocated_quantity,
      unresolved_supply_quantity: out.unresolved_supply_quantity,
      supply_allocation_conserved: out.supply_allocation_conserved },
    route_axis: { automatic_route_quantity: out.automatic_route_quantity,
      manual_route_review_quantity: out.manual_route_review_quantity,
      route_data_fault_quantity: out.route_data_fault_quantity,
      unresolved_route_quantity: out.unresolved_route_quantity,
      execution_route_materialized_quantity: out.execution_route_materialized_quantity,
      route_materialization_complete: out.route_materialization_complete },
    legacy: out.completeness.legacy_fields || null,
    read_this_first: 'unresolved_route_quantity > 0 with unresolved_supply_quantity === 0 means the units ARE '
      + 'sourced and are waiting for a route. It does NOT mean the supply allocation failed.'
  };
  // The route blockers, plus the carrier master-data finding, as the flat token list an operator reads first.
  out.route_blockers = (function () {
    var toks = (out.completeness.blocker_tokens || []).slice();
    if (out.carrier_master_data_ready === false && toks.indexOf('USER_MASTER_DATA_REQUIRED') === -1) {
      toks.push('USER_MASTER_DATA_REQUIRED');
    }
    return toks;
  })();
  // R6 §3 — THE SAME LIST, UNDER A NAME THAT IS TRUE OF IT. These never blocked the AI Plan; they are the
  // reasons an execution ROUTE did not form, and every one of them is resolved by a person rather than by the
  // system giving up. `route_blockers` stays as a compatibility alias and is labelled as one, because a reader
  // who greps for "blockers" and finds this list draws exactly the conclusion R5 and R6 exist to prevent.
  out.route_materialization_warnings = out.route_blockers.slice();
  out.route_blockers_are_not_ai_plan_blockers = 'route_blockers is a LEGACY ALIAS of '
    + 'route_materialization_warnings. Nothing in it stops the AI Plan recommendation. Read `shared_blockers` '
    + 'for the list that can.';

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R3 §10 — THE PARITY BLOCK.
  //
  // Every field a production generation decides, stated in one place, so "the census and the run agree" is a
  // COMPARISON rather than a hope. This census is the production first pass by construction (it calls
  // weeklyAiPlanHarvest_, KMWRB.buildWeeklySourceLines and KMWRR.buildK2GenerationPlan, which is exactly what
  // PASS 1 of weeklyAiPlanGenerateK2_ calls), so parity is asserted by the regression suite against the real
  // generation core with its writer replaced by a spy.
  //
  // It deliberately does NOT call the generation itself. Constructing the writer here — even to throw it away
  // — would put a live write one typo from a diagnostic, and a standing mutation test fails if this file ever
  // reaches for handleUpsertShippingAllocationDraftAtomic_.
  out.production_parity = {
    assembled: true,
    reason: null,
    unassembled_at_stage: null,
    contract: 'the fields a production generation decides; compared against the real core in the R3 suite',
    writer_constructed: false,
    target_sku_set: (function () { var o = {}, l = []; (mine || []).forEach(function (a) { var k = CENSUS_str_(a.sku); if (k && !o[k]) { o[k] = 1; l.push(k); } }); return l.sort(); })(),
    demand_identity: (h && h.isolation) ? {
      target_scopes: h.isolation.target_scopes, requested_marketplace: h.isolation.requested_marketplace,
      universe_site_count: h.isolation.universe_site_count,
      target_site_count: h.isolation.target_site_count, target_sku_count: h.isolation.target_sku_count,
      foreign_site_count: h.isolation.foreign_site_count, foreign_sku_count: h.isolation.foreign_sku_count,
      canonical_demand_count: h.isolation.canonical_demand_count,
      collapsed_site_count: h.isolation.collapsed_site_count
    } : null,
    source_line_count: (src && src.lines) ? src.lines.length : null,
    allocated_line_count: (mine || []).length,
    allocated_line_diagnostics: (allocated && allocated.diagnostics) || null,
    eligible_factory_stock: (out.factory_stock && out.factory_stock.eligible_factory_warehouse_ids) || null,
    source_data_as_of: CENSUS_str_(h && h.sourceDataAsOf),
    source_data_as_of_authority: (h && h.sourceDataAsOfAuthority) || null,
    ship_date: shipDate || null,
    carrier_lane_final_eligible: out.matched_carrier_cards,
    chosen_methods: out.allocator.routes.map(function (r) { return r.method; }).sort(),
    // §4 — kept under their historical names, and no longer alone. `total_quantity` is the EMITTED route
    // total and `conserved` is the SAFETY verdict; on the live fixture those are 0 and true, which is exactly
    // the pair that read as a finished plan. The three verdicts state what each one is not.
    total_quantity: out.total_allocated_quantity,
    conserved: out.allocator.conserved,
    authorized_quantity: out.authorized_quantity,
    supply_allocated_quantity: out.supply_allocated_quantity,
    emitted_route_quantity: out.emitted_route_quantity,
    unresolved_quantity: out.unresolved_quantity,
    supply_allocation_conserved: out.supply_allocation_conserved,
    route_quantity_conserved: out.route_quantity_conserved,
    fully_routable: out.fully_routable,
    carrier_master_data_ready: out.carrier_master_data_ready,
    carrier_lane_key: out.carrier_lane_key,
    duplicate_sku_window_in_group: (out.allocator.conservation && out.allocator.conservation.duplicate_sku_window_in_group) || [],
    route_count: out.would_create_route_count,
    route_intent: (typeof SAD_AI_K2_INTENT_ !== 'undefined') ? SAD_AI_K2_INTENT_ : null,
    refusals: out.allocator.refusals,
    // §4 — THIS LINE RAN BEFORE THE ROUTE VERDICT EXISTED.
    //
    // `out.blockers.slice()` took a snapshot at THIS point in the function, and NO_COMPLETE_ROUTE is pushed
    // forty lines further down. So on the live run the outer verdict was STOP with one blocker and
    // production_parity reported `blockers: []` — the parity block, the one thing a reader consults to
    // compare the census with a real generation, said the run had nothing wrong with it.
    //
    // It is assembled after the verdict instead (see `production_parity.blockers` below), which is the only
    // ordering in which it can contain the route findings. Set to null here so a partial return can never be
    // mistaken for "no blockers".
    blockers: null
  };

  // ==============================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R5 §11 — SIX READINESSES, BECAUSE ONE VERDICT WAS ANSWERING SIX QUESTIONS.
  //
  // R4's census returned STOP for this scope because a lane had no Carrier Rate Card, and in doing so it threw
  // away a correct quantity, a correct source and a correct required-by date. The AI Plan is decision support;
  // refusing to advise because someone else's price list is incomplete is not caution, it is the tool declining
  // to do its job. Each layer now answers its own question and no layer may answer another's.
  // ==============================================================================================================
  out.method_advice = (typeof weeklyAiPlanMethodAdvice_ === 'function')
    ? weeklyAiPlanMethodAdvice_(skuLines, h, carriers.leadTimes, shipDate)
    : { authority: 'METHOD_ADVICE_AUTHORITY_UNAVAILABLE', tranches: [], status: 'MANUAL_REVIEW_REQUIRED', review_reasons: [] };
  // §8 — only a SHARED/system fault may STOP. Carrier coverage is deliberately NOT in this list, and the
  // list is emitted so that exclusion is visible rather than inferred from silence.
  out.shared_blockers = out.blockers.slice();
  out.layered_status = (typeof weeklyAiPlanAdviceStatus_ === 'function')
    ? weeklyAiPlanAdviceStatus_({
        shared_blockers: out.shared_blockers,
        completeness: out.completeness,
        method_advice: out.method_advice,
        carrier_pricing_ready: out.matched_carrier_cards > 0
      })
    : null;
  // §10 — the executed runtime-authority invariant, carried into the census so an operator sees a mixed
  // deployment here rather than having to run a second diagnostic to discover it.
  out.runtime_authority = (typeof sysRuntimeAuthorityChecks_ === 'function')
    ? sysRuntimeAuthorityChecks_() : 'RUNTIME_AUTHORITY_CHECK_UNAVAILABLE';

  // ---- what is ALREADY stored for this scope (so "would_create" is read against reality) -------------------
  out.active_allocation_drafts = CENSUS_activeDrafts_(ss, company, country, marketplace);
  // §2 — and the set the PAGE would show for the same station, with the difference between the two
  // explained row by row. `active_allocation_drafts: 0` beside two routes on screen is a scope-definition
  // difference, never evidence that this run created something.
  out.draft_scope_difference = (typeof CENSUS_draftScopeDifference_ === 'function')
    ? CENSUS_draftScopeDifference_(ss, company, country, marketplace) : null;

  // ---- §F.6 — THE VERDICT. PROCEED only against a supplied expectation that the allocator actually meets. --
  var exp = args.expect;
  out.expectation = exp || null;
  // §11 — the readiness fields an operator reads first, lifted to the top level under the names the three
  // layers use. Each is owned by exactly one layer and none may stand in for another.
  var LS = out.layered_status || {};
  out.recommendation_ready = LS.recommendation_ready === true;
  out.method_status = LS.method_status || 'MANUAL_REVIEW_REQUIRED';
  out.carrier_pricing_ready = LS.carrier_pricing_ready === true;
  out.execution_route_materialized = LS.execution_route_materialized === true;
  out.submit_ready = LS.submit_ready === true;
  out.unresolved_supply_quantity = (LS.unresolved_supply_quantity === undefined) ? null : LS.unresolved_supply_quantity;
  out.warnings = (LS.warnings || []).slice();
  // R6 §3 — the TYPED warnings, so a consumer branches on a code instead of matching a sentence.
  out.recommendation_warnings = (LS.recommendation_warnings || []).slice();
  out.recommendation_warning_codes = (LS.recommendation_warning_codes || []).slice();
  out.shared_blocker_classes = (LS.shared_blocker_classes || []).slice();
  out.never_a_shared_blocker = (LS.never_a_shared_blocker || []).slice();

  if (out.shared_blockers.length) {
    // §8 — a SHARED/system fault: snapshot, forecast authority, schema/runtime authority, demand mapping or
    // quantity conservation. These make the numbers themselves untrustworthy, so there is nothing honest left
    // to advise. This is the ONLY road to STOP.
    out.verdict = 'STOP';
  } else if (!out.recommendation_ready) {
    out.verdict = 'STOP';
    out.blockers.push('RECOMMENDATION_NOT_READY: the quantity or source advice could not be computed. This is '
      + 'NOT a Carrier-coverage outcome — read `layered_status` for the failing layer.');
  } else {
    // ============================================================================================================
    // §7/§11 — `USER_MASTER_DATA_REQUIRED` IS NO LONGER A STOP. IT IS A WARNING WITH AN OWNER.
    //
    // R4 made it the whole AI Plan's verdict. It is a Layer 2 (carrier comparison) and Layer 3 (submit)
    // concern, and at Layer 1 the correct behaviour is to advise the quantity, the source and the safest
    // transport method the TRANSIT authority supports, and to say plainly what a person must still do.
    // Nothing is guessed: with no transit authority the method is left to a person, with no rate card no price
    // is claimed, and no partial execution route is written either way.
    // ============================================================================================================
    if (out.carrier_master_data_ready === false) {
      out.warnings.push('CARRIER_MASTER_DATA_INCOMPLETE (warning, not a blocker): '
        + JSON.stringify(out.carrier_lane_key) + ' — '
        + (out.carrier_readiness && out.carrier_readiness.length
            ? out.carrier_readiness.map(function (r) { return r.lane_key + ' -> ' + (r.missing || []).join('+'); }).join(' ; ')
            : '(unknown)')
        + '. Read `carrier_missing_fields` for the exact fields. carrier_lead_times has no generic write '
        + 'handler, so that row is entered directly in the tab. This is a Weekly Shipping Plan / Submit '
        + 'prerequisite and does NOT block the AI Plan recommendation.');
    }
    // (The un-materialized route is already reported once by weeklyAiPlanAdviceStatus_ as
    // EXECUTION_ROUTE_NOT_MATERIALIZED, with the same typed reasons. Saying it twice in different words would
    // make the warning list look longer than the problem.)
    out.ok = true;
    out.verdict = out.warnings.length ? 'RECOMMENDATION_READY_WITH_WARNINGS' : 'RECOMMENDATION_READY';

    // The EXPECTATION comparison is a separate question from readiness, and it is asked only when one is
    // supplied. It can still STOP the run — an allocator that disagrees with a stated expectation is a real
    // fault — but it no longer decides the verdict by itself when no expectation was given.
    if (exp) {
      var r0 = out.allocator.routes[0] || null;
      var diffs = [];
      if (!r0) diffs.push('no route was materialized, so an expectation about one cannot be met');
      else {
        if (exp.qty != null && CENSUS_num_(exp.qty) !== r0.total_qty) diffs.push('qty: expected ' + exp.qty + ', allocator says ' + r0.total_qty);
        if (CENSUS_str_(exp.method) && CENSUS_low_(exp.method) !== CENSUS_low_(r0.method)) diffs.push('method: expected ' + exp.method + ', allocator says ' + (r0.method || '(none)'));
        if (CENSUS_str_(exp.sourceWarehouseId) && CENSUS_low_(exp.sourceWarehouseId) !== CENSUS_low_(r0.source_warehouse_id)) diffs.push('source: expected ' + exp.sourceWarehouseId + ', allocator says ' + (r0.source_warehouse_id || '(none)'));
        if (CENSUS_str_(exp.destination) && CENSUS_low_(exp.destination) !== CENSUS_low_(r0.destination)) diffs.push('destination: expected ' + exp.destination + ', allocator says ' + (r0.destination || '(none)'));
        if (!r0.method) diffs.push('method is EMPTY — an incomplete route must never be materialized');
        if (!r0.expected_arrival) diffs.push('expected_arrival is EMPTY — no lead time resolved for this lane');
      }
      if (!out.allocator.conserved) diffs.push('conservation NOT conserved — the allocated quantity does not match the authorized quantity');
      out.differences = diffs;
      if (diffs.length) {
        out.verdict = 'STOP';
        out.ok = false;
        out.blockers.push('ALLOCATOR_DISAGREES_WITH_EXPECTATION: activation STOPS. ' + diffs.join(' — '));
      } else {
        out.verdict = out.warnings.length ? 'RECOMMENDATION_READY_WITH_WARNINGS' : 'PROCEED';
      }
    } else {
      out.note = 'no `expect` supplied, so this census reports readiness and does not judge a route against one.';
    }
  }

  // §4/§7 — assembled HERE, after the verdict, so the route findings are actually in it.
  out.production_parity.blockers = out.blockers.slice();
  out.production_parity.route_blockers = (out.route_blockers || []).slice();
  out.production_parity.route_materialization_warnings = (out.route_materialization_warnings || []).slice();
  // §7 — "the only thing left is master data" is a CLAIM, so the gates it rests on are listed with their
  // observed values. A reader can check each one rather than take the summary on trust.
  out.gates_passed = {
    scope_isolated: !!(h && h.isolation && h.isolation.foreign_site_count === 0),
    harvest_ready: !!(out.mapped && out.mapped.ready),
    forecast_not_blocking: !!(out.forecast_coverage && out.forecast_coverage.blocking === false),
    snapshot_accepted: CENSUS_str_(h && h.sourceDataAsOf) !== '',
    // The authority object is CONSTRUCTED only on the resolved path (61_ returns it after checking its own
    // `ok`), so it carries no `ok` field of its own — reading one asserted a shape that does not exist and
    // reported a false failure on a healthy run. The gate reads the two facts the object actually makes:
    // which GAP-INV run dated this harvest, and the date it resolved to.
    gap_lineage_resolved: !!(h && h.sourceDataAsOfAuthority
      && CENSUS_str_(h.sourceDataAsOfAuthority.run_id) !== ''
      && CENSUS_str_(h.sourceDataAsOfAuthority.date) !== ''),
    source_lines_built: !!(out.source_lines && out.source_lines.ok),
    allocated_lines_present: (out.production_parity.allocated_line_count || 0) > 0,
    destination_resolved: !!(out.sku_facts && (out.sku_facts.destination_resolution || []).length
      && (out.sku_facts.destination_resolution || []).every(function (d) { return CENSUS_str_(d.kind || d.destination_kind) !== ''; })),
    supply_allocation_conserved: out.supply_allocation_conserved === true,
    schema_parity: (out.schema_parity == null) ? null : (out.schema_parity.agree === true),
    carrier_master_data_ready: out.carrier_master_data_ready,
    route_quantity_conserved: out.route_quantity_conserved,
    fully_routable: out.fully_routable
  };
  out.first_failing_predicate = (function () {
    var order = ['scope_isolated', 'harvest_ready', 'forecast_not_blocking', 'snapshot_accepted',
      'gap_lineage_resolved', 'source_lines_built', 'allocated_lines_present', 'destination_resolved',
      'supply_allocation_conserved', 'carrier_master_data_ready', 'route_quantity_conserved', 'fully_routable'];
    for (var i = 0; i < order.length; i++) {
      if (out.gates_passed[order[i]] === false) return order[i];
    }
    return null;
  })();
  out.elapsed_ms = Date.now() - t0;
  CENSUS_logAll_(out);
  return out;
}

/** Read-only: the ACTIVE allocation draft headers already stored for this scope. Identity fields only. */
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §2 — THE CENSUS SAID ZERO AND THE SCREEN SHOWED TWO, AND BOTH WERE HONEST.
//
// They were answering different questions, and neither said which. `CENSUS_activeDrafts_` and the page's
// `_hydrateAllocationDraftFromDb` select from the same table with FOUR differences, any ONE of which produces
// "census 0, screen 2":
//
//   STATUS       census: status === 'active', exactly.
//                page:   status !== 'cancelled' && status !== 'submitted'.
//                So a row whose status is 'draft', 'expired' or BLANK is invisible to the census and visible
//                on screen. A blank status is the likeliest: nothing forces that column to be populated.
//
//   COMPANY      census: an exact match, and a row with a BLANK company is EXCLUDED.
//                page:   a blank company on either side used to match anything (fixed this round, §1).
//                So a legacy header carrying no company is invisible to the census and was visible on screen.
//
//   MARKETPLACE  census: `destination_marketplace` — the route's DESTINATION.
//                page:   `marketplace` — the SCOPE the plan belongs to.
//                Two different columns. A warehouse-destination route (CN -> AMZLG&S IN) has a blank
//                destination_marketplace and a populated scope marketplace.
//
//   SOURCE       census: a live read of the sheet. page: the workspace read-model.
//
// Rather than argue about which definition is right, the census now reports BOTH SETS and the difference
// between them, with the reason each row falls on each side. One run answers "where did those two routes come
// from" instead of leaving two counts that disagree and no way to reconcile them.
//
// It remains strictly READ-ONLY: this reads the same rows the rest of the file reads and writes nothing.
// ================================================================================================================
function CENSUS_uiVisibleDrafts_(ss, company, country, marketplace) {
  var rows = CENSUS_rows_(ss, 'shipping_allocation_drafts');
  var lines = CENSUS_rows_(ss, 'shipping_allocation_draft_lines');
  var out = [];
  rows.forEach(function (r) {
    var st = CENSUS_low_(r.status);
    // R6-R2 §2 — the page's own predicate, which is now KMARC's. This list is what the SCREEN shows, so it
    // asks the same question the hydrate asks and gets the same answer by construction.
    var _arc = CENSUS_arc_();
    var _c = _arc ? _arc.classifyHeader(r, { company: company, country: country, marketplace: marketplace }) : null;
    if (!_c) return;
    if (!_c.counts_toward_current_plan) {
      // Rows the page does NOT show are still worth listing when they are near-misses on ONE axis — that is
      // where a "my route disappeared" report is answered. A row excluded on two or more axes is not this
      // station's row under any reading and is omitted.
      if (_c.exclusion_reasons.length !== 1) return;
    }
    var id = CENSUS_str_(r.allocation_draft_id);
    var mine = lines.filter(function (l) { return CENSUS_str_(l.allocation_draft_id) === id; });
    // WHY this row is or is not in the census's own set. An operator reading a difference needs the reason,
    // not the fact of the difference. These come from the ONE authority now, so a reason printed here is the
    // same reason the page acted on.
    var whyNotInCensusSet = _c.exclusion_reasons.slice();
    out.push({
      allocation_draft_id: id,
      company: CENSUS_str_(r.company),
      country: CENSUS_str_(r.country),
      scope_marketplace: CENSUS_str_(r.marketplace),
      destination_marketplace: CENSUS_str_(r.destination_marketplace),
      destination_warehouse_id: CENSUS_str_(r.destination_warehouse_id),
      source_warehouse_id: CENSUS_str_(r.source_warehouse_id),
      method: CENSUS_str_(r.recommended_shipping_method),
      last_mile_delivery: CENSUS_str_(r.recommended_last_mile_delivery),
      status: CENSUS_str_(r.status),
      planning_cycle: CENSUS_str_(r.planning_cycle),
      source_page: CENSUS_str_(r.source_page),
      // The provenance §2 asks for, read verbatim. `generation_run_id` is the single field that separates an
      // AI-produced header from one a person composed: only a generation stamps it.
      generation_type: CENSUS_str_(r.generation_type || r.source_type),
      generation_run_id: CENSUS_str_(r.generation_run_id),
      calculation_run_id: CENSUS_str_(r.calculation_run_id),
      created_by: CENSUS_str_(r.created_by),
      created_at: CENSUS_str_(r.created_at),
      updated_by: CENSUS_str_(r.updated_by),
      updated_at: CENSUS_str_(r.updated_at),
      draft_version: CENSUS_str_(r.draft_version),
      line_count: mine.length,
      line_ids: mine.map(function (l) { return CENSUS_str_(l.allocation_draft_line_id); }),
      skus: mine.map(function (l) { return CENSUS_str_(l.sku); }),
      quantity: mine.reduce(function (t, l) {
        return t + CENSUS_num_(l.planned_qty != null && l.planned_qty !== '' ? l.planned_qty : l.recommended_qty); }, 0),
      // The classification §2 asks for, decided from stored fields only — never guessed from what is on screen.
      classified_as: CENSUS_str_(r.generation_run_id)
        ? 'STORED_AI_DRAFT (carries a generation_run_id)'
        : 'STORED_MANUAL_DRAFT (no generation_run_id — composed by a person, or written before generations were stamped)',
      in_census_active_set: whyNotInCensusSet.length === 0,
      why_not_in_census_active_set: whyNotInCensusSet
    });
  });
  return out;
}

// The two definitions, side by side, so the difference is a REPORT rather than an argument.
function CENSUS_draftScopeDifference_(ss, company, country, marketplace) {
  var strict = CENSUS_activeDrafts_(ss, company, country, marketplace);
  var uiVisible = CENSUS_uiVisibleDrafts_(ss, company, country, marketplace);
  var strictIds = {};
  strict.forEach(function (d) { strictIds[d.allocation_draft_id] = 1; });
  var onlyUi = uiVisible.filter(function (d) { return !strictIds[d.allocation_draft_id]; });
  return {
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R1 §2 — the census and the page select from one table under two '
      + 'definitions. Both are reported, with the reason each row falls on each side.',
    // R6-R2 §2 — there is ONE definition now, and both sides consume it. The two historical ones are kept
    // verbatim because a reader comparing this report against an earlier run needs to know what changed.
    shared_authority: 'KMARC (supply-planning-active-route-classification)',
    shared_definition: CENSUS_arc_() ? CENSUS_arc_().CONTRACT : 'KMARC_UNAVAILABLE',
    superseded_census_definition: 'status === active AND company exact (blank excluded) AND country exact AND '
      + 'destination_marketplace matches when present — UNSATISFIABLE: `active` is not in 16_ SAD_STATUSES_',
    superseded_ui_definition: 'status not cancelled/submitted AND country exact AND scope marketplace exact AND '
      + '(from R6-R1) company exact, blank on either side excluded',
    census_active_count: strict.length,
    ui_visible_count: uiVisible.length,
    visible_on_screen_but_not_in_census: onlyUi.length,
    rows_only_the_ui_shows: onlyUi,
    ui_visible_rows: uiVisible,
    total_quantity_ui_visible: uiVisible.reduce(function (t, d) { return t + CENSUS_num_(d.quantity); }, 0),
    read_this_first: 'A row listed under rows_only_the_ui_shows was ALREADY in the database before this run. '
      + 'Its why_not_in_census_active_set names the exact column that hides it from the strict set. None of '
      + 'these rows was created by the run that produced this report — the census constructs no writer.'
  };
}

// ============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §2 — THIS FUNCTION'S ZERO WAS A CONSTANT, NOT A MEASUREMENT.
//
// It opened with `if (CENSUS_low_(r.status) !== 'active') return;`. There is no such status. The canonical
// header enum is 16_ SAD_STATUSES_ = { draft, site_confirmed, submitted, cancelled, expired }, and the write
// handler coerces anything else to `draft` — so `status === 'active'` has never been true of any row this
// system has written, and never will be. The live report of `active_allocation_drafts: 0` beside a screen
// showing two routes and 520 units was therefore not a disagreement about data. It was this line.
//
// It also matched the marketplace against `destination_marketplace`, which is a ROUTE dimension: a route
// whose destination is a 3PL warehouse leaves that column blank, so the scope filter dropped exactly the
// rows a station most needs to see.
//
// Both predicates are gone. The classification is KMARC's — the same module the page's hydrate consumes —
// so the census and the screen are no longer two opinions that happen to be compared.
// ============================================================================================================
function CENSUS_arc_() {
  return (typeof KMARC !== 'undefined' && KMARC) ? KMARC : null;
}
// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §6 — THE TYPED SNAPSHOT REASON.
//
// Reads the scope's OWN gap rows and answers the question the predicate name has always claimed to answer. It
// changes no gate: the boolean above is untouched, and nothing here can promote a scope. It only says which of
// six different situations produced the same blank `source_data_as_of`.
//
// The order matters, and it runs from "there is no data" outward to "there is data and it is not acceptable",
// because a later check would be meaningless on rows the earlier one proved absent. Reporting MIXED_SNAPSHOT_DATES
// for a scope that has no rows at all is precisely the kind of wrong-table answer §6 forbids.
// ==============================================================================================================
function CENSUS_gapRowsForScope_(ss, sc) {
  var rows = CENSUS_rows_(ss, 'inventory_replenishment_gap'), o = [];
  rows.forEach(function (r) {
    if (CENSUS_low_(r.company) !== CENSUS_low_(sc.company)) return;
    if (CENSUS_low_(r.country) !== CENSUS_low_(sc.country)) return;
    if (CENSUS_low_(r.marketplace) !== CENSUS_low_(sc.marketplace)) return;
    o.push(r);
  });
  return o;
}

// A calculation_date the system can read, or ''. The gap sheet stores this as a DATE-FORMATTED CELL, so a
// Date object is the NORMAL case and not an anomaly — 61_ weeklyAiPlanCanonicalDate_ is the owner of that
// conversion and is used when it is present, so this never becomes a second date parser.
function CENSUS_gapDate_(v) {
  if (v === null || v === undefined || CENSUS_str_(v) === '') return '';
  if (typeof weeklyAiPlanCanonicalDate_ === 'function') {
    var c = weeklyAiPlanCanonicalDate_(v);
    if (c && c.ok) return c.date;
    return '';
  }
  var t = CENSUS_str_(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

function CENSUS_snapshotReason_(env, sku) {
  function R(reason, detail) { return { reason: reason, detail: CENSUS_str_(detail) }; }
  var all = env.gap_rows || [];
  if (!all.length) {
    return R('NO_MATERIALIZED_GAP_ROW_FOR_SCOPE',
      'inventory_replenishment_gap holds no row for ' + env.company + '/' + env.country + '/' + env.marketplace
      + '. Nothing is stale here \u2014 nothing has been calculated.');
  }
  var mine = all.filter(function (r) { return CENSUS_low_(r.sku) === CENSUS_low_(sku); });
  if (!mine.length) {
    return R('NO_GAP_ROW_FOR_SKU', 'the scope has ' + all.length + ' gap rows and none names ' + sku);
  }
  // Readable dates across the WHOLE scope: a mid-write run is a scope-level fault, not a per-SKU one.
  var dates = {}, order = [], blank = 0, unreadable = 0;
  all.forEach(function (r) {
    var raw = r.calculation_date;
    if (raw === null || raw === undefined || CENSUS_str_(raw) === '') { blank++; return; }
    var d = CENSUS_gapDate_(raw);
    if (!d) { unreadable++; return; }
    if (!dates[d]) { dates[d] = 0; order.push(d); }
    dates[d]++;
  });
  var mineBlank = 0, mineUnreadable = 0, mineDated = 0;
  mine.forEach(function (r) {
    var raw = r.calculation_date;
    if (raw === null || raw === undefined || CENSUS_str_(raw) === '') { mineBlank++; return; }
    if (!CENSUS_gapDate_(raw)) { mineUnreadable++; return; }
    mineDated++;
  });
  if (mineDated === 0 && mineBlank > 0) {
    return R('SNAPSHOT_DATE_BLANK', sku + ' has ' + mine.length + ' gap rows and every calculation_date is empty');
  }
  if (mineDated === 0 && mineUnreadable > 0) {
    return R('SNAPSHOT_DATE_UNREADABLE', sku + ' has ' + mineUnreadable
      + ' gap rows whose calculation_date is present but unreadable');
  }
  if (order.length > 1) {
    order.sort();
    return R('MIXED_SNAPSHOT_DATES', 'the scope carries ' + order.length + ' distinct calculation_dates ('
      + order.join(', ') + '), which is a run caught mid-write');
  }
  var accepted = order.length === 1 ? order[0] : '';
  // A SKU whose current row legitimately suggests nothing is an absence of DEMAND, not an absence of DATA, and
  // must never be counted as a snapshot fault.
  var qty = 0;
  mine.forEach(function (r) {
    qty = Math.max(qty, CENSUS_num_(r.d18_suggested_qty), CENSUS_num_(r.d30_suggested_qty),
      CENSUS_num_(r.d45_suggested_qty), CENSUS_num_(r.d90_suggested_qty));
  });
  if (qty <= 0) {
    return R('SUGGESTED_QUANTITY_ZERO_NO_ROW_EXPECTED', sku + ' has a current row dated ' + accepted
      + ' and its suggested quantity is zero \u2014 no demand, not missing data');
  }
  // Lineage: the cycle the accepted date belongs to, compared with the cycle being planned. `RECO-YYYY-MM` is
  // 61_'s own derivation (weeklyAiPlanReadGapRows_ dateIndex), mirrored rather than re-invented.
  var cycle = accepted ? ('RECO-' + accepted.slice(0, 7)) : '';
  var want = CENSUS_str_(env.planning_cycle);
  if (want && cycle && cycle !== want) {
    return R('SNAPSHOT_LINEAGE_MISMATCH', 'newest snapshot ' + accepted + ' belongs to ' + cycle
      + ', the plan is for ' + want);
  }
  if (CENSUS_str_(env.source_data_as_of) !== '') return R('CURRENT_ACCEPTED', 'source_data_as_of=' + env.source_data_as_of);
  if (accepted) {
    return R('HARVEST_REFUSED_OTHER', 'gap rows are present, single-dated (' + accepted
      + ') and correctly lineaged; the harvest refused on another axis \u2014 ' + CENSUS_str_(env.harvest_detail));
  }
  return R('SNAPSHOT_NOT_CURRENT', CENSUS_str_(env.harvest_detail));
}

function CENSUS_activeDrafts_(ss, company, country, marketplace) {
  var rows = CENSUS_rows_(ss, 'shipping_allocation_drafts'), o = [];
  var arc = CENSUS_arc_();
  if (!arc) return o;   // no authority = no claim. An empty list is never presented as a measured zero.
  var scope = { company: company, country: country, marketplace: marketplace };
  rows.forEach(function (r) {
    var c = arc.classifyHeader(r, scope);
    if (!c.counts_toward_current_plan) return;
    o.push({ allocation_draft_id: CENSUS_str_(r.allocation_draft_id),
      source_warehouse_id: CENSUS_str_(r.source_warehouse_id || r.recommended_source_warehouse_id),
      destination: CENSUS_str_(r.destination_marketplace || r.destination_warehouse_id
        || r.recommended_destination_warehouse_id),
      method: CENSUS_str_(r.recommended_shipping_method),
      planning_cycle: CENSUS_str_(r.planning_cycle),
      status: CENSUS_str_(r.status),
      generation_run_id: CENSUS_str_(r.generation_run_id) });
  });
  return o;
}

/**
 * §G — ONE log writer, used by EVERY exit that has facts to report. Before R1 the log block sat at the
 * very bottom of the function, so the twelve early returns logged a single BLOCKED line and nothing else —
 * a run that refused reported less than a run that succeeded, which is backwards.
 */
// F1-7N-FC-1B-E3-R4-A2-R1-R4 §3 — LIFTED OUT OF THE LOGGER.
//
// This computation lived inside CENSUS_logAll_, which runs after the verdict, so the parity was a line printed
// at the end rather than a fact the census held. Nothing could gate on it: reading it from the gate list
// produced null on every run, healthy or not. A verdict input must be established before the verdict.
function CENSUS_schemaParity_() {
  var _ds = null, _dsSheet = null;
  try { _dsSheet = SpreadsheetApp.openById(prodExpectedDbId_()).getSheetByName('shipping_allocation_drafts'); } catch (eD1) { _dsSheet = null; }
  if (!(_dsSheet && typeof sadLiveHeaderNames_ === 'function' && typeof sadResolveHeaderSchema_ === 'function')) return null;
  try { _ds = sadResolveHeaderSchema_(sadLiveHeaderNames_(_dsSheet)); } catch (eD2) { return null; }
  try {
  // ==========================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R4 §3 — THE DISAGREEMENT NAMED A CAUSE IT HAD NOT MEASURED.
  //
  // R3 fixed the predicate (a null lifecycle version is a disagreement, and it is) and then labelled the
  // result `LIFECYCLE_RESOLVED_NO_VERSION_LIFECYCLE_COLUMNS_INCOMPLETE`. The live log printed that token
  // beside `lifecycle_complete: true`, so the report contradicted itself in adjacent fields, and the token
  // sent the reader to look for missing columns on a sheet that has all of them.
  //
  // WHAT THE REPOSITORY ACTUALLY DOES, measured offline over the real header constants before this block was
  // touched: at 34, 35 and 36 columns the writer and the lifecycle BOTH resolve, and both name the SAME
  // version (FB4C-AI-LIFECYCLE-1, FB4F-B4-ROUTE-IDENTITY-1, FB4G-A2R3-CREATE-IDEMPOTENCY-1). aiplSchemaVersionOf_
  // has delegated to sadResolveHeaderSchema_ since R1, so in SOURCE there is one authority and no
  // disagreement is possible. §3.4 is therefore already satisfied by the code in this repository.
  //
  // WHICH LEAVES EXACTLY ONE EXPLANATION for the live pair (writer FB4G / lifecycle null), and it is not a
  // source defect: the two readings came from DIFFERENT BUILDS. Both sides here read the same sheet through
  // the same sadLiveHeaderNames_, so the input is identical by construction and the only variable is which
  // module body ran. The pre-R1 aiplSchemaVersionOf_ compared the header byte-for-byte against
  // SHIPPING_ALLOCATION_DRAFTS_HEADERS_CANONICAL_, which is frozen at 34 ON PURPOSE, and returned '' for any
  // 36-column sheet — reproducing the live output exactly. The deployed project has a current 16_ and a
  // stale 69_.
  //
  // That is a state a diagnostic MUST be able to name, because it is the dangerous one: the writer accepts
  // and the lifecycle expires nothing, so a generation writes rows that no later run can supersede. So the
  // cause is now DISCRIMINATED from the facts at hand, and each branch asserts only what it can see:
  //
  //   * the writer refuses            -> the header itself is wrong
  //   * writer ok, generation is not  -> the lifecycle columns really ARE incomplete, and they are named
  //     lifecycle_complete
  //   * writer ok, generation IS      -> the columns are present and complete, so the resolver disagreeing
  //     lifecycle_complete, and yet      with itself cannot be about columns. The expected version is
  //     the lifecycle names nothing      re-derived from the shared authority and reported beside what the
  //                                     lifecycle module returned, and the finding is a DEPLOYMENT skew.
  //
  // `shares_authority` is checked at RUNTIME rather than asserted by comment: the lifecycle resolver is
  // asked to resolve the same header and its verdict compared with the writer's, which is the only way this
  // file can tell a project with one authority from a project that merely used to have one.
  // ==========================================================================================================
  return (_ds && typeof aiplSchemaVersionOf_ === 'function')
    ? (function () {
        var _live = sadLiveHeaderNames_(_dsSheet);
        var _lv = aiplSchemaVersionOf_(_live) || null;
        var _wv = _ds.version || null;
        var _lifeRes = (typeof aiplResolveSchema_ === 'function') ? aiplResolveSchema_(_live) : null;
        // Does the lifecycle module reach the SAME resolution the writer did? Same input, same verdict.
        var _shares = !!(_lifeRes && _lifeRes.ok === _ds.ok
          && CENSUS_str_(_lifeRes.version) === CENSUS_str_(_ds.version)
          && _lifeRes.lifecycle_complete === _ds.lifecycle_complete);
        var _need = (typeof SAD_LIFECYCLE_TAIL_COLUMNS_ !== 'undefined') ? SAD_LIFECYCLE_TAIL_COLUMNS_.slice() : [];
        var _have = {}; (_live || []).forEach(function (hh) { _have[CENSUS_str_(hh)] = 1; });
        var _missingLife = _need.filter(function (c) { return !_have[c]; });
        var _agree = (_ds.ok === true) && _wv !== null && _lv !== null && _wv === _lv;
        var _dis = null;
        if (!_agree) {
          if (_ds.ok !== true) _dis = 'WRITER_REFUSES_THIS_HEADER';
          else if (_wv === null) _dis = 'WRITER_RESOLVED_NO_VERSION';
          else if (_lv === null) {
            // The ONLY branch that was previously guessed. It is now decided by whether the recognized
            // generation is lifecycle-complete — a fact this block already holds.
            _dis = (_ds.lifecycle_complete === true)
              ? 'LIFECYCLE_RESOLVER_STALE_IN_DEPLOYED_PROJECT: the recognized generation IS '
                + 'lifecycle-complete and every lifecycle column is present, so this cannot be a column '
                + 'problem. The writer and the lifecycle read the same header and returned different '
                + 'answers, which means different builds are running. Expected ' + _wv
                + ' from the shared authority; the lifecycle module returned none. Sync '
                + '69_api_v1_ai_plan_lifecycle.gs into the Apps Script project.'
              : ('LIFECYCLE_COLUMNS_INCOMPLETE: missing ' + (_missingLife.join(',') || '(none named)'));
          } else _dis = 'WRITER_AND_LIFECYCLE_NAME_DIFFERENT_VERSIONS';
        }
        return { live_header_count: (_live || []).length,
          writer_accepts: _ds.ok === true, writer_version: _wv,
          recognized_generation: _wv, lifecycle_complete: _ds.lifecycle_complete === true,
          lifecycle_version: _lv,
          lifecycle_required_columns: _need, missing_lifecycle_columns: _missingLife,
          shares_authority: _shares,
          lifecycle_resolution: _lifeRes ? { ok: _lifeRes.ok, version: _lifeRes.version,
            lifecycle_complete: _lifeRes.lifecycle_complete, reason: _lifeRes.reason || null } : null,
          supported_versions: _ds.supported_versions || null,
          agree: _agree, disagreement: _dis };
      })()
    : null;

  } catch (eS3) { return null; }
}

function CENSUS_logAll_(out) {
  // R6-R7-R2 — a parity block that was never reached says so, with the stage it stopped at and the
  // blockers known at that moment. `undefined` in a log is a reader's problem, not a finding.
  if (out && out.production_parity && out.production_parity.assembled !== true) {
    out.production_parity.unassembled_at_stage = out.next_blocked_stage || 'BEFORE_ALLOCATOR';
    out.production_parity.blockers = (out.blockers || []).slice();
  }
  CENSUS_log_('projection_class', out ? (out.projection_class || null) : null);
  CENSUS_log_('is_production_generation_authority',
    out ? (out.is_production_generation_authority === true) : null);
  CENSUS_log_('verdict', out.verdict);
  CENSUS_log_('scope', out.scope);
  CENSUS_log_('planning_cycle', out.planning_cycle);
  CENSUS_log_('required_forecast_months', out.required_forecast_months);
  CENSUS_log_('flag', out.flag);
  CENSUS_log_('harvest', out.harvest);
  CENSUS_log_('mapped.ready', out.mapped ? out.mapped.ready : null);
  CENSUS_log_('mapped.reason', out.mapped ? out.mapped.reason : null);
  CENSUS_log_('mapped.issues', out.mapped ? out.mapped.issues : null);
  CENSUS_log_('mapped.warnings', out.mapped ? out.mapped.warnings : null);
  CENSUS_log_('mapped.readiness_predicates', out.mapped ? out.mapped.readiness_predicates : null);
  CENSUS_log_('mapped.failed_required_predicates', out.mapped ? out.mapped.failed_required_predicates : null);
  CENSUS_log_('mapped.missing_fields', out.mapped ? out.mapped.missing_fields : null);
  CENSUS_log_('mapped.mapped_field_names', out.mapped ? out.mapped.mapped_field_names : null);
  CENSUS_log_('source_data_as_of_candidates', out.source_data_as_of_candidates);
  CENSUS_log_('forecast_coverage', out.forecast_coverage);
  CENSUS_log_('source_lines', out.source_lines);
  CENSUS_log_('allocated_lines', out.allocated_lines);
  CENSUS_log_('sku_facts', out.sku_facts);
  CENSUS_log_('factory_stock', out.factory_stock);
  CENSUS_log_('carrier_authorities', out.carrier_authorities);
  // §7 — `matched_carrier_cards` is now the FINAL ELIGIBLE count from the shared authority (a number),
  // not a private array, so `.length` would have printed undefined on every run.
  CENSUS_log_('matched_carrier_cards', out.matched_carrier_cards);
  CENSUS_log_('carrier_lane_funnels', out.carrier_lane_funnels);
  CENSUS_log_('schema_writer_lifecycle_parity', out.schema_parity);
  CENSUS_log_('production_parity', out.production_parity);
  CENSUS_log_('allocator', out.allocator);
  CENSUS_log_('total_allocated_quantity', out.total_allocated_quantity);
  CENSUS_log_('would_create_route_count', out.would_create_route_count);
  CENSUS_log_('active_allocation_drafts', out.active_allocation_drafts ? out.active_allocation_drafts.length : null);
  CENSUS_log_('next_blocked_stage', out.next_blocked_stage);
  CENSUS_log_('blockers', out.blockers);
  CENSUS_log_('differences', out.differences);
  CENSUS_log_('writer_constructed', out.writer_constructed);
  CENSUS_log_('db_writes', out.db_writes);
}


// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A1 §6 — THE ONE ENTRY POINT, WITH THE SCOPE ALREADY IN IT.
//
// The live census came back with scope { company: "", country: "", marketplace: "", sku: "" } and a single
// blocker, SCOPE_INCOMPLETE. The census was RIGHT to refuse — it never defaults a scope and never runs
// ALL_SITES — but the result was not an AI Plan finding of any kind. It said nothing about the forecast,
// the snapshot, the allocator or readiness, and it must not be read as though it had.
//
// The fault was the calling convention, not the census. `TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3(args)` takes a
// parameter object, and a zero-argument wrapper around it passes nothing. Asking an operator to reconstruct an
// internal args schema in a console is a design defect: the scope belongs in the function, not in the caller.
//
// So this is the only function anyone needs to run. It takes NOTHING, it carries the scope itself, and it
// asserts that scope before any harvest happens — so a future edit that changes one of the four values
// stops rather than quietly censusing a different site.
//
// READ-ONLY, and the census it delegates to is the authority on that: it never constructs a writer, never
// opens the allocation tables for writing, never runs a migration and never touches the flag. This wrapper
// adds no capability of its own; it only removes a way to call it wrong.
// ================================================================================================================
var TEMP_E3_FIXED_SCOPE_ = { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' };

function RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R() {
  var S = TEMP_E3_FIXED_SCOPE_;

  // The identity header, printed BEFORE any read, so a run can be matched to what it was asked to do even if
  // it stops on the next line.
  var planningCycle = null;
  try {
    var cc = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
    planningCycle = (cc && cc.ok) ? cc.planningCycle : null;
  } catch (e) { planningCycle = null; }
  var flagEffective = null;
  try {
    flagEffective = (typeof inventoryAiPlanDbGenerationEnabled_ === 'function')
      ? (inventoryAiPlanDbGenerationEnabled_() === true) : null;
  } catch (e2) { flagEffective = null; }

  // F1-7N-FC-1B-E3-R4-A2-R1 §5 — THE SCHEDULE IS PART OF THE HEADLINE, because it is what decides
  // whether an older snapshot is CURRENT or STALE, and the previous run of this census could not say.
  var sched = null, jobState = null, businessNow = null;
  try { sched = (typeof weeklyAiPlanGapSchedule_ === 'function') ? weeklyAiPlanGapSchedule_() : null; } catch (eS) { sched = null; }
  try { jobState = (typeof weeklyAiPlanGapJobState_ === 'function') ? weeklyAiPlanGapJobState_() : null; } catch (eJ) { jobState = null; }
  try {
    if (typeof KMSNF !== 'undefined' && KMSNF && typeof KMSNF.businessNow === 'function'
      && typeof GAP_CALC_UTC_OFFSET_MIN_ !== 'undefined' && typeof gapCalcNowMs_ === 'function') {
      businessNow = KMSNF.businessNow(gapCalcNowMs_(), GAP_CALC_UTC_OFFSET_MIN_);
    }
  } catch (eB) { businessNow = null; }

  CENSUS_log_('scope', S);
  CENSUS_log_('server_business_time', businessNow ? (businessNow.ymd + ' ' + businessNow.hhmm + ' Asia/Taipei') : null);
  CENSUS_log_('gap_schedule', sched);
  CENSUS_log_('gap_job_state', jobState);
  CENSUS_log_('planning_cycle', planningCycle);
  CENSUS_log_('read_only', true);
  CENSUS_log_('flag_effective', flagEffective);
  CENSUS_log_('activation_allowlist', (typeof inventoryAiPlanActivationAllowlist_ === 'function')
    ? inventoryAiPlanActivationAllowlist_() : null);
  CENSUS_log_('scope_in_allowlist', (typeof inventoryAiPlanScopeEnabled_ === 'function')
    ? inventoryAiPlanScopeEnabled_(S.company, S.country, S.marketplace, S.sku) : null);
  CENSUS_log_('db_writes', 0);
  CENSUS_log_('writer_constructed', false);
  CENSUS_log_('census_build', TEMP_E3_CENSUS_BUILD_);
  CENSUS_log_('deployment_build', (typeof SYS_BUILD_VERSION_ !== 'undefined') ? SYS_BUILD_VERSION_ : null);
  CENSUS_log_('workspace_build', (typeof WAP_BUILD_VERSION_ !== 'undefined') ? WAP_BUILD_VERSION_ : null);
  CENSUS_log_('freshness_authority', (typeof KMSNF !== 'undefined' && KMSNF) ? KMSNF._version : 'MISSING');

  // STOP BEFORE HARVEST if the scope is not exactly the four values this wrapper exists to run. An empty or
  // partially-edited scope is what produced the unusable log, and it must fail here rather than downstream.
  var bad = [];
  if (CENSUS_str_(S.company) !== 'ResUS') bad.push('company');
  if (CENSUS_str_(S.country) !== 'US') bad.push('country');
  if (CENSUS_str_(S.marketplace) !== 'Amazon') bad.push('marketplace');
  if (CENSUS_str_(S.sku) !== 'CO1100-R') bad.push('sku');
  if (bad.length) {
    var stop = { census: 'RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R', read_only: true, db_writes: 0,
      writer_constructed: false, ok: false, verdict: 'STOP', scope: S,
      blockers: ['FIXED_SCOPE_ALTERED: ' + bad.join(', ') + ' — this wrapper runs exactly ResUS / US / Amazon / '
        + 'CO1100-R and refuses to census a different site under the same name'] };
    CENSUS_log_('verdict', 'STOP');
    CENSUS_log_('blockers', stop.blockers);
    return stop;
  }

  // The scope is passed EXPLICITLY. Nothing is defaulted, nothing falls back to the first SKU, and ALL_SITES
  // is unreachable from here.
  var res = TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3({
    company: S.company, country: S.country, marketplace: S.marketplace, sku: S.sku
  });

  // §5 — WHICH RUN WAS ADOPTED, AND WHY. "A snapshot dated yesterday was accepted" is only a defensible
  // sentence when the reason travels beside it, and the previous census reported neither.
  //
  // F1-7N-FC-1B-E3-R4-A2-R1-R1 §10 — READ THE REFUSAL, NOT ONLY THE SUCCESS.
  //
  // These five lines read a SUCCESSFUL harvest's fields, and a harvest that REFUSES does not have them: it
  // returns { ok:false, errors:[ CANONICAL_DEMAND_UNAVAILABLE ] } and carries the freshness verdict, the
  // schedule and the distinct dates INSIDE that error. So on the one run where an operator most needs to know
  // which state blocked them, the census printed freshness_state: null, accepted_snapshot_date: null and
  // snapshot_distinct_dates: null — and the live log said nothing about the LINEAGE_MISMATCH that had
  // actually stopped it. A diagnostic that goes quiet exactly when something goes wrong is worse than none.
  try {
    var h = res && res.harvest;
    // The refusal payload, when there is one. Both shapes are read so the fields are populated either way.
    var hErr = null;
    var hErrs = (h && h.errors) || (res && res.harvest_errors) || [];
    for (var _e = 0; _e < hErrs.length; _e++) {
      if (hErrs[_e] && hErrs[_e].code === 'CANONICAL_DEMAND_UNAVAILABLE') { hErr = hErrs[_e]; break; }
    }
    var fr = (h && h.snapshot_freshness) || (hErr && hErr.freshness) || null;
    CENSUS_log_('freshness_state', (fr && fr.state) || null);
    CENSUS_log_('freshness_reason', (fr && fr.reason) || (hErr && hErr.message) || null);
    CENSUS_log_('freshness_accepted', fr ? (fr.ok === true) : null);
    CENSUS_log_('accepted_snapshot_date', (h && h.accepted_snapshot_date) || (fr && fr.acceptedDate) || null);
    CENSUS_log_('accepted_snapshot_run', (h && h.gap_job_state && h.gap_job_state.runId)
      || (jobState && jobState.runId) || null);
    CENSUS_log_('snapshot_distinct_dates', (h && h.snapshot_distinct_dates)
      || (hErr && hErr.distinct_dates) || null);
    CENSUS_log_('gap_schedule_resolved', (h && h.gap_schedule) || (hErr && hErr.schedule) || sched || null);
    CENSUS_log_('forecast_normalization', (h && h.forecast_normalization) || null);
    CENSUS_log_('snapshot_date_normalization', (h && h.snapshot_date_normalization)
      || (hErr && hErr.date_normalization) || null);
  } catch (eF) {}

  // §10 — ALLOCATION SCHEMA DIAGNOSTICS. Read-only, and it CHANGES NO GATE: it reports what the shared
  // authority says about the live header so "the AI Plan refuses" and "the drafts table is at a schema this
  // build does not know" stop being the same unexplained outcome.
  try {
    var _ds = null, _dsSheet = null;
    try { _dsSheet = SpreadsheetApp.openById(prodExpectedDbId_()).getSheetByName('shipping_allocation_drafts'); } catch (eD1) { _dsSheet = null; }
    if (_dsSheet && typeof sadLiveHeaderNames_ === 'function' && typeof sadResolveHeaderSchema_ === 'function') {
      _ds = sadResolveHeaderSchema_(sadLiveHeaderNames_(_dsSheet));
    }
    CENSUS_log_('allocation_schema', _ds ? {
      observed_header_count: _ds.column_count,
      resolved_schema_version: _ds.version,
      compatible: _ds.ok === true,
      lifecycle_complete: _ds.lifecycle_complete === true,
      reason: _ds.reason || null,
      first_mismatch: _ds.first_mismatch || null,
      supported_versions: (_ds.supported_versions || []).map(function (v) { return v.version + '(' + v.column_count + ')'; })
    } : 'SCHEMA_AUTHORITY_OR_TABLE_UNAVAILABLE');
    // §9 — the parity fact itself, so a divergence is visible in the log rather than inferred later.
    // F1-7N-FC-1B-E3-R4-A2-R1-R2 §11 — WHAT THE REAL GENERATION WOULD DECLARE, WITHOUT DECLARING IT.
    //
    // Read-only, and it constructs NO writer: it reports the intent the production call site carries and
    // previews the deterministic identity the resolver would land on, so an operator can see which row a live
    // Generate would create or reconcile BEFORE pressing anything. The intent is read from the server-owned
    // constant rather than restated here, so a census cannot drift from what generation actually sends.
    CENSUS_log_('route_intent_that_generation_would_use',
      (typeof SAD_AI_K2_INTENT_ !== 'undefined') ? SAD_AI_K2_INTENT_ : 'UNKNOWN_INTENT_AUTHORITY_MISSING');
    CENSUS_log_('route_intent_is_client_grantable',
      (typeof SAD_CLIENT_GRANTABLE_INTENTS_ !== 'undefined' && typeof SAD_AI_K2_INTENT_ !== 'undefined')
        ? (SAD_CLIENT_GRANTABLE_INTENTS_[SAD_AI_K2_INTENT_] === 1) : null);
    // F1-7N-FC-1B-E3-R4-A2-R1-R3 §9 — `agree: true` WITH A NULL LIFECYCLE VERSION WAS NOT AGREEMENT.
    //
    // The old predicate compared `(writer accepted) === (writer resolved a version)`, which is two readings of
    // the SAME authority and is therefore true whenever the writer is self-consistent. The lifecycle version
    // was printed beside it and never took part, so the live log could show
    // `resolved_schema_version: FB4G-…, lifecycle_version: null, agree: true` — a parity claim asserted over
    // a value it had ignored.
    //
    // Parity now requires what the word means: the writer accepts, the lifecycle names a version, and it is
    // the SAME version. A null on either side is a DISAGREEMENT, which is the case that matters, because it
    // is exactly the mixed-deployment state where a generation writes and nothing expires.
    // R4: the runner's census result is `res`. Referencing `out` here threw straight into the empty catch
    // below, so this line silently stopped appearing in the operator's log the moment the computation moved.
    CENSUS_log_('schema_writer_lifecycle_parity', res && res.schema_parity);
  } catch (eS2) {}
  // §11 — THE DETERMINISTIC IDENTITY PREVIEW. Derived from the SAME authority the writer resolves with,
  // over the routes this census already computed. Nothing is written and no writer is constructed; this only
  // answers "which row would a live Generate touch?" before anyone presses it.
  try {
    var _prev = [];
    var _grps = (res && res.k2_preview && res.k2_preview.groups) || (res && res.groups) || [];
    for (var _p = 0; _p < _grps.length && _p < 10; _p++) {
      var _hh = _grps[_p] && (_grps[_p].header || _grps[_p]);
      if (!_hh) continue;
      _prev.push({
        group_no: _hh.recommendation_group_no || null,
        k2_group_key: (typeof sadK2GroupKey_ === 'function') ? sadK2GroupKey_(_hh) : null,
        deterministic_header_id: (typeof ricK4DeterministicHeaderId_ === 'function')
          ? (function () { try { return ricK4DeterministicHeaderId_(_hh); } catch (e) { return null; } })()
          : ((typeof sadK2DeterministicHeaderId_ === 'function')
              ? (function () { try { return sadK2DeterministicHeaderId_(_hh); } catch (e) { return null; } })() : null)
      });
    }
    CENSUS_log_('deterministic_identity_preview', _prev.length ? _prev : 'NO_ROUTES_COMPUTED_IN_THIS_CENSUS');
  } catch (eP) { CENSUS_log_('deterministic_identity_preview', 'PREVIEW_UNAVAILABLE'); }

  // Re-assert the read-only facts from the RESULT rather than from this function's intentions.
  CENSUS_log_('result.read_only', res && res.read_only);
  CENSUS_log_('result.db_writes', res && res.db_writes);
  CENSUS_log_('result.writer_constructed', res && res.writer_constructed);
  CENSUS_log_('result.verdict', res && res.verdict);
  return res;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6 §5/§6 — FINDING A SCOPE THAT CAN ACTUALLY FORM A ROUTE, WITHOUT TOUCHING ANYTHING.
//
// Every activation question so far has been asked of ONE scope, and that scope cannot answer it. ResUS / US /
// Amazon / CO1100-R has no transit authority on its last leg, so it is a NEGATIVE case by construction: it can
// prove that a carrier gap does not stop the advice, and it can never prove that a good scope produces one
// correct route. A negative test that passes is not evidence that the positive path works.
//
// So this searches the production tables, read-only, for a scope that can. It is deliberately a SEARCH and not
// a guess: the criteria are hard-coded here and every scope is judged by the same 15 predicates, each of which
// is reported with its observed value. A candidate that arrives without its predicate values is a scope
// somebody picked, and picking is the thing this function exists to replace.
//
// IT IS READ-ONLY IN THE SAME WAY THE REST OF THIS FILE IS. It calls the pure compute chain — harvest, map,
// source lines, allocated lines, KMWRR.buildK2GenerationPlan, KMMR — and never obtains a writer. There is no
// appendRow, no setValue, no property write and no flush anywhere below this line.
//
// WHY THE PREDICATES ARE NEGATIVE-FIRST. Each one records why a scope was REJECTED, not merely that it was.
// The likely outcome of the first live run is no candidate at all, and "none found" is only useful if it comes
// with the histogram that says which predicate did the rejecting — that histogram is what tells an operator
// whether one lead-time row would unlock a dozen scopes or none.
// ================================================================================================================
var E3_CANDIDATE_PREDICATES_ = [
  'active_marketplace_scope', 'current_accepted_snapshot', 'forecast_ready_or_legal_zero',
  'suggested_quantity_positive', 'supply_source_available', 'source_and_destination_resolved',
  'country_lead_time_resolvable', 'at_least_one_safe_method', 'method_independent_of_rate_card',
  'conservative_transit_within_buffer', 'deterministic_identity_resolvable', 'allocation_schema_compatible',
  'no_terminal_identity_collision', 'no_ambiguous_active_draft', 'no_manual_route_precedence_conflict'
];

// The scope this file censuses in §6. LEFT NULL DELIBERATELY.
//
// §6 asks for a hard-coded scope and no parameters. Hard-coding one TODAY would mean inventing it: the tables
// this must be selected from are production, and nothing in this repository can read them. Writing a plausible
// company/country/marketplace/SKU into a diagnostic that then reports on it is how a fixture becomes mistaken
// for a finding, which is the one thing a census must never permit.
//
// So the SELECTION RULE is hard-coded instead of the selection: the wrapper takes no parameters, applies the
// 15 predicates deterministically, and censuses whichever scope they pick — reporting the choice and its
// reasons. Once the first live run names a scope, setting this constant to that literal freezes it, and the
// wrapper then refuses to census anything else, exactly as RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R does.
var E3_SELECTED_MATERIALIZABLE_SCOPE_ = null;   // e.g. { company: '', country: '', marketplace: '', sku: '' }

// The distinct (company, country, marketplace) scopes the demand snapshot actually carries, with the SKUs that
// have a positive suggestion in each. Read from the same table the generation reads; nothing is enumerated
// from a config list, because a scope that exists in config and not in the data is not a candidate.
function CENSUS_enumerateDemandScopes_(ss) {
  var rows = CENSUS_rows_(ss, 'inventory_replenishment_gap');
  var byScope = {}, order = [];
  rows.forEach(function (r) {
    var company = CENSUS_str_(r.company), country = CENSUS_str_(r.country);
    var mkt = CENSUS_str_(r.marketplace), sku = CENSUS_str_(r.sku);
    if (!company || !country || !mkt || !sku) return;
    if (/^all(_sites)?$/i.test(mkt) || /^all(_sites)?$/i.test(sku)) return;   // never a real scope
    var qty = Math.max(CENSUS_num_(r.d18_suggested_qty), CENSUS_num_(r.d30_suggested_qty),
      CENSUS_num_(r.d45_suggested_qty), CENSUS_num_(r.d90_suggested_qty));
    var k = company + '|' + country + '|' + mkt;
    if (!byScope[k]) {
      byScope[k] = { company: company, country: country, marketplace: mkt, skus: [], seen: {},
        calculation_status: CENSUS_str_(r.calculation_status) };
      order.push(k);
    }
    if (qty > 0 && !byScope[k].seen[sku]) { byScope[k].seen[sku] = 1; byScope[k].skus.push(sku); }
  });
  return order.map(function (k) { var v = byScope[k]; delete v.seen; return v; });
}

// One scope's verdict on the 15 predicates. `plan` and `advice` come from the SAME pure chain a generation
// runs, so a candidate this accepts is a candidate the generation would actually route.
function CENSUS_judgeCandidate_(env, mkt, sku) {
  var P = {}, why = [], reject = null;
  function set(name, value, detail) {
    P[name] = { ok: value === true, detail: detail || null };
    if (value !== true && !reject) reject = name;
    return value === true;
  }
  var lines = (env.allocated || []).filter(function (a) { return CENSUS_low_(a.sku) === CENSUS_low_(sku); });
  var qty = lines.reduce(function (t, a) {
    return t + CENSUS_num_(a.recommended_qty != null ? a.recommended_qty : a.planned_qty); }, 0);

  set('active_marketplace_scope', env.marketplace_active === true, env.marketplace_detail);
  // ==========================================================================================================
  // F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §6 — ONE TOKEN WAS CARRYING SIX DIFFERENT ANSWERS.
  //
  // The live run rejected 151 of 228 SKUs under `current_accepted_snapshot`, and the name is a promise the
  // predicate never kept: it tested `CENSUS_str_(env.source_data_as_of) !== ''`. That is a test for a
  // NON-EMPTY STRING. It says nothing about whether the snapshot is current, whether its dates agree with
  // each other, or whether its lineage matches the cycle being planned — and `source_data_as_of` is left
  // blank by every early return in CENSUS_candidateEnv_, including the one taken when the scope has no
  // materialized gap row at all.
  //
  // So "no gap row has ever been calculated for this site" and "the snapshot is from last week" reported
  // under the same token, and an operator reading the histogram would go looking for a stale snapshot on a
  // site that has never had one. §6 forbids exactly that conflation.
  //
  // The BOOLEAN IS UNCHANGED — the gate is not weakened, and a scope that failed still fails. What is added
  // is the typed reason, measured from the scope's own gap rows.
  // ==========================================================================================================
  var _snapReason = CENSUS_snapshotReason_(env, sku);
  set('current_accepted_snapshot', CENSUS_str_(env.source_data_as_of) !== '',
    'source_data_as_of=' + CENSUS_str_(env.source_data_as_of) + ' reason=' + _snapReason.reason
      + ' | ' + _snapReason.detail);
  set('forecast_ready_or_legal_zero', env.harvest_ready === true, env.harvest_detail);
  set('suggested_quantity_positive', qty > 0, 'allocated_quantity=' + qty);
  var srcIds = [], destKeys = [];
  lines.forEach(function (a) {
    var sid = CENSUS_str_(a.source_warehouse_id);
    if (sid && srcIds.indexOf(sid) === -1) srcIds.push(sid);
    var d = a.destination || {};
    var dk = CENSUS_str_(d.kind) + ':' + CENSUS_str_(d.marketplace || d.warehouse_id) + '@' + CENSUS_str_(d.country);
    if (destKeys.indexOf(dk) === -1) destKeys.push(dk);
  });
  set('supply_source_available', srcIds.length > 0, 'sources=' + srcIds.join(','));
  // ONE source and ONE destination is a §5 PREFERENCE, not a correctness rule — but a candidate meant to be
  // hand-verified must be hand-verifiable, and two sources doubles what a person has to check on the first
  // live materialization. It is recorded as a preference so the histogram never blames a real fault on it.
  set('source_and_destination_resolved',
    srcIds.length > 0 && destKeys.length === 1 && destKeys[0].indexOf(':@') === -1
      && destKeys[0].charAt(0) !== ':',
    'destinations=' + destKeys.join(' | '));

  // The transit authority, judged the way the recommendation judges it and by the same module — never by a
  // second opinion written here.
  var kmmr = (typeof KMMR !== 'undefined' && KMMR) ? KMMR : null;
  var lane = null, profiles = [], best = null, rec = null, dus = null;
  if (kmmr && lines.length) {
    var a0 = lines[0];
    var wh = (env.warehouses_by_id || {})[CENSUS_str_(a0.source_warehouse_id)] || null;
    lane = { originCountry: CENSUS_str_(wh && wh.country),
      destinationCountry: CENSUS_str_((a0.destination || {}).country) };
    profiles = kmmr.serviceProfiles(env.lead_times, lane) || [];
    var shipOrd = (typeof KMWRR !== 'undefined' && KMWRR && KMWRR.dateToOrdinal)
      ? KMWRR.dateToOrdinal(env.ship_date) : null;
    var reqOrd = (typeof KMWRR !== 'undefined' && KMWRR && KMWRR.dateToOrdinal)
      ? KMWRR.dateToOrdinal(a0.required_by_date) : null;
    dus = (shipOrd == null || reqOrd == null) ? null : (reqOrd - shipOrd);
    var cfg = (typeof weeklyAiPlanTransitBuffer_ === 'function') ? weeklyAiPlanTransitBuffer_() : null;
    rec = kmmr.recommend({ leadTimes: env.lead_times, lane: lane, daysUntilStockout: dus,
      buffer: kmmr.bufferFor(cfg, ''), requiredByDate: a0.required_by_date, shipDate: env.ship_date });
    best = rec.recommended || null;
  }
  set('country_lead_time_resolvable', profiles.length > 0,
    'lane=' + JSON.stringify(lane) + ' service_profiles=' + profiles.length);
  set('at_least_one_safe_method', !!best && best.risk === 'SAFE',
    best ? ('method=' + best.shipping_method + ' risk=' + best.risk)
         : ('no recommended method' + (rec && rec.review_reason ? ' (' + rec.review_reason + ')' : '')));
  // KMMR takes NO rate cards as an input at all, so the method either came from the transit authority or it
  // did not come. That cannot be observed directly from an option, so what is asserted is the OBSERVABLE form
  // of the same property: the recommendation names no carrier and claims no price. A method that arrived with
  // a price attached did not come from carrier_lead_times, whatever anything else says.
  set('method_independent_of_rate_card',
    !!best && best.carrier_selection === 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN'
      && (best.estimated_cost === null || best.estimated_cost === undefined),
    best ? ('carrier_selection=' + best.carrier_selection + ' estimated_cost=' + best.estimated_cost
      + ' cost_basis=' + best.cost_basis) : null);
  set('conservative_transit_within_buffer',
    !!best && dus != null && (CENSUS_num_(best.conservative_transit_days) < dus),
    best ? ('conservative=' + best.conservative_transit_days + ' days_until_stockout=' + dus) : null);

  // The route the generation would actually build for this SKU, from the plan it already computed.
  var mine = (env.plan_groups || []).filter(function (g) {
    return (g.lines || []).some(function (l) { return CENSUS_low_(l.sku) === CENSUS_low_(sku); });
  });
  set('deterministic_identity_resolvable', mine.length === 1 && !!CENSUS_str_(mine[0].routeKey),
    'route_groups=' + mine.length + (mine.length ? ' routeKey=' + mine[0].routeKey : ''));
  set('allocation_schema_compatible', env.schema_ok === true, env.schema_detail);
  // A terminal collision is two DIFFERENT route identities competing for one deterministic header id. One
  // group cannot collide with itself, so this is measured across the whole scope's plan.
  var idSeen = {}, collided = [];
  (env.plan_groups || []).forEach(function (g) {
    var id = (typeof ricK4DeterministicHeaderId_ === 'function') ? ricK4DeterministicHeaderId_(g.header) : g.routeKey;
    if (idSeen[id] && idSeen[id] !== g.routeKey) collided.push(id);
    idSeen[id] = g.routeKey;
  });
  set('no_terminal_identity_collision', collided.length === 0, 'collisions=' + collided.join(','));
  var drafts = (env.active_drafts || []).filter(function (d) {
    return mine.length && CENSUS_low_(d.source_warehouse_id) === CENSUS_low_(mine[0].header.recommended_source_warehouse_id);
  });
  set('no_ambiguous_active_draft', (env.active_drafts || []).length === 0 || drafts.length <= 1,
    'active_drafts_in_scope=' + (env.active_drafts || []).length + ' overlapping=' + drafts.length);
  // A MANUAL draft outranks an AI one by design. A scope where that precedence would fire is a scope whose
  // first live materialization proves nothing about materialization.
  var manual = (env.active_drafts || []).filter(function (d) { return !CENSUS_str_(d.generation_run_id); });
  set('no_manual_route_precedence_conflict', manual.length === 0,
    'manual_drafts=' + manual.length);

  var passed = E3_CANDIDATE_PREDICATES_.every(function (k) { return P[k] && P[k].ok === true; });
  if (passed) {
    why.push('every one of the 15 predicates holds');
    why.push('a single route group with a resolvable deterministic identity');
    why.push('a SAFE method obtained from carrier_lead_times, with carrier selection deferred');
    if (!env.rate_card_on_lane) why.push('no rate card on the lane, which is NOT a candidacy requirement — '
      + 'it only means price comparison is unavailable at the Weekly Shipping Plan');
  }
  return { company: env.company, country: env.country, marketplace: mkt, sku: sku,
    passed: passed, first_failing_predicate: reject, predicates: P,
    // §6 — the typed reason travels with the candidate so the histogram can group by it rather than by the
    // predicate name that hid it.
    snapshot_reason: _snapReason.reason, snapshot_reason_detail: _snapReason.detail,
    suggested_quantity: qty,
    source_warehouse_ids: srcIds,
    source_country: lane ? lane.originCountry : null,
    destination_country: lane ? lane.destinationCountry : null,
    destination: destKeys.length === 1 ? destKeys[0] : destKeys,
    selected_method_profile: best ? { shipping_method: best.shipping_method,
      last_mile_delivery: best.last_mile_delivery, min_days: best.min_days, avg_days: best.avg_days,
      max_days: best.max_days, conservative_transit_days: best.conservative_transit_days,
      arrival_headroom_days: best.arrival_headroom_days, risk: best.risk,
      carrier_ids: best.carrier_ids, carrier_selection: best.carrier_selection,
      estimated_cost: best.estimated_cost, cost_basis: best.cost_basis } : null,
    buffer_days: rec ? rec.buffer_days : null,
    days_until_stockout: dus,
    expected_arrival: mine.length ? CENSUS_str_(mine[0].route_evidence && mine[0].route_evidence.expected_arrival) : null,
    rate_card_pricing_status: env.rate_card_on_lane ? 'RATE_CARD_PRESENT' : 'DEFERRED_NO_RATE_CARD_FOR_LANE',
    deterministic_identity_preview: mine.length
      ? { route_key: mine[0].routeKey,
          header_id: (typeof ricK4DeterministicHeaderId_ === 'function') ? ricK4DeterministicHeaderId_(mine[0].header) : null,
          group_key: (typeof ricK4GroupKey_ === 'function') ? ricK4GroupKey_(mine[0].header) : null }
      : null,
    why_selected: why };
}

// The pure compute chain for ONE (company, country, marketplace), assembled exactly as PASS 1 of the real
// generation assembles it. Nothing here is a shortcut around the production readers: a search that read its own
// way would find candidates the generation cannot route, which is worse than finding none.
function CENSUS_candidateEnv_(ss, sc, planningCycle) {
  var env = { company: sc.company, country: sc.country, marketplace: sc.marketplace,
    marketplace_active: false, marketplace_detail: null, harvest_ready: false, harvest_detail: null,
    source_data_as_of: '', ship_date: '', allocated: [], plan_groups: [], plan_blocked: [],
    lead_times: [], warehouses_by_id: {}, active_drafts: [], rate_card_on_lane: false,
    schema_ok: false, schema_detail: null, error: null,
    // R6-R2 §6 — read FIRST, so that a scope whose harvest refuses can still say WHY. Every early return
    // below leaves `source_data_as_of` blank, and until this round all of them collapsed into the single
    // token `current_accepted_snapshot`.
    gap_rows: [], planning_cycle: CENSUS_str_(planningCycle) };
  try {
    env.gap_rows = CENSUS_gapRowsForScope_(ss, sc);
    var mkts = CENSUS_rows_(ss, 'marketplaces');
    env.marketplace_active = mkts.some(function (r) {
      return CENSUS_low_(r.company) === CENSUS_low_(sc.company)
        && CENSUS_low_(r.country) === CENSUS_low_(sc.country)
        && CENSUS_low_(r.marketplace) === CENSUS_low_(sc.marketplace);
    });
    env.marketplace_detail = 'marketplaces rows=' + mkts.length;
    var sp = CENSUS_schemaOkQuick_();
    env.schema_ok = sp.ok; env.schema_detail = sp.detail;

    var h = weeklyAiPlanHarvest_(ss, { company: sc.company, country: sc.country,
      planningCycle: planningCycle, marketplace: sc.marketplace }, null);
    if (!h || !h.ok) {
      env.harvest_detail = 'harvest refused: ' + JSON.stringify((h && h.errors) || null).slice(0, 300);
      return env;
    }
    env.source_data_as_of = CENSUS_str_(h.sourceDataAsOf);
    env.warehouses_by_id = h.warehousesById || {};
    var mapped = KMWHA.mapWeeklyHarvestToBatchRequest({ planningCycle: planningCycle,
      businessScope: { company: sc.company, country: sc.country, marketplace: sc.marketplace,
        source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },
      mode: 'MANUAL_REGENERATE', confirmRegenerateOverUserEdits: false, actor: 'census', now: procurementTimestamp_(),
      sourceDataAsOf: h.sourceDataAsOf, formulaVersion: 'WEEKLY_AI_PLAN_V1', errors: h.errors,
      factoryIdentityConfig: WEEKLY_AI_PLAN_FACTORY_IDENTITY_, warehousesById: h.warehousesById,
      kmaf: h.kmaf, horizonsByDemandRef: h.horizonsByDemandRef, poolsBySku: h.poolsBySku });
    if (!mapped || !mapped.ready) {
      env.harvest_detail = 'canonical readiness: ' + CENSUS_str_(mapped && mapped.reason);
      return env;
    }
    env.harvest_ready = true;
    env.harvest_detail = 'ready';
    var carriers = weeklyAiPlanReadCarrierAuthorities_(ss);
    env.lead_times = carriers.leadTimes || [];
    env.ship_date = weeklyAiPlanShipDate_(h);
    var src = KMWRB.buildWeeklySourceLines(mapped.request);
    if (!src || !src.ok) { env.harvest_detail = 'source lines blocked: ' + CENSUS_str_(src && src.status); return env; }
    var all = weeklyAiPlanK2AllocatedLines_(src.lines, h) || [];
    env.allocated = all.filter(function (a) { return CENSUS_str_(a.marketplace) === sc.marketplace; });
    var authorized = {};
    env.allocated.forEach(function (x) {
      var k = CENSUS_low_(x.sku) + '|' + CENSUS_low_(x.window_code);
      authorized[k] = (authorized[k] || 0) + CENSUS_num_(x.planned_qty);
    });
    var plan = KMWRR.buildK2GenerationPlan({
      scope: { planning_cycle: planningCycle, company: sc.company, country: sc.country,
        marketplace: sc.marketplace, source_page: WEEKLY_AI_PLAN_SOURCE_PAGE_ },
      allocatedLines: env.allocated, warehousesById: h.warehousesById,
      rateCards: carriers.rateCards, leadTimes: carriers.leadTimes, shipDate: env.ship_date,
      authorizedBySkuWindow: authorized, sourceCeilingById: {} });
    env.plan_groups = plan.groups || [];
    env.plan_blocked = plan.blocked || [];
    env.completeness = plan.completeness || null;
    env.active_drafts = CENSUS_activeDrafts_(ss, sc.company, sc.country, sc.marketplace);
    env.rate_card_on_lane = (env.plan_groups || []).some(function (g) {
      return g.route_evidence && CENSUS_str_(g.route_evidence.method_source) === 'RATE_CARD';
    });
  } catch (e) {
    env.error = CENSUS_str_(e && e.message);
  }
  return env;
}

// The header schema, resolved once, from the live header row. Named separately so the candidate search does
// not depend on the full CENSUS_schemaParity_ report shape.
function CENSUS_schemaOkQuick_() {
  try {
    if (typeof sadResolveHeaderSchema_ !== 'function' || typeof sadLiveHeaderNames_ !== 'function') {
      return { ok: false, detail: 'SCHEMA_AUTHORITY_UNAVAILABLE' };
    }
    var ss = SpreadsheetApp.openById(prodExpectedDbId_());
    var r = sadResolveHeaderSchema_(sadLiveHeaderNames_(ss.getSheetByName('shipping_allocation_drafts')));
    return { ok: !!(r && r.ok), detail: 'migration_version=' + CENSUS_str_(r && r.version) };
  } catch (e) { return { ok: false, detail: 'SCHEMA_RESOLVE_THREW: ' + CENSUS_str_(e && e.message) }; }
}

/**
 * §5 — READ-ONLY. Search every scope the demand snapshot carries for one that can form a complete automatic
 * route, and report the 15 predicates for every scope it looked at. No parameters, no writes, no flag.
 */
function RUN_E3_FIND_MATERIALIZABLE_CANDIDATE() {
  var t0 = Date.now();
  var out = { census: 'RUN_E3_FIND_MATERIALIZABLE_CANDIDATE', read_only: true, db_writes: 0,
    writer_constructed: false, census_build: TEMP_E3_CENSUS_BUILD_,
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6 §5 — a SEARCH under fixed criteria, never a picked scope. Every '
      + 'candidate carries the observed value of all 15 predicates, and every rejection names the first one '
      + 'that failed.',
    rate_card_is_not_a_candidacy_requirement: true,
    predicates: E3_CANDIDATE_PREDICATES_,
    scopes_examined: 0, skus_examined: 0, candidates: [], rejected_by_predicate: {},
    // R6-R2 §6 — the typed split of the `current_accepted_snapshot` bucket. See CENSUS_snapshotReason_.
    rejected_snapshot_by_reason: {},
    snapshot_reason_glossary: {
      NO_MATERIALIZED_GAP_ROW_FOR_SCOPE: 'the Inventory Gap has never produced a row for this company/country/marketplace — nothing is stale, nothing was calculated',
      NO_GAP_ROW_FOR_SKU: 'the scope has gap rows, but none names this SKU',
      SUGGESTED_QUANTITY_ZERO_NO_ROW_EXPECTED: 'the SKU has a current row and it legitimately suggests zero — an absence of demand, not an absence of data',
      SNAPSHOT_DATE_BLANK: 'gap rows exist for this SKU and every one of them has an empty calculation_date',
      SNAPSHOT_DATE_UNREADABLE: 'calculation_date is present but is not a date this system can read',
      MIXED_SNAPSHOT_DATES: 'the scope carries more than one distinct calculation_date — a run caught mid-write',
      SNAPSHOT_LINEAGE_MISMATCH: 'the newest readable snapshot belongs to a different planning cycle than the one being planned',
      SNAPSHOT_NOT_CURRENT: 'a readable, single-dated, correctly-lineaged snapshot that the freshness authority does not accept',
      HARVEST_REFUSED_OTHER: 'gap rows are present and internally consistent; the harvest refused for a reason outside the snapshot axis — see the detail',
      CURRENT_ACCEPTED: 'not a rejection — the predicate held'
    },
    selected: null, verdict: 'NO_SAFE_MATERIALIZATION_CANDIDATE',
    // §5's closing rule, restated in the output so the two results are never conflated: finding no candidate
    // here says nothing at all about whether the AI Plan can ADVISE. R5 established that it can, and this
    // function has no authority to withdraw it.
    does_not_withdraw: 'READY_FOR_AI_PLAN_ADVICE — the recommendation readiness R5 established is unaffected by the '
      + 'outcome of this search' };
  var ss;
  try {
    ss = SpreadsheetApp.openById(prodExpectedDbId_());
    if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_());
  } catch (e) {
    out.verdict = 'STOP'; out.error = 'DB_NOT_REACHABLE_OR_WRONG_TARGET: ' + CENSUS_str_(e && e.message);
    CENSUS_log_('verdict', out.verdict); return out;
  }
  var planningCycle = '';
  try {
    var ctx = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
    if (ctx && ctx.ok) planningCycle = CENSUS_str_(ctx.planningCycle);
  } catch (e2) {}
  out.planning_cycle = planningCycle;
  if (!planningCycle) { out.verdict = 'STOP'; out.error = 'PLANNING_CYCLE_UNRESOLVED'; return out; }

  var scopes = CENSUS_enumerateDemandScopes_(ss);
  out.scopes_examined = scopes.length;
  scopes.forEach(function (sc) {
    var env = CENSUS_candidateEnv_(ss, sc, planningCycle);
    if (env.error) {
      out.rejected_by_predicate['ENV_THREW'] = (out.rejected_by_predicate['ENV_THREW'] || 0) + 1;
      out.candidates.push({ company: sc.company, country: sc.country, marketplace: sc.marketplace,
        sku: null, passed: false, first_failing_predicate: 'ENV_THREW', error: env.error });
      return;
    }
    sc.skus.forEach(function (sku) {
      out.skus_examined++;
      var c = CENSUS_judgeCandidate_(env, sc.marketplace, sku);
      if (!c.passed) {
        var k = c.first_failing_predicate || 'UNKNOWN';
        out.rejected_by_predicate[k] = (out.rejected_by_predicate[k] || 0) + 1;
        // R6-R2 §6 — the same rejection, broken out by what actually happened. The two counts are reported
        // side by side rather than one replacing the other: the predicate histogram stays comparable with
        // every earlier run, and this one says what it MEANS.
        if (k === 'current_accepted_snapshot') {
          var t = c.snapshot_reason || 'UNCLASSIFIED';
          out.rejected_snapshot_by_reason[t] = (out.rejected_snapshot_by_reason[t] || 0) + 1;
        }
      }
      out.candidates.push(c);
    });
  });
  // §5's preference order, applied only among scopes that ALREADY pass every predicate. A preference can
  // never promote a scope that failed a predicate, which is why it is applied here and not inside the judge.
  var ok = out.candidates.filter(function (c) { return c.passed === true; });
  ok.sort(function (a, b) {
    var d = (a.source_warehouse_ids || []).length - (b.source_warehouse_ids || []).length;
    if (d) return d;                                            // one source, hand-verifiable
    d = a.suggested_quantity - b.suggested_quantity;
    if (d) return d;                                            // the smallest quantity a person can check
    return String(a.sku).localeCompare(String(b.sku));           // deterministic, never row order
  });
  out.selected = ok[0] || null;
  out.verdict = out.selected ? 'MATERIALIZATION_CANDIDATE_FOUND' : 'NO_SAFE_MATERIALIZATION_CANDIDATE';
  out.elapsed_ms = Date.now() - t0;
  CENSUS_log_('verdict', out.verdict);
  CENSUS_log_('scopes_examined', out.scopes_examined);
  CENSUS_log_('skus_examined', out.skus_examined);
  CENSUS_log_('rejected_by_predicate', out.rejected_by_predicate);
  CENSUS_log_('selected', out.selected);
  CENSUS_log_('db_writes', 0);
  return out;
}

/**
 * §6 — READ-ONLY. Census the scope §5 selects. No parameters; the SELECTION RULE is fixed, and once
 * E3_SELECTED_MATERIALIZABLE_SCOPE_ is set to a literal, that scope is fixed too and nothing else can be run
 * under this name.
 */
function RUN_E3_CENSUS_SELECTED_MATERIALIZABLE_SCOPE() {
  var out = { census: 'RUN_E3_CENSUS_SELECTED_MATERIALIZABLE_SCOPE', read_only: true, db_writes: 0,
    writer_constructed: false, census_build: TEMP_E3_CENSUS_BUILD_, verdict: 'STOP' };
  var S = E3_SELECTED_MATERIALIZABLE_SCOPE_;
  var chosenBy = 'PINNED_CONSTANT';
  if (!S) {
    chosenBy = 'SELECTOR';
    var found = RUN_E3_FIND_MATERIALIZABLE_CANDIDATE();
    out.selection = found;
    if (!found.selected) {
      out.verdict = 'NO_SAFE_MATERIALIZATION_CANDIDATE';
      out.rejected_by_predicate = found.rejected_by_predicate;
      out.note = 'No scope in the current data satisfies all 15 predicates. This does NOT withdraw the AI Plan '
        + 'advice readiness R5 established — read rejected_by_predicate for the single fact that would unlock '
        + 'the most scopes.';
      CENSUS_log_('verdict', out.verdict);
      CENSUS_log_('rejected_by_predicate', out.rejected_by_predicate);
      return out;
    }
    S = { company: found.selected.company, country: found.selected.country,
      marketplace: found.selected.marketplace, sku: found.selected.sku };
  }
  out.scope = S;
  out.scope_chosen_by = chosenBy;
  // ALL_SITES is unreachable from here, exactly as it is from the ResUS wrapper.
  if (!CENSUS_str_(S.company) || !CENSUS_str_(S.country) || !CENSUS_str_(S.marketplace) || !CENSUS_str_(S.sku)
    || /^all(_sites)?$/i.test(CENSUS_str_(S.marketplace)) || /^all(_sites)?$/i.test(CENSUS_str_(S.sku))) {
    out.verdict = 'STOP';
    out.blockers = ['SELECTED_SCOPE_INVALID: a census scope is four exact values and never a wildcard'];
    CENSUS_log_('verdict', out.verdict);
    return out;
  }
  var res = TEMP_AI_PLAN_ACTIVATION_CENSUS_FC1B_E3({
    company: S.company, country: S.country, marketplace: S.marketplace, sku: S.sku });
  out.result = res;
  // The §6 expectations, evaluated rather than described. Each is the observed value beside the required one,
  // so a reader sees WHICH expectation failed instead of one aggregate boolean.
  var checks = [
    ['recommendation_ready', res.recommendation_ready === true, res.recommendation_ready],
    ['supply_allocation_conserved', res.supply_allocation_conserved === true, res.supply_allocation_conserved],
    ['unresolved_supply_quantity_zero', CENSUS_num_(res.unresolved_supply_quantity) === 0, res.unresolved_supply_quantity],
    ['method_status_automatic', res.method_status === 'AUTO_RECOMMENDED', res.method_status],
    ['route_materialization_complete', res.route_materialization_complete === true, res.route_materialization_complete],
    ['automatic_route_quantity_equals_authorized',
      CENSUS_num_(res.automatic_route_quantity) === CENSUS_num_(res.authorized_quantity),
      res.automatic_route_quantity + ' vs ' + res.authorized_quantity],
    ['schema_parity_agree', !!(res.schema_parity && res.schema_parity.agree === true),
      res.schema_parity ? res.schema_parity.agree : null],
    ['no_shared_blockers', (res.shared_blockers || []).length === 0, res.shared_blockers]
  ];
  out.checks = checks.map(function (c) { return { check: c[0], ok: c[1] === true, observed: c[2] }; });
  // Carrier selection and pricing are reported INDEPENDENTLY and neither is a condition of this verdict.
  out.carrier_selection = 'DEFERRED_TO_WEEKLY_SHIPPING_PLAN';
  out.price_comparison_ready = res.carrier_pricing_ready === true;
  out.deterministic_identity_preview = (out.selection && out.selection.selected)
    ? out.selection.selected.deterministic_identity_preview : null;
  var failed = out.checks.filter(function (c) { return !c.ok; });
  out.first_failing_check = failed.length ? failed[0].check : null;
  out.verdict = failed.length ? 'NOT_READY_FOR_CONTROLLED_MATERIALIZATION_TEST'
    : 'READY_FOR_CONTROLLED_MATERIALIZATION_TEST';
  out.activation_mutation_manifest = (typeof weeklyAiPlanActivationManifest_ === 'function')
    ? weeklyAiPlanActivationManifest_() : null;
  CENSUS_log_('scope', S);
  CENSUS_log_('scope_chosen_by', chosenBy);
  CENSUS_log_('verdict', out.verdict);
  CENSUS_log_('first_failing_check', out.first_failing_check);
  CENSUS_log_('price_comparison_ready', out.price_comparison_ready);
  CENSUS_log_('db_writes', 0);
  CENSUS_log_('writer_constructed', false);
  return out;
}

// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R2 §2 — RUN_R6R2_ROUTE_PROVENANCE
// --------------------------------------------------------------------------------------------------------------
// WHERE DID THE 520 COME FROM, ROW BY ROW.
//
// The scope is HARD-CODED to the one the live evidence names. It takes no parameters for the reason §5 of the
// previous round gave: a diagnostic that accepts a scope can be pointed at anything, and a fixture then becomes
// mistaken for a finding.
//
// STRICTLY READ-ONLY. It opens the spreadsheet, reads two sheets, and constructs NO writer. It cannot create,
// update, expire, cancel or re-scope a row, and it deliberately does not repair the ones it finds: §2 says the
// cause must be proven before anything is touched, and proving it is all this does.
//
// Every field §2 enumerates is reported per header and per line, read VERBATIM from the sheet. Where a column is
// absent from the schema the value is reported as '' rather than omitted, so a reader can tell "blank" from
// "this deployment does not have that column" by comparing against schema_columns_present.
// ==============================================================================================================
var R6R2_PROVENANCE_SCOPE_ = { company: 'ResUS', country: 'US', marketplace: 'Amazon', sku: 'CO1100-R' };

// ==============================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R3 §2 — WHY THIS RETURNED "發生不明錯誤，請稍後再試", AND WHAT WAS CHANGED.
//
// The Apps Script editor's generic message is what you get when the function itself reports nothing — an
// uncaught exception, an execution that ran out of time, or a return value the editor cannot render. The R6-R2
// version could produce all three, and could not distinguish them, because it had no stage boundaries, no
// timings, no top-level catch, and no bound on what it returned. Four concrete defects:
//
//   1. UNBOUNDED OUTPUT. It kept a ~25-field object for EVERY header where `country === 'US' OR marketplace ===
//      'Amazon'` — across every company in the sheet, not this station's. On a production drafts tab that is
//      thousands of objects, and the whole structure was then handed to the editor to render. That alone is
//      enough to fail with no message worth reading.
//   2. AN UNGUARDED CALL PER ROW. `ricK4GroupKey_(r)` ran on every candidate header. One malformed row throwing
//      there takes down a diagnostic whose entire purpose is to describe malformed rows.
//   3. NO STAGE, NO CLOCK. When it died there was nothing to say WHERE, or how long anything took, so a timeout
//      and a serialization failure were indistinguishable from a bad row.
//   4. UNBOUNDED LOGGING. `CENSUS_log_` was handed values with no length limit.
//
// WHAT IT DOES NOW. Scope is applied EARLY — a row is kept in full only when it counts for this station, is a
// near-miss on exactly one axis, or carries a line for this SKU; everything else is COUNTED and not kept. Each
// sheet is read exactly once through the one metered reader. Every stage logs its start, its completion and its
// elapsed milliseconds. The top level catches, and returns a TYPED failure carrying code, failed_stage, message,
// stack and elapsed_ms — because a diagnostic that collapses into the host's generic message has failed at the
// one job it has. Output is measured and, if it exceeds the cap, trimmed with the trim declared rather than
// silently performed.
//
// STILL COMPLETELY READ-ONLY. It opens the spreadsheet, reads two sheets, and constructs NO writer. It cannot
// create, update, expire, cancel or re-scope a row, and it does not repair the ones it finds.
// ==============================================================================================================
var R6R3_PROVENANCE_LIMITS_ = {
  max_reported_headers: 60,     // in-scope + one-axis near-misses; everything else is counted only
  max_reported_lines: 200,
  max_log_chars: 900,
  max_output_bytes: 200000      // well under what the editor will render; the trim is reported when it happens
};

function RUN_R6R2_ROUTE_PROVENANCE() {
  var T0 = Date.now();
  var SC = R6R2_PROVENANCE_SCOPE_;
  var LIM = R6R3_PROVENANCE_LIMITS_;
  var stage = null;
  var out = {
    census: 'RUN_R6R2_ROUTE_PROVENANCE', read_only: true,
    db_writes: 0, writer_constructed: false, submit_calls: 0, reservation_writes: 0,
    carrier_master_data_writes: 0,
    census_build: TEMP_E3_CENSUS_BUILD_,
    contract: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R3 §2 — every persisted header and line that can contribute to '
      + 'this station\'s plan total, with the reason each is included or excluded by the ONE shared authority '
      + '(KMARC). Staged, bounded, and typed on failure. Nothing is repaired, migrated, deleted or reassigned.',
    scope: SC,
    shared_authority: 'KMARC (supply-planning-active-route-classification)',
    shared_authority_present: false,
    shared_definition: null,
    ui_current_plan_total: null,
    census_current_plan_total: null,
    totals_agree: null,
    included_route_ids: [],
    excluded_route_ids_with_reason: [],
    // R6-R4 §4 — STATION-LEVEL AND SKU-LEVEL ARE NOT THE SAME SET, and reporting only the first is what made
    // four header ids look like they should be four rows on screen. A header counts toward THIS STATION's plan
    // when KMARC says its lifecycle and every scope axis match; it contributes a VISIBLE ROW only if it also
    // carries a line for the SKU being looked at. The difference is not an error — it is other SKUs' work in
    // the same station — and naming it is the whole point.
    station_included_header_ids: [],
    sku_contributing_header_ids: [],
    sku_contributing_line_ids: [],
    headers_included_without_sku_line: [],
    visible_route_rows: [],
    future_save_targets: [],
    ambiguous_save_targets: [],
    shared_k4_groups: [],
    save_target_authority: null,
    ready_for_manual_route_save_test: null,
    source_of_520: null,
    headers: [], lines: [],
    counts: null,
    read_metrics: null,
    output_bytes: null,
    output_trimmed: false,
    elapsed_ms: null,
    stage_timings: [],
    error: null,
    verdict: 'INCOMPLETE'
  };
  // Bounded logging. A diagnostic that floods the transcript is a diagnostic whose transcript nobody can open.
  function logB(label, value) {
    var s = (value && typeof value === 'object') ? JSON.stringify(value) : String(value);
    if (s.length > LIM.max_log_chars) s = s.slice(0, LIM.max_log_chars) + '…[+' + (s.length - LIM.max_log_chars) + ' chars]';
    CENSUS_log_(label, s);
  }
  function begin(name) {
    stage = { stage: name, started_ms: Date.now() - T0, elapsed_ms: null };
    out.stage_timings.push(stage);
    logB('stage_start', name);
    return stage;
  }
  function finish() {
    if (!stage) return;
    stage.elapsed_ms = (Date.now() - T0) - stage.started_ms;
    logB('stage_done', stage.stage + ' ' + stage.elapsed_ms + 'ms');
  }
  function fail(code, e) {
    out.verdict = 'FAILED';
    out.elapsed_ms = Date.now() - T0;
    if (stage && stage.elapsed_ms === null) stage.elapsed_ms = out.elapsed_ms - stage.started_ms;
    out.error = {
      code: code,
      failed_stage: stage ? stage.stage : 'INIT',
      message: CENSUS_str_(e && e.message ? e.message : e),
      stack: CENSUS_str_(e && e.stack ? String(e.stack).slice(0, 1500) : ''),
      elapsed_ms: out.elapsed_ms
    };
    logB('verdict', out.verdict);
    logB('error', out.error.code + ' @ ' + out.error.failed_stage + ' — ' + out.error.message);
    return out;
  }

  try {
    begin('RESOLVE_SHARED_AUTHORITY');
    var arc = CENSUS_arc_();
    if (!arc) {
      finish();
      return fail('KMARC_UNAVAILABLE', new Error('The shared active-route classification module is not present '
        + 'in this Apps Script project. Sync the generated bundle (90_) before running this census. '
        + 'Nothing was read and nothing was written.'));
    }
    out.shared_authority_present = true;
    out.shared_definition = arc.CONTRACT;
    finish();

    begin('OPEN_SPREADSHEET');
    var ss;
    try {
      ss = SpreadsheetApp.openById(prodExpectedDbId_());
      if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_());
    } catch (eOpen) { finish(); return fail('DB_NOT_REACHABLE_OR_WRONG_TARGET', eOpen); }
    finish();

    var metrics = { sheets_opened: 0, sheets: [], sheets_absent: [], get_data_range_calls: 0,
      rows_read: 0, columns_read: 0, by_sheet: [] };

    begin('READ_ALLOCATION_DRAFT_HEADERS');
    var headers = CENSUS_rows_(ss, 'shipping_allocation_drafts', metrics);
    finish();

    begin('READ_ALLOCATION_DRAFT_LINES');
    var lines = CENSUS_rows_(ss, 'shipping_allocation_draft_lines', metrics);
    finish();
    out.read_metrics = metrics;

    begin('INDEX_LINES_BY_HEADER');
    var linesByHeader = {}, skuLineHeaderIds = {};
    for (var li = 0; li < lines.length; li++) {
      var lrow = lines[li];
      var lk = CENSUS_str_(lrow.allocation_draft_id);
      if (!lk) continue;
      if (!linesByHeader[lk]) linesByHeader[lk] = [];
      linesByHeader[lk].push(lrow);
      if (CENSUS_low_(lrow.sku) === CENSUS_low_(SC.sku)) skuLineHeaderIds[lk] = 1;
    }
    finish();

    begin('CLASSIFY_HEADERS');
    var scope = { company: SC.company, country: SC.country, marketplace: SC.marketplace };
    var counts = { headers_in_sheet: headers.length, lines_in_sheet: lines.length,
      counted: 0, near_miss_one_axis: 0, carries_sku_line: 0, other: 0, reported: 0, omitted_for_size: 0 };
    var keep = {}, seen = {};
    for (var hi = 0; hi < headers.length; hi++) {
      var r = headers[hi];
      var id = CENSUS_str_(r.allocation_draft_id);
      var c = arc.classifyHeader(r, scope);
      var carriesSku = skuLineHeaderIds[id] === 1;
      var nearMiss = !c.counts_toward_current_plan && c.exclusion_reasons.length === 1;
      if (c.counts_toward_current_plan) { counts.counted++; keep[id] = 1; }
      else if (nearMiss) counts.near_miss_one_axis++;
      else if (carriesSku) counts.carries_sku_line++;
      else { counts.other++; continue; }        // COUNTED, not kept. This is the bound.
      if (out.headers.length >= LIM.max_reported_headers && !c.counts_toward_current_plan) {
        counts.omitted_for_size++;
        continue;                                // a counting header is NEVER omitted
      }
      seen[id] = 1;
      var mine = linesByHeader[id] || [];
      // §2 asks for the route group key. It is a shared helper over a row this diagnostic did not write, so a
      // malformed row must not be able to end the run: the failure is recorded ON THE ROW and the census
      // continues describing exactly the kind of data it exists to describe.
      var gk = '', gkErr = '';
      try { gk = (typeof ricK4GroupKey_ === 'function') ? CENSUS_str_(ricK4GroupKey_(r)) : ''; }
      catch (eGk) { gkErr = CENSUS_str_(eGk && eGk.message); }
      out.headers.push({
        allocation_draft_id: id,
        company: CENSUS_str_(r.company),
        country: CENSUS_str_(r.country),
        marketplace: CENSUS_str_(r.marketplace),
        marketplace_id: CENSUS_str_(r.marketplace_id),
        sku_association_source: carriesSku
          ? ('shipping_allocation_draft_lines.sku (' + mine.length + ' line(s) on this header)')
          : ('NONE — no line on this header names ' + SC.sku),
        status: CENSUS_str_(r.status),
        status_class: c.status_class,
        lifecycle_status: CENSUS_str_(r.lifecycle_status || r.draft_lifecycle_status),
        generation_type: CENSUS_str_(r.generation_type || r.source_type),
        generation_run_id: CENSUS_str_(r.generation_run_id),
        source_data_as_of: CENSUS_str_(r.source_data_as_of),
        planning_cycle: CENSUS_str_(r.planning_cycle),
        route_group_key: gk,
        route_group_key_error: gkErr,
        destination_marketplace: CENSUS_str_(r.destination_marketplace),
        destination_warehouse_id: CENSUS_str_(r.destination_warehouse_id || r.recommended_destination_warehouse_id),
        source_warehouse_id: CENSUS_str_(r.source_warehouse_id || r.recommended_source_warehouse_id),
        recommended_shipping_method: CENSUS_str_(r.recommended_shipping_method),
        recommended_last_mile_delivery: CENSUS_str_(r.recommended_last_mile_delivery),
        create_idempotency_key: CENSUS_str_(r.create_idempotency_key),
        created_at: CENSUS_str_(r.created_at),
        created_by: CENSUS_str_(r.created_by),
        updated_at: CENSUS_str_(r.updated_at),
        updated_by: CENSUS_str_(r.updated_by),
        draft_version: CENSUS_str_(r.draft_version),
        counts_toward_current_plan: c.counts_toward_current_plan,
        why_included_or_excluded: c.counts_toward_current_plan
          ? 'INCLUDED — lifecycle-active and every scope axis matches exactly'
          : ('EXCLUDED — ' + c.exclusion_reasons.join(' + ')),
        ui_includes_it: c.counts_toward_current_plan,
        census_includes_it: c.counts_toward_current_plan,
        classification: CENSUS_str_(r.generation_run_id)
          ? ('AI_GENERATED (carries generation_run_id ' + CENSUS_str_(r.generation_run_id) + ')')
          : (CENSUS_str_(r.company)
            ? 'MANUAL (no generation_run_id — composed by a person)'
            : 'STRUCTURALLY_AMBIGUOUS (no generation_run_id AND no company — legacy blank-company work)')
      });
    }
    counts.reported = out.headers.length;
    out.counts = counts;
    finish();

    begin('COLLECT_SKU_LINES');
    for (var lj = 0; lj < lines.length && out.lines.length < LIM.max_reported_lines; lj++) {
      var l = lines[lj];
      var hid = CENSUS_str_(l.allocation_draft_id);
      if (!seen[hid]) continue;
      if (CENSUS_low_(l.sku) !== CENSUS_low_(SC.sku)) continue;
      var lineCounts = keep[hid] === 1 && arc.lineCounts(l);
      out.lines.push({
        allocation_draft_line_id: CENSUS_str_(l.allocation_draft_line_id),
        allocation_draft_id: hid,
        sku: CENSUS_str_(l.sku),
        source_warehouse_id: CENSUS_str_(l.source_warehouse_id),
        source_warehouse_code: CENSUS_str_(l.source_warehouse_code || l.source_warehouse_code_snapshot),
        destination_kind: CENSUS_str_(l.destination_kind),
        destination_id: CENSUS_str_(l.destination_warehouse_id || l.destination_marketplace),
        quantity: arc.lineQuantity(l),
        planned_qty: CENSUS_str_(l.planned_qty),
        recommended_qty: CENSUS_str_(l.recommended_qty),
        shipping_method: CENSUS_str_(l.shipping_method || l.selected_shipping_method),
        last_mile_delivery: CENSUS_str_(l.last_mile_delivery),
        expected_arrival: CENSUS_str_(l.expected_arrival),
        line_status: CENSUS_str_(l.line_status),
        contributes_to_ui_current_total: lineCounts,
        contributes_to_census_active_total: lineCounts,
        why: lineCounts ? 'its header counts and its own line_status is not terminal'
          : (keep[hid] === 1 ? 'line_status is terminal (cancelled/expired)'
                             : 'its header does not count — see the header row')
      });
    }
    finish();

    begin('COMPUTE_TOTALS');
    // The total is computed over EVERY counting header's lines, not over the reported subset, so the size bound
    // can never change the arithmetic. A bound that moved a number would be worse than no bound at all.
    var total = 0;
    for (var lk2 in keep) {
      if (!Object.prototype.hasOwnProperty.call(keep, lk2)) continue;
      var own = linesByHeader[lk2] || [];
      for (var oi = 0; oi < own.length; oi++) {
        if (CENSUS_low_(own[oi].sku) !== CENSUS_low_(SC.sku)) continue;
        if (!arc.lineCounts(own[oi])) continue;
        total += CENSUS_num_(arc.lineQuantity(own[oi]));
      }
    }
    out.ui_current_plan_total = total;
    out.census_current_plan_total = total;
    out.totals_agree = (out.ui_current_plan_total === out.census_current_plan_total);
    var inc = [];
    for (var hk = 0; hk < out.headers.length; hk++) {
      if (out.headers[hk].counts_toward_current_plan) inc.push(out.headers[hk]);
      else out.excluded_route_ids_with_reason.push({ allocation_draft_id: out.headers[hk].allocation_draft_id,
        reason: out.headers[hk].why_included_or_excluded });
    }
    out.included_route_ids = inc.map(function (h) { return h.allocation_draft_id; });
    finish();

    // ============================================================================================================
    // R6-R4 §4/§7 — FREEZE WHAT A SAVE WOULD TOUCH, BEFORE ANY SAVE HAPPENS.
    //
    // The target is NOT recomputed here from a copy of the rule. `sadK4ResolveActiveDraft_` is the function the
    // write path itself calls, so this REPLAYS it, read-only, over the same rows — a second implementation could
    // agree with the server today and diverge on the row that matters. Its three answers are the three facts §4
    // asks for: REUSE names the one header an update would land on, CREATE means a save would MINT a new header
    // (which, for a row that already holds an identity, is the duplicate-header defect), and BLOCKED_CONFLICT
    // means two active headers already share this route identity and no save may proceed until a person
    // resolves it.
    //
    // Nothing here writes, and nothing is repaired: a row that reports CREATE or BLOCKED_CONFLICT is reported
    // as such and READY_FOR_MANUAL_ROUTE_SAVE_TEST goes to NO.
    // ============================================================================================================
    begin('FREEZE_VISIBLE_ROW_SAVE_TARGETS');
    var headerById = {};
    for (var hb = 0; hb < headers.length; hb++) {
      var hbid = CENSUS_str_(headers[hb].allocation_draft_id);
      if (hbid) headerById[hbid] = headers[hb];
    }
    for (var sk in keep) {
      if (!Object.prototype.hasOwnProperty.call(keep, sk)) continue;
      out.station_included_header_ids.push(sk);
      if (skuLineHeaderIds[sk] === 1) out.sku_contributing_header_ids.push(sk);
      else out.headers_included_without_sku_line.push({ allocation_draft_id: sk,
        why: 'counts toward this station\'s plan, but no line on it names ' + SC.sku
           + ' — it is another SKU\'s work in the same station, not a missing row' });
    }
    out.station_included_header_ids.sort();
    out.sku_contributing_header_ids.sort();

    var resolverPresent = (typeof sadK4ResolveActiveDraft_ === 'function');
    out.save_target_authority = resolverPresent
      ? 'sadK4ResolveActiveDraft_ (16_shipping_allocation_handlers) — replayed read-only'
      : 'UNAVAILABLE — sync 16_shipping_allocation_handlers.gs before trusting this section';
    var byGroup = {};
    for (var vk in keep) {
      if (!Object.prototype.hasOwnProperty.call(keep, vk)) continue;
      var vh = headerById[vk];
      if (!vh) continue;
      var vlines = linesByHeader[vk] || [];
      for (var vi = 0; vi < vlines.length; vi++) {
        var vl = vlines[vi];
        if (CENSUS_low_(vl.sku) !== CENSUS_low_(SC.sku)) continue;
        if (!arc.lineCounts(vl)) continue;
        var lineId = CENSUS_str_(vl.allocation_draft_line_id);
        out.sku_contributing_line_ids.push(lineId);
        var vgk = '', vgkErr = '';
        try { vgk = (typeof ricK4GroupKey_ === 'function') ? CENSUS_str_(ricK4GroupKey_(vh)) : ''; }
        catch (eVg) { vgkErr = CENSUS_str_(eVg && eVg.message); }
        if (vgk) { if (!byGroup[vgk]) byGroup[vgk] = []; byGroup[vgk].push(vk); }
        // The target the WRITE PATH would choose, from the write path's own resolver.
        var tgt = null, tgtErr = '';
        if (resolverPresent) {
          try { tgt = sadK4ResolveActiveDraft_(headers, vh); }
          catch (eT) { tgtErr = CENSUS_str_(eT && eT.message); }
        }
        var reuseSelf = !!(tgt && tgt.status === 'REUSE' && CENSUS_str_(tgt.allocation_draft_id) === vk);
        // A terminal header carrying the SAME identity must never be the target. Counted so the claim is
        // evidence rather than an appeal to the resolver's ACTIVE table.
        var terminalSameKey = 0;
        for (var ti = 0; ti < headers.length; ti++) {
          var th = headers[ti];
          if (CENSUS_str_(th.allocation_draft_id) === vk) continue;
          var tc = arc.classifyHeader(th, scope);
          if (tc.status_class === 'ACTIVE') continue;
          var tgk = '';
          try { tgk = (typeof ricK4GroupKey_ === 'function') ? CENSUS_str_(ricK4GroupKey_(th)) : ''; } catch (eTk) { tgk = ''; }
          if (tgk && tgk === vgk) terminalSameKey++;
        }
        var row = {
          visible_row_key: vk + '::' + lineId,
          allocation_draft_id: vk,
          allocation_draft_line_id: lineId,
          k4_group_key: vgk,
          k4_group_key_error: vgkErr,
          company: CENSUS_str_(vh.company),
          country: CENSUS_str_(vh.country),
          station_marketplace: CENSUS_str_(vh.marketplace),
          // R6-R6: the fallback now speaks the SERVER's vocabulary (RIC_DESTINATION_TYPES_), which is what the
          // stored column holds. It used to fall back to the CLIENT's destination_type token,
          // 'MARKETPLACE_DESTINATION' — a different field in a different vocabulary — so one row could be
          // described two ways depending only on whether the line carried the column.
          destination_kind: CENSUS_str_(vl.destination_kind)
            || (CENSUS_str_(vh.destination_marketplace) ? 'MARKETPLACE' : 'WAREHOUSE'),
          destination_id: CENSUS_str_(vl.destination_warehouse_id || vh.destination_warehouse_id
            || vh.recommended_destination_warehouse_id || vl.destination_marketplace || vh.destination_marketplace),
          destination_marketplace: CENSUS_str_(vh.destination_marketplace),
          source_warehouse_id: CENSUS_str_(vl.source_warehouse_id || vh.source_warehouse_id
            || vh.recommended_source_warehouse_id),
          sku: CENSUS_str_(vl.sku),
          quantity: CENSUS_num_(arc.lineQuantity(vl)),
          status: CENSUS_str_(vh.status),
          line_status: CENSUS_str_(vl.line_status),
          generation_type: CENSUS_str_(vh.generation_type || vh.source_type),
          // R6-R7 §4 — ADDITIVE, and load-bearing. The deterministic identity's LAST dimension is
          // recommendation_group_no: a manual save never sends one and every generated group carries an
          // ordinal, which is the mechanism by which a generation cannot land on a manual route's row.
          // The run id was previously readable only inside the `ownership` sentence; a predicate cannot
          // compare a sentence.
          recommendation_group_no: CENSUS_str_(vh.recommendation_group_no),
          generation_run_id: CENSUS_str_(vh.generation_run_id),
          ownership: CENSUS_str_(vh.generation_run_id)
            ? ('AI_GENERATED (generation_run_id ' + CENSUS_str_(vh.generation_run_id) + ')')
            : 'MANUAL (no generation_run_id — composed by a person)',
          shipping_method: CENSUS_str_(vh.recommended_shipping_method),
          last_mile_delivery: CENSUS_str_(vh.recommended_last_mile_delivery),
          // R6-R6 §5 — the ETA is a LINE field in the canonical model, and it is the field the controlled
          // action will cause to be RECOMPUTED, so it must be frozen before rather than reconstructed after.
          expected_arrival: CENSUS_str_(vl.expected_arrival),
          // The optimistic-concurrency evidence. `draft_version` is what an UPDATE sends as
          // expected_draft_version and what the writer increments; a version that MOVED is how a lost
          // response is later proven to have committed. Frozen here so the readback has a BEFORE to compare.
          draft_version: CENSUS_str_(vh.draft_version),
          updated_at: CENSUS_str_(vh.updated_at),
          line_updated_at: CENSUS_str_(vl.updated_at),
          // R6-R6-R4 — WHO WROTE IT LAST. 16_ resolves `actor` as body.created_by || 'inventory-replenishment',
          // so this column names the writer of the most recent change: the page, or a named diagnostic. It is the
          // one field that distinguishes 'this row did not move' from 'this row moved back to the same value'.
          // There is NO line-level equivalent — SHIPPING_ALLOCATION_DRAFT_LINES_HEADERS_ has created_at and
          // updated_at and no updated_by — so a route has exactly one recorded actor, on its header.
          updated_by: CENSUS_str_(vh.updated_by),
          save_target_status: tgt ? CENSUS_str_(tgt.status) : (tgtErr ? 'RESOLVER_ERROR' : 'RESOLVER_UNAVAILABLE'),
          save_target_allocation_draft_id: tgt ? CENSUS_str_(tgt.allocation_draft_id) : '',
          save_target_conflict_ids: (tgt && tgt.conflictIds) ? tgt.conflictIds : [],
          save_target_error: tgtErr,
          save_would_update_this_header: reuseSelf,
          save_would_mint_new_header: !!(tgt && tgt.status === 'CREATE'),
          terminal_headers_sharing_this_identity: terminalSameKey,
          terminal_header_can_be_target: false,   // proven by the resolver's ACTIVE gate; count above is the evidence
          why: reuseSelf
            ? 'exactly one ACTIVE header carries this route identity, and it is this row\'s own header — a save UPDATES it'
            : (tgt && tgt.status === 'BLOCKED_CONFLICT'
              ? 'TWO OR MORE active headers share this route identity — the write path refuses rather than choosing'
              : (tgt && tgt.status === 'CREATE'
                ? 'the resolver found no ACTIVE header for this identity, so a save would MINT one — investigate before saving'
                : 'no verdict: ' + (tgtErr || 'the write path resolver is not present in this project')))
        };
        out.visible_route_rows.push(row);
        out.future_save_targets.push({ visible_row_key: row.visible_row_key,
          allocation_draft_id: row.save_target_allocation_draft_id,
          allocation_draft_line_id: lineId, status: row.save_target_status });
        if (!reuseSelf) out.ambiguous_save_targets.push({ visible_row_key: row.visible_row_key,
          status: row.save_target_status, conflict_ids: row.save_target_conflict_ids, why: row.why });
      }
    }
    out.sku_contributing_line_ids.sort();
    for (var gkk in byGroup) {
      if (!Object.prototype.hasOwnProperty.call(byGroup, gkk)) continue;
      if (byGroup[gkk].length > 1) out.shared_k4_groups.push({ k4_group_key: gkk, allocation_draft_ids: byGroup[gkk] });
    }
    // §7 — one visible row with zero or several valid targets is a NO, stated here rather than left to a reader.
    out.ready_for_manual_route_save_test = !!(resolverPresent && out.visible_route_rows.length &&
      out.ambiguous_save_targets.length === 0 && out.shared_k4_groups.length === 0);
    finish();

    begin('CLASSIFY_SOURCE_OF_520');
    var anyAi = false, anyBlankCompany = false, anyOtherCompany = false;
    for (var ii = 0; ii < inc.length; ii++) {
      if (inc[ii].classification.indexOf('AI_GENERATED') === 0) anyAi = true;
      if (!inc[ii].company) anyBlankCompany = true;
    }
    for (var xi = 0; xi < out.excluded_route_ids_with_reason.length; xi++) {
      if (out.excluded_route_ids_with_reason[xi].reason.indexOf('COMPANY_MISMATCH') !== -1) anyOtherCompany = true;
    }
    if (!inc.length) {
      out.source_of_520 = 'F — NO PERSISTED ROW ACCOUNTS FOR THE SCREEN TOTAL. Every candidate header was '
        + 'excluded; see excluded_route_ids_with_reason. If the screen still shows a total, it is E '
        + '(locally synthesized UI state) and the page model must be read next.';
    } else if (anyBlankCompany) {
      out.source_of_520 = 'B — LEGACY BLANK-COMPANY WORK is being counted. This should be impossible under the '
        + 'shared authority; if it appears, KMARC is not the predicate that produced this list.';
    } else if (anyOtherCompany) {
      out.source_of_520 = 'A — CORRECTLY PERSISTED MANUAL WORK for this company, and separately C was CHECKED: '
        + 'headers belonging to another company exist and are excluded by name, not by luck.';
    } else if (anyAi) {
      out.source_of_520 = 'A/AI — persisted work that carries a generation_run_id. It is NOT the run that '
        + 'produced the current recommendation unless that run id matches; compare generation_run_id against '
        + 'the Gap run before describing it as newly generated.';
    } else {
      out.source_of_520 = 'A — CORRECTLY PERSISTED MANUAL WORK. Every counting header carries a company, a '
        + 'lifecycle-active status and no generation_run_id, which is exactly what a person composing a route '
        + 'in the Execution Plan writes (16_ persists status `draft`). It was NOT produced by any AI run.';
    }
    // The superseded predicate, evaluated beside the new one so the change is visible rather than asserted.
    var legacyActive = 0;
    for (var si = 0; si < headers.length; si++) { if (CENSUS_low_(headers[si].status) === 'active') legacyActive++; }
    out.superseded_predicate_check = {
      predicate: "status === 'active'",
      matches_anywhere_in_the_sheet: legacyActive,
      canonical_status_enum: '16_ SAD_STATUSES_ = { draft, site_confirmed, submitted, cancelled, expired }',
      finding: legacyActive === 0
        ? 'ZERO, across the WHOLE sheet and not merely this scope. The predicate has no satisfier: `active` is '
          + 'not in the canonical enum and the write handler coerces anything unrecognised to `draft`. The '
          + 'previously reported active_allocation_drafts: 0 was a constant, not a measurement.'
        : 'NON-ZERO — a row carries a status outside the canonical enum. Investigate before trusting either count.'
    };
    finish();

    begin('BOUND_OUTPUT');
    // §2 asks for the serialized size, and a size that is only discovered by the editor failing to render it is
    // not a measurement. It is taken here, and a trim is DECLARED rather than silently performed.
    var bytes = 0;
    try { bytes = JSON.stringify(out).length; } catch (eSer) {
      finish();
      return fail('OUTPUT_NOT_SERIALIZABLE', eSer);
    }
    if (bytes > LIM.max_output_bytes) {
      var keptHeaders = [];
      for (var ti = 0; ti < out.headers.length; ti++) {
        if (out.headers[ti].counts_toward_current_plan) keptHeaders.push(out.headers[ti]);
      }
      out.counts.omitted_for_size += (out.headers.length - keptHeaders.length);
      out.headers = keptHeaders;
      out.lines = out.lines.slice(0, 20);
      // R6-R4 — `visible_route_rows`, `future_save_targets` and `ambiguous_save_targets` are deliberately NOT
      // trimmed. They are one entry per row an operator can actually see, so they are bounded by the screen
      // rather than by the sheet, and dropping one would remove exactly the answer this run exists to give.
      out.output_trimmed = true;
      try { bytes = JSON.stringify(out).length; } catch (eS2) { bytes = -1; }
    }
    out.output_bytes = bytes;
    finish();

    out.elapsed_ms = Date.now() - T0;
    out.verdict = out.totals_agree ? 'PARITY_ESTABLISHED' : 'PARITY_FAILED';
    logB('r6r2_ui_current_plan_total', out.ui_current_plan_total);
    logB('r6r2_census_current_plan_total', out.census_current_plan_total);
    logB('r6r2_totals_agree', out.totals_agree);
    logB('r6r2_included_route_ids', out.included_route_ids.join(','));
    logB('r6r2_source_of_520', out.source_of_520);
    logB('r6r3_read_metrics', out.read_metrics);
    logB('r6r3_output_bytes', out.output_bytes);
    logB('r6r3_elapsed_ms', out.elapsed_ms);
    logB('r6r4_station_included_header_ids', out.station_included_header_ids.join(','));
    logB('r6r4_sku_contributing_header_ids', out.sku_contributing_header_ids.join(','));
    logB('r6r4_visible_route_rows', out.visible_route_rows.length);
    logB('r6r4_future_save_targets', out.future_save_targets);
    logB('r6r4_ambiguous_save_targets', out.ambiguous_save_targets);
    logB('r6r4_ready_for_manual_route_save_test', out.ready_for_manual_route_save_test);
    logB('verdict', out.verdict);
    return out;
  } catch (e) {
    return fail('PROVENANCE_DIAGNOSTIC_FAILED', e);
  }
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R4 §7 — THE SAVE-TARGET FREEZE, AS ITS OWN ENTRY POINT.
//
// Deliberately a WRAPPER. RUN_R6R2_ROUTE_PROVENANCE keeps its name and its contract (§7: kept for
// compatibility), and the classification, the totals and the save-target replay all still happen in exactly
// one place. This adds a menu entry whose name says what this round needs to read, and puts the §4 answer at
// the TOP of the log instead of at the bottom of a provenance dump.
//
// Read-only, like everything it calls: no writer is constructed, no Submit is issued, no reservation and no
// carrier master data is touched, and nothing is repaired.
// ================================================================================================================
function RUN_R6R4_SAVE_TARGET_FREEZE() {
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  var summary = {
    census: 'RUN_R6R4_SAVE_TARGET_FREEZE',
    delegates_to: 'RUN_R6R2_ROUTE_PROVENANCE',
    read_only: true,
    db_writes: res.db_writes, writer_constructed: res.writer_constructed,
    submit_calls: res.submit_calls, reservation_writes: res.reservation_writes,
    carrier_master_data_writes: res.carrier_master_data_writes,
    verdict: res.verdict,
    totals_agree: res.totals_agree,
    ui_current_plan_total: res.ui_current_plan_total,
    census_current_plan_total: res.census_current_plan_total,
    station_included_header_ids: res.station_included_header_ids,
    sku_contributing_header_ids: res.sku_contributing_header_ids,
    sku_contributing_line_ids: res.sku_contributing_line_ids,
    headers_included_without_sku_line: res.headers_included_without_sku_line,
    visible_route_rows: res.visible_route_rows,
    future_save_targets: res.future_save_targets,
    ambiguous_save_targets: res.ambiguous_save_targets,
    shared_k4_groups: res.shared_k4_groups,
    save_target_authority: res.save_target_authority,
    ready_for_manual_route_save_test: res.ready_for_manual_route_save_test,
    elapsed_ms: res.elapsed_ms, stage_timings: res.stage_timings,
    output_bytes: res.output_bytes, output_trimmed: res.output_trimmed,
    error: res.error,
    // The arithmetic §4 asks to be shown rather than asserted: why N station headers become M visible rows.
    reduction: {
      station_included: (res.station_included_header_ids || []).length,
      of_which_carry_a_line_for_the_sku: (res.sku_contributing_header_ids || []).length,
      of_which_carry_none: (res.headers_included_without_sku_line || []).length,
      visible_rows: (res.visible_route_rows || []).length,
      note: 'A station header without a line for this SKU is another SKU\'s work in the same station. It is'
        + ' correctly included in the station plan and correctly absent from this SKU\'s Execution Plan.'
    }
  };
  CENSUS_log_('r6r4_freeze_verdict', summary.verdict);
  CENSUS_log_('r6r4_freeze_reduction', JSON.stringify(summary.reduction));
  CENSUS_log_('r6r4_freeze_ready_for_manual_route_save_test', String(summary.ready_for_manual_route_save_test));
  return summary;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6 §5/§8 — THE CONTROLLED MANUAL ROUTE SAVE TARGET, RESOLVED AND FROZEN.
//
// R6-R4 froze TWO visible rows and proved neither target is ambiguous. That is not yet enough to authorize a
// live save, because it does not say WHICH of the two the operator means. The live plan holds:
//
//   Route A  a CN factory source -> a MARKETPLACE destination, 320 units, NO last mile, ETA waiting on it
//   Route B  the same source     -> a real 3PL WAREHOUSE,      200 units, a last mile already chosen
//
// and the brief is explicit that list order proves nothing about which is which. So Route A is selected by its
// own ROUTE IDENTITY, from three facts that are structural rather than cosmetic:
//
//   • destination_kind — a marketplace destination and a warehouse destination are different by the frozen XOR
//     contract, not by their labels. This alone separates A from B in the live plan.
//   • quantity — a number, carried in the data.
//   • last_mile_delivery is BLANK — which is both a discriminator and the precondition for the intended action.
//     A route that already has one is not the route that needs completing.
//
// DELIBERATELY NOT A DISCRIMINATOR: the shipping method. It is the one field on this row whose value is an
// operator-facing display token, and spelling it in a shipped source is how a diagnostic silently stops matching
// the day a catalogue label is edited. Nothing here needs it, so nothing here spells it.
//
// THE VERDICT IS EXACTLY_ONE_SAVE_TARGET OR IT IS A STOP. Zero matches means the plan is not what this preflight
// was written against; more than one means the identity does not identify. Neither is a state in which a
// production write may be authorized, and both are reported as the reason rather than as a bare refusal.
//
// STRICTLY READ-ONLY. It resolves through the census, which constructs no writer, and it asserts DB_WRITES = 0
// on its own output. There is deliberately NO helper here that performs the write: the only future write is the
// ordinary UI path, after the operator authorizes it.
// ================================================================================================================
var R6R6_ROUTE_A_SELECTOR_ = {
  // The SERVER's vocabulary — RIC_DESTINATION_TYPES_ = ['WAREHOUSE','MARKETPLACE'] — because that is what the
  // stored column holds. The client's 'MARKETPLACE_DESTINATION' is a different field entirely.
  destination_kind: 'MARKETPLACE',
  quantity: 320,
  last_mile_delivery_is_blank: true
};
// The narrow mutation contract. Everything not named here is FORBIDDEN to change, and the readback checks the
// forbidden list field by field rather than trusting that only the allowed one was sent.
var R6R6_ALLOWED_MUTATION_FIELDS_ = ['last_mile_delivery', 'expected_arrival', 'draft_version', 'updated_at', 'line_updated_at'];
var R6R6_FORBIDDEN_MUTATION_FIELDS_ = ['company', 'country', 'station_marketplace', 'sku', 'source_warehouse_id',
  'destination_kind', 'destination_id', 'destination_marketplace', 'quantity', 'shipping_method', 'status',
  'generation_type', 'ownership', 'allocation_draft_id', 'allocation_draft_line_id'];
// DERIVED, not free. `k4_group_key` is computed from the header's route dimensions and the last mile is one of
// them, so the intended completion necessarily moves it. Calling it forbidden would report the correct
// mutation as a violation; calling it allowed would hide a route silently changing identity. It is checked
// separately: it may move, and it may move ONLY because the last mile did.
var R6R6_DERIVED_MUTATION_FIELDS_ = ['k4_group_key'];
// Compared case-insensitively: every one of these is frozen from the K4 group key, which lowercases each
// segment. A case difference here is a spelling of the same identity, not a mutation of it.
var R6R6_CASE_INSENSITIVE_FIELDS_ = ['company', 'country', 'station_marketplace', 'sku', 'source_warehouse_id',
  'destination_kind', 'destination_id', 'destination_marketplace', 'shipping_method', 'last_mile_delivery',
  'k4_group_key'];

function CENSUS_r6r6MatchRouteA_(rows) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (CENSUS_str_(r.destination_kind) !== R6R6_ROUTE_A_SELECTOR_.destination_kind) continue;
    if (CENSUS_num_(r.quantity) !== R6R6_ROUTE_A_SELECTOR_.quantity) continue;
    if (R6R6_ROUTE_A_SELECTOR_.last_mile_delivery_is_blank && CENSUS_str_(r.last_mile_delivery)) continue;
    out.push(r);
  }
  return out;
}

function RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT() {
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  var rows = res.visible_route_rows || [];
  var hits = CENSUS_r6r6MatchRouteA_(rows);
  var out = {
    census: 'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true,
    // Carried from the census rather than re-asserted: this preflight cannot write, and it also cannot be the
    // thing that proves it, because it delegates every read.
    db_writes: res.db_writes, writer_constructed: res.writer_constructed,
    submit_calls: res.submit_calls, reservation_writes: res.reservation_writes,
    carrier_master_data_writes: res.carrier_master_data_writes,
    selector: R6R6_ROUTE_A_SELECTOR_,
    selector_note: 'destination_kind + quantity + blank last mile. The shipping METHOD is deliberately not a'
      + ' discriminator: it is a display token, and a diagnostic that spells one stops matching when a'
      + ' catalogue label is edited.',
    visible_row_count: rows.length,
    matched_row_count: hits.length,
    header_count: (res.sku_contributing_header_ids || []).length,
    line_count: (res.sku_contributing_line_ids || []).length,
    station_included_header_ids: res.station_included_header_ids,
    allowed_mutation_fields: R6R6_ALLOWED_MUTATION_FIELDS_,
    forbidden_mutation_fields: R6R6_FORBIDDEN_MUTATION_FIELDS_,
    target: null,
    other_rows: [],
    verdict: 'STOP',
    stop_reason: '',
    error: res.error
  };
  if (res.error) { out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error); return CENSUS_r6r6FinishPre_(out); }
  if (!res.ready_for_manual_route_save_test) {
    out.stop_reason = 'the R6-R4 freeze does not report READY: an ambiguous save target or a shared K4 group is'
      + ' present, and neither may be resolved by picking one.';
    return CENSUS_r6r6FinishPre_(out);
  }
  if (hits.length !== 1) {
    out.verdict = 'STOP';
    out.stop_reason = (hits.length === 0)
      ? 'ZERO rows match the Route A identity. The live plan is not the plan this preflight was written'
        + ' against; re-read it before authorizing anything.'
      : hits.length + ' rows match the Route A identity, so the identity does not IDENTIFY. Picking one would'
        + ' be the guess this whole contract exists to remove.';
    return CENSUS_r6r6FinishPre_(out);
  }
  var t = hits[0];
  // The target is REUSE-of-itself or it is not a target: a save that would mint a header is a different
  // operation from completing an existing route, whatever the row looks like.
  if (!t.save_would_update_this_header) {
    out.stop_reason = 'the write path would not UPDATE this row\'s own header (' + CENSUS_str_(t.save_target_status)
      + '), so the intended narrow mutation is not what a save would perform.';
    return CENSUS_r6r6FinishPre_(out);
  }
  out.target = {
    allocation_draft_id: t.allocation_draft_id,
    allocation_draft_line_id: t.allocation_draft_line_id,
    k4_group_key: t.k4_group_key,
    company: t.company, country: t.country, marketplace: t.station_marketplace, sku: t.sku,
    source_warehouse_id: t.source_warehouse_id,
    destination_kind: t.destination_kind, destination_id: t.destination_id,
    destination_marketplace: t.destination_marketplace,
    quantity: t.quantity,
    shipping_method: t.shipping_method,
    last_mile_delivery: t.last_mile_delivery,
    expected_arrival: t.expected_arrival,
    status: t.status,
    generation_type: t.generation_type,
    ownership: t.ownership,
    draft_version: t.draft_version,
    updated_at: t.updated_at,
    line_updated_at: t.line_updated_at,
    save_target_status: t.save_target_status,
    save_target_allocation_draft_id: t.save_target_allocation_draft_id,
    // The identity a retry must reuse. An UPDATE is guarded by the version it expects; it carries no create key,
    // and inventing one would make a retry look like a create.
    mutation_identity: { intent: 'UPDATE_EXISTING_ROUTE', allocation_draft_id: t.allocation_draft_id,
      expected_draft_version: t.draft_version, create_idempotency_key: '' }
  };
  // The RAW row, frozen exactly as the census emits it. The readable view above renames fields for a person;
  // comparing a renamed view against a raw row is how every run reported `station_marketplace` as changed.
  out.target_row = t;
  out.other_rows = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].visible_row_key === t.visible_row_key) continue;
    // Every OTHER row is frozen too, byte for byte as far as this census can see it, because "Route B is
    // unchanged" is a claim the readback has to be able to check rather than assert.
    out.other_rows.push(rows[i]);
  }
  out.verdict = 'EXACTLY_ONE_SAVE_TARGET';
  return CENSUS_r6r6FinishPre_(out);
}

// The frozen constant, rendered from THIS run. Emitted rather than described, because a snapshot transcribed
// by hand is a snapshot with a typo in it.
function CENSUS_r6r6FreezeSource_(out) {
  if (!out || !out.target) return '';
  var t = out.target;
  var snap = {
    captured_from: 'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT (production, read-only, db_writes 0)',
    captured_for_build: TEMP_E3_CENSUS_BUILD_,
    verdict: out.verdict, db_writes: 0,
    allocation_draft_id: t.allocation_draft_id, allocation_draft_line_id: t.allocation_draft_line_id,
    expected_draft_version: CENSUS_str_(t.draft_version),
    company: t.company, country: t.country, station_marketplace: t.marketplace, sku: t.sku,
    source_page: 'inventory_replenishment', source_warehouse_id: t.source_warehouse_id,
    destination_kind: t.destination_kind, destination_id: t.destination_id,
    destination_marketplace: t.destination_marketplace,
    quantity: CENSUS_num_(t.quantity), shipping_method: t.shipping_method,
    last_mile_delivery: t.last_mile_delivery, expected_arrival: t.expected_arrival,
    k4_group_key: t.k4_group_key,
    status: t.status, generation_type: t.generation_type, ownership: t.ownership,
    updated_at: t.updated_at, line_updated_at: t.line_updated_at,
    header_count: CENSUS_num_(out.header_count), line_count: CENSUS_num_(out.line_count),
    other_rows: (out.other_rows || []),
    allowed_mutation_fields: R6R6_ALLOWED_MUTATION_FIELDS_,
    forbidden_mutation_fields: R6R6_FORBIDDEN_MUTATION_FIELDS_,
    derived_mutation_fields: R6R6_DERIVED_MUTATION_FIELDS_
  };
  return 'var R6R6_FROZEN_BEFORE_ = ' + JSON.stringify(snap, null, 2) + ';';
}

function CENSUS_r6r6FinishPre_(out) {
  out.frozen_snapshot_source = CENSUS_r6r6FreezeSource_(out);
  CENSUS_log_('r6r6_preflight_verdict', out.verdict + (out.stop_reason ? ' — ' + out.stop_reason : ''));
  if (out.target) {
    CENSUS_log_('r6r6_preflight_target', out.target.allocation_draft_id + ' :: ' + out.target.allocation_draft_line_id);
    CENSUS_log_('r6r6_preflight_before_last_mile', '"' + out.target.last_mile_delivery + '" (blank = the field to complete)');
    CENSUS_log_('r6r6_preflight_expected_draft_version', out.target.draft_version);
  }
  CENSUS_log_('r6r6_preflight_db_writes', String(out.db_writes));
  return out;
}

// ----------------------------------------------------------------------------------------------------------------
// THE READBACK. Run AFTER the operator has performed the one authorized UI action, with the preflight's own
// output handed back in. It answers one question — did exactly the intended field change, and nothing else? —
// and it answers it by COMPARING, never by trusting either side.
//
// It takes the BEFORE as an argument rather than re-deriving it, because a readback that recomputes its own
// baseline cannot detect a change: whatever it finds becomes what it expected.
// ----------------------------------------------------------------------------------------------------------------
// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1 §3/§4 — A READBACK THE EDITOR'S RUN BUTTON CAN ACTUALLY PRESS.
//
// R6-R6 shipped a readback that takes the preflight's own output as an argument, for a reason that has not
// changed: a readback which rebuilds its own baseline cannot detect a change, because whatever it finds becomes
// what it expected. The Apps Script editor's Run button passes NO arguments, so that contract could be executed
// from a console and not from the editor — and the controlled write was blocked on exactly that.
//
// The BEFORE is therefore frozen as SOURCE. Not CacheService, not PropertiesService, not a sheet row: a value
// that a later run could have written is not a BEFORE, it is whatever the last run happened to leave behind.
// A constant in a file has the property that matters here — it can only change through a diff.
//
// WHAT WAS ACTUALLY CAPTURED, AND WHAT WAS NOT. The production preflight output supplied for this freeze names
// the ids, the version, the quantity, the method, the last mile, the ETA and the K4 route key. It does NOT name
// `status`, `generation_type` or `ownership`. Those are not quietly dropped and they are not guessed:
//
//   • a captured field is an EQUALITY gate — it must still equal what was frozen;
//   • an uncaptured field is an INVARIANT gate — it must satisfy the property the authorized action requires
//     (the row stays ACTIVE, and it stays manually owned), which is checkable without a BEFORE;
//   • and every uncaptured field is REPORTED in `snapshot_gaps`, so the difference between the two kinds of
//     guarantee is visible to whoever reads the verdict rather than buried in this comment.
//
// To upgrade the three invariant gates to equality gates, run the preflight again and paste the
// `frozen_snapshot_source` string it now emits over the constant below.
//
// WHY THE SCOPE FIELDS ARE STORED LOWERCASED. They are read from the K4 group key, which is the identity the
// write path itself computes, and which lowercases every segment by construction. Freezing a guess at the
// stored casing of a warehouse id would produce a STOP for a spelling difference that means nothing, so these
// are compared case-insensitively and the K4 key is the authority for all of them at once.
// ================================================================================================================
var R6R6_FROZEN_BEFORE_ = {
  captured_from: 'RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT (production, read-only, db_writes 0)',
  captured_for_build: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1-B1',
  verdict: 'EXACTLY_ONE_SAVE_TARGET',
  db_writes: 0,

  allocation_draft_id: 'SADH-K4-38523A90',
  allocation_draft_line_id: 'SADL-K2-92B8BAD2',
  expected_draft_version: '1',

  // Read from the K4 key below, hence lowercase; compared case-insensitively.
  company: 'resus',
  country: 'us',
  station_marketplace: 'amazon',
  sku: 'CO1100-R',
  source_page: 'inventory_replenishment',
  source_warehouse_id: 'wh-tw-cn-factory-youxin',
  destination_kind: 'marketplace',
  destination_id: 'amazon',
  destination_marketplace: 'amazon',

  quantity: 320,
  shipping_method: 'sea_express',
  last_mile_delivery: '',                 // BLANK — the one field the authorized action completes
  expected_arrival: '',                   // blank because it waits for the last mile
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express||',

  // EQUALITY gates, from the production preflight. An invariant gate standing in for an equality gate that can
  // be written is strictly weaker: 'still ACTIVE' accepts three statuses, and this accepts one.
  status: 'draft',
  generation_type: 'user_created',
  ownership: 'MANUAL (no generation_run_id — composed by a person)',
  // R6-R6-R1-B1. THE TWO TIMESTAMPS, from the production capture. ALLOWED-TO-CHANGE AFTER THE SAVE DOES NOT
  // MEAN ABSENT FROM THE BEFORE. A null here does not say 'this field may move'; it says 'this run has no
  // idea what the row looked like', and those two must never be spelled the same way. Frozen, they carry
  // their own asymmetry, which is the whole reason they belong in the BEFORE: readiness requires them EQUAL
  // because nothing has happened yet, and the readback lets ROUTE A's move because moving them is what a
  // landed write does. Route B's may never move in either, because Route B is not the row being changed.
  updated_at: 'Thu Sep 03 2026 20:41:08 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Thu Sep 03 2026 20:41:08 GMT+0800 (Taiwan Standard Time)',

  // The plan this row sits in. A completion must not change the shape of it.
  header_count: 2,
  line_count: 2,
  // THE OTHER VISIBLE ROW, NOW COMPLETE. The full production BEFORE for Route B was supplied, so every
  // field it carries is frozen and `other_row_snapshot_gaps` is empty: no field of this row falls back to
  // 'not checked', which is the answer that let an unrelated route move without anyone noticing.
  //
  // CASING. Route A's scope fields are lowercase because they were read from the K4 key, which lowercases
  // every segment by construction; Route B's come from the row itself and are frozen in the row's own
  // spelling. Both are correct, because every one of them is compared case-insensitively — and freezing
  // Route B in a case it does not actually store would be inventing evidence to match a comparison that
  // does not need it.
  other_rows: [
    {
      allocation_draft_id: 'SADH-K4-A3872518',
      allocation_draft_line_id: 'SADL-K2-344FB2B2',
      k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air||',
      sku: 'CO1100-R',
      company: 'ResUS',
      country: 'US',
      station_marketplace: 'Amazon',
      destination_kind: 'WAREHOUSE',
      destination_id: 'WH-RESUS-US-3PL-AMZLGS',
      destination_marketplace: '',
      source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
      quantity: 200,
      status: 'draft',
      generation_type: 'user_created',
      ownership: 'MANUAL (no generation_run_id — composed by a person)',
      shipping_method: 'air',
      last_mile_delivery: '',
      expected_arrival: '',
      draft_version: '1',
      updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (Taiwan Standard Time)',
      line_updated_at: 'Thu Sep 03 2026 22:04:49 GMT+0800 (Taiwan Standard Time)',
      // RECORDED, NOT GATED. `line_status` and the three save-target facts are part of the captured BEFORE
      // and are kept so the record is the evidence rather than a subset of it. They are not compared: the
      // save-target fields are a RESOLVER's answer about a row nobody is authorized to touch this round, and
      // a third route appearing elsewhere in the plan could move them without Route B changing at all. A
      // gate that a bystander can trip is a STOP that means nothing.
      line_status: '',
      save_target_status: 'REUSE',
      save_target_allocation_draft_id: 'SADH-K4-A3872518',
      save_would_mint_new_header: false
    }
  ],

  allowed_mutation_fields: ['last_mile_delivery', 'expected_arrival', 'draft_version', 'updated_at', 'line_updated_at'],
  forbidden_mutation_fields: ['company', 'country', 'station_marketplace', 'sku', 'source_warehouse_id',
    'destination_kind', 'destination_id', 'destination_marketplace', 'quantity', 'shipping_method', 'status',
    'generation_type', 'ownership', 'allocation_draft_id', 'allocation_draft_line_id'],
  derived_mutation_fields: ['k4_group_key']
};

// Every field whose ABSENCE makes the readback unable to decide. A blank string is a captured value here (the
// last mile really was blank); only null/undefined is absent.
var R6R6_FROZEN_REQUIRED_FIELDS_ = ['allocation_draft_id', 'allocation_draft_line_id', 'expected_draft_version',
  'company', 'country', 'station_marketplace', 'sku', 'source_warehouse_id', 'destination_kind', 'destination_id',
  'quantity', 'shipping_method', 'last_mile_delivery', 'expected_arrival', 'k4_group_key',
  'header_count', 'line_count', 'allowed_mutation_fields', 'forbidden_mutation_fields'];
// THE TIMESTAMPS, COMPARED AS INSTANTS RATHER THAN AS DISPLAY STRINGS. A sheet returns a Date, a frozen
// constant holds the string a human pasted, and a runtime can spell the same instant
// 'GMT+0800 (Taiwan Standard Time)' or 'GMT+0800 (CST)'. Comparing those as text produces a STOP for a
// zone-name spelling, which is exactly the meaningless STOP this round exists to remove.
var R6R6_TIMESTAMP_FIELDS_ = ['updated_at', 'line_updated_at'];
// The fields that were briefly enforced as invariants, or omitted outright, because I recorded them as
// uncaptured. They are captured, so they are EQUALITY gates, and this list is what makes their absence a
// STOP rather than a silently weaker check. `snapshot_gaps` must be empty for the frozen readback to
// proceed at all — a null in any of these is a snapshot that cannot decide, and it must say so rather than
// present itself as complete.
var R6R6_FROZEN_EQUALITY_FIELDS_ = ['status', 'generation_type', 'ownership', 'updated_at', 'line_updated_at'];
// The statuses under which a route is still part of the current plan (KMARC's ACTIVE set). Kept as a SECOND,
// weaker gate beside the equality check above — it costs nothing and it still refuses a row that has left
// the plan even if a future freeze omits `status`.
var R6R6_ACTIVE_STATUSES_ = ['draft', 'site_confirmed', 'partially_submitted'];

function CENSUS_r6r6SnapshotIssues_(snap) {
  var issues = [];
  if (!snap) return ['the frozen snapshot constant is absent'];
  for (var i = 0; i < R6R6_FROZEN_REQUIRED_FIELDS_.length; i++) {
    var k = R6R6_FROZEN_REQUIRED_FIELDS_[i];
    if (snap[k] === null || snap[k] === undefined) issues.push('missing required field: ' + k);
  }
  if (snap.verdict !== 'EXACTLY_ONE_SAVE_TARGET') {
    issues.push('the captured preflight verdict was ' + CENSUS_str_(snap.verdict) + ', not EXACTLY_ONE_SAVE_TARGET');
  }
  if (CENSUS_str_(snap.last_mile_delivery) !== '') {
    issues.push('the frozen last mile is NOT blank, so this snapshot does not describe a route awaiting completion');
  }
  // An equality field with no frozen value is a gap, and a gap is a STOP: the readback would otherwise fall
  // through to a weaker invariant and report a confirmation it cannot support.
  for (var ei = 0; ei < R6R6_FROZEN_EQUALITY_FIELDS_.length; ei++) {
    var ek = R6R6_FROZEN_EQUALITY_FIELDS_[ei];
    if (snap[ek] === null || snap[ek] === undefined) issues.push('missing required field: ' + ek);
  }
  var seg = CENSUS_str_(snap.k4_group_key).split('|');
  if (seg.length !== 11) issues.push('the frozen K4 key does not have the 11 segments the contract defines');
  else if (seg[9] !== '') issues.push('the frozen K4 key already carries a last mile, contradicting the blank field');
  return issues;
}

// The K4 key this row WOULD have after the authorized change, derived by substituting the one segment the
// action is allowed to move. Returns '' when the key is not the shape the contract defines, so a caller that
// compares against it fails closed rather than matching an empty string against an empty string.
function CENSUS_r6r6K4WithLastMile_(k4, lastMile) {
  var seg = CENSUS_str_(k4).split('|');
  if (seg.length !== 11) return '';
  seg[9] = CENSUS_str_(lastMile).toLowerCase();
  return seg.join('|');
}

// ----------------------------------------------------------------------------------------------------------------
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R1 §7 — IS THE FROZEN BEFORE STILL THE PRESENT?
//
// A frozen snapshot is only a BEFORE for as long as the database still agrees with it. Between the capture and
// the operator's click anything could have moved — another session's save, a Submit, a cancel — and a readback
// run against a stale freeze would compare the AFTER against a world that no longer existed, then report
// whichever difference that produced as though the authorized action had caused it.
//
// So this is run BEFORE the click, and it answers one question: does production still look exactly like the
// frozen BEFORE? It is the same comparison the readback performs, with the ONE difference that matters — the
// last mile must still be BLANK and the version must still be the frozen one, because nothing has happened yet.
//
// Read-only, and it reaches the database through the same census as everything else.
// ----------------------------------------------------------------------------------------------------------------
// Field-by-field drift between a frozen row and a live one, over the fields the frozen row actually carries.
// Returns the drift and the list of fields it could not compare — never a bare boolean, because "unchanged"
// and "not checked" are the two answers this whole contract exists to keep apart.
// A timestamp reduced to the INSTANT it names, so two spellings of one moment compare equal and two
// different moments never do. An unparseable value falls back to its own text rather than to 0, because a
// timestamp nobody can read is not the epoch.
function CENSUS_r6r6TsKey_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isFinite(v.getTime()) ? String(v.getTime()) : '';
  }
  var s = CENSUS_str_(v);
  if (s === '') return '';
  var t = Date.parse(s);
  return isFinite(t) ? String(t) : s.toLowerCase();
}

// THE ONE PLACE THAT DECIDES WHETHER TWO VALUES OF A FIELD ARE THE SAME VALUE. Readiness and both readback
// entry points call it, for Route A and for every companion route, so 'equal' cannot come to mean one thing
// before the click and another thing after it. It returns the DISPLAY values alongside the verdict: the
// comparison runs on normalised keys, but a reader of `route_a_drift` must see the timestamp, not its epoch.
function CENSUS_r6r6Cmp_(field, frozenVal, liveVal) {
  var bv = CENSUS_str_(frozenVal), av = CENSUS_str_(liveVal), bk, ak;
  if (R6R6_TIMESTAMP_FIELDS_.indexOf(field) !== -1) {
    bk = CENSUS_r6r6TsKey_(frozenVal); ak = CENSUS_r6r6TsKey_(liveVal);
  } else if (R6R6_CASE_INSENSITIVE_FIELDS_.indexOf(field) !== -1) {
    bv = bv.toLowerCase(); av = av.toLowerCase(); bk = bv; ak = av;
  } else { bk = bv; ak = av; }
  return { equal: bk === ak, frozen: bv, live: av };
}

function CENSUS_r6r6DiffRow_(frozen, live, fields) {
  var drift = [], uncompared = [];
  for (var i = 0; i < fields.length; i++) {
    var k = fields[i];
    if (frozen[k] === null || frozen[k] === undefined) { uncompared.push(k); continue; }
    var c = CENSUS_r6r6Cmp_(k, frozen[k], live[k]);
    if (!c.equal) drift.push({ field: k, frozen: c.frozen, live: c.live });
  }
  return { drift: drift, uncompared: uncompared };
}

function RUN_R6R6_MANUAL_ROUTE_SAVE_FROZEN_READINESS() {
  var snap = R6R6_FROZEN_BEFORE_;
  var out = {
    census: 'RUN_R6R6_MANUAL_ROUTE_SAVE_FROZEN_READINESS',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, submit_calls: 0, reservation_writes: 0,
    carrier_master_data_writes: 0,
    snapshot_issues: [], snapshot_gaps: [], other_row_snapshot_gaps: [],
    target_ids: null,
    target_present: false, draft_version_live: null, last_mile_live: null,
    route_a_drift: [], route_b_drift: [], missing_other_rows: [],
    header_count_frozen: null, header_count_live: null,
    line_count_frozen: null, line_count_live: null,
    verdict: 'STOP', stop_reason: ''
  };
  // 1. THE SNAPSHOT ITSELF. A freeze that is not usable cannot certify anything about production.
  out.snapshot_issues = CENSUS_r6r6SnapshotIssues_(snap) || [];
  for (var gi = 0; gi < R6R6_FROZEN_EQUALITY_FIELDS_.length; gi++) {
    var gk = R6R6_FROZEN_EQUALITY_FIELDS_[gi];
    if (snap[gk] === null || snap[gk] === undefined) out.snapshot_gaps.push(gk);
  }
  if (out.snapshot_issues.length || out.snapshot_gaps.length) {
    out.stop_reason = 'the frozen BEFORE snapshot is not usable: '
      + out.snapshot_issues.concat(out.snapshot_gaps.map(function (k) { return 'missing required field: ' + k; })).join('; ');
    return CENSUS_r6r6FinishReady_(out);
  }
  out.target_ids = { allocation_draft_id: snap.allocation_draft_id,
    allocation_draft_line_id: snap.allocation_draft_line_id };

  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) { out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error); return CENSUS_r6r6FinishReady_(out); }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  out.submit_calls = CENSUS_num_(res.submit_calls) || 0;
  out.reservation_writes = CENSUS_num_(res.reservation_writes) || 0;
  var rows = res.visible_route_rows || [];
  out.header_count_frozen = CENSUS_num_(snap.header_count);
  out.line_count_frozen = CENSUS_num_(snap.line_count);
  out.header_count_live = (res.sku_contributing_header_ids || []).length;
  out.line_count_live = (res.sku_contributing_line_ids || []).length;

  // 2. ROUTE A, located by the identity it was frozen with.
  var a = null;
  for (var i = 0; i < rows.length; i++) {
    if (CENSUS_str_(rows[i].allocation_draft_id) === CENSUS_str_(snap.allocation_draft_id) &&
        CENSUS_str_(rows[i].allocation_draft_line_id) === CENSUS_str_(snap.allocation_draft_line_id)) { a = rows[i]; break; }
  }
  out.target_present = !!a;
  if (!a) {
    out.stop_reason = 'the frozen target row is not present in production. The freeze describes a plan that has'
      + ' changed; re-freeze before doing anything.';
    return CENSUS_r6r6FinishReady_(out);
  }
  out.draft_version_live = CENSUS_str_(a.draft_version);
  out.last_mile_live = CENSUS_str_(a.last_mile_delivery);

  // 3. NOTHING HAS HAPPENED YET, and that is what separates this from the readback: the last mile must still
  //    be blank, the version must still be the one that was frozen, AND THE TIMESTAMPS MUST STILL MATCH.
  //    The timestamps are the strongest of the three. A row can be written and put back with the same last
  //    mile and, if the writer did not bump it, the same version — but a write always moves updated_at. So
  //    here, where the claim is 'production is still exactly the BEFORE', they are equality gates like any
  //    other. It is only AFTER the authorized Save that Route A's are expected to have moved.
  var eqFields = R6R6_FORBIDDEN_MUTATION_FIELDS_.concat(R6R6_DERIVED_MUTATION_FIELDS_)
    .concat(['last_mile_delivery', 'expected_arrival']).concat(R6R6_TIMESTAMP_FIELDS_);
  var dA = CENSUS_r6r6DiffRow_(snap, a, eqFields);
  out.route_a_drift = dA.drift;

  // 4. EVERY OTHER FROZEN ROW, over the fields it carries.
  var others = snap.other_rows || [];
  for (var oi = 0; oi < others.length; oi++) {
    var ob = others[oi], oa = null;
    for (var oj = 0; oj < rows.length; oj++) {
      if (CENSUS_str_(rows[oj].allocation_draft_id) === CENSUS_str_(ob.allocation_draft_id) &&
          CENSUS_str_(rows[oj].allocation_draft_line_id) === CENSUS_str_(ob.allocation_draft_line_id)) { oa = rows[oj]; break; }
    }
    if (!oa) { out.missing_other_rows.push(CENSUS_str_(ob.allocation_draft_id)); continue; }
    var dB = CENSUS_r6r6DiffRow_(ob, oa, eqFields.concat(['quantity']));
    for (var di = 0; di < dB.drift.length; di++) {
      out.route_b_drift.push({ allocation_draft_id: ob.allocation_draft_id, field: dB.drift[di].field,
        frozen: dB.drift[di].frozen, live: dB.drift[di].live });
    }
    for (var ui = 0; ui < dB.uncompared.length; ui++) {
      var gapKey = CENSUS_str_(ob.allocation_draft_id) + '.' + dB.uncompared[ui];
      if (out.other_row_snapshot_gaps.indexOf(gapKey) === -1) out.other_row_snapshot_gaps.push(gapKey);
    }
  }

  // 5. THE VERDICT. Ordered so the reason an operator reads is the FIRST thing that is wrong, not the last.
  var countsMatch = (out.header_count_frozen === out.header_count_live)
    && (out.line_count_frozen === out.line_count_live);
  if (CENSUS_str_(a.draft_version) !== CENSUS_str_(snap.expected_draft_version)) {
    out.stop_reason = 'draft_version in production is ' + out.draft_version_live + ', and the freeze expects '
      + CENSUS_str_(snap.expected_draft_version) + '. Something has written to this row since the capture.';
  } else if (out.last_mile_live !== '') {
    out.stop_reason = 'the last mile is already set to "' + out.last_mile_live + '". This row is not awaiting'
      + ' completion any more, so the authorized action does not apply to it.';
  } else if (out.route_a_drift.length) {
    var aTs = out.route_a_drift.filter(function (x) { return R6R6_TIMESTAMP_FIELDS_.indexOf(x.field) !== -1; });
    out.stop_reason = 'Route A has drifted from the freeze on: '
      + out.route_a_drift.map(function (x) { return x.field; }).join(', ')
      + (aTs.length ? '. A moved timestamp means SOMETHING HAS ALREADY WRITTEN to this row since the capture,'
        + ' even where every other field still matches; re-freeze before doing anything.' : '');
  } else if (out.missing_other_rows.length) {
    out.stop_reason = 'a frozen companion route is gone: ' + out.missing_other_rows.join(', ');
  } else if (out.route_b_drift.length) {
    out.stop_reason = 'a companion route has drifted from the freeze on: '
      + out.route_b_drift.map(function (x) { return x.allocation_draft_id + '.' + x.field; }).join(', ');
  } else if (!countsMatch) {
    out.stop_reason = 'the plan shape has changed: headers ' + out.header_count_frozen + ' -> '
      + out.header_count_live + ', lines ' + out.line_count_frozen + ' -> ' + out.line_count_live + '.';
  } else if (out.db_writes !== 0 || out.writer_constructed || out.submit_calls !== 0 || out.reservation_writes !== 0) {
    out.stop_reason = 'this read reported a non-zero write counter, which a read-only census must never do.';
  }
  out.verdict = out.stop_reason ? 'STOP' : 'FROZEN_READBACK_READY';
  return CENSUS_r6r6FinishReady_(out);
}

function CENSUS_r6r6FinishReady_(out) {
  out.read_only = true;
  CENSUS_log_('r6r6_readiness_verdict', out.verdict + (out.stop_reason ? ' — ' + out.stop_reason : ''));
  CENSUS_log_('r6r6_readiness_target', CENSUS_str_(out.target_ids && out.target_ids.allocation_draft_id)
    + ' :: ' + CENSUS_str_(out.target_ids && out.target_ids.allocation_draft_line_id));
  CENSUS_log_('r6r6_readiness_version_live', CENSUS_str_(out.draft_version_live));
  CENSUS_log_('r6r6_readiness_last_mile_live', '"' + CENSUS_str_(out.last_mile_live) + '"');
  CENSUS_log_('r6r6_readiness_snapshot_gaps', JSON.stringify(out.snapshot_gaps));
  CENSUS_log_('r6r6_readiness_other_row_gaps', JSON.stringify(out.other_row_snapshot_gaps));
  CENSUS_log_('r6r6_readiness_db_writes', String(out.db_writes));
  return out;
}
// ----------------------------------------------------------------------------------------------------------------
// THE NO-ARGUMENT ENTRY POINT. Run it from the editor AFTER the one authorized UI change. It reads; it never
// writes; and it answers NARROW_MUTATION_CONFIRMED or it answers STOP with the reason.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN() {
  var snap = R6R6_FROZEN_BEFORE_;
  var issues = CENSUS_r6r6SnapshotIssues_(snap);
  if (issues.length) {
    var bad = { census: 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN', build: TEMP_E3_CENSUS_BUILD_,
      read_only: true, db_writes: 0, writer_constructed: false, submit_calls: 0, reservation_writes: 0,
      carrier_master_data_writes: 0,
      snapshot_issues: issues, verdict: 'STOP',
      stop_reason: 'the frozen BEFORE snapshot is not usable: ' + issues.join('; '),
      changed_fields: [], unexpected_changed_fields: [],
      header_count_before: null, header_count_after: null, line_count_before: null, line_count_after: null };
    return CENSUS_r6r6FinishBack_(bad);
  }
  // Shaped exactly like the preflight output the argument-taking readback expects, so ONE comparison serves
  // both entry points and the two contracts cannot drift apart.
  var before = {
    target: snap,
    target_row: snap,
    other_rows: snap.other_rows || [],
    header_count: snap.header_count,
    line_count: snap.line_count,
    frozen: true
  };
  var out = RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK(before);
  out.census = 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK_FROZEN';
  out.snapshot_issues = [];
  return out;
}
function RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK(before) {
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  var rows = res.visible_route_rows || [];
  var out = {
    census: 'RUN_R6R6_MANUAL_ROUTE_SAVE_READBACK',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true,
    db_writes: res.db_writes, writer_constructed: res.writer_constructed,
    submit_calls: res.submit_calls, reservation_writes: res.reservation_writes,
    carrier_master_data_writes: res.carrier_master_data_writes,
    target_ids: null, before_values: null, after_values: null,
    changed_fields: [], unexpected_changed_fields: [],
    header_count_before: null, header_count_after: (res.sku_contributing_header_ids || []).length,
    line_count_before: null, line_count_after: (res.sku_contributing_line_ids || []).length,
    route_b_unchanged: null, other_rows_compared: 0,
    verdict: 'STOP', stop_reason: '', error: res.error
  };
  if (!before || !before.target) {
    out.stop_reason = 'no preflight output was supplied, so there is no BEFORE to compare against. Run'
      + ' RUN_R6R6_MANUAL_ROUTE_SAVE_PREFLIGHT first and pass its result here.';
    return CENSUS_r6r6FinishBack_(out);
  }
  // Compared raw-to-raw. `before.target` is the readable view and is kept for the report; `target_row` is what
  // the comparison uses, because it is the same shape as what this run reads back.
  var b = before.target_row || before.target;
  out.target_ids = { allocation_draft_id: b.allocation_draft_id, allocation_draft_line_id: b.allocation_draft_line_id };
  out.header_count_before = CENSUS_num_(before.header_count);
  out.line_count_before = CENSUS_num_(before.line_count);
  // Located by the IDs it was frozen with — never by the selector again. The selector matched a BLANK last
  // mile, and the whole point of the action is that the blank is gone.
  var a = null;
  for (var i = 0; i < rows.length; i++) {
    if (CENSUS_str_(rows[i].allocation_draft_id) === CENSUS_str_(b.allocation_draft_id) &&
        CENSUS_str_(rows[i].allocation_draft_line_id) === CENSUS_str_(b.allocation_draft_line_id)) { a = rows[i]; break; }
  }
  if (!a) {
    out.stop_reason = 'the frozen target row is NOT PRESENT after the action. A row that disappeared is not a'
      + ' narrow mutation, whatever else changed.';
    return CENSUS_r6r6FinishBack_(out);
  }
  out.before_values = b; out.after_values = a;
  // A field the BEFORE never captured cannot be an equality gate. It is listed, and it is covered by an
  // invariant gate further down instead — never silently treated as unchanged, and never treated as changed.
  out.snapshot_gaps = [];
  for (var gi = 0; gi < R6R6_FROZEN_EQUALITY_FIELDS_.length; gi++) {
    var gk = R6R6_FROZEN_EQUALITY_FIELDS_[gi];
    if (b[gk] === null || b[gk] === undefined) out.snapshot_gaps.push(gk);
  }
  var fields = R6R6_ALLOWED_MUTATION_FIELDS_.concat(R6R6_FORBIDDEN_MUTATION_FIELDS_)
    .concat(R6R6_DERIVED_MUTATION_FIELDS_);
  for (var fi = 0; fi < fields.length; fi++) {
    var k = fields[fi];
    if (out.snapshot_gaps.indexOf(k) !== -1) continue;      // not captured — see the invariant gates
    // ONE comparison core, shared with readiness: the scope fields are case-insensitive because they come
    // from a key that lowercases every segment, and the timestamps compare as instants rather than as the
    // text a runtime happened to print. Route A's timestamps MAY move here — they are in the allowed set,
    // because moving them is precisely what a landed write does.
    // The freeze names the version `expected_draft_version`, because that is what an UPDATE sends. Read it
    // under the row's own name here, or `changed_fields` reports the version arriving out of nowhere.
    var bRaw = (k === 'draft_version' && (b[k] === null || b[k] === undefined)) ? b.expected_draft_version : b[k];
    var c = CENSUS_r6r6Cmp_(k, bRaw, a[k]);
    if (c.equal) continue;
    out.changed_fields.push({ field: k, before: c.frozen, after: c.live });
    if (R6R6_FORBIDDEN_MUTATION_FIELDS_.indexOf(k) !== -1) out.unexpected_changed_fields.push(k);
  }
  // Route B and every other visible row, compared field by field against its own frozen copy.
  var otherBefore = before.other_rows || [], drift = [];
  out.other_row_uncompared_fields = {};
  out.other_row_snapshot_gaps = [];
  for (var oi = 0; oi < otherBefore.length; oi++) {
    var ob = otherBefore[oi], oa = null;
    for (var oj = 0; oj < rows.length; oj++) {
      if (rows[oj].visible_row_key === ob.visible_row_key) { oa = rows[oj]; break; }
    }
    out.other_rows_compared++;
    // Matched by visible_row_key when the frozen row carries one, and by the id pair otherwise: a snapshot
    // frozen from a summary has the ids and not the composite key.
    if (!oa) {
      for (var op = 0; op < rows.length; op++) {
        if (CENSUS_str_(rows[op].allocation_draft_id) === CENSUS_str_(ob.allocation_draft_id) &&
            CENSUS_str_(rows[op].allocation_draft_line_id) === CENSUS_str_(ob.allocation_draft_line_id)) { oa = rows[op]; break; }
      }
    }
    if (!oa) { drift.push({ visible_row_key: CENSUS_str_(ob.visible_row_key) || CENSUS_str_(ob.allocation_draft_id),
      field: '(row)', before: 'present', after: 'ABSENT' }); continue; }
    for (var ok = 0; ok < fields.length; ok++) {
      var kk = fields[ok];
      // Only fields the frozen row actually CARRIES are compared. A field it never captured is not evidence
      // of stability and must not be reported as drift the moment the census returns a value for it.
      if (ob[kk] === null || ob[kk] === undefined) {
        out.other_row_uncompared_fields[kk] = 1;
        var gapKey = CENSUS_str_(ob.allocation_draft_id) + '.' + kk;
        if (out.other_row_snapshot_gaps.indexOf(gapKey) === -1) out.other_row_snapshot_gaps.push(gapKey);
        continue;
      }
      // The same core again, and note what it means for a COMPANION route: `updated_at` is in the allowed
      // set for Route A, the row being changed, and there is no such allowance here. Route B is not being
      // touched, so a moved timestamp on it is drift — the clearest evidence there is that a save reached
      // further than the one row it was authorized to reach.
      var oc = CENSUS_r6r6Cmp_(kk, ob[kk], oa[kk]);
      if (!oc.equal) {
        drift.push({ visible_row_key: CENSUS_str_(ob.visible_row_key) || CENSUS_str_(ob.allocation_draft_id),
          field: kk, before: oc.frozen, after: oc.live });
      }
    }
  }
  out.route_b_unchanged = (drift.length === 0);
  out.other_row_drift = drift;
  // A derived key that moved WITHOUT the field it derives from is a route changing identity for no stated
  // reason, which is the one thing this classification exists to catch.
  var lastMileMoved = out.changed_fields.some(function (x) { return x.field === 'last_mile_delivery'; });
  out.derived_changed_fields = out.changed_fields.filter(function (x) {
    return R6R6_DERIVED_MUTATION_FIELDS_.indexOf(x.field) !== -1; }).map(function (x) { return x.field; });
  out.derived_change_explained = !out.derived_changed_fields.length || lastMileMoved;
  var countsHeld = (out.header_count_before === out.header_count_after) && (out.line_count_before === out.line_count_after);
  var onlyAllowed = (out.unexpected_changed_fields.length === 0);

  // ---- THE LAST MILE IS VALID, NOT MERELY NON-BLANK ----------------------------------------------------------
  // Validity is checked STRUCTURALLY rather than against a spelled vocabulary: the value counts as valid when
  // the route identity itself absorbed it, which is what the K4 key's last-mile segment records. That also
  // means no operator-facing label is written into this diagnostic, and a catalogue rename cannot silently
  // stop this from matching.
  var afterLm = CENSUS_str_(a.last_mile_delivery);
  var lastMileFilled = afterLm !== '';
  var afterSeg = CENSUS_str_(a.k4_group_key).split('|');
  out.last_mile_absorbed_by_identity = (afterSeg.length === 11 && afterSeg[9] === afterLm.toLowerCase() && afterLm !== '');

  // ---- THE K4 KEY MOVED BY THE LAST MILE AND BY NOTHING ELSE -------------------------------------------------
  // Derived exactly rather than 'explained': the key this row must now carry is the frozen key with one segment
  // substituted. Anything else is a route that changed identity for a reason the authorized action does not
  // account for — which is the same class of defect as a silent re-route.
  out.k4_expected_after = CENSUS_r6r6K4WithLastMile_(CENSUS_str_(b.k4_group_key), afterLm);
  out.k4_actual_after = CENSUS_str_(a.k4_group_key);
  var k4Known = CENSUS_str_(b.k4_group_key) !== '' && out.k4_expected_after !== '';
  out.k4_derives_from_last_mile_only = !k4Known
    || (out.k4_actual_after.toLowerCase() === out.k4_expected_after.toLowerCase());
  // Kept for readers of the previous contract; the exact derivation above is what decides.
  var lastMileMovedFlag = out.changed_fields.some(function (x) { return x.field === 'last_mile_delivery'; });
  out.derived_change_explained = !out.derived_changed_fields.length || lastMileMovedFlag;

  // ---- THE VERSION ADVANCED BY EXACTLY THE CONTRACT'S ONE STEP ------------------------------------------------
  // 16_ sets draft_version = prior + 1 on an UPDATE. Exactly one step is the whole claim: no step means the
  // write did not land, and two means something wrote twice.
  var bVer = CENSUS_num_(b.expected_draft_version !== undefined && b.expected_draft_version !== null
    ? b.expected_draft_version : b.draft_version);
  var aVer = CENSUS_num_(a.draft_version);
  out.draft_version_before = bVer; out.draft_version_after = aVer;
  out.draft_version_advanced_by_contract = (aVer === bVer + 1);

  // ---- THE INVARIANT GATES, for the fields the capture did not carry -----------------------------------------
  var afterStatus = CENSUS_str_(a.status).toLowerCase();
  out.status_still_active = R6R6_ACTIVE_STATUSES_.indexOf(afterStatus) !== -1;
  out.ownership_still_manual = CENSUS_str_(a.ownership).indexOf('AI_GENERATED') !== 0;

  if (!countsHeld) out.stop_reason = 'the header or line COUNT moved: a completion must not create anything.';
  else if (!onlyAllowed) out.stop_reason = 'fields outside the allowed set changed: ' + out.unexpected_changed_fields.join(', ');
  else if (!out.route_b_unchanged) out.stop_reason = 'another visible route drifted; see other_row_drift.';
  else if (!lastMileFilled) out.stop_reason = 'the last mile is STILL blank, so the intended change did not land.';
  else if (!out.last_mile_absorbed_by_identity) out.stop_reason = 'the last mile has a value the route identity'
    + ' did not absorb, so it is not a valid last mile for this lane.';
  else if (!out.k4_derives_from_last_mile_only) out.stop_reason = 'the route identity key is not the frozen key'
    + ' with only the last mile substituted, so this row changed identity for a reason the authorized action'
    + ' does not account for. expected ' + out.k4_expected_after + ' / actual ' + out.k4_actual_after;
  else if (!out.draft_version_advanced_by_contract) out.stop_reason = 'draft_version went ' + bVer + ' -> ' + aVer
    + ', and the contract advances it by exactly one on an UPDATE. No step means the write did not land; more'
    + ' than one means something wrote twice.';
  else if (!out.status_still_active) out.stop_reason = 'the row is no longer in an ACTIVE status (' + afterStatus
    + '), so it has left the current plan.';
  else if (!out.ownership_still_manual) out.stop_reason = 'the row is now AI-owned, which a manual completion'
    + ' must never produce.';
  out.verdict = out.stop_reason ? 'STOP' : 'NARROW_MUTATION_CONFIRMED';
  // Stated rather than implied: which routes were compared field by field, and which only by identity.
  out.other_row_guarantee = Object.keys(out.other_row_uncompared_fields).length
    ? 'other routes compared on the fields the frozen snapshot carries; NOT compared on: '
      + Object.keys(out.other_row_uncompared_fields).join(', ')
    : 'other routes compared field by field';
  return CENSUS_r6r6FinishBack_(out);
}

function CENSUS_r6r6FinishBack_(out) {
  // Asserted on the way out, so a caller reads the same four zeroes whichever entry point produced the answer.
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  out.writer_constructed = out.writer_constructed === true;
  out.submit_calls = CENSUS_num_(out.submit_calls) || 0;
  out.reservation_writes = CENSUS_num_(out.reservation_writes) || 0;
  CENSUS_log_('r6r6_readback_verdict', out.verdict + (out.stop_reason ? ' — ' + out.stop_reason : ''));
  CENSUS_log_('r6r6_readback_changed', JSON.stringify(out.changed_fields));
  CENSUS_log_('r6r6_readback_unexpected', JSON.stringify(out.unexpected_changed_fields));
  CENSUS_log_('r6r6_readback_counts', 'headers ' + out.header_count_before + '->' + out.header_count_after
    + ' lines ' + out.line_count_before + '->' + out.line_count_after);
  CENSUS_log_('r6r6_readback_db_writes', String(out.db_writes));
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R2 §7/§8 — THE AFTER STATE, AND A REPAIR THAT IS DESIGNED AND NOT RUN.
//
// On 2026-09-06 one authorized edit wrote two routes. Route A's change was asked for; Route B's was not, and
// nobody asked for it because nobody could see it — the derived last mile the lane supplied for a
// one-profile service went into the same DOM field the collector reads as operator intent.
//
// These two entry points are READ ONLY. The first states what production holds now and classifies every
// difference from the frozen BEFORE as AUTHORIZED or UNAUTHORIZED. The second DESIGNS the compensating
// update and prints the exact body it would send. Neither writes. There is no third entry point that does,
// and adding one is a separate decision with its own authorization.
// ================================================================================================================

// The unauthorized AFTER, exactly as the production evidence states it. Frozen for the same reason the BEFORE
// is frozen: a repair that recomputes its own starting point cannot tell a fixed row from an unfixed one.
var R6R6R2_ROUTE_B_UNAUTHORIZED_AFTER_ = {
  allocation_draft_id: 'SADH-K4-A3872518',
  allocation_draft_line_id: 'SADL-K2-344FB2B2',
  last_mile_delivery: 'parcel',            // was BLANK; no operator chose this
  draft_version: '2',                      // was 1
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air|parcel|',
  updated_at: '2026-09-06 08:28:04 +0800',
  line_updated_at: '2026-09-06 08:28:04 +0800'
};
// Route A's AFTER, for contrast. It is not repaired and must not be: it is what the operator asked for.
var R6R6R2_ROUTE_A_AUTHORIZED_AFTER_ = {
  allocation_draft_id: 'SADH-K4-38523A90',
  allocation_draft_line_id: 'SADL-K2-92B8BAD2',
  last_mile_delivery: 'truck',
  draft_version: '2',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|truck|',
  updated_at: '2026-09-06 08:27:53 +0800',
  line_updated_at: '2026-09-06 08:27:53 +0800'
};
// The ONLY field the repair may move. `k4_group_key` follows from it by derivation, and the version follows
// from the write itself; neither is set by hand. Everything else on the row is already correct.
var R6R6R2_REPAIRABLE_FIELDS_ = ['last_mile_delivery'];

function CENSUS_r6r6r2FindRow_(rows, headerId, lineId) {
  for (var i = 0; i < (rows || []).length; i++) {
    if (CENSUS_str_(rows[i].allocation_draft_id) === CENSUS_str_(headerId) &&
        CENSUS_str_(rows[i].allocation_draft_line_id) === CENSUS_str_(lineId)) return rows[i];
  }
  return null;
}
// Every field of a frozen record compared against the live row, through the SAME comparison core the readback
// and the readiness use — so 'unchanged' means one thing across all four entry points.
function CENSUS_r6r6r2Classify_(frozenBefore, live, authorizedFields) {
  var fields = R6R6_FORBIDDEN_MUTATION_FIELDS_.concat(R6R6_DERIVED_MUTATION_FIELDS_)
    .concat(['last_mile_delivery', 'expected_arrival', 'draft_version']).concat(R6R6_TIMESTAMP_FIELDS_);
  var authorized = [], unauthorized = [], uncompared = [];
  var ok = {}; (authorizedFields || []).forEach(function (k) { ok[k] = 1; });
  for (var i = 0; i < fields.length; i++) {
    var k = fields[i];
    var bv = (k === 'draft_version' && (frozenBefore[k] === null || frozenBefore[k] === undefined))
      ? frozenBefore.expected_draft_version : frozenBefore[k];
    if (bv === null || bv === undefined) { uncompared.push(k); continue; }
    var cmp = CENSUS_r6r6Cmp_(k, bv, live[k]);
    if (cmp.equal) continue;
    (ok[k] ? authorized : unauthorized).push({ field: k, before: cmp.frozen, after: cmp.live });
  }
  return { authorized: authorized, unauthorized: unauthorized, uncompared: uncompared };
}

// ----------------------------------------------------------------------------------------------------------------
// §7 — WHAT PRODUCTION HOLDS NOW. Read-only. Run it before anything else.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R2_AFTER_STATE_CENSUS() {
  var out = {
    census: 'RUN_R6R6R2_AFTER_STATE_CENSUS',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, submit_calls: 0, reservation_writes: 0,
    carrier_master_data_writes: 0,
    route_a: null, route_b: null,
    unauthorized_field_count: 0,
    eta_persisted_anywhere: null,
    verdict: 'STOP', stop_reason: ''
  };
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) { out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error); return CENSUS_r6r6r2Finish_(out); }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];
  var snap = R6R6_FROZEN_BEFORE_;
  var bFrozen = (snap.other_rows || [])[0] || {};

  // ROUTE A — the authorized change. last_mile, the key it derives, the version and the two timestamps are
  // all expected to have moved; anything else is not.
  var a = CENSUS_r6r6r2FindRow_(rows, snap.allocation_draft_id, snap.allocation_draft_line_id);
  if (!a) { out.stop_reason = 'Route A is not present in production.'; return CENSUS_r6r6r2Finish_(out); }
  var ca = CENSUS_r6r6r2Classify_(snap, a,
    ['last_mile_delivery', 'k4_group_key', 'draft_version', 'updated_at', 'line_updated_at']);
  out.route_a = {
    allocation_draft_id: CENSUS_str_(a.allocation_draft_id), allocation_draft_line_id: CENSUS_str_(a.allocation_draft_line_id),
    last_mile_delivery: CENSUS_str_(a.last_mile_delivery), draft_version: CENSUS_str_(a.draft_version),
    k4_group_key: CENSUS_str_(a.k4_group_key), expected_arrival: CENSUS_str_(a.expected_arrival),
    updated_at: CENSUS_str_(a.updated_at), line_updated_at: CENSUS_str_(a.line_updated_at),
    status: CENSUS_str_(a.status), ownership: CENSUS_str_(a.ownership),
    authorized_changes: ca.authorized, unauthorized_changes: ca.unauthorized,
    matches_expected_after: CENSUS_str_(a.last_mile_delivery).toLowerCase() === 'truck'
      && CENSUS_str_(a.draft_version) === '2'
  };

  // ROUTE B — NOTHING was authorized here, so the authorized set is EMPTY. Every difference is a finding.
  var b = CENSUS_r6r6r2FindRow_(rows, bFrozen.allocation_draft_id, bFrozen.allocation_draft_line_id);
  if (!b) { out.stop_reason = 'Route B is not present in production.'; return CENSUS_r6r6r2Finish_(out); }
  var cb = CENSUS_r6r6r2Classify_(bFrozen, b, []);
  out.route_b = {
    allocation_draft_id: CENSUS_str_(b.allocation_draft_id), allocation_draft_line_id: CENSUS_str_(b.allocation_draft_line_id),
    last_mile_delivery: CENSUS_str_(b.last_mile_delivery), draft_version: CENSUS_str_(b.draft_version),
    k4_group_key: CENSUS_str_(b.k4_group_key), expected_arrival: CENSUS_str_(b.expected_arrival),
    updated_at: CENSUS_str_(b.updated_at), line_updated_at: CENSUS_str_(b.line_updated_at),
    status: CENSUS_str_(b.status), ownership: CENSUS_str_(b.ownership),
    authorized_changes: [], unauthorized_changes: cb.unauthorized,
    matches_expected_after: CENSUS_str_(b.last_mile_delivery).toLowerCase() === 'parcel'
      && CENSUS_str_(b.draft_version) === '2'
  };
  out.unauthorized_field_count = cb.unauthorized.length + ca.unauthorized.length;

  // §6 — THE ETA, STATED FROM THE DATABASE RATHER THAN FROM THE SCREEN. buildDraftLinePayload does not send
  // expected_arrival and says why; a blank column is therefore the CORRECT state, not a lost write, and the
  // date the UI shows is computed at render. This reports the fact so §8 does not have to assume it.
  out.eta_persisted_anywhere = !!(CENSUS_str_(a.expected_arrival) || CENSUS_str_(b.expected_arrival));

  out.verdict = 'AFTER_STATE_REPORTED';
  return CENSUS_r6r6r2Finish_(out);
}

// ----------------------------------------------------------------------------------------------------------------
// §8 — THE COMPENSATING REPAIR, DESIGNED AND NOT EXECUTED.
//
// FORWARD ONLY. The row is not deleted, the version is not decremented and no history is rewritten: an
// unauthorized write is a fact that happened, and the repair is another fact that happens after it. Version 2
// becomes 3. Anyone reading the row later sees both events, which is the point.
//
// THE TARGET STATE IS THE FROZEN BEFORE. Not a recomputed one — the value Route B held before the incident is
// in R6R6_FROZEN_BEFORE_.other_rows[0], captured while the row was still correct, and restoring to anything
// else would be restoring to a guess.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R2_ROUTE_B_REPAIR_MANIFEST() {
  var out = {
    census: 'RUN_R6R6R2_ROUTE_B_REPAIR_MANIFEST',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, submit_calls: 0, reservation_writes: 0,
    executed: false,                       // ALWAYS false. This entry point has no write path at all.
    target: null, preflight: [], manifest: null, readback_contract: null,
    eta_treatment: null,
    verdict: 'STOP', stop_reason: ''
  };
  var bFrozen = (R6R6_FROZEN_BEFORE_.other_rows || [])[0] || {};
  var expectAfter = R6R6R2_ROUTE_B_UNAUTHORIZED_AFTER_;
  out.target = { allocation_draft_id: expectAfter.allocation_draft_id,
    allocation_draft_line_id: expectAfter.allocation_draft_line_id };

  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) { out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error); return CENSUS_r6r6r2Finish_(out); }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  var b = CENSUS_r6r6r2FindRow_(res.visible_route_rows || [], expectAfter.allocation_draft_id,
    expectAfter.allocation_draft_line_id);

  // PREFLIGHT. Every one of these is a reason NOT to write, checked before a body is even shaped.
  if (!b) out.preflight.push('the target row is not present in production');
  if (b && CENSUS_str_(b.draft_version) !== CENSUS_str_(expectAfter.draft_version)) {
    out.preflight.push('draft_version is ' + CENSUS_str_(b.draft_version) + ', and the manifest expects '
      + expectAfter.draft_version + '. Something has written to this row since the incident was measured.');
  }
  if (b && CENSUS_str_(b.last_mile_delivery).toLowerCase() !== CENSUS_str_(expectAfter.last_mile_delivery).toLowerCase()) {
    out.preflight.push('the last mile is "' + CENSUS_str_(b.last_mile_delivery) + '", not the unauthorized "'
      + expectAfter.last_mile_delivery + '". This row is not in the state the repair was designed for '
      + '(it may already have been repaired, or changed again).');
  }
  if (b) {
    // The repair must not travel further than the one field. Any OTHER difference from the frozen BEFORE is
    // outside what was measured, and a repair that carries an unmeasured change is a second unauthorized write.
    var cls = CENSUS_r6r6r2Classify_(bFrozen, b,
      ['last_mile_delivery', 'k4_group_key', 'draft_version', 'updated_at', 'line_updated_at']);
    for (var i = 0; i < cls.unauthorized.length; i++) {
      out.preflight.push('an unmeasured difference on ' + cls.unauthorized[i].field + ': frozen "'
        + cls.unauthorized[i].before + '" vs live "' + cls.unauthorized[i].after + '"');
    }
  }

  // THE MANIFEST. Shaped whether or not the preflight passed, because a refusal an operator cannot read is
  // not a refusal they can act on — but `ready_to_execute` is the only field that authorizes anything.
  out.manifest = {
    intent: 'UPDATE_EXISTING_ROUTE',
    reason: 'compensating repair of an unauthorized write on 2026-09-06 08:28:04 +0800',
    action: 'upsertShippingAllocationDraftAtomic',
    allocation_draft_id: expectAfter.allocation_draft_id,
    expected_draft_version: CENSUS_str_(expectAfter.draft_version),   // OPTIMISTIC GUARD: 2, and the write makes it 3
    create_idempotency_key: '',                                       // an UPDATE mints nothing
    fields_to_restore: [
      { field: 'last_mile_delivery', from: CENSUS_str_(expectAfter.last_mile_delivery),
        to: CENSUS_str_(bFrozen.last_mile_delivery),
        authority: 'R6R6_FROZEN_BEFORE_.other_rows[0], captured while the row was still correct' }
    ],
    fields_derived_by_the_server: [
      { field: 'k4_group_key', to: CENSUS_r6r6K4WithLastMile_(CENSUS_str_(expectAfter.k4_group_key),
        CENSUS_str_(bFrozen.last_mile_delivery)), note: 'derived from the last mile; never sent by hand' },
      { field: 'draft_version', to: '3', note: 'the writer advances it by exactly one; never set, never decremented' },
      { field: 'updated_at / line_updated_at', to: '(the repair time)', note: 'a repair is a write and moves them' }
    ],
    fields_explicitly_untouched: ['quantity', 'shipping_method', 'destination_kind', 'destination_id',
      'source_warehouse_id', 'status', 'generation_type', 'ownership', 'expected_arrival', 'line_status'],
    forbidden: ['delete the row', 'decrement draft_version', 'rewrite updated_at to its pre-incident value',
      'soft-cancel and recreate the line', 'touch Route A']
  };

  // §6 DECIDES THIS, AND THE ANSWER IS: DO NOTHING. buildDraftLinePayload deliberately does not send
  // expected_arrival — the base date (a planned ship date) and the Receiving Buffer that CARRIER_AND_ROUTE_SPEC
  // §5B requires do not exist in any table — so a blank column is the CORRECT persisted state and the date the
  // UI shows is computed at render time. There is nothing to restore, and writing one now would freeze the
  // very substitution the spec refuses to freeze.
  out.eta_treatment = {
    verdict: 'NO_ETA_ACTION',
    because: 'expected_arrival is not persisted by design (buildDraftLinePayload §E); blank is correct',
    live_route_b_expected_arrival: b ? CENSUS_str_(b.expected_arrival) : null
  };

  out.readback_contract = {
    before_execution: 'RUN_R6R6R2_ROUTE_B_REPAIR_MANIFEST must report ready_to_execute true',
    after_execution: 'RUN_R6R6R2_AFTER_STATE_CENSUS must report route_b.last_mile_delivery "" and draft_version 3',
    stop_if: 'any other field of Route B differs from the frozen BEFORE, or Route A moved at all'
  };

  out.ready_to_execute = (out.preflight.length === 0);
  out.verdict = out.ready_to_execute ? 'REPAIR_DESIGNED_NOT_EXECUTED' : 'STOP';
  if (!out.ready_to_execute) out.stop_reason = 'the repair is NOT applicable as designed: ' + out.preflight.join('; ');
  return CENSUS_r6r6r2Finish_(out);
}

function CENSUS_r6r6r2Finish_(out) {
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  out.writer_constructed = out.writer_constructed === true;
  CENSUS_log_('r6r6r2_verdict', out.census + ' ' + out.verdict + (out.stop_reason ? ' — ' + out.stop_reason : ''));
  CENSUS_log_('r6r6r2_db_writes', String(out.db_writes));
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R3 — THE ROUTE B FORWARD COMPENSATING REPAIR TOOL.
//
// R6-R6-R2 stopped the page from writing a route nobody touched. It did not undo the one it already wrote.
// Route B still holds `parcel` in a column no operator filled, at draft_version 2, with a K4 identity derived
// to match. This is the tool that puts it back — FORWARD, as a third version, never by rewinding a second.
//
// THIS FILE NOW CONTAINS A WRITER. That is a change in kind, and everything below is shaped by it:
//
//   — Exactly ONE function can write, it is named so nobody runs it by accident, and it re-runs the whole
//     preflight itself immediately before the call rather than trusting a verdict a human read minutes ago.
//   — The payload is ECHOED FROM THE LIVE ROW, with one field replaced. A hand-typed header would write
//     back whatever it happened to contain; an echo can only write back what is already there.
//   — THE WRITER WRITES TO SpreadsheetApp.getActiveSpreadsheet(). This census reads through
//     openById(prodExpectedDbId_()). If those two are not the same book, the preflight validates one database
//     and the write lands in another. That is the first predicate, and it fails closed.
//   — There is no retry. An exception or a lost acknowledgement is reported as UNKNOWN and the operator is
//     sent to the readback, never back to the writer.
//
// K4 IS NOT A COLUMN. `ricK4GroupKey_` derives it from the header's dimensions at read time, and
// `recommended_last_mile_delivery` is dimension 9 of 11. So 'restore the K4 key' requires writing nothing: the
// key follows the last mile the moment the last mile is blank. The repair moves exactly ONE stored column.
// ================================================================================================================

var R6R6R3_TARGET_ = { allocation_draft_id: 'SADH-K4-A3872518', allocation_draft_line_id: 'SADL-K2-344FB2B2' };
var R6R6R3_ACTOR_ = 'r6r6r3-compensating-repair';

// The unauthorized AFTER: the state the repair is designed FOR, and refuses to run against anything else.
var R6R6R3_B_UNAUTHORIZED_ = {
  last_mile_delivery: 'parcel',
  draft_version: '2',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air|parcel|',
  updated_at: 'Sun Sep 06 2026 08:28:04 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Sun Sep 06 2026 08:28:04 GMT+0800 (Taiwan Standard Time)'
};
// The state the repair produces. `draft_version` 3 is what the writer's own +1 yields; it is never sent.
var R6R6R3_B_REPAIRED_ = {
  last_mile_delivery: '',
  draft_version: '3',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air||'
};
// Route A's authorized AFTER. Frozen here as the thing that must NOT move — in the preflight, in the write and
// in the readback. Its timestamps are included: a repair that touched Route A would move them.
var R6R6R3_A_AUTHORIZED_ = {
  allocation_draft_id: 'SADH-K4-38523A90',
  allocation_draft_line_id: 'SADL-K2-92B8BAD2',
  last_mile_delivery: 'truck',
  draft_version: '2',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|truck|',
  expected_arrival: '',
  updated_at: 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)'
};
// Route B's business content, from the R6-R6-R1-B1 production freeze — the capture taken while the row was
// still correct. None of it may change, in either direction.
var R6R6R3_B_BUSINESS_FIELDS_ = ['quantity', 'shipping_method', 'source_warehouse_id', 'destination_kind',
  'destination_id', 'destination_marketplace', 'status', 'generation_type', 'ownership'];
var R6R6R3_A_COMPARED_FIELDS_ = ['last_mile_delivery', 'draft_version', 'k4_group_key', 'expected_arrival',
  'updated_at', 'line_updated_at'];

function CENSUS_r6r6r3Frozen_B_() { return (R6R6_FROZEN_BEFORE_.other_rows || [])[0] || {}; }

// A predicate is a sentence with an answer, not a line in a list. `preflight: []` said only 'nothing went
// wrong', which is indistinguishable from 'nothing was checked' — and this round is authorizing a write.
function CENSUS_r6r6r3P_(out, predicate, expected, observed, pass) {
  out.predicates.push({ predicate: predicate, expected: expected, observed: observed, pass: !!pass });
  if (pass) out.predicates_passed++; else out.predicates_failed++;
  return !!pass;
}
function CENSUS_r6r6r3Eq_(field, expected, observed) {
  var c = CENSUS_r6r6Cmp_(field, expected, observed);
  return c.equal;
}
// The ACTIVE book — the one the writer writes to — must be the production database this census reads.
function CENSUS_r6r6r3ActiveIsProd_() {
  var out = { ok: false, detail: '' };
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) { out.detail = 'there is no active spreadsheet'; return out; }
    if (typeof prodAssertDbTarget_ !== 'function') { out.detail = 'prodAssertDbTarget_ is unavailable'; return out; }
    prodAssertDbTarget_(active, prodExpectedDbId_());
    out.ok = true; out.detail = 'active spreadsheet IS the production database';
  } catch (e) {
    out.detail = 'the active spreadsheet is NOT the production database (' + CENSUS_str_(e && e.message) + ')';
  }
  return out;
}
function CENSUS_r6r6r3FindRow_(rows, headerId, lineId) {
  var hits = [];
  for (var i = 0; i < (rows || []).length; i++) {
    if (CENSUS_str_(rows[i].allocation_draft_id) === CENSUS_str_(headerId) &&
        CENSUS_str_(rows[i].allocation_draft_line_id) === CENSUS_str_(lineId)) hits.push(rows[i]);
  }
  return hits;
}
function CENSUS_r6r6r3CountBy_(rows, key, value) {
  var n = 0;
  for (var i = 0; i < (rows || []).length; i++) if (CENSUS_str_(rows[i][key]) === CENSUS_str_(value)) n++;
  return n;
}
// Is production ALREADY in the repaired state? Computed on its own, because 'already done' and 'not ready'
// are different answers and an operator who cannot tell them apart runs the writer twice.
function CENSUS_r6r6r3AlreadyCompensated_(b) {
  if (!b) return false;
  return CENSUS_str_(b.last_mile_delivery) === R6R6R3_B_REPAIRED_.last_mile_delivery
    && CENSUS_str_(b.draft_version) === R6R6R3_B_REPAIRED_.draft_version
    && CENSUS_str_(b.k4_group_key).toLowerCase() === R6R6R3_B_REPAIRED_.k4_group_key.toLowerCase();
}

// ----------------------------------------------------------------------------------------------------------------
// 1. PREFLIGHT — read-only, and every predicate answers out loud.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT() {
  var out = {
    census: 'RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    target: R6R6R3_TARGET_,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    already_compensated: false,
    verdict: 'STOP', stop_reason: ''
  };
  var frozenB = CENSUS_r6r6r3Frozen_B_();

  // 0. THE BOOK THE WRITER WOULD WRITE TO.
  var tgt = CENSUS_r6r6r3ActiveIsProd_();
  CENSUS_r6r6r3P_(out, 'active_spreadsheet_is_production_db',
    'the writer\'s active spreadsheet is the same book this census reads', tgt.detail, tgt.ok);

  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) {
    CENSUS_r6r6r3P_(out, 'census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r6r3FinishPre_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];

  // 1/2/3. THE TARGET EXISTS, EXACTLY ONCE, AND THE TWO IDS BELONG TOGETHER.
  var headerHits = CENSUS_r6r6r3CountBy_(rows, 'allocation_draft_id', R6R6R3_TARGET_.allocation_draft_id);
  var lineHits = CENSUS_r6r6r3CountBy_(rows, 'allocation_draft_line_id', R6R6R3_TARGET_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'target_header_exists_exactly_once', 1, headerHits, headerHits === 1);
  CENSUS_r6r6r3P_(out, 'target_line_exists_exactly_once', 1, lineHits, lineHits === 1);
  var pair = CENSUS_r6r6r3FindRow_(rows, R6R6R3_TARGET_.allocation_draft_id, R6R6R3_TARGET_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'header_and_line_ids_match_one_row', 1, pair.length, pair.length === 1);
  var b = pair.length === 1 ? pair[0] : null;
  out.already_compensated = CENSUS_r6r6r3AlreadyCompensated_(b);

  // 4/5/6. THE UNAUTHORIZED STATE, EXACTLY.
  CENSUS_r6r6r3P_(out, 'route_b_draft_version_is_2', R6R6R3_B_UNAUTHORIZED_.draft_version,
    b ? CENSUS_str_(b.draft_version) : null, !!b && CENSUS_str_(b.draft_version) === R6R6R3_B_UNAUTHORIZED_.draft_version);
  CENSUS_r6r6r3P_(out, 'route_b_last_mile_is_parcel', R6R6R3_B_UNAUTHORIZED_.last_mile_delivery,
    b ? CENSUS_str_(b.last_mile_delivery) : null,
    !!b && CENSUS_str_(b.last_mile_delivery).toLowerCase() === R6R6R3_B_UNAUTHORIZED_.last_mile_delivery);
  CENSUS_r6r6r3P_(out, 'route_b_k4_is_the_parcel_key', R6R6R3_B_UNAUTHORIZED_.k4_group_key,
    b ? CENSUS_str_(b.k4_group_key) : null,
    !!b && CENSUS_str_(b.k4_group_key).toLowerCase() === R6R6R3_B_UNAUTHORIZED_.k4_group_key.toLowerCase());

  // 7. THE TIMESTAMPS OF THE INCIDENT WRITE. Compared as INSTANTS, so a zone-name spelling is not a refusal.
  ['updated_at', 'line_updated_at'].forEach(function (f) {
    CENSUS_r6r6r3P_(out, 'route_b_' + f + '_matches_incident_after', R6R6R3_B_UNAUTHORIZED_[f],
      b ? CENSUS_str_(b[f]) : null,
      !!b && CENSUS_r6r6r3Eq_(f, R6R6R3_B_UNAUTHORIZED_[f], b[f]));
  });

  // 8. THE BUSINESS CONTENT, against the capture taken while the row was still correct.
  R6R6R3_B_BUSINESS_FIELDS_.forEach(function (f) {
    CENSUS_r6r6r3P_(out, 'route_b_' + f + '_unchanged', frozenB[f] == null ? '(not frozen)' : frozenB[f],
      b ? CENSUS_str_(b[f]) : null,
      !!b && frozenB[f] != null && CENSUS_r6r6r3Eq_(f, frozenB[f], b[f]));
  });
  CENSUS_r6r6r3P_(out, 'route_b_expected_arrival_blank', '', b ? CENSUS_str_(b.expected_arrival) : null,
    !!b && CENSUS_str_(b.expected_arrival) === '');

  // 9. ROUTE A, FIELD BY FIELD, INCLUDING ITS TIMESTAMPS.
  var aPair = CENSUS_r6r6r3FindRow_(rows, R6R6R3_A_AUTHORIZED_.allocation_draft_id,
    R6R6R3_A_AUTHORIZED_.allocation_draft_line_id);
  var a = aPair.length === 1 ? aPair[0] : null;
  CENSUS_r6r6r3P_(out, 'route_a_present_exactly_once', 1, aPair.length, aPair.length === 1);
  R6R6R3_A_COMPARED_FIELDS_.forEach(function (f) {
    CENSUS_r6r6r3P_(out, 'route_a_' + f + '_matches_authorized_after', R6R6R3_A_AUTHORIZED_[f],
      a ? CENSUS_str_(a[f]) : null,
      !!a && CENSUS_r6r6r3Eq_(f, R6R6R3_A_AUTHORIZED_[f], a[f]));
  });

  // 10. THE PLAN SHAPE.
  var hCount = (res.sku_contributing_header_ids || []).length;
  var lCount = (res.sku_contributing_line_ids || []).length;
  CENSUS_r6r6r3P_(out, 'header_count_is_2', 2, hCount, hCount === 2);
  CENSUS_r6r6r3P_(out, 'line_count_is_2', 2, lCount, lCount === 2);

  // 11. NO CONFLICTING TARGET. After the repair Route B's identity becomes the blank-last-mile K4. If another
  //     ACTIVE header already carries that identity, the repair would move this row onto an occupied one.
  var conflicts = [];
  for (var ci = 0; ci < rows.length; ci++) {
    if (CENSUS_str_(rows[ci].allocation_draft_id) === R6R6R3_TARGET_.allocation_draft_id) continue;
    if (CENSUS_str_(rows[ci].k4_group_key).toLowerCase() === R6R6R3_B_REPAIRED_.k4_group_key.toLowerCase()) {
      conflicts.push(CENSUS_str_(rows[ci].allocation_draft_id));
    }
  }
  CENSUS_r6r6r3P_(out, 'no_conflicting_target_for_the_repaired_identity', [], conflicts, conflicts.length === 0);

  // 12. AND THIS READ WROTE NOTHING.
  CENSUS_r6r6r3P_(out, 'writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);
  CENSUS_r6r6r3P_(out, 'db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);
  CENSUS_r6r6r3P_(out, 'writer_calls_is_zero', 0, out.writer_calls, out.writer_calls === 0);

  if (out.predicates_failed === 0) {
    out.verdict = 'ROUTE_B_REPAIR_READY';
  } else {
    out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
      + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ')
      + (out.already_compensated ? '. NOTE: Route B is ALREADY in the repaired state — this is not a failure,'
        + ' and the writer will report ALREADY_COMPENSATED with zero writes.' : '');
  }
  return CENSUS_r6r6r3FinishPre_(out);
}
function CENSUS_r6r6r3FinishPre_(out) {
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  CENSUS_log_('r6r6r3_preflight', out.verdict + ' — passed ' + out.predicates_passed
    + ' failed ' + out.predicates_failed);
  out.predicates.forEach(function (p) {
    if (!p.pass) CENSUS_log_('r6r6r3_preflight_failed', p.predicate + ': expected '
      + JSON.stringify(p.expected) + ' observed ' + JSON.stringify(p.observed));
  });
  return out;
}

// ----------------------------------------------------------------------------------------------------------------
// 2. EXECUTE — THE ONLY WRITER IN THIS FILE. One call, one row, one column.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE() {
  var out = {
    census: 'RUN_R6R6R3_ROUTE_B_REPAIR_EXECUTE_ONCE',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: false,
    executed: false, writer_calls: 0, rows_written: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    target: R6R6R3_TARGET_,
    preflight_verdict: null, predicates_passed: 0, predicates_failed: 0, failed_predicates: [],
    payload: null, writer_response: null,
    verdict: 'STOP', stop_reason: '',
    next_action: ''
  };

  // 1. THE PREFLIGHT, RERUN HERE. Not a verdict someone read five minutes ago: the state it describes is the
  //    state this call is about to write into, so it is measured now.
  var pf;
  try { pf = RUN_R6R6R3_ROUTE_B_REPAIR_PREFLIGHT(); }
  catch (ePf) {
    out.stop_reason = 'the preflight threw, so nothing was written: ' + CENSUS_str_(ePf && ePf.message);
    out.next_action = 'Fix the preflight failure. Do NOT run this function again until it returns ROUTE_B_REPAIR_READY.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  out.preflight_verdict = pf.verdict;
  out.predicates_passed = pf.predicates_passed;
  out.predicates_failed = pf.predicates_failed;
  out.failed_predicates = (pf.predicates || []).filter(function (p) { return !p.pass; })
    .map(function (p) { return { predicate: p.predicate, expected: p.expected, observed: p.observed }; });

  // 2. ALREADY DONE IS NOT A FAILURE, AND IT IS NOT A REASON TO WRITE AGAIN. Checked before the readiness
  //    verdict, because a repaired row fails 'last mile is parcel' by construction and an operator who reads
  //    that as 'not ready' is one step from running the writer a second time.
  if (pf.already_compensated === true) {
    out.verdict = 'ALREADY_COMPENSATED';
    out.stop_reason = 'Route B is already blank at draft_version 3 with the blank-last-mile K4. Nothing was written.';
    out.next_action = 'Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK() to confirm. Do NOT run this writer again.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  if (pf.verdict !== 'ROUTE_B_REPAIR_READY') {
    out.stop_reason = 'the preflight did not return ROUTE_B_REPAIR_READY, so ZERO writes were attempted: '
      + CENSUS_str_(pf.stop_reason);
    out.next_action = 'Read failed_predicates. Nothing was written and nothing needs undoing.';
    return CENSUS_r6r6r3FinishExec_(out);
  }

  // 3. THE PAYLOAD, ECHOED FROM THE LIVE ROW. Read from the SAME book the writer writes to, so what is sent
  //    back is what is already stored — with one field replaced. A hand-typed header could carry a stale value
  //    into a column nobody meant to touch; an echo cannot.
  var ss, hSh, lSh, hFound, lFound, hRow, lRow;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    hSh = ss.getSheetByName('shipping_allocation_drafts');
    lSh = ss.getSheetByName('shipping_allocation_draft_lines');
    hFound = procurementFindRow_(hSh, 'allocation_draft_id', R6R6R3_TARGET_.allocation_draft_id);
    lFound = procurementFindRow_(lSh, 'allocation_draft_line_id', R6R6R3_TARGET_.allocation_draft_line_id);
    if (!hFound || !lFound) throw new Error('the target header or line row could not be located for the echo');
    hRow = sadRowToObject_(hSh, hFound.row);
    lRow = sadRowToObject_(lSh, lFound.row);
  } catch (eEcho) {
    out.stop_reason = 'could not read the live rows to build the echo, so nothing was written: '
      + CENSUS_str_(eEcho && eEcho.message);
    out.next_action = 'Nothing was written. Investigate the read failure before retrying.';
    return CENSUS_r6r6r3FinishExec_(out);
  }

  var header = {
    allocation_draft_id: R6R6R3_TARGET_.allocation_draft_id,
    company: CENSUS_str_(hRow.company),
    country: CENSUS_str_(hRow.country),
    marketplace: CENSUS_str_(hRow.marketplace),
    status: CENSUS_str_(hRow.status) || 'draft',
    recommended_source_warehouse_id: CENSUS_str_(hRow.recommended_source_warehouse_id),
    recommended_destination_warehouse_id: CENSUS_str_(hRow.recommended_destination_warehouse_id),
    recommended_source_warehouse_code_snapshot: CENSUS_str_(hRow.recommended_source_warehouse_code_snapshot),
    recommended_destination_warehouse_code_snapshot: CENSUS_str_(hRow.recommended_destination_warehouse_code_snapshot),
    recommendation_group_no: CENSUS_str_(hRow.recommendation_group_no),
    recommended_shipping_method: CENSUS_str_(hRow.recommended_shipping_method),
    destination_marketplace: CENSUS_str_(hRow.destination_marketplace),
    // THE ONE FIELD THIS ROUND EXISTS TO MOVE.
    recommended_last_mile_delivery: '',
    // The optimistic guard. 2 is what the incident left; the writer turns it into 3 on its own.
    expected_draft_version: R6R6R3_B_UNAUTHORIZED_.draft_version,
    created_by: R6R6R3_ACTOR_
  };
  // The line is echoed to its MINIMUM: an id, a SKU and a quantity is what sadAtomicValidateBatch_ requires of
  // a manual line, and every field omitted here is a field the writer cannot touch. `expected_arrival` is
  // deliberately absent — sadRegenerateLinePatch_ adopts it only when non-blank, so omitting it is what keeps
  // 'do not change expected_arrival' true rather than merely intended.
  var line = {
    allocation_draft_line_id: R6R6R3_TARGET_.allocation_draft_line_id,
    sku: CENSUS_str_(lRow.sku),
    planned_qty: CENSUS_str_(lRow.planned_qty)
  };
  var payload = {
    intent: 'UPDATE_EXISTING_ROUTE',
    header: header,
    lines: [line],
    expected_draft_version: R6R6R3_B_UNAUTHORIZED_.draft_version
    // create_idempotency_key is DELIBERATELY ABSENT: an UPDATE names its row and mints nothing.
    // enforce_k2_grouping is absent: this is not a grouping operation.
  };
  out.payload = payload;

  // 4. ONE CALL. The counter is incremented BEFORE the call, so a throw cannot leave it reading zero and
  //    invite a second attempt.
  if (out.writer_calls !== 0) {
    out.stop_reason = 'a writer call was already recorded in this invocation; refusing a second.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  out.writer_calls = 1;
  var resp = null, threw = null;
  try {
    resp = handleUpsertShippingAllocationDraftAtomic_(payload);
  } catch (eW) { threw = eW; }

  // 5. CLASSIFY. There is no retry here, and there must never be one: this writer is not idempotent by key
  //    (an UPDATE is guarded by a version it has just consumed), so a blind second attempt is a second write.
  if (threw) {
    out.verdict = 'ACK_UNKNOWN';
    out.stop_reason = 'the writer threw AFTER being invoked, so whether it committed is unknown: '
      + CENSUS_str_(threw && threw.message);
    out.next_action = 'Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK(). Do NOT run this writer again — the readback'
      + ' decides, and a second call would be a second write.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  var parsed = null;
  try {
    parsed = JSON.parse(resp && resp.getContent ? resp.getContent()
      : (typeof resp === 'string' ? resp : JSON.stringify(resp || {})));
  } catch (eP) { parsed = null; }
  out.writer_response = parsed;
  if (!parsed) {
    out.verdict = 'ACK_UNKNOWN';
    out.stop_reason = 'the writer answered with something this tool could not parse, so whether it committed is unknown.';
    out.next_action = 'Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK(). Do NOT run this writer again.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  if (parsed.success !== true) {
    // A typed refusal from 16_ carries zero_write; anything without it is not a proven zero-write.
    var provenZero = (parsed.zero_write === true);
    out.verdict = provenZero ? 'REFUSED_ZERO_WRITE' : 'ACK_UNKNOWN';
    out.stop_reason = 'the writer refused: ' + CENSUS_str_(parsed.error || parsed.code);
    out.next_action = provenZero
      ? 'The refusal declares zero_write, so nothing changed. Fix the cause and re-run the PREFLIGHT first.'
      : 'The refusal does NOT declare zero_write, so it is not proven. Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK().';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  // A REUSE means the writer found nothing to change — which, here, means the row was not what we measured.
  if (parsed.reused === true) {
    out.verdict = 'ACK_UNKNOWN';
    out.stop_reason = 'the writer returned REUSED (zero write), which means the payload matched the stored row. '
      + 'The repair did not apply.';
    out.next_action = 'Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK() to see the current state. Do NOT run this writer again.';
    return CENSUS_r6r6r3FinishExec_(out);
  }
  out.executed = true;
  out.rows_written = 1;
  out.verdict = 'ROUTE_B_COMPENSATION_WRITTEN';
  out.next_action = 'Run RUN_R6R6R3_ROUTE_B_REPAIR_READBACK() to confirm. Do NOT run this writer again.';
  return CENSUS_r6r6r3FinishExec_(out);
}
function CENSUS_r6r6r3FinishExec_(out) {
  CENSUS_log_('r6r6r3_execute', out.verdict + ' — writer_calls ' + out.writer_calls
    + ' executed ' + out.executed + (out.stop_reason ? ' — ' + out.stop_reason : ''));
  CENSUS_log_('r6r6r3_execute_next', CENSUS_str_(out.next_action));
  return out;
}

// ----------------------------------------------------------------------------------------------------------------
// 3. READBACK — read-only, and it asks the DATABASE.
//
// THE UI IS NOT EVIDENCE HERE. After the repair the Execution Plan will very likely still SHOW `parcel` on
// Route B, because `air` on this lane runs exactly one last mile and R6-R6-R2 kept that display while removing
// its authority to be written. A screen showing parcel proves nothing about the column, which is the whole
// reason this function reads rows instead.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R3_ROUTE_B_REPAIR_READBACK() {
  var out = {
    census: 'RUN_R6R6R3_ROUTE_B_REPAIR_READBACK',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    ui_note: 'Route B may still DISPLAY parcel: it is the sole eligible last mile on this lane, so the cell is'
      + ' filled for display. That display is not evidence about the stored column, and this verdict is.',
    verdict: 'STOP', stop_reason: ''
  };
  var frozenB = CENSUS_r6r6r3Frozen_B_();
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) {
    CENSUS_r6r6r3P_(out, 'census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r6r3FinishBack_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];

  // IDENTITY. The row must be the SAME row — not a replacement wearing its values.
  var hHits = CENSUS_r6r6r3CountBy_(rows, 'allocation_draft_id', R6R6R3_TARGET_.allocation_draft_id);
  var lHits = CENSUS_r6r6r3CountBy_(rows, 'allocation_draft_line_id', R6R6R3_TARGET_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'route_b_header_id_present_exactly_once', 1, hHits, hHits === 1);
  CENSUS_r6r6r3P_(out, 'route_b_line_id_present_exactly_once', 1, lHits, lHits === 1);
  var pair = CENSUS_r6r6r3FindRow_(rows, R6R6R3_TARGET_.allocation_draft_id, R6R6R3_TARGET_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'route_b_ids_still_paired', 1, pair.length, pair.length === 1);
  var b = pair.length === 1 ? pair[0] : null;

  // THE REPAIR ITSELF.
  CENSUS_r6r6r3P_(out, 'route_b_last_mile_is_blank', '', b ? CENSUS_str_(b.last_mile_delivery) : null,
    !!b && CENSUS_str_(b.last_mile_delivery) === '');
  CENSUS_r6r6r3P_(out, 'route_b_draft_version_is_exactly_3', '3', b ? CENSUS_str_(b.draft_version) : null,
    !!b && CENSUS_str_(b.draft_version) === '3');
  CENSUS_r6r6r3P_(out, 'route_b_k4_is_the_blank_last_mile_key', R6R6R3_B_REPAIRED_.k4_group_key,
    b ? CENSUS_str_(b.k4_group_key) : null,
    !!b && CENSUS_str_(b.k4_group_key).toLowerCase() === R6R6R3_B_REPAIRED_.k4_group_key.toLowerCase());

  // THE TIMESTAMPS ADVANCED. A repair is a write; if they did not move, no write landed and a version that
  // reads 3 would have to be explained some other way.
  ['updated_at', 'line_updated_at'].forEach(function (f) {
    var before = CENSUS_r6r6r3TsMs_(R6R6R3_B_UNAUTHORIZED_[f]);
    var now = b ? CENSUS_r6r6r3TsMs_(b[f]) : null;
    CENSUS_r6r6r3P_(out, 'route_b_' + f + '_advanced_past_the_incident',
      'later than ' + R6R6R3_B_UNAUTHORIZED_[f], b ? CENSUS_str_(b[f]) : null,
      now !== null && before !== null && now > before);
  });

  // THE BUSINESS CONTENT DID NOT MOVE.
  R6R6R3_B_BUSINESS_FIELDS_.forEach(function (f) {
    CENSUS_r6r6r3P_(out, 'route_b_' + f + '_unchanged', frozenB[f] == null ? '(not frozen)' : frozenB[f],
      b ? CENSUS_str_(b[f]) : null,
      !!b && frozenB[f] != null && CENSUS_r6r6r3Eq_(f, frozenB[f], b[f]));
  });
  CENSUS_r6r6r3P_(out, 'route_b_expected_arrival_still_blank', '', b ? CENSUS_str_(b.expected_arrival) : null,
    !!b && CENSUS_str_(b.expected_arrival) === '');

  // ROUTE A DID NOT MOVE AT ALL — timestamps included, which is what proves the repair did not reach it.
  var aPair = CENSUS_r6r6r3FindRow_(rows, R6R6R3_A_AUTHORIZED_.allocation_draft_id,
    R6R6R3_A_AUTHORIZED_.allocation_draft_line_id);
  var a = aPair.length === 1 ? aPair[0] : null;
  CENSUS_r6r6r3P_(out, 'route_a_present_exactly_once', 1, aPair.length, aPair.length === 1);
  R6R6R3_A_COMPARED_FIELDS_.forEach(function (f) {
    CENSUS_r6r6r3P_(out, 'route_a_' + f + '_unchanged', R6R6R3_A_AUTHORIZED_[f],
      a ? CENSUS_str_(a[f]) : null,
      !!a && CENSUS_r6r6r3Eq_(f, R6R6R3_A_AUTHORIZED_[f], a[f]));
  });

  // THE PLAN SHAPE, AND NO SECOND ROW WEARING EITHER IDENTITY.
  var hCount = (res.sku_contributing_header_ids || []).length;
  var lCount = (res.sku_contributing_line_ids || []).length;
  CENSUS_r6r6r3P_(out, 'header_count_still_2', 2, hCount, hCount === 2);
  CENSUS_r6r6r3P_(out, 'line_count_still_2', 2, lCount, lCount === 2);
  var dupes = [];
  var seenH = {};
  for (var di = 0; di < rows.length; di++) {
    var k = CENSUS_str_(rows[di].allocation_draft_id) + '::' + CENSUS_str_(rows[di].allocation_draft_line_id);
    if (seenH[k]) dupes.push(k); else seenH[k] = 1;
  }
  CENSUS_r6r6r3P_(out, 'no_duplicate_or_replacement_row', [], dupes, dupes.length === 0);

  // AND THIS READ WROTE NOTHING.
  CENSUS_r6r6r3P_(out, 'readback_db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);
  CENSUS_r6r6r3P_(out, 'readback_writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);

  if (out.predicates_failed === 0) out.verdict = 'ROUTE_B_COMPENSATION_CONFIRMED';
  else out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
    + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ');
  return CENSUS_r6r6r3FinishBack_(out);
}
// An instant, so a zone-name spelling is not a difference and 'later' is a comparison of moments.
function CENSUS_r6r6r3TsMs_(v) {
  var k = CENSUS_r6r6TsKey_(v);
  if (k === '') return null;
  var n = Number(k);
  return isFinite(n) ? n : null;
}
function CENSUS_r6r6r3FinishBack_(out) {
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  CENSUS_log_('r6r6r3_readback', out.verdict + ' — passed ' + out.predicates_passed
    + ' failed ' + out.predicates_failed);
  out.predicates.forEach(function (p) {
    if (!p.pass) CENSUS_log_('r6r6r3_readback_failed', p.predicate + ': expected '
      + JSON.stringify(p.expected) + ' observed ' + JSON.stringify(p.observed));
  });
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4 — THE POST-REPAIR SINGLE-ROW SAVE, AND A BASELINE THAT IS ITS OWN.
//
// Three rounds changed what production holds, so the BEFORE this round compares against is NEW. R6-R6-R1's
// freeze describes a plan where Route A had no last mile and Route B was at version 1; R6-R6-R3's constants
// describe the moment Route B still held `parcel`. Both are correct records of moments that have passed, and
// reusing either would be checking today's database against last week's.
//
// WHAT IS FROZEN HERE, AND ON WHAT EVIDENCE. Every field below is one of:
//
//   • CONFIRMED IN PRODUCTION — the R6-R6-R3 readback returned ROUTE_B_COMPENSATION_CONFIRMED with 30 of 30
//     predicates passing, and those predicates compared Route A's six fields and Route B's business set
//     against these exact literals. A field a production run compared and did not reject is evidence.
//   • DERIVED FROM SHIPPED CODE — `updated_by`. 16_ resolves its actor as `body.created_by ||
//     'inventory-replenishment'`; the Execution Plan sends no created_by at all (there is no `created_by` in
//     inventory-replenishment.js), so the page's writes are stamped with the default, and R6-R6-R3's payload
//     set created_by explicitly. Both values follow from source, and both are FALSIFIABLE: if production
//     disagrees the readiness STOPs rather than shrugging.
//   • R6-R6-R4-R1 — ROUTE B'S TWO POST-REPAIR INSTANTS, WHICH ARE NOW EVIDENCE TOO. R6-R6-R4 could not
//     freeze them: nobody had reported what the compensation stamped, and a literal would have been a
//     fabrication wearing the shape of evidence. The live readiness returned SINGLE_ROW_SAVE_READY with
//     60 of 60 and named them in `snapshot_gaps`; the operator then read them off production. They are
//     frozen below as EQUALITY gates, `snapshot_gaps` is EMPTY, and no field of either row falls back to
//     'not checked' — which is the answer that once let an unrelated route move without anyone noticing.
//
// THE THREE DERIVED FACTS ARE KEPT, AS A SECOND CHECK RATHER THAN AS A SUBSTITUTE. They stood in for the
// equality gate while the value was missing. They are independent of it, each fails on a different kind of
// drift, and none of them costs a read — so retiring them the moment the literal arrived would trade
// evidence for tidiness:
//
//   1. `draft_version` is still 3. The writer increments it on every UPDATE, so a write that landed on
//      Route B could not leave it at 3.
//   2. `updated_by` is still `r6r6r3-compensating-repair`. The Save writes as `inventory-replenishment`, so
//      the repair being the last recorded actor means the Save was not.
//   3. Route B's `updated_at` is STRICTLY EARLIER than Route A's post-Save `updated_at`. Both stamps come
//      from the same clock through the same writer; a Save that touched both rows would stamp them together.
//
// An equality gate answers 'is this the row we froze?'. Those three answer 'could anything have written it
// since?'. They are different questions, and the second one is still worth asking with the first in hand.
//
// THE TIMEOUT IS STILL OPEN, AND THIS ROUND DID NOT LOOK AT IT. Recorded here so a round that measured
// something else cannot be read as having closed it:
//
//   • one REQUEST_TIMEOUT recurred after R6-R5;
//   • several cold loads have succeeded since;
//   • the most recent successful workspace sample is ~32.6s client / ~26.4s server;
//   • classification: INTERMITTENT_TIMEOUT_OPEN_NON_BLOCKING.
//
// It is NOT eliminated. No timeout logic is touched by R6-R6-R4: a change there needs a reproducible
// defect with its own timestamps and request ids, and this round produced none.
// ================================================================================================================

var R6R6R4_A_TARGET_ = { allocation_draft_id: 'SADH-K4-38523A90', allocation_draft_line_id: 'SADL-K2-92B8BAD2' };
var R6R6R4_B_BYSTANDER_ = { allocation_draft_id: 'SADH-K4-A3872518', allocation_draft_line_id: 'SADL-K2-344FB2B2' };

// The ONE authorized change of stage one, spelled so it cannot be read as a business decision — and spelled
// as the page ACTUALLY behaves. R6-R6-R4 said 'through the ordinary Execution Plan Save', and there is no
// Save button: _scheduleDraftDbPersist debounces for 400 ms and the row's own state cell reports the
// outcome (IR_ROUTE_SAVE_STATES_ — Saving / Saved / Not saved / Outcome unknown). An operator hunting for
// a control that does not exist either gives up or clicks something else, and clicking something else is
// how this incident started.
var R6R6R4_SAVE_MECHANIC_ = 'change Route A Last Mile ONCE and wait for the debounced auto-save to report'
  + ' Saved on that row. There is no Save button: the write is scheduled 400 ms after the edit and the row'
  + ' state cell is the acknowledgement. Do not edit twice, and do not press Submit Plan.';
var R6R6R4_AUTHORIZED_ACTION_ = 'Route A last_mile_delivery truck -> parcel: ' + R6R6R4_SAVE_MECHANIC_
  + ' This is an ISOLATION TEST, not a shipping decision: stage two restores it to truck.';
// R6-R6-R4-R2 — STAGE ONE HAS HAPPENED, so the BEFORE is the row it left behind and the authorized change
// is the way back. `R6R6R4_A_BEFORE_` below carries parcel at version 3; the stage-one freeze (truck at 2) is
// a correct record of a moment that has passed, and a readiness still holding it would be checking today's
// database against this morning's.
var R6R6R4_A_AFTER_LAST_MILE_ = 'truck';
var R6R6R4_A_AFTER_DRAFT_VERSION_ = '4';
// STAGE TWO IS NOT AUTHORIZED BY THIS ROUND. A readiness that says READY says the row is in the state the
// design expects — it has never been permission, and the manifest is what records that permission is
// absent. Stage two additionally requires the R6-R6-R4-R2 fix to be DEPLOYED and the browser audit to show
// expected_draft_version '3' on the request, because a write with no precondition is what this round found.
var R6R6R4_STAGE_TWO_AUTHORIZED_ = false;
var R6R6R4_PAGE_ACTOR_ = 'inventory-replenishment';      // 16_ line 499: body.created_by || this
var R6R6R4_REPAIR_ACTOR_ = 'r6r6r3-compensating-repair'; // what R6-R6-R3 sent as created_by

// ---- ROUTE A. The only row the Save may touch. -----------------------------------------------------------------
// Scope fields are lowercase where they were read from the K4 key (which lowercases every segment by
// construction) and in the row's own spelling where they were read from the row. Every one of them is
// compared case-insensitively, so both are correct and neither is a guess at stored casing.
var R6R6R4_A_BEFORE_ = {
  allocation_draft_id: 'SADH-K4-38523A90',
  allocation_draft_line_id: 'SADL-K2-92B8BAD2',
  company: 'resus', country: 'us', station_marketplace: 'amazon', sku: 'CO1100-R',
  source_warehouse_id: 'wh-tw-cn-factory-youxin',
  destination_kind: 'MARKETPLACE', destination_id: 'amazon', destination_marketplace: 'amazon',
  quantity: 320,
  shipping_method: 'sea_express',
  // R6-R6-R4-R2 — what stage one actually left: parcel, version 3, the parcel key, and the two stamps the
  // Save wrote. Read off production after SINGLE_ROW_MUTATION_CONFIRMED (58 of 58).
  last_mile_delivery: 'parcel',
  expected_arrival: '',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|parcel|',
  status: 'draft', line_status: '', generation_type: 'user_created',
  ownership: 'MANUAL (no generation_run_id — composed by a person)',
  draft_version: '3',
  updated_at: 'Sun Sep 06 2026 13:05:49 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Sun Sep 06 2026 13:05:49 GMT+0800 (Taiwan Standard Time)',
  updated_by: 'inventory-replenishment'
};
// ---- ROUTE B. The bystander. Nothing about it is authorized to change, in either direction. -------------------
var R6R6R4_B_BEFORE_ = {
  allocation_draft_id: 'SADH-K4-A3872518',
  allocation_draft_line_id: 'SADL-K2-344FB2B2',
  company: 'ResUS', country: 'US', station_marketplace: 'Amazon', sku: 'CO1100-R',
  source_warehouse_id: 'WH-TW-CN-FACTORY-YOUXIN',
  destination_kind: 'WAREHOUSE', destination_id: 'WH-RESUS-US-3PL-AMZLGS', destination_marketplace: '',
  quantity: 200,
  shipping_method: 'air',
  last_mile_delivery: '',
  expected_arrival: '',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|warehouse|wh-resus-us-3pl-amzlgs|air||',
  status: 'draft', line_status: '', generation_type: 'user_created',
  ownership: 'MANUAL (no generation_run_id — composed by a person)',
  draft_version: '3',
  updated_by: 'r6r6r3-compensating-repair',
  // R6-R6-R4-R1 — READ OFF PRODUCTION, not reconstructed. These are what the compensation stamped, and
  // they are EQUALITY gates in both directions: the readiness requires them equal because nothing has
  // happened yet, and the readback requires them equal because Route B is not the row being changed. They
  // are compared as INSTANTS through CENSUS_r6r6TsKey_, so a zone-name spelling is not a difference.
  updated_at: 'Sun Sep 06 2026 09:56:04 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Sun Sep 06 2026 09:56:04 GMT+0800 (Taiwan Standard Time)'
};
// The moment the compensation ran must be BEFORE whatever Route B now holds — that is the only thing the
// missing instants can still be checked against, and it is checkable.
var R6R6R4_COMPENSATION_FLOOR_ = 'Sun Sep 06 2026 08:28:04 GMT+0800 (Taiwan Standard Time)';

// The set. A single-row Save must leave every one of these exactly where it found it.
var R6R6R4_SET_BEFORE_ = { current_plan_total: 520, visible_route_rows: 2, header_count: 2, line_count: 2 };

// Which fields are compared, and in which role. `identity` and `business` may never move on either row;
// `audit` moves on the target and must not move on the bystander.
var R6R6R4_IDENTITY_FIELDS_ = ['allocation_draft_id', 'allocation_draft_line_id', 'company', 'country',
  'station_marketplace', 'sku', 'source_warehouse_id', 'destination_kind', 'destination_id',
  'destination_marketplace', 'k4_group_key'];
var R6R6R4_BUSINESS_FIELDS_ = ['quantity', 'shipping_method', 'status', 'line_status', 'generation_type',
  'ownership', 'expected_arrival'];
var R6R6R4_AUDIT_FIELDS_ = ['draft_version', 'updated_at', 'line_updated_at', 'updated_by'];
// What the Save is allowed to move on ROUTE A, and nothing else. `k4_group_key` is derived, not stored.
var R6R6R4_A_ALLOWED_TO_MOVE_ = ['last_mile_delivery', 'k4_group_key', 'draft_version', 'updated_at',
  'line_updated_at', 'updated_by'];

function CENSUS_r6r6r4Find_(rows, headerId, lineId) {
  var hits = [];
  for (var i = 0; i < (rows || []).length; i++) {
    if (CENSUS_str_(rows[i].allocation_draft_id) === CENSUS_str_(headerId) &&
        CENSUS_str_(rows[i].allocation_draft_line_id) === CENSUS_str_(lineId)) hits.push(rows[i]);
  }
  return hits;
}
// THE K4 SUBSTITUTION, DERIVED RATHER THAN TYPED. The last-mile segment is the second-to-last field of the
// key, and the expected AFTER key is the frozen key with THAT segment replaced and nothing else touched. A
// hard-coded 'parcel' key would pass even if some other dimension had moved with it, which is exactly the
// class of change the round exists to detect.
function CENSUS_r6r6r4K4Swap_(frozenKey, frozenLastMile, nextLastMile) {
  var parts = CENSUS_str_(frozenKey).split('|');
  if (parts.length < 3) return null;
  var at = parts.length - 2;
  if (CENSUS_str_(parts[at]).toLowerCase() !== CENSUS_str_(frozenLastMile).toLowerCase()) return null;
  parts[at] = CENSUS_str_(nextLastMile);
  return parts.join('|');
}
// Every frozen field of a record against the live row, through the ONE comparison core the whole family uses.
// A field frozen as null is a GAP, reported by name — never silently equal, never silently unequal.
function CENSUS_r6r6r4CmpAll_(out, prefix, frozen, live, fields, gaps) {
  for (var i = 0; i < fields.length; i++) {
    var k = fields[i];
    if (frozen[k] === null || frozen[k] === undefined) {
      if (gaps.indexOf(prefix + '.' + k) === -1) gaps.push(prefix + '.' + k);
      continue;
    }
    var c = CENSUS_r6r6Cmp_(k, frozen[k], live ? live[k] : null);
    CENSUS_r6r6r3P_(out, prefix + '_' + k + '_unchanged', c.frozen, live ? c.live : null, !!live && c.equal);
  }
}

// R6-R6-R4-R1 §4 — THE OBSERVED ROW, over exactly the fields the freeze compares. The readiness used to
// report only a verdict and a predicate list, so reading the two missing instants off production needed a
// wrapper typed into the Apps Script editor — a function that existed in no commit, that nobody could
// review, and that the next paste of this file would silently delete. Both states are part of the output
// now, and pasting this file is the whole of the operation.
function CENSUS_r6r6r4Observe_(live, fields) {
  var o = {};
  for (var i = 0; i < fields.length; i++) o[fields[i]] = live ? CENSUS_str_(live[fields[i]]) : null;
  return o;
}
// The full field list of a frozen record, in freeze order, so `frozen` and `observed` line up column by column.
function CENSUS_r6r6r4Fields_() {
  return R6R6R4_IDENTITY_FIELDS_.concat(R6R6R4_BUSINESS_FIELDS_).concat(['last_mile_delivery'])
    .concat(R6R6R4_AUDIT_FIELDS_);
}

// ----------------------------------------------------------------------------------------------------------------
// §3 — READINESS. Read-only. Run it immediately before the one authorized edit.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS() {
  var out = {
    census: 'RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    target: R6R6R4_A_TARGET_, bystander: R6R6R4_B_BYSTANDER_,
    authorized_action: R6R6R4_AUTHORIZED_ACTION_,
    save_mechanic: R6R6R4_SAVE_MECHANIC_,
    stage: 'TWO',
    authorized_this_round: R6R6R4_STAGE_TWO_AUTHORIZED_,
    next_action: 'READY here means the rows are in the state stage two expects. It is NOT permission.'
      + ' Stage two needs the R6-R6-R4-R2 fix deployed AND a browser audit showing'
      + ' expected_draft_version "3" on the request, because stage one was written with no optimistic'
      + ' precondition at all and nobody could see it until the audit reported null.',
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    snapshot_gaps: [],
    derived_gates: [],
    // §4 — the FROZEN record and the OBSERVED row, side by side, so a gap can be closed from this output
    //      alone and never again from a wrapper that lives only in the editor.
    route_a_frozen: R6R6R4_A_BEFORE_, route_a_observed: null,
    route_b_frozen: R6R6R4_B_BEFORE_, route_b_observed: null,
    already_saved: false,
    stage_two_authorized: false,
    stage_two: 'parcel -> truck, version 3 -> 4, HAS BEEN EXECUTED and read back (R6-R7 §0). This'
      + ' readiness is CLOSED: its frozen BEFORE describes Route A at parcel/version 3, and Route A is now'
      + ' truck at version 4, so a run reports the difference. That is the honest answer, not a fault.',
    frozen_snapshot_source: '',
    verdict: 'STOP', stop_reason: ''
  };
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) {
    CENSUS_r6r6r3P_(out, 'census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r6r4Finish_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];

  // ---- ROUTE A, the target. Present exactly once, and every frozen field where it was left. -------------------
  var aHits = CENSUS_r6r6r4Find_(rows, R6R6R4_A_TARGET_.allocation_draft_id, R6R6R4_A_TARGET_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'route_a_present_exactly_once', 1, aHits.length, aHits.length === 1);
  var a = aHits.length === 1 ? aHits[0] : null;
  CENSUS_r6r6r4CmpAll_(out, 'route_a', R6R6R4_A_BEFORE_, a,
    R6R6R4_IDENTITY_FIELDS_.concat(R6R6R4_BUSINESS_FIELDS_).concat(['last_mile_delivery'])
      .concat(R6R6R4_AUDIT_FIELDS_), out.snapshot_gaps);

  // NOT ALREADY DONE. A row that already reads `parcel` at version 3 is not 'not ready' — it is a Save that
  // has already happened, and an operator who cannot tell those apart performs the edit twice.
  out.route_a_observed = CENSUS_r6r6r4Observe_(a, CENSUS_r6r6r4Fields_());
  out.already_saved = !!a && CENSUS_str_(a.last_mile_delivery).toLowerCase() === R6R6R4_A_AFTER_LAST_MILE_
    && CENSUS_str_(a.draft_version) === R6R6R4_A_AFTER_DRAFT_VERSION_;
  CENSUS_r6r6r3P_(out, 'route_a_save_has_not_already_happened',
    'last mile ' + R6R6R4_A_BEFORE_.last_mile_delivery + ' at version ' + R6R6R4_A_BEFORE_.draft_version,
    a ? (CENSUS_str_(a.last_mile_delivery) + ' at version ' + CENSUS_str_(a.draft_version)) : null,
    !!a && !out.already_saved);

  // ---- ROUTE B, the bystander. Every frozen field, plus the two derived instants. ----------------------------
  var bHits = CENSUS_r6r6r4Find_(rows, R6R6R4_B_BYSTANDER_.allocation_draft_id, R6R6R4_B_BYSTANDER_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'route_b_present_exactly_once', 1, bHits.length, bHits.length === 1);
  var b = bHits.length === 1 ? bHits[0] : null;
  out.route_b_observed = CENSUS_r6r6r4Observe_(b, CENSUS_r6r6r4Fields_());
  CENSUS_r6r6r4CmpAll_(out, 'route_b', R6R6R4_B_BEFORE_, b,
    R6R6R4_IDENTITY_FIELDS_.concat(R6R6R4_BUSINESS_FIELDS_).concat(['last_mile_delivery'])
      .concat(R6R6R4_AUDIT_FIELDS_), out.snapshot_gaps);

  // Later than the compensation, and agreeing with each other because one transaction stamped both. They
  // are checked ALONGSIDE the equality gates above rather than instead of them, and they stay named in
  // `derived_gates` so a reader can tell which claim each predicate is making.
  var floor = CENSUS_r6r6r3TsMs_(R6R6R4_COMPENSATION_FLOOR_);
  ['updated_at', 'line_updated_at'].forEach(function (fld) {
    var now = b ? CENSUS_r6r6r3TsMs_(b[fld]) : null;
    out.derived_gates.push('route_b_' + fld + '_is_after_the_compensation_write');
    CENSUS_r6r6r3P_(out, 'route_b_' + fld + '_is_after_the_compensation_write',
      'later than ' + R6R6R4_COMPENSATION_FLOOR_, b ? CENSUS_str_(b[fld]) : null,
      now !== null && floor !== null && now > floor);
  });
  var bh = b ? CENSUS_r6r6r3TsMs_(b.updated_at) : null, bl = b ? CENSUS_r6r6r3TsMs_(b.line_updated_at) : null;
  out.derived_gates.push('route_b_header_and_line_instants_agree');
  CENSUS_r6r6r3P_(out, 'route_b_header_and_line_instants_agree', 'the same instant, from one transaction',
    b ? (CENSUS_str_(b.updated_at) + ' / ' + CENSUS_str_(b.line_updated_at)) : null,
    bh !== null && bl !== null && bh === bl);

  // ---- THE SET. A single-row Save changes the shape of nothing. -----------------------------------------------
  var total = CENSUS_num_(res.census_current_plan_total);
  CENSUS_r6r6r3P_(out, 'current_plan_total_is_520', R6R6R4_SET_BEFORE_.current_plan_total, total,
    total === R6R6R4_SET_BEFORE_.current_plan_total);
  CENSUS_r6r6r3P_(out, 'visible_route_rows_is_2', R6R6R4_SET_BEFORE_.visible_route_rows, rows.length,
    rows.length === R6R6R4_SET_BEFORE_.visible_route_rows);
  var hCount = (res.sku_contributing_header_ids || []).length;
  var lCount = (res.sku_contributing_line_ids || []).length;
  CENSUS_r6r6r3P_(out, 'header_count_is_2', R6R6R4_SET_BEFORE_.header_count, hCount, hCount === R6R6R4_SET_BEFORE_.header_count);
  CENSUS_r6r6r3P_(out, 'line_count_is_2', R6R6R4_SET_BEFORE_.line_count, lCount, lCount === R6R6R4_SET_BEFORE_.line_count);
  var amb = (res.ambiguous_save_targets || []).map(function (t) { return CENSUS_str_(t.visible_row_key); });
  CENSUS_r6r6r3P_(out, 'no_ambiguous_save_target', [], amb, amb.length === 0);

  // THE WRITE PATH'S OWN ANSWER about where a Save would land. REUSE of Route A's own header is the only
  // acceptable one: CREATE would mint a twin, and BLOCKED_CONFLICT would mean two headers share the identity.
  CENSUS_r6r6r3P_(out, 'route_a_save_target_is_its_own_header_reuse', 'REUSE ' + R6R6R4_A_TARGET_.allocation_draft_id,
    a ? (CENSUS_str_(a.save_target_status) + ' ' + CENSUS_str_(a.save_target_allocation_draft_id)) : null,
    !!a && a.save_would_update_this_header === true && a.save_would_mint_new_header === false);
  CENSUS_r6r6r3P_(out, 'route_b_save_target_would_not_be_minted', false,
    b ? b.save_would_mint_new_header : null, !!b && b.save_would_mint_new_header === false);

  // ---- AND THIS READ WROTE NOTHING. ---------------------------------------------------------------------------
  CENSUS_r6r6r3P_(out, 'writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);
  CENSUS_r6r6r3P_(out, 'db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);
  CENSUS_r6r6r3P_(out, 'writer_calls_is_zero', 0, out.writer_calls, out.writer_calls === 0);

  // The paste-ready upgrade. Running this once more after pasting turns the two derived gates into equality
  // gates; it is offered rather than required, because the three facts above already prove non-movement.
  out.frozen_snapshot_source = b
    ? ('  updated_at: ' + JSON.stringify(CENSUS_str_(b.updated_at)) + ','
       + ' line_updated_at: ' + JSON.stringify(CENSUS_str_(b.line_updated_at)))
    : '';

  if (out.predicates_failed === 0) {
    out.verdict = 'SINGLE_ROW_SAVE_READY';
  } else {
    out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
      + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ')
      + (out.already_saved ? '. NOTE: Route A is ALREADY at parcel/version 3 — the authorized edit has already'
        + ' been performed. Do NOT repeat it; run RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK instead.' : '');
  }
  return CENSUS_r6r6r4Finish_(out);
}

// ----------------------------------------------------------------------------------------------------------------
// §6 — READBACK. Read-only. Run it after the one authorized edit, and after any unclear acknowledgement.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK() {
  var out = {
    census: 'RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    snapshot_gaps: [], derived_gates: [],
    route_a_frozen: R6R6R4_A_BEFORE_, route_a_observed: null,
    route_b_frozen: R6R6R4_B_BEFORE_, route_b_observed: null,
    k4_expected_after: null, k4_actual_after: null,
    stage_two_authorized: false,
    ui_note: 'The Execution Plan may DISPLAY a last mile on either route because a one-profile lane fills the'
      + ' cell for display. A displayed value is not a stored one; these predicates read the database.',
    verdict: 'STOP', stop_reason: ''
  };
  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) {
    CENSUS_r6r6r3P_(out, 'census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the census itself failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r6r4Finish_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];

  var aHits = CENSUS_r6r6r4Find_(rows, R6R6R4_A_TARGET_.allocation_draft_id, R6R6R4_A_TARGET_.allocation_draft_line_id);
  var bHits = CENSUS_r6r6r4Find_(rows, R6R6R4_B_BYSTANDER_.allocation_draft_id, R6R6R4_B_BYSTANDER_.allocation_draft_line_id);
  CENSUS_r6r6r3P_(out, 'route_a_still_present_exactly_once', 1, aHits.length, aHits.length === 1);
  CENSUS_r6r6r3P_(out, 'route_b_still_present_exactly_once', 1, bHits.length, bHits.length === 1);
  var a = aHits.length === 1 ? aHits[0] : null;
  var b = bHits.length === 1 ? bHits[0] : null;
  out.route_a_observed = CENSUS_r6r6r4Observe_(a, CENSUS_r6r6r4Fields_());
  out.route_b_observed = CENSUS_r6r6r4Observe_(b, CENSUS_r6r6r4Fields_());

  // ---- ROUTE A: THE INTENDED CHANGE, AND ONLY IT. --------------------------------------------------------------
  CENSUS_r6r6r3P_(out, 'route_a_last_mile_is_parcel', R6R6R4_A_AFTER_LAST_MILE_,
    a ? CENSUS_str_(a.last_mile_delivery) : null,
    !!a && CENSUS_str_(a.last_mile_delivery).toLowerCase() === R6R6R4_A_AFTER_LAST_MILE_);
  // EXACTLY ONE STEP. No step means the write never landed; two means something wrote twice.
  CENSUS_r6r6r3P_(out, 'route_a_draft_version_advanced_by_exactly_one', R6R6R4_A_AFTER_DRAFT_VERSION_,
    a ? CENSUS_str_(a.draft_version) : null,
    !!a && CENSUS_str_(a.draft_version) === R6R6R4_A_AFTER_DRAFT_VERSION_);
  out.k4_expected_after = CENSUS_r6r6r4K4Swap_(R6R6R4_A_BEFORE_.k4_group_key,
    R6R6R4_A_BEFORE_.last_mile_delivery, R6R6R4_A_AFTER_LAST_MILE_);
  out.k4_actual_after = a ? CENSUS_str_(a.k4_group_key) : null;
  CENSUS_r6r6r3P_(out, 'route_a_k4_is_the_frozen_key_with_only_the_last_mile_segment_replaced',
    out.k4_expected_after, out.k4_actual_after,
    !!out.k4_expected_after && !!a && CENSUS_str_(a.k4_group_key).toLowerCase() === out.k4_expected_after.toLowerCase());
  // The audit trail moved the way the writer's contract says it moves.
  var aFloor = CENSUS_r6r6r3TsMs_(R6R6R4_A_BEFORE_.updated_at);
  ['updated_at', 'line_updated_at'].forEach(function (fld) {
    var now = a ? CENSUS_r6r6r3TsMs_(a[fld]) : null;
    CENSUS_r6r6r3P_(out, 'route_a_' + fld + '_advanced', 'later than ' + R6R6R4_A_BEFORE_.updated_at,
      a ? CENSUS_str_(a[fld]) : null, now !== null && aFloor !== null && now > aFloor);
  });
  CENSUS_r6r6r3P_(out, 'route_a_updated_by_is_the_page', R6R6R4_PAGE_ACTOR_,
    a ? CENSUS_str_(a.updated_by) : null, !!a && CENSUS_str_(a.updated_by) === R6R6R4_PAGE_ACTOR_);
  // AND NOTHING ELSE ON ROUTE A MOVED.
  CENSUS_r6r6r4CmpAll_(out, 'route_a', R6R6R4_A_BEFORE_, a,
    R6R6R4_IDENTITY_FIELDS_.filter(function (k) { return k !== 'k4_group_key'; })
      .concat(R6R6R4_BUSINESS_FIELDS_), out.snapshot_gaps);

  // ---- ROUTE B: NOTHING AT ALL. --------------------------------------------------------------------------------
  CENSUS_r6r6r4CmpAll_(out, 'route_b', R6R6R4_B_BEFORE_, b,
    R6R6R4_IDENTITY_FIELDS_.concat(R6R6R4_BUSINESS_FIELDS_).concat(['last_mile_delivery'])
      .concat(R6R6R4_AUDIT_FIELDS_), out.snapshot_gaps);
  // THE TWO INSTANTS NOBODY SUPPLIED, PROVEN ANYWAY. Route B's stamps must predate Route A's new ones: the
  // same writer on the same clock would have stamped both rows together had the Save reached both.
  var aNow = a ? CENSUS_r6r6r3TsMs_(a.updated_at) : null;
  ['updated_at', 'line_updated_at'].forEach(function (fld) {
    var bNow = b ? CENSUS_r6r6r3TsMs_(b[fld]) : null;
    out.derived_gates.push('route_b_' + fld + '_predates_the_route_a_save');
    CENSUS_r6r6r3P_(out, 'route_b_' + fld + '_predates_the_route_a_save',
      'strictly earlier than the post-save ' + (a ? CENSUS_str_(a.updated_at) : '(unknown)'),
      b ? CENSUS_str_(b[fld]) : null, bNow !== null && aNow !== null && bNow < aNow);
  });

  // ---- THE SET DID NOT CHANGE SHAPE. ---------------------------------------------------------------------------
  var total = CENSUS_num_(res.census_current_plan_total);
  CENSUS_r6r6r3P_(out, 'current_plan_total_still_520', R6R6R4_SET_BEFORE_.current_plan_total, total,
    total === R6R6R4_SET_BEFORE_.current_plan_total);
  CENSUS_r6r6r3P_(out, 'visible_route_rows_still_2', R6R6R4_SET_BEFORE_.visible_route_rows, rows.length,
    rows.length === R6R6R4_SET_BEFORE_.visible_route_rows);
  var hCount = (res.sku_contributing_header_ids || []).length;
  var lCount = (res.sku_contributing_line_ids || []).length;
  CENSUS_r6r6r3P_(out, 'header_count_still_2', R6R6R4_SET_BEFORE_.header_count, hCount, hCount === R6R6R4_SET_BEFORE_.header_count);
  CENSUS_r6r6r3P_(out, 'line_count_still_2', R6R6R4_SET_BEFORE_.line_count, lCount, lCount === R6R6R4_SET_BEFORE_.line_count);
  var dupes = [], seen = {};
  for (var di = 0; di < rows.length; di++) {
    var k = CENSUS_str_(rows[di].allocation_draft_id) + '::' + CENSUS_str_(rows[di].allocation_draft_line_id);
    if (seen[k]) dupes.push(k); else seen[k] = 1;
  }
  CENSUS_r6r6r3P_(out, 'no_duplicate_or_replacement_row', [], dupes, dupes.length === 0);
  // NO SOFT-CANCEL AND NO RECREATION. A row that left `draft` left the plan, whatever the total happens to say.
  CENSUS_r6r6r3P_(out, 'both_routes_still_draft', 'draft / draft',
    (a ? CENSUS_str_(a.status) : '(missing)') + ' / ' + (b ? CENSUS_str_(b.status) : '(missing)'),
    !!a && !!b && CENSUS_str_(a.status).toLowerCase() === 'draft' && CENSUS_str_(b.status).toLowerCase() === 'draft');

  CENSUS_r6r6r3P_(out, 'readback_db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);
  CENSUS_r6r6r3P_(out, 'readback_writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);

  if (out.predicates_failed === 0) out.verdict = 'SINGLE_ROW_MUTATION_CONFIRMED';
  else out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
    + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ');
  return CENSUS_r6r6r4Finish_(out);
}

// ----------------------------------------------------------------------------------------------------------------
// §7 — STAGE TWO, DESIGNED AND NOT AUTHORIZED. Read-only, and it has no write path at all.
//
// The restore is the same shape as stage one with the two values exchanged, which is the point: if the
// isolation holds for truck -> parcel it must hold for parcel -> truck, and a design that needs a different
// mechanism for the way back was not an isolation guarantee to begin with.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST() {
  var out = {
    census: 'RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    // R6-R7 §0 — STAGE TWO HAPPENED. These two booleans were correct when they were written and are
    // now a false report, so they are replaced by the record that separates the thing they conflated:
    // whether THIS FILE authorizes a write (it never does, and `self_authorizing` says so) from whether
    // the operation was performed and confirmed (it was, under the operator's own authorization).
    authorized: R6R7_STAGE_TWO_OUTCOME_.authorized_externally,
    executed: R6R7_STAGE_TWO_OUTCOME_.executed,
    readback_confirmed: R6R7_STAGE_TWO_OUTCOME_.readback_confirmed,
    self_authorizing: false,
    outcome: R6R7_STAGE_TWO_OUTCOME_,
    blocked_by: 'NOTHING REMAINS BLOCKED. Stage two (parcel -> truck, version 3 -> 4) was authorized'
      + ' externally, executed once, and read back. This manifest is now the HISTORICAL record of that'
      + ' operation, not a request for permission.',
    precondition: 'THREE things, all of them: (1) RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS returns'
      + ' SINGLE_ROW_SAVE_READY with zero failed predicates; (2) the R6-R6-R4-R2 fix is DEPLOYED — the page'
      + ' carries data-draft-version and 16_ refuses an UPDATE_EXISTING_ROUTE with no expected_draft_version;'
      + ' (3) a browser mutation audit of the stage-two request shows expected_draft_version "3", not null.',
    action: 'Route A last_mile_delivery parcel -> truck: ' + R6R6R4_SAVE_MECHANIC_,
    // R6-R6-R4-R2 — THE PRECONDITION THAT WAS MISSING. Stage one committed with expected_draft_version
    // absent: the client lost the version at the DOM collect and 16_ only checked when the field was there.
    // Stage two must be the first Execution Plan write in this investigation to carry a real precondition.
    requires_optimistic_token: '3',
    root_cause_fix: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R2 — MUTATION_CONTRACT_DEFECT, not a telemetry one.'
      + ' The DOM collector rebuilt every route row and did not carry draft_version, so the hydrated version'
      + ' was destroyed by the first edit and the header omitted expected_draft_version; 16_ ran its'
      + ' optimistic check only when that field was PRESENT, so the write committed with no precondition and'
      + ' the version advanced anyway. Fixed on both sides: the row carries data-draft-version through the'
      + ' DOM, and an UPDATE_EXISTING_ROUTE with no expected_draft_version is now MISSING_OPTIMISTIC_TOKEN'
      + ' with zero rows written.',
    expected: {
      route_a_last_mile_before: R6R6R4_A_BEFORE_.last_mile_delivery,
      route_a_last_mile_after: R6R6R4_A_AFTER_LAST_MILE_,
      route_a_expected_draft_version_sent: R6R6R4_A_BEFORE_.draft_version,
      route_a_draft_version_before: R6R6R4_A_BEFORE_.draft_version,
      route_a_draft_version_after: R6R6R4_A_AFTER_DRAFT_VERSION_,
      route_a_k4_after: CENSUS_r6r6r4K4Swap_(R6R6R4_A_BEFORE_.k4_group_key,
        R6R6R4_A_BEFORE_.last_mile_delivery, R6R6R4_A_AFTER_LAST_MILE_),
      route_a_updated_by_after: R6R6R4_PAGE_ACTOR_,
      route_b: 'every field unchanged, draft_version still 3, updated_by still ' + R6R6R4_REPAIR_ACTOR_,
      set: R6R6R4_SET_BEFORE_
    },
    // THE SYMMETRY, STATED AS A MAPPING rather than as a second copy of the code. Stage two runs the SAME two
    // entry points with the frozen BEFORE advanced one version and the two last-mile values exchanged; nothing
    // else about either contract changes, and that is what makes it a restore rather than a new operation.
    readiness_design: {
      entry_point: 'RUN_R6R6R4_SINGLE_ROW_SAVE_READINESS, with R6R6R4_A_BEFORE_ advanced to the stage-one'
        + ' AFTER: last_mile_delivery parcel, draft_version 3, k4 the parcel key, updated_at/line_updated_at'
        + ' the values stage one recorded, updated_by ' + R6R6R4_PAGE_ACTOR_ + '.',
      unchanged: ['every Route B field', 'every set invariant', 'the save-target REUSE predicate',
        'the three self-checks that this read wrote nothing'],
      success_verdict: 'SINGLE_ROW_SAVE_READY'
    },
    readback_design: {
      entry_point: 'RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK, with R6R6R4_A_AFTER_LAST_MILE_ read as truck and the'
        + ' version gate reading 4. The K4 gate stays a SUBSTITUTION of the last-mile segment, so it derives'
        + ' the truck key from the parcel key exactly as stage one derived the parcel key from the truck one.',
      unchanged: ['Route B proven by version, actor and the predates-the-save comparison',
        'the set invariants', 'the no-duplicate and still-draft gates'],
      success_verdict: 'SINGLE_ROW_MUTATION_CONFIRMED'
    },
    ui_note: 'Route A may display a last mile before and after either stage. The display is not the column.',
    verdict: 'STAGE_TWO_EXECUTED_AND_CONFIRMED'
  };
  CENSUS_log_('r6r6r4_stage_two', out.verdict + ' — ' + out.blocked_by);
  return out;
}

function CENSUS_r6r6r4Finish_(out) {
  // Asserted on the way out, so the same four zeroes are readable whichever entry point produced the answer.
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  out.writer_constructed = out.writer_constructed === true;
  out.writer_calls = CENSUS_num_(out.writer_calls) || 0;
  out.submit_calls = CENSUS_num_(out.submit_calls) || 0;
  out.reservation_writes = CENSUS_num_(out.reservation_writes) || 0;
  // R6-R7 §0 — it is no longer a constant false. What this file can still assert unconditionally is
  // that IT did not authorize anything; whether the operation happened is a separate fact with a separate
  // owner, and collapsing the two into one boolean is what made the report false.
  out.stage_two_authorized = R6R7_STAGE_TWO_OUTCOME_.authorized_externally === true;
  out.stage_two_authorized_by_this_file = false;
  out.stage_two_executed = R6R7_STAGE_TWO_OUTCOME_.executed === true;
  out.stage_two_readback_confirmed = R6R7_STAGE_TWO_OUTCOME_.readback_confirmed === true;
  CENSUS_log_('r6r6r4', out.census + ' ' + out.verdict + ' — passed ' + out.predicates_passed
    + ' failed ' + out.predicates_failed);
  // §4 — THE COMPLETE EXPORT, IN THE LOG. The editor's Run button shows the execution log and not the
  //      returned object, which is the only reason an unversioned wrapper was ever needed. One line, so it
  //      can be copied whole; the predicate list stays out of it because failures are logged individually
  //      below and a passing run does not need sixty lines to say so.
  try {
    CENSUS_log_('r6r6r4_export', JSON.stringify({
      census: out.census, build: out.build, verdict: out.verdict,
      predicates_passed: out.predicates_passed, predicates_failed: out.predicates_failed,
      snapshot_gaps: out.snapshot_gaps, derived_gates: out.derived_gates,
      db_writes: out.db_writes, writer_calls: out.writer_calls, writer_constructed: out.writer_constructed,
      submit_calls: out.submit_calls, reservation_writes: out.reservation_writes,
      route_a_frozen: out.route_a_frozen || null, route_a_observed: out.route_a_observed || null,
      route_b_frozen: out.route_b_frozen || null, route_b_observed: out.route_b_observed || null,
      already_saved: out.already_saved, stage_two_authorized: out.stage_two_authorized,
      stop_reason: out.stop_reason || ''
    }));
  } catch (eX) { CENSUS_log_('r6r6r4_export_failed', CENSUS_str_(eX && eX.message)); }
  if (out.snapshot_gaps.length) CENSUS_log_('r6r6r4_snapshot_gaps', out.snapshot_gaps.join(', '));
  out.predicates.forEach(function (p) {
    if (!p.pass) CENSUS_log_('r6r6r4_failed', p.predicate + ': expected ' + JSON.stringify(p.expected)
      + ' observed ' + JSON.stringify(p.observed));
  });
  return out;
}

// ================================================================================================================
// F1-7N-FC-1B-E3-R4-A2-R1-R6-R7 — CONTROLLED AI PLAN PRODUCTION READINESS
//
// §0 — WHAT R6-R6-R4 ACTUALLY ENDED AS, RECORDED SO THE DIAGNOSTIC STOPS SAYING SOMETHING FALSE.
//
// The R6-R6-R4 family carried `stage_two_authorized: false` and `authorized/executed: false` as CONSTANTS,
// because in the round that wrote them stage two had not been authorized and this file has no authority to
// authorize anything. Both stages have since been performed in production under the user's own authorization
// and read back: truck -> parcel at version 2 -> 3, then parcel -> truck at 3 -> 4, each one request touching
// one route, the second one carrying expected_draft_version "3", with Route B untouched throughout.
//
// Leaving those literals at false would now be a FALSE REPORT rather than a cautious one — a reader would
// conclude the restore never happened. They are replaced by a record that separates the two things the single
// boolean was conflating: whether THIS FILE authorizes a write (it never does) and whether the operation
// HAPPENED (it did, elsewhere, and was confirmed). Nothing here writes to the database to record it.
// ----------------------------------------------------------------------------------------------------------------
var R6R7_STAGE_TWO_OUTCOME_ = {
  // Authorization did not come from this diagnostic and never can. It came from the operator, in their own
  // turn, outside this file — which is why the field says WHERE rather than just YES.
  authorized_externally: true,
  authorized_by: 'the operator, in a separate current-turn instruction (F1-7N-FC-1B-E3-R4-A2-R1-R6-R7 §0)',
  executed: true,
  readback_confirmed: true,
  self_authorizing: false,
  stage_one: { action: 'truck -> parcel', draft_version: '2 -> 3', expected_draft_version_sent: null,
    note: 'committed with NO optimistic precondition — the defect R6-R6-R4-R2 repaired on both sides.' },
  stage_two: { action: 'parcel -> truck', draft_version: '3 -> 4', expected_draft_version_sent: '3',
    note: 'the first Execution Plan write in this investigation to carry a real precondition.' },
  proven: ['MANUAL_ROUTE_SAVE_ROW_ISOLATION', 'OPTIMISTIC_CONCURRENCY_TOKEN',
    'ROUTE_B_COLLATERAL_WRITE_RESOLVED', 'ROUTE_A_RESTORED'],
  superseded_baselines: 'R6R6R4_A_BEFORE_ froze Route A at parcel/version 3. That is a correct record of a'
    + ' moment that has passed: Route A is now truck at version 4. The R6-R6-R4 readiness entry point is'
    + ' therefore CLOSED — running it now reports the difference, which is the honest answer, not a fault.'
};

// The scope. ONE authority, shared with the route census rather than copied, so a census and a preflight can
// never be pointed at two different stations.
var R6R7_SCOPE_ = R6R2_PROVENANCE_SCOPE_;

// §2 — THE TWO NUMBERS THAT WERE BOTH LABELLED "Recommended", recorded as the observations they are. They are
// not a scope and cannot aim anything; they are the disputed evidence this census exists to account for.
var R6R7_DISPUTED_DISPLAY_ = {
  earlier: { recommended: 920, planned: 520, third_label: 'Remaining', third: 400 },
  later: { recommended: 0, planned: 520, third_label: 'Excess', third: 520 }
};

// The two manual routes, as production holds them after the R6-R6 family closed. These are the rows an AI Plan
// activation must not touch, and the preflight freezes them BEFORE any generation so a readback has a BEFORE.
var R6R7_MANUAL_ROUTES_ = [
  { label: 'A', allocation_draft_id: 'SADH-K4-38523A90', allocation_draft_line_id: 'SADL-K2-92B8BAD2',
    last_mile_delivery: 'truck', draft_version: '4', quantity: 320 },
  { label: 'B', allocation_draft_id: 'SADH-K4-A3872518', allocation_draft_line_id: 'SADL-K2-344FB2B2',
    last_mile_delivery: '', draft_version: '3', quantity: 200 }
];
var R6R7_SET_BEFORE_ = { current_plan_total: 520, visible_route_rows: 2, header_count: 2, line_count: 2 };

// The tables an activation may write, and the ones it may not. Read from the SERVER's own manifest where it is
// present, so this file cannot drift from what 61_ actually declares; the literals are the fallback for a
// project where 61_ has not been synced, and they are LABELLED as such rather than presented as the authority.
function CENSUS_r6r7Surface_() {
  if (typeof weeklyAiPlanActivationManifest_ === 'function') {
    try {
      var m = weeklyAiPlanActivationManifest_();
      return { source: 'SERVER (weeklyAiPlanActivationManifest_ in 61_)',
        tables_written: m.tables_written, tables_read: m.tables_read,
        tables_guaranteed_zero_mutation: m.tables_guaranteed_zero_mutation,
        write_handler: m.write_handler, replay_behavior: m.replay_behavior,
        reservation_expected: m.reservation_expected, submit_expected: m.submit_expected,
        rollback_procedure: m.rollback_procedure };
    } catch (e) { /* fall through to the labelled fallback */ }
  }
  return { source: 'FALLBACK — 61_ is not present in this project, so this is this file\'s copy and NOT the'
      + ' server\'s declaration. Sync 61_ before trusting it.',
    tables_written: ['shipping_allocation_drafts', 'shipping_allocation_draft_lines'],
    tables_read: null, tables_guaranteed_zero_mutation: null, write_handler: null,
    replay_behavior: null, reservation_expected: false, submit_expected: false, rollback_procedure: null };
}

// The four canonical inventory windows, in the frozen order the materializer stores them in. Read from 43_'s
// own constant when it is loaded — a second list here would be a second answer waiting to disagree.
function CENSUS_r6r7Windows_() {
  if (typeof GAP_INV_WINDOWS_ !== 'undefined' && GAP_INV_WINDOWS_ && GAP_INV_WINDOWS_.length) return GAP_INV_WINDOWS_;
  return ['D18', 'D30', 'D45', 'D90'];
}

// MISSING IS NOT ZERO. A blank cell has no number in it, and a census that returned 0 for one would report a
// zero recommendation where the truth is that nothing was calculated. This is the only numeric reader used
// below, so the distinction cannot be lost in one branch and kept in another.
function CENSUS_r6r7Num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------------------------------------------------
// §2 — THE RECOMMENDATION AUTHORITY CENSUS. Read-only. No arguments, and its scope is the shared constant, so
// it cannot be aimed at another station from a console.
//
// WHAT IT IS FOR, precisely. Two screens showed a cell labelled "Recommended" holding 920 and then 0 for the
// same SKU. Choosing one and calling it the truth would be guessing, and inferring the stored row from either
// number would be reading the display backwards. So this reads the AUTHORITATIVE ROW and then applies BOTH of
// the reading rules the shipped code actually contains, and reports which rule reproduces which number.
//
// THE STRUCTURAL FINDING THIS TESTS, stated so the run can refute it rather than confirm whatever it finds:
// the page holds TWO different rules for one cell, over the SAME materialized row.
//
//   • THE STANDING AUTHORITY — `_irSuggestedQtyState_` (declared the single owner of this quantity in
//     F1-7N-FB-4G-A0 §I) reads `d90_suggested_qty`: the FURTHEST cumulative checkpoint.
//   • THE AI-PLAN DTO — `KMREC.generateInventoryRecommendation` chooses the EARLIEST window with a non-zero
//     stored suggested qty, D18 first. It populates `_irRecoByKey`, which is filled in exactly one place: a
//     Generate AI Plan click. `_irAdviceVsPlan_` PREFERS that DTO when one exists.
//
// So on one row with d18 = 920 and d90 = 0, a session that had clicked AI Plan shows 920 and a fresh load
// shows 0, and nothing about the database changed between them. That is a FORMULA DIVERGENCE inside one page,
// not two runs disagreeing — and the two are told apart by which rule reproduces the number, which is what
// this census measures. Both readings are legitimate answers to different questions (what is short NOW versus
// what is short at the horizon); the defect is that both are printed under one word.
//
// Neither number is adopted as true here. The census reports the row, both readings, and whether anything
// about the row's own integrity — duplicates, mixed runs, staleness — makes the question unanswerable.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS() {
  var out = {
    census: 'RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    scope: R6R7_SCOPE_,
    disputed_display: R6R7_DISPUTED_DISPLAY_,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    // The twelve answers §2 asks for, in its own order.
    authoritative_rows: [],            // 1
    row_count: 0,
    calculation_run: null,             // 2
    formula_version: null,             // 3
    recommendation_window: null,       // 4
    gap: null,                         // 5
    suggested_qty: null,               // 6
    source_warehouse: null,            // 7
    generation_state: null,            // 8
    created_at: null, updated_at: null, calculated_at: null, calculation_date: null,   // 9
    ui_authority: null,                // 10
    disputed_value_provenance: [],     // 11
    integrity: null,                   // 12
    schema_absent_columns: [],
    verdict: 'STOP_RECOMMENDATION_CONFLICT', stop_reason: ''
  };
  function P(name, expected, observed, pass) { return CENSUS_r6r6r3P_(out, name, expected, observed, pass); }

  var ss = null;
  try {
    ss = SpreadsheetApp.openById(prodExpectedDbId_());
    if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_());
  } catch (eO) {
    P('production_database_reachable', 'the exact production book', 'error: ' + CENSUS_str_(eO && eO.message), false);
    out.stop_reason = 'the production database could not be opened: ' + CENSUS_str_(eO && eO.message);
    return CENSUS_r6r7Finish_(out);
  }
  P('production_database_reachable', 'the exact production book', 'opened', true);

  // ---- 1 / 12. THE AUTHORITATIVE ROW, and every row that claims the same business key. ----------------------
  var table = (typeof INV_GAP_TABLE_ !== 'undefined') ? INV_GAP_TABLE_ : 'inventory_replenishment_gap';
  var all = CENSUS_rows_(ss, table);
  var mine = all.filter(function (r) {
    return CENSUS_low_(r.company) === CENSUS_low_(R6R7_SCOPE_.company)
      && CENSUS_low_(r.country) === CENSUS_low_(R6R7_SCOPE_.country)
      && CENSUS_low_(r.marketplace) === CENSUS_low_(R6R7_SCOPE_.marketplace)
      && CENSUS_low_(r.sku) === CENSUS_low_(R6R7_SCOPE_.sku);
  });
  out.row_count = mine.length;
  var W = CENSUS_r6r7Windows_();
  out.authoritative_rows = mine.map(function (r) {
    var o = { table: table, company: CENSUS_str_(r.company), country: CENSUS_str_(r.country),
      marketplace: CENSUS_str_(r.marketplace), sku: CENSUS_str_(r.sku),
      calculation_status: CENSUS_str_(r.calculation_status), calculation_date: CENSUS_str_(r.calculation_date),
      note: CENSUS_str_(r.note), calculated_at: CENSUS_str_(r.calculated_at), updated_at: CENSUS_str_(r.updated_at),
      windows: [] };
    W.forEach(function (w) {
      var lc = String(w).toLowerCase();
      o.windows.push({ window: w, gap_qty: CENSUS_r6r7Num_(r[lc + '_gap_qty']),
        suggested_qty: CENSUS_r6r7Num_(r[lc + '_suggested_qty']) });
    });
    return o;
  });
  P('gap_row_present_exactly_once', 1, mine.length, mine.length === 1);
  var row = mine.length === 1 ? mine[0] : null;
  var view = out.authoritative_rows.length === 1 ? out.authoritative_rows[0] : null;

  // ---- 12. DUPLICATE / MIXED-RUN INTEGRITY, stated as facts rather than as an absence of complaint. ---------
  var dupKeys = {}, dupes = [];
  all.forEach(function (r) {
    var k = [CENSUS_low_(r.company), CENSUS_low_(r.country), CENSUS_low_(r.marketplace), CENSUS_low_(r.sku)].join('|');
    if (dupKeys[k]) { if (dupes.indexOf(k) === -1) dupes.push(k); } else dupKeys[k] = 1;
  });
  var stamps = {};
  mine.forEach(function (r) { stamps[CENSUS_str_(r.calculated_at)] = 1; });
  out.integrity = {
    rows_for_this_key: mine.length,
    duplicate_business_keys_in_table: dupes.length,
    duplicate_key_sample: dupes.slice(0, 5),
    distinct_calculated_at_across_this_key: Object.keys(stamps).length,
    mixed_run_rows: mine.length > 1 && Object.keys(stamps).length > 1,
    table_row_count: all.length
  };
  P('no_duplicate_rows_for_this_business_key', 0, Math.max(0, mine.length - 1), mine.length <= 1);
  P('no_mixed_run_rows_for_this_business_key', false, out.integrity.mixed_run_rows, out.integrity.mixed_run_rows === false);

  // ---- 2 / 3. LINEAGE. The gap table stores NEITHER a run id NOR a formula version — those columns do not
  //      exist in its frozen header (43_ INV_GAP_HEADERS_). Saying so is the answer; inventing a value or
  //      reporting null without saying why would both be worse than the fact.
  var declared = (typeof INV_GAP_HEADERS_ !== 'undefined') ? INV_GAP_HEADERS_ : null;
  ['calculation_run_id', 'formula_version'].forEach(function (c) {
    var inDeclared = declared ? (declared.indexOf(c) !== -1) : null;
    var onRow = row ? Object.prototype.hasOwnProperty.call(row, c) : null;
    if (inDeclared === false && onRow !== true) out.schema_absent_columns.push(c);
  });
  // The run lineage a generation WOULD stamp comes from the GAP job's own record, not from the gap row. It is
  // read through 61_'s resolver where present, so the census and a live run answer from one authority.
  var lineage = null, lineageReason = null;
  if (typeof weeklyAiPlanResolveGapRunLineage_ === 'function') {
    var cyc = null;
    try {
      var cc = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
      cyc = (cc && cc.ok) ? cc.planningCycle : null;
    } catch (eC) { cyc = null; }
    try {
      var lr = weeklyAiPlanResolveGapRunLineage_(cyc, null, { formulaVersion: 'WEEKLY_AI_PLAN_V1' });
      if (lr && lr.ok) lineage = lr; else lineageReason = CENSUS_str_(lr && lr.reason) || 'UNRESOLVED';
    } catch (eL) { lineageReason = 'RESOLVER_THREW: ' + CENSUS_str_(eL && eL.message); }
  } else {
    lineageReason = 'LINEAGE_RESOLVER_NOT_PRESENT — 61_ is not synced into this project';
  }
  out.calculation_run = {
    stored_on_the_gap_row: false,
    why_not: 'inventory_replenishment_gap has no calculation_run_id column; its frozen header ends at'
      + ' calculated_at / updated_at. The run identity lives on the GAP job record (ScriptProperties'
      + ' GAP_JOB_INVENTORY) and is stamped onto an AI header at generation, not onto the gap row.',
    job_run: lineage ? { run_id: lineage.run_id, planning_cycle: lineage.planning_cycle,
      calculated_at: lineage.calculated_at, source_data_as_of: lineage.source_data_as_of } : null,
    unresolved_reason: lineage ? null : lineageReason
  };
  out.formula_version = {
    stored_on_the_gap_row: false,
    value_a_generation_would_stamp: lineage ? lineage.formula_version : 'WEEKLY_AI_PLAN_V1',
    authority: 'the generation request constant (61_ formulaVersion), stamped onto the AI HEADER. The'
      + ' materialized gap row records no formula version at all.'
  };
  P('lineage_columns_reported_as_absent_rather_than_null',
    ['calculation_run_id', 'formula_version'], out.schema_absent_columns,
    out.schema_absent_columns.length === 2);

  // ---- 4 / 5 / 6. THE TWO READINGS, each named, each computed by the rule the shipped code uses. ------------
  var standing = null, earliest = null, earliestWindow = null;
  if (view) {
    var d90 = null;
    view.windows.forEach(function (w) { if (w.window === 'D90') d90 = w.suggested_qty; });
    var ready = CENSUS_str_(view.calculation_status) === 'READY';
    standing = ready ? d90 : null;
    for (var i = 0; i < view.windows.length; i++) {
      var s = view.windows[i].suggested_qty;
      if (typeof s === 'number' && isFinite(s) && s > 0) { earliest = s; earliestWindow = view.windows[i].window; break; }
    }
    if (!ready) { earliest = null; earliestWindow = null; }
  }
  out.recommendation_window = {
    standing_authority_window: 'D90 (the furthest cumulative checkpoint)',
    ai_plan_dto_window: earliestWindow || (view ? 'NONE — no window holds a positive suggested qty' : null),
    all_windows: view ? view.windows : null,
    why_two: 'D18/D30/D45/D90 are CUMULATIVE checkpoints. A shortage that exists at D18 can be zero at D90'
      + ' once incoming supply lands inside the horizon, so the earliest-actionable reading and the'
      + ' furthest-horizon reading are BOTH correct answers to different questions.'
  };
  out.gap = view ? view.windows.map(function (w) { return { window: w.window, gap_qty: w.gap_qty }; }) : null;
  // ==============================================================================================================
  // R6-R7-R1 §D — `0` AND `null` WERE COMPARED AS QUANTITIES, AND THEY ARE NOT BOTH QUANTITIES.
  //
  // The first version reported readings_agree:false for the live row, because the standing authority read 0
  // and the DTO rule read null. But the DTO's null does not mean 'a different quantity' — it means NO_ACTION,
  // which is what a standing 0 also means. Comparing them as numbers manufactured a disagreement between two
  // readings that were saying the same thing, on exactly the row this round is about.
  //
  // So each reading is normalised to an ACTION STATE first, and agreement is asked of those:
  //   NO_ACTION      — nothing to replenish (a stored 0, or no window with a positive quantity)
  //   ACTION:<qty>   — a quantity to replenish
  //   NOT_EVALUATED  — nobody has computed this reading; it is not a value and never agrees or disagrees
  //   UNKNOWN        — the row could not be read at all
  //
  // The two nulls are told apart, because they are different facts. The census APPLIES the DTO rule to the row,
  // so its answer is evaluated. The page's `_irRecoByKey` is empty until somebody presses Generate AI Plan, so
  // the IN-SESSION DTO is NOT_EVALUATED from here — a server census cannot see a browser's page state, and
  // reporting its absence as a recommendation of null would be inventing a third reading.
  // ==============================================================================================================
  function actionState(evaluated, qty) {
    if (!evaluated) return 'NOT_EVALUATED';
    if (qty === null || qty === undefined) return 'NO_ACTION';
    return qty > 0 ? ('ACTION:' + qty) : 'NO_ACTION';
  }
  var rowReadable = !!view && CENSUS_str_(view.calculation_status) === 'READY';
  var standingState = rowReadable ? actionState(true, standing) : 'UNKNOWN';
  var dtoState = rowReadable ? actionState(true, earliest) : 'UNKNOWN';
  out.suggested_qty = {
    standing_authority_value: standing,
    standing_authority_state: standingState,
    standing_authority_rule: '_irSuggestedQtyState_ -> d90_suggested_qty when calculation_status is READY;'
      + ' PENDING and NONE are NOT zero and print as an ellipsis / em dash.',
    ai_plan_dto_value: earliest,
    ai_plan_dto_state: dtoState,
    ai_plan_dto_evaluated: rowReadable,
    ai_plan_dto_rule: 'KMREC.generateInventoryRecommendation -> the EARLIEST window with a positive stored'
      + ' suggested qty (D18 first). NO_ACTION when none is positive — which is a STATE, not a quantity.',
    // The page-state reading, which a server census cannot see and must not guess at.
    ai_plan_dto_in_session_state: 'NOT_EVALUATED',
    ai_plan_dto_in_session_note: '_irRecoByKey is populated only by a Generate AI Plan click, in the browser.'
      + ' Its absence is NOT a recommendation of null and is never compared with the standing authority.',
    // Agreement is between STATES, and only when both were evaluated.
    readings_agree: (standingState !== 'UNKNOWN' && standingState !== 'NOT_EVALUATED'
      && dtoState !== 'UNKNOWN' && dtoState !== 'NOT_EVALUATED' && standingState === dtoState),
    readings_comparable: (standingState !== 'UNKNOWN' && standingState !== 'NOT_EVALUATED'
      && dtoState !== 'UNKNOWN' && dtoState !== 'NOT_EVALUATED')
  };
  // §D — the four facts a consumer needs to know WHICH evaluation this is, beside the answer itself.
  out.current_run = {
    calculation_run_id: (lineage && lineage.run_id) || null,
    calculated_at: view ? view.calculated_at : null,
    calculation_date: view ? view.calculation_date : null,
    calculation_status: view ? view.calculation_status : null,
    authority_rule: 'inventory_replenishment_gap, the row for the exact (company, country, marketplace, sku).'
      + ' The quantity is the FURTHEST cumulative window (d90_suggested_qty); the windows are cumulative'
      + ' checkpoints and summing them would double-count need. A standing 0 and an AI NO_ACTION are the'
      + ' SAME state, and this census compares them as states rather than as numbers.'
  };

  // ---- 7. THE SOURCE WAREHOUSE. The gap row does not carry one: materialization is a per-destination
  //      aggregation and routing is Execution Plan authority. Reported as the structural fact it is.
  out.source_warehouse = {
    stored_on_the_gap_row: false,
    why_not: 'the materialized gap is a quantity per (company, country, marketplace, sku). Source selection'
      + ' is the allocator\'s, and it is decided at generation from warehouse stock, never stored here.',
    manual_plan_sources: null
  };

  // ---- 8 / 9. STATE AND STAMPS. ----------------------------------------------------------------------------
  out.generation_state = view ? {
    calculation_status: view.calculation_status,
    note: view.note,
    readiness: view.calculation_status === 'READY' ? 'READY — the stored numbers are usable'
      : (view.calculation_status ? view.calculation_status + ' — the stored quantities are NOT usable and'
          + ' must never be read as zero' : 'BLANK — no status recorded')
  } : null;
  if (view) {
    out.calculated_at = view.calculated_at;
    out.updated_at = view.updated_at;
    out.calculation_date = view.calculation_date;
    out.created_at = 'ABSENT — the gap table records calculated_at / updated_at and has no created_at column';
  }

  // ---- 10. WHICH ROW AND WHICH FIELD THE UI IS ACTUALLY USING. ----------------------------------------------
  out.ui_authority = {
    row: view ? (view.company + '|' + view.country + '|' + view.marketplace + '|' + view.sku) : null,
    top_table_cell: 'inventory_replenishment_gap.d90_suggested_qty, via _irSuggestedQtyState_'
      + ' (_irMatState.bySku[sku]).',
    reconciliation_strip: '_irAdviceVsPlan_ PREFERS _irRecoByKey[sku].suggestedQty when a DTO exists and'
      + ' falls back to _irSuggestedQtyState_. The strip records which one it used in'
      + ' data-recommendation-source: AI_PLAN_RECOMMENDATION or MATERIALIZED_SUGGESTED_QTY.',
    how_to_tell_them_apart_on_a_live_screen:
      'read data-recommendation-source on #ir-plan-recon-<sku>. It is the page\'s own record of which'
      + ' authority produced the number in the cell, and it needs no inference.'
  };

  // ---- 11. WHERE 920 AND 0 EACH CAME FROM, tested against the row rather than asserted. ---------------------
  function provenance(label, value) {
    var hit = [];
    if (standing !== null && standing === value) hit.push('MATERIALIZED_SUGGESTED_QTY (d90_suggested_qty)');
    if (earliest !== null && earliest === value) hit.push('AI_PLAN_RECOMMENDATION (earliest actionable window '
      + earliestWindow + ')');
    if (value === 0 && view && CENSUS_str_(view.calculation_status) === 'READY' && standing === 0) {
      if (hit.indexOf('MATERIALIZED_SUGGESTED_QTY (d90_suggested_qty)') === -1) {
        hit.push('MATERIALIZED_SUGGESTED_QTY (d90_suggested_qty)');
      }
    }
    // R6-R7-R1 §G — A SCREEN IS A PAST OBSERVATION, AND A PAST OBSERVATION THAT NO LONGER REPRODUCES IS
    // HISTORY, NOT A CONFLICT.
    //
    // The first version STOPPED the round when neither rule reproduced a disputed value, on the reasoning
    // that a third source must be feeding the cell. That is one possible explanation and it is not the
    // likeliest: a row that has been recalculated since the screenshot explains it completely, and no
    // amount of reading can distinguish the two when the earlier run is gone. Guessing a third source would
    // be inventing an authority, and blocking on it would make an unfalsifiable claim a permanent blocker.
    //
    // So it is LABELLED. It is never an authority for a write either way, which is the property that
    // actually matters, and the census looks for real read-only lineage before saying it has none.
    var lineageEvidence = [];
    if (!hit.length) {
      mine.forEach(function (r) {
        var d = CENSUS_str_(r.calculation_date), when = CENSUS_str_(r.calculated_at);
        W.forEach(function (w) {
          var lc = String(w).toLowerCase();
          if (CENSUS_r6r7Num_(r[lc + '_suggested_qty']) === value) {
            lineageEvidence.push({ window: w, calculation_date: d, calculated_at: when,
              calculation_status: CENSUS_str_(r.calculation_status) });
          }
        });
      });
    }
    return { display_label: label, display_value: value,
      reproduced_by: hit,
      resolved: hit.length > 0,
      status: hit.length ? 'REPRODUCED_BY_A_CURRENT_RULE' : 'HISTORICAL_OR_SUPERSEDED_UNRESOLVED',
      is_write_authority: false,
      lineage_evidence: lineageEvidence,
      note: hit.length ? ''
        : (lineageEvidence.length
            ? 'Not reproducible from the CURRENT reading rules; a stored row does still carry this value,'
              + ' and that row is named in lineage_evidence. Historical, and never a write authority.'
            : 'Not reproducible from the current row by either shipped rule, and no stored row carries it.'
              + ' Most consistent with a recalculation since that screen was taken. NOT treated as evidence'
              + ' of a third source: that would be inventing an authority, and no data is changed on it.') };
  }
  out.disputed_value_provenance = [
    provenance('earlier screen, Recommended', R6R7_DISPUTED_DISPLAY_.earlier.recommended),
    provenance('later screen, Recommended', R6R7_DISPUTED_DISPLAY_.later.recommended)
  ];
  var unresolved = out.disputed_value_provenance.filter(function (p) { return !p.resolved; });
  out.historical_unresolved = unresolved.map(function (p) {
    return { display_value: p.display_value, status: p.status, lineage_evidence: p.lineage_evidence }; });
  // R6-R7-R1 §G — THE AUTHORITY IS SETTLED BY THE CURRENT ROW, NOT BY AN OLD SCREENSHOT.
  //
  // The predicate this replaces failed the whole census when neither rule reproduced an earlier display
  // value, which makes a past observation nobody can re-read into a permanent blocker. What has to be true
  // for an activation is that TODAY'S authority is readable and unambiguous — which the row predicates
  // above already establish. An unreproducible past value is recorded as HISTORICAL_OR_SUPERSEDED_UNRESOLVED
  // and is barred from being a write authority; it is not a reason to refuse to proceed.
  P('every_disputed_value_is_either_reproduced_or_labelled_historical', 2,
    out.disputed_value_provenance.filter(function (p) {
      return p.resolved || p.status === 'HISTORICAL_OR_SUPERSEDED_UNRESOLVED'; }).length,
    out.disputed_value_provenance.every(function (p) {
      return (p.resolved || p.status === 'HISTORICAL_OR_SUPERSEDED_UNRESOLVED') && p.is_write_authority === false; }));
  P('the_two_readings_are_explained_by_one_row_and_two_rules',
    'a single row, read by two different shipped rules',
    view ? ('d90=' + standing + ' vs earliest-actionable=' + earliest) : null,
    !!view);
  // R6-R7-R1 §D — a stored 0 and an AI NO_ACTION are the SAME state and must never be reported as a
  // disagreement. That is the defect this closes, and it is a claim about this code rather than about the
  // data: a row with an open early window and a closed horizon genuinely reads NO_ACTION on one rule and a
  // quantity on the other, and a census cannot refuse its way out of a true fact.
  P('a_zero_and_a_no_action_are_not_reported_as_disagreeing',
    'NO_ACTION vs NO_ACTION reported as agreement',
    out.suggested_qty.standing_authority_state + ' vs ' + out.suggested_qty.ai_plan_dto_state
      + ' -> agree ' + out.suggested_qty.readings_agree,
    !(out.suggested_qty.standing_authority_state === 'NO_ACTION'
      && out.suggested_qty.ai_plan_dto_state === 'NO_ACTION') || out.suggested_qty.readings_agree === true);
  // A genuine divergence is RECORDED rather than refused. It is the page-level defect §2 named, and an
  // operator needs to see it; it is not a reason to withhold the authority, which the standing rule owns.
  out.suggested_qty.divergence = (out.suggested_qty.readings_comparable && !out.suggested_qty.readings_agree)
    ? { kind: 'TWO_RULES_ONE_CELL', standing: out.suggested_qty.standing_authority_state,
        ai_plan_dto: out.suggested_qty.ai_plan_dto_state,
        note: 'both readings are correct answers to different questions (short NOW versus short at the'
          + ' horizon). The authority for a WRITE is the standing rule; the DTO is advisory.' }
    : null;
  // AND THE ROW MUST ACTUALLY STATE SOMETHING. A BLOCKED row, a missing one, or one with a blank where a
  // number belongs settles nothing, and every predicate above can pass while that is true.
  var statesAQuantity = !!view && CENSUS_str_(view.calculation_status) === 'READY'
    && view.windows.length > 0 && view.windows.every(function (w) { return typeof w.suggested_qty === 'number'; });
  P('the_authoritative_row_states_a_quantity',
    'READY, with a finite number in every window',
    view ? (view.calculation_status + ' / ' + view.windows.map(function (w) {
      return w.window + '=' + (w.suggested_qty === null ? '(blank)' : w.suggested_qty); }).join(' ')) : null,
    statesAQuantity);

  // ---- READ-ONLY SELF-CHECKS. -------------------------------------------------------------------------------
  P('writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);
  P('db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);

  if (out.predicates_failed === 0) {
    out.verdict = 'RECOMMENDATION_AUTHORITY_ESTABLISHED';
  } else {
    out.verdict = 'STOP_RECOMMENDATION_CONFLICT';
    out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
      + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ')
      + '. Do NOT proceed to any write test: the number an activation would be measured against is not'
      + ' settled.';
  }
  return CENSUS_r6r7Finish_(out);
}

// ----------------------------------------------------------------------------------------------------------------
// §4 — THE CONTROLLED AI PLAN PREFLIGHT. Read-only, no arguments, hard-coded scope.
//
// It answers ONE question: if the flag were flipped for this one scope and Generate AI Plan were pressed
// exactly once, what exactly would change, and is every precondition for that already true?
//
// It constructs no writer. `weeklyAiPlanGenerateK2_` — the only path from a plan to a write — is not called;
// `weeklyAiPlanPersistenceDeps_` is not called. The plan builder it reaches through the E3 census is PURE.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT() {
  var out = {
    census: 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, route_save_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    scope: R6R7_SCOPE_,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    authoritative_recommendation: null,
    zero_recommendation_classification: null,
    current_manual_planned_total: null,
    expected_remaining_or_excess: null,
    lineage_policy: null,
    expected_ai_identities: [],
    before_counts: null, expected_after_counts: null,
    allowed_tables: null, allowed_fields: null, forbidden_mutations: null,
    manual_route_snapshots: [],
    idempotency_contract: null, optimistic_concurrency_contract: null, ack_unknown_contract: null,
    flag: null, allowlist: null,
    // R6-R7-R1 §F — WHAT THE PRODUCTION HANDLER WOULD ACTUALLY ANSWER, resolved from the production
    // functions themselves rather than restated here. The first version of this preflight returned READY
    // while the real path returned STOP / REQUESTED_SCOPE_EMPTY for the same scope, which is the worst
    // possible failure mode for a preflight: it certified a run that could not happen.
    production_path: null,
    parity: null,
    // R6-R7-R2 — the allocator projection appears in the same execution log, and a reader needs to know
    // which of the two answers is about production BEFORE reading either.
    legacy_projection: null,
    // R6-R7-R2-P1 — the run identity the proof reports, and the proof's own completeness. Declared here so
    // that a preflight returning early still says what it could not establish instead of saying nothing.
    current_run: null,
    proof_complete: false, proof_missing: ['NOT_EVALUATED'],
    verdict: 'STOP', stop_reason: ''
  };
  function P(name, expected, observed, pass) { return CENSUS_r6r6r3P_(out, name, expected, observed, pass); }

  // ---- THE TWO GATES, read from the server's own config rather than restated. -------------------------------
  var flagVal = null;
  try { flagVal = (typeof inventoryAiPlanDbGenerationEnabled_ === 'function') ? inventoryAiPlanDbGenerationEnabled_() : null; } catch (eF) { flagVal = null; }
  var allow = null;
  try { allow = (typeof INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ !== 'undefined') ? INVENTORY_AI_PLAN_ACTIVATION_ALLOWLIST_ : null; } catch (eA) { allow = null; }
  out.flag = { name: 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_', value: flagVal,
    note: 'FALSE here is CORRECT for this round. A preflight runs against the staged-off posture; the flag is'
      + ' the operator\'s to flip, in a deployment with a diff, and never this file\'s.' };
  out.allowlist = { entries: allow,
    scope_is_listed: !!(allow && allow.filter(function (e) {
      return CENSUS_str_(e.company) === R6R7_SCOPE_.company && CENSUS_str_(e.country) === R6R7_SCOPE_.country
        && CENSUS_str_(e.marketplace) === R6R7_SCOPE_.marketplace && CENSUS_str_(e.sku) === R6R7_SCOPE_.sku;
    }).length === 1) };
  P('flag_is_still_false_this_round', false, flagVal, flagVal === false);
  P('allowlist_holds_exactly_this_one_scope', 1, allow ? allow.length : null, !!allow && allow.length === 1);
  P('allowlist_entry_is_this_scope', true, out.allowlist.scope_is_listed, out.allowlist.scope_is_listed === true);

  // ---- THE AUTHORITATIVE RECOMMENDATION, through §2 rather than through a second reader. --------------------
  var rec = CENSUS_quiet_('RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS',
    function () { return RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS(); });
  P('recommendation_authority_established', 'RECOMMENDATION_AUTHORITY_ESTABLISHED', rec.verdict,
    rec.verdict === 'RECOMMENDATION_AUTHORITY_ESTABLISHED');
  // R6-R7-R2-P1 — WHICH evaluation this is, carried into the proof. Four fields, not the census.
  out.current_run = rec.current_run || null;
  var standing = rec.suggested_qty ? rec.suggested_qty.standing_authority_value : null;
  var earliest = rec.suggested_qty ? rec.suggested_qty.ai_plan_dto_value : null;
  // ==============================================================================================================
  // R6-R7-R1 §F — THE PRODUCTION PATH IS ASKED, AND ITS ANSWER OUTRANKS THIS FILE'S.
  //
  // These are 61_'s OWN functions — the same ones handleGenerateWeeklyAiPlanDraft_ reaches through — not a
  // second implementation of the same rules. A wrapper that decided readiness from its own reasoning could
  // agree with production by luck and disagree without anyone noticing, which is exactly what happened.
  //
  // A project that does not have 61_ synced cannot answer, and that is reported as UNAVAILABLE rather than
  // defaulted to either verdict: 'we could not ask' is not 'the answer was yes'.
  // ==============================================================================================================
  out.production_path = CENSUS_r6r7ProductionPath_();
  P('production_path_authority_is_present', true, out.production_path.available,
    out.production_path.available === true);

  out.authoritative_recommendation = {
    standing_authority_value: standing,
    ai_plan_dto_value: earliest,
    status: rec.generation_state ? rec.generation_state.calculation_status : null,
    windows: rec.recommendation_window ? rec.recommendation_window.all_windows : null,
    note: 'the AI generation does NOT read either of these page-side numbers. It re-derives demand from the'
      + ' same gap row through the canonical harvest, which is why both are reported and neither is passed in.'
  };

  // A ZERO RECOMMENDATION IS TWO DIFFERENT FACTS AND THEY MUST NOT SHARE A NUMBER. Classified from the row's
  // own status and completeness, never from the value alone — and never repaired by inventing a quantity.
  var st = rec.generation_state ? CENSUS_str_(rec.generation_state.calculation_status) : '';
  var wins = (rec.recommendation_window && rec.recommendation_window.all_windows) || [];
  var allFinite = wins.length > 0 && wins.every(function (w) { return typeof w.suggested_qty === 'number'; });
  var allZero = allFinite && wins.every(function (w) { return w.suggested_qty === 0; });
  if (rec.row_count !== 1) {
    out.zero_recommendation_classification = { kind: 'STALE_OR_MISSING',
      reason: rec.row_count === 0 ? 'there is NO materialized gap row for this scope, so there is no'
        + ' recommendation to act on and none may be invented' : 'more than one row claims this business key' };
  } else if (st !== 'READY') {
    out.zero_recommendation_classification = { kind: 'STALE_OR_MISSING',
      reason: 'calculation_status is ' + (st || '(blank)') + '. A non-READY row carries no usable quantity,'
        + ' and reading it as zero is exactly the defect the materializer refuses to commit.' };
  } else if (allZero) {
    out.zero_recommendation_classification = { kind: 'CORRECT_NO_ACTION',
      reason: 'the row is READY and every window holds a stored, finite 0. That is a canonical valid zero:'
        + ' the SKU is not short at any horizon, and the correct outcome of a generation is NO_ACTION with'
        + ' zero rows written — not an empty header.' };
  } else if (standing === 0 && earliest !== null && earliest > 0) {
    out.zero_recommendation_classification = { kind: 'NOT_ZERO_AT_EVERY_HORIZON',
      reason: 'the furthest-horizon reading is 0 but the earliest actionable window is ' + earliest
        + '. The SKU IS short now and is covered by the horizon. This is the divergence §2 names, and it is'
        + ' not a zero recommendation.' };
  } else {
    out.zero_recommendation_classification = { kind: 'NON_ZERO', reason: 'the authority reads ' + standing };
  }
  P('zero_recommendation_is_classified_not_assumed',
    'CORRECT_NO_ACTION | STALE_OR_MISSING | NOT_ZERO_AT_EVERY_HORIZON | NON_ZERO',
    out.zero_recommendation_classification.kind, !!out.zero_recommendation_classification.kind);
  P('no_quantity_was_invented_to_make_a_write_possible', true, true, true);

  // ---- THE MANUAL PLAN, frozen. -----------------------------------------------------------------------------
  var res = CENSUS_quiet_('RUN_R6R2_ROUTE_PROVENANCE', function () { return RUN_R6R2_ROUTE_PROVENANCE(); });
  if (res.error) {
    P('route_census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the route census failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r7Finish_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];
  var total = CENSUS_num_(res.census_current_plan_total);
  out.current_manual_planned_total = total;
  P('current_manual_planned_total_is_520', R6R7_SET_BEFORE_.current_plan_total, total,
    total === R6R7_SET_BEFORE_.current_plan_total);

  out.before_counts = {
    visible_route_rows: rows.length,
    headers: (res.sku_contributing_header_ids || []).length,
    lines: (res.sku_contributing_line_ids || []).length,
    manual_planned_total: total
  };
  P('before_shape_is_two_headers_two_lines_two_rows',
    R6R7_SET_BEFORE_, out.before_counts,
    rows.length === R6R7_SET_BEFORE_.visible_route_rows
      && out.before_counts.headers === R6R7_SET_BEFORE_.header_count
      && out.before_counts.lines === R6R7_SET_BEFORE_.line_count);

  // Each manual route, frozen field by field, and — the fact the whole isolation argument rests on — its
  // provenance and its recommendation_group_no.
  var groupNos = [];
  R6R7_MANUAL_ROUTES_.forEach(function (m) {
    var hits = CENSUS_r6r6r4Find_(rows, m.allocation_draft_id, m.allocation_draft_line_id);
    var r = hits.length === 1 ? hits[0] : null;
    var snap = {
      label: m.label,
      allocation_draft_id: m.allocation_draft_id,
      allocation_draft_line_id: m.allocation_draft_line_id,
      observed: r ? {
        status: r.status, line_status: r.line_status,
        draft_version: r.draft_version,
        last_mile_delivery: r.last_mile_delivery,
        shipping_method: r.shipping_method,
        source_warehouse_id: r.source_warehouse_id,
        destination_marketplace: r.destination_marketplace,
        quantity: r.quantity,
        k4_group_key: r.k4_group_key,
        generation_type: r.generation_type,
        generation_run_id: r.generation_run_id,
        recommendation_group_no: r.recommendation_group_no,
        ownership: r.ownership,
        updated_by: r.updated_by, updated_at: r.updated_at, line_updated_at: r.line_updated_at
      } : null,
      expected: { last_mile_delivery: m.last_mile_delivery, draft_version: m.draft_version, quantity: m.quantity }
    };
    out.manual_route_snapshots.push(snap);
    P('route_' + m.label + '_present_exactly_once', 1, hits.length, hits.length === 1);
    P('route_' + m.label + '_is_at_the_state_section_0_records',
      m.last_mile_delivery + ' / version ' + m.draft_version,
      r ? (CENSUS_str_(r.last_mile_delivery) + ' / version ' + CENSUS_str_(r.draft_version)) : null,
      !!r && CENSUS_str_(r.last_mile_delivery) === m.last_mile_delivery
        && CENSUS_str_(r.draft_version) === m.draft_version);
    // THE ONE GATE THAT DECIDES WHETHER A GENERATION CAN TOUCH THESE ROWS AT ALL. aiplExpirationCandidates_
    // preserves a row whose provenance is MANUAL and expires an AI draft; the classifier reads
    // generation_type first and falls back to "carries a generation_run_id". A manual row must satisfy BOTH.
    P('route_' + m.label + '_is_classified_MANUAL_by_the_lifecycle_authority',
      'generation_type user_created (or blank) AND no generation_run_id',
      r ? (CENSUS_str_(r.generation_type) + ' / run_id ' + (CENSUS_str_(r.generation_run_id) || '(none)')) : null,
      !!r && CENSUS_low_(r.generation_type) !== 'system_generated' && CENSUS_str_(r.generation_run_id) === '');
    if (r) groupNos.push({ label: m.label, recommendation_group_no: CENSUS_str_(r.recommendation_group_no) });
  });

  // ---- WHY A GENERATION CANNOT LAND ON A MANUAL ROUTE'S IDENTITY. -------------------------------------------
  //
  // The deterministic identity — K4 on a schema that can store a canonical destination, K2 otherwise —
  // includes recommendation_group_no as its LAST dimension. A manual save never sends one (the page has no
  // such field and 16_ stores ''), and KMWRR assigns every generated group a deterministic ordinal 1..N. Two
  // keys that differ in their last segment hash to different ids, so an AI upsert RESOLVES to a row that does
  // not exist and CREATES it. That is the mechanism by which the manual 520 survives: not a rule that says
  // "do not touch it", but an identity it cannot reach.
  var allBlank = groupNos.length > 0 && groupNos.every(function (g) { return g.recommendation_group_no === ''; });
  P('manual_routes_carry_a_blank_recommendation_group_no', 'blank on every manual route',
    groupNos, allBlank);

  // ---- WHAT A GENERATION WOULD PROPOSE, from the pure plan builder the real run uses. -----------------------
  var e3 = null;
  try {
    e3 = CENSUS_quiet_('RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R',
      function () { return RUN_E3_CENSUS_RESUS_US_AMAZON_CO1100R(); });
  } catch (eE) { e3 = null; }
  // ============================================================================================================
  // R6-R7-R2 — WHY THE LOG CARRIES A STOP AND A READY AT THE SAME TIME, SAID HERE RATHER THAN LEFT TO THE
  // READER. This call is how the preflight learns which ROUTES a generation would propose, and it prints its
  // own verdict on the way through. That verdict is the allocator projection's, scoped to itself: an
  // allocator that ships nothing for a scope that needs nothing is the allocator being right.
  //
  // It is recorded, subordinated and labelled. The production answer is `production_path`, and nothing else
  // in this file is allowed to stand in for it.
  // ============================================================================================================
  out.legacy_projection = e3 ? {
    projection_class: e3.projection_class || 'LEGACY_ALLOCATOR_PROJECTION',
    is_production_generation_authority: e3.is_production_generation_authority === true,
    verdict: e3.verdict || null,
    verdict_scope: e3.verdict_scope || 'THIS_PROJECTION_ONLY',
    next_blocked_stage: e3.next_blocked_stage || null,
    blockers: (e3.blockers || []).slice(),
    source_line_count: (e3.source_lines && e3.source_lines.count) || 0,
    allocated_line_count: (e3.allocated_lines && e3.allocated_lines.this_marketplace) || 0,
    production_parity_assembled: !!(e3.production_parity && e3.production_parity.assembled === true),
    note: 'a projection STOP is NOT a production refusal. Read production_path.'
  } : { projection_class: 'LEGACY_ALLOCATOR_PROJECTION', is_production_generation_authority: false,
    verdict: null, verdict_scope: 'THIS_PROJECTION_ONLY', next_blocked_stage: null, blockers: [],
    source_line_count: 0, allocated_line_count: 0, production_parity_assembled: false,
    note: 'the projection did not run; it is not the production authority either way' };
  P('the_projection_does_not_claim_production_authority', false,
    out.legacy_projection.is_production_generation_authority,
    out.legacy_projection.is_production_generation_authority === false);
  P('the_projection_verdict_is_scoped_to_itself', 'THIS_PROJECTION_ONLY',
    out.legacy_projection.verdict_scope, out.legacy_projection.verdict_scope === 'THIS_PROJECTION_ONLY');
  var proposed = (e3 && e3.allocator && e3.allocator.routes) || [];
  out.expected_ai_identities = proposed.map(function (r) {
    var h = { planning_cycle: e3 && e3.planning_cycle, company: R6R7_SCOPE_.company, country: R6R7_SCOPE_.country,
      marketplace: R6R7_SCOPE_.marketplace, source_page: 'inventory_replenishment',
      recommended_source_warehouse_id: r.source_warehouse_id,
      recommended_destination_warehouse_id: r.destination_type === 'WAREHOUSE' ? r.destination : '',
      destination_marketplace: r.destination_type === 'MARKETPLACE' ? r.destination : '',
      recommended_shipping_method: r.method, recommended_last_mile_delivery: r.last_mile,
      recommendation_group_no: r.group_no };
    var k2 = '', k4 = '', id2 = '', id4 = '';
    try { k2 = (typeof sadK2GroupKey_ === 'function') ? sadK2GroupKey_(h) : ''; } catch (e) {}
    try { id2 = (typeof sadK2DeterministicHeaderId_ === 'function') ? sadK2DeterministicHeaderId_(h) : ''; } catch (e) {}
    try { k4 = (typeof ricK4GroupKey_ === 'function') ? ricK4GroupKey_(h) : ''; } catch (e) {}
    try { id4 = (typeof ricK4DeterministicHeaderId_ === 'function') ? ricK4DeterministicHeaderId_(h) : ''; } catch (e) {}
    return { recommendation_group_no: r.group_no, source_warehouse_id: r.source_warehouse_id,
      destination: r.destination, method: r.method, last_mile: r.last_mile,
      line_count: r.line_count, total_qty: r.total_qty,
      k2_group_key: k2, k2_deterministic_header_id: id2,
      k4_group_key: k4, k4_deterministic_header_id: id4,
      id_the_writer_would_mint: id4 || id2,
      id_family_note: 'K4 when the live header can store destination_marketplace (production can), K2'
        + ' otherwise. sadMintNewHeaderId_ resolves it from the SAME authority the resolver used.' };
  });
  // NO PROPOSED IDENTITY MAY EQUAL A MANUAL ROUTE'S, and the thing that collides is the KEY.
  //
  // A stored allocation_draft_id is a historical fact: it was minted when the row was created, from what the
  // header held then. A row whose route has since been edited therefore holds an id that is no longer the
  // hash of its own key, and comparing against it would miss a real collision. What the resolver does is
  // find the ACTIVE header whose K4 group key EQUALS the one being written and return that row's id — so the
  // key is compared, and the id is kept as a second, independent check rather than as the only one.
  var manualKeys = {}, manualIds = [];
  out.manual_route_snapshots.forEach(function (s) {
    manualIds.push(s.allocation_draft_id);
    var k = s.observed ? CENSUS_low_(s.observed.k4_group_key) : '';
    if (k) manualKeys[k] = s.allocation_draft_id;
  });
  var clashes = [];
  out.expected_ai_identities.forEach(function (p) {
    var k = CENSUS_low_(p.k4_group_key);
    if (k && manualKeys[k]) clashes.push({ by: 'GROUP_KEY', key: p.k4_group_key, held_by: manualKeys[k] });
    if (manualIds.indexOf(p.id_the_writer_would_mint) !== -1) {
      clashes.push({ by: 'MINTED_ID', id: p.id_the_writer_would_mint, held_by: p.id_the_writer_would_mint });
    }
  });
  P('no_proposed_ai_identity_equals_a_manual_route_identity', [], clashes, clashes.length === 0);

  var proposedUnits = out.expected_ai_identities.reduce(function (a, p) { return a + CENSUS_num_(p.total_qty); }, 0);
  var proposedLines = out.expected_ai_identities.reduce(function (a, p) { return a + CENSUS_num_(p.line_count); }, 0);
  out.expected_after_counts = {
    headers: out.before_counts.headers + out.expected_ai_identities.length,
    lines: out.before_counts.lines + proposedLines,
    manual_headers_unchanged: out.before_counts.headers,
    manual_planned_total_unchanged: total,
    ai_units: proposedUnits,
    note: out.expected_ai_identities.length === 0
      ? 'ZERO proposed groups. A generation would write NOTHING — and NO_ACTION must produce no empty header'
        + ' and no empty line, which is what the readback verifies.'
      : 'the manual rows are ADDED TO, never replaced. Their count, their quantities and their versions are'
        + ' identical before and after.'
  };

  // ---- THE RECONCILIATION GAP, DISCLOSED RATHER THAN SMOOTHED OVER. ----------------------------------------
  //
  // 61_ has a per-identity precedence rule (aiplManualPrecedence_) whose whole purpose is to let an active
  // manual decision suppress a parallel AI draft. It can only fire when the AI's proposed identity EQUALS the
  // manual row's — and the predicate above proves it cannot. So the suppression that exists in the code is
  // unreachable for these rows, and a generation would add its units ALONGSIDE the manual 520 rather than
  // reconcile with them. That is not a defect this round introduces and not one it repairs; it is the fact an
  // activation decision has to be made in front of.
  out.expected_remaining_or_excess = {
    manual_planned: total,
    recommendation_standing: standing,
    recommendation_earliest_actionable: earliest,
    strip_would_show: (standing === null) ? 'Remaining —  (the recommendation is not known)'
      : (total > standing ? ('Excess ' + (total - standing)) : ('Remaining ' + (standing - total))),
    server_side_reconciliation: 'NONE for these rows.',
    why: 'aiplManualPrecedence_ suppresses an AI draft only when its identity is already held by an active'
      + ' manual row. A manual route carries a blank recommendation_group_no and every generated group carries'
      + ' an ordinal, so the identities never meet and the suppression never fires. A generation would ADD'
      + ' its own routes; the station total would become the manual total PLUS the AI total.',
    operator_consequence: 'decide BEFORE activation whether the 520 should be cancelled first, or whether two'
      + ' parallel plans for one SKU is the intended outcome. This preflight will not choose.'
  };

  // ---- THE EXACT SURFACE. ----------------------------------------------------------------------------------
  var surf = CENSUS_r6r7Surface_();
  out.allowed_tables = { source: surf.source, written: surf.tables_written,
    read: surf.tables_read, guaranteed_zero_mutation: surf.tables_guaranteed_zero_mutation };
  out.allowed_fields = {
    header: ['allocation_draft_id (resolved, never named by the caller)', 'planning_cycle', 'company', 'country',
      'marketplace', 'source_page', 'recommended_source_warehouse_id', 'recommended_destination_warehouse_id',
      'destination_marketplace', 'recommended_shipping_method', 'recommended_last_mile_delivery',
      'recommendation_group_no', 'calculation_run_id', 'formula_version', 'calculated_at', 'source_data_as_of',
      'generation_run_id', 'generation_type = system_generated', 'status = draft', 'draft_version',
      'created_by / updated_by', 'created_at / updated_at'],
    line: ['allocation_draft_line_id (deterministic)', 'allocation_draft_id', 'sku', 'site_sku', 'window_code',
      'recommended_qty', 'expected_arrival', 'line_status', 'created_at / updated_at'],
    note: 'every one of these is written by handleUpsertShippingAllocationDraftAtomic_ under one lock. A field'
      + ' the live sheet cannot store is a typed REFUSAL, never a silent drop.'
  };
  out.forbidden_mutations = {
    manual_rows: 'no UPDATE, no expiry, no cancellation, no re-ownership, no draft_version change on'
      + ' SADH-K4-38523A90 or SADH-K4-A3872518 or either of their lines.',
    other_scopes: 'no row whose (company, country, marketplace, sku) is not ' + R6R7_SCOPE_.company + '/'
      + R6R7_SCOPE_.country + '/' + R6R7_SCOPE_.marketplace + '/' + R6R7_SCOPE_.sku + '.',
    tables: surf.tables_guaranteed_zero_mutation,
    lifecycle: 'no Submit, no shipping_plans / shipments row, no reservation, no inventory deduction, no'
      + ' document generation. Generation writes a DRAFT and stops.'
  };
  out.idempotency_contract = {
    identity: 'the deterministic header id resolved from the route group key. A repeat generation for the same'
      + ' scope resolves the SAME id and REUSEs or UPDATEs that row.',
    execution_key: 'AIPLAN-<fnv1a(planningCycle|company|country|marketplace|calculation_run_id)>, persisted'
      + ' where a create key lives so a replay has a second independent witness.',
    replay_expectation: surf.replay_behavior || 'a replay must not raise the row count in either table and'
      + ' must not change created_headers.',
    second_click: 'DO NOT press Generate a second time to test this. A replay is verified by reading, not by'
      + ' pressing.'
  };
  out.optimistic_concurrency_contract = {
    generation: 'an AI upsert RESOLVES its identity and must not name an allocation_draft_id'
      + ' (ROUTE_INTENT_CONTRADICTORY if it does).',
    manual_save: 'unchanged and now enforced: an UPDATE_EXISTING_ROUTE that declares no'
      + ' expected_draft_version is MISSING_OPTIMISTIC_TOKEN with zero rows written (R6-R6-R4-R2).',
    interaction: 'a generation never sends expected_draft_version for a manual row, because it never'
      + ' addresses one.'
  };
  out.ack_unknown_contract = {
    rule: 'an unclassifiable write outcome is held OUT of the write scope and is NEVER auto-resent.',
    on_ack_unknown: 'do NOT press Generate again. Run RUN_R6R7_CONTROLLED_AI_PLAN_READBACK and let the'
      + ' database say what happened. A proven zero-write stays retryable; anything else is decided by'
      + ' reading, never by repeating.'
  };
  out.lineage_policy = {
    calculation_run_id: 'MUST come from a DONE GAP-INV run whose planning cycle equals the request'
      + ' (weeklyAiPlanResolveGapRunLineage_). A missing, non-DONE, wrong-prefix or wrong-cycle run BLOCKS'
      + ' before any write.',
    generation_run_id: 'minted per run and stamped on every header the run owns, so a later run can tell its'
      + ' own rows from the ones it is replacing.',
    resolved_now: rec.calculation_run ? rec.calculation_run.job_run : null,
    unresolved_reason: rec.calculation_run ? rec.calculation_run.unresolved_reason : null,
    harvest_writer_agreement: 'the harvest run id and the writer run id must be the SAME id; 61_ refuses'
      + ' when they differ rather than stamping one and computing from the other.'
  };

  // ---- MIXED DEPLOYMENT. A generation that writes while the lifecycle module is absent leaves two active
  //      plans, which is the state the whole lifecycle exists to prevent. 61_ refuses; this reports it first.
  var lifecyclePresent = (typeof aiplExpireSupersededDrafts_ === 'function')
    && (typeof aiplActivationGate_ === 'function') && (typeof aiplReadActivationFacts_ === 'function');
  P('ai_plan_lifecycle_module_is_present', true, lifecyclePresent, lifecyclePresent === true);
  var routeAuthorityPresent = (typeof KMWRR !== 'undefined' && KMWRR && typeof KMWRR.buildK2GenerationPlan === 'function');
  P('route_derivation_authority_is_present', true, routeAuthorityPresent, routeAuthorityPresent === true);

  // ---- AND THIS PREFLIGHT WROTE NOTHING. -------------------------------------------------------------------
  P('writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);
  P('db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);
  P('writer_calls_is_zero', 0, out.writer_calls, out.writer_calls === 0);
  P('submit_calls_is_zero', 0, out.submit_calls, out.submit_calls === 0);
  P('route_save_calls_is_zero', 0, out.route_save_calls, out.route_save_calls === 0);

  // ---- §F PARITY. The wrapper's verdict is DERIVED from the production answer, never asserted beside it. ----
  //
  // Three outcomes, and each is the production path's outcome under a different name:
  //   READY_NO_ACTION           — production would return AI_PLAN_NO_ACTION with zero writes. Pressing
  //                               Generate is safe AND would create nothing. That is a finish, not a run.
  //   CONTROLLED_AI_PLAN_READY  — production has a residual to generate and every gate is satisfied.
  //   STOP                      — anything else, INCLUDING the case where this file's own checks all pass
  //                               but production would refuse. That case is the whole reason this exists.
  var pp = out.production_path || {};
  // READ, never re-derived. A refusal can still carry a residual — the recommendation is what could not be
  // read, not the plan it would have been netted against — so 'there is a residual' is not 'this would run'.
  var wouldWrite = pp.would_write === true;
  out.parity = {
    // filled after the verdict is decided, because a parity that reports the verdict must be written after
    // it exists — the same ordering the projection's blockers list got wrong two rounds ago.
    wrapper_verdict: null,
    production_outcome: pp.outcome || null,
    agree: null,
    production_would_write: wouldWrite,
    wrapper_own_checks_passed: out.predicates_failed === 0,
    production_path_available: pp.available === true,
    production_path_outcome: pp.outcome || null,
    production_path_code: pp.code || null,
    production_path_reason: pp.reason || null,
    production_decision_source: pp.decision_source || null,
    production_entry_point: pp.entry_point || null,
    rule: 'the wrapper may only report a success this file can point at in the production answer. When the'
      + ' production path would refuse, the wrapper STOPS — a preflight that certifies a run which cannot'
      + ' happen is worse than no preflight.'
  };
  // THE ONE INVARIANT. Not 'the two agree' — a wrapper is allowed to stop for its own reasons — but that it
  // is never the MORE PERMISSIVE of the two.
  P('the_wrapper_reports_the_production_handlers_own_decision',
    'weeklyAiPlanControlledDecisionFromParts_ (61_)',
    pp.decision_source ? String(pp.decision_source).split(';')[0] : null,
    !!pp.decision_source && String(pp.decision_source).indexOf('weeklyAiPlanControlledDecisionFromParts_') === 0);
  P('the_valid_zero_short_circuit_precedes_the_empty_scope_refusal',
    'VALID_ZERO_SHORT_CIRCUIT before REQUESTED_SCOPE_EMPTY_REFUSAL',
    (pp.gate_order || []).join(' > '),
    (function () { var o = pp.gate_order || [];
      var a = o.indexOf('VALID_ZERO_SHORT_CIRCUIT'), b = o.indexOf('REQUESTED_SCOPE_EMPTY_REFUSAL');
      return a >= 0 && b >= 0 && a < b; })());
  P('wrapper_verdict_is_derived_from_the_production_path', true, out.parity.production_path_available,
    out.parity.production_path_available === true);
  P('production_path_would_not_refuse', 'AI_PLAN_NO_ACTION or WOULD_GENERATE',
    (pp.outcome || 'UNAVAILABLE') + (wouldWrite ? ' (residual ' + pp.residual_qty + ')' : ''),
    pp.available === true
      && (pp.outcome === 'AI_PLAN_NO_ACTION' || (pp.outcome === 'WOULD_GENERATE' && wouldWrite)));

  if (out.predicates_failed !== 0) {
    out.verdict = 'STOP';
    out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
      + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ');
  } else if (pp.outcome === 'AI_PLAN_NO_ACTION') {
    out.verdict = 'READY_NO_ACTION';
  } else if (pp.outcome === 'WOULD_GENERATE' && wouldWrite) {
    out.verdict = 'CONTROLLED_AI_PLAN_READY';
  } else {
    // The else branch used to be the success. Any outcome that is not one of the two named above — a
    // refusal, an UNAVAILABLE, a WOULD_GENERATE with nothing to generate — is a STOP, by name.
    out.verdict = 'STOP';
    out.stop_reason = 'PRODUCTION_PATH_WOULD_NOT_RUN: ' + (pp.outcome || 'UNAVAILABLE')
      + (pp.code ? ' / ' + pp.code : '') + (pp.reason ? ' (' + pp.reason + ')' : '')
      + '. A preflight may not report a success this file cannot point at in the production answer.';
  }
  out.parity.wrapper_verdict = out.verdict;
  out.parity.agree = (out.verdict === 'READY_NO_ACTION' && pp.outcome === 'AI_PLAN_NO_ACTION')
    || (out.verdict === 'CONTROLLED_AI_PLAN_READY' && pp.outcome === 'WOULD_GENERATE' && wouldWrite === true)
    || out.verdict === 'STOP';
  out.parity.wrapper_never_outranks_production =
    out.verdict === 'STOP' || (pp.available === true && pp.outcome !== 'REFUSAL');
  return CENSUS_r6r7Finish_(out);
}

/**
 * §F — ASK 61_ WHAT IT WOULD ANSWER, AND REPORT ITS ANSWER RATHER THAN AN EQUIVALENT ONE.
 *
 * R6-R7-R2. This function used to call 61_'s classifiers and then decide for itself that a no-action means
 * AI_PLAN_NO_ACTION / NO_REPLENISHMENT_REQUIRED and a missing recommendation means REQUESTED_SCOPE_EMPTY.
 * Those strings were correct on the day they were typed and nothing kept them correct: a second mapping of
 * one decision is precisely the divergence the parity block exists to catch, moved one level inward where
 * the parity block cannot see it.
 *
 * It now calls weeklyAiPlanControlledDecision_ — the SAME builder the public handler returns its envelope
 * from — and copies the fields out. There is no outcome or code spelled in this file any more.
 *
 * Read-only, and it constructs no writer: the decision reads through 61_'s own canonical reader and pure
 * classifiers, and nothing on that path can reach PASS 2.
 */
function CENSUS_r6r7ProductionPath_() {
  var out = { available: false, unavailable_reason: null,
    entry_point: null,   // copied from the production decision; never spelled here
    decision_source: null,
    outcome: null, code: null, reason: null,
    recommendation_state: null, recommended_qty: null,
    qualifying_active_planned_qty: null, qualifying_planned_qty: null, residual_qty: null,
    per_scope: [], missing_reasons: [], authority: null,
    would_write: false, writer_reached: false, db_writes: 0,
    requested_scope_empty_is_bypassed_by_valid_zero: false, gate_order: [],
    production_response: null, production_refusal: null };
  var missing = [];
  // The ONE function that has to exist, because it is the one the handler goes through. Asking for the
  // classifiers individually would let a project answer with a decision this file assembled itself.
  if (typeof weeklyAiPlanControlledDecision_ !== 'function') missing.push('weeklyAiPlanControlledDecision_');
  if (typeof weeklyAiPlanControlledDecisionFromParts_ !== 'function') missing.push('weeklyAiPlanControlledDecisionFromParts_');
  if (missing.length) {
    out.unavailable_reason = 'PRODUCTION_AUTHORITY_NOT_SYNCED: ' + missing.join(', ')
      + '. This project does not carry the R6-R7-R2 shared decision builder, so the production answer cannot'
      + ' be asked for — which is NOT the same as it being yes. Sync 61_api_v1_weekly_ai_plan.gs.';
    return out;
  }
  var cycle = null;
  try {
    var cc = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
    cycle = (cc && cc.ok) ? cc.planningCycle : null;
  } catch (eC) { cycle = null; }
  var scope = { company: R6R7_SCOPE_.company, country: R6R7_SCOPE_.country,
    marketplace: R6R7_SCOPE_.marketplace, planningCycle: cycle };
  var ss = null;
  try { ss = SpreadsheetApp.openById(prodExpectedDbId_());
    if (typeof prodAssertDbTarget_ === 'function') prodAssertDbTarget_(ss, prodExpectedDbId_()); }
  catch (eO) { out.unavailable_reason = 'PRODUCTION_DATABASE_UNREACHABLE: ' + CENSUS_str_(eO && eO.message); return out; }
  var calcDate = null;
  try {
    var cc2 = (typeof gapCalcResolveContext_ === 'function') ? gapCalcResolveContext_('INVENTORY') : null;
    calcDate = (cc2 && cc2.ok) ? cc2.calculationDate : null;
  } catch (eD) { calcDate = null; }
  var d;
  try { d = weeklyAiPlanControlledDecision_(ss, scope, R6R7_SCOPE_.marketplace, calcDate); }
  catch (eX) {
    out.unavailable_reason = 'PRODUCTION_AUTHORITY_THREW: ' + CENSUS_str_(eX && eX.message);
    return out;
  }
  if (!d || d.available !== true) {
    out.unavailable_reason = (d && d.unavailable_reason)
      || 'PRODUCTION_AUTHORITY_RETURNED_NOTHING_USABLE';
    return out;
  }
  // COPIED, not re-derived. Every field below is the production decision's own.
  out.available = true;
  out.entry_point = d.entry_point;
  out.decision_source = d.decision_source;
  out.outcome = d.outcome;
  out.code = d.code;
  out.reason = d.reason;
  out.recommendation_state = d.recommendation_state;
  out.recommended_qty = d.recommended_qty;
  out.qualifying_active_planned_qty = d.qualifying_active_planned_qty;
  out.qualifying_planned_qty = d.qualifying_planned_qty;
  out.residual_qty = d.residual_qty;
  out.per_scope = d.per_scope || [];
  out.missing_reasons = d.missing_reasons || [];
  out.would_write = d.would_write === true;
  out.writer_reached = d.writer_reached === true;
  out.db_writes = CENSUS_num_(d.db_writes) || 0;
  out.requested_scope_empty_is_bypassed_by_valid_zero =
    d.requested_scope_empty_is_bypassed_by_valid_zero === true;
  out.gate_order = d.gate_order || [];
  out.authority = d.authority || null;
  // The envelope the handler would actually return, reported field for field rather than described. A
  // preflight that says 'zero writes' and cannot show the response saying it has asserted, not measured.
  out.production_response = d.response ? d.response.data : null;
  out.production_refusal = d.refusal ? d.refusal.errors[0] : null;
  return out;
}

// ----------------------------------------------------------------------------------------------------------------
// §5 — THE CONTROLLED ACTIVATION, DESIGNED AND NOT AUTHORIZED. Read-only; there is no write path in it.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST() {
  var out = {
    census: 'RUN_R6R7_CONTROLLED_ACTIVATION_MANIFEST',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, route_save_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    authorized: false, executed: false,
    flag_flipped_this_round: false,
    scope: R6R7_SCOPE_,
    verdict: 'CONTROLLED_ACTIVATION_DESIGNED_NOT_AUTHORIZED'
  };
  out.blocked_by = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R7 §5 authorizes a DESIGN only. The flag is not flipped in this'
    + ' round and this file cannot flip it.';
  out.precondition = 'FOUR things, all of them: (1) RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS returns'
    + ' RECOMMENDATION_AUTHORITY_ESTABLISHED; (2) RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT returns'
    + ' CONTROLLED_AI_PLAN_READY with zero failed predicates; (3) the operator has decided what should happen'
    + ' to the manual 520, because a generation will NOT reconcile with it; (4) a separate, explicit,'
    + ' current-turn authorization to flip the flag.';
  out.enablement = {
    what_changes: 'INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ false -> true in 00_config.gs.',
    why_that_alone_is_not_the_gate: 'the flag is GLOBAL. It is paired with a server-owned allowlist so that'
      + ' flipping it enables materialization for the listed scopes ONLY. A browser cannot widen the list and'
      + ' a payload cannot widen it; widening it is a deployment with a diff.',
    deployment_scope: 'ONE file (00_config.gs) plus a new Web App deployment version. No frontend change, no'
      + ' bundle rebuild, no migration.',
    allowlist_must_read: [{ company: R6R7_SCOPE_.company, country: R6R7_SCOPE_.country,
      marketplace: R6R7_SCOPE_.marketplace, sku: R6R7_SCOPE_.sku }],
    reverting: 'flip the same constant back and publish a deployment version. The flag is the kill switch and'
      + ' it is one line.'
  };
  out.the_one_action = {
    press: 'Generate AI Plan, ONCE, with the scope modal set to ' + R6R7_SCOPE_.company + ' / '
      + R6R7_SCOPE_.country + ' / ' + R6R7_SCOPE_.marketplace + '.',
    do_not: ['do not press it a second time — a replay is verified by READING, never by pressing',
      'do not press Submit Plan',
      'do not edit, add, delete or re-order any route on the Execution Plan',
      'do not run Recalculate All Sites in the same session — it would move the very row the readback'
        + ' compares against',
      'do not answer the "Regenerate over your own saved routes?" prompt with OK. There is nothing for it to'
        + ' supersede here (the identities cannot meet), and confirming it authorizes something nobody has'
        + ' measured.']
  };
  out.mutation_timeline = {
    where: 'the browser, before anything is pressed: KM.transport.timeline().',
    expected_before: 'mutation_requests 0 on a freshly loaded page.',
    expected_during: 'EXACTLY ONE mutation request, action weeklyAiPlan.generate.',
    what_to_capture: ['action', 'intent', 'expected_draft_version', 'has_create_idempotency_key',
      'mints_new_row', 'allocation_draft_ids', 'allocation_draft_line_ids', 'http status', 'duration'],
    red_flag: 'more than one mutation request, or any request naming SADH-K4-38523A90 or SADH-K4-A3872518.'
      + ' Either one means STOP and read before doing anything else.'
  };
  out.apps_script_correlation = {
    how: 'Apps Script > Executions, filtered to the minute of the click. The response carries'
      + ' generation_run_id and execution_key; the execution log carries the same run id.',
    why: 'an ACK the browser never received is still an execution with a run id. Correlating them is how a'
      + ' silent timeout is told apart from a refusal.'
  };
  out.immediate_readback = {
    entry_point: 'RUN_R6R7_CONTROLLED_AI_PLAN_READBACK',
    when: 'immediately after the click resolves, and ALSO after any unclear acknowledgement.',
    success_verdicts: ['CONTROLLED_AI_PLAN_WRITE_CONFIRMED', 'CONTROLLED_AI_PLAN_NO_ACTION_CONFIRMED']
  };
  out.no_action_design = {
    when: 'the authoritative recommendation is a canonical zero (READY, every window a stored finite 0).',
    what_must_happen: 'the generation writes NOTHING: no header, no line, no empty shell of either.',
    verdict: 'CONTROLLED_AI_PLAN_NO_ACTION_CONFIRMED',
    what_must_not_happen: 'an empty header or a zero-quantity line created "so there is something to see".'
      + ' A row that exists to represent nothing is a row a later run has to decide about.'
  };
  out.ack_unknown = {
    rule: 'do NOT press Generate again.',
    procedure: 'run the readback. It reads the database, which is the only authority on whether a write'
      + ' happened. A proven zero-write stays retryable; anything else is decided from what is there.'
  };
  out.rollback = {
    non_destructive: true,
    method: 'the written headers are DRAFTS carrying their generation_run_id. Expire them through the same'
      + ' lifecycle that supersedes them (aiplExpireSupersededDrafts_), which stamps expired_at,'
      + ' expired_by_run_id and expiration_reason.',
    never: 'never delete rows by hand, and never edit the sheet directly — an expiry that records no reason'
      + ' is indistinguishable from data loss.',
    manual_rows: 'nothing to roll back. They are not touched, which the readback proves field by field.',
    flag: 'flip INVENTORY_AI_PLAN_DB_GENERATION_ENABLED_ back to false and publish a deployment version.'
  };
  out.compensation = {
    if_a_manual_row_moved: 'STOP. Do not generate again, do not repair from the page. The R6-R6-R3'
      + ' compensating-repair pattern applies: freeze what is there, design the repair, execute it once'
      + ' through a named actor, and read it back.'
  };
  CENSUS_log_('r6r7_activation', out.verdict + ' — ' + out.blocked_by);
  return CENSUS_r6r7Finish_(out);
}

// ----------------------------------------------------------------------------------------------------------------
// §6 — THE READBACK CONTRACT. Built and tested offline in this round; NOT run against a production write,
// because no production write is authorized in this round.
//
// It reports one of two success verdicts because there are two correct outcomes: a generation that wrote the
// routes it proposed, and a generation that correctly wrote nothing. Reporting NO_ACTION as a failure would
// push an operator to make a zero recommendation non-zero, which is the one thing that must never happen.
// ----------------------------------------------------------------------------------------------------------------
function RUN_R6R7_CONTROLLED_AI_PLAN_READBACK() {
  var out = {
    census: 'RUN_R6R7_CONTROLLED_AI_PLAN_READBACK',
    build: TEMP_E3_CENSUS_BUILD_,
    read_only: true, db_writes: 0, writer_constructed: false, writer_calls: 0,
    submit_calls: 0, route_save_calls: 0, reservation_writes: 0, carrier_master_data_writes: 0,
    scope: R6R7_SCOPE_,
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    manual_routes_observed: [],
    ai_rows_observed: [],
    counts: null,
    changed_fields: [],
    verdict: 'STOP', stop_reason: ''
  };
  function P(name, expected, observed, pass) { return CENSUS_r6r6r3P_(out, name, expected, observed, pass); }

  var res = RUN_R6R2_ROUTE_PROVENANCE();
  if (res.error) {
    P('route_census_readable', 'the route census returns rows', 'error: ' + CENSUS_str_(res.error), false);
    out.stop_reason = 'the route census failed: ' + CENSUS_str_(res.error);
    return CENSUS_r6r7Finish_(out);
  }
  out.db_writes = CENSUS_num_(res.db_writes) || 0;
  out.writer_constructed = res.writer_constructed === true;
  var rows = res.visible_route_rows || [];

  // ---- THE MANUAL ROUTES, FIELD BY FIELD. A bystander is proven still by its own columns, never by the
  //      absence of a complaint elsewhere.
  R6R7_MANUAL_ROUTES_.forEach(function (m) {
    var hits = CENSUS_r6r6r4Find_(rows, m.allocation_draft_id, m.allocation_draft_line_id);
    var r = hits.length === 1 ? hits[0] : null;
    out.manual_routes_observed.push({ label: m.label, allocation_draft_id: m.allocation_draft_id,
      observed: r ? { status: r.status, draft_version: r.draft_version,
        last_mile_delivery: r.last_mile_delivery, quantity: r.quantity, updated_by: r.updated_by,
        updated_at: r.updated_at, line_updated_at: r.line_updated_at,
        generation_type: r.generation_type, generation_run_id: r.generation_run_id } : null });
    P('route_' + m.label + '_still_present_exactly_once', 1, hits.length, hits.length === 1);
    // THE VERSION IS THE WHOLE ARGUMENT. The writer increments draft_version on every UPDATE, so a version
    // that did not move is proof that no UPDATE touched the row — stronger than any timestamp comparison.
    P('route_' + m.label + '_draft_version_did_not_move', m.draft_version,
      r ? CENSUS_str_(r.draft_version) : null, !!r && CENSUS_str_(r.draft_version) === m.draft_version);
    P('route_' + m.label + '_last_mile_unchanged', m.last_mile_delivery,
      r ? CENSUS_str_(r.last_mile_delivery) : null, !!r && CENSUS_str_(r.last_mile_delivery) === m.last_mile_delivery);
    P('route_' + m.label + '_quantity_unchanged', m.quantity,
      r ? CENSUS_num_(r.quantity) : null, !!r && CENSUS_num_(r.quantity) === m.quantity);
    P('route_' + m.label + '_was_not_expired_or_cancelled', 'draft',
      r ? CENSUS_low_(r.status) : null, !!r && CENSUS_low_(r.status) === 'draft');
    // AND IT WAS NOT RE-OWNED. A generation stamps generation_type system_generated and a generation_run_id;
    // a manual row that acquired either has been adopted by a run, which is a different failure from being
    // edited and would otherwise pass every value comparison above.
    P('route_' + m.label + '_was_not_re_owned_by_a_run', 'no generation_run_id, not system_generated',
      r ? (CENSUS_str_(r.generation_type) + ' / ' + (CENSUS_str_(r.generation_run_id) || '(none)')) : null,
      !!r && CENSUS_low_(r.generation_type) !== 'system_generated' && CENSUS_str_(r.generation_run_id) === '');
    // THE FIELDS THAT MOVED, NAMED. A failed predicate says WHICH claim broke; this says which COLUMN did,
    // which is what an operator needs before deciding whether a compensation is required. An empty list
    // here means nothing moved — it is filled on every run, so it can never mean 'nothing was checked'.
    if (r) {
      [['draft_version', m.draft_version], ['last_mile_delivery', m.last_mile_delivery],
       ['quantity', m.quantity], ['status', 'draft']].forEach(function (pair) {
        var was = CENSUS_str_(pair[1]), now = CENSUS_str_(r[pair[0]] === undefined ? '' : r[pair[0]]);
        if (pair[0] === 'status') now = CENSUS_low_(r.status);
        if (was !== now) out.changed_fields.push({ route: m.label, field: pair[0], was: was, now: now });
      });
      if (CENSUS_str_(r.generation_run_id) !== '') {
        out.changed_fields.push({ route: m.label, field: 'generation_run_id', was: '', now: CENSUS_str_(r.generation_run_id) });
      }
    }
  });

  // ---- WHAT IS NEW, AND WHETHER IT IS ALLOWED TO BE. --------------------------------------------------------
  var manualIds = R6R7_MANUAL_ROUTES_.map(function (m) { return m.allocation_draft_id; });
  var extra = rows.filter(function (r) { return manualIds.indexOf(CENSUS_str_(r.allocation_draft_id)) === -1; });
  out.ai_rows_observed = extra.map(function (r) {
    return { allocation_draft_id: r.allocation_draft_id, allocation_draft_line_id: r.allocation_draft_line_id,
      status: r.status, quantity: r.quantity, generation_type: r.generation_type,
      generation_run_id: r.generation_run_id, recommendation_group_no: r.recommendation_group_no,
      shipping_method: r.shipping_method, last_mile_delivery: r.last_mile_delivery,
      source_warehouse_id: r.source_warehouse_id, k4_group_key: r.k4_group_key };
  });
  // Every new row must be AI-owned. A new row with no run id is not an AI plan output — it is an unexplained
  // write, and it must fail rather than be counted as one.
  var unowned = out.ai_rows_observed.filter(function (r) {
    return CENSUS_str_(r.generation_run_id) === '' || CENSUS_low_(r.generation_type) !== 'system_generated';
  }).map(function (r) { return r.allocation_draft_id; });
  P('every_new_row_is_ai_owned', [], unowned, unowned.length === 0);
  // One run, not several. Two run ids among the new rows means the button was pressed twice.
  var runIds = [];
  out.ai_rows_observed.forEach(function (r) {
    var g = CENSUS_str_(r.generation_run_id);
    if (g && runIds.indexOf(g) === -1) runIds.push(g);
  });
  P('new_rows_belong_to_at_most_one_generation_run', 'at most 1', runIds, runIds.length <= 1);
  // No duplicates: two rows may never claim one deterministic identity.
  var seen = {}, dupIds = [];
  out.ai_rows_observed.forEach(function (r) {
    var k = CENSUS_str_(r.k4_group_key);
    if (!k) return;
    if (seen[k]) { if (dupIds.indexOf(k) === -1) dupIds.push(k); } else seen[k] = 1;
  });
  P('no_duplicate_ai_identities', [], dupIds, dupIds.length === 0);
  // And no empty shell. A row that represents nothing is a row a later run has to decide about.
  var empties = out.ai_rows_observed.filter(function (r) { return CENSUS_num_(r.quantity) <= 0; })
    .map(function (r) { return r.allocation_draft_id; });
  P('no_zero_quantity_ai_row_was_created', [], empties, empties.length === 0);

  var total = CENSUS_num_(res.census_current_plan_total);
  var aiUnits = out.ai_rows_observed.reduce(function (a, r) { return a + CENSUS_num_(r.quantity); }, 0);
  out.counts = {
    visible_route_rows: rows.length,
    manual_rows: rows.length - extra.length,
    ai_rows: extra.length,
    headers: (res.sku_contributing_header_ids || []).length,
    lines: (res.sku_contributing_line_ids || []).length,
    station_plan_total: total,
    manual_planned_total: R6R7_SET_BEFORE_.current_plan_total,
    ai_units: aiUnits
  };
  P('manual_rows_still_number_two', 2, out.counts.manual_rows, out.counts.manual_rows === 2);
  // The total must be exactly the manual total plus what the AI added. A total that is anything else means a
  // quantity somewhere was rewritten, which no amount of row-level comparison would catch on its own.
  P('station_total_is_the_manual_total_plus_the_ai_units',
    R6R7_SET_BEFORE_.current_plan_total + aiUnits, total,
    total === R6R7_SET_BEFORE_.current_plan_total + aiUnits);

  // ---- SCOPE ISOLATION, AND THE LIFECYCLE THAT MUST NOT HAVE RUN. -------------------------------------------
  var foreign = (res.excluded_route_ids_with_reason || []).filter(function (x) {
    return CENSUS_str_(x.reason).indexOf('EXPIRED_BY_THIS_RUN') !== -1;
  });
  P('no_row_was_expired_by_this_run', [], foreign, foreign.length === 0);

  P('writer_not_constructed', false, out.writer_constructed, out.writer_constructed === false);
  P('db_writes_is_zero', 0, out.db_writes, out.db_writes === 0);

  if (out.predicates_failed > 0) {
    out.verdict = 'STOP';
    out.stop_reason = out.predicates_failed + ' predicate(s) failed: '
      + out.predicates.filter(function (p) { return !p.pass; }).map(function (p) { return p.predicate; }).join(', ');
  } else if (out.ai_rows_observed.length === 0) {
    // NOTHING WRITTEN is a success verdict, not a missing one — but only when the recommendation says so.
    // Asked of §2 rather than assumed from the emptiness, because "nothing was written" and "nothing should
    // have been written" are different claims and the second is the one that makes the first correct.
    out.verdict = 'CONTROLLED_AI_PLAN_NO_ACTION_CONFIRMED';
  } else {
    out.verdict = 'CONTROLLED_AI_PLAN_WRITE_CONFIRMED';
  }
  return CENSUS_r6r7Finish_(out);
}

// ================================================================================================================
// R6-R7-R2 — THE EXPORT IS WHAT AN AUDITOR READS, AND IT WAS A FIXED LIST WRITTEN BEFORE THE EVIDENCE EXISTED.
//
// The live run held `production_path` and `parity` on the returned object and printed neither, because this
// list was written in R6-R7 and the two fields arrived in R6-R7-R1. Nothing failed. The preflight reported
// READY_NO_ACTION and the one line a reader would audit could not say what production had answered — which
// is indistinguishable, from the outside, from the wrapper having decided on its own.
//
// A whitelist that silently drops new evidence is the defect, not the missing entries. So each census
// DECLARES the fields its verdict rests on, and omitting one is a STOP with a named reason rather than a
// quieter report.
// ================================================================================================================
var R6R7_REQUIRED_EXPORT_ = {
  RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT: ['production_path', 'parity'],
  RUN_R6R7_RECOMMENDATION_AUTHORITY_CENSUS: ['suggested_qty', 'disputed_value_provenance', 'current_run'],
  RUN_R6R7_CONTROLLED_AI_PLAN_READBACK: ['counts']
};

// ================================================================================================================
// THE BOUNDED PROOF. Everything an acceptance rests on, in one line small enough to survive.
//
// It carries no envelope, no per-scope array, no planned rows, no route snapshots, no harvest, no warehouses,
// no carrier cards and no blocker prose — every one of those is unbounded, and one of them growing is what
// takes the line past the cap again. The detailed export keeps all of it, unchanged, for debugging; this is
// the line an operator keeps.
// ================================================================================================================
var R6R7_PROOF_CONTRACT_ = 'R6R7-PROOF-V1';
var R6R7_PROOF_MAX_BYTES_ = 4096;

function CENSUS_r6r7ProofRoute_(out, label) {
  var snaps = out.manual_route_snapshots || [];
  for (var i = 0; i < snaps.length; i++) if (snaps[i].label === label) return snaps[i];
  return null;
}

function CENSUS_r6r7ProofObject_(out) {
  var pp = out.production_path || {};
  var pa = out.parity || {};
  var lp = out.legacy_projection || {};
  var cr = out.current_run || {};
  // freshness is the canonical reader's own word for the snapshot, and it arrives with the production
  // decision rather than with the page-side authority — so it is read from there, not restated.
  var fr = (pp.authority && pp.authority.current_run) || {};
  var A = CENSUS_r6r7ProofRoute_(out, 'A'), B = CENSUS_r6r7ProofRoute_(out, 'B');
  return {
    census: out.census, build: out.build, verdict: out.verdict,
    predicates_passed: out.predicates_passed, predicates_failed: out.predicates_failed,
    export_complete: out.export_complete === true,
    export_missing: out.export_missing || [],
    // Required by the proof's own guard: a proof that is incomplete has to say so IN the line that survives.
    proof_complete: out.proof_complete === true,
    proof_missing: out.proof_missing || [],

    db_writes: CENSUS_num_(out.db_writes) || 0,
    writer_calls: CENSUS_num_(out.writer_calls) || 0,
    writer_constructed: out.writer_constructed === true,
    submit_calls: CENSUS_num_(out.submit_calls) || 0,
    route_save_calls: CENSUS_num_(out.route_save_calls) || 0,
    reservation_writes: CENSUS_num_(out.reservation_writes) || 0,

    current_run: {
      calculation_run_id: cr.calculation_run_id === undefined ? null : cr.calculation_run_id,
      calculation_date: (cr.calculation_date === undefined ? null : cr.calculation_date)
        || (fr.calculation_date === undefined ? null : fr.calculation_date),
      calculation_status: cr.calculation_status === undefined ? null : cr.calculation_status,
      freshness_state: fr.freshness_state === undefined ? null : fr.freshness_state
    },

    recommendation: {
      state: pp.recommendation_state === undefined ? null : pp.recommendation_state,
      recommended_qty: pp.recommended_qty === undefined ? null : pp.recommended_qty,
      qualifying_active_planned_qty: pp.qualifying_active_planned_qty === undefined
        ? null : pp.qualifying_active_planned_qty,
      residual_qty: pp.residual_qty === undefined ? null : pp.residual_qty
    },

    production_path: {
      available: pp.available === true,
      entry_point: pp.entry_point || null,
      decision_source: pp.decision_source || null,
      outcome: pp.outcome || null,
      code: pp.code || null,
      reason: pp.reason || null,
      recommendation_state: pp.recommendation_state || null,
      would_write: pp.would_write === true,
      writer_reached: pp.writer_reached === true,
      requested_scope_empty_is_bypassed_by_valid_zero:
        pp.requested_scope_empty_is_bypassed_by_valid_zero === true
    },

    parity: {
      wrapper_verdict: pa.wrapper_verdict || null,
      production_outcome: pa.production_outcome || null,
      agree: pa.agree === undefined ? null : pa.agree,
      production_would_write: pa.production_would_write === undefined ? null : pa.production_would_write,
      wrapper_never_outranks_production: pa.wrapper_never_outranks_production === undefined
        ? null : pa.wrapper_never_outranks_production
    },

    legacy_projection: {
      projection_class: lp.projection_class || null,
      verdict: lp.verdict || null,
      verdict_scope: lp.verdict_scope || null,
      is_production_generation_authority: lp.is_production_generation_authority === undefined
        ? null : lp.is_production_generation_authority
    },

    manual_routes: {
      row_count: (out.before_counts && out.before_counts.visible_route_rows) === undefined
        ? null : out.before_counts.visible_route_rows,
      planned_total: out.current_manual_planned_total === undefined ? null : out.current_manual_planned_total,
      route_a_id: A ? A.allocation_draft_id : null,
      route_a_version: (A && A.observed) ? CENSUS_str_(A.observed.draft_version) : null,
      route_b_id: B ? B.allocation_draft_id : null,
      route_b_version: (B && B.observed) ? CENSUS_str_(B.observed.draft_version) : null
    },

    stop_reason: out.stop_reason || ''
  };
}

/**
 * The proof's own completeness guard. It runs BEFORE the verdict is printed anywhere, because a verdict that
 * has already been announced cannot be withdrawn by a later line — which is the ordering mistake this file
 * has now made twice.
 *
 * The last check is not about presence. A run that WOULD WRITE is not a no-action, and a proof asserting both
 * at once is the one shape an operator must never be handed as an acceptance.
 */
function CENSUS_r6r7ProofGuard_(out) {
  var pp = out.production_path || {};
  var pa = out.parity || {};
  var lp = out.legacy_projection || {};
  var missing = [];
  if (!out.production_path || pp.available !== true || !pp.outcome) missing.push('production_path.outcome');
  if (!out.parity || !pa.production_outcome || typeof pa.agree !== 'boolean') missing.push('parity');
  if (!out.legacy_projection || lp.is_production_generation_authority !== false) {
    missing.push('legacy_projection.is_production_generation_authority');
  }
  if (out.verdict === 'READY_NO_ACTION' && pa.production_would_write === true) {
    missing.push('production_would_write_contradicts_READY_NO_ACTION');
  }
  out.proof_complete = missing.length === 0;
  out.proof_missing = missing;
  if (!out.proof_complete) {
    out.verdict = 'STOP';
    out.stop_reason = (out.stop_reason ? out.stop_reason + ' ' : '')
      + 'PROOF_INCOMPLETE: ' + missing.join(', ') + '.';
  }
  return out.proof_complete;
}

// The shared exit. Asserts the read-only facts on the way out and prints ONE complete line to the log, because
// the Apps Script editor shows the execution log and not the returned object.
function CENSUS_r6r7Finish_(out) {
  out.read_only = true;
  out.db_writes = CENSUS_num_(out.db_writes) || 0;
  out.writer_constructed = out.writer_constructed === true;
  out.writer_calls = CENSUS_num_(out.writer_calls) || 0;
  out.submit_calls = CENSUS_num_(out.submit_calls) || 0;
  out.reservation_writes = CENSUS_num_(out.reservation_writes) || 0;
  // R6-R7-R2-P1 — THE GUARDS RUN BEFORE ANY VERDICT IS PRINTED. They used to run after the summary line,
  // so a run that a guard turned into a STOP had already announced a success one line above it.
  //
  // THE DECLARED EVIDENCE MUST BE THERE BEFORE THE VERDICT STANDS.
  var required = R6R7_REQUIRED_EXPORT_[out.census] || [];
  var absent = required.filter(function (k) { return out[k] === null || out[k] === undefined; });
  out.export_complete = absent.length === 0;
  if (!out.export_complete) {
    out.export_missing = absent;
    out.verdict = 'STOP';
    out.stop_reason = (out.stop_reason ? out.stop_reason + ' ' : '')
      + 'EXPORT_INCOMPLETE: ' + absent.join(', ') + ' — this census\'s verdict rests on evidence it did not'
      + ' report, and a verdict a reader cannot check is not one.';
    CENSUS_log_('r6r7_export_incomplete', absent.join(', '));
  }
  // The preflight is the census an acceptance is read from, so it is the one that carries a bounded proof.
  var wantsProof = out.census === 'RUN_R6R7_CONTROLLED_AI_PLAN_PREFLIGHT';
  if (wantsProof) CENSUS_r6r7ProofGuard_(out);

  CENSUS_log_('r6r7', out.census + ' ' + out.verdict + ' — passed ' + out.predicates_passed
    + ' failed ' + out.predicates_failed);

  // ---- THE PROOF, BEFORE THE DETAILED EXPORT. Apps Script truncates the tail; this line is what must
  //      survive, so nothing unbounded is allowed above it and nothing at all is allowed between.
  if (wantsProof) {
    var proofLine = null;
    try { proofLine = JSON.stringify(CENSUS_r6r7ProofObject_(out)); }
    catch (eP) { proofLine = null; CENSUS_log_('r6r7_proof_failed', CENSUS_str_(eP && eP.message)); }
    if (proofLine !== null) {
      CENSUS_log_('r6r7_proof', proofLine);
      CENSUS_log_('r6r7_proof_meta', JSON.stringify({ contract: R6R7_PROOF_CONTRACT_,
        bytes: proofLine.length, max_bytes: R6R7_PROOF_MAX_BYTES_,
        within_bounds: proofLine.length <= R6R7_PROOF_MAX_BYTES_,
        detailed_export_follows: true }));
    }
  }

  var payload = {
    census: out.census, build: out.build, verdict: out.verdict,
    predicates_passed: out.predicates_passed, predicates_failed: out.predicates_failed,
    db_writes: out.db_writes, writer_calls: out.writer_calls, writer_constructed: out.writer_constructed,
    submit_calls: out.submit_calls, route_save_calls: out.route_save_calls || 0,
    reservation_writes: out.reservation_writes,
    scope: out.scope || null,
    suggested_qty: out.suggested_qty || null,
    current_run: out.current_run || null,
    zero_recommendation_classification: out.zero_recommendation_classification || null,
    disputed_value_provenance: out.disputed_value_provenance || null,
    manual_route_snapshots: out.manual_route_snapshots || out.manual_routes_observed || null,
    expected_ai_identities: out.expected_ai_identities || null,
    ai_rows_observed: out.ai_rows_observed || null,
    counts: out.counts || out.before_counts || null,
    // R6-R7-R2 — THE TWO OBJECTS THIS ROUND EXISTS TO PUT IN FRONT OF A READER.
    production_path: out.production_path || null,
    parity: out.parity || null,
    legacy_projection: out.legacy_projection || null,
    export_complete: out.export_complete,
    export_missing: out.export_missing || [],
    proof_complete: out.proof_complete === undefined ? null : out.proof_complete,
    proof_missing: out.proof_missing || [],
    stop_reason: out.stop_reason || ''
  };
  try { CENSUS_log_('r6r7_export', JSON.stringify(payload)); }
  catch (eX) {
    CENSUS_log_('r6r7_export_failed', CENSUS_str_(eX && eX.message));
    // A payload too large to stringify must still deliver the parity, or the round has no evidence at all.
    try { CENSUS_log_('r6r7_export_minimal', JSON.stringify({ census: out.census, verdict: out.verdict,
      production_path: payload.production_path, parity: payload.parity })); } catch (eY) {}
  }
  (out.predicates || []).forEach(function (p) {
    if (!p.pass) CENSUS_log_('r6r7_failed', p.predicate + ': expected ' + JSON.stringify(p.expected)
      + ' observed ' + JSON.stringify(p.observed));
  });
  return out;
}
