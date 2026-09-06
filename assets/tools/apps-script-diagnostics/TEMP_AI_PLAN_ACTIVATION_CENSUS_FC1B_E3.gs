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
var TEMP_E3_CENSUS_BUILD_ = 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4-R1';

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

function CENSUS_log_(label, value) {
  try {
    Logger.log('[E3-CENSUS] ' + label + ': ' +
      (value && typeof value === 'object' ? JSON.stringify(value) : String(value)));
  } catch (e) {}
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
        out.blockers.push('REQUESTED_SCOPE_EMPTY: the marketplace produced no allocated lines (the generation ' +
          'fails closed with the same code — it never fans out to other marketplaces)');
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
    out.blockers.push('SKU_NOT_IN_SCOPE: the named SKU produced no allocated line for this marketplace');
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
var R6R6R4_A_AFTER_LAST_MILE_ = 'parcel';
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
  last_mile_delivery: 'truck',
  expected_arrival: '',
  k4_group_key: '|resus|us|amazon|inventory_replenishment|wh-tw-cn-factory-youxin|marketplace|amazon|sea_express|truck|',
  status: 'draft', line_status: '', generation_type: 'user_created',
  ownership: 'MANUAL (no generation_run_id — composed by a person)',
  draft_version: '2',
  updated_at: 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)',
  line_updated_at: 'Sun Sep 06 2026 08:27:53 GMT+0800 (Taiwan Standard Time)',
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
    predicates: [], predicates_passed: 0, predicates_failed: 0,
    snapshot_gaps: [],
    derived_gates: [],
    // §4 — the FROZEN record and the OBSERVED row, side by side, so a gap can be closed from this output
    //      alone and never again from a wrapper that lives only in the editor.
    route_a_frozen: R6R6R4_A_BEFORE_, route_a_observed: null,
    route_b_frozen: R6R6R4_B_BEFORE_, route_b_observed: null,
    already_saved: false,
    stage_two_authorized: false,
    stage_two: 'parcel -> truck, version 3 -> 4, is DESIGNED and NOT AUTHORIZED this round. See'
      + ' RUN_R6R6R4_RESTORE_STAGE_TWO_MANIFEST.',
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
    && CENSUS_str_(a.draft_version) === '3';
  CENSUS_r6r6r3P_(out, 'route_a_save_has_not_already_happened', 'last mile truck at version 2',
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
  CENSUS_r6r6r3P_(out, 'route_a_draft_version_advanced_by_exactly_one', '3',
    a ? CENSUS_str_(a.draft_version) : null, !!a && CENSUS_str_(a.draft_version) === '3');
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
    authorized: false,          // ALWAYS false in this round.
    executed: false,            // ALWAYS false. There is no write path in this function.
    blocked_by: 'F1-7N-FC-1B-E3-R4-A2-R1-R6-R6-R4 §7 authorizes stage one only. Stage two requires stage'
      + ' one to have returned SINGLE_ROW_MUTATION_CONFIRMED and a separate current-turn authorization.',
    precondition: 'RUN_R6R6R4_SINGLE_ROW_SAVE_READBACK returns SINGLE_ROW_MUTATION_CONFIRMED with zero failed'
      + ' predicates. Until then the starting point of stage two is not established.',
    action: 'Route A last_mile_delivery parcel -> truck: ' + R6R6R4_SAVE_MECHANIC_,
    expected: {
      route_a_last_mile_before: R6R6R4_A_AFTER_LAST_MILE_,
      route_a_last_mile_after: R6R6R4_A_BEFORE_.last_mile_delivery,
      route_a_draft_version_before: '3',
      route_a_draft_version_after: '4',
      route_a_k4_after: R6R6R4_A_BEFORE_.k4_group_key,
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
    verdict: 'STAGE_TWO_DESIGNED_NOT_AUTHORIZED'
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
  out.stage_two_authorized = false;
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
